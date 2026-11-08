-- =====================================================================
-- PoC lapisan database — Aplikasi SaaS Penjualan Pertanian (PRD V1.1)
-- PostgreSQL 16. Satu database bersama, tenant_id + Row-Level Security.
-- Revisi 2 (8 Nov 2026) menutup temuan auditor:
--   R2-1  FK komposit (tenant_id, id) di semua relasi -> referensi lintas tenant mustahil
--   R2-2  app_user TANPA hak DML langsung; perubahan data hanya lewat fungsi
--         SECURITY DEFINER milik app_owner (NOBYPASSRLS, RLS FORCE tetap berlaku)
--   R2-3  buka karton membuat baris LOOSE bila belum ada + verifikasi baris terubah
--   R2-4  idempotency key terikat hash payload; key sama + payload beda -> ditolak
--   AS-11 cap waktu Sale = waktu pemeriksaan hak terakhir di server
-- Revisi 3 (8 Nov 2026) menutup audit R2:
--   R3-1  konteks tenant TIDAK lagi dibaca dari GUC bebas. Backend mengirim token sesi mentah
--         (lokal transaksi); database menurunkan tenant/aktor/peran dari iam.session yang
--         tidak dapat dibaca app_user. Memalsukan tenant butuh token sesi sah milik tenant lain.
--   R3-2  fungsi persetujuan memeriksa peran OWNER di database, bukan hanya di HTTP
--   R3-3  hak paket diperiksa ulang SAAT COMMIT (constraint trigger DEFERRED) + cap waktu commit
-- BUKAN skema produksi.
-- =====================================================================
drop schema if exists app cascade;
drop schema if exists iam cascade;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='app_owner') then
    create role app_owner nologin nosuperuser nobypassrls;     -- pemilik objek; tunduk RLS karena FORCE
  end if;
  if not exists (select 1 from pg_roles where rolname='app_user') then
    create role app_user login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end $$;

create schema app authorization app_owner;
set role app_owner;

-- R3-1: konteks = token sesi mentah dari backend (set_config(..., true) = lokal transaksi).
-- Database memverifikasi token terhadap iam.session (hanya dapat dibaca app_owner).
create function app.session_row(out tenant_id uuid, out user_id uuid, out role text)
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare v_tok text := nullif(current_setting('app.session_token', true), '');
begin
  if v_tok is null then return; end if;
  select s.tenant_id, s.user_id, s.role into tenant_id, user_id, role
    from iam.session s
   where s.token_hash = encode(sha256(convert_to(v_tok, 'UTF8')), 'hex')
     and s.revoked_at is null and s.expires_at > clock_timestamp();
end $$;
create function app.tid() returns uuid language sql stable as $$ select (app.session_row()).tenant_id $$;
create function app.actor_id() returns uuid language sql stable as $$ select (app.session_row()).user_id $$;
create function app.actor_role() returns text language sql stable as $$ select (app.session_row()).role $$;

-- ---------------------------------------------------------------- tenant
create table app.tenant(
  id uuid primary key,
  name text not null,
  plan text not null check (plan in ('FREE','PRO','MAX')),
  status text not null check (status in ('ACTIVE','LOCKED')),
  entitlement_until timestamptz not null
);

-- ---------------------------------------------------------------- produk & stok
create table app.product(
  tenant_id uuid not null references app.tenant(id),
  id int not null,
  sku text not null,
  pack_factor int not null check (pack_factor > 0),
  can_open boolean not null,
  price_unit bigint not null check (price_unit >= 0),
  primary key (tenant_id, id),
  unique (tenant_id, sku)
);

create table app.stock(
  tenant_id uuid not null,
  product_id int not null,
  form text not null check (form in ('LOOSE','SEALED')),
  batch text not null,
  status text not null check (status in ('READY','HELD','INSPECT')),
  qty int not null check (qty >= 0),
  primary key (tenant_id, product_id, form, batch, status),
  foreign key (tenant_id, product_id) references app.product(tenant_id, id)
);

create table app.cost_pool(
  tenant_id uuid not null,
  product_id int not null,
  status text not null check (status in ('READY','HELD','INSPECT')),
  qty_base int not null check (qty_base >= 0),
  value bigint not null check (value >= 0),
  check (qty_base > 0 or value = 0),
  primary key (tenant_id, product_id, status),
  foreign key (tenant_id, product_id) references app.product(tenant_id, id)
);

