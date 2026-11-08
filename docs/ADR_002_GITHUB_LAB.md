# ADR-002 — Private GitHub + Actions untuk Lab
**Status:** DIPUTUSKAN PEMILIK, 8 November 2026.

- Private repository terpisah dari aplikasi lain; `main` sebagai baseline, PR sebelum merge, required CI bila plan GitHub memungkinkan.
- Semua data dalam CI data dummy; DB container sementara, tidak ada kredensial cloud produksi.
- Hasil PoC R3 yang disertakan agen bukan hasil GitHub Actions; harus diuji ulang dalam CI.
- Staging terkelola, PITR cloud, HP Android/iPhone dan printer real tetap uji terpisah.
