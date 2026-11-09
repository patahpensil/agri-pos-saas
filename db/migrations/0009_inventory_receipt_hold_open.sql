-- 0009: Inventori — penerimaan stok, buka karton, tahan/lepas, pindah status (karantina/rusak).
-- PRD: INV-01, INV-02, INV-03, INV-05, INV-06, INV-08, INV-09; COST-01, COST-02, COST-05, COST-06.
--
-- Pola sama dengan 0008: semua tabel di biz (tenant_id, FK komposit, FORCE RLS), jalur tulis HANYA lewat
-- fungsi app.* (SECURITY DEFINER milik app_fn_owner). Toko, aktor, dan peran dari iam.current_actor().
--
-- Serialisasi: setiap mutasi inventori mengunci baris produk (FOR NO KEY UPDATE) lebih dulu, lalu baris
-- saldo dan kolam biaya. Dengan begitu tahan-vs-penerimaan dan buka karton serentak tidak saling balapan.
-- Modul checkout nanti WAJIB mengambil kunci produk yang sama sebelum mengurangi stok.
--
-- Pilihan sementara (belum diatur rinci PRD; diajukan ke Edgar, bukan aturan final):
--  * Batch kedaluwarsa hanya boleh diterima ke QUARANTINE atau DAMAGED.
--  * Admin boleh MENAHAN (INV-06, AUTH-05); pindah status lain & pelepasan hanya Owner.
--  * Pemusnahan/write-off tidak ada (COST-07 GATED); retur pemasok, opname, FEFO di luar PR ini.
--
-- Perbaikan audit PR #7:
--  * INV-AUD-01: pelepasan penahanan wajib bukti reautentikasi Owner (sandi diperiksa ulang di database),
--    terikat ke sesi, aksi, dan penahanan; berlaku singkat (parameter reauth_ttl_seconds); sekali pakai.
--  * INV-AUD-02: pemasok WAJIB pada setiap penerimaan (INV-01 "beserta pemasok"); dokumen tetap "jika tersedia".
--  * INV-AUD-03: nomor batch per produk hanya punya SATU tanggal kedaluwarsa; expiry batch tidak bisa diubah.
--  * INV-AUD-04: pindah status ke SALEABLE (dari INSPECTION/QUARANTINE saja) wajib reautentikasi Owner yang
--    terikat pada isi perpindahan; HELD hanya lewat pelepasan; DAMAGED tidak bisa dikeluarkan lewat stock_move.
--
-- Penanda uji mutasi: "-- @kontrol:NAMA" (dihapus saat mutasi), "-- @mutasi:NAMA " (diaktifkan).

set role migration_owner;

-- ------------------------------------------------------------------ perluasan tabel 0008
alter table biz.inventory_event drop constraint inventory_event_kind_check;
alter table biz.inventory_event add constraint inventory_event_kind_check
  check (kind in ('OPENING', 'RECEIPT', 'OPEN_PACKAGE', 'STATUS_MOVE', 'HOLD', 'RELEASE'));
alter table biz.inventory_event add column note text check (note is null or char_length(note) between 1 and 200);

alter table biz.inventory_ledger drop constraint inventory_ledger_movement_check;
alter table biz.inventory_ledger add constraint inventory_ledger_movement_check
  check (movement in ('OPENING', 'RECEIPT', 'OPEN_PACKAGE', 'STATUS_MOVE', 'HOLD', 'RELEASE'));
-- Penerimaan selalu menambah stok fisik.
alter table biz.inventory_ledger add constraint inventory_ledger_receipt_positive
  check (movement <> 'RECEIPT' or (qty_delta > 0 and qty_base_delta > 0));

-- 'MOVE' = nilai yang dipindah antarstatus (COST-05); bukan biaya baru.
alter table biz.value_ledger drop constraint value_ledger_cost_basis_check;
alter table biz.value_ledger add constraint value_ledger_cost_basis_check
  check (cost_basis in ('KNOWN', 'BONUS_ZERO', 'UNVERIFIED', 'MOVE'));

alter table biz.idempotency drop constraint idempotency_operation_check;
alter table biz.idempotency add constraint idempotency_operation_check
  check (operation in ('product.create', 'inventory.receipt', 'inventory.open', 'inventory.move',
                       'inventory.hold', 'inventory.release'));

-- ------------------------------------------------------------------ tabel baru
-- INV-01: header penerimaan (pemasok & dokumen bila ada). Baris kuantitas/biaya ada di ledger.
create table biz.stock_receipt (
  tenant_id       uuid not null,
  event_id        uuid not null,
  product_id      uuid not null,
  location_id     uuid not null,
  supplier_name   text check (supplier_name is null or char_length(supplier_name) between 1 and 120),  -- wajib: lihat stock_receipt_supplier_required
  source_document text check (source_document is null or char_length(source_document) between 1 and 80),
  primary key (tenant_id, event_id),
  foreign key (tenant_id, event_id, product_id, location_id)
    references biz.inventory_event (tenant_id, id, product_id, location_id)
);

-- INV-06: penahanan produk (batch_id null) atau batch. Pelepasan mengisi kolom release_* tepat sekali.
create table biz.stock_hold (
  tenant_id        uuid not null,
  id               uuid not null default gen_random_uuid(),
  location_id      uuid not null,
  product_id       uuid not null,
  batch_id         uuid,
  reason           text not null check (char_length(reason) between 1 and 200),
  held_by          uuid not null references iam.user_account (id),
  held_at          timestamptz not null,
  hold_event_id    uuid not null,
  released_by      uuid references iam.user_account (id),
  released_at      timestamptz,
  release_reason   text check (release_reason is null or char_length(release_reason) between 1 and 200),
  release_event_id uuid,
  primary key (tenant_id, id),
  foreign key (tenant_id, product_id, batch_id) references biz.batch (tenant_id, product_id, id),
  foreign key (tenant_id, hold_event_id, product_id, location_id)
    references biz.inventory_event (tenant_id, id, product_id, location_id),
  foreign key (tenant_id, release_event_id, product_id, location_id)
    references biz.inventory_event (tenant_id, id, product_id, location_id),
  check ((released_at is null) = (released_by is null)
         and (released_at is null) = (release_reason is null)
         and (released_at is null) = (release_event_id is null))
);
create index stock_hold_active on biz.stock_hold (tenant_id, product_id) where released_at is null;

-- (INV-AUD-02) INV-01: setiap penerimaan dicatat beserta pemasoknya; kosong/spasi saja ditolak database.
alter table biz.stock_receipt add constraint stock_receipt_supplier_required check (supplier_name is not null and pg_catalog.btrim(supplier_name) <> '');  -- @kontrol:SUPPLIER_REQUIRED

-- Append-only untuk header penerimaan.
create trigger stock_receipt_append_only before update or delete on biz.stock_receipt for each row execute function iam.reject_change();
create trigger stock_receipt_no_truncate before truncate on biz.stock_receipt for each statement execute function iam.reject_change();

