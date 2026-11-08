-- 0008: Produk, varian kemasan, dan stok awal (PRD-01..07, INV-02/03/08/09, COST-01/02/06).
--
-- Skema produksi (bukan salinan PoC). Semua tabel bisnis di schema biz: tenant_id wajib, PK/FK komposit
-- (tenant_id, …), ENABLE + FORCE RLS, tidak ada hak tabel untuk role runtime. Satu-satunya jalur tulis
-- adalah fungsi app.* (SECURITY DEFINER milik app_fn_owner, search_path terkunci) yang menurunkan toko,
-- aktor, peran, dan status paket dari iam.current_actor().
--
-- Satuan: stok disimpan per bentuk fisik (qty kemasan) dan setara satuan dasar (qty × faktor). Nilai
-- persediaan adalah bilangan bulat rupiah per (toko, lokasi, produk, status) dalam satuan dasar.
-- Harga jual TIDAK ditangani di sini (K-2: Admin mengajukan, Owner menyetujui) — tidak ada jalur harga.
--
-- Penanda uji mutasi: "-- @kontrol:NAMA" (dihapus saat mutasi), "-- @mutasi:NAMA " (diaktifkan).

create schema biz authorization migration_owner;
revoke all on schema biz from public;
grant usage on schema biz to app_fn_owner;

set role migration_owner;

-- ---------------------------------------------------------------------------------------- produk
create table biz.product (
  tenant_id     uuid not null references platform.tenant (id),
  id            uuid not null default gen_random_uuid(),
  sku           text not null check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  name          text not null check (char_length(name) between 1 and 120),
  category      text not null check (category in ('FERTILIZER', 'PESTICIDE', 'TOOL')),
  is_subsidized boolean not null default false,
  brand         text check (brand is null or char_length(brand) between 1 and 80),
  base_unit     text not null check (char_length(base_unit) between 1 and 20),
  is_active     boolean not null default true,
  created_by    uuid not null references iam.user_account (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       bigint not null default 1,
  primary key (tenant_id, id),
  -- Pupuk subsidi dipisah dari produk umum (SUB-01, POS-08); hanya kategori pupuk.
  check (not is_subsidized or category = 'FERTILIZER')
);
-- PRD-01: SKU unik per toko (tidak peka huruf besar/kecil).
create unique index product_sku_unique on biz.product (tenant_id, upper(sku));

-- PRD-02/05: varian kemasan. Faktor = isi dalam satuan dasar. LOOSE = unit lepas (faktor 1).
create table biz.package_version (
  tenant_id     uuid not null,
  id            uuid not null default gen_random_uuid(),
  product_id    uuid not null,
  label         text not null check (char_length(label) between 1 and 60),
  form          text not null check (form in ('SEALED', 'LOOSE')),
  factor        integer not null check (factor > 0),
  may_open      boolean not null default false,
  supersedes_id uuid,
  superseded_at timestamptz,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id),
  foreign key (tenant_id, supersedes_id) references biz.package_version (tenant_id, id),
  check (form <> 'LOOSE' or factor = 1),
  check (form = 'SEALED' or not may_open)               -- PRD-06: hanya kemasan tersegel yang bisa "boleh dibuka"
);
create index package_version_product on biz.package_version (tenant_id, product_id);

-- Barcode produk & varian dalam satu ruang nama: unik per toko lintas produk/varian (PRD-01/02).
create table biz.barcode (
  tenant_id          uuid not null,
  code               text not null check (code ~ '^[0-9A-Za-z-]{4,64}$'),
  product_id         uuid not null,
  package_version_id uuid,
  created_at         timestamptz not null default now(),
  primary key (tenant_id, code),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id),
  foreign key (tenant_id, package_version_id) references biz.package_version (tenant_id, id)
);
create unique index barcode_one_per_product on biz.barcode (tenant_id, product_id) where package_version_id is null;
create unique index barcode_one_per_package on biz.barcode (tenant_id, package_version_id) where package_version_id is not null;

-- Batch fisik. Tanpa nomor/expiry = "tanpa batch" (satu baris per produk), sehingga dimensi stok selalu lengkap.
create table biz.batch (
  tenant_id    uuid not null,
  id           uuid not null default gen_random_uuid(),
  product_id   uuid not null,
  batch_number text check (batch_number is null or char_length(batch_number) between 1 and 64),
  expires_on   date,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id)
);
create unique index batch_identity on biz.batch (tenant_id, product_id, batch_number, expires_on) nulls not distinct;

-- --------------------------------------------------------------------------------- inventori
-- Peristiwa inventori (header). PRD-04: tepat satu OPENING per produk.
create table biz.inventory_event (
  tenant_id       uuid not null,
  id              uuid not null default gen_random_uuid(),
  kind            text not null check (kind in ('OPENING')),
  product_id      uuid not null,
  location_id     uuid not null,
  actor_user_id   uuid not null references iam.user_account (id),
  event_at        timestamptz not null default clock_timestamp(),
  idempotency_key uuid,
  primary key (tenant_id, id),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id),
  foreign key (tenant_id, location_id) references platform.location (tenant_id, id)
);
create unique index inventory_event_one_opening on biz.inventory_event (tenant_id, product_id)
  where kind = 'OPENING';

