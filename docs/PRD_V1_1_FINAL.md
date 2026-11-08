# PRODUCT REQUIREMENTS DOCUMENT (PRD) — V1.1
## Aplikasi SaaS Penjualan Pupuk, Pestisida, dan Alat Pertanian

**Status:** **PRD V1.1 — FINAL, DISAHKAN PEMILIK SEBAGAI BASELINE PENGEMBANGAN** — menjadi acuan rancangan teknis dan pengembangan; **bukan izin rilis produksi**  
**Tanggal:** 8 November 2026  
**Inventaris PRD V1.1:** **131 requirement fungsional** (CASH-08 dihapus), **135 kasus uji penerimaan unik** (131 dari V4.10 + 4 uji baru), 12 NFR terdaftar terpisah.  
**Landasan produk utama:** `DRAFT_V4_10_LANDASAN_PRD_PENJUALAN_PERTANIAN.md` (928 baris, keputusan sampai V4.10)  
**Cakupan PRD:** FREE Trial dan PRO, satu lokasi usaha; batas antarmuka MAX ditetapkan, tetapi modul MAX belum dispesifikasikan  
**Target produk v1:** Aplikasi Android dan iPhone (HP/tablet), layanan backend SaaS online, dan back-office internal operator platform  
**Pemilik produk:** Pemilik usaha/pengembang yang mengesahkan keputusan komersial  
**Ketentuan dokumen:** *shall/wajib* = acceptance requirement; *terbuka* = belum ada keputusan, bukan persetujuan diam-diam; *syarat rilis* = tidak boleh dinyatakan lulus sebelum bukti pengujian/kepatuhan ada.

> **Prinsip ketertelusuran:** Dokumen ini menerjemahkan keputusan V4.10 menjadi requirement yang dapat dikembangkan dan diuji. Pengelompokan, penamaan requirement, model data konseptual, dan urutan pengerjaan di sini adalah **usulan spesifikasi teknis**, bukan pengubahan keputusan bisnis. Jika perumusan PRD tidak dapat ditarik secara pasti dari V4.10, poinnya ditandai **[TERBUKA / PERLU PENGESAHAN]**. Dengan pengesahan pemilik, **PRD V1.1 menjadi baseline kebutuhan pengembangan**; V4.10 tetap menjadi rujukan riwayat keputusan dan dasar ketertelusuran. Perubahan kebutuhan setelah pengesahan harus mengikuti kontrol perubahan PRD.

**Catatan pengesahan:** Pemilik secara eksplisit menyatakan **“Saya sahkan”** pada 8 November 2026 setelah menerima PRD V1.1 kandidat final. Pengesahan berlaku untuk cakupan FREE Trial dan PRO serta batas MAX sebagaimana tertulis; keputusan K-1 = A dan K-2 = A tetap berlaku. Pengesahan **tidak** menyatakan pengujian aplikasi, kepatuhan C-01–C-04, SLA, atau parameter TBD telah selesai.

---

# 0. Perubahan V1.0 → V1.1 (8 November 2026)

**Dasar revisi:** perintah pemilik: **K-1 = A** dan **K-2 = A**, 8 November 2026; koreksi teknis P-02, P-03 dan editorial P-04 berdasarkan audit PRD V1.0. **V1.0 tetap disimpan sebagai arsip**. Bila keputusan baru berbeda dari batas usulan pada V4.10, keputusan K-1/K-2 pemilik menjadi sumber perubahan yang spesifik; ketentuan lain V4.10 tidak berubah.

| ID | Keputusan/perbaikan yang diterapkan | Lokasi / requirement / uji | Sumber |
|---|---|---|---|
| K-1 / P-01 | **FREE Trial memakai tutup hari dasar yang sama dengan PRO**: kas seharusnya, kas fisik, selisih, dan blokir `RECEIVED_UNMATCHED` tanpa keputusan Owner | §2.1, J-07, CASH-01–06, INV-11, §11.1; **ST-CASH-05**; CASH-08 dihapus | **Keputusan Edgar 8 Nov 2026 (K-1 = A)** |
| K-2 / P-04b | Admin PRO **mengajukan** harga/grosir/promo; **Owner menyetujui** sebelum berlaku | §4.1, §11.1 | **Keputusan Edgar 8 Nov 2026 (K-2 = A)** |
| P-02 | Alokasi HPP retur parsial memakai pembagian sisa rupiah deterministik dari snapshot HPP baris | COST-04, INV-COST-01; **ST-COST-07** | Perbaikan audit PRD V1.0, bukan perubahan metode HPP |
| P-03 | Refund tunai berstatus konseptual `PAID_CASH`, dibayar langsung dari laci sekali, tanpa status transfer terkirim | §5.3, §6.4; **ST-RET-24** | Perbaikan audit PRD V1.0; mengikuti kas tunai V4.10 |
| P-04a/c | Pemetaan alias `REFUND_APPROVED_PENDING` diperjelas; uji identitas petani sebelum gerbang tempo subsidi ditambah | §5.3, SUB-04; **ST-COMP-27** | Perbaikan editorial dan keterlacakan audit PRD V1.0 |

**Batas revisi:** tidak mengubah harga, hak paket di luar K-1, periode trial/jeda, keputusan PPN, rumus plafon refund V4.10, `REFUND_RETURNED`, batas MAX, atau C-01 sampai C-04. Kasus uji lampiran merupakan **spesifikasi penerimaan**, bukan bukti implementasi telah diuji.

# 1. Ringkasan produk dan sasaran

## 1.1 Rumusan masalah

Kios/agen pertanian memerlukan sistem yang mempercepat transaksi langsung, mencatat berbagai kemasan fisik secara akurat, mengelola stok/barang rusak/kedaluwarsa, mencatat pembayaran tunai dan non-tunai serta tempo/piutang, dan membaca kinerja penjualan tanpa menambah proses ERP yang tidak diperlukan. Penyaluran pupuk bersubsidi mempunyai batasan administratif dan hukum yang berbeda dengan POS umum sehingga harus dipisah.

## 1.2 Tujuan produk

| ID | Hasil yang harus tersedia | Cara memverifikasi |
|---|---|---|
| GOAL-01 | Penjualan online atomik tanpa stok negatif, duplikasi faktur, atau pembayaran sebagian yang hilang | Uji konkurensi, retry, ledger, ST-POS/ST-INV |
| GOAL-02 | Kartu stok benar untuk karton tersegel, unit lepas, batch/expiry, barang ditahan dan karantina | Rekonsiliasi ekuivalen dan status inventori |
| GOAL-03 | Pemilik dapat memantau omzet, uang diterima, piutang, stok, HPP/laba kotor, dan laris/kurang laris | Rekonsiliasi angka laporan dengan dokumen sumber |
| GOAL-04 | Prosedur pembayaran manual, refund, dan penerimaan pengecualian tidak menambah omzet atau kas fiktif | Uji pengembalian dana lintas hari dan ledger |
| GOAL-05 | Hak FREE Trial/PRO, pemisahan tenant, backup, ekspor, dan offboarding diputuskan server | Uji entitlement, kontrol akses, restore dan penghapusan |
| GOAL-06 | Pencatatan internal pupuk subsidi terpisah dari penebusan resmi pemerintah | Uji HET, stok fisik, pengaturan PPN, pemisahan modul |

**Metrik keberhasilan belum diputuskan:** tingkat transaksi sukses, kesalahan stok, waktu transaksi p95, stabilitas, jumlah tenant aktif, penggunaan trial, konversi berbayar, retensi, dan toleransi downtime tidak diberi angka fiktif. Metode ukur harus disusun pada desain telemetry/pilot; target disahkan pada spesifikasi operasional sebelum produksi.

## 1.3 Pengguna dan aktor

| Aktor | Konteks kerja | Hak pokok |
|---|---|---|
| Owner kios/agen | Pemilik bisnis sekaligus pengesah keputusan sensitif | Mengelola produk, harga, staf, langganan, stok, persetujuan, ekspor, seluruh laporan |
| Admin Bisnis/kasir | Petugas individu pada satu lokasi PRO | Menjual, menerima barang dan pembayaran, menagih; mengajukan tindakan sensitif; tidak menyetujuinya |
| Pelanggan toko | Pembeli biasa atau pelanggan berpiutang | Tidak perlu akun aplikasi; wajib tercatat untuk tempo/parsial |
| Petani / anggota kelompok tani | Penerima penyaluran pupuk subsidi | Hanya nama dan kelompok tani dicatat pada modul internal; bukan pengguna login |
| Operator platform SaaS | Mengelola tenant dan hak berlangganan | Metadata tenant, invoice langganan, entitlement, bantuan dan insiden; tidak melihat data transaksi toko secara default |
| Petugas keuangan platform | Mengonfirmasi pembayaran langganan | Hanya invoice/pembayaran SaaS, bukan keuangan tenant |
| Staf dukungan teknis | Menangani kendala berdasarkan izin | Akses minimum berjangka sesuai grant Owner dan audit; tidak boleh mengubah saldo semaunya |

## 1.4 Platform dan batas tegas

**Termasuk v1:** aplikasi Android dan iPhone dengan desain untuk HP dan tablet, API/backend SaaS online, database multi-tenant, sistem dokumen PDF/struk thermal opsional, tautan WhatsApp manual, back-office platform minimum.

**Tidak termasuk v1:** website login pelanggan, aplikasi desktop `.exe`, finalisasi POS offline, pending order, reservasi stok, saldo deposit pelanggan PRO, utang pemasok terintegrasi, klaim pemasok terintegrasi, perpindahan stok antar lokasi, gudang/cabang multi-lokasi, akuntansi umum/laba bersih, otomatisasi WhatsApp, dan pelaporan pemerintah terintegrasi. MAX baru dipetakan sebagai batas entitlement; kebutuhan operasional MAX akan menjadi PRD terpisah.

**Batas desain:** stok dasar bilangan bulat; tidak menjual volume/berat curah pecahan. Tidak ada anggapan bahwa barcode SKU adalah barcode batch, atau aplikasi memberikan izin jual/pemusnahan pestisida.

---

# 2. Rilis, status keputusan dan ketergantungan

## 2.1 Paket dan entitlement yang mengikat

| Kapabilitas | FREE Trial | PRO | MAX (batas, bukan desain lengkap) |
|---|---|---|---|
| Model akses | Percobaan gratis **7 × 24 jam** | Langganan Rp287.000/bulan atau Rp3.000.000/tahun | Langganan dan kapasitas belum ditentukan |
| Awal masa | OTP Owner berhasil diverifikasi, memakai waktu server | Setelah pembayaran/otorisasi periode berhasil diverifikasi server | Terbuka |
| Akun operasional | 1 Owner | 1 Owner + 1 Admin Bisnis | Owner/Admin/peran kustom; jumlah belum disahkan |
| Lokasi aktif | 1 | 1 | Multi-lokasi |
| Master produk, kemasan, stok awal, penerimaan | Ada | Ada | Ada |
| POS online, pembayaran manual, piutang, retur sah | Ada | Ada | Ada |
| FEFO, batch aman, tahan penjualan, ekspor penuh | Ada (minimum) | Ada | Ada |
| PPN via Pengaturan Owner | Ada | Ada | Ada |
| Pencatatan internal pupuk subsidi | Ada | Ada | Ada |
| Harga grosir dan Barang Diskon berkuota | Tidak | Ada | Ada |
| Stok opname terstruktur | Tidak, hanya koreksi dasar Owner | Ada | Ada |
| Analitik detail/HPP/laba kotor/laris-kurang laris | Tidak pada dashboard trial ringkas | Ada | Ada termasuk konsolidasi nantinya |
| Laporan periodik lengkap/ekspor rutin | Antarmuka ringkas; portabilitas data tetap penuh | Ada | Ada |
| Rekonsiliasi kas akhir hari | **Ada (dasar, sama dengan PRO)** | Ada | Ada |
| Klaim pemasok terintegrasi | Tidak | Tidak | Ada (desain terpisah) |
| Transfer stok lintas gudang/cabang | Tidak | Tidak | Ada (desain terpisah) |

**Ketentuan bersama:** keamanan, audit, ketahanan transaksi dan isolasi tenant tidak boleh dilemahkan untuk FREE Trial. Trial tidak memiliki kuota '300 produk/300 transaksi'; pembatasan penyalahgunaan keamanan/fair use berbeda dari kuota komersial dan tidak boleh menyamar menjadi kuota produk.

## 2.2 Status langganan dan data

| Keadaan | Hak bisnis | Hak minimum Owner | Transisi |
|---|---|---|---|
| FREE aktif | Fitur trial sesuai matrix | Mengelola usaha selama trial | Waktu server mencapai `expires_at` → dikunci; atau membayar → PRO |
| FREE habis, masa tunggu 7 hari | Seluruh operasi bisnis dikunci | Ekspor seluruh data sendiri; berlangganan | Berlangganan tepat waktu → aktif, data utuh; jika tidak → penghapusan aktif |
| PRO aktif | Fitur PRO | Seluruh hak sesuai role | Berakhir → dikunci; bayar perpanjangan → aktif |
| PRO/MAX habis, masa jeda 30 hari | Seluruh operasi bisnis dikunci | Ekspor data sendiri; perpanjang langganan | Perpanjang → aktif, data utuh; jika tidak → penghapusan aktif |
| Data operasional dihapus | Tidak dapat dibuka lagi secara biasa | Tidak ada pemulihan tenant lewat backup | Backup berakhir menurut retensi terukur; legal hold terbatas |

- Notifikasi PRO/MAX **H-7** sebelum habis wajib ada. Tidak ada tambahan notifikasi selama masa jeda 30 hari.
- Setelah masa jeda, data tenant dihapus dari **database aktif**, tetapi backup terenkripsi tidak diklaim terhapus seketika. Maksimum retensi backup harus disahkan sebelum rilis.
- Penghapusan tenant direkam pada **daftar append-only terpisah dari backup**. Restore tidak boleh mengaktifkan kembali tenant yang sudah dihapus.
- Hak ekspor portabilitas penuh selama jendela yang disepakati tidak boleh dipaywall.
- Data keuangan dan pajak yang wajib disimpan tetap menjadi tanggung jawab wajib pajak/kios sesuai dasar hukum; batas dan perjanjian harus ditinjau sebelum penjualan langganan publik.

## 2.3 Gerbang keputusan

| Kode | Hal yang belum ditutup | Perlakuan dalam PRD | Akibat bila tidak dipenuhi sebelum produksi |
|---|---|---|---|
| C-01 | Konfirmasi tertulis kelayakan tempo subsidi dari pihak resmi berwenang | Alur dicakup namun diberi feature gate **NONAKTIF** saat rilis sampai verifikasi | Jangan aktifkan tempo subsidi |
| C-02 | Kesesuaian perhitungan dan pembulatan PPN POS dengan hukum/Coretax | Algoritma V4.10 ditulis dan diuji; belum dinyatakan menghasilkan Faktur Pajak resmi | Jangan klaim kesesuaian atau aktifkan PPN secara publik sebelum verifikasi |
| C-03 | Refund manual, arus uang pengecualian, carry-over dan SLA tindak lanjut | Model peristiwa dan pengujian wajib, bukan janji anti-duplikasi transfer eksternal | Jangan rilis alur pembayaran/refund tanpa lulus uji dan SOP |
| C-04 | Batas backup, RPO/RTO, uji restore dan daftar tenant terhapus | Parameter tetap `TBD`, owner operasional ditunjuk saat spesifikasi teknis | Jangan rilis produksi tanpa pemulihan yang diuji |
| SEC-GATE | Keamanan database, API, aplikasi Android/iOS, dan akses operator | Uji isolasi tenant, sesi, OTP, ekspor, audit, injeksi, backup | Jangan rilis sebelum lulus |