-- stock_hold: satu-satunya perubahan sah = pelepasan sekali (release_* dari kosong menjadi terisi).
create function biz.stock_hold_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'APPEND_ONLY' using errcode = 'P0001';
  end if;
  if old.released_at is not null or new.released_at is null
     or (new.tenant_id, new.id, new.location_id, new.product_id, new.batch_id, new.reason, new.held_by, new.held_at, new.hold_event_id)
        is distinct from
        (old.tenant_id, old.id, old.location_id, old.product_id, old.batch_id, old.reason, old.held_by, old.held_at, old.hold_event_id) then
    raise exception 'APPEND_ONLY' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function biz.stock_hold_guard() from public;
create trigger stock_hold_guard before update or delete on biz.stock_hold for each row execute function biz.stock_hold_guard();
-- SUB-03 lapis kedua (berlaku untuk SEMUA jalur tulis, termasuk fungsi lain di masa depan): ledger umum
-- 'RECEIPT' tidak boleh menambah stok produk bersubsidi. Penerimaan subsidi kelak memakai jenis tersendiri.
create function biz.ledger_subsidy_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.movement = 'RECEIPT' and exists (select 1 from biz.product p
                                           where p.tenant_id = new.tenant_id and p.id = new.product_id and p.is_subsidized) then
    raise exception 'SUBSIDY_RECEIPT_SEPARATE' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function biz.ledger_subsidy_guard() from public;

-- (INV-AUD-03) Identitas batch: satu nomor batch per produk per toko = satu tanggal kedaluwarsa. Penerimaan
-- yang memakai nomor sama dengan expiry berbeda/kosong ditolak (BATCH_EXPIRY_MISMATCH), bukan membentuk
-- batch "baru" yang menyamarkan batch lama. Indeks unik = jaminan akhir bila dua transaksi balapan.
create unique index batch_number_one_expiry on biz.batch (tenant_id, product_id, batch_number) where batch_number is not null;  -- @kontrol:BATCH_IDENTITY
create function biz.batch_identity_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    -- Histori batch tidak boleh diubah diam-diam (termasuk tanggal kedaluwarsa).
    if (new.tenant_id, new.id, new.product_id, new.batch_number, new.expires_on)
       is distinct from (old.tenant_id, old.id, old.product_id, old.batch_number, old.expires_on) then
      raise exception 'IMMUTABLE_FIELD' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.batch_number is not null and exists (
       select 1 from biz.batch b
        where b.tenant_id = new.tenant_id and b.product_id = new.product_id and b.batch_number = new.batch_number
          and b.expires_on is distinct from new.expires_on) then
    raise exception 'BATCH_EXPIRY_MISMATCH' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function biz.batch_identity_guard() from public;
create trigger batch_identity_guard before insert or update on biz.batch for each row execute function biz.batch_identity_guard();  -- @kontrol:BATCH_IDENTITY

-- (INV-AUD-01) Bukti reautentikasi Owner untuk tindakan sensitif. Hanya hash token yang disimpan.
alter table iam.security_param drop constraint security_param_key_check;
alter table iam.security_param add constraint security_param_key_check check (key in (
  'otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
  'otp_send_max_per_window', 'otp_send_window_seconds',
  'login_max_failures', 'login_window_seconds',
  'ip_max_requests', 'ip_window_seconds',
  'session_ttl_seconds', 'max_active_sessions_per_user',
  'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds',
  'otp_dispatch_lease_seconds', 'otp_dispatch_max_attempts', 'reauth_ttl_seconds'));

create table iam.reauth_grant (
  tenant_id  uuid not null references platform.tenant (id),
  id         uuid not null default gen_random_uuid(),
  user_id    uuid not null references iam.user_account (id),
  session_id uuid not null,
  action     text not null check (action in ('inventory.release', 'inventory.move')),
  target_id  uuid not null,
  scope_hash bytea check (scope_hash is null or octet_length(scope_hash) = 32),  -- INV-AUD-04: isi perubahan yang disetujui
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, session_id) references iam.session (tenant_id, id),
  check (expires_at > created_at)
);
-- Satu-satunya perubahan sah: menandai terpakai sekali.
create function iam.reauth_grant_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op <> 'UPDATE' or old.used_at is not null or new.used_at is null
     or (new.tenant_id, new.id, new.user_id, new.session_id, new.action, new.target_id, new.scope_hash, new.token_hash, new.created_at, new.expires_at)
        is distinct from
        (old.tenant_id, old.id, old.user_id, old.session_id, old.action, old.target_id, old.scope_hash, old.token_hash, old.created_at, old.expires_at) then
    raise exception 'APPEND_ONLY' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function iam.reauth_grant_guard() from public;
create trigger reauth_grant_guard before update or delete on iam.reauth_grant for each row execute function iam.reauth_grant_guard();
create trigger reauth_grant_no_truncate before truncate on iam.reauth_grant for each statement execute function iam.reject_change();
create trigger inventory_ledger_subsidy_guard before insert on biz.inventory_ledger for each row execute function biz.ledger_subsidy_guard();  -- @kontrol:SUBSIDY_SPLIT
create trigger stock_hold_no_truncate before truncate on biz.stock_hold for each statement execute function iam.reject_change();
reset role;

grant select, insert on biz.stock_receipt to app_fn_owner;
grant select, insert, update on iam.reauth_grant to auth_fn_owner;
alter table iam.reauth_grant enable row level security;
alter table iam.reauth_grant force row level security;
create policy auth_boundary on iam.reauth_grant for all to auth_fn_owner using (true) with check (true);

-- ------------------------------------------------------------------ reautentikasi Owner (INV-AUD-01)
set role auth_fn_owner;

-- (INV-AUD-04) Sidik jari isi perubahan yang disetujui. Untuk 'inventory.move' hanya perpindahan ke SALEABLE dari
-- INSPECTION/QUARANTINE yang bisa diotorisasi; produk, kemasan, batch, asal, tujuan, jumlah, dan lokasi (bila
-- disebut) ikut di-hash, sehingga token tidak bisa dipakai untuk perpindahan lain. 'inventory.release' tanpa isi.
create function iam.reauth_scope_hash(p_action text, p_scope jsonb) returns bytea
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
  raise exception 'VALIDATION' using errcode = 'P0001';
end $$;

