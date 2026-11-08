-- 0004: fungsi bisnis tenant (milik app_fn_owner, SECURITY DEFINER, search_path terkunci).
-- Semua fungsi menurunkan aktor dari iam.current_actor() (token sesi lokal-transaksi), lalu
-- mengakses tabel sebagai app_fn_owner yang dibatasi FORCE RLS: tenant_id = app.current_tenant().
set role app_fn_owner;

-- Dipakai kebijakan RLS. SECURITY INVOKER: dijalankan sebagai app_fn_owner di dalam fungsi app.*.
create function app.current_tenant() returns uuid
language sql stable set search_path = pg_catalog, pg_temp as $$
  select a.tenant_id from iam.current_actor() a
$$;

create function app.require_owner() returns void
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
begin
  if (select a.role from iam.current_actor() a) is distinct from 'OWNER' then
    raise exception 'FORBIDDEN_ROLE' using errcode = 'P0001';
  end if;
end $$;

-- GET /tenant/me
create function app.tenant_me() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; t record;
begin
  select * into a from iam.current_actor();
  select tn.id, tn.business_name, tn.timezone into t from platform.tenant tn where tn.id = a.tenant_id;
  return pg_catalog.jsonb_build_object(
    'tenant', pg_catalog.jsonb_build_object('id', t.id, 'businessName', t.business_name, 'timezone', t.timezone),
    'role', a.role,
    'plan', a.plan,
    'effectiveStatus', a.effective_status,
    'expiresAt', a.expires_at,
    'graceDeadline', a.grace_deadline,
    'limits', pg_catalog.jsonb_build_object('maxAdmins', case when a.plan = 'PRO' then 1 else 0 end));
end $$;

-- GET /auth/sessions: hanya sesi milik aktor sendiri, tanpa token.
create function app.session_list()
returns table (r_id uuid, r_device_id text, r_created_at timestamptz, r_expires_at timestamptz, r_current boolean)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record;
begin
  select * into a from iam.current_actor();
  return query
    select s.id, s.device_id, s.created_at, s.expires_at, s.id = a.session_id
      from iam.session s
     where s.user_id = a.user_id and s.revoked_at is null and s.expires_at > pg_catalog.clock_timestamp()
     order by s.created_at desc;
end $$;

-- POST /auth/logout
create function app.logout() returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record;
begin
  select * into a from iam.current_actor();
  update iam.session s set revoked_at = pg_catalog.now(), revoke_reason = 'LOGOUT'
   where s.tenant_id = a.tenant_id and s.id = a.session_id and s.revoked_at is null;
  perform iam.audit(a.tenant_id, a.user_id, 'LOGOUT', '{}'::jsonb);
end $$;

-- POST /auth/sessions/{id}/revoke (Owner). Sesi toko lain tidak terlihat (RLS) -> NOT_FOUND.
create function app.session_revoke(p_session_id uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; n integer;
begin
  select * into a from iam.current_actor();
  perform app.require_owner();
  update iam.session s set revoked_at = pg_catalog.now(), revoke_reason = 'OWNER_REVOKE'
   where s.id = p_session_id and s.revoked_at is null;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  perform iam.audit(a.tenant_id, a.user_id, 'SESSION_REVOKED_BY_OWNER', '{}'::jsonb);
end $$;

-- GET /staff (Owner)
create function app.staff_list()
returns table (r_id uuid, r_role text, r_state text, r_display_name text, r_created_at timestamptz,
               r_activated_at timestamptz, r_deactivated_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform app.require_owner();
  return query
    select m.id, m.role, m.state, m.display_name, m.created_at, m.activated_at, m.deactivated_at
      from iam.membership m
     order by m.created_at;
end $$;

-- POST /staff (Owner, PRO). Kunci baris langganan mencegah dua undangan serentak melampaui kuota.
create function app.staff_invite(p_phone text, p_display_name text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_plan text; v_id uuid;
begin
  select * into a from iam.current_actor();
  perform app.require_owner();
  if not iam.valid_phone(p_phone)
     or p_display_name is null or pg_catalog.char_length(pg_catalog.btrim(p_display_name)) not between 1 and 80 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  if a.effective_status <> 'ACTIVE' then
    raise exception 'TENANT_LOCKED' using errcode = 'P0001';
  end if;
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

-- POST /staff/{id}/deactivate (Owner). Histori tetap; semua sesi Admin dicabut; undangan dibatalkan.
-- Tindakan pengamanan ini tetap diizinkan saat toko LOCKED_GRACE.
create function app.staff_deactivate(p_membership_id uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_state text;
begin
  select * into a from iam.current_actor();
  perform app.require_owner();
  select m.state into v_state from iam.membership m
   where m.id = p_membership_id and m.role = 'ADMIN' for update;
  if v_state is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_state = 'DEACTIVATED' then
    return;                                                     -- idempoten
  end if;
  update iam.membership m set state = 'DEACTIVATED', deactivated_at = pg_catalog.now(), version = m.version + 1
   where m.id = p_membership_id;
  update iam.session s set revoked_at = pg_catalog.now(), revoke_reason = 'ADMIN_DEACTIVATED'
   where s.membership_id = p_membership_id and s.revoked_at is null;
  update iam.otp_challenge c set voided_at = pg_catalog.now()
   where c.membership_id = p_membership_id and c.used_at is null and c.voided_at is null;
  perform iam.audit(a.tenant_id, a.user_id, 'ADMIN_DEACTIVATED', '{}'::jsonb);
end $$;

reset role;
