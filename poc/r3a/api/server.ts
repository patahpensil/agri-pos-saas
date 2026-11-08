// PoC API kandidat A — Fastify + pg (TypeScript). BUKAN kode produksi.
// Tujuan: membuktikan kontrol keamanan API PRD V1.1 (AUTH/SEC) di atas skema PoC database.
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import pg from "pg";
import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const DB = { host: process.env.APP_DB_HOST ?? "/tmp", port: Number(process.env.APP_DB_PORT ?? 55432), database: process.env.DB ?? "poc" };
const POOL_MAX = Number(process.env.POOL_MAX ?? 10);
const appPool = new pg.Pool({ ...DB, user: "app_user", max: POOL_MAX });   // data bisnis, tunduk RLS
const authPool = new pg.Pool({ ...DB, user: "auth_svc", max: 5 });          // identitas & sesi
const EXPOSE_OTP = process.env.DEV_EXPOSE_OTP === "1";                      // HANYA untuk uji otomatis

// ---------------------------------------------------------------- util keamanan
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
function hashPw(pw: string): string {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}
function verifyPw(pw: string, stored: string): boolean {
  const [s, h] = stored.split(":");
  const calc = scryptSync(pw, Buffer.from(s, "hex"), 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(calc, Buffer.from(h, "hex"));
}
const DUMMY_HASH = hashPw("dummy-untuk-waktu-respons-setara");

// Pembatas laju sederhana (PoC: memori proses; produksi: penyimpanan bersama).
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}

type Session = { userId: string; tenantId: string; role: "OWNER" | "ADMIN"; tokenHash: string; token: string };
declare module "fastify" { interface FastifyRequest { session?: Session } }

