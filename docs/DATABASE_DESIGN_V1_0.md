# DATABASE DESIGN V1.0 — PostgreSQL Multi-Tenant
**Status:** Detailed design, **bukan skrip migrasi produksi**. Mengacu SAD V1.0 & PRD V1.1 FINAL. Semua tabel berikut kandidat desain dan wajib melalui uji migrasi/constraint/indeks. Nominal mata uang adalah **BIGINT rupiah**, timestamp UTC (`timestamptz`); hasil pecahan HPP/PPN dihitung dengan `numeric` dan pembulatan deterministik. `uuid` untuk ID; nomor dokumen tenant/jenis dibuat terurut backend.

## A. Schemas dan prinsip fisik

- `platform`: tenant metadata, subscription invoice, entitlements, billing verification, support grants, incident/audit; **tidak** otomatis mengakses transaksi kios.
- `iam`: user, credential, OTP, session, membership, recovery events; akses tabel sensitif hanya fungsi terproteksi.
- `biz`: katalog, inventory, sale, payment, customer, cash, subsidy, VAT, ledger, refund, audit. Semua tabel `biz` punya `tenant_id NOT NULL`, relasi FK komposit, `ENABLE/FORCE RLS`, audit tamper-evident di level aplikasi+infra.
- `ops`: outbox, document objects, export jobs, backup policy metadata. Data tenant `tenant_id` wajib.
- `erasure`: **bukan schema dalam backup utama** untuk tombstone; media penyimpanan/akun/failure-domain terpisah, ID tenant+deleted_at minimal. Pemulihan membaca sumber terpisah secara wajib sebelum menerima trafik.

**Pola ID:** `PRIMARY KEY (tenant_id,id)` untuk semua tabel tenant-scoped; bila UUID global unik, tambahkan `UNIQUE (id)` hanya jika benar-benar dibutuhkan; child selalu `FOREIGN KEY (tenant_id,parent_id) REFERENCES ... (tenant_id,id)` agar tidak dapat menunjuk data tenant lain. Identitas `tenant_id` diambil dari konteks authenticated server/DB, tidak dari JSON request.

## B. Data dictionary — schema platform & identity

| Tabel | Field inti (tipe; kewajiban) | Constraint / indeks / aturan |
|---|---|---|
| `platform.tenant` | `id uuid PK`, `business_name text`, `status enum`, `created_at timestamptz`, `timezone text`, `version bigint` | status ACTIVE/LOCKED/OFFBOARDING/DELETED; `timezone` salah satu Asia/Jakarta/Makassar/Jayapura; transisi diaudit |
| `platform.location` | `tenant_id uuid`, `id uuid`, `name`, `active bool` | satu lokasi aktif FREE/PRO; enforcement di entitlement transaction; siap ekstensi MAX tanpa mengaktifkannya |
| `platform.subscription` | `tenant_id`, `id`, `plan`, `activated_at`, `expires_at`, `grace_deadline`, `status`, `version` | FREE berlaku 7×24h saat OTP Owner berhasil; PRO sesuai periode terverifikasi; MAX batas saja |
| `platform.entitlement_event` | `tenant_id`, `id`, `subscription_id`, `kind`, `effective_at`, `actor`, `evidence` | append-only; verifikasi server; upgrade tidak menggandakan periode |
| `platform.subscription_invoice` | `tenant_id`, `id`, `plan`, `gross_idr`, `cycle`, `payment_state` | **terpisah dari `biz.sale`**; channel billing belum diputus |
| `iam.user_account` | `id`, `phone_normalized`, `password_hash`, `status` | unik nomor HP login per kebijakan; jangan log password/OTP/token |
| `iam.membership` | `tenant_id`, `id`, `user_id`, `role`, `active`, `version` | satu Owner FREE; 1 Owner+1 Admin PRO; peran tidak diambil dari client |
| `iam.otp_challenge` | `id`, `user_id/target`, `otp_hash`, `expires_at`, `used_at`, `attempt_count` | TTL dan batas percobaan parameter TBD keamanan; hash berpepper/HMAC jika perlu |
| `iam.session` | `token_hash`, `user_id`, `tenant_id`, `expires_at`, `revoked_at`, `device_id`, `auth_at` | deny revoked/expired, periksa membership/tenant status, granular revoke |
| `iam.owner_reauth` | `id`, `tenant_id`, `actor_id`, `action_hash`, `expires_at`, `used_at` | satu kali dan terikat aksi/objek/nilai; TTL belum disahkan |
| `platform.support_grant` | `tenant_id`, `id`, `owner_id`, `support_actor`, `purpose`, `scope`, `expires_at`, `revoked_at` | tidak ada akses lintas tenant tanpa grant; hanya minimum |

