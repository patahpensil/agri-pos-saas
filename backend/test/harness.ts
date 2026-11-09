import { Pool } from "pg";
import { randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dispatchOtps, otpMac, OtpPurpose, TestOtpSender } from "../src/auth/otp-sender";
import { join } from "node:path";

export type Status = "PASS" | "FAIL" | "BELUM DIUJI";
export interface Result {
  id: string;
  kind: string;
  target: string;
  title: string;
  status: Status;
  detail: string;
}

export const RESULTS: Result[] = [];

// Target koneksi role runtime: 'direct' (PostgreSQL) atau 'pgbouncer' (mode transaksi).
export const TARGET = process.env.TEST_TARGET ?? "direct";

export function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`env ${k} wajib untuk uji`);
  return v;
}

export const DBNAME = env("TEST_DB_NAME");
export const RUNTIME_HOST = env("TEST_RUNTIME_HOST");
export const RUNTIME_PORT = Number(env("TEST_RUNTIME_PORT"));
export const ADMIN_HOST = env("TEST_ADMIN_HOST");
export const ADMIN_PORT = Number(env("TEST_ADMIN_PORT"));
export const ADMIN_USER = env("TEST_ADMIN_USER");

export class Fail extends Error {}
export function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Fail(msg);
}
export function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Fail(`${msg}: harapan=${String(expected)} aktual=${String(actual)}`);
}

const ONLY = process.env.TEST_ONLY_IDS ? new Set(process.env.TEST_ONLY_IDS.split(",")) : null;

export async function test(id: string, kind: string, title: string, fn: () => Promise<string | void>): Promise<void> {
  if (ONLY && !ONLY.has(id)) return;   // dipakai uji mutasi: hanya ID terkait yang dijalankan
  const t0 = Date.now();
  try {
    const d = await fn();
    RESULTS.push({ id, kind, target: TARGET, title, status: "PASS", detail: `${d ?? "OK"} (${Date.now() - t0} ms)` });
    console.log(`[PASS] ${id} [${TARGET}] ${title}`);
  } catch (e) {
    const msg = e instanceof Fail ? e.message : `ERROR HARNESS: ${(e as Error)?.message ?? String(e)}`;
    RESULTS.push({ id, kind, target: TARGET, title, status: "FAIL", detail: msg });
    console.log(`[FAIL] ${id} [${TARGET}] ${title} :: ${msg}`);
  }
}

export function notRun(id: string, kind: string, title: string, why: string): void {
  if (ONLY && !ONLY.has(id)) return;
  RESULTS.push({ id, kind, target: TARGET, title, status: "BELUM DIUJI", detail: why });
  console.log(`[BELUM DIUJI] ${id} [${TARGET}] ${title} :: ${why}`);
}

export function writeResults(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `results-${TARGET}.json`), JSON.stringify(RESULTS, null, 1));
}

// ------------------------------------------------------------------ koneksi
const adminPool = new Pool({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, database: DBNAME, max: 4 });
export async function admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await adminPool.query(sql, params);
  return r.rows as T[];
}

const pools = new Map<string, Pool>();
export function rolePool(role: string): Pool {
  let p = pools.get(role);
  if (!p) {
    p = new Pool({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: role, database: DBNAME, max: 20 });
    p.on("error", () => undefined);
    pools.set(role, p);
  }
  return p;
}

export async function asRole<T = Record<string, unknown>>(role: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await rolePool(role).query(sql, params);
  return r.rows as T[];
}

