// Uji modul Inventori: penerimaan stok, buka karton, tahan/lepas, pindah status, nilai HPP (INV-01/02/03/05/06/08/09,
// COST-01/02/05/06). DB langsung/PgBouncer + API. ID ST-* mengikuti Lampiran A PRD V1.1.
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { AppConfig } from "../src/config/config";
import { TestOtpSender } from "../src/auth/otp-sender";
import { Client } from "pg";
import {
  ADMIN_HOST, ADMIN_PORT, ADMIN_USER, DBNAME, RUNTIME_HOST, RUNTIME_PORT, TEST_OTP_MAC_KEY, admin, asActor, asRole, eq, errOf, inviteAndActivateAdminSql,
  PW, makePro, notRun, ok, registerOwnerSql, sleep, test,
} from "./harness";

const KA = "API";
const KD = "integrasi DB";
let base = "";

interface Res { status: number; body: Record<string, unknown>; text: string }
async function http(method: string, path: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* bukan JSON */ }
  return { status: r.status, body: json, text };
}
const idem = (key: string = randomUUID()) => ({ "idempotency-key": key });
// Pemasok wajib (INV-01). Helper menambahkan pemasok uji bila body tidak menyebutnya; uji negatif memakai rawReceive.
const withSupplier = (b: unknown) => (typeof b === "object" && b !== null && !("supplierName" in b) ? { supplierName: "PT Pemasok Uji", ...b } : b);
const rawReceive = (t: string, b: unknown, key?: string) => http("POST", "/inventory/receipts", t, b, idem(key));
const receive = (t: string, b: unknown, key?: string) => rawReceive(t, withSupplier(b), key);
const sqlReceive = (token: string, b: unknown, key: string = randomUUID()) =>
  asActor(token, "select app.inventory_receive($1, $2::jsonb)", [key, JSON.stringify(withSupplier(b))]);
const openPkg = (t: string, pkg: string, b: unknown, key?: string) => http("POST", `/packages/${pkg}/open`, t, b, idem(key));
const move = (t: string, b: unknown, key?: string) => http("POST", "/inventory/status-moves", t, b, idem(key));
const hold = (t: string, b: unknown, key?: string) => http("POST", "/inventory/holds", t, b, idem(key));
const release = (t: string, id: string, b: unknown, key?: string) => http("POST", `/inventory/holds/${id}/release`, t, b, idem(key));
const reauth = (t: string, holdId: string, password = PW) => http("POST", "/auth/reauth", t, { password, action: "inventory.release", targetId: holdId });
// Pelepasan sah oleh Owner: reautentikasi sandi untuk penahanan ini, lalu lepas dengan token sekali pakai.
async function ownerRelease(t: string, holdId: string, reason: string): Promise<Res> {
  const g = await reauth(t, holdId);
  if (g.status !== 201) throw new Error(`reauth gagal: ${g.text}`);
  return release(t, holdId, { reason, reauthToken: g.body.reauthToken });
}

