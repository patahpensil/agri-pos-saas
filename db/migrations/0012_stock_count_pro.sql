-- 0012: INV-07 stok opname PRO, per item/batch/kemasan. Count snapshot tidak memutasi stok.
-- Kunci produk + delta ledger setelah counted_at saat approval: transaksi setelah hitung TIDAK dihapus.
-- Fase pertama: SALEABLE saja. HELD/karantina & subsidi tidak diubah melalui opname umum.
-- Tidak ada harga jual/checkout; tidak ada konstanta keamanan produksi baru.

set role migration_owner;

alter table biz.inventory_event drop constraint inventory_event_kind_check;
alter table biz.inventory_event add constraint inventory_event_kind_check
 check (kind in ('OPENING','RECEIPT','OPEN_PACKAGE','STATUS_MOVE','HOLD','RELEASE','COUNT_ADJUST'));
alter table biz.inventory_ledger drop constraint inventory_ledger_movement_check;
alter table biz.inventory_ledger add constraint inventory_ledger_movement_check
 check (movement in ('OPENING','RECEIPT','OPEN_PACKAGE','STATUS_MOVE','HOLD','RELEASE','COUNT_ADJUST'));
alter table biz.value_ledger drop constraint value_ledger_cost_basis_check;
alter table biz.value_ledger add constraint value_ledger_cost_basis_check
 check (cost_basis in ('KNOWN','BONUS_ZERO','UNVERIFIED','MOVE','ADJUST'));
alter table biz.idempotency drop constraint idempotency_operation_check;
alter table biz.idempotency add constraint idempotency_operation_check
 check (operation in ('product.create','inventory.receipt','inventory.open','inventory.move',
                      'inventory.hold','inventory.release','inventory.count','inventory.count.approve'));
alter table iam.reauth_grant drop constraint reauth_grant_action_check;
alter table iam.reauth_grant add constraint reauth_grant_action_check
 check (action in ('inventory.release','inventory.move','inventory.count.approve'));

create table biz.stock_count (
 tenant_id uuid not null,
 id uuid not null default pg_catalog.gen_random_uuid(),
 product_id uuid not null,
 location_id uuid not null,
 counted_at timestamptz not null,
 entered_at timestamptz not null,
 ledger_version bigint not null check (ledger_version >= 0),
 reason text not null check (char_length(reason) between 1 and 200),
 state text not null default 'PENDING' check (state in ('PENDING','APPROVED')),
 version bigint not null default 1 check (version >= 1),
 submitted_by uuid not null references iam.user_account(id),
 approved_by uuid references iam.user_account(id),
 approved_at timestamptz,
 approval_reason text check (approval_reason is null or char_length(approval_reason) between 1 and 200),
 approval_document text check (approval_document is null or char_length(approval_document) between 1 and 120),
 approval_event_id uuid,
 primary key (tenant_id,id),
 unique (tenant_id,id,product_id,location_id),
 foreign key (tenant_id,product_id) references biz.product(tenant_id,id),
 foreign key (tenant_id,location_id) references platform.location(tenant_id,id),
 foreign key (tenant_id,approval_event_id,product_id,location_id)
   references biz.inventory_event(tenant_id,id,product_id,location_id),
 check (counted_at <= entered_at),
 check ((state='PENDING' and approved_by is null and approved_at is null and approval_event_id is null)
    or (state='APPROVED' and approved_by is not null and approved_at is not null and approval_event_id is not null))
);

