import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import {
  ADMIN_HOST, ADMIN_PORT, ADMIN_USER, DBNAME, PW, RUNTIME_HOST, RUNTIME_PORT,
  admin, asActor, asRole, claimCode, eq, errOf, inviteAndActivateAdminSql, makePro, newDevice, newPhone, ok,
  registerOwnerSql, rolePool, test,
} from "./harness";

const K = "integrasi DB";
const RUNTIME = ["auth_runtime", "app_runtime", "otp_dispatch_runtime"];
const FN_OWNERS = ["auth_fn_owner", "app_fn_owner", "migration_owner"];
const TABLES = [
  "platform.tenant", "platform.location", "platform.subscription", "platform.entitlement_event",
  "iam.user_account", "iam.membership", "iam.otp_challenge", "iam.otp_outbox", "iam.session",
  "iam.auth_event", "iam.rate_limit_bucket", "iam.security_param",
];

// Daftar EXECUTE yang diizinkan per role runtime. Fungsi lain (termasuk iam.issue_session) harus tertutup.
const ALLOW: Record<string, string[]> = {
  auth_runtime: [
    "iam.activate_admin", "iam.ip_rate_hit", "iam.login", "iam.register_start", "iam.register_verify",
    "iam.security_params_status",
  ],
  app_runtime: [
    "app.logout", "app.session_list", "app.session_revoke", "app.staff_deactivate", "app.staff_invite",
    "app.staff_list", "app.tenant_me",
  ],
  otp_dispatch_runtime: ["iam.otp_dispatch_claim"],
};