## 2.4 Asumsi dan batas perumusan PRD

- PRD ini **tidak menetapkan framework, database, cloud, payment gateway, toko aplikasi, tarif pihak ketiga, atau lokasi hosting**.
- Draft V4.10 memuat pelengkap yang belum disetujui; bagian seperti kuota ekspor rutin trial, kelengkapan rekonsiliasi kas FREE, kedaluwarsa approval, pengukuran performa dan rincian metadata pestisida ditandai terbuka, bukan dijadikan janji final.
- Pemilihan metode bayar langganan, tanggal billing, pembatalan/refund langganan, dan jalur pembelian langganan Android/iOS masih perlu analisis biaya/kebijakan kanal. Back-office tetap harus mampu memverifikasi pembayaran secara aman.
- PRD dapat dikaji dan disetujui tanpa mengklaim pengujian aplikasi yang belum dibangun. Persetujuan PRD **tidak otomatis** berarti siap rilis.

---

# 3. Perjalanan pengguna dan alur inti

## 3.1 Journey J-01 — Registrasi dan aktivasi FREE Trial

1. Owner mengisi data pendaftaran minimum dan memperoleh OTP pada nomor HP yang sah.
2. Backend memverifikasi OTP, menghindari enumerasi dan penyalahgunaan.
3. Pada keberhasilan verifikasi OTP Owner, backend mencatat `activated_at` berdasarkan waktu server dan menetapkan `expires_at = activated_at + 7 × 24 jam`.
4. Owner melihat masa trial, status paket, fungsi yang tersedia/terkunci, dan konsekuensi penghapusan data.
5. Seluruh entitlement diverifikasi ulang di server pada setiap finalisasi. Jam perangkat tidak memiliki kewenangan.
6. Jika dua request bersaing dekat akhir trial, hanya transaksi yang commit sebelum batas berlaku; transaksi yang tidak commit harus tetap berupa draft keranjang yang tidak dianggap lunas.

**Kriteria penerimaan:** ST-SUB-01, 02, 05, 06, 11, 13; ST-SEC-03, 17, 18.

## 3.2 Journey J-02 — Master produk → stok awal → penerimaan

1. Owner/Admin membuat produk pada satu alur form: identitas, satuan dasar, varian kemasan/harga, stok awal per bentuk fisik/batch/expiry bila relevan, biaya perolehan bila stok bernilai.
2. Input **stok awal harus terlihat dan diisi**; nilai 0 diterima.
3. Produk dan definisi kemasan tersimpan; peristiwa saldo pembukaan masuk `InventoryLedger` sekali saja.
4. Petugas menerima barang melalui **Tambah Stok** dari halaman detail produk dan memasukkan jumlah fisik, pemasok/dokumen bila ada, biaya, batch/expiry dan status.
5. Petugas dapat membuka karton dari POS hanya setelah konfirmasi fisik, jika kemasan tersebut boleh dibuka.
6. Mutasi siap jual harus dapat direkonsiliasi dengan satuan dasar tanpa menghitung dua kali isi karton.

**Kriteria penerimaan:** ST-INV-01–03, 05, 08, 12; ST-COST-01, 03–06.

## 3.3 Journey J-03 — POS umum tunai/campuran/tempo

1. Kasir memindai/memilih produk, kemasan, kuantitas dan batch fisik sah.
2. Backend menyediakan harga yang berlaku, termasuk aturan harga grosir/promo untuk PRO.
3. Kasir melihat ringkasan harga, PPN jika diaktifkan Owner untuk barang terkait, total, dan metode pembayaran.
4. Pembayaran tunai/transfer/QRIS eksternal/EDC diverifikasi manual dari sumber penerimaan yang relevan. Pembayaran campuran dicatat per metode.
5. Jika parsial atau tempo, pelanggan terdaftar dan jatuh tempo wajib ada.
6. Finalisasi server **atomik** mengunci ketersediaan stok/promo, membuat Sale dan seluruh mutasi keuangan/persediaan sekali, lalu menyediakan dokumen PDF/struk.
7. Jika item atau harga berubah ketika keranjang dibuka, server meminta konfirmasi ulang; tidak mencatat pembayaran palsu atau stok negatif.
8. Kasir dapat mencetak ulang *SALINAN*; tidak membuat Sale kedua.

**Kriteria penerimaan:** ST-POS-01–05; ST-PAY-01–04; ST-DOC-01–02.

## 3.4 Journey J-04 — Pembayaran diterima, tetapi finalisasi gagal

1. Jika bukti penerimaan eksternal sah sudah masuk namun POS tidak dapat difinalisasi, server membuat **Pengecualian Pembayaran** `RECEIVED_UNMATCHED`, tanpa Sale, tanpa omzet dan tanpa piutang pelanggan fiktif.
2. Dalam sesi yang sama, penerimaan boleh dikaitkan sekali ke penjualan baru yang berhasil, setelah stok/harga/persetujuan pembeli diperiksa ulang.
3. Jika tidak, Owner menyetujui refund. Untuk transfer manual v1, petugas dapat menandai **Transfer sudah dikirim** sebagai status internal, **bukan** bukti uang keluar.
4. Sebelum tanda terkirim: Owner dapat membatalkan persetujuan dengan reautentikasi dan audit. Sesudah tanda terkirim: jatah tidak boleh dilepas melalui pembatalan.
5. Jika transfer manual gagal, Owner boleh mencoba lagi **di bawah persetujuan yang sama**. Sistem tidak membuat persetujuan baru; pencatatan `dibayar` hanya sekali per persetujuan.
6. Jika bank/laci telah benar-benar membayar, sistem mencatat arus keluar; bila kemudian dana kembali dan terbukti, buat `REFUND_RETURNED` dan kembalikan nominal terkait ke `RECEIVED_UNMATCHED` untuk keputusan Owner, bukan deposit atau omzet.
7. Ketika penutupan hari, penerimaan `RECEIVED_UNMATCHED` yang belum ditinjau Owner memblokir tutup hari. Refund tertunda dapat *carry-over* hanya dengan persetujuan Owner, alasan dan tindak lanjut.

**Kriteria penerimaan:** ST-PAY-05–15; ST-RET-19–23; ST-CASH-03–04.

## 3.5 Journey J-05 — Piutang, retur, koreksi, refund

1. Kasir/Owner mencari faktur asal dan nilai yang masih dapat diretur.
2. Admin mengajukan retur/koreksi/refund; Owner menilai lewat perangkat terautentikasi, meninjau alasan, versi dan nilai terkini.
3. Barang retur fisik masuk status **pemeriksaan**, bukan siap jual.
4. Retur lebih dulu mengurangi sisa piutang, lalu membentuk kewajiban refund untuk kelebihan pembayaran.
5. Backend mengecek batas hak refund dan seluruh approval tertunda secara atomik; peristiwa yang merusak invarian ditolak.
6. Refund yang sudah dibayar dicatat dengan bukti arus uang; jika dana kembali, refund efektif berkurang melalui peristiwa terhubung, bukan menghapus histori.
7. Perubahan nominal penjualan final berupa dokumen koreksi, tidak mengedit transaksi final.

**Kriteria penerimaan:** ST-RET-01–23, ST-APR-01–02.

## 3.6 Journey J-06 — Penyaluran subsidi terpisah

1. Owner memasukkan angka alokasi per jenis/periode beserta sumber/ketentuan; angka ini **bukan** stok fisik.
2. Penerimaan pupuk subsidi fisik ditambahkan bertahap melalui inventori bersubsidi; tidak bercampur stok nonsubsidi.
3. Petugas mencatat nama petani, kelompok tani, tanggal, jumlah dan harga di modul internal subsidi.
4. Server memvalidasi stok fisik tersedia, HET yang berlaku menurut tanggal transaksi dan larangan PPN tambahan/diskon/grosir POS umum.
5. Penyaluran mengurangi stok fisik subsidi. Pembayaran tunai atau tempo mengikuti keputusan bisnis, tetapi **mode tempo nonaktif sampai C-01 terpenuhi**.
6. Rekap subsidi terpisah dari laporan POS umum. Transaksi di aplikasi bukan pengganti penebusan atau laporan resmi pemerintah.

**Kriteria penerimaan:** ST-COMP-01, 02, 05, 07–10, 21, **27 (tunai sebelum C-01)**.

## 3.7 Journey J-07 — Tutup hari dan laporan

1. Petugas memeriksa kas awal yang terverifikasi atau ditandai sementara, penerimaan tunai bersih, refund tunai, pembelian/pengeluaran tunai, setoran dan pengambilan Owner.
2. Sistem menghitung **kas seharusnya** dan meminta jumlah **kas fisik** yang dihitung.
3. Selisih kas ditampilkan sebagai selisih, bukan koreksi omzet otomatis.
4. Penerimaan bank/QRIS/EDC dan kewajiban refund belum selesai ditampilkan terpisah dari kas laci.
5. Carry-over refund membutuhkan persetujuan Owner, tidak mengakui uang keluar sebelum ada bukti.
6. Penutupan disimpan bersama hari operasional berdasarkan zona tenant. Pembukuan terlambat membuat penyesuaian bertanggal posting, tidak menimpa periode lama tanpa jejak.

**Kriteria penerimaan:** ST-CASH-01–05 (termasuk FREE Trial menurut K-1 = A), ST-PAY-06, 08–09, 15.

---

# 4. Persyaratan fungsional yang dapat diterima (FR)

**Cara membaca:** `MUST` merupakan kebutuhan baseline untuk fitur yang tersedia pada paket terkait; `GATED` merupakan requirement yang dirancang tetapi tidak boleh diaktifkan sampai syarat rilisnya terpenuhi; `TBD` bukan fitur yang dianggap sudah disetujui. Setiap FR harus menghasilkan pengujian server dan pengujian UI bila relevan.

## 4.1 FR-AUTH — Identitas, sesi, role, persetujuan

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| AUTH-01 | MUST | Akun Owner dan Admin mempunyai identitas serta kredensial individu; akun kasir bersama dilarang pada baseline | Admin A dan B tidak dapat berbagi audit aktor; V4.10 §5.1 |
| AUTH-02 | MUST | Registrasi Owner via nomor HP + OTP yang diverifikasi server; login rutin via sandi; pemulihan berlapis | OTP invalid/berulang/expired ditolak; ST-SEC-03, 17 |
| AUTH-03 | MUST | Semua API mengecek aktor, tenant, role, status tenant, entitlement, waktu server dan konteks objek | Penolakan akses palsu melalui API; ST-SEC-01, 08, 18 |
| AUTH-04 | MUST | Tindakan sensitif Owner memerlukan reautentikasi berbasis risiko, alasan, dokumen rujukan dan audit | Pengajuan yang berubah versinya ditolak; ST-APR-01–02 |
| AUTH-05 | MUST | Admin tidak boleh mengesahkan retur, refund, koreksi atau penyesuaian stok; namun boleh langsung menahan batch berisiko | ST-INV-07, ST-SEC-05 |
| AUTH-06 | MUST | Sesi dapat dicabut server-side; pergantian perangkat tidak mempertahankan hak sesi lama | ST-SEC-04 |
| AUTH-07 | TBD | Durasi kedaluwarsa pengajuan Owner dan notifikasi pengingat ditentukan dalam spesifikasi keamanan/operasional | Tidak mengarang angka; V4.10 §5.2 |

### Matriks izin operasional PRO

| Aksi | Owner | Admin Bisnis |
|---|:---:|:---:|
| Jual, menerima pembayaran, pelunasan piutang | Ya | Ya |
| Master produk, stok awal, penerimaan, buka karton | Ya | Ya |
| Harga/grosir/promo: menetapkan atau mengajukan | Menyetujui/menetapkan | **Mengajukan; Owner menyetujui sebelum berlaku** |
| Ajukan retur/refund/koreksi/opname | Ya | Ya |
| **Setujui** retur/refund/koreksi/opname | Ya | Tidak |
| Tahan produk/batch berisiko segera | Ya | Ya |
| Lepas karantina / setujui pemusnahan | Ya | Tidak |
| Lihat ringkasan operasional | Ya | Sesuai tugas |
| Ekspor massal data pelanggan, langganan, keamanan akun | Ya | Tidak |

## 4.2 FR-ENT — Langganan dan masa trial

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| ENT-01 | MUST | FREE dimulai saat verifikasi OTP Owner berhasil, berlaku persis 7 × 24 jam berdasar waktu server | ST-SUB-01, 13 |
| ENT-02 | MUST | FREE 1 Owner/1 lokasi; PRO 1 Owner + 1 Admin/1 lokasi; MAX belum ditentukan kapasitasnya | ST-SEC-18 |
| ENT-03 | MUST | Backend menjadi sumber kebenaran periode entitlement, bukan field klien; pembayaran langganan harus terverifikasi dulu | ST-SUB-03, 04 |
| ENT-04 | MUST | Pada finalisasi dekat waktu kedaluwarsa, validasi harus atomik terhadap batas waktu; tidak ada posting parsial | ST-SUB-02 |
| ENT-05 | MUST | FREE habis: kunci bisnis, masa tunggu 7 hari untuk ekspor dan bayar, lalu hapus dari database aktif | ST-SUB-05–07 |
| ENT-06 | MUST | PRO/MAX habis: H-7 peringatan, kunci bisnis, 30 hari untuk ekspor/perpanjang; tanpa peringatan tambahan saat jeda | ST-SUB-12 |
| ENT-07 | MUST | Upgrade/perpanjangan sebelum penghapusan memulihkan hak tanpa menggandakan periode/data | ST-SUB-04, 06 |
| ENT-08 | MUST | Hak akses fitur dibatasi backend, khusus grosir/promo/opname dan fitur MAX | ST-SUB-09, 10 |
| ENT-09 | MUST | Penghapusan aktif di akhir jeda, retensi backup terukur, tombstone di luar backup, pencegahan resurrect tenant | ST-SEC-21, 22, 24 |
| ENT-10 | TBD | Periode billing, kanal beli langganan, pembayaran/refund langganan dan metode aktivasi komersial belum final | Catat sebagai keputusan terbuka D-11 dan §4.2 |

## 4.3 FR-PRD — Produk, SKU, kemasan dan stok awal

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| PRD-01 | MUST | SKU unik per tenant; identitas produk meliputi nama, kategori, merek bila ada, satuan dasar dan barcode opsional | SKU duplikat ditolak pada tenant yang sama |
| PRD-02 | MUST | Produk mendukung varian kemasan fisik dengan faktor konversi integer positif, barcode/harga tiap varian | Faktor 0/negatif ditolak; ST-INV-02 |
| PRD-03 | MUST | Stok awal harus diisi sebagai satu langkah pembuatan produk (boleh 0), terpisah bentuk tersegel/lepas dan batch | ST-INV-01 |
| PRD-04 | MUST | Stok awal menghasilkan ledger pembukaan tunggal; tidak dapat ditimpa melalui edit produk berikutnya | Audit event pembukaan; ST-INV-05 |
| PRD-05 | MUST | Varian kemasan yang telah dipakai dalam transaksi tidak boleh mengalami perubahan faktor isi secara retroaktif | Membuat versi/varian baru; histori stabil |
| PRD-06 | MUST | Produk dengan kemasan yang tidak boleh dibuka tidak menampilkan/menjalankan aksi buka karton bahkan via API | ST-INV-12 |
| PRD-07 | MUST | Barang bernilai positif memerlukan basis biaya pembukaan untuk HPP; bonus bernilai nol perlu alasan/asal dan catatan valuasi | ST-COST-04; HPP invalid ditandai |
| PRD-08 | TBD | Metadata legal/registrasi pestisida hanya setelah persyaratan resmi diverifikasi | Tidak menganggap ada izin penjualan hanya karena ada kolom |

