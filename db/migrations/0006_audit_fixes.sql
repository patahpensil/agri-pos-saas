-- 0006: perbaikan audit independen PR #4 (AUD-OTP-01, AUD-SESSION-01, AUD-LOGIN-01, AUD-OTP-02).
--
-- Kompatibilitas: migrasi 0001-0005 belum pernah diterapkan di lingkungan permanen (hanya database
-- sementara CI). Antrean OTP lama (iam.otp_outbox berisi kode mentah) DIHAPUS dan diganti antrean
-- baru tanpa kode. Challenge yang sedang berjalan saat migrasi kehilangan kodenya dan harus diminta ulang.
--
-- Penanda pengujian mutasi (db/test/mutation.sh):
--   baris berakhiran  "-- @kontrol:NAMA"  = kontrol keamanan; dihapus saat mutasi NAMA
--   baris berawalan   "-- @mutasi:NAMA "  = versi rentan; diaktifkan saat mutasi NAMA
-- Pada migrasi normal penanda ini hanya komentar dan tidak mengubah perilaku.

-- ------------------------------------------------------------------ bentuk data
set role migration_owner;

-- (TEMUAN-01) Kode OTP tidak lagi disimpan dalam bentuk apa pun yang bisa dibuka dari database.
-- Yang disimpan hanya MAC = HMAC-SHA256(kunci di luar database, tujuan|nomor|kode).
-- Kunci MAC hanya ada di proses backend (OTP_MAC_KEY), tidak di database dan tidak di repo.
alter table iam.otp_challenge drop column code_hash;
alter table iam.otp_challenge add column code_mac bytea check (code_mac is null or pg_catalog.octet_length(code_mac) = 32);

-- (TEMUAN-04) Antrean pengiriman dengan lease + acknowledgment. Tidak ada kolom kode.
drop table iam.otp_outbox;
create table iam.otp_outbox (
  id             uuid primary key default gen_random_uuid(),
  challenge_id   uuid not null unique references iam.otp_challenge (id),
  purpose        text not null check (purpose in ('REGISTER_OWNER', 'ACTIVATE_ADMIN')),
  phone_e164     text not null,
  status         text not null default 'QUEUED' check (status in ('QUEUED', 'LEASED', 'SENT', 'FAILED', 'EXPIRED')),
  send_attempts  integer not null default 0 check (send_attempts >= 0),
  lease_token    bytea,
  lease_until    timestamptz,
  created_at     timestamptz not null default now(),
  last_failed_at timestamptz,
  sent_at        timestamptz,
  check ((status = 'LEASED') = (lease_token is not null and lease_until is not null)),
  check ((status = 'SENT') = (sent_at is not null))
);
create index otp_outbox_ready on iam.otp_outbox (created_at) where status in ('QUEUED', 'LEASED');

alter table iam.security_param drop constraint security_param_key_check;
alter table iam.security_param add constraint security_param_key_check check (key in (
  'otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
  'otp_send_max_per_window', 'otp_send_window_seconds',
  'login_max_failures', 'login_window_seconds',
  'ip_max_requests', 'ip_window_seconds',
  'session_ttl_seconds', 'max_active_sessions_per_user',
  'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds',
  'otp_dispatch_lease_seconds', 'otp_dispatch_max_attempts'));
reset role;

alter table iam.otp_outbox enable row level security;
alter table iam.otp_outbox force row level security;
create policy auth_boundary on iam.otp_outbox for all to auth_fn_owner using (true) with check (true);
grant select, insert, update on iam.otp_outbox to auth_fn_owner;

-- ------------------------------------------------------------------ fungsi
drop function iam.otp_dispatch_claim(integer);
drop function iam.register_verify(text, text, text, text, text, text);
drop function iam.activate_admin(text, text, text, text);
drop function iam.consume_otp(text, text, text);
drop function iam.new_otp();

set role auth_fn_owner;

