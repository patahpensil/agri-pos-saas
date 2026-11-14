-- Harga eceran berversi per kemasan, keputusan Owner, dan audit.
set role migration_owner;

alter table iam.reauth_grant drop constraint reauth_grant_action_check;
alter table iam.reauth_grant add constraint reauth_grant_action_check
  check (action in ('inventory.release','inventory.move','inventory.count.approve','price.approve'));
alter table biz.idempotency drop constraint idempotency_operation_check;
alter table biz.idempotency add constraint idempotency_operation_check
  check (operation in ('product.create','inventory.receipt','inventory.open','inventory.move',
    'inventory.hold','inventory.release','inventory.count','inventory.count.approve',
    'price.request','price.approve','price.reject'));

create table biz.price_change_request (
  tenant_id uuid not null,
  id uuid not null default pg_catalog.gen_random_uuid(),
  product_id uuid not null,
  package_version_id uuid not null,
  price_idr bigint not null check (price_idr between 0 and 1000000000000000),
  expected_version bigint not null check (expected_version > 0),
  state text not null default 'PENDING' check (state in ('PENDING','APPROVED','REJECTED')),
  reason text not null check (char_length(reason) between 1 and 200 and reason ~ '[^[:space:]]'),
  source_document text check (source_document is null or
    (char_length(source_document) between 1 and 120 and source_document ~ '[^[:space:]]')),
  submitted_by uuid not null references iam.user_account(id),
  submitted_at timestamptz not null default pg_catalog.clock_timestamp(),
  approved_by uuid references iam.user_account(id),
  approved_at timestamptz,
  rejected_by uuid references iam.user_account(id),
  rejected_at timestamptz,
  primary key (tenant_id,id),
  foreign key (tenant_id,product_id) references biz.product(tenant_id,id),
  foreign key (tenant_id,product_id,package_version_id) references biz.package_version(tenant_id,product_id,id),
  check (
    (state = 'PENDING' and approved_by is null and approved_at is null
                       and rejected_by is null and rejected_at is null)
    or (state = 'APPROVED' and approved_by is not null and approved_at is not null
                           and rejected_by is null and rejected_at is null)
    or (state = 'REJECTED' and rejected_by is not null and rejected_at is not null
                           and approved_by is null and approved_at is null)
  )
);
create index price_request_lookup on biz.price_change_request(tenant_id,product_id,submitted_at,id);

create table biz.price_rule_version (
  tenant_id uuid not null,
  id uuid not null default pg_catalog.gen_random_uuid(),
  request_id uuid not null,
  product_id uuid not null,
  package_version_id uuid not null,
  price_idr bigint not null check (price_idr between 0 and 1000000000000000),
  approved_by uuid not null references iam.user_account(id),
  approved_at timestamptz not null,
  primary key (tenant_id,id),
  unique (tenant_id,request_id),
  foreign key (tenant_id,request_id) references biz.price_change_request(tenant_id,id),
  foreign key (tenant_id,product_id,package_version_id) references biz.package_version(tenant_id,product_id,id)
);
create index price_rule_lookup
  on biz.price_rule_version(tenant_id,product_id,package_version_id,approved_at desc,id desc);

create trigger price_rule_append_only before update or delete on biz.price_rule_version
  for each row execute function iam.reject_change();
create trigger price_rule_no_truncate before truncate on biz.price_rule_version
  for each statement execute function iam.reject_change();

create function biz.price_request_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op <> 'UPDATE'
     or old.state <> 'PENDING' or new.state not in ('APPROVED','REJECTED')
     or (old.tenant_id,old.id,old.product_id,old.package_version_id,old.price_idr,old.expected_version,
         old.reason,old.source_document,old.submitted_by,old.submitted_at)
        is distinct from
        (new.tenant_id,new.id,new.product_id,new.package_version_id,new.price_idr,new.expected_version,
         new.reason,new.source_document,new.submitted_by,new.submitted_at)
  then
    raise exception 'APPEND_ONLY' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger price_request_guard before update or delete on biz.price_change_request
  for each row execute function biz.price_request_guard();
create trigger price_request_no_truncate before truncate on biz.price_change_request
  for each statement execute function iam.reject_change();