## 4.4 FR-INV — Inventori, penerimaan, FEFO, opname

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| INV-01 | MUST | Setiap penerimaan stok nyata membuat mutasi ledger beserta pemasok, dokumen jika tersedia, biaya, lokasi, batch/expiry bila relevan, waktu dan aktor | Retry tidak mencatat dua kali; ST-INV-05 |
| INV-02 | MUST | Stok siap jual, pemeriksaan, ditahan, rusak, karantina/ditarik dan keluar dibedakan | POS hanya mengurangi siap jual; ST-INV-06, 07 |
| INV-03 | MUST | Validasi tanggal kedaluwarsa dan blokir batch tidak aman berada di backend, bukan UI | ST-INV-06 |
| INV-04 | MUST | FEFO memberi saran batch layak dengan expiry terdekat; kasir mengonfirmasi batch fisik | Tidak salah menjual batch; V4.10 §6.3 |
| INV-05 | MUST | Buka karton fisik: karton tersegel −1, unit lepas +n dengan batch/expiry asal; total ekuivalen/nilai tidak berubah | ST-INV-02, 03, 08 |
| INV-06 | MUST | Owner/Admin boleh menahan produk/batch berisiko segera; pelepasan harus Owner | Status ditahan segera memblokir POS/API; ST-INV-07 |
| INV-07 | MUST (PRO) | Stok opname per item/batch/kemasan mencatat `counted_at`, `entered_at`, versi ledger dan hitungan fisik; disetujui Owner | Pergerakan sesudah hitung tidak hilang; ST-INV-09 |
| INV-08 | MUST | Semua mutasi status, penerimaan, penjualan, retur, koreksi dan konversi konservatif/atomik; stok negatif dilarang | ST-INV-04, 10, 13 |
| INV-09 | MUST | Saldo cache/proyeksi dapat dibangun ulang dari ledger; ketidakcocokan mengeluarkan alert tanpa mengedit histori | ST-INV-10 |
| INV-10 | MUST (PRO) | Pengembalian barang rusak ke pemasok dicatat sederhana tanpa modul klaim/kredit terintegrasi | ST-INV-11; integrasi klaim hanya MAX |
| INV-11 | MUST (FREE) | Penyesuaian stok dasar oleh Owner tetap wajib beralasan dan diaudit; **tutup hari dasar FREE mengikuti CASH-01–06 (K-1 = A)** | Tidak mengaktifkan opname kompleks pada trial; ST-CASH-05 |

## 4.5 FR-COST — HPP dan valuasi rupiah

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| COST-01 | MUST | Moving weighted average per SKU per lokasi dalam unit dasar; nilai persediaan disimpan sebagai integer rupiah, rata-rata eksak | Tidak ada sisa rupiah fiktif; ST-COST-01 |
| COST-02 | MUST | `nilai_beban = floor(nilai_sisa × qty_keluar / qty_sisa)`; bila stok habis, seluruh nilai tersisa diambil | Rp100/3 → 33/33/34; Rp1 juta/7 → 285.714/285.714/428.572 |
| COST-03 | MUST | HPP yang dibebankan disimpan sebagai snapshot tiap baris transaksi; tidak diubah oleh penerimaan berikutnya | ST-COST-02 |
| COST-04 | MUST | **HPP retur = ⌊HPP baris tersisa × unit diretur ÷ unit baris tersisa⌋** berdasarkan snapshot historis baris asal; retur yang menghabiskan sisa unit baris mengambil **seluruh** sisa HPP baris. Nilai yang dikembalikan masuk status pemeriksaan; aturan pembagian sama dengan PPN retur (§6.3) | ST-COST-02, **ST-COST-07** |
| COST-05 | MUST | Perpindahan status stok memindahkan nilai deterministik tanpa mengakui rugi dua kali | ST-COST-03, 06 |
| COST-06 | MUST | Bila harga pokok tak dapat diverifikasi, laba kotor tidak boleh dipresentasikan sebagai angka pasti | Label `HPP belum terverifikasi` |
| COST-07 | GATED | Kebijakan penurunan nilai/pemusnahan mengikuti penilaian akuntansi yang disahkan | Tidak membuat aturan kerugian universal |

## 4.6 FR-POS — Penjualan, harga dan promosi

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| POS-01 | MUST | Keranjang dapat disiapkan lokal, tetapi finalisasi hanya online dan melalui transaksi server atomik | ST-INV-13; ST-POS-01 |
| POS-02 | MUST | Penjualan stok negatif, batch ditahan/kedaluwarsa dan pemakaian promo di luar hak selalu ditolak server | ST-INV-04, 06; ST-POS-05 |
| POS-03 | MUST | Harga server disnapshot, diperiksa ulang saat checkout; perubahan material meminta konfirmasi ulang | ST-POS-02 |
| POS-04 | MUST (PRO) | Harga grosir berdasarkan kuantitas dan Barang Diskon berkuota mengikuti harga valid terendah, tanpa penumpukan | ST-POS-03–04 |
| POS-05 | MUST (PRO) | Kuota promo hanya dikurangi untuk unit yang benar-benar mendapat harga promo, tidak direservasi di draft | ST-POS-03–04 |
| POS-06 | MUST | Finalisasi memakai idempotency key, membuat satu Sale/ledger/dokumen untuk retry identik | ST-POS-01 |
| POS-07 | MUST | Kasir tidak dapat mengubah harga sesukanya atau memalsukan status paket/PPN melalui API | ST-POS-05, ST-COMP-24 |
| POS-08 | MUST | Produk subsidi tidak masuk checkout POS umum | ST-COMP-01, 02 |

## 4.7 FR-PAY — Pembayaran POS dan piutang

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| PAY-01 | MUST | Tunai, transfer, QRIS eksternal dan EDC dicatat manual setelah bukti resmi diperiksa | ST-PAY-01–04 |
| PAY-02 | MUST | Pembayaran campuran menyimpan metode, nominal, waktu, aktor, referensi bila ada dan status verifikasi tiap bagian | ST-PAY-02 |
| PAY-03 | MUST | Uang tunai diserahkan dan kembalian disimpan terpisah, penerimaan bersih hanya nilai yang ditahan toko | ST-CASH-01 |
| PAY-04 | MUST | Jumlah bagian pembayaran tidak melebihi total tagihan; selain kembalian tunai, tidak menciptakan deposit | ST-PAY-02, 04 |
| PAY-05 | MUST | Pelanggan terdaftar wajib untuk tempo/parsial, jatuh tempo dicatat per faktur | ST-PAY-04 |
| PAY-06 | MUST | Pelunasan mengurangi saldo faktur yang dipilih dan tidak menambah omzet atau mengurangi stok lagi | ST-PAY-01 |
| PAY-07 | MUST | Transaksi pembayaran idempoten dan koreksi pembayaran memerlukan dokumen koreksi/otorisasi Owner | ST-PAY-03 |
| PAY-08 | MUST | Analitik piutang per barang adalah alokasi saldo faktur secara proporsional dengan residual deterministik, bukan utang resmi per item | Σ alokasi = saldo faktur |
| PAY-09 | MUST | Tautan WhatsApp penagihan manual dan pratinjau nomor/isi tidak mengklaim pesan sudah dikirim | V4.10 §8.4, §13.3 |

## 4.8 FR-EXC — Pengecualian pembayaran eksternal

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| EXC-01 | MUST | Uang masuk tanpa Sale sah direkam satu kali sebagai `RECEIVED_UNMATCHED` lengkap bukti, tenant, waktu, aktor; tanpa omzet/faktur fiktif | ST-PAY-05, 11 |
| EXC-02 | MUST | Alokasi ke Sale baru hanya dalam sesi yang sama, satu jalur bisnis dan dengan persetujuan pembeli; tidak untuk belanja berikut hari | ST-PAY-10 |
| EXC-03 | MUST | Jika tidak ada Sale sah, Owner mengesahkan refund sesuai dana aktual, tanpa saldo deposit | ST-PAY-07, 12, 13 |
| EXC-04 | MUST | Saat refund v1 manual, `Transfer sudah dikirim` hanya status petugas; retry transfer boleh dalam approval sama, bukan approval baru | ST-RET-19, 22, 23 |
| EXC-05 | MUST | Pembayaran refund dikonfirmasi **dibayar** sekali per approval berdasarkan bukti dana benar-benar keluar | ST-PAY-09, ST-RET-22 |
| EXC-06 | MUST | Refund dana kembali yang telah diverifikasi menghasilkan `REFUND_RETURNED`, lalu nominal pengecualian kembali `RECEIVED_UNMATCHED` menunggu Owner | ST-PAY-15 |
| EXC-07 | MUST | `RECEIVED_UNMATCHED` tanpa keputusan Owner memblokir tutup hari; carry-over refund tertunda hanya dengan persetujuan Owner | ST-PAY-06, 08, 15 |
| EXC-08 | MUST | Setiap mutasi pengecualian mempertahankan partisi total nominal diterima, tanpa partisi ganda | Invarian §6.2 dan ST-PAY-15 |
| EXC-09 | MUST | Manual retry/pencatatan berulang tidak menggandakan cash/bank; dana bank nyata dilacak di luar layar Sale | ST-PAY-09, 11 |

## 4.9 FR-RET — Retur, koreksi, pembatalan dan refund

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| RET-01 | MUST | Retur hanya pada Sale asal dan maksimal unit yang belum diretur; Owner menyetujui | ST-RET-01–03 |
| RET-02 | MUST | Barang retur ke pemeriksaan; HPP historis dan PPN snapshot dari transaksi asal | ST-COST-02, ST-COMP-17, 25 |
| RET-03 | MUST | Retur mengurangi piutang dahulu; kelebihan menjadi kewajiban refund, bukan deposit | ST-RET-06–09 |
| RET-04 | MUST | Koreksi final bersifat append-only bertanda +/- dan merujuk dokumen asal, tidak menimpa Sale | ST-RET-10–11 |
| RET-05 | MUST | Rumus saldo `B = F+C−R−(P−Rf)`; piutang `max(B,0)`, refund terutang `max(−B,0)` | ST-RET-06–11 |
| RET-06 | MUST | Persetujuan refund atomik: `Q + refund_baru ≤ L`, `L = max(−B,0)`; refund dibayar tidak dihitung dua kali | ST-RET-12, 13, 17, 18 |
| RET-07 | MUST | Pembayaran refund ≤ approval tertunda, satu pencatatan dibayar per approval; koreksi lain yang merusak invarian ditolak | ST-RET-15, 18 |
| RET-08 | MUST | Pada transfer manual tanpa tanda terkirim, Owner boleh membatalkan approval dengan reautentikasi; setelah tanda terkirim tidak membebaskan jatah | ST-RET-14, 16, 19, 23 |
| RET-09 | MUST | Transfer gagal dapat diulang di bawah approval yang sama; hasil eksternal belum pasti tidak boleh diklaim gagal final | ST-RET-19, 22 |
| RET-10 | MUST | Dana refund kembali membuat `REFUND_RETURNED`: arus balik + pengurangan `Rf` efektif + hitung ulang hak refund, tanpa hapus histori | ST-RET-20–21, ST-PAY-14–15 |
| RET-11 | MUST | Pembatalan penjualan final hanya pengecualian sebelum barang diserahkan, dengan Owner; sudah diserahkan gunakan retur | ST-RET-05 |
| RET-12 | MUST | Persetujuan Owner memeriksa versi objek, bukti, stok/kuota/nominal dan status saat akan diterapkan | ST-APR-01–02 |

## 4.10 FR-CASH — Rekonsiliasi kas dan tutup hari

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| CASH-01 | MUST | Pisahkan kas seharusnya, kas fisik terhitung dan selisih; jangan otomatis mengubah omzet | ST-CASH-01, 04 |
| CASH-02 | MUST | Kas awal yang belum diperiksa diberi label `Saldo pembukaan sementara` | ST-CASH-02 |
| CASH-03 | MUST | Rumus kas laci hanya peristiwa tunai nyata: tunai neto, refund tunai, beli stok tunai, pengeluaran, setor, pengambilan dan koreksi sah | ST-CASH-01, 03 |
| CASH-04 | MUST | Transfer/QRIS/EDC dan refund eksternal tidak mengubah kas laci; refund tertunda adalah kewajiban, bukan kas keluar | ST-CASH-03; ST-PAY-08 |
| CASH-05 | MUST | Owner menyetujui carry-over refund, disimpan pada laporan hari dan daftar tindak lanjut sampai terbayar | ST-PAY-08–09 |
| CASH-06 | MUST | Tutup hari **FREE dan PRO** memblokir pengecualian `RECEIVED_UNMATCHED` tanpa keputusan Owner | ST-PAY-06, 15, **ST-CASH-05** |
| CASH-07 | MUST | Hari operasional memakai WIB/WITA/WIT tenant; waktu faktual UTC; koreksi akhir hari tetap dapat ditelusuri | V4.10 §10–11 |

## 4.11 FR-SUB — Pupuk bersubsidi

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| SUB-01 | MUST | Pencatatan penyaluran subsidi di modul terpisah, bukan POS umum atau sistem penebusan resmi | ST-COMP-01 |
| SUB-02 | MUST | Alokasi hanya angka administratif per periode; tidak menaikkan stok fisik | ST-COMP-07 |
| SUB-03 | MUST | Stok subsidi bertambah hanya dari penerimaan fisik dan terpisah dari barang nonsubsidi | ST-COMP-02, 07–08 |
| SUB-04 | MUST | Identitas internal penyaluran hanya nama petani dan kelompok tani; tidak meminta NIK atau HP pada modul ini | **ST-COMP-27 (sebelum C-01)**; ST-COMP-05 (hanya sesudah C-01) |
| SUB-05 | MUST | HET dari Owner dengan sumber dan tanggal efektif; backend melarang harga lebih tinggi dari HET pada tanggal penyaluran | ST-COMP-09 |
| SUB-06 | MUST | Tanpa promosi/grosir POS umum, tanpa pemungutan PPN ulang oleh pengecer, tidak lebih HET | ST-COMP-01, 10, 21 |
| SUB-07 | GATED C-01 | Penyaluran tempo dan piutangnya disiapkan sebagai kebutuhan, tetapi **dinonaktifkan saat rilis** sampai konfirmasi tertulis kepatuhan | ST-COMP-05 (hanya pasca C-01) |
| SUB-08 | MUST | Laporan stok, penerimaan, penyaluran dan piutang subsidi terpisah menurut periode | V4.10 §15.1 |
| SUB-09 | MUST | UI menyatakan pencatatan internal, bukan integrasi penebusan/pelaporan pemerintah; kewajiban resmi tetap di luar aplikasi | ST-COMP-04 |