-- Menambah 1 pada jendela tetap SECARA ATOMIK (upsert, baris terkunci sampai transaksi selesai)
-- dan mengembalikan jumlah setelah penambahan.
create function iam.rate_reserve(p_kind text, p_key bytea, p_window_s bigint) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare ws timestamptz; n integer;
begin
  ws := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) / p_window_s) * p_window_s);
  insert into iam.rate_limit_bucket as b (kind, key_hash, window_start, hits) values (p_kind, p_key, ws, 1)
    on conflict (kind, key_hash, window_start) do update set hits = b.hits + 1
    returning b.hits into n;
  return n;
end $$;

-- Mengembalikan slot yang dicadangkan (dipakai saat login berhasil).
create function iam.rate_release(p_kind text, p_key bytea, p_window_s bigint) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare ws timestamptz;
begin
  ws := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) / p_window_s) * p_window_s);
  update iam.rate_limit_bucket b set hits = greatest(b.hits - 1, 0)
   where b.kind = p_kind and b.key_hash = p_key and b.window_start = ws;
end $$;

-- (TEMUAN-02) Penerbitan sesi dengan kunci akun: dua login serentak untuk akun yang sama diproses
-- berurutan, sehingga login kedua melihat sesi login pertama dan mencabutnya bila perangkat berbeda.
-- Urutan kunci konsisten: akun (user_account) -> sesi.
create or replace function iam.issue_session(p_tenant uuid, p_user uuid, p_membership uuid, p_device text,
                                             out r_token text, out r_expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_max bigint := iam.param('max_active_sessions_per_user');
begin
  if p_device is null or pg_catalog.char_length(p_device) not between 8 and 128 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  perform 1 from iam.user_account u where u.id = p_user for update;   -- @kontrol:SESSION_LOCK

  update iam.session s set revoked_at = pg_catalog.clock_timestamp(), revoke_reason = 'DEVICE_CHANGE'
   where s.user_id = p_user and s.revoked_at is null and s.device_id <> p_device;

  r_token := pg_catalog.encode(ext.gen_random_bytes(32), 'hex');
  r_expires_at := pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => iam.param('session_ttl_seconds'));
  insert into iam.session (tenant_id, token_hash, user_id, membership_id, device_id, auth_at, expires_at, created_at)
  values (p_tenant, pg_catalog.sha256(pg_catalog.convert_to(r_token, 'UTF8')), p_user, p_membership, p_device,
          pg_catalog.clock_timestamp(), r_expires_at, pg_catalog.clock_timestamp());

  update iam.session s set revoked_at = pg_catalog.clock_timestamp(), revoke_reason = 'SESSION_LIMIT'
   where s.id in (select s2.id from iam.session s2
                   where s2.user_id = p_user and s2.revoked_at is null
                   order by s2.created_at desc, s2.id desc offset v_max);
  perform iam.audit(p_tenant, p_user, 'SESSION_ISSUED', '{}'::jsonb);
end $$;

-- Challenge OTP + pekerjaan antrean. Kode BELUM ada: dibuat oleh pengirim berwenang saat lease.
create or replace function iam.create_challenge(p_purpose text, p_phone text, p_tenant uuid, p_membership uuid, p_ttl_s bigint)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid;
begin
  insert into iam.otp_challenge (purpose, phone_hash, tenant_id, membership_id, expires_at, max_attempts)
  values (p_purpose, iam.phone_hash(p_phone), p_tenant, p_membership,
          pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_s), iam.param('otp_max_attempts'))
  returning id into v_id;
  insert into iam.otp_outbox (challenge_id, purpose, phone_e164) values (v_id, p_purpose, p_phone);
  return v_id;
end $$;

