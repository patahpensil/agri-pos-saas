# API CONTRACT V1.0 — SaaS Pertanian
**Status:** rancangan endpoint untuk implementasi NestJS; **belum OpenAPI final atau API yang hidup**. Normatif dari PRD V1.1 FINAL; sample field adalah keputusan teknis dan dapat disempurnakan melalui ADR tanpa mengubah bisnis.

## 1. Konvensi protokol

- Base `/api/v1`; transport TLS1.2+ dengan target TLS1.3 bila didukung; `application/json; charset=utf-8`; waktu ISO 8601 UTC.
- Mobile: `Authorization: Bearer <opaque_session_token>`; token panjang acak, hanya hash disimpan server. Refresh/reauth workflow ditentukan spesifikasi identitas; jangan taruh secret di URL.
- Semua mutasi final/reservasi jatah/koreksi/penutupan harus memakai `Idempotency-Key: <UUID>` atau opaque random client-generated; identitas scoped `(tenant, operation, key)`, canonical body hash. Same key+same body → hasil sama; same key+different body → **409**. Retensi idempotency harus melindungi retry ketika sale telah di-commit, tidak dihapus sembarangan.
- **Tidak terima `tenant_id`, `role`, `plan`, `price_override`, atau field saldo server-managed** dari body klien. JSON strict schema `additionalProperties: false`, nested validation. Contoh `PATCH /settings/vat` hanya Owner yang sah.
- `MoneyIDR` di API adalah string angka rupiah integer seperti `"150000"`, bukan float JavaScript. `Qty` integer positif; biaya/rate decimal dikirim string desimal dengan validasi presisi.
- Setiap write memakai ETag/`If-Match` atau `object_version` untuk perubahan yang perlu optimistic concurrency; approval terhadap object versi berubah → **409** + diff.
- Konsistensi: `POST` sukses hanya setelah commit DB; status payment eksternal verified manual tidak boleh dibentuk dari screenshot pelanggan saja. PDF/thermal dapat gagal terpisah dari sale.
- Respons API tak membocorkan keberadaan ID tenant lain; gunakan **404** untuk sumber yang tidak terlihat. Role forbidden pada resource yang memang terlihat dapat **403**.
- Error standar `application/problem+json`: `type`, `title`, `status`, `code`, `detail` (tanpa data rahasia), `correlation_id`, `retryable`, `current_version?`. Tidak mengembalikan SQL/stack trace.

## 2. Matriks endpoint utama

**Aktor:** `O` Owner; `A` Admin; `P` Platform staff dengan kebijakan terpisah; `U` pra-login. `R` baca saja; `W` aksi; `G` feature gate. Endpoint final dalam API implementation boleh dipisah versi tanpa menghilangkan kontrak PRD.

