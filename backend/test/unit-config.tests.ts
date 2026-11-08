import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ConfigError, loadConfig, AppConfig } from "../src/config/config";
import { normalizePhone, parseBody, schemas } from "../src/common/validation";
import { AppError, fromDbError } from "../src/common/errors";
import { redact } from "../src/common/log";
import { TestOtpSender } from "../src/auth/otp-sender";
import { checkSecurityParams, createApp } from "../src/app";
import { DbService } from "../src/db/db.service";
import { DBNAME, RUNTIME_HOST, RUNTIME_PORT, admin, eq, ok, test } from "./harness";

const MAIN = resolve(__dirname, "../src/main.js");

const BASE_ENV: Record<string, string> = {
  PORT: "0", DB_HOST: "127.0.0.1", DB_PORT: "5432", DB_NAME: "x", DB_POOL_MAX: "2",
  DB_AUTH_USER: "auth_runtime", DB_APP_USER: "app_runtime", DB_OTP_USER: "otp_dispatch_runtime",
  IP_HASH_SECRET: "0123456789abcdef0123456789abcdef-secret",
  OTP_MAC_KEY: "fedcba9876543210fedcba9876543210-otpmac",
};

function throwsConfig(env: Record<string, string>): string {
  try {
    loadConfig(env);
    return "TIDAK DITOLAK";
  } catch (e) {
    return e instanceof ConfigError ? e.message : "ERROR LAIN";
  }
}

// Menjalankan proses aplikasi sungguhan; mengembalikan exit code (atau 'RUNNING' bila masih hidup setelah ms).
function runMain(env: Record<string, string>, ms = 4000): Promise<{ code: string; out: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      res({ code: "RUNNING", out });
    }, ms);
    p.on("exit", (c) => {
      clearTimeout(t);
      res({ code: String(c), out });
    });
  });
}

export async function unitTests(): Promise<void> {
  const K = "unit";
  await test("U-01", K, "Normalisasi nomor HP Indonesia", async () => {
    const cases: [string, string | null][] = [
      ["081234567890", "+6281234567890"], ["+6281234567890", "+6281234567890"], ["6281234567890", "+6281234567890"],
      ["0812-3456-7890", "+6281234567890"], ["12345", null], ["+1555123456", null], ["08abc", null], ["0012345678", null],
    ];
    for (const [i, o] of cases) eq(normalizePhone(i), o, i);
    return `${cases.length} kasus`;
  });
  await test("U-02", K, "Skema strict menolak field asing dan objek bersarang", async () => {
    const bad = [{ phone: "081234567890", x: 1 }, { phone: { a: 1 } }, [], "x", { phone: "081234567890", nested: { role: "OWNER" } }];
    for (const b of bad) {
      let code = "";
      try { parseBody(schemas.registerStart, b); } catch (e) { code = (e as AppError).code; }
      eq(code, "VALIDATION_ERROR", JSON.stringify(b));
    }
    eq(parseBody(schemas.registerStart, { phone: "081234567890" }).phone, "+6281234567890", "valid");
    return `${bad.length} payload ditolak, 1 diterima`;
  });
  await test("U-03", K, "Pemetaan error DB: kode dikenal -> HTTP; tak dikenal -> tidak dipetakan (500)", async () => {
    eq(fromDbError({ code: "P0001", message: "FORBIDDEN_ROLE" })?.status, 403, "FORBIDDEN_ROLE");
    eq(fromDbError({ code: "P0001", message: "NOT_FOUND" })?.status, 404, "NOT_FOUND");
    eq(fromDbError({ code: "P0001", message: "SECURITY_PARAM_MISSING" }), undefined, "kode internal");
    eq(fromDbError({ code: "42501", message: "permission denied for table x" }), undefined, "error SQL");
    return "4 kasus";
  });
  await test("U-04", K, "Redaksi log: token, nomor HP, dan 6 digit disamarkan", async () => {
    const s = redact(`tok ${"a".repeat(64)} hp +6281234567890 hp2 081234567890 otp 123456`);
    ok(!/a{64}|6281234567890|081234567890|123456/.test(s), s);
    return s;
  });
  await test("U-05", K, "Validasi konfigurasi: wajib lengkap, angka sah, rahasia cukup panjang", async () => {
    const r = [
      throwsConfig({ ...BASE_ENV, NODE_ENV: "test", OTP_SENDER: "test", DB_HOST: "" }),
      throwsConfig({ ...BASE_ENV, NODE_ENV: "test", OTP_SENDER: "test", DB_PORT: "abc" }),
      throwsConfig({ ...BASE_ENV, NODE_ENV: "test", OTP_SENDER: "test", IP_HASH_SECRET: "pendek" }),
      throwsConfig({ ...BASE_ENV, NODE_ENV: "staging", OTP_SENDER: "test" }),
    ];
    ok(r.every((x) => x !== "TIDAK DITOLAK"), r.join(" | "));
    eq(throwsConfig({ ...BASE_ENV, NODE_ENV: "test", OTP_SENDER: "test" }), "TIDAK DITOLAK", "konfigurasi uji sah");
    return "4 konfigurasi salah ditolak; 1 konfigurasi uji sah diterima";
  });
}

