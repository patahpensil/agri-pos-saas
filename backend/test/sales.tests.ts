import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import {
  DBNAME, RUNTIME_HOST, RUNTIME_PORT, TEST_OTP_MAC_KEY, PW, Owner, admin, asActor,
  eq, errOf, harnessSender, inviteAndActivateAdminSql, makePro, ok, registerOwnerSql, rolePool, test,
} from "./harness";

const KIND = "API";
let base: string;
type Result = { status: number; body: Record<string, unknown> };
type SaleLine = { product_id: string; package_version_id: string; batch_id: string; quantity: number };
type QuotedLine = SaleLine & { quote_version: string };
type Product = { line: SaleLine; version: number };

async function request(path: string, token: string, body?: unknown, key?: string): Promise<Result> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function response(result: Result, status: number, code?: string) {
  const detail = JSON.stringify(result.body);
  eq(result.status, status, detail);
  if (code) eq(result.body.code, code, detail);
}

async function setPrice(owner: Owner, item: Product, price: number) {
  const proposed = await request("/price-change-requests", owner.token, {
    productId: item.line.product_id, packageId: item.line.package_version_id,
    priceIdr: price, expectedVersion: item.version, reason: "Harga eceran kios uji",
  }, randomUUID());
  response(proposed, 201);
  const grant = await request("/auth/reauth", owner.token, {
    password: PW, action: "price.approve", targetId: proposed.body.requestId, scope: { expectedVersion: item.version },
  });
  response(grant, 201);
  const approved = await request(`/price-change-requests/${proposed.body.requestId}/approve`, owner.token, {
    expectedVersion: item.version, reason: "Harga diperiksa", reauthToken: grant.body.reauthToken,
  }, randomUUID());
  response(approved, 200);
  item.version = Number(approved.body.productVersion);
}

async function product(owner: Owner, qty: number, options: { subsidized?: boolean; price?: number; cost?: number | null } = {}) {
  const category = options.subsidized ? "FERTILIZER" : "PESTICIDE";
  const cost = options.cost === null ? { basis: "UNVERIFIED" }
    : { basis: "KNOWN", totalIdr: options.cost ?? qty * 2 };
  const r = await request("/products", owner.token, {
    sku: "SALE-" + randomUUID().slice(0, 12).toUpperCase(), name: "Barang uji kasir", category,
    subsidized: options.subsidized ?? false, baseUnit: "unit",
    packages: [{ key: "unit", form: "LOOSE", factor: 1, label: "Unit" }],
    opening: [{ packageKey: "unit", qty, batch: { number: "A-001" }, cost }],
  }, randomUUID());
  response(r, 201);
  const p = r.body.product as { version: number; packages: { id: string }[] };
  const productId = String(r.body.productId);
  const [batch] = await admin<{ id: string }>(
    "select id from biz.batch where tenant_id=$1 and product_id=$2 and batch_number='A-001'", [owner.tenant, productId]);
  const item: Product = { version: p.version, line: {
    product_id: productId, package_version_id: p.packages[0].id, batch_id: batch.id, quantity: 1,
  } };
  if (!options.subsidized) await setPrice(owner, item, options.price ?? 15_000);
  return item;
}

async function quote(token: string, ...lines: SaleLine[]) {
  const result = await request("/sales/quote", token, { lines });
  response(result, 200);
  return result.body as { grand_total_idr: string; lines: (QuotedLine & { unit_price_idr: string })[] };
}

function cash(lines: QuotedLine[], total: string, change = "0") {
  return {
    customer_id: null,
    lines: lines.map(({ product_id, package_version_id, batch_id, quantity, quote_version }) =>
      ({ product_id, package_version_id, batch_id, quantity, quote_version })),
    payments: [{ method: "CASH", tendered_idr: String(BigInt(total) + BigInt(change)), change_idr: change, net_received_idr: total }],
  };
}