create table biz.stock_count_line (
 tenant_id uuid not null,
 count_id uuid not null,
 location_id uuid not null,
 product_id uuid not null,
 package_version_id uuid not null,
 batch_id uuid not null,
 status text not null default 'SALEABLE' check (status = 'SALEABLE'),
 physical_qty integer not null check (physical_qty >= 0),
 system_qty_at_count integer not null check (system_qty_at_count >= 0),
 ledger_version bigint not null check (ledger_version >= 0),
 cost_basis text check (cost_basis in ('KNOWN','BONUS_ZERO','UNVERIFIED')),
 positive_value_idr bigint check (positive_value_idr is null or positive_value_idr >= 0),
 basis_reason text check (basis_reason is null or char_length(basis_reason) between 1 and 200),
 basis_origin text check (basis_origin is null or char_length(basis_origin) between 1 and 200),
 primary key (tenant_id,count_id,package_version_id,batch_id),
 foreign key (tenant_id,count_id,product_id,location_id)
   references biz.stock_count(tenant_id,id,product_id,location_id),
 foreign key (tenant_id,product_id,package_version_id)
   references biz.package_version(tenant_id,product_id,id),
 foreign key (tenant_id,product_id,batch_id)
   references biz.batch(tenant_id,product_id,id),
 check ((physical_qty <= system_qty_at_count and cost_basis is null and positive_value_idr is null
         and basis_reason is null and basis_origin is null)
    or (physical_qty > system_qty_at_count and cost_basis is not null))
);

create function biz.stock_count_guard() returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
 if tg_op <> 'UPDATE' then raise exception 'APPEND_ONLY' using errcode='P0001'; end if;
 if old.state <> 'PENDING' or new.state <> 'APPROVED' or new.version <> old.version+1
   or (new.tenant_id,new.id,new.product_id,new.location_id,new.counted_at,new.entered_at,
       new.ledger_version,new.reason,new.submitted_by) is distinct from
      (old.tenant_id,old.id,old.product_id,old.location_id,old.counted_at,old.entered_at,
       old.ledger_version,old.reason,old.submitted_by) then
   raise exception 'APPEND_ONLY' using errcode='P0001';
 end if;
 return new;
end $$;
revoke execute on function biz.stock_count_guard() from public;
create trigger stock_count_guard before update or delete on biz.stock_count
 for each row execute function biz.stock_count_guard();
create trigger stock_count_no_truncate before truncate on biz.stock_count
 for each statement execute function iam.reject_change();
create trigger stock_count_line_no_change before update or delete on biz.stock_count_line
 for each row execute function iam.reject_change();
create trigger stock_count_line_no_truncate before truncate on biz.stock_count_line
 for each statement execute function iam.reject_change();

grant select,insert,update on biz.stock_count to app_fn_owner;
grant select,insert on biz.stock_count_line to app_fn_owner;
do $$
declare t text;
begin
 foreach t in array array['biz.stock_count','biz.stock_count_line'] loop
   execute format('alter table %s enable row level security',t);
   execute format('alter table %s force row level security',t);
   execute format('create policy app_tenant on %s for all to app_fn_owner using (tenant_id=app.current_tenant()) with check (tenant_id=app.current_tenant())',t);
 end loop;
end $$;

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
  if p_action is null or p_action not in ('inventory.release', 'inventory.move', 'inventory.count.approve') or p_target is null then
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
-- Entitlement dicek di DB, bukan dari input klien.
create function app.count_require_pro(p_tenant uuid) returns void
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
begin
 if not exists (select 1 from platform.subscription s
     where s.tenant_id=p_tenant and s.plan='PRO') then
   raise exception 'FEATURE_GATED_PLAN' using errcode='P0001';
 end if;
end $$;

-- Kuantitas transaksi setelah counted_at pada DIMENSI PERSIS; id ledger dibaca sebagai watermark.
create function app.count_movement_after(p_tenant uuid,p_location uuid,p_product uuid,p_package uuid,
                                          p_batch uuid,p_time timestamptz) returns bigint
language sql stable set search_path=pg_catalog,pg_temp as $$
 select coalesce(sum(l.qty_delta),0)::bigint from biz.inventory_ledger l
  where l.tenant_id=p_tenant and l.location_id=p_location and l.product_id=p_product
    and l.package_version_id=p_package and l.batch_id=p_batch
    and l.status='SALEABLE' and l.event_at>p_time
$$;

