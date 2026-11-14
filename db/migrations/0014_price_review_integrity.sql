-- Tindak lanjut review PR #14. Pertahankan checksum migrasi yang sudah diterapkan.
set role migration_owner;

create function biz.package_approved_price_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if exists (
    select 1 from biz.price_rule_version r
    where r.tenant_id = old.tenant_id and r.product_id = old.product_id
      and r.package_version_id = old.id
  ) then
    raise exception 'PACKAGE_FACTOR_LOCKED' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger package_approved_price_guard
  before update of factor, form on biz.package_version
  for each row
  when (old.factor is distinct from new.factor or old.form is distinct from new.form)
  execute function biz.package_approved_price_guard();

reset role;

set role app_fn_owner;

create or replace function app.price_approve(p_key uuid,p_id uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare a record; r record; p record; i record; v_hash bytea; v_ret jsonb; v_rule uuid;
        v_reference text; v_reauth_grant uuid;
begin
 select * into a from iam.current_actor();
 if a.effective_status<>'ACTIVE' then raise exception 'TENANT_LOCKED' using errcode='P0001'; end if;
 if a.role<>'OWNER' then raise exception 'FORBIDDEN_ROLE' using errcode='P0001'; end if;
 if p_key is null or p_id is null or p_body is null or pg_catalog.jsonb_typeof(p_body)<>'object'
    or p_body - 'expectedVersion' - 'reason' - 'referenceDocument' - 'reauthToken' <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_body->'expectedVersion') is distinct from 'number'
    or coalesce(p_body->>'expectedVersion','') !~ '^[1-9][0-9]{0,15}$'
    or pg_catalog.jsonb_typeof(p_body->'reason') is distinct from 'string'
    or coalesce(p_body->>'reason','') !~ '[^[:space:]]'
    or char_length(pg_catalog.btrim(p_body->>'reason')) > 200
    or (p_body ? 'referenceDocument' and (
       pg_catalog.jsonb_typeof(p_body->'referenceDocument') is distinct from 'string'
       or coalesce(p_body->>'referenceDocument','') !~ '[^[:space:]]'
       or char_length(pg_catalog.btrim(p_body->>'referenceDocument')) > 120))
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
 -- Urutan lock sama dengan katalog: produk, lalu varian.
 perform 1 from biz.package_version v where v.tenant_id=a.tenant_id
   and v.id=r.package_version_id and v.product_id=p.id and v.superseded_at is null
   for no key update;
 if not found then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;

 v_reference := coalesce(p_body->>'referenceDocument',r.source_document);
 if coalesce(v_reference,'') !~ '[^[:space:]]' then
   raise exception 'PRICE_REFERENCE_REQUIRED' using errcode='P0001';
 end if;
 v_reauth_grant := iam.reauth_consume_scope(p_body->>'reauthToken','price.approve',p_id,
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
    pg_catalog.jsonb_build_object('ruleId',v_rule,'reason',pg_catalog.btrim(p_body->>'reason'),
      'referenceDocument',pg_catalog.btrim(v_reference),'reauthGrantId',v_reauth_grant));
 v_ret:=pg_catalog.jsonb_build_object('requestId',p_id,'ruleId',v_rule,'state','APPROVED','productVersion',p.version+1,'replayed',false);
 update biz.idempotency set response=v_ret where tenant_id=a.tenant_id and operation='price.approve' and key=p_key;
 return v_ret;
end $$;

create or replace function app.price_list(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a record;
begin
 select * into a from iam.current_actor();
 perform app.inv_require_active(a.effective_status);
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
    'id',r.id,'packageId',r.package_version_id,'packageLabel',v.label,'packageFactor',v.factor,
    'ruleType',r.rule_type,'state',r.state,'expectedVersion',r.expected_version,
    'priceIdr',r.price_idr,'minQty',r.min_qty,'quotaUnits',r.quota_units,
    'startsAt',r.starts_at,'endsAt',r.ends_at,'reason',r.reason,
    'referenceDocument',r.source_document,'submittedAt',r.submitted_at)
    order by r.submitted_at,r.id)
    from biz.price_change_request r
    join biz.package_version v on v.tenant_id=r.tenant_id and v.product_id=r.product_id
      and v.id=r.package_version_id
    where r.tenant_id=a.tenant_id and r.product_id=p_product),'[]'::jsonb));
end $$;
reset role;