-- INV-08/09: ledger kuantitas append-only. Saldo = jumlah delta per dimensi.
create table biz.inventory_ledger (
  tenant_id          uuid not null,
  id                 bigint generated always as identity,
  event_id           uuid not null,
  movement           text not null check (movement in ('OPENING')),
  location_id        uuid not null,
  product_id         uuid not null,
  package_version_id uuid not null,
  batch_id           uuid not null,
  status             text not null check (status in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE')),
  qty_delta          integer not null,
  qty_base_delta     bigint not null,
  actor_user_id      uuid not null references iam.user_account (id),
  event_at           timestamptz not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, event_id) references biz.inventory_event (tenant_id, id),
  foreign key (tenant_id, location_id) references platform.location (tenant_id, id),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id),
  foreign key (tenant_id, package_version_id) references biz.package_version (tenant_id, id),
  foreign key (tenant_id, batch_id) references biz.batch (tenant_id, id),
  check (movement <> 'OPENING' or (qty_delta >= 0 and qty_base_delta >= 0))
);
create index inventory_ledger_dims on biz.inventory_ledger (tenant_id, product_id, package_version_id);

-- Proyeksi saldo per dimensi fisik (INV-02: status terpisah; batch terpisah). Stok tidak boleh negatif.
create table biz.stock_balance (
  tenant_id          uuid not null,
  location_id        uuid not null,
  product_id         uuid not null,
  package_version_id uuid not null,
  batch_id           uuid not null,
  status             text not null check (status in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE')),
  qty                integer not null check (qty >= 0),
  version            bigint not null default 1,
  primary key (tenant_id, location_id, product_id, package_version_id, batch_id, status),
  foreign key (tenant_id, location_id) references platform.location (tenant_id, id),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id),
  foreign key (tenant_id, package_version_id) references biz.package_version (tenant_id, id),
  foreign key (tenant_id, batch_id) references biz.batch (tenant_id, id)
);

-- COST-01: kolam biaya rata-rata bergerak per (lokasi, produk, status) dalam satuan dasar; rupiah bulat.
create table biz.cost_pool (
  tenant_id   uuid not null,
  location_id uuid not null,
  product_id  uuid not null,
  status      text not null check (status in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE')),
  qty_base    bigint not null check (qty_base >= 0),
  value_idr   bigint not null check (value_idr >= 0),
  unverified  boolean not null default false,          -- COST-06: ada stok dengan basis biaya belum terverifikasi
  version     bigint not null default 1,
  primary key (tenant_id, location_id, product_id, status),
  foreign key (tenant_id, location_id) references platform.location (tenant_id, id),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id),
  check (qty_base > 0 or value_idr = 0)
);

-- Ledger nilai append-only; basis biaya pembukaan dicatat per baris (PRD-07).
create table biz.value_ledger (
  tenant_id      uuid not null,
  id             bigint generated always as identity,
  event_id       uuid not null,
  location_id    uuid not null,
  product_id     uuid not null,
  status         text not null check (status in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE')),
  qty_base_delta bigint not null,
  value_delta    bigint not null,
  cost_basis     text not null check (cost_basis in ('KNOWN', 'BONUS_ZERO', 'UNVERIFIED')),
  basis_reason   text check (basis_reason is null or char_length(basis_reason) between 1 and 200),
  basis_origin   text check (basis_origin is null or char_length(basis_origin) between 1 and 200),
  actor_user_id  uuid not null references iam.user_account (id),
  event_at       timestamptz not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, event_id) references biz.inventory_event (tenant_id, id),
  foreign key (tenant_id, location_id) references platform.location (tenant_id, id),
  foreign key (tenant_id, product_id) references biz.product (tenant_id, id),
  check (cost_basis <> 'BONUS_ZERO' or (value_delta = 0 and basis_reason is not null and basis_origin is not null)),
  check (cost_basis <> 'UNVERIFIED' or value_delta = 0)
);

-- Idempotensi terikat isi request: (toko, operasi, kunci) + hash isi kanonik.
create table biz.idempotency (
  tenant_id    uuid not null references platform.tenant (id),
  operation    text not null check (operation in ('product.create')),
  key          uuid not null,
  request_hash bytea not null check (octet_length(request_hash) = 32),
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, operation, key)
);

create table biz.audit_event (
  tenant_id     uuid not null references platform.tenant (id),
  id            bigint generated always as identity,
  actor_user_id uuid not null references iam.user_account (id),
  kind          text not null,
  entity        text not null,
  entity_id     uuid not null,
  at            timestamptz not null default clock_timestamp(),
  detail        jsonb not null default '{}'::jsonb,
  primary key (tenant_id, id)
);

