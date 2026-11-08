"""
PoC uji lapisan database — PRD V1.1 (Aplikasi SaaS Penjualan Pertanian).
Menjalankan T-01..T-10 dan uji tambahan terhadap PostgreSQL 16 nyata.
Jenis uji: DATABASE INTEGRATION TEST (bukan uji API, bukan uji perangkat).

Pakai:  python3 run_tests.py  (PostgreSQL di host /tmp port 55432, db 'poc')
"""
import json, os, subprocess, threading, time, uuid, statistics, sys
import os, getpass
SOCK = os.environ.get("POC_SOCK", "/tmp")
PG_PORT = int(os.environ.get("PG_PORT", "55432"))
RUNTIME = os.environ.get("POC_RUNTIME", "/tmp/poc_runtime")
RESULTS_DIR = os.environ.get("POC_RESULTS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results"))
os.makedirs(RESULTS_DIR, exist_ok=True)
import psycopg
from psycopg import errors

HOST, PORT = SOCK, PG_PORT
ADMIN = dict(host=HOST, port=PORT, user="postgres", dbname="poc")
APP = dict(host=HOST, port=PORT, user="app_user", dbname="poc")
RESULTS = []

def admin():
    c = psycopg.connect(**ADMIN, autocommit=True); return c

def appconn():
    return psycopg.connect(**APP, autocommit=False)

TOKENS = {}
def token_for(tenant, role):
    """Membuat akun + sesi sah (seperti hasil login) dan mengembalikan token mentah."""
    key = (str(tenant), role)
    if key not in TOKENS:
        import secrets
        tok = secrets.token_urlsafe(32); uid = uuid.uuid4()
        with admin() as c:
            c.execute("insert into iam.app_user_account values (%s,%s,%s,'x',%s)", (uid, tenant, "+62" + uid.hex[:12], role))
            c.execute("insert into iam.session values (encode(sha256(convert_to(%s,'UTF8')),'hex'),%s,%s,%s, now() + interval '1 day', null)",
                      (tok, uid, tenant, role))
        TOKENS[key] = tok
    return TOKENS[key]

def ctx(cur, tenant, actor="owner"):
    """Backend meneruskan token sesi mentah, lokal transaksi. Tenant/aktor/peran DITURUNKAN database."""
    if not tenant: return
    role = "OWNER" if actor == "owner" else "ADMIN"
    cur.execute("select set_config('app.session_token', %s, true)", (token_for(tenant, role),))

def call(tenant, sql, params=(), actor="owner"):
    """Satu request backend = satu transaksi. Mengembalikan (ok, hasil/pesan)."""
    with appconn() as c:
        cur = c.cursor()
        try:
            ctx(cur, tenant, actor)
            cur.execute(sql, params)
            res = cur.fetchone() if cur.description else None
            c.commit()
            return True, (res[0] if res else None)
        except psycopg.Error as e:
            c.rollback()
            return False, (e.diag.message_primary or str(e)).split("\n")[0]

def q1(sql, params=()):
    with admin() as c:
        r = c.execute(sql, params).fetchone()
        return r[0] if r and len(r) == 1 else r

def record(tid, jenis, kondisi, harapan, aktual, ok):
    RESULTS.append(dict(id=tid, jenis=jenis, kondisi=kondisi, harapan=harapan, aktual=aktual,
                        status="PASS" if ok else "FAIL"))
    print(f"[{'PASS' if ok else 'FAIL'}] {tid}: {aktual}")

# ------------------------------------------------------------------ seed
def new_tenant(plan="PRO", seconds=86400 * 30):
    t = uuid.uuid4()
    with admin() as c:
        c.execute("insert into app.tenant values (%s,%s,%s,'ACTIVE', now() + make_interval(secs => %s))",
                  (t, f"kios-{str(t)[:6]}", plan, seconds))
    return t

def add_product(t, pid, price, factor=1, can_open=False, loose=0, sealed=0, value=0, batch="A"):
    with admin() as c:
        c.execute("insert into app.product values (%s,%s,%s,%s,%s,%s)", (t, pid, f"SKU{pid}", factor, can_open, price))
        c.execute("insert into app.stock values (%s,%s,'LOOSE',%s,'READY',%s)", (t, pid, batch, loose))
        c.execute("insert into app.stock values (%s,%s,'SEALED',%s,'READY',%s)", (t, pid, batch, sealed))
        c.execute("insert into app.cost_pool values (%s,%s,'READY',%s,%s)", (t, pid, loose + sealed * factor, value))
        c.execute("insert into app.inventory_ledger(tenant_id,event,product_id,batch,status,delta_qty,delta_value,ref) "
                  "values (%s,'OPENING',%s,%s,'READY',%s,%s,'seed')", (t, pid, batch, loose + sealed * factor, value))

def sell(t, idem, lines, pay, actor="kasir"):
    return call(t, "select app.finalize_sale(%s,%s::jsonb,%s::jsonb)", (idem, json.dumps(lines), json.dumps(pay)), actor)

def stock(t, pid, form="LOOSE", status="READY", batch="A"):
    return q1("select qty from app.stock where tenant_id=%s and product_id=%s and form=%s and status=%s and batch=%s",
              (t, pid, form, status, batch))

def race(fns):
    """Jalankan fungsi bersamaan dengan barrier; kembalikan hasil berurutan."""
    out = [None] * len(fns); b = threading.Barrier(len(fns))
    def run(i, f):
        b.wait(); out[i] = f()
    th = [threading.Thread(target=run, args=(i, f)) for i, f in enumerate(fns)]
    [x.start() for x in th]; [x.join() for x in th]
    return out