## 4.12 FR-VAT — Pengaturan dan penghitungan PPN v1

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| VAT-01 | MUST | Owner mengendalikan sakelar `Gunakan PPN: Ya/Tidak` hanya dari Pengaturan | ST-COMP-18, 24 |
| VAT-02 | MUST | Persentase PPN diisi sendiri Owner, **tanpa nilai awal**; perubahan memiliki waktu efektif dan audit | ST-COMP-17, 19 |
| VAT-03 | MUST | Bila sakelar Tidak atau persen kosong, tidak ada PPN pada rekap; jika Ya + persen ada, berlaku cakupan barang | ST-COMP-18–19 |
| VAT-04 | MUST | Owner memilih `Semua barang` atau `Pilih barang`; subsidi selalu dikecualikan | ST-COMP-20–22 |
| VAT-05 | MUST | Tidak ada kontrol centang PPN per transaksi; kasir tidak dapat memodifikasi PPN via API | ST-COMP-24 |
| VAT-06 | MUST | Kontrak POS: persen × jumlah harga barang kena PPN, dibulatkan rupiah terdekat (pecahan ≥0,50 ke atas) | ST-COMP-23 |
| VAT-07 | MUST | PPN transaksi, persen efektif, alokasi *largest remainder* per baris, nilai sebelum pembulatan dan snapshot dicatat untuk retur | ST-COMP-16, 17, 25 |
| VAT-08 | MUST | Omzet dan laba kotor **tidak termasuk PPN**; piutang/tagihan memuat PPN sesuai transaksi; struk bukan Faktur Pajak resmi | ST-COMP-12 |
| VAT-09 | GATED C-02 | Sebelum fitur PPN go-live, uji metode POS dengan ketentuan resmi/Coretax: granularitas baris/faktur dan urutan DPP serta retur campuran | ST-COMP-26, §19 C-02 |
| VAT-10 | MUST | Owner mendapat pemberitahuan bahwa pengaturan bukan verifikasi status pajak resmi dan tanggung jawab perpajakan tetap berlaku | Tidak mengklaim aplikasi adalah otoritas pajak |

## 4.13 FR-DOC — Bukti, nomor dokumen dan portabilitas

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| DOC-01 | MUST | Sale final menghasilkan dokumen dengan nomor unik berurutan per tenant/jenis dokumen; gap sah bisa diaudit | ST-DOC-02 |
| DOC-02 | MUST | Struk berisi snapshot item/kemasan/harga, PPN bila aktif, total, pembayaran, piutang dan waktu; PDF tersedia | V4.10 §11.1 |
| DOC-03 | MUST | Cetak ulang bertanda `SALINAN` dan tidak memposting ulang Sale | ST-DOC-01 |
| DOC-04 | MUST | Cetak thermal opsional, kegagalan printer/PDF tidak membatalkan Sale yang sudah commit | ST-DOC-01 |
| DOC-05 | MUST | Tautan WhatsApp hanya berbagi manual; tidak mengklaim pesan terkirim | V4.10 §11.1 |
| DOC-06 | MUST | Ekspor lengkap data usaha Owner tersedia selama entitlement dan masa jeda terkait | ST-SUB-05–07, 12 |
| DOC-07 | MUST | Ekspor hanya dari tenant sah, dibatasi role Owner, diverifikasi ulang, dicatat di audit | ST-SEC-02, 05 |
| DOC-08 | TBD | Format ekspor portabilitas rinci, batas pemrosesan, struktur file untuk arsip jangka panjang dan kapasitas storage ditentukan pada spesifikasi data | Kriteria: data dapat dibaca tanpa bergantung pada langganan aktif |

## 4.14 FR-ANL — Dashboard dan laporan PRO

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| ANL-01 | MUST | Dashboard PRO memiliki ringkasan omzet bruto, penjualan bersih, uang diterima, kas, piutang, stok dan stok kritis | Angka berasal dari ledger/dokumen sumber |
| ANL-02 | MUST | HPP terjual dan laba kotor dipisah dari laba bersih; HPP belum terverifikasi tidak menghasilkan laba pasti | COST-06 |
| ANL-03 | MUST | Barang laris/kurang laris menurut jumlah/nilai/periode termasuk produk nol penjualan dengan aturan kelayakan produk baru yang akan dirinci | P1-04 spesifikasi teknis |
| ANL-04 | MUST | Laporan promo menyebut kuota terpakai hanya bila harga promo benar-benar dipakai | ST-POS-03–04 |
| ANL-05 | MUST | Piutang dikelompokkan per faktur, pelanggan, status jatuh tempo; dapat dilihat sampai detail transaksi | PAY-06, PAY-08 |
| ANL-06 | MUST | Penyaluran subsidi ditampilkan terpisah dari POS nonsubsidi | SUB-08 |
| ANL-07 | MUST | Dokumen pengecualian, refund belum dibayar, penahanan batch dan selisih kas/opname tampil terpisah dari omzet | ST-PAY-05, 08–09 |
| ANL-08 | MUST (PRO) | Filter periode dan produk/kategori; ekspor CSV/Excel/PDF untuk laporan PRO | V4.10 §11.2 |
| ANL-09 | TBD | Target interval refresh dashboard dan definisi barang baru/kurang laris ditetapkan sebelum sign-off laporan | Tidak ada angka atau kategori buatan |

## 4.15 FR-PLATFORM — Back-office SaaS internal

| ID | Prioritas | Requirement | Acceptance / trace |
|---|---|---|---|
| PLAT-01 | MUST | Operator platform mengelola daftar tenant minimum, status paket, periode entitlement, invoice SaaS dan permintaan bantuan | V4.10 §13.5 |
| PLAT-02 | MUST | Verifikasi pembayaran langganan dilakukan oleh pihak yang berwenang, di server, dengan bukti dan idempotensi | ST-SUB-03–04 |
| PLAT-03 | MUST | Peran keuangan platform hanya mengakses invoice SaaS, bukan transaksi pelanggan tenant | ST-SEC-20, 23 |
| PLAT-04 | MUST | Dukungan teknis tidak melihat data tenant tanpa grant Owner yang sah, berjangka, dapat dicabut dan diaudit | ST-SEC-07 |
| PLAT-05 | MUST | Override paket/masa trial memerlukan alasan, batas waktu, identitas dan izin yang tepat | ST-SEC-19 |
| PLAT-06 | MUST | Back-office bukan fitur kasir dan tidak menjadi pembeda antara PRO dan MAX | Uji permission dan boundary |
| PLAT-07 | TBD | Bentuk back-office (web internal/mobile), struktur operator, dan cara bayar langganan ditentukan di desain teknis | Tidak menetapkan toko aplikasi/payment gateway |

---
# 5. Model data konseptual dan kepemilikan informasi

**Status model:** rancangan objek/logika untuk membantu penulisan Technical Design, **bukan penetapan DBMS, tabel fisik, indeks atau skema SQL**. Nama objek bersifat konseptual. Persyaratan yang mengikat adalah hubungan, integritas, dan isolasi tenant.

## 5.1 Entitas utama

| Domain | Entitas konseptual | Data yang perlu dipertahankan / alasan |
|---|---|---|
| Keamanan SaaS | `Tenant`, `BusinessLocation`, `User`, `Role`, `Session`, `OwnerApproval`, `AuditEvent` | ID tenant/server-authenticated, aktor, role, waktu, grant, versi, audit |
| Langganan | `Subscription`, `SubscriptionInvoice`, `PaymentVerification`, `EntitlementEvent` | Paket, periode hak, sumber verifikasi server dan audit; terpisah dari transaksi kios |
| Master | `Product`, `ProductVariant`, `PackageDefinition`, `Barcode`, `PriceRule`, `Promotion` | SKU unik tenant, faktor kemasan berversi, satuan dasar, harga eceran/grosir/promo |
| Persediaan | `StockBalanceProjection`, `InventoryLedger`, `StockReceipt`, `StockHold`, `StockCount`, `InventoryAdjustment` | Mutasi fisik berdimensi tenant/lokasi/SKU/kemasan/batch/status; counted_at dan versi ledger |
| Valuasi | `InventoryValueLedger`, `SaleCostSnapshot`, `ReturnCostSnapshot`, `ValuationCorrection` | Rupiah integer, rata-rata eksak, pembagian sisa, biaya asal retur |
| Penjualan | `Sale`, `SaleLine`, `SaleDocument`, `Correction`, `Return`, `ReturnLine` | Snapshot harga/kemasan/batch/tax, perubahan append-only, dokumen asal |
| Pembayaran | `Payment`, `PaymentAllocation`, `Receivable`, `RefundApproval`, `RefundAttempt`, `RefundPayment`, `RefundReturned` | Identitas sumber, status verifikasi, saldo kewajiban, approval tunggal, dana balik |
| Pengecualian | `UnmatchedReceipt`, `ExceptionAllocation`, `ExceptionRefund`, `ExceptionCarryOver` | Terima tanpa Sale, alokasi/refund terpartisi, keputusan Owner, tutup hari |
| Keuangan operasional | `CashDay`, `CashMovement`, `CashCount`, `BankReceipt`, `CashDifference` | Kas laci vs bank, uang masuk riil, refund keluar riil, selisih dan waktu posting |
| Pajak konfigurasi | `VATSettingVersion`, `VATCoverage`, `VATSaleSnapshot`, `VATReturnAllocation` | Owner-set switch/rate, tanggal efektif, alokasi per baris/unit, audit perubahan |
| Subsidi | `SubsidizedAllocation`, `SubsidizedStockReceipt`, `FarmerRecipient`, `SubsidizedDistribution`, `HETRule` | Kuota angka bukan stok, stok subsidi terpisah, nama + kelompok tani, HET efektif |
| Pelaporan | `ReportQuery`, `ExportJob`, `DocumentArtifact` | View konsisten dari ledger, ekspor tenant sendiri, tautan berjangka |
| Penghapusan | `TenantDeletionRecord`, `BackupRetentionPolicy`, `RestoreReconciliation` | Tombstone terpisah dari backup; bukti penerapan ulang sebelum layanan dibuka |

**Batas data penting:** tidak ada kebutuhan menyimpan NIK/HP petani pada modul subsidi internal. Sistem penebusan resmi yang mungkin membutuhkan KTP berada di luar produk. Jaringan bank/EDC tidak otomatis terintegrasi hanya karena aplikasi menyimpan referensi pembayaran.

## 5.2 Kunci logis dan hubungan

1. **Semua objek bisnis tenant** wajib dapat ditelusuri ke tenant terautentikasi server dan lokasi yang diizinkan; `tenant_id` yang dikirim klien tidak memberi hak akses.
2. `SaleLine` merujuk `Sale` final dan snapshot SKU/kemasan/harga/PPN/HPP/kuantitas/batch, bukan mengambil ulang harga atau aturan pajak terkini untuk histori.
3. `InventoryLedger` adalah sumber kebenaran perpindahan stok; `StockBalanceProjection` hanyalah turunan yang dapat dibangun ulang.
4. `ReturnLine` merujuk tepat ke baris `SaleLine` asal, kuantitas sebelumnya yang sudah kembali, dan snapshot HPP/PPN yang belum dibalik.
5. `RefundApproval` terkait satu kewajiban refund dari faktur atau satu jalur pengecualian; **jangan mencampurkan rumus plafon kedua domain**.
6. Satu `RefundApproval` boleh memiliki beberapa `RefundAttempt` (transfer manual gagal lalu dicoba ulang) namun maksimal **satu posting refund dibayar sah** pada persetujuan itu. Bila posting yang sah kemudian benar-benar kembali, peristiwa `RefundReturned` merujuk posting asal, bukan menghapusnya.
7. `UnmatchedReceipt` menautkan penerimaan eksternal terverifikasi ke pilihan tepat satu jalur: penjualan baru sah dalam sesi sama **atau** refund. Nominal yang kembali dari refund diletakkan lagi pada `RECEIVED_UNMATCHED` menunggu keputusan Owner.
8. `AuditEvent` untuk entri finansial, pajak, stok, persetujuan, entitlement, ekspor, akses sensitif dan penghapusan harus tahan pengubahan oleh peran bisnis biasa.

## 5.3 Status peristiwa refund manual v1

| Keadaan konseptual | Makna | Aksi yang diperbolehkan |
|---|---|---|
| `APPROVED_NOT_SENT` | Owner sudah menyetujui refund, belum ada tanda transfer dikirim | Owner boleh membatalkan dengan reautentikasi; jatah kembali satu kali |
| `TRANSFER_MARKED_SENT` | Petugas telah menandai “Transfer sudah dikirim” | Jatah tetap tertahan; **bukan** bukti dana keluar; percobaan lain di bawah approval sama diperbolehkan bila diperlukan |
| `PAID_CASH` | Refund tunai diserahkan langsung dari laci dan diposting **sekali** sebagai dibayar | **Tidak** melalui tahap *Transfer sudah dikirim*; mengurangi kas seharusnya (§6.4); pembatalan setelah diserahkan tidak diperbolehkan. Jika uang dikembalikan pelanggan, catat `REFUND_RETURNED` tunai dengan bukti penerimaan |
| `PAID_VERIFIED` | Arus dana keluar benar-benar diverifikasi dan diposting | Satu kali pencatatan dibayar; permintaan posting kedua ditolak |
| `RETURNED_VERIFIED` | Arus dana dari refund yang sudah dibayar benar-benar kembali dan dicocokkan dengan asal | Posting `REFUND_RETURNED`; saldo dihitung ulang, histori tetap ada |
| `CANCELLED_NOT_SENT` | Approval sebelum tanda terkirim dibatalkan Owner secara sah | Jatah dibebaskan satu kali; tidak dapat dipakai tanpa approval baru |

**Catatan status:** `REFUND_APPROVED_PENDING` pada ST-PAY-08 adalah **istilah payung** bagi `APPROVED_NOT_SENT` dan `TRANSFER_MARKED_SENT` yang belum benar-benar dibayar; bukan status tambahan atau bukti pembayaran. Refund tunai yang sudah diserahkan (`PAID_CASH`) tidak termasuk pending.

**Catatan spesifikasi:** label status di atas adalah representasi konseptual untuk PRD, bukan enum database yang sudah disahkan. V4.10 tidak mewajibkan status `PENDING/UNKNOWN` berasal dari bank karena refund v1 manual tanpa API penyedia. Transfer luar aplikasi yang ternyata ganda **tidak dapat secara teknis dicegah oleh aplikasi** dan menjadi bagian SOP C-03.

---

# 6. Aturan integritas dan formula yang wajib lulus

Semua angka rupiah yang dibukukan ke saldo/ledger disimpan sebagai integer. Presisi eksak/rasional dapat dipakai dalam perhitungan antara, dengan aturan pembulatan sesuai kontrak; bukan `float` biner yang menimbulkan selisih uang diam-diam.

## 6.1 Konservasi stok dan nilai

**INV-INV-01 — Ekuivalen satuan dasar:**

`total_ekuivalen = Σ(karton_tersegel × isi_per_karton) + unit_lepas`.

Contoh: 3 karton × 12 + 5 botol = 41 botol. Buka 1 karton → 2 karton + 17 botol = 41 botol. Tidak boleh menjual isi karton dan karton tersegel yang sama sekaligus.

**INV-INV-02 — Rekonsiliasi ledger:**

`StockBalance(tenant, lokasi, SKU, bentuk, batch, status) = Σ event InventoryLedger pada dimensi yang sama`.

Stok status fisik tidak pernah negatif. Dua kasir yang menghabiskan satu unit terakhir tidak boleh sama-sama commit. FEFO adalah saran dan tidak membatalkan keharusan memilih batch fisik yang layak.

**INV-COST-01 — Distribusi nilai rupiah:**

`nilai_keluar = floor(nilai_tersisa × qty_keluar / qty_tersisa)`; jika `qty_keluar = qty_tersisa`, ambil **seluruh** nilai tersisa. Aturan identik berlaku untuk pembebanan biaya transaksi dan perpindahan nilai antarstatus stok; biaya historis retur mengikuti snapshot penjualan asal.

**HPP retur sebagian (COST-04):** `HPP_retur = floor(HPP_baris_tersisa × unit_diretur / unit_baris_tersisa)`; retur yang menghabiskan sisa unit baris mengambil **seluruh** sisa HPP baris. Snapshot HPP historis tidak dihitung ulang memakai rata-rata terkini; HPP yang dibalik masuk nilai stok pemeriksaan. Contoh satu baris 3 sak ber-HPP Rp100 yang diretur satu sak tiap kali: **Rp33 + Rp33 + Rp34 = Rp100**.