-- INV-09: ketidakcocokan saldo vs ledger dicatat sebagai alert; histori tidak diubah.
create table biz.inventory_alert (
  tenant_id   uuid not null references platform.tenant (id),
  id          bigint generated always as identity,
  kind        text not null check (kind in ('STOCK_MISMATCH', 'VALUE_MISMATCH', 'BASE_MISMATCH')),
  detail      jsonb not null,
  detected_at timestamptz not null default clock_timestamp(),
  detected_by uuid not null references iam.user_account (id),
  primary key (tenant_id, id)
);

-- ------------------------------------------------------------------- trigger integritas (migration_owner)
create trigger inventory_ledger_append_only before update or delete on biz.inventory_ledger
  for each row execute function iam.reject_change();
create trigger inventory_ledger_no_truncate before truncate on biz.inventory_ledger
  for each statement execute function iam.reject_change();
create trigger value_ledger_append_only before update or delete on biz.value_ledger
  for each row execute function iam.reject_change();
create trigger value_ledger_no_truncate before truncate on biz.value_ledger
  for each statement execute function iam.reject_change();
create trigger inventory_event_append_only before update or delete on biz.inventory_event
  for each row execute function iam.reject_change();
create trigger audit_event_append_only before update or delete on biz.audit_event
  for each row execute function iam.reject_change();
create trigger inventory_alert_append_only before update or delete on biz.inventory_alert
  for each row execute function iam.reject_change();

-- PRD-05: faktor/bentuk/produk varian yang sudah punya histori stok tidak boleh berubah (lapis kedua
-- di bawah pemeriksaan fungsi). Varian baru dibuat sebagai versi baru.
create function biz.package_version_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.product_id is distinct from old.product_id or new.tenant_id is distinct from old.tenant_id then
    raise exception 'IMMUTABLE_FIELD' using errcode = 'P0001';
  end if;
  if (new.factor is distinct from old.factor or new.form is distinct from old.form)
     and (exists (select 1 from biz.inventory_ledger l
                   where l.tenant_id = old.tenant_id and l.package_version_id = old.id and l.qty_delta <> 0)
          or exists (select 1 from biz.stock_balance b
                      where b.tenant_id = old.tenant_id and b.package_version_id = old.id and b.qty <> 0)) then
    raise exception 'PACKAGE_FACTOR_LOCKED' using errcode = 'P0001';                       -- @kontrol:FACTOR_LOCK
  end if;
  return new;
end $$;
create trigger package_version_guard before update on biz.package_version
  for each row execute function biz.package_version_guard();

-- Produk: SKU dan status subsidi tidak bisa diubah setelah dibuat (pemisahan stok subsidi).
create function biz.product_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.tenant_id is distinct from old.tenant_id or upper(new.sku) is distinct from upper(old.sku)
     or new.is_subsidized is distinct from old.is_subsidized then
    raise exception 'IMMUTABLE_FIELD' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger product_guard before update on biz.product
  for each row execute function biz.product_guard();

revoke execute on function biz.package_version_guard(), biz.product_guard() from public;
reset role;

-- --------------------------------------------------------------------------- hak & RLS
grant select, insert, update on biz.product, biz.package_version, biz.batch, biz.stock_balance,
  biz.cost_pool, biz.idempotency to app_fn_owner;
grant select, insert, delete on biz.barcode to app_fn_owner;
grant select, insert on biz.inventory_event, biz.inventory_ledger, biz.value_ledger, biz.audit_event,
  biz.inventory_alert to app_fn_owner;

do $$
declare t text;
begin
  foreach t in array array['biz.product', 'biz.package_version', 'biz.barcode', 'biz.batch', 'biz.inventory_event',
                           'biz.inventory_ledger', 'biz.stock_balance', 'biz.cost_pool', 'biz.value_ledger',
                           'biz.idempotency', 'biz.audit_event', 'biz.inventory_alert'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy app_tenant on %s for all to app_fn_owner using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())', t);
  end loop;
end $$;
-- @mutasi:NO_FORCE_BIZ alter table biz.stock_balance no force row level security;

-- ------------------------------------------------------------------------------- fungsi
set role app_fn_owner;

-- COST-02: beban keluar = floor(nilai_sisa × qty_keluar / qty_sisa); bila stok habis, seluruh nilai
-- tersisa diambil. Aritmetika numeric (tanpa floating point, tanpa overflow bigint).
create function app.cost_take(p_value bigint, p_qty bigint, p_out bigint) returns bigint
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p_value is null or p_qty is null or p_out is null or p_value < 0 or p_qty <= 0 or p_out <= 0 or p_out > p_qty then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  if p_out = p_qty then
    return p_value;
  end if;
  return pg_catalog.floor(p_value::numeric * p_out::numeric / p_qty::numeric)::bigint;    -- @kontrol:COST_FORMULA
