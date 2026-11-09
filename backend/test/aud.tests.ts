// Uji perbaikan audit independen PR #4 (bagian integrasi database / pengirim OTP).
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { Client, Pool } from "pg";
import { dispatchOtps, OtpSender, TestOtpSender } from "../src/auth/otp-sender";
import { setLogSink } from "../src/common/log";
import {
  ADMIN_HOST, ADMIN_PORT, ADMIN_USER, DBNAME, PW, RUNTIME_HOST, RUNTIME_PORT, TEST_OTP_MAC_KEY,
  admin, asActor, asRole, claimCode, eq, errOf, inviteAndActivateAdminSql, mac, makePro, newDevice, newPhone, ok,
  regVerify, registerOwnerSql, rolePool, sleep, test, waitFor,
} from "./harness";

const K = "integrasi DB";
const KO = "integrasi DB/pengirim OTP";

class FailingSender implements OtpSender {
  readonly kind = "test-fail";
  readonly seen: string[] = [];
  async send(_phone: string, code: string): Promise<void> {
    this.seen.push(code);
    throw new Error("provider down");
  }
}

const phoneKey = (p: string) => createHash("sha256").update(p).digest().subarray(0, 16).toString("hex");

async function outboxOf(phone: string) {
  return admin<{ status: string; send_attempts: number }>(
    "select status, send_attempts from iam.otp_outbox where phone_e164=$1 order by created_at desc limit 1", [phone],
  );
}

// Issue #5: uji batas laju tidak boleh melintasi pergantian jendela waktu di tengah jalan. Bila sisa jendela
// login (login_window_seconds) kurang dari `needS` detik, tunggu sampai jendela baru dimulai (syarat awal
// deterministik, bukan tidur sembarang).
async function ensureWindowMargin(needS = 30): Promise<number> {
  const [w] = await admin<{ left: number }>(
    `select (ceil(extract(epoch from clock_timestamp()) / p.value) * p.value - extract(epoch from clock_timestamp()))::float8 "left"
       from iam.security_param p where p.key = 'login_window_seconds'`);
  if (w.left < needS) await sleep(Math.ceil(w.left * 1000) + 500);
  return w.left;
}