Contoh: stok 3 unit total Rp100 → saat keluar satu-satu Rp33 + Rp33 + Rp34. Mutasi status 1/3 memindahkan Rp33; mutasi 2/2 yang tersisa memindahkan Rp67.

## 6.2 Konservasi faktur, retur dan refund

Untuk satu faktur:

- `F` = total nilai tagihan awal termasuk PPN yang memang dibukukan.
- `C` = total koreksi nilai final sah, bertanda positif/negatif, termasuk efek PPN.
- `R` = total retur sah, termasuk efek PPN.
- `P` = total pembayaran pelanggan yang benar-benar dibukukan sah.
- `Rf` = total refund keluar benar-benar dibayar dan terverifikasi **dikurangi** total dana refund yang benar-benar kembali dan terhubung ke refund asal.
- `B = F + C − R − (P − Rf)`.
- `Piutang_sisa = max(B,0)` dan `L = Refund_terutang = max(−B,0)`.
- `Q` = refund yang telah disetujui tetapi belum dibayar sah dan belum dibatalkan secara sah, termasuk approval bertanda transfer sudah dikirim.

**Invarian yang harus dipertahankan setiap saat:** `0 ≤ Q ≤ L`, serta `Rf ≥ 0` dan batas retur tidak melebihi sisa unit yang sah. Approval refund baru sebesar `x` hanya diterima apabila `Q+x ≤ L` dalam operasi atomik. Pembayaran refund mengurangi Q dan menambah Rf secara konsisten; peristiwa dana kembali mengurangi Rf efektif dengan tetap menyimpan bukti keluar dan kembali masing-masing.

**Contoh pengujian:** faktur Rp1.000.000, bayar Rp900.000, retur Rp250.000 → refund berhak Rp150.000. Approval Rp100.000 lalu dibayar Rp100.000 → refund sisa Rp50.000; approval Rp50.000 **diterima**. Persetujuan kedua Rp150.000 atas approval Rp150.000 yang belum dibayar **ditolak**. Koreksi harga positif yang membuat Q lebih tinggi daripada hak refund baru **ditolak** sampai diperbaiki secara sah.

**Untuk penerimaan tanpa Sale sah, rumus berbeda:**

`nilai_penerimaan_eksternal = nominal_dialokasikan_ke_Sale_sah + refund_efektif_dibayar + refund_tertunda_disetujui + nominal_RECEIVED_UNMATCHED_yang_menunggu_Owner`.

Jika dana refund yang pernah keluar benar-benar kembali, kurangi `refund_efektif_dibayar` dan tambah `RECEIVED_UNMATCHED` sebesar nilai kembali. **Tidak boleh menambahkan dana kembali sebagai omzet.** Untuk approval baru atas pengecualian, `refund_tertunda + refund_efektif_dibayar + refund_baru ≤ nilai_diterima − nilai_dialokasikan`, diperiksa atomik.

**Uji partisi nominal Rp200.000:**

| Tahap | Dialokasikan | Refund efektif dibayar | Refund tertunda | Menunggu Owner | Jumlah |
|---|---:|---:|---:|---:|---:|
| Penerimaan eksternal belum punya Sale | 0 | 0 | 0 | 200.000 | 200.000 |
| Owner setujui refund | 0 | 0 | 200.000 | 0 | 200.000 |
| Refund terverifikasi dibayar | 0 | 200.000 | 0 | 0 | 200.000 |
| Dana refund kembali/terverifikasi | 0 | 0 | 0 | 200.000 | 200.000 |
| Owner menyetujui refund ulang | 0 | 0 | 200.000 | 0 | 200.000 |

**Uji manual refund:** tanda *Transfer sudah dikirim* tidak mengurangi saldo refund tertunda atau bank. Percobaan ulang dalam persetujuan sama tidak menambah Q. Hanya verifikasi uang keluar yang membuat posting `dibayar`. Risiko instruksi transfer aktual yang dilakukan di luar aplikasi dua kali tetap perlu SOP dan pemeriksaan mutasi aktual.

## 6.3 PPN dan alokasi residual

Jika konfigurasi aktif dan persentase ada, untuk barang yang dicakup Owner (selalu mengecualikan pupuk subsidi):

`PPN transaksi = round_half_up(persen × total_harga_jual_barang_terpilih)` ke rupiah penuh.

- Semua perhitungan dibuat dari **snapshot persen dan harga pada transaksi final**.
- Alokasi PPN ke baris memakai metode *largest remainder* untuk menjaga `Σ alokasi_baris = PPN_transaksi`, dengan ID baris stabil untuk tie-break.
- Saat retur sebagian unit suatu baris, `PPN_retur = floor(PPN_baris_tersisa × unit_diretur / unit_baris_tersisa)`; retur unit terakhir mengambil seluruh sisa PPN baris.
- Omzet tanpa PPN; uang diterima dan piutang menurut tagihan aktual termasuk PPN; laba kotor = penjualan bersih tanpa PPN − HPP terkait.
- **Batas kepatuhan C-02:** persamaan ini merupakan kontrak perhitungan POS dalam V4.10. Validasi hasil terhadap Coretax/ketentuan resmi untuk variasi DPP, pembulatan per baris/per faktur, transaksi campuran dan retur tetap wajib sebelum fitur PPN dirilis. Struk bukan Faktur Pajak resmi.

## 6.4 Kas seharusnya

`kas_akhir_seharusnya = kas_awal_terverifikasi_atau_sementara + tunai_bersih − refund_tunai_aktual − pembelian_stok_tunai_dari_laci − pengeluaran_tunai_sah − setoran_bank_tunai − pengambilan_owner_tunai ± koreksi_kas_sah`.

Uang tunai diterima bersih = uang diserahkan − kembalian. Transfer, QRIS dan EDC tidak dianggap kas laci. `kas_fisik` adalah hitungan riil; `selisih = kas_fisik − kas_seharusnya`. Refund pending bukan kas keluar. **Refund tunai `PAID_CASH` Rp50.000 yang benar-benar diserahkan mengurangi kas seharusnya Rp50.000 tepat sekali**, tidak melalui tanda transfer; posting ulang ditolak. Refund yang benar-benar keluar lalu kembali dibukukan sebagai **dua arus uang riil**, bukan dihapus silang secara tak terlacak.

## 6.5 Invarian tenant, approval dan audit

- Semua perubahan stok/penjualan/pembayaran/piutang/refund yang saling terkait bersifat atomik, versi-entitas benar dan idempoten.
- Hanya Owner yang mengesahkan tindakan sensitif; Admin boleh melakukan penahanan keselamatan yang langsung efektif.
- Tidak ada saldo pelanggan otomatis dari pengembalian uang gagal atau pembayaran lebih selain pengembalian tunai.
- Penggantian waktu perangkat, spoof tenant, spoof paket, atau upaya melalui API langsung tidak boleh mengubah hak bisnis.
- Layanan yang dipulihkan dari backup **wajib** menerapkan daftar tenant yang sudah dihapus sebelum membuka akses.
- Ekspor, objek PDF, identitas pelanggan, dan data perangkat terikat izin tenant/role yang sama kuatnya dengan endpoint transaksi.

---

# 7. Rancangan layar, navigasi, dan UX

**Status:** peta layar dan acceptance UX (belum final desain Figma). Target antarmuka v1 adalah HP dan tablet Android/iOS. Website publik pelanggan dan `.exe` tidak termasuk.

## 7.1 Struktur menu kios PRO

Menu utama tidak lebih dari delapan: **Dashboard; Kasir; Produk & Stok; Pelanggan & Piutang; Harga & Barang Diskon; Retur & Koreksi; Laporan; Pengaturan.** Kas harian ditempatkan di Kasir, bukan menu ERP tambahan. Submenu penyaluran subsidi dibuat sebagai alur khusus dalam arsitektur navigasi, tidak melalui POS umum; penempatan detailnya harus diuji terhadap batas delapan menu.

## 7.2 Peta layar minimum

| Layar / alur | Kebutuhan tampilan | Kondisi kesalahan / kosong |
|---|---|---|
| Registrasi, OTP, login dan pemulihan | Status verifikasi, pesan netral terhadap enumerasi, loading dan aksesibilitas OTP | OTP salah/expired, limit, hilang HP |
| Ringkasan trial/langganan | Paket efektif, masa sisa dari server, batas fitur dan ekspor, tanggal hapus | Trial/PRO dikunci, gagal verifikasi bayar |
| Dashboard | Omzet, uang diterima, stok kritis, piutang, status barang, item laris/kurang laris sesuai entitlement | Tenant baru tanpa transaksi; HPP belum valid |
| Kasir | Cari/scan barang, kemasan/batch, qty, harga, rekap PPN otomatis, metode bayar, struk | Stok habis/ditahan/expired, harga berubah, jaringan putus |
| Master produk | Satu alur identitas → kemasan/harga → **stok awal wajib**/batch | SKU/barcode ganda, faktor isi tidak sah, stok 0 |
| Detail produk & penerimaan | Tambah Stok, riwayat mutasi, buka karton, status batch | Barang tidak boleh dibuka, batch tak layak |
| Barang Diskon & grosir PRO | Aturan harga valid, kuota promo, otorisasi Owner | Promo habis, harga grosir lebih murah |
| Pelanggan & Piutang | Daftar faktur, umur piutang, pembayaran, tombol WA manual | Kontak tak ada, data pelanggan umum, duplikasi pelunasan |
| Pengajuan Owner | Jumlah/reason/versi/bukti, keputusan setuju/tolak | Pengajuan usang, belum dijawab, jaringan putus |
| Retur & refund | Pilih faktur/unit, status approval, tanda transfer manual, percobaan ulang, bukti dibayar/returned | Refund melebihi hak, bukti tak cocok, duplikasi posting |
| Pengecualian pembayaran | Uang masuk tanpa Sale, opsi alokasi sah atau refund, status unmatched/carry-over | Tidak boleh jadi deposit/omzet, tutup hari terblokir |
| Kas harian | Kas awal fisik/sementara, tunai, bank terpisah, selisih, kewajiban refund pending | Hari belum ditutup, carry-over perlu Owner |
| Penyaluran pupuk subsidi | Alokasi administratif, stok fisik, petani/kelompok tani, HET, penyaluran, rekap | Di atas HET/stok; tempo belum C-01 |
| Pengaturan PPN | Sakelar, persen kosong awal, semua/pilih barang, tanggal efektif | PPN aktif tetapi persen belum diisi, subsidi dikecualikan |
| Laporan & ekspor | Filter periode/produk, sumber angka jelas, ekspor data lengkap | Data kosong, item biaya tak tervalidasi |
| Back-office SaaS internal | Tenant/entitlement/invoice langganan/bantuan/insiden | Dilarang melihat laporan penjualan tenant |

## 7.3 Prinsip interaksi dan aksesibilitas

- Tidak menggunakan penampilan 'AI-powered', emoji UI, gradien ungu-biru sebagai identitas utama atau efek dekoratif berlebihan.
- Kata kerja operasional memakai bahasa toko: **Bayar, Tagih, Tambah Stok, Buka Karton, Tahan Penjualan, Ajukan Retur, Cetak Struk**.
- Target sentuh minimum proyek **44×44 CSS px** dan kontras teks normal **4,5:1** serta teks besar **3:1** dengan pengecualian standar WCAG 2.2 AA.
- Kasir dalam kasus tunai sederhana: target maksimal **3 ketukan dari pemindaian sampai tombol Bayar**. Jalur batch, kredit, refund dan approval boleh lebih panjang dengan alasan jelas.
- Tampilkan nilai rupiah dan kuantitas besar/terbaca pada HP/tablet serta kondisi cahaya terang; responsif tidak berarti ada versi web pelanggan dalam v1.
- Semua form mempunyai state loading, kosong, error, konflik versi, offline, timeout, jaringan pulih dan kegagalan printer. Dalam offline hanya katalog cache/keranjang draft; **jangan memberi tampilan pembayaran final jika server belum commit**.
- Pengguna kios/kasir sungguhan wajib menguji prototipe; ukuran sampel dan target keberhasilan UX belum ditetapkan, tidak diisi secara sepihak.

---

# 8. Keamanan, privasi dan persyaratan nonfungsional (NFR)

## 8.1 Ancaman utama dan kontrol minimum

| ID | Risiko / titik serang | Persyaratan keamanan yang dapat diuji |
|---|---|---|
| SEC-01 | Akses lintas tenant / IDOR / BOLA | Tenant berasal dari sesi server; semua resource termasuk PDF, laporan, objek, export dan pembayaran memverifikasi tenant+role; uji lintas tenant seluruh metode |
| SEC-02 | Spoof role/entitlement | Keputusan hak berada di backend; klien tidak dapat mengaktifkan PRO/MAX atau mengubah masa trial |
| SEC-03 | Pengambilalihan akun | OTP dan password rate limit; anti-enumerasi; reset Owner berlapis; revoke sesi benar-benar berlaku |
| SEC-04 | Perubahan uang/stok tanpa otorisasi | Transaksi atomik/idempoten, kontrol versi, approval Owner sensitif, audit append-only dan reautentikasi |
| SEC-05 | Paparan data pelanggan | Nomor HP masked secara default; buka nomor lengkap hanya untuk keperluan sah dan dicatat; ekspor massal hanya Owner |
| SEC-06 | Injeksi/XSS/CSRF/akses aplikasi | Validasi masukan, query aman, proteksi XSS/injeksi, CSRF jika sesi cookie, TLS wajib, secret tidak di aplikasi mobile |
| SEC-07 | Akses dukungan ilegal | Grant Owner untuk cakupan/tujuan/maksimum masa berlaku tertentu; tanpa grant tidak bisa membaca data tenant |
| SEC-08 | Insiden/backup/ransomware | Enkripsi transit & at rest, backup terenkripsi, isolasi akses, uji restore, alert, pemulihan tenant deletion tombstones |
| SEC-09 | Perangkat hilang, di-root, shared tablet | Token/sesi aman dan dapat dicabut, cache minimum dan terlindung, tanpa secret backend di paket aplikasi |
| SEC-10 | Insider operator platform | Akses metadata SaaS dan invoice langganan terpisah dari data bisnis tenant; override terbatasi dan diaudit |
| SEC-11 | Kebocoran informasi melalui notifikasi/WhatsApp | Pesan minimum, pratinjau penerima, tidak membocorkan barang sensitif/riwayat utang penuh secara otomatis |

**Acuan QA wajib:** ST-SEC-01–24 (sesuai keberadaan ID dalam lampiran V4.10), ST-SUB terkait, ST-RET uang, dan ST-INV konkurensi. Keamanan **setara** di FREE, PRO dan MAX, tidak boleh dijual sebagai upgrade.

## 8.2 Perlindungan Data Pribadi

- Pemetaan peran pengendali/prosesor dilakukan menurut tujuan pemrosesan; tenant kios umumnya pengendali data pelanggan, platform prosesor di bawah perjanjian, dan platform dapat menjadi pengendali tersendiri untuk akun/langganan/keamanan.
- Data pribadi dikumpulkan minimum; tidak mengumpulkan NIK pada POS umum maupun modul internal penyaluran subsidi.
- Pemrosesan harus memiliki dasar sah per tujuan; tidak menganggap semua memerlukan satu kotak consent.
- Ada mekanisme permintaan akses/koreksi/penghapusan yang sah, termasuk bukti identitas pemohon dan pengecualian retensi hukum.
- Insiden pelindungan data dipantau dan jalur pemberitahuan dibangun sesuai hukum dan peran pengendali/prosesor. Detail SLA internal untuk notifikasi prosesor kepada tenant harus disahkan bersama DPA.
- Ketentuan subprosesor, daftar pihak, lokasi tujuan data, offboarding, dan kebijakan retensi wajib dituangkan dalam dokumen hukum sebelum komersialisasi.
- Tidak menjanjikan penghapusan selektif seketika dari immutable backup; ada batas retensi yang diumumkan dan bukti bahwa akun yang dihapus tidak hidup setelah restore.

