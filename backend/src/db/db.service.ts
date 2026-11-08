import { Pool, PoolClient } from "pg";
import { AppConfig, DbRoleConfig } from "../config/config";

// Tiga pool, tiga role database yang berbeda (lihat db/migrations/0005_grants_rls.sql):
//  - auth: fungsi identitas pra-login (iam.register_*, iam.login, iam.activate_admin)
//  - app : fungsi bisnis per toko (app.*), selalu dalam transaksi dengan token sesi lokal-transaksi
//  - otp : satu-satunya role yang dapat mengambil kode OTP untuk dikirim
export class DbService {
  readonly auth: Pool;
  readonly app: Pool;
  readonly otp: Pool;

  constructor(cfg: AppConfig) {
    const mk = (r: DbRoleConfig, max: number) =>
      new Pool({
        host: cfg.db.host,
        port: cfg.db.port,
        database: cfg.db.database,
        user: r.user,
        password: r.password,
        max,
        idleTimeoutMillis: 10_000,
        application_name: "agri-pos-backend",
      });
    this.auth = mk(cfg.db.auth, cfg.db.poolMax);
    this.app = mk(cfg.db.app, cfg.db.poolMax);
    this.otp = mk(cfg.db.otp, Math.max(1, Math.min(4, cfg.db.poolMax)));
    // Error koneksi idle tidak boleh mematikan proses; detailnya tidak dicatat ke log umum.
    for (const p of [this.auth, this.app, this.otp]) p.on("error", () => undefined);
  }

  // Satu request = satu transaksi. Token sesi hanya berlaku di transaksi ini (set_config ..., true),
  // sehingga aman untuk PgBouncer mode transaksi: konteks tidak terbawa ke klien berikutnya.
  async withActor<T>(token: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.app.connect();
    try {
      await c.query("begin");
      await c.query("select pg_catalog.set_config('app.session_token', $1, true)", [token]);
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      try {
        await c.query("rollback");
      } catch {
        /* koneksi rusak: dibuang di bawah */
      }
      throw e;
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.auth.end(), this.app.end(), this.otp.end()]);
  }
}