create function biz.package_approved_price_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if exists (                                                                            -- @kontrol:PRICE_FACTOR_LOCK
    select 1 from biz.price_rule_version r                                                 -- @kontrol:PRICE_FACTOR_LOCK
    where r.tenant_id = old.tenant_id and r.product_id = old.product_id                    -- @kontrol:PRICE_FACTOR_LOCK
      and r.package_version_id = old.id                                                   -- @kontrol:PRICE_FACTOR_LOCK
  ) then                                                                                 -- @kontrol:PRICE_FACTOR_LOCK
    raise exception 'PACKAGE_FACTOR_LOCKED' using errcode = 'P0001';                       -- @kontrol:PRICE_FACTOR_LOCK
  end if;                                                                                -- @kontrol:PRICE_FACTOR_LOCK
  return new;
end $$;

create trigger package_approved_price_guard
  before update of factor, form on biz.package_version
  for each row
  when (old.factor is distinct from new.factor or old.form is distinct from new.form)
  execute function biz.package_approved_price_guard();

grant select, insert, update on biz.price_change_request to app_fn_owner;
grant select, insert on biz.price_rule_version to app_fn_owner;
alter table biz.price_change_request enable row level security;
alter table biz.price_change_request force row level security;
alter table biz.price_rule_version enable row level security;
alter table biz.price_rule_version force row level security;
create policy price_request_tenant on biz.price_change_request for all to app_fn_owner
  using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant());
create policy price_rule_tenant on biz.price_rule_version for all to app_fn_owner
  using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant());
reset role;

set role auth_fn_owner;
create or replace function iam.reauth_scope_hash(p_action text, p_scope jsonb) returns bytea
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p_action = 'inventory.release' then
    if p_scope is not null then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    return null;
  end if;
  if p_action = 'inventory.move' then
    if p_scope is null or pg_catalog.jsonb_typeof(p_scope) <> 'object' or p_scope->>'to' is distinct from 'SALEABLE'
       or coalesce(p_scope->>'from', '') not in ('INSPECTION', 'QUARANTINE')
       or p_scope->>'productId' is null or p_scope->>'packageId' is null or p_scope->>'batchId' is null
       or p_scope->>'qty' is null or (p_scope->>'qty')::bigint <= 0 then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    return pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'productId', (p_scope->>'productId')::uuid, 'packageId', (p_scope->>'packageId')::uuid,
      'batchId', (p_scope->>'batchId')::uuid, 'from', p_scope->>'from', 'to', p_scope->>'to',
      'qty', (p_scope->>'qty')::bigint, 'locationId', (p_scope->>'locationId')::uuid)::text, 'UTF8'));
  end if;
  if p_action = 'inventory.count.approve' then
    if p_scope is null or pg_catalog.jsonb_typeof(p_scope) <> 'object'
       or p_scope - 'expectedVersion' <> '{}'::jsonb
       or coalesce(p_scope->>'expectedVersion', '') !~ '^[1-9][0-9]{0,10}$' then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    return pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'expectedVersion', (p_scope->>'expectedVersion')::bigint)::text, 'UTF8'));
  end if;
  if p_action = 'price.approve' then
    if p_scope is null or pg_catalog.jsonb_typeof(p_scope) <> 'object'
       or p_scope - 'expectedVersion' <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(p_scope->'expectedVersion') is distinct from 'number'
       or coalesce(p_scope->>'expectedVersion','') !~ '^[1-9][0-9]{0,15}$' then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    return pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'expectedVersion', (p_scope->>'expectedVersion')::bigint)::text, 'UTF8'));
  end if;
  raise exception 'VALIDATION' using errcode = 'P0001';
