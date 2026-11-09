// Uji FEFO INV-04: hanya saran batch; tidak mengurangi/mengunci stok.
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { AppConfig } from "../src/config/config";
import {
  DBNAME, RUNTIME_HOST, RUNTIME_PORT,
  TEST_OTP_MAC_KEY, admin, asActor, eq, harnessSender, ok, registerOwnerSql, test,
} from "./harness";

type Json = Record<string, unknown>;
const apiKind = "API";
const dbKind = "integrasi DB";
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const uuid = () => randomUUID();
let url = "";

async function http(path: string, token?: string): Promise<{status: number; body: Json; text: string}> {
  const r = await fetch(url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await r.text();
  let body: Json = {};
  try { body = JSON.parse(text) as Json; } catch { /* bukan JSON */ }
  return { status: r.status, body, text };
}

export async function fefoTests(): Promise<void> {
  const cfg: AppConfig = {
    mode: "test", port: 0,
    db: { host: RUNTIME_HOST, port: RUNTIME_PORT, database: DBNAME, poolMax: 20,
      auth: { user: "auth_runtime", password: undefined },
      app: { user: "app_runtime", password: undefined },
      otp: { user: "otp_dispatch_runtime", password: undefined } },
    otpSender: "test", ipHashSecret: Buffer.from("TEST_ONLY_fefo_ip_hash_secret_0123456789"),
    otpMacKey: TEST_OTP_MAC_KEY, otpDispatchIntervalMs: 1000, trustProxyHops: 0,
  };
  const { app, db } = await createApp(cfg, { otpSender: harnessSender });
  await app.listen(0, "127.0.0.1");
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  try {
    const A = await registerOwnerSql("Kios FEFO A");
    const B = await registerOwnerSql("Kios FEFO B");
    const body = {
      sku: "FEFO-" + uuid().slice(0, 8), name: "Pestisida Uji FEFO", category: "PESTICIDE",
      subsidized: false, baseUnit: "botol",
      packages: [{ key: "botol", form: "LOOSE", factor: 1, label: "Botol" }],
      opening: [
        { packageKey: "botol", qty: 2, batch: { number: "B-LATE", expiresOn: future(90) }, cost: { basis: "KNOWN", totalIdr: 200 } },
        { packageKey: "botol", qty: 2, batch: { number: "B-EARLY", expiresOn: future(30) }, cost: { basis: "KNOWN", totalIdr: 200 } },
        { packageKey: "botol", qty: 2, batch: { number: "B-MID", expiresOn: future(60) }, cost: { basis: "KNOWN", totalIdr: 200 } },
      ],
    };
    const [made] = await asActor<{ r: { productId: string } }>(A.token,
      "select app.product_create($1,$2::jsonb) as r", [uuid(), JSON.stringify(body)]);
    const productId = made.r.productId;
    const pkg = (await admin<{ id: string }>(
      "select id from biz.package_version where tenant_id=$1 and product_id=$2 limit 1", [A.tenant, productId]))[0].id;
    const batch = await admin<{ id: string; batch_number: string }>(
      "select id,batch_number from biz.batch where tenant_id=$1 and product_id=$2", [A.tenant, productId]);
    const early = batch.find((b) => b.batch_number === "B-EARLY")!.id;
    // Skenario negatif untuk mutant FEFO_GUARD: stok karantina dengan expiry masih aman
    // tidak boleh muncul sekalipun status=SALEABLE sengaja dihapus dari query.
    await asActor(A.token, "select app.inventory_receive($1,$2::jsonb) as r",
      [uuid(), JSON.stringify({ productId, supplierName: "Pemasok Karantina",
        lines: [{ packageId: pkg, qty: 1, status: "QUARANTINE",
          batch: { number: "Q-CLEAR", expiresOn: future(15) },
          cost: { basis: "KNOWN", totalIdr: 100 } }] })]);
    const locB = (await admin<{ id: string }>("select id from platform.location where tenant_id=$1 limit 1", [B.tenant]))[0].id;
    const path = `/inventory/fefo?productId=${productId}`;

    await test("FEFO-01", apiKind, "FEFO mengurutkan batch layak berdasarkan expiry dan tidak melakukan reservasi", async () => {
      const r = await http(path, A.token);
      eq(r.status, 200, r.text);
      const suggestions = r.body.suggestions as Json[];
      eq(suggestions.length, 3, "jumlah batch");
      eq(suggestions.map((s) => s.batchNumber).join(","), "B-EARLY,B-MID,B-LATE", "urutan");
      eq(r.body.reservation, false, "bukan reservasi");
      eq(suggestions[0].availablePackages, 2, "kuantitas");
      return "urutan expiry naik; tidak ada reservasi";
    });

    await test("FEFO-02", apiKind, "FEFO tidak mengusulkan batch yang ditahan (bahkan sesudah perubahan status)", async () => {
      const [h] = await asActor<{ r: Json }>(A.token,
        "select app.stock_hold($1,$2::jsonb) as r",
        [uuid(), JSON.stringify({ productId, batchId: early, reason: "Batch bermasalah" })]);
      ok(Boolean(h.r), "gagal membuat penahanan");
      const r = await http(path, A.token);
      eq(r.status, 200, r.text);
      eq((r.body.suggestions as Json[]).map((s) => s.batchNumber).join(","), "B-MID,B-LATE", "batch tertahan tak boleh disarankan");
      return "stok HELD dikeluarkan dari rekomendasi";
    });

    await test("FEFO-03", apiKind, "BOLA dan sesi tidak sah tidak boleh membaca FEFO toko lain", async () => {
      const cross = await http(path, B.token);
      eq(cross.status, 404, cross.text);
      const anon = await http(path);
      eq(anon.status, 401, "tanpa sesi");
      return "tenant lain 404, tanpa sesi 401";
    });

    await test("FEFO-04", apiKind, "Input asing dan referensi lokasi/kemasan toko lain ditolak", async () => {
      const unknown = await http(path + "&tenantId=" + B.tenant, A.token);
      eq(unknown.status, 400, "key tenant asing");
      const bad = await http("/inventory/fefo?productId=none", A.token);
      eq(bad.status, 400, "UUID salah");
      const other = await http(path + "&locationId=" + locB, A.token);
      eq(other.status, 404, "lokasi tenant lain");
      const badLimit = await http(path + "&limit=999", A.token);
      eq(badLimit.status, 400, "batas daftar");
      return "400 key/UUID/limit, 404 lokasi asing";
    });

    await test("FEFO-05", apiKind, "Batch tanpa expiry di belakang; kedaluwarsa di karantina tidak termasuk", async () => {
      const [rcv] = await asActor<{ r: Json }>(A.token,
        "select app.inventory_receive($1,$2::jsonb) as r",
        [uuid(), JSON.stringify({ productId, supplierName: "Pemasok FEFO",
          lines: [
            { packageId: pkg, qty: 1, status: "SALEABLE", batch: { number: "NO-EXP" }, cost: { basis: "KNOWN", totalIdr: 100 } },
            { packageId: pkg, qty: 1, status: "QUARANTINE", batch: { number: "EXPIRED", expiresOn: future(-30) }, cost: { basis: "KNOWN", totalIdr: 100 } },
          ] })]);
      ok(Boolean(rcv.r), "penerimaan");
      const r = await http(path, A.token);
      eq(r.status, 200, r.text);
      eq((r.body.suggestions as Json[]).map((s) => s.batchNumber).join(","), "B-MID,B-LATE,NO-EXP", "urutan nulls last");
      return "expiry tidak diketahui ditempatkan terakhir; karantina dan expired tidak masuk";
    });

    await test("FEFO-06", dbKind, "Pemanggilan FEFO SQL tidak mengubah saldo maupun ledger", async () => {
      const [before] = await admin<{ n: number }>(
        "select count(*)::int n from biz.inventory_ledger where tenant_id=$1 and product_id=$2", [A.tenant, productId]);
      const [b] = await admin<{ q: string }>(
        "select coalesce(sum(qty),0)::text q from biz.stock_balance where tenant_id=$1 and product_id=$2", [A.tenant, productId]);
      const [r] = await asActor<{ r: Json }>(A.token,
        "select app.inventory_fefo($1,$2,$3,$4) as r", [productId, pkg, null, 10]);
      ok(Array.isArray(r.r.suggestions), "respons SQL");
      const [after] = await admin<{ n: number }>(
        "select count(*)::int n from biz.inventory_ledger where tenant_id=$1 and product_id=$2", [A.tenant, productId]);
      const [a] = await admin<{ q: string }>(
        "select coalesce(sum(qty),0)::text q from biz.stock_balance where tenant_id=$1 and product_id=$2", [A.tenant, productId]);
      eq(after.n, before.n, "ledger berubah");
      eq(a.q, b.q, "saldo berubah");
      return "ledger dan saldo identik";
    });
  } finally {
    await app.close();
    await db.close();
  }
}
