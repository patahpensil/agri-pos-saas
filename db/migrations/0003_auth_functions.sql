-- 0003: fungsi identitas (milik auth_fn_owner, SECURITY DEFINER, search_path terkunci).
--
-- Batas kepercayaan (TEMUAN-01):
--  * Sesi HANYA diterbitkan oleh fungsi yang di dalam transaksi yang sama memverifikasi bukti:
--    sandi (bcrypt via pgcrypto, diverifikasi di database) atau OTP (hash di database).
--  * Fungsi penerbit sesi iam.issue_session() TIDAK bisa dieksekusi role runtime mana pun.
--  * Kode OTP dibuat di database dan hanya keluar lewat iam.otp_dispatch_claim() yang dapat
--    dieksekusi otp_dispatch_runtime saja; auth_runtime tidak pernah menerima kode OTP.
--  * Parameter keamanan dibaca dari iam.security_param, bukan dari argumen pemanggil.
set role auth_fn_owner;

-- ------------------------------------------------------------ helper internal
create function iam.param(p_key text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v bigint;
begin
  select sp.value into v from iam.security_param sp where sp.key = p_key;
  if v is null then
    raise exception 'SECURITY_PARAM_MISSING' using errcode = 'P0001';
  end if;
  return v;
end $$;

create function iam.phone_hash(p_phone text) returns bytea
language sql immutable security definer set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.sha256(pg_catalog.convert_to(p_phone, 'UTF8'))
$$;

create function iam.valid_phone(p_phone text) returns boolean
language sql immutable security definer set search_path = pg_catalog, pg_temp as $$
  select p_phone is not null and p_phone ~ '^\+62[1-9][0-9]{7,12}$'
$$;

create function iam.audit(p_tenant uuid, p_actor uuid, p_kind text, p_detail jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  insert into iam.auth_event (tenant_id, actor_user_id, kind, detail) values (p_tenant, p_actor, p_kind, p_detail)
$$;

-- Menambah 1 hit pada jendela tetap; mengembalikan true bila masih dalam batas.
create function iam.rate_hit(p_kind text, p_key bytea, p_max bigint, p_window_s bigint) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare ws timestamptz; n integer;
begin
  ws := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) / p_window_s) * p_window_s);
  insert into iam.rate_limit_bucket as b (kind, key_hash, window_start, hits) values (p_kind, p_key, ws, 1)
    on conflict (kind, key_hash, window_start) do update set hits = b.hits + 1
    returning b.hits into n;
  return n <= p_max;
end $$;

create function iam.rate_count(p_kind text, p_key bytea, p_window_s bigint) returns integer
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare ws timestamptz; n integer;
begin
  ws := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) / p_window_s) * p_window_s);
  select b.hits into n from iam.rate_limit_bucket b where b.kind = p_kind and b.key_hash = p_key and b.window_start = ws;
  return coalesce(n, 0);
end $$;