let seq = 0;
const sku = (p = "INV") => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`.toUpperCase().slice(0, 40);

interface Prod { id: string; pkg: Record<string, string> }
// Pestisida: karton isi 12 (boleh dibuka) + botol lepas. Stok awal 3 karton (Rp3.600.000) + 5 botol (Rp500.000) batch B-01.
async function pesticide(token: string, over: Record<string, unknown> = {}): Promise<Prod> {
  const body = {
    sku: sku("PST"), name: "Pestisida Inventori", category: "PESTICIDE", subsidized: false, baseUnit: "botol",
    packages: [
      { key: "karton", form: "SEALED", factor: 12, label: "Karton 12", mayOpen: true },
      { key: "botol", form: "LOOSE", factor: 1, label: "Botol" },
    ],
    opening: [
      { packageKey: "karton", qty: 3, batch: { number: "B-01", expiresOn: "2030-12-31" }, cost: { basis: "KNOWN", totalIdr: 3_600_000 } },
      { packageKey: "botol", qty: 5, batch: { number: "B-01", expiresOn: "2030-12-31" }, cost: { basis: "KNOWN", totalIdr: 500_000 } },
    ],
    ...over,
  };
  return createProduct(token, body);
}
async function createProduct(token: string, body: Record<string, unknown>): Promise<Prod> {
  const r = await http("POST", "/products", token, body, idem());
  if (r.status !== 201) throw new Error(`buat produk gagal: ${r.text}`);
  const p = r.body.product as { packages: { id: string; label: string; form: string }[] };
  const keys = (body.packages as { key: string; label: string }[]);
  const pkg: Record<string, string> = {};
  for (const k of keys) pkg[k.key] = p.packages.find((x) => x.label === k.label)!.id;
  return { id: r.body.productId as string, pkg };
}
interface Row { packageVersionId: string; batchId: string; batchNumber: string | null; status: string; qty: number; qtyBase: number }
async function rows(token: string, productId: string): Promise<Row[]> {
  const r = await http("GET", `/inventory/stock?productId=${productId}`, token);
  return r.body.rows as Row[];
}
const qtyOf = (rs: Row[], pkg: string, batch: string, status: string) =>
  rs.filter((x) => x.packageVersionId === pkg && x.batchId === batch && x.status === status).reduce((s, x) => s + x.qty, 0);
const baseOf = (rs: Row[], status?: string) => rs.filter((x) => !status || x.status === status).reduce((s, x) => s + x.qtyBase, 0);
async function batchId(productId: string, number: string): Promise<string> {
  const [b] = await admin<{ id: string }>("select id::text from biz.batch where product_id=$1 and batch_number=$2", [productId, number]);
  return b.id;
}
async function pools(productId: string): Promise<Record<string, { q: number; v: number; u: boolean }>> {
  const out: Record<string, { q: number; v: number; u: boolean }> = {};
  for (const r of await admin<{ status: string; q: string; v: string; u: boolean }>(
    "select status, qty_base::text q, value_idr::text v, unverified u from biz.cost_pool where product_id=$1", [productId])) {
    out[r.status] = { q: Number(r.q), v: Number(r.v), u: r.u };
  }
  return out;
}
const sumPools = (p: Record<string, { q: number; v: number }>) =>
  Object.values(p).reduce((s, x) => ({ q: s.q + x.q, v: s.v + x.v }), { q: 0, v: 0 });
const count = async (sql: string, p: unknown[]) => (await admin<{ n: number }>(sql, p))[0].n;
const ledgerCount = (productId: string) => count("select count(*)::int n from biz.inventory_ledger where product_id=$1", [productId]);
const line = (pkg: string, qty: number, extra: Record<string, unknown> = {}) => ({
  packageId: pkg, qty, status: "SALEABLE", batch: { number: "B-01", expiresOn: "2030-12-31" }, cost: { basis: "KNOWN", totalIdr: qty * 1_000 }, ...extra,
});

export async function inventoryTests(): Promise<void> {
  const cfg: AppConfig = {
    mode: "test", port: 0,
    db: { host: RUNTIME_HOST, port: RUNTIME_PORT, database: DBNAME, poolMax: 20,
      auth: { user: "auth_runtime", password: undefined }, app: { user: "app_runtime", password: undefined }, otp: { user: "otp_dispatch_runtime", password: undefined } },
    otpSender: "test", ipHashSecret: Buffer.from("TEST_ONLY_ip_hash_secret_inventory_0123456789"), otpMacKey: TEST_OTP_MAC_KEY,
    otpDispatchIntervalMs: 1000, trustProxyHops: 0,
  };
  const { app } = await createApp(cfg, { otpSender: new TestOtpSender() });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;

  try {
    const A = await registerOwnerSql("Kios Inventori A");
    await makePro(A.tenant);
    const ADM = await inviteAndActivateAdminSql(A);
    const [admUser] = await admin<{ u: string }>("select user_id::text u from iam.membership where id=$1", [ADM.membership]);
    const B = await registerOwnerSql("Kios Inventori B");

    // ------------------------------------------------------------------ penerimaan (INV-01)
    await test("INV-REC-01", KA, "Penerimaan mencatat pemasok, dokumen, biaya, lokasi, batch/expiry, waktu & aktor; stok dan kolam biaya bertambah", async () => {
      const p = await pesticide(A.token);
      const r = await receive(ADM.token, {
        productId: p.id, supplierName: "PT Tani Uji", sourceDocument: "SJ-001",
        lines: [{ packageId: p.pkg.karton, qty: 2, status: "SALEABLE", batch: { number: "B-02", expiresOn: "2031-06-30" }, cost: { basis: "KNOWN", totalIdr: 2_500_000 } }],
      });
      eq(r.status, 201, r.text);
      const ev = r.body.eventId as string;
      const [x] = await admin<Record<string, string | number | null>>(
        `select e.kind, e.actor_user_id::text actor, e.location_id::text loc, e.event_at is not null has_at,
                s.supplier_name sup, s.source_document doc,
                (select count(*)::int from biz.inventory_ledger l where l.event_id=e.id and l.movement='RECEIPT' and l.qty_delta=2 and l.qty_base_delta=24 and l.actor_user_id=e.actor_user_id) led,
                (select bt.expires_on::text from biz.inventory_ledger l join biz.batch bt on bt.id=l.batch_id where l.event_id=e.id) exp,
                (select v.value_delta::int from biz.value_ledger v where v.event_id=e.id and v.cost_basis='KNOWN') val,
                (select count(*)::int from biz.audit_event a where a.entity_id=e.id and a.kind='STOCK_RECEIVED' and a.actor_user_id=e.actor_user_id) aud
           from biz.inventory_event e join biz.stock_receipt s on s.event_id=e.id where e.id=$1`, [ev]);
      ok(x.kind === "RECEIPT" && x.actor === admUser.u && x.sup === "PT Tani Uji" && x.doc === "SJ-001" && x.led === 1
         && x.exp === "2031-06-30" && x.val === 2_500_000 && x.aud === 1 && x.loc !== null, JSON.stringify(x));
      const pl = await pools(p.id);
      ok(pl.SALEABLE.q === 41 + 24 && pl.SALEABLE.v === 4_100_000 + 2_500_000, JSON.stringify(pl));
      const rs = await rows(A.token, p.id);
      eq(qtyOf(rs, p.pkg.karton, await batchId(p.id, "B-02"), "SALEABLE"), 2, "saldo batch B-02");
      return "1 event RECEIPT + header pemasok/dokumen + ledger 2 karton (24 botol) oleh Admin + nilai Rp2.500.000; kolam 65 botol/Rp6.600.000";
    });

    await test("ST-INV-05", KA, "Penerimaan stok dikirim ulang / dua koneksi -> hanya satu event dan satu penambahan stok", async () => {
      const p = await pesticide(A.token);
      const key = randomUUID();
      const body = { productId: p.id, lines: [line(p.pkg.botol, 7)] };
      const first = await receive(A.token, body, key);
      const again = await receive(A.token, body, key);
      const par = await Promise.all(Array.from({ length: 10 }, () => receive(A.token, body, key)));
      const reordered = await receive(A.token, { lines: body.lines, productId: p.id }, key);
      const diff = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 8)] }, key);
      eq(first.status, 201, first.text);
      ok(again.status === 201 && again.body.eventId === first.body.eventId && again.body.replayed === true, `ulang: ${again.text}`);
      ok(par.every((r) => r.status === 201 && r.body.eventId === first.body.eventId), par.map((r) => r.status).join(","));
      ok(reordered.status === 201 && reordered.body.eventId === first.body.eventId, `urutan kunci: ${reordered.status}`);
      ok(diff.status === 409 && diff.body.code === "IDEMPOTENCY_PAYLOAD_MISMATCH", `isi beda: ${diff.status} ${diff.body.code}`);
      eq(await count("select count(*)::int n from biz.inventory_event where product_id=$1 and kind='RECEIPT'", [p.id]), 1, "event RECEIPT");
      const pl = await pools(p.id);
      eq(pl.SALEABLE.q, 41 + 7, "stok bertambah sekali");
      // Panggilan database langsung dengan kunci sama & isi beda juga ditolak (hash dihitung database).
      const e = await errOf(sqlReceive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 9)] }, key));
      eq(e, "IDEMPOTENCY_PAYLOAD_MISMATCH", "database langsung");
      return "ulang + 10 serentak + urutan kunci beda -> event sama; isi beda -> 409 (API & DB); 1 event, stok +7 sekali";
    });

    await test("INV-REC-02", KA, "Barang kedaluwarsa: ditolak ke siap jual/pemeriksaan/ditahan, diterima ke karantina/rusak dan tidak bisa dipindah ke siap jual", async () => {
      const p = await pesticide(A.token);
      const exp = { number: "LAMA", expiresOn: "2020-01-01" };
      const rej = [];
      for (const status of ["SALEABLE", "INSPECTION", "HELD"]) rej.push(await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 2, { status, batch: exp })] }));
      ok(rej.every((r) => r.status === 400 && r.body.code === "BATCH_EXPIRED"), rej.map((r) => `${r.status}:${r.body.code}`).join(","));
      const q = await receive(ADM.token, { productId: p.id, lines: [line(p.pkg.botol, 2, { status: "QUARANTINE", batch: exp }), line(p.pkg.botol, 1, { status: "DAMAGED", batch: exp })] });
      eq(q.status, 201, q.text);
      const rs = await rows(A.token, p.id);
      ok(baseOf(rs, "QUARANTINE") === 2 && baseOf(rs, "DAMAGED") === 1 && baseOf(rs, "SALEABLE") === 41, JSON.stringify(rs.map((x) => [x.status, x.qtyBase])));
      const mv = await move(A.token, { productId: p.id, packageId: p.pkg.botol, batchId: await batchId(p.id, "LAMA"), from: "QUARANTINE", to: "SALEABLE", qty: 1, reason: "coba lepas" });
      ok(mv.status === 400 && mv.body.code === "BATCH_EXPIRED", `pindah ke siap jual: ${mv.status} ${mv.body.code}`);
      return "3 status layak jual -> 400 BATCH_EXPIRED; karantina 2 + rusak 1 diterima; siap jual tetap 41; karantina->siap jual 400";
    });

    await test("INV-REC-03", KA, "Penerimaan tidak sah ditolak tanpa efek samping (varian produk lain, qty 0, toko lain, field asing, basis biaya, tanpa kunci)", async () => {
      const p = await pesticide(A.token);
      const other = await pesticide(A.token);
      const before = await ledgerCount(p.id);
      const res = [
        ["varian produk lain", await receive(A.token, { productId: p.id, lines: [line(other.pkg.botol, 1)] }), 400, "PACKAGE_INVALID"],
        ["qty 0", await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 0)] }), 400, "VALIDATION_ERROR"],
        ["toko lain", await receive(B.token, { productId: p.id, lines: [line(p.pkg.botol, 1)] }), 404, "NOT_FOUND"],
        ["field tenant_id", await receive(A.token, { productId: p.id, tenant_id: B.tenant, lines: [line(p.pkg.botol, 1)] }), 400, "VALIDATION_ERROR"],
        ["field harga", await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { price: 5 })] }), 400, "VALIDATION_ERROR"],
        ["KNOWN Rp0", await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { cost: { basis: "KNOWN", totalIdr: 0 } })] }), 400, "COST_BASIS_INVALID"],
        ["UNVERIFIED + nilai", await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { cost: { basis: "UNVERIFIED", totalIdr: 9 } })] }), 400, "COST_BASIS_INVALID"],
        ["BONUS tanpa asal", await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { cost: { basis: "BONUS_ZERO", reason: "promo" } })] }), 400, "COST_BASIS_INVALID"],
        ["tanpa Idempotency-Key", await http("POST", "/inventory/receipts", A.token, { productId: p.id, supplierName: "PT X", lines: [line(p.pkg.botol, 1)] }), 400, "IDEMPOTENCY_KEY_REQUIRED"],
      ] as const;
      const bad = res.filter(([, r, s, c]) => r.status !== s || r.body.code !== c).map(([n, r]) => `${n}: ${r.status} ${String(r.body.code)}`);
      ok(bad.length === 0, bad.join("; "));
      eq(await ledgerCount(p.id), before, "ledger tidak bertambah");
      eq(await count("select count(*)::int n from biz.inventory_event where product_id=$1 and kind='RECEIPT'", [p.id]), 0, "event");
      return `${res.length} penolakan sesuai kode; ledger & event tidak bertambah`;
    });

    await test("INV-REC-04", KA, "Penerimaan basis biaya belum terverifikasi diberi label; bonus nol menyimpan alasan & asal (COST-06)", async () => {
      const p = await pesticide(A.token);
      const bonus = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 4, { cost: { basis: "BONUS_ZERO", reason: "Bonus pembelian", origin: "Nota PT Uji 9" } })] });
      eq(bonus.status, 201, bonus.text);
      let prod = await http("GET", `/products/${p.id}`, A.token);
      eq(prod.body.costStatus, "VERIFIED", "bonus bukan biaya tak diketahui");
      const un = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 2, { cost: { basis: "UNVERIFIED" } })] });
      eq(un.status, 201, un.text);
      prod = await http("GET", `/products/${p.id}`, A.token);
      eq(prod.body.costStatus, "UNVERIFIED", "label HPP belum terverifikasi");
      const [v] = await admin<{ r: string; o: string }>("select basis_reason r, basis_origin o from biz.value_ledger where event_id=$1", [bonus.body.eventId]);
      ok(v.r === "Bonus pembelian" && v.o === "Nota PT Uji 9", JSON.stringify(v));
      return "BONUS_ZERO -> VERIFIED + alasan/asal tersimpan; UNVERIFIED -> costStatus UNVERIFIED";
    });

    await test("INV-SUB-01", KA, "Pupuk subsidi tidak bisa ditambah lewat Tambah Stok umum (API, fungsi DB, dan insert ledger langsung); produk nonsubsidi tetap bisa", async () => {
      const sub = await createProduct(A.token, {
        sku: sku("SUB"), name: "Urea Subsidi", category: "FERTILIZER", subsidized: true, baseUnit: "kg",
        packages: [{ key: "sak", form: "SEALED", factor: 50, label: "Sak 50 kg", mayOpen: false }],
        opening: [{ packageKey: "sak", qty: 0, cost: { basis: "KNOWN", totalIdr: 0 } }],
      });
      const before = await ledgerCount(sub.id);
      const body = { productId: sub.id, lines: [{ packageId: sub.pkg.sak, qty: 10, status: "SALEABLE", cost: { basis: "KNOWN", totalIdr: 1_125_000 } }] };
      const r1 = await receive(A.token, body);
      const r2 = await receive(ADM.token, { ...body, lines: [{ ...body.lines[0], status: "QUARANTINE" }] });
      const e3 = await errOf(sqlReceive(A.token, body));
      ok(r1.status === 409 && r1.body.code === "SUBSIDY_RECEIPT_SEPARATE", `Owner: ${r1.status} ${String(r1.body.code)}`);
      ok(r2.status === 409 && r2.body.code === "SUBSIDY_RECEIPT_SEPARATE", `Admin/karantina: ${r2.status} ${String(r2.body.code)}`);
      eq(e3, "SUBSIDY_RECEIPT_SEPARATE", "fungsi database langsung");
      // Lapis kedua: insert ledger RECEIPT langsung (superuser, melewati fungsi) tetap ditolak trigger.
      const [ev] = await admin<{ id: string; loc: string; b: string }>(
        "select e.id::text, e.location_id::text loc, (select id::text from biz.batch where product_id=$1 limit 1) b from biz.inventory_event e where e.product_id=$1 and e.kind='OPENING'", [sub.id]);
      const e4 = await errOf(admin(
        `insert into biz.inventory_ledger (tenant_id, event_id, movement, location_id, product_id, package_version_id, batch_id, status, qty_delta, qty_base_delta, actor_user_id, event_at)
         select $1, $2, 'RECEIPT', $3, $4, $5, $6, 'SALEABLE', 1, 50, created_by, now() from biz.product where id=$4`, [A.tenant, ev.id, ev.loc, sub.id, sub.pkg.sak, ev.b]));
      eq(e4, "SUBSIDY_RECEIPT_SEPARATE", "insert ledger langsung");
      eq(await ledgerCount(sub.id), before, "ledger subsidi tidak bertambah");
      const pl = await pools(sub.id);
      eq(pl.SALEABLE.q, 0, "stok subsidi tetap 0");
      const p = await pesticide(A.token);
      eq((await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1)] })).status, 201, "nonsubsidi tetap bisa");
      return "API Owner/Admin 409 SUBSIDY_RECEIPT_SEPARATE; fungsi DB & insert ledger langsung ditolak; stok subsidi tetap 0; nonsubsidi 201";
    });

    // ------------------------------------------------------------------ buka karton (INV-05)
    await test("ST-INV-02", KA, "Stok 3 karton isi 12 + 5 botol -> total setara 41, tidak dihitung ganda", async () => {
      const p = await pesticide(A.token);
      const rs = await rows(A.token, p.id);
      eq(baseOf(rs), 41, "total setara");
      const prod = await http("GET", `/products/${p.id}`, A.token);
      eq((prod.body.stockBase as Record<string, number>).SALEABLE, 41, "stockBase");
      return "stok 41 botol (rincian & ringkasan produk)";
    });

    await test("ST-INV-03", KA, "Buka 1 karton isi 12 -> karton -1, botol lepas +12, total 41 dan nilai biaya tetap", async () => {
      const p = await pesticide(A.token);
      const b1 = await batchId(p.id, "B-01");
      const before = await pools(p.id);
      const r = await openPkg(ADM.token, p.pkg.karton, { batchId: b1, physicalConfirmed: true });
      eq(r.status, 201, r.text);
      const rs = await rows(A.token, p.id);
      const after = await pools(p.id);
      ok(qtyOf(rs, p.pkg.karton, b1, "SALEABLE") === 2 && qtyOf(rs, p.pkg.botol, b1, "SALEABLE") === 17 && baseOf(rs) === 41,
         JSON.stringify(rs.map((x) => [x.qty, x.qtyBase])));
      ok(after.SALEABLE.q === before.SALEABLE.q && after.SALEABLE.v === before.SALEABLE.v && after.SALEABLE.v === 4_100_000, JSON.stringify(after));
      const [l] = await admin<{ n: number; s: string }>("select count(*)::int n, sum(qty_base_delta)::text s from biz.inventory_ledger where event_id=$1", [r.body.eventId]);
      ok(l.n === 2 && l.s === "0", JSON.stringify(l));
      eq(await count("select count(*)::int n from biz.value_ledger where event_id=$1", [r.body.eventId]), 0, "tidak ada mutasi nilai");
      return "2 karton + 17 botol = 41; kolam Rp4.100.000 tetap; 2 baris ledger berjumlah 0 satuan dasar";
    });

    await test("ST-INV-08", KA, "Buka karton dari batch A -> semua botol lepas mengikuti batch/expiry A", async () => {
      const p = await pesticide(A.token);
      const rcv = await receive(A.token, { productId: p.id, lines: [line(p.pkg.karton, 1, { batch: { number: "B-BB", expiresOn: "2029-01-31" }, cost: { basis: "KNOWN", totalIdr: 1_200_000 } })] });
      eq(rcv.status, 201, rcv.text);
      const bA = await batchId(p.id, "B-BB");
      const bB = await batchId(p.id, "B-01");
      const r = await openPkg(A.token, p.pkg.karton, { batchId: bA, physicalConfirmed: true });
      eq(r.status, 201, r.text);
      const rs = await rows(A.token, p.id);
      ok(qtyOf(rs, p.pkg.botol, bA, "SALEABLE") === 12 && qtyOf(rs, p.pkg.karton, bA, "SALEABLE") === 0
         && qtyOf(rs, p.pkg.botol, bB, "SALEABLE") === 5 && qtyOf(rs, p.pkg.karton, bB, "SALEABLE") === 3, JSON.stringify(rs));
      const [x] = await admin<{ e: string }>("select bt.expires_on::text e from biz.inventory_ledger l join biz.batch bt on bt.id=l.batch_id where l.event_id=$1 and l.qty_delta>0", [r.body.eventId]);
      eq(x.e, "2029-01-31", "expiry botol lepas");
      return "12 botol lepas tercatat di batch A (exp 2029-01-31); batch B tidak berubah";
    });

    await test("ST-INV-12", KA, "Kemasan tidak boleh dibuka dipanggil endpoint konversi -> ditolak server; tanpa konfirmasi fisik juga ditolak", async () => {
      const fert = await createProduct(A.token, {
        sku: sku("SAK"), name: "Pupuk Sak", category: "FERTILIZER", subsidized: false, baseUnit: "kg",
        packages: [{ key: "sak", form: "SEALED", factor: 50, label: "Sak 50 kg", mayOpen: false }, { key: "kg", form: "LOOSE", factor: 1, label: "Kg" }],
        opening: [{ packageKey: "sak", qty: 4, cost: { basis: "KNOWN", totalIdr: 1_000_000 } }],
      });
      const [b] = await admin<{ id: string }>("select id::text from biz.batch where product_id=$1", [fert.id]);
      const before = await ledgerCount(fert.id);
      const r1 = await openPkg(A.token, fert.pkg.sak, { batchId: b.id, physicalConfirmed: true });
      const r2 = await openPkg(A.token, fert.pkg.kg, { batchId: b.id, physicalConfirmed: true });
      const e3 = await errOf(asActor(A.token, "select app.package_open($1, $2, $3::jsonb)", [randomUUID(), fert.pkg.sak, JSON.stringify({ batchId: b.id, physicalConfirmed: true })]));
      const p = await pesticide(A.token);
      const r4 = await openPkg(A.token, p.pkg.karton, { batchId: await batchId(p.id, "B-01"), physicalConfirmed: false });
      const r5 = await openPkg(B.token, p.pkg.karton, { batchId: await batchId(p.id, "B-01"), physicalConfirmed: true });
      ok(r1.status === 409 && r1.body.code === "PACKAGE_NOT_OPENABLE", `sak: ${r1.status} ${r1.body.code}`);
      ok(r2.status === 409 && r2.body.code === "PACKAGE_NOT_OPENABLE", `lepas: ${r2.status} ${r2.body.code}`);
      eq(e3, "PACKAGE_NOT_OPENABLE", "database langsung");
      ok(r4.status === 400 && r4.body.code === "PHYSICAL_CONFIRMATION_REQUIRED", `konfirmasi: ${r4.status} ${r4.body.code}`);
      ok(r5.status === 404, `toko lain: ${r5.status}`);
      const big = await createProduct(A.token, {
        sku: sku("BIG"), name: "Isi besar", category: "TOOL", subsidized: false, baseUnit: "pcs",
        packages: [{ key: "dus", form: "SEALED", factor: 1_000_000, label: "Dus", mayOpen: true }, { key: "pcs", form: "LOOSE", factor: 1, label: "Pcs" }],
        opening: [{ packageKey: "dus", qty: 0, cost: { basis: "KNOWN", totalIdr: 0 } }],
      });
      const [bb] = await admin<{ id: string }>("select id::text from biz.batch where product_id=$1", [big.id]);
      const r6 = await openPkg(A.token, big.pkg.dus, { batchId: bb.id, qty: 10_000, physicalConfirmed: true });
      ok(r6.status === 400 && r6.body.code === "VALIDATION", `melebihi batas integer: ${r6.status} ${r6.text}`);
      eq(await ledgerCount(fert.id), before, "ledger tidak berubah");
      return "may_open=false & unit lepas -> 409 (API & DB); tanpa konfirmasi fisik -> 400; toko lain -> 404; ledger tetap";
    });

    await test("INV-OPEN-01", KD, "Delapan permintaan buka karton serentak atas 1 karton terakhir -> tepat satu berhasil, stok tidak negatif", async () => {
      const p = await pesticide(A.token, {
        opening: [{ packageKey: "karton", qty: 1, batch: { number: "B-01", expiresOn: "2030-12-31" }, cost: { basis: "KNOWN", totalIdr: 1_200_000 } }],
      });
      const b1 = await batchId(p.id, "B-01");
      const res = await Promise.all(Array.from({ length: 8 }, () =>
        errOf(asActor(A.token, "select app.package_open($1, $2, $3::jsonb)", [randomUUID(), p.pkg.karton, JSON.stringify({ batchId: b1, physicalConfirmed: true })]))));
      const okN = res.filter((x) => x === "OK").length;
      const insuf = res.filter((x) => x === "INSUFFICIENT_STOCK").length;
      ok(okN === 1 && insuf === 7, res.join(","));
      const rs = await rows(A.token, p.id);
      ok(qtyOf(rs, p.pkg.karton, b1, "SALEABLE") === 0 && qtyOf(rs, p.pkg.botol, b1, "SALEABLE") === 12 && rs.every((x) => x.qty >= 0), JSON.stringify(rs));
      return "1 OK + 7 INSUFFICIENT_STOCK; karton 0, botol 12";
    });

    // ------------------------------------------------------------------ tahan / lepas (INV-06)
    await test("ST-INV-07-INV", KA, "Admin menahan batch -> stok siap jual langsung 0 & tidak bisa diisi; pelepasan hanya Owner (API & database)", async () => {
      const p = await pesticide(A.token);
      const b1 = await batchId(p.id, "B-01");
      const h = await hold(ADM.token, { productId: p.id, batchId: b1, reason: "Laporan botol bocor" });
      eq(h.status, 201, h.text);
      const holdId = h.body.holdId as string;
      let rs = await rows(A.token, p.id);
      ok(baseOf(rs, "SALEABLE") === 0 && baseOf(rs, "HELD") === 41, `setelah tahan: ${JSON.stringify(rs.map((x) => [x.status, x.qtyBase]))}`);
      const rcv = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 3)] });
      ok(rcv.status === 409 && rcv.body.code === "HOLD_ACTIVE", `terima ke siap jual: ${rcv.status} ${rcv.body.code}`);
      const rcvOther = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 3, { batch: { number: "B-LAIN", expiresOn: "2031-01-01" } })] });
      eq(rcvOther.status, 201, `batch lain tidak tercakup: ${rcvOther.text}`);
      const mv = await move(A.token, { productId: p.id, packageId: p.pkg.botol, batchId: b1, from: "HELD", to: "SALEABLE", qty: 1, reason: "coba" });
      ok(mv.status === 409 && mv.body.code === "HOLD_ACTIVE", `owner pindah ke siap jual: ${mv.status} ${mv.body.code}`);
      const admRel = await release(ADM.token, holdId, { reason: "admin coba lepas" });
      ok(admRel.status === 403 && admRel.body.code === "FORBIDDEN_ROLE", `admin lepas (API): ${admRel.status} ${admRel.body.code}`);
      const admDb = await errOf(asActor(ADM.token, "select app.stock_release($1, $2, $3::jsonb)", [randomUUID(), holdId, JSON.stringify({ reason: "x" })]));
      eq(admDb, "FORBIDDEN_ROLE", "admin lepas (database langsung)");
      rs = await rows(A.token, p.id);
      eq(baseOf(rs.filter((x) => x.batchId === b1), "SALEABLE"), 0, "masih 0 setelah percobaan admin");
      const rel = await ownerRelease(A.token, holdId, "Diperiksa, aman");
      eq(rel.status, 200, rel.text);
      rs = await rows(A.token, p.id);
      ok(baseOf(rs.filter((x) => x.batchId === b1), "SALEABLE") === 41 && baseOf(rs, "HELD") === 0, JSON.stringify(rs.map((x) => [x.status, x.qtyBase])));
      const again = await ownerRelease(A.token, holdId, "lagi");
      ok(again.status === 409 && again.body.code === "HOLD_NOT_ACTIVE", `lepas ulang: ${again.status}`);
      const [hh] = await admin<{ rb: string }>("select released_by::text rb from biz.stock_hold where id=$1", [holdId]);
      const [ow] = await admin<{ u: string }>("select user_id::text u from iam.membership where tenant_id=$1 and role='OWNER'", [A.tenant]);
      eq(hh.rb, ow.u, "dilepas oleh Owner");
      return "tahan Admin: siap jual 41->0; terima ke siap jual 409 HOLD_ACTIVE; Admin lepas 403 (API & DB); Owner lepas -> 41 kembali; lepas ulang 409";
    });
    notRun("ST-INV-07-POS", KA, "Batch ditahan: penjualan POS langsung diblokir", "Checkout POS belum dibangun; sisi inventori (siap jual 0 & terkunci) diuji di ST-INV-07-INV");

    await test("INV-HOLD-02", KA, "Pelepasan tidak membuka stok yang kedaluwarsa atau masih dicakup penahanan lain (dilaporkan, tidak dibuang diam-diam)", async () => {
      const p = await pesticide(A.token);
      const r = await receive(A.token, { productId: p.id, lines: [
        line(p.pkg.botol, 10, { batch: { number: "B-X", expiresOn: "2032-01-01" } }),
        line(p.pkg.botol, 2, { status: "QUARANTINE", batch: { number: "B-OLD", expiresOn: "2020-01-01" } })] });
      eq(r.status, 201, r.text);
      const b1 = await batchId(p.id, "B-01");
      const bx = await batchId(p.id, "B-X");
      const bo = await batchId(p.id, "B-OLD");
      // Barang kedaluwarsa dipindah Owner ke HELD (bukan siap jual) agar tercakup pelepasan.
      const mv = await move(A.token, { productId: p.id, packageId: p.pkg.botol, batchId: bo, from: "QUARANTINE", to: "HELD", qty: 2, reason: "tahan untuk retur" });
      eq(mv.status, 201, mv.text);
      const hb = await hold(A.token, { productId: p.id, batchId: b1, reason: "batch dicurigai" });
      const hp = await hold(ADM.token, { productId: p.id, reason: "penarikan produk" });
      ok(hb.status === 201 && hp.status === 201, `${hb.text} ${hp.text}`);
      const blocked = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { batch: { number: "B-BARU", expiresOn: "2033-01-01" } })] });
      ok(blocked.status === 409 && blocked.body.code === "HOLD_ACTIVE", `tahan produk memblokir batch baru: ${blocked.status}`);
      const relB = await ownerRelease(A.token, hb.body.holdId as string, "batch aman");
      eq(relB.status, 200, relB.text);
      const nr = relB.body.notReleased as { reason: string }[];
      ok(Number(relB.body.releasedQtyBase) === 0 && nr.length > 0 && nr.every((x) => x.reason === "OTHER_HOLD_ACTIVE"), `lepas batch: ${relB.text}`);
      let rs = await rows(A.token, p.id);
      eq(baseOf(rs, "SALEABLE"), 0, "masih tertahan oleh penahanan produk");
      const relP = await ownerRelease(A.token, hp.body.holdId as string, "penarikan dibatalkan");
      eq(relP.status, 200, relP.text);
      rs = await rows(A.token, p.id);
      const nr2 = relP.body.notReleased as { reason: string; batchId: string }[];
      ok(baseOf(rs.filter((x) => x.batchId === bx), "SALEABLE") === 10 && baseOf(rs.filter((x) => x.batchId === b1), "SALEABLE") === 41,
         `B-X & B-01 kembali: ${JSON.stringify(rs)}`);
      ok(baseOf(rs.filter((x) => x.batchId === bo), "SALEABLE") === 0 && nr2.some((x) => x.reason === "BATCH_EXPIRED" && x.batchId === bo), `B-OLD kedaluwarsa tetap ditahan: ${relP.text}`);
      eq(baseOf(rs.filter((x) => x.batchId === bo), "HELD"), 2, "B-OLD tetap HELD");
      // Setelah semua penahanan dilepas, stok tidak kedaluwarsa tidak boleh tertinggal di HELD ("yatim").
      const [orphan] = await admin<{ n: number }>(
        `select coalesce(sum(b.qty),0)::int n from biz.stock_balance b join biz.batch bt on bt.id=b.batch_id
          where b.product_id=$1 and b.status='HELD' and (bt.expires_on is null or bt.expires_on >= current_date)`, [p.id]);
      eq(orphan.n, 0, "stok layak yang tertinggal ditahan");
      return "lepas batch saat tahan produk aktif -> 0 dilepas (OTHER_HOLD_ACTIVE); lepas produk -> B-01 41 & B-X 10 kembali, B-OLD kedaluwarsa tetap HELD (BATCH_EXPIRED); 0 stok layak tertinggal";
    });

    await test("INV-HOLD-03", KD, "Tahan vs penerimaan siap jual serentak (10 putaran): saat penahanan aktif, stok siap jual dalam cakupan selalu 0", async () => {
      const viol: string[] = [];
      for (let i = 0; i < 10; i++) {
        const p = await pesticide(A.token);
        const b1 = await batchId(p.id, "B-01");
        const [h, rcv] = await Promise.all([
          errOf(asActor(ADM.token, "select app.stock_hold($1, $2::jsonb)", [randomUUID(), JSON.stringify({ productId: p.id, batchId: b1, reason: "uji balapan" })])),
          errOf(sqlReceive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 2)] })),
        ]);
        if (h !== "OK" || !(rcv === "OK" || rcv === "HOLD_ACTIVE")) viol.push(`putaran ${i}: tahan=${h} terima=${rcv}`);
        const [s] = await admin<{ q: number }>(
          "select coalesce(sum(qty),0)::int q from biz.stock_balance where product_id=$1 and batch_id=$2 and status='SALEABLE'", [p.id, b1]);
        if (s.q !== 0) viol.push(`putaran ${i}: siap jual=${s.q} terima=${rcv}`);
      }
      ok(viol.length === 0, viol.join("; "));
      return "10 putaran: tidak ada stok siap jual di bawah penahanan aktif";
    });

    // ------------------------------------------------------------------ nilai HPP antarstatus (COST-05)
    await test("ST-COST-06", KA, "3 botol Rp100 siap jual; 1 ditahan lalu 2 sisanya ditahan -> nilai pindah Rp33 lalu Rp67; total Rp100", async () => {
      const p = await createProduct(A.token, {
        sku: sku("C06"), name: "Botol Rp100", category: "PESTICIDE", subsidized: false, baseUnit: "botol",
        packages: [{ key: "botol", form: "LOOSE", factor: 1, label: "Botol" }],
        opening: [{ packageKey: "botol", qty: 3, batch: { number: "K1" }, cost: { basis: "KNOWN", totalIdr: 100 } }],
      });
      const bk = await batchId(p.id, "K1");
      const m1 = await move(A.token, { productId: p.id, packageId: p.pkg.botol, batchId: bk, from: "SALEABLE", to: "HELD", qty: 1, reason: "tahan 1" });
      const m2 = await move(A.token, { productId: p.id, packageId: p.pkg.botol, batchId: bk, from: "SALEABLE", to: "HELD", qty: 2, reason: "tahan 2" });
      ok(m1.status === 201 && m2.status === 201, `${m1.text} ${m2.text}`);
      ok(m1.body.valueMovedIdr === 33 && m2.body.valueMovedIdr === 67, `nilai: ${String(m1.body.valueMovedIdr)}, ${String(m2.body.valueMovedIdr)}`);
      const pl = await pools(p.id);
      ok(pl.SALEABLE.q === 0 && pl.SALEABLE.v === 0 && pl.HELD.q === 3 && pl.HELD.v === 100, JSON.stringify(pl));
      const [s] = await admin<{ v: string }>("select sum(value_delta)::text v from biz.value_ledger where product_id=$1 and cost_basis='MOVE'", [p.id]);
      eq(s.v, "0", "baris MOVE berjumlah nol");
      return "pindah Rp33 + Rp67; siap jual 0/Rp0, ditahan 3/Rp100; ledger MOVE seimbang";
    });

    await test("ST-COST-03", KA, "Karton dibuka dan batch berubah status -> total nilai persediaan tetap", async () => {
      const p = await pesticide(A.token);
      const b1 = await batchId(p.id, "B-01");
      const t0 = sumPools(await pools(p.id));
      const o = await openPkg(A.token, p.pkg.karton, { batchId: b1, physicalConfirmed: true });
      const m = await move(A.token, { productId: p.id, packageId: p.pkg.botol, batchId: b1, from: "SALEABLE", to: "QUARANTINE", qty: 7, reason: "segel rusak" });
      const h = await hold(ADM.token, { productId: p.id, reason: "cek mutu" });
      ok(o.status === 201 && m.status === 201 && h.status === 201, `${o.status} ${m.status} ${h.status}`);
      const pl = await pools(p.id);
      const t1 = sumPools(pl);
      ok(t0.q === 41 && t0.v === 4_100_000 && t1.q === 41 && t1.v === 4_100_000, `sebelum ${JSON.stringify(t0)} sesudah ${JSON.stringify(t1)} ${JSON.stringify(pl)}`);
      ok(pl.QUARANTINE.v === Math.floor(4_100_000 * 7 / 41), `nilai karantina floor: ${pl.QUARANTINE.v}`);
      return `total 41 botol/Rp4.100.000 tetap; karantina 7 botol Rp${pl.QUARANTINE.v} (floor)`;
    });

    await test("INV-MOVE-01", KA, "Pindah status hanya Owner; tidak bisa melebihi stok; label HPP belum terverifikasi ikut pindah", async () => {
      const p = await createProduct(A.token, {
        sku: sku("MV"), name: "Botol UNVERIFIED", category: "PESTICIDE", subsidized: false, baseUnit: "botol",
        packages: [{ key: "botol", form: "LOOSE", factor: 1, label: "Botol" }],
        opening: [{ packageKey: "botol", qty: 4, batch: { number: "U1" }, cost: { basis: "UNVERIFIED" } }],
      });
      const other = await pesticide(A.token);
      const bu = await batchId(p.id, "U1");
      const mk = (o: Record<string, unknown> = {}) => ({ productId: p.id, packageId: p.pkg.botol, batchId: bu, from: "SALEABLE", to: "DAMAGED", qty: 1, reason: "pecah", ...o });
      const adm = await move(ADM.token, mk());
      const admDb = await errOf(asActor(ADM.token, "select app.stock_move($1, $2::jsonb)", [randomUUID(), JSON.stringify(mk())]));
      const same = await move(A.token, mk({ to: "SALEABLE" }));
      const over = await move(A.token, mk({ qty: 5 }));
      const otherPkg = await move(A.token, mk({ packageId: other.pkg.botol }));
      ok(adm.status === 403 && adm.body.code === "FORBIDDEN_ROLE" && admDb === "FORBIDDEN_ROLE", `admin: ${adm.status} / ${admDb}`);
      ok(same.status === 400, `asal=tujuan: ${same.status}`);
      ok(over.status === 409 && over.body.code === "INSUFFICIENT_STOCK", `melebihi: ${over.status} ${over.body.code}`);
      ok(otherPkg.status === 400 && otherPkg.body.code === "PACKAGE_INVALID", `varian lain: ${otherPkg.status}`);
      const good = await move(A.token, mk({ qty: 2 }));
      eq(good.status, 201, good.text);
      const pl = await pools(p.id);
      ok(pl.DAMAGED.q === 2 && pl.DAMAGED.u === true, `label pindah: ${JSON.stringify(pl)}`);
      return "Admin 403 (API & DB); asal=tujuan 400; melebihi 409; varian lain 400; Owner pindah 2 -> kolam rusak tetap UNVERIFIED";
    });

    // ------------------------------------------------------------------ perbaikan audit PR #7
    await test("INV-AUD-01-API", KA, "Pelepasan penahanan wajib reautentikasi Owner: tanpa/palsu/kedaluwarsa/salah objek ditolak; Admin tidak bisa; reautentikasi sah diterima", async () => {
      const p = await pesticide(A.token);
      const b1 = await batchId(p.id, "B-01");
      const h1 = await hold(ADM.token, { productId: p.id, batchId: b1, reason: "cek" });
      const p2 = await pesticide(A.token);
      const h2 = await hold(ADM.token, { productId: p2.id, reason: "cek 2" });
      const id1 = h1.body.holdId as string;
      const id2 = h2.body.holdId as string;
      const none = await release(A.token, id1, { reason: "tanpa reauth" });
      const forged = await release(A.token, id1, { reason: "palsu", reauthToken: "ab".repeat(32) });
      const admReauth = await reauth(ADM.token, id1);
      const wrongPw = await reauth(A.token, id1, "sandi-salah-sekali");
      const g2 = await reauth(A.token, id2);
      const otherTarget = await release(A.token, id1, { reason: "token objek lain", reauthToken: g2.body.reauthToken });
      const gExp = await reauth(A.token, id1);
      await sleep(5_600);   // reauth_ttl_seconds uji = 5 (TEST_ONLY)
      const expired = await release(A.token, id1, { reason: "kedaluwarsa", reauthToken: gExp.body.reauthToken });
      const g1 = await reauth(A.token, id1);
      const admUse = await release(ADM.token, id1, { reason: "admin pakai token owner", reauthToken: g1.body.reauthToken });
      const bad = [["tanpa token", none], ["token palsu", forged], ["token objek lain", otherTarget], ["kedaluwarsa", expired]]
        .filter(([, r]) => (r as Res).status !== 403 || (r as Res).body.code !== "REAUTH_REQUIRED").map(([n, r]) => `${String(n)}: ${(r as Res).status} ${String((r as Res).body.code)}`);
      ok(bad.length === 0, bad.join("; "));
      ok(admReauth.status === 403 && admReauth.body.code === "FORBIDDEN_ROLE", `admin reauth: ${admReauth.status} ${String(admReauth.body.code)}`);
      ok(wrongPw.status === 401 && wrongPw.body.code === "REAUTH_INVALID" && wrongPw.body.reauthToken === undefined, `sandi salah: ${wrongPw.status}`);
      ok(admUse.status === 403 && admUse.body.code === "FORBIDDEN_ROLE", `admin pakai token owner: ${admUse.status}`);
      let rs = await rows(A.token, p.id);
      eq(baseOf(rs, "SALEABLE"), 0, "stok tetap ditahan setelah percobaan tidak sah");
      const okRel = await release(A.token, id1, { reason: "diperiksa", reauthToken: g1.body.reauthToken });
      eq(okRel.status, 200, okRel.text);
      rs = await rows(A.token, p.id);
      eq(baseOf(rs, "SALEABLE"), 41, "dilepas setelah reautentikasi");
      const [aud] = await admin<{ n: number }>("select count(*)::int n from iam.auth_event where tenant_id=$1 and kind='REAUTH_FAILED'", [A.tenant]);
      ok(aud.n >= 1, "kegagalan reautentikasi diaudit");
      return "tanpa/palsu/objek lain/kedaluwarsa -> 403 REAUTH_REQUIRED; Admin reauth & pakai token Owner -> 403; sandi salah 401 tanpa token; reauth sah -> 200, stok kembali 41";
    });

    await test("INV-AUD-01-DB", KD, "Bukti reautentikasi: dicek database, hanya hash disimpan, sekali pakai, terikat sesi, runtime tak bisa baca/memalsukan, percobaan sandi dibatasi", async () => {
      const O = await registerOwnerSql("Kios Reauth");
      const p = await pesticide(O.token);
      const h = (await asActor<{ r: { holdId: string } }>(O.token, "select app.stock_hold($1, $2::jsonb) r", [randomUUID(), JSON.stringify({ productId: p.id, reason: "uji db" })]))[0].r.holdId;
      const relSql = (tok: string | undefined, token = O.token) =>
        errOf(asActor(token, "select app.stock_release($1, $2, $3::jsonb)", [randomUUID(), h, JSON.stringify(tok ? { reason: "x", reauthToken: tok } : { reason: "x" })]));
      eq(await relSql(undefined), "REAUTH_REQUIRED", "fungsi DB tanpa token");
      const [g] = await asActor<{ r: { status: string; reauthToken: string } }>(O.token, "select app.reauth_start($1,'inventory.release',$2) r", [PW, h]);
      eq(g.r.status, "OK", "reauth_start");
      const tok = g.r.reauthToken;
      const [row] = await admin<{ n: number; used: boolean }>(
        "select count(*)::int n, bool_or(used_at is not null) used from iam.reauth_grant where token_hash = sha256(decode($1,'hex'))", [tok]);
      ok(row.n === 1 && row.used === false, JSON.stringify(row));
      const [plain] = await admin<{ n: number }>("select count(*)::int n from iam.reauth_grant g where g::text like '%'||$1||'%'", [tok]);
      eq(plain.n, 0, "token mentah tersimpan");
      // Runtime tidak bisa membaca tabel bukti atau memanggil fungsi konsumsi langsung.
      const e1 = await errOf(asRole("app_runtime", "select 1 from iam.reauth_grant"));
      const [fx] = await admin<{ c: boolean; t: boolean }>(
        "select has_function_privilege('app_runtime','iam.reauth_consume(text,text,uuid)','EXECUTE') c, has_table_privilege('app_runtime','iam.reauth_grant','INSERT') t");
      ok(e1.startsWith("42501") && !fx.c && !fx.t, `${e1} ${JSON.stringify(fx)}`);
      eq(await relSql(tok), "OK", "pemakaian pertama");
      eq(await relSql(tok), "REAUTH_REQUIRED", "pemakaian ulang");
      const e2 = await errOf(admin("update iam.reauth_grant set used_at = null where token_hash = sha256(decode($1,'hex'))", [tok]));
      eq(e2, "APPEND_ONLY", "superuser mengosongkan used_at");
      // Terikat sesi: token dari sesi lama tidak berlaku di sesi baru.
      const h2 = (await asActor<{ r: { holdId: string } }>(O.token, "select app.stock_hold($1, $2::jsonb) r", [randomUUID(), JSON.stringify({ productId: p.id, reason: "uji sesi" })]))[0].r.holdId;
      const [g2] = await asActor<{ r: { reauthToken: string } }>(O.token, "select app.reauth_start($1,'inventory.release',$2) r", [PW, h2]);
      const [l] = await asRole<{ r_status: string; r_token: string }>("auth_runtime", "select * from iam.login($1,$2,$3)", [O.phone, PW, "dev-sesi-baru-123"]);
      eq(l.r_status, "OK", "login sesi baru");
      const e3 = await errOf(asActor(l.r_token, "select app.stock_release($1, $2, $3::jsonb)", [randomUUID(), h2, JSON.stringify({ reason: "x", reauthToken: g2.r.reauthToken })]));
      eq(e3, "REAUTH_REQUIRED", "token sesi lain");
      // Batas percobaan sandi (memakai parameter login_max_failures yang sudah ada; uji = 5).
      const R = await registerOwnerSql("Kios Reauth Limit");
      const out: string[] = [];
      for (let i = 0; i < 6; i++) out.push((await asActor<{ r: { status: string } }>(R.token, "select app.reauth_start($1,'inventory.release',gen_random_uuid()) r", ["salah-" + i]))[0].r.status);
      const last = (await asActor<{ r: { status: string } }>(R.token, "select app.reauth_start($1,'inventory.release',gen_random_uuid()) r", [PW]))[0].r.status;
      ok(out.slice(0, 5).every((x) => x === "INVALID_CREDENTIALS") && out[5] === "RATE_LIMITED" && last === "RATE_LIMITED", `${out.join(",")} | sandi benar: ${last}`);
      return "tanpa token -> REAUTH_REQUIRED (DB); hanya hash; runtime 42501; pakai ulang ditolak; used_at tak bisa dikosongkan; token sesi lain ditolak; 5 salah -> dibatasi (sandi benar pun)";
    });

    await test("INV-AUD-02-API", KA, "Penerimaan tanpa pemasok (kosong/spasi) ditolak API; dengan pemasok diterima dan tersimpan apa adanya", async () => {
      const p = await pesticide(A.token);
      const before = await ledgerCount(p.id);
      const r1 = await rawReceive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1)] });
      const r2 = await rawReceive(A.token, { productId: p.id, supplierName: "   ", lines: [line(p.pkg.botol, 1)] });
      ok(r1.status === 400 && (r1.body.fields as string[]).includes("supplierName"), `tanpa pemasok: ${r1.text}`);
      ok(r2.status === 400 && (r2.body.fields as string[]).includes("supplierName"), `spasi: ${r2.text}`);
      eq(await ledgerCount(p.id), before, "ledger tidak bertambah");
      const r3 = await rawReceive(A.token, { productId: p.id, supplierName: "  CV Tani Makmur ", lines: [line(p.pkg.botol, 1)] });
      eq(r3.status, 201, r3.text);
      const [x] = await admin<{ s: string }>("select supplier_name s from biz.stock_receipt where event_id=$1", [r3.body.eventId]);
      eq(x.s, "CV Tani Makmur", "pemasok tersimpan (dirapikan spasi)");
      return "tanpa pemasok & spasi -> 400 (field supplierName); ledger tetap; dengan pemasok -> 201";
    });

    await test("INV-AUD-02-DB", KD, "Pemasok wajib juga di database: fungsi SQL langsung & insert langsung tanpa pemasok ditolak; tidak ada pemasok fiktif", async () => {
      const p = await pesticide(A.token);
      const before = await ledgerCount(p.id);
      const raw = (b: unknown) => errOf(asActor(A.token, "select app.inventory_receive($1, $2::jsonb)", [randomUUID(), JSON.stringify(b)]));
      const e1 = await raw({ productId: p.id, lines: [line(p.pkg.botol, 1)] });
      const e2 = await raw({ productId: p.id, supplierName: "  ", lines: [line(p.pkg.botol, 1)] });
      const e3 = await raw({ productId: p.id, supplierName: null, lines: [line(p.pkg.botol, 1)] });
      ok(e1 === "SUPPLIER_REQUIRED" && e2 === "SUPPLIER_REQUIRED" && e3 === "SUPPLIER_REQUIRED", `${e1} | ${e2} | ${e3}`);
      eq(await ledgerCount(p.id), before, "ledger tidak bertambah");
      const c = new Client({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, database: DBNAME });
      await c.connect();
      const out: string[] = [];
      try {
        for (const sup of [null, "", "   "]) {
          await c.query("begin");
          try {
            const [ev] = (await c.query<{ id: string; loc: string; u: string }>(
              `insert into biz.inventory_event (tenant_id, kind, product_id, location_id, actor_user_id)
               select tenant_id, 'RECEIPT', id, (select id from platform.location where tenant_id=p.tenant_id limit 1), created_by from biz.product p where id=$1
               returning id::text, location_id::text loc, actor_user_id::text u`, [p.id])).rows;
            out.push(await errOf(c.query("insert into biz.stock_receipt (tenant_id, event_id, product_id, location_id, supplier_name) values ($1,$2,$3,$4,$5)",
              [A.tenant, ev.id, p.id, ev.loc, sup])));
          } finally {
            await c.query("rollback");
          }
        }
      } finally {
        await c.end();
      }
      ok(out.every((e) => e.startsWith("23514")), out.join(" | "));
      const [fake] = await admin<{ n: number }>("select count(*)::int n from biz.stock_receipt where supplier_name is null or btrim(supplier_name) = ''");
      eq(fake.n, 0, "header penerimaan tanpa pemasok");
      return "fungsi DB: tanpa/spasi/null -> SUPPLIER_REQUIRED; insert langsung superuser null/''/spasi -> 23514; 0 header tanpa pemasok";
    });

    await test("INV-AUD-03-API", KA, "Nomor batch yang sama tidak bisa dipakai dengan expiry berbeda/kosong untuk menyamarkan batch lama", async () => {
      const p = await pesticide(A.token);
      const old = { number: "B-001", expiresOn: "2020-01-01" };
      const r0 = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 2, { status: "QUARANTINE", batch: old })] });
      eq(r0.status, 201, r0.text);
      const r1 = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 5, { batch: { number: "B-001", expiresOn: "2031-01-01" } })] });
      const r2 = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 5, { batch: { number: "B-001" } })] });
      const r3 = await receive(ADM.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { status: "DAMAGED", batch: { number: "B-001", expiresOn: "2020-01-02" } })] });
      ok([r1, r2, r3].every((r) => r.status === 409 && r.body.code === "BATCH_EXPIRY_MISMATCH"), [r1, r2, r3].map((r) => `${r.status}:${String(r.body.code)}`).join(","));
      const same = await receive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { status: "DAMAGED", batch: old })] });
      eq(same.status, 201, `expiry sama tetap boleh: ${same.text}`);
      const [b] = await admin<{ n: number; e: string }>("select count(*)::int n, max(expires_on)::text e from biz.batch where product_id=$1 and batch_number='B-001'", [p.id]);
      ok(b.n === 1 && b.e === "2020-01-01", `batch B-001: ${JSON.stringify(b)}`);
      const rs = await rows(A.token, p.id);
      eq(baseOf(rs.filter((x) => x.batchNumber === "B-001"), "SALEABLE"), 0, "tidak ada stok siap jual B-001");
      const pc = await http("POST", "/products", A.token, {
        sku: sku("BID"), name: "Batch ganda", category: "PESTICIDE", subsidized: false, baseUnit: "botol",
        packages: [{ key: "botol", form: "LOOSE", factor: 1, label: "Botol" }],
        opening: [
          { packageKey: "botol", qty: 1, batch: { number: "Z-1", expiresOn: "2030-01-01" }, cost: { basis: "KNOWN", totalIdr: 100 } },
          { packageKey: "botol", qty: 1, batch: { number: "Z-1", expiresOn: "2031-01-01" }, cost: { basis: "KNOWN", totalIdr: 100 } },
        ],
      }, idem());
      ok(pc.status === 409 && pc.body.code === "BATCH_EXPIRY_MISMATCH", `stok awal: ${pc.status} ${String(pc.body.code)}`);
      const pB = await pesticide(B.token);
      const rb = await receive(B.token, { productId: pB.id, lines: [line(pB.pkg.botol, 1, { batch: { number: "B-001", expiresOn: "2031-01-01" } })] });
      eq(rb.status, 201, `toko B nomor sama: ${rb.text}`);
      return "B-001 (exp 2020-01-01) lalu exp 2031/kosong/2020-01-02 -> 409 BATCH_EXPIRY_MISMATCH; expiry sama -> 201 batch sama; stok awal ganda 409; toko B tidak terpengaruh";
    });

    await test("INV-AUD-03-DB", KD, "Database menolak batch bernomor sama dengan expiry berbeda dan perubahan expiry historis (termasuk superuser)", async () => {
      const p = await pesticide(A.token);
      const e0 = await errOf(sqlReceive(A.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { batch: { number: "B-01", expiresOn: "2031-12-31" } })] }));
      eq(e0, "BATCH_EXPIRY_MISMATCH", "fungsi DB langsung");
      const e1 = await errOf(admin("insert into biz.batch (tenant_id, product_id, batch_number, expires_on) select tenant_id, id, 'B-01', date '2029-01-01' from biz.product where id=$1", [p.id]));
      const e2 = await errOf(admin("insert into biz.batch (tenant_id, product_id, batch_number, expires_on) select tenant_id, id, 'B-01', null from biz.product where id=$1", [p.id]));
      const e3 = await errOf(admin("update biz.batch set expires_on = date '2035-01-01' where product_id=$1 and batch_number='B-01'", [p.id]));
      const e4 = await errOf(admin("update biz.batch set batch_number = 'B-02' where product_id=$1 and batch_number='B-01'", [p.id]));
      ok(e1 === "BATCH_EXPIRY_MISMATCH" && e2 === "BATCH_EXPIRY_MISMATCH" && e3 === "IMMUTABLE_FIELD" && e4 === "IMMUTABLE_FIELD", `${e1} | ${e2} | ${e3} | ${e4}`);
      const [b] = await admin<{ e: string; n: number }>("select max(expires_on)::text e, count(*)::int n from biz.batch where product_id=$1 and batch_number='B-01'", [p.id]);
      ok(b.e === "2030-12-31" && b.n === 1, JSON.stringify(b));
      const [ix] = await admin<{ n: number }>("select count(*)::int n from pg_indexes where schemaname='biz' and indexname='batch_number_one_expiry'");
      eq(ix.n, 1, "indeks unik nomor batch");
      return "fungsi DB & insert superuser (expiry beda/kosong) -> BATCH_EXPIRY_MISMATCH; ubah expiry/nomor -> IMMUTABLE_FIELD; expiry asli 2030-12-31 utuh; indeks unik ada";
    });

    // ------------------------------------------------------------------ isolasi, atomik, append-only, hak
    await test("INV-TENANT-01", KA, "Toko B tidak bisa menerima, membuka, menahan, memindah, atau melepas objek toko A", async () => {
      const p = await pesticide(A.token);
      const b1 = await batchId(p.id, "B-01");
      const h = await hold(A.token, { productId: p.id, batchId: b1, reason: "milik A" });
      const before = await ledgerCount(p.id);
      const res = [
        await receive(B.token, { productId: p.id, lines: [line(p.pkg.botol, 1)] }),
        await openPkg(B.token, p.pkg.karton, { batchId: b1, physicalConfirmed: true }),
        await hold(B.token, { productId: p.id, reason: "x" }),
        await move(B.token, { productId: p.id, packageId: p.pkg.botol, batchId: b1, from: "HELD", to: "DAMAGED", qty: 1, reason: "x" }),
        await release(B.token, h.body.holdId as string, { reason: "x" }),
      ];
      ok(res.every((r) => r.status === 404), res.map((r) => `${r.status}:${String(r.body.code)}`).join(","));
      const list = await http("GET", "/inventory/holds?active=false", B.token);
      ok((list.body.items as { id: string }[]).every((x) => x.id !== h.body.holdId), "daftar B memuat penahanan A");
      eq(await ledgerCount(p.id), before, "ledger A tidak berubah");
      eq(await count("select count(*)::int n from biz.stock_hold where id=$1 and released_at is null", [h.body.holdId]), 1, "penahanan A tetap aktif");
      return "5 operasi lintas toko -> 404; daftar penahanan B tidak memuat milik A; data A tidak berubah";
    });

    await test("INV-ATOM-01", KD, "Gagal di akhir transaksi penerimaan/penahanan -> semua rollback (event, header, ledger, saldo, kolam, batch, penahanan, idempotensi)", async () => {
      const O = await registerOwnerSql("Kios Atomik");
      const p = await pesticide(O.token);
      const b1 = await batchId(p.id, "B-01");
      const snap = async () => (await admin<Record<string, string>>(
        `select (select count(*) from biz.inventory_event where product_id=$1)::text ev, (select count(*) from biz.stock_receipt where product_id=$1)::text rc,
                (select count(*) from biz.inventory_ledger where product_id=$1)::text led, (select count(*) from biz.value_ledger where product_id=$1)::text vl,
                (select string_agg(status||':'||qty, ',' order by status, package_version_id, batch_id) from biz.stock_balance where product_id=$1) bal,
                (select string_agg(status||':'||qty_base||':'||value_idr, ',' order by status) from biz.cost_pool where product_id=$1) pool,
                (select count(*) from biz.batch where product_id=$1)::text bt, (select count(*) from biz.stock_hold where product_id=$1)::text h,
                (select count(*) from biz.idempotency where tenant_id=$2)::text idem`, [p.id, O.tenant]))[0];
      const s0 = await snap();
      await admin(`create or replace function public.t_inv_fail() returns trigger language plpgsql as $$
        begin if new.tenant_id = '${O.tenant}'::uuid and new.kind in ('STOCK_RECEIVED','STOCK_HELD') then raise exception 'INJECTED'; end if; return new; end $$`);
      await admin("create trigger t_inv_fail before insert on biz.audit_event for each row execute function public.t_inv_fail()");
      let e1 = "";
      let e2 = "";
      try {
        e1 = await errOf(asActor(O.token, "select app.inventory_receive($1, $2::jsonb)", [randomUUID(),
          JSON.stringify({ productId: p.id, supplierName: "PT Gagal", lines: [line(p.pkg.karton, 2, { batch: { number: "B-NEW", expiresOn: "2031-01-01" } })] })]));
        e2 = await errOf(asActor(O.token, "select app.stock_hold($1, $2::jsonb)", [randomUUID(), JSON.stringify({ productId: p.id, batchId: b1, reason: "gagal" })]));
      } finally {
        await admin("drop trigger t_inv_fail on biz.audit_event");
        await admin("drop function public.t_inv_fail()");
      }
      ok(e1.includes("INJECTED") && e2.includes("INJECTED"), `${e1} | ${e2}`);
      const s1 = await snap();
      eq(JSON.stringify(s1), JSON.stringify(s0), "keadaan sebelum vs sesudah");
      return "penerimaan & penahanan gagal di langkah terakhir -> 9 besaran identik dengan sebelum";
    });

    await test("INV-APPEND-01", KD, "Header penerimaan & penahanan tahan ubah: UPDATE/DELETE/TRUNCATE ditolak; penahanan hanya boleh dilepas sekali", async () => {
      const p = await pesticide(A.token);
      const r = await receive(A.token, { productId: p.id, supplierName: "PT Asli", lines: [line(p.pkg.botol, 1)] });
      const h = await hold(A.token, { productId: p.id, reason: "alasan asli" });
      const out: string[] = [];
      const tries = [
        ["update biz.stock_receipt set supplier_name='PALSU' where event_id=$1", [r.body.eventId]],
        ["delete from biz.stock_receipt where event_id=$1", [r.body.eventId]],
        ["truncate biz.stock_receipt cascade", []],
        ["update biz.stock_hold set reason='PALSU' where id=$1", [h.body.holdId]],
        ["delete from biz.stock_hold where id=$1", [h.body.holdId]],
        ["truncate biz.stock_hold cascade", []],
      ] as const;
      for (const [sql, params] of tries) {
        const e = await errOf(admin(sql, [...params]));
        ok(e === "APPEND_ONLY", `${sql}: ${e}`);
        out.push(e);
      }
      const rel = await ownerRelease(A.token, h.body.holdId as string, "aman");
      eq(rel.status, 200, rel.text);
      const e2 = await errOf(admin("update biz.stock_hold set release_reason='PALSU' where id=$1", [h.body.holdId]));
      const e3 = await errOf(admin("update biz.stock_hold set released_at=null, released_by=null, release_reason=null, release_event_id=null where id=$1", [h.body.holdId]));
      ok(e2 === "APPEND_ONLY" && e3 === "APPEND_ONLY", `${e2} | ${e3}`);
      const [x] = await admin<{ s: string; r: string }>(
        "select (select supplier_name from biz.stock_receipt where event_id=$1) s, (select reason from biz.stock_hold where id=$2) r", [r.body.eventId, h.body.holdId]);
      ok(x.s === "PT Asli" && x.r === "alasan asli", JSON.stringify(x));
      return `${out.length + 2} perubahan langsung (superuser) ditolak APPEND_ONLY; data asli utuh`;
    });

    await test("INV-PRIV-01", KD, "Runtime tanpa hak tabel inventori baru & fungsi internal; tabel baru FORCE RLS", async () => {
      const tables = ["biz.stock_receipt", "biz.stock_hold"];
      let n = 0;
      for (const role of ["app_runtime", "auth_runtime", "otp_dispatch_runtime"]) {
        for (const t of tables) {
          for (const sql of [`update ${t} set tenant_id = tenant_id`, `delete from ${t}`, `insert into ${t} default values`, `select 1 from ${t}`]) {
            const e = await errOf(asRole(role, sql));
            ok(e.startsWith("42501"), `${role}: ${sql} -> ${e}`);
            n++;
          }
          const [pv] = await admin<{ any: boolean }>(
            "select has_table_privilege($1,$2,'SELECT') or has_table_privilege($1,$2,'INSERT') or has_table_privilege($1,$2,'UPDATE') or has_table_privilege($1,$2,'DELETE') any", [role, t]);
          ok(!pv.any, `${role} punya hak tabel di ${t}`);
        }
      }
      const internal = ["app.idem_claim(uuid,text,uuid,jsonb)", "app.stock_post(uuid,uuid,text,uuid,uuid,uuid,uuid,text,integer,integer,uuid,timestamptz)",
        "app.pool_move(uuid,uuid,uuid,uuid,text,text,bigint,uuid,timestamptz)", "app.pool_add(uuid,uuid,uuid,uuid,text,bigint,bigint,text,text,text,uuid,timestamptz)",
        "app.hold_active(uuid,uuid,uuid,uuid)", "app.inv_lock_product(uuid,uuid)", "app.idem_finish(uuid,text,uuid,jsonb)"];
      for (const f of internal) {
        const [x] = await admin<{ e: boolean }>("select has_function_privilege('app_runtime', $1, 'EXECUTE') e", [f]);
        ok(!x.e, `app_runtime boleh EXECUTE ${f}`);
      }
      const [f] = await admin<{ n: number }>("select count(*)::int n from pg_class where oid in ('biz.stock_receipt'::regclass,'biz.stock_hold'::regclass) and relrowsecurity and relforcerowsecurity");
      eq(f.n, 2, "FORCE RLS");
      return `${n} DML/SELECT langsung -> 42501; ${internal.length} fungsi internal tertutup; 2 tabel FORCE RLS`;
    });

    await test("INV-LOCK-01", KA, "Toko terkunci (paket habis) menolak penerimaan/buka/tahan/pindah/lepas; baca tetap bisa", async () => {
      const O = await registerOwnerSql("Kios Kunci Inventori");
      await makePro(O.tenant);
      const p = await pesticide(O.token);
      const b1 = await batchId(p.id, "B-01");
      const h = await hold(O.token, { productId: p.id, batchId: b1, reason: "sebelum kunci" });
      eq(h.status, 201, h.text);
      await admin("update platform.subscription set activated_at=now()-interval '31 days', expires_at=now()-interval '1 hour', grace_deadline=now()+interval '29 days' where tenant_id=$1", [O.tenant]);
      const res = [
        await receive(O.token, { productId: p.id, lines: [line(p.pkg.botol, 1, { batch: { number: "B-Z" } })] }),
        await openPkg(O.token, p.pkg.karton, { batchId: b1, physicalConfirmed: true, status: "HELD" }),
        await hold(O.token, { productId: p.id, reason: "x" }),
        await move(O.token, { productId: p.id, packageId: p.pkg.botol, batchId: b1, from: "HELD", to: "DAMAGED", qty: 1, reason: "x" }),
        await release(O.token, h.body.holdId as string, { reason: "x" }),
      ];
      ok(res.every((r) => r.status === 403 && r.body.code === "TENANT_LOCKED"), res.map((r) => `${r.status}:${String(r.body.code)}`).join(","));
      const list = await http("GET", "/inventory/holds", O.token);
      const st = await http("GET", `/inventory/stock?productId=${p.id}`, O.token);
      ok(list.status === 200 && st.status === 200, `${list.status} ${st.status}`);
      return "5 mutasi -> 403 TENANT_LOCKED; daftar penahanan & stok tetap 200";
    });

    await test("INV-RECON-01", KA, "Setelah penerimaan, buka karton, tahan/lepas, dan pindah status: saldo & kolam biaya cocok dengan ledger (rekonsiliasi ok)", async () => {
      const r = await http("POST", "/inventory/reconciliation", A.token, {});
      eq(r.status, 200, r.text);
      ok(r.body.ok === true, `ketidakcocokan: ${r.text.slice(0, 300)}`);
      const [g] = await admin<{ s: number; v: number }>(
        `select (select count(*)::int from (select location_id, product_id, package_version_id, batch_id, status, sum(qty_delta) q
                   from biz.inventory_ledger where tenant_id=$1 group by 1,2,3,4,5) l
                  full join (select * from biz.stock_balance where tenant_id=$1) b using (location_id, product_id, package_version_id, batch_id, status)
                 where coalesce(l.q,0) <> coalesce(b.qty,0)) s,
                (select count(*)::int from (select location_id, product_id, status, sum(qty_base_delta) q, sum(value_delta) v
                   from biz.value_ledger where tenant_id=$1 group by 1,2,3) l
                  full join (select * from biz.cost_pool where tenant_id=$1) c using (location_id, product_id, status)
                 where coalesce(l.q,0) <> coalesce(c.qty_base,0) or coalesce(l.v,0) <> coalesce(c.value_idr,0)) v`, [A.tenant]);
      ok(g.s === 0 && g.v === 0, JSON.stringify(g));
      const [neg] = await admin<{ n: number }>("select count(*)::int n from biz.stock_balance where qty < 0");
      eq(neg.n, 0, "stok negatif");
      return "rekonsiliasi API ok=true; pemeriksaan independen superuser: 0 selisih kuantitas & nilai; 0 stok negatif";
    });
  } finally {
    await app.close();
  }
}