create table app.inventory_ledger(
  tenant_id uuid not null,
  id bigserial primary key,
  at timestamptz not null default clock_timestamp(),
  event text not null,
  product_id int not null,
  form text, batch text, status text,
  delta_qty int not null,
  delta_value bigint not null default 0,
  ref text,
  foreign key (tenant_id, product_id) references app.product(tenant_id, id)
);

-- ---------------------------------------------------------------- penjualan
create table app.sale(
  tenant_id uuid not null references app.tenant(id),
  id bigserial primary key,
  idem_key text not null,
  request_hash text not null,                              -- R2-4
  created_at timestamptz not null default clock_timestamp(),
  total bigint not null check (total >= 0),
  unique (tenant_id, idem_key),
  unique (tenant_id, id)
);

create table app.sale_line(
  tenant_id uuid not null,
  sale_id bigint not null,
  line_no int not null,
  product_id int not null,
  form text not null, batch text not null,
  qty int not null check (qty > 0),
  price_total bigint not null check (price_total >= 0),
  hpp bigint not null check (hpp >= 0),
  primary key (sale_id, line_no),
  unique (tenant_id, sale_id, line_no),
  foreign key (tenant_id, sale_id) references app.sale(tenant_id, id),
  foreign key (tenant_id, product_id) references app.product(tenant_id, id)
);

create table app.return_line(
  tenant_id uuid not null,
  id bigserial primary key,
  sale_id bigint not null, line_no int not null,
  qty int not null check (qty > 0),
  price_returned bigint not null check (price_returned >= 0),
  hpp_returned bigint not null check (hpp_returned >= 0),
  foreign key (tenant_id, sale_id, line_no) references app.sale_line(tenant_id, sale_id, line_no)
);

create table app.invoice(
  tenant_id uuid not null,
  sale_id bigint primary key,
  f bigint not null, c bigint not null default 0, r bigint not null default 0,
  p bigint not null default 0, rf bigint not null default 0, q bigint not null default 0,
  check (rf >= 0 and q >= 0),
  check (q <= greatest(-(f + c - r - (p - rf)), 0)),
  check (r <= f + c),
  unique (tenant_id, sale_id),
  foreign key (tenant_id, sale_id) references app.sale(tenant_id, id)
);

create table app.payment(
  tenant_id uuid not null,
  id bigserial primary key,
  sale_id bigint not null,
  method text not null check (method in ('CASH','TRANSFER','QRIS','EDC')),
  amount bigint not null check (amount > 0),
  foreign key (tenant_id, sale_id) references app.sale(tenant_id, id)
);

create table app.unmatched_receipt(
  tenant_id uuid not null references app.tenant(id),
  id bigserial primary key,
  idem_key text not null,
  amount bigint not null check (amount > 0),
  alloc bigint not null default 0, rf bigint not null default 0,
  q bigint not null default 0, waiting bigint not null,
  check (alloc >= 0 and rf >= 0 and q >= 0 and waiting >= 0),
  check (alloc + rf + q + waiting = amount),
  unique (tenant_id, idem_key),
  unique (tenant_id, id)
);

create table app.refund_approval(
  tenant_id uuid not null,
  id bigserial primary key,
  target_kind text not null check (target_kind in ('INVOICE','EXC')),
  target_id bigint not null,
  invoice_sale_id bigint, exc_id bigint,                   -- R2-1: target ber-FK komposit
  method text not null check (method in ('TRANSFER','CASH')),
  amount bigint not null check (amount > 0),
  state text not null check (state in ('APPROVED_NOT_SENT','TRANSFER_MARKED_SENT',
        'PAID_VERIFIED','PAID_CASH','CANCELLED_NOT_SENT','RETURNED_VERIFIED')),
  check (method = 'TRANSFER' or state not in ('TRANSFER_MARKED_SENT','PAID_VERIFIED')),
  check ((target_kind = 'INVOICE' and invoice_sale_id = target_id and exc_id is null)
      or (target_kind = 'EXC' and exc_id = target_id and invoice_sale_id is null)),
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_sale_id) references app.invoice(tenant_id, sale_id),
  foreign key (tenant_id, exc_id) references app.unmatched_receipt(tenant_id, id)
);
create table app.refund_attempt(
  tenant_id uuid not null,
  id bigserial primary key,
  approval_id bigint not null,
  note text,
  foreign key (tenant_id, approval_id) references app.refund_approval(tenant_id, id)
);
create table app.refund_payment(
  tenant_id uuid not null,
  id bigserial primary key,
  approval_id bigint not null unique,
  amount bigint not null check (amount > 0), evidence text not null,
  unique (tenant_id, id),
  foreign key (tenant_id, approval_id) references app.refund_approval(tenant_id, id)
);
create table app.refund_returned(
  tenant_id uuid not null,
  id bigserial primary key,
  payment_id bigint not null unique,
  amount bigint not null check (amount > 0), evidence text not null,
  foreign key (tenant_id, payment_id) references app.refund_payment(tenant_id, id)
);