-- OTP 6 digit dari pembangkit acak kriptografis.
create function iam.new_otp() returns text
language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.lpad(((('x' || pg_catalog.encode(ext.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0')
$$;

create function iam.hash_secret(p_secret text, p_cost integer) returns text
language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select ext.crypt(p_secret, ext.gen_salt('bf', p_cost))
$$;

create function iam.check_secret(p_secret text, p_hash text) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p_hash is not null and ext.crypt(p_secret, p_hash) = p_hash
$$;

create function iam.check_password_policy(p_password text) returns void
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_password is null
     or pg_catalog.char_length(p_password) < iam.param('password_min_length')
     or pg_catalog.octet_length(p_password) > 72 then          -- batas bcrypt
    raise exception 'PASSWORD_POLICY' using errcode = 'P0001';
  end if;
end $$;

create function iam.phone_is_free(p_phone text) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select not exists (select 1 from iam.user_account u where u.phone_e164 = p_phone)
$$;

-- Penerbitan sesi. INTERNAL: tidak dapat dieksekusi role runtime mana pun (dibuktikan uji).
-- O-1/AUTH-06: sesi aktif di perangkat lain dicabut (DEVICE_CHANGE); jumlah sesi dibatasi parameter.
create function iam.issue_session(p_tenant uuid, p_user uuid, p_membership uuid, p_device text,
                                  out r_token text, out r_expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_max bigint := iam.param('max_active_sessions_per_user');
begin
  if p_device is null or pg_catalog.char_length(p_device) not between 8 and 128 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  update iam.session s set revoked_at = pg_catalog.now(), revoke_reason = 'DEVICE_CHANGE'
   where s.user_id = p_user and s.revoked_at is null and s.device_id <> p_device;

  r_token := pg_catalog.encode(ext.gen_random_bytes(32), 'hex');
  r_expires_at := pg_catalog.now() + pg_catalog.make_interval(secs => iam.param('session_ttl_seconds'));
  insert into iam.session (tenant_id, token_hash, user_id, membership_id, device_id, auth_at, expires_at)
  values (p_tenant, pg_catalog.sha256(pg_catalog.convert_to(r_token, 'UTF8')), p_user, p_membership, p_device,
          pg_catalog.now(), r_expires_at);

  update iam.session s set revoked_at = pg_catalog.now(), revoke_reason = 'SESSION_LIMIT'
   where s.id in (select s2.id from iam.session s2
                   where s2.user_id = p_user and s2.revoked_at is null
                   order by s2.created_at desc, s2.id desc offset v_max);
  perform iam.audit(p_tenant, p_user, 'SESSION_ISSUED', '{}'::jsonb);
end $$;

-- Membuat challenge OTP + baris kotak keluar. INTERNAL.
create function iam.create_challenge(p_purpose text, p_phone text, p_tenant uuid, p_membership uuid, p_ttl_s bigint)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_code text := iam.new_otp(); v_id uuid;
begin
  insert into iam.otp_challenge (purpose, phone_hash, tenant_id, membership_id, code_hash, expires_at, max_attempts)
  values (p_purpose, iam.phone_hash(p_phone), p_tenant, p_membership, iam.hash_secret(v_code, 6),
          pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_s), iam.param('otp_max_attempts'))
  returning id into v_id;
  insert into iam.otp_outbox (challenge_id, phone_e164, code) values (v_id, p_phone, v_code);
  return v_id;
end $$;

-- Verifikasi OTP dengan penghitungan percobaan yang PERMANEN (TEMUAN-02):
-- tidak memakai exception untuk OTP salah, sehingga kenaikan attempt_count ikut ter-commit.
-- Baris challenge dikunci FOR UPDATE agar percobaan serentak tidak kehilangan hitungan.
-- Mengembalikan 'OK' (challenge ditandai terpakai), 'OTP_INVALID', atau 'OTP_LOCKED'.
create function iam.consume_otp(p_purpose text, p_phone text, p_code text, out r_status text, out r_challenge iam.otp_challenge)
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
     or p_code is null or p_code !~ '^[0-9]{6}$'
     or not iam.check_secret(p_code, r_challenge.code_hash) then
    update iam.otp_challenge c set attempt_count = c.attempt_count + 1 where c.id = r_challenge.id
      returning c.attempt_count into r_challenge.attempt_count;
    perform iam.audit(r_challenge.tenant_id, null, 'OTP_FAILED', pg_catalog.jsonb_build_object('purpose', p_purpose));
    r_status := case when r_challenge.attempt_count >= r_challenge.max_attempts then 'OTP_LOCKED' else 'OTP_INVALID' end;
    return;
  end if;
  update iam.otp_challenge c set used_at = pg_catalog.clock_timestamp() where c.id = r_challenge.id;
  r_status := 'OK';
end $$;

-- ------------------------------------------------------------ fungsi untuk auth_runtime
-- Batas laju per IP (dipanggil backend sebelum endpoint pra-login).
create function iam.ip_rate_hit(p_kind text, p_ip_hash bytea) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_kind not in ('IP_REGISTER', 'IP_LOGIN', 'IP_ACTIVATE') or p_ip_hash is null or pg_catalog.octet_length(p_ip_hash) <> 32 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  return iam.rate_hit(p_kind, p_ip_hash, iam.param('ip_max_requests'), iam.param('ip_window_seconds'));
end $$;

-- Mulai registrasi. Jawaban sama untuk nomor terdaftar/tidak (anti-enumerasi); kode OTP TIDAK dikembalikan.
create function iam.register_start(p_phone text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_h bytea;
begin
  if not iam.valid_phone(p_phone) then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_h := iam.phone_hash(p_phone);
  if not iam.rate_hit('OTP_SEND', v_h, iam.param('otp_send_max_per_window'), iam.param('otp_send_window_seconds')) then
    perform iam.audit(null, null, 'OTP_SEND_LIMITED', '{}'::jsonb);
    return 'RATE_LIMITED';
  end if;
  if not iam.phone_is_free(p_phone) then
    return 'ACCEPTED';                      -- nomor sudah terdaftar: tanpa OTP, jawaban identik
  end if;
  if exists (select 1 from iam.otp_challenge c
              where c.phone_hash = v_h and c.purpose = 'REGISTER_OWNER' and c.used_at is null and c.voided_at is null
                and c.created_at > pg_catalog.now() - pg_catalog.make_interval(secs => iam.param('otp_resend_seconds'))) then
    return 'ACCEPTED';                      -- masih dalam jeda kirim ulang
  end if;
  -- Challenge lama dibatalkan agar hanya satu yang berlaku.
  update iam.otp_challenge c set voided_at = pg_catalog.now()
   where c.phone_hash = v_h and c.purpose = 'REGISTER_OWNER' and c.used_at is null and c.voided_at is null;
  perform iam.create_challenge('REGISTER_OWNER', p_phone, null, null, iam.param('otp_ttl_seconds'));
  perform iam.audit(null, null, 'OTP_ISSUED', '{"purpose":"REGISTER_OWNER"}'::jsonb);
  return 'ACCEPTED';
end $$;

-- Bootstrap toko (TEMUAN-03): satu-satunya jalur pembuatan toko. Hanya berjalan setelah OTP sah,
-- semua langkah dalam satu transaksi; identitas toko, peran OWNER, dan paket FREE ditetapkan di sini,
-- bukan dari input klien.
create function iam.register_verify(p_phone text, p_code text, p_password text, p_business_name text,
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

  select * into v_otp from iam.consume_otp('REGISTER_OWNER', p_phone, p_code);
  if v_otp.r_status <> 'OK' then
    r_status := v_otp.r_status; return;   -- hitungan percobaan sudah tersimpan
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

-- Login nomor HP + sandi. Sandi diverifikasi DI DATABASE; jawaban gagal sama untuk nomor tak dikenal.
create function iam.login(p_phone text, p_password text, p_device_id text,
                          out r_status text, out r_token text, out r_expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_h bytea; v_u record; v_ok boolean;
begin
  if p_device_id is null or pg_catalog.char_length(p_device_id) not between 8 and 128 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_h := iam.phone_hash(coalesce(p_phone, ''));
  if iam.rate_count('LOGIN_FAIL', v_h, iam.param('login_window_seconds')) >= iam.param('login_max_failures') then
    perform iam.audit(null, null, 'LOGIN_LIMITED', '{}'::jsonb);
    r_status := 'RATE_LIMITED'; return;
  end if;

  select u.id as user_id, u.password_hash, m.tenant_id, m.id as membership_id into v_u
    from iam.user_account u
    join iam.membership m on m.user_id = u.id and m.state = 'ACTIVE'
    join platform.tenant t on t.id = m.tenant_id and t.status <> 'OFFBOARDED'
   where u.phone_e164 = p_phone and u.status = 'ACTIVE';

  if v_u.user_id is null then
    -- Hitung bcrypt palsu agar waktu kerja mirip (anti-enumerasi; kesetaraan waktu hanya diukur di lab).
    perform iam.hash_secret(coalesce(p_password, ''), iam.param('bcrypt_cost')::integer);
    v_ok := false;
  else
    v_ok := iam.check_secret(coalesce(p_password, ''), v_u.password_hash);
  end if;

  if not v_ok then
    perform iam.rate_hit('LOGIN_FAIL', v_h, 2147483647, iam.param('login_window_seconds'));
    perform iam.audit(v_u.tenant_id, null, 'LOGIN_FAILED', '{}'::jsonb);
    r_status := 'INVALID_CREDENTIALS'; return;
  end if;

  select s.r_token, s.r_expires_at into r_token, r_expires_at
    from iam.issue_session(v_u.tenant_id, v_u.user_id, v_u.membership_id, p_device_id) s;
  perform iam.audit(v_u.tenant_id, v_u.user_id, 'LOGIN_OK', '{}'::jsonb);
  r_status := 'OK';
end $$;

-- Aktivasi Admin oleh pemilik nomor HP (O-2): OTP ke HP Admin, sandi dibuat sendiri oleh Admin.
create function iam.activate_admin(p_phone text, p_code text, p_password text, p_device_id text,
                                   out r_status text, out r_token text, out r_expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_otp record; v_m record; v_user uuid;
begin
  if not iam.valid_phone(p_phone) or p_device_id is null or pg_catalog.char_length(p_device_id) not between 8 and 128 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  perform iam.check_password_policy(p_password);

  select * into v_otp from iam.consume_otp('ACTIVATE_ADMIN', p_phone, p_code);
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
    r_status := 'PHONE_NOT_AVAILABLE'; return;   -- pemanggil sudah membuktikan memiliki nomor ini
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

-- Pengambilan kode OTP untuk dikirim. Hanya otp_dispatch_runtime. Baris dihapus saat diambil.
create function iam.otp_dispatch_claim(p_limit integer)
returns table (r_phone text, r_code text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  return query
  delete from iam.otp_outbox o
   where o.challenge_id in (select o2.challenge_id from iam.otp_outbox o2 order by o2.created_at
                             limit greatest(1, least(coalesce(p_limit, 50), 200)) for update skip locked)
  returning o.phone_e164, o.code;
end $$;

-- Status parameter keamanan untuk pemeriksaan startup (tanpa nilai rahasia).
create function iam.security_params_status()
returns table (r_key text, r_present boolean, r_test_only boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select k.key, sp.key is not null, coalesce(sp.test_only, false)
    from pg_catalog.unnest(array['otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
              'otp_send_max_per_window', 'otp_send_window_seconds', 'login_max_failures', 'login_window_seconds',
              'ip_max_requests', 'ip_window_seconds', 'session_ttl_seconds', 'max_active_sessions_per_user',
              'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds']) as k(key)
    left join iam.security_param sp on sp.key = k.key
$$;

-- Penentu aktor dari token sesi lokal-transaksi. Dipakai fungsi app.* dan kebijakan RLS.
create function iam.current_actor(
  out tenant_id uuid, out user_id uuid, out membership_id uuid, out role text, out session_id uuid,
  out plan text, out effective_status text, out expires_at timestamptz, out grace_deadline timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_tok text := pg_catalog.current_setting('app.session_token', true); v record;
begin
  if v_tok is null or v_tok !~ '^[0-9a-f]{64}$' then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;
  select s.tenant_id, s.user_id, s.membership_id, m.role, s.id as session_id, sub.plan, t.status,
         sub.expires_at, sub.grace_deadline into v
    from iam.session s
    join iam.membership m on m.tenant_id = s.tenant_id and m.id = s.membership_id and m.state = 'ACTIVE'
    join iam.user_account u on u.id = s.user_id and u.status = 'ACTIVE'
    join platform.tenant t on t.id = s.tenant_id and t.status <> 'OFFBOARDED'
    join platform.subscription sub on sub.tenant_id = s.tenant_id
   where s.token_hash = pg_catalog.sha256(pg_catalog.convert_to(v_tok, 'UTF8'))
     and s.revoked_at is null and s.expires_at > pg_catalog.clock_timestamp();
  if v.tenant_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;
  tenant_id := v.tenant_id; user_id := v.user_id; membership_id := v.membership_id; role := v.role;
  session_id := v.session_id; plan := v.plan; expires_at := v.expires_at; grace_deadline := v.grace_deadline;
  effective_status := case when v.status = 'ACTIVE' and pg_catalog.clock_timestamp() >= v.expires_at
                           then 'LOCKED_GRACE' else v.status end;
end $$;

reset role;