export async function dbTests(): Promise<void> {
  await test("T-DB-01", K, "Role runtime/pemilik tidak BYPASSRLS, bukan superuser, bukan pemilik tabel", async () => {
    const roles = await admin<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      "select rolname, rolbypassrls, rolsuper from pg_roles where rolname = any($1)", [[...RUNTIME, ...FN_OWNERS]],
    );
    eq(roles.length, 6, "jumlah role");
    for (const r of roles) ok(!r.rolbypassrls && !r.rolsuper, `${r.rolname} punya BYPASSRLS/superuser`);
    const owned = await admin<{ n: string }>(
      "select count(*)::text n from pg_class c join pg_roles r on r.oid=c.relowner where r.rolname = any($1)", [RUNTIME],
    );
    eq(owned[0].n, "0", "objek milik role runtime");
    return "6 role: BYPASSRLS=false, superuser=false; role runtime tidak memiliki objek";
  });

  await test("T-DB-02", K, "FORCE RLS aktif di semua tabel platform/iam (termasuk semua tabel ber-tenant_id)", async () => {
    const rows = await admin<{ t: string; rls: boolean; force: boolean; has_tenant: boolean }>(
      `select n.nspname||'.'||c.relname t, c.relrowsecurity rls, c.relforcerowsecurity force,
              exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped) has_tenant
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('platform','iam') and c.relkind in ('r','p')`,
    );
    const bad = rows.filter((r) => !r.rls || !r.force).map((r) => r.t);
    eq(bad.length, 0, `tabel tanpa FORCE RLS: ${bad.join(",")}`);
    eq(rows.length, TABLES.length, "jumlah tabel");
    return `${rows.length} tabel FORCE RLS (${rows.filter((r) => r.has_tenant).length} ber-tenant_id)`;
  });

  await test("T-DB-03", K, "Role runtime tidak bisa SELECT/INSERT/UPDATE/DELETE langsung ke tabel mana pun", async () => {
    let n = 0;
    for (const role of RUNTIME) {
      for (const t of TABLES) {
        for (const sql of [`select 1 from ${t} limit 1`, `insert into ${t} default values`, `update ${t} set ${t.endsWith("security_param") ? "value" : "tenant_id"} = null where false`, `delete from ${t} where false`]) {
          const e = await errOf(asRole(role, sql));
          // 42501 = permission denied; 42703 = kolom tidak ada (UPDATE pada tabel tanpa tenant_id) juga ditolak sebelum menyentuh data,
          // maka untuk UPDATE dicek privilege secara eksplisit di bawah.
          ok(e.startsWith("42501") || (sql.startsWith("update") && e.startsWith("42703")), `${role}: '${sql}' -> ${e}`);
          n++;
        }
        const [p] = await admin<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
          "select has_table_privilege($1,$2,'SELECT') s, has_table_privilege($1,$2,'INSERT') i, has_table_privilege($1,$2,'UPDATE') u, has_table_privilege($1,$2,'DELETE') d",
          [role, t],
        );
        ok(!p.s && !p.i && !p.u && !p.d, `${role} punya hak tabel di ${t}`);
      }
    }
    return `${n} percobaan DML/SELECT langsung ditolak; has_table_privilege=false untuk 3 role x ${TABLES.length} tabel`;
  });

  await test("T-DB-04", K, "Fungsi SECURITY DEFINER: search_path terkunci, tanpa EXECUTE PUBLIC, allowlist runtime persis", async () => {
    const fns = await admin<{ f: string; secdef: boolean; cfg: string[] | null; pub: boolean }>(
      `select n.nspname||'.'||p.proname f, p.prosecdef secdef, p.proconfig cfg, has_function_privilege('public', p.oid, 'EXECUTE') pub
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('iam','app')`,
    );
    for (const f of fns) {
      ok(!f.pub, `${f.f} dapat dieksekusi PUBLIC`);
      ok((f.cfg ?? []).includes("search_path=pg_catalog, pg_temp"), `${f.f} tanpa search_path terkunci`);
    }
    for (const role of RUNTIME) {
      const got = (await admin<{ f: string }>(
        `select distinct n.nspname||'.'||p.proname f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname in ('iam','app','ext','platform') and has_function_privilege($1, p.oid, 'EXECUTE')
          order by 1`, [role],
      )).map((r) => r.f);
      eq(JSON.stringify(got), JSON.stringify(ALLOW[role]), `allowlist EXECUTE ${role}`);
    }
    return `${fns.length} fungsi iam/app terkunci; allowlist 3 role runtime cocok persis`;
  });

  await test("T-DB-05", K, "FK komposit menolak referensi lintas toko (termasuk oleh superuser)", async () => {
    const a = await registerOwnerSql("Kios A");
    const b = await registerOwnerSql("Kios B");
    const [mb] = await admin<{ id: string }>("select id from iam.membership where tenant_id=$1", [b.tenant]);
    const [ua] = await admin<{ id: string }>("select m.user_id id from iam.membership m where m.tenant_id=$1", [a.tenant]);
    const [sb] = await admin<{ id: string }>("select id from platform.subscription where tenant_id=$1", [b.tenant]);
    const r = {
      session: await errOf(admin("insert into iam.session(tenant_id,token_hash,user_id,membership_id,device_id,auth_at,expires_at) values ($1, sha256('x'::bytea||gen_random_uuid()::text::bytea), $2, $3, 'dev-xxxxxxxx', now(), now()+interval '1 hour')", [a.tenant, ua.id, mb.id])),
      challenge: await errOf(admin("insert into iam.otp_challenge(purpose,phone_hash,tenant_id,membership_id,code_hash,expires_at,max_attempts) values ('ACTIVATE_ADMIN','\\x00',$1,$2,'x',now()+interval '1 minute',1)", [a.tenant, mb.id])),
      entitlement: await errOf(admin("insert into platform.entitlement_event(tenant_id,subscription_id,kind,effective_at) values ($1,$2,'FREE_STARTED',now())", [a.tenant, sb.id])),
    };
    for (const [k, v] of Object.entries(r)) ok(v.startsWith("23503"), `${k}: ${v}`);
    return Object.entries(r).map(([k, v]) => `${k}=${v.slice(0, 5)}`).join(", ");
  });

  await test("T-DB-06", K, "auth_event & entitlement_event append-only (UPDATE/DELETE/TRUNCATE ditolak, termasuk superuser)", async () => {
    const r = [
      await errOf(admin("update iam.auth_event set kind='X'")),
      await errOf(admin("delete from iam.auth_event")),
      await errOf(admin("truncate iam.auth_event")),
      await errOf(admin("update platform.entitlement_event set kind='FREE_STARTED'")),
      await errOf(admin("delete from platform.entitlement_event")),
      await errOf(admin("truncate platform.entitlement_event cascade")),
    ];
    ok(r.every((x) => x === "APPEND_ONLY"), r.join(" | "));
    return "6/6 ditolak APPEND_ONLY";
  });

  await test("T-DB-07", "uji meta", "Migrasi dengan file rusak membuat migrate.sh gagal (exit != 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    cpSync(resolve(__dirname, "../../../db/migrations"), dir, { recursive: true });
    writeFileSync(join(dir, "0099_broken.sql"), "create table platform.tenant (id int);\n");
    const db = "meta_" + Date.now();
    await admin(`create database ${db}`);
    const run = spawnSync("bash", [resolve(__dirname, "../../../db/migrate.sh")], {
      env: { ...process.env, PGHOST: ADMIN_HOST, PGPORT: String(ADMIN_PORT), PGUSER: ADMIN_USER, PGDATABASE: db, MIGRATIONS_DIR: dir },
      encoding: "utf8",
    });
    const c = new Client({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, database: db });
    await c.connect();
    const applied = (await c.query("select count(*)::int n from meta.schema_migration")).rows[0].n as number;
    await c.end();
    await admin(`drop database ${db}`);
    ok(run.status !== 0, `exit=${run.status}`);
    ok(!/Migrasi selesai/.test(run.stdout), "migrate.sh mencetak selesai");
    eq(applied, 5, "migrasi tercatat sebelum file rusak");
    return `exit=${run.status}; 5 migrasi sah tercatat, 0099 ditolak`;
  });

  // ---------------------------------------------------------------- TEMUAN-01
  await test("SEC-FIX-01", K, "Fungsi penerbit sesi tidak bisa dipanggil tanpa autentikasi", async () => {
    const o = await registerOwnerSql();
    const [u] = await admin<{ user_id: string; id: string }>("select user_id, id from iam.membership where tenant_id=$1", [o.tenant]);
    const before = (await admin<{ n: number }>("select count(*)::int n from iam.session"))[0].n;
    const r: Record<string, string> = {};
    for (const role of RUNTIME) {
      r[`${role}.issue_session`] = await errOf(asRole(role, "select * from iam.issue_session($1,$2,$3,'dev-attack1')", [o.tenant, u.user_id, u.id]));
      r[`${role}.create_challenge`] = await errOf(asRole(role, "select iam.create_challenge('REGISTER_OWNER','+6281111111111',null,null,60)"));
      r[`${role}.current_actor`] = await errOf(asRole(role, "select * from iam.current_actor()"));
    }
    for (const [k, v] of Object.entries(r)) ok(v.startsWith("42501"), `${k}: ${v}`);
    const [l] = await asRole<{ r_status: string; r_token: string | null }>("auth_runtime", "select * from iam.login($1,'sandi-salah-xx',$2)", [o.phone, newDevice()]);
    eq(l.r_status, "INVALID_CREDENTIALS", "login tanpa sandi benar");
    ok(l.r_token === null, "token terbit tanpa sandi");
    const [v] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.register_verify($1,'123456',$2,'Palsu','Asia/Makassar',$3)", [newPhone(), PW, newDevice()]);
    eq(v.r_status, "OTP_INVALID", "registrasi tanpa challenge OTP");
    const after = (await admin<{ n: number }>("select count(*)::int n from iam.session"))[0].n;
    eq(after, before, "jumlah sesi berubah tanpa autentikasi sah");
    return `9 panggilan fungsi internal ditolak 42501; login sandi salah & registrasi tanpa OTP tidak menerbitkan sesi`;
  });

  await test("SEC-FIX-02", K, "Bukti palsu, kedaluwarsa, dan replay ditolak (OTP & token sesi)", async () => {
    // OTP palsu
    const p1 = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p1]);
    const code = await claimCode(p1);
    const fake = code === "000000" ? "111111" : "000000";
    const [f] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K','Asia/Makassar',$4)", [p1, fake, PW, newDevice()]);
    // OTP kedaluwarsa (benar tapi lewat waktu)
    await admin("update iam.otp_challenge set created_at = now() - interval '1 hour', expires_at = now() - interval '59 minutes' where phone_hash = sha256(convert_to($1,'UTF8')) and voided_at is null", [p1]);
    const [x] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K','Asia/Makassar',$4)", [p1, code, PW, newDevice()]);
    // Replay OTP yang sudah terpakai
    const p2 = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p2]);
    const c2 = await claimCode(p2);
    const [ok1] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K','Asia/Makassar',$4)", [p2, c2, PW, newDevice()]);
    const [rep] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K2','Asia/Makassar',$4)", [p2, c2, PW, newDevice()]);
    // Token karangan, token dicabut, token kedaluwarsa
    const o = await registerOwnerSql();
    const forged = await errOf(asActor("a".repeat(64), "select app.tenant_me()"));
    await asActor(o.token, "select app.logout()");
    const revoked = await errOf(asActor(o.token, "select app.tenant_me()"));
    const o2 = await registerOwnerSql();
    await admin("update iam.session set auth_at = now() - interval '2 hours', created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where tenant_id = $1", [o2.tenant]);
    const expired = await errOf(asActor(o2.token, "select app.tenant_me()"));
    eq(f.r_status, "OTP_INVALID", "OTP palsu");
    eq(x.r_status, "OTP_INVALID", "OTP kedaluwarsa");
    eq(ok1.r_status, "OK", "OTP sah pertama");
    eq(rep.r_status, "OTP_INVALID", "replay OTP");
    eq(forged, "UNAUTHENTICATED", "token karangan");
    eq(revoked, "UNAUTHENTICATED", "token dicabut");
    eq(expired, "UNAUTHENTICATED", "token kedaluwarsa");
    const n = (await admin<{ n: number }>("select count(*)::int n from iam.user_account where phone_e164=$1", [p1]))[0].n;
    eq(n, 0, "akun terbentuk dari OTP palsu/kedaluwarsa");
    return "OTP palsu/kedaluwarsa/replay ditolak; token karangan/dicabut/kedaluwarsa -> UNAUTHENTICATED";
  });

  // ---------------------------------------------------------------- TEMUAN-02
  await test("SEC-FIX-03", K, "Percobaan OTP salah tersimpan permanen setelah ditolak", async () => {
    const p = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p]);
    const code = await claimCode(p);
    const wrong = code === "000000" ? "111111" : "000000";
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await asRole("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K','Asia/Makassar',$4)", [p, wrong, PW, newDevice()]);
      counts.push((await admin<{ n: number }>("select attempt_count n from iam.otp_challenge where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [p]))[0].n);
    }
    eq(counts.join(","), "1,2,3", "hitungan percobaan");
    const failEv = (await admin<{ n: number }>("select count(*)::int n from iam.auth_event where kind='OTP_FAILED' and at > now() - interval '1 minute'"))[0].n;
    ok(failEv >= 3, "audit OTP_FAILED");
    return "attempt_count 1 -> 2 -> 3 setelah tiap penolakan (ter-commit)";
  });

  await test("SEC-FIX-04", K, "Percobaan OTP salah serentak tidak kehilangan hitungan; batas percobaan berlaku", async () => {
    const p = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p]);
    const code = await claimCode(p);
    const wrong = code === "000000" ? "111111" : "000000";
    await admin("update iam.otp_challenge set max_attempts = 100 where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [p]);
    await Promise.all(Array.from({ length: 20 }, () =>
      asRole("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K','Asia/Makassar',$4)", [p, wrong, PW, newDevice()])));
    const n = (await admin<{ n: number }>("select attempt_count n from iam.otp_challenge where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [p]))[0].n;
    eq(n, 20, "20 percobaan serentak");
    // batas percobaan (TEST_ONLY max 5): lewati batas lalu kode BENAR tetap ditolak
    const p2 = newPhone();
    await asRole("auth_runtime", "select iam.register_start($1)", [p2]);
    const c2 = await claimCode(p2);
    const w2 = c2 === "000000" ? "111111" : "000000";
    const st: string[] = [];
    for (let i = 0; i < 6; i++) {
      st.push((await asRole<{ r_status: string }>("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K','Asia/Makassar',$4)", [p2, w2, PW, newDevice()]))[0].r_status);
    }
    const [last] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.register_verify($1,$2,$3,'K','Asia/Makassar',$4)", [p2, c2, PW, newDevice()]);
    eq(st.join(","), "OTP_INVALID,OTP_INVALID,OTP_INVALID,OTP_INVALID,OTP_LOCKED,OTP_LOCKED", "status percobaan");
    eq(last.r_status, "OTP_LOCKED", "kode benar setelah terkunci");
    return "20 percobaan serentak -> attempt_count=20; setelah 5 salah, kode benar tetap OTP_LOCKED";
  });

  // ---------------------------------------------------------------- TEMUAN-03
  await test("SEC-FIX-05", K, "Bootstrap toko hanya setelah OTP sah, atomik, gagal di tengah tidak meninggalkan sisa", async () => {
    const p = newPhone();
    const tenantsBefore = (await admin<{ n: number }>("select count(*)::int n from platform.tenant"))[0].n;
    await asRole("auth_runtime", "select iam.register_start($1)", [p]);
    const code = await claimCode(p);
    eq((await admin<{ n: number }>("select count(*)::int n from platform.tenant"))[0].n, tenantsBefore, "toko terbentuk sebelum OTP");
    // kegagalan di tengah: trigger uji menggagalkan insert lokasi untuk nama toko tertentu
    await admin(`create or replace function public.t_fail_inject() returns trigger language plpgsql as $$
      begin if (select business_name from platform.tenant where id = new.tenant_id) = 'FAIL_INJECT' then raise exception 'INJECTED'; end if; return new; end $$`);
    await admin("create trigger t_fail_inject before insert on platform.location for each row execute function public.t_fail_inject()");
    const mid = await errOf(asRole("auth_runtime", "select * from iam.register_verify($1,$2,$3,'FAIL_INJECT','Asia/Makassar',$4)", [p, code, PW, newDevice()]));
    await admin("drop trigger t_fail_inject on platform.location");
    await admin("drop function public.t_fail_inject()");
    const leftovers = (await admin<{ n: number }>(
      "select ((select count(*) from platform.tenant where business_name='FAIL_INJECT') + (select count(*) from iam.user_account where phone_e164=$1))::int n", [p],
    ))[0].n;
    const [ch] = await admin<{ used: boolean; att: number }>("select used_at is not null used, attempt_count att from iam.otp_challenge where phone_hash=sha256(convert_to($1,'UTF8')) and voided_at is null", [p]);
    // percobaan ulang dengan kode yang sama sekarang berhasil
    const [r] = await asRole<{ r_status: string; r_tenant: string }>("auth_runtime", "select * from iam.register_verify($1,$2,$3,'Kios Bootstrap','Asia/Makassar',$4)", [p, code, PW, newDevice()]);
    const [chk] = await admin<{ loc: number; own: number; sub: string; hours: number; ev: number; ses: number }>(
      `select (select count(*)::int from platform.location where tenant_id=$1 and active) loc,
              (select count(*)::int from iam.membership where tenant_id=$1 and role='OWNER' and state='ACTIVE') own,
              (select plan from platform.subscription where tenant_id=$1) sub,
              (select extract(epoch from expires_at-activated_at)::int/3600 from platform.subscription where tenant_id=$1) hours,
              (select count(*)::int from platform.entitlement_event where tenant_id=$1 and kind='FREE_STARTED') ev,
              (select count(*)::int from iam.session where tenant_id=$1 and revoked_at is null) ses`, [r.r_tenant],
    );
    ok(mid.includes("INJECTED"), `kegagalan tengah: ${mid}`);
    eq(leftovers, 0, "sisa data setelah kegagalan tengah");
    ok(!ch.used && ch.att === 0, "challenge ikut ter-rollback (belum terpakai, hitungan 0)");
    eq(r.r_status, "OK", "registrasi ulang");
    ok(chk.loc === 1 && chk.own === 1 && chk.sub === "FREE" && chk.hours === 168 && chk.ev === 1 && chk.ses === 1, JSON.stringify(chk));
    return "tanpa OTP: 0 toko; gagal tengah: 0 sisa & OTP belum terpakai; OTP sah: lokasi+OWNER+FREE 168 jam+event+sesi";
  });

  await test("SEC-FIX-06", K, "Bootstrap tidak membuka bypass: pemilik fungsi NOLOGIN, runtime tanpa hak tabel/BYPASSRLS", async () => {
    const r: string[] = [];
    for (const role of FN_OWNERS) {
      const c = new Client({ host: RUNTIME_HOST, port: RUNTIME_PORT, user: role, database: DBNAME });
      const e = await c.connect().then(() => "TERHUBUNG", (x: Error) => x.message);
      await c.end().catch(() => undefined);
      ok(e !== "TERHUBUNG", `${role} bisa login`);
      r.push(`${role}:ditolak`);
    }
    const [x] = await admin<{ n: number }>("select count(*)::int n from pg_roles where rolname = any($1) and (rolbypassrls or rolsuper or rolcreaterole)", [[...RUNTIME, ...FN_OWNERS]]);
    eq(x.n, 0, "role dengan bypass/superuser/createrole");
    const e1 = await errOf(asRole("app_runtime", "select * from iam.register_verify('+6281111111111','123456','x','y','Asia/Makassar','dev-xxxxxxxx')"));
    const e2 = await errOf(asRole("auth_runtime", "insert into platform.tenant(business_name,timezone) values ('x','Asia/Makassar')"));
    ok(e1.startsWith("42501") && e2.startsWith("42501"), `${e1} | ${e2}`);
    return `${r.join(", ")}; app_runtime tidak bisa memanggil bootstrap; auth_runtime tidak bisa INSERT toko langsung`;
  });

  // ---------------------------------------------------------------- O-1, O-3, kuota
  await test("SEC-FIX-07", K, "Pergantian perangkat mencabut sesi perangkat lama (fungsi DB)", async () => {
    const o = await registerOwnerSql();
    const devB = newDevice();
    const [b] = await asRole<{ r_status: string; r_token: string }>("auth_runtime", "select * from iam.login($1,$2,$3)", [o.phone, PW, devB]);
    eq(b.r_status, "OK", "login perangkat B");
    const oldA = await errOf(asActor(o.token, "select app.tenant_me()"));
    const newB = await errOf(asActor(b.r_token, "select app.tenant_me()"));
    const [rs] = await admin<{ reason: string }>("select revoke_reason reason from iam.session where tenant_id=$1 and device_id=$2", [o.tenant, o.device]);
    eq(oldA, "UNAUTHENTICATED", "token perangkat A");
    eq(newB, "OK", "token perangkat B");
    eq(rs.reason, "DEVICE_CHANGE", "alasan pencabutan");
    // batas sesi aktif (TEST_ONLY = 3) di perangkat yang sama
    const toks: string[] = [];
    for (let i = 0; i < 4; i++) toks.push((await asRole<{ r_token: string }>("auth_runtime", "select * from iam.login($1,$2,$3)", [o.phone, PW, devB]))[0].r_token);
    const active = (await admin<{ n: number }>("select count(*)::int n from iam.session where tenant_id=$1 and revoked_at is null", [o.tenant]))[0].n;
    eq(active, 3, "sesi aktif setelah batas");
    eq(await errOf(asActor(b.r_token, "select app.tenant_me()")), "UNAUTHENTICATED", "sesi tertua dicabut");
    return "token A -> UNAUTHENTICATED (DEVICE_CHANGE); token B sah; batas 3 sesi aktif (TEST_ONLY) ditegakkan";
  });

  await test("SEC-FIX-08", K, "Admin dinonaktifkan: semua sesi dicabut, tidak bisa login, histori tetap", async () => {
    const o = await registerOwnerSql();
    await makePro(o.tenant);
    const a = await inviteAndActivateAdminSql(o);
    const extra = (await asRole<{ r_token: string }>("auth_runtime", "select * from iam.login($1,$2,$3)", [a.phone, PW, a.device]))[0].r_token;
    await asActor(o.token, "select app.staff_deactivate($1)", [a.membership]);
    const t1 = await errOf(asActor(a.token, "select app.tenant_me()"));
    const t2 = await errOf(asActor(extra, "select app.tenant_me()"));
    const [l] = await asRole<{ r_status: string }>("auth_runtime", "select * from iam.login($1,$2,$3)", [a.phone, PW, newDevice()]);
    const [h] = await admin<{ state: string; uid: boolean; ev: number; act: number }>(
      `select m.state, m.user_id is not null uid,
              (select count(*)::int from iam.auth_event e where e.tenant_id=m.tenant_id and e.kind in ('ADMIN_ACTIVATED','ADMIN_DEACTIVATED')) ev,
              (select count(*)::int from iam.session s where s.membership_id=m.id and s.revoked_at is null) act
         from iam.membership m where m.id=$1`, [a.membership],
    );
    eq(t1, "UNAUTHENTICATED", "token admin 1");
    eq(t2, "UNAUTHENTICATED", "token admin 2");
    eq(l.r_status, "INVALID_CREDENTIALS", "login admin nonaktif");
    ok(h.state === "DEACTIVATED" && h.uid && h.ev === 2 && h.act === 0, JSON.stringify(h));
    // Owner bisa mengundang pengganti
    const rep = await errOf(asActor(o.token, "select app.staff_invite($1,'Pengganti')", [newPhone()]));
    eq(rep, "OK", "undang pengganti");
    return "2 sesi admin dicabut; login ditolak; membership & audit tetap; pengganti bisa diundang";
  });

  await test("SEC-FIX-09", K, "Dua+ undangan Admin serentak tidak melampaui kuota PRO", async () => {
    const o = await registerOwnerSql();
    await makePro(o.tenant);
    const res = await Promise.all(Array.from({ length: 10 }, () => errOf(asActor(o.token, "select app.staff_invite($1,'Serentak')", [newPhone()]))));
    const okN = res.filter((x) => x === "OK").length;
    const lim = res.filter((x) => x === "ADMIN_LIMIT_REACHED").length;
    const n = (await admin<{ n: number }>("select count(*)::int n from iam.membership where tenant_id=$1 and role='ADMIN' and state in ('PENDING','ACTIVE')", [o.tenant]))[0].n;
    eq(okN, 1, `sukses (${res.join(",")})`);
    eq(lim, 9, "ditolak ADMIN_LIMIT_REACHED");
    eq(n, 1, "admin PENDING/ACTIVE");
    return "10 undangan serentak -> 1 sukses, 9 ADMIN_LIMIT_REACHED, 1 baris admin";
  });

  // ---------------------------------------------------------------- peran & isolasi di database
  await test("T-ROLE-01", K, "Admin tidak bisa memakai fungsi Owner atau menaikkan peran (database)", async () => {
    const o = await registerOwnerSql();
    await makePro(o.tenant);
    const a = await inviteAndActivateAdminSql(o);
    const [osess] = await asActor<{ r_id: string }>(o.token, "select r_id from app.session_list() limit 1");
    const r = {
      invite: await errOf(asActor(a.token, "select app.staff_invite($1,'X')", [newPhone()])),
      list: await errOf(asActor(a.token, "select * from app.staff_list()")),
      revoke: await errOf(asActor(a.token, "select app.session_revoke($1)", [osess.r_id])),
      deactivate: await errOf(asActor(a.token, "select app.staff_deactivate($1)", [a.membership])),
    };
    for (const [k, v] of Object.entries(r)) eq(v, "FORBIDDEN_ROLE", k);
    const up = await errOf(admin("update iam.membership set role='OWNER' where id=$1", [a.membership]));
    eq(up, "IMMUTABLE_FIELD", "ubah peran (bahkan superuser)");
    const [me] = await asActor<{ r: string }>(a.token, "select app.tenant_me()->>'role' r");
    eq(me.r, "ADMIN", "peran admin");
    return "4 fungsi Owner -> FORBIDDEN_ROLE; perubahan role -> IMMUTABLE_FIELD";
  });

  await test("T-TENANT-01", K, "Konteks toko palsu (GUC lama, token karangan, token toko lain) tidak memberi akses", async () => {
    const a = await registerOwnerSql("Kios A");
    const b = await registerOwnerSql("Kios B");
    const c = await rolePoolConnect();
    let spoof: string;
    try {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.current_tenant', $1, true), set_config('app.role','OWNER',true)", [a.tenant]);
      spoof = await errOf(c.query("select app.tenant_me()"));
      await c.query("rollback");
    } finally {
      c.release();
    }
    const forged = await errOf(asActor("b".repeat(64), "select app.tenant_me()"));
    const [bme] = await asActor<{ t: string }>(b.token, "select app.tenant_me()->'tenant'->>'id' t");
    const bstaff = await asActor<{ r_id: string }>(b.token, "select r_id from app.staff_list()");
    const aMembers = (await admin<{ id: string }>("select id from iam.membership where tenant_id=$1", [a.tenant])).map((x) => x.id);
    eq(spoof, "UNAUTHENTICATED", "GUC palsu");
    eq(forged, "UNAUTHENTICATED", "token karangan");
    eq(bme.t, b.tenant, "token B melihat toko B");
    ok(!bstaff.some((s) => aMembers.includes(s.r_id)), "token B melihat anggota A");
    return "GUC tenant palsu & token karangan -> UNAUTHENTICATED; token B hanya melihat data B";
  });

  await test("T-TENANT-02", K, "Akses ID milik toko lain lewat fungsi -> NOT_FOUND, data toko lain tidak berubah", async () => {
    const a = await registerOwnerSql("Kios A");
    const b = await registerOwnerSql("Kios B");
    await makePro(b.tenant);
    const bAdmin = await inviteAndActivateAdminSql(b);
    const [bs] = await admin<{ id: string }>("select id from iam.session where tenant_id=$1 and revoked_at is null limit 1", [b.tenant]);
    const r1 = await errOf(asActor(a.token, "select app.session_revoke($1)", [bs.id]));
    const r2 = await errOf(asActor(a.token, "select app.staff_deactivate($1)", [bAdmin.membership]));
    const still = await errOf(asActor(bAdmin.token, "select app.tenant_me()"));
    eq(r1, "NOT_FOUND", "cabut sesi B");
    eq(r2, "NOT_FOUND", "nonaktifkan admin B");
    eq(still, "OK", "sesi admin B tetap sah");
    return "revoke/deactivate objek toko B oleh A -> NOT_FOUND; data B utuh";
  });
}

function rolePoolConnect() {
  return rolePool("app_runtime").connect();
}