## C. Katalog/harga/stok/biaya

| Tabel | Field inti | Constraint dan alur |
|---|---|---|
| `biz.product` | `(tenant_id,id)`, `sku`, `name`, `category`, `brand?`, `base_unit`, `is_subsidized`, `is_active` | unique(tenant_id,sku); subsidi tidak bisa masuk sale normal |
| `biz.package_version` | `(tenant_id,id)`, `product_id`, `form` SEALED/LOOSE, `factor int`, `barcode?`, `may_open`, `valid_from`, `superseded_at` | `factor>0`, immutable sesudah dipakai transaksi; barcode unik bila ditetapkan dalam tenant |
| `biz.batch` | `(tenant_id,id)`, `product_id`, `batch_number?`, `expires_on?`, `safety_state` | expiry null diizinkan pada barang yang tidak memiliki expiry; batch fisik terpisah |
| `biz.price_rule_version` | `(tenant_id,id)`, `package_version_id`, `type`, `min_qty`, `price_idr`, `effective_at`, `approved_by`, `version` | `price_idr>=0`; Admin request+Owner approve; harga paling rendah yang sah saat commit |
| `biz.price_change_request` | `(tenant_id,id)`, `actor_id`, `target`, `proposed`, `status`, `object_version`, `reviewed_by` | Admin hanya ajukan; Owner reauth sebelum efektif |
| `biz.promotion` | `(tenant_id,id)`, `product_id`, `quota_units`, `used_units`, `promo_price`, `start_at/end_at`, `approved_by` | 0≤used≤quota, harga promo tidak menumpuk; stok tidak direservasi saat draft |
| `biz.stock_receipt` | `(tenant_id,id)`, `supplier_name`, `source_document`, `package_version_id`, `batch_id`, `qty`, `total_cost_idr`, `received_at`, `actor_id` | hanya barang fisik diterima; unique idem; token bukti idempoten |
| `biz.stock_balance` | `(tenant_id,location_id,product_id,package_version_id,batch_id,status)` PK, `qty int`, `version bigint` | qty≥0; SALEABLE/HELD/INSPECTION/DAMAGED/QUARANTINE; indeks fast checkout; projection dari ledger |
| `biz.inventory_ledger` | `(tenant_id,id)`, `event_id`, `movement_type`, dimensional source/destination, `quantity_delta`, `event_at`, `actor`, `source_ref` | append-only; checksum/projection reconciliation; qty balance tidak negatif |
| `biz.cost_pool` | `(tenant_id,location_id,product_id,status)` PK, `qty_base bigint`, `value_idr bigint`, `version` | qty≥0, value≥0, qty=0⇒value=0; cost average exact ratio |
| `biz.value_ledger` | `(tenant_id,id)`, `product_id`, `status_from/to`, `qty_base`, `value_delta`, `source_event_id` | append-only, event_id unique, cost moves = floor/residual formula |
| `biz.stock_hold` | `(tenant_id,id)`, `product_id`, `batch_id`, `reason`, `held_by`, `released_by?`, `audit` | Admin/Owner hold segera; release hanya Owner |
| `biz.stock_count` / `stock_count_line` | `(tenant_id,id)`, `counted_at`, `entered_at`, `ledger_version`, `physical_qty`, `approved_by?` | Owner approval, reconcile changes since counted_at, PRO only |

**Saldo:** satu transaksi menulis inventory/value ledger dan memperbarui balance projection; jika gagal rollback semuanya. Rekonsiliasi ulang dihitung dari ledger di luar jalur POS, mismatch menghasilkan alarm bukan edit histori.