end $$;
create or replace function iam.reauth_issue(p_password text, p_action text, p_target uuid, p_scope jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_h bytea; v_n integer; v_win bigint := iam.param('login_window_seconds'); v_pw text;
        v_tok bytea; v_exp timestamptz; v_scope bytea;
begin
  select * into a from iam.current_actor();
  if a.role is distinct from 'OWNER' then
    raise exception 'FORBIDDEN_ROLE' using errcode = 'P0001';
  end if;
  if p_action is null or p_action not in ('inventory.release', 'inventory.move', 'inventory.count.approve', 'price.approve') or p_target is null then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_scope := iam.reauth_scope_hash(p_action, p_scope);
  if p_action = 'inventory.move' and (p_scope->>'batchId')::uuid <> p_target then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_h := pg_catalog.sha256(pg_catalog.convert_to('reauth:' || a.user_id::text, 'UTF8'));
  v_n := iam.rate_reserve('REAUTH_FAIL', v_h, v_win);
  if v_n > iam.param('login_max_failures') then
    perform iam.audit(a.tenant_id, a.user_id, 'REAUTH_LIMITED', '{}'::jsonb);
    return pg_catalog.jsonb_build_object('status', 'RATE_LIMITED');
  end if;
  select u.password_hash into v_pw from iam.user_account u where u.id = a.user_id and u.status = 'ACTIVE';
  if not iam.check_secret(coalesce(p_password, ''), v_pw) then
    perform iam.audit(a.tenant_id, a.user_id, 'REAUTH_FAILED', pg_catalog.jsonb_build_object('action', p_action));
    return pg_catalog.jsonb_build_object('status', 'INVALID_CREDENTIALS');
  end if;
  perform iam.rate_release('REAUTH_FAIL', v_h, v_win);
  v_tok := ext.gen_random_bytes(32);
  v_exp := pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => iam.param('reauth_ttl_seconds'));
  insert into iam.reauth_grant (tenant_id, user_id, session_id, action, target_id, scope_hash, token_hash, expires_at)
  values (a.tenant_id, a.user_id, a.session_id, p_action, p_target, v_scope, pg_catalog.sha256(v_tok), v_exp);
  perform iam.audit(a.tenant_id, a.user_id, 'REAUTH_OK', pg_catalog.jsonb_build_object('action', p_action, 'target', p_target));
  return pg_catalog.jsonb_build_object('status', 'OK', 'reauthToken', pg_catalog.encode(v_tok, 'hex'), 'expiresAt', v_exp);
end $$;
reset role;

set role app_fn_owner;

-- Ketiga mutasi harga menerima versi numerik dan alasan singkat.
create function app.price_validate_decision_fields(p_body jsonb) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if pg_catalog.jsonb_typeof(p_body) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_body->'expectedVersion') is distinct from 'number'
     or coalesce(p_body->>'expectedVersion','') !~ '^[1-9][0-9]{0,15}$'
     or pg_catalog.jsonb_typeof(p_body->'reason') is distinct from 'string'
     or coalesce(p_body->>'reason','') !~ '[^[:space:]]'
     or char_length(p_body->>'reason') > 200
  then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
end $$;

