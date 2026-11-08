# SECURITY STANDARD & TEST GATES V1.0
**Cakupan:** Mobile Flutter, NestJS API, PostgreSQL/PgBouncer, Cloudflare, GitHub CI, produksi yang belum dipilih. Status: wajib dirancang; belum menyatakan sistem lulus audit/pentest. Rujukan: PRD V1.1 §8–12, OWASP ASVS 5.x (versi aktual dipin saat baseline test), OWASP API Top 10 2023, OWASP MASVS/MASTG, PostgreSQL resmi.

## Threat model prioritas

| Ancaman | Komponen | Kontrol preventif | Uji wajib |
|---|---|---|---|
| BOLA/IDOR tenant B | API/DB | principal server session, composite FK, RLS FORCE, explicit privilege | Ubah ID sales/invoice/pdf/export/subsidy tenant B: deny |
| Abuse role Admin→Owner | API/DB | auth guard + privilege checks di fungsi sensitif | Admin approve refund/promo/correction/hold release → deny |
| Stok negatif/double Sale | DB | atomic tx, row locking, idempotency + unique | 100/1000 concurrency, same SKU 1 balance |
| Uang/refund ganda | DB+manual workflow | Q cap, unique refund paid, attempts same approval, evidence | Refund concurrent, returned funds, cash close |
| Tenant context spoof | RLS session GUC | session opaque hash verified DB, least privilege, no raw SQL endpoint | forged session, revoke, missing token, SQL injection, PgBouncer bleed |
| Cached stale stock | Edge/cache | never cache tenant-sensitive checkout reads as authority | quote stale then stock changed, final deny |
| Bad input nested | NestJS DTO/validator | strict additionalProperties false, whitelist & reject, length limits | tenant_id/role/price injection, prototype pollution fields |
| OTP/account enumeration | auth | shared throttles, response normalization, OTP hashed, short TTL | registered vs not, repeated attempt, distributed test |
| Stolen device/session | mobile/auth | token Keystore/Keychain, remote revoke, refresh rotation | restore device backup, logout, session stolen/revoked |
| Stolen secrets | CI/hosting | minimal permissions, secret manager, no env dumps, code scanning | secrets search, fork PR permissions |
| Malicious support | SaaS ops | no tenant raw data by default, Owner grant timed and audited | P operator tries raw Sale without grant |
| Document exfiltration | storage | private bucket, tenant check, short signed URL, filename random | guessed object key, TTL expiry, cross-tenant |
| Tenant resurrection | backup | tombstone separate failure domain, quarantined restore | T-08 and managed PITR re-delete before traffic |
| Destructive purge | offboarding | special role, legal hold review, rehearsal, external audit, approval | purge dry-run, wrong tenant ID no effect |
| Deadline bypass | transaction time | late guard + conservative expiry margin + R3 AS-11 tests | T-06c forced deferred trigger early + commit delay |

## Minimum implementation baseline

1. **HTTP:** TLS to Cloudflare and origin, HSTS after domain validated, no unauthenticated administrative endpoints, API rate limit at app + edge, request body size cap; app CORS only if back-office browser needs it, CSRF protection on cookie sessions.
2. **Auth:** Argon2id or hardened password hashing parameter calibrated and documented (PoC uses scrypt; no silent assertion it is final), OTP one-time, hashed at rest, abuse detection, backend device/session revoke. Security parameters TBD but **required before public exposure**.
3. **Authorization:** deny-by-default, role matrix checked at controller/service and SQL operation; RLS not a substitute for same-tenant least-privilege. No direct DML at app runtime role, no `BYPASSRLS`, audited migration/purge separate.
4. **Transactions:** constraint-backed row-local invariants + locked aggregate posting; integer rupiah; no float; idempotency payload hash; SQL injection via parameterization and no dynamic untrusted table/column names.
5. **Security-definer functions:** immutable `search_path`, no untrusted CREATE, revoke PUBLIC EXECUTE in migration transaction; RLS FORCE on business tables; fuzz arguments including cross-tenant references.
6. **Mobile:** never embed production secrets or private API keys in binary; securely store tokens; cache only minimum; root/jailbreak threat policy no claim perfect protection; protect sensitive app switching screens case-by-case.
7. **SaaS ops:** platform roles separated from tenant; finance platform sees SaaS invoices only; break-glass with dual control, audit to separate retention/administration domain.
8. **Backup:** encryption keys scoped per environment, access to backup restricted, test restore + tenant deletion tombstone; never upload real data to public CI.
9. **Supply chain:** pinned runtimes+lockfiles, source review, dependency vulnerability alerts, license review, scripts run with minimal token permissions; action versions pin to full SHA after verified, note YAML scaffold may use named tag as *bootstrap only*.
10. **Incidents:** track detection/respond, revoke sessions, rotate compromised secrets, preserve evidence, map controller/processor responsibility under UU PDP, prepare notification SOP; legal advice TBD.

## CI gates in order

- **G0 docs integrity:** verify original PRD hash and files, Markdown crosslinks + ADR, no missing docs; runs on PR.
- **G1 lint/typecheck:** NestJS build, Dart analyze, formatter, dependencies, IaC scanning.
- **G2 database:** migration from blank + upgrade migration; `ON_ERROR_STOP=1`; broken fixture must FAIL; verify RLS/FK/NO DIRECT DML; ledger invariants.
- **G3 API negative:** 401/403/404, role bypass, token revoke, unknown fields, tenant B, rate limit distributed.
- **G4 financial race:** 2 casher stock last; refund approvals concurrent; return/paid; carton open/hold; repeated idem with body mismatch; VAT/HPP residual.
- **G5 time cutoff:** T-06c (forced `SET CONSTRAINTS`), slow COMMIT injection; PRD exact commit requirement. **Open** until proven; don't merge production checkout if not resolved.
- **G6 platform offboarding:** isolated recovery+PITR and tombstone; separate managed environment required.
- **G7 mobile devices M-01..08:** Android low-end, iPhone, tablet, printers/scanners real; no device CI implies incomplete.
- **G8 prod release:** Owner release approval after C-01..04 relevant gates, legal docs, security sign-off and staging evidence.

## Test artifact template

`test_id | source_prd_id | build_sha | db_version | env | fixture | expected | actual | pass/fail/not_run | report_link | tester | timestamp`.

**No passing claim without actual CI run.** PoC R3 67/67 is evidence reported by another agent, not automatically green in GitHub. Vulnerability in R3 transaction commit semantics remains open, and no security standard guarantees 100% immunity to attacks.