## D. Sales, VAT, receivables & exception

| Tabel | Field inti | Constraint / perilaku |
|---|---|---|
| `biz.sale` | `(tenant_id,id)`, `document_seq`, `business_day`, `status FINAL`, `f_idr`, `vat_idr`, `grand_idr`, `customer_id?`, `finalized_at`, `idem_scope`, `request_hash` | unik(tenant_id,document_type,seq); idempotensi payload mismatch→409; tidak mengedit final |
| `biz.sale_line` | `(tenant_id,id)`, `sale_id`, `product_id`, `package_version_id`, `batch_id`, `qty`, `unit_price_idr`, `gross_idr`, `vat_snapshot_idr`, `cost_snapshot_idr` | FK komposit; immutable sale snapshot; return qty ≤ sold qty |
| `biz.customer` | `(tenant_id,id)`, `display_name`, `phone?`, `address?` | customer wajib untuk tempo/parsial, masked by default |
| `biz.payment` | `(tenant_id,id)`, `sale_id`, `method`, `gross_cash_tendered?`, `change_idr?`, `net_received_idr`, `bank_reference?`, `verified_by`, `verified_at` | cash, bank, QRIS/EDC external; no fake receipt; idempotent external ref+bukti |
| `biz.payment_allocation` | `(tenant_id,id)`, `payment_id`, `sale_id`, `allocated_idr` | total allocated≤payment verified net; no deposit |
| `biz.invoice_state` | `(tenant_id,sale_id)` PK, `f_idr`, `c_idr`, `r_idr`, `p_idr`, `rf_idr`, `q_pending_idr`, `version` | Q≤max(−B,0) **row-local** CHECK; updates only via posting functions; ledger as source |
| `biz.sale_correction` | `(tenant_id,id)`, `sale_id`, `signed_delta_idr`, `tax_delta`, `reason`, `owner_approval_id` | append-only, recalculates invoice under lock |
| `biz.return_header` / `return_line` | `(tenant_id,id)`, `sale_id`, `sale_line_id`, `qty_returned`, `value_idr`, `vat_return_idr`, `cost_return_idr`, `owner_approval` | snapshot from sale line; HPP/PPN residual; stock to INSPECTION |
| `biz.unmatched_receipt` | `(tenant_id,id)`, `source_ref`, `received_idr`, `sale_allocated_idr`, `paid_effective_idr`, `approved_pending_idr`, `waiting_idr`, `status`, `verified_evidence` | CHECK amounts≥0 and sum=total; *one source event once* |
| `biz.exception_allocation` | `(tenant_id,id)`, `unmatched_id`, `sale_id`, `allocated_idr`, `session_id`, `buyer_confirmation` | single sale in original checkout session or choose refund, not customer deposit |
| `biz.exception_carryover` | `(tenant_id,id)`, `unmatched_id`, `owner_approval`, `reason`, `follow_up_due` | carry-over pending refund only; pending unmatched without Owner decision blocks close day |
| `biz.vat_setting_version` | `(tenant_id,id)`, `enabled bool`, `percent numeric NULL`, `coverage_mode`, `effective_at`, `owner_id` | no default percentage, `NULL` means off; subsidized excluded regardless |
| `biz.vat_coverage` | `(tenant_id,setting_id,product_id)` | only for selected mode; changes prospective |
| `biz.vat_line_snapshot` | `(tenant_id,sale_line_id)`, `exact_tax numeric`, `allocated_tax_idr`, `remaining_tax_idr` | largest remainder + stable tie-break; refund snapshot proportional |

**Key ledger account equation (invoice):** `B=F+C−R−(P−Rf)`, `L=max(−B,0)`, `Qpending≤L`, `Rf≥0`. Updates crossing multiple tables must go through one posting function that locks `invoice_state`, ensures source payment/approval is real, appends events and updates projection. **Jangan gunakan SQL CHECK untuk mencoba membaca subtotal dari tabel lain**; gunakan row-local cached aggregate + locked posting and reconciliation. Refund effective paid changes in transaction same as Q and cash/bank ledger.

