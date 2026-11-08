# ADR-001 — Pemilihan Arsitektur A
**Status:** DIPUTUSKAN PEMILIK, 8 November 2026. **Cakupan:** implementasi FREE Trial + PRO, bukan produksi langsung.

**Keputusan:** Flutter/Dart Android+iOS; NestJS/TypeScript modular monolith; PostgreSQL terkelola; transaction pooler PgBouncer/setara; Cloudflare sebagai proteksi edge; private GitHub+GitHub Actions untuk lab pengujian. Vendor cloud/region final, OTP provider, object storage, billing channel, SLA/RPO/RTO masih terbuka.

**Alasan:** kebutuhan uang/stok/approval menuntut satu transaksi atomik; modular monolith menghindari koordinasi distributed transaction, sementara PostgreSQL mendukung constraint, locking, RLS dan ledger. Tidak memilih Cloudflare Workers+Hyperdrive sebagai jalur transaksi utama saat ini karena risiko integrasi dan caching masih belum diuji; ASP.NET Core tetap alternatif yang layak, tetapi tidak dipilih Owner. Pilihan teknis bukan klaim bahwa NestJS lebih aman intrinsik.

**Konsekuensi:** modul terpisah dalam satu deployment; peran database terpisah, RLS/role/SQL function; pipeline GitHub CI; dedicated staging + real device lab dan managed cloud DR sebelum produksi. **Risiko belum ditutup:** strict commit time near trial expiry, PoC→production migration, device support, C-01..C-04.

**Acuan:** PRD V1.1 FINAL, PoC R3 dan audit silang, SAD V1.0. Perubahan keputusan memerlukan ADR baru; perubahan PRD memerlukan pengesahan Owner.