// Panggilan fungsi app.* dalam satu transaksi dengan token sesi lokal (seperti backend).
export async function asActor<T = Record<string, unknown>>(token: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await rolePool("app_runtime").connect();
  try {
    await c.query("begin");
    if (token !== null) await c.query("select pg_catalog.set_config('app.session_token', $1, true)", [token]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

// Mengembalikan pesan error PostgreSQL (atau 'OK') — untuk uji penolakan.
export async function errOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    const x = e as { code?: string; message?: string };
    return x.code === "P0001" ? String(x.message) : `${x.code}:${x.message}`;
  }
}

export async function closeAll(): Promise<void> {
  await adminPool.end();
  for (const p of pools.values()) await p.end();
}

// ------------------------------------------------------------------ data uji
export function newPhone(): string {
  return "+62812" + String(randomInt(10_000_000, 99_999_999));
}
export function newDevice(): string {
  return "dev-" + String(randomInt(1_000_000, 9_999_999)) + "-" + String(randomInt(1000, 9999));
}
export const PW = "sandi-uji-panjang-1";

// Kunci MAC OTP khusus uji. Kunci produksi wajib dari luar repo (OTP_MAC_KEY).
export const TEST_OTP_MAC_KEY = Buffer.from("TEST_ONLY_otp_mac_key_for_tests_0123456789abcdef");
// SATU kotak masuk OTP untuk semua pengirim uji (harness + pemroses berkala aplikasi uji). Issue #5: antrean OTP
// bersifat global (sesuai produksi), jadi pemroses mana pun boleh mengirim; yang penting kodenya tidak hilang.
// Aplikasi uji WAJIB memakai harnessSender (atau pembungkusnya) sebagai pengirim OTP.
export const harnessSender = new TestOtpSender();

export function mac(purpose: OtpPurpose, phone: string, code: string): Buffer {
  return otpMac(TEST_OTP_MAC_KEY, purpose, phone, code);
}

// Tunggu kondisi (bukan tidur dengan waktu tetap). Gagal dengan pesan jelas bila tidak tercapai.
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 15_000, stepMs = 50): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Fail(`${what}: tidak tercapai dalam ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}

// Menjalankan worker pengirim sah (role otp_dispatch_runtime) lalu menunggu SAMPAI pekerjaan OTP terbaru
// untuk nomor ini berstatus SENT dan kodenya ada di kotak masuk bersama (siapa pun pemroses yang mengirim).
export async function claimCode(phone: string): Promise<string> {
  return waitFor(`kode OTP untuk ${phone} tidak terkirim`, async () => {
    await dispatchOtps(rolePool("otp_dispatch_runtime"), harnessSender, TEST_OTP_MAC_KEY, 200);
    const [o] = await admin<{ status: string }>(
      "select status from iam.otp_outbox where phone_e164=$1 order by created_at desc limit 1", [phone]);
    if (o && (o.status === "FAILED" || o.status === "EXPIRED")) throw new Fail(`OTP ${phone} berstatus ${o.status}`);
    return o?.status === "SENT" ? harnessSender.last(phone) : undefined;
  });
}

// register_verify dengan MAC kode (seperti backend).
export async function regVerify(phone: string, code: string, businessName: string, device: string, password = PW) {
  return asRole<{ r_status: string; r_token: string; r_tenant: string }>(
    "auth_runtime",
    "select * from iam.register_verify($1,$2,$3,$4,'Asia/Makassar',$5)",
    [phone, mac("REGISTER_OWNER", phone, code), password, businessName, device],
  );
}

export interface Owner {
  phone: string;
  token: string;
  tenant: string;
  device: string;
}

// Registrasi Owner lewat fungsi database (dipakai uji DB; uji API memakai endpoint HTTP).
export async function registerOwnerSql(businessName = "Kios Uji"): Promise<Owner> {
  const phone = newPhone();
  const device = newDevice();
  await asRole("auth_runtime", "select iam.register_start($1)", [phone]);
  const code = await claimCode(phone);
  const [r] = await regVerify(phone, code, businessName, device);
  eq(r.r_status, "OK", "registrasi owner");
  return { phone, token: r.r_token, tenant: r.r_tenant, device };
}

export async function makePro(tenant: string): Promise<void> {
  await admin(
    "update platform.subscription set plan='PRO', activated_at=now(), expires_at=now()+interval '30 days', grace_deadline=now()+interval '60 days' where tenant_id=$1",
    [tenant],
  );
}

export async function inviteAndActivateAdminSql(owner: Owner): Promise<{ phone: string; token: string; membership: string; device: string }> {
  const phone = newPhone();
  const device = newDevice();
  const [inv] = await asActor<{ id: string }>(owner.token, "select app.staff_invite($1,'Admin Uji') as id", [phone]);
  const code = await claimCode(phone);
  const [r] = await asRole<{ r_status: string; r_token: string }>(
    "auth_runtime",
    "select * from iam.activate_admin($1,$2,$3,$4)",
    [phone, mac("ACTIVATE_ADMIN", phone, code), PW, device],
  );
  eq(r.r_status, "OK", "aktivasi admin");
  return { phone, token: r.r_token, membership: inv.id, device };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
