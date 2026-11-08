-- 0005: hak akses minimum, FORCE RLS, dan trigger append-only/immutability.

-- ------------------------------------------------------------ cabut eksekusi publik (sabuk pengaman)
revoke execute on all functions in schema iam, app from public;

-- ------------------------------------------------------------ hak tabel pemilik fungsi
-- auth_fn_owner: batas kepercayaan identitas (pra-login: toko belum diketahui).
grant select, insert, update on platform.tenant, platform.location, platform.subscription to auth_fn_owner;
grant select, insert on platform.entitlement_event to auth_fn_owner;
grant select, insert, update on iam.user_account, iam.membership, iam.otp_challenge, iam.session to auth_fn_owner;
grant select, insert, update, delete on iam.otp_outbox to auth_fn_owner;   -- update: dibutuhkan FOR UPDATE
grant select, insert on iam.auth_event to auth_fn_owner;
grant select, insert, update on iam.rate_limit_bucket to auth_fn_owner;
grant select on iam.security_param to auth_fn_owner;

-- app_fn_owner: hanya yang dibutuhkan fungsi app.*, dan selalu dibatasi RLS per toko.
grant select on platform.tenant, platform.location to app_fn_owner;
grant select, update (version) on platform.subscription to app_fn_owner;
grant select, insert, update on iam.membership to app_fn_owner;
grant select, update on iam.session to app_fn_owner;
grant select, update on iam.otp_challenge to app_fn_owner;

-- Role runtime: TIDAK ada hak tabel sama sekali (dibuktikan uji T-DB-03).

-- ------------------------------------------------------------ hak eksekusi fungsi
grant execute on function iam.current_actor(), iam.param(text), iam.valid_phone(text), iam.phone_hash(text),
  iam.phone_is_free(text), iam.audit(uuid, uuid, text, jsonb),
  iam.create_challenge(text, text, uuid, uuid, bigint) to app_fn_owner;

grant execute on function iam.ip_rate_hit(text, bytea), iam.register_start(text),
  iam.register_verify(text, text, text, text, text, text), iam.login(text, text, text),
  iam.activate_admin(text, text, text, text), iam.security_params_status() to auth_runtime;

grant execute on function iam.otp_dispatch_claim(integer) to otp_dispatch_runtime;

grant execute on function app.tenant_me(), app.session_list(), app.logout(), app.session_revoke(uuid),
  app.staff_list(), app.staff_invite(text, text), app.staff_deactivate(uuid) to app_runtime;

-- ------------------------------------------------------------ FORCE RLS di semua tabel
do $$
declare t text;
begin
  foreach t in array array['platform.tenant', 'platform.location', 'platform.subscription', 'platform.entitlement_event',
                           'iam.user_account', 'iam.membership', 'iam.otp_challenge', 'iam.otp_outbox', 'iam.session',
                           'iam.auth_event', 'iam.rate_limit_bucket', 'iam.security_param'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy auth_boundary on %s for all to auth_fn_owner using (true) with check (true)', t);
  end loop;
end $$;

create policy app_tenant on platform.tenant for select to app_fn_owner using (id = app.current_tenant());
create policy app_tenant on platform.location for select to app_fn_owner using (tenant_id = app.current_tenant());
create policy app_tenant on platform.subscription for all to app_fn_owner
  using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant());
create policy app_tenant on iam.membership for all to app_fn_owner
  using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant());
create policy app_tenant on iam.session for all to app_fn_owner
  using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant());
create policy app_tenant on iam.otp_challenge for all to app_fn_owner
  using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant());

-- ------------------------------------------------------------ trigger integritas
set role migration_owner;

create function iam.reject_change() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'APPEND_ONLY' using errcode = 'P0001';
end $$;

create trigger auth_event_append_only before update or delete on iam.auth_event
  for each row execute function iam.reject_change();
create trigger auth_event_no_truncate before truncate on iam.auth_event
  for each statement execute function iam.reject_change();
create trigger entitlement_event_append_only before update or delete on platform.entitlement_event
  for each row execute function iam.reject_change();
create trigger entitlement_event_no_truncate before truncate on platform.entitlement_event
  for each statement execute function iam.reject_change();

-- Peran, toko, dan pemilik akun pada keanggotaan tidak bisa diubah (cegah naik hak).
create function iam.membership_immutable() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.role is distinct from old.role or new.tenant_id is distinct from old.tenant_id
     or (old.user_id is not null and new.user_id is distinct from old.user_id)
     or (old.state = 'DEACTIVATED' and new.state <> 'DEACTIVATED') then
    raise exception 'IMMUTABLE_FIELD' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger membership_immutable before update on iam.membership
  for each row execute function iam.membership_immutable();

-- Identitas sesi tidak bisa diubah; sesi yang dicabut tidak bisa dihidupkan lagi.
create function iam.session_immutable() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.token_hash is distinct from old.token_hash or new.user_id is distinct from old.user_id
     or new.tenant_id is distinct from old.tenant_id or new.membership_id is distinct from old.membership_id
     or new.expires_at > old.expires_at
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'IMMUTABLE_FIELD' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger session_immutable before update on iam.session
  for each row execute function iam.session_immutable();

revoke execute on function iam.reject_change(), iam.membership_immutable(), iam.session_immutable() from public;
reset role;