create function app.price_reference(p_body jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if not (p_body ? 'referenceDocument') then
    return null;
  end if;
  if pg_catalog.jsonb_typeof(p_body->'referenceDocument') is distinct from 'string'
     or coalesce(p_body->>'referenceDocument','') !~ '[^[:space:]]'
     or char_length(p_body->>'referenceDocument') > 120
  then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  return pg_catalog.btrim(p_body->>'referenceDocument');
end $$;

create function app.price_submit(p_key uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; p record; v_package uuid; v_request uuid;
  v_previous jsonb; v_reference text; v_price bigint;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  perform app.price_validate_decision_fields(p_body);
  if p_body - 'productId' - 'packageId' - 'priceIdr' - 'expectedVersion' - 'reason' - 'referenceDocument' <> '{}'::jsonb
     or pg_catalog.jsonb_typeof(p_body->'productId') is distinct from 'string'
     or coalesce(p_body->>'productId','') !~* v_uuid
     or pg_catalog.jsonb_typeof(p_body->'packageId') is distinct from 'string'
     or coalesce(p_body->>'packageId','') !~* v_uuid
     or pg_catalog.jsonb_typeof(p_body->'priceIdr') is distinct from 'number'
     or coalesce(p_body->>'priceIdr','') !~ '^(0|[1-9][0-9]{0,15})$'
  then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_price := (p_body->>'priceIdr')::bigint;
  if v_price > 1000000000000000 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_reference := app.price_reference(p_body);
  v_previous := app.idem_claim(a.tenant_id,'price.request',p_key,p_body);
  if v_previous is not null then return v_previous; end if;

  select * into p from biz.product
    where tenant_id = a.tenant_id and id = (p_body->>'productId')::uuid for no key update;
  if p.id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p.is_subsidized then raise exception 'SUBSIDY_PRICE_SEPARATE' using errcode = 'P0001'; end if;
  if not p.is_active or p.version <> (p_body->>'expectedVersion')::bigint then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  select v.id into v_package from biz.package_version v
    where v.tenant_id = a.tenant_id and v.product_id = p.id
      and v.id = (p_body->>'packageId')::uuid and v.superseded_at is null;
  if v_package is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  insert into biz.price_change_request
    (tenant_id,product_id,package_version_id,price_idr,expected_version,reason,source_document,submitted_by)
  values (a.tenant_id,p.id,v_package,v_price,p.version,pg_catalog.btrim(p_body->>'reason'),v_reference,a.user_id)
  returning id into v_request;
  perform app.audit(a.tenant_id,a.user_id,'PRICE_REQUESTED','price_change_request',v_request,
    pg_catalog.jsonb_build_object('packageId',v_package,'priceIdr',v_price));
  return app.idem_finish(a.tenant_id,'price.request',p_key,pg_catalog.jsonb_build_object(
    'requestId',v_request,'state','PENDING','expectedVersion',p.version,'replayed',false));
end $$;

create function app.price_approve(p_key uuid,p_id uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; r record; p record;
  v_previous jsonb; v_rule uuid; v_reauth_grant uuid;
  v_reference text; v_self_submitted boolean; v_zero_price boolean; v_approved_at timestamptz;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  perform app.require_owner();                                                           -- @kontrol:PRICE_OWNER_APPROVAL
  perform app.price_validate_decision_fields(p_body);
  if p_id is null or p_body - 'expectedVersion' - 'reason' - 'referenceDocument' - 'reauthToken' <> '{}'::jsonb then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_reference := app.price_reference(p_body);
  v_previous := app.idem_claim(a.tenant_id,'price.approve',p_key,
    pg_catalog.jsonb_build_object('requestId',p_id,'body',p_body));
  if v_previous is not null then return v_previous; end if;

  select * into r from biz.price_change_request where tenant_id = a.tenant_id and id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if r.state <> 'PENDING' then raise exception 'PRICE_ALREADY_REVIEWED' using errcode = 'P0001'; end if;
  select * into p from biz.product where tenant_id = a.tenant_id and id = r.product_id for no key update;
  if p.id is null or not p.is_active or r.expected_version <> (p_body->>'expectedVersion')::bigint then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  if p.version <> r.expected_version then                                                -- @kontrol:PRICE_STALE
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';                            -- @kontrol:PRICE_STALE
  end if;                                                                                -- @kontrol:PRICE_STALE
  if p.is_subsidized then raise exception 'SUBSIDY_PRICE_SEPARATE' using errcode = 'P0001'; end if;

  -- Urutan lock sama dengan katalog: produk, lalu varian.
  perform 1 from biz.package_version v where v.tenant_id = a.tenant_id
    and v.product_id = p.id and v.id = r.package_version_id and v.superseded_at is null
    for no key update;
  if not found then raise exception 'VERSION_CONFLICT' using errcode = 'P0001'; end if;
  v_reference := coalesce(v_reference,r.source_document);
  v_self_submitted := r.submitted_by = a.user_id;
  if not v_self_submitted and coalesce(v_reference,'') !~ '[^[:space:]]' then               -- @kontrol:PRICE_REFERENCE
    raise exception 'PRICE_REFERENCE_REQUIRED' using errcode = 'P0001';                    -- @kontrol:PRICE_REFERENCE
  end if;                                                                                -- @kontrol:PRICE_REFERENCE
  v_reauth_grant := iam.reauth_consume_scope(p_body->>'reauthToken','price.approve',p_id,   -- @kontrol:PRICE_REAUTH
    pg_catalog.jsonb_build_object('expectedVersion',r.expected_version));                  -- @kontrol:PRICE_REAUTH

  v_zero_price := r.price_idr = 0;
  v_approved_at := pg_catalog.clock_timestamp();
  insert into biz.price_rule_version
    (tenant_id,request_id,product_id,package_version_id,price_idr,approved_by,approved_at)
  values (a.tenant_id,r.id,r.product_id,r.package_version_id,r.price_idr,a.user_id,v_approved_at)
  returning id into v_rule;
  update biz.price_change_request set state = 'APPROVED', approved_by = a.user_id, approved_at = v_approved_at
    where tenant_id = a.tenant_id and id = p_id;
  update biz.product set version = version + 1, updated_at = v_approved_at
    where tenant_id = a.tenant_id and id = p.id;
  perform app.audit(a.tenant_id,a.user_id,'PRICE_APPROVED','price_change_request',p_id,
    pg_catalog.jsonb_build_object('ruleId',v_rule,'reason',pg_catalog.btrim(p_body->>'reason'),
      'referenceDocument',v_reference,'reauthGrantId',v_reauth_grant,
      'selfSubmitted',v_self_submitted,'zeroPrice',v_zero_price));
  return app.idem_finish(a.tenant_id,'price.approve',p_key,pg_catalog.jsonb_build_object(
    'requestId',p_id,'ruleId',v_rule,'state','APPROVED','productVersion',p.version + 1,
    'zeroPrice',v_zero_price,'replayed',false));
end $$;

create function app.price_reject(p_key uuid,p_id uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; r record; v_previous jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  perform app.require_owner();
  perform app.price_validate_decision_fields(p_body);
  if p_id is null or p_body - 'expectedVersion' - 'reason' <> '{}'::jsonb then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_previous := app.idem_claim(a.tenant_id,'price.reject',p_key,
    pg_catalog.jsonb_build_object('requestId',p_id,'body',p_body));
  if v_previous is not null then return v_previous; end if;

  select * into r from biz.price_change_request where tenant_id = a.tenant_id and id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if r.state <> 'PENDING' then raise exception 'PRICE_ALREADY_REVIEWED' using errcode = 'P0001'; end if;

  -- Versi yang ditinjau adalah versi pada pengajuan. Produk boleh sudah berubah.
  if r.expected_version <> (p_body->>'expectedVersion')::bigint then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  update biz.price_change_request set state = 'REJECTED', rejected_by = a.user_id,
    rejected_at = pg_catalog.clock_timestamp()
    where tenant_id = a.tenant_id and id = p_id;
  perform app.audit(a.tenant_id,a.user_id,'PRICE_REJECTED','price_change_request',p_id,
    pg_catalog.jsonb_build_object('reason',pg_catalog.btrim(p_body->>'reason')));
  return app.idem_finish(a.tenant_id,'price.reject',p_key,pg_catalog.jsonb_build_object(
    'requestId',p_id,'state','REJECTED','replayed',false));
end $$;

create function app.price_list(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_product_version bigint;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  select p.version into v_product_version from biz.product p
    where p.tenant_id = a.tenant_id and p.id = p_product;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  return pg_catalog.jsonb_build_object(
    'packages',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'packageId',v.id,'packageLabel',v.label,'packageFactor',v.factor,'current',latest.price)
        order by v.label,v.id)
      from biz.package_version v
      left join lateral (
        select pg_catalog.jsonb_build_object(
          'id',r.id,'priceIdr',r.price_idr,'approvedAt',r.approved_at) as price
        from biz.price_rule_version r
        where r.tenant_id = v.tenant_id and r.product_id = v.product_id and r.package_version_id = v.id
        order by r.approved_at desc,r.id desc limit 1
      ) latest on true
      where v.tenant_id = a.tenant_id and v.product_id = p_product and v.superseded_at is null
    ),'[]'::jsonb),
    'rules',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',r.id,'packageId',r.package_version_id,'priceIdr',r.price_idr,'approvedAt',r.approved_at)
        order by r.approved_at,r.id)
      from biz.price_rule_version r where r.tenant_id = a.tenant_id and r.product_id = p_product
    ),'[]'::jsonb),
    'requests',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',r.id,'packageId',r.package_version_id,'packageLabel',v.label,'packageFactor',v.factor,
        'state',r.state,'expectedVersion',r.expected_version,'priceIdr',r.price_idr,'reason',r.reason,
        'referenceDocument',r.source_document,'submittedAt',r.submitted_at,
        'stale',r.state = 'PENDING' and r.expected_version <> v_product_version)
        order by r.submitted_at,r.id)
      from biz.price_change_request r
      join biz.package_version v on v.tenant_id = r.tenant_id and v.product_id = r.product_id
        and v.id = r.package_version_id
      where r.tenant_id = a.tenant_id and r.product_id = p_product
    ),'[]'::jsonb)
  );
end $$;

reset role;
revoke execute on all functions in schema app from public;
grant execute on function app.price_submit(uuid,jsonb),app.price_approve(uuid,uuid,jsonb),
  app.price_reject(uuid,uuid,jsonb),app.price_list(uuid) to app_runtime;
