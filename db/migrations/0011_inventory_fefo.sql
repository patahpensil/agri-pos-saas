-- 0011: FEFO (INV-04) — saran batch paling dekat kedaluwarsa, BUKAN reservasi atau finalisasi jual.
-- Keputusan batch fisik tetap pada kasir; POS wajib validasi ulang stok, status, hold dan expiry saat commit.
set role app_fn_owner;

create function app.inventory_fefo(p_product uuid, p_package uuid default null, p_location uuid default null, p_limit integer default 20)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  a record; v_today date; v_items jsonb;
begin
  select * into a from iam.current_actor();
  if p_product is null or not exists (
    select 1 from biz.product p where p.tenant_id = a.tenant_id and p.id = p_product and p.is_active
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'VALIDATION' using errcode = 'P0001';
  end if;
  if p_package is not null and not exists (
    select 1 from biz.package_version v
     where v.tenant_id = a.tenant_id and v.product_id = p_product and v.id = p_package
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_location is not null and not exists (
    select 1 from platform.location l
     where l.tenant_id = a.tenant_id and l.id = p_location and l.active
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  v_today := app.tenant_today(a.tenant_id);
  with eligible as (
    select b.location_id, b.package_version_id, b.batch_id, b.qty, b.version, v.factor,
           bt.batch_number, bt.expires_on
      from biz.stock_balance b
      join biz.package_version v
        on v.tenant_id = b.tenant_id and v.product_id = b.product_id and v.id = b.package_version_id
      join biz.batch bt
        on bt.tenant_id = b.tenant_id and bt.product_id = b.product_id and bt.id = b.batch_id
     where b.tenant_id = a.tenant_id
       and b.product_id = p_product and b.status = 'SALEABLE' and b.qty > 0
       and (p_location is null or b.location_id = p_location)
       and (p_package is null or b.package_version_id = p_package)
       and (bt.expires_on is null or bt.expires_on >= v_today)
       and not app.hold_active(a.tenant_id, b.location_id, b.product_id, b.batch_id) -- @kontrol:FEFO_GUARD
     order by bt.expires_on asc nulls last, bt.batch_number asc nulls last,
              b.batch_id, b.package_version_id, b.location_id
     limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'locationId', location_id, 'packageVersionId', package_version_id,
    'batchId', batch_id, 'batchNumber', batch_number, 'expiresOn', expires_on,
    'availablePackages', qty, 'availableBaseUnits', qty::bigint * factor,
    'stockVersion', version
  ) order by expires_on asc nulls last, batch_number asc nulls last,
             batch_id, package_version_id, location_id), '[]'::jsonb)
    into v_items from eligible;
  return jsonb_build_object('productId', p_product, 'asOfDate', v_today,
                            'suggestions', v_items, 'reservation', false);
end $$;

revoke all on function app.inventory_fefo(uuid, uuid, uuid, integer) from public;
grant execute on function app.inventory_fefo(uuid, uuid, uuid, integer) to app_runtime;
reset role;
