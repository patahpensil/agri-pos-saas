// Uji keamanan API (HTTP nyata ke Fastify lokal) — PoC kandidat A.
import pg from "pg";
import { writeFileSync } from "node:fs";
import { build, pools } from "./server.ts";

const admin = new pg.Pool({ host: process.env.POC_SOCK ?? "/tmp", port: Number(process.env.PG_PORT ?? 55432), database: process.env.DB ?? "poc", user: "postgres", max: 3 });
const results: any[] = [];
const rec = (id: string, kondisi: string, harapan: string, aktual: string, ok: boolean) => {
  results.push({ id, jenis: "API integration (HTTP lokal)", kondisi, harapan, aktual, status: ok ? "PASS" : "FAIL" });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${aktual}`);
};

const app = build();
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
async function http(method: string, path: string, body?: any, token?: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
let seq = 0;
async function newOwner(plan = "FREE") {
  const phone = "+6281" + String(Date.now()).slice(-7) + String(seq++).padStart(2, "0");
  const reg = await http("POST", "/auth/register", { phone, password: "sandi-kuat-123", kiosName: "Kios Uji" });
  const otp = reg.headers.get("x-test-otp")!;
  await http("POST", "/auth/verify-otp", { phone, code: otp });
  const login = await http("POST", "/auth/login", { phone, password: "sandi-kuat-123" });
  const tid = (await admin.query("select tenant_id from iam.app_user_account where phone=$1", [phone])).rows[0].tenant_id;
  if (plan !== "FREE") await admin.query("update app.tenant set plan=$2 where id=$1", [tid, plan]);
  await admin.query("insert into app.product values ($1,1,'SKU1',1,false,10000)", [tid]);
  await admin.query("insert into app.stock values ($1,1,'LOOSE','A','READY',20),($1,1,'SEALED','A','READY',0)", [tid]);
  await admin.query("insert into app.cost_pool values ($1,1,'READY',20,100000)", [tid]);
  return { phone, token: login.json.token as string, tid };
}
const sale = (token: string, key: string, extra: any = {}) =>
  http("POST", "/sales", { lines: [{ product: 1, form: "LOOSE", batch: "A", qty: 1 }], payments: [{ method: "CASH", amount: 10000 }], ...extra }, token, { "idempotency-key": key });

// API-01 BOLA
{
  const A = await newOwner(), B = await newOwner();
  const sb = (await sale(B.token, "kunci-B-0001")).json.saleId;
  const r = await http("GET", `/sales/${sb}`, undefined, A.token);
  const own = await http("GET", `/sales/${sb}`, undefined, B.token);
  rec("API-01", "Owner A membuka /sales/{id milik B}", "404 tanpa data B", `A→${r.status} ${r.text}; B→${own.status}`, r.status === 404 && own.status === 200);
}
// API-02 tenant_id dari klien
{
  const A = await newOwner(), B = await newOwner();
  const r = await sale(A.token, "kunci-A-spoof1", { tenant_id: B.tid });
  const nB = (await admin.query("select count(*)::int n from app.sale where tenant_id=$1", [B.tid])).rows[0].n;
  rec("API-02", "Body POST /sales menyisipkan tenant_id milik B", "Ditolak; tidak ada data di B", `status ${r.status} ${r.json?.error}; Sale di B=${nB}`, r.status === 400 && nB === 0);
}
// API-03 tanpa / token palsu
{
  const a = await http("GET", "/sales/1"), b = await http("GET", "/sales/1", undefined, "token-palsu");
  rec("API-03", "Tanpa token & token palsu", "401", `${a.status}, ${b.status}`, a.status === 401 && b.status === 401);
}
// API-04 sesi dicabut
{
  const A = await newOwner("PRO");
  const st = await http("POST", "/staff", { phone: A.phone.replace("+6281", "+6282"), password: "sandi-admin-123" }, A.token);
  const adm = await http("POST", "/auth/login", { phone: A.phone.replace("+6281", "+6282"), password: "sandi-admin-123" });
  const before = await sale(adm.json.token, "kunci-adm-0001");
  await http("POST", `/staff/${st.json.id}/revoke-sessions`, undefined, A.token);
  const after = await sale(adm.json.token, "kunci-adm-0002");
  rec("API-04", "Owner mencabut sesi Admin", "Token Admin langsung tidak berlaku", `sebelum ${before.status}; sesudah ${after.status}`, before.status === 201 && after.status === 401);

  // API-05 Admin menyetujui refund
  const adm2 = await http("POST", "/auth/login", { phone: A.phone.replace("+6281", "+6282"), password: "sandi-admin-123" });
  const s1 = (await sale(A.token, "kunci-own-0001")).json.saleId;
  const ra = await http("POST", "/refunds/approve", { saleId: s1, amount: 1, method: "CASH" }, adm2.json.token);
  const ro = await http("POST", "/refunds/approve", { saleId: s1, amount: 1, method: "CASH" }, A.token);
  rec("API-05", "Admin vs Owner menyetujui refund (L=0)", "Admin 403; Owner sampai ke aturan DB", `Admin ${ra.status} ${ra.json?.error}; Owner ${ro.status} ${ro.json?.error}`,
      ra.status === 403 && ro.status === 409 && ro.json?.error === "REFUND_CAP_EXCEEDED");
  // API-06 ekspor
  const ea = await http("GET", "/exports/sales", undefined, adm2.json.token), eo = await http("GET", "/exports/sales", undefined, A.token);
  rec("API-06", "Admin vs Owner ekspor massal", "Admin 403, Owner 200", `${ea.status}, ${eo.status}`, ea.status === 403 && eo.status === 200);
  // API-07b PRO admin kedua
  const st2 = await http("POST", "/staff", { phone: A.phone.replace("+6281", "+6283"), password: "sandi-admin-456" }, A.token);
  rec("API-07b", "PRO menambah Admin kedua", "403 PLAN_LIMIT", `${st2.status} ${st2.json?.error}`, st2.status === 403);
}
// API-07 FREE: fitur PRO & tambah Admin
{
  const F = await newOwner("FREE");
  const p = await http("POST", "/promotions", {}, F.token);
  const s = await http("POST", "/staff", { phone: F.phone.replace("+6281", "+6284"), password: "sandi-admin-123" }, F.token);
  rec("API-07", "FREE memanggil API promo & tambah Admin", "Ditolak backend", `promo ${p.status} ${p.json?.error}; admin ${s.status} ${s.json?.error}`, p.status === 403 && s.status === 403);
}
// API-08 brute force & enumerasi login
{
  const A = await newOwner();
  const unknown = await http("POST", "/auth/login", { phone: "+628999999999", password: "salah-salah-1" });
  const wrong = await http("POST", "/auth/login", { phone: A.phone, password: "salah-salah-1" });
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await http("POST", "/auth/login", { phone: A.phone, password: "salah-" + i })).status);
  const right = await http("POST", "/auth/login", { phone: A.phone, password: "sandi-kuat-123" });
  rec("API-08", "Nomor tak terdaftar vs sandi salah; lalu 6 percobaan", "Respons identik; dibatasi 429",
      `tak terdaftar ${unknown.status} ${unknown.text} | salah ${wrong.status} ${wrong.text}; percobaan ${codes.join(",")}; sandi benar saat terkunci ${right.status}`,
      unknown.status === wrong.status && unknown.text === wrong.text && codes.includes(429) && right.status === 429);
}
// API-09 brute force OTP
{
  const phone = "+6285" + String(Date.now()).slice(-8);
  const reg = await http("POST", "/auth/register", { phone, password: "sandi-kuat-123", kiosName: "X" });
  const otp = reg.headers.get("x-test-otp")!; const wrongCode = otp === "000000" ? "111111" : "000000";
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await http("POST", "/auth/verify-otp", { phone, code: wrongCode })).status);
  const correct = await http("POST", "/auth/verify-otp", { phone, code: otp });
  const t = (await admin.query("select count(*)::int n from iam.app_user_account where phone=$1", [phone])).rows[0].n;
  const known = await http("POST", "/auth/register", { phone: (await newOwner()).phone, password: "sandi-kuat-123", kiosName: "Y" });
  rec("API-09", "5 OTP salah lalu OTP benar; daftar ulang nomor terdaftar", "Terkunci; tidak ada akun; respons daftar identik",
      `salah ${codes.join(",")}; benar setelah 5x → ${correct.status} ${correct.json?.error}; akun dibuat=${t}; daftar nomor terdaftar → ${known.status} ${known.text} (tanpa OTP)`,
      correct.status === 429 && t === 0 && known.status === 202 && !known.headers.get("x-test-otp"));
}
// API-10 idempotensi lewat HTTP bersamaan
{
  const A = await newOwner();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => sale(A.token, "kunci-sama-99999")));
  const ids = new Set(rs.map((r) => r.json?.saleId));
  const n = (await admin.query("select count(*)::int n from app.sale where tenant_id=$1", [A.tid])).rows[0].n;
  const stok = (await admin.query("select qty from app.stock where tenant_id=$1 and form='LOOSE'", [A.tid])).rows[0].qty;
  rec("API-10", "5 request POST /sales bersamaan dengan Idempotency-Key sama", "Satu Sale", `status ${rs.map((r) => r.status).join(",")}; ID unik ${[...ids].join(",")}; Sale=${n}; stok 20→${stok}`, ids.size === 1 && n === 1 && stok === 19);
}
// API-11 hak habis: jual ditolak, ekspor tetap boleh
{
  const A = await newOwner();
  await admin.query("update app.tenant set entitlement_until = now() - interval '1 second' where id=$1", [A.tid]);
  const s = await sale(A.token, "kunci-habis-0001"); const e = await http("GET", "/exports/sales", undefined, A.token);
  rec("API-11", "Masa trial habis", "Jual 403; ekspor 200", `jual ${s.status} ${s.json?.error}; ekspor ${e.status}`, s.status === 403 && e.status === 200);
}
// API-12 input jahat
{
  const A = await newOwner();
  const a = await http("GET", "/sales/1%20or%201=1", undefined, A.token);
  const b = await http("POST", "/sales", { lines: [{ product: "1; drop table app.sale", form: "LOOSE", batch: "A", qty: 1 }], payments: [] }, A.token, { "idempotency-key": "kunci-inj-0001" });
  const c = await http("POST", "/sales", { lines: [{ product: 1, form: "LOOSE", batch: "A'); delete from app.sale; --", qty: 1 }], payments: [] }, A.token, { "idempotency-key": "kunci-inj-0002" });
  const still = (await admin.query("select count(*)::int n from app.sale")).rows[0].n;
  rec("API-12", "Injeksi lewat path & body", "400/404, tanpa detail SQL, data utuh", `path ${a.status}; body angka ${b.status}; batch ${c.status} ${c.json?.error}; tabel sale masih ada (${still} baris)`,
      a.status === 400 && b.status === 400 && [404, 409].includes(c.status) && !c.text.includes("SQL") && still > 0);
}
// API-13 kebocoran konteks tenant pada koneksi yang dipakai ulang (pool 1 koneksi)
{
  const A = await newOwner(), B = await newOwner();
  const sa = (await sale(A.token, "kunci-pool-A001")).json.saleId, sb = (await sale(B.token, "kunci-pool-B001")).json.saleId;
  let leak = 0;
  for (let i = 0; i < 200; i++) {
    const [x, y] = await Promise.all([http("GET", `/sales/${sb}`, undefined, A.token), http("GET", `/sales/${sa}`, undefined, B.token)]);
    if (x.status !== 404 || y.status !== 404) leak++;
  }
  const c = await pools.appPool.connect();
  const ctx = (await c.query("select current_setting('app.session_token', true) v")).rows[0].v; c.release();
  rec("API-13", `400 request bergantian 2 tenant lewat pool (POOL_MAX=${process.env.POOL_MAX ?? 10})`, "Tidak ada kebocoran; konteks kosong setelah transaksi",
      `kebocoran=${leak}; konteks di koneksi idle='${ctx ?? ""}'`, leak === 0 && !ctx);
}

// API-14 idempotency key sama, isi berbeda
{
  const A = await newOwner();
  const r1 = await sale(A.token, "kunci-isi-beda-01");
  const r2 = await http("POST", "/sales", { lines: [{ product: 1, form: "LOOSE", batch: "A", qty: 3 }], payments: [{ method: "CASH", amount: 30000 }] }, A.token, { "idempotency-key": "kunci-isi-beda-01" });
  const r3 = await sale(A.token, "kunci-isi-beda-01");
  const stok = (await admin.query("select qty from app.stock where tenant_id=$1 and form='LOOSE'", [A.tid])).rows[0].qty;
  rec("API-14", "Idempotency-Key sama dengan isi berbeda lewat HTTP", "422 IDEMPOTENCY_KEY_REUSED; retry identik = Sale sama",
      `pertama ${r1.status}; isi beda ${r2.status} ${r2.json?.error}; retry identik ${r3.status} sama=${r3.json?.saleId === r1.json?.saleId}; stok 20→${stok}`,
      r1.status === 201 && r2.status === 422 && r2.json?.error === "IDEMPOTENCY_KEY_REUSED" && r3.json?.saleId === r1.json?.saleId && stok === 19);
}

writeFileSync(`${process.env.POC_RESULTS ?? "../results"}/api_results_${process.env.API_LABEL ?? "direct"}.json`, JSON.stringify(results, null, 1));
console.log(`\nPASS ${results.filter((r) => r.status === "PASS").length}/${results.length}`);
await app.close(); await admin.end(); await pools.appPool.end(); await pools.authPool.end();
