-- Checkout eceran tunai. Sale, baris, dan penerimaan kas dicatat sekali dalam transaksi yang sama.
set role migration_owner;

alter table biz.inventory_event drop constraint inventory_event_kind_check;
alter table biz.inventory_event add constraint inventory_event_kind_check
  check (kind in ('OPENING','RECEIPT','OPEN_PACKAGE','STATUS_MOVE','HOLD','RELEASE','COUNT_ADJUST','SALE'));
alter table biz.inventory_ledger drop constraint inventory_ledger_movement_check;
alter table biz.inventory_ledger add constraint inventory_ledger_movement_check
  check (movement in ('OPENING','RECEIPT','OPEN_PACKAGE','STATUS_MOVE','HOLD','RELEASE','COUNT_ADJUST','SALE'));
alter table biz.inventory_ledger add constraint inventory_ledger_sale_negative
  check (movement <> 'SALE' or (status = 'SALEABLE' and qty_delta < 0 and qty_base_delta < 0));
alter table biz.value_ledger drop constraint value_ledger_cost_basis_check;
alter table biz.value_ledger add constraint value_ledger_cost_basis_check
  check (cost_basis in ('KNOWN','BONUS_ZERO','UNVERIFIED','MOVE','ADJUST','SALE'));
alter table biz.idempotency drop constraint idempotency_operation_check;
alter table biz.idempotency add constraint idempotency_operation_check
  check (operation in ('product.create','inventory.receipt','inventory.open','inventory.move',
    'inventory.hold','inventory.release','inventory.count','inventory.count.approve',
    'price.request','price.approve','price.reject','sale.create'));

create table biz.sale (
  tenant_id uuid not null,
  id uuid not null default pg_catalog.gen_random_uuid(),
  location_id uuid not null,
  document_seq bigint not null check (document_seq > 0),
  business_day date not null,
  finalized_at timestamptz not null,
  actor_user_id uuid not null references iam.user_account(id),
  idempotency_key uuid not null,
  total_idr bigint not null check (total_idr >= 0),
  primary key (tenant_id,id),
  unique (tenant_id,document_seq),
  unique (tenant_id,idempotency_key),
  unique (tenant_id,id,location_id),
  unique (tenant_id,id,total_idr),
  foreign key (tenant_id,location_id) references platform.location(tenant_id,id)
);

alter table biz.price_rule_version add constraint price_rule_sale_snapshot_key
  unique (tenant_id,product_id,package_version_id,id,price_idr);

create table biz.sale_line (
  tenant_id uuid not null,
  sale_id uuid not null,
  line_no integer not null check (line_no > 0),
  location_id uuid not null,
  product_id uuid not null,
  package_version_id uuid not null,
  batch_id uuid not null,
  price_rule_id uuid not null,
  inventory_event_id uuid not null,
  sku text not null,
  product_name text not null,
  package_label text not null,
  package_factor integer not null check (package_factor > 0),
  batch_number text,
  expires_on date,
  quantity integer not null check (quantity > 0),
  unit_price_idr bigint not null check (unit_price_idr >= 0),
  gross_idr bigint not null check (gross_idr = quantity::numeric * unit_price_idr),
  cost_snapshot_idr bigint not null check (cost_snapshot_idr >= 0),
  cost_verified boolean not null,
  primary key (tenant_id,sale_id,line_no),
  unique (tenant_id,inventory_event_id),
  foreign key (tenant_id,sale_id,location_id) references biz.sale(tenant_id,id,location_id),
  foreign key (tenant_id,product_id,package_version_id) references biz.package_version(tenant_id,product_id,id),
  foreign key (tenant_id,product_id,batch_id) references biz.batch(tenant_id,product_id,id),
  foreign key (tenant_id,product_id,package_version_id,price_rule_id,unit_price_idr)
    references biz.price_rule_version(tenant_id,product_id,package_version_id,id,price_idr),
  foreign key (tenant_id,inventory_event_id,product_id,location_id)
    references biz.inventory_event(tenant_id,id,product_id,location_id)
);

create table biz.payment (
  tenant_id uuid not null,
  id uuid not null default pg_catalog.gen_random_uuid(),
  sale_id uuid not null,
  method text not null check (method = 'CASH'),
  gross_cash_tendered bigint not null check (gross_cash_tendered >= 0),
  change_idr bigint not null check (change_idr >= 0),
  net_received_idr bigint not null check (net_received_idr >= 0 and
    net_received_idr = gross_cash_tendered - change_idr),
  verified_by uuid not null references iam.user_account(id),
  verified_at timestamptz not null,
  primary key (tenant_id,id),
  unique (tenant_id,sale_id),
  foreign key (tenant_id,sale_id,net_received_idr) references biz.sale(tenant_id,id,total_idr)
);