-- Verifikasi OTP: hitungan percobaan permanen (tanpa exception), baris dikunci FOR UPDATE.
-- p_mac = HMAC(kunci backend, tujuan|nomor|kode) dihitung backend dari kode yang diketik pengguna.
create function iam.consume_otp(p_purpose text, p_phone text, p_mac bytea, out r_status text, out r_challenge iam.otp_challenge)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  select c.* into r_challenge from iam.otp_challenge c
   where c.phone_hash = iam.phone_hash(p_phone) and c.purpose = p_purpose
     and c.used_at is null and c.voided_at is null
   order by c.created_at desc limit 1
   for update;
  if not found then
    r_status := 'OTP_INVALID'; return;
  end if;
  if r_challenge.attempt_count >= r_challenge.max_attempts then
    r_status := 'OTP_LOCKED'; return;
  end if;
  if r_challenge.expires_at <= pg_catalog.clock_timestamp()
     or r_challenge.code_mac is null
     or p_mac is null or pg_catalog.octet_length(p_mac) <> 32
     or p_mac <> r_challenge.code_mac then
    update iam.otp_challenge c set attempt_count = c.attempt_count + 1 where c.id = r_challenge.id
      returning c.attempt_count into r_challenge.attempt_count;
    perform iam.audit(r_challenge.tenant_id, null, 'OTP_FAILED', pg_catalog.jsonb_build_object('purpose', p_purpose));
    r_status := case when r_challenge.attempt_count >= r_challenge.max_attempts then 'OTP_LOCKED' else 'OTP_INVALID' end;
    return;
  end if;
  update iam.otp_challenge c set used_at = pg_catalog.clock_timestamp() where c.id = r_challenge.id;
  r_status := 'OK';
end $$;

create function iam.register_verify(p_phone text, p_code_mac bytea, p_password text, p_business_name text,
                                    p_timezone text, p_device_id text,
                                    out r_status text, out r_token text, out r_expires_at timestamptz, out r_tenant uuid)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_otp record; v_user uuid; v_member uuid; v_sub uuid; v_now timestamptz := pg_catalog.now();
begin
  if not iam.valid_phone(p_phone)
     or p_business_name is null or pg_catalog.char_length(pg_catalog.btrim(p_business_name)) not between 1 and 120
     or p_timezone is null or p_timezone not in ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')
     or p_device_id is null or pg_catalog.char_length(p_device_id) not between 8 and 128 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  perform iam.check_password_policy(p_password);

  select * into v_otp from iam.consume_otp('REGISTER_OWNER', p_phone, p_code_mac);
  if v_otp.r_status <> 'OK' then
    r_status := v_otp.r_status; return;
  end if;
  if not iam.phone_is_free(p_phone) then
    r_status := 'OTP_INVALID'; return;
  end if;

  insert into platform.tenant (business_name, timezone) values (pg_catalog.btrim(p_business_name), p_timezone)
    returning id into r_tenant;
  insert into platform.location (tenant_id, name) values (r_tenant, 'Lokasi Utama');
  insert into iam.user_account (phone_e164, password_hash)
    values (p_phone, iam.hash_secret(p_password, iam.param('bcrypt_cost')::integer)) returning id into v_user;
  insert into iam.membership (tenant_id, user_id, role, state, display_name, activated_at)
    values (r_tenant, v_user, 'OWNER', 'ACTIVE', 'Owner', v_now) returning id into v_member;
  insert into platform.subscription (tenant_id, plan, activated_at, expires_at, grace_deadline)
    values (r_tenant, 'FREE', v_now, v_now + interval '168 hours', v_now + interval '168 hours' + interval '7 days')
    returning id into v_sub;
  insert into platform.entitlement_event (tenant_id, subscription_id, kind, effective_at, actor_user_id)
    values (r_tenant, v_sub, 'FREE_STARTED', v_now, v_user);
  select s.r_token, s.r_expires_at into r_token, r_expires_at from iam.issue_session(r_tenant, v_user, v_member, p_device_id) s;
  perform iam.audit(r_tenant, v_user, 'OWNER_REGISTERED', '{}'::jsonb);
  r_status := 'OK';
end $$;

