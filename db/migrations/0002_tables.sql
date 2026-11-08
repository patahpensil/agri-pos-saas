-- 0002: tabel fondasi identitas, toko (tenant), dan entitlement.
-- Pemilik semua tabel: migration_owner. Tidak ada role runtime yang diberi hak tabel.
set role migration_owner;

-- ---------------------------------------------------------------- platform
create table platform.tenant (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null check (char_length(business_name) between 1 and 120),
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'LOCKED_GRACE', 'OFFBOARDED')),
  timezone      text not null check (timezone in ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')),
  created_at    timestamptz not null default now(),
  version       bigint not null default 0
);

create table platform.location (
  tenant_id  uuid not null references platform.tenant (id),
  id         uuid not null default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- ENT-02: satu lokasi aktif per toko (FREE/PRO).
create unique index location_one_active on platform.location (tenant_id) where active;

create table platform.subscription (
  tenant_id      uuid not null references platform.tenant (id),
  id             uuid not null default gen_random_uuid(),
  plan           text not null check (plan in ('FREE', 'PRO')),
  activated_at   timestamptz not null,
  expires_at     timestamptz not null,
  grace_deadline timestamptz not null,
  version        bigint not null default 0,
  primary key (tenant_id, id),
  check (expires_at > activated_at),
  check (grace_deadline >= expires_at),
  -- ENT-01: FREE berlaku persis 7 x 24 jam.
  check (plan <> 'FREE' or expires_at = activated_at + interval '168 hours')
);
create unique index subscription_one_per_tenant on platform.subscription (tenant_id);

create table platform.entitlement_event (
  tenant_id       uuid not null,
  id              uuid not null default gen_random_uuid(),
  subscription_id uuid not null,
  kind            text not null check (kind in ('FREE_STARTED')),
  effective_at    timestamptz not null,
  actor_user_id   uuid,
  recorded_at     timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, subscription_id) references platform.subscription (tenant_id, id)
);

-- ---------------------------------------------------------------- iam
create table iam.user_account (
  id            uuid primary key default gen_random_uuid(),
  phone_e164    text not null unique check (phone_e164 ~ '^\+62[1-9][0-9]{7,12}$'),
  password_hash text not null,
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  created_at    timestamptz not null default now()
);

create table iam.membership (
  tenant_id         uuid not null references platform.tenant (id),
  id                uuid not null default gen_random_uuid(),
  user_id           uuid references iam.user_account (id),
  invite_phone_hash bytea,
  role              text not null check (role in ('OWNER', 'ADMIN')),
  state             text not null check (state in ('PENDING', 'ACTIVE', 'DEACTIVATED')),
  display_name      text not null check (char_length(display_name) between 1 and 80),
  created_by        uuid references iam.user_account (id),
  created_at        timestamptz not null default now(),
  activated_at      timestamptz,
  deactivated_at    timestamptz,
  version           bigint not null default 0,
  primary key (tenant_id, id),
  -- PENDING belum punya akun; ACTIVE wajib punya akun. DEACTIVATED boleh tanpa akun
  -- (undangan yang dibatalkan sebelum aktivasi).
  check (state <> 'PENDING' or user_id is null),
  check (state <> 'ACTIVE' or user_id is not null),
  check (state <> 'PENDING' or invite_phone_hash is not null),
  check (role <> 'OWNER' or state <> 'PENDING'),
  check ((state = 'DEACTIVATED') = (deactivated_at is not null))
);
-- Satu Owner per toko.
create unique index membership_one_owner on iam.membership (tenant_id) where role = 'OWNER';
-- O-4: satu akun hanya satu keanggotaan aktif.
create unique index membership_one_active_per_user on iam.membership (user_id) where state = 'ACTIVE';
-- ENT-02 (FREE 0, PRO maks 1): maksimum struktural 1 Admin PENDING/ACTIVE per toko.
-- Pemeriksaan paket FREE dilakukan di fungsi dengan kunci baris langganan.
create unique index membership_max_one_admin on iam.membership (tenant_id)
  where role = 'ADMIN' and state in ('PENDING', 'ACTIVE');

create table iam.otp_challenge (
  id            uuid primary key default gen_random_uuid(),
  purpose       text not null check (purpose in ('REGISTER_OWNER', 'ACTIVATE_ADMIN')),
  phone_hash    bytea not null,
  tenant_id     uuid,
  membership_id uuid,
  code_hash     text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  voided_at     timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts  integer not null check (max_attempts > 0),
  check (expires_at > created_at),
  check ((purpose = 'ACTIVATE_ADMIN') = (tenant_id is not null and membership_id is not null)),
  foreign key (tenant_id, membership_id) references iam.membership (tenant_id, id)
);
create index otp_challenge_lookup on iam.otp_challenge (phone_hash, purpose, created_at desc);

-- Kotak keluar OTP: kode mentah hanya ada di sini sampai diambil pengirim, lalu dihapus.
-- Hanya otp_dispatch_runtime (lewat fungsi) yang bisa mengambilnya; auth_runtime/app_runtime tidak.
create table iam.otp_outbox (
  challenge_id uuid primary key references iam.otp_challenge (id),
  phone_e164   text not null,
  code         text not null,
  created_at   timestamptz not null default now()
);

create table iam.session (
  tenant_id     uuid not null,
  id            uuid not null default gen_random_uuid(),
  token_hash    bytea not null unique,
  user_id       uuid not null references iam.user_account (id),
  membership_id uuid not null,
  device_id     text not null check (char_length(device_id) between 8 and 128),
  created_at    timestamptz not null default now(),
  auth_at       timestamptz not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  revoke_reason text check (revoke_reason in ('LOGOUT', 'OWNER_REVOKE', 'DEVICE_CHANGE', 'SESSION_LIMIT', 'ADMIN_DEACTIVATED')),
  primary key (tenant_id, id),
  foreign key (tenant_id, membership_id) references iam.membership (tenant_id, id),
  check (expires_at > auth_at),
  check ((revoked_at is null) = (revoke_reason is null))
);
create index session_user_active on iam.session (user_id) where revoked_at is null;

create table iam.auth_event (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references platform.tenant (id),
  actor_user_id uuid,
  kind          text not null,
  at            timestamptz not null default now(),
  detail        jsonb not null default '{}'::jsonb
);
create index auth_event_tenant on iam.auth_event (tenant_id, at);

-- Penghitung batas laju (jendela tetap). Disimpan di DB agar berlaku untuk banyak instance API.
create table iam.rate_limit_bucket (
  kind         text not null,
  key_hash     bytea not null,
  window_start timestamptz not null,
  hits         integer not null default 0 check (hits >= 0),
  primary key (kind, key_hash, window_start)
);

-- Parameter keamanan (NFR-09 dan sejenisnya). TIDAK diisi oleh migrasi: produksi wajib diisi
-- operator atas keputusan Edgar. Nilai uji wajib ditandai test_only = true.
create table iam.security_param (
  key       text primary key check (key in (
              'otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
              'otp_send_max_per_window', 'otp_send_window_seconds',
              'login_max_failures', 'login_window_seconds',
              'ip_max_requests', 'ip_window_seconds',
              'session_ttl_seconds', 'max_active_sessions_per_user',
              'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds')),
  value     bigint not null check (value > 0),
  test_only boolean not null,
  set_at    timestamptz not null default now()
);

reset role;