do $$
declare v_table text;
begin
  foreach v_table in array array['sale','sale_line','payment'] loop
    execute format('alter table biz.%I enable row level security',v_table);
    execute format('alter table biz.%I force row level security',v_table);
    execute format('create policy sale_tenant on biz.%I for all to app_fn_owner using (tenant_id=app.current_tenant()) with check (tenant_id=app.current_tenant())',v_table);
    execute format('grant select, insert on biz.%I to app_fn_owner',v_table);
    execute format('create trigger sale_append_only before update or delete on biz.%I for each row execute function iam.reject_change()',v_table);
    execute format('create trigger sale_no_truncate before truncate on biz.%I for each statement execute function iam.reject_change()',v_table);
  end loop;
end $$;

reset role;
set role app_fn_owner;

create function app.sale_validate_lines(p_lines jsonb, p_final boolean) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_line jsonb; v_field text;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
  if jsonb_array_length(p_lines) not between 1 and 50 then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or v_line - 'product_id' - 'package_version_id' - 'batch_id' - 'quantity'
          - 'quote_version' <> '{}'::jsonb
       or (not p_final and v_line ? 'quote_version')
       or jsonb_typeof(v_line->'quantity') is distinct from 'number'
       or coalesce(v_line->>'quantity','') !~ '^[1-9][0-9]{0,6}$'
       or (p_final and (jsonb_typeof(v_line->'quote_version') is distinct from 'string'
         or coalesce(v_line->>'quote_version','') !~ '^[0-9a-f]{64}$'))
    then raise exception 'VALIDATION' using errcode='P0001'; end if;
    foreach v_field in array array['product_id','package_version_id','batch_id'] loop
      if jsonb_typeof(v_line->v_field) is distinct from 'string'
         or coalesce(v_line->>v_field,'') !~* v_uuid then
        raise exception 'VALIDATION' using errcode='P0001';
      end if;
    end loop;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_lines) l
    group by (l->>'product_id')::uuid,(l->>'package_version_id')::uuid,(l->>'batch_id')::uuid
    having count(*) > 1) then raise exception 'VALIDATION' using errcode='P0001'; end if;
end $$;

-- Dipanggil oleh pratinjau dan finalisasi. Finalisasi sudah memegang kunci produk.
create function app.sale_price_lines(p_tenant uuid,p_location uuid,p_lines jsonb)
returns table (
  line_no integer, product_id uuid, package_id uuid, batch_id uuid, qty integer,
  sku text, product_name text, product_version bigint, package_label text, factor integer,
  batch_number text, expires_on date, price_id uuid, unit_price_idr bigint,
  gross_idr numeric, quote_version text
) language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v_line record; v record; v_stock record; v_today date := app.tenant_today(p_tenant);
begin
  for v_line in select value as body, ordinality as n from jsonb_array_elements(p_lines) with ordinality loop
    line_no := v_line.n::integer;
    product_id := (v_line.body->>'product_id')::uuid;
    package_id := (v_line.body->>'package_version_id')::uuid;
    batch_id := (v_line.body->>'batch_id')::uuid;
    qty := (v_line.body->>'quantity')::integer;
    select p.sku,p.name,p.version,p.is_active,p.is_subsidized,pkg.label,pkg.factor,
           bt.batch_number,bt.expires_on,current_price.id,current_price.price_idr
      into v
      from biz.product p
      join biz.package_version pkg on pkg.tenant_id=p.tenant_id and pkg.product_id=p.id
        and pkg.id=package_id and pkg.superseded_at is null
      join biz.batch bt on bt.tenant_id=p.tenant_id and bt.product_id=p.id and bt.id=sale_price_lines.batch_id
      left join lateral (
        select r.id,r.price_idr from biz.price_rule_version r
        where r.tenant_id=p.tenant_id and r.product_id=p.id and r.package_version_id=pkg.id
        order by r.approved_at desc,r.id desc limit 1
      ) current_price on true
      where p.tenant_id=p_tenant and p.id=sale_price_lines.product_id;
    if not found then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
    if v.is_subsidized then raise exception 'SUBSIDY_PRICE_SEPARATE' using errcode='P0001'; end if;
    if not v.is_active then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
    if v.expires_on < v_today then raise exception 'SALE_BATCH_EXPIRED' using errcode='P0001'; end if;
    if app.hold_active(p_tenant,p_location,product_id,batch_id) then
      raise exception 'HOLD_ACTIVE' using errcode='P0001';
    end if;
    select b.qty,b.version into v_stock from biz.stock_balance b
      where b.tenant_id=p_tenant and b.location_id=p_location and b.product_id=sale_price_lines.product_id
        and b.package_version_id=package_id and b.batch_id=sale_price_lines.batch_id and b.status='SALEABLE';
    if coalesce(v_stock.qty,0) < qty then raise exception 'INSUFFICIENT_STOCK' using errcode='P0001'; end if;
    if v.id is null then raise exception 'SALE_PRICE_MISSING' using errcode='P0001'; end if;

    sku := v.sku; product_name := v.name; product_version := v.version;
    package_label := v.label; factor := v.factor; batch_number := v.batch_number; expires_on := v.expires_on;
    price_id := v.id; unit_price_idr := v.price_idr; gross_idr := qty::numeric * unit_price_idr;
    if gross_idr > 9223372036854775807 then raise exception 'SALE_TOTAL_LIMIT' using errcode='P0001'; end if;
    quote_version := encode(sha256(convert_to(jsonb_build_array(p_tenant,p_location,
      product_id,package_id,batch_id,qty,price_id,product_version,v_stock.version)::text,'UTF8')),'hex');
    return next;
  end loop;
