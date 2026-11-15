-- Checkout paid in full with cash, bank transfer, external QRIS, external EDC, or a mix of them.
-- Every part is recorded once with method, amount, reference, actor and verification time.
set role migration_owner;

alter table biz.payment drop constraint payment_tenant_id_sale_id_key;
alter table biz.payment drop constraint payment_tenant_id_sale_id_net_received_idr_fkey;
alter table biz.payment drop constraint payment_method_check;
alter table biz.payment drop constraint payment_check;
alter table biz.payment alter column gross_cash_tendered drop not null;
alter table biz.payment add column part_no integer not null default 1;
alter table biz.payment alter column part_no drop default;
alter table biz.payment add column bank_reference text;
alter table biz.payment add column verification_status text not null default 'VERIFIED';
alter table biz.payment alter column verification_status drop default;

alter table biz.payment add constraint payment_part_no_check check (part_no between 1 and 4);
alter table biz.payment add constraint payment_method_check
  check (method in ('CASH','TRANSFER','QRIS','EDC'));
alter table biz.payment add constraint payment_verification_check check (verification_status = 'VERIFIED');
alter table biz.payment add constraint payment_amount_check check (
  (method = 'CASH' and gross_cash_tendered is not null and bank_reference is null
    and net_received_idr = gross_cash_tendered - change_idr)
  or (method <> 'CASH' and gross_cash_tendered is null and change_idr = 0 and net_received_idr > 0));
alter table biz.payment add constraint payment_reference_check check (
  bank_reference is null or (char_length(bank_reference) between 1 and 64
    and bank_reference = btrim(bank_reference) and bank_reference !~ '[[:cntrl:]]'));
alter table biz.payment add constraint payment_part_unique unique (tenant_id,sale_id,part_no);
alter table biz.payment add constraint payment_sale_fkey
  foreign key (tenant_id,sale_id) references biz.sale(tenant_id,id);
create unique index payment_one_cash_part on biz.payment (tenant_id,sale_id) where method = 'CASH';

reset role;
set role app_fn_owner;

-- Shape check only. Amount arithmetic is checked after the server price is known.
create function app.sale_validate_payments(p_payments jsonb) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_part jsonb; v_field text;
  v_amount constant text := '^(0|[1-9][0-9]{0,18})$';
begin
  if jsonb_typeof(p_payments) is distinct from 'array'
     or jsonb_array_length(p_payments) not between 1 and 4 then
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
    elsif v_part->>'method' in ('TRANSFER','QRIS','EDC') then
      if v_part - 'method' - 'net_received_idr' - 'reference' - 'proof_checked' <> '{}'::jsonb
         or jsonb_typeof(v_part->'net_received_idr') is distinct from 'string'
         or coalesce(v_part->>'net_received_idr','') !~ v_amount
         or jsonb_typeof(v_part->'proof_checked') is distinct from 'boolean'
         or (v_part ? 'reference' and jsonb_typeof(v_part->'reference') not in ('string','null'))
         or (jsonb_typeof(v_part->'reference') = 'string' and (
              char_length(v_part->>'reference') not between 1 and 64
              or v_part->>'reference' <> btrim(v_part->>'reference')
              or v_part->>'reference' ~ '[[:cntrl:]]'))
      then raise exception 'VALIDATION' using errcode='P0001'; end if;
    else
      raise exception 'VALIDATION' using errcode='P0001';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_payments) p where p->>'method' = 'CASH') > 1 then
    raise exception 'VALIDATION' using errcode='P0001';
  end if;
end $$;

-- Backstop at commit: the verified parts of a sale add up to its total, no more and no less.
create function app.sale_payment_balance_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_sale uuid; v_total bigint; v_paid numeric; v_parts integer;
begin
  -- Fired from both biz.sale (id) and biz.payment (sale_id).
  v_sale := coalesce(to_jsonb(new)->>'sale_id',to_jsonb(new)->>'id')::uuid;
  select s.total_idr into v_total from biz.sale s where s.tenant_id=new.tenant_id and s.id=v_sale;
  select coalesce(sum(p.net_received_idr),0),count(*) into v_paid,v_parts from biz.payment p
    where p.tenant_id=new.tenant_id and p.sale_id=v_sale;
  if v_total is null or v_parts = 0 or v_paid <> v_total then
    raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001';
  end if;
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
    'payments',(select jsonb_agg(jsonb_build_object('method',p.method,
      'tendered_idr',p.gross_cash_tendered::text,'change_idr',p.change_idr::text,
      'net_received_idr',p.net_received_idr::text,'reference',p.bank_reference,
      'verification_status',p.verification_status,'verified_by',p.verified_by,'verified_at',p.verified_at)
      order by p.part_no) from biz.payment p where p.tenant_id=s.tenant_id and p.sale_id=s.id),
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
  a record; v_product uuid; v_location uuid; v_sale uuid; v_event uuid;
  v_lines jsonb; v_line record; v_part record; v_pool record; v_total numeric; v_paid numeric;
  v_change numeric := 0; v_parts integer;
  v_seq bigint; v_base bigint; v_hpp bigint; v_at timestamptz; v_day date;
  v_expires timestamptz; v_response jsonb;