## 8.3 Performa, daya tahan, pemulihan dan operasi

| ID | Ukuran | Status | Kriteria pengesahan/tes |
|---|---|---|---|
| NFR-01 | Scan → item keranjang p95 | **TBD**, bukan angka yang diklaim | Uji perangkat kelas bawah dan jaringan kios nyata |
| NFR-02 | Tekan Bayar → komit server p95 | **TBD** | Simulasi concurrency, latency dan timeout |
| NFR-03 | Uptime bulanan | **TBD** | Perhitungan dari transaksi nyata, bukan ping server saja |
| NFR-04 | RPO data | **TBD — syarat rilis** | Restore tervalidasi terhadap stok, pembayaran, piutang, audit |
| NFR-05 | RTO layanan | **TBD — syarat rilis** | Waktu sampai transaksi POS dapat dilanjutkan setelah restore |
| NFR-06 | Backup dan retensi maksimum | **TBD — syarat rilis** | Pemulihan terenkripsi, expiry backup, tombstone tenant terhapus |
| NFR-07 | Periode rekonsiliasi ledger | **TBD** | Deteksi drift proyeksi vs sumber ledger; alert tanpa edit histori |
| NFR-08 | Kapasitas tenant/storage/dokumen | **TBD** | Simulasi volume SKU, transaksi bertahun-tahun, foto, backup dan ekspor |
| NFR-09 | Batas sesi/OTP/permintaan API | **TBD spesifikasi keamanan** | Rate limit diuji tanpa menghalangi kebutuhan sah |
| NFR-10 | SLA tindak lanjut refund tertunda | **TBD — syarat rilis C-03** | Uji eskalasi, Owner approval carry-over dan overdue |
| NFR-11 | Keselarasan perangkat printer/scanner | **TBD uji lapangan** | Daftar kompatibilitas dan fallback PDF |
| NFR-12 | Keamanan mobile | Wajib; detail SDK/OS TBD | Analisis ancaman Android/iOS dan uji perangkat hilang/revokasi |

**Pelarangan klaim:** tidak boleh mengiklankan SLA/keamanan teruji atau compliant terhadap sistem resmi sebelum benar-benar ada bukti pengujian/sertifikasi/penilaian yang relevan.

---

# 9. Strategi pengembangan dan prioritas tanpa mengubah hak paket

Urutan kerja berikut adalah **saran penyusunan backlog**, bukan janji tanggal, bukan pemotongan fitur wajib PRO, dan bukan izin memproduksi sebelum seluruh gerbang yang relevan lulus.

| Tahap engineering | Kelompok kerja | Bukti selesai |
|---|---|---|
| E0 — Fondasi keamanan dan domain | Tenant, akun/role, entitlement, audit, ledger, model stok dan uang, migrasi/backup awal | Uji lintas tenant, integritas transaksi, login dan dasar restore |
| E1 — POS & stok | Master Produk, batch, kemasan, stok awal/masuk, penahanan, POS online, pembayaran manual, dokumen | ST-INV/ST-POS/ST-PAY/ST-DOC inti lulus |
| E2 — Keuangan operasional | Piutang, retur, approval, refund manual, pengecualian uang, kas harian | Seluruh ST-RET/ST-PAY lanjutan dan ST-CASH lulus |
| E3 — Nilai dan wawasan | HPP, promo/grosir PRO, dashboard, analitik, laporan, ekspor | Konservasi rupiah, laporan dan data portabilitas lulus |
| E4 — Subsidi dan konfigurasi PPN | Alokasi vs stok fisik subsidi, HET, data petani, PPN konfigurasi Owner | Semua ST-COMP lulus; tempo subsidi tetap gated sampai C-01; PPN sampai C-02 |
| E5 — Operasi SaaS & hardening | Back-office minimum, billing verification, lock/grace/delete, restore/tombstones, mobile hardening dan pilot | ST-SUB/ST-SEC/ST-UX lulus; C-03/C-04 dan dokumen hukum ditutup |

Tahap E0–E5 boleh dikerjakan paralel pada bagian independen dengan desain kontrak dan pengujian integrasi. Pemetaan ini bukan penghapusan fitur dari release PRO; bila modul mandatory belum lulus, produk belum boleh diklaim lengkap.

---

# 10. Matriks penerimaan dan pengujian

## 10.1 Jenis pengujian yang wajib direncanakan

| Kelas | Metode pengujian | Kondisi lulus |
|---|---|---|
| Unit dan property-based | HPP, PPN, retur, pembagian residual, kuantitas kemasan, plafon refund, partisi uang | Semua invariant terpenuhi pada data tepi, nol, pembulatan dan urutan peristiwa berbeda |
| Integrasi DB | Atomic commit/rollback, idempotensi, transaksi ke ledger, nomor dokumen, audit | Retry/concurrency tidak menggandakan data atau mengubah saldo secara ilegal |
| Keamanan API | IDOR/BOLA lintas tenant, role/entitlement spoof, GET/POST/PATCH/DELETE, ekspor/PDF | Tidak ada akses/data bocor dan tidak ada bypass melalui API langsung |
| Mobile | Token aman, revoke sesi, rooted/lost device, offline, resume, printer/WA manual | Tidak ada finalisasi offline, state UI konsisten dengan status commit server |
| Alur kas/uang | Tunai, campuran, piutang, refund manual, gagal/ulang, `REFUND_RETURNED`, carry-over | Mutasi laci/bank hanya sesuai uang aktual; tidak ada deposit/pending Sale fiktif |
| Retensi dan disaster recovery | Restore terenkripsi, RPO/RTO, tombstone tenant, expiry backup | Ledger cocok, tenant dihapus tidak dapat aktif kembali, pemulihan sesuai target disahkan |
| Kepatuhan subsidi/PPN | HET efektif, jumlah fisik, subsidi vs umum, PPN Owner, formula Coretax | C-01/C-02 telah ditutup sesuai cakupan fitur yang dirilis |
| Uji pengguna kios | Waktu dan ketukan transaksi tunai, keterbacaan HP/tablet, kerja di lapangan | Hasil terukur dan sign-off pemilik setelah pilot |

## 10.2 Definisi lulus dan bukti

Setiap kasus uji mempunyai: `ID`, tautan FR, precondition, input, aksi, hasil yang diharapkan, hasil aktual, bukti log/dokumen/screenshot yang aman, build/lingkungan, tanggal, pelaksana dan status. Teks contoh pada V4.10 adalah **spesifikasi**, bukan bukti uji aplikasi. Pemeriksaan model matematika hanya menutup lapisan model, tidak menggantikan uji database/runtime.

## 10.3 Persyaratan keamanan QA minimum

1. Transaksi dua kasir merebut stok terakhir: satu sukses atau semuanya gagal secara sah, tidak pernah dua sukses dengan stok negatif.
2. Dua approval Owner mengakses kewajiban refund yang sama: hanya satu dapat mengambil jatah yang tidak mencukupi untuk dua.
3. Penandaan `Transfer sudah dikirim` tidak boleh secara otomatis mencatat uang keluar; retry transfer manual memakai approval yang sama.
4. Setelah `REFUND_RETURNED`, saldo pengecualian kembali menunggu keputusan Owner dan rekonsiliasi tetap sama dengan nilai diterima.
5. Refund yang dibayar dan dikonfirmasi ulang tidak menciptakan dua posting uang keluar.
6. Owner/Operator A tidak dapat membaca/mengekspor dokumen tenant B; bantuan platform butuh grant sesuai batas.
7. Restore backup lama yang masih memuat tenant dihapus harus menahan pembukaan layanan sampai tombstone diterapkan.
8. Masa trial yang sudah lewat tidak dapat diperpanjang melalui jam perangkat atau payload palsu.

---

# 11. Ketertelusuran keputusan, persetujuan, dan daftar terbuka

## 11.1 Mapping keputusan V4.10 → PRD

| Keputusan sumber | Perlakuan dalam PRD | FR utama |
|---|---|---|
| V3.3–3.4 POS langsung/pembayaran manual | Final online, pembayaran tunai/transfer/QRIS/EDC | POS-01–08, PAY-01–04 |
| V3.5–3.11 pelanggan/piutang/WA manual | Piutang per faktur, alokasi per barang, tanpa notifikasi WA otomatis | PAY-05–09 |
| V3.12–3.19 retur/refund/koreksi/dokumen | Owner approval, snapshot, koreksi append-only, struk | RET-01–12, DOC-01–05 |
| V3.20–3.22 harga grosir/promosi | PRO, harga valid terendah dan kuota nyata | POS-03–05 |
| V3.23–3.28 kemasan/batch/penerimaan | Stok awal wajib, satuan integer, FEFO dan buka karton | PRD-01–08, INV-01–11 |
| V3.16 & V3.29 batas MAX | Klaim pemasok terintegrasi dan transfer lokasi dikecualikan PRO | §1.4, §2.1 |
| D-01 subsidi | Alokasi ≠ stok, HET, penyaluran terpisah; tempo C-01 | SUB-01–09 |
| D-02, V4.7–V4.8 PPN | Switch Owner dan persen tanpa default; round half up + C-02 | VAT-01–10 |
| D-03, D-06, D-07 trial/PRO | 7 × 24 jam, Rp287.000/Rp3 juta, 1 Owner+1 Admin | ENT-01–10 |
| D-04 HPP | Moving average dan sisa rupiah deterministik | COST-01–07 |
| D-05 kas/hold/campuran; **K-1 = A** | Hold langsung, campuran, **tutup hari dasar FREE dan PRO** | INV-06, INV-11, PAY-02, CASH-01–07; ST-CASH-05 |
| V4.6-01 s.d. 08 | Koreksi nominal, refund carry-over, backup dan back-office | RET-05, EXC-01–09, ENT-09, PLAT-01–07 |
| V4.7-03/04/06 | Plafon refund, tombstone, residual perpindahan stok/PPN | RET-06–10, ENT-09, COST-05, VAT-07 |
| V4.9 revisi refund | Bukti keluar/return yang sah, tidak menimpa histori | RET-10, EXC-06 |
| **V4.10-01** transfer refund manual | Tanda internal, retry dalam approval sama, bayar sekali | RET-08–09, EXC-04–05 |
| **V4.10-02** return pengecualian | `RECEIVED_UNMATCHED`, Owner decision, konservasi dana | EXC-06–08, CASH-06 |
| **K-2 = A (8 Nov 2026)** | **Admin PRO mengajukan** harga/grosir/promo; Owner yang menyetujui/menetapkan | §4.1 matriks izin; POS-03–05 |
| D-14 back-office SaaS | Konsol platform terpisah dan RBAC | PLAT-01–07 |

## 11.2 Parameter/keputusan yang belum boleh dianggap final

| ID | Topik | Penanggung jawab keputusan yang diperlukan | Dibutuhkan paling lambat |
|---|---|---|---|
| OPEN-01 | Metode bayar langganan, kanal pembelian Android/iOS, jadwal billing, pembatalan/refund langganan | Pemilik produk + penilaian komersial/legal platform | Sebelum implementasi penagihan publik |
| OPEN-02 | Harga MAX, jumlah cabang/akun dan seluruh detail transfer/klaim MAX | Pemilik; PRD MAX terpisah | Tidak memblokir PRD FREE/PRO |
| OPEN-03 | Default jatuh tempo piutang, masa approval, stok minimum, interval kedaluwarsa | Owner tenant untuk operasional; default proyek setelah pilot | Sebelum sign-off layar terkait |
| OPEN-04 | Target performa p95, uptime, volume SKU, penyimpanan dan kapasitas | Tim engineering + pemilik setelah pengujian | Sebelum SLA/produksi |
| OPEN-05 | RPO/RTO, `BACKUP_RETENTION_MAX`, jadwal uji restore dan legal hold | Engineering/Security, Legal, pemilik mengesahkan kebijakan | **Wajib sebelum rilis (C-04)** |
| OPEN-06 | SLA, eskalasi dan rekonsiliasi transfer/refund manual | Operator bisnis/engineering, disahkan pemilik | **Wajib sebelum rilis (C-03)** |
| OPEN-07 | Penyaluran tempo subsidi sesuai ketentuan resmi/pedoman teknis | Verifikasi tertulis dari instansi/pihak resmi yang kompeten | **Sebelum mengaktifkan tempo subsidi (C-01)** |
| OPEN-08 | Metode perhitungan PPN resmi sesuai kondisi barang dan Coretax | Penilai pajak/ahli + pengujian dengan dokumen resmi | **Sebelum fitur PPN go-live (C-02)** |
| OPEN-09 | Metadata pestisida wajib, kesesuaian kemasan/label dan SOP | Penelaahan ketentuan produk oleh pihak kompeten | Sebelum metadata/prosedur dipasarkan sebagai patuh |
| OPEN-10 | Aturan eligible produk baru, definisi laris/kurang laris dan pengukuran UX pilot | Tim produk + pemilik setelah uji lapangan | Sebelum laporan/UI final |
| OPEN-11 | Standar desain final, target OS, scanner/printer/EDC yang didukung | Tim desain/engineering, pilot lapangan | Sebelum paket release aplikasi |
| OPEN-12 | Retensi akun/security logs, DPA/subprosesor, kebijakan privasi dan ToS | Legal/security + pemilik | Sebelum penjualan SaaS publik |

**Tidak dimasukkan sebagai keputusan baru:** pengenaan PPN wajib berbasis deteksi status PKP, produk baru 'wajib diklasifikasi' sebelum dijual, kotak centang PPN di checkout, PPN default 11%, saldo deposit pelanggan, integrasi gateway refund, dan finalisasi offline. Hal tersebut bertentangan atau tidak termasuk keputusan V4.10.

## 11.3 Risiko yang tetap perlu diakui

| Risiko | Dampak jika diabaikan | Kontrol / gerbang |
|---|---|---|
| Transfer manual dua kali di aplikasi bank, hanya satu yang diposting di POS | Pelanggan menerima refund berlebih tanpa diketahui POS | SOP dan rekonsiliasi mutasi/bukti; C-03, tidak mengklaim jaminan mutlak |
| Owner salah memilih cakupan/rate PPN | Nominal/arsip pajak tidak cocok | Edukasi Owner dan uji kepatuhan C-02; tidak mengarang status pajak |
| Kios mengaktifkan tempo subsidi sebelum dasar resmi | Risiko ketidakpatuhan pada penyaluran subsidi | Feature gate nonaktif hingga C-01 |
| Backup menghidupkan tenant yang sudah dihapus | Risiko pelanggaran privasi/offboarding | Tombstone terpisah, cek sebelum restore dibuka; C-04 |
| Identitas tenant atau role dipalsukan | Kebocoran finansial dan data pribadi | Server-side ACL/RLS atau setara, ST-SEC |
| Stok rusak/expired tetap dijual karena cache perangkat | Risiko keselamatan dan stok tidak akurat | Backend block & batch status, final online saja |
| HPP hilang akibat pembulatan per unit | Laporan laba kotor salah | Rupiah integer + residual deterministik dan snapshot |
| Syarat dokumen hukum/ekspor tidak dipenuhi | Risiko hilangnya catatan pajak dan hak data | ToS, ekspor full, pemberitahuan jadwal penghapusan |