| Modul / endpoint | Method | Aktor | Kontrak/wajib validasi | PRD |
|---|---|---|---|---|
| `/auth/register/start` | POST | U | nomor HP minimum; OTP rate-limited; anti-enumerasi | AUTH-02 |
| `/auth/register/verify-otp` | POST | U | OTP once, creates Owner+tenant+FREE activated_at server atomik | AUTH-02 ENT-01 |
| `/auth/login` | POST | U | sandi, server session, throttled | AUTH-02/06 |
| `/auth/logout` | POST | O/A | revoke current session | AUTH-06 |
| `/auth/sessions` | GET | O/A | hanya sesi milik aktor, no raw token | AUTH-06 |
| `/auth/sessions/{id}/revoke` | POST | O | revoke Admin / sendiri sesuai kebijakan | AUTH-06 |
| `/auth/reauth` | POST | O | proof recent bound to requested action/amount/object; one-use | AUTH-04 |
| `/tenant/me` | GET | O/A | tenant, role, plan, grace/lock, entitlements server | ENT-03 |
| `/subscription/status` | GET | O | trial expiry server timestamp, tier, grace deadline | ENT-01–07 |
| `/subscription/activate` | POST | O/P authorized | verified SaaS invoice evidence, no spoofed payment | ENT-03/07/10 |
| `/products` | POST/GET | O/A | SKU unique tenant, stock opening required including zero | PRD-01–04 |
| `/products/{id}` | GET/PATCH | O/A | historical pack_factor immutable; legal metadata gated | PRD-05–08 |
| `/packages/{id}/open` | POST | O/A | physical confirm; sealed−1 loose+n, equal base units and cost | INV-05 |
| `/inventory/receipts` | POST | O/A | verify physical receipt; idempotent, source document | INV-01 |
| `/inventory/stock` | GET | O/A | tenant batch/pack/status projection; never source for final checkout | INV-02/09 |
| `/inventory/holds` | POST | O/A | hold server immediate/commit even before Owner approval | INV-06 |
| `/inventory/holds/{id}/release` | POST | O | reauth, review evidence, cannot Admin | INV-06 |
| `/inventory/counts` | POST/GET | O/A G PRO | counted_at and ledger version, no erase newer sale | INV-07 |
| `/inventory/counts/{id}/approve` | POST | O G PRO | reconcile counted_at, version revalidation | INV-07 |
| `/price-change-requests` | POST | A/O G PRO | Admin requests, owner review | K-2/POS-03 |
| `/price-change-requests/{id}/approve` | POST | O G PRO | only Owner, approve before effective, reauth | K-2/POS-03 |
| `/promotions` | POST/GET | O/A G PRO | creation request then Owner approval, quota atomic | POS-04/05 |
| `/sales/quote` | POST | O/A | read-only, preview quote expiration/version, no reserve | POS-01–03 |
| `/sales` | POST | O/A | **atomic** server final, current stock/price/batch/plan/PPN, idem | POS-01..08 |
| `/operations/{key}` | GET | O/A | replay authoritative outcome after timeout, no double posting | POS-06 |
| `/sales/{id}` | GET | O/A permitted | tenant/role scoped, snapshots/doc state | DOC-01–03 |
| `/payments` | POST | O/A | apply verified payment to selected invoice, no extra Sale | PAY-05–07 |
| `/receivables` | GET | O/A permission | mask customer phones, role scope | PAY-05–09 |
| `/payment-exceptions` | POST | O/A | verified source, one unmatched receipt, no omzet | EXC-01 |
| `/payment-exceptions/{id}/allocate` | POST | O/A + Owner decision if needed | only same session valid sale, else refund | EXC-02 |
| `/payment-exceptions/{id}/carry-over` | POST | O | pending approved only; reason, assignee, due | EXC-07 |
| `/returns` | POST | O/A | return request on sale line/version; owner approval | RET-01–04 |
| `/returns/{id}/approve` | POST | O | reauth, stock return to INSPECTION; cash obligations | RET-01..06 |
| `/corrections` | POST | O/A | signed amount, tax snapshot, Owner approval | RET-04/12 |
| `/refunds/approvals` | POST | O | source SALE vs UNMATCHED; **different cap formulas**, owner reauth | RET-06 EXC-03 |
| `/refunds/approvals/{id}/mark-sent` | POST | O/A eligible | internal marker only, not paid; no new entitlement | RET-08/09 |
| `/refunds/approvals/{id}/attempts` | POST | O/A eligible | manual retry in SAME approval, no extra Q | RET-09 |
| `/refunds/approvals/{id}/cancel` | POST | O | only NOT_SENT, reauth; released once | RET-08 |
| `/refunds/approvals/{id}/confirm-paid` | POST | O/A eligible + verification | once per approval, bank evidence verified, cash actual, idem | RET-07/09 |
| `/refunds/payments/{id}/return` | POST | O | verified cash/bank incoming, ledger net adjustment + audit | RET-10 EXC-06 |
| `/cash-days/current` | GET | O/A | cash expected vs physical, pending exceptional | CASH-01..07 |
| `/cash-days/{id}/close` | POST | O/A; Owner carry-over | deny undecided unmatched; physical count; idem | CASH-01..07 |
| `/vat-settings` | GET | O/A | percent null by default, no arbitrary cashier toggle | VAT-01–10 |
| `/vat-settings/versions` | POST | O | switch/rate/coverage only Owner; effective date, audited | VAT-01–07 |
| `/subsidy/allocations` | POST | O | numeric allocation only, no stock addition | SUB-02 |
| `/subsidy/receipts` | POST | O/A | real physical stock receipt | SUB-03 |
| `/subsidy/distributions` | POST | O/A | farmer name/group only; HET; no PPN; tempo C-01 gate | SUB-01..09 |
| `/reports/dashboard` | GET | O/A scoped | returns derived aggregate, without VAT as income | ANL-* |
| `/documents/{id}/download` | GET | O/A permitted | short-lived signed private access, audit | DOC-01..07 |
| `/exports` | POST/GET | O | mass portability full even in grace; reauth | DOC-* ENT-05/06 |
| `/platform/tenants` | GET | P | platform metadata only; never raw tenant sales | PLAT-* |
| `/platform/subscription-invoices/{id}/verify` | POST | P-finance | server-only verification+audit, no tenant sales access | PLAT-* |
| `/platform/support-grants` | GET | authorized P/O | only Owner-signed short-lived grant, masked data | PLAT-* |

**Release flags:** `VAT_ENABLED_FOR_PRODUCTION=false` sampai C-02; `SUBSIDY_CREDIT_ENABLED=false` sampai C-01. Backend check, bukan hanya UI.

## 3. Sampel kontrak (illustrative)

### 3.1 POST `/api/v1/sales` dengan `Idempotency-Key`

```json
{
  "customer_id": null,
  "lines": [
    {
      "product_id": "UUID",
      "package_version_id": "UUID",
      "batch_id": "UUID",
      "quantity": 2,
      "quote_version": "Q-TEST-123"
    }
  ],
  "payments": [
    {"method": "CASH", "tendered_idr": "50000", "change_idr": "4000", "net_received_idr": "46000"}
  ]
}
```

