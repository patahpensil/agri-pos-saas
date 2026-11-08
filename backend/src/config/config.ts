// Konfigurasi fail-closed (G2, G3). Mode produksi menolak start bila ada parameter wajib yang
// kosong/tidak sah, nilai berlabel TEST_ONLY, atau pengirim OTP palsu.
// Parameter keamanan NFR-09 (OTP, sesi, batas laju, sandi) disimpan di database
// (iam.security_param) supaya pemanggil SQL tidak bisa melonggarkannya; startup produksi juga
// memeriksa bahwa semuanya terisi dan tidak ditandai test_only (lihat security-params.check.ts).

export type AppMode = "production" | "test" | "development";
export type OtpSenderKind = "test";

export interface DbRoleConfig {
  user: string;
  password: string | undefined;
}

export interface AppConfig {
  mode: AppMode;
  port: number;
  db: {
    host: string;
    port: number;
    database: string;
    poolMax: number;
    auth: DbRoleConfig;
    app: DbRoleConfig;
    otp: DbRoleConfig;
  };
  otpSender: OtpSenderKind;
  ipHashSecret: Buffer;
  trustProxyHops: number;
}

export class ConfigError extends Error {}

const MODES: readonly AppMode[] = ["production", "test", "development"];

function req(env: NodeJS.ProcessEnv, key: string, problems: string[]): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") {
    problems.push(`${key} wajib diisi`);
    return "";
  }
  return v;
}

function int(env: NodeJS.ProcessEnv, key: string, problems: string[], min: number, max: number): number {
  const raw = req(env, key, problems);
  if (raw === "") return 0;
  if (!/^[0-9]+$/.test(raw)) {
    problems.push(`${key} harus bilangan bulat`);
    return 0;
  }
  const n = Number(raw);
  if (n < min || n > max) problems.push(`${key} harus di antara ${min} dan ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const problems: string[] = [];
  const mode = env.NODE_ENV as AppMode;
  if (!MODES.includes(mode)) {
    throw new ConfigError(`NODE_ENV wajib salah satu dari: ${MODES.join(", ")}`);
  }
  const prod = mode === "production";

  if (prod) {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string" && /TEST_ONLY/i.test(v)) problems.push(`${k} berisi nilai TEST_ONLY (dilarang di produksi)`);
    }
  }

  const role = (prefix: string): DbRoleConfig => {
    const user = req(env, `${prefix}_USER`, problems);
    const password = env[`${prefix}_PASSWORD`];
    if (prod && (password === undefined || password.length < 16)) {
      problems.push(`${prefix}_PASSWORD wajib diisi (minimal 16 karakter) di produksi`);
    }
    return { user, password: password === "" ? undefined : password };
  };

  const otpRaw = req(env, "OTP_SENDER", problems);
  let otpSender: OtpSenderKind = "test";
  if (otpRaw !== "") {
    if (otpRaw !== "test") {
      problems.push(`OTP_SENDER '${otpRaw}' tidak dikenal; penyedia OTP produksi belum dipilih (keputusan Edgar)`);
    } else if (prod) {
      problems.push("OTP_SENDER=test dilarang di produksi");
    }
    otpSender = "test";
  }

  const secretRaw = req(env, "IP_HASH_SECRET", problems);
  const ipHashSecret = Buffer.from(secretRaw, "utf8");
  if (secretRaw !== "" && ipHashSecret.length < 32) problems.push("IP_HASH_SECRET minimal 32 byte");

  const cfg: AppConfig = {
    mode,
    port: int(env, "PORT", problems, 0, 65535),
    db: {
      host: req(env, "DB_HOST", problems),
      port: int(env, "DB_PORT", problems, 1, 65535),
      database: req(env, "DB_NAME", problems),
      poolMax: int(env, "DB_POOL_MAX", problems, 1, 200),
      auth: role("DB_AUTH"),
      app: role("DB_APP"),
      otp: role("DB_OTP"),
    },
    otpSender,
    ipHashSecret,
    trustProxyHops: env.TRUST_PROXY_HOPS === undefined ? 0 : int(env, "TRUST_PROXY_HOPS", problems, 0, 5),
  };

  if (problems.length > 0) throw new ConfigError(problems.join("; "));
  return cfg;
}