-- @mutasi:COST_FORMULA return pg_catalog.round(p_value::numeric * p_out::numeric / p_qty::numeric)::bigint;
end $$;

-- Hanya produk aktif nonsubsidi yang boleh masuk checkout POS umum (POS-08). Dipakai modul checkout nanti.
create function app.pos_eligible(p_tenant uuid, p_product uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select p.is_active and not p.is_subsidized from biz.product p
                    where p.tenant_id = p_tenant and p.id = p_product), false)
$$;

create function app.audit(p_tenant uuid, p_actor uuid, p_kind text, p_entity text, p_entity_id uuid, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = pg_catalog, pg_temp as $$
  insert into biz.audit_event (tenant_id, actor_user_id, kind, entity, entity_id, detail)
  values (p_tenant, p_actor, p_kind, p_entity, p_entity_id, p_detail)
$$;

-- Ringkasan produk (dipakai GET /products/{id} dan respons create).
create function app.product_view(p_tenant uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.jsonb_build_object(
    'id', p.id, 'sku', p.sku, 'name', p.name, 'category', p.category, 'subsidized', p.is_subsidized,
    'brand', p.brand, 'baseUnit', p.base_unit, 'active', p.is_active, 'version', p.version,
    'posEligible', p.is_active and not p.is_subsidized,
    'barcode', (select b.code from biz.barcode b where b.tenant_id = p.tenant_id and b.product_id = p.id and b.package_version_id is null),
    'packages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', v.id, 'label', v.label, 'form', v.form, 'factor', v.factor, 'mayOpen', v.may_open,
        'active', v.superseded_at is null, 'supersedesId', v.supersedes_id,
        'barcode', (select b.code from biz.barcode b where b.tenant_id = v.tenant_id and b.package_version_id = v.id))
        order by v.created_at, v.id)
      from biz.package_version v where v.tenant_id = p.tenant_id and v.product_id = p.id), '[]'::jsonb),
    'stockBase', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.q) from (
        select b.status, sum(b.qty::bigint * v.factor) q from biz.stock_balance b
          join biz.package_version v on v.tenant_id = b.tenant_id and v.id = b.package_version_id
         where b.tenant_id = p.tenant_id and b.product_id = p.id group by b.status) s), '{}'::jsonb),
    'costStatus', case when exists (select 1 from biz.cost_pool c where c.tenant_id = p.tenant_id and c.product_id = p.id and c.unverified)
                       then 'UNVERIFIED' else 'VERIFIED' end,
    'openingEventId', (select e.id from biz.inventory_event e where e.tenant_id = p.tenant_id and e.product_id = p.id and e.kind = 'OPENING'))
  from biz.product p where p.tenant_id = p_tenant and p.id = p_id
$$;