create function app.count_create(p_key uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
 a record; p record; v_prev jsonb; v_loc uuid; v_id uuid; v_enter timestamptz:=clock_timestamp();
 v_counted timestamptz; v_ledger bigint; v_lid bigint; v_qty bigint; v_move bigint; v_phys integer;
 v_pkg uuid; v_batch uuid; v_basis text; v_val bigint; v_delta bigint; v_lines int:=0;
 ln jsonb; v_cost jsonb; v_resp jsonb; v_pkgrow record;
begin
 select * into a from iam.current_actor();
 perform app.inv_require_active(a.effective_status);
 perform app.count_require_pro(a.tenant_id);
 if p_body is null or jsonb_typeof(p_body)<>'object'
   or p_body - 'productId' - 'locationId' - 'countedAt' - 'reason' - 'lines'<>'{}'::jsonb
   or jsonb_typeof(p_body->'lines')<>'array'
   or jsonb_array_length(p_body->'lines') not between 1 and 100
   or nullif(btrim(coalesce(p_body->>'reason','')),'') is null then
    raise exception 'VALIDATION' using errcode='P0001';
 end if;
 v_prev:=app.idem_claim(a.tenant_id,'inventory.count',p_key,p_body);
 if v_prev is not null then return v_prev; end if;
 select * into p from biz.product x where x.tenant_id=a.tenant_id and x.id=(p_body->>'productId')::uuid;
 if p.id is null then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
 perform app.inv_lock_product(a.tenant_id,p.id);
 if p.is_subsidized then raise exception 'SUBSIDY_RECEIPT_SEPARATE' using errcode='P0001'; end if;
 v_loc:=app.inv_location(a.tenant_id,p_body);
 v_counted:=(p_body->>'countedAt')::timestamptz;
 if v_counted is null or v_counted>v_enter then raise exception 'VALIDATION' using errcode='P0001'; end if;
 select coalesce(max(id),0) into v_ledger from biz.inventory_ledger
  where tenant_id=a.tenant_id and location_id=v_loc and product_id=p.id;
 insert into biz.stock_count(tenant_id,product_id,location_id,counted_at,entered_at,ledger_version,reason,submitted_by)
 values(a.tenant_id,p.id,v_loc,v_counted,v_enter,v_ledger,btrim(p_body->>'reason'),a.user_id)
 returning id into v_id;
 for ln in select * from jsonb_array_elements(p_body->'lines') loop
   if jsonb_typeof(ln)<>'object'
      or ln - 'packageId' - 'batchId' - 'physicalQty' - 'cost'<>'{}'::jsonb then
      raise exception 'VALIDATION' using errcode='P0001';
   end if;
   v_pkg:=(ln->>'packageId')::uuid;
   v_batch:=(ln->>'batchId')::uuid;
   v_phys:=(ln->>'physicalQty')::integer;
   if v_phys is null or v_phys<0 then raise exception 'VALIDATION' using errcode='P0001'; end if;
   select v.id,v.factor into v_pkgrow from biz.package_version v
     where v.tenant_id=a.tenant_id and v.product_id=p.id and v.id=v_pkg and v.superseded_at is null;
   if v_pkgrow.id is null or not exists (
      select 1 from biz.batch b where b.tenant_id=a.tenant_id and b.product_id=p.id and b.id=v_batch
   ) then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
   select coalesce((select b.qty from biz.stock_balance b
    where b.tenant_id=a.tenant_id and b.location_id=v_loc and b.product_id=p.id
      and b.package_version_id=v_pkg and b.batch_id=v_batch and b.status='SALEABLE'),0) into v_qty;
   v_move:=app.count_movement_after(a.tenant_id,v_loc,p.id,v_pkg,v_batch,v_counted);
   v_qty:=v_qty-v_move;
   if v_qty<0 or v_qty>2147483647 then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
   v_delta:=v_phys-v_qty;
   if app.hold_active(a.tenant_id,v_loc,p.id,v_batch) then raise exception 'HOLD_ACTIVE' using errcode='P0001'; end if;
   select coalesce(max(id),0) into v_lid from biz.inventory_ledger l
    where l.tenant_id=a.tenant_id and l.location_id=v_loc and l.product_id=p.id
      and l.package_version_id=v_pkg and l.batch_id=v_batch and l.status='SALEABLE';
   v_cost:=ln->'cost'; v_basis:=v_cost->>'basis';
   v_val:=case when v_cost ? 'totalIdr' then (v_cost->>'totalIdr')::bigint else null end;
   if v_delta>0 then
     if v_cost is null or jsonb_typeof(v_cost)<>'object'
       or v_cost - 'basis' - 'totalIdr' - 'reason' - 'origin'<>'{}'::jsonb
       or v_basis not in ('KNOWN','BONUS_ZERO','UNVERIFIED')
       or (v_basis='KNOWN' and (v_val is null or v_val<=0))
       or (v_basis in ('BONUS_ZERO','UNVERIFIED') and coalesce(v_val,0)<>0)
       or (v_basis in ('BONUS_ZERO','UNVERIFIED') and nullif(btrim(coalesce(v_cost->>'reason','')),'') is null)
       or (v_basis='BONUS_ZERO' and nullif(btrim(coalesce(v_cost->>'origin','')),'') is null)
       then raise exception 'COST_BASIS_INVALID' using errcode='P0001';
     end if;
   elsif v_cost is not null then raise exception 'VALIDATION' using errcode='P0001';
   end if;
   insert into biz.stock_count_line(tenant_id,count_id,location_id,product_id,package_version_id,batch_id,
      physical_qty,system_qty_at_count,ledger_version,cost_basis,positive_value_idr,basis_reason,basis_origin)
   values (a.tenant_id,v_id,v_loc,p.id,v_pkg,v_batch,v_phys,v_qty::integer,v_lid,
      case when v_delta>0 then v_basis end,case when v_delta>0 then coalesce(v_val,0) end,
      case when v_delta>0 then v_cost->>'reason' end,case when v_delta>0 then v_cost->>'origin' end);
   v_lines:=v_lines+1;
 end loop;
 v_resp:=jsonb_build_object('countId',v_id,'status','PENDING','version',1,
     'countedAt',v_counted,'enteredAt',v_enter,'ledgerVersion',v_ledger,'lines',v_lines);
 perform app.audit(a.tenant_id,a.user_id,'STOCK_COUNT_SUBMITTED','stock_count',v_id,
    jsonb_build_object('countedAt',v_counted,'ledgerVersion',v_ledger,'lines',v_lines));
 return app.idem_finish(a.tenant_id,'inventory.count',p_key,v_resp);
end $$;

create function app.count_list() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a record;
begin
 select * into a from iam.current_actor();
 perform app.count_require_pro(a.tenant_id);
 return jsonb_build_object('items',coalesce((
   select jsonb_agg(jsonb_build_object('id',c.id,'productId',c.product_id,
     'locationId',c.location_id,'countedAt',c.counted_at,'enteredAt',c.entered_at,
     'ledgerVersion',c.ledger_version,'status',c.state,'version',c.version,
     'reason',c.reason,'submittedBy',c.submitted_by,'approvedBy',c.approved_by,
     'lines',coalesce((select jsonb_agg(jsonb_build_object('packageId',l.package_version_id,
      'batchId',l.batch_id,'physicalQty',l.physical_qty,'systemQtyAtCount',l.system_qty_at_count,
      'ledgerVersion',l.ledger_version,'costBasis',l.cost_basis,'positiveValueIdr',l.positive_value_idr)
      order by l.package_version_id,l.batch_id)
      from biz.stock_count_line l where l.tenant_id=c.tenant_id and l.count_id=c.id),'[]'::jsonb))
      order by c.entered_at desc,c.id desc)
     from (select * from biz.stock_count c where c.tenant_id=a.tenant_id
           order by c.entered_at desc,c.id desc limit 100) c),'[]'::jsonb));
end $$;

create function app.count_approve(p_key uuid,p_count uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
 a record; c record; l record; pool record; v_prev jsonb; v_now timestamptz:=clock_timestamp();
 v_v bigint; v_event uuid; v_qty bigint; v_after bigint; v_asof bigint; v_delta bigint;
 v_base bigint; v_value bigint; v_total_base bigint:=0; v_total_value bigint:=0;
 v_moves jsonb:='[]'::jsonb; v_resp jsonb; v_token text; v_rid uuid; v_exp date;
begin
 select * into a from iam.current_actor();
 if a.role<>'OWNER' then raise exception 'FORBIDDEN_ROLE' using errcode='P0001'; end if;
 perform app.inv_require_active(a.effective_status);
 perform app.count_require_pro(a.tenant_id);
 if p_body is null or jsonb_typeof(p_body)<>'object'
    or p_body - 'expectedVersion' - 'reason' - 'referenceDocument' - 'reauthToken'<>'{}'::jsonb
    or nullif(btrim(coalesce(p_body->>'reason','')),'') is null
    or coalesce(p_body->>'reauthToken','') !~ '^[0-9a-f]{64}$' then
   raise exception 'VALIDATION' using errcode='P0001'; end if;
 v_v:=(p_body->>'expectedVersion')::bigint;
 v_prev:=app.idem_claim(a.tenant_id,'inventory.count.approve',p_key,
                        jsonb_build_object('countId',p_count,'body',p_body));
 if v_prev is not null then return v_prev; end if;
 select * into c from biz.stock_count x where x.tenant_id=a.tenant_id and x.id=p_count for update;
 if c.id is null then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
 perform app.inv_lock_product(a.tenant_id,c.product_id);
 if c.version<>v_v or c.state<>'PENDING' then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
 if exists (select 1 from biz.product p where p.tenant_id=a.tenant_id and p.id=c.product_id and p.is_subsidized) then
   raise exception 'SUBSIDY_RECEIPT_SEPARATE' using errcode='P0001'; end if;
 -- Token terikat id dan versi proposal; perubahan proposal atau token operasi lain tidak berlaku.
 v_token:=p_body->>'reauthToken';
 v_rid:=iam.reauth_consume_scope(v_token,'inventory.count.approve',p_count,
                                 jsonb_build_object('expectedVersion',v_v)); -- @kontrol:COUNT_OWNER_APPROVAL
 v_event:=app.inv_event(a.tenant_id,'COUNT_ADJUST',c.product_id,c.location_id,a.user_id,v_now,
                        p_key,'STOCK_COUNT');
 for l in select x.*,v.factor,b.expires_on from biz.stock_count_line x
    join biz.package_version v on v.tenant_id=x.tenant_id and v.product_id=x.product_id and v.id=x.package_version_id
    join biz.batch b on b.tenant_id=x.tenant_id and b.product_id=x.product_id and b.id=x.batch_id
    where x.tenant_id=a.tenant_id and x.count_id=p_count
    order by x.package_version_id,x.batch_id loop
   if app.hold_active(a.tenant_id,c.location_id,c.product_id,l.batch_id) then
      raise exception 'HOLD_ACTIVE' using errcode='P0001'; end if;
   select coalesce((select b.qty from biz.stock_balance b
    where b.tenant_id=a.tenant_id and b.location_id=c.location_id and b.product_id=c.product_id
      and b.package_version_id=l.package_version_id and b.batch_id=l.batch_id and b.status='SALEABLE'),0) into v_qty;
   v_after:=app.count_movement_after(a.tenant_id,c.location_id,c.product_id,l.package_version_id,l.batch_id,c.counted_at);
   v_asof:=v_qty-v_after;
   if v_asof<>l.system_qty_at_count then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
   v_delta:=l.physical_qty-v_asof;
   -- Target akhir = hasil hitung fisik + SELURUH pergerakan sesudah waktu hitung.
   if (v_qty+v_delta)<0 or (v_qty+v_delta)>2147483647 then
     raise exception 'INSUFFICIENT_STOCK' using errcode='P0001'; end if;
   if v_delta>0 and l.expires_on is not null and l.expires_on<app.tenant_today(a.tenant_id) then
     raise exception 'BATCH_EXPIRED' using errcode='P0001'; end if;
   if v_delta=0 then continue; end if;
   v_base:=abs(v_delta)*l.factor;
   if v_delta<0 then
     select * into pool from biz.cost_pool x where x.tenant_id=a.tenant_id
       and x.location_id=c.location_id and x.product_id=c.product_id and x.status='SALEABLE'
       for update;
     if pool.qty_base is null or pool.qty_base<v_base then
        raise exception 'INVENTORY_INCONSISTENT' using errcode='P0001'; end if;
     v_value:=app.cost_take(pool.value_idr,pool.qty_base,v_base);
     update biz.cost_pool x set qty_base=x.qty_base-v_base,value_idr=x.value_idr-v_value,version=x.version+1
       where x.tenant_id=a.tenant_id and x.location_id=c.location_id and x.product_id=c.product_id and x.status='SALEABLE';
     insert into biz.value_ledger(tenant_id,event_id,location_id,product_id,status,qty_base_delta,
       value_delta,cost_basis,actor_user_id,event_at)
     values(a.tenant_id,v_event,c.location_id,c.product_id,'SALEABLE',-v_base,-v_value,'ADJUST',a.user_id,v_now);
   else
     v_value:=coalesce(l.positive_value_idr,0);
     perform app.pool_add(a.tenant_id,v_event,c.location_id,c.product_id,'SALEABLE',v_base,v_value,
             l.cost_basis,l.basis_reason,l.basis_origin,a.user_id,v_now);
   end if;
   perform app.stock_post(a.tenant_id,v_event,'COUNT_ADJUST',c.location_id,c.product_id,
        l.package_version_id,l.batch_id,'SALEABLE',v_delta::integer,l.factor,a.user_id,v_now);
   v_total_base:=v_total_base+v_delta*l.factor;
   v_total_value:=v_total_value+case when v_delta>0 then v_value else -v_value end;
   v_moves:=v_moves||jsonb_build_array(jsonb_build_object('packageId',l.package_version_id,
       'batchId',l.batch_id,'qtyDelta',v_delta,'valueDeltaIdr',case when v_delta>0 then v_value else -v_value end,
       'countedAt',c.counted_at,'systemQtyAtCount',v_asof,'afterCountMovement',v_after));
 end loop;
 update biz.stock_count x set state='APPROVED',version=x.version+1,approved_by=a.user_id,
    approved_at=v_now,approval_reason=btrim(p_body->>'reason'),
    approval_document=p_body->>'referenceDocument',approval_event_id=v_event
  where x.tenant_id=a.tenant_id and x.id=p_count;
 perform app.audit(a.tenant_id,a.user_id,'STOCK_COUNT_APPROVED','stock_count',p_count,
  jsonb_build_object('reauthGrantId',v_rid,'countedAt',c.counted_at,'enteredAt',c.entered_at,
   'ledgerVersionAtEntry',c.ledger_version,'qtyBaseDelta',v_total_base,'valueDeltaIdr',v_total_value,
   'moves',v_moves,'reason',p_body->>'reason','referenceDocument',p_body->>'referenceDocument'));
 v_resp:=jsonb_build_object('countId',p_count,'status','APPROVED','version',c.version+1,
   'eventId',v_event,'qtyBaseDelta',v_total_base,'valueDeltaIdr',v_total_value,'moves',v_moves);
 return app.idem_finish(a.tenant_id,'inventory.count.approve',p_key,v_resp);
end $$;

reset role;
-- Hak bawaan PUBLIC atas helper baru juga harus dicabut; runtime hanya memakai tiga fungsi publik yang ditetapkan.
revoke execute on all functions in schema app from public;
revoke execute on function app.count_create(uuid,jsonb),app.count_list(),app.count_approve(uuid,uuid,jsonb)
 from public;
grant execute on function app.count_create(uuid,jsonb),app.count_list(),app.count_approve(uuid,uuid,jsonb)
 to app_runtime;
