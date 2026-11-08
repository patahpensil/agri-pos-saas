-- 0007: perbaikan audit ulang PR #4 (R4-02).
-- Masa berlaku OTP aktivasi Admin dipisahkan dari masa berlaku undangan:
--   * undangan (membership PENDING) berlaku sampai invite_expires_at  (parameter invite_ttl_seconds)
--   * setiap OTP aktivasi berlaku sesuai otp_ttl_seconds, sama seperti OTP registrasi
--   * selama undangan masih berlaku, OTP baru diminta lewat iam.admin_activation_start
--     (anti-enumerasi, batas kirim per nomor, jeda kirim ulang; challenge lama dibatalkan).
-- Kompatibilitas: undangan PENDING yang sudah ada diberi invite_expires_at dari challenge terakhirnya
-- (atau saat ini bila tidak ada), sehingga tidak ada undangan yang menjadi berlaku lebih lama.

set role migration_owner;
alter table iam.membership add column invite_expires_at timestamptz;
update iam.membership m set invite_expires_at = coalesce(
    (select max(c.expires_at) from iam.otp_challenge c where c.membership_id = m.id), pg_catalog.now())
 where m.state = 'PENDING';
alter table iam.membership add constraint membership_pending_invite_expiry
  check (state <> 'PENDING' or invite_expires_at is not null);
reset role;

set role auth_fn_owner;
create or replace function iam.activate_admin(p_phone text, p_code_mac bytea, p_password text, p_device_id text,
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
     and m.invite_expires_at > pg_catalog.clock_timestamp()                              -- @kontrol:INVITE_EXPIRY
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

-- Meminta OTP aktivasi baru selama undangan masih berlaku. Jawaban selalu sama (anti-enumerasi);
-- kode tidak pernah dikembalikan (dikirim lewat antrean OTP).
create function iam.admin_activation_start(p_phone text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_h bytea; v_m record;
begin
  if not iam.valid_phone(p_phone) then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_h := iam.phone_hash(p_phone);
  if not iam.rate_hit('OTP_SEND', v_h, iam.param('otp_send_max_per_window'), iam.param('otp_send_window_seconds')) then
    perform iam.audit(null, null, 'OTP_SEND_LIMITED', '{}'::jsonb);
    return 'RATE_LIMITED';
  end if;
  select m.tenant_id, m.id into v_m
    from iam.membership m
    join platform.tenant t on t.id = m.tenant_id and t.status <> 'OFFBOARDED'
    join platform.subscription s on s.tenant_id = m.tenant_id and s.plan = 'PRO' and s.expires_at > pg_catalog.now()
   where m.invite_phone_hash = v_h and m.role = 'ADMIN' and m.state = 'PENDING'
     and m.invite_expires_at > pg_catalog.clock_timestamp()                              -- @kontrol:INVITE_EXPIRY
   order by m.created_at desc limit 1
   for update of m;
  if v_m.id is null then
    return 'ACCEPTED';                     -- tidak ada undangan berlaku: tanpa OTP, jawaban identik
  end if;
  if exists (select 1 from iam.otp_challenge c
              where c.membership_id = v_m.id and c.used_at is null and c.voided_at is null
                and c.created_at > pg_catalog.now() - pg_catalog.make_interval(secs => iam.param('otp_resend_seconds'))) then
    return 'ACCEPTED';                     -- masih dalam jeda kirim ulang
  end if;
  update iam.otp_challenge c set voided_at = pg_catalog.now()
   where c.membership_id = v_m.id and c.used_at is null and c.voided_at is null;
  perform iam.create_challenge('ACTIVATE_ADMIN', p_phone, v_m.tenant_id, v_m.id, iam.param('otp_ttl_seconds'));
  perform iam.audit(v_m.tenant_id, null, 'OTP_ISSUED', '{"purpose":"ACTIVATE_ADMIN"}'::jsonb);
  return 'ACCEPTED';
end $$;
reset role;

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
    insert into iam.membership (tenant_id, role, state, display_name, invite_phone_hash, invite_expires_at, created_by)
      values (a.tenant_id, 'ADMIN', 'PENDING', pg_catalog.btrim(p_display_name), iam.phone_hash(p_phone),
              pg_catalog.now() + pg_catalog.make_interval(secs => iam.param('invite_ttl_seconds')), a.user_id)
      returning id into v_id;
  exception when unique_violation then
    raise exception 'ADMIN_LIMIT_REACHED' using errcode = 'P0001';
  end;
  -- R4-02: masa berlaku OTP mengikuti otp_ttl_seconds, terpisah dari masa undangan.
  perform iam.create_challenge('ACTIVATE_ADMIN', p_phone, a.tenant_id, v_id, iam.param('otp_ttl_seconds'));   -- @kontrol:INVITE_OTP_TTL
-- @mutasi:INVITE_OTP_TTL perform iam.create_challenge('ACTIVATE_ADMIN', p_phone, a.tenant_id, v_id, iam.param('invite_ttl_seconds'));
  perform iam.audit(a.tenant_id, a.user_id, 'ADMIN_INVITED', '{}'::jsonb);
  return v_id;
end $$;
reset role;

revoke execute on all functions in schema iam, app from public;
grant execute on function iam.admin_activation_start(text) to auth_runtime;