create table app.cash_movement(
  tenant_id uuid not null references app.tenant(id),
  id bigserial primary key,
  kind text not null,
  amount bigint not null,
  ref text not null,
  unique (tenant_id, kind, ref)
);

create table app.document_print(
  tenant_id uuid not null,
  id bigserial primary key,
  sale_id bigint not null,
  is_copy boolean not null,
  channel text not null check (channel in ('THERMAL','PDF')),
  foreign key (tenant_id, sale_id) references app.sale(tenant_id, id)
);

create table app.audit_event(
  tenant_id uuid not null references app.tenant(id),
  id bigserial primary key,
  at timestamptz not null default clock_timestamp(),
  actor text not null,
  action text not null,
  ref text
);

-- ---------------------------------------------------------------- append-only
create function app.block_mutation() returns trigger language plpgsql as
$$ begin raise exception 'APPEND_ONLY: % tidak boleh diubah/dihapus', tg_table_name; end $$;
create trigger t_ledger_ro before update or delete on app.inventory_ledger for each row execute function app.block_mutation();
create trigger t_audit_ro  before update or delete on app.audit_event     for each row execute function app.block_mutation();
create trigger t_rp_ro     before update or delete on app.refund_payment  for each row execute function app.block_mutation();
create trigger t_rr_ro     before update or delete on app.refund_returned for each row execute function app.block_mutation();
create trigger t_cash_ro   before update or delete on app.cash_movement   for each row execute function app.block_mutation();
create trigger t_sl_ro     before update or delete on app.sale_line       for each row execute function app.block_mutation();