**Unmatched equation:** `original_received = allocated_sale + refunded_effective + approved_pending + waiting_unmatched`. Saat `REFUND_RETURNED`, `refunded_effective` turun dan `waiting_unmatched` naik dalam satu commit; Owner decision needed again.

## E. Refund, cash close, subsidy, auditing

| Tabel | Field inti | Constraint/perilaku |
|---|---|---|
| `biz.refund_approval` | `(tenant_id,id)`, `source_kind` SALE/UNMATCHED, `source_id`, `amount_idr`, `status`, `approved_by`, `marked_sent_at?`, `version` | satu approval mencadangkan Q; status NOT_SENT→MARKED_SENT, CANCELLED only before sent+reauth |
| `biz.refund_attempt` | `(tenant_id,id)`, `approval_id`, `attempt_no`, `method TRANSFER`, `operator_id`, `evidence`, `created_at` | retry transfer manual boleh lebih dari satu, **bukan approval baru** |
| `biz.refund_payment` | `(tenant_id,id)`, `approval_id`, `amount_idr`, `method CASH/TRANSFER`, `external_verified_ref?`, `paid_at`, `posted_by` | `UNIQUE(tenant_id,approval_id)` untuk satu posting per approval; cash direct via PAID_CASH |
| `biz.refund_returned` | `(tenant_id,id)`, `refund_payment_id`, `amount_idr`, `evidence`, `verified_by`, `verified_at` | append-only; total returned≤paid, `Rf` effective decreases; jika posting parsial perlu aturan approval tetap satu kali — model v1 hanya satu paid posting |
| `biz.cash_day` | `(tenant_id,id)`, `location_id`, `business_date`, `opening_type`, `opening_idr`, `expected_idr`, `physical_idr`, `difference_idr`, `closed_at`, `approved_by?` | unik tenant/location/date; FREE & PRO same basic close; no unmatched undecided |
| `biz.cash_movement` | `(tenant_id,id)`, `cash_day_id`, `kind`, `actual_delta_idr`, `payment_ref`, `posted_at` | refund pending delta=0; cash returned actual delta positive; no double posting |
| `biz.subsidy_allocation` | `(tenant_id,id)`, `product_id`, `period_start/end`, `allocation_base_qty`, `source` | bukan stok, boleh > physical receipt without stock minted |
| `biz.het_version` | `(tenant_id,id)`, `product_id`, `valid_from`, `price_limit_idr`, `source` | server checks HET at distribution date |
| `biz.subsidy_distribution` | `(tenant_id,id)`, `product_id`, `farmer_name`, `farmer_group`, `qty`, `unit_price`, `mode`, `source_batch` | tanpa `nik` atau `phone`; TIME_CREDIT blocked until C-01; stock physical ledger |
| `biz.audit_event` | `(tenant_id,id)`, `actor_id`, `action`, `subject`, `old/new_digest`, `timestamp`, `origin_req` | append-only, no raw PII/secrets, export to secondary integrity log |
| `ops.outbox` | `(tenant_id,id)`, `event_type`, `ref_id`, `payload_min`, `created_at`, `processed_at`, `attempts` | at-least-once dedup ID |
| `ops.document_object` | `(tenant_id,id)`, `sale_id`, `kind`, `object_key`, `sha256`, `revision`, `created_at` | private, short-lived access, no public bucket |
| `ops.export_job` | `(tenant_id,id)`, `requested_by`, `scope`, `status`, `object_id`, `expires_at` | Owner only mass export, lifetime limited; during grace export allowed |

## F. Constraint, index, lock & RLS contract