begin
  select * into a from iam.current_actor();
  if p_key is null or jsonb_typeof(p_body) is distinct from 'object'
     or p_body - 'customer_id' - 'lines' - 'payments' <> '{}'::jsonb
     or (p_body ? 'customer_id' and p_body->'customer_id' <> 'null'::jsonb)
  then raise exception 'VALIDATION' using errcode='P0001'; end if;
  perform app.sale_validate_payments(p_body->'payments');
  perform app.sale_validate_lines(p_body->'lines',true);
  v_parts := jsonb_array_length(p_body->'payments');
  for v_part in select p.value as body from jsonb_array_elements(p_body->'payments') p loop
    if greatest(coalesce((v_part.body->>'tendered_idr')::numeric,0),coalesce((v_part.body->>'change_idr')::numeric,0),
                (v_part.body->>'net_received_idr')::numeric) > 9223372036854775807 then
      raise exception 'VALIDATION' using errcode='P0001';
    end if;
  end loop;

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

  v_paid := 0;
  for v_part in select p.value as body from jsonb_array_elements(p_body->'payments') p loop
    if v_part.body->>'method' = 'CASH' then
      if (v_part.body->>'tendered_idr')::numeric - (v_part.body->>'change_idr')::numeric
         <> (v_part.body->>'net_received_idr')::numeric then
        raise exception 'SALE_CASH_MISMATCH' using errcode='P0001';
      end if;
      v_change := (v_part.body->>'change_idr')::numeric;
    elsif (v_part.body->>'proof_checked')::boolean is not true then
      raise exception 'PAYMENT_PROOF_REQUIRED' using errcode='P0001';
    end if;
    -- A zero part only makes sense as the single cash part of a Rp0 sale.
    if (v_part.body->>'net_received_idr')::numeric = 0 and (v_parts > 1 or v_part.body->>'method' <> 'CASH') then
      raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001';
    end if;
    v_paid := v_paid + (v_part.body->>'net_received_idr')::numeric;
  end loop;
  -- Paid in full only: no remaining balance and no deposit. Change exists only on the cash part.
  if v_paid <> v_total then raise exception 'SALE_PAYMENT_MISMATCH' using errcode='P0001'; end if;

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

  insert into biz.payment (tenant_id,sale_id,part_no,method,gross_cash_tendered,change_idr,net_received_idr,
    bank_reference,verification_status,verified_by,verified_at)
  select a.tenant_id,v_sale,p.ordinality::integer,p.value->>'method',
    case when p.value->>'method' = 'CASH' then (p.value->>'tendered_idr')::bigint end,
    coalesce((p.value->>'change_idr')::bigint,0),(p.value->>'net_received_idr')::bigint,
    case when jsonb_typeof(p.value->'reference') = 'string' then p.value->>'reference' end,
    'VERIFIED',a.user_id,v_at
  from jsonb_array_elements(p_body->'payments') with ordinality p;
  perform app.audit(a.tenant_id,a.user_id,'SALE_FINAL','sale',v_sale,jsonb_build_object(
    'receipt_number',v_seq::text,'payment_methods',
    (select jsonb_agg(p->>'method' order by n) from jsonb_array_elements(p_body->'payments') with ordinality x(p,n))));
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

grant execute on function app.sale_payment_balance_guard() to migration_owner;
reset role;

set role migration_owner;
create constraint trigger sale_payment_balance after insert on biz.sale            -- @kontrol:PAYMENT_BALANCE
  deferrable initially deferred for each row execute function app.sale_payment_balance_guard(); -- @kontrol:PAYMENT_BALANCE
create constraint trigger payment_balance after insert on biz.payment              -- @kontrol:PAYMENT_BALANCE
  deferrable initially deferred for each row execute function app.sale_payment_balance_guard(); -- @kontrol:PAYMENT_BALANCE
reset role;