export async function configTests(): Promise<void> {
  const K = "startup";
  const prodEnv = {
    ...BASE_ENV, NODE_ENV: "production",
    DB_AUTH_PASSWORD: "p".repeat(20), DB_APP_PASSWORD: "p".repeat(20), DB_OTP_PASSWORD: "p".repeat(20),
  };

  await test("T-CONFIG-01", K, "Produksi tanpa parameter keamanan sah -> startup ditolak", async () => {
    const r1 = await runMain({ ...prodEnv, DB_AUTH_PASSWORD: "", OTP_SENDER: "x" });
    const r2 = await runMain({ ...prodEnv, OTP_SENDER: "x", IP_HASH_SECRET: "TEST_ONLY_secret_0123456789abcdef0123" });
    ok(r1.code === "1" && /STARTUP DITOLAK/.test(r1.out) && /DB_AUTH_PASSWORD/.test(r1.out), `r1 ${r1.code} ${r1.out}`);
    ok(r2.code === "1" && /TEST_ONLY/.test(r2.out), `r2 ${r2.code} ${r2.out}`);
    ok(!/p{20}/.test(r1.out + r2.out), "pesan memuat rahasia");
    // Parameter keamanan di database: TEST_ONLY atau kosong -> ditolak; lengkap & sah -> diterima (kontrol positif).
    const cfg: AppConfig = {
      mode: "production", port: 0,
      db: { host: RUNTIME_HOST, port: RUNTIME_PORT, database: DBNAME, poolMax: 1,
        auth: { user: "auth_runtime", password: undefined }, app: { user: "app_runtime", password: undefined }, otp: { user: "otp_dispatch_runtime", password: undefined } },
      otpSender: "test", ipHashSecret: Buffer.alloc(32), otpMacKey: Buffer.alloc(32, 1), trustProxyHops: 0,
    };
    const dbs = new DbService(cfg);
    const check = () => checkSecurityParams(dbs, cfg).then(() => "DITERIMA", (e) => (e instanceof ConfigError ? "DITOLAK" : "ERROR"));
    let testOnly = "", missing = "", valid = "";
    try {
      testOnly = await check();
      await admin("update iam.security_param set test_only=false");
      await admin("delete from iam.security_param where key='session_ttl_seconds'");
      missing = await check();
      await admin("insert into iam.security_param(key,value,test_only) values ('session_ttl_seconds',3600,false)");
      valid = await check();
    } finally {
      await admin("update iam.security_param set test_only=true");
      await dbs.close();
    }
    eq(testOnly, "DITOLAK", "parameter TEST_ONLY");
    eq(missing, "DITOLAK", "parameter kosong");
    eq(valid, "DITERIMA", "kontrol positif");
    return "env kurang -> exit 1; nilai TEST_ONLY -> exit 1; param DB TEST_ONLY/kosong -> ditolak; lengkap -> diterima";
  });

  await test("T-OTP-01", K, "Pengirim OTP palsu di produksi -> startup ditolak", async () => {
    const r = await runMain({ ...prodEnv, OTP_SENDER: "test" });
    ok(r.code === "1" && /OTP_SENDER=test dilarang di produksi/.test(r.out), `${r.code} ${r.out}`);
    // Lapis kedua: createApp menolak TestOtpSender pada mode produksi walau konfigurasi lolos.
    const cfg = { ...loadConfig({ ...BASE_ENV, NODE_ENV: "test", OTP_SENDER: "test" }), mode: "production" as const };
    const second = await createApp(cfg, { otpSender: new TestOtpSender() }).then(() => "DITERIMA", (e) => (e instanceof ConfigError ? "DITOLAK" : "ERROR"));
    eq(second, "DITOLAK", "lapis kedua createApp");
    // Kontrol positif: mode uji dengan konfigurasi sama benar-benar berjalan.
    const pos = await runMain({
      ...BASE_ENV, NODE_ENV: "test", OTP_SENDER: "test", DB_HOST: RUNTIME_HOST, DB_PORT: String(RUNTIME_PORT), DB_NAME: DBNAME,
    }, 3000);
    eq(pos.code, "RUNNING", `kontrol positif mode uji: ${pos.out}`);
    return "produksi+OTP_SENDER=test -> exit 1; createApp produksi+TestOtpSender -> ditolak; mode uji -> berjalan";
  });
}