-- POST /auth/reauth: Owner memasukkan ulang sandi untuk SATU aksi pada SATU objek. Sandi diperiksa di database
-- (bcrypt). Percobaan gagal dibatasi per akun dengan parameter login yang sudah ada (login_max_failures,
-- login_window_seconds); hasil gagal dikembalikan sebagai status (bukan exception) agar penghitung ikut tersimpan.
create function iam.reauth_issue(p_password text, p_action text, p_target uuid, p_scope jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; v_h bytea; v_n integer; v_win bigint := iam.param('login_window_seconds'); v_pw text;
        v_tok bytea; v_exp timestamptz; v_scope bytea;
begin
  select * into a from iam.current_actor();
  if a.role is distinct from 'OWNER' then
    raise exception 'FORBIDDEN_ROLE' using errcode = 'P0001';
  end if;
  if p_action is null or p_action not in ('inventory.release', 'inventory.move') or p_target is null then
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

-- Dipanggil fungsi aksi sensitif (bukan runtime). Bukti sah hanya bila: milik pengguna & sesi yang sama,
-- aksi & objek sama, belum kedaluwarsa, belum dipakai. Semua kegagalan memakai satu kode (tidak membocorkan alasan).
create function iam.reauth_consume_scope(p_token text, p_action text, p_target uuid, p_scope jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare a record; g record;
begin
  select * into a from iam.current_actor();
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'REAUTH_REQUIRED' using errcode = 'P0001';
  end if;
  select r.* into g from iam.reauth_grant r where r.token_hash = pg_catalog.sha256(pg_catalog.decode(p_token, 'hex')) for update;
  if g.id is null or g.tenant_id <> a.tenant_id or g.user_id <> a.user_id or g.session_id <> a.session_id
     or g.action <> p_action or g.target_id <> p_target
     or g.scope_hash is distinct from iam.reauth_scope_hash(p_action, p_scope) then
    raise exception 'REAUTH_REQUIRED' using errcode = 'P0001';
  end if;
  if g.expires_at <= pg_catalog.clock_timestamp() then                                      -- @kontrol:REAUTH_EXPIRY
    raise exception 'REAUTH_REQUIRED' using errcode = 'P0001';                              -- @kontrol:REAUTH_EXPIRY
  end if;                                                                                   -- @kontrol:REAUTH_EXPIRY
  if g.used_at is not null then                                                             -- @kontrol:REAUTH_SINGLE_USE
    raise exception 'REAUTH_REQUIRED' using errcode = 'P0001';                              -- @kontrol:REAUTH_SINGLE_USE
  end if;                                                                                   -- @kontrol:REAUTH_SINGLE_USE
  update iam.reauth_grant r set used_at = pg_catalog.clock_timestamp() where r.tenant_id = g.tenant_id and r.id = g.id;  -- @kontrol:REAUTH_SINGLE_USE
  return g.id;
end $$;

-- Pelepasan penahanan (INV-AUD-01): tanpa isi tambahan.
create function iam.reauth_consume(p_token text, p_action text, p_target uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform iam.reauth_consume_scope(p_token, p_action, p_target, null);
end $$;

-- Daftar parameter keamanan wajib (produksi menolak start bila ada yang kosong/test_only) + reauth_ttl_seconds.
create or replace function iam.security_params_status()
returns table (r_key text, r_present boolean, r_test_only boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select k.key, sp.key is not null, coalesce(sp.test_only, false)
    from pg_catalog.unnest(array['otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
              'otp_send_max_per_window', 'otp_send_window_seconds', 'login_max_failures', 'login_window_seconds',
              'ip_max_requests', 'ip_window_seconds', 'session_ttl_seconds', 'max_active_sessions_per_user',
              'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds',
              'otp_dispatch_lease_seconds', 'otp_dispatch_max_attempts', 'reauth_ttl_seconds']) as k(key)
    left join iam.security_param sp on sp.key = k.key
$$;
reset role;
revoke execute on function iam.reauth_issue(text, text, uuid, jsonb), iam.reauth_consume(text, text, uuid),
  iam.reauth_consume_scope(text, text, uuid, jsonb), iam.reauth_scope_hash(text, jsonb) from public;
grant execute on function iam.reauth_issue(text, text, uuid, jsonb), iam.reauth_consume(text, text, uuid),
  iam.reauth_consume_scope(text, text, uuid, jsonb) to app_fn_owner;
grant select, insert, update on biz.stock_hold to app_fn_owner;
do $$
declare t text;
begin
  foreach t in array array['biz.stock_receipt', 'biz.stock_hold'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy app_tenant on %s for all to app_fn_owner using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ fungsi bantu (internal)
set role app_fn_owner;

-- Idempotensi terikat isi: hash dihitung database dari jsonb yang diterima (pelajaran CAT-AUD-03).
-- Mengembalikan NULL bila kunci baru (lanjutkan), atau respons tersimpan + replayed:true.
create function app.idem_claim(p_tenant uuid, p_op text, p_key uuid, p_body jsonb) returns jsonb
language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
declare v_hash bytea; v record;
begin
  if p_key is null or p_body is null or pg_catalog.jsonb_typeof(p_body) <> 'object' then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_hash := pg_catalog.sha256(pg_catalog.convert_to(p_body::text, 'UTF8'));
  insert into biz.idempotency (tenant_id, operation, key, request_hash) values (p_tenant, p_op, p_key, v_hash)
  on conflict (tenant_id, operation, key) do nothing;
  if found then
    return null;
  end if;
  select i.* into v from biz.idempotency i
   where i.tenant_id = p_tenant and i.operation = p_op and i.key = p_key for update;
  if v.request_hash <> v_hash then                                                         -- @kontrol:IDEM_INV
    raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH' using errcode = 'P0001';                -- @kontrol:IDEM_INV
  end if;                                                                                  -- @kontrol:IDEM_INV
  return v.response || '{"replayed": true}'::jsonb;
end $$;

create function app.idem_finish(p_tenant uuid, p_op text, p_key uuid, p_resp jsonb) returns jsonb
language sql volatile set search_path = pg_catalog, pg_temp as $$
  update biz.idempotency i set response = p_resp
   where i.tenant_id = p_tenant and i.operation = p_op and i.key = p_key
  returning p_resp
$$;

-- Toko harus ACTIVE untuk menulis inventori (LOCKED/LOCKED_GRACE = baca saja).
create function app.inv_require_active(p_status text) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p_status is distinct from 'ACTIVE' then
    raise exception 'TENANT_LOCKED' using errcode = 'P0001';
  end if;
end $$;

-- Kunci produk (serialisasi semua mutasi inventori per produk). Produk toko lain = tidak ditemukan (RLS).
create function app.inv_lock_product(p_tenant uuid, p_product uuid) returns void
language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
begin
  perform 1 from biz.product p where p.tenant_id = p_tenant and p.id = p_product for no key update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
end $$;

create function app.inv_location(p_tenant uuid, p_body jsonb) returns uuid
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v uuid;
begin
  if p_body ? 'locationId' then
    select l.id into v from platform.location l where l.tenant_id = p_tenant and l.id = (p_body->>'locationId')::uuid and l.active;
  else
    select l.id into v from platform.location l where l.tenant_id = p_tenant and l.active order by l.id limit 1;
  end if;
  if v is null then
    raise exception 'LOCATION_INVALID' using errcode = 'P0001';
  end if;
  return v;
end $$;

create function app.tenant_today(p_tenant uuid) returns date
language sql stable set search_path = pg_catalog, pg_temp as $$
  select (pg_catalog.clock_timestamp() at time zone t.timezone)::date from platform.tenant t where t.id = p_tenant
$$;

-- Ada penahanan aktif yang mencakup (lokasi, produk, batch)? Penahanan produk (batch null) mencakup semua batch.
create function app.hold_active(p_tenant uuid, p_loc uuid, p_product uuid, p_batch uuid) returns boolean
language sql stable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from biz.stock_hold h
                  where h.tenant_id = p_tenant and h.location_id = p_loc and h.product_id = p_product
                    and h.released_at is null and (h.batch_id is null or h.batch_id = p_batch))
$$;

-- Posting satu baris ledger kuantitas + saldo. Pengurangan tidak boleh membuat stok negatif (INV-08).
create function app.stock_post(p_tenant uuid, p_event uuid, p_movement text, p_loc uuid, p_product uuid, p_pkg uuid,
                               p_batch uuid, p_status text, p_delta integer, p_factor integer, p_actor uuid, p_at timestamptz)
returns void language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
begin
  if p_delta = 0 then
    return;
  end if;
  if p_delta < 0 then
    update biz.stock_balance b set qty = b.qty + p_delta, version = b.version + 1
     where b.tenant_id = p_tenant and b.location_id = p_loc and b.product_id = p_product
       and b.package_version_id = p_pkg and b.batch_id = p_batch and b.status = p_status and b.qty + p_delta >= 0;
    if not found then
      raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001';
    end if;
  else
    insert into biz.stock_balance (tenant_id, location_id, product_id, package_version_id, batch_id, status, qty)
    values (p_tenant, p_loc, p_product, p_pkg, p_batch, p_status, p_delta)
    on conflict (tenant_id, location_id, product_id, package_version_id, batch_id, status)
    do update set qty = biz.stock_balance.qty + excluded.qty, version = biz.stock_balance.version + 1;
  end if;
  insert into biz.inventory_ledger (tenant_id, event_id, movement, location_id, product_id, package_version_id,
                                    batch_id, status, qty_delta, qty_base_delta, actor_user_id, event_at)
  values (p_tenant, p_event, p_movement, p_loc, p_product, p_pkg, p_batch, p_status, p_delta, p_delta::bigint * p_factor, p_actor, p_at);
end $$;

-- Tambah nilai ke kolam biaya status tujuan (penerimaan). COST-01: rata-rata bergerak = nilai/qty kolam.
create function app.pool_add(p_tenant uuid, p_event uuid, p_loc uuid, p_product uuid, p_status text, p_base bigint,
                             p_value bigint, p_basis text, p_reason text, p_origin text, p_actor uuid, p_at timestamptz)
returns void language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
begin
  insert into biz.value_ledger (tenant_id, event_id, location_id, product_id, status, qty_base_delta, value_delta,
                                cost_basis, basis_reason, basis_origin, actor_user_id, event_at)
  values (p_tenant, p_event, p_loc, p_product, p_status, p_base, p_value, p_basis, p_reason, p_origin, p_actor, p_at);
  insert into biz.cost_pool (tenant_id, location_id, product_id, status, qty_base, value_idr, unverified)
  values (p_tenant, p_loc, p_product, p_status, p_base, p_value, p_basis = 'UNVERIFIED')
  on conflict (tenant_id, location_id, product_id, status)
  do update set qty_base = biz.cost_pool.qty_base + excluded.qty_base,
                value_idr = biz.cost_pool.value_idr + excluded.value_idr,
                unverified = biz.cost_pool.unverified or excluded.unverified,
                version = biz.cost_pool.version + 1;
end $$;

-- COST-05 / INV-COST-01: pindah nilai antarstatus = floor(nilai × qty_pindah / qty_kolam); bila seluruh
-- isi kolam dipindah, seluruh nilai ikut. Label "belum terverifikasi" ikut pindah (COST-06).
create function app.pool_move(p_tenant uuid, p_event uuid, p_loc uuid, p_product uuid, p_from text, p_to text,
                              p_base bigint, p_actor uuid, p_at timestamptz)
returns bigint language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
declare s record; v bigint;
begin
  if p_base = 0 then
    return 0;
  end if;
  perform 1 from biz.cost_pool c
   where c.tenant_id = p_tenant and c.location_id = p_loc and c.product_id = p_product and c.status in (p_from, p_to)
   order by c.status for update;
  select c.* into s from biz.cost_pool c
   where c.tenant_id = p_tenant and c.location_id = p_loc and c.product_id = p_product and c.status = p_from;
  if s.qty_base is null or s.qty_base < p_base then
    raise exception 'INVENTORY_INCONSISTENT' using errcode = 'P0001';
  end if;
  v := app.cost_take(s.value_idr, s.qty_base, p_base);
-- @mutasi:MOVE_VALUE v := 0;
  update biz.cost_pool c set qty_base = c.qty_base - p_base, value_idr = c.value_idr - v, version = c.version + 1
   where c.tenant_id = p_tenant and c.location_id = p_loc and c.product_id = p_product and c.status = p_from;
  insert into biz.cost_pool (tenant_id, location_id, product_id, status, qty_base, value_idr, unverified)
  values (p_tenant, p_loc, p_product, p_to, p_base, v, s.unverified)
  on conflict (tenant_id, location_id, product_id, status)
  do update set qty_base = biz.cost_pool.qty_base + excluded.qty_base,
                value_idr = biz.cost_pool.value_idr + excluded.value_idr,
                unverified = biz.cost_pool.unverified or excluded.unverified,
                version = biz.cost_pool.version + 1;
  insert into biz.value_ledger (tenant_id, event_id, location_id, product_id, status, qty_base_delta, value_delta,
                                cost_basis, actor_user_id, event_at)
  values (p_tenant, p_event, p_loc, p_product, p_from, -p_base, -v, 'MOVE', p_actor, p_at),
         (p_tenant, p_event, p_loc, p_product, p_to, p_base, v, 'MOVE', p_actor, p_at);
  return v;
end $$;

create function app.inv_event(p_tenant uuid, p_kind text, p_product uuid, p_loc uuid, p_actor uuid, p_at timestamptz,
                              p_key uuid, p_note text) returns uuid
language sql volatile set search_path = pg_catalog, pg_temp as $$
  insert into biz.inventory_event (tenant_id, kind, product_id, location_id, actor_user_id, event_at, idempotency_key, note)
  values (p_tenant, p_kind, p_product, p_loc, p_actor, p_at, p_key, p_note) returning id
$$;

create function app.inv_reason(p_body jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v text := p_body->>'reason';
begin
  if v is null or pg_catalog.char_length(v) not between 1 and 200 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  return v;
end $$;

-- ------------------------------------------------------------------ POST /inventory/receipts (INV-01)
create function app.inventory_receive(p_key uuid, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_prev jsonb; v_pid uuid; v_loc uuid; v_event uuid; v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date; ln jsonb; pk record; v_batch uuid; v_bnum text; v_exp date; v_status text; v_qty integer;
  v_base bigint; v_cost bigint; v_basis text; v_lines integer := 0; v_resp jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  v_prev := app.idem_claim(a.tenant_id, 'inventory.receipt', p_key, p_body);
  if v_prev is not null then
    return v_prev;
  end if;
  if pg_catalog.jsonb_typeof(p_body->'lines') <> 'array' or pg_catalog.jsonb_array_length(p_body->'lines') not between 1 and 100 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_pid := (p_body->>'productId')::uuid;
  perform app.inv_lock_product(a.tenant_id, v_pid);
  -- SUB-03 / J-06: stok pupuk subsidi hanya bertambah lewat penerimaan inventori bersubsidi (/subsidy/receipts,
  -- modul subsidi terpisah), tidak lewat Tambah Stok umum. Lapis kedua: trigger biz.ledger_subsidy_guard.
  if (select p.is_subsidized from biz.product p where p.tenant_id = a.tenant_id and p.id = v_pid) then        -- @kontrol:SUBSIDY_SPLIT
    raise exception 'SUBSIDY_RECEIPT_SEPARATE' using errcode = 'P0001';                                        -- @kontrol:SUBSIDY_SPLIT
  end if;                                                                                                      -- @kontrol:SUBSIDY_SPLIT
  -- (INV-AUD-02) INV-01: pemasok wajib; tidak ada nilai bawaan/fiktif.
  if pg_catalog.btrim(coalesce(p_body->>'supplierName', '')) = '' then                        -- @kontrol:SUPPLIER_REQUIRED
    raise exception 'SUPPLIER_REQUIRED' using errcode = 'P0001';                              -- @kontrol:SUPPLIER_REQUIRED
  end if;                                                                                     -- @kontrol:SUPPLIER_REQUIRED
  v_loc := app.inv_location(a.tenant_id, p_body);
  v_today := app.tenant_today(a.tenant_id);

  v_event := app.inv_event(a.tenant_id, 'RECEIPT', v_pid, v_loc, a.user_id, v_now, p_key, null);
  insert into biz.stock_receipt (tenant_id, event_id, product_id, location_id, supplier_name, source_document)
  values (a.tenant_id, v_event, v_pid, v_loc, p_body->>'supplierName', p_body->>'sourceDocument');

  for ln in select * from pg_catalog.jsonb_array_elements(p_body->'lines') loop
    v_lines := v_lines + 1;
    select v.id, v.factor into pk from biz.package_version v
     where v.tenant_id = a.tenant_id and v.product_id = v_pid and v.id = (ln->>'packageId')::uuid and v.superseded_at is null;
    if pk.id is null then
      raise exception 'PACKAGE_INVALID' using errcode = 'P0001';
    end if;
    v_qty := (ln->>'qty')::integer;
    v_status := ln->>'status';
    if v_qty is null or v_qty <= 0 or v_status is null
       or v_status not in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE') then
      raise exception 'VALIDATION' using errcode = 'P0001';
    end if;
    v_base := v_qty::bigint * pk.factor;

    -- INV-03: kedaluwarsa divalidasi di database. Barang kedaluwarsa hanya boleh dicatat ke karantina/rusak.
    v_bnum := ln->'batch'->>'number';
    v_exp := (ln->'batch'->>'expiresOn')::date;
    if v_exp is not null and v_exp < v_today and v_status not in ('QUARANTINE', 'DAMAGED') then  -- @kontrol:RECEIPT_EXPIRY
      raise exception 'BATCH_EXPIRED' using errcode = 'P0001';                                   -- @kontrol:RECEIPT_EXPIRY
    end if;                                                                                       -- @kontrol:RECEIPT_EXPIRY
    insert into biz.batch (tenant_id, product_id, batch_number, expires_on) values (a.tenant_id, v_pid, v_bnum, v_exp)
      on conflict (tenant_id, product_id, batch_number, expires_on) do nothing;
    select b.id into v_batch from biz.batch b
     where b.tenant_id = a.tenant_id and b.product_id = v_pid
       and b.batch_number is not distinct from v_bnum and b.expires_on is not distinct from v_exp;

    -- INV-06: selama penahanan aktif, stok baru tidak boleh masuk siap jual pada cakupan itu.
    if v_status = 'SALEABLE' and app.hold_active(a.tenant_id, v_loc, v_pid, v_batch) then      -- @kontrol:HOLD_BLOCK
      raise exception 'HOLD_ACTIVE' using errcode = 'P0001';                                      -- @kontrol:HOLD_BLOCK
    end if;                                                                                       -- @kontrol:HOLD_BLOCK

    -- Basis biaya (PRD-07/COST-06), aturan sama dengan stok awal; qty selalu > 0.
    v_basis := ln->'cost'->>'basis';
    v_cost := (ln->'cost'->>'totalIdr')::bigint;
    if v_basis = 'KNOWN' then
      if v_cost is null or v_cost <= 0 then
        raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
      end if;
    elsif v_basis = 'BONUS_ZERO' then
      if coalesce(v_cost, 0) <> 0 or ln->'cost'->>'reason' is null or ln->'cost'->>'origin' is null then
        raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
      end if;
      v_cost := 0;
    elsif v_basis = 'UNVERIFIED' then
      if v_cost is not null then
        raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
      end if;
      v_cost := 0;
    else
      raise exception 'COST_BASIS_INVALID' using errcode = 'P0001';
    end if;

    perform app.stock_post(a.tenant_id, v_event, 'RECEIPT', v_loc, v_pid, pk.id, v_batch, v_status, v_qty, pk.factor, a.user_id, v_now);
    perform app.pool_add(a.tenant_id, v_event, v_loc, v_pid, v_status, v_base, v_cost, v_basis,
                         ln->'cost'->>'reason', ln->'cost'->>'origin', a.user_id, v_now);
  end loop;

  perform app.audit(a.tenant_id, a.user_id, 'STOCK_RECEIVED', 'inventory_event', v_event,
                    pg_catalog.jsonb_build_object('role', a.role, 'lines', v_lines));
  v_resp := pg_catalog.jsonb_build_object('eventId', v_event, 'productId', v_pid, 'locationId', v_loc, 'lines', v_lines);
  return app.idem_finish(a.tenant_id, 'inventory.receipt', p_key, v_resp);
end $$;

-- ------------------------------------------------------------------ POST /packages/{id}/open (INV-05)
-- Karton tersegel −n, unit lepas +n×isi, batch & status sama. Total setara satuan dasar dan nilai tetap
-- (kolam biaya per satuan dasar per status tidak berubah), jadi tidak ada baris ledger nilai.
create function app.package_open(p_key uuid, p_package uuid, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_prev jsonb; src record; loose record; v_loc uuid; v_batch uuid; v_status text; v_qty integer;
  v_event uuid; v_now timestamptz := pg_catalog.clock_timestamp(); v_resp jsonb; v_body jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  v_body := p_body || pg_catalog.jsonb_build_object('packageId', p_package);
  v_prev := app.idem_claim(a.tenant_id, 'inventory.open', p_key, v_body);
  if v_prev is not null then
    return v_prev;
  end if;
  if (p_body->>'physicalConfirmed')::boolean is distinct from true then
    raise exception 'PHYSICAL_CONFIRMATION_REQUIRED' using errcode = 'P0001';
  end if;
  select v.* into src from biz.package_version v where v.tenant_id = a.tenant_id and v.id = p_package;
  if src.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  perform app.inv_lock_product(a.tenant_id, src.product_id);
  -- PRD-06 / ST-INV-12: kemasan yang tidak boleh dibuka ditolak server, walau dipanggil langsung lewat API.
  if src.form <> 'SEALED' or not src.may_open then                                           -- @kontrol:OPEN_GUARD
    raise exception 'PACKAGE_NOT_OPENABLE' using errcode = 'P0001';                           -- @kontrol:OPEN_GUARD
  end if;                                                                                     -- @kontrol:OPEN_GUARD

  select null::uuid as id into loose;
  if p_body ? 'loosePackageId' then
    select v.* into loose from biz.package_version v
     where v.tenant_id = a.tenant_id and v.product_id = src.product_id and v.id = (p_body->>'loosePackageId')::uuid
       and v.form = 'LOOSE' and v.superseded_at is null;
  elsif (select count(*) from biz.package_version v where v.tenant_id = a.tenant_id and v.product_id = src.product_id
           and v.form = 'LOOSE' and v.superseded_at is null) = 1 then
    select v.* into loose from biz.package_version v
     where v.tenant_id = a.tenant_id and v.product_id = src.product_id and v.form = 'LOOSE' and v.superseded_at is null;
  end if;
  if loose.id is null then
    raise exception 'LOOSE_PACKAGE_REQUIRED' using errcode = 'P0001';
  end if;

  v_loc := app.inv_location(a.tenant_id, p_body);
  v_batch := (p_body->>'batchId')::uuid;
  if not exists (select 1 from biz.batch b where b.tenant_id = a.tenant_id and b.product_id = src.product_id and b.id = v_batch) then
    raise exception 'BATCH_INVALID' using errcode = 'P0001';
  end if;
  v_status := coalesce(p_body->>'status', 'SALEABLE');
  v_qty := coalesce((p_body->>'qty')::integer, 1);
  if v_qty <= 0 or v_qty::bigint * src.factor > 2147483647
     or v_status not in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE') then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;

  v_event := app.inv_event(a.tenant_id, 'OPEN_PACKAGE', src.product_id, v_loc, a.user_id, v_now, p_key, null);
  perform app.stock_post(a.tenant_id, v_event, 'OPEN_PACKAGE', v_loc, src.product_id, src.id, v_batch, v_status, -v_qty, src.factor, a.user_id, v_now);
  perform app.stock_post(a.tenant_id, v_event, 'OPEN_PACKAGE', v_loc, src.product_id, loose.id, v_batch, v_status, v_qty * src.factor, 1, a.user_id, v_now);

  perform app.audit(a.tenant_id, a.user_id, 'PACKAGE_OPENED', 'inventory_event', v_event,
                    pg_catalog.jsonb_build_object('role', a.role, 'cartons', v_qty, 'units', v_qty * src.factor));
  v_resp := pg_catalog.jsonb_build_object('eventId', v_event, 'productId', src.product_id, 'batchId', v_batch,
              'status', v_status, 'sealedDelta', -v_qty, 'looseDelta', v_qty * src.factor, 'loosePackageId', loose.id);
  return app.idem_finish(a.tenant_id, 'inventory.open', p_key, v_resp);
end $$;

-- ------------------------------------------------------------------ POST /inventory/status-moves (Owner)
-- Pindah status fisik. Nilai ikut pindah. Matriks perpindahan (INV-AUD-04, fail-closed):
--   SALEABLE   -> INSPECTION | HELD | QUARANTINE | DAMAGED      (makin ketat; Owner)
--   INSPECTION -> QUARANTINE | HELD | DAMAGED; -> SALEABLE hanya dengan reautentikasi Owner terikat isi
--   QUARANTINE -> HELD | DAMAGED;              -> SALEABLE hanya dengan reautentikasi Owner terikat isi ("lepas karantina")
--   HELD       -> DAMAGED; ke SALEABLE WAJIB lewat pelepasan penahanan (stock_release)
--   DAMAGED    -> (tidak ada; prosedur pemusnahan/retur pemasok belum disahkan)
-- Perpindahan lain ditolak STATUS_MOVE_NOT_ALLOWED agar tidak ada jalan memutar (mis. DAMAGED -> QUARANTINE -> SALEABLE).
create function app.stock_move(p_key uuid, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_prev jsonb; v_pid uuid; v_loc uuid; pk record; bt record; v_from text; v_to text; v_qty integer;
  v_event uuid; v_now timestamptz := pg_catalog.clock_timestamp(); v_val bigint; v_resp jsonb; v_reason text;
  v_grant uuid; v_ref text;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if a.role is distinct from 'OWNER' then                                                   -- @kontrol:OWNER_MOVE
    raise exception 'FORBIDDEN_ROLE' using errcode = 'P0001';                               -- @kontrol:OWNER_MOVE
  end if;                                                                                   -- @kontrol:OWNER_MOVE
  v_prev := app.idem_claim(a.tenant_id, 'inventory.move', p_key, p_body);
  if v_prev is not null then
    return v_prev;
  end if;
  v_reason := app.inv_reason(p_body);
  v_from := p_body->>'from';
  v_to := p_body->>'to';
  v_qty := (p_body->>'qty')::integer;
  if v_from is null or v_to is null or v_from = v_to or v_qty is null or v_qty <= 0
     or v_from not in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE')
     or v_to not in ('SALEABLE', 'INSPECTION', 'HELD', 'DAMAGED', 'QUARANTINE') then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  v_pid := (p_body->>'productId')::uuid;
  perform app.inv_lock_product(a.tenant_id, v_pid);
  v_loc := app.inv_location(a.tenant_id, p_body);
  select v.id, v.factor into pk from biz.package_version v
   where v.tenant_id = a.tenant_id and v.product_id = v_pid and v.id = (p_body->>'packageId')::uuid;
  if pk.id is null then
    raise exception 'PACKAGE_INVALID' using errcode = 'P0001';
  end if;
  select b.id, b.expires_on into bt from biz.batch b
   where b.tenant_id = a.tenant_id and b.product_id = v_pid and b.id = (p_body->>'batchId')::uuid;
  if bt.id is null then
    raise exception 'BATCH_INVALID' using errcode = 'P0001';
  end if;
  v_ref := p_body->>'referenceDocument';
  if v_ref is not null and pg_catalog.char_length(pg_catalog.btrim(v_ref)) not between 1 and 120 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  if v_to = 'SALEABLE' then
    -- Syarat barang tetap berlaku walau token reautentikasi sah.
    if bt.expires_on is not null and bt.expires_on < app.tenant_today(a.tenant_id) then
      raise exception 'BATCH_EXPIRED' using errcode = 'P0001';
    end if;
    if app.hold_active(a.tenant_id, v_loc, v_pid, bt.id) then
      raise exception 'HOLD_ACTIVE' using errcode = 'P0001';
    end if;
    if v_from = 'HELD' then                                                                   -- @kontrol:MOVE_TRANSITION
      raise exception 'HELD_RELEASE_REQUIRED' using errcode = 'P0001';                        -- @kontrol:MOVE_TRANSITION
    end if;                                                                                   -- @kontrol:MOVE_TRANSITION
    if v_from not in ('INSPECTION', 'QUARANTINE') then                                        -- @kontrol:MOVE_TRANSITION
      raise exception 'STATUS_MOVE_NOT_ALLOWED' using errcode = 'P0001';                      -- @kontrol:MOVE_TRANSITION
    end if;                                                                                   -- @kontrol:MOVE_TRANSITION
    -- AUTH-04: bukti reautentikasi baru, sekali pakai, terikat tenant/pengguna/sesi/aksi/batch/isi perpindahan.
    v_grant := iam.reauth_consume_scope(p_body->>'reauthToken', 'inventory.move', bt.id, p_body);  -- @kontrol:MOVE_REAUTH
  elsif v_from = 'DAMAGED' or (v_from = 'HELD' and v_to <> 'DAMAGED')
        or (v_from = 'QUARANTINE' and v_to not in ('HELD', 'DAMAGED'))
        or (v_from = 'INSPECTION' and v_to not in ('QUARANTINE', 'HELD', 'DAMAGED')) then
    raise exception 'STATUS_MOVE_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  v_event := app.inv_event(a.tenant_id, 'STATUS_MOVE', v_pid, v_loc, a.user_id, v_now, p_key, v_reason);
  perform app.stock_post(a.tenant_id, v_event, 'STATUS_MOVE', v_loc, v_pid, pk.id, bt.id, v_from, -v_qty, pk.factor, a.user_id, v_now);
  perform app.stock_post(a.tenant_id, v_event, 'STATUS_MOVE', v_loc, v_pid, pk.id, bt.id, v_to, v_qty, pk.factor, a.user_id, v_now);
  v_val := app.pool_move(a.tenant_id, v_event, v_loc, v_pid, v_from, v_to, v_qty::bigint * pk.factor, a.user_id, v_now);

  perform app.audit(a.tenant_id, a.user_id, 'STOCK_STATUS_MOVED', 'inventory_event', v_event,
                    pg_catalog.jsonb_build_object('from', v_from, 'to', v_to, 'qty', v_qty, 'valueIdr', v_val,
                      'packageVersionId', pk.id, 'batchId', bt.id, 'reason', v_reason, 'referenceDocument', v_ref,
                      'reauthGrantId', v_grant));
  v_resp := pg_catalog.jsonb_build_object('eventId', v_event, 'productId', v_pid, 'from', v_from, 'to', v_to,
              'qty', v_qty, 'qtyBase', v_qty::bigint * pk.factor, 'valueMovedIdr', v_val);
  return app.idem_finish(a.tenant_id, 'inventory.move', p_key, v_resp);
end $$;

-- ------------------------------------------------------------------ POST /inventory/holds (INV-06)
-- Owner/Admin menahan produk atau batch SEGERA: seluruh stok siap jual dalam cakupan pindah ke HELD dalam
-- transaksi yang sama, dan selama penahanan aktif tidak ada stok baru yang boleh masuk siap jual.
create function app.stock_hold(p_key uuid, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_prev jsonb; v_pid uuid; v_loc uuid; v_batch uuid; v_reason text; v_event uuid; v_hold uuid;
  v_now timestamptz := pg_catalog.clock_timestamp(); r record; v_base bigint := 0; v_val bigint; v_resp jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if a.role not in ('OWNER', 'ADMIN') then
    raise exception 'FORBIDDEN_ROLE' using errcode = 'P0001';
  end if;
  v_prev := app.idem_claim(a.tenant_id, 'inventory.hold', p_key, p_body);
  if v_prev is not null then
    return v_prev;
  end if;
  v_reason := app.inv_reason(p_body);
  v_pid := (p_body->>'productId')::uuid;
  perform app.inv_lock_product(a.tenant_id, v_pid);
  v_loc := app.inv_location(a.tenant_id, p_body);
  if p_body ? 'batchId' then
    select b.id into v_batch from biz.batch b
     where b.tenant_id = a.tenant_id and b.product_id = v_pid and b.id = (p_body->>'batchId')::uuid;
    if v_batch is null then
      raise exception 'BATCH_INVALID' using errcode = 'P0001';
    end if;
  end if;

  v_event := app.inv_event(a.tenant_id, 'HOLD', v_pid, v_loc, a.user_id, v_now, p_key, v_reason);
  insert into biz.stock_hold (tenant_id, location_id, product_id, batch_id, reason, held_by, held_at, hold_event_id)
  values (a.tenant_id, v_loc, v_pid, v_batch, v_reason, a.user_id, v_now, v_event) returning id into v_hold;

  for r in select b.package_version_id, b.batch_id, b.qty, v.factor from biz.stock_balance b
             join biz.package_version v on v.tenant_id = b.tenant_id and v.id = b.package_version_id
            where b.tenant_id = a.tenant_id and b.location_id = v_loc and b.product_id = v_pid and b.status = 'SALEABLE'
              and b.qty > 0 and (v_batch is null or b.batch_id = v_batch)
            order by b.package_version_id, b.batch_id loop
    perform app.stock_post(a.tenant_id, v_event, 'HOLD', v_loc, v_pid, r.package_version_id, r.batch_id, 'SALEABLE', -r.qty, r.factor, a.user_id, v_now);
    perform app.stock_post(a.tenant_id, v_event, 'HOLD', v_loc, v_pid, r.package_version_id, r.batch_id, 'HELD', r.qty, r.factor, a.user_id, v_now);
    v_base := v_base + r.qty::bigint * r.factor;
  end loop;
  v_val := app.pool_move(a.tenant_id, v_event, v_loc, v_pid, 'SALEABLE', 'HELD', v_base, a.user_id, v_now);

  perform app.audit(a.tenant_id, a.user_id, 'STOCK_HELD', 'stock_hold', v_hold,
                    pg_catalog.jsonb_build_object('role', a.role, 'batchId', v_batch, 'qtyBase', v_base, 'valueIdr', v_val));
  v_resp := pg_catalog.jsonb_build_object('holdId', v_hold, 'eventId', v_event, 'productId', v_pid, 'batchId', v_batch,
              'heldQtyBase', v_base, 'valueMovedIdr', v_val);
  return app.idem_finish(a.tenant_id, 'inventory.hold', p_key, v_resp);
end $$;

-- ------------------------------------------------------------------ POST /inventory/holds/{id}/release (Owner)
-- Hanya Owner (dicek di sini). Semua stok berstatus HELD dalam cakupan penahanan ini (produk, atau satu batch)
-- dikembalikan ke siap jual, KECUALI batch kedaluwarsa atau yang masih dicakup penahanan aktif lain: itu TETAP
-- ditahan dan dilaporkan di notReleased (tidak dibuang diam-diam). Dengan aturan ini stok tidak bisa "yatim"
-- (tetap HELD padahal semua penahanan sudah dilepas) saat penahanan produk & batch bertumpuk.
create function app.stock_release(p_key uuid, p_hold uuid, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_prev jsonb; h record; v_reason text; v_event uuid; v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date; r record; v_base bigint := 0; v_val bigint;
  v_rel jsonb := '[]'::jsonb; v_not jsonb := '[]'::jsonb; v_resp jsonb;
begin
  select * into a from iam.current_actor();
  perform app.inv_require_active(a.effective_status);
  if a.role is distinct from 'OWNER' then                                                   -- @kontrol:OWNER_RELEASE
    raise exception 'FORBIDDEN_ROLE' using errcode = 'P0001';                               -- @kontrol:OWNER_RELEASE
  end if;                                                                                   -- @kontrol:OWNER_RELEASE
  v_prev := app.idem_claim(a.tenant_id, 'inventory.release', p_key, p_body || pg_catalog.jsonb_build_object('holdId', p_hold));
  if v_prev is not null then
    return v_prev;
  end if;
  v_reason := app.inv_reason(p_body);
  select x.product_id into h from biz.stock_hold x where x.tenant_id = a.tenant_id and x.id = p_hold;
  if h.product_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  -- (INV-AUD-01) AUTH-04: bukti reautentikasi Owner untuk penahanan INI, sekali pakai, belum kedaluwarsa.
  perform iam.reauth_consume(p_body->>'reauthToken', 'inventory.release', p_hold);         -- @kontrol:REAUTH_RELEASE
  perform app.inv_lock_product(a.tenant_id, h.product_id);
  select x.* into h from biz.stock_hold x where x.tenant_id = a.tenant_id and x.id = p_hold for update;
  if h.released_at is not null then
    raise exception 'HOLD_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  v_today := app.tenant_today(a.tenant_id);

  v_event := app.inv_event(a.tenant_id, 'RELEASE', h.product_id, h.location_id, a.user_id, v_now, p_key, v_reason);
  update biz.stock_hold x set released_by = a.user_id, released_at = v_now, release_reason = v_reason, release_event_id = v_event
   where x.tenant_id = a.tenant_id and x.id = p_hold;

  for r in select b.package_version_id, b.batch_id, b.qty q, v.factor, bt.expires_on
             from biz.stock_balance b
             join biz.package_version v on v.tenant_id = b.tenant_id and v.id = b.package_version_id
             join biz.batch bt on bt.tenant_id = b.tenant_id and bt.id = b.batch_id
            where b.tenant_id = a.tenant_id and b.location_id = h.location_id and b.product_id = h.product_id
              and b.status = 'HELD' and b.qty > 0 and (h.batch_id is null or b.batch_id = h.batch_id)
            order by b.package_version_id, b.batch_id loop
    if r.expires_on is not null and r.expires_on < v_today then
      v_not := v_not || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('packageVersionId', r.package_version_id,
                 'batchId', r.batch_id, 'qty', r.q, 'reason', 'BATCH_EXPIRED'));
      continue;
    end if;
    if app.hold_active(a.tenant_id, h.location_id, h.product_id, r.batch_id) then
      v_not := v_not || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('packageVersionId', r.package_version_id,
                 'batchId', r.batch_id, 'qty', r.q, 'reason', 'OTHER_HOLD_ACTIVE'));
      continue;
    end if;
    perform app.stock_post(a.tenant_id, v_event, 'RELEASE', h.location_id, h.product_id, r.package_version_id, r.batch_id, 'HELD', -r.q, r.factor, a.user_id, v_now);
    perform app.stock_post(a.tenant_id, v_event, 'RELEASE', h.location_id, h.product_id, r.package_version_id, r.batch_id, 'SALEABLE', r.q, r.factor, a.user_id, v_now);
    v_base := v_base + r.q::bigint * r.factor;
    v_rel := v_rel || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('packageVersionId', r.package_version_id,
               'batchId', r.batch_id, 'qty', r.q));
  end loop;
  v_val := app.pool_move(a.tenant_id, v_event, h.location_id, h.product_id, 'HELD', 'SALEABLE', v_base, a.user_id, v_now);

  perform app.audit(a.tenant_id, a.user_id, 'STOCK_RELEASED', 'stock_hold', p_hold,
                    pg_catalog.jsonb_build_object('qtyBase', v_base, 'valueIdr', v_val, 'notReleased', v_not));
  v_resp := pg_catalog.jsonb_build_object('holdId', p_hold, 'eventId', v_event, 'releasedQtyBase', v_base,
              'valueMovedIdr', v_val, 'released', v_rel, 'notReleased', v_not);
  return app.idem_finish(a.tenant_id, 'inventory.release', p_key, v_resp);
end $$;

-- POST /auth/reauth: pintu masuk runtime (runtime tidak punya akses schema iam).
create function app.reauth_start(p_password text, p_action text, p_target uuid, p_scope jsonb default null) returns jsonb
language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select iam.reauth_issue(p_password, p_action, p_target, p_scope)
$$;

-- GET /inventory/holds
create function app.hold_list(p_active_only boolean) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record;
begin
  select * into a from iam.current_actor();
  return pg_catalog.jsonb_build_object('items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', h.id, 'productId', h.product_id, 'locationId', h.location_id, 'batchId', h.batch_id,
      'batchNumber', b.batch_number, 'expiresOn', b.expires_on, 'reason', h.reason, 'heldBy', h.held_by,
      'heldAt', h.held_at, 'active', h.released_at is null, 'releasedBy', h.released_by, 'releasedAt', h.released_at,
      'releaseReason', h.release_reason) order by h.held_at desc, h.id)
    from biz.stock_hold h
    left join biz.batch b on b.tenant_id = h.tenant_id and b.id = h.batch_id
   where h.tenant_id = a.tenant_id and (not coalesce(p_active_only, true) or h.released_at is null)), '[]'::jsonb));
end $$;
reset role;

revoke execute on all functions in schema app from public;
grant execute on function app.inventory_receive(uuid, jsonb), app.package_open(uuid, uuid, jsonb), app.stock_move(uuid, jsonb),
  app.stock_hold(uuid, jsonb), app.stock_release(uuid, uuid, jsonb), app.hold_list(boolean) to app_runtime;
grant execute on function app.reauth_start(text, text, uuid, jsonb) to app_runtime;