---

# 12. Kriteria pengesahan PRD dan rilis

## 12.1 Persetujuan baseline PRD (sebelum pengembangan)

**Pengesahan pemilik: TELAH DIBERIKAN pada 8 November 2026.** Butir pemeriksaan berikut dipertahankan sebagai kontrol handoff dan kesiapan rekayasa; butir teknis yang belum dilaksanakan tidak boleh dianggap lulus hanya karena PRD disahkan.

- [ ] Pemilik membaca dan menyetujui ruang lingkup FREE Trial dan PRO, serta batas MAX.
- [ ] Review memastikan tidak ada perubahan diam-diam keputusan V4.10.
- [ ] Owner menyetujui hak peran, alur POS langsung, penanganan uang, dan data yang dikumpulkan.
- [ ] Tim teknis mengakui setiap `MUST`, `GATED`, dan `TBD` serta menghubungkannya ke acceptance case.
- [ ] Empat syarat C-01–C-04 dicatat sebagai kondisi rilis, bukan dianggap sudah terpenuhi.
- [ ] Status implementasi dan pengujian tetap **BELUM DIUJI**, kecuali bukti aktual yang terdokumentasi pada build kelak.

## 12.2 Exit criteria setiap modul engineering

- Semua requirement MUST pada modul bersangkutan memiliki test case yang dapat dijalankan otomatis/manual dan bukti uji.
- Semuanya lulus uji keamanan lintas tenant/role, negative path, timeout, konkurensi, dan idempotensi yang relevan.
- Uang, inventori dan audit ledger dapat direkonsiliasi setelah rollback, retry dan restore.
- Tidak ada keputusan bisnis yang disimpulkan dari parameter kosong.
- UX diuji pada perangkat HP/tablet Android/iOS yang realistis sebelum disahkan.

## 12.3 Exit criteria rilis produksi

**Wajib:** semua kontrol keamanan dan invariant selesai diuji, backup/restore RPO/RTO serta tenant deletion lulus, dokumen hukum siap, prosedur dana manual dan pengecualian lulus C-03, serta pengujian performa dan perangkat selesai.

**Gate khusus:** tempo subsidi tetap *disabled* jika C-01 belum terbukti; fitur PPN tidak boleh dirilis tanpa C-02. Manajemen feature gate harus ditegakkan backend, bukan sekadar menyembunyikan tombol UI.

## 12.4 Aturan perubahan PRD

Setiap revisi setelah PRD V1.1 disahkan harus memuat: ID perubahan, requirement terdampak, alasan, sumber keputusan pemilik, efek paket, risiko keamanan/keuangan/hukum, uji regresi, dan status persetujuan. Pengembang tidak boleh memindahkan modul MAX ke PRO atau menambah workflow yang memengaruhi uang/stok tanpa change request eksplisit.

---

# Lampiran A — Matriks uji penerimaan dari landasan V4.10

**Catatan:** Kasus uji awal berasal dari §17 V4.10 dengan ID sumber dipertahankan; **ST-COST-07, ST-CASH-05, ST-RET-24, dan ST-COMP-27 ditambahkan pada V1.1** atas keputusan/perbaikan PRD di §0. Ini spesifikasi pengujian, **bukan laporan lulus aplikasi**. Sejumlah ID disusun berdasarkan riwayat perubahan sehingga tidak selalu berurutan numerik. Apabila ditemukan perbedaan antara narasi PRD dan kasus uji lampiran, keputusan produk V4.10 harus direkonsiliasi sebelum implementasi; jangan memilih diam-diam.

### 17.1 Produk, batch, stok, biaya dan kas

| ID | Kondisi awal / aksi | Hasil yang harus diperoleh |
|---|---|---|
| ST-INV-01 | Produk baru stok awal 0 | Master tersimpan, POS menolak jual sebelum stok masuk |
| ST-INV-02 | Stok 3 karton isi 12 + 5 botol | Total ekuivalen **41**, tidak dihitung ganda |
| ST-INV-03 | Buka 1 karton isi 12 | Karton −1, botol lepas +12, total 41 dan nilai biaya tetap |
| ST-INV-04 | Dua kasir menjual unit siap jual terakhir | Paling banyak satu berhasil, saldo tak negatif |
| ST-INV-05 | Penerimaan stok dikirim ulang/dua koneksi | Hanya satu event dan penambahan stok |
| ST-INV-06 | Batch kadaluwarsa disertakan langsung melalui API | Ditolak backend, walau UI dimanipulasi |
| ST-INV-07 | Admin menahan batch berisiko, Owner belum jawab | **Penjualan langsung diblokir**; pelepasan butuh Owner |
| ST-INV-08 | Buka karton dari batch A | Semua botol lepas mengikuti batch/expiry A |
| ST-INV-09 | Count barang dilakukan, lalu terjual sebelum Owner setujui | Delta opname direkonsiliasi; penjualan setelah counted_at tidak terhapus |
| ST-INV-10 | Ledger dan saldo cache sengaja dibuat tidak cocok | Alert keluar; ledger asal tidak dipalsukan agar seolah cocok |
| ST-INV-11 | Barang rusak → retur pemasok/pemusnahan | Jumlah fisik dan nilai pemulihan terlacak, kerugian tidak diakui dua kali |
| ST-INV-12 | Produk yang tidak boleh dibuka dipanggil endpoint konversi | Ditolak server |
| ST-INV-13 | Transaksi penjualan gagal tepat sebelum commit | Semua stok, kas, piutang, HPP, dokumen dan promo rollback utuh |
| ST-COST-01 | 3 unit total Rp100 terjual bertahap | Total HPP Rp100, stok 0, nilai sisa Rp0 |
| ST-COST-02 | Retur satu unit dari baris ber-HPP Rp33 | HPP yang diretur Rp33, ke pemeriksaan, bukan rata-rata baru |
| ST-COST-03 | Karton dibuka dan batch berubah status | Total nilai persediaan dipertahankan selama belum ada write-down sah |
| ST-COST-04 | Stok bonus bernilai 0 dengan dokumen pemasok | Tercatat jelas, tidak menyamarkan biaya yang tak diketahui |
| ST-COST-06 | 3 botol Rp100 siap jual; 1 botol ditahan, lalu 2 botol sisanya ditahan | Nilai pindah Rp33 lalu Rp67; total nilai tetap Rp100 |
| ST-COST-05 | Rp1.000.000 atas 7 unit, terjual 2, 2, 3 | Beban 285.714; 285.714; 428.572; total 1.000.000, nilai sisa 0 |
| **ST-COST-07** | Satu baris 3 sak dengan HPP historis Rp100, diretur satu sak pada tiga transaksi terpisah | HPP retur Rp33, Rp33, Rp34; jumlah Rp100; setiap nilai HPP retur masuk status pemeriksaan; tidak memakai rata-rata HPP kini |
| ST-CASH-01 | Tunai 550.000, kembalian 50.000, pembelian 100.000, biaya 50.000, setor 200.000 | Perubahan kas seharusnya +Rp150.000 |
| ST-CASH-02 | Hari sebelumnya belum tutup | Label “Saldo pembukaan sementara”; bukan kas fisik terverifikasi |
| ST-CASH-03 | Pembayaran via transfer | Uang masuk metode transfer, **bukan** kas laci |
| ST-CASH-04 | Kas fisik berbeda dari kas seharusnya | Selisih dicatat; omzet tidak otomatis dikoreksi |
| **ST-CASH-05** | Paket FREE Trial aktif, terdapat penerimaan eksternal `RECEIVED_UNMATCHED` yang belum diputuskan Owner ketika **Owner** mencoba tutup hari | **Tutup hari ditolak oleh backend**; bukti penerimaan tetap tersimpan; aturan sama dengan PRO menurut K-1 = A |

### 17.2 Kasir, harga, piutang, retur, persetujuan

| ID | Kondisi awal / aksi | Hasil yang harus diperoleh |
|---|---|---|
| ST-POS-01 | Kirim ulang finalisasi dengan idempotency key identik | Satu Sale, mutasi dan nomor struk |
| ST-POS-02 | Harga/kuota/batch berubah setelah keranjang | Konfirmasi ulang sebelum commit, tidak mengubah diam-diam |
| ST-POS-03 | Harga grosir lebih murah daripada promo | Grosir dipakai; kuota promo tidak berkurang |
| ST-POS-04 | Kuota promo sisa 3, beli 5 | Tepat 3 unit promo jika lebih murah, kuota habis 0 |
| ST-POS-05 | Kasir manipulasi harga/paket lewat API | Server menolak hak/nominal yang tak sah |
| ST-PAY-01 | Tempo 1.000.000, dibayar 400.000 | Piutang 600.000; pelunasan tidak menambah omzet |
| ST-PAY-02 | Tunai + transfer pada satu tagihan | Kedua bagian tervalidasi, total tidak melebihi tagihan; kas hanya komponen tunai neto |
| ST-PAY-03 | Ulangi konfirmasi pembayaran yang sama | Tidak ada penerimaan uang/piutang ganda |
| ST-PAY-04 | Pelanggan tidak terdaftar mencoba bayar sebagian | Transaksi ditolak sampai pelanggan terdaftar |
| ST-PAY-05 | Stok tersisa 1; kasir A dan B menerima transfer untuk unit itu, hanya A berhasil final | B tercatat Pengecualian Pembayaran; ditutup dengan Refund; total uang masuk bank − refund = total tagihan penjualan final yang dibayar lewat bank |
| ST-PAY-06 | Pengecualian pembayaran masih `RECEIVED_UNMATCHED` tanpa keputusan Owner saat tutup hari | Tutup hari **ditolak**; bukti penerimaan tetap ada |
| ST-PAY-07 | Refund melebihi nilai pengecualian | Ditolak; tidak mengurangi saldo kas/bank dua kali |
| ST-PAY-08 | Owner mengesahkan refund manual; hingga tutup hari **belum ada bukti dana refund benar-benar keluar** | Status `REFUND_APPROVED_PENDING`, **tutup hari diizinkan hanya dengan persetujuan carry-over Owner**; uang tetap tercatat masuk, kewajiban refund tetap terbuka, tidak ada kas keluar fiktif |
| ST-PAY-09 | Refund terverifikasi pada hari berikutnya, permintaan/konfirmasi dikirim ulang | Hanya satu arus kas keluar; kewajiban tertutup sekali dan audit menghubungkan hari pertama dan kedua |
| ST-PAY-10 | Kasir mencoba mengalihkan pengecualian ke pembelian hari berikutnya tanpa refund | Ditolak; bukan saldo deposit pelanggan |
| ST-PAY-11 | Dua callback/verifikasi sumber terhadap pembayaran eksternal tanpa referensi unik yang andal | Bukti/peristiwa diterima sekali secara idempoten, tidak ada dua pengecualian untuk uang sama |
| ST-RET-06 | Faktur 1.000.000; bayar 400.000; retur 250.000 | Piutang 350.000; refund terutang 0 |
| ST-RET-07 | Faktur 1.000.000; bayar 900.000; retur 250.000 | Piutang 0; refund terutang 150.000 |
| ST-RET-08 | Lanjutan ST-RET-07, refund 150.000 dibayar | Piutang 0; refund terutang 0 |
| ST-RET-09 | Faktur 1.000.000; bayar lunas 1.000.000; retur 250.000 | Piutang 0; refund terutang 250.000 |
| ST-RET-10 | Faktur 1.000.000; koreksi nominal sah −100.000; bayar 400.000; tanpa retur | Piutang 500.000, bukan 600.000; koreksi termasuk audit/persetujuan Owner |
| ST-RET-11 | Koreksi negatif menghasilkan hak refund, lalu refund tertunda/dibayar | Piutang/refund terutang dihitung sesuai §9.3; uang keluar hanya saat pembayaran refund benar-benar terverifikasi |
| ST-RET-12 | Refund terutang 150.000; Owner menyetujui 150.000 lalu menyetujui lagi 150.000 sebelum transfer | Persetujuan kedua ditolak: "Refund untuk transaksi ini sudah disetujui sebelumnya." |
| ST-RET-13 | Dua persetujuan refund 150.000 dikirim pada detik yang sama, refund terutang 150.000 | Paling banyak satu disetujui |
| ST-RET-14 | V1 manual: refund belum ditandai **Transfer sudah dikirim**, Owner reautentikasi lalu membatalkan persetujuan dan mengajukan ulang | Pembatalan atomik diterima, jatah dilepas sekali dengan audit; persetujuan baru boleh diajukan sesuai sisa hak |
| ST-RET-15 | Satu persetujuan 150.000, tetapi pencatatan refund dibayar dikirim 2 × 150.000 | Pencatatan kedua ditolak dan Owner diberi peringatan |
| ST-RET-16 | V1 manual: persetujuan refund Rp150.000 **sudah ditandai Transfer sudah dikirim**, kemudian Owner mencoba membatalkan tanpa perubahan status sah dan meminta persetujuan baru | Pembatalan dan persetujuan baru ditolak; jatah tetap tertahan. Percobaan transfer ulang tetap memakai persetujuan awal |
| ST-RET-17 | Refund terutang 150.000; setuju 100.000, dibayar 100.000, lalu setuju 50.000 | Persetujuan 50.000 diterima; setelah dibayar, refund terutang 0; persetujuan Rp1 berikutnya ditolak |
| ST-RET-18 | Refund 150.000 disetujui belum dibayar; koreksi +100.000 pada faktur | Koreksi ditolak sampai refund tertunda diselesaikan |
| ST-RET-19 | V1 manual: refund Rp150.000 sudah ditandai **Transfer sudah dikirim**, mutasi belum menunjukkan debit, Owner mencoba membatalkan dan meminta persetujuan pengganti | Pembatalan dan persetujuan baru ditolak; jatah pada persetujuan awal tetap tertahan. Bila transfer gagal, Owner boleh mencoba transfer ulang **di bawah persetujuan yang sama** |
| ST-RET-22 | Refund manual Rp150.000 disetujui dan ditandai **Transfer sudah dikirim**; percobaan transfer gagal tanpa debit; Owner mencoba ulang di bawah persetujuan sama | Tidak membuat persetujuan/jatah baru; hanya satu pencatatan `dibayar` Rp150.000 diterima sesudah pembayaran terverifikasi; pencatatan kedua ditolak, dan audit mencatat percobaan ulang |
| ST-RET-23 | Refund manual belum ditandai **Transfer sudah dikirim**; Owner membatalkan dengan reautentikasi | Pembatalan diterima secara atomik, jatah dilepas sekali, dan audit mencatat aktor/waktu/alasan |
| ST-RET-20 | Refund Rp150.000 sudah dibayar sah, lalu bank mengembalikan Rp150.000 dengan referensi asal terverifikasi | Buat event `REFUND_RETURNED` dan arus bank masuk; `Rf` efektif turun Rp150.000; saldo kewajiban muncul kembali; persetujuan ulang baru boleh setelah pemeriksaan atomik; sejarah pembayaran tetap ada |
| ST-RET-21 | **Hanya jika integrasi penyedia kelak tersedia:** konfirmasi pembayaran sukses tiba bersamaan dengan pembatalan | Transisi diserialisasi berdasarkan ID sumber yang sama; tidak ada pembebasan jatah sesudah pembayaran sukses. Bukan prasyarat refund manual v1 |
| ST-PAY-13 | Pengecualian 200.000; setuju 120.000, dibayar 120.000, lalu setuju 80.000 | Diterima; persetujuan Rp1 berikutnya ditolak |
| ST-PAY-14 | V1 manual: pengecualian Rp200.000 sudah ditandai **Transfer sudah dikirim**, tetapi belum ada bukti debit; kasir mencoba membatalkan dan menyetujui ulang | Ditolak; jika transfer gagal, Owner dapat mencoba ulang di bawah persetujuan yang sama. Kewajiban pending lintas hari memerlukan otorisasi carry-over Owner |
| ST-PAY-15 | Pengecualian Rp200.000 direfund sah seluruhnya, lalu Rp200.000 masuk kembali ke rekening secara definitif dan cocok dengan instruksi asal | Setelah refund awal: `alokasi 0 + refund efektif 200.000 + tertunda 0 + menunggu 0 = 200.000`. Setelah `REFUND_RETURNED`: `0 + 0 + 0 + RECEIVED_UNMATCHED 200.000 = 200.000`. Kredit balik dicatat terpisah; tutup hari ditolak sampai Owner mengesahkan refund ulang, kemudian carry-over bila belum dibayar. Tidak membentuk omzet, deposit, atau penjualan baru |
| ST-PAY-12 | Pengecualian pembayaran 200.000; dua persetujuan refund 200.000 | Persetujuan kedua ditolak |
| ST-RET-01 | Retur 250.000 pada piutang 600.000 | Piutang menjadi 350.000, barang masuk pemeriksaan |
| ST-RET-02 | Nilai retur lebih tinggi dari sisa piutang | Kelebihan menjadi refund terutang, bukan saldo deposit |
| ST-RET-03 | Dua request retur atas unit sama secara bersamaan | Paling banyak kuantitas yang belum diretur sah |
| ST-RET-04 | Refund dikirim ulang | Satu pembayaran refund dan satu pengurangan kas/bank |
| ST-RET-05 | Pembatalan penjualan ketika barang sudah diserahkan | Ditolak; prosedur retur digunakan |
| **ST-RET-24** | Refund tunai Rp50.000 disetujui Owner, kemudian benar-benar diserahkan langsung dari laci; pencatatan dibayar dikirim ulang | Posting `PAID_CASH` hanya sekali dan kas seharusnya berkurang Rp50.000; posting kedua ditolak oleh server; tidak melalui *Transfer sudah dikirim* |
| ST-APR-01 | Owner melihat pengajuan yang versinya berubah | Persetujuan usang ditolak, minta peninjauan ulang |
| ST-APR-02 | Owner tak membalas pengajuan | Koreksi/retur tidak diterapkan otomatis |
| ST-DOC-01 | Cetak ulang struk 3 kali | Semua bertanda “SALINAN”; tidak membuat 3 transaksi |
| ST-DOC-02 | Dua kasir memperoleh nomor dokumen serentak | Unik, urutan menurut mekanisme server, tidak dipakai ulang |