-- Mencatat satu kode barcode; duplikat dalam toko -> BARCODE_DUPLICATE.
create function app.put_barcode(p_tenant uuid, p_code text, p_product uuid, p_package uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_code is null then return; end if;
  insert into biz.barcode (tenant_id, code, product_id, package_version_id) values (p_tenant, p_code, p_product, p_package);
exception when unique_violation then
  raise exception 'BARCODE_DUPLICATE' using errcode = 'P0001';
end $$;

-- POST /products: produk + varian + barcode + stok awal + nilai pembukaan dalam SATU transaksi.
-- p_body sudah divalidasi skema di backend; aturan bisnis & invarian ditegakkan ulang di sini.
create function app.product_create(p_key uuid, p_hash bytea, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_idem record; v_pid uuid; v_loc uuid; v_event uuid; v_tz text; v_today date;
  pk jsonb; ln jsonb; v_pkgs jsonb := '{}'::jsonb; v_pkg uuid; v_factor integer; v_batch uuid;
  v_qty integer; v_base bigint; v_cost bigint; v_basis text; v_exp date; v_bnum text; v_now timestamptz := clock_timestamp();
  v_resp jsonb; v_lines integer := 0;
begin
  select * into a from iam.current_actor();
  if a.effective_status <> 'ACTIVE' then                                                   -- @kontrol:LOCK_CATALOG
    raise exception 'TENANT_LOCKED' using errcode = 'P0001';                               -- @kontrol:LOCK_CATALOG
  end if;                                                                                  -- @kontrol:LOCK_CATALOG
  if p_key is null or p_hash is null or octet_length(p_hash) <> 32 or p_body is null
     or jsonb_typeof(p_body) <> 'object' then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;

  -- Idempotensi: baris kunci dibuat dulu; permintaan serentak dengan kunci sama menunggu baris ini.
  insert into biz.idempotency (tenant_id, operation, key, request_hash)
  values (a.tenant_id, 'product.create', p_key, p_hash)
  on conflict (tenant_id, operation, key) do nothing;
  if not found then
    select i.* into v_idem from biz.idempotency i
     where i.tenant_id = a.tenant_id and i.operation = 'product.create' and i.key = p_key for update;
    if v_idem.request_hash <> p_hash then                                                  -- @kontrol:IDEM_HASH
      raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH' using errcode = 'P0001';              -- @kontrol:IDEM_HASH
    end if;                                                                                -- @kontrol:IDEM_HASH
    return v_idem.response || '{"replayed": true}'::jsonb;
  end if;

  -- Lokasi sah milik toko (RLS) dan aktif; bawaan = satu-satunya lokasi aktif.
  if p_body ? 'locationId' then
    select l.id into v_loc from platform.location l where l.id = (p_body->>'locationId')::uuid and l.active;
  else
    select l.id into v_loc from platform.location l where l.active limit 1;
  end if;
  if v_loc is null then
    raise exception 'LOCATION_INVALID' using errcode = 'P0001';
  end if;
  select t.timezone into v_tz from platform.tenant t where t.id = a.tenant_id;
  v_today := (v_now at time zone v_tz)::date;

  begin
    insert into biz.product (tenant_id, sku, name, category, is_subsidized, brand, base_unit, created_by)
    values (a.tenant_id, p_body->>'sku', p_body->>'name', p_body->>'category',
            coalesce((p_body->>'subsidized')::boolean, false), p_body->>'brand', p_body->>'baseUnit', a.user_id)
    returning id into v_pid;
  exception when unique_violation then
    raise exception 'SKU_DUPLICATE' using errcode = 'P0001';
  end;
  perform app.put_barcode(a.tenant_id, p_body->>'barcode', v_pid, null);

  -- Varian kemasan (minimal satu).
  if jsonb_typeof(p_body->'packages') <> 'array' or jsonb_array_length(p_body->'packages') = 0 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  for pk in select * from jsonb_array_elements(p_body->'packages') loop
    if v_pkgs ? (pk->>'key') then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    insert into biz.package_version (tenant_id, product_id, label, form, factor, may_open)
    values (a.tenant_id, v_pid, pk->>'label', pk->>'form', (pk->>'factor')::integer, coalesce((pk->>'mayOpen')::boolean, false))
    returning id into v_pkg;
    perform app.put_barcode(a.tenant_id, pk->>'barcode', v_pid, v_pkg);
    v_pkgs := v_pkgs || jsonb_build_object(pk->>'key', jsonb_build_object('id', v_pkg, 'factor', (pk->>'factor')::integer));
  end loop;

  -- Stok awal wajib (PRD-03); boleh nol. Tepat satu peristiwa OPENING per produk (PRD-04).
  if jsonb_typeof(p_body->'opening') <> 'array' or jsonb_array_length(p_body->'opening') = 0 then
    raise exception 'OPENING_REQUIRED' using errcode = 'P0001';
  end if;
  insert into biz.inventory_event (tenant_id, kind, product_id, location_id, actor_user_id, event_at, idempotency_key)
  values (a.tenant_id, 'OPENING', v_pid, v_loc, a.user_id, v_now, p_key)
  returning id into v_event;

  for ln in select * from jsonb_array_elements(p_body->'opening') loop
    v_lines := v_lines + 1;
    if not (v_pkgs ? (ln->>'packageKey')) then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    v_pkg := (v_pkgs->(ln->>'packageKey')->>'id')::uuid;
    v_factor := (v_pkgs->(ln->>'packageKey')->>'factor')::integer;
    v_qty := (ln->>'qty')::integer;
    if v_qty is null or v_qty < 0 then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    v_base := v_qty::bigint * v_factor;

    -- INV-03: tanggal kedaluwarsa divalidasi di backend database; batch kedaluwarsa tidak boleh siap jual.
    v_bnum := ln->'batch'->>'number';
    v_exp := (ln->'batch'->>'expiresOn')::date;
    if v_exp is not null and v_exp < v_today then
      raise exception 'BATCH_EXPIRED' using errcode = 'P0001';
    end if;
    insert into biz.batch (tenant_id, product_id, batch_number, expires_on) values (a.tenant_id, v_pid, v_bnum, v_exp)
      on conflict (tenant_id, product_id, batch_number, expires_on) do nothing;
    select b.id into v_batch from biz.batch b
     where b.tenant_id = a.tenant_id and b.product_id = v_pid
       and b.batch_number is not distinct from v_bnum and b.expires_on is not distinct from v_exp;

    -- PRD-07 / COST-06: basis biaya pembukaan.
    v_basis := ln->'cost'->>'basis';
    v_cost := (ln->'cost'->>'totalIdr')::bigint;
    if v_basis = 'KNOWN' then
      if v_cost is null or v_cost < 0 or (v_qty > 0 and v_cost = 0) or (v_qty = 0 and v_cost <> 0) then
        raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
      end if;
    elsif v_basis = 'BONUS_ZERO' then
      if v_qty = 0 or coalesce(v_cost, 0) <> 0 or ln->'cost'->>'reason' is null or ln->'cost'->>'origin' is null then
        raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
      end if;
      v_cost := 0;
    elsif v_basis = 'UNVERIFIED' then
      if v_qty = 0 or v_cost is not null then
        raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
      end if;
      v_cost := 0;
    else
      raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
    end if;

    insert into biz.inventory_ledger (tenant_id, event_id, movement, location_id, product_id, package_version_id,
                                      batch_id, status, qty_delta, qty_base_delta, actor_user_id, event_at)
    values (a.tenant_id, v_event, 'OPENING', v_loc, v_pid, v_pkg, v_batch, 'SALEABLE', v_qty, v_base, a.user_id, v_now);
    insert into biz.stock_balance (tenant_id, location_id, product_id, package_version_id, batch_id, status, qty)
    values (a.tenant_id, v_loc, v_pid, v_pkg, v_batch, 'SALEABLE', v_qty)
    on conflict (tenant_id, location_id, product_id, package_version_id, batch_id, status)
    do update set qty = biz.stock_balance.qty + excluded.qty, version = biz.stock_balance.version + 1;

    insert into biz.value_ledger (tenant_id, event_id, location_id, product_id, status, qty_base_delta, value_delta,
                                  cost_basis, basis_reason, basis_origin, actor_user_id, event_at)
    values (a.tenant_id, v_event, v_loc, v_pid, 'SALEABLE', v_base, v_cost, v_basis,
            ln->'cost'->>'reason', ln->'cost'->>'origin', a.user_id, v_now);
    insert into biz.cost_pool (tenant_id, location_id, product_id, status, qty_base, value_idr, unverified)
    values (a.tenant_id, v_loc, v_pid, 'SALEABLE', v_base, v_cost, v_basis = 'UNVERIFIED')
    on conflict (tenant_id, location_id, product_id, status)
    do update set qty_base = biz.cost_pool.qty_base + excluded.qty_base,
                  value_idr = biz.cost_pool.value_idr + excluded.value_idr,
                  unverified = biz.cost_pool.unverified or excluded.unverified,
                  version = biz.cost_pool.version + 1;
  end loop;

  perform app.audit(a.tenant_id, a.user_id, 'PRODUCT_CREATED', 'product', v_pid, jsonb_build_object('role', a.role));
  perform app.audit(a.tenant_id, a.user_id, 'OPENING_POSTED', 'inventory_event', v_event, jsonb_build_object('lines', v_lines));

  v_resp := jsonb_build_object('productId', v_pid, 'openingEventId', v_event);
  update biz.idempotency i set response = v_resp
   where i.tenant_id = a.tenant_id and i.operation = 'product.create' and i.key = p_key;
  return v_resp;
end $$;

create function app.product_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v jsonb;
begin
  select * into a from iam.current_actor();
  v := app.product_view(a.tenant_id, p_id);
  if v is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  return v;
end $$;

create function app.product_list(p_search text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record;
begin
  select * into a from iam.current_actor();
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'category', p.category,
                                        'subsidized', p.is_subsidized, 'active', p.is_active, 'version', p.version,
                                        'posEligible', p.is_active and not p.is_subsidized) order by p.name, p.id)
      from (select * from biz.product p
             where p.tenant_id = a.tenant_id
               and (p_search is null or p.name ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                    or upper(p.sku) = upper(p_search))
             order by p.name, p.id limit p_limit offset p_offset) p), '[]'::jsonb));
