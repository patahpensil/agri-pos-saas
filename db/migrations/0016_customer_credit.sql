-- Registered customers, credit (tempo/partial) checkout, and settlement of an outstanding invoice.
-- Settlement adds money to the selected invoice only: no new Sale, no revenue, no stock movement.
set role migration_owner;

alter table biz.idempotency drop constraint idempotency_operation_check;
alter table biz.idempotency add constraint idempotency_operation_check
  check (operation in ('product.create','inventory.receipt','inventory.open','inventory.move',
    'inventory.hold','inventory.release','inventory.count','inventory.count.approve',
    'price.request','price.approve','price.reject','sale.create','customer.create','receivable.pay'));

create table biz.customer (
  tenant_id uuid not null references platform.tenant(id),
  id uuid not null default pg_catalog.gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 80
    and display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  phone_e164 text check (phone_e164 ~ '^\+62[1-9][0-9]{7,12}$'),
  address text check (address is null or (char_length(address) between 1 and 200
    and address = btrim(address) and address !~ '[[:cntrl:]]')),
  created_by uuid not null references iam.user_account(id),
  created_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  primary key (tenant_id,id)
);
-- One farmer, one record: a second record with the same number would split the debt.
create unique index customer_phone_unique on biz.customer (tenant_id,phone_e164) where phone_e164 is not null;

alter table biz.sale add column customer_id uuid;
alter table biz.sale add column due_on date;
alter table biz.sale add column credit_idr bigint not null default 0;
alter table biz.sale add constraint sale_customer_fkey foreign key (tenant_id,customer_id) references biz.customer(tenant_id,id);
alter table biz.sale add constraint sale_credit_check check (
  credit_idr >= 0 and credit_idr <= total_idr
  and ((credit_idr = 0 and due_on is null)
    or (credit_idr > 0 and customer_id is not null and due_on is not null and due_on >= business_day)));

create table biz.receivable_payment (
  tenant_id uuid not null,
  id uuid not null default pg_catalog.gen_random_uuid(),
  sale_id uuid not null,
  document_seq bigint not null check (document_seq > 0),
  business_day date not null,
  paid_at timestamptz not null,
  actor_user_id uuid not null references iam.user_account(id),
  idempotency_key uuid not null,
  amount_idr bigint not null check (amount_idr > 0),
  primary key (tenant_id,id),
  unique (tenant_id,document_seq),
  unique (tenant_id,idempotency_key),
  unique (tenant_id,id,sale_id),
  foreign key (tenant_id,sale_id) references biz.sale(tenant_id,id)
);

alter table biz.payment add column settlement_id uuid;
alter table biz.payment add constraint payment_settlement_fkey
  foreign key (tenant_id,settlement_id,sale_id) references biz.receivable_payment(tenant_id,id,sale_id);
alter table biz.payment drop constraint payment_part_unique;
create unique index payment_part_unique on biz.payment (tenant_id,sale_id,settlement_id,part_no) nulls not distinct;
drop index biz.payment_one_cash_part;
create unique index payment_one_cash_part on biz.payment (tenant_id,sale_id,settlement_id) nulls not distinct
  where method = 'CASH';

-- Projection of the invoice equation B = F + C - R - (P - Rf). Updated only by posting functions.
create table biz.invoice_state (
  tenant_id uuid not null,
  sale_id uuid not null,
  customer_id uuid,
  due_on date,
  f_idr bigint not null check (f_idr >= 0),
  c_idr bigint not null default 0,
  r_idr bigint not null default 0 check (r_idr >= 0),
  p_idr bigint not null check (p_idr >= 0),
  rf_idr bigint not null default 0 check (rf_idr >= 0),
  q_pending_idr bigint not null default 0 check (q_pending_idr >= 0),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null,
  primary key (tenant_id,sale_id),
  foreign key (tenant_id,sale_id) references biz.sale(tenant_id,id),
  foreign key (tenant_id,customer_id) references biz.customer(tenant_id,id),
  check (q_pending_idr <= greatest(-(f_idr::numeric + c_idr - r_idr - (p_idr - rf_idr)),0))
);