export async function audDbTests(): Promise<void> {
  // ------------------------------------------------------------------ AUD-OTP-01
  await test("AUD-OTP-01", K, "OTP tidak tersimpan terbuka; salinan DB tanpa kunci tidak membuka OTP; role lain tidak bisa mengambil", async () => {
    const p = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p]);
    const code = await claimCode(p);
    // 1) isi tabel antrean & challenge (seperti dibaca superuser/dump) tidak memuat kode
    const ob = await admin<Record<string, unknown>>("select * from iam.otp_outbox where phone_e164=$1", [p]);
    const ch = await admin<{ code_mac: Buffer }>("select * from iam.otp_challenge where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [p]);
    const flat = JSON.stringify([...ob, ...ch], (_k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v));
    ok(!flat.includes(`"${code}"`) && !Object.keys(ob[0]).includes("code"), "kode muncul di tabel");
    const cols = await admin<{ c: string }>("select table_name||'.'||column_name c from information_schema.columns where table_schema='iam' and table_name in ('otp_outbox','otp_challenge')");
    ok(!cols.some((x) => /\.code$/.test(x.c)), `kolom kode mentah ada: ${cols.map((x) => x.c).join(",")}`);
    // 2) dump database: blok data antrean tidak memuat field 6 digit; MAC tidak bisa dibuka tanpa kunci
    const bin = process.env.PG_BIN ? `${process.env.PG_BIN}/pg_dump` : "pg_dump";
    const dump = spawnSync(bin, ["-h", ADMIN_HOST, "-p", String(ADMIN_PORT), "-U", ADMIN_USER, "-d", DBNAME, "--data-only", "-t", "iam.otp_outbox", "-t", "iam.otp_challenge"], { encoding: "utf8", maxBuffer: 1 << 28 });
    eq(dump.status, 0, `pg_dump: ${dump.stderr}`);
    const fields = dump.stdout.split("\n").filter((l) => l.includes("\t")).flatMap((l) => l.split("\t"));
    ok(!fields.some((f) => /^[0-9]{6}$/.test(f)), "field 6 digit di dump");
    ok(!dump.stdout.includes(TEST_OTP_MAC_KEY.toString()), "kunci MAC ada di dump");
    const target = ch[0].code_mac.toString("hex");
    const tries: Record<string, (c: string) => string> = {
      sha256_kode: (c) => createHash("sha256").update(c).digest("hex"),
      sha256_tujuan_nomor_kode: (c) => createHash("sha256").update(`REGISTER_OWNER|${p}|${c}`).digest("hex"),
      hmac_kunci_kosong: (c) => createHmac("sha256", "").update(`REGISTER_OWNER|${p}|${c}`).digest("hex"),
      hmac_kunci_salah: (c) => createHmac("sha256", "kunci-tebakan-penyerang").update(`REGISTER_OWNER|${p}|${c}`).digest("hex"),
    };
    let found = 0;
    for (const f of Object.values(tries)) for (let i = 0; i < 1_000_000; i++) if (f(String(i).padStart(6, "0")) === target) found++;
    let withKey = "";
    for (let i = 0; i < 1_000_000 && !withKey; i++) {
      const c = String(i).padStart(6, "0");
      if (mac("REGISTER_OWNER", p, c).toString("hex") === target) withKey = c;
    }
    eq(found, 0, "kode terbuka tanpa kunci");
    eq(withKey, code, "kontrol positif dengan kunci");
    // 3) role tanpa izin tidak bisa mengambil/membuka
    const denied: string[] = [];
    for (const role of ["auth_runtime", "app_runtime"]) {
      for (const sql of ["select * from iam.otp_dispatch_claim(10)", "select iam.otp_dispatch_set_code(gen_random_uuid(), '\\x00', '\\x00')",
                         "select iam.otp_dispatch_ack(gen_random_uuid(), '\\x00')", "select * from iam.otp_outbox", "select * from iam.otp_challenge"]) {
        const e = await errOf(asRole(role, sql));
        ok(e.startsWith("42501"), `${role}: ${sql} -> ${e}`);
        denied.push(e.slice(0, 5));
      }
    }
    // 4) kode benar diterima sekali, replay ditolak
    const [r1] = await regVerify(p, code, "Kios OTP", newDevice());
    const [r2] = await regVerify(p, code, "Kios OTP 2", newDevice());
    eq(r1.r_status, "OK", "pakai pertama");
    eq(r2.r_status, "OTP_INVALID", "replay");
    return `tanpa kolom kode; dump tanpa field 6 digit & tanpa kunci; 4x1.000.000 tebakan tanpa kunci = 0 cocok, dengan kunci = kode benar; ${denied.length} akses tanpa izin ditolak 42501; sekali pakai`;
  });

  // ------------------------------------------------------------------ AUD-OTP-02
  await test("AUD-OTP-02", KO, "Antrean OTP lease/ack: gagal->retry terbatas, tidak dobel, SKIP LOCKED, kedaluwarsa tidak dikirim, pulih dari crash", async () => {
    const logs: string[] = [];
    setLogSink((l) => logs.push(l));
    const pool = rolePool("otp_dispatch_runtime");
    const fail = new FailingSender();
    const good = new TestOtpSender();
    try {
      // a) gagal pertama -> tetap di antrean; kedua berhasil; tidak dikirim ulang setelah sukses
      const p = newPhone();
      await asRole("auth_runtime", "select iam.register_start($1)", [p]);
      const s1 = await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200);
      const [o1] = await outboxOf(p);
      ok(s1.failed >= 1 && o1.status === "QUEUED" && o1.send_attempts === 1, `setelah gagal: ${JSON.stringify(o1)}`);
      // Issue #5: kiriman ulang menunggu jeda backoff (bukan putaran berikutnya). Tunggu kondisi terkirim.
      await waitFor("kirim ulang setelah jeda", async () => {
        await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
        return good.count(p) > 0 ? true : undefined;
      });
      const [o2] = await outboxOf(p);
      eq(o2.status, "SENT", "status setelah kirim kedua");
      eq(good.count(p), 1, "terkirim sekali");
      await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
      eq(good.count(p), 1, "dikirim ulang setelah sukses");
      const [v] = await regVerify(p, good.last(p)!, "Kios Retry", newDevice());
      eq(v.r_status, "OK", "kode dari kiriman kedua berlaku");
      ok(fail.seen.length >= 1, "pengirim gagal menerima kode");
      // b) dua worker serentak tidak mengambil pekerjaan yang sama
      const phones = Array.from({ length: 10 }, () => newPhone());
      for (const x of phones) await asRole("auth_runtime", "select iam.register_start($1)", [x]);
      const c1 = new Client({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "otp_dispatch_runtime", database: DBNAME });
      const c2 = new Client({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "otp_dispatch_runtime", database: DBNAME });
      await c1.connect();
      await c2.connect();
      const [w1, w2] = await Promise.all([c1.query("select * from iam.otp_dispatch_claim(10)"), c2.query("select * from iam.otp_dispatch_claim(10)")]);
      const ids1 = new Set(w1.rows.map((r) => r.r_job as string));
      const ids2 = w2.rows.map((r) => r.r_job as string);
      const overlap = ids2.filter((x) => ids1.has(x)).length;
      for (const r of [...w1.rows, ...w2.rows]) await c1.query("select iam.otp_dispatch_fail($1,$2)", [r.r_job, r.r_lease]);
      await c1.end();
      await c2.end();
      eq(overlap, 0, "pekerjaan sama diambil dua worker");
      ok(ids1.size + ids2.length >= 10, `jumlah diambil ${ids1.size + ids2.length}`);
      await waitFor("bersihkan antrean", async () => {    // pekerjaan yang digagalkan menunggu jeda backoff
        await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
        return phones.every((x) => good.count(x) > 0) ? true : undefined;
      });
      // c) OTP kedaluwarsa tidak dikirim
      const pe = newPhone();
      await asRole("auth_runtime", "select iam.register_start($1)", [pe]);
      await admin("update iam.otp_challenge set created_at=now()-interval '1 hour', expires_at=now()-interval '59 minutes' where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [pe]);
      await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
      const [oe] = await outboxOf(pe);
      eq(good.count(pe), 0, "OTP kedaluwarsa terkirim");
      eq(oe.status, "EXPIRED", "status pekerjaan kedaluwarsa");
      // d) worker mati setelah mengambil (tanpa ack/fail) -> dipulihkan setelah lease habis
      const pc = newPhone();
      await asRole("auth_runtime", "select iam.register_start($1)", [pc]);
      await asRole("otp_dispatch_runtime", "select * from iam.otp_dispatch_claim(200)");   // "crash": lease tidak pernah diselesaikan
      await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
      eq(good.count(pc), 0, "diambil worker lain saat lease masih berlaku");
      await sleep(2300);                                                                   // lease TEST_ONLY = 2 detik
      await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
      eq(good.count(pc), 1, "pemulihan setelah lease habis");
      const [vc] = await regVerify(pc, good.last(pc)!, "Kios Crash", newDevice());
      eq(vc.r_status, "OK", "kode setelah pemulihan berlaku");
      // e) batas percobaan kirim (TEST_ONLY = 3) -> FAILED, tidak diulang tanpa batas
      const pf = newPhone();
      await asRole("auth_runtime", "select iam.register_start($1)", [pf]);
      await waitFor("batas percobaan tercapai", async () => {    // tiap percobaan menunggu jeda backoff
        await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200);
        const [x] = await outboxOf(pf);
        return x.status === "FAILED" ? true : undefined;
      });
      await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200);   // setelah FAILED tidak diambil lagi
      const [of] = await outboxOf(pf);
      ok(of.status === "FAILED" && of.send_attempts === 3, `batas percobaan: ${JSON.stringify(of)}`);
      // f) log kegagalan tidak memuat kode
      const leaked = fail.seen.filter((c) => logs.some((l) => l.includes(c)));
      eq(leaked.length, 0, "kode muncul di log");
      ok(logs.some((l) => l.includes("otp_send_failed")), "kegagalan tidak tercatat");
      return `gagal->QUEUED->SENT (1 kiriman); 0 tumpang tindih 2 worker; kedaluwarsa->EXPIRED; pulih setelah lease 2 dtk; maks 3 percobaan->FAILED; ${fail.seen.length} kode gagal tidak ada di log`;
    } finally {
      setLogSink((l) => process.stdout.write(l + "\n"));
    }
  });

  // ------------------------------------------------------------------ AUD-OTP-04 (R4-02)
  await test("AUD-OTP-04", K, "Masa OTP aktivasi Admin terpisah dari masa undangan; masing-masing berakhir sesuai batasnya", async () => {
    const [prm] = await admin<{ otp: number; inv: number }>(
      "select (select value::int from iam.security_param where key='otp_ttl_seconds') otp, (select value::int from iam.security_param where key='invite_ttl_seconds') inv",
    );
    ok(prm.otp !== prm.inv, "parameter uji harus berbeda");
    // a) OTP berakhir sesuai otp_ttl, undangan sesuai invite_ttl
    const o = await registerOwnerSql();
    await makePro(o.tenant);
    const p = newPhone();
    const [inv] = await asActor<{ id: string }>(o.token, "select app.staff_invite($1,'Admin TTL') as id", [p]);
    const [t] = await admin<{ otp_s: number; inv_s: number }>(
      `select extract(epoch from c.expires_at - c.created_at)::int otp_s, extract(epoch from m.invite_expires_at - m.created_at)::int inv_s
         from iam.membership m join iam.otp_challenge c on c.membership_id = m.id where m.id = $1`, [inv.id],
    );
    eq(t.otp_s, prm.otp, "masa OTP (detik)");
    eq(t.inv_s, prm.inv, "masa undangan (detik)");
    const c1 = await claimCode(p);
    await admin("update iam.otp_challenge set created_at=now()-interval '1 hour', expires_at=now()-interval '59 minutes' where membership_id=$1 and used_at is null and voided_at is null", [inv.id]);
    const [x1] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.activate_admin($1,$2,$3,$4)", [p, mac("ACTIVATE_ADMIN", p, c1), PW, newDevice()]);
    eq(x1.r_status, "OTP_INVALID", "OTP lewat masa, undangan masih berlaku");
    const [s1] = await asRole<{ s: string }>("auth_runtime", "select iam.admin_activation_start($1) s", [p]);
    eq(s1.s, "ACCEPTED", "minta OTP baru");
    const c2 = await claimCode(p);
    const [x2] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.activate_admin($1,$2,$3,$4)", [p, mac("ACTIVATE_ADMIN", p, c2), PW, newDevice()]);
    eq(x2.r_status, "OK", "aktivasi dengan OTP baru");
    // b) undangan berakhir walaupun OTP masih berlaku; tidak ada OTP baru setelah undangan habis
    const o2 = await registerOwnerSql();
    await makePro(o2.tenant);
    const p2 = newPhone();
    const [inv2] = await asActor<{ id: string }>(o2.token, "select app.staff_invite($1,'Admin Habis') as id", [p2]);
    const c3 = await claimCode(p2);
    await admin("update iam.membership set invite_expires_at = now() - interval '1 second' where id=$1", [inv2.id]);
    const [x3] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.activate_admin($1,$2,$3,$4)", [p2, mac("ACTIVATE_ADMIN", p2, c3), PW, newDevice()]);
    const jobsBefore = (await admin<{ n: number }>("select count(*)::int n from iam.otp_outbox where phone_e164=$1", [p2]))[0].n;
    await admin("update iam.otp_challenge set created_at = created_at - interval '1 hour' where membership_id=$1", [inv2.id]);   // lewati jeda kirim ulang
    const [s2] = await asRole<{ s: string }>("auth_runtime", "select iam.admin_activation_start($1) s", [p2]);
    const jobsAfter = (await admin<{ n: number }>("select count(*)::int n from iam.otp_outbox where phone_e164=$1", [p2]))[0].n;
    const [s3] = await asRole<{ s: string }>("auth_runtime", "select iam.admin_activation_start($1) s", [newPhone()]);
    eq(x3.r_status, "INVITE_INVALID", "undangan habis, OTP masih berlaku");
    eq(s2.s, "ACCEPTED", "jawaban start undangan habis");
    eq(jobsAfter, jobsBefore, "OTP baru diterbitkan untuk undangan habis");
    eq(s3.s, "ACCEPTED", "jawaban start nomor tanpa undangan");
    return `OTP ${t.otp_s} dtk vs undangan ${t.inv_s} dtk; OTP lewat -> OTP_INVALID, OTP baru -> OK; undangan lewat -> INVITE_INVALID & tanpa OTP baru`;
  });

  // ------------------------------------------------------------------ AUD-SESSION-01
  await test("AUD-SESSION-01", K, "Login serentak HP A & HP B (barrier, 50 putaran): tepat 1 sesi aktif, perangkat lama tidak punya hak", async () => {
    let bad = 0;
    const notes: string[] = [];
    for (let round = 0; round < 50; round++) {
      const o = await registerOwnerSql(`Kios Sesi ${round}`);
      await admin("update iam.session set revoked_at=now(), revoke_reason='LOGOUT' where tenant_id=$1 and revoked_at is null", [o.tenant]);
      const ca = new Client({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "auth_runtime", database: DBNAME });
      const cb = new Client({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "auth_runtime", database: DBNAME });
      await Promise.all([ca.connect(), cb.connect()]);
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      const fire = (c: Client, dev: string) => barrier.then(() => c.query("select * from iam.login($1,$2,$3)", [o.phone, PW, dev]));
      const pa = fire(ca, `devA-${round}-xxxx`);
      const pb = fire(cb, `devB-${round}-xxxx`);
      release();
      const [ra, rb] = await Promise.all([pa, pb]);
      await Promise.all([ca.end(), cb.end()]);
      const ta = ra.rows[0].r_token as string;
      const tb = rb.rows[0].r_token as string;
      const active = await admin<{ device_id: string }>("select device_id from iam.session where tenant_id=$1 and revoked_at is null", [o.tenant]);
      const okA = (await errOf(asActor(ta, "select app.tenant_me()"))) === "OK";
      const okB = (await errOf(asActor(tb, "select app.tenant_me()"))) === "OK";
      if (active.length !== 1 || okA === okB) {
        bad++;
        notes.push(`putaran ${round}: aktif=${active.length} A=${okA} B=${okB}`);
      }
    }
    eq(bad, 0, notes.slice(0, 3).join("; "));
    return "50/50 putaran: tepat 1 sesi aktif, token perangkat lain ditolak database";
  });

  // ------------------------------------------------------------------ AUD-LOGIN-01
  await test("AUD-LOGIN-01", K, "50 login salah serentak: hanya 5 (TEST_ONLY) diperiksa kredensialnya, sisanya RATE_LIMITED, penghitung tidak hilang", async () => {
    const o = await registerOwnerSql();
    const ghost = newPhone();
    const out: string[] = [];
    await ensureWindowMargin(60);
    for (const [label, phone] of [["terdaftar", o.phone], ["tidak terdaftar", ghost]] as const) {
      const pool = new Pool({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: "auth_runtime", database: DBNAME, max: 50 });
      const clients = await Promise.all(Array.from({ length: 50 }, () => pool.connect()));
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      const runs = clients.map((c, i) => barrier.then(() => c.query("select r_status from iam.login($1,$2,$3)", [phone, `sandi-salah-${i}-xx`, newDevice()])));
      release();
      const res = (await Promise.all(runs)).map((r) => r.rows[0].r_status as string);
      clients.forEach((c) => c.release());
      await pool.end();
      const inv = res.filter((x) => x === "INVALID_CREDENTIALS").length;
      const lim = res.filter((x) => x === "RATE_LIMITED").length;
      const [ev] = await admin<{ checked: number; limited: number }>(
        `select count(*) filter (where kind='LOGIN_CHECKED')::int checked, count(*) filter (where kind='LOGIN_LIMITED')::int limited
           from iam.auth_event where detail->>'k' = $1`, [phoneKey(phone)],
      );
      const [b] = await admin<{ hits: number }>("select coalesce(sum(hits),0)::int hits from iam.rate_limit_bucket where kind='LOGIN_FAIL' and key_hash=sha256(convert_to($1,'UTF8'))", [phone]);
      const after = (await asRole<{ r_status: string }>("auth_runtime", "select r_status from iam.login($1,$2,$3)", [phone, PW, newDevice()]))[0].r_status;
      const [b2] = await admin<{ hits: number }>("select coalesce(sum(hits),0)::int hits from iam.rate_limit_bucket where kind='LOGIN_FAIL' and key_hash=sha256(convert_to($1,'UTF8'))", [phone]);
      eq(inv, 5, `${label}: INVALID_CREDENTIALS`);
      eq(lim, 45, `${label}: RATE_LIMITED`);
      eq(ev.checked, 5, `${label}: pemeriksaan kredensial`);
      eq(ev.limited, 45, `${label}: audit LOGIN_LIMITED`);
      eq(b.hits, 50, `${label}: penghitung`);
      eq(after, "RATE_LIMITED", `${label}: permintaan berikutnya (sandi benar)`);
      ok(b2.hits >= 50, `${label}: penghitung berkurang (${b2.hits})`);
      out.push(`${label}: 5 diperiksa/45 ditolak, penghitung=${b2.hits}`);
    }
    return out.join("; ");
  });

  // ------------------------------------------------------------------ AUD-LOCK-01
  await test("AUD-LOCK-01", K, "LOCKED_GRACE: undang & aktivasi Admin ditolak; logout, cabut sesi, nonaktifkan Admin diizinkan", async () => {
    const o = await registerOwnerSql();
    await makePro(o.tenant);
    const a = await inviteAndActivateAdminSql(o);
    const o2 = await registerOwnerSql();
    await makePro(o2.tenant);
    const pend = newPhone();
    await asActor(o2.token, "select app.staff_invite($1,'Tertunda')", [pend]);
    const pendCode = await claimCode(pend);
    const expire = "update platform.subscription set activated_at=now()-interval '31 days', expires_at=now()-interval '1 hour', grace_deadline=now()+interval '29 days' where tenant_id=$1";
    await admin(expire, [o.tenant]);
    await admin(expire, [o2.tenant]);
    const [st] = await asActor<{ s: string }>(o.token, "select app.tenant_me()->>'effectiveStatus' s");
    const invite = await errOf(asActor(o.token, "select app.staff_invite($1,'Baru')", [newPhone()]));
    const [act] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.activate_admin($1,$2,$3,$4)", [pend, mac("ACTIVATE_ADMIN", pend, pendCode), PW, newDevice()]);
    const [as] = await admin<{ id: string }>("select id from iam.session where membership_id=$1 and revoked_at is null limit 1", [a.membership]);
    const revoke = await errOf(asActor(o.token, "select app.session_revoke($1)", [as.id]));
    const a2 = (await asRole<{ r_token: string }>("auth_runtime", "select * from iam.login($1,$2,$3)", [a.phone, PW, a.device]))[0].r_token;
    const deact = await errOf(asActor(o.token, "select app.staff_deactivate($1)", [a.membership]));
    const adminAfter = await errOf(asActor(a2, "select app.tenant_me()"));
    const logout = await errOf(asActor(o.token, "select app.logout()"));
    const free = await registerOwnerSql();
    await admin("update platform.subscription set activated_at=now()-interval '169 hours', expires_at=now()-interval '1 hour', grace_deadline=now()+interval '6 days' where tenant_id=$1", [free.tenant]);
    const freeInvite = await errOf(asActor(free.token, "select app.staff_invite($1,'X')", [newPhone()]));
    eq(st.s, "LOCKED_GRACE", "status");
    eq(invite, "TENANT_LOCKED", "undang Admin (PRO lewat)");
    eq(freeInvite, "TENANT_LOCKED", "undang Admin (FREE lewat)");
    eq(act.r_status, "INVITE_INVALID", "aktivasi undangan tertunda");
    eq(revoke, "OK", "cabut sesi");
    eq(deact, "OK", "nonaktifkan Admin");
    eq(adminAfter, "UNAUTHENTICATED", "sesi Admin setelah dinonaktifkan");
    eq(logout, "OK", "logout");
    return "undang PRO/FREE -> TENANT_LOCKED; aktivasi tertunda -> INVITE_INVALID; cabut sesi/nonaktifkan/logout -> OK. Penjualan: modul belum ada di PR ini (tidak dapat diuji)";
  });
  // ------------------------------------------------------------------ Issue #5: retry OTP bertahap
  const job = async (phone: string) => (await admin<{ id: string; status: string; send_attempts: number; next_attempt_at: string | null; last_failed_at: string | null; gap: number | null }>(
    `select id::text, status, send_attempts, next_attempt_at::text, last_failed_at::text,
            extract(epoch from (next_attempt_at - last_failed_at))::float8 gap
       from iam.otp_outbox where phone_e164=$1 order by created_at desc limit 1`, [phone]))[0];

  await test("OTP-RETRY-01", KO, "Retry OTP: jeda setelah gagal, jeda naik bertahap (dibatasi maks), batas percobaan -> FAILED, diaudit tanpa nomor/kode", async () => {
    const pool = rolePool("otp_dispatch_runtime");
    const fail = new FailingSender();
    const good = new TestOtpSender();
    const p = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p]);
    // Gagal #1 -> QUEUED, jeda = dasar (1 dtk TEST_ONLY); tidak diambil sebelum jatuh tempo.
    await waitFor("percobaan #1", async () => { await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200); const j = await job(p); return j.send_attempts === 1 ? j : undefined; });
    const j1 = await job(p);
    ok(j1.status === "QUEUED" && Math.abs((j1.gap ?? 0) - 1) < 0.01, `jeda #1: ${JSON.stringify(j1)}`);
    await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
    const early = await job(p);
    ok(early.send_attempts === 1 && good.count(p) === 0, `diambil sebelum jatuh tempo: ${JSON.stringify(early)}`);
    // Gagal #2 -> jeda 2 dtk (dasar × 2, = batas maks TEST_ONLY 2).
    await waitFor("percobaan #2", async () => { await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200); const j = await job(p); return j.send_attempts === 2 ? j : undefined; });
    const j2 = await job(p);
    ok(j2.status === "QUEUED" && Math.abs((j2.gap ?? 0) - 2) < 0.01, `jeda #2: ${JSON.stringify(j2)}`);
    // Gagal #3 = batas percobaan (3 TEST_ONLY) -> FAILED, tidak diambil lagi.
    await waitFor("percobaan #3", async () => { await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200); const j = await job(p); return j.send_attempts === 3 ? j : undefined; });
    const j3 = await job(p);
    ok(j3.status === "FAILED" && j3.next_attempt_at === null, `setelah #3: ${JSON.stringify(j3)}`);
    await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
    eq(good.count(p), 0, "dikirim setelah FAILED");
    const ev = await admin<{ kind: string; d: string }>("select kind, detail::text d from iam.auth_event where detail->>'job' = $1 order by at", [j3.id]);
    ok(ev.map((e) => e.kind).join(",") === "OTP_DISPATCH_FAILED,OTP_DISPATCH_FAILED,OTP_DISPATCH_GAVE_UP", `audit: ${ev.map((e) => e.kind).join(",")}`);
    const leak = ev.filter((e) => e.d.includes(p) || fail.seen.some((c) => e.d.includes(c)));
    eq(leak.length, 0, "nomor/kode di audit");
    // Challenge kedaluwarsa tidak dikirim walau pekerjaan sudah jatuh tempo.
    const pe = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [pe]);
    await waitFor("gagal sekali", async () => { await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200); const j = await job(pe); return j.send_attempts === 1 ? j : undefined; });
    await admin("update iam.otp_challenge set created_at=now()-interval '1 hour', expires_at=now()-interval '59 minutes' where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [pe]);
    await sleep(1100);
    await dispatchOtps(pool, good, TEST_OTP_MAC_KEY, 200);
    const je = await job(pe);
    ok(je.status === "EXPIRED" && good.count(pe) === 0, `kedaluwarsa: ${JSON.stringify(je)}`);
    return "gagal#1 jeda 1 dtk (tidak diambil lebih awal) -> gagal#2 jeda 2 dtk -> gagal#3 FAILED; audit FAILED,FAILED,GAVE_UP tanpa nomor/kode; kedaluwarsa -> EXPIRED";
  });

  await test("OTP-RETRY-02", KO, "Worker mati pada percobaan terakhir: pekerjaan tidak macet di LEASED, ditandai FAILED & diaudit; lease lama tidak bisa ack/set kode", async () => {
    const pool = rolePool("otp_dispatch_runtime");
    const fail = new FailingSender();
    const p = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p]);
    for (const n of [1, 2]) {
      await waitFor(`percobaan #${n}`, async () => { await dispatchOtps(pool, fail, TEST_OTP_MAC_KEY, 200); const j = await job(p); return j.send_attempts === n ? j : undefined; });
    }
    // Percobaan #3 diambil lalu worker "mati" (tanpa ack/fail).
    const lease = await waitFor("klaim #3", async () => {
      const r = await asRole<{ r_job: string; r_lease: Buffer; r_phone: string }>("otp_dispatch_runtime", "select * from iam.otp_dispatch_claim(200)");
      return r.find((x) => x.r_phone === p);
    });
    await sleep(2300);   // lease TEST_ONLY 2 dtk
    await asRole("otp_dispatch_runtime", "select * from iam.otp_dispatch_claim(200)");
    const j = await job(p);
    const ackOld = (await asRole<{ ok: boolean }>("otp_dispatch_runtime", "select iam.otp_dispatch_ack($1,$2) ok", [lease.r_job, lease.r_lease]))[0].ok;
    const setOld = (await asRole<{ ok: boolean }>("otp_dispatch_runtime", "select iam.otp_dispatch_set_code($1,$2,$3) ok", [lease.r_job, lease.r_lease, Buffer.alloc(32, 7)]))[0].ok;
    ok(j.status === "FAILED" && j.send_attempts === 3 && !ackOld && !setOld, `${JSON.stringify(j)} ack=${ackOld} set=${setOld}`);
    const [g] = await admin<{ n: number }>("select count(*)::int n from iam.auth_event where kind='OTP_DISPATCH_GAVE_UP' and detail->>'job'=$1", [j.id]);
    eq(g.n, 1, "audit GAVE_UP");
    return "LEASED kedaluwarsa pada percobaan terakhir -> FAILED + audit; ack & set kode dengan lease lama ditolak";
  });

  // ------------------------------------------------------------------ Issue #5: keamanan login
  const loginSql = async (phone: string, pw: string) =>
    (await asRole<{ r_status: string }>("auth_runtime", "select r_status from iam.login($1,$2,$3)", [phone, pw, newDevice()]))[0].r_status;
  const rollWindow = (phone: string) =>   // simulasi pergantian jendela: penghitung jendela sekarang digeser ke jendela lalu
    admin(`update iam.rate_limit_bucket set window_start = window_start - make_interval(secs => (select value from iam.security_param where key='login_window_seconds'))
            where kind='LOGIN_FAIL' and key_hash=sha256(convert_to($1,'UTF8'))`, [phone]);

  await test("LOGIN-WINDOW-01", K, "Pergantian jendela batas laju: penghitung jendela lama tidak terbawa; batas berlaku lagi di jendela baru", async () => {
    await ensureWindowMargin(30);
    const o = await registerOwnerSql();
    const r1: string[] = [];
    for (let i = 0; i < 6; i++) r1.push(await loginSql(o.phone, "salah-" + i));
    ok(r1.slice(0, 5).every((x) => x === "INVALID_CREDENTIALS") && r1[5] === "RATE_LIMITED", r1.join(","));
    await rollWindow(o.phone);
    const okNow = await loginSql(o.phone, PW);
    const r2: string[] = [];
    for (let i = 0; i < 6; i++) r2.push(await loginSql(o.phone, "salah2-" + i));
    ok(okNow === "OK" && r2.slice(0, 5).every((x) => x === "INVALID_CREDENTIALS") && r2[5] === "RATE_LIMITED", `${okNow} | ${r2.join(",")}`);
    return "jendela 1: 5 salah lalu dibatasi; jendela baru: sandi benar OK, 5 salah lalu dibatasi lagi";
  });

  await test("LOGIN-VICTIM-01", K, "Risiko penguncian nomor korban: terbukti TERBATAS satu jendela & per nomor (mitigasi lebih lanjut = keputusan kebijakan)", async () => {
    await ensureWindowMargin(30);
    const victim = await registerOwnerSql();
    const other = await registerOwnerSql();
    for (let i = 0; i < 5; i++) await loginSql(victim.phone, "penyerang-" + i);
    const blocked = await loginSql(victim.phone, PW);
    const otherOk = await loginSql(other.phone, PW);
    await rollWindow(victim.phone);
    const after = await loginSql(victim.phone, PW);
    ok(blocked === "RATE_LIMITED" && otherOk === "OK" && after === "OK", `${blocked} ${otherOk} ${after}`);
    return "5 salah oleh pihak lain -> korban RATE_LIMITED (risiko nyata, dicatat terbuka); nomor lain tidak terdampak; jendela baru -> korban OK";
  });

  await test("LOGIN-ENUM-01", K, "Respons login nomor terdaftar (sandi salah) dan tidak terdaftar identik; waktu respons diukur (bcrypt dijalankan di kedua jalur)", async () => {
    await ensureWindowMargin(30);
    const o = await registerOwnerSql();
    const ghosts = Array.from({ length: 4 }, () => newPhone());
    const reg: number[] = [];
    const unreg: number[] = [];
    const sts = new Set<string>();
    for (let i = 0; i < 8; i++) {
      // tiap nomor maks 4 percobaan agar tidak menyentuh batas laju (5)
      const ph = i < 4 ? o.phone : (await registerOwnerSql()).phone;
      let t = process.hrtime.bigint();
      sts.add(await loginSql(ph, "salah-a-" + i));
      reg.push(Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint();
      sts.add(await loginSql(ghosts[i % 4], "salah-b-" + i));
      unreg.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const mr = med(reg);
    const mu = med(unreg);
    eq([...sts].join(","), "INVALID_CREDENTIALS", "status berbeda");
    ok(mu / mr > 0.5 && mu / mr < 2, `median terdaftar ${mr.toFixed(1)} ms vs tidak terdaftar ${mu.toFixed(1)} ms`);
    return `status identik INVALID_CREDENTIALS; median waktu terdaftar ${mr.toFixed(1)} ms vs tidak terdaftar ${mu.toFixed(1)} ms (rasio ${(mu / mr).toFixed(2)}; pengukuran lab, bukan bukti tahan serangan waktu)`;
  });

}