end $$;

-- PATCH /products/{id}: hanya field yang boleh diubah; stok awal tidak bisa ditimpa (PRD-04);
-- faktor varian yang sudah punya histori stok dikunci (PRD-05) — buat varian baru lalu pensiunkan yang lama.
create function app.product_update(p_id uuid, p_expected_version bigint, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; p record; pk jsonb; v_pkg uuid; v_ver record; v_has_stock boolean;
begin
  select * into a from iam.current_actor();
  if a.effective_status <> 'ACTIVE' then                                                   -- @kontrol:LOCK_CATALOG
    raise exception 'TENANT_LOCKED' using errcode = 'P0001';                               -- @kontrol:LOCK_CATALOG
  end if;                                                                                  -- @kontrol:LOCK_CATALOG
  select * into p from biz.product x where x.tenant_id = a.tenant_id and x.id = p_id for update;
  if p.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_expected_version is null or p.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update biz.product x set
    name = coalesce(p_patch->>'name', x.name),
    brand = case when p_patch ? 'brand' then p_patch->>'brand' else x.brand end,
    category = coalesce(p_patch->>'category', x.category),
    is_active = coalesce((p_patch->>'active')::boolean, x.is_active),
    updated_at = clock_timestamp(), version = x.version + 1
   where x.tenant_id = a.tenant_id and x.id = p_id;

  if p_patch ? 'barcode' then
    delete from biz.barcode b where b.tenant_id = a.tenant_id and b.product_id = p_id and b.package_version_id is null;
    perform app.put_barcode(a.tenant_id, p_patch->>'barcode', p_id, null);
  end if;

  for pk in select * from jsonb_array_elements(coalesce(p_patch->'packages'->'update', '[]'::jsonb)) loop
    select v.* into v_ver from biz.package_version v
     where v.tenant_id = a.tenant_id and v.product_id = p_id and v.id = (pk->>'id')::uuid for update;
    if v_ver.id is null then
      raise exception 'NOT_FOUND' using errcode = 'P0001';
    end if;
    if pk ? 'factor' and (pk->>'factor')::integer <> v_ver.factor then
      if exists (select 1 from biz.inventory_ledger l where l.tenant_id = a.tenant_id and l.package_version_id = v_ver.id and l.qty_delta <> 0)
         or exists (select 1 from biz.stock_balance b where b.tenant_id = a.tenant_id and b.package_version_id = v_ver.id and b.qty <> 0) then
        raise exception 'PACKAGE_FACTOR_LOCKED' using errcode = 'P0001';                   -- @kontrol:FACTOR_LOCK
      end if;
    end if;
    update biz.package_version v set
      label = coalesce(pk->>'label', v.label),
      factor = coalesce((pk->>'factor')::integer, v.factor),
      may_open = coalesce((pk->>'mayOpen')::boolean, v.may_open)
     where v.tenant_id = a.tenant_id and v.id = v_ver.id;
    if pk ? 'barcode' then
      delete from biz.barcode b where b.tenant_id = a.tenant_id and b.package_version_id = v_ver.id;
      perform app.put_barcode(a.tenant_id, pk->>'barcode', p_id, v_ver.id);
    end if;
  end loop;

  for pk in select * from jsonb_array_elements(coalesce(p_patch->'packages'->'add', '[]'::jsonb)) loop
    if pk ? 'supersedesId' and not exists (select 1 from biz.package_version v where v.tenant_id = a.tenant_id
                                             and v.product_id = p_id and v.id = (pk->>'supersedesId')::uuid) then
      raise exception 'NOT_FOUND' using errcode = 'P0001';
    end if;
    insert into biz.package_version (tenant_id, product_id, label, form, factor, may_open, supersedes_id)
    values (a.tenant_id, p_id, pk->>'label', pk->>'form', (pk->>'factor')::integer,
            coalesce((pk->>'mayOpen')::boolean, false), (pk->>'supersedesId')::uuid)
    returning id into v_pkg;
    perform app.put_barcode(a.tenant_id, pk->>'barcode', p_id, v_pkg);
    perform app.audit(a.tenant_id, a.user_id, 'PACKAGE_ADDED', 'package_version', v_pkg, '{}'::jsonb);
  end loop;

  -- Pensiunkan varian (histori tetap). Hanya bila tidak ada stok tersisa pada varian itu.
  for pk in select * from jsonb_array_elements(coalesce(p_patch->'packages'->'retire', '[]'::jsonb)) loop
    select exists (select 1 from biz.stock_balance b where b.tenant_id = a.tenant_id
                     and b.package_version_id = (pk#>>'{}')::uuid and b.qty > 0) into v_has_stock;
    if v_has_stock then
      raise exception 'PACKAGE_HAS_STOCK' using errcode = 'P0001';
    end if;
    update biz.package_version v set superseded_at = clock_timestamp()
     where v.tenant_id = a.tenant_id and v.product_id = p_id and v.id = (pk#>>'{}')::uuid and v.superseded_at is null;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'P0001';
    end if;
  end loop;
  if not exists (select 1 from biz.package_version v where v.tenant_id = a.tenant_id and v.product_id = p_id and v.superseded_at is null) then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;

  perform app.audit(a.tenant_id, a.user_id, 'PRODUCT_UPDATED', 'product', p_id, jsonb_build_object('role', a.role));
  return app.product_view(a.tenant_id, p_id);
end $$;

-- GET /inventory/stock: proyeksi saldo per lokasi/produk/varian/batch/status + total setara satuan dasar.
-- Bukan sumber kebenaran checkout final (API Contract).
create function app.stock_list(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record;
begin
  select * into a from iam.current_actor();
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'locationId', b.location_id, 'productId', b.product_id, 'packageVersionId', b.package_version_id,
        'packageLabel', v.label, 'form', v.form, 'factor', v.factor, 'batchId', b.batch_id,
        'batchNumber', bt.batch_number, 'expiresOn', bt.expires_on, 'status', b.status, 'qty', b.qty,
        'qtyBase', b.qty::bigint * v.factor) order by b.product_id, v.created_at, bt.expires_on nulls last, b.status)
      from biz.stock_balance b
      join biz.package_version v on v.tenant_id = b.tenant_id and v.id = b.package_version_id
      join biz.batch bt on bt.tenant_id = b.tenant_id and bt.id = b.batch_id
     where b.tenant_id = a.tenant_id and (p_product is null or b.product_id = p_product)), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(jsonb_build_object('productId', t.product_id, 'status', t.status,
        'qtyBase', t.q, 'costStatus', t.cs) order by t.product_id, t.status)
      from (select b.product_id, b.status, sum(b.qty::bigint * v.factor) q,
                   case when bool_or(coalesce(c.unverified, false)) then 'UNVERIFIED' else 'VERIFIED' end cs
              from biz.stock_balance b
              join biz.package_version v on v.tenant_id = b.tenant_id and v.id = b.package_version_id
              left join biz.cost_pool c on c.tenant_id = b.tenant_id and c.location_id = b.location_id
                                       and c.product_id = b.product_id and c.status = b.status
             where b.tenant_id = a.tenant_id and (p_product is null or b.product_id = p_product)
             group by b.product_id, b.status) t), '[]'::jsonb));
