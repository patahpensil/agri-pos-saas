"""
Uji PITR (Point-in-Time Recovery) dengan mekanisme bawaan PostgreSQL:
base backup + arsip WAL + recovery_target_time. Ini mekanisme yang sama yang
dipakai layanan terkelola; PITR layanan terkelola sendiri tetap BELUM DIUJI.

Skenario:
 t0 base backup
 t1 data tenant KEEP dan GONE
 T  <- titik pemulihan yang dipilih
 t2 GONE di-offboard (purge + tombstone di penyimpanan terpisah)
 t3 transaksi baru KEEP
 t4 bencana: skema aplikasi terhapus
Pulihkan ke T (sebelum t2) di instance terisolasi -> GONE muncul lagi -> tombstone diterapkan -> buka layanan.
"""
import os, shutil, subprocess, time, uuid, json
import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
B = os.environ["PG_BIN"]
SOCK = os.environ.get("POC_SOCK", "/tmp")
ROOT = os.path.join(os.environ.get("POC_RUNTIME", "/tmp/poc_runtime"), "pitr")
SRC_PORT, RST_PORT, MAIN_PORT = int(os.environ.get("PITR_SRC_PORT", "55433")), int(os.environ.get("PITR_RST_PORT", "55434")), int(os.environ.get("PG_PORT", "55432"))
SCHEMA = os.path.join(HERE, "..", "db", "schema.sql")
RUN_AS = os.environ.get("RUN_AS", "pgpoc")
RESULTS_DIR = os.environ.get("POC_RESULTS", os.path.join(HERE, "..", "results")); os.makedirs(RESULTS_DIR, exist_ok=True)
res = {}

def su(cmd, check=True):
    """Jalankan sebagai user OS non-root (PostgreSQL menolak berjalan sebagai root)."""
    argv = ["su", RUN_AS, "-c", cmd] if os.geteuid() == 0 else ["bash", "-c", cmd]
    return subprocess.run(argv, check=check, capture_output=True, text=True)

def conn(port, db="poc", user="postgres", host=SOCK, **kw):
    return psycopg.connect(host=host, port=port, user=user, dbname=db, autocommit=True, **kw)

# ---------------------------------------------------------------- siapkan instance sumber dengan arsip WAL
for d in ("src", "rst"):
    su(f"{B}/pg_ctl -D {ROOT}/{d} stop -m immediate", check=False)
su(f"rm -rf {ROOT} && mkdir -p {ROOT}/archive {ROOT}/sock")
su(f"{B}/initdb -D {ROOT}/src -U postgres -A trust >/dev/null")
su(f"{B}/pg_ctl -D {ROOT}/src -l {ROOT}/src.log -o \"-p {SRC_PORT} -k {SOCK} -c track_commit_timestamp=on -c wal_level=replica -c archive_mode=on "
   f"-c archive_command='cp %p {ROOT}/archive/%f' -c archive_timeout=1\" start")
time.sleep(2)
with conn(SRC_PORT, "postgres") as c: c.execute("create database poc")
subprocess.run([f"{B}/psql", "-h", SOCK, "-p", str(SRC_PORT), "-U", "postgres", "-d", "poc", "-q", "-f", SCHEMA], check=True, capture_output=True)

su(f"{B}/pg_basebackup -h {SOCK} -p {SRC_PORT} -U postgres -D {ROOT}/base -X stream -c fast")   # t0

TOK = {}
def app_tx(t, sql, params=()):
    if t not in TOK:
        import secrets
        TOK[t] = secrets.token_urlsafe(32); uid = uuid.uuid4()
        with conn(SRC_PORT) as a:
            a.execute("insert into iam.app_user_account values (%s,%s,%s,'x','ADMIN')", (uid, t, "+62" + uid.hex[:12]))
            a.execute("insert into iam.session values (encode(sha256(convert_to(%s,'UTF8')),'hex'),%s,%s,'ADMIN', now()+interval '1 day', null)", (TOK[t], uid, t))
    with psycopg.connect(host=SOCK, port=SRC_PORT, user="app_user", dbname="poc") as c:
        cur = c.cursor(); cur.execute("select set_config('app.session_token',%s,true)", (TOK[t],))
        cur.execute(sql, params); c.commit()

keep, gone = uuid.uuid4(), uuid.uuid4()
with conn(SRC_PORT) as c:                                                                     # t1
    for t in (keep, gone):
        c.execute("insert into app.tenant values (%s,'k','PRO','ACTIVE', now()+interval '30 days')", (t,))
        c.execute("insert into app.product values (%s,1,'SKU1',1,false,1000)", (t,))
        c.execute("insert into app.stock values (%s,1,'LOOSE','A','READY',10),(%s,1,'SEALED','A','READY',0)", (t, t))
        c.execute("insert into app.cost_pool values (%s,1,'READY',10,5000)", (t,))
for t in (keep, gone):
    app_tx(t, "select app.finalize_sale('t1',%s::jsonb,%s::jsonb)", ('[{"product":1,"form":"LOOSE","batch":"A","qty":1}]', '[{"method":"CASH","amount":1000}]'))
time.sleep(1.5)
with conn(SRC_PORT) as c: target = c.execute("select now()").fetchone()[0]                   # T
time.sleep(1.5)

# t2: offboarding GONE — tombstone di instance UTAMA (penyimpanan terpisah), purge di sumber
with conn(MAIN_PORT, "tombstone_store") as c:
    c.execute("create table if not exists deleted_tenant(tenant_id uuid primary key, deleted_at timestamptz not null default now())")
    c.execute("insert into deleted_tenant(tenant_id) values (%s) on conflict do nothing", (gone,))