1. **Invariant 1 — `invoice_state`:** row local `CHECK(q_pending_idr >= 0 AND rf_idr >= 0 AND q_pending_idr <= GREATEST(-(f_idr+c_idr-r_idr-(p_idr-rf_idr)),0))`. Source ledger still authoritative and transaction reconciles both.
2. **Invariant 2 — stock:** `CHECK(qty>=0)` and `CHECK(qty_base>=0 AND value_idr>=0 AND (qty_base>0 OR value_idr=0))`, posted under row locks. Inventory ledger signed delta and projection version sequence.
3. **Invariant 3 — exception:** row local `CHECK(received_idr=sale_allocated_idr+paid_effective_idr+approved_pending_idr+waiting_idr)` with all ≥0.
4. **Invariant 4 — paid once:** `UNIQUE(tenant_id,approval_id)` on `refund_payment`; allow multiple `refund_attempt` but never second paid posting.
5. **Invariant 5 — idempotency:** `UNIQUE(tenant_id,operation_scope,idempotency_key)`, store canonical payload hash/result; identical key+different body→409; include expiration rule that does not allow double-charge after deletion of idem row.
6. **Invariant 6 — append-only business audit:** application role cannot UPDATE/DELETE event log; purge under separate audited offboarding account; don't disable triggers via replication role.
7. **Indexes:** `(tenant_id,sku) unique`, `(tenant_id,barcode) unique where barcode is not null` (depending on barcode entity); stock PK includes status/batch; `(tenant_id,sale_id)`, `(tenant_id,due_date,unpaid)`, `(tenant_id,created_at)`, unique doc sequence; refund `(tenant_id,approval_id)`, receipt unique external identity per source where supported; audit `(tenant_id,timestamp)`.
8. **Lock order:** tenant/entitlement→campaign→stock dimensions sorted→cost pool→invoice/exception→refund→cash day. Settlement functions shared with hold/stock opening; use DB timeouts and retriable SQLSTATE errors only when safe.
9. **Enforce RLS:** grant `USAGE` of schema; runtime role NOBYPASSRLS, not table owner; `FORCE ROW LEVEL SECURITY`; fail closed when no authenticated tenant. Real code obtains principal from validated session, and SQL function recalculates role/tenant from protected IAM source.
10. **No unrestricted `GRANT SELECT ON ALL TABLES`** on sensitive objects; use role-scoped views / explicit projections; no secret/OTP/session raw access. RLS isolates tenant; ABAC/RBAC inside tenant must also be tested.

### F.1 Illustrative SQL patterns — NOT a complete executable migration

```sql
-- DDL fragment; DB migration is separately reviewed and tested.
CREATE TABLE biz.invoice_state (
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  f_idr bigint NOT NULL CHECK (f_idr >= 0),
  c_idr bigint NOT NULL DEFAULT 0,
  r_idr bigint NOT NULL DEFAULT 0 CHECK (r_idr >= 0),
  p_idr bigint NOT NULL DEFAULT 0 CHECK (p_idr >= 0),
  rf_idr bigint NOT NULL DEFAULT 0 CHECK (rf_idr >= 0),
  q_pending_idr bigint NOT NULL DEFAULT 0 CHECK (q_pending_idr >= 0),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sale_id),
  CONSTRAINT refund_cap CHECK (
    q_pending_idr <= GREATEST(
      -(f_idr + c_idr - r_idr - (p_idr - rf_idr)), 0
    )
  )
  -- Add composite FK (tenant_id,sale_id)->biz.sale after ordering migrations.
);

CREATE TABLE biz.unmatched_receipt (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  received_idr bigint NOT NULL CHECK (received_idr >= 0),
  sale_allocated_idr bigint NOT NULL DEFAULT 0 CHECK (sale_allocated_idr >= 0),
  paid_effective_idr bigint NOT NULL DEFAULT 0 CHECK (paid_effective_idr >= 0),
  approved_pending_idr bigint NOT NULL DEFAULT 0 CHECK (approved_pending_idr >= 0),
  waiting_idr bigint NOT NULL DEFAULT 0 CHECK (waiting_idr >= 0),
  PRIMARY KEY (tenant_id,id),
  CONSTRAINT conservation CHECK (
    received_idr = sale_allocated_idr + paid_effective_idr
                   + approved_pending_idr + waiting_idr
  )
);

ALTER TABLE biz.invoice_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE biz.invoice_state FORCE ROW LEVEL SECURITY;
-- Illustrative only: app.authenticated_tenant() MUST verify a protected
-- server session, NOT merely trust a caller-controlled 'tenant_id' GUC.
CREATE POLICY invoice_tenant_read ON biz.invoice_state FOR SELECT TO app_runtime
USING (tenant_id = app.authenticated_tenant());
-- app_runtime should have no direct INSERT/UPDATE/DELETE grant;
-- designated posting function revalidates role and locks state.
```