### 17.3 Langganan, keamanan, audit dan ketahanan

| ID | Kondisi awal / aksi | Hasil yang harus diperoleh |
|---|---|---|
| ST-SUB-01 | FREE berakhir menurut jam server, perangkat mundur jam | Penjualan baru ditolak; jam perangkat tidak memperpanjang masa |
| ST-SUB-02 | Dua transaksi mencapai batas masa trial bersamaan | Commit sebelum `expires_at` sah; selebihnya ditolak, tanpa posting parsial |
| ST-SUB-03 | Klien mengirim status langganan “lunas” palsu | Hak tidak bertambah tanpa bukti server terverifikasi |
| ST-SUB-04 | Bukti pembayaran yang sama diproses ulang | Tidak menggandakan masa berlangganan/hak |
| ST-SUB-05 | Trial hari ke-7 berakhir tanpa berlangganan | Akun dikunci; semua operasi ditolak kecuali ekspor dan berlangganan |
| ST-SUB-06 | Berlangganan di masa tunggu 7 hari | Seluruh data kembali utuh tanpa migrasi |
| ST-SUB-07 | Masa tunggu berakhir tanpa berlangganan | Peringatan sudah dikirim; data akun dihapus dari database aktif, backup terhapus di akhir siklus; data tenant lain tidak terpengaruh |
| ST-SUB-13 | Akun dibuat, OTP baru berhasil 2 jam kemudian | `activated_at` = waktu OTP berhasil; trial berakhir tepat 7 × 24 jam setelahnya |
| ST-SUB-12 | Langganan PRO/MAX habis | Peringatan sudah dikirim H-7; akun dikunci; hanya unduh data dan berlangganan lagi; berlangganan sebelum 30 hari data utuh; lewat 30 hari data dihapus dari database aktif dan backup terhapus di akhir siklus |
| ST-SUB-08 | MAX turun ke PRO memiliki lokasi/akun nonaktif | Tidak terhapus; transaksi baru terlarang, kewajiban lama dapat diselesaikan terkendali |
| ST-SUB-09 | FREE memanggil API grosir/promo/opname lanjutan | Ditolak di backend |
| ST-SUB-10 | PRO memanggil API transfer/claim MAX | Ditolak, kecuali penyelesaian historis yang diizinkan eksplisit |
| ST-SUB-11 | Owner mengganti tanggal perangkat agar trial mulai lagi | Tidak memperoleh trial baru |
| ST-SEC-01 | Tenant A mencoba ID objek tenant B melalui GET/POST/PATCH/DELETE | Ditolak tanpa metadata tenant B |
| ST-SEC-02 | Tenant A meminta PDF/ekspor pelanggan tenant B | Ditolak dan audit terbentuk |
| ST-SEC-03 | OTP/password ditebak berulang | Rate limit/kunci sementara, tidak membocorkan validitas akun |
| ST-SEC-04 | Sesi petugas dicabut server | Token lama tak dapat memodifikasi data |
| ST-SEC-05 | Admin mencoba ekspor massal pelanggan | Ditolak, Owner sah diaudit |
| ST-SEC-06 | Lihat nomor HP penuh tanpa kewenangan | Ditolak; akses sah beralasan dan tercatat |
| ST-SEC-07 | Teknisi tanpa grant aktif mengakses data pelanggan | Ditolak; grant yang habis/dicabut langsung tidak berlaku |
| ST-SEC-08 | Request menyertakan tenant_id palsu | Server memakai tenant terverifikasi dari sesi |
| ST-SEC-09 | Secret dicari di paket klien dan log | Tidak ditemukan; backup dan data terenkripsi |
| ST-SEC-10 | Permintaan akses/koreksi/hapus data dari orang tak terverifikasi | Tidak mengungkap data; permintaan sah diproses menurut dasar/retensi |
| ST-SEC-11 | Simulasi insiden data pribadi | Waktu/dampak/notifikasi/tindak lanjut dan peran tercatat |
| ST-SEC-12 | Subprosesor baru tanpa persetujuan tertulis yang disyaratkan | Proses tidak diaktifkan sebelum persetujuan sesuai UU PDP |
| ST-SEC-13 | Penutupan akun dan legal hold | Ekspor, penghapusan terverifikasi dan siklus backup tidak menghapus data tenant lain |
| ST-SEC-14 | Mencoba menghapus/menimpa audit lama | Ditolak, perubahan melalui peristiwa baru |
| ST-SEC-15 | Restore backup pada lingkungan terisolasi | Total stok, piutang, pembayaran, audit dan checksum direkonsiliasi |
| ST-SEC-21 | Restore backup yang masih memuat tenant sudah dihapus | Tenant tidak diaktifkan kembali dan data operasionalnya diproses menurut daftar penghapusan; tenant lain tetap utuh |
| ST-SEC-24 | Tenant dihapus tanggal 10; restore dari backup tanggal 5 setelah database aktif rusak | Catatan penghapusan tetap terbaca dari penyimpanan terpisah; tenant dihapus ulang sebelum layanan dibuka; tenant lain utuh |
| ST-SEC-22 | Batas masa simpan backup telah habis | Backup/pemulihan terkait expired sesuai kebijakan terukur; bukti penghapusan disimpan terbatas tanpa memulihkan data tenant |
| ST-SEC-23 | Operator platform meminta akses penjualan tenant tanpa grant Owner | Ditolak; back-office hanya metadata SaaS dan invoice langganan |
| ST-SEC-16 | Koneksi TLS tidak valid / protokol tak aman | Data tidak diteruskan |
| ST-SEC-17 | Verifikasi OTP atau reset akun dari petugas tidak berwenang | Pemulihan Owner berlapis dan tidak membuka akun |
| ST-SEC-18 | Penambahan Admin saat FREE satu-Owner | Ditolak melalui API, bukan hanya tombol sembunyi |
| ST-SEC-19 | Operator mengubah entitlement tanpa alasan/izin | Ditolak; setiap override sah diaudit dan berbatas waktu |
| ST-SEC-20 | Staf keuangan platform meminta laporan penjualan tenant | Ditolak; hanya invoice langganan platform sesuai peran |
| ST-UX-01 | Kasir memakai aplikasi di HP dan tablet Android/iPhone | Nominal, unit, batch, konfirmasi terlihat jelas |
| ST-UX-02 | Mode offline, stok habis, batch ditahan, trial habis | Kesalahan dan tindakan perbaikan jelas |
| ST-UX-03 | Pemeriksaan kontras dan target sentuh | Mengikuti kebijakan UI serta WCAG AA |
| ST-UX-04 | Uji pemilik kios/kasir pada POS harian | Masalah dan revisi dicatat sebelum UI disahkan |

### 17.4 Uji kepatuhan kategori dan dokumentasi

| ID | Skenario | Hasil |
|---|---|---|
| ST-COMP-01 | POS umum mencoba harga promo pupuk subsidi | Selalu ditolak, semua paket |
| ST-COMP-02 | Penyaluran subsidi melebihi stok subsidi, atau memakai stok nonsubsidi | Ditolak; stok subsidi dan nonsubsidi terpisah, tidak negatif |
| ST-COMP-05 | **Setelah C-01 terpenuhi**, penyaluran subsidi tempo ke petani terdaftar (nama + kelompok tani) | Piutang tercatat; form tidak meminta NIK. **Sebelum C-01, jalur tempo subsidi harus nonaktif pada rilis** |
| **ST-COMP-27** | **Sebelum C-01**, Owner menginput penyaluran pupuk subsidi **tunai** di modul internal | Form hanya meminta nama petani dan kelompok tani sebagai identitas penerima; **tidak meminta NIK atau nomor HP**; transaksi tunai yang mematuhi HET/stok dapat dicatat, sementara jalur tempo tetap dinonaktifkan |
| ST-COMP-07 | Alokasi 10 ton, diterima fisik 4 ton, penyaluran 5 ton | Ditolak: melebihi stok fisik |
| ST-COMP-08 | Penerimaan subsidi membuat total diterima > alokasi | Peringatan tampil; penerimaan tetap tersimpan dan diaudit |
| ST-COMP-09 | Harga penyaluran subsidi di atas HET yang berlaku pada tanggal transaksi | Ditolak server |
| ST-COMP-10 | Upaya memungut PPN **tambahan oleh pengecer** pada penyaluran subsidi (lewat UI atau API) | Ditolak server; tidak menyatakan pupuk bebas PPN di seluruh rantai |
| ST-COMP-12 | PPN aktif 11%; harga 1.000.000; bayar 500.000; lalu retur 25% | PPN 110.000; tagihan 1.110.000; omzet 1.000.000; piutang 610.000; setelah retur: penjualan bersih 750.000, PPN 82.500, piutang 332.500 |
| ST-COMP-18 | Sakelar "Tidak" | Rekap tanpa baris PPN; total = harga jual |
| ST-COMP-19 | Sakelar "Ya", persen kosong | PPN tidak dihitung; rekap tanpa baris PPN; Pengaturan menampilkan "PPN tidak aktif — persen belum diisi" |
| ST-COMP-20 | PPN aktif 11%, cakupan "Semua barang", keranjang berisi barang biasa | Semua baris dikenai PPN; rekap menampilkan harga, PPN, total final |
| ST-COMP-21 | PPN aktif, cakupan "Semua barang", penyaluran pupuk subsidi (UI atau API) | PPN tidak dihitung; percobaan menambah PPN lewat API ditolak server |
| ST-COMP-22 | PPN aktif, cakupan "Pilih barang"; keranjang berisi barang dicentang dan tidak dicentang | PPN hanya untuk barang yang dicentang |
| ST-COMP-23 | PPN aktif 11%; harga 33.333 | PPN 3.667 (aturan pembulatan nominal dalam kontrak POS; rujukan resmi PER-11/PJ/2025 Pasal 129 untuk angka dokumen pajak) |
| ST-COMP-24 | Kasir mencoba menambah/menghapus PPN pada transaksi lewat API | Ditolak server; tidak ada kontrol PPN di layar kasir |
| ST-COMP-16 | Dua baris kena PPN masing-masing 33.333, satu baris kemudian diretur | PPN transaksi 7.333; snapshot per baris 3.667/3.666 berdasar ID stabil, refund PPN tidak lebih dari snapshot dan bila keduanya kembali total tepat 7.333 |
| ST-COMP-25 | Satu baris 3 sak dengan PPN baris Rp100, diretur satu sak per transaksi | PPN dikembalikan Rp33, Rp33, Rp34; total tepat Rp100 |
| ST-COMP-17 | Owner mengubah persen PPN setelah transaksi lama lalu ada retur | Retur memakai snapshot tarif/PPN faktur asal, bukan tarif terkini |
| ST-COMP-26 | Bandingkan harga Rp32 dengan dua urutan hitung: 11% langsung dan DPP `11/12` yang dibulatkan terlebih dahulu | Secara aritmetika hasil **Rp4 vs Rp3**; uji terhadap contoh resmi Coretax sebelum rilis (C-02), **tidak** mengklaim metode kedua pasti diwajibkan |
| ST-COMP-04 | Keterangan hukum/fitur tanpa sumber atau izin | Ditandai “BELUM TERVERIFIKASI”, jangan disajikan sebagai patuh penuh |

**Gerbang pengujian:** matriks di atas adalah *acceptance specification*. Status **LULUS** hanya boleh diberikan setelah implementasi sungguhan diuji menggunakan data dan bukti. Contoh hitung dapat diverifikasi sekarang, tetapi performa, backup, keamanan runtime dan transaksi bersamaan belum dapat diuji dari draft.

---

# Lampiran B — Referensi dokumen dan status sumber

1. `DRAFT_V4_10_LANDASAN_PRD_PENJUALAN_PERTANIAN.md`, V4.10, 8 November 2026, sebagai sumber keputusan produk dan acceptance cases. Naskah ini tidak menandai V4.10 telah lolos audit independen terakhir; pembentukan PRD dilakukan karena instruksi pemilik untuk melanjutkan penyusunannya.
2. V4.10 merujuk regulasi tentang pupuk subsidi (Permentan 15/2025 jo. 3/2026), PPN khusus subsidi (PMK 66/2022 jo. 11/2025), ketentuan PPN umum, PER-11/PJ/2025 Pasal 129 dan PER-12/PJ/2026, UU PDP dan UU KUP. **PRD ini tidak melakukan verifikasi hukum primer baru**; pernyataan yang belum diuji tetap ditandai di C-01 dan C-02 serta daftar syarat rilis.
3. Sumber spesifikasi UX: V4.10 §14; sumber nonfungsional: V4.10 §13 dan §16; sumber entitlement: V4.10 §3–4; sumber batas MAX: V4.10 §12; sumber keputusan terbuka: V4.10 §19.

**AKHIR PRD V1.1 — FINAL, DISAHKAN PEMILIK PADA 8 NOVEMBER 2026 SEBAGAI BASELINE PENGEMBANGAN; BELUM IZIN RILIS PRODUKSI.**