do $$
declare v_table text;
begin
  foreach v_table in array array['customer','receivable_payment','invoice_state'] loop
    execute format('alter table biz.%I enable row level security',v_table);
    execute format('alter table biz.%I force row level security',v_table);
    execute format('create policy credit_tenant on biz.%I for all to app_fn_owner using (tenant_id=app.current_tenant()) with check (tenant_id=app.current_tenant())',v_table);
    execute format('grant select, insert on biz.%I to app_fn_owner',v_table);
    execute format('create trigger credit_no_truncate before truncate on biz.%I for each statement execute function iam.reject_change()',v_table);
  end loop;
  foreach v_table in array array['customer','receivable_payment'] loop
    execute format('create trigger credit_append_only before update or delete on biz.%I for each row execute function iam.reject_change()',v_table);
  end loop;
end $$;
grant update (p_idr,version,updated_at) on biz.invoice_state to app_fn_owner;
create trigger invoice_state_no_delete before delete on biz.invoice_state
  for each row execute function iam.reject_change();

reset role;
set role app_fn_owner;

create function app.mask_phone(p_phone text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_phone is null then null
    else left(p_phone,6) || repeat('*',char_length(p_phone)-10) || right(p_phone,4) end
$$;

create function app.text_field_ok(p_value jsonb, p_max integer, p_required boolean) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_value is null or p_value = 'null'::jsonb then not p_required
    when jsonb_typeof(p_value) <> 'string' then false
    else char_length(p_value#>>'{}') between 1 and p_max and p_value#>>'{}' = btrim(p_value#>>'{}')
      and p_value#>>'{}' !~ '[[:cntrl:]]' end
$$;

create function app.customer_view(p_tenant uuid,p_id uuid) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('customer_id',c.id,'display_name',c.display_name,
    'phone_masked',app.mask_phone(c.phone_e164),'address',c.address,'version',c.version,
    'open_receivable_idr',(select coalesce(sum(greatest(i.f_idr::numeric+i.c_idr-i.r_idr-(i.p_idr-i.rf_idr),0)),0)::text
      from biz.invoice_state i where i.tenant_id=c.tenant_id and i.customer_id=c.id))
  from biz.customer c where c.tenant_id=p_tenant and c.id=p_id
$$;

create function app.customer_create(p_key uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_id uuid; v_response jsonb;
begin
  select * into a from iam.current_actor();
  if p_key is null or jsonb_typeof(p_body) is distinct from 'object'
     or p_body - 'display_name' - 'phone' - 'address' <> '{}'::jsonb
     or not app.text_field_ok(p_body->'display_name',80,true)
     or not app.text_field_ok(p_body->'address',200,false)
     or (p_body->'phone' is not null and p_body->'phone' <> 'null'::jsonb
       and (jsonb_typeof(p_body->'phone') <> 'string' or p_body->>'phone' !~ '^\+62[1-9][0-9]{7,12}$'))
  then raise exception 'VALIDATION' using errcode='P0001'; end if;
  v_response := app.idem_claim(a.tenant_id,'customer.create',p_key,p_body);
  if v_response is not null then return v_response; end if;
  perform app.inv_require_active(a.effective_status);
  begin
    insert into biz.customer (tenant_id,display_name,phone_e164,address,created_by,created_at)
      values (a.tenant_id,p_body->>'display_name',nullif(p_body->>'phone',''),p_body->>'address',a.user_id,clock_timestamp())
      returning id into v_id;
  exception when unique_violation then
    raise exception 'CUSTOMER_PHONE_DUPLICATE' using errcode='P0001';
  end;
  perform app.audit(a.tenant_id,a.user_id,'CUSTOMER_CREATED','customer',v_id,'{}'::jsonb);
  return app.idem_finish(a.tenant_id,'customer.create',p_key,
    app.customer_view(a.tenant_id,v_id) || '{"replayed": false}'::jsonb);
end $$;

create function app.customer_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  v := app.customer_view(a.tenant_id,p_id);
  if v is null then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
  return v;
end $$;

create function app.customer_list(p_search text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if p_search is not null and (char_length(p_search) not between 1 and 80 or p_search ~ '[[:cntrl:]]') then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
  select coalesce(jsonb_agg(app.customer_view(a.tenant_id,c.id) order by c.display_name,c.id),'[]'::jsonb) into v
  from (select c.tenant_id,c.id,c.display_name from biz.customer c
    where c.tenant_id=a.tenant_id
      and (p_search is null or strpos(lower(c.display_name),lower(p_search)) > 0)
    order by c.display_name,c.id limit 50) c;
  return v;
end $$;

-- Shape check of payment parts; an empty list is allowed only for a credit checkout.
create or replace function app.sale_validate_payments(p_payments jsonb) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_part jsonb; v_field text;
  v_amount constant text := '^(0|[1-9][0-9]{0,18})$';
begin
  if jsonb_typeof(p_payments) is distinct from 'array'
     or jsonb_array_length(p_payments) > 4 then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
  for v_part in select value from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_part) is distinct from 'object' then raise exception 'VALIDATION' using errcode='P0001'; end if;
    if v_part->>'method' = 'CASH' then
      if v_part - 'method' - 'tendered_idr' - 'change_idr' - 'net_received_idr' <> '{}'::jsonb then
        raise exception 'VALIDATION' using errcode='P0001';
      end if;
      foreach v_field in array array['tendered_idr','change_idr','net_received_idr'] loop
        if jsonb_typeof(v_part->v_field) is distinct from 'string' or coalesce(v_part->>v_field,'') !~ v_amount then
          raise exception 'VALIDATION' using errcode='P0001';
        end if;
      end loop;
      if greatest((v_part->>'tendered_idr')::numeric,(v_part->>'change_idr')::numeric) > 9223372036854775807 then
        raise exception 'VALIDATION' using errcode='P0001';
      end if;
    elsif v_part->>'method' in ('TRANSFER','QRIS','EDC') then
      if v_part - 'method' - 'net_received_idr' - 'reference' - 'proof_checked' <> '{}'::jsonb
         or jsonb_typeof(v_part->'net_received_idr') is distinct from 'string'
         or coalesce(v_part->>'net_received_idr','') !~ v_amount
         or jsonb_typeof(v_part->'proof_checked') is distinct from 'boolean'
         or not app.text_field_ok(v_part->'reference',64,false)
      then raise exception 'VALIDATION' using errcode='P0001'; end if;
    else
      raise exception 'VALIDATION' using errcode='P0001';
    end if;
    if (v_part->>'net_received_idr')::numeric > 9223372036854775807 then
      raise exception 'VALIDATION' using errcode='P0001';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_payments) p where p->>'method' = 'CASH') > 1 then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
end $$;

-- Checks every part and returns the money actually kept by the store. Raises on bad arithmetic.
create function app.payment_parts_total(p_payments jsonb) returns numeric
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_part jsonb; v_paid numeric := 0; v_parts integer := jsonb_array_length(p_payments);
begin
  for v_part in select value from jsonb_array_elements(p_payments) loop
    if v_part->>'method' = 'CASH' then
      if (v_part->>'tendered_idr')::numeric - (v_part->>'change_idr')::numeric <> (v_part->>'net_received_idr')::numeric then
        raise exception 'SALE_CASH_MISMATCH' using errcode='P0001';
      end if;
    elsif (v_part->>'proof_checked')::boolean is not true then
      raise exception 'PAYMENT_PROOF_REQUIRED' using errcode='P0001';
    end if;
    -- A zero part only makes sense as the single cash part of a Rp0 sale.
    if (v_part->>'net_received_idr')::numeric = 0 and (v_parts > 1 or v_part->>'method' <> 'CASH') then
      raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001';
    end if;
    v_paid := v_paid + (v_part->>'net_received_idr')::numeric;
  end loop;
  return v_paid;
end $$;

create function app.payment_parts_insert(p_tenant uuid,p_sale uuid,p_settlement uuid,p_payments jsonb,
  p_actor uuid,p_at timestamptz) returns void
language sql volatile set search_path = pg_catalog, pg_temp as $$
  insert into biz.payment (tenant_id,sale_id,settlement_id,part_no,method,gross_cash_tendered,change_idr,net_received_idr,
    bank_reference,verification_status,verified_by,verified_at)
  select p_tenant,p_sale,p_settlement,p.ordinality::integer,p.value->>'method',
    case when p.value->>'method' = 'CASH' then (p.value->>'tendered_idr')::bigint end,
    coalesce((p.value->>'change_idr')::bigint,0),(p.value->>'net_received_idr')::bigint,
    case when jsonb_typeof(p.value->'reference') = 'string' then p.value->>'reference' end,
    'VERIFIED',p_actor,p_at
  from jsonb_array_elements(p_payments) with ordinality p
$$;

-- Backstop at commit. Checkout parts plus credit equal the sale total; settlement parts equal the
-- settlement amount; the invoice projection matches all recorded money and is never overpaid.
create or replace function app.sale_payment_balance_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_row jsonb := to_jsonb(new); v_sale uuid; v_settlement uuid; v_total bigint; v_credit bigint;
  v_paid numeric; v_parts integer; v_amount bigint; v_inv record;
begin
  if tg_table_name = 'receivable_payment' then
    v_sale := (v_row->>'sale_id')::uuid; v_settlement := (v_row->>'id')::uuid;
  elsif tg_table_name = 'payment' then
    v_sale := (v_row->>'sale_id')::uuid; v_settlement := (v_row->>'settlement_id')::uuid;
  else
    v_sale := (v_row->>'id')::uuid;
  end if;
  if v_settlement is null then
    select s.total_idr,s.credit_idr into v_total,v_credit from biz.sale s where s.tenant_id=new.tenant_id and s.id=v_sale;
    select coalesce(sum(p.net_received_idr),0),count(*) into v_paid,v_parts from biz.payment p
      where p.tenant_id=new.tenant_id and p.sale_id=v_sale and p.settlement_id is null;
    if v_total is null or (v_parts = 0 and v_credit < v_total) or v_paid + v_credit <> v_total then
      raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001';
    end if;
  else
    select r.amount_idr into v_amount from biz.receivable_payment r where r.tenant_id=new.tenant_id and r.id=v_settlement;
    select coalesce(sum(p.net_received_idr),0) into v_paid from biz.payment p
      where p.tenant_id=new.tenant_id and p.settlement_id=v_settlement;
    if v_amount is null or v_paid <> v_amount then raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001'; end if;
  end if;
  select i.* into v_inv from biz.invoice_state i where i.tenant_id=new.tenant_id and i.sale_id=v_sale;
  select coalesce(sum(p.net_received_idr),0) into v_paid from biz.payment p
    where p.tenant_id=new.tenant_id and p.sale_id=v_sale;
  if v_inv is null or v_inv.p_idr <> v_paid                                               -- @kontrol:RECEIVABLE_BALANCE
     or v_inv.f_idr::numeric + v_inv.c_idr - v_inv.r_idr - (v_inv.p_idr - v_inv.rf_idr) < 0 -- @kontrol:RECEIVABLE_BALANCE
  then raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001'; end if;             -- @kontrol:RECEIVABLE_BALANCE
  return null;
end $$;

create or replace function app.sale_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_sale jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  select jsonb_build_object(
    'sale_id',s.id,'receipt_number',s.document_seq::text,'business_day',s.business_day,
    'finalized_at',s.finalized_at,'grand_total_idr',s.total_idr::text,'version',1,
    'customer',case when s.customer_id is not null then app.customer_view(s.tenant_id,s.customer_id) - 'open_receivable_idr' end,
    'payments',coalesce((select jsonb_agg(jsonb_build_object('method',p.method,
      'tendered_idr',p.gross_cash_tendered::text,'change_idr',p.change_idr::text,
      'net_received_idr',p.net_received_idr::text,'reference',p.bank_reference,
      'verification_status',p.verification_status,'verified_by',p.verified_by,'verified_at',p.verified_at)
      order by p.part_no) from biz.payment p where p.tenant_id=s.tenant_id and p.sale_id=s.id and p.settlement_id is null),
      '[]'::jsonb),
    'receivable',(select jsonb_build_object('credit_idr',s.credit_idr::text,'due_on',i.due_on,
      'paid_idr',i.p_idr::text,
      'outstanding_idr',greatest(i.f_idr::numeric+i.c_idr-i.r_idr-(i.p_idr-i.rf_idr),0)::text,'version',i.version,
      'settlements',coalesce((select jsonb_agg(jsonb_build_object('payment_id',r.id,'receipt_number',r.document_seq::text,
        'paid_at',r.paid_at,'amount_idr',r.amount_idr::text) order by r.document_seq)
        from biz.receivable_payment r where r.tenant_id=s.tenant_id and r.sale_id=s.id),'[]'::jsonb))
      from biz.invoice_state i where i.tenant_id=s.tenant_id and i.sale_id=s.id),
    'lines',(select jsonb_agg(jsonb_build_object('product_id',l.product_id,'sku',l.sku,'product_name',l.product_name,
      'package_version_id',l.package_version_id,'package_label',l.package_label,'package_factor',l.package_factor,
      'batch_id',l.batch_id,'batch_number',l.batch_number,'expires_on',l.expires_on,'quantity',l.quantity,
      'unit_price_idr',l.unit_price_idr::text,'gross_idr',l.gross_idr::text,
      'cost_snapshot_idr',case when l.cost_verified then l.cost_snapshot_idr::text end,'cost_verified',l.cost_verified)
      order by l.line_no) from biz.sale_line l where l.tenant_id=s.tenant_id and l.sale_id=s.id)
  ) into v_sale
  from biz.sale s
  where s.tenant_id=a.tenant_id and s.id=p_id;
  if not found then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
  return v_sale;
end $$;

create or replace function app.sale_create(p_key uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_product uuid; v_location uuid; v_sale uuid; v_event uuid; v_customer uuid; v_due date;
  v_lines jsonb; v_line record; v_pool record; v_total numeric; v_paid numeric; v_credit numeric;
  v_change numeric;
  v_seq bigint; v_base bigint; v_hpp bigint; v_at timestamptz; v_day date;
  v_expires timestamptz; v_response jsonb;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  select * into a from iam.current_actor();
  if p_key is null or jsonb_typeof(p_body) is distinct from 'object'
     or p_body - 'customer_id' - 'due_on' - 'lines' - 'payments' <> '{}'::jsonb
     or (p_body->'customer_id' is not null and p_body->'customer_id' <> 'null'::jsonb
       and (jsonb_typeof(p_body->'customer_id') <> 'string' or p_body->>'customer_id' !~ v_uuid))
     or (p_body->'due_on' is not null and p_body->'due_on' <> 'null'::jsonb
       and (jsonb_typeof(p_body->'due_on') <> 'string' or p_body->>'due_on' !~ '^\d{4}-\d{2}-\d{2}$'
         or pg_input_is_valid(p_body->>'due_on','date') is not true))
  then raise exception 'VALIDATION' using errcode='P0001'; end if;
  perform app.sale_validate_payments(p_body->'payments');
  perform app.sale_validate_lines(p_body->'lines',true);
  v_customer := (p_body->>'customer_id')::uuid;
  v_due := (p_body->>'due_on')::date;

  v_response := app.idem_claim(a.tenant_id,'sale.create',p_key,p_body);
  if v_response is not null then return v_response; end if;
  perform app.inv_require_active(a.effective_status);
  -- All checkouts of one tenant are serialized by the subscription row lock before product locks.
  select sub.expires_at into v_expires from platform.subscription sub
    where sub.tenant_id=a.tenant_id for update;
  if not found then raise exception 'TENANT_LOCKED' using errcode='P0001'; end if;
  v_location := app.inv_location(a.tenant_id,'{}'::jsonb);
  for v_product in select distinct (l->>'product_id')::uuid from jsonb_array_elements(p_body->'lines') l order by 1 loop
    perform app.inv_lock_product(a.tenant_id,v_product);
  end loop;
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  -- Conservative deadline before posting. Literal commit-time proof remains T-06c.
  if v_expires <= clock_timestamp() + interval '5 seconds' then
    raise exception 'TENANT_LOCKED' using errcode='P0001';
  end if;
  v_day := app.tenant_today(a.tenant_id);
  if v_customer is not null and not exists (select 1 from biz.customer c where c.tenant_id=a.tenant_id and c.id=v_customer) then
    raise exception 'NOT_FOUND' using errcode='P0001';
  end if;
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

  v_paid := app.payment_parts_total(p_body->'payments');
  if v_paid > v_total then raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001'; end if;
  v_credit := v_total - v_paid;
  if v_credit = 0 then
    if v_due is not null or jsonb_array_length(p_body->'payments') = 0 then
      raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001';
    end if;
  else
    -- Tempo or partial payment: a registered customer and a due date for this invoice.
    if v_customer is null then raise exception 'CREDIT_CUSTOMER_REQUIRED' using errcode='P0001'; end if;
    if v_due is null then raise exception 'CREDIT_DUE_DATE_REQUIRED' using errcode='P0001'; end if;
    if v_due < v_day then raise exception 'CREDIT_DUE_DATE_INVALID' using errcode='P0001'; end if;
  end if;
  select coalesce(max((p->>'change_idr')::numeric),0) into v_change
    from jsonb_array_elements(p_body->'payments') p where p->>'method' = 'CASH';

  v_at := clock_timestamp();
  select coalesce(max(s.document_seq),0)+1 into v_seq from biz.sale s where s.tenant_id=a.tenant_id;
  insert into biz.sale (tenant_id,location_id,document_seq,business_day,finalized_at,actor_user_id,idempotency_key,
    total_idr,customer_id,due_on,credit_idr)
    values (a.tenant_id,v_location,v_seq,v_day,v_at,a.user_id,p_key,v_total::bigint,v_customer,v_due,v_credit::bigint)
    returning id into v_sale;

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

  perform app.payment_parts_insert(a.tenant_id,v_sale,null,p_body->'payments',a.user_id,v_at);
  insert into biz.invoice_state (tenant_id,sale_id,customer_id,due_on,f_idr,p_idr,updated_at)
    values (a.tenant_id,v_sale,v_customer,v_due,v_total::bigint,v_paid::bigint,v_at);
  perform app.audit(a.tenant_id,a.user_id,'SALE_FINAL','sale',v_sale,jsonb_build_object(
    'receipt_number',v_seq::text,'credit_idr',v_credit::text,'payment_methods',
    (select coalesce(jsonb_agg(p->>'method' order by n),'[]'::jsonb)
      from jsonb_array_elements(p_body->'payments') with ordinality x(p,n))));
  v_response := app.idem_finish(a.tenant_id,'sale.create',p_key,jsonb_build_object(
    'sale_id',v_sale,'receipt_number',v_seq::text,'grand_total_idr',v_total::text,
    'cash_change_idr',v_change::text,'credit_idr',v_credit::text,'due_on',v_due,'version',1,'replayed',false));
  if v_day <> app.tenant_today(a.tenant_id) then raise exception 'SALE_QUOTE_CHANGED' using errcode='P0001'; end if;
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if v_expires <= clock_timestamp() + interval '5 seconds' then
    raise exception 'TENANT_LOCKED' using errcode='P0001';
  end if;
  return v_response;
end $$;

-- Settlement of one selected invoice. Adds money only; revenue and stock stay as finalized.
create function app.receivable_pay(p_key uuid,p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_sale uuid; v_inv record; v_expires timestamptz; v_paid numeric; v_outstanding numeric;
  v_change numeric; v_id uuid; v_seq bigint; v_at timestamptz; v_response jsonb;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  select * into a from iam.current_actor();
  if p_key is null or jsonb_typeof(p_body) is distinct from 'object'
     or p_body - 'sale_id' - 'expected_version' - 'payments' <> '{}'::jsonb
     or jsonb_typeof(p_body->'sale_id') is distinct from 'string' or p_body->>'sale_id' !~ v_uuid
     or jsonb_typeof(p_body->'expected_version') is distinct from 'number'
     or p_body->>'expected_version' !~ '^[1-9][0-9]{0,8}$'
     or jsonb_typeof(p_body->'payments') is distinct from 'array' or jsonb_array_length(p_body->'payments') = 0
  then raise exception 'VALIDATION' using errcode='P0001'; end if;
  perform app.sale_validate_payments(p_body->'payments');
  v_sale := (p_body->>'sale_id')::uuid;

  v_response := app.idem_claim(a.tenant_id,'receivable.pay',p_key,p_body);
  if v_response is not null then return v_response; end if;
  perform app.inv_require_active(a.effective_status);
  select sub.expires_at into v_expires from platform.subscription sub where sub.tenant_id=a.tenant_id for update;
  if not found then raise exception 'TENANT_LOCKED' using errcode='P0001'; end if;
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if v_expires <= clock_timestamp() + interval '5 seconds' then
    raise exception 'TENANT_LOCKED' using errcode='P0001';
  end if;
  select i.* into v_inv from biz.invoice_state i where i.tenant_id=a.tenant_id and i.sale_id=v_sale for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0001'; end if;
  if v_inv.version <> (p_body->>'expected_version')::integer then
    raise exception 'VERSION_CONFLICT' using errcode='P0001';
  end if;
  v_outstanding := v_inv.f_idr::numeric + v_inv.c_idr - v_inv.r_idr - (v_inv.p_idr - v_inv.rf_idr);
  if v_outstanding <= 0 then raise exception 'RECEIVABLE_SETTLED' using errcode='P0001'; end if;
  v_paid := app.payment_parts_total(p_body->'payments');
  if v_paid = 0 then raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001'; end if;
  if v_paid > v_outstanding then raise exception 'RECEIVABLE_OVERPAID' using errcode='P0001'; end if;
  select coalesce(max((p->>'change_idr')::numeric),0) into v_change
    from jsonb_array_elements(p_body->'payments') p where p->>'method' = 'CASH';

  v_at := clock_timestamp();
  select coalesce(max(r.document_seq),0)+1 into v_seq from biz.receivable_payment r where r.tenant_id=a.tenant_id;
  insert into biz.receivable_payment (tenant_id,sale_id,document_seq,business_day,paid_at,actor_user_id,idempotency_key,amount_idr)
    values (a.tenant_id,v_sale,v_seq,app.tenant_today(a.tenant_id),v_at,a.user_id,p_key,v_paid::bigint)
    returning id into v_id;
  perform app.payment_parts_insert(a.tenant_id,v_sale,v_id,p_body->'payments',a.user_id,v_at);
  update biz.invoice_state i set p_idr=i.p_idr+v_paid::bigint,version=i.version+1,updated_at=v_at
    where i.tenant_id=a.tenant_id and i.sale_id=v_sale;
  perform app.audit(a.tenant_id,a.user_id,'RECEIVABLE_PAYMENT','sale',v_sale,jsonb_build_object(
    'payment_id',v_id,'receipt_number',v_seq::text,'amount_idr',v_paid::text));
  v_response := app.idem_finish(a.tenant_id,'receivable.pay',p_key,jsonb_build_object(
    'payment_id',v_id,'receipt_number',v_seq::text,'sale_id',v_sale,'paid_idr',v_paid::text,
    'outstanding_idr',(v_outstanding-v_paid)::text,'cash_change_idr',v_change::text,
    'invoice_version',v_inv.version+1,'replayed',false));
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if v_expires <= clock_timestamp() + interval '5 seconds' then
    raise exception 'TENANT_LOCKED' using errcode='P0001';
  end if;
  return v_response;
end $$;

-- Open invoices, oldest due first. Phone numbers stay masked.
create function app.receivable_list(p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_today date; v jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  v_today := app.tenant_today(a.tenant_id);
  select coalesce(jsonb_agg(x.item order by x.due_on,x.seq),'[]'::jsonb) into v from (
    select i.due_on,s.document_seq seq,jsonb_build_object(
      'sale_id',s.id,'receipt_number',s.document_seq::text,'business_day',s.business_day,'due_on',i.due_on,
      'due_status',case when v_today < i.due_on then 'NOT_DUE' when v_today = i.due_on then 'DUE_TODAY' else 'OVERDUE' end,
      'customer_id',c.id,'customer_name',c.display_name,'phone_masked',app.mask_phone(c.phone_e164),
      'grand_total_idr',i.f_idr::text,'paid_idr',i.p_idr::text,
      'outstanding_idr',(i.f_idr::numeric+i.c_idr-i.r_idr-(i.p_idr-i.rf_idr))::text,'version',i.version) item
    from biz.invoice_state i
    join biz.sale s on s.tenant_id=i.tenant_id and s.id=i.sale_id
    join biz.customer c on c.tenant_id=i.tenant_id and c.id=i.customer_id
    where i.tenant_id=a.tenant_id and (p_customer is null or i.customer_id=p_customer)
      and i.f_idr::numeric+i.c_idr-i.r_idr-(i.p_idr-i.rf_idr) > 0
    order by i.due_on,s.document_seq limit 200) x;
  return v;
end $$;

grant execute on function app.sale_payment_balance_guard() to migration_owner;
reset role;

set role migration_owner;
create constraint trigger receivable_payment_balance after insert on biz.receivable_payment
  deferrable initially deferred for each row execute function app.sale_payment_balance_guard();
reset role;

grant execute on function app.customer_create(uuid,jsonb),app.customer_get(uuid),app.customer_list(text),
  app.receivable_pay(uuid,jsonb),app.receivable_list(uuid) to app_runtime;