async function withTenant<T>(s: Session, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    // Revisi 3: kirim token sesi mentah (parameter terikat, lokal transaksi). Database sendiri yang
    // memverifikasi token dan menurunkan tenant/aktor/peran — GUC tenant tidak lagi dipercaya.
    await c.query("select set_config('app.session_token',$1,true)", [s.token]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}

const ERR: Record<string, number> = {
  INSUFFICIENT_STOCK: 409, REFUND_CAP_EXCEEDED: 409, ENTITLEMENT_EXPIRED: 403, ENTITLEMENT_LOCKED: 403,
  TARGET_NOT_FOUND: 404, PRODUCT_NOT_FOUND: 404, SALE_NOT_FOUND: 404, LINE_NOT_FOUND: 404, OVERPAYMENT_NOT_ALLOWED: 422,
  IDEMPOTENCY_KEY_REUSED: 422, FORBIDDEN_ROLE: 403, ENTITLEMENT_EXPIRED_AT_COMMIT: 403, ENTITLEMENT_LOCKED_AT_COMMIT: 403, INVALID_QTY: 422, INVALID_AMOUNT: 422, EMPTY_CART: 422,
};
function dbError(reply: FastifyReply, e: any) {
  const code = String(e?.message ?? "");
  if (ERR[code]) return reply.code(ERR[code]).send({ error: code });
  reply.log.error(e);
  return reply.code(500).send({ error: "INTERNAL" });       // tanpa membocorkan detail SQL
}

// ---------------------------------------------------------------- aplikasi
export function build() {
  // Temuan uji API-02: bawaan Fastify/Ajv MENGHAPUS diam-diam properti tak dikenal (removeAdditional).
  // Diubah agar properti tak dikenal (mis. tenant_id dari klien) DITOLAK 400.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, ajv: { customOptions: { removeAdditional: false } } });

  async function auth(req: FastifyRequest, reply: FastifyReply) {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    const r = await authPool.query(
      "select user_id, tenant_id, role from iam.session where token_hash=$1 and revoked_at is null and expires_at > now()", [sha256(token)]);
    if (r.rowCount !== 1) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    req.session = { userId: r.rows[0].user_id, tenantId: r.rows[0].tenant_id, role: r.rows[0].role, tokenHash: sha256(token), token };
  }
  const ownerOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session?.role !== "OWNER") return reply.code(403).send({ error: "FORBIDDEN_ROLE" });
  };
  async function plan(s: Session): Promise<string> {
    return withTenant(s, async (c) => (await c.query("select plan from app.tenant where id = app.tid()")).rows[0].plan);
  }

  // --- registrasi Owner + OTP (AUTH-02, ENT-01)
  app.post("/auth/register", { schema: { body: { type: "object", additionalProperties: false, required: ["phone", "password", "kiosName"],
      properties: { phone: { type: "string", pattern: "^\\+62[0-9]{8,13}$" }, password: { type: "string", minLength: 10, maxLength: 128 }, kiosName: { type: "string", maxLength: 80 } } } } },
    async (req, reply) => {
      const { phone, password, kiosName } = req.body as any;
      if (limited("reg:" + phone, 3, 15 * 60e3)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS" });
      const exists = await authPool.query("select 1 from iam.app_user_account where phone=$1", [phone]);
      const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (exists.rowCount === 0) {
        await authPool.query(`insert into iam.pending_owner values ($1,$2,$3,$4, now() + interval '5 minutes', 0)
          on conflict (phone) do update set pw_hash=excluded.pw_hash, otp_hash=excluded.otp_hash, otp_expires=excluded.otp_expires, otp_attempts=0`,
          [phone, kiosName, hashPw(password), sha256(otp)]);
      }
      // Respons identik untuk nomor terdaftar/belum (anti-enumerasi)
      if (EXPOSE_OTP && exists.rowCount === 0) reply.header("x-test-otp", otp);
      return reply.code(202).send({ status: "OTP_SENT_IF_ELIGIBLE" });
    });

  app.post("/auth/verify-otp", { schema: { body: { type: "object", additionalProperties: false, required: ["phone", "code"],
      properties: { phone: { type: "string" }, code: { type: "string", pattern: "^[0-9]{6}$" } } } } },
    async (req, reply) => {
      const { phone, code } = req.body as any;
      const c = await authPool.connect();
      try {
        await c.query("begin");
        const p = await c.query("select * from iam.pending_owner where phone=$1 for update", [phone]);
        if (p.rowCount !== 1) { await c.query("rollback"); return reply.code(400).send({ error: "OTP_INVALID" }); }
        const row = p.rows[0];
        if (row.otp_attempts >= 5) { await c.query("commit"); return reply.code(429).send({ error: "OTP_LOCKED" }); }
        const ok = timingSafeEqual(Buffer.from(sha256(code)), Buffer.from(row.otp_hash)) && new Date(row.otp_expires) > new Date();
        if (!ok) {
          await c.query("update iam.pending_owner set otp_attempts = otp_attempts + 1 where phone=$1", [phone]);
          await c.query("commit"); return reply.code(400).send({ error: "OTP_INVALID" });
        }
        const tenant = randomUUID(), user = randomUUID();
        // Awal trial = waktu server saat OTP berhasil; 7 x 24 jam (ENT-01)
        await c.query("insert into app.tenant values ($1,$2,'FREE','ACTIVE', now() + interval '7 days')", [tenant, row.kios_name]);
        await c.query("insert into iam.app_user_account values ($1,$2,$3,$4,'OWNER')", [user, tenant, phone, row.pw_hash]);
        await c.query("delete from iam.pending_owner where phone=$1", [phone]);
        await c.query("commit");
        return reply.code(201).send({ status: "ACTIVATED" });
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
    });

  // --- login (anti-enumerasi + pembatas laju) (SEC-03)
  app.post("/auth/login", { schema: { body: { type: "object", additionalProperties: false, required: ["phone", "password"],
      properties: { phone: { type: "string", maxLength: 20 }, password: { type: "string", maxLength: 128 } } } } },
    async (req, reply) => {
      const { phone, password } = req.body as any;
      if (limited("login:" + phone, 5, 15 * 60e3) || limited("login-ip:" + req.ip, 50, 15 * 60e3))
        return reply.code(429).send({ error: "TOO_MANY_REQUESTS" });
      const r = await authPool.query("select id, tenant_id, pw_hash, role from iam.app_user_account where phone=$1", [phone]);
      const okPw = verifyPw(password, r.rowCount === 1 ? r.rows[0].pw_hash : DUMMY_HASH);   // waktu setara
      if (r.rowCount !== 1 || !okPw) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
      const token = randomBytes(32).toString("base64url");
      await authPool.query("insert into iam.session values ($1,$2,$3,$4, now() + interval '1 hour', null)",
        [sha256(token), r.rows[0].id, r.rows[0].tenant_id, r.rows[0].role]);
      return { token };
    });

  app.post("/auth/logout", { preHandler: auth }, async (req) => {
    await authPool.query("update iam.session set revoked_at = now() where token_hash=$1", [req.session!.tokenHash]);
    return { status: "REVOKED" };
  });

  // --- staf (ENT-02 / ST-SEC-18) & pencabutan sesi (AUTH-06)
  app.post("/staff", { preHandler: [auth, ownerOnly], schema: { body: { type: "object", additionalProperties: false, required: ["phone", "password"],
      properties: { phone: { type: "string", pattern: "^\\+62[0-9]{8,13}$" }, password: { type: "string", minLength: 10 } } } } },
    async (req, reply) => {
      const s = req.session!; const p = await plan(s);
      const n = (await authPool.query("select count(*)::int n from iam.app_user_account where tenant_id=$1 and role='ADMIN'", [s.tenantId])).rows[0].n;
      if (p === "FREE" || (p === "PRO" && n >= 1)) return reply.code(403).send({ error: "PLAN_LIMIT" });
      const id = randomUUID(); const { phone, password } = req.body as any;
      await authPool.query("insert into iam.app_user_account values ($1,$2,$3,$4,'ADMIN')", [id, s.tenantId, phone, hashPw(password)]);
      return reply.code(201).send({ id });
    });
  app.post("/staff/:id/revoke-sessions", { preHandler: [auth, ownerOnly], schema: { params: { type: "object", properties: { id: { type: "string", format: "uuid" } } } } },
    async (req, reply) => {
      const r = await authPool.query("update iam.session set revoked_at = now() where user_id=$1 and tenant_id=$2 and revoked_at is null",
        [(req.params as any).id, req.session!.tenantId]);     // hanya staf tenant sendiri
      return { revoked: r.rowCount };
    });

  // --- penjualan (POS-06, ST-POS-01, SEC-01)
  const lineSchema = { type: "object", additionalProperties: false, required: ["product", "form", "batch", "qty"],
    properties: { product: { type: "integer", minimum: 1 }, form: { enum: ["LOOSE", "SEALED"] }, batch: { type: "string", maxLength: 40 }, qty: { type: "integer", minimum: 1, maximum: 100000 } } };
  const paySchema = { type: "object", additionalProperties: false, required: ["method", "amount"],
    properties: { method: { enum: ["CASH", "TRANSFER", "QRIS", "EDC"] }, amount: { type: "integer", minimum: 1 } } };
  app.post("/sales", { preHandler: auth, schema: {
      headers: { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 80 } } },
      body: { type: "object", additionalProperties: false, required: ["lines", "payments"],     // tenant_id dari klien DITOLAK
        properties: { lines: { type: "array", minItems: 1, maxItems: 200, items: lineSchema }, payments: { type: "array", maxItems: 5, items: paySchema } } } } },
    async (req, reply) => {
      const s = req.session!; const key = String(req.headers["idempotency-key"]); const b = req.body as any;
      const run = () => withTenant(s, async (c) =>
        (await c.query("select app.finalize_sale($1,$2::jsonb,$3::jsonb) id", [key, JSON.stringify(b.lines), JSON.stringify(b.payments)])).rows[0].id);
      try { return reply.code(201).send({ saleId: Number(await run()) }); }
      catch (e: any) {
        if (e?.code === "23505") { try { return reply.code(201).send({ saleId: Number(await run()) }); } catch (e2) { return dbError(reply, e2); } }
        return dbError(reply, e);
      }
    });
  app.get("/sales/:id", { preHandler: auth, schema: { params: { type: "object", properties: { id: { type: "integer", minimum: 1 } } } } },
    async (req, reply) => {
      const r = await withTenant(req.session!, (c) => c.query("select id, total from app.sale where id=$1", [(req.params as any).id]));
      if (r.rowCount !== 1) return reply.code(404).send({ error: "NOT_FOUND" });       // tidak membedakan "milik tenant lain"
      return { id: Number(r.rows[0].id), total: Number(r.rows[0].total) };
    });

  // --- refund: hanya Owner (AUTH-05, RET-06)
  app.post("/refunds/approve", { preHandler: [auth, ownerOnly], schema: { body: { type: "object", additionalProperties: false, required: ["saleId", "amount", "method"],
      properties: { saleId: { type: "integer", minimum: 1 }, amount: { type: "integer", minimum: 1 }, method: { enum: ["CASH", "TRANSFER"] } } } } },
    async (req, reply) => {
      const b = req.body as any;
      try {
        const id = await withTenant(req.session!, async (c) =>
          (await c.query("select app.approve_refund('INVOICE',$1,$2,$3) id", [b.saleId, b.amount, b.method])).rows[0].id);
        return reply.code(201).send({ approvalId: Number(id) });
      } catch (e) { return dbError(reply, e); }
    });

  // --- ekspor: hanya Owner; tetap boleh saat akun terkunci (ENT-05, DOC-06/07)
  app.get("/exports/sales", { preHandler: [auth, ownerOnly] }, async (req) => {
    const r = await withTenant(req.session!, (c) => c.query("select count(*)::int n from app.sale"));
    return { sales: r.rows[0].n };
  });

  // --- fitur khusus PRO (ENT-08 / ST-SUB-09)
  app.post("/promotions", { preHandler: auth }, async (req, reply) => {
    if ((await plan(req.session!)) === "FREE") return reply.code(403).send({ error: "FEATURE_NOT_IN_PLAN" });
    return reply.code(201).send({ status: "OK" });
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err.validation) return reply.code(400).send({ error: "VALIDATION", detail: err.message });
    reply.code(500).send({ error: "INTERNAL" });
  });
  return app;
}

if (process.argv[1]?.endsWith("server.ts")) {
  build().listen({ port: Number(process.env.PORT ?? 8787), host: "127.0.0.1" }).then(() => console.log("API siap"));
}
export const pools = { appPool, authPool };
