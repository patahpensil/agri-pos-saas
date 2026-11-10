// INV-07: uji stok opname PRO, rebase mutasi sejak counted_at dan persetujuan Owner.
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { AppConfig } from "../src/config/config";
import {
  DBNAME, RUNTIME_HOST, RUNTIME_PORT, TEST_OTP_MAC_KEY, PW,
  admin, asActor, eq, errOf, harnessSender, inviteAndActivateAdminSql,
  makePro, ok, registerOwnerSql, test,
} from "./harness";

type Json = Record<string, unknown>;
const uuid = () => randomUUID();
const KA = "API";
const KD = "integrasi DB";
let url = "";

async function http(method: string, path: string, token?: string, body?: unknown, key?: string):
 Promise<{ status: number; body: Json; text: string }> {
  const response = await fetch(url + path, {
    method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let result: Json = {};
  try { result = JSON.parse(text) as Json; } catch { /* status error dapat non-JSON */ }
  return { status: response.status, body: result, text };
}
async function serverNow(): Promise<string> {
  const [r] = await admin<{ t: Date }>("select clock_timestamp() t");
  return new Date(r.t).toISOString();
}
async function countSubmit(token: string, productId: string, packageId: string, batchId: string,
  physicalQty: number, cost?: Json, key = uuid()) {
  const body = { productId, countedAt: await serverNow(), reason: "Hitung fisik di rak",
    lines: [{ packageId, batchId, physicalQty, ...(cost ? { cost } : {}) }] };
  return { body, key, result: await http("POST", "/inventory/counts", token, body, key) };
}
async function tokenFor(token: string, countId: string, expectedVersion = 1): Promise<string> {
  const r = await http("POST", "/auth/reauth", token, {
    password: PW, action: "inventory.count.approve", targetId: countId,
    scope: { expectedVersion },
  });
  eq(r.status, 201, "reauth: " + r.text);
  return String(r.body.reauthToken);
}
async function approve(token: string, countId: string, reauthToken: string,
  key = uuid(), bodyExtra: Json = {}) {
  const body = { expectedVersion: 1, reason: "Disetujui setelah cek stok", reauthToken, ...bodyExtra };
  return { key, body, result: await http("POST", `/inventory/counts/${countId}/approve`, token, body, key) };
}

export async function stockCountTests(): Promise<void> {
  const cfg: AppConfig = {
    mode: "test", port: 0,
    db: { host: RUNTIME_HOST, port: RUNTIME_PORT, database: DBNAME, poolMax: 20,
      auth: { user: "auth_runtime", password: undefined },
      app: { user: "app_runtime", password: undefined },
      otp: { user: "otp_dispatch_runtime", password: undefined } },
    otpSender: "test", ipHashSecret: Buffer.from("TEST_ONLY_count_ip_hash_secret_0123456789"),
    otpMacKey: TEST_OTP_MAC_KEY, otpDispatchIntervalMs: 1000, trustProxyHops: 0,
  };
  const { app, db } = await createApp(cfg, { otpSender: harnessSender });
  await app.listen(0, "127.0.0.1");
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  try {
    const O = await registerOwnerSql("Kios Opname PRO");
    const Other = await registerOwnerSql("Kios Opname Asing");
    await test("COUNT-01", KA, "FREE tidak boleh mengakses opname terstruktur", async () => {
      const list = await http("GET", "/inventory/counts", O.token);
      eq(list.status, 403, list.text);
      const post = await http("POST", "/inventory/counts", O.token, {
        productId: uuid(), countedAt: await serverNow(), reason: "uji",
        lines: [{ packageId: uuid(), batchId: uuid(), physicalQty: 1 }],
      }, uuid());
      eq(post.status, 403, post.text);
      return "FREE 403, tidak boleh melaksanakan opname PRO";
    });
    await makePro(O.tenant);
    const ADM = await inviteAndActivateAdminSql(O);
    const body = {
      sku: "CNT-" + uuid().slice(0, 8), name: "Pestisida Opname", category: "PESTICIDE",
      subsidized: false, baseUnit: "botol",
      packages: [{ key: "botol", form: "LOOSE", factor: 1, label: "Botol" }],
      opening: [{ packageKey: "botol", qty: 10,
        batch: { number: "COUNT-10", expiresOn: "2035-06-01" },
        cost: { basis: "KNOWN", totalIdr: 1000 } }],
    };
    const [made] = await asActor<{ r: { productId: string } }>(O.token,
      "select app.product_create($1,$2::jsonb) r", [uuid(), JSON.stringify(body)]);
    const productId = made.r.productId;
    const [pkg] = await admin<{ id: string }>(
      "select id from biz.package_version where tenant_id=$1 and product_id=$2 limit 1", [O.tenant, productId]);
    const [bt] = await admin<{ id: string }>(
      "select id from biz.batch where tenant_id=$1 and product_id=$2 limit 1", [O.tenant, productId]);
    let countId = "";
    let requestKey = "";
    let requestBody: Json = {};
    let countToken = "";

    await test("COUNT-02", KA, "Owner/Admin PRO mengajukan opname tanpa mutasi stok; tercatat countedAt/enteredAt/versi ledger dan idempotensi", async () => {
      const before = (await admin<{ n: number }>(
        "select count(*)::int n from biz.inventory_ledger where tenant_id=$1 and product_id=$2",
        [O.tenant, productId]))[0].n;
      const s = await countSubmit(ADM.token, productId, pkg.id, bt.id, 8);
      requestKey = s.key; requestBody = s.body;
      eq(s.result.status, 201, s.result.text);
      countId = String(s.result.body.countId);
      const replay = await http("POST", "/inventory/counts", ADM.token, requestBody, requestKey);
      eq(replay.status, 201, replay.text);
      eq(replay.body.countId, countId, "same count");
      eq(replay.body.replayed, true, "idem replay");
      const [count] = await admin<{ submitted_by: string; counted_at: Date; entered_at: Date; ledger_version: string; qty: number; physical: number }>(
        `select c.submitted_by,c.counted_at,c.entered_at,c.ledger_version,l.system_qty_at_count qty,l.physical_qty physical
           from biz.stock_count c join biz.stock_count_line l on c.tenant_id=l.tenant_id and c.id=l.count_id
          where c.tenant_id=$1 and c.id=$2`, [O.tenant, countId]);
      eq(count.qty, 10, "qty saat hitung");
      eq(count.physical, 8, "fisik 8");
      ok(count.ledger_version !== null && new Date(count.entered_at) >= new Date(count.counted_at), "waktu/ledger");
      const after = (await admin<{ n: number }>(
        "select count(*)::int n from biz.inventory_ledger where tenant_id=$1 and product_id=$2",
        [O.tenant, productId]))[0].n;
      eq(after, before, "pengajuan mengubah ledger");
      return "pengajuan PRO tercatat; ledger belum berubah; retry tidak ganda";
    });

    await test("COUNT-03", KA, "Admin, token palsu, tenant lain, dan body asing ditolak", async () => {
      // Uji ini harus mandiri: harness mutasi menjalankan COUNT-03 saja.
      // Tanpa setup mandiri, mutant dapat tampak tertangkap karena countId kosong.
      if (!countId) {
        const s = await countSubmit(ADM.token, productId, pkg.id, bt.id, 8);
        eq(s.result.status, 201, "fixture COUNT-03: " + s.result.text);
        countId = String(s.result.body.countId);
        requestKey = s.key;
        requestBody = s.body;
      }
      const listed = await http("GET", "/inventory/counts", O.token);
      eq(listed.status, 200, listed.text);
      ok((listed.body.items as Json[]).some((c) => c.id === countId), "list tidak memuat count");
      const foreign = await http("GET", "/inventory/counts", Other.token);
      eq(foreign.status, 403, "FREE tenant lain gated");
      await makePro(Other.tenant);
      const cross = await http("POST", `/inventory/counts/${countId}/approve`, Other.token,
        { expectedVersion: 1, reason: "x", reauthToken: "a".repeat(64) }, uuid());
      eq(cross.status, 404, "tenant lain harus NOT_FOUND");
      const blockedAdmin = await http("POST", `/inventory/counts/${countId}/approve`, ADM.token,
        { expectedVersion: 1, reason: "x", reauthToken: "a".repeat(64) }, uuid());
      eq(blockedAdmin.status, 403, "admin tidak boleh menyetujui");
      const forged = await http("POST", `/inventory/counts/${countId}/approve`, O.token,
        { expectedVersion: 1, reason: "x", reauthToken: "a".repeat(64) }, uuid());
      eq(forged.status, 403, "reauth token palsu");
      const unknown = await http("POST", "/inventory/counts", ADM.token,
        { ...requestBody, tenantId: O.tenant }, uuid());
      eq(unknown.status, 400, "tenant input asing");
      const nested = await http("POST", "/inventory/counts", ADM.token,
        { ...requestBody, lines: [{ packageId: pkg.id, batchId: bt.id, physicalQty: 8, role: "OWNER" }] }, uuid());
      eq(nested.status, 400, "nested input asing");
      const duplicate = await http("POST", "/inventory/counts", ADM.token,
        { ...requestBody, lines: [
          { packageId: pkg.id, batchId: bt.id, physicalQty: 8 },
          { packageId: pkg.id, batchId: bt.id, physicalQty: 8 },
        ] }, uuid());
      eq(duplicate.status, 400, "count lines duplicate");
      return "isolasi tenant, Admin tidak approve, token palsu, foreign key strict";
    });

    await test("ST-INV-09-INV", KA, "Mutasi setelah countedAt tidak hilang ketika Owner menyetujui opname; HPP & ledger konsisten", async () => {
      const m = await http("POST", "/inventory/status-moves", O.token,
        { productId, packageId: pkg.id, batchId: bt.id, from: "SALEABLE", to: "QUARANTINE", qty: 2, reason: "dipindah setelah hitung" }, uuid());
      eq(m.status, 201, m.text);
      const [prior] = await admin<{ qty: number }>(
        "select qty from biz.stock_balance where tenant_id=$1 and product_id=$2 and batch_id=$3 and status='SALEABLE'",
        [O.tenant, productId, bt.id]);
      eq(prior.qty, 8, "stok sudah bergerak 2 unit");
      countToken = await tokenFor(O.token, countId);
      const approved = await approve(O.token, countId, countToken);
      eq(approved.result.status, 200, approved.result.text);
      eq(Number(approved.result.body.qtyBaseDelta), -2, "delta koreksi");
      const [after] = await admin<{ saleable: number; quarantine: number; saleable_value: string; quarantine_value: string }>(
        `select
           (select qty from biz.stock_balance where tenant_id=$1 and product_id=$2 and batch_id=$3 and status='SALEABLE') saleable,
           (select qty from biz.stock_balance where tenant_id=$1 and product_id=$2 and batch_id=$3 and status='QUARANTINE') quarantine,
           (select value_idr::text from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='SALEABLE') saleable_value,
           (select value_idr::text from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='QUARANTINE') quarantine_value`,
        [O.tenant, productId, bt.id]);
      eq(after.saleable, 6, "fisik 8 - selisih 2 + perpindahan 2 => 6 siap jual");
      eq(after.quarantine, 2, "mutasi setelah count tetap ada");
      eq(after.saleable_value, "600", "HPP siap jual");
      eq(after.quarantine_value, "200", "HPP karantina");
      const [event] = await admin<{ n: number; delta: number }>(
        `select count(*)::int n,coalesce(sum(qty_delta),0)::int delta from biz.inventory_ledger
           where tenant_id=$1 and product_id=$2 and movement='COUNT_ADJUST'`, [O.tenant, productId]);
      eq(event.n, 1, "satu posting koreksi");
      eq(event.delta, -2, "quantity koreksi");
      return "10 sebelum hitung, count 8, mutasi -2, approval -> 6 siap jual +2 karantina, nilai 600+200";
    });

    await test("COUNT-04", KA, "Approval idempotent, persetujuan kedua ditolak, dan count immutable", async () => {
      const r = await approve(O.token, countId, countToken);
      eq(r.result.status, 409, "kunci berbeda setelah count disetujui");
      const [c] = await admin<{ n: number; ver: number }>(
        "select count(*)::int n,max(version)::int ver from biz.stock_count where tenant_id=$1 and id=$2",
        [O.tenant, countId]);
      eq(c.ver, 2, "version disetujui");
      const changes = [
        "update biz.stock_count set reason='PALSU' where id=$1",
        "delete from biz.stock_count where id=$1",
        "update biz.stock_count_line set physical_qty=99 where count_id=$1",
      ];
      for(const sql of changes) {
        const err = await errOf(admin(sql, [countId]));
        ok(err !== "OK", "count immutable");
      }
      return "second approve ditolak, header dan snapshot tidak dapat ditulis ulang";
    });

    await test("COUNT-05", KA, "Penyesuaian stok bertambah dengan basis HPP diketahui lalu tidak terverifikasi", async () => {
      const nowQty = 6;
      const add = await countSubmit(O.token, productId, pkg.id, bt.id, nowQty+1, { basis: "KNOWN", totalIdr: 50 });
      eq(add.result.status, 201, add.result.text);
      const t = await tokenFor(O.token, String(add.result.body.countId));
      const a = await approve(O.token, String(add.result.body.countId), t);
      eq(a.result.status, 200, a.result.text);
      const [known] = await admin<{ value: string; qty: string; unverified: boolean }>(
        "select value_idr::text value,qty_base::text qty,unverified from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='SALEABLE'",
        [O.tenant, productId]);
      eq(known.qty, "7", "stok +1");
      eq(known.value, "650", "biaya +50");
      eq(known.unverified, false, "masih known");
      const unknown = await countSubmit(O.token, productId, pkg.id, bt.id, 8,
        { basis: "UNVERIFIED", reason: "Belum ada bukti modal tambahan" });
      eq(unknown.result.status, 201, unknown.result.text);
      const t2 = await tokenFor(O.token, String(unknown.result.body.countId));
      const a2 = await approve(O.token, String(unknown.result.body.countId), t2);
      eq(a2.result.status, 200, a2.result.text);
      const [flag] = await admin<{ value: string; qty: string; unverified: boolean }>(
        "select value_idr::text value,qty_base::text qty,unverified from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='SALEABLE'",
        [O.tenant, productId]);
      eq(flag.qty, "8", "stok +1 unverified");
      eq(flag.value, "650", "tidak menciptakan biaya fiktif");
      eq(flag.unverified, true, "label UNVERIFIED");
      return "stok +2, HPP tambahan hanya known Rp50; sisanya berlabel UNVERIFIED";
    });

    await test("COUNT-06", KA, "FREE dan tenant lain tidak bisa membaca/mengubah opname toko PRO; tidak ada DML runtime", async () => {
      const [obj] = await admin<{ id: string }>("select id from biz.stock_count where tenant_id=$1 order by entered_at desc limit 1",[O.tenant]);
      const direct = await errOf(asActor(O.token, "update biz.stock_count set reason='bypass' where id=$1", [obj.id]));
      ok(direct !== "OK", "role app runtime DML ditolak");
      const other = await http("GET", "/inventory/counts", Other.token);
      eq(other.status, 200, "PRO tenant lain bisa baca daftar sendiri");
      ok(!(other.body.items as Json[]).some((c) => c.id === obj.id), "count tenant lain bocor");
      return "RLS, no DML, BOLA count";
    });

    await test("COUNT-07", KD, "Koreksi HPP sisa rupiah deterministik: 3 unit Rp100 -> 33,33,34", async () => {
      const pbody = {
        sku: "RESID-" + uuid().slice(0, 8), name: "Unit HPP Residu", category: "PESTICIDE",
        subsidized: false, baseUnit: "unit",
        packages: [{ key: "u", form: "LOOSE", factor: 1, label: "Unit" }],
        opening: [{ packageKey: "u", qty: 3,
          batch: { number: "R-3", expiresOn: "2035-06-01" },
          cost: { basis: "KNOWN", totalIdr: 100 } }],
      };
      const [prod] = await asActor<{ r: { productId: string } }>(O.token,"select app.product_create($1,$2::jsonb) r",[uuid(),JSON.stringify(pbody)]);
      const product = prod.r.productId;
      const [pk] = await admin<{ id: string }>("select id from biz.package_version where tenant_id=$1 and product_id=$2",[O.tenant,product]);
      const [batch] = await admin<{ id: string }>("select id from biz.batch where tenant_id=$1 and product_id=$2",[O.tenant,product]);
      const vals: number[] = [];
      for (const physical of [2,1,0]) {
        const s = await countSubmit(O.token, product, pk.id, batch.id, physical);
        eq(s.result.status, 201, s.result.text);
        const tk = await tokenFor(O.token, String(s.result.body.countId));
        const r = await approve(O.token, String(s.result.body.countId), tk);
        eq(r.result.status, 200, r.result.text);
        vals.push(-Number(r.result.body.valueDeltaIdr));
      }
      eq(vals.join(","), "33,33,34", "Rp100 dibagi deterministik");
      const [pool] = await admin<{ q: string; v: string }>(
        "select qty_base::text q,value_idr::text v from biz.cost_pool where tenant_id=$1 and product_id=$2 and status='SALEABLE'",
        [O.tenant,product]);
      eq(pool.q, "0", "stok zero");
      eq(pool.v, "0", "rupiah zero");
      return "Rp33+Rp33+Rp34 = Rp100; saldo dan nilai akhir 0";
    });

    await test("COUNT-08", KA, "Penyesuaian tidak boleh membuat stok negatif setelah pergerakan pascahitung", async () => {
      const s = await countSubmit(O.token, productId, pkg.id, bt.id, 0);
      eq(s.result.status, 201, s.result.text);
      const m = await http("POST", "/inventory/status-moves", O.token,
        { productId, packageId: pkg.id, batchId: bt.id, from: "SALEABLE", to: "QUARANTINE",
          qty: 8, reason: "Dipindahkan setelah hitung" }, uuid());
      eq(m.status, 201, m.text);
      const t = await tokenFor(O.token, String(s.result.body.countId));
      const r = await approve(O.token, String(s.result.body.countId), t);
      eq(r.result.status, 409, r.result.text);
      eq(r.result.body.code, "INSUFFICIENT_STOCK", "gagal konservasi");
      const [q] = await admin<{ n: string }>(
        "select coalesce(sum(qty),0)::text n from biz.stock_balance where tenant_id=$1 and product_id=$2 and status='SALEABLE'",
        [O.tenant, productId]);
      eq(q.n, "0", "stok tidak negatif");
      return "post-count movement dipertahankan; koreksi mustahil ditolak";
    });


    await test("COUNT-09", KA, "Dua opname batch sama tidak memotong stok dua kali; opname basi ditolak", async () => {
      // Fixture milik COUNT-09: dapat berjalan sendiri lewat TEST_ONLY_IDS.
      async function fixture(suffix: string) {
        const body = {
          sku: "STALE-" + uuid().slice(0, 8), name: "Pestisida Opname " + suffix,
          category: "PESTICIDE", subsidized: false, baseUnit: "botol",
          packages: [{ key: "botol", form: "LOOSE", factor: 1, label: "Botol" }],
          opening: [{ packageKey: "botol", qty: 10,
            batch: { number: "B-" + suffix, expiresOn: "2035-06-01" },
            cost: { basis: "KNOWN", totalIdr: 1000 } }],
        };
        const [made] = await asActor<{ r: { productId: string } }>(O.token,
          "select app.product_create($1,$2::jsonb) r", [uuid(), JSON.stringify(body)]);
        const product = made.r.productId;
        const [packageRow] = await admin<{ id: string }>(
          "select id from biz.package_version where tenant_id=$1 and product_id=$2 limit 1",
          [O.tenant, product]);
        const [batchRow] = await admin<{ id: string }>(
          "select id from biz.batch where tenant_id=$1 and product_id=$2 limit 1",
          [O.tenant, product]);
        ok(Boolean(packageRow?.id && batchRow?.id), "fixture opname tidak lengkap");
        return { product, packageId: packageRow.id, batchId: batchRow.id };
      }
      async function saldo(product: string, expectedLedger: number) {
        const [balance] = await admin<{ n: string }>(
          `select coalesce(sum(qty),0)::text n from biz.stock_balance
            where tenant_id=$1 and product_id=$2 and status='SALEABLE'`,
          [O.tenant, product]);
        const [pool] = await admin<{ q: string; v: string }>(
          `select qty_base::text q,value_idr::text v from biz.cost_pool
            where tenant_id=$1 and product_id=$2 and status='SALEABLE'`,
          [O.tenant, product]);
        const [ledger] = await admin<{ n: number }>(
          `select count(*)::int n from biz.inventory_ledger
            where tenant_id=$1 and product_id=$2 and movement='COUNT_ADJUST'`,
          [O.tenant, product]);
        eq(balance.n, "8", "stok harus 8 botol");
        eq(pool.q, "8", "pool qty harus 8");
        eq(pool.v, "800", "pool nilai harus Rp800");
        eq(ledger.n, expectedLedger, "baris ledger koreksi");
        return "stok=" + balance.n + ",pool=" + pool.q + "/Rp" + pool.v + ",ledger=" + ledger.n;
      }
      async function submitFor(f: { product: string; packageId: string; batchId: string },
        countedAt?: string) {
        const body = { productId: f.product, countedAt: countedAt ?? await serverNow(),
          reason: "Opname fisik", lines: [{ packageId: f.packageId, batchId: f.batchId, physicalQty: 8 }] };
        return http("POST", "/inventory/counts", O.token, body, uuid());
      }
      async function approveId(id: string) {
        return approve(O.token, id, await tokenFor(O.token, id));
      }
      // (a) A lebih dahulu disetujui; B yang menghitung keadaan sama harus ditolak.
      const a = await fixture("A");
      const a1 = await submitFor(a);
      const b1 = await submitFor(a);
      eq(a1.status, 201, "A harus masuk");
      eq(b1.status, 201, "B harus masuk");
      const aid = String(a1.body.countId), bid = String(b1.body.countId);
      const aOk = await approveId(aid);
      eq(aOk.result.status, 200, aOk.result.text);
      const aBalance = await saldo(a.product, 1);
      const bDenied = await approveId(bid);
      eq(bDenied.result.status, 409, bDenied.result.text);
      eq(bDenied.result.body.code, "VERSION_CONFLICT", "B harus ditolak sebagai opname basi");
      const aFinal = await saldo(a.product, 1);
      const [bState] = await admin<{ state: string }>(
        "select state from biz.stock_count where tenant_id=$1 and id=$2", [O.tenant, bid]);
      eq(bState.state, "PENDING", "B tidak boleh otomatis disetujui");

      // (b) B lebih dahulu disetujui; A harus ditolak dengan saldo tetap 8.
      const rev = await fixture("B");
      const revA = await submitFor(rev), revB = await submitFor(rev);
      eq(revA.status, 201, "A urutan balik masuk");
      eq(revB.status, 201, "B urutan balik masuk");
      const revBok = await approveId(String(revB.body.countId));
      eq(revBok.result.status, 200, revBok.result.text);
      const revAdenied = await approveId(String(revA.body.countId));
      eq(revAdenied.result.status, 409, revAdenied.result.text);
      eq(revAdenied.result.body.code, "VERSION_CONFLICT", "A urutan balik harus ditolak");
      const bFinal = await saldo(rev.product, 1);

      // (c) C dibuat setelah A disetujui, tetapi countedAt berada di antara A dibuat dan A disetujui.
      const stale = await fixture("C");
      const priorA = await submitFor(stale);
      eq(priorA.status, 201, priorA.text);
      const middleTime = await serverNow();
      const approvedA = await approveId(String(priorA.body.countId));
      eq(approvedA.result.status, 200, approvedA.result.text);
      const lateC = await submitFor(stale, middleTime);
      eq(lateC.status, 409, lateC.text);
      eq(lateC.body.code, "VERSION_CONFLICT", "C dihitung sebelum koreksi A");
      const cFinal = await saldo(stale.product, 1);

      // (d) Opname setelah approval terdahulu adalah keadaan baru yang sah; tidak ada koreksi kedua.
      const valid = await fixture("D");
      const validA = await submitFor(valid);
      eq(validA.status, 201, validA.text);
      const validAok = await approveId(String(validA.body.countId));
      eq(validAok.result.status, 200, validAok.result.text);
      const validD = await submitFor(valid);
      eq(validD.status, 201, validD.text);
      const validDok = await approveId(String(validD.body.countId));
      eq(validDok.result.status, 200, validDok.result.text);
      eq(Number(validDok.result.body.qtyBaseDelta), 0, "D tidak boleh mengoreksi lagi");
      const dFinal = await saldo(valid.product, 1);
      return `a=${aBalance}→${aFinal},B=409/PENDING; b=${bFinal},A=409; c=${cFinal},C=409; d=${dFinal},D=200/delta0`;
    });

  } finally {
    await app.close();
    await db.close();
  }
}