end $$;

create function app.sale_quote(p_body jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_location uuid; v_total numeric; v_lines jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if jsonb_typeof(p_body) is distinct from 'object' or p_body - 'lines' <> '{}'::jsonb then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
  perform app.sale_validate_lines(p_body->'lines',false);
  v_location := app.inv_location(a.tenant_id,'{}'::jsonb);
  select sum(s.gross_idr),jsonb_agg(jsonb_build_object(
    'product_id',s.product_id,'package_version_id',s.package_id,'batch_id',s.batch_id,
    'quantity',s.qty,'quote_version',s.quote_version,'unit_price_idr',s.unit_price_idr::text,
    'gross_idr',s.gross_idr::text
  ) order by s.line_no) into v_total,v_lines
  from app.sale_price_lines(a.tenant_id,v_location,p_body->'lines') s;
  if v_total > 9223372036854775807 then raise exception 'SALE_TOTAL_LIMIT' using errcode='P0001'; end if;
  return jsonb_build_object('grand_total_idr',v_total::text,'lines',v_lines);
end $$;

create function app.sale_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_sale jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  select jsonb_build_object(
    'sale_id',s.id,'receipt_number',s.document_seq::text,'business_day',s.business_day,
    'finalized_at',s.finalized_at,'grand_total_idr',s.total_idr::text,'version',1,
    'payment',jsonb_build_object('method',p.method,'tendered_idr',p.gross_cash_tendered::text,
      'change_idr',p.change_idr::text,'net_received_idr',p.net_received_idr::text),
    'lines',(select jsonb_agg(jsonb_build_object('product_id',l.product_id,'sku',l.sku,'product_name',l.product_name,
      'package_version_id',l.package_version_id,'package_label',l.package_label,'package_factor',l.package_factor,
      'batch_id',l.batch_id,'batch_number',l.batch_number,'expires_on',l.expires_on,'quantity',l.quantity,
      'unit_price_idr',l.unit_price_idr::text,'gross_idr',l.gross_idr::text,
      'cost_snapshot_idr',case when l.cost_verified then l.cost_snapshot_idr::text end,'cost_verified',l.cost_verified)
      order by l.line_no) from biz.sale_line l where l.tenant_id=s.tenant_id and l.sale_id=s.id)
  ) into v_sale
  from biz.sale s join biz.payment p on p.tenant_id=s.tenant_id and p.sale_id=s.id
  where s.tenant_id=a.tenant_id and s.id=p_id;
  if not found then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
  return v_sale;
end $$;

create function app.sale_operation(p_key uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_response jsonb;
begin
  select * into a from iam.current_actor();
  -- Hanya status transaksi yang sudah commit, termasuk bila paket berakhir setelah pembayaran.
  select i.response into v_response from biz.idempotency i
    where i.tenant_id=a.tenant_id and i.operation='sale.create' and i.key=p_key;
  if v_response is null then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
  return v_response;
end $$;

-- Pemeriksaan tambahan di akhir transaksi. Trigger ini tidak membuktikan waktu commit literal.
create function app.sale_commit_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a record;
begin
  select * into a from iam.current_actor();
  if a.tenant_id is distinct from new.tenant_id or a.user_id is distinct from new.actor_user_id
     or a.effective_status is distinct from 'ACTIVE'
     or a.expires_at <= clock_timestamp() + interval '5 seconds'
  then raise exception 'TENANT_LOCKED' using errcode='P0001'; end if;
  if new.business_day <> app.tenant_today(new.tenant_id) then
    raise exception 'SALE_QUOTE_CHANGED' using errcode='P0001';
  end if;
  return null;
end $$;

create function app.sale_create(p_key uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_payment jsonb; v_product uuid; v_location uuid; v_sale uuid; v_event uuid;
  v_lines jsonb; v_line record; v_pool record; v_tendered numeric; v_change numeric; v_net numeric; v_total numeric;
  v_seq bigint; v_base bigint; v_hpp bigint; v_at timestamptz; v_day date;
  v_expires timestamptz; v_response jsonb;
begin
  select * into a from iam.current_actor();
  if p_key is null or jsonb_typeof(p_body) is distinct from 'object'
     or p_body - 'customer_id' - 'lines' - 'payments' <> '{}'::jsonb
     or (p_body ? 'customer_id' and p_body->'customer_id' <> 'null'::jsonb)
     or jsonb_typeof(p_body->'payments') is distinct from 'array'
  then raise exception 'VALIDATION' using errcode='P0001'; end if;
  if jsonb_array_length(p_body->'payments') <> 1 then raise exception 'VALIDATION' using errcode='P0001'; end if;
  v_payment := p_body->'payments'->0;
  if jsonb_typeof(v_payment) is distinct from 'object'
     or v_payment - 'method' - 'tendered_idr' - 'change_idr' - 'net_received_idr' <> '{}'::jsonb
     or v_payment->>'method' is distinct from 'CASH'
     or jsonb_typeof(v_payment->'tendered_idr') is distinct from 'string'
     or jsonb_typeof(v_payment->'change_idr') is distinct from 'string'
     or jsonb_typeof(v_payment->'net_received_idr') is distinct from 'string'
     or coalesce(v_payment->>'tendered_idr','') !~ '^(0|[1-9][0-9]{0,18})$'
     or coalesce(v_payment->>'change_idr','') !~ '^(0|[1-9][0-9]{0,18})$'
     or coalesce(v_payment->>'net_received_idr','') !~ '^(0|[1-9][0-9]{0,18})$'
  then raise exception 'VALIDATION' using errcode='P0001'; end if;
  v_tendered := (v_payment->>'tendered_idr')::numeric;
  v_change := (v_payment->>'change_idr')::numeric;
  v_net := (v_payment->>'net_received_idr')::numeric;
  if greatest(v_tendered,v_change,v_net) > 9223372036854775807 then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
  perform app.sale_validate_lines(p_body->'lines',true);

  v_response := app.idem_claim(a.tenant_id,'sale.create',p_key,p_body);
  if v_response is not null then return v_response; end if;
  perform app.inv_require_active(a.effective_status);
  -- Semua checkout satu toko diserialkan oleh kunci langganan sebelum kunci produk.
  select sub.expires_at into v_expires from platform.subscription sub
    where sub.tenant_id=a.tenant_id for update;
  if not found then raise exception 'TENANT_LOCKED' using errcode='P0001'; end if;
  v_location := app.inv_location(a.tenant_id,'{}'::jsonb);
  for v_product in select distinct (l->>'product_id')::uuid from jsonb_array_elements(p_body->'lines') l order by 1 loop
    perform app.inv_lock_product(a.tenant_id,v_product);
  end loop;
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  -- Batas konservatif sebelum posting. Pembuktian timestamp commit literal tetap T-06c.
  if v_expires <= clock_timestamp() + interval '5 seconds' then
    raise exception 'TENANT_LOCKED' using errcode='P0001';
  end if;
  v_day := app.tenant_today(a.tenant_id);
  select sum(s.gross_idr),jsonb_agg(to_jsonb(s) order by s.line_no)
    into v_total,v_lines from app.sale_price_lines(a.tenant_id,v_location,p_body->'lines') s;
  if v_total > 9223372036854775807 then raise exception 'SALE_TOTAL_LIMIT' using errcode='P0001'; end if;

  for v_line in select l.value->>'quote_version' as quote_version,l.ordinality as n
    from jsonb_array_elements(v_lines) with ordinality l
  loop
    if v_line.quote_version <> p_body->'lines'->((v_line.n-1)::integer)->>'quote_version' then
      raise exception 'SALE_QUOTE_CHANGED' using errcode='P0001';
    end if;
  end loop;
  if v_net <> v_total or v_tendered-v_change <> v_net then
    raise exception 'SALE_CASH_MISMATCH' using errcode='P0001';
  end if;
  v_at := clock_timestamp();
  select coalesce(max(s.document_seq),0)+1 into v_seq from biz.sale s where s.tenant_id=a.tenant_id;
  insert into biz.sale (tenant_id,location_id,document_seq,business_day,finalized_at,actor_user_id,idempotency_key,total_idr)
    values (a.tenant_id,v_location,v_seq,v_day,v_at,a.user_id,p_key,v_total::bigint) returning id into v_sale;

  for v_line in select * from jsonb_to_recordset(v_lines) as l(
    line_no integer, product_id uuid, package_id uuid, batch_id uuid, qty integer,
    sku text, product_name text, package_label text, factor integer, batch_number text, expires_on date,
    price_id uuid, unit_price_idr bigint, gross_idr bigint
  ) order by line_no loop
    v_event := app.inv_event(a.tenant_id,'SALE',v_line.product_id,v_location,a.user_id,v_at,p_key,null);
    perform app.stock_post(a.tenant_id,v_event,'SALE',v_location,v_line.product_id,v_line.package_id,
      v_line.batch_id,'SALEABLE',-v_line.qty,v_line.factor,a.user_id,v_at);
    v_base := v_line.qty::bigint * v_line.factor;
    select c.qty_base,c.value_idr,c.unverified into v_pool from biz.cost_pool c
      where c.tenant_id=a.tenant_id and c.location_id=v_location and c.product_id=v_line.product_id and c.status='SALEABLE'
      for update;
    if not found or v_pool.qty_base < v_base then raise exception 'INVENTORY_INCONSISTENT' using errcode='P0001'; end if;
    v_hpp := app.cost_take(v_pool.value_idr,v_pool.qty_base,v_base);
    update biz.cost_pool c set qty_base=c.qty_base-v_base,value_idr=c.value_idr-v_hpp,
      version=c.version+1,unverified=c.unverified and c.qty_base>v_base
      where c.tenant_id=a.tenant_id and c.location_id=v_location and c.product_id=v_line.product_id and c.status='SALEABLE';
    insert into biz.value_ledger (tenant_id,event_id,location_id,product_id,status,qty_base_delta,value_delta,
      cost_basis,actor_user_id,event_at)
      values (a.tenant_id,v_event,v_location,v_line.product_id,'SALEABLE',-v_base,-v_hpp,'SALE',a.user_id,v_at);
    insert into biz.sale_line (tenant_id,sale_id,line_no,location_id,product_id,package_version_id,batch_id,price_rule_id,
      inventory_event_id,sku,product_name,package_label,package_factor,batch_number,expires_on,quantity,unit_price_idr,
      gross_idr,cost_snapshot_idr,cost_verified)
      values (a.tenant_id,v_sale,v_line.line_no,v_location,v_line.product_id,v_line.package_id,v_line.batch_id,
        v_line.price_id,v_event,v_line.sku,v_line.product_name,v_line.package_label,v_line.factor,v_line.batch_number,
        v_line.expires_on,v_line.qty,v_line.unit_price_idr,v_line.gross_idr,v_hpp,not v_pool.unverified);
  end loop;

  insert into biz.payment (tenant_id,sale_id,method,gross_cash_tendered,change_idr,net_received_idr,verified_by,verified_at)
    values (a.tenant_id,v_sale,'CASH',v_tendered::bigint,v_change::bigint,v_net::bigint,a.user_id,v_at);
  perform app.audit(a.tenant_id,a.user_id,'SALE_FINAL','sale',v_sale,jsonb_build_object('receipt_number',v_seq::text));
  v_response := app.idem_finish(a.tenant_id,'sale.create',p_key,jsonb_build_object(
    'sale_id',v_sale,'receipt_number',v_seq::text,'grand_total_idr',v_total::text,
    'cash_change_idr',v_change::text,'version',1,'replayed',false));
  if v_day <> app.tenant_today(a.tenant_id) then raise exception 'SALE_QUOTE_CHANGED' using errcode='P0001'; end if;
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if v_expires <= clock_timestamp() + interval '5 seconds' then
    raise exception 'TENANT_LOCKED' using errcode='P0001';
  end if;
  return v_response;
end $$;

grant execute on function app.sale_commit_guard() to migration_owner;
reset role;

set role migration_owner;
create constraint trigger sale_commit_guard after insert on biz.sale
  deferrable initially deferred for each row execute function app.sale_commit_guard();
reset role;

grant execute on function app.sale_quote(jsonb),app.sale_create(uuid,jsonb),app.sale_get(uuid),app.sale_operation(uuid) to app_runtime;