-- ---------------------------------------------------------------- RLS (FORCE: berlaku juga bagi app_owner)
do $$ declare t text; begin
  foreach t in array array['product','stock','cost_pool','inventory_ledger','sale','sale_line',
     'return_line','invoice','payment','unmatched_receipt','refund_approval','refund_attempt',
     'refund_payment','refund_returned','cash_movement','document_print','audit_event'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy p_tenant on app.%I using (tenant_id = (select app.tid())) with check (tenant_id = (select app.tid()))', t);
  end loop;
end $$;
alter table app.tenant enable row level security;
alter table app.tenant force row level security;
create policy p_self on app.tenant for select using (id = (select app.tid()));
create policy p_self_lock on app.tenant for update using (id = (select app.tid())) with check (false);   -- kunci baris boleh, ubah tidak

-- ---------------------------------------------------------------- helper
create function app.audit(p_action text, p_ref text) returns void language sql as
$$ insert into app.audit_event(tenant_id, actor, action, ref) values (app.tid(), (app.session_row()).role || ':' || (app.session_row()).user_id, p_action, p_ref) $$;

create function app.split(p_remaining_value bigint, p_take int, p_remaining_qty int)
returns bigint language sql immutable as
$$ select case when p_take = p_remaining_qty then p_remaining_value
               else (p_remaining_value * p_take) / p_remaining_qty end $$;

create function app.require_tenant() returns uuid language plpgsql stable as $$
begin
  if app.tid() is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  return app.tid();
end $$;
-- R3-2: otorisasi peran di database (PRD AUTH-05: hanya Owner menyetujui retur/refund/koreksi)
create function app.require_owner() returns void language plpgsql stable as $$
begin
  perform app.require_tenant();
  if app.actor_role() is distinct from 'OWNER' then raise exception 'FORBIDDEN_ROLE'; end if;
end $$;

-- ---------------------------------------------------------------- finalisasi penjualan
create function app.finalize_sale(p_idem text, p_lines jsonb, p_pay jsonb)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_sale bigint; v_t app.tenant; l record; v_stock int; v_pool app.cost_pool;
  v_base int; v_hpp bigint; v_price bigint; v_total bigint := 0; v_paid bigint := 0;
  v_cash bigint := 0; v_no int := 0; v_prod app.product; v_now timestamptz;
  v_hash text := encode(sha256(convert_to(coalesce(p_lines,'null'::jsonb)::text || '|' || coalesce(p_pay,'null'::jsonb)::text, 'UTF8')), 'hex');
  v_old_hash text;
begin
  perform app.require_tenant();
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'EMPTY_CART'; end if;
  select id, request_hash into v_sale, v_old_hash from app.sale where tenant_id = app.tid() and idem_key = p_idem;
  if found then
    if v_old_hash <> v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;   -- R2-4
    return v_sale;
  end if;

  select * into v_t from app.tenant where id = app.tid() for share;
  if not found then raise exception 'NO_TENANT_CONTEXT'; end if;
  if v_t.status <> 'ACTIVE' then raise exception 'ENTITLEMENT_LOCKED'; end if;

  insert into app.sale(tenant_id, idem_key, request_hash, total) values (app.tid(), p_idem, v_hash, 0) returning id into v_sale;

  for l in select (e->>'product')::int product, e->>'form' form, e->>'batch' batch, (e->>'qty')::int qty
           from jsonb_array_elements(p_lines) e order by 1,2,3 loop
    if l.qty is null or l.qty <= 0 then raise exception 'INVALID_QTY'; end if;
    select * into v_prod from app.product where tenant_id = app.tid() and id = l.product;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    select qty into v_stock from app.stock
      where tenant_id = app.tid() and product_id = l.product and form = l.form and batch = l.batch and status = 'READY'
      for update;
    if not found or v_stock < l.qty then raise exception 'INSUFFICIENT_STOCK'; end if;
    update app.stock set qty = qty - l.qty
      where tenant_id = app.tid() and product_id = l.product and form = l.form and batch = l.batch and status = 'READY';

    v_base := l.qty * case when l.form = 'SEALED' then v_prod.pack_factor else 1 end;
    select * into v_pool from app.cost_pool where tenant_id = app.tid() and product_id = l.product and status = 'READY' for update;
    if not found or v_pool.qty_base < v_base then raise exception 'COST_POOL_INCONSISTENT'; end if;
    v_hpp := app.split(v_pool.value, v_base, v_pool.qty_base);
    update app.cost_pool set qty_base = qty_base - v_base, value = value - v_hpp
      where tenant_id = app.tid() and product_id = l.product and status = 'READY';

    v_price := v_prod.price_unit * v_base;
    v_no := v_no + 1;
    insert into app.sale_line values (app.tid(), v_sale, v_no, l.product, l.form, l.batch, l.qty, v_price, v_hpp);
    insert into app.inventory_ledger(tenant_id, event, product_id, form, batch, status, delta_qty, delta_value, ref)
      values (app.tid(), 'SALE', l.product, l.form, l.batch, 'READY', -l.qty, -v_hpp, 'sale:'||v_sale);
    v_total := v_total + v_price;
  end loop;

  update app.sale set total = v_total where id = v_sale;
  for l in select e->>'method' method, (e->>'amount')::bigint amount from jsonb_array_elements(coalesce(p_pay,'[]'::jsonb)) e loop
    if l.amount is null or l.amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
    insert into app.payment(tenant_id, sale_id, method, amount) values (app.tid(), v_sale, l.method, l.amount);
    v_paid := v_paid + l.amount;
    if l.method = 'CASH' then v_cash := v_cash + l.amount; end if;
  end loop;
  if v_paid > v_total then raise exception 'OVERPAYMENT_NOT_ALLOWED'; end if;
  insert into app.invoice(tenant_id, sale_id, f, p) values (app.tid(), v_sale, v_total, v_paid);
  if v_cash > 0 then
    insert into app.cash_movement(tenant_id, kind, amount, ref) values (app.tid(), 'SALE_CASH', v_cash, 'sale:'||v_sale);
  end if;
  perform app.audit('SALE_FINAL', 'sale:'||v_sale);

  -- AS-11: waktu sah = pemeriksaan hak terakhir (jam server), dicap ke Sale
  v_now := clock_timestamp();
  if v_now >= v_t.entitlement_until then raise exception 'ENTITLEMENT_EXPIRED'; end if;
  update app.sale set created_at = v_now where id = v_sale;
  return v_sale;
end $$;

-- ---------------------------------------------------------------- R3-3: hak paket diperiksa saat COMMIT
-- Trigger konstrain DEFERRED dijalankan PostgreSQL di dalam proses COMMIT, setelah aplikasi
-- mengirim COMMIT. Bila hak sudah habis/terkunci, COMMIT gagal dan seluruh transaksi batal.
-- Sisa jeda: mikrodetik di dalam COMMIT sampai catatan commit ditulis (dibuktikan lewat
-- pg_xact_commit_timestamp; lihat uji T-06b). Ini batas teknis yang dinyatakan terbuka.
create function app.check_entitlement_at_commit() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_t app.tenant;
begin
  select * into v_t from app.tenant where id = new.tenant_id;
  if not found or v_t.status <> 'ACTIVE' then raise exception 'ENTITLEMENT_LOCKED_AT_COMMIT'; end if;
  if clock_timestamp() >= v_t.entitlement_until then raise exception 'ENTITLEMENT_EXPIRED_AT_COMMIT'; end if;
  return null;
end $$;
create constraint trigger t_sale_entitlement_at_commit after insert on app.sale
  deferrable initially deferred for each row execute function app.check_entitlement_at_commit();

-- ---------------------------------------------------------------- buka karton (R2-3)
create function app.open_carton(p_product int, p_batch text, p_ref text)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
declare v_prod app.product; v_sealed int; v_rows int;
begin
  perform app.require_tenant();
  select * into v_prod from app.product where tenant_id = app.tid() and id = p_product;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if not v_prod.can_open then raise exception 'CANNOT_OPEN'; end if;
  -- pastikan baris LOOSE ada sebelum dikunci (sebelumnya: 12 unit hilang bila baris belum ada)
  insert into app.stock values (app.tid(), p_product, 'LOOSE', p_batch, 'READY', 0) on conflict do nothing;
  perform 1 from app.stock where tenant_id = app.tid() and product_id = p_product and batch = p_batch
     and status = 'READY' and form in ('LOOSE','SEALED') order by form for update;
  select qty into v_sealed from app.stock where tenant_id = app.tid() and product_id = p_product
     and batch = p_batch and status = 'READY' and form = 'SEALED';
  if coalesce(v_sealed,0) < 1 then raise exception 'NO_SEALED_STOCK'; end if;
  update app.stock set qty = qty - 1 where tenant_id = app.tid() and product_id = p_product and batch = p_batch and status='READY' and form='SEALED';
  get diagnostics v_rows = row_count; if v_rows <> 1 then raise exception 'OPEN_CARTON_INCONSISTENT'; end if;
  update app.stock set qty = qty + v_prod.pack_factor where tenant_id = app.tid() and product_id = p_product and batch = p_batch and status='READY' and form='LOOSE';
  get diagnostics v_rows = row_count; if v_rows <> 1 then raise exception 'OPEN_CARTON_INCONSISTENT'; end if;
  insert into app.inventory_ledger(tenant_id, event, product_id, form, batch, status, delta_qty, ref) values
    (app.tid(), 'OPEN_CARTON', p_product, 'SEALED', p_batch, 'READY', -1, p_ref),
    (app.tid(), 'OPEN_CARTON', p_product, 'LOOSE',  p_batch, 'READY', v_prod.pack_factor, p_ref);
  perform app.audit('OPEN_CARTON', p_ref);
end $$;

-- ---------------------------------------------------------------- tahan batch
create function app.hold_batch(p_product int, p_batch text)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
declare r record; v_prod app.product; v_base int := 0; v_pool app.cost_pool; v_val bigint;
begin
  perform app.require_tenant();
  select * into v_prod from app.product where tenant_id = app.tid() and id = p_product;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  for r in select form, qty from app.stock where tenant_id = app.tid() and product_id = p_product
           and batch = p_batch and status = 'READY' order by form for update loop
    v_base := v_base + r.qty * case when r.form='SEALED' then v_prod.pack_factor else 1 end;
    update app.stock set qty = 0 where tenant_id = app.tid() and product_id = p_product and batch = p_batch and form = r.form and status = 'READY';
    insert into app.stock values (app.tid(), p_product, r.form, p_batch, 'HELD', r.qty)
      on conflict (tenant_id, product_id, form, batch, status) do update set qty = app.stock.qty + excluded.qty;
  end loop;
  if v_base = 0 then return; end if;
  select * into v_pool from app.cost_pool where tenant_id = app.tid() and product_id = p_product and status = 'READY' for update;
  v_val := app.split(v_pool.value, v_base, v_pool.qty_base);
  update app.cost_pool set qty_base = qty_base - v_base, value = value - v_val where tenant_id = app.tid() and product_id = p_product and status='READY';
  insert into app.cost_pool values (app.tid(), p_product, 'HELD', v_base, v_val)
    on conflict (tenant_id, product_id, status) do update set qty_base = app.cost_pool.qty_base + excluded.qty_base, value = app.cost_pool.value + excluded.value;
  insert into app.inventory_ledger(tenant_id, event, product_id, batch, status, delta_qty, delta_value, ref)
    values (app.tid(), 'HOLD', p_product, p_batch, 'HELD', v_base, v_val, 'hold');
  perform app.audit('HOLD_BATCH', p_product||':'||p_batch);
end $$;

-- ---------------------------------------------------------------- retur
create function app.return_line(p_sale bigint, p_line int, p_qty int)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare sl app.sale_line; v_done_qty int; v_done_hpp bigint; v_done_price bigint;
        v_hpp bigint; v_price bigint; v_prod app.product; v_base int; v_id bigint;
begin
  perform app.require_owner();
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QTY'; end if;
  select * into sl from app.sale_line where tenant_id = app.tid() and sale_id = p_sale and line_no = p_line for update;
  if not found then raise exception 'LINE_NOT_FOUND'; end if;
  select coalesce(sum(qty),0), coalesce(sum(hpp_returned),0), coalesce(sum(price_returned),0)
    into v_done_qty, v_done_hpp, v_done_price from app.return_line where tenant_id = app.tid() and sale_id = p_sale and line_no = p_line;
  if p_qty > sl.qty - v_done_qty then raise exception 'RETURN_EXCEEDS_LINE'; end if;
  v_hpp   := app.split(sl.hpp - v_done_hpp, p_qty, sl.qty - v_done_qty);
  v_price := app.split(sl.price_total - v_done_price, p_qty, sl.qty - v_done_qty);
  insert into app.return_line(tenant_id, sale_id, line_no, qty, price_returned, hpp_returned)
    values (app.tid(), p_sale, p_line, p_qty, v_price, v_hpp) returning id into v_id;
  select * into v_prod from app.product where tenant_id = app.tid() and id = sl.product_id;
  v_base := p_qty * case when sl.form='SEALED' then v_prod.pack_factor else 1 end;
  insert into app.stock values (app.tid(), sl.product_id, sl.form, sl.batch, 'INSPECT', p_qty)
    on conflict (tenant_id, product_id, form, batch, status) do update set qty = app.stock.qty + excluded.qty;
  insert into app.cost_pool values (app.tid(), sl.product_id, 'INSPECT', v_base, v_hpp)
    on conflict (tenant_id, product_id, status) do update set qty_base = app.cost_pool.qty_base + excluded.qty_base, value = app.cost_pool.value + excluded.value;
  perform 1 from app.invoice where tenant_id = app.tid() and sale_id = p_sale for update;
  update app.invoice set r = r + v_price where tenant_id = app.tid() and sale_id = p_sale;
  insert into app.inventory_ledger(tenant_id, event, product_id, form, batch, status, delta_qty, delta_value, ref)
    values (app.tid(), 'RETURN', sl.product_id, sl.form, sl.batch, 'INSPECT', p_qty, v_hpp, 'ret:'||v_id);
  perform app.audit('RETURN', 'ret:'||v_id);
  return v_hpp;
end $$;

-- ---------------------------------------------------------------- koreksi faktur
create function app.correct_invoice(p_sale bigint, p_delta bigint)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
begin
  perform app.require_owner();
  if p_delta is null or p_delta = 0 then raise exception 'INVALID_AMOUNT'; end if;
  perform 1 from app.invoice where tenant_id = app.tid() and sale_id = p_sale for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  update app.invoice set c = c + p_delta where tenant_id = app.tid() and sale_id = p_sale;
  perform app.audit('CORRECTION', 'sale:'||p_sale||':'||p_delta);
end $$;

-- ---------------------------------------------------------------- pengecualian pembayaran
create function app.record_unmatched(p_idem text, p_amount bigint)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id bigint; v_amt bigint;
begin
  perform app.require_tenant();
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  insert into app.unmatched_receipt(tenant_id, idem_key, amount, waiting) values (app.tid(), p_idem, p_amount, p_amount)
    on conflict (tenant_id, idem_key) do nothing returning id into v_id;
  if v_id is null then
    select id, amount into v_id, v_amt from app.unmatched_receipt where tenant_id = app.tid() and idem_key = p_idem;
    if v_amt <> p_amount then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;       -- R2-4
    return v_id;
  end if;
  perform app.audit('RECEIVED_UNMATCHED', 'exc:'||v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- refund
create function app.approve_refund(p_kind text, p_target bigint, p_amount bigint, p_method text)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id bigint;
begin
  perform app.require_owner();
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_kind = 'INVOICE' then
    perform 1 from app.invoice where tenant_id = app.tid() and sale_id = p_target for update;
    if not found then raise exception 'TARGET_NOT_FOUND'; end if;
    begin
      update app.invoice set q = q + p_amount where tenant_id = app.tid() and sale_id = p_target;
    exception when check_violation then raise exception 'REFUND_CAP_EXCEEDED';
    end;
  elsif p_kind = 'EXC' then
    perform 1 from app.unmatched_receipt where tenant_id = app.tid() and id = p_target for update;
    if not found then raise exception 'TARGET_NOT_FOUND'; end if;
    begin
      update app.unmatched_receipt set waiting = waiting - p_amount, q = q + p_amount where tenant_id = app.tid() and id = p_target;
    exception when check_violation then raise exception 'REFUND_CAP_EXCEEDED';
    end;
  else
    raise exception 'INVALID_TARGET_KIND';
  end if;
  insert into app.refund_approval(tenant_id, target_kind, target_id, invoice_sale_id, exc_id, method, amount, state)
    values (app.tid(), p_kind, p_target,
            case when p_kind='INVOICE' then p_target end, case when p_kind='EXC' then p_target end,
            p_method, p_amount, 'APPROVED_NOT_SENT') returning id into v_id;
  perform app.audit('REFUND_APPROVED', 'appr:'||v_id);
  return v_id;
end $$;

create function app.mark_sent(p_appr bigint, p_note text)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
declare a app.refund_approval;
begin
  perform app.require_tenant();
  select * into a from app.refund_approval where tenant_id = app.tid() and id = p_appr for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND'; end if;
  if a.method <> 'TRANSFER' or a.state not in ('APPROVED_NOT_SENT','TRANSFER_MARKED_SENT') then raise exception 'INVALID_STATE'; end if;
  update app.refund_approval set state = 'TRANSFER_MARKED_SENT' where tenant_id = app.tid() and id = p_appr;
  insert into app.refund_attempt(tenant_id, approval_id, note) values (app.tid(), p_appr, p_note);
  perform app.audit('TRANSFER_MARKED_SENT', 'appr:'||p_appr);
end $$;

create function app.cancel_approval(p_appr bigint)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
declare a app.refund_approval;
begin
  perform app.require_owner();
  select * into a from app.refund_approval where tenant_id = app.tid() and id = p_appr for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND'; end if;
  if a.state <> 'APPROVED_NOT_SENT' then raise exception 'CANNOT_CANCEL_AFTER_SENT'; end if;
  if a.target_kind = 'INVOICE' then
    update app.invoice set q = q - a.amount where tenant_id = app.tid() and sale_id = a.target_id;
  else
    update app.unmatched_receipt set q = q - a.amount, waiting = waiting + a.amount where tenant_id = app.tid() and id = a.target_id;
  end if;
  update app.refund_approval set state = 'CANCELLED_NOT_SENT' where tenant_id = app.tid() and id = p_appr;
  perform app.audit('REFUND_CANCELLED', 'appr:'||p_appr);
end $$;

create function app.record_refund_paid(p_appr bigint, p_evidence text)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare a app.refund_approval; v_pay bigint;
begin
  perform app.require_owner();
  if coalesce(trim(p_evidence),'') = '' then raise exception 'EVIDENCE_REQUIRED'; end if;
  select * into a from app.refund_approval where tenant_id = app.tid() and id = p_appr for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND'; end if;
  if a.method = 'TRANSFER' and a.state <> 'TRANSFER_MARKED_SENT' then raise exception 'INVALID_STATE'; end if;
  if a.method = 'CASH' and a.state <> 'APPROVED_NOT_SENT' then raise exception 'INVALID_STATE'; end if;
  insert into app.refund_payment(tenant_id, approval_id, amount, evidence)
    values (app.tid(), p_appr, a.amount, p_evidence) returning id into v_pay;
  if a.target_kind = 'INVOICE' then
    update app.invoice set q = q - a.amount, rf = rf + a.amount where tenant_id = app.tid() and sale_id = a.target_id;
  else
    update app.unmatched_receipt set q = q - a.amount, rf = rf + a.amount where tenant_id = app.tid() and id = a.target_id;
  end if;
  update app.refund_approval set state = case when a.method='CASH' then 'PAID_CASH' else 'PAID_VERIFIED' end where tenant_id = app.tid() and id = p_appr;
  if a.method = 'CASH' then
    insert into app.cash_movement(tenant_id, kind, amount, ref) values (app.tid(), 'REFUND_CASH', -a.amount, 'appr:'||p_appr);
  end if;
  perform app.audit('REFUND_PAID', 'appr:'||p_appr);
  return v_pay;
end $$;

create function app.record_refund_returned(p_pay bigint, p_evidence text)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
declare rp app.refund_payment; a app.refund_approval;
begin
  perform app.require_owner();
  if coalesce(trim(p_evidence),'') = '' then raise exception 'EVIDENCE_REQUIRED'; end if;
  select * into rp from app.refund_payment where tenant_id = app.tid() and id = p_pay;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  select * into a from app.refund_approval where tenant_id = app.tid() and id = rp.approval_id for update;
  insert into app.refund_returned(tenant_id, payment_id, amount, evidence) values (app.tid(), p_pay, rp.amount, p_evidence);
  if a.target_kind = 'INVOICE' then
    update app.invoice set rf = rf - rp.amount where tenant_id = app.tid() and sale_id = a.target_id;
  else
    update app.unmatched_receipt set rf = rf - rp.amount, waiting = waiting + rp.amount where tenant_id = app.tid() and id = a.target_id;
  end if;
  update app.refund_approval set state = 'RETURNED_VERIFIED' where tenant_id = app.tid() and id = a.id;
  if a.method = 'CASH' then
    insert into app.cash_movement(tenant_id, kind, amount, ref) values (app.tid(), 'REFUND_CASH_RETURNED', rp.amount, 'pay:'||p_pay);
  end if;
  perform app.audit('REFUND_RETURNED', 'pay:'||p_pay);
end $$;

-- ---------------------------------------------------------------- dokumen
create function app.print_doc(p_sale bigint, p_channel text)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
declare v_n int;
begin
  perform app.require_tenant();
  perform 1 from app.sale where tenant_id = app.tid() and id = p_sale for share;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;
  select count(*) into v_n from app.document_print where tenant_id = app.tid() and sale_id = p_sale;
  insert into app.document_print(tenant_id, sale_id, is_copy, channel) values (app.tid(), p_sale, v_n > 0, p_channel);
end $$;

-- ---------------------------------------------------------------- hak akses (R2-2)
reset role;

-- Identitas & sesi: TIDAK dapat dibaca app_user. app_owner hanya membaca untuk verifikasi token.
create schema iam;
create table iam.pending_owner(
  phone text primary key, kios_name text not null, pw_hash text not null,
  otp_hash text not null, otp_expires timestamptz not null, otp_attempts int not null default 0
);
create table iam.app_user_account(
  id uuid primary key, tenant_id uuid not null references app.tenant(id),
  phone text not null unique, pw_hash text not null,
  role text not null check (role in ('OWNER','ADMIN'))
);
create table iam.session(
  token_hash text primary key, user_id uuid not null references iam.app_user_account(id),
  tenant_id uuid not null, role text not null check (role in ('OWNER','ADMIN')),
  expires_at timestamptz not null, revoked_at timestamptz
);
revoke all on schema iam from public;
grant usage on schema iam to app_owner;
grant select on iam.session to app_owner;
grant usage on schema app to app_user;
grant select on all tables in schema app to app_user;                 -- baca saja; tetap dibatasi RLS
revoke insert, update, delete, truncate on all tables in schema app from app_user;
revoke execute on all functions in schema app from public;
grant execute on function app.finalize_sale(text,jsonb,jsonb), app.open_carton(int,text,text), app.hold_batch(int,text),
  app.return_line(bigint,int,int), app.correct_invoice(bigint,bigint), app.record_unmatched(text,bigint),
  app.approve_refund(text,bigint,bigint,text), app.mark_sent(bigint,text), app.cancel_approval(bigint),
  app.record_refund_paid(bigint,text), app.record_refund_returned(bigint,text), app.print_doc(bigint,text),
  app.tid() to app_user;
grant execute on function app.session_row(), app.actor_id(), app.actor_role() to app_user;
-- fungsi internal (audit, split, require_tenant) hanya untuk app_owner
grant execute on function app.audit(text,text), app.split(bigint,int,int), app.require_tenant(), app.require_owner(),
  app.check_entitlement_at_commit() to app_owner;
grant execute on function app.session_row(), app.tid(), app.actor_id(), app.actor_role() to app_owner;
