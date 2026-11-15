-- Reserve each supplied external reference once per tenant and method.
-- Existing duplicate payments stay in the ledger for reconciliation.
set role migration_owner;

lock table biz.sale, biz.payment, biz.invoice_state in share row exclusive mode nowait;

create table biz.payment_reference (
  tenant_id uuid not null,
  method text not null check (method in ('TRANSFER','QRIS','EDC')),
  reference text collate "C" not null check (char_length(reference) between 1 and 64),
  payment_id uuid not null,
  primary key (tenant_id,method,reference),
  foreign key (tenant_id,payment_id) references biz.payment(tenant_id,id)
);

alter table biz.payment_reference enable row level security;
alter table biz.payment_reference force row level security;
create policy payment_reference_tenant on biz.payment_reference for all to app_fn_owner
  using (tenant_id=app.current_tenant()) with check (tenant_id=app.current_tenant());
grant insert on biz.payment_reference to app_fn_owner;

create trigger payment_reference_append_only before update or delete on biz.payment_reference
  for each row execute function iam.reject_change();
create trigger payment_reference_no_truncate before truncate on biz.payment_reference
  for each statement execute function iam.reject_change();

-- Temporary migration-only policies. FORCE RLS remains enabled throughout.
create policy backfill_sale on biz.sale for select to migration_owner using (true);
create policy backfill_payment on biz.payment for select to migration_owner using (true);
create policy backfill_invoice on biz.invoice_state for all to migration_owner using (true) with check (true);
create policy backfill_reference on biz.payment_reference for all to migration_owner using (true) with check (true);

insert into biz.payment_reference(tenant_id,method,reference,payment_id)
select distinct on (p.tenant_id,p.method,p.bank_reference collate "C")
  p.tenant_id,p.method,p.bank_reference,p.id
from biz.payment p
where p.bank_reference is not null
order by p.tenant_id,p.method,p.bank_reference collate "C",p.verified_at,p.id;

-- Sales created before the credit module were paid in full at checkout.
-- Rebuild their invoice projection from the original payment parts, without posting new money.
insert into biz.invoice_state(tenant_id,sale_id,customer_id,due_on,f_idr,p_idr,updated_at)
select s.tenant_id,s.id,s.customer_id,s.due_on,s.total_idr,
       sum(p.net_received_idr)::bigint,s.finalized_at
from biz.sale s
join biz.payment p on p.tenant_id=s.tenant_id and p.sale_id=s.id and p.settlement_id is null
left join biz.invoice_state i on i.tenant_id=s.tenant_id and i.sale_id=s.id
where i.sale_id is null and s.credit_idr=0 and s.due_on is null
group by s.tenant_id,s.id
having sum(p.net_received_idr)=s.total_idr;

do $$
declare duplicate_rows bigint;
begin
  if exists (
    select 1 from biz.sale s
    left join biz.invoice_state i on i.tenant_id=s.tenant_id and i.sale_id=s.id
    where i.sale_id is null
  ) then
    raise exception 'Historical sale without matching full payment. Reconcile before migrating invoice balances.';
  end if;

  select (select count(*) from biz.payment where bank_reference is not null)
       - (select count(*) from biz.payment_reference)
    into duplicate_rows;
  if duplicate_rows > 0 then
    raise warning '% historical payment rows share an external reference; amounts and stock were preserved for reconciliation',
      duplicate_rows;
  end if;
end $$;

drop policy backfill_sale on biz.sale;
drop policy backfill_payment on biz.payment;
drop policy backfill_invoice on biz.invoice_state;
drop policy backfill_reference on biz.payment_reference;

create function biz.reserve_payment_reference() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  insert into biz.payment_reference(tenant_id,method,reference,payment_id)
    values (new.tenant_id,new.method,new.bank_reference,new.id)
    on conflict do nothing;
  if not found then
    raise exception 'PAYMENT_REFERENCE_DUPLICATE' using errcode='P0001';
  end if;
  return null;
end $$;

create trigger reserve_payment_reference after insert on biz.payment
  for each row when (new.bank_reference is not null)
  execute function biz.reserve_payment_reference();

reset role;