create function iam.activate_admin(p_phone text, p_code_mac bytea, p_password text, p_device_id text,
                                   out r_status text, out r_token text, out r_expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_otp record; v_m record; v_user uuid;
begin
  if not iam.valid_phone(p_phone) or p_device_id is null or pg_catalog.char_length(p_device_id) not between 8 and 128 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  perform iam.check_password_policy(p_password);

  select * into v_otp from iam.consume_otp('ACTIVATE_ADMIN', p_phone, p_code_mac);
  if v_otp.r_status <> 'OK' then
    r_status := v_otp.r_status; return;
  end if;

  select m.tenant_id, m.id into v_m
    from iam.membership m
    join platform.tenant t on t.id = m.tenant_id and t.status <> 'OFFBOARDED'
    join platform.subscription s on s.tenant_id = m.tenant_id and s.plan = 'PRO' and s.expires_at > pg_catalog.now()
   where m.tenant_id = (v_otp.r_challenge).tenant_id and m.id = (v_otp.r_challenge).membership_id
     and m.role = 'ADMIN' and m.state = 'PENDING'
   for update of m;
  if v_m.id is null then
    r_status := 'INVITE_INVALID'; return;
  end if;
  if not iam.phone_is_free(p_phone) then
    r_status := 'PHONE_NOT_AVAILABLE'; return;
  end if;

  insert into iam.user_account (phone_e164, password_hash)
    values (p_phone, iam.hash_secret(p_password, iam.param('bcrypt_cost')::integer)) returning id into v_user;
  update iam.membership m set user_id = v_user, state = 'ACTIVE', activated_at = pg_catalog.now(),
         invite_phone_hash = null, version = m.version + 1
   where m.tenant_id = v_m.tenant_id and m.id = v_m.id;
  select s.r_token, s.r_expires_at into r_token, r_expires_at from iam.issue_session(v_m.tenant_id, v_user, v_m.id, p_device_id) s;
  perform iam.audit(v_m.tenant_id, v_user, 'ADMIN_ACTIVATED', '{}'::jsonb);
  r_status := 'OK';
end $$;

-- (TEMUAN-03) Login dengan cadangan slot percobaan yang ATOMIK sebelum memeriksa kredensial.
-- Upsert pada baris penghitung mengunci baris tsb sampai transaksi selesai, sehingga permintaan
-- serentak untuk nomor yang sama diputuskan berurutan; setelah batas tercapai, kredensial TIDAK
-- diperiksa. Login sukses mengembalikan slotnya. Penghitung ikut ter-commit (tanpa exception).
create or replace function iam.login(p_phone text, p_password text, p_device_id text,
                                     out r_status text, out r_token text, out r_expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_h bytea; v_u record; v_ok boolean; v_n integer; v_win bigint := iam.param('login_window_seconds');
begin
  if p_device_id is null or pg_catalog.char_length(p_device_id) not between 8 and 128 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_h := iam.phone_hash(coalesce(p_phone, ''));
  v_n := iam.rate_reserve('LOGIN_FAIL', v_h, v_win);                                   -- @kontrol:LOGIN_RESERVE
-- @mutasi:LOGIN_RESERVE v_n := iam.rate_count('LOGIN_FAIL', v_h, v_win) + 1;
  if v_n > iam.param('login_max_failures') then
    perform iam.audit(null, null, 'LOGIN_LIMITED',
      pg_catalog.jsonb_build_object('k', pg_catalog.encode(pg_catalog.substring(v_h, 1, 16), 'hex')));
    r_status := 'RATE_LIMITED'; return;
  end if;

  select u.id as user_id, u.password_hash, m.tenant_id, m.id as membership_id into v_u
    from iam.user_account u
    join iam.membership m on m.user_id = u.id and m.state = 'ACTIVE'
    join platform.tenant t on t.id = m.tenant_id and t.status <> 'OFFBOARDED'
   where u.phone_e164 = p_phone and u.status = 'ACTIVE';

  if v_u.user_id is null then
    perform iam.hash_secret(coalesce(p_password, ''), iam.param('bcrypt_cost')::integer);  -- waktu kerja mirip
    v_ok := false;
  else
    v_ok := iam.check_secret(coalesce(p_password, ''), v_u.password_hash);
  end if;
  -- Bukti jumlah pemeriksaan kredensial yang benar-benar dijalankan (tanpa nomor/sandi).
  perform iam.audit(v_u.tenant_id, null, 'LOGIN_CHECKED',
    pg_catalog.jsonb_build_object('k', pg_catalog.encode(pg_catalog.substring(v_h, 1, 16), 'hex')));

  if not v_ok then
-- @mutasi:LOGIN_RESERVE perform iam.rate_hit('LOGIN_FAIL', v_h, 2147483647, v_win);
    perform iam.audit(v_u.tenant_id, null, 'LOGIN_FAILED', '{}'::jsonb);
    r_status := 'INVALID_CREDENTIALS'; return;
  end if;

  perform iam.rate_release('LOGIN_FAIL', v_h, v_win);                                   -- @kontrol:LOGIN_RESERVE
  select s.r_token, s.r_expires_at into r_token, r_expires_at
    from iam.issue_session(v_u.tenant_id, v_u.user_id, v_u.membership_id, p_device_id) s;
  perform iam.audit(v_u.tenant_id, v_u.user_id, 'LOGIN_OK', '{}'::jsonb);
  r_status := 'OK';
end $$;

-- ------------------------------------------------------------------ antrean pengiriman OTP (TEMUAN-04)
-- Jaminan: pengiriman MINIMAL SEKALI (at-least-once) dengan batas percobaan; BUKAN exactly-once.
-- Setiap lease membuat kode baru dan menggantikan MAC lama, sehingga bila pesan terkirim ganda
-- (mis. proses mati setelah kirim, sebelum ack) hanya kode terakhir yang berlaku.

-- Mengambil pekerjaan siap kirim dengan lease. FOR UPDATE SKIP LOCKED mencegah dua worker
-- mengambil pekerjaan yang sama. Pekerjaan untuk challenge kedaluwarsa/batal/terpakai ditutup EXPIRED.
create function iam.otp_dispatch_claim(p_limit integer)
returns table (r_job uuid, r_lease bytea, r_purpose text, r_phone text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_now timestamptz := pg_catalog.clock_timestamp();
begin
  update iam.otp_outbox o set status = 'EXPIRED', lease_token = null, lease_until = null
    from iam.otp_challenge c
   where c.id = o.challenge_id and o.status in ('QUEUED', 'LEASED')
     and (c.used_at is not null or c.voided_at is not null
          or c.expires_at <= v_now                                                       -- @kontrol:OTP_EXPIRY
         )
     and (o.status = 'QUEUED' or o.lease_until < v_now);

  return query
  with picked as (
    select o.id from iam.otp_outbox o
      join iam.otp_challenge c on c.id = o.challenge_id
     where (o.status = 'QUEUED' or (o.status = 'LEASED' and o.lease_until < v_now))
       and o.send_attempts < iam.param('otp_dispatch_max_attempts')
       and c.used_at is null and c.voided_at is null
       and c.expires_at > v_now                                                          -- @kontrol:OTP_EXPIRY
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update of o skip locked)
  update iam.otp_outbox o set status = 'LEASED', send_attempts = o.send_attempts + 1,
         lease_token = ext.gen_random_bytes(32),
         lease_until = v_now + pg_catalog.make_interval(secs => iam.param('otp_dispatch_lease_seconds'))
    from picked where o.id = picked.id
  returning o.id, o.lease_token, o.purpose, o.phone_e164;

  -- Pekerjaan yang habis jatah percobaan ditandai FAILED (tidak dikirim ulang tanpa batas).
  update iam.otp_outbox o set status = 'FAILED', lease_token = null, lease_until = null
   where o.status = 'QUEUED' and o.send_attempts >= iam.param('otp_dispatch_max_attempts');
end $$;

-- Menyimpan MAC kode yang akan dikirim pemegang lease. Ditolak bila lease tidak sah/kedaluwarsa
-- atau challenge sudah tidak berlaku.
create function iam.otp_dispatch_set_code(p_job uuid, p_lease bytea, p_mac bytea) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_ch uuid;
begin
  if p_mac is null or pg_catalog.octet_length(p_mac) <> 32 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  select o.challenge_id into v_ch from iam.otp_outbox o
   where o.id = p_job and o.status = 'LEASED' and o.lease_token = p_lease and o.lease_until > pg_catalog.clock_timestamp()
   for update;
  if v_ch is null then
    return false;
  end if;
  update iam.otp_challenge c set code_mac = p_mac
   where c.id = v_ch and c.used_at is null and c.voided_at is null
     and c.expires_at > pg_catalog.clock_timestamp()                                     -- @kontrol:OTP_EXPIRY
  ;
  return found;
end $$;

-- Konfirmasi terkirim. Hanya pemegang lease yang sah.
create function iam.otp_dispatch_ack(p_job uuid, p_lease bytea) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  update iam.otp_outbox o set status = 'SENT', sent_at = pg_catalog.clock_timestamp(), lease_token = null, lease_until = null
   where o.id = p_job and o.status = 'LEASED' and o.lease_token = p_lease;
  return found;
end $$;

-- Gagal kirim: kembali ke antrean bila jatah masih ada, selain itu FAILED.
create function iam.otp_dispatch_fail(p_job uuid, p_lease bytea) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  update iam.otp_outbox o
     set status = case when o.send_attempts >= iam.param('otp_dispatch_max_attempts') then 'FAILED' else 'QUEUED' end,
         lease_token = null, lease_until = null, last_failed_at = pg_catalog.clock_timestamp()
   where o.id = p_job and o.status = 'LEASED' and o.lease_token = p_lease;
  return found;
end $$;

create or replace function iam.security_params_status()
returns table (r_key text, r_present boolean, r_test_only boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select k.key, sp.key is not null, coalesce(sp.test_only, false)
    from pg_catalog.unnest(array['otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
              'otp_send_max_per_window', 'otp_send_window_seconds', 'login_max_failures', 'login_window_seconds',
              'ip_max_requests', 'ip_window_seconds', 'session_ttl_seconds', 'max_active_sessions_per_user',
              'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds',
              'otp_dispatch_lease_seconds', 'otp_dispatch_max_attempts']) as k(key)
    left join iam.security_param sp on sp.key = k.key
$$;
reset role;

-- ------------------------------------------------------------------ app.staff_invite (penanda uji mutasi AUD-LOCK-01)
set role app_fn_owner;
create or replace function app.staff_invite(p_phone text, p_display_name text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_plan text; v_id uuid;
begin
  select * into a from iam.current_actor();
  perform app.require_owner();
  if not iam.valid_phone(p_phone)
     or p_display_name is null or pg_catalog.char_length(pg_catalog.btrim(p_display_name)) not between 1 and 80 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  if a.effective_status <> 'ACTIVE' then                                                 -- @kontrol:LOCK_INVITE
    raise exception 'TENANT_LOCKED' using errcode = 'P0001';                             -- @kontrol:LOCK_INVITE
  end if;                                                                                -- @kontrol:LOCK_INVITE
  select s.plan into v_plan from platform.subscription s for update;      -- RLS: hanya baris toko aktor
  if v_plan is distinct from 'PRO' then
    raise exception 'FEATURE_GATED_PLAN' using errcode = 'P0001';
  end if;
  if exists (select 1 from iam.membership m where m.role = 'ADMIN' and m.state in ('PENDING', 'ACTIVE')) then
    raise exception 'ADMIN_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  if not iam.phone_is_free(p_phone) then
    raise exception 'PHONE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  begin
    insert into iam.membership (tenant_id, role, state, display_name, invite_phone_hash, created_by)
      values (a.tenant_id, 'ADMIN', 'PENDING', pg_catalog.btrim(p_display_name), iam.phone_hash(p_phone), a.user_id)
      returning id into v_id;
  exception when unique_violation then
    raise exception 'ADMIN_LIMIT_REACHED' using errcode = 'P0001';
  end;
  perform iam.create_challenge('ACTIVATE_ADMIN', p_phone, a.tenant_id, v_id, iam.param('invite_ttl_seconds'));
  perform iam.audit(a.tenant_id, a.user_id, 'ADMIN_INVITED', '{}'::jsonb);
  return v_id;
end $$;
reset role;

-- ------------------------------------------------------------------ hak eksekusi
revoke execute on all functions in schema iam, app from public;
grant execute on function iam.register_verify(text, bytea, text, text, text, text),
  iam.activate_admin(text, bytea, text, text) to auth_runtime;
grant execute on function iam.otp_dispatch_claim(integer), iam.otp_dispatch_set_code(uuid, bytea, bytea),
  iam.otp_dispatch_ack(uuid, bytea), iam.otp_dispatch_fail(uuid, bytea) to otp_dispatch_runtime;
-- @mutasi:ISSUE_GRANT grant execute on function iam.issue_session(uuid, uuid, uuid, text) to auth_runtime;
-- @mutasi:NO_FORCE alter table iam.session no force row level security;