`app.authenticated_tenant()` dalam contoh adalah **kontrak antarmuka**, bukan fungsi yang tersedia dalam file ini. Bila tetap meneruskan token sesi via transaction-local setting seperti PoC R3, migrasi harus menguji spoofing, token expiry, search_path, response injection, peran dan kebocoran antar pool secara negatif.

## G. Atomic posting steps — sequences to implement and test

**G1 Checkout:** validate actor→lock tenant entitlement→validate final now→lock promo→lock stock sorted→validate expiry/hold/qty→compute effective price+PPN→apply `cost_out=floor(pool_value×qty/pool_qty)` (last stock takes all)→insert Sale/SaleLine with snapshots→insert verified payments and receivable delta→append inventory/value/finance ledger→update projections→store canonical idempotency outcome + outbox event→last deadline guard/commit. On error rollback all; no Sale or stock debit without payments outcome.

**G2 Refund approval:** lock invoice state or receipt; check Q+x≤L OR receipt-partition formula as appropriate; insert owner approval with identity/re-auth evidence; increment pending; append audit; commit.

**G3 Manual transfer:** approval NOT_SENT→MARKED_SENT records attempted transfer (not cash), retry attempt same approval allowed with audit; once bank confirmed **paid**, lock refund approval+invoice/receipt+cash account, insert `refund_payment` unique, pending−x, effective paid+x, bank ledger−x, audit; second posting violates UNIQUE. Cash paid bypass mark sent but still paid once and cash ledger−x.

**G4 Returned funds:** lock original paid record and state; verify bank/cash actual returned with linked reference; insert returned event, decrement effective `Rf` or exception paid and increment waiting; record bank/cash actual incoming, audit; do not revive old approval for new posting; new Owner decision required for exception.

**G5 Close day:** lock cash_day and all linked undecided exception statuses; reject undecided unmatched; retain Owner-approved pending refund carry-overs with reason/assignee; physical cash count+expected+difference; close immutable, late adjustment as new event.

**G6 Purge/restore:** offboarding marks tenant locked/deleted, export full while allowed; tombstone durable outside primary failure domain; purge all tenant scoped tables through constrained process; verify zero remaining; restore must replay tombstones before service open; audit externally.

## H. Security/operational unresolved points

- **Refund paid ≤ Owner approval (OPEN, perlu pengujian integrasi DB):** nilai `biz.refund_payment.amount_idr` wajib `<= biz.refund_approval.amount_idr` untuk persetujuan terkait; perpindahan dari tertunda ke dibayar harus menurunkan `Q` sebesar nilai pembayaran `x` yang sama secara atomik. `CHECK refund_cap` **tidak** mencegah `Rf` naik tanpa persetujuan. Contoh negatif yang harus ditolak: `F=1.000.000, C=0, R=250.000, P=900.000, Rf=150.001, Q=0` memberi `B=1`, `L=0`; karena `Q<=L`, CHECK baris tetap lolos meskipun nilai refund sudah melampaui hak Rp150.000. Jangan menyatakan ini tertutup sebelum uji integrasi terhadap FK approval, kunci dan ledger posting.

- `ENT-04`: absolute literal *committed before expiry* not proven in R3 using deferred trigger; `SET CONSTRAINTS` can fire it early. Do not claim formal proof; design as special test gate and seek DBA assessment. No reinterpretation of PRD.
- Managed PostgreSQL vendor support for pgaudit, logical WAL, extensions, PITR window, backup region, conn pooler: TBD.
- Password/OTP/session TTL, MFA support operator, project IP allowlists, network CIDR, budget, backup retention, RPO/RTO: TBD according to PRD §11.2.
- Cross-tenant FK test must cover missing combinations, deletion cascades, deferred constraints, and grants on security-definer functions, not only read API.

