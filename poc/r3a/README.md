# PoC Arsitektur Kandidat A — paket uji yang dapat dijalankan ulang

Paket ini membuktikan **model transaksi dan kontrol keamanan** untuk PRD V1.1. Isinya:

- **PostgreSQL:** 31 skenario uji (T-01..T-10, T-06b, X-01..X-08, N-01..N-09, uji beban).
- **API TypeScript (Fastify + pg):** 15 uji, dijalankan langsung ke database dan lewat pooler.
- **Pooler mode transaksi (PgBouncer):** 4 uji.
- **PITR:** base backup + arsip WAL + `recovery_target_time` + tombstone.
- **Uji meta:** setup wajib gagal bila migrasi SQL error.
- **CI:** `ci/poc-regression.yml` (GitHub Actions). **Belum pernah dijalankan di GitHub.**

> **Bukan kode produksi.** Lulus di sini membuktikan modelnya, bukan keamanan aplikasi final. `auth_type=trust` dan `DEV_EXPOSE_OTP` hanya untuk uji lokal.

## Revisi 3 — menutup audit R2 (8 Nov 2026)

| Temuan R2 | Perbaikan | Bukti uji |
|---|---|---|
| **R2-01** Konteks tenant bisa dipalsukan oleh role SQL; fungsi persetujuan tanpa cek peran | Backend mengirim **token sesi mentah** (lokal transaksi). Database memverifikasi token ke `iam.session`, tabel yang **tidak dapat dibaca** `app_user`, lalu menurunkan tenant, aktor, dan peran. GUC `app.tenant_id` tidak dipakai lagi. Enam fungsi persetujuan memeriksa peran **OWNER di database**. Aktor audit diambil dari sesi, bukan GUC | N-08 (GUC palsu, token karangan, token tenant lain, token dicabut → tidak bisa baca/ubah data B; tabel sesi tertutup); N-09 (sesi ADMIN → `FORBIDDEN_ROLE` di 6 fungsi) |
| **R2-02** Batas waktu diperiksa sebelum COMMIT | **Constraint trigger DEFERRED** memeriksa hak paket **di dalam proses COMMIT**; `track_commit_timestamp=on` untuk verifikasi | T-06b: fungsi selesai sebelum batas, COMMIT ditahan 3,5 dtk → **ditolak** `ENTITLEMENT_EXPIRED_AT_COMMIT`, tanpa posting; kontrol: cap waktu commit < batas |
| **R2-03** Setup menelan error migrasi | `\|\| true` dihapus; `ON_ERROR_STOP` + `set -e`; penghapusan runtime dijaga file penanda | META-01: migrasi sengaja salah → setup exit 3 |
| Lain-lain | `.gitignore`, tanpa `__pycache__`; workflow CI dengan runtime khusus job | — |

**Sisa batas yang dinyatakan terbuka:**
- **Jeda di dalam COMMIT.** Pemeriksaan berjalan di dalam COMMIT, tetapi catatan commit ditulis beberapa mikrodetik setelahnya. Tidak ada sistem database yang memeriksa tepat pada detik catatan commit ditulis. Batas ini harus disebut eksplisit di SAD dan diputuskan pemilik, tidak boleh diam-diam dianggap memenuhi PRD.
- **Klien dapat memajukan pemeriksaan.** Klien bisa menjalankan `SET CONSTRAINTS ALL IMMEDIATE`, sehingga pemeriksaan terjadi lebih awal. Pengaman: audit pasca-commit membandingkan `pg_xact_commit_timestamp` dengan batas hak.
- **Biaya keamanan.** Verifikasi token per fungsi menurunkan throughput uji beban berpool dari ±1.470 ke ±820 transaksi/detik (p95 61 → 152 ms; sandbox 2 vCPU). Masih jauh di atas kebutuhan puncak simulasi (±111 tx/dtk pada 10.000 kios). Optimasi (misalnya cache sesi per transaksi yang tidak dapat ditulis `app_user`) menjadi tugas desain SAD.

## Revisi 2 — menutup temuan auditor (8 Nov 2026)

Ketiga celah berikut **terbukti ada** di revisi 1 (direproduksi sebelum diperbaiki), lalu ditutup:

| Temuan | Bukti di revisi 1 | Perbaikan | Uji negatif |
|---|---|---|---|
| FK lintas tenant | `app_user` tenant A berhasil mencatat pembayaran yang menunjuk Sale tenant B | FK komposit `(tenant_id, id)` di semua relasi; `app_user` **tanpa DML langsung**; perubahan data hanya lewat fungsi `SECURITY DEFINER` milik `app_owner` (NOBYPASSRLS, RLS FORCE tetap berlaku) | N-01, N-05, N-06, N-07 |
| Buka karton tanpa baris LOOSE | Karton 2→1, tetapi **12 unit hilang** karena baris unit lepas tidak ada | Baris LOOSE dibuat bila belum ada; jumlah baris yang terubah diverifikasi | N-02 |
| Idempotency key dengan isi berbeda | Key sama, qty 1 lalu qty 3 → Sale lama dikembalikan diam-diam | Key terikat hash isi request; isi beda → `IDEMPOTENCY_KEY_REUSED` (API 422); berlaku juga untuk pengecualian pembayaran | N-03, API-14 |

Tambahan: validasi nilai tidak sah (N-04), dan cap waktu Sale = pemeriksaan hak terakhir (AS-11, T-06).

> **Status skema:** tetap **PoC, bukan desain database produksi**. Desain produksi ditetapkan di SAD dan diuji ulang dengan paket ini sebagai uji regresi minimum.

## Prasyarat (versi yang dipakai saat validasi)

| Komponen | Versi tervalidasi |
|---|---|
| Linux (bash) | Ubuntu 24.04 |
| PostgreSQL server + client | 16.15 (`PG_BIN` menunjuk ke folder `bin`-nya) |
| PgBouncer | 1.22.0 (minimal 1.21, karena butuh `max_prepared_statements`) |
| Python | 3.13, dengan `psycopg[binary]` 3.3.x |
| Node.js | 22.23 (dependensi dikunci di `api/package-lock.json`) |

Contoh pemasangan di Ubuntu: `apt-get install postgresql-16 pgbouncer nodejs python3-pip`.

## Menjalankan

```bash
bash scripts/setup.sh      # membuat cluster baru, PgBouncer, skema, dan memasang dependensi
bash scripts/run_all.sh    # menjalankan semua uji; ringkasan PASS/FAIL di akhir; exit 1 bila ada FAIL
bash scripts/teardown.sh   # menghentikan semua proses
```

- Semua port dan path bisa ditimpa lewat variabel lingkungan (lihat `scripts/env.sh`): `PG_PORT`, `PGB_PORT`, `PITR_SRC_PORT`, `PITR_RST_PORT`, `POC_RUNTIME`, `PG_BIN`, `RUN_AS`.
- Bila dijalankan sebagai root, skrip membuat user OS `pgpoc`, karena PostgreSQL dan PgBouncer menolak berjalan sebagai root.

## Hasil

Ditulis ke `results/`:
- `db_results.json`
- `pooler_results.json`
- `api_results_direct.json`
- `api_results_pgbouncer.json`
- `pitr_results.json`
- log per tahap

## Peta uji → persyaratan

| Berkas | Uji | Persyaratan PRD / temuan |
|---|---|---|
| `tests/run_tests.py` | T-01..T-10, X-01..X-08, X-LOAD | POS-01/06, INV-08, RET-06..10, EXC-01..08, ENT-04/09, SEC-01/14 |
| `tests/pooler_test.py` | P-01..P-04 | Konteks tenant hanya lokal transaksi (AS-10); P-02 adalah kontrol negatif yang **sengaja** menunjukkan kebocoran bila desain salah |
| `api/api_tests.ts` | API-01..API-13 (+07b) | AUTH-01..06, SEC-01..06, ENT-02/05/08; API-02 = penolakan input asing (AS-09) |
| `tests/pitr_test.py` | PITR | ENT-09, C-04, ST-SEC-21/24 |
| `tests/run_tests.py` T-06 | Cap waktu Sale < batas hak | Batas commit trial (AS-11) |
| `tests/run_tests.py` N-01..N-07 | Uji negatif | FK lintas tenant, buka karton tanpa LOOSE, idempotency isi beda, nilai tidak sah, DML langsung, fungsi tanpa konteks, fungsi internal |
| `api/api_tests.ts` API-14 | Idempotency-Key isi beda lewat HTTP | POS-06, ST-POS-01 |
| `tests/run_tests.py` T-06b, N-08, N-09 | COMMIT tertahan melewati batas; impersonasi tenant via SQL; peran Owner di DB | ST-SUB-02, SEC-01/02/04, AUTH-05 |
| `tests/meta_setup_fails.sh` | META-01 | Integritas migrasi (audit R2-03) |

## Batas

Berikut **BELUM DIUJI** di paket ini dan menjadi gerbang awal implementasi:
- PITR layanan terkelola (AWS RDS / Cloud SQL);
- Hyperdrive asli;
- uji perangkat HP M-01..M-08;
- uji penetrasi;
- kesetaraan waktu respons login.