end $$;

-- INV-09: rekonsiliasi saldo & kolam biaya terhadap ledger. Ketidakcocokan dicatat sebagai alert;
-- ledger dan saldo TIDAK diubah.
create function app.inventory_reconcile() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_stock jsonb; v_value jsonb; v_base jsonb;
begin
  select * into a from iam.current_actor();
  select coalesce(jsonb_agg(m), '[]'::jsonb) into v_stock from (
    select coalesce(b.product_id, l.product_id) product_id, coalesce(b.package_version_id, l.package_version_id) package_version_id,
           coalesce(b.batch_id, l.batch_id) batch_id, coalesce(b.status, l.status) status,
           coalesce(b.qty, 0) balance_qty, coalesce(l.q, 0) ledger_qty
      from (select * from biz.stock_balance where tenant_id = a.tenant_id) b
      full join (select location_id, product_id, package_version_id, batch_id, status, sum(qty_delta) q
                   from biz.inventory_ledger where tenant_id = a.tenant_id
                  group by location_id, product_id, package_version_id, batch_id, status) l
        on l.location_id = b.location_id and l.product_id = b.product_id and l.package_version_id = b.package_version_id
       and l.batch_id = b.batch_id and l.status = b.status
     where coalesce(b.qty, 0) <> coalesce(l.q, 0)) m;
  select coalesce(jsonb_agg(m), '[]'::jsonb) into v_value from (
    select coalesce(c.product_id, l.product_id) product_id, coalesce(c.status, l.status) status,
           coalesce(c.qty_base, 0) pool_qty, coalesce(l.q, 0) ledger_qty, coalesce(c.value_idr, 0) pool_value, coalesce(l.v, 0) ledger_value
      from (select * from biz.cost_pool where tenant_id = a.tenant_id) c
      full join (select location_id, product_id, status, sum(qty_base_delta) q, sum(value_delta) v
                   from biz.value_ledger where tenant_id = a.tenant_id group by location_id, product_id, status) l
        on l.location_id = c.location_id and l.product_id = c.product_id and l.status = c.status
     where coalesce(c.qty_base, 0) <> coalesce(l.q, 0) or coalesce(c.value_idr, 0) <> coalesce(l.v, 0)) m;
  select coalesce(jsonb_agg(m), '[]'::jsonb) into v_base from (
    select l.id ledger_id, l.qty_delta, l.qty_base_delta, v.factor
      from biz.inventory_ledger l join biz.package_version v on v.tenant_id = l.tenant_id and v.id = l.package_version_id
     where l.tenant_id = a.tenant_id and l.qty_base_delta <> l.qty_delta::bigint * v.factor) m;

  if jsonb_array_length(v_stock) > 0 then
    insert into biz.inventory_alert (tenant_id, kind, detail, detected_by) values (a.tenant_id, 'STOCK_MISMATCH', v_stock, a.user_id);
  end if;
  if jsonb_array_length(v_value) > 0 then
    insert into biz.inventory_alert (tenant_id, kind, detail, detected_by) values (a.tenant_id, 'VALUE_MISMATCH', v_value, a.user_id);
  end if;
  if jsonb_array_length(v_base) > 0 then
    insert into biz.inventory_alert (tenant_id, kind, detail, detected_by) values (a.tenant_id, 'BASE_MISMATCH', v_base, a.user_id);
  end if;
  return jsonb_build_object('ok', jsonb_array_length(v_stock) + jsonb_array_length(v_value) + jsonb_array_length(v_base) = 0,
                            'stockMismatches', v_stock, 'valueMismatches', v_value, 'baseMismatches', v_base);
end $$;
reset role;

revoke execute on all functions in schema app from public;
grant execute on function app.product_create(uuid, bytea, jsonb), app.product_get(uuid), app.product_list(text, integer, integer),
  app.product_update(uuid, bigint, jsonb), app.stock_list(uuid), app.inventory_reconcile() to app_runtime;
-- @mutasi:BIZ_GRANT grant update on biz.stock_balance to app_runtime;
