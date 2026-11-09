import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { AppConfig } from "../src/config/config";
import { setLogSink } from "../src/common/log";
import { OtpSender } from "../src/auth/otp-sender";
import { DBNAME, PW, RUNTIME_HOST, RUNTIME_PORT, TEST_OTP_MAC_KEY, admin, eq, harnessSender, makePro, newDevice, newPhone, ok, test, waitFor } from "./harness";

const K = "API";
const LOGS: string[] = [];
let base = "";
// Pengirim uji yang bisa dibuat gagal N kali UNTUK NOMOR TERTENTU (AUD-OTP-03). Kegagalan per nomor, bukan
// global, agar pekerjaan OTP lain di antrean tidak "memakan" jatah gagal (akar masalah Issue #5). Kode yang
// berhasil dikirim masuk kotak masuk bersama harness.
class ToggleSender implements OtpSender {
  readonly kind = "test";
  readonly failFor = new Map<string, number>();
  async send(phone: string, code: string): Promise<void> {
    const n = this.failFor.get(phone) ?? 0;
    if (n > 0) {
      this.failFor.set(phone, n - 1);
      throw new Error("penyedia gagal (simulasi)");
    }
    return harnessSender.send(phone, code);
  }
  last(phone: string): string | undefined {
    return harnessSender.last(phone);
  }
  count(phone: string): number {
    return harnessSender.count(phone);
  }
}
const sender = new ToggleSender();
const SECRETS = new Set<string>([TEST_OTP_MAC_KEY.toString()]);   // token, OTP, sandi, kunci -> dicari di log (T-SEC-03)

interface Res { status: number; body: Record<string, unknown>; text: string }

async function http(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Res> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* bukan JSON */ }
  if (typeof json.token === "string") SECRETS.add(json.token);
  return { status: r.status, body: json, text };
}

function otpOf(phone: string): string {
  const c = sender.last(phone);
  ok(c, `OTP untuk ${phone} tidak terkirim`);
  SECRETS.add(c);
  return c;
}

interface ApiOwner { phone: string; token: string; tenant: string; device: string }

async function registerOwner(name = "Kios API"): Promise<ApiOwner> {
  const phone = newPhone();
  const device = newDevice();
  SECRETS.add(PW);
  eq((await http("POST", "/auth/register/start", { phone })).status, 202, "register/start");
  const r = await http("POST", "/auth/register/verify-otp", { phone, code: otpOf(phone), password: PW, businessName: name, timezone: "Asia/Makassar", deviceId: device });
  eq(r.status, 201, `verify-otp ${r.text}`);
  return { phone, token: r.body.token as string, tenant: r.body.tenantId as string, device };
}

async function addAdmin(o: ApiOwner): Promise<{ phone: string; token: string; id: string; device: string }> {
  const phone = newPhone();
  const device = newDevice();
  const inv = await http("POST", "/staff", { phone, displayName: "Admin API" }, o.token);
  eq(inv.status, 202, `undang admin ${inv.text}`);
  const act = await http("POST", "/auth/staff-activation/verify", { phone, code: otpOf(phone), password: PW, deviceId: device });
  eq(act.status, 201, `aktivasi admin ${act.text}`);
  return { phone, token: act.body.token as string, id: inv.body.staffId as string, device };
}

const sameShape = (a: Res, b: Res) => {
  const strip = (x: Res) => JSON.stringify({ ...x.body, correlation_id: undefined });
  return a.status === b.status && strip(a) === strip(b);
};