type Part = Record<string, unknown>;
function mixed(lines: QuotedLine[], payments: Part[]) {
  return { ...cash(lines, "0"), payments };
}
function external(method: "TRANSFER" | "QRIS" | "EDC", amount: string, reference: string | null = null): Part {
  return { method, net_received_idr: amount, reference, proof_checked: true };
}
function cashPart(net: string, change = "0"): Part {
  return { method: "CASH", tendered_idr: String(BigInt(net) + BigInt(change)), change_idr: change, net_received_idr: net };
}

async function states(owner: Owner, p: Product) {
  const [result] = await admin<{ qty: number; sales: number; payments: number; ledger: number; audit: number; value: string }>(`
    select
      (select coalesce(sum(qty),0)::int from biz.stock_balance where tenant_id=$1 and product_id=$2 and status='SALEABLE') qty,
      (select count(*)::int from biz.sale where tenant_id=$1) sales,
      (select count(*)::int from biz.payment where tenant_id=$1) payments,
      (select count(*)::int from biz.inventory_ledger where tenant_id=$1 and product_id=$2 and movement='SALE') ledger,
      (select count(*)::int from biz.audit_event where tenant_id=$1 and kind='SALE_FINAL') audit,
      (select value_idr::text from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='SALEABLE') value`,
    [owner.tenant, p.line.product_id]);
  return result;
}