# ------------------------------------------------------------------ T-01
def t01():
    rounds, viol = 200, 0
    for i in range(rounds):
        t = new_tenant(); add_product(t, 1, 10000, loose=1, value=7000)
        r = race([lambda k=k: sell(t, f"k{k}", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":10000}]) for k in range(2)])
        ok = sum(1 for x in r if x[0]); s = stock(t, 1)
        if not (ok == 1 and s == 0 and q1("select count(*) from app.sale where tenant_id=%s", (t,)) == 1): viol += 1
    record("T-01", "DB integration (konkurensi)", f"Stok 1, dua kasir bersamaan, diulang {rounds}x",
           "Maksimal satu berhasil", f"{rounds - viol}/{rounds} putaran: tepat 1 sukses, stok 0, tidak negatif", viol == 0)

# ------------------------------------------------------------------ T-02
def t02():
    t = new_tenant(); add_product(t, 1, 200000, loose=0, value=0)
    omzet0 = q1("select coalesce(sum(total),0) from app.sale where tenant_id=%s", (t,))
    ok, msg = sell(t, "trf-1", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"TRANSFER","amount":200000}])
    ok2, exc = call(t, "select app.record_unmatched(%s,%s)", ("bukti-trf-1", 200000))
    ok3, exc2 = call(t, "select app.record_unmatched(%s,%s)", ("bukti-trf-1", 200000))   # bukti dikirim ulang
    sales = q1("select count(*) from app.sale where tenant_id=%s", (t,))
    omzet1 = q1("select coalesce(sum(total),0) from app.sale where tenant_id=%s", (t,))
    row = q1("select amount, waiting, count(*) over () from app.unmatched_receipt where tenant_id=%s", (t,))
    good = (not ok) and msg == "INSUFFICIENT_STOCK" and ok2 and exc == exc2 and sales == 0 and omzet1 == omzet0 and row == (200000, 200000, 1)
    record("T-02", "DB integration", "Transfer Rp200.000 diterima, finalisasi gagal (stok habis)",
           "RECEIVED_UNMATCHED, bukan omzet", f"finalisasi: {msg}; Sale={sales}; omzet {omzet0}->{omzet1}; pengecualian (nominal,menunggu,jumlah baris)={row}", good)
    return t, exc

# ------------------------------------------------------------------ T-03
def setup_invoice(price=250000, units=4, paid=900000, method="TRANSFER"):
    t = new_tenant(); add_product(t, 1, price, loose=units, value=units * 100000)
    ok, sale = sell(t, "s1", [{"product":1,"form":"LOOSE","batch":"A","qty":units}], [{"method":method,"amount":paid}])
    assert ok, sale
    return t, sale

def inv(t, sale):
    return q1("select f,c,r,p,rf,q, f+c-r-(p-rf) from app.invoice where tenant_id=%s and sale_id=%s", (t, sale))

def t03():
    t, s = setup_invoice()
    call(t, "select app.return_line(%s,1,1)", (s,))                         # R=250.000 -> L=150.000
    ok_a, appr = call(t, "select app.approve_refund('INVOICE',%s,150000,'TRANSFER')", (s,))
    call(t, "select app.mark_sent(%s,'percobaan 1 — gagal di bank')", (appr,))
    ok_cancel, m_cancel = call(t, "select app.cancel_approval(%s)", (appr,))
    ok_new, m_new = call(t, "select app.approve_refund('INVOICE',%s,150000,'TRANSFER')", (s,))
    call(t, "select app.mark_sent(%s,'percobaan 2 — ulang di approval sama')", (appr,))
    ok_p1, _ = call(t, "select app.record_refund_paid(%s,'mutasi debit #2')", (appr,))
    ok_p2, m_p2 = call(t, "select app.record_refund_paid(%s,'kirim ulang')", (appr,))
    f, c, r, p, rf, q, b = inv(t, s)
    attempts = q1("select count(*) from app.refund_attempt where approval_id=%s", (appr,))
    pays = q1("select count(*) from app.refund_payment where approval_id=%s", (appr,))
    good = ok_a and not ok_cancel and not ok_new and ok_p1 and not ok_p2 and attempts == 2 and pays == 1 and rf == 150000 and q == 0 and b == 0
    record("T-03", "DB integration", "Faktur 1jt, bayar 900rb, retur 250rb; refund 150rb transfer gagal lalu diulang",
           "Approval sama, tanpa posting dibayar ganda",
           f"batal setelah terkirim: {m_cancel}; approval baru: {m_new}; attempt={attempts}; posting dibayar={pays}; posting ke-2: {m_p2}; Rf={rf}, Q={q}, B={b}", good)

# ------------------------------------------------------------------ T-04
def t04():
    t = new_tenant(); add_product(t, 1, 50, loose=3, value=100)
    ok, s = sell(t, "s", [{"product":1,"form":"LOOSE","batch":"A","qty":3}], [{"method":"CASH","amount":150}])
    hpp_line = q1("select hpp from app.sale_line where sale_id=%s", (s,))
    rets = [call(t, "select app.return_line(%s,1,1)", (s,))[1] for _ in range(3)]
    insp = q1("select value from app.cost_pool where tenant_id=%s and product_id=1 and status='INSPECT'", (t,))
    good = hpp_line == 100 and rets == [33, 33, 34] and insp == 100
    record("T-04", "DB integration", "Baris 3 unit HPP Rp100, retur 1 unit x3",
           "Rp33 + Rp33 + Rp34", f"HPP baris={hpp_line}; retur={rets}; nilai stok pemeriksaan={insp}", good)

# ------------------------------------------------------------------ T-05
def t05():
    a = new_tenant(); b = new_tenant()
    add_product(a, 1, 1000, loose=10, value=5000); add_product(b, 1, 1000, loose=10, value=5000)
    _, sb = sell(b, "sb", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    checks = {}
    with appconn() as c:
        cur = c.cursor(); ctx(cur, a)
        checks["baca Sale B"] = cur.execute("select count(*) from app.sale where id=%s", (sb,)).fetchone()[0]
        checks["baca semua invoice"] = cur.execute("select count(*) from app.invoice").fetchone()[0]
        c.rollback()
    with appconn() as c:
        cur = c.cursor(); ctx(cur, a)
        try:
            checks["ubah stok B"] = cur.execute("update app.stock set qty=999 where tenant_id=%s", (b,)).rowcount
        except psycopg.Error as e:
            checks["ubah stok B"] = e.diag.message_primary
        c.rollback()
    with appconn() as c:
        cur = c.cursor(); ctx(cur, a)
        try:
            cur.execute("insert into app.audit_event(tenant_id, action) values (%s,'palsu')", (b,)); checks["sisip baris ber-tenant B"] = "LOLOS"
        except psycopg.Error as e:
            checks["sisip baris ber-tenant B"] = e.diag.message_primary
        c.rollback()
    checks["retur faktur B dari A"] = call(a, "select app.return_line(%s,1,1)", (sb,))[1]
    checks["ubah masa langganan sendiri"] = call(a, "update app.tenant set entitlement_until = now() + interval '10 years' where id=%s returning 1", (a,))[1]
    with appconn() as c:   # tanpa konteks tenant
        cur = c.cursor()
        checks["tanpa konteks: baca Sale"] = cur.execute("select count(*) from app.sale").fetchone()[0]
        c.rollback()
    checks["tanpa konteks: finalisasi"] = call("", "select app.finalize_sale('x','[]','[]')")[1] if False else None
    with appconn() as c:
        cur = c.cursor()
        try:
            cur.execute("select app.finalize_sale('x','[]'::jsonb,'[]'::jsonb)"); checks["tanpa konteks: finalisasi"] = "LOLOS"
        except psycopg.Error as e:
            checks["tanpa konteks: finalisasi"] = e.diag.message_primary
    stok_b = stock(b, 1)
    denied = lambda v: v == 0 or "permission denied" in str(v) or "row-level security" in str(v)
    good = (checks["baca Sale B"] == 0 and denied(checks["ubah stok B"]) and checks["baca semua invoice"] == 0
            and denied(checks["sisip baris ber-tenant B"]) and checks["retur faktur B dari A"] == "LINE_NOT_FOUND"
            and ("row-level security" in str(checks["ubah masa langganan sendiri"]) or "permission denied" in str(checks["ubah masa langganan sendiri"])) and checks["tanpa konteks: baca Sale"] == 0
            and checks["tanpa konteks: finalisasi"] == "NO_TENANT_CONTEXT" and stok_b == 9)
    record("T-05", "DB integration (lapisan database; lapisan API BELUM DIUJI)", "Tenant A memakai ID objek tenant B",
           "Ditolak di lapisan database", "; ".join(f"{k}: {v}" for k, v in checks.items()) + f"; stok B tetap {stok_b}", good)

# ------------------------------------------------------------------ T-06
def t06():
    t = new_tenant(seconds=3); add_product(t, 1, 1000, loose=10, value=5000)
    ok1, _ = sell(t, "sebelum", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    # Transaksi kedua tertahan kunci stok sampai melewati batas waktu
    holder = psycopg.connect(**ADMIN); hc = holder.cursor()
    hc.execute("select 1 from app.stock where tenant_id=%s and product_id=1 and form='LOOSE' and status='READY' for update", (t,))
    res = {}
    th = threading.Thread(target=lambda: res.setdefault("r", sell(t, "melewati", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])))
    th.start(); time.sleep(3.5); holder.rollback(); holder.close(); th.join()
    ok3, m3 = sell(t, "sesudah", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    sales = q1("select count(*) from app.sale where tenant_id=%s", (t,)); s = stock(t, 1)
    stamped = q1("select bool_and(s.created_at < t.entitlement_until) from app.sale s join app.tenant t on t.id = s.tenant_id where s.tenant_id=%s", (t,))
    good = stamped and ok1 and not res["r"][0] and res["r"][1] == "ENTITLEMENT_EXPIRED" and not ok3 and sales == 1 and s == 9
    record("T-06", "DB integration", "Masa hak 3 detik; transaksi ke-2 tertahan kunci hingga lewat batas",
           "Hanya commit sebelum batas yang sah", f"cap waktu Sale < batas hak={stamped}; sebelum batas: sukses; tertahan: {res['r'][1]}; sesudah: {m3}; Sale={sales}; stok={s} (tanpa posting parsial)", good)

def t06b():
    t = new_tenant(seconds=3); add_product(t, 1, 1000, loose=10, value=5000)
    c = appconn(); cur = c.cursor(); ctx(cur, t, "kasir")
    cur.execute("select app.finalize_sale('tahan-commit','[{\"product\":1,\"form\":\"LOOSE\",\"batch\":\"A\",\"qty\":1}]','[{\"method\":\"CASH\",\"amount\":1000}]')")
    fn_ok = cur.fetchone()[0] is not None                       # fungsi selesai SEBELUM batas
    time.sleep(3.5)                                             # COMMIT ditahan melewati batas
    try: c.commit(); commit_res = "COMMIT BERHASIL"
    except psycopg.Error as e: commit_res = e.diag.message_primary; c.rollback()
    c.close()
    n = q1("select count(*) from app.sale where tenant_id=%s", (t,)); s = stock(t, 1)
    # kontrol positif: commit normal sebelum batas — cap waktu commit (track_commit_timestamp) < batas hak
    t2 = new_tenant(seconds=60); add_product(t2, 1, 1000, loose=10, value=5000)
    sell(t2, "normal", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    ct_ok = q1("select bool_and(pg_xact_commit_timestamp(s.xmin) < t.entitlement_until) from app.sale s join app.tenant t on t.id=s.tenant_id where s.tenant_id=%s", (t2,))
    good = fn_ok and commit_res == "ENTITLEMENT_EXPIRED_AT_COMMIT" and n == 0 and s == 10 and ct_ok
    record("T-06b", "DB integration (audit R2-02)", "Fungsi finalisasi selesai sebelum batas; COMMIT ditahan 3,5 dtk melewati batas",
           "COMMIT ditolak; tidak ada posting", f"fungsi sebelum batas={fn_ok}; COMMIT: {commit_res}; Sale={n}; stok={s}; kontrol: cap waktu commit < batas={ct_ok}", good)

# ------------------------------------------------------------------ T-07
def t07():
    t = new_tenant(); add_product(t, 1, 1000, loose=10, value=5000)
    line = [{"product":1,"form":"LOOSE","batch":"A","qty":2}]; pay = [{"method":"CASH","amount":2000}]
    def backend_retry():
        ok, r = sell(t, "idem-777", line, pay)
        if not ok and "duplicate key" in r:          # backend: konflik idem -> ambil Sale yang sudah ada
            ok, r = sell(t, "idem-777", line, pay)
        return ok, r
    r = race([backend_retry, backend_retry, backend_retry])
    r2 = sell(t, "idem-777", line, pay)              # retry setelah jaringan pulih
    ids = {x[1] for x in r + [r2] if x[0]}
    n = q1("select count(*) from app.sale where tenant_id=%s", (t,)); s = stock(t, 1)
    cash = q1("select sum(amount) from app.cash_movement where tenant_id=%s", (t,))
    good = len(ids) == 1 and n == 1 and s == 8 and cash == 2000
    record("T-07", "DB integration", "Kunci idempotensi sama dikirim 3x bersamaan + 1x sesudahnya",
           "Tidak ada transaksi ganda", f"ID Sale unik={ids}; jumlah Sale={n}; stok 10->{s}; kas={cash}", good)

# ------------------------------------------------------------------ T-08 (+ uji tambahan pemulihan)
def t08():
    keep = new_tenant(); gone = new_tenant()
    for t in (keep, gone):
        add_product(t, 1, 1000, loose=10, value=5000)
        sell(t, "s", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    audit_keep = q1("select count(*) from app.audit_event where tenant_id=%s", (keep,))
    dump = os.path.join(RUNTIME, "backup_t0.dump")
    subprocess.run([os.path.join(os.environ.get("PG_BIN", "/usr/bin"), "pg_dump"), "-h", HOST, "-p", str(PORT), "-U", "postgres", "-Fc", "-f", dump, "poc"], check=True)
    # Offboarding: hapus dari database aktif + tombstone di penyimpanan TERPISAH
    with psycopg.connect(host=HOST, port=PORT, user="postgres", dbname="tombstone_store", autocommit=True) as c:
        c.execute("create table if not exists deleted_tenant(tenant_id uuid primary key, deleted_at timestamptz not null default now())")
        c.execute("insert into deleted_tenant(tenant_id) values (%s) on conflict do nothing", (gone,))
    purge(gone, "poc")
    # Bencana: database rusak -> pulihkan backup lama ke database baru, akses aplikasi ditutup dulu
    with admin() as c:
        c.execute("drop database if exists poc_restore"); c.execute("create database poc_restore")
        c.execute("revoke connect on database poc_restore from public")
    subprocess.run([os.path.join(os.environ.get("PG_BIN", "/usr/bin"), "pg_restore"), "-h", HOST, "-p", str(PORT), "-U", "postgres", "-d", "poc_restore", dump], check=True)
    try:
        psycopg.connect(host=HOST, port=PORT, user="app_user", dbname="poc_restore").close(); app_blocked = False
    except psycopg.Error:
        app_blocked = True
    present_before = q1_db("poc_restore", "select count(*) from app.tenant where id=%s", (gone,))
    with psycopg.connect(host=HOST, port=PORT, user="postgres", dbname="tombstone_store") as c:
        tomb = [r[0] for r in c.execute("select tenant_id from deleted_tenant").fetchall()]
    for t in tomb: purge(t, "poc_restore")
    with admin() as c: c.execute("grant connect on database poc_restore to app_user")
    present_after = q1_db("poc_restore", "select count(*) from app.tenant where id=%s", (gone,))
    rows_left = q1_db("poc_restore", "select (select count(*) from app.sale where tenant_id=%s)+(select count(*) from app.audit_event where tenant_id=%s)", (gone, gone))
    keep_ok = q1_db("poc_restore", "select count(*) from app.audit_event where tenant_id=%s", (keep,)) == audit_keep
    good = app_blocked and present_before == 1 and present_after == 0 and rows_left == 0 and keep_ok
    record("T-08", "DB integration (pg_dump/pg_restore; PITR terkelola BELUM DIUJI)", "Backup t0 memuat tenant yang lalu dihapus; restore ke DB baru",
           "Tenant tidak aktif kembali", f"akses aplikasi ditutup selama restore={app_blocked}; tenant di backup={present_before}; setelah tombstone diterapkan={present_after}; sisa baris={rows_left}; audit tenant lain utuh={keep_ok}", good)

def q1_db(db, sql, params=()):
    with psycopg.connect(host=HOST, port=PORT, user="postgres", dbname=db) as c:
        return c.execute(sql, params).fetchone()[0]

def purge(t, db):
    """Jalur purge terkendali: satu-satunya jalan menghapus tabel append-only (peran privileged, diaudit di luar tenant)."""
    tables = ["refund_returned","refund_payment","refund_attempt","refund_approval","document_print","payment","return_line",
              "invoice","sale_line","sale","unmatched_receipt","cash_movement","inventory_ledger","audit_event","cost_pool","stock","product"]
    iam_tables = ["session", "app_user_account"]
    with psycopg.connect(host=HOST, port=PORT, user="postgres", dbname=db) as c:
        c.execute("set session_replication_role = replica")   # melewati trigger append-only HANYA di jalur purge
        for tb in tables: c.execute(f"delete from app.{tb} where tenant_id=%s", (t,))
        for tb in iam_tables: c.execute(f"delete from iam.{tb} where tenant_id=%s", (t,))
        c.execute("delete from app.tenant where id=%s", (t,))
        c.commit()

# ------------------------------------------------------------------ T-09
def t09():
    t, s = setup_invoice(price=50000, units=1, paid=50000, method="CASH")
    cash0 = q1("select sum(amount) from app.cash_movement where tenant_id=%s", (t,))
    call(t, "select app.return_line(%s,1,1)", (s,))
    ok_a, appr = call(t, "select app.approve_refund('INVOICE',%s,50000,'CASH')", (s,))
    r = race([lambda: call(t, "select app.record_refund_paid(%s,'serah tunai')", (appr,)) for _ in range(2)])
    cash1 = q1("select sum(amount) from app.cash_movement where tenant_id=%s", (t,))
    aud = q1("select count(*) from app.audit_event where tenant_id=%s and action='REFUND_PAID'", (t,))
    state = q1("select state from app.refund_approval where id=%s", (appr,))
    good = sum(1 for x in r if x[0]) == 1 and cash0 - cash1 == 50000 and aud == 1 and state == "PAID_CASH"
    record("T-09", "DB integration (konkurensi)", "Refund tunai Rp50.000, posting dikirim 2x bersamaan",
           "Kas berkurang sekali, audit tercatat", f"posting sukses={sum(1 for x in r if x[0])}; kas {cash0}->{cash1}; audit REFUND_PAID={aud}; status={state}", good)

# ------------------------------------------------------------------ T-10
def t10():
    t = new_tenant(); add_product(t, 1, 1000, loose=5, value=2500)
    _, s = sell(t, "s", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    call(t, "select app.print_doc(%s,'THERMAL')", (s,))
    for _ in range(3): call(t, "select app.print_doc(%s,'PDF')", (s,))
    prints = q1("select array_agg(is_copy order by id) from app.document_print where sale_id=%s", (s,))
    n = q1("select count(*) from app.sale where tenant_id=%s", (t,)); st = stock(t, 1)
    good = prints == [False, True, True, True] and n == 1 and st == 4
    record("T-10", "DB integration (logika dokumen); printer & PDF di perangkat BELUM DIUJI", "Cetak struk lalu 3x ulang/PDF",
           "Transaksi tidak difinalisasi ulang", f"salinan={prints}; Sale={n}; stok={st}", good)

# ------------------------------------------------------------------ tambahan
def x_return_vs_refund():
    rounds, bad = 30, 0
    for i in range(rounds):
        t, s = setup_invoice()
        call(t, "select app.return_line(%s,1,1)", (s,))
        _, appr = call(t, "select app.approve_refund('INVOICE',%s,150000,'TRANSFER')", (s,))
        call(t, "select app.mark_sent(%s,'x')", (appr,))
        race([lambda: call(t, "select app.return_line(%s,1,1)", (s,)),
              lambda: call(t, "select app.record_refund_paid(%s,'bukti')", (appr,))])
        f, c, r, p, rf, q, b = inv(t, s)
        if not (r == 500000 and rf == 150000 and q == 0 and b == -250000): bad += 1
    record("X-01", "DB integration (konkurensi)", f"Retur kedua & pembayaran refund bersamaan, {rounds}x",
           "Invarian Q<=L terjaga, tidak hilang", f"{rounds - bad}/{rounds} putaran: R=500.000, Rf=150.000, Q=0, B=-250.000", bad == 0)

def x_carton():
    rounds, bad = 50, 0
    for i in range(rounds):
        t = new_tenant(); add_product(t, 2, 1000, factor=12, can_open=True, sealed=1, value=12000)
        r = race([lambda: call(t, "select app.open_carton(2,'A','buka')"),
                  lambda: sell(t, "karton", [{"product":2,"form":"SEALED","batch":"A","qty":1}], [{"method":"CASH","amount":12000}])])
        sealed, loose = stock(t, 2, "SEALED"), stock(t, 2, "LOOSE")
        pool = q1("select qty_base from app.cost_pool where tenant_id=%s and product_id=2 and status='READY'", (t,))
        equiv = sealed * 12 + loose
        if sum(1 for x in r if x[0]) != 1 or equiv != pool: bad += 1
    record("X-02", "DB integration (konkurensi)", f"1 karton isi 12: buka karton vs jual karton bersamaan, {rounds}x",
           "Hanya satu berhasil; ekuivalen = kolam nilai", f"{rounds - bad}/{rounds} putaran konsisten", bad == 0)

def x_hold():
    t = new_tenant(); add_product(t, 1, 1000, loose=5, value=5000)
    c1 = appconn(); cur = c1.cursor(); ctx(cur, t, "kasir")
    cur.execute("select app.finalize_sale('h1','[{\"product\":1,\"form\":\"LOOSE\",\"batch\":\"A\",\"qty\":1}]','[{\"method\":\"CASH\",\"amount\":1000}]')")
    res = {}
    th = threading.Thread(target=lambda: res.setdefault("h", call(t, "select app.hold_batch(1,'A')", actor="admin")))
    th.start(); time.sleep(1); waited = th.is_alive(); c1.commit(); c1.close(); th.join()
    ok_after, m_after = sell(t, "h2", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    held = stock(t, 1, status="HELD"); ready = stock(t, 1)
    pools = q1("select array_agg(value order by status) from app.cost_pool where tenant_id=%s", (t,))
    good = waited and res["h"][0] and held == 4 and ready == 0 and not ok_after and m_after == "INSUFFICIENT_STOCK" and sum(pools) == 4000
    record("X-03", "DB integration (konkurensi)", "Admin menahan batch saat transaksi kasir masih terbuka",
           "Penahanan menunggu commit, lalu penjualan berikut diblokir", f"penahanan menunggu={waited}; ditahan={held}; siap jual={ready}; jual sesudah tahan: {m_after}; nilai HELD+READY={sum(pools)}", good)

def x_correction():
    t, s = setup_invoice()
    call(t, "select app.return_line(%s,1,1)", (s,))
    call(t, "select app.approve_refund('INVOICE',%s,150000,'TRANSFER')", (s,))
    ok_up, m_up = call(t, "select app.correct_invoice(%s,100000)", (s,))
    ok_dn, _ = call(t, "select app.correct_invoice(%s,-50000)", (s,))
    f, c, r, p, rf, q, b = inv(t, s)
    good = not ok_up and "check constraint" in m_up and ok_dn and c == -50000 and q == 150000 and -b == 200000
    record("X-04", "DB integration", "Refund 150rb tertunda; koreksi +100rb lalu -50rb",
           "Koreksi yang membuat Q>L ditolak", f"koreksi +100rb: {m_up[:60]}; koreksi -50rb: diterima; Q={q}, L={-b}", good)

def x_entitlement_change():
    t = new_tenant(); add_product(t, 1, 1000, loose=5, value=5000)
    c1 = appconn(); cur = c1.cursor(); ctx(cur, t, "kasir")
    cur.execute("select app.finalize_sale('e1','[{\"product\":1,\"form\":\"LOOSE\",\"batch\":\"A\",\"qty\":1}]','[{\"method\":\"CASH\",\"amount\":1000}]')")
    def operator_lock():
        with admin() as c: c.execute("update app.tenant set status='LOCKED' where id=%s", (t,))
        return True
    res = {}
    th = threading.Thread(target=lambda: res.setdefault("op", operator_lock())); th.start()
    time.sleep(1); waited = th.is_alive(); c1.commit(); c1.close(); th.join()
    ok2, m2 = sell(t, "e2", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    n = q1("select count(*) from app.sale where tenant_id=%s", (t,))
    good = waited and not ok2 and m2 == "ENTITLEMENT_LOCKED" and n == 1
    record("X-05", "DB integration (konkurensi)", "Operator mengunci paket saat transaksi kasir berjalan",
           "Transaksi berjalan selesai utuh; berikutnya ditolak", f"operator menunggu commit={waited}; transaksi berikutnya: {m2}; Sale={n}", good)

def x_cross_tenant_ids():
    a = new_tenant(); b = new_tenant()
    add_product(b, 7, 1000, loose=5, value=5000, can_open=True)
    _, sb = sell(b, "s", [{"product":7,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    _, eb = call(b, "select app.record_unmatched('x',1000)")
    r = {
      "refund faktur B": call(a, "select app.approve_refund('INVOICE',%s,1,'CASH')", (sb,))[1],
      "refund pengecualian B": call(a, "select app.approve_refund('EXC',%s,1,'CASH')", (eb,))[1],
      "buka karton produk B": call(a, "select app.open_carton(7,'A','x')")[1],
      "jual produk B": sell(a, "z", [{"product":7,"form":"LOOSE","batch":"A","qty":1}], [])[1],
      "koreksi faktur B": call(a, "select app.correct_invoice(%s,-1)", (sb,))[1],
      "cetak struk B": call(a, "select app.print_doc(%s,'PDF')", (sb,))[1],
    }
    good = all(v in ("TARGET_NOT_FOUND", "PRODUCT_NOT_FOUND", "INVOICE_NOT_FOUND", "SALE_NOT_FOUND") for v in r.values()) and stock(b, 7) == 4
    record("X-06", "DB integration", "Tenant A memanggil fungsi dengan ID objek milik B",
           "Semua ditolak, data B utuh", "; ".join(f"{k}: {v}" for k, v in r.items()), good)

def x_exception_flow():
    t = new_tenant()
    _, e = call(t, "select app.record_unmatched('bukti-9',200000)")
    _, a1 = call(t, "select app.approve_refund('EXC',%s,200000,'TRANSFER')", (e,))
    ok_dup, m_dup = call(t, "select app.approve_refund('EXC',%s,200000,'TRANSFER')", (e,))
    call(t, "select app.mark_sent(%s,'kirim')", (a1,))
    _, pay = call(t, "select app.record_refund_paid(%s,'debit')", (a1,))
    st1 = q1("select array[alloc,rf,q,waiting] from app.unmatched_receipt where id=%s", (e,))
    call(t, "select app.record_refund_returned(%s,'kredit balik')", (pay,))
    st2 = q1("select array[alloc,rf,q,waiting] from app.unmatched_receipt where id=%s", (e,))
    ok_re, _ = call(t, "select app.approve_refund('EXC',%s,200000,'TRANSFER')", (e,))
    st3 = q1("select array[alloc,rf,q,waiting] from app.unmatched_receipt where id=%s", (e,))
    good = not ok_dup and st1 == [0, 200000, 0, 0] and st2 == [0, 0, 0, 200000] and ok_re and st3 == [0, 0, 200000, 0]
    record("X-07", "DB integration", "Pengecualian Rp200.000: refund, dibayar, dana kembali, refund ulang",
           "Partisi selalu = 200.000; dana kembali menunggu Owner", f"approval ganda: {m_dup}; setelah bayar={st1}; setelah kembali={st2}; refund ulang={st3}", good)

def x_append_only():
    t = new_tenant(); add_product(t, 1, 1000, loose=1, value=500)
    r = {"ubah ledger": call(t, "update app.inventory_ledger set delta_qty=0 where tenant_id=%s", (t,))[1],
         "hapus audit": call(t, "delete from app.audit_event where tenant_id=%s", (t,))[1],
         "superuser hapus ledger": None}
    with admin() as c:
        try: c.execute("delete from app.inventory_ledger where tenant_id=%s", (t,)); r["superuser hapus ledger"] = "LOLOS"
        except psycopg.Error as e: r["superuser hapus ledger"] = e.diag.message_primary
    good = all("permission denied" in str(v) or "APPEND_ONLY" in str(v) for v in r.values())
    record("X-08", "DB integration", "Mengubah/menghapus ledger & audit",
           "Ditolak (termasuk superuser tanpa jalur purge)", "; ".join(f"{k}: {v}" for k, v in r.items()), good)

def x_load(n):
    t = new_tenant(); add_product(t, 1, 1000, loose=500, value=250000)
    token_for(t, "ADMIN")  # perbaikan alat uji: token dibuat sekali sebelum uji serentak, agar koneksi admin tidak melebihi max_connections
    lat, errs = [], {}
    lock = threading.Lock(); b = threading.Barrier(n)
    conns = [appconn() for _ in range(n)]
    def run(i):
        c = conns[i]; cur = c.cursor(); b.wait(); t0 = time.perf_counter()
        try:
            ctx(cur, t, "kasir")
            cur.execute("select app.finalize_sale(%s,%s::jsonb,%s::jsonb)", (f"L{n}-{i}", '[{"product":1,"form":"LOOSE","batch":"A","qty":1}]', '[{"method":"CASH","amount":1000}]'))
            c.commit(); k = "SUKSES"
        except psycopg.Error as e:
            c.rollback(); k = e.diag.message_primary
        dt = (time.perf_counter() - t0) * 1000
        with lock: lat.append(dt); errs[k] = errs.get(k, 0) + 1
    th = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    t0 = time.perf_counter(); [x.start() for x in th]; [x.join() for x in th]; wall = time.perf_counter() - t0
    for c in conns: c.close()
    s = stock(t, 1); pool = q1("select array[qty_base,value] from app.cost_pool where tenant_id=%s and status='READY'", (t,))
    hpp = q1("select coalesce(sum(hpp),0) from app.sale_line where tenant_id=%s", (t,))
    succ = errs.get("SUKSES", 0)
    lat.sort(); p50 = statistics.median(lat); p95 = lat[int(len(lat) * 0.95) - 1]
    good = succ == min(n, 500) and s == 500 - succ and pool[0] == s and hpp + pool[1] == 250000 and set(errs) <= {"SUKSES", "INSUFFICIENT_STOCK"}
    record(f"X-LOAD-{n}", "Load test eksperimen (1 SKU panas, 2 vCPU sandbox — BUKAN angka produksi)",
           f"{n} permintaan serentak membeli 1 unit dari stok 500", "Tanpa stok negatif/nilai hilang",
           f"hasil={errs}; stok akhir={s}; HPP+sisa nilai={hpp + pool[1]}; p50={p50:.0f} ms, p95={p95:.0f} ms, durasi={wall:.1f} s", good)

def x_load_pooled(total=1000, tenants=100, pool=40):
    ts = []
    for i in range(tenants):
        t = new_tenant(); add_product(t, 1, 1000, loose=50, value=25000); ts.append(t)
    jobs = list(range(total)); lat = []; errs = {}; lock = threading.Lock()
    def worker():
        c = appconn(); cur = c.cursor()
        while True:
            with lock:
                if not jobs: break
                i = jobs.pop()
            t0 = time.perf_counter()
            try:
                ctx(cur, ts[i % tenants], "kasir")
                cur.execute("select app.finalize_sale(%s,%s::jsonb,%s::jsonb)", (f"P{i}", '[{"product":1,"form":"LOOSE","batch":"A","qty":1}]', '[{"method":"CASH","amount":1000}]'))
                c.commit(); k = "SUKSES"
            except psycopg.Error as e:
                c.rollback(); k = e.diag.message_primary
            with lock: lat.append((time.perf_counter() - t0) * 1000); errs[k] = errs.get(k, 0) + 1
        c.close()
    th = [threading.Thread(target=worker) for _ in range(pool)]
    t0 = time.perf_counter(); [x.start() for x in th]; [x.join() for x in th]; wall = time.perf_counter() - t0
    lat.sort(); p50 = statistics.median(lat); p95 = lat[int(len(lat) * 0.95) - 1]
    left = q1("select sum(qty) from app.stock where tenant_id = any(%s)", ([str(x) for x in ts],))
    good = errs == {"SUKSES": total} and left == tenants * 50 - total
    record("X-LOAD-POOL", "Load test eksperimen (pool 40 koneksi, 2 vCPU sandbox — BUKAN angka produksi)",
           f"{total} transaksi tersebar di {tenants} tenant lewat pool {pool} koneksi", "Semua sukses, stok konsisten",
           f"hasil={errs}; sisa stok={left}; p50={p50:.0f} ms, p95={p95:.0f} ms, throughput={total / wall:.0f} transaksi/detik", good)

# ------------------------------------------------------------------ UJI NEGATIF (revisi 2)
def n01_fk_cross_tenant():
    a = new_tenant(); b = new_tenant()
    add_product(a, 1, 1000, loose=5, value=5000); add_product(b, 1, 1000, loose=5, value=5000)
    _, sb = sell(b, "nb", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    _, eb = call(b, "select app.record_unmatched('nb-exc',1000)")
    with admin() as c:   # Sale B tanpa faktur, agar uji tidak tertahan PK lebih dulu
        # Jalur istimewa: pemeriksaan hak saat COMMIT (R3-3) juga menolak Sale tanpa sesi sah,
        # jadi baris uji ini dibuat dengan trigger dimatikan (hanya mungkin bagi superuser).
        c.execute("set session_replication_role = replica")
        sb_bare = c.execute("insert into app.sale(tenant_id,idem_key,request_hash,total) values (%s,'bare','x',0) returning id", (b,)).fetchone()[0]
    r = {}
    # kasus terburuk: kode yang berjalan dengan hak pemilik/superuser (RLS terlewati) — FK komposit tetap menolak
    with admin() as c:
        for label, sql, prm in [
            ("payment A→Sale B", "insert into app.payment(tenant_id,sale_id,method,amount) values (%s,%s,'CASH',1)", (a, sb)),
            ("invoice A→Sale B (Sale B tanpa faktur)", "insert into app.invoice(tenant_id,sale_id,f) values (%s,%s,1)", (a, sb_bare)),
            ("dokumen A→Sale B", "insert into app.document_print(tenant_id,sale_id,is_copy,channel) values (%s,%s,false,'PDF')", (a, sb)),
            ("refund A→pengecualian B", "insert into app.refund_approval(tenant_id,target_kind,target_id,exc_id,method,amount,state) values (%s,'EXC',%s,%s,'CASH',1,'APPROVED_NOT_SENT')", (a, eb, eb)),
            ("stok A→produk tak ada", "insert into app.cost_pool values (%s,99,'READY',1,1)", (a,)),
        ]:
            try: c.execute(sql, prm); r[label] = "LOLOS"
            except psycopg.Error as e: r[label] = e.sqlstate
    # jalur aplikasi: app_user tidak punya DML langsung sama sekali
    with appconn() as c:
        cur = c.cursor(); ctx(cur, a)
        try: cur.execute("insert into app.payment(tenant_id,sale_id,method,amount) values (%s,%s,'CASH',1)", (a, sb)); r["app_user insert langsung"] = "LOLOS"
        except psycopg.Error as e: r["app_user insert langsung"] = e.diag.message_primary
        c.rollback()
    good = all(v == "23503" for k, v in r.items() if k != "app_user insert langsung") and "permission denied" in r["app_user insert langsung"]
    record("N-01", "Negatif — FK komposit lintas tenant", "Referensi tenant A ke objek tenant B (termasuk via hak pemilik)",
           "Ditolak FK (23503); app_user tanpa DML", "; ".join(f"{k}: {v}" for k, v in r.items()), good)

def n02_open_carton_no_loose():
    t = new_tenant()
    with admin() as c:
        c.execute("insert into app.product values (%s,2,'K',12,true,1000)", (t,))
        c.execute("insert into app.stock values (%s,2,'SEALED','A','READY',2)", (t,))      # TANPA baris LOOSE
        c.execute("insert into app.cost_pool values (%s,2,'READY',24,24000)", (t,))
    ok, m = call(t, "select app.open_carton(2,'A','buka')")
    sealed, loose = stock(t, 2, "SEALED"), stock(t, 2, "LOOSE")
    pool = q1("select qty_base from app.cost_pool where tenant_id=%s and product_id=2 and status='READY'", (t,))
    ok2, m2 = call(t, "select app.open_carton(2,'A','buka2')")
    ok3, m3 = call(t, "select app.open_carton(2,'A','buka3')")          # karton habis
    eq = stock(t, 2, "SEALED") * 12 + stock(t, 2, "LOOSE")
    good = ok and sealed == 1 and loose == 12 and pool == 24 and ok2 and not ok3 and m3 == "NO_SEALED_STOCK" and eq == 24
    record("N-02", "Negatif — buka karton tanpa baris LOOSE", "2 karton isi 12, baris unit lepas belum ada",
           "Unit lepas dibuat; ekuivalen tetap 24", f"buka-1: sealed={sealed}, loose={loose}, kolam={pool}; buka-2 ok; buka-3: {m3}; ekuivalen akhir={eq}", good)

def n03_idem_different_payload():
    t = new_tenant(); add_product(t, 1, 1000, loose=10, value=10000)
    l1 = [{"product":1,"form":"LOOSE","batch":"A","qty":1}]; l3 = [{"product":1,"form":"LOOSE","batch":"A","qty":3}]
    r1 = sell(t, "K-1", l1, [{"method":"CASH","amount":1000}])
    r2 = sell(t, "K-1", l3, [{"method":"CASH","amount":3000}])          # key sama, isi beda
    r3 = sell(t, "K-1", l1, [{"method":"CASH","amount":1000}])          # retry identik
    # bersamaan: key sama, isi beda
    def backend(lines, pay):
        ok, r = sell(t, "K-2", lines, pay)
        if not ok and "duplicate key" in r: ok, r = sell(t, "K-2", lines, pay)
        return ok, r
    rr = race([lambda: backend(l1, [{"method":"CASH","amount":1000}]), lambda: backend(l3, [{"method":"CASH","amount":3000}])])
    _, e1 = call(t, "select app.record_unmatched('U-1',200000)")
    ue = call(t, "select app.record_unmatched('U-1',250000)")
    n = q1("select count(*) from app.sale where tenant_id=%s", (t,)); s = stock(t, 1)
    good = (r1[0] and not r2[0] and r2[1] == "IDEMPOTENCY_KEY_REUSED" and r3 == r1 and sum(x[0] for x in rr) == 1
            and any(x[1] == "IDEMPOTENCY_KEY_REUSED" for x in rr) and not ue[0] and ue[1] == "IDEMPOTENCY_KEY_REUSED" and n == 2)
    record("N-03", "Negatif — idempotency key sama, payload berbeda", "qty 1 lalu qty 3 dengan key sama; bersamaan; pengecualian nominal beda",
           "Ditolak IDEMPOTENCY_KEY_REUSED; retry identik tetap Sale yang sama",
           f"isi beda: {r2[1]}; retry identik sama={r3 == r1}; bersamaan: {[x[1] if not x[0] else 'SUKSES' for x in rr]}; pengecualian: {ue[1]}; Sale={n}; stok={s}", good)

def n04_invalid_values():
    t, sl = setup_invoice()                       # faktur 1.000.000, bayar 900.000; stok habis
    with admin() as c:                            # isi ulang 1 unit agar uji "bayar negatif" sampai ke validasi bayar
        c.execute("update app.stock set qty = 1 where tenant_id=%s and product_id=1 and form='LOOSE'", (t,))
        c.execute("update app.cost_pool set qty_base = 1, value = 100000 where tenant_id=%s and product_id=1 and status='READY'", (t,))
    before = inv(t, sl)
    L1 = [{"product":1,"form":"LOOSE","batch":"A","qty":1}]
    r = {
      "qty 0": sell(t, "z0", [{"product":1,"form":"LOOSE","batch":"A","qty":0}], [])[1],
      "qty negatif": sell(t, "z1", [{"product":1,"form":"LOOSE","batch":"A","qty":-2}], [])[1],
      "bayar negatif": sell(t, "z2", L1, [{"method":"CASH","amount":-5}])[1],
      "keranjang kosong": sell(t, "z3", [], [])[1],
      "refund 0": call(t, "select app.approve_refund('INVOICE',%s,0,'CASH')", (sl,))[1],
      "refund negatif": call(t, "select app.approve_refund('INVOICE',%s,-100,'CASH')", (sl,))[1],
      "retur qty 0": call(t, "select app.return_line(%s,1,0)", (sl,))[1],
      "retur melebihi": call(t, "select app.return_line(%s,1,99)", (sl,))[1],
      "koreksi 0": call(t, "select app.correct_invoice(%s,0)", (sl,))[1],
      "pengecualian 0": call(t, "select app.record_unmatched('z',0)")[1],
      "jenis target asing": call(t, "select app.approve_refund('LAIN',%s,1,'CASH')", (sl,))[1],
    }
    mid = inv(t, sl); stock_mid = stock(t, 1); sales_mid = q1("select count(*) from app.sale where tenant_id=%s", (t,))
    call(t, "select app.return_line(%s,1,1)", (sl,))                      # sah: refund terutang 150.000
    _, appr = call(t, "select app.approve_refund('INVOICE',%s,100,'CASH')", (sl,))
    r["bukti kosong"] = call(t, "select app.record_refund_paid(%s,'  ')", (appr,))[1]
    rf_after = inv(t, sl)[4]
    expected = {"qty 0": "INVALID_QTY", "qty negatif": "INVALID_QTY", "bayar negatif": "INVALID_AMOUNT", "keranjang kosong": "EMPTY_CART",
                "refund 0": "INVALID_AMOUNT", "refund negatif": "INVALID_AMOUNT", "retur qty 0": "INVALID_QTY", "retur melebihi": "RETURN_EXCEEDS_LINE",
                "koreksi 0": "INVALID_AMOUNT", "pengecualian 0": "INVALID_AMOUNT", "jenis target asing": "INVALID_TARGET_KIND", "bukti kosong": "EVIDENCE_REQUIRED"}
    bad = {k: v for k, v in r.items() if v != expected[k]}
    good = not bad and mid == before and stock_mid == 1 and sales_mid == 1 and rf_after == 0
    record("N-04", "Negatif — nilai tidak sah", "qty 0/negatif, nominal 0/negatif, keranjang kosong, retur berlebih, jenis target asing, bukti kosong",
           "Ditolak dengan kode jelas; saldo, stok, Sale tidak berubah",
           ("12/12 ditolak sesuai kode" if not bad else f"TIDAK SESUAI: {bad}") + f"; faktur tetap={mid == before}; stok tetap={stock_mid}; Sale={sales_mid}; Rf setelah bukti kosong={rf_after}", good)

def n05_no_direct_dml():
    t = new_tenant()
    tables = ["product","stock","cost_pool","inventory_ledger","sale","sale_line","return_line","invoice","payment","unmatched_receipt",
              "refund_approval","refund_attempt","refund_payment","refund_returned","cash_movement","document_print","audit_event","tenant"]
    allowed = []
    for tb in tables:
        for op, sql in [("UPDATE", f"update app.{tb} set tenant_id=tenant_id" if tb != "tenant" else "update app.tenant set name=name"),
                        ("DELETE", f"delete from app.{tb}")]:
            with appconn() as c:
                cur = c.cursor(); ctx(cur, t)
                try: cur.execute(sql); allowed.append(f"{op} {tb}")
                except psycopg.Error as e:
                    if "permission denied" not in (e.diag.message_primary or ""): allowed.append(f"{op} {tb}: {e.diag.message_primary}")
                c.rollback()
    record("N-05", "Negatif — DML langsung oleh app_user", f"UPDATE/DELETE pada {len(tables)} tabel",
           "Semua permission denied", "semua ditolak" if not allowed else f"LOLOS: {allowed}", not allowed)

def n06_functions_without_context():
    calls = ["select app.finalize_sale('x','[{\"product\":1,\"form\":\"LOOSE\",\"batch\":\"A\",\"qty\":1}]','[]')",
             "select app.open_carton(1,'A','x')", "select app.hold_batch(1,'A')", "select app.return_line(1,1,1)",
             "select app.correct_invoice(1,1)", "select app.record_unmatched('x',1)", "select app.approve_refund('INVOICE',1,1,'CASH')",
             "select app.mark_sent(1,'x')", "select app.cancel_approval(1)", "select app.record_refund_paid(1,'x')",
             "select app.record_refund_returned(1,'x')", "select app.print_doc(1,'PDF')"]
    bad = []
    for sql in calls:
        with appconn() as c:
            try: c.execute(sql); bad.append(sql)
            except psycopg.Error as e:
                if e.diag.message_primary != "NO_TENANT_CONTEXT": bad.append(f"{sql} -> {e.diag.message_primary}")
            c.rollback()
    record("N-06", "Negatif — 12 fungsi dipanggil tanpa konteks tenant", "Semua fungsi perubahan data",
           "NO_TENANT_CONTEXT", "semua ditolak NO_TENANT_CONTEXT" if not bad else f"TIDAK SESUAI: {bad}", not bad)

def n07_internal_functions_not_callable():
    r = {}
    for sql in ["select app.audit('x','y')", "select app.split(1,1,1)", "select app.require_tenant()"]:
        with appconn() as c:
            try: c.execute(sql); r[sql] = "LOLOS"
            except psycopg.Error as e: r[sql] = e.diag.message_primary
            c.rollback()
    good = all("permission denied" in v for v in r.values())
    record("N-07", "Negatif — fungsi internal dipanggil app_user", "audit/split/require_tenant", "permission denied", "; ".join(f"{k}: {v}" for k, v in r.items()), good)

def n08_tenant_impersonation():
    """Audit R2-01: penyerang punya eksekusi SQL sebagai app_user (mis. injeksi) dan mencoba menjadi tenant B."""
    a = new_tenant(); b = new_tenant()
    add_product(b, 1, 1000, loose=5, value=5000)
    _, sb = sell(b, "imp", [{"product":1,"form":"LOOSE","batch":"A","qty":1}], [{"method":"CASH","amount":1000}])
    ta = token_for(a, "OWNER")
    tok_rev = token_for(b, "ADMIN")
    with admin() as c: c.execute("update iam.session set revoked_at = now() where token_hash = encode(sha256(convert_to(%s,'UTF8')),'hex')", (tok_rev,))
    r = {}
    def attempt(label, setup_sqls):
        with psycopg.connect(**APP) as c:
            cur = c.cursor()
            for q, prm in setup_sqls: cur.execute(q, prm)
            n = cur.execute("select count(*) from app.sale where tenant_id=%s", (b,)).fetchone()[0]
            try: cur.execute("select app.correct_invoice(%s,-1)", (sb,)); w = "LOLOS"
            except psycopg.Error as e: w = e.diag.message_primary
            r[label] = f"baca B={n}, ubah B={w}"; c.rollback()
    attempt("GUC lama app.tenant_id=B", [("select set_config('app.tenant_id',%s,true)", (str(b),))])
    attempt("GUC tenant B tingkat sesi", [("select set_config('app.tenant_id',%s,false)", (str(b),))])
    attempt("token karangan", [("select set_config('app.session_token',%s,true)", ("token-karangan-123",))])
    attempt("token sah milik A", [("select set_config('app.session_token',%s,true)", (ta,))])
    attempt("token B yang sudah dicabut", [("select set_config('app.session_token',%s,true)", (tok_rev,))])
    with psycopg.connect(**APP) as c:
        try: c.execute("select count(*) from iam.session"); r["baca tabel sesi"] = "LOLOS"
        except psycopg.Error as e: r["baca tabel sesi"] = e.diag.message_primary
    good = all(v.startswith("baca B=0") and "LOLOS" not in v for k, v in r.items() if k != "baca tabel sesi") and "permission denied" in r["baca tabel sesi"]
    record("N-08", "Negatif — impersonasi tenant lewat SQL (audit R2-01)", "app_user memalsukan konteks: GUC lama, token karangan, token tenant lain, token dicabut",
           "Tidak bisa membaca/mengubah data B; tabel sesi tertutup", "; ".join(f"{k}: {v}" for k, v in r.items()), good)

def n09_owner_only_in_db():
    t, s = setup_invoice()
    call(t, "select app.return_line(%s,1,1)", (s,))
    _, appr = call(t, "select app.approve_refund('INVOICE',%s,50000,'CASH')", (s,))
    checks = {
      "retur": "select app.return_line(%s,1,1)" % s,
      "koreksi": "select app.correct_invoice(%s,-1)" % s,
      "setujui refund": "select app.approve_refund('INVOICE',%s,1,'CASH')" % s,
      "batalkan approval": "select app.cancel_approval(%s)" % appr,
      "catat refund dibayar": "select app.record_refund_paid(%s,'bukti')" % appr,
      "catat dana kembali": "select app.record_refund_returned(999999,'bukti')",
    }
    adm = {k: call(t, q, actor="admin")[1] for k, q in checks.items()}
    allowed = {"jual": sell(t, "adm-1", [], [])[1], "tahan batch": call(t, "select app.hold_batch(1,'A')", actor="admin")[0],
               "tandai terkirim (tunai → INVALID_STATE)": call(t, "select app.mark_sent(%s,'x')", (appr,), actor="admin")[1]}
    owner_ok = call(t, "select app.correct_invoice(%s,-1)", (s,))[0]
    good = all(v == "FORBIDDEN_ROLE" for v in adm.values()) and owner_ok and allowed["tahan batch"] is True and allowed["jual"] == "EMPTY_CART"
    record("N-09", "Negatif — otorisasi peran di database (audit R2-01)", "Sesi ADMIN memanggil 6 fungsi khusus Owner langsung lewat SQL",
           "Semua FORBIDDEN_ROLE; Owner tetap bisa", "; ".join(f"{k}: {v}" for k, v in adm.items()) + f"; Owner koreksi={owner_ok}; fungsi Admin yang sah tetap jalan={allowed}", good)

if __name__ == "__main__":
    for f in (t01, t02, t03, t04, t05, t06, t06b, t07, t08, t09, t10, x_return_vs_refund, x_carton, x_hold,
              x_correction, x_entitlement_change, x_cross_tenant_ids, x_exception_flow, x_append_only,
              n01_fk_cross_tenant, n02_open_carton_no_loose, n03_idem_different_payload, n04_invalid_values,
              n05_no_direct_dml, n06_functions_without_context, n07_internal_functions_not_callable,
              n08_tenant_impersonation, n09_owner_only_in_db):
        try: f()
        except Exception as e:
            record(f.__name__, "ERROR", "", "", f"HARNESS ERROR: {e!r}", False)
    try: x_load_pooled()
    except Exception as e: record("X-LOAD-POOL", "ERROR", "", "", f"HARNESS ERROR: {e!r}", False)
    for n in (100, 1000):
        try: x_load(n)
        except Exception as e: record(f"X-LOAD-{n}", "ERROR", "", "", f"HARNESS ERROR: {e!r}", False)
    json.dump(RESULTS, open(os.path.join(RESULTS_DIR, "db_results.json"), "w"), ensure_ascii=False, indent=1)
    print(f"\nPASS {sum(r['status']=='PASS' for r in RESULTS)}/{len(RESULTS)}")