with conn(SRC_PORT) as c:
    c.execute("set session_replication_role = replica")
    for tb in ["payment","invoice","sale_line","sale","cash_movement","inventory_ledger","audit_event","cost_pool","stock","product"]:
        c.execute(f"delete from app.{tb} where tenant_id=%s", (gone,))
    for tb in ["session","app_user_account"]: c.execute(f"delete from iam.{tb} where tenant_id=%s", (gone,))
    c.execute("delete from app.tenant where id=%s", (gone,))
app_tx(keep, "select app.finalize_sale('t3',%s::jsonb,%s::jsonb)", ('[{"product":1,"form":"LOOSE","batch":"A","qty":2}]', '[{"method":"CASH","amount":2000}]'))  # t3
with conn(SRC_PORT) as c:                                                                     # t4 bencana
    c.execute("drop schema app cascade")
    c.execute("select pg_switch_wal()")
time.sleep(3)
su(f"{B}/pg_ctl -D {ROOT}/src stop -m fast")

# ---------------------------------------------------------------- pemulihan ke T di instance TERISOLASI
su(f"cp -a {ROOT}/base {ROOT}/rst && touch {ROOT}/rst/recovery.signal")
with open(f"{ROOT}/rst/postgresql.auto.conf", "a") as f:
    f.write(f"\nrestore_command = 'cp {ROOT}/archive/%f %p'\nrecovery_target_time = '{target.isoformat()}'\nrecovery_target_action = 'promote'\n")
if os.geteuid() == 0: shutil.chown(f"{ROOT}/rst/postgresql.auto.conf", RUN_AS)
# Terisolasi: hanya socket privat, tanpa TCP -> aplikasi (yang memakai /tmp) tidak dapat tersambung
su(f"{B}/pg_ctl -D {ROOT}/rst -l {ROOT}/rst.log -w -t 60 -o \"-p {RST_PORT} -k {ROOT}/sock -c listen_addresses=''\" start")
time.sleep(2)
try:
    psycopg.connect(host=SOCK, port=RST_PORT, user="app_user", dbname="poc").close(); res["aplikasi_bisa_masuk_saat_restore"] = True
except psycopg.Error:
    res["aplikasi_bisa_masuk_saat_restore"] = False
with conn(RST_PORT, host=f"{ROOT}/sock") as c:
    res["schema_ada"] = c.execute("select count(*) from pg_namespace where nspname='app'").fetchone()[0] == 1
    res["keep_sale_sebelum_T"] = c.execute("select count(*) from app.sale where tenant_id=%s", (keep,)).fetchone()[0]
    res["gone_muncul_kembali"] = c.execute("select count(*) from app.tenant where id=%s", (gone,)).fetchone()[0]
    with conn(MAIN_PORT, "tombstone_store") as t:
        tomb = [r[0] for r in t.execute("select tenant_id from deleted_tenant").fetchall()]
    c.execute("set session_replication_role = replica")
    for tid in tomb:
        for tb in ["payment","invoice","sale_line","sale","cash_movement","inventory_ledger","audit_event","cost_pool","stock","product"]:
            c.execute(f"delete from app.{tb} where tenant_id=%s", (tid,))
        for tb in ["session","app_user_account"]: c.execute(f"delete from iam.{tb} where tenant_id=%s", (tid,))
        c.execute("delete from app.tenant where id=%s", (tid,))
    c.execute("set session_replication_role = origin")
    res["gone_setelah_tombstone"] = c.execute("select count(*) from app.tenant where id=%s", (gone,)).fetchone()[0]
    res["sisa_baris_gone"] = c.execute("select (select count(*) from app.sale where tenant_id=%s)+(select count(*) from app.audit_event where tenant_id=%s)", (gone, gone)).fetchone()[0]
    res["stok_keep"] = c.execute("select qty from app.stock where tenant_id=%s and form='LOOSE'", (keep,)).fetchone()[0]
    res["recovery_selesai"] = not c.execute("select pg_is_in_recovery()").fetchone()[0]
su(f"{B}/pg_ctl -D {ROOT}/rst stop -m fast")
# Buka layanan
su(f"{B}/pg_ctl -D {ROOT}/rst -l {ROOT}/rst.log -w -o \"-p {RST_PORT} -k {SOCK} -c listen_addresses=''\" start")
with psycopg.connect(host=SOCK, port=RST_PORT, user="app_user", dbname="poc") as c:
    cur = c.cursor(); cur.execute("select set_config('app.session_token',%s,true)", (TOK[keep],))
    res["keep_bisa_transaksi_setelah_dibuka"] = cur.execute("select count(*) from app.sale").fetchone()[0] == 1
su(f"{B}/pg_ctl -D {ROOT}/rst stop -m fast")

res["target_time"] = target.isoformat()
res["catatan_RPO"] = "Transaksi KEEP di t3 (setelah T) tidak ada di hasil pemulihan — ini kehilangan data yang sesuai titik pemulihan yang dipilih."
ok = (res["schema_ada"] and not res["aplikasi_bisa_masuk_saat_restore"] and res["keep_sale_sebelum_T"] == 1 and res["gone_muncul_kembali"] == 1
      and res["gone_setelah_tombstone"] == 0 and res["sisa_baris_gone"] == 0 and res["stok_keep"] == 9 and res["recovery_selesai"] and res["keep_bisa_transaksi_setelah_dibuka"])
res["status"] = "PASS" if ok else "FAIL"
print(json.dumps(res, indent=1, default=str))
json.dump(res, open(os.path.join(RESULTS_DIR, "pitr_results.json"), "w"), indent=1, default=str)