export async function salesTests() {
  const { app, db } = await createApp({
    mode: "test", port: 0,
    db: { host: RUNTIME_HOST, port: RUNTIME_PORT, database: DBNAME, poolMax: 16,
      auth: { user: "auth_runtime", password: undefined }, app: { user: "app_runtime", password: undefined },
      otp: { user: "otp_dispatch_runtime", password: undefined } },
    otpSender: "test", ipHashSecret: Buffer.from("TEST_ONLY_ip_hash_secret_checkout_012345"),
    otpMacKey: TEST_OTP_MAC_KEY, otpDispatchIntervalMs: 1000, trustProxyHops: 0,
  }, { otpSender: harnessSender });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  try {
    await test("ST-POS-01", KIND, "Ulang checkout serentak hanya mencatat satu penjualan tunai dan nomor struk", async () => {
      const owner = await registerOwnerSql();
      const p = await product(owner, 3);
      const before = await states(owner, p);
      const q = await quote(owner.token, p.line);
      eq(q.grand_total_idr, "15000", "harga disiapkan server");
      eq(JSON.stringify(await states(owner, p)), JSON.stringify(before), "quote tidak mencadangkan stok");
      const body = cash(q.lines, q.grand_total_idr, "5000");
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => request("/sales", owner.token, body, key)));
      for (const result of results) response(result, 201);
      eq(new Set(results.map((r) => r.body.sale_id)).size, 1, "satu penjualan");
      eq(results.filter((r) => r.body.replayed === false).length, 1, "satu posting");
      eq(results[0].body.receipt_number, "1", "nomor struk pertama");
      const lookup = await request(`/operations/${key}`, owner.token);
      response(lookup, 200);
      eq(lookup.body.sale_id, results[0].body.sale_id, "hasil commit dapat diketahui ulang");
      response(await request("/sales", owner.token, { ...body, payments: cash(q.lines, "15000", "10000").payments }, key),
        409, "IDEMPOTENCY_PAYLOAD_MISMATCH");
      const after = await states(owner, p);
      eq(after.qty, 2, "tiga botol dikurangi satu");
      eq(after.sales + after.payments + after.ledger + after.audit, 4, "satu event per catatan");
      eq(after.sales, 1, "satu Sale"); eq(after.payments, 1, "satu pembayaran"); eq(after.ledger, 1, "satu mutasi");
      const saved = await request(`/sales/${results[0].body.sale_id}`, owner.token);
      response(saved, 200);
      const [payment] = saved.body.payments as Record<string, unknown>[];
      eq(payment.method, "CASH", "metode");
      eq(payment.tendered_idr, "20000", "tunai diserahkan");
      eq(payment.change_idr, "5000", "kembalian");
      eq(payment.net_received_idr, "15000", "tunai diterima bersih");
      return "6 request → 1 Sale, 1 pembayaran, 1 mutasi, struk 1; Rp20.000 − Rp5.000 = Rp15.000";
    });

    await test("SALE-PRICE-01", KIND, "Harga atau saldo yang berubah perlu konfirmasi ulang di kasir", async () => {
      const owner = await registerOwnerSql(), item = await product(owner, 3);
      const q = await quote(owner.token, item.line);
      await setPrice(owner, item, 16_000);
      response(await request("/sales", owner.token, cash(q.lines, "15000"), randomUUID()), 409, "SALE_QUOTE_CHANGED");
      eq((await states(owner, item)).sales, 0, "harga basi tidak menghasilkan penjualan");
      const fresh = await quote(owner.token, item.line);
      response(await request("/sales", owner.token, cash(fresh.lines, "16000"), randomUUID()), 201);
      response(await request("/sales", owner.token, cash(fresh.lines, "16000"), randomUUID()), 409, "SALE_QUOTE_CHANGED");
      eq((await states(owner, item)).qty, 2, "stok berkurang hanya setelah konfirmasi harga baru");
      return "Rp15.000 basi → 409; Rp16.000 terkonfirmasi → 201; versi saldo lama → 409";
    });

    await test("ST-INV-01-POS", KIND, "Sebelum stok masuk penjualan ditolak", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 0);
      response(await request("/sales/quote", owner.token, { lines: [p.line] }), 409, "INSUFFICIENT_STOCK");
      response(await request("/sales", owner.token, cash([{ ...p.line, quote_version: "a".repeat(64) }], "15000"), randomUUID()),
        409, "INSUFFICIENT_STOCK");
      const after = await states(owner, p);
      eq(after.qty + after.sales + after.payments + after.ledger, 0, "tanpa efek samping");
      return "0 stok: quote dan POST final 409, 0 penjualan, 0 pembayaran, 0 mutasi";
    });

    await test("ST-INV-07-POS", KIND, "Batch ditahan sesudah quote memblokir finalisasi", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 2);
      await makePro(owner.tenant);
      const operator = await inviteAndActivateAdminSql(owner);
      const q = await quote(operator.token, p.line);
      response(await request("/inventory/holds", operator.token, {
        productId: p.line.product_id, batchId: p.line.batch_id, reason: "Botol bocor",
      }, randomUUID()), 201);
      response(await request("/sales", operator.token, cash(q.lines, "15000"), randomUUID()), 409, "HOLD_ACTIVE");
      const after = await states(owner, p);
      eq(after.sales + after.payments + after.ledger, 0, "tidak ada penjualan batch yang ditahan");
      return "Admin menahan 2 unit setelah quote; checkout 409 HOLD_ACTIVE dan 0 mutasi jual";
    });

    await test("SALE-STOCK-01", KIND, "Persaingan menghabiskan stok terakhir tepat sekali", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 1);
      await makePro(owner.tenant);
      const operator = await inviteAndActivateAdminSql(owner);
      const q = await quote(operator.token, p.line);
      const body = cash(q.lines, "15000");
      const results = await Promise.all([owner.token, operator.token].map((token) => request("/sales", token, body, randomUUID())));
      eq(results.filter((r) => r.status === 201).length, 1, "hanya satu berhasil");
      const loser = results.find((r) => r.status !== 201)!;
      response(loser, 409, "INSUFFICIENT_STOCK");
      const after = await states(owner, p);
      eq(after.qty, 0, "stok tidak negatif"); eq(after.sales, 1, "satu transaksi");
      eq(after.payments, 1, "satu pembayaran"); eq(after.ledger, 1, "satu debit");
      return "2 kasir, 1 stok: 1 berhasil, 1 ditolak; stok 0";
    });

    await test("SALE-COST-01", KIND, "HPP aktual database menyimpan Rp33, Rp33, Rp34 dan nomor urut", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 3, { cost: 100 });
      for (const [index, want] of ["33", "33", "34"].entries()) {
        const q = await quote(owner.token, p.line);
        const result = await request("/sales", owner.token, cash(q.lines, "15000"), randomUUID());
        response(result, 201);
        eq(result.body.receipt_number, String(index + 1), "nomor per toko");
        const saved = await request(`/sales/${result.body.sale_id}`, owner.token);
        const [line] = saved.body.lines as { cost_snapshot_idr: string }[];
        eq(line.cost_snapshot_idr, want, "HPP historis");
      }
      const after = await states(owner, p);
      eq(after.value, "0", "HPP sisa nol"); eq(after.qty, 0, "kuantitas sisa nol");
      const unverified = await product(owner, 1, { cost: null });
      const q = await quote(owner.token, unverified.line);
      const result = await request("/sales", owner.token, cash(q.lines, "15000"), randomUUID());
      response(result, 201);
      const saved = await request(`/sales/${result.body.sale_id}`, owner.token);
      const [line] = saved.body.lines as { cost_snapshot_idr: string | null; cost_verified: boolean }[];
      eq(line.cost_snapshot_idr, null, "HPP belum diverifikasi tidak tampil sebagai angka pasti");
      eq(line.cost_verified, false, "status HPP disimpan");
      const bulk = await product(owner, 7, { cost: 1_000_000 });
      for (const [quantity, want] of [[2, "285714"], [2, "285714"], [3, "428572"]] as const) {
        const q = await quote(owner.token, { ...bulk.line, quantity });
        const sale = await request("/sales", owner.token, cash(q.lines, String(quantity * 15_000)), randomUUID());
        response(sale, 201);
        const historic = await request(`/sales/${sale.body.sale_id}`, owner.token);
        response(historic, 200);
        const [bulkLine] = historic.body.lines as { cost_snapshot_idr: string }[];
        eq(bulkLine.cost_snapshot_idr, want, "HPP Rp1 juta");
      }
      eq((await states(owner, bulk)).value, "0", "rupiah sisa Rp1 juta");
      return "Rp33+Rp33+Rp34=Rp100 dan Rp285.714+Rp285.714+Rp428.572=Rp1 juta; HPP tak terverifikasi null";
    });

    await test("ST-DOC-02", KIND, "Dua kasir mendapat nomor struk unik meski kirim serentak", async () => {
      const owner = await registerOwnerSql(), other = await registerOwnerSql();
      const a = await product(owner, 1), b = await product(owner, 1), c = await product(other, 1);
      await makePro(owner.tenant);
      const operator = await inviteAndActivateAdminSql(owner);
      const first = await quote(owner.token, a.line), second = await quote(operator.token, b.line);
      const results = await Promise.all([
        request("/sales", owner.token, cash(first.lines, "15000"), randomUUID()),
        request("/sales", operator.token, cash(second.lines, "15000"), randomUUID()),
      ]);
      for (const result of results) response(result, 201);
      eq(results.map((r) => String(r.body.receipt_number)).sort().join(","), "1,2", "nomor unik dan urut");
      const foreign = await quote(other.token, c.line);
      const ownFirst = await request("/sales", other.token, cash(foreign.lines, "15000"), randomUUID());
      response(ownFirst, 201);
      eq(ownFirst.body.receipt_number, "1", "nomor per toko");
      return "Dua kasir satu toko mendapat struk 1 dan 2; toko lain mulai dari 1.";
    });

    await test("SALE-ACCESS-01", KIND, "Lintas toko, pupuk subsidi, batch kedaluwarsa, dan input harga ditolak", async () => {
      const owner = await registerOwnerSql(), other = await registerOwnerSql();
      const p = await product(owner, 2);
      const subsidized = await product(owner, 0, { subsidized: true });
      const q = await quote(owner.token, p.line);
      const body = cash(q.lines, "15000");
      const key = randomUUID();
      response(await request("/sales", other.token, body, randomUUID()), 404, "NOT_FOUND");
      response(await request("/sales/quote", owner.token, { lines: [subsidized.line] }), 409, "SUBSIDY_PRICE_SEPARATE");
      response(await request("/sales", owner.token, cash([{ ...subsidized.line, quote_version: "a".repeat(64) }], "0"), randomUUID()),
        409, "SUBSIDY_PRICE_SEPARATE");
      const received = await request("/inventory/receipts", owner.token, {
        productId: p.line.product_id,
        supplierName: "Pemasok uji",
        lines: [{ packageId: p.line.package_version_id, qty: 1, status: "QUARANTINE",
          batch: { number: "LAMA", expiresOn: "2020-01-01" }, cost: { basis: "KNOWN", totalIdr: 10 } }],
      }, randomUUID());
      response(received, 201);
      const [expired] = await admin<{ id: string }>("select id from biz.batch where tenant_id=$1 and product_id=$2 and batch_number='LAMA'",
        [owner.tenant, p.line.product_id]);
      response(await request("/sales", owner.token, cash([{ ...p.line, batch_id: expired.id, quote_version: "a".repeat(64) }], "15000"),
        randomUUID()), 409, "SALE_BATCH_EXPIRED");
      const forged = { ...body, lines: [{ ...body.lines[0], unit_price_idr: "1" }] };
      response(await request("/sales", owner.token, forged, key), 400, "VALIDATION_ERROR");
      eq(await errOf(asActor(owner.token, "select app.sale_create($1,$2::jsonb)", [key, forged])), "VALIDATION", "validasi DB");
      const valid = await request("/sales", owner.token, body, key);
      response(valid, 201);
      response(await request(`/operations/${key}`, other.token), 404, "NOT_FOUND");
      response(await request(`/sales/${valid.body.sale_id}`, other.token), 404, "NOT_FOUND");
      return "Lintas toko, pupuk subsidi, batch kedaluwarsa, dan harga klien ditolak; 1 checkout sah.";
    });

    await test("SALE-ROLLBACK-01", KIND, "Kesalahan HPP pada item kedua mengembalikan item pertama dan kunci retry", async () => {
      const owner = await registerOwnerSql();
      const a = await product(owner, 2), b = await product(owner, 2);
      const [pool] = await admin<{ value: string }>(
        "select value_idr::text as value from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='SALEABLE'", [owner.tenant, b.line.product_id]);
      await admin("delete from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='SALEABLE'", [owner.tenant, b.line.product_id]);
      const q = await quote(owner.token, a.line, b.line);
      const key = randomUUID(), body = cash(q.lines, "30000");
      response(await request("/sales", owner.token, cash(q.lines, "29000"), randomUUID()), 409, "SALE_PAYMENT_MISMATCH");
      response(await request("/sales", owner.token, body, key), 409, "INVENTORY_INCONSISTENT");
      const one = await states(owner, a), two = await states(owner, b);
      ok(one.qty === 2 && two.qty === 2 && one.sales + one.payments + one.ledger + one.audit + two.ledger === 0,
        "kedua saldo, audit, dan pembayaran kembali");
      response(await request(`/operations/${key}`, owner.token), 404, "NOT_FOUND");
      await admin(`insert into biz.cost_pool(tenant_id,location_id,product_id,status,qty_base,value_idr)
        select tenant_id,location_id,product_id,'SALEABLE',qty,$3::bigint from biz.stock_balance
        where tenant_id=$1 and product_id=$2 and status='SALEABLE'`, [owner.tenant, b.line.product_id, pool.value]);
      const result = await request("/sales", owner.token, body, key);
      response(result, 201);
      eq(result.body.receipt_number, "1", "retry tidak menghabiskan nomor");
      return "2 item, item kedua gagal HPP → 0 penjualan, 0 uang, 0 mutasi; retry yang sama → struk 1";
    });

    await test("ST-PAY-02", KIND, "Tunai dan transfer pada satu tagihan tercatat per bagian tanpa kelebihan", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 5);
      const q = await quote(owner.token, { ...p.line, quantity: 2 });
      eq(q.grand_total_idr, "30000", "dua unit Rp15.000");
      response(await request("/sales", owner.token, mixed(q.lines, [external("TRANSFER", "20000"), cashPart("15000")]),
        randomUUID()), 409, "SALE_PAYMENT_MISMATCH");
      response(await request("/sales", owner.token, mixed(q.lines, [external("TRANSFER", "40000")]), randomUUID()),
        409, "SALE_PAYMENT_MISMATCH");
      response(await request("/sales", owner.token, mixed(q.lines, [external("TRANSFER", "10000")]), randomUUID()),
        409, "SALE_PAYMENT_MISMATCH");
      response(await request("/sales", owner.token, mixed(q.lines, [cashPart("15000"), cashPart("15000")]), randomUUID()),
        400, "VALIDATION_ERROR");
      response(await request("/sales", owner.token, mixed(q.lines, [{ ...external("TRANSFER", "30000"), change_idr: "0" }]),
        randomUUID()), 400, "VALIDATION_ERROR");
      response(await request("/sales", owner.token, mixed(q.lines, [external("TRANSFER", "20000"),
        { method: "CASH", tendered_idr: "20000", change_idr: "5000", net_received_idr: "10000" }]), randomUUID()),
      409, "SALE_CASH_MISMATCH");
      eq((await states(owner, p)).sales, 0, "penolakan tidak membuat penjualan");
      const sale = await request("/sales", owner.token, mixed(q.lines,
        [external("TRANSFER", "20000", "BRI 0912-7781"), cashPart("10000", "10000")]), randomUUID());
      response(sale, 201);
      eq(sale.body.cash_change_idr, "10000", "kembalian hanya dari tunai");
      const saved = await request(`/sales/${sale.body.sale_id}`, owner.token);
      response(saved, 200);
      const parts = saved.body.payments as Record<string, unknown>[];
      eq(parts.length, 2, "dua bagian");
      eq(parts.map((x) => x.method).join(","), "TRANSFER,CASH", "urutan bagian");
      eq(parts[0].net_received_idr, "20000", "transfer"); eq(parts[0].tendered_idr, null, "transfer tanpa uang diserahkan");
      eq(parts[0].change_idr, "0", "transfer tanpa kembalian"); eq(parts[0].reference, "BRI 0912-7781", "referensi");
      eq(parts[1].tendered_idr, "20000", "uang tunai diserahkan"); eq(parts[1].change_idr, "10000", "kembalian");
      eq(parts[1].net_received_idr, "10000", "tunai bersih");
      const [actor] = await admin<{ user_id: string }>(`select m.user_id from iam.membership m
        where m.tenant_id=$1 and m.role='OWNER'`, [owner.tenant]);
      for (const part of parts) {
        eq(part.verification_status, "VERIFIED", "status verifikasi");
        eq(part.verified_by, actor.user_id, "pemeriksa"); ok(part.verified_at, "waktu periksa");
      }
      const after = await states(owner, p);
      eq(after.qty, 3, "stok berkurang 2"); eq(after.sales, 1, "satu penjualan"); eq(after.payments, 2, "dua bagian bayar");
      return "Tagihan Rp30.000: transfer Rp20.000 + tunai Rp20.000 kembali Rp10.000; lebih/kurang bayar 409";
    });

    await test("PAY-METHOD-01", KIND, "Transfer, QRIS, dan EDC hanya dicatat setelah bukti diperiksa", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 4);
      const q = await quote(owner.token, p.line);
      const unchecked = { ...external("QRIS", "15000"), proof_checked: false };
      response(await request("/sales", owner.token, mixed(q.lines, [unchecked]), randomUUID()), 400, "PAYMENT_PROOF_REQUIRED");
      response(await request("/sales", owner.token, mixed(q.lines, [{ method: "EDC", net_received_idr: "15000" }]), randomUUID()),
        400, "VALIDATION_ERROR");
      response(await request("/sales", owner.token, mixed(q.lines, [{ method: "GOPAY", net_received_idr: "15000",
        proof_checked: true }]), randomUUID()), 400, "VALIDATION_ERROR");
      eq((await states(owner, p)).sales, 0, "bukti belum diperiksa tidak menjadi penjualan");
      const methods = [] as string[];
      for (const part of [external("TRANSFER", "15000", "TRF-1"), external("QRIS", "15000"),
        { method: "EDC", net_received_idr: "15000", proof_checked: true }]) {
        const fresh = await quote(owner.token, p.line);
        const sale = await request("/sales", owner.token, mixed(fresh.lines, [part]), randomUUID());
        response(sale, 201);
        eq(sale.body.cash_change_idr, "0", "tanpa kembalian");
        const saved = await request(`/sales/${sale.body.sale_id}`, owner.token);
        const [stored] = saved.body.payments as Record<string, unknown>[];
        methods.push(`${stored.method}:${stored.reference ?? "-"}`);
      }
      eq(methods.join(","), "TRANSFER:TRF-1,QRIS:-,EDC:-", "metode dan referensi");
      eq((await states(owner, p)).qty, 1, "tiga unit terjual");
      return "proof_checked=false → 400; TRANSFER, QRIS, EDC masing-masing Rp15.000 → 3 penjualan, stok 4 → 1";
    });

    await test("ST-PAY-03", KIND, "Konfirmasi pembayaran campuran yang diulang tidak menggandakan uang", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 3);
      const q = await quote(owner.token, p.line);
      const body = mixed(q.lines, [external("EDC", "5000", "APPR 0041"), cashPart("10000", "0")]);
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 5 }, () => request("/sales", owner.token, body, key)));
      for (const result of results) response(result, 201);
      eq(new Set(results.map((r) => r.body.sale_id)).size, 1, "satu penjualan");
      eq(results.filter((r) => r.body.replayed === false).length, 1, "satu posting");
      response(await request("/sales", owner.token, mixed(q.lines, [external("EDC", "15000", "APPR 0041")]), key),
        409, "IDEMPOTENCY_PAYLOAD_MISMATCH");
      const after = await states(owner, p);
      eq(after.sales, 1, "satu Sale"); eq(after.payments, 2, "dua bagian sekali"); eq(after.qty, 2, "stok sekali");
      const [sum] = await admin<{ total: string }>("select sum(net_received_idr)::text total from biz.payment where tenant_id=$1",
        [owner.tenant]);
      eq(sum.total, "15000", "uang tercatat sekali");
      return "5 kiriman serentak EDC Rp5.000 + tunai Rp10.000 → 1 Sale, 2 bagian, total Rp15.000";
    });

    await test("PAY-INPUT-01", KIND, "Referensi dan field pembayaran asing ditolak di API dan database", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 2);
      const q = await quote(owner.token, p.line);
      for (const reference of [" TRF-1", "TRF\n1", "x".repeat(65), ""]) {
        response(await request("/sales", owner.token, mixed(q.lines, [external("TRANSFER", "15000", reference)]), randomUUID()),
          400, "VALIDATION_ERROR");
      }
      const forged = [
        { ...external("TRANSFER", "15000"), verification_status: "VERIFIED" },
        { ...external("TRANSFER", "15000"), verified_by: randomUUID() },
        { ...external("TRANSFER", "15000"), reference: " TRF" },
        { ...external("TRANSFER", "15000"), proof_checked: "true" },
        { ...cashPart("15000"), reference: "TUNAI" },
      ];
      for (const part of forged) {
        eq(await errOf(asActor(owner.token, "select app.sale_create($1,$2::jsonb)", [randomUUID(), mixed(q.lines, [part])])),
          "VALIDATION", "validasi DB");
      }
      eq(await errOf(asActor(owner.token, "select app.sale_create($1,$2::jsonb)",
        [randomUUID(), mixed(q.lines, [cashPart("15000"), external("QRIS", "0")])])), "SALE_PAYMENT_MISMATCH", "QRIS nol");
      eq(await errOf(asActor(owner.token, "select app.sale_create($1,$2::jsonb)",
        [randomUUID(), mixed(q.lines, [cashPart("0"), external("QRIS", "15000")])])), "SALE_PAYMENT_MISMATCH", "tunai nol");
      eq((await states(owner, p)).sales, 0, "tidak ada penjualan");
      return "Spasi tepi, baris baru, >64 karakter, status/aktor palsu, dan bagian nol ditolak";
    });

    await test("PAY-BALANCE-01", "integrasi DB", "Database menolak bagian bayar tambahan atau Sale tanpa pembayaran", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 2);
      const q = await quote(owner.token, p.line);
      const sale = await request("/sales", owner.token, mixed(q.lines, [external("TRANSFER", "15000")]), randomUUID());
      response(sale, 201);
      const [row] = await admin<{ user_id: string; location_id: string }>(`select s.actor_user_id user_id,s.location_id
        from biz.sale s where s.tenant_id=$1 and s.id=$2`, [owner.tenant, sale.body.sale_id]);
      // The session token stays set until commit, so the deferred guards see the real actor and tenant.
      const insertExtra = admin(`with actor as (select pg_catalog.set_config('app.session_token',$4,true))
        insert into biz.payment(tenant_id,sale_id,part_no,method,change_idr,net_received_idr,
        verification_status,verified_by,verified_at) select $1,$2,2,'QRIS',0,5000,'VERIFIED',$3,now() from actor`,
      [owner.tenant, sale.body.sale_id, row.user_id, owner.token]);
      eq(await errOf(insertExtra), "SALE_PAYMENT_MISMATCH", "bagian tambahan ditolak saat commit");
      const unpaid = admin(`with actor as (select pg_catalog.set_config('app.session_token',$5,true))
        insert into biz.sale(tenant_id,location_id,document_seq,business_day,finalized_at,actor_user_id,
        idempotency_key,total_idr) select $1,$2,99,app.tenant_today($1),now(),$3,$4,15000 from actor`,
      [owner.tenant, row.location_id, row.user_id, randomUUID(), owner.token]);
      eq(await errOf(unpaid), "SALE_PAYMENT_MISMATCH", "Sale tanpa pembayaran ditolak saat commit");
      const [count] = await admin<{ n: number }>("select count(*)::int n from biz.payment where tenant_id=$1", [owner.tenant]);
      eq(count.n, 1, "hanya satu bagian sah");
      return "Insert langsung bagian QRIS Rp5.000 dan Sale Rp15.000 tanpa bayar → SALE_PAYMENT_MISMATCH";
    });

    await test("SALE-DEADLINE-01", KIND, "Batas konservatif menghentikan penjualan di transaksi database", async () => {
      const owner = await registerOwnerSql(), p = await product(owner, 2);
      const q = await quote(owner.token, p.line), key = randomUUID();
      const body = cash(q.lines, "15000");
      await admin(`update platform.subscription sub
        set expires_at=t.deadline, activated_at=t.deadline-interval '168 hours'
        from (select clock_timestamp()+interval '7 seconds' deadline) t where sub.tenant_id=$1`, [owner.tenant]);
      const client = await rolePool("app_runtime").connect();
      try {
        await client.query("begin");
        await client.query("select pg_catalog.set_config('app.session_token',$1,true)", [owner.token]);
        const r = await client.query("select app.sale_create($1,$2::jsonb) as sale", [key, body]);
        ok(r.rows[0].sale.sale_id, "sementara ada di transaksi");
        await client.query("select pg_sleep(2.2)");
        eq(await errOf(client.query("commit")), "TENANT_LOCKED", "cek tertunda membatalkan commit");
      } finally {
        await client.query("rollback");
        client.release();
      }
      const after = await states(owner, p);
      eq(after.sales + after.payments + after.ledger + after.audit, 0, "semua posting rollback");
      eq(after.qty, 2, "stok tetap");
      response(await request(`/operations/${key}`, owner.token), 404, "NOT_FOUND");
      return "Posting sementara dibatalkan saat commit mendekati batas; stok tetap 2. T-06c literal masih terbuka.";
    });
  } finally {
    await app.close();
    await db.close();
  }
}
