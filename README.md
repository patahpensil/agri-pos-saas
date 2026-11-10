# SaaS Penjualan Pupuk, Pestisida, dan Alat Pertanian

**Status:** PRD V1.1 FINAL disahkan pemilik. Arsitektur A ditetapkan sebagai arsitektur resmi SAD. Dokumen arsitektur adalah rancangan teknis; belum ada layanan atau aplikasi produksi.

## Dokumen kanonis

- [PRD V1.1 FINAL](docs/PRD_V1_1_FINAL.md) — requirement bisnis; perubahan wajib change request dan persetujuan pemilik.
- [SAD V1.0](docs/SAD_V1_0_ARSITEKTUR_A.md) — arsitektur Flutter, NestJS/TypeScript, PostgreSQL, pooler transaksi, Cloudflare.
- [Rancangan database](docs/DATABASE_DESIGN_V1_0.md), [kontrak API](docs/API_CONTRACT_V1_0.md), [standar keamanan](docs/SECURITY_TEST_PLAN_V1_0.md).
- [ADR-001](docs/ADR_001_ARSITEKTUR_A.md) dan [ADR-002](docs/ADR_002_GITHUB_LAB.md) — keputusan pemilik.
- Matriks requirement dan acceptance test: `docs/TRACEABILITY_*.csv`.

**Memperbarui matriks pelacakan:** Setiap PR yang menambah atau memperluas uji CI wajib memperbarui `TRACEABILITY_REQUIREMENTS.csv` dan `TRACEABILITY_ACCEPTANCE_TESTS.csv` pada PR yang sama. Status PASS hanya boleh diberikan bila seluruh hasil yang diwajibkan PRD benar-benar dibuktikan oleh uji aplikasi, API, atau database; cakupan sebagian tetap PARTIAL/BELUM_DIUJI. Pemeriksaan `docs-integrity` menolak klaim tanpa ID uji yang terdaftar di `backend/test/ci_gate.py` dan menjaga hash PRD tetap sama.

## Alur kerja

- Repository **private**; perubahan kode dan dokumen substantif melalui **branch → Pull Request → pemeriksaan → review pemilik → merge**.
- GitHub Actions untuk laboratorium awal; perintah `python3 scripts/verify_docs.py` hanya menguji **integritas dokumen**.
- Bukti PoC R3 (67 pengujian yang dilaporkan agen) **belum sama dengan PASS GitHub Actions**. PoC dimigrasikan pada PR pengujian terpisah, bukan diterapkan sebagai skema produksi.
- Dilarang memasukkan token, `.env`, kredensial produksi, data pribadi pelanggan, atau dump database.
- Tidak ada deployment produksi tanpa persetujuan pemilik.

## Gerbang yang belum lulus

- Aturan FREE Trial: bukti commit sebelum `expires_at` (T-06c) **OPEN**.
- Isolasi tenant/RLS dan otorisasi Owner harus lulus integration test DB/API.
- M-01 s.d. M-08 pada perangkat nyata; PITR penyedia cloud, C-01 sampai C-04 dan uji penetrasi **BELUM DIUJI**.
- Provider cloud produksi, biaya, RPO/RTO, OTP, dan jalur pembayaran langganan belum diputuskan.

Gunakan Pull Request untuk semua pekerjaan berikutnya. Versi PRD FINAL tidak boleh diubah oleh workflow otomatis.