export async function apiTests(): Promise<void> {
  setLogSink((l) => LOGS.push(l));
  const cfg: AppConfig = {
    mode: "test",
    port: 0,
    db: {
      host: RUNTIME_HOST, port: RUNTIME_PORT, database: DBNAME, poolMax: 10,
      auth: { user: "auth_runtime", password: undefined },
      app: { user: "app_runtime", password: undefined },
      otp: { user: "otp_dispatch_runtime", password: undefined },
    },
    otpSender: "test",
    ipHashSecret: Buffer.from("TEST_ONLY_ip_hash_secret_for_api_tests_0123456789"),
    otpMacKey: TEST_OTP_MAC_KEY,
    otpDispatchIntervalMs: 300,
    trustProxyHops: 0,
  };
  const { app, db } = await createApp(cfg, { otpSender: sender });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;

  try {
    await test("T-AUTH-01", K, "Registrasi Owner + OTP: toko & FREE hanya terbentuk setelah OTP sah (168 jam)", async () => {
      const phone = newPhone();
      eq((await http("POST", "/auth/register/start", { phone })).status, 202, "start");
      const before = (await admin<{ n: number }>("select count(*)::int n from iam.user_account where phone_e164=$1", [phone]))[0].n;
      eq(before, 0, "akun sebelum OTP");
      const r = await http("POST", "/auth/register/verify-otp", { phone, code: otpOf(phone), password: PW, businessName: "Kios Pak Budi", timezone: "Asia/Makassar", deviceId: newDevice() });
      eq(r.status, 201, "verify");
      const me = await http("GET", "/tenant/me", undefined, r.body.token as string);
      const [s] = await admin<{ h: number }>("select extract(epoch from expires_at - activated_at)::int/3600 h from platform.subscription where tenant_id=$1", [r.body.tenantId]);
      ok(me.status === 200 && me.body.plan === "FREE" && me.body.role === "OWNER" && me.body.effectiveStatus === "ACTIVE", me.text);
      eq(s.h, 168, "jam FREE");
      // nomor terdaftar: register/start menjawab sama dan tidak mengirim OTP baru
      const n0 = sender.count(phone);
      const again = await http("POST", "/auth/register/start", { phone });
      const fresh = await http("POST", "/auth/register/start", { phone: newPhone() });
      ok(sameShape(again, fresh), "jawaban nomor terdaftar berbeda dari nomor baru");
      eq(sender.count(phone), n0, "OTP terkirim ke nomor terdaftar");
      return "sebelum OTP: 0 akun; sesudah: OWNER/FREE/ACTIVE, 168 jam; anti-enumerasi register/start";
    });

    await test("T-AUTH-02", K, "OTP salah, berulang, kedaluwarsa, dan replay ditolak", async () => {
      const phone = newPhone();
      await http("POST", "/auth/register/start", { phone });
      const code = otpOf(phone);
      const wrong = code === "000000" ? "111111" : "000000";
      const body = (c: string) => ({ phone, code: c, password: PW, businessName: "K", timezone: "Asia/Makassar", deviceId: newDevice() });
      const st: number[] = [];
      for (let i = 0; i < 5; i++) st.push((await http("POST", "/auth/register/verify-otp", body(wrong))).status);
      const after = await http("POST", "/auth/register/verify-otp", body(code));
      eq(st.join(","), "400,400,400,400,429", "status OTP salah berulang");
      eq(after.status, 429, "kode benar setelah terkunci");
      // kedaluwarsa
      const p2 = newPhone();
      await http("POST", "/auth/register/start", { phone: p2 });
      const c2 = otpOf(p2);
      await admin("update iam.otp_challenge set created_at = now() - interval '1 hour', expires_at = now() - interval '59 minutes' where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [p2]);
      const exp = await http("POST", "/auth/register/verify-otp", { ...body(c2), phone: p2 });
      eq(exp.status, 400, "OTP kedaluwarsa");
      // replay
      const p3 = newPhone();
      await http("POST", "/auth/register/start", { phone: p3 });
      const c3 = otpOf(p3);
      eq((await http("POST", "/auth/register/verify-otp", { ...body(c3), phone: p3 })).status, 201, "pakai pertama");
      eq((await http("POST", "/auth/register/verify-otp", { ...body(c3), phone: p3, businessName: "K2" })).status, 400, "replay");
      return "5 salah -> 400x4 + 429; benar setelah terkunci -> 429; kedaluwarsa -> 400; replay -> 400";
    });

    await test("T-AUTH-03", K, "Login sandi salah & nomor tak dikenal dijawab identik; batas percobaan -> 429", async () => {
      const o = await registerOwner();
      const wrongPw = await http("POST", "/auth/login", { phone: o.phone, password: "sandi-salah-sekali", deviceId: newDevice() });
      const unknown = await http("POST", "/auth/login", { phone: newPhone(), password: "sandi-salah-sekali", deviceId: newDevice() });
      eq(wrongPw.status, 401, "sandi salah");
      ok(sameShape(wrongPw, unknown), `jawaban berbeda: ${wrongPw.text} vs ${unknown.text}`);
      for (let i = 0; i < 4; i++) await http("POST", "/auth/login", { phone: o.phone, password: "sandi-salah-" + i, deviceId: newDevice() });
      const locked = await http("POST", "/auth/login", { phone: o.phone, password: PW, deviceId: newDevice() });
      eq(locked.status, 429, "sandi benar setelah 5 gagal (TEST_ONLY)");
      const ghost = newPhone();
      const gs: number[] = [];
      for (let i = 0; i < 6; i++) gs.push((await http("POST", "/auth/login", { phone: ghost, password: "x-" + i, deviceId: newDevice() })).status);
      eq(gs.join(","), "401,401,401,401,401,429", "nomor tak dikenal juga dibatasi sama");
      return "401 identik untuk nomor tak dikenal vs sandi salah; >=5 gagal -> 429 (nomor dikenal maupun tidak)";
    });

    await test("T-AUTH-04", K, "Logout & pencabutan sesi: token lama langsung ditolak", async () => {
      const o = await registerOwner();
      eq((await http("POST", "/auth/logout", {}, o.token)).status, 204, "logout");
      eq((await http("GET", "/tenant/me", undefined, o.token)).status, 401, "token setelah logout");
      const o2 = await registerOwner();
      await makePro(o2.tenant);
      const a = await addAdmin(o2);
      const [s] = await admin<{ id: string }>("select id from iam.session where tenant_id=$1 and membership_id=$2 and revoked_at is null", [o2.tenant, a.id]);
      eq((await http("POST", `/auth/sessions/${s.id}/revoke`, {}, o2.token)).status, 204, "owner cabut sesi admin");
      eq((await http("GET", "/tenant/me", undefined, a.token)).status, 401, "token admin dicabut");
      return "logout -> 401; Owner cabut sesi Admin -> 401";
    });

    await test("T-AUTH-05", K, "Toko FREE membuat Admin -> 403 FEATURE_GATED_PLAN", async () => {
      const o = await registerOwner();
      const r = await http("POST", "/staff", { phone: newPhone(), displayName: "Admin" }, o.token);
      eq(r.status, 403, "status");
      eq(r.body.code, "FEATURE_GATED_PLAN", "kode");
      return "403 FEATURE_GATED_PLAN";
    });

    await test("T-AUTH-06", K, "Toko PRO membuat Admin kedua -> 409 ADMIN_LIMIT_REACHED", async () => {
      const o = await registerOwner();
      await makePro(o.tenant);
      await addAdmin(o);
      const r = await http("POST", "/staff", { phone: newPhone(), displayName: "Admin 2" }, o.token);
      eq(r.status, 409, "status");
      eq(r.body.code, "ADMIN_LIMIT_REACHED", "kode");
      return "Admin pertama aktif; Admin kedua -> 409";
    });

    await test("T-ROLE-01", K, "Admin memakai endpoint Owner -> 403; tidak bisa menaikkan peran lewat body", async () => {
      const o = await registerOwner();
      await makePro(o.tenant);
      const a = await addAdmin(o);
      const [os] = await admin<{ id: string }>("select id from iam.session where tenant_id=$1 and revoked_at is null and membership_id <> $2 limit 1", [o.tenant, a.id]);
      const r = [
        await http("POST", "/staff", { phone: newPhone(), displayName: "X" }, a.token),
        await http("GET", "/staff", undefined, a.token),
        await http("POST", `/auth/sessions/${os.id}/revoke`, {}, a.token),
        await http("POST", `/staff/${a.id}/deactivate`, {}, a.token),
      ];
      ok(r.every((x) => x.status === 403 && x.body.code === "FORBIDDEN_ROLE"), r.map((x) => x.status).join(","));
      const esc = await http("POST", "/auth/login", { phone: a.phone, password: PW, deviceId: a.device, role: "OWNER" });
      eq(esc.status, 400, "role di body login");
      const me = await http("GET", "/tenant/me", undefined, a.token, { "x-role": "OWNER" });
      eq(me.body.role, "ADMIN", "peran tetap ADMIN");
      return "4 endpoint Owner -> 403 FORBIDDEN_ROLE; role di body -> 400; header palsu diabaikan";
    });

    await test("T-TENANT-01", K, "Toko palsu dari body/header tidak memberi akses toko lain", async () => {
      const a = await registerOwner("Kios A");
      const b = await registerOwner("Kios B");
      const viaBody = await http("POST", "/staff", { phone: newPhone(), displayName: "X", tenant_id: b.tenant }, a.token);
      const viaHeader = await http("GET", "/tenant/me", undefined, a.token, { "x-tenant-id": b.tenant, "x-tenant": b.tenant });
      eq(viaBody.status, 400, "tenant_id di body");
      eq((viaHeader.body.tenant as { id: string }).id, a.tenant, "header tenant diabaikan");
      return "tenant_id di body -> 400; header X-Tenant-ID diabaikan (tetap toko A)";
    });

    await test("T-TENANT-02", K, "ID milik toko lain (BOLA) -> 404", async () => {
      const a = await registerOwner("Kios A");
      const b = await registerOwner("Kios B");
      await makePro(b.tenant);
      const bAdmin = await addAdmin(b);
      const [bs] = await admin<{ id: string }>("select id from iam.session where tenant_id=$1 and revoked_at is null limit 1", [b.tenant]);
      const r1 = await http("POST", `/auth/sessions/${bs.id}/revoke`, {}, a.token);
      const r2 = await http("POST", `/staff/${bAdmin.id}/deactivate`, {}, a.token);
      const r3 = await http("POST", `/staff/00000000-0000-4000-8000-000000000000/deactivate`, {}, a.token);
      ok(r1.status === 404 && r2.status === 404 && r3.status === 404, `${r1.status},${r2.status},${r3.status}`);
      ok(sameShape(r2, r3), "jawaban ID toko lain berbeda dari ID tidak ada");
      eq((await http("GET", "/tenant/me", undefined, bAdmin.token)).status, 200, "admin B tetap sah");
      return "sesi/admin toko B -> 404, identik dengan ID yang tidak ada";
    });

    await test("T-API-01", K, "Field asing & nested extra key -> 400", async () => {
      const o = await registerOwner();
      const cases: Res[] = [
        await http("POST", "/auth/register/start", { phone: newPhone(), extra: 1 }),
        await http("POST", "/auth/register/start", { phone: { nested: "+6281234567890" } }),
        await http("POST", "/auth/login", { phone: o.phone, password: PW, deviceId: newDevice(), meta: { a: { b: 1 } } }),
        await http("POST", "/staff", { phone: newPhone(), displayName: "X", meta: { role: "OWNER" } }, o.token),
        await http("POST", "/auth/logout", { x: 1 }, o.token),
        await http("POST", "/auth/register/start", [{ phone: newPhone() }]),
      ];
      ok(cases.every((c) => c.status === 400 && c.body.code === "VALIDATION_ERROR"), cases.map((c) => c.status).join(","));
      return `${cases.length}/${cases.length} -> 400 VALIDATION_ERROR`;
    });

    await test("SEC-FIX-02", K, "Token karangan, dicabut, dan kedaluwarsa ditolak lewat API", async () => {
      const o = await registerOwner();
      const forged = await http("GET", "/tenant/me", undefined, "c".repeat(64));
      const garbage = await http("GET", "/tenant/me", undefined, undefined, { authorization: "Bearer xyz" });
      await http("POST", "/auth/logout", {}, o.token);
      const revoked = await http("GET", "/tenant/me", undefined, o.token);
      const o2 = await registerOwner();
      await admin("update iam.session set auth_at=now()-interval '2 hours', created_at=now()-interval '2 hours', expires_at=now()-interval '1 second' where tenant_id=$1", [o2.tenant]);
      const expired = await http("GET", "/tenant/me", undefined, o2.token);
      ok([forged, garbage, revoked, expired].every((r) => r.status === 401), [forged, garbage, revoked, expired].map((r) => r.status).join(","));
      return "4/4 -> 401";
    });

    await test("SEC-FIX-05", K, "Bootstrap lewat API: tanpa OTP sah tidak ada toko; identitas dari klien ditolak", async () => {
      const phone = newPhone();
      const before = (await admin<{ n: number }>("select count(*)::int n from platform.tenant"))[0].n;
      const noOtp = await http("POST", "/auth/register/verify-otp", { phone, code: "123456", password: PW, businessName: "Palsu", timezone: "Asia/Makassar", deviceId: newDevice() });
      const withRole = await http("POST", "/auth/register/verify-otp", { phone, code: "123456", password: PW, businessName: "Palsu", timezone: "Asia/Makassar", deviceId: newDevice(), role: "OWNER", plan: "PRO", tenantId: "x" });
      const after = (await admin<{ n: number }>("select count(*)::int n from platform.tenant"))[0].n;
      eq(noOtp.status, 400, "tanpa OTP");
      eq(withRole.status, 400, "role/plan/tenant dari klien");
      eq(after, before, "toko bertambah");
      return "tanpa OTP -> 400 & 0 toko baru; role/plan/tenantId di body -> 400";
    });

    await test("SEC-FIX-07", K, "Pergantian perangkat: token perangkat lama -> 401", async () => {
      const o = await registerOwner();
      const b = await http("POST", "/auth/login", { phone: o.phone, password: PW, deviceId: newDevice() });
      eq(b.status, 200, "login perangkat B");
      eq((await http("GET", "/tenant/me", undefined, o.token)).status, 401, "token A");
      eq((await http("GET", "/tenant/me", undefined, b.body.token as string)).status, 200, "token B");
      const list = await http("GET", "/auth/sessions", undefined, b.body.token as string);
      eq((list.body.sessions as unknown[]).length, 1, "sesi aktif");
      ok(!list.text.includes(b.body.token as string), "daftar sesi memuat token");
      return "A -> 401, B -> 200; daftar sesi tanpa token";
    });

    await test("SEC-FIX-08", K, "Admin dinonaktifkan lewat API: semua sesi hilang, login ditolak, pengganti bisa diundang", async () => {
      const o = await registerOwner();
      await makePro(o.tenant);
      const a = await addAdmin(o);
      eq((await http("POST", `/staff/${a.id}/deactivate`, {}, o.token)).status, 204, "nonaktifkan");
      eq((await http("GET", "/tenant/me", undefined, a.token)).status, 401, "token admin");
      eq((await http("POST", "/auth/login", { phone: a.phone, password: PW, deviceId: newDevice() })).status, 401, "login admin");
      const list = await http("GET", "/staff", undefined, o.token);
      ok((list.body.staff as { id: string; state: string }[]).some((s) => s.id === a.id && s.state === "DEACTIVATED"), "histori admin");
      eq((await http("POST", "/staff", { phone: newPhone(), displayName: "Pengganti" }, o.token)).status, 202, "undang pengganti");
      return "204; token 401; login 401; histori DEACTIVATED; pengganti 202";
    });

    await test("SEC-FIX-10", K, "Payload dengan field asing atau role/tenant/plan palsu -> 400", async () => {
      const o = await registerOwner();
      const r = [
        await http("POST", "/staff", { phone: newPhone(), displayName: "X", role: "OWNER" }, o.token),
        await http("POST", "/staff", { phone: newPhone(), displayName: "X", plan: "PRO" }, o.token),
        await http("POST", "/auth/staff-activation/verify", { phone: newPhone(), code: "123456", password: PW, deviceId: newDevice(), tenant_id: o.tenant }),
        await http("POST", "/auth/login", { phone: o.phone, password: PW, deviceId: newDevice(), tenantId: o.tenant }),
      ];
      ok(r.every((x) => x.status === 400), r.map((x) => x.status).join(","));
      return "4/4 -> 400";
    });

    await test("T-ENT-01", K, "Masa paket habis: status LOCKED_GRACE, perubahan data 403, keamanan tetap jalan", async () => {
      const o = await registerOwner();
      await admin("update platform.subscription set activated_at=now()-interval '169 hours', expires_at=now()-interval '1 hour', grace_deadline=now()-interval '1 hour'+interval '7 days' where tenant_id=$1", [o.tenant]);
      const me = await http("GET", "/tenant/me", undefined, o.token);
      eq(me.body.effectiveStatus, "LOCKED_GRACE", "status FREE habis");
      const o2 = await registerOwner();
      await admin("update platform.subscription set plan='PRO', activated_at=now()-interval '31 days', expires_at=now()-interval '1 hour', grace_deadline=now()+interval '29 days' where tenant_id=$1", [o2.tenant]);
      const inv = await http("POST", "/staff", { phone: newPhone(), displayName: "X" }, o2.token);
      eq(inv.status, 403, "undang saat terkunci");
      eq(inv.body.code, "TENANT_LOCKED", "kode");
      eq((await http("POST", "/auth/logout", {}, o2.token)).status, 204, "logout saat terkunci");
      return "FREE lewat -> LOCKED_GRACE; PRO lewat: undang 403 TENANT_LOCKED; logout tetap 204";
    });

    await test("T-SEC-01", K, "Injeksi lewat path dan body tidak berdampak", async () => {
      const o = await registerOwner();
      await makePro(o.tenant);
      const r1 = await http("POST", "/auth/login", { phone: "' or 1=1 --", password: "' or '1'='1", deviceId: newDevice() });
      const r2 = await http("POST", "/staff/1;drop%20table%20iam.session;--/deactivate", {}, o.token);
      const name = "Robert'); drop table iam.membership; --";
      const r3 = await http("POST", "/staff", { phone: newPhone(), displayName: name }, o.token);
      const list = await http("GET", "/staff", undefined, o.token);
      const tables = (await admin<{ n: number }>("select count(*)::int n from pg_tables where schemaname in ('iam','platform')"))[0].n;
      eq(r1.status, 400, "phone injeksi");
      eq(r2.status, 404, "path injeksi");
      eq(r3.status, 202, "nama berisi kutip");
      ok((list.body.staff as { displayName: string }[]).some((s) => s.displayName === name), "nama tersimpan literal");
      // 12 tabel fondasi + iam.reauth_grant (0009, INV-AUD-01).
      eq(tables, 13, "tabel utuh");
      return "phone -> 400; path -> 404; nama berkutip tersimpan literal; 13 tabel utuh";
    });

    await test("T-SEC-02", K, "Error tidak membocorkan SQL, nama tabel, stack, atau kode internal", async () => {
      const o = await registerOwner();
      await makePro(o.tenant);
      await admin("delete from iam.security_param where key='invite_ttl_seconds'");
      let r: Res;
      try {
        r = await http("POST", "/staff", { phone: newPhone(), displayName: "X" }, o.token);
      } finally {
        await admin("insert into iam.security_param(key,value,test_only) values ('invite_ttl_seconds',600,true)");
      }
      const bad = await http("POST", "/auth/login", "{rusak", undefined, { "content-type": "application/json" });
      const bad2 = await http("POST", "/auth/login", "a=b", undefined, { "content-type": "text/plain" });
      eq(r.status, 500, "error internal");
      eq(bad.status, 400, "JSON rusak");
      for (const x of [r, bad, bad2]) {
        ok(!/select|insert|iam\.|platform\.|SECURITY_PARAM|stack|at \w+ \(|postgres|P0001|sqlstate/i.test(x.text), `bocor: ${x.text}`);
      }
      return `500 generik (code=${r.body.code}); JSON rusak 400; tanpa SQL/nama tabel/stack`;
    });

    await test("HEALTH-01", K, "Endpoint health tanpa detail internal", async () => {
      const live = await http("GET", "/health/live");
      const ready = await http("GET", "/health/ready");
      ok(live.status === 200 && ready.status === 200, `${live.status},${ready.status}`);
      ok(!/postgres|version|host|5432/i.test(live.text + ready.text), "detail bocor");
      return "live 200, ready 200, tanpa detail";
    });

    await test("AUD-OTP-01", K, "OTP lewat API: pengirim sah menerima kode, sekali pakai, tidak ada di respons/log", async () => {
      const phone = newPhone();
      const start = await http("POST", "/auth/register/start", { phone });
      const code = otpOf(phone);
      ok(!start.text.includes(code), "kode di respons");
      const body = { phone, code, password: PW, businessName: "Kios OTP API", timezone: "Asia/Makassar", deviceId: newDevice() };
      const first = await http("POST", "/auth/register/verify-otp", body);
      const replay = await http("POST", "/auth/register/verify-otp", { ...body, businessName: "Lagi" });
      eq(first.status, 201, "pakai pertama");
      eq(replay.status, 400, "replay");
      ok(!replay.text.includes(code), "kode di error");
      const all = LOGS.join("\n");
      ok(!all.includes(code) && !all.includes(TEST_OTP_MAC_KEY.toString()), "kode/kunci di log");
      return "kode diterima pengirim sah; 201 lalu replay 400; kode & kunci tidak ada di respons/error/log";
    });

    await test("AUD-SESSION-01", K, "Login API serentak HP A & B (50 putaran): tepat satu token tetap berlaku", async () => {
      let bad = 0;
      for (let round = 0; round < 50; round++) {
        const o = await registerOwner(`Kios Sesi API ${round}`);
        await admin("update iam.session set revoked_at=now(), revoke_reason='LOGOUT' where tenant_id=$1 and revoked_at is null", [o.tenant]);
        const [ra, rb] = await Promise.all([
          http("POST", "/auth/login", { phone: o.phone, password: PW, deviceId: `apiA-${round}-xxxx` }),
          http("POST", "/auth/login", { phone: o.phone, password: PW, deviceId: `apiB-${round}-xxxx` }),
        ]);
        const sa = (await http("GET", "/tenant/me", undefined, ra.body.token as string)).status;
        const sb = (await http("GET", "/tenant/me", undefined, rb.body.token as string)).status;
        const n = (await admin<{ n: number }>("select count(*)::int n from iam.session where tenant_id=$1 and revoked_at is null", [o.tenant]))[0].n;
        if (ra.status !== 200 || rb.status !== 200 || n !== 1 || [sa, sb].filter((s) => s === 200).length !== 1) bad++;
      }
      eq(bad, 0, "putaran dengan dua perangkat aktif / anomali");
      return "50/50 putaran: tepat satu token 200, lainnya 401; 1 sesi aktif";
    });

    await test("AUD-LOGIN-01", K, "50 login salah serentak lewat API: 5x401 lalu 45x429; sesudahnya sandi benar tetap 429", async () => {
      const o = await registerOwner();
      const out: string[] = [];
      for (const [label, phone] of [["terdaftar", o.phone], ["tidak terdaftar", newPhone()]] as const) {
        const res = await Promise.all(Array.from({ length: 50 }, (_, i) => http("POST", "/auth/login", { phone, password: `salah-api-${i}-x`, deviceId: newDevice() })));
        const c401 = res.filter((r) => r.status === 401).length;
        const c429 = res.filter((r) => r.status === 429).length;
        const after = await http("POST", "/auth/login", { phone, password: PW, deviceId: newDevice() });
        eq(c401, 5, `${label}: 401`);
        eq(c429, 45, `${label}: 429`);
        eq(after.status, 429, `${label}: sesudahnya`);
        out.push(`${label}: 5x401/45x429/lalu 429`);
      }
      return out.join("; ");
    });

    await test("AUD-LOCK-01", K, "LOCKED_GRACE lewat API: undang 403, cabut sesi/nonaktifkan Admin/logout 204", async () => {
      const o = await registerOwner();
      await makePro(o.tenant);
      const a = await addAdmin(o);
      await admin("update platform.subscription set activated_at=now()-interval '31 days', expires_at=now()-interval '1 hour', grace_deadline=now()+interval '29 days' where tenant_id=$1", [o.tenant]);
      const me = await http("GET", "/tenant/me", undefined, o.token);
      const inv = await http("POST", "/staff", { phone: newPhone(), displayName: "Baru" }, o.token);
      const [as] = await admin<{ id: string }>("select id from iam.session where membership_id=$1 and revoked_at is null limit 1", [a.id]);
      const rev = await http("POST", `/auth/sessions/${as.id}/revoke`, {}, o.token);
      const deact = await http("POST", `/staff/${a.id}/deactivate`, {}, o.token);
      const out = await http("POST", "/auth/logout", {}, o.token);
      eq(me.body.effectiveStatus, "LOCKED_GRACE", "status");
      ok(inv.status === 403 && inv.body.code === "TENANT_LOCKED", `undang: ${inv.status}`);
      ok(rev.status === 204 && deact.status === 204 && out.status === 204, `${rev.status},${deact.status},${out.status}`);
      return "undang 403 TENANT_LOCKED; cabut sesi 204; nonaktifkan Admin 204; logout 204";
    });

    await test("AUD-OTP-03", K, "Pengiriman OTP pertama gagal -> pemroses berkala mengirim ulang TANPA permintaan API baru", async () => {
      const phone = newPhone();
      sender.failFor.set(phone, 1);
      const start = await http("POST", "/auth/register/start", { phone });
      eq(start.status, 202, "register/start");
      eq(sender.count(phone), 0, "terkirim saat pengirim gagal");
      const [q] = await admin<{ status: string; send_attempts: number }>("select status, send_attempts from iam.otp_outbox where phone_e164=$1", [phone]);
      ok(q.status === "QUEUED" && q.send_attempts === 1, `antrean setelah gagal: ${JSON.stringify(q)}`);
      const t0 = Date.now();
      // Tunggu kondisi: pemroses berkala (tanpa request API baru) mengirim ulang setelah jeda backoff, dan ack tercatat.
      const d = await waitFor("kiriman ulang oleh pemroses berkala", async () => {
        const [x] = await admin<{ status: string; send_attempts: number }>("select status, send_attempts from iam.otp_outbox where phone_e164=$1", [phone]);
        return x.status === "SENT" ? x : undefined;
      });
      const waited = Date.now() - t0;
      eq(sender.count(phone), 1, "kiriman ulang oleh pemroses berkala");
      ok(d.send_attempts === 2, `antrean setelah kirim ulang: ${JSON.stringify(d)}`);
      const v = await http("POST", "/auth/register/verify-otp", { phone, code: otpOf(phone), password: PW, businessName: "Kios Retry Otomatis", timezone: "Asia/Makassar", deviceId: newDevice() });
      eq(v.status, 201, "verifikasi kode kiriman ulang");
      return `gagal -> QUEUED; terkirim ulang otomatis setelah ${waited} ms tanpa request API; SENT (2 percobaan); verifikasi 201`;
    });

    await test("AUD-OTP-04", K, "Minta OTP aktivasi baru selama undangan berlaku; jawaban identik untuk nomor tanpa undangan", async () => {
      const o = await registerOwner();
      await makePro(o.tenant);
      const phone = newPhone();
      eq((await http("POST", "/staff", { phone, displayName: "Admin OTP" }, o.token)).status, 202, "undang");
      const first = otpOf(phone);
      await admin("update iam.otp_challenge set created_at=now()-interval '1 hour', expires_at=now()-interval '59 minutes' where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null and used_at is null", [phone]);
      const expired = await http("POST", "/auth/staff-activation/verify", { phone, code: first, password: PW, deviceId: newDevice() });
      eq(expired.status, 400, "OTP lama kedaluwarsa");
      const n0 = sender.count(phone);
      const again = await http("POST", "/auth/staff-activation/start", { phone });
      const nobody = await http("POST", "/auth/staff-activation/start", { phone: newPhone() });
      ok(sameShape(again, nobody), "jawaban berbeda untuk nomor tanpa undangan");
      eq(again.status, 202, "start");
      eq(sender.count(phone), n0 + 1, "OTP baru terkirim");
      const act = await http("POST", "/auth/staff-activation/verify", { phone, code: otpOf(phone), password: PW, deviceId: newDevice() });
      eq(act.status, 201, "aktivasi dengan OTP baru");
      return "OTP lama kedaluwarsa 400; start -> OTP baru (202, identik dgn nomor tanpa undangan); aktivasi 201";
    });

    await test("T-SEC-03", "uji log","Log tidak memuat OTP, sandi, token, atau nomor HP utuh", async () => {
      const all = LOGS.join("\n");
      const leaks = [...SECRETS].filter((s) => s.length >= 6 && all.includes(s));
      const phones = all.match(/\+62[0-9]{8,13}/g) ?? [];
      eq(leaks.length, 0, `rahasia muncul di log: ${leaks.slice(0, 3).map((s) => s.slice(0, 4) + "…").join(",")}`);
      eq(phones.length, 0, "nomor HP muncul di log");
      ok(LOGS.length > 50, "log terlalu sedikit untuk diuji");
      return `${LOGS.length} baris log dipindai terhadap ${SECRETS.size} rahasia: 0 kebocoran`;
    });
  } finally {
    await app.close();
    await db.close().catch(() => undefined);
  }
}