*Angka hanya contoh payload; server menghitung harga dari master dan PPN yang sah. `quote_version` tidak menjamin harga terkunci. Respons 201 hanya setelah commit, berisi `sale_id`, `receipt_number`, `grand_total_idr`, `cash_change_idr`, `version`; 409 untuk harga/stok/batch/entitlement konflik; 402 **tidak** digunakan untuk memalsukan status subscription.*

### 3.2 POST `/api/v1/refunds/approvals/{id}/attempts`

```json
{"attempt_reference":"attempt-local-2", "reason":"transfer_manual_gagal_terverifikasi_dan_diuji_ulang"}
```

Attempt baru tidak memodifikasi `q_pending`, tidak menandai bank paid dan tidak membuat approval baru. Jika outcome transfer sebelumnya belum pasti, UI meminta rekonsiliasi bank sebelum Owner mengulang transfer; v1 tidak dapat mencegah transfer yang terjadi dua kali di aplikasi bank.

### 3.3 Refund paid and returned

```json
{"method":"TRANSFER", "paid_idr":"150000", "evidence_id":"UUID", "bank_verified_at":"2026-11-08T08:00:00Z"}
```

Field `bank_verified_at` adalah waktu bukti yang diverifikasi petugas, **bukan** callback provider. Jika nominal sesuai approval dan belum ada posting, server mengubah Q→Rf efektif + bank movement; request paid ulang idempoten atau 409 (payload beda). `REFUND_RETURNED` memakai `refund_payment_id` + bukti dana kembali; tidak pernah menghapus posting sebelumnya.

### 3.4 Error standar

```json
{
  "type": "https://api.example.invalid/problems/stock-insufficient",
  "title": "Stok tidak cukup",
  "status": 409,
  "code": "INSUFFICIENT_STOCK",
  "detail": "Stok siap jual telah berubah. Periksa jumlah dan pilih ulang.",
  "correlation_id": "uuid",
  "retryable": false
}
```

URL `.invalid` adalah placeholder dokumentasi, bukan domain yang akan dipakai.

## 4. State machines & invariants

`RefundApproval`: `APPROVED_NOT_SENT`→`TRANSFER_MARKED_SENT`→`PAID_VERIFIED`; `APPROVED_NOT_SENT`→`CANCELLED_NOT_SENT` (Owner reauth); cash path `APPROVED_NOT_SENT`→`PAID_CASH`; `REFUND_RETURNED` adalah **event balik terpisah** yang merujuk `refund_payment`, bukan status yang menghapus riwayat.

`PaymentException`: `RECEIVED_UNMATCHED`→`ALLOCATED_IN_SAME_SESSION` atau `REFUND_APPROVED_PENDING`→`REFUNDED`; dana kembali → `RECEIVED_UNMATCHED` + Owner follow-up. Jaga partisi total.

`Tenant`: ACTIVE→LOCKED_GRACE (FREE 7 hari, PRO 30 hari)→OFFBOARDED; export allowed in grace, mutation blocked. Restoration tidak boleh menghidupkan OFFBOARDED tenant.

**Semua transisi server-side**. Jangan mempercayai client-supplied source_kind atau approver_role bila dapat dideduksi dari objek; API harus menolak percobaan silang.

## 5. Security & HTTP status tests

| Kasus | Hasil |
|---|---|
| Tanpa token / revoked | 401 |
| Admin ingin approve refund/promo tanpa Owner | 403 |
| Free akses promo/grosir lanjutan | 403 dengan code paket yang jelas |
| Id tenant lain ditebak | 404 tanpa data |
| Extra `tenant_id`/`role`/`price` pada nested body | 400 |
| Idempotency key sama body beda | 409 `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| Dua kasir stok 1 | satu sukses maksimal, satu 409 |
| Refund paid dua kali | satu posting, retry sama response, body beda 409 |
| Timeout checkout sesudah commit | `GET /operations/{key}` mengembalikan Sale yang sama |
| `RECEIVED_UNMATCHED` undecided saat close-day | 409 `UNMATCHED_PAYMENT_REQUIRES_OWNER` untuk FREE dan PRO |
| Tempo subsidi tanpa C-01 | 403 `FEATURE_GATED` |
| PPN fitur belum lulus C-02 saat production | 403 `FEATURE_GATED` untuk tax collection features (perubahan setting boleh disimpan tapi tidak dipakai untuk memungut sebelum rilis) |
| Penggunaan nomor HP petani/NIK di distribusi | 400 unknown field |

## 6. Observability & versioning

`X-Correlation-ID` diterbitkan server, divalidasi bila klien memasok; log berisi tenant pseudonym/actor ID & operation ID, status/time, tidak raw token/OTP/customer phone/bukti bank. HTTP version `/v1`, perubahan incompatible memakai versi baru, event append-only tetap dapat dibaca. `/health/live` boleh publik tanpa detail DB; `/health/ready` dibatasi atau output minimal.

**API ini adalah desain — belum ada endpoint implementasi atau hasil pengujian.** Kontrak resmi OpenAPI perlu dihasilkan dari DTO/validator dengan linting agar tidak menyimpang dari dokumen ini dan PRD.
