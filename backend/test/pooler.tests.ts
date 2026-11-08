import { Client, Pool } from "pg";
import { DBNAME, RUNTIME_HOST, RUNTIME_PORT, TARGET, env, eq, ok, registerOwnerSql, test } from "./harness";

async function tenantOf(pool: Pool, token: string | null): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (token) await c.query("select pg_catalog.set_config('app.session_token', $1, true)", [token]);
    try {
      return (await c.query("select app.tenant_me()->'tenant'->>'id' t")).rows[0].t as string;
    } catch (e) {
      const x = e as { code?: string; message?: string };
      return x.code === "P0001" ? String(x.message) : `ERR:${x.code}`;
    } finally {
      await c.query("rollback").catch(() => undefined);
    }
  } finally {
    c.release();
  }
}

export async function poolerTests(): Promise<void> {
  const K = TARGET === "pgbouncer" ? "DB lewat PgBouncer (transaksi)" : "DB langsung";

  await test("T-TENANT-03", K, "Transaksi toko A lalu B bergantian (pool 1 koneksi + serentak) tanpa kebocoran konteks", async () => {
    const a = await registerOwnerSql("Kios A");
    const b = await registerOwnerSql("Kios B");
    const p1 = new Pool({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "app_runtime", database: DBNAME, max: 1 });
    let wrong = 0;
    let leaked = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const o = i % 2 ? b : a;
        if ((await tenantOf(p1, o.token)) !== o.tenant) wrong++;
        if ((await tenantOf(p1, null)) !== "UNAUTHENTICATED") leaked++;
      }
    } finally {
      await p1.end();
    }
    const p10 = new Pool({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "app_runtime", database: DBNAME, max: 10 });
    let wrongPar = 0;
    try {
      const res = await Promise.all(Array.from({ length: 300 }, (_, i) => {
        const o = i % 3 === 0 ? null : i % 3 === 1 ? a : b;
        return tenantOf(p10, o ? o.token : null).then((t) => (o ? t === o.tenant : t === "UNAUTHENTICATED"));
      }));
      wrongPar = res.filter((x) => !x).length;
    } finally {
      await p10.end();
    }
    eq(wrong, 0, "hasil toko salah (berurutan)");
    eq(leaked, 0, "transaksi tanpa token melihat toko sebelumnya");
    eq(wrongPar, 0, "hasil salah (serentak)");
    return "200 putaran berurutan pool=1 + 300 permintaan serentak: 0 salah, 0 bocor";
  });

  if (TARGET !== "pgbouncer") return;

  // Kontrol negatif: membuktikan uji di atas MAMPU mendeteksi kebocoran. set_config tingkat sesi
  // (is_local=false) lewat PgBouncer mode transaksi bocor ke klien lain pada koneksi server yang sama.
  await test("T-TENANT-03-KONTROL", K, "Kontrol negatif: konteks tingkat sesi lewat pooler memang bocor (alat uji sah)", async () => {
    const a = await registerOwnerSql("Kios Kontrol");
    const db1 = env("TEST_PGB_POOL1_DB");
    const c1 = new Client({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "app_runtime", database: db1 });
    const c2 = new Client({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "app_runtime", database: db1 });
    await c1.connect();
    await c2.connect();
    let seen = "";
    try {
      await c1.query("select pg_catalog.set_config('app.session_token', $1, false)", [a.token]);   // SALAH secara sengaja
      seen = (await c2.query("select app.tenant_me()->'tenant'->>'id' t")).rows[0].t as string;
    } catch (e) {
      seen = String((e as Error).message);
    } finally {
      await c2.query("reset app.session_token").catch(() => undefined);
      await c1.end();
      await c2.end();
    }
    ok(seen === a.tenant, `kebocoran tidak terdeteksi (aktual: ${seen})`);
    return "klien 2 tanpa token melihat toko klien 1 -> desain sesi-level terbukti bocor; produksi memakai set_config lokal-transaksi";
  });
}
