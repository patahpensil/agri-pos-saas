-- 0013: Harga per varian dan persetujuan harga Owner (K-2/AUTH-04/POS-03 partial).
-- Belum ada checkout Sale, pemotongan kuota promo atau HET subsidi: tidak boleh dianggap sudah selesai.
-- Hanya fungsi SECURITY DEFINER di database boleh menulis harga. Tidak menambah hak tabel runtime.
set role migration_owner;
alter table iam.reauth_grant drop constraint reauth_grant_action_check;
alter table iam.reauth_grant add constraint reauth_grant_action_check
  check (action in ('inventory.release','inventory.move','inventory.count.approve','price.approve'));
alter table biz.idempotency drop constraint idempotency_operation_check;
alter table biz.idempotency add constraint idempotency_operation_check
  check (operation in ('product.create','inventory.receipt','inventory.open','inventory.move',
    'inventory.hold','inventory.release','inventory.count','inventory.count.approve',
    'price.request','price.approve'));

create table biz.price_change_request (
  tenant_id uuid not null,
  id uuid not null default pg_catalog.gen_random_uuid(),
  product_id uuid not null,
  package_version_id uuid not null,
  rule_type text not null check (rule_type in ('RETAIL','WHOLESALE','PROMO')),
  min_qty integer not null check (min_qty >= 1),
  price_idr bigint not null check (price_idr >= 0 and price_idr <= 1000000000000000),
  quota_units integer check (quota_units is null or quota_units > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  expected_version bigint not null check (expected_version > 0),
  state text not null default 'PENDING' check (state in ('PENDING','APPROVED')),
  reason text not null check (char_length(pg_catalog.btrim(reason)) between 1 and 200),
  source_document text check (source_document is null or char_length(source_document) between 1 and 120),
  submitted_by uuid not null references iam.user_account(id),
  submitted_at timestamptz not null default pg_catalog.clock_timestamp(),
  approved_by uuid references iam.user_account(id),
  approved_at timestamptz,
  primary key(tenant_id,id),
  foreign key(tenant_id, product_id) references biz.product(tenant_id,id),
  foreign key(tenant_id, product_id, package_version_id) references biz.package_version(tenant_id,product_id,id),
  check ((rule_type='RETAIL' and min_qty=1 and quota_units is null and starts_at is null and ends_at is null)
     or (rule_type='WHOLESALE' and min_qty>=2 and quota_units is null and starts_at is null and ends_at is null)
     or (rule_type='PROMO' and min_qty=1 and quota_units>0 and starts_at is not null and ends_at>starts_at)),
  check ((state='PENDING' and approved_by is null and approved_at is null)
      or (state='APPROVED' and approved_by is not null and approved_at is not null))
);
create index price_request_pending on biz.price_change_request(tenant_id,product_id,state);
create table biz.price_rule_version (
  tenant_id uuid not null,
  id uuid not null default pg_catalog.gen_random_uuid(),
  request_id uuid not null,
  product_id uuid not null,
  package_version_id uuid not null,
  rule_type text not null check (rule_type in ('RETAIL','WHOLESALE','PROMO')),
  min_qty integer not null check (min_qty >= 1),
  price_idr bigint not null check (price_idr >= 0),
  quota_units integer check (quota_units is null or quota_units > 0),
  used_units integer not null default 0 check (used_units >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  approved_by uuid not null references iam.user_account(id),
  approved_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tenant_id,id),
  unique (tenant_id,request_id),
  foreign key (tenant_id,request_id) references biz.price_change_request(tenant_id,id),
  foreign key (tenant_id,product_id,package_version_id) references biz.package_version(tenant_id,product_id,id),
  check (quota_units is null or used_units<=quota_units),
  check ((rule_type='RETAIL' and min_qty=1 and quota_units is null and starts_at is null and ends_at is null)
      or (rule_type='WHOLESALE' and min_qty>=2 and quota_units is null and starts_at is null and ends_at is null)
      or (rule_type='PROMO' and min_qty=1 and quota_units>0 and starts_at is not null and ends_at>starts_at))
);
create index price_rule_lookup on biz.price_rule_version(tenant_id,product_id,package_version_id,rule_type,approved_at desc);
-- Audit harga historis tak boleh dihapus/diedit. Pemotongan kuota nanti ditambah secara teruji bersama checkout.
create trigger price_rule_append_only before update or delete on biz.price_rule_version
  for each row execute function iam.reject_change();
create trigger price_rule_no_truncate before truncate on biz.price_rule_version
  for each statement execute function iam.reject_change();

create function biz.price_request_guard() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
 if tg_op <> 'UPDATE'
    or old.state <> 'PENDING' or new.state <> 'APPROVED'
    or new.approved_by is null or new.approved_at is null
    or (old.tenant_id,old.id,old.product_id,old.package_version_id,old.rule_type,old.min_qty,
        old.price_idr,old.quota_units,old.starts_at,old.ends_at,old.expected_version,
        old.reason,old.source_document,old.submitted_by,old.submitted_at)
       is distinct from
       (new.tenant_id,new.id,new.product_id,new.package_version_id,new.rule_type,new.min_qty,
        new.price_idr,new.quota_units,new.starts_at,new.ends_at,new.expected_version,
        new.reason,new.source_document,new.submitted_by,new.submitted_at)
 then
   raise exception 'APPEND_ONLY' using errcode='P0001';
 end if;
 return new;
end $$;
revoke execute on function biz.price_request_guard() from public;
create trigger price_request_guard before update or delete on biz.price_change_request
 for each row execute function biz.price_request_guard();
create trigger price_request_no_truncate before truncate on biz.price_change_request
 for each statement execute function iam.reject_change();

grant select,insert,update on biz.price_change_request to app_fn_owner;
grant select,insert on biz.price_rule_version to app_fn_owner;
alter table biz.price_change_request enable row level security;
alter table biz.price_change_request force row level security;
alter table biz.price_rule_version enable row level security;
alter table biz.price_rule_version force row level security;
create policy price_request_tenant on biz.price_change_request for all to app_fn_owner
 using (tenant_id=app.current_tenant()) with check (tenant_id=app.current_tenant());
create policy price_rule_tenant on biz.price_rule_version for all to app_fn_owner
 using (tenant_id=app.current_tenant()) with check (tenant_id=app.current_tenant());
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
       or coalesce(p_scope->>'expectedVersion','') !~ '^[1-9][0-9]{0,10} then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    return pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'expectedVersion', (p_scope->>'expectedVersion')::bigint)::text, 'UTF8'));
  end if;
  raise exception 'VALIDATION' using errcode = 'P0001';
end $;
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
-- Semua harga harus dihitung dan ditetapkan server; klien hanya mengajukan.
create function app.price_require_pro(p_tenant uuid) returns void
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
begin
 if not exists(select 1 from platform.subscription where tenant_id=p_tenant and plan='PRO') then
   raise exception 'FEATURE_GATED_PLAN' using errcode='P0001';
 end if;
end $$;

create function app.price_submit(p_key uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare a record; p record; v record; i record; v_hash bytea; v_id uuid; v_ret jsonb;
        v_type text; v_min integer; v_price bigint; v_quota integer;
begin
 select * into a from iam.current_actor();
 if a.effective_status<>'ACTIVE' then raise exception 'TENANT_LOCKED' using errcode='P0001'; end if;
 if p_body is null or pg_catalog.jsonb_typeof(p_body)<>'object' or p_key is null
   then raise exception 'VALIDATION' using errcode='P0001'; end if;
 v_type:=p_body->>'ruleType'; v_min:=(p_body->>'minQty')::integer;
 v_price:=(p_body->>'priceIdr')::bigint; v_quota:=(p_body->>'quotaUnits')::integer;
 if v_type not in ('RETAIL','WHOLESALE','PROMO') or v_type is null
    or v_min is null or v_price is null or v_price<0 or v_price>1000000000000000 then
   raise exception 'VALIDATION' using errcode='P0001';
 end if;
 if v_type<>'RETAIL' then perform app.price_require_pro(a.tenant_id); end if;
 if (v_type='RETAIL' and (v_min<>1 or v_quota is not null or p_body ? 'startsAt' or p_body ? 'endsAt'))
   or (v_type='WHOLESALE' and (v_min<2 or v_quota is not null or p_body ? 'startsAt' or p_body ? 'endsAt'))
   or (v_type='PROMO' and (v_min<>1 or v_quota is null or v_quota<=0
       or p_body->>'startsAt' is null or p_body->>'endsAt' is null
       or (p_body->>'endsAt')::timestamptz <= (p_body->>'startsAt')::timestamptz)) then
   raise exception 'VALIDATION' using errcode='P0001';
 end if;
 v_hash:=pg_catalog.sha256(pg_catalog.convert_to(p_body::text,'UTF8'));
 insert into biz.idempotency(tenant_id,operation,key,request_hash)
 values(a.tenant_id,'price.request',p_key,v_hash)
 on conflict(tenant_id,operation,key) do nothing;
 if not found then
   select * into i from biz.idempotency where tenant_id=a.tenant_id and operation='price.request' and key=p_key for update;
   if i.request_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH' using errcode='P0001'; end if;
   return i.response || '{"replayed":true}'::jsonb;
 end if;
 select * into p from biz.product where tenant_id=a.tenant_id and id=(p_body->>'productId')::uuid for update;
 if p.id is null then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
 if p.is_subsidized then raise exception 'SUBSIDY_PRICE_SEPARATE' using errcode='P0001'; end if;
 if not p.is_active or p.version<>(p_body->>'expectedVersion')::bigint then
   raise exception 'VERSION_CONFLICT' using errcode='P0001';
 end if;
 select * into v from biz.package_version where tenant_id=a.tenant_id and product_id=p.id
   and id=(p_body->>'packageId')::uuid and superseded_at is null;
 if v.id is null then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
 insert into biz.price_change_request
 (tenant_id,product_id,package_version_id,rule_type,min_qty,price_idr,quota_units,starts_at,ends_at,
  expected_version,reason,source_document,submitted_by)
 values (a.tenant_id,p.id,v.id,v_type,v_min,v_price,v_quota,
 (p_body->>'startsAt')::timestamptz,(p_body->>'endsAt')::timestamptz,
 p.version,p_body->>'reason',p_body->>'referenceDocument',a.user_id)
 returning id into v_id;
 perform app.audit(a.tenant_id,a.user_id,'PRICE_REQUESTED','price_change_request',v_id,
   pg_catalog.jsonb_build_object('ruleType',v_type,'packageId',v.id));
 v_ret:=pg_catalog.jsonb_build_object('requestId',v_id,'state','PENDING','expectedVersion',p.version,'replayed',false);
 update biz.idempotency set response=v_ret where tenant_id=a.tenant_id and operation='price.request' and key=p_key;
 return v_ret;
end $$;

create function app.price_approve(p_key uuid,p_id uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare a record; r record; p record; i record; v_hash bytea; v_ret jsonb; v_rule uuid;
begin
 select * into a from iam.current_actor();
 if a.effective_status<>'ACTIVE' then raise exception 'TENANT_LOCKED' using errcode='P0001'; end if;
 if a.role<>'OWNER' then raise exception 'FORBIDDEN_ROLE' using errcode='P0001'; end if;
 if p_key is null or p_id is null or p_body is null or pg_catalog.jsonb_typeof(p_body)<>'object'
   then raise exception 'VALIDATION' using errcode='P0001'; end if;
 v_hash:=pg_catalog.sha256(pg_catalog.convert_to(
   pg_catalog.jsonb_build_object('requestId',p_id,'body',p_body)::text,'UTF8'));
 insert into biz.idempotency(tenant_id,operation,key,request_hash)
 values(a.tenant_id,'price.approve',p_key,v_hash)
 on conflict(tenant_id,operation,key) do nothing;
 if not found then
   select * into i from biz.idempotency where tenant_id=a.tenant_id and operation='price.approve' and key=p_key for update;
   if i.request_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH' using errcode='P0001'; end if;
   return i.response || '{"replayed":true}'::jsonb;
 end if;
 select * into r from biz.price_change_request where tenant_id=a.tenant_id and id=p_id for update;
 if r.id is null then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
 if r.state<>'PENDING' then raise exception 'PRICE_ALREADY_REVIEWED' using errcode='P0001'; end if;
 select * into p from biz.product where tenant_id=a.tenant_id and id=r.product_id for update;
 if p.id is null or not p.is_active or p.version<>r.expected_version
    or r.expected_version<>(p_body->>'expectedVersion')::bigint then
   raise exception 'VERSION_CONFLICT' using errcode='P0001';
 end if;
 if r.rule_type<>'RETAIL' then perform app.price_require_pro(a.tenant_id); end if;
 if p.is_subsidized then raise exception 'SUBSIDY_PRICE_SEPARATE' using errcode='P0001'; end if;
 if not exists (select 1 from biz.package_version v where v.tenant_id=a.tenant_id
   and v.id=r.package_version_id and v.product_id=p.id and v.superseded_at is null) then
   raise exception 'VERSION_CONFLICT' using errcode='P0001';
 end if;
 perform iam.reauth_consume_scope(p_body->>'reauthToken','price.approve',p_id,
   pg_catalog.jsonb_build_object('expectedVersion',r.expected_version));
 insert into biz.price_rule_version
 (tenant_id,request_id,product_id,package_version_id,rule_type,min_qty,price_idr,
  quota_units,starts_at,ends_at,approved_by)
 values(a.tenant_id,r.id,r.product_id,r.package_version_id,r.rule_type,r.min_qty,r.price_idr,
  r.quota_units,r.starts_at,r.ends_at,a.user_id)
 returning id into v_rule;
 update biz.price_change_request set state='APPROVED',approved_by=a.user_id,
   approved_at=pg_catalog.clock_timestamp()
 where tenant_id=a.tenant_id and id=p_id;
 update biz.product set version=version+1,updated_at=pg_catalog.clock_timestamp()
 where tenant_id=a.tenant_id and id=p.id;
 perform app.audit(a.tenant_id,a.user_id,'PRICE_APPROVED','price_change_request',p_id,
    pg_catalog.jsonb_build_object('ruleId',v_rule,'reason',p_body->>'reason'));
 v_ret:=pg_catalog.jsonb_build_object('requestId',p_id,'ruleId',v_rule,'state','APPROVED','productVersion',p.version+1,'replayed',false);
 update biz.idempotency set response=v_ret where tenant_id=a.tenant_id and operation='price.approve' and key=p_key;
 return v_ret;
end $$;

create function app.price_list(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a record;
begin
 select * into a from iam.current_actor();
 if not exists (select 1 from biz.product p where p.tenant_id=a.tenant_id and p.id=p_product)
    then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
 return pg_catalog.jsonb_build_object(
   'rules',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',r.id,'packageId',r.package_version_id,'ruleType',r.rule_type,'minQty',r.min_qty,
    'priceIdr',r.price_idr,'quotaUnits',r.quota_units,'usedUnits',r.used_units,
    'startsAt',r.starts_at,'endsAt',r.ends_at,'approvedAt',r.approved_at)
    order by r.approved_at,r.id)
    from biz.price_rule_version r where r.tenant_id=a.tenant_id and r.product_id=p_product),'[]'::jsonb),
   'requests',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',r.id,'packageId',r.package_version_id,'ruleType',r.rule_type,'state',r.state,
    'expectedVersion',r.expected_version,'priceIdr',r.price_idr)
    order by r.submitted_at,r.id)
    from biz.price_change_request r where r.tenant_id=a.tenant_id and r.product_id=p_product),'[]'::jsonb));
end $$;
reset role;
revoke execute on all functions in schema app from public;
grant execute on function app.price_submit(uuid,jsonb),app.price_approve(uuid,uuid,jsonb),
 app.price_list(uuid) to app_runtime;
