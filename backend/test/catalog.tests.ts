// Uji modul Produk & Stok Awal (CAT-01..18, ST-INV/ST-COST terkait). DB langsung + API.
import { randomInt, randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { AppConfig } from "../src/config/config";
import { Client } from "pg";
import {
  ADMIN_HOST, ADMIN_PORT, ADMIN_USER, DBNAME, RUNTIME_HOST, RUNTIME_PORT, TEST_OTP_MAC_KEY, admin, asActor, asRole, eq, errOf, inviteAndActivateAdminSql,
  harnessSender, makePro, notRun, ok, registerOwnerSql, test,
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
const post = (token: string, body: unknown, key: string = randomUUID(), extra: Record<string, string> = {}) =>
  http("POST", "/products", token, body, { "idempotency-key": key, ...extra });

let seq = 0;
const sku = (p = "SKU") => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}-${randomInt(1000, 9999)}`.toUpperCase().slice(0, 40);
const bc = () => `899${randomInt(100000000, 999999999)}${randomInt(10, 99)}`;

// Pestisida: karton isi 12 botol (boleh dibuka) + botol lepas.
function pesticide(s: string, over: Record<string, unknown> = {}) {
  return {
    sku: s, name: "Pestisida Uji", category: "PESTICIDE", subsidized: false, baseUnit: "botol",
    packages: [
      { key: "karton", form: "SEALED", factor: 12, label: "Karton 12 botol", mayOpen: true },
      { key: "botol", form: "LOOSE", factor: 1, label: "Botol" },
    ],
    opening: [
      { packageKey: "karton", qty: 3, batch: { number: "B-01", expiresOn: "2030-12-31" }, cost: { basis: "KNOWN", totalIdr: 3_600_000 } },
      { packageKey: "botol", qty: 5, batch: { number: "B-01", expiresOn: "2030-12-31" }, cost: { basis: "KNOWN", totalIdr: 500_000 } },
    ],
    ...over,
  };
}
function fertilizer(s: string, qty = 10, over: Record<string, unknown> = {}) {
  return {
    sku: s, name: "Pupuk Uji", category: "FERTILIZER", subsidized: false, baseUnit: "kg",
    packages: [{ key: "sak", form: "SEALED", factor: 50, label: "Sak 50 kg", mayOpen: false }],
    opening: [{ packageKey: "sak", qty, cost: qty ? { basis: "KNOWN", totalIdr: qty * 250_000 } : { basis: "KNOWN", totalIdr: 0 } }],
    ...over,
  };
}
const count = async (sql: string, p: unknown[]) => (await admin<{ n: number }>(sql, p))[0].n;

export async function catalogTests(): Promise<void> {
  const cfg: AppConfig = {
    mode: "test", port: 0,
    db: { host: RUNTIME_HOST, port: RUNTIME_PORT, database: DBNAME, poolMax: 20,
      auth: { user: "auth_runtime", password: undefined }, app: { user: "app_runtime", password: undefined }, otp: { user: "otp_dispatch_runtime", password: undefined } },
    otpSender: "test", ipHashSecret: Buffer.from("TEST_ONLY_ip_hash_secret_catalog_0123456789"), otpMacKey: TEST_OTP_MAC_KEY,
    otpDispatchIntervalMs: 1000, trustProxyHops: 0,
  };
  const { app, db } = await createApp(cfg, { otpSender: harnessSender });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;

  try {
    const A = await registerOwnerSql("Kios Katalog A");
    const B = await registerOwnerSql("Kios Katalog B");

    await test("CAT-01", KA, "SKU duplikat dalam satu toko ditolak (tidak peka huruf besar/kecil)", async () => {
      const s = sku("DUP");
      const r1 = await post(A.token, fertilizer(s));
      const r2 = await post(A.token, fertilizer(s.toLowerCase()));
      eq(r1.status, 201, `pertama ${r1.text}`);
      eq(r2.status, 409, "kedua");
      eq(r2.body.code, "SKU_DUPLICATE", "kode");
      eq(await count("select count(*)::int n from biz.product where tenant_id=$1 and upper(sku)=upper($2)", [A.tenant, s]), 1, "jumlah produk");
      return "201 lalu 409 SKU_DUPLICATE; 1 produk";
    });

    await test("CAT-02", KA, "SKU sama di dua toko berbeda diizinkan; data tetap terisolasi", async () => {
      const s = sku("SAME");
      const ra = await post(A.token, fertilizer(s));
      const rb = await post(B.token, fertilizer(s));
      ok(ra.status === 201 && rb.status === 201, `${ra.status},${rb.status}`);
      const listA = await http("GET", `/products?search=${encodeURIComponent(s)}`, A.token);
      const items = (listA.body.items as { id: string }[]);
      ok(items.length === 1 && items[0].id === ra.body.productId, "daftar A memuat produk B");
      return "keduanya 201; pencarian A hanya mengembalikan produk A";
    });

    await test("CAT-03", KA, "Barcode duplikat dalam toko ditolak (lintas produk & varian); toko lain boleh", async () => {
      const code = bc();
      const r1 = await post(A.token, fertilizer(sku(), 1, { barcode: code }));
      const r2 = await post(A.token, fertilizer(sku(), 1, { barcode: code }));
      const p3 = fertilizer(sku(), 1);
      (p3.packages[0] as Record<string, unknown>).barcode = code;
      const r3 = await post(A.token, p3);
      const r4 = await post(B.token, fertilizer(sku(), 1, { barcode: code }));
      eq(r1.status, 201, "pertama");
      ok(r2.status === 409 && r2.body.code === "BARCODE_DUPLICATE", `produk: ${r2.status}`);
      ok(r3.status === 409 && r3.body.code === "BARCODE_DUPLICATE", `varian: ${r3.status}`);
      eq(r4.status, 201, "toko lain");
      return "produk & varian duplikat -> 409; toko lain -> 201";
    });

    await test("CAT-04", KA, "Faktor kemasan nol/negatif ditolak (API dan database)", async () => {
      const bad = [0, -1, 1.5].map((f) => {
        const b = fertilizer(sku(), 1);
        (b.packages[0] as Record<string, unknown>).factor = f;
        return b;
      });
      const res = await Promise.all(bad.map((b) => post(A.token, b)));
      ok(res.every((r) => r.status === 400), res.map((r) => r.status).join(","));
      const body = fertilizer(sku(), 0);
      (body.packages[0] as Record<string, unknown>).factor = 0;
      const e = await errOf(asActor(A.token, "select app.product_create($1, $2::jsonb)", [randomUUID(), JSON.stringify(body)]));
      ok(e.startsWith("23514"), `database: ${e}`);
      const loose = fertilizer(sku(), 1);
      loose.packages = [{ key: "sak", form: "LOOSE", factor: 50, label: "x", mayOpen: false }];
      eq((await post(A.token, loose)).status, 400, "LOOSE faktor != 1");
      return "API 400 untuk 0/-1/1.5 & LOOSE≠1; database menolak faktor 0 (CHECK 23514)";
    });

    await test("CAT-05", KA, "Stok awal 0 diterima dan tercatat (peristiwa pembukaan + ledger + saldo 0)", async () => {
      const r = await post(A.token, fertilizer(sku("ZERO"), 0));
      eq(r.status, 201, r.text);
      const id = r.body.productId as string;
      const [x] = await admin<{ ev: number; led: number; bal: number; q: number; pool: number; v: number }>(
        `select (select count(*)::int from biz.inventory_event where product_id=$1 and kind='OPENING') ev,
                (select count(*)::int from biz.inventory_ledger where product_id=$1) led,
                (select count(*)::int from biz.stock_balance where product_id=$1) bal,
                (select coalesce(sum(qty),0)::int from biz.stock_balance where product_id=$1) q,
                (select qty_base::int from biz.cost_pool where product_id=$1) pool,
                (select value_idr::int from biz.cost_pool where product_id=$1) v`, [id]);
      ok(x.ev === 1 && x.led === 1 && x.bal === 1 && x.q === 0 && x.pool === 0 && x.v === 0, JSON.stringify(x));
      return "1 peristiwa OPENING, 1 baris ledger qty 0, saldo 0, kolam biaya 0/Rp0";
    });

    await test("CAT-06", KA, "Basis biaya stok awal: tidak sah ditolak; tak terverifikasi ditandai; bonus nol butuh alasan & asal", async () => {
      const mk = (cost: Record<string, unknown>, qty = 2) => fertilizer(sku("COST"), qty, { opening: [{ packageKey: "sak", qty, cost }] });
      const bad = [
        mk({ basis: "KNOWN", totalIdr: 0 }), mk({ basis: "KNOWN" }), mk({ basis: "BONUS_ZERO", reason: "promo" }),
        mk({ basis: "BONUS_ZERO", origin: "PT Pemasok" }), mk({ basis: "UNVERIFIED", totalIdr: 1000 }), mk({ basis: "BONUS_ZERO", totalIdr: 5, reason: "x", origin: "y" }),
      ];
      const rb = [];
      for (const b of bad) rb.push(await post(A.token, b));
      ok(rb.every((r) => r.status === 400 && r.body.code === "COST_BASIS_INVALID"), rb.map((r) => `${r.status}:${r.body.code}`).join(","));
      const un = await post(A.token, mk({ basis: "UNVERIFIED" }));
      eq(un.status, 201, "UNVERIFIED");
      eq((un.body.product as { costStatus: string }).costStatus, "UNVERIFIED", "label HPP belum terverifikasi");
      return "6 basis tidak sah -> 400 COST_BASIS_INVALID; UNVERIFIED diterima dengan costStatus=UNVERIFIED";
    });

    await test("ST-COST-04", KA, "Stok bonus bernilai 0 dengan dokumen pemasok tercatat jelas (bukan biaya tak diketahui)", async () => {
      const r = await post(A.token, fertilizer(sku("BONUS"), 4, { opening: [{ packageKey: "sak", qty: 4, cost: { basis: "BONUS_ZERO", reason: "Bonus pembelian", origin: "Surat jalan PT Tani 123" } }] }));
      eq(r.status, 201, r.text);
      const id = r.body.productId as string;
      const [v] = await admin<{ basis: string; reason: string; origin: string; val: number }>(
        "select cost_basis basis, basis_reason reason, basis_origin origin, value_delta::int val from biz.value_ledger where product_id=$1", [id]);
      ok(v.basis === "BONUS_ZERO" && v.val === 0 && v.reason === "Bonus pembelian" && v.origin.includes("PT Tani"), JSON.stringify(v));
      eq((r.body.product as { costStatus: string }).costStatus, "VERIFIED", "bonus bukan biaya tak terverifikasi");
      return "basis BONUS_ZERO, nilai Rp0, alasan & asal tersimpan, costStatus VERIFIED";
    });

    await test("CAT-07", KD, "Gagal di tengah transaksi produk+stok awal -> semua rollback", async () => {
      await admin(`create or replace function public.t_cat_fail() returns trigger language plpgsql as $$
        begin if (select name from biz.product where tenant_id = new.tenant_id and id = new.product_id) = 'FAIL_INJECT' then raise exception 'INJECTED'; end if; return new; end $$`);
      await admin("create trigger t_cat_fail before insert on biz.value_ledger for each row execute function public.t_cat_fail()");
      const s = sku("FAIL");
      const key = randomUUID();
      const body = pesticide(s, { name: "FAIL_INJECT", barcode: bc() });
      let e = "";
      try {
        e = await errOf(asActor(A.token, "select app.product_create($1, $2::jsonb)", [key, JSON.stringify(body)]));
      } finally {
        await admin("drop trigger t_cat_fail on biz.value_ledger");
        await admin("drop function public.t_cat_fail()");
      }
      const [x] = await admin<Record<string, number>>(
        `select (select count(*)::int from biz.product where tenant_id=$1 and sku=$2) p,
                (select count(*)::int from biz.package_version v join biz.product p on p.id=v.product_id where p.sku=$2) v,
                (select count(*)::int from biz.barcode where tenant_id=$1 and code=$3) b,
                (select count(*)::int from biz.idempotency where tenant_id=$1 and key=$4) i,
                (select count(*)::int from biz.inventory_ledger l join biz.product p on p.id=l.product_id where p.sku=$2) l,
                (select count(*)::int from biz.batch b join biz.product p on p.id=b.product_id where p.sku=$2) bt`,
        [A.tenant, s, (body as { barcode?: string }).barcode, key]);
      ok(e.includes("INJECTED"), `kegagalan: ${e}`);
      ok(Object.values(x).every((n) => n === 0), `sisa data: ${JSON.stringify(x)}`);
      return "error di tengah (ledger nilai) -> produk/varian/barcode/batch/ledger/idempotensi semuanya 0";
    });

    await test("CAT-08", KA, "Request identik diulang -> hasil sama, tanpa stok/ledger ganda", async () => {
      const key = randomUUID();
      const body = pesticide(sku("RETRY"));
      const r1 = await post(A.token, body, key);
      const r2 = await post(A.token, body, key);
      eq(r1.status, 201, "pertama");
      eq(r2.status, 201, "ulang");
      eq(r2.body.productId, r1.body.productId, "productId sama");
      eq(r2.body.replayed, true, "ditandai replay");
      const id = r1.body.productId as string;
      const [x] = await admin<{ ev: number; led: number; base: number }>(
        `select (select count(*)::int from biz.inventory_event where product_id=$1) ev,
                (select count(*)::int from biz.inventory_ledger where product_id=$1) led,
                (select sum(qty_base_delta)::int from biz.inventory_ledger where product_id=$1) base`, [id]);
      ok(x.ev === 1 && x.led === 2 && x.base === 41, JSON.stringify(x));
      return "2x201, productId sama, replayed=true; 1 peristiwa, 2 baris ledger, 41 botol";
    });

    await test("CAT-09", KA, "Idempotency-Key sama dengan isi berbeda -> 409", async () => {
      const key = randomUUID();
      const r1 = await post(A.token, fertilizer(sku("IDEM"), 2), key);
      const r2 = await post(A.token, fertilizer(sku("IDEM"), 3), key);
      const r3 = await http("POST", "/products", A.token, fertilizer(sku("NOKEY"), 1));
      eq(r1.status, 201, "pertama");
      ok(r2.status === 409 && r2.body.code === "IDEMPOTENCY_PAYLOAD_MISMATCH", `${r2.status} ${r2.body.code}`);
      ok(r3.status === 400 && r3.body.code === "IDEMPOTENCY_KEY_REQUIRED", `tanpa kunci: ${r3.status}`);
      return "isi beda -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH; tanpa kunci -> 400";
    });

    await test("CAT-10", KA, "Toko A membaca/mengubah produk toko B -> 404; stok B tidak terlihat", async () => {
      const rb = await post(B.token, pesticide(sku("B")));
      const id = rb.body.productId as string;
      const g = await http("GET", `/products/${id}`, A.token);
      const p = await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 1, name: "Diretas" });
      const s = await http("GET", `/inventory/stock?productId=${id}`, A.token);
      const ghost = await http("GET", `/products/${randomUUID()}`, A.token);
      ok(g.status === 404 && p.status === 404, `${g.status},${p.status}`);
      eq(JSON.stringify({ ...g.body, correlation_id: 0 }), JSON.stringify({ ...ghost.body, correlation_id: 0 }), "jawaban ID B beda dari ID tidak ada");
      eq((s.body.rows as unknown[]).length, 0, "stok B terlihat");
      eq((await admin<{ name: string }>("select name from biz.product where id=$1", [id]))[0].name, "Pestisida Uji", "data B berubah");
      const direct = await asActor(A.token, "select app.product_get($1) p", [id]).then(() => "OK", (e: { message?: string }) => String(e.message));
      eq(direct, "NOT_FOUND", "fungsi database");
      return "GET/PATCH 404 (identik dgn ID tak ada), stok kosong, data B utuh, fungsi DB NOT_FOUND";
    });

    await test("CAT-11", KD, "Runtime database mencoba mengubah stok/ledger langsung -> permission denied", async () => {
      const tables = ["biz.stock_balance", "biz.inventory_ledger", "biz.cost_pool", "biz.value_ledger", "biz.product", "biz.package_version", "biz.idempotency"];
      const out: string[] = [];
      for (const role of ["app_runtime", "auth_runtime", "otp_dispatch_runtime"]) {
        for (const t of tables) {
          for (const sql of [`update ${t} set tenant_id = tenant_id`, `delete from ${t}`, `insert into ${t} default values`, `select 1 from ${t}`]) {
            const e = await errOf(asRole(role, sql));
            ok(e.startsWith("42501"), `${role}: ${sql} -> ${e}`);
            out.push(e.slice(0, 5));
          }
          // Lapis hak tabel juga harus kosong (bukan hanya terhalang hak schema).
          const [pv] = await admin<{ any: boolean }>(
            "select has_table_privilege($1,$2,'SELECT') or has_table_privilege($1,$2,'INSERT') or has_table_privilege($1,$2,'UPDATE') or has_table_privilege($1,$2,'DELETE') any",
            [role, t]);
          ok(!pv.any, `${role} punya hak tabel di ${t}`);
        }
      }
      const e2 = await errOf(asRole("app_runtime", "select app.cost_take(100,3,1)"));
      const e3 = await errOf(asRole("app_runtime", "select app.pos_eligible(gen_random_uuid(), gen_random_uuid())"));
      ok(e2.startsWith("42501") && e3.startsWith("42501"), `${e2} | ${e3}`);
      return `${out.length} DML/SELECT langsung ditolak 42501; fungsi internal biaya/POS tertutup`;
    });

    await test("CAT-13", KA, "Konversi karton & satuan dasar: 3 karton×12 + 5 botol = 41 botol, tidak dihitung ganda", async () => {
      const r = await post(A.token, pesticide(sku("EQ")));
      const id = r.body.productId as string;
      const s = await http("GET", `/inventory/stock?productId=${id}`, A.token);
      const rows = s.body.rows as { form: string; qty: number; qtyBase: number }[];
      const totals = s.body.totals as { status: string; qtyBase: number }[];
      const karton = rows.find((x) => x.form === "SEALED")!;
      const botol = rows.find((x) => x.form === "LOOSE")!;
      ok(karton.qty === 3 && karton.qtyBase === 36 && botol.qty === 5 && botol.qtyBase === 5, JSON.stringify(rows));
      ok(totals.length === 1 && totals[0].status === "SALEABLE" && totals[0].qtyBase === 41, JSON.stringify(totals));
      const [pool] = await admin<{ q: number; v: number }>("select qty_base::int q, value_idr::int v from biz.cost_pool where product_id=$1", [id]);
      ok(pool.q === 41 && pool.v === 4_100_000, JSON.stringify(pool));
      return "karton 3 (36) + botol 5 (5) = 41 botol; kolam biaya 41 botol Rp4.100.000";
    });

    await test("ST-INV-02", KA, "Stok 3 karton isi 12 + 5 botol: total ekuivalen 41, tidak dihitung ganda", async () => {
      const r = await post(A.token, pesticide(sku("ST2")));
      const p = await http("GET", `/products/${r.body.productId}`, A.token);
      eq((p.body.stockBase as Record<string, number>).SALEABLE, 41, "stockBase");
      return "stockBase SALEABLE = 41";
    });

    await test("CAT-14", KD, "HPP residual: Rp100/3 -> 33+33+34; Rp1.000.000/7 keluar 2,2,3 -> 285.714+285.714+428.572", async () => {
      const take = async (v: number, q: number, o: number) => Number((await admin<{ x: string }>("select app.cost_take($1,$2,$3)::text x", [v, q, o]))[0].x);
      const seqOut = async (value: number, qty: number, outs: number[]) => {
        const res: number[] = [];
        for (const o of outs) {
          const c = await take(value, qty, o);
          res.push(c);
          value -= c;
          qty -= o;
        }
        return { res, value, qty };
      };
      const a = await seqOut(100, 3, [1, 1, 1]);
      const b = await seqOut(1_000_000, 7, [2, 2, 3]);
      eq(a.res.join(","), "33,33,34", "Rp100/3");
      ok(a.value === 0 && a.qty === 0, "sisa Rp100/3");
      eq(b.res.join(","), "285714,285714,428572", "Rp1jt/7");
      ok(b.value === 0 && b.qty === 0, "sisa Rp1jt/7");
      // Properti: 300 urutan acak -> jumlah beban selalu sama dengan nilai awal, tiap beban >= 0, tanpa sisa fiktif.
      let bad = 0;
      for (let i = 0; i < 300; i++) {
        let qty = randomInt(1, 60);
        let value = randomInt(0, 5_000_000);
        const v0 = value;
        let sum = 0;
        while (qty > 0) {
          const o = randomInt(1, qty + 1);
          const c = await take(value, qty, o);
          if (c < 0 || c > value) bad++;
          sum += c;
          value -= c;
          qty -= o;
        }
        if (sum !== v0 || value !== 0) bad++;
      }
      eq(bad, 0, "pelanggaran properti");
      const inv = [await errOf(admin("select app.cost_take(100,3,4)")), await errOf(admin("select app.cost_take(100,0,1)")), await errOf(admin("select app.cost_take(-1,3,1)"))];
      ok(inv.every((x) => x === "VALIDATION"), inv.join(","));
      return "33/33/34 dan 285.714/285.714/428.572 tepat; 300 urutan acak tanpa sisa fiktif; argumen tak sah ditolak";
    });

    await test("ST-COST-01", KD, "3 unit total Rp100 keluar bertahap -> total HPP Rp100, stok 0, nilai sisa Rp0 (rumus)", async () => {
      let value = 100;
      let qty = 3;
      let total = 0;
      for (let i = 0; i < 3; i++) {
        const c = Number((await admin<{ x: string }>("select app.cost_take($1,$2,1)::text x", [value, qty]))[0].x);
        total += c;
        value -= c;
        qty -= 1;
      }
      ok(total === 100 && value === 0 && qty === 0, `${total}/${value}/${qty}`);
      return "rumus COST-02: total Rp100, sisa 0 (alur penjualan belum dibangun)";
    });

    await test("ST-COST-05", KD, "Rp1.000.000 atas 7 unit, keluar 2,2,3 -> 285.714; 285.714; 428.572 (rumus)", async () => {
      const r1 = Number((await admin<{ x: string }>("select app.cost_take(1000000,7,2)::text x"))[0].x);
      const r2 = Number((await admin<{ x: string }>("select app.cost_take($1,5,2)::text x", [1_000_000 - r1]))[0].x);
      const r3 = Number((await admin<{ x: string }>("select app.cost_take($1,3,3)::text x", [1_000_000 - r1 - r2]))[0].x);
      eq(`${r1},${r2},${r3}`, "285714,285714,428572", "beban");
      return "285.714 / 285.714 / 428.572 = Rp1.000.000";
    });

    await test("CAT-15", KA, "Request stok awal serentak: kunci sama -> 1 produk; kunci beda SKU sama -> 1 sukses", async () => {
      const key = randomUUID();
      const body = pesticide(sku("CONC"));
      const same = await Promise.all(Array.from({ length: 10 }, () => post(A.token, body, key)));
      const ids = new Set(same.map((r) => r.body.productId));
      ok(same.every((r) => r.status === 201) && ids.size === 1, same.map((r) => r.status).join(","));
      const id = [...ids][0] as string;
      const [x] = await admin<{ p: number; ev: number; base: number }>(
        `select (select count(*)::int from biz.product where tenant_id=$1 and sku=$2) p,
                (select count(*)::int from biz.inventory_event where product_id=$3) ev,
                (select sum(qty_base_delta)::int from biz.inventory_ledger where product_id=$3) base`, [A.tenant, body.sku, id]);
      ok(x.p === 1 && x.ev === 1 && x.base === 41, JSON.stringify(x));
      const s2 = sku("CONC2");
      const diff = await Promise.all(Array.from({ length: 10 }, () => post(A.token, pesticide(s2))));
      const c201 = diff.filter((r) => r.status === 201).length;
      const c409 = diff.filter((r) => r.status === 409 && r.body.code === "SKU_DUPLICATE").length;
      ok(c201 === 1 && c409 === 9, `kunci beda: 201=${c201} 409=${c409}`);
      eq(await count("select count(*)::int n from biz.inventory_event e join biz.product p on p.id=e.product_id where p.tenant_id=$1 and p.sku=$2", [A.tenant, s2]), 1, "peristiwa pembukaan");
      return "10 serentak kunci sama: 1 produk/1 peristiwa/41 botol; 10 serentak kunci beda: 1x201 + 9x409";
    });

    await test("CAT-16", KA, "Ubah faktor kemasan setelah ada histori stok -> ditolak; histori tetap; versi baru via varian baru", async () => {
      const r = await post(A.token, pesticide(sku("FACTOR"), {
        packages: [
          { key: "karton", form: "SEALED", factor: 12, label: "Karton 12", mayOpen: true },
          { key: "botol", form: "LOOSE", factor: 1, label: "Botol" },
          { key: "dus", form: "SEALED", factor: 6, label: "Dus 6 (belum dipakai)" },
        ],
      }));
      const id = r.body.productId as string;
      const pk = (r.body.product as { packages: { id: string; label: string }[] }).packages;
      const karton = pk.find((x) => x.label === "Karton 12")!.id;
      const dus = pk.find((x) => x.label.startsWith("Dus"))!.id;
      const locked = await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 1, packages: { update: [{ id: karton, factor: 10 }] } });
      ok(locked.status === 409 && locked.body.code === "PACKAGE_FACTOR_LOCKED", `${locked.status} ${locked.body.code}`);
      const trig = await errOf(admin("update biz.package_version set factor = 10 where id=$1", [karton]));
      eq(trig, "PACKAGE_FACTOR_LOCKED", "trigger database (bahkan superuser)");
      const fix = await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 1, packages: { update: [{ id: dus, factor: 8 }] } });
      eq(fix.status, 200, `varian tanpa histori boleh dikoreksi: ${fix.text}`);
      const add = await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 2, packages: { add: [{ form: "SEALED", factor: 10, label: "Karton 10 (baru)", supersedesId: karton }] } });
      eq(add.status, 200, `varian baru: ${add.text}`);
      const retire = await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 3, packages: { retire: [karton] } });
      ok(retire.status === 409 && retire.body.code === "PACKAGE_HAS_STOCK", `pensiun varian berstok: ${retire.status}`);
      const stale = await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 1, name: "Basi" });
      ok(stale.status === 409 && stale.body.code === "VERSION_CONFLICT", `versi lama: ${stale.status}`);
      const [h] = await admin<{ f: number; base: number }>(
        "select (select factor from biz.package_version where id=$1) f, (select sum(qty_base_delta)::int from biz.inventory_ledger where package_version_id=$1) base", [karton]);
      ok(h.f === 12 && h.base === 36, `histori: ${JSON.stringify(h)}`);
      return "faktor berhistori -> 409 (API & trigger); koreksi varian tanpa histori 200; varian baru 200; pensiun berstok 409; versi basi 409; histori 12×3=36 utuh";
    });

    await test("CAT-17", KA, "Admin memalsukan tenant/role/entitlement ditolak; toko terkunci menolak mutasi", async () => {
      const O = await registerOwnerSql("Kios Admin Katalog");
      await makePro(O.tenant);
      const adm = await inviteAndActivateAdminSql(O);
      const forged = [
        await post(adm.token, { ...fertilizer(sku()), tenant_id: B.tenant }),
        await post(adm.token, { ...fertilizer(sku()), role: "OWNER" }),
        await post(adm.token, { ...fertilizer(sku()), plan: "PRO" }),
        await post(adm.token, { ...fertilizer(sku()), price: 1000 }),
      ];
      ok(forged.every((r) => r.status === 400), forged.map((r) => r.status).join(","));
      const viaHeader = await post(adm.token, fertilizer(sku("ADM")), randomUUID(), { "x-tenant-id": B.tenant });
      eq(viaHeader.status, 201, `admin membuat produk: ${viaHeader.text}`);
      const [owner] = await admin<{ t: string; actor: string }>(
        "select p.tenant_id::text t, (select a.actor_user_id::text from biz.audit_event a where a.entity_id=p.id and a.kind='PRODUCT_CREATED') actor from biz.product p where p.id=$1", [viaHeader.body.productId]);
      const [admUser] = await admin<{ u: string }>("select user_id::text u from iam.membership where id=$1", [adm.membership]);
      ok(owner.t === O.tenant && owner.actor === admUser.u, `toko/aktor: ${JSON.stringify(owner)}`);
      await admin("update platform.subscription set activated_at=now()-interval '31 days', expires_at=now()-interval '1 hour', grace_deadline=now()+interval '29 days' where tenant_id=$1", [O.tenant]);
      const lockedCreate = await post(adm.token, fertilizer(sku()));
      const lockedPatch = await http("PATCH", `/products/${viaHeader.body.productId}`, O.token, { expectedVersion: 1, name: "X" });
      const read = await http("GET", `/products/${viaHeader.body.productId}`, O.token);
      ok(lockedCreate.status === 403 && lockedCreate.body.code === "TENANT_LOCKED", `buat saat terkunci: ${lockedCreate.status}`);
      ok(lockedPatch.status === 403 && lockedPatch.body.code === "TENANT_LOCKED", `ubah saat terkunci: ${lockedPatch.status}`);
      eq(read.status, 200, "baca saat terkunci");
      return "tenant_id/role/plan/price di body -> 400; header tenant diabaikan (produk di toko Admin, aktor Admin tercatat); terkunci -> 403 TENANT_LOCKED; baca tetap 200";
    });

    await test("CAT-18", KA, "Produk pupuk subsidi terpisah dan tidak memenuhi syarat checkout POS umum", async () => {
      const sub = await post(A.token, fertilizer(sku("SUB"), 5, { subsidized: true, name: "Urea Subsidi" }));
      const gen = await post(A.token, fertilizer(sku("NONSUB"), 5));
      eq(sub.status, 201, sub.text);
      eq((sub.body.product as { posEligible: boolean }).posEligible, false, "posEligible subsidi");
      eq((gen.body.product as { posEligible: boolean }).posEligible, true, "posEligible umum");
      // Fungsi internal untuk modul checkout: dipanggil dalam konteks sesi aktor (RLS), seperti nanti di checkout.
      const c = new Client({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, database: DBNAME });
      await c.connect();
      let e: { s: boolean; g: boolean };
      try {
        await c.query("begin");
        await c.query("select set_config('app.session_token', $1, true)", [A.token]);
        e = (await c.query("select app.pos_eligible($1,$2) s, app.pos_eligible($1,$3) g", [A.tenant, sub.body.productId, gen.body.productId])).rows[0];
        await c.query("commit");
      } finally {
        await c.end();
      }
      ok(e.s === false && e.g === true, JSON.stringify(e));
      const pest = await post(A.token, { ...pesticide(sku("SUBP")), subsidized: true });
      eq(pest.status, 400, "pestisida subsidi");
      const flip = await http("PATCH", `/products/${sub.body.productId}`, A.token, { expectedVersion: 1, subsidized: false });
      eq(flip.status, 400, "ubah status subsidi lewat API");
      eq(await errOf(admin("update biz.product set is_subsidized=false where id=$1", [sub.body.productId])), "IMMUTABLE_FIELD", "ubah status subsidi di database");
      return "subsidi posEligible=false (fungsi app.pos_eligible=false); pestisida subsidi 400; status subsidi tidak bisa diubah. Checkout POS belum dibangun.";
    });

    await test("ST-INV-01-MASTER", KA, "Produk baru stok awal 0: master tersimpan dengan saldo 0", async () => {
      const r = await post(A.token, fertilizer(sku("ST1"), 0));
      const p = await http("GET", `/products/${r.body.productId}`, A.token);
      ok(r.status === 201 && p.status === 200 && (p.body.stockBase as Record<string, number>).SALEABLE === 0, p.text);
      return "201; stockBase SALEABLE = 0";
    });
    notRun("ST-INV-01-POS", KA, "POS menolak jual sebelum stok masuk", "Checkout POS belum dibangun (di luar cakupan PR ini)");

    await test("INV-03-EXP", KA, "Batch kedaluwarsa tidak bisa dicatat sebagai stok siap jual (validasi server)", async () => {
      const r = await post(A.token, pesticide(sku("EXP"), { opening: [{ packageKey: "botol", qty: 2, batch: { number: "OLD", expiresOn: "2020-01-01" }, cost: { basis: "KNOWN", totalIdr: 200 } }] }));
      ok(r.status === 400 && r.body.code === "BATCH_EXPIRED", `${r.status} ${r.body.code}`);
      const bad = await post(A.token, pesticide(sku("EXP2"), { opening: [{ packageKey: "botol", qty: 2, batch: { expiresOn: "2030-02-31" }, cost: { basis: "KNOWN", totalIdr: 200 } }] }));
      eq(bad.status, 400, "tanggal tidak sah");
      return "expired -> 400 BATCH_EXPIRED; 31 Feb -> 400";
    });

    await test("CAT-12", KD, "Saldo stok & kolam biaya selalu cocok dengan ledger; ketidakcocokan menghasilkan alert tanpa mengubah histori", async () => {
      const [g] = await admin<{ stock: number; value: number }>(
        `select (select count(*)::int from (
                  select b.tenant_id from biz.stock_balance b
                  full join (select tenant_id, location_id, product_id, package_version_id, batch_id, status, sum(qty_delta) q from biz.inventory_ledger
                             group by 1,2,3,4,5,6) l using (tenant_id, location_id, product_id, package_version_id, batch_id, status)
                  where coalesce(b.qty,0) <> coalesce(l.q,0)) x) stock,
                (select count(*)::int from (
                  select c.tenant_id from biz.cost_pool c
                  full join (select tenant_id, location_id, product_id, status, sum(qty_base_delta) q, sum(value_delta) v from biz.value_ledger group by 1,2,3,4) l
                    using (tenant_id, location_id, product_id, status)
                  where coalesce(c.qty_base,0) <> coalesce(l.q,0) or coalesce(c.value_idr,0) <> coalesce(l.v,0)) x) value`);
      ok(g.stock === 0 && g.value === 0, `global: ${JSON.stringify(g)}`);
      const okA = await http("POST", "/inventory/reconciliation", A.token, {});
      eq(okA.body.ok, true, `rekonsiliasi A: ${okA.text}`);
      // ST-INV-10: rusak sengaja saldo (sebagai superuser) -> alert, ledger tidak disentuh
      const r = await post(A.token, pesticide(sku("MISM")));
      const id = r.body.productId as string;
      const ledgerBefore = await count("select coalesce(sum(qty_delta),0)::int n from biz.inventory_ledger where product_id=$1", [id]);
      await admin("update biz.stock_balance set qty = qty + 1 where product_id=$1 and qty = 3", [id]);
      const bad = await http("POST", "/inventory/reconciliation", A.token, {});
      const ledgerAfter = await count("select coalesce(sum(qty_delta),0)::int n from biz.inventory_ledger where product_id=$1", [id]);
      const alerts = await count("select count(*)::int n from biz.inventory_alert where tenant_id=$1 and kind='STOCK_MISMATCH'", [A.tenant]);
      await admin("update biz.stock_balance set qty = qty - 1 where product_id=$1 and qty = 4", [id]);
      eq(bad.body.ok, false, "mismatch terdeteksi");
      ok(alerts >= 1, "alert tercatat");
      eq(ledgerAfter, ledgerBefore, "ledger diubah");
      eq(await errOf(admin("update biz.inventory_ledger set qty_delta = 0 where product_id=$1", [id])), "APPEND_ONLY", "ledger append-only");
      const again = await http("POST", "/inventory/reconciliation", A.token, {});
      eq(again.body.ok, true, "setelah dipulihkan");
      return "0 selisih global (stok & nilai); saldo dirusak -> ok=false + alert STOCK_MISMATCH, ledger tetap & append-only";
    });

    await test("CAT-NEG-01", KD, "Stok fisik tidak bisa negatif (CHECK database, termasuk superuser)", async () => {
      const r = await post(A.token, fertilizer(sku("NEG"), 1));
      const e1 = await errOf(admin("update biz.stock_balance set qty = -1 where product_id=$1", [r.body.productId]));
      const e2 = await errOf(admin("update biz.cost_pool set qty_base = 0 where product_id=$1", [r.body.productId]));
      ok(e1.startsWith("23514") && e2.startsWith("23514"), `${e1} | ${e2}`);
      return "qty < 0 -> 23514; kolam qty 0 dengan nilai > 0 -> 23514";
    });

    // ------------------------------------------------------------------ audit PR #6
    await test("CAT-AUD-01", KD, "Referensi silang antar-produk (kemasan/batch/peristiwa/barcode/varian pengganti) ditolak constraint database", async () => {
      const ra = await post(A.token, pesticide(sku("XA")));
      const rb = await post(A.token, fertilizer(sku("XB"), 2, { opening: [{ packageKey: "sak", qty: 2, batch: { number: "PB-1" }, cost: { basis: "KNOWN", totalIdr: 500_000 } }] }));
      const ids = async (pid: string) => (await admin<{ pkg: string; batch: string; ev: string; loc: string; uid: string }>(
        `select (select id::text from biz.package_version where product_id=$1 order by created_at limit 1) pkg,
                (select id::text from biz.batch where product_id=$1 limit 1) batch,
                (select id::text from biz.inventory_event where product_id=$1) ev,
                (select location_id::text from biz.inventory_event where product_id=$1) loc,
                (select actor_user_id::text from biz.inventory_event where product_id=$1) uid`, [pid]))[0];
      const a = await ids(ra.body.productId as string);
      const b = await ids(rb.body.productId as string);
      const pa = ra.body.productId as string;
      const c = new Client({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, database: DBNAME });   // superuser: penolakan murni dari constraint, bukan izin
      await c.connect();
      const out: Record<string, string> = {};
      const attempt = async (name: string, sql: string, params: unknown[]) => {
        await c.query("savepoint s");
        try {
          await c.query(sql, params);
          out[name] = "DITERIMA";
        } catch (e) {
          const x = e as { code?: string; constraint?: string };
          out[name] = `${x.code}:${x.constraint ?? ""}`;
        }
        await c.query("rollback to savepoint s");
      };
      try {
        await c.query("begin");
        await attempt("stok A + kemasan B", "insert into biz.stock_balance (tenant_id,location_id,product_id,package_version_id,batch_id,status,qty) values ($1,$2,$3,$4,$5,'HELD',0)", [A.tenant, a.loc, pa, b.pkg, a.batch]);
        await attempt("stok A + batch B", "insert into biz.stock_balance (tenant_id,location_id,product_id,package_version_id,batch_id,status,qty) values ($1,$2,$3,$4,$5,'HELD',0)", [A.tenant, a.loc, pa, a.pkg, b.batch]);
        await attempt("ledger A + event B", "insert into biz.inventory_ledger (tenant_id,event_id,movement,location_id,product_id,package_version_id,batch_id,status,qty_delta,qty_base_delta,actor_user_id,event_at) values ($1,$2,'OPENING',$3,$4,$5,$6,'SALEABLE',0,0,$7,now())", [A.tenant, b.ev, a.loc, pa, a.pkg, a.batch, a.uid]);
        await attempt("ledger nilai A + event B", "insert into biz.value_ledger (tenant_id,event_id,location_id,product_id,status,qty_base_delta,value_delta,cost_basis,actor_user_id,event_at) values ($1,$2,$3,$4,'SALEABLE',0,0,'KNOWN',$5,now())", [A.tenant, b.ev, a.loc, pa, a.uid]);
        await attempt("barcode A + kemasan B", "insert into biz.barcode (tenant_id,code,product_id,package_version_id) values ($1,$2,$3,$4)", [A.tenant, bc(), pa, b.pkg]);
        await attempt("varian A menggantikan varian B", "insert into biz.package_version (tenant_id,product_id,label,form,factor,supersedes_id) values ($1,$2,'X','SEALED',6,$3)", [A.tenant, pa, b.pkg]);
        // kontrol positif: kombinasi sah tetap diterima
        await attempt("SAH stok A + kemasan & batch A", "insert into biz.stock_balance (tenant_id,location_id,product_id,package_version_id,batch_id,status,qty) values ($1,$2,$3,$4,$5,'HELD',0)", [A.tenant, a.loc, pa, a.pkg, a.batch]);
        await attempt("SAH ledger A + event A", "insert into biz.inventory_ledger (tenant_id,event_id,movement,location_id,product_id,package_version_id,batch_id,status,qty_delta,qty_base_delta,actor_user_id,event_at) values ($1,$2,'OPENING',$3,$4,$5,$6,'SALEABLE',0,0,$7,now())", [A.tenant, a.ev, a.loc, pa, a.pkg, a.batch, a.uid]);
        await attempt("SAH varian A menggantikan varian A", "insert into biz.package_version (tenant_id,product_id,label,form,factor,supersedes_id) values ($1,$2,'X','SEALED',6,$3)", [A.tenant, pa, a.pkg]);
        await attempt("SAH barcode A + kemasan A", "insert into biz.barcode (tenant_id,code,product_id,package_version_id) values ($1,$2,$3,$4)", [A.tenant, bc(), pa, (await c.query("select id from biz.package_version where product_id=$1 and form='LOOSE'", [pa])).rows[0].id]);
      } finally {
        await c.query("rollback").catch(() => undefined);
        await c.end();
      }
      const bad = Object.entries(out).filter(([k]) => !k.startsWith("SAH"));
      const good = Object.entries(out).filter(([k]) => k.startsWith("SAH"));
      ok(bad.every(([, v]) => v.startsWith("23503:")), `referensi silang lolos: ${JSON.stringify(out)}`);
      ok(good.every(([, v]) => v === "DITERIMA"), `kombinasi sah ditolak: ${JSON.stringify(out)}`);
      return bad.map(([k, v]) => `${k} -> ${v}`).join("; ") + `; ${good.length} kombinasi sah diterima (lalu di-rollback)`;
    });

    await test("CAT-AUD-02", KD, "Tabel append-only menolak UPDATE/DELETE/TRUNCATE (pemilik & superuser); histori identik; event sah tetap bisa dicatat", async () => {
      const tables = ["biz.inventory_event", "biz.inventory_ledger", "biz.value_ledger", "biz.audit_event", "biz.inventory_alert"];
      await http("POST", "/inventory/reconciliation", A.token, {});   // pastikan tabel lain terisi
      const r0 = await post(A.token, fertilizer(sku("APPEND"), 1));
      eq(r0.status, 201, "data awal");
      await admin("insert into biz.inventory_alert (tenant_id, kind, detail, detected_by) select tenant_id, 'STOCK_MISMATCH', '{\"uji\":true}', actor_user_id from biz.inventory_event where product_id=$1", [r0.body.productId]);
      const snap = async () => {
        const o: Record<string, string> = {};
        for (const t of tables) o[t] = (await admin<{ s: string }>(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') s from ${t} x`))[0].s;
        return o;
      };
      const before = await snap();
      const res: string[] = [];
      for (const t of tables) {
        res.push(`${t}.superuser.update=${await errOf(admin(`update ${t} set tenant_id = tenant_id`))}`);
        res.push(`${t}.superuser.delete=${await errOf(admin(`delete from ${t}`))}`);
        res.push(`${t}.superuser.truncate=${await errOf(admin(`truncate ${t} cascade`))}`);
        const c = new Client({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, database: DBNAME });
        await c.connect();
        try {
          await c.query("set role migration_owner");          // role pemilik tabel
          res.push(`${t}.owner.truncate=${await errOf(c.query(`truncate ${t} cascade`))}`);
          // FORCE RLS: pemilik tanpa kebijakan tidak melihat baris -> 0 baris tersentuh (tidak ada perubahan)
          const u = await c.query(`update ${t} set tenant_id = tenant_id`).then((x) => `rows=${x.rowCount}`, (e) => String(e.message));
          res.push(`${t}.owner.update=${u}`);
        } finally {
          await c.end();
        }
      }
      const after = await snap();
      const rejected = res.filter((x) => /superuser\.(update|delete|truncate)=APPEND_ONLY|owner\.truncate=APPEND_ONLY/.test(x)).length;
      const ownerUpd = res.filter((x) => /owner\.update=(rows=0|APPEND_ONLY)/.test(x)).length;
      eq(rejected, tables.length * 4, `penolakan: ${res.filter((x) => !/APPEND_ONLY|rows=0/.test(x)).join(" | ")}`);
      eq(ownerUpd, tables.length, "update oleh pemilik");
      eq(JSON.stringify(after), JSON.stringify(before), "histori berubah");
      const r1 = await post(A.token, fertilizer(sku("APPEND2"), 2));
      eq(r1.status, 201, "event sah setelahnya");
      ok((await count("select count(*)::int n from biz.inventory_event where product_id=$1", [r1.body.productId])) === 1, "event baru tercatat");
      return `${rejected} operasi UPDATE/DELETE/TRUNCATE ditolak APPEND_ONLY (5 tabel); update pemilik 0 baris (FORCE RLS); isi 5 tabel identik (count+md5); event baru 201`;
    });

    await test("CAT-AUD-03", KD, "Idempotensi diikat ke jsonb yang diterima database: hash pemanggil tidak dipercaya, replay/konkurensi/normalisasi benar", async () => {
      const K = randomUUID();
      const bodyA = fertilizer(sku("IDA"), 3);
      const bodyB = fertilizer(sku("IDB"), 5);
      const call = (key: string, json: string) => asActor<{ r: { productId: string; replayed?: boolean } }>(A.token, "select app.product_create($1, $2::jsonb) r", [key, json]);
      const state = async (s: string) => (await admin<{ p: number; ev: number; led: number }>(
        `select (select count(*)::int from biz.product where tenant_id=$1 and sku=$2) p,
                (select count(*)::int from biz.inventory_event e join biz.product x on x.id=e.product_id where x.tenant_id=$1 and x.sku=$2) ev,
                (select count(*)::int from biz.inventory_ledger l join biz.product x on x.id=l.product_id where x.tenant_id=$1 and x.sku=$2) led`, [A.tenant, s]))[0];
      // A. normal
      const [a1] = await call(K, JSON.stringify(bodyA));
      // B. replay sah
      const [a2] = await call(K, JSON.stringify(bodyA));
      const sA = await state(bodyA.sku);
      ok(a2.r.productId === a1.r.productId && a2.r.replayed === true, `replay: ${JSON.stringify(a2.r)}`);
      ok(sA.p === 1 && sA.ev === 1 && sA.led === 1, `replay menambah data: ${JSON.stringify(sA)}`);
      // C/D. isi berbeda dengan kunci sama -> ditolak; tanda tangan lama (dengan hash pemanggil) sudah tidak ada
      const d1 = await errOf(call(K, JSON.stringify(bodyB)));
      const hashA = (await admin<{ h: Buffer }>("select sha256(convert_to($1::jsonb::text,'UTF8')) h", [JSON.stringify(bodyA)]))[0].h;
      const d2 = await errOf(asActor(A.token, "select app.product_create($1, $2::bytea, $3::jsonb)", [K, hashA, JSON.stringify(bodyB)]));
      const sB = await state(bodyB.sku);
      eq(d1, "IDEMPOTENCY_PAYLOAD_MISMATCH", "kunci K + isi B");
      ok(d2.startsWith("42883"), `jalur hash pemanggil: ${d2}`);
      ok(sB.p === 0 && sB.ev === 0, `produk B terbentuk: ${JSON.stringify(sB)}`);
      // E. 10 permintaan serentak dengan kunci sama
      const K2 = randomUUID();
      const bodyE = pesticide(sku("IDE"));
      const outs = await Promise.all(Array.from({ length: 10 }, () => call(K2, JSON.stringify(bodyE)).then((r) => r[0].r.productId, (e) => `ERR:${e.message}`)));
      const sE = await state(bodyE.sku);
      ok(new Set(outs).size === 1 && !outs[0].startsWith("ERR"), `hasil serentak: ${[...new Set(outs)].join(",")}`);
      ok(sE.p === 1 && sE.ev === 1 && sE.led === 2, `serentak: ${JSON.stringify(sE)}`);
      // F. urutan kunci JSON berbeda = isi yang sama (normalisasi jsonb)
      const K3 = randomUUID();
      const bodyF = fertilizer(sku("IDF"), 4, { brand: "Merek Uji" });
      const reordered = (o: unknown): unknown => Array.isArray(o) ? o.map(reordered)
        : o && typeof o === "object" ? Object.fromEntries(Object.entries(o as Record<string, unknown>).reverse().map(([k, v]) => [k, reordered(v)])) : o;
      const t1 = JSON.stringify(bodyF);
      const t2 = JSON.stringify(reordered(bodyF));
      ok(t1 !== t2, "teks JSON harus berbeda urutan");
      const [f1] = await call(K3, t1);
      const [f2] = await call(K3, t2);
      const sF = await state(bodyF.sku);
      ok(f2.r.productId === f1.r.productId && f2.r.replayed === true && sF.p === 1 && sF.ev === 1, `normalisasi: ${JSON.stringify({ f2: f2.r, sF })}`);
      return "A ok; B replay produk sama tanpa data baru; C/D isi beda -> IDEMPOTENCY_PAYLOAD_MISMATCH, jalur hash pemanggil tidak ada (42883), produk B 0; E 10 serentak -> 1 produk/1 peristiwa; F urutan kunci beda -> replay";
    });

    await test("CAT-AUD-03", KA, "Idempotensi lewat API: replay sama, isi beda 409, urutan kunci beda tetap replay; dicek di database", async () => {
      const K = randomUUID();
      const bodyA = fertilizer(sku("APIA"), 2);
      const r1 = await post(A.token, bodyA, K);
      const r2 = await post(A.token, Object.fromEntries(Object.entries(bodyA).reverse()), K);
      const r3 = await post(A.token, fertilizer(sku("APIB"), 2), K);
      const [st] = await admin<{ p: number; ev: number; idem: number }>(
        `select (select count(*)::int from biz.product where tenant_id=$1 and sku=$2) p,
                (select count(*)::int from biz.inventory_event where product_id=$3) ev,
                (select count(*)::int from biz.idempotency where tenant_id=$1 and key=$4) idem`, [A.tenant, bodyA.sku, r1.body.productId, K]);
      eq(r1.status, 201, "pertama");
      ok(r2.status === 201 && r2.body.productId === r1.body.productId && r2.body.replayed === true, `replay urutan beda: ${r2.text.slice(0, 120)}`);
      ok(r3.status === 409 && r3.body.code === "IDEMPOTENCY_PAYLOAD_MISMATCH", `isi beda: ${r3.status}`);
      ok(st.p === 1 && st.ev === 1 && st.idem === 1, JSON.stringify(st));
      return "201; replay (urutan kunci dibalik) 201 produk sama; isi beda 409; database: 1 produk, 1 peristiwa, 1 kunci";
    });

    await test("CAT-API-01", KA, "Field asing/nested extra key & query asing ditolak 400", async () => {
      const id = (await post(A.token, fertilizer(sku("STRICT"), 1))).body.productId as string;
      const bodyNested = fertilizer(sku(), 1);
      (bodyNested.opening[0].cost as Record<string, unknown>).extra = 1;
      const pkgNested = fertilizer(sku(), 1);
      (pkgNested.packages[0] as Record<string, unknown>).price = 5000;
      const res = [
        await post(A.token, bodyNested),
        await post(A.token, pkgNested),
        await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 1, packages: { update: [{ id, factor: 2, x: 1 }] } }),
        await http("PATCH", `/products/${id}`, A.token, { expectedVersion: 1, opening: [] }),
        await http("GET", "/products?limit=10&tenant=x", A.token),
        await http("GET", "/inventory/stock?productId=x", A.token),
      ];
      ok(res.every((r) => r.status === 400), res.map((r) => r.status).join(","));
      return `${res.length}/${res.length} -> 400 (termasuk upaya menimpa stok awal lewat PATCH)`;
    });
  } finally {
    await app.close();
    await db.close().catch(() => undefined);
  }
}
