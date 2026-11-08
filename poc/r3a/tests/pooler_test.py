"""
Uji pooler MODE TRANSAKSI (PgBouncer 1.22, pool_mode=transaction, default_pool_size=2).
Pengganti terdekat untuk perilaku Hyperdrive (yang juga mode transaksi).
Hyperdrive ASLI tetap BELUM DIUJI (butuh akun Cloudflare).
"""
import json, threading, uuid, psycopg, os
SOCK = os.environ.get("POC_SOCK", "/tmp"); PG_PORT = int(os.environ.get("PG_PORT", "55432")); PGB_PORT = int(os.environ.get("PGB_PORT", "6432"))
RESULTS_DIR = os.environ.get("POC_RESULTS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results")); os.makedirs(RESULTS_DIR, exist_ok=True)
PGB = dict(host="127.0.0.1", port=PGB_PORT, dbname="poc")
DIRECT = dict(host=SOCK, port=PG_PORT, dbname="poc", user="postgres")
out = []
def rec(i, k, h, a, ok):
    out.append(dict(id=i, jenis="DB via PgBouncer mode transaksi", kondisi=k, harapan=h, aktual=a, status="PASS" if ok else "FAIL"))
    print(f"[{'PASS' if ok else 'FAIL'}] {i}: {a}")

import secrets
TOK = {}
def token(t):
    if t not in TOK:
        tok = secrets.token_urlsafe(32); uid = uuid.uuid4()
        with psycopg.connect(**DIRECT, autocommit=True) as c:
            c.execute("insert into iam.app_user_account values (%s,%s,%s,'x','OWNER')", (uid, t, "+62" + uid.hex[:12]))
            c.execute("insert into iam.session values (encode(sha256(convert_to(%s,'UTF8')),'hex'),%s,%s,'OWNER', now()+interval '1 day', null)", (tok, uid, t))
        TOK[t] = tok
    return TOK[t]

def tenant_with_sale():
    t = uuid.uuid4()
    with psycopg.connect(**DIRECT, autocommit=True) as c:
        c.execute("insert into app.tenant values (%s,'p','PRO','ACTIVE', now()+interval '30 days')", (t,))
        c.execute("insert into app.product values (%s,1,'S',1,false,1000)", (t,))
        c.execute("insert into app.stock values (%s,1,'LOOSE','A','READY',1),(%s,1,'SEALED','A','READY',0)", (t, t))
        c.execute("insert into app.cost_pool values (%s,1,'READY',1,500)", (t,))
    return t

A, B = tenant_with_sale(), tenant_with_sale()
with psycopg.connect(**PGB, user="app_user") as c:
    cur = c.cursor(); cur.execute("select set_config('app.session_token',%s,true)", (token(A),))
    cur.execute("select app.finalize_sale('pa','[{\"product\":1,\"form\":\"LOOSE\",\"batch\":\"A\",\"qty\":1}]','[{\"method\":\"CASH\",\"amount\":1000}]')"); c.commit()

# P-01: konteks LOKAL transaksi tidak bocor ke klien lain yang memakai koneksi server yang sama
leak_local = 0
for i in range(300):
    with psycopg.connect(**PGB, user="app_user") as c1:
        cur = c1.cursor(); cur.execute("select set_config('app.session_token',%s,true)", (token(A),)); cur.execute("select count(*) from app.sale"); c1.commit()
    with psycopg.connect(**PGB, user="app_user") as c2:     # klien lain, TANPA konteks
        n = c2.execute("select count(*) from app.sale").fetchone()[0]; c2.commit()
        if n != 0: leak_local += 1
rec("P-01", "300x: klien 1 memakai konteks lokal A, klien 2 tanpa konteks", "Klien 2 selalu 0 baris", f"kebocoran={leak_local}/300", leak_local == 0)

# P-02 (kontrol negatif): konteks tingkat SESI memang BOCOR lewat pooler -> wajib lokal
leak_session = 0
for i in range(50):
    with psycopg.connect(**PGB, user="app_user", autocommit=True) as c1:
        c1.execute("select set_config('app.session_token',%s,false)", (token(A),))   # SALAH: tingkat sesi
    with psycopg.connect(**PGB, user="app_user", autocommit=True) as c2:
        if c2.execute("select count(*) from app.sale").fetchone()[0] > 0: leak_session += 1
rec("P-02", "Kontrol negatif: set_config tingkat sesi lewat pooler", "Membuktikan kebocoran bila desain salah",
    f"klien tanpa konteks melihat data A pada {leak_session}/50 percobaan", leak_session > 0)
with psycopg.connect(**DIRECT, autocommit=True) as c:   # bersihkan sisa sesi di koneksi server pool
    c.execute("select pg_terminate_backend(pid) from pg_stat_activity where usename='app_user'")

# P-03: race stok terakhir lewat pooler (pool server 2 koneksi, 20 klien)
viol = 0
for r in range(40):
    t = tenant_with_sale(); b = threading.Barrier(20); res = []
    def go(k):
        b.wait()
        try:
            with psycopg.connect(**PGB, user="app_user") as c:
                cur = c.cursor(); cur.execute("select set_config('app.session_token',%s,true)", (token(t),))
                cur.execute("select app.finalize_sale(%s,'[{\"product\":1,\"form\":\"LOOSE\",\"batch\":\"A\",\"qty\":1}]','[{\"method\":\"CASH\",\"amount\":1000}]')", (f"r{k}",))
                c.commit(); res.append(1)
        except psycopg.Error: res.append(0)
    th = [threading.Thread(target=go, args=(k,)) for k in range(20)]; [x.start() for x in th]; [x.join() for x in th]
    with psycopg.connect(**DIRECT) as c:
        q = c.execute("select qty from app.stock where tenant_id=%s and form='LOOSE'", (t,)).fetchone()[0]
    if sum(res) != 1 or q != 0: viol += 1
rec("P-03", "40 putaran x 20 kasir berebut stok 1 lewat pooler", "Tepat 1 sukses", f"{40 - viol}/40 putaran benar", viol == 0)

# P-04: prepared statement driver (psycopg menyiapkan otomatis setelah 5x eksekusi) lewat pooler
ok = True
try:
    with psycopg.connect(**PGB, user="app_user") as c:
        for i in range(30):
            cur = c.cursor(); cur.execute("select set_config('app.session_token',%s,true)", (token(B),))
            cur.execute("select count(*) from app.stock where qty >= %s", (0,)); c.commit()
except psycopg.Error as e:
    ok = False; err = str(e)
rec("P-04", "30x query berulang (prepared statement otomatis driver) lewat pooler", "Tanpa error", "OK" if ok else err, ok)
json.dump(out, open(os.path.join(RESULTS_DIR, "pooler_results.json"), "w"), indent=1, ensure_ascii=False)
