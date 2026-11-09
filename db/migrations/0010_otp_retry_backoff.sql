-- 0010: Issue #5 — jeda bertahap (backoff) untuk pengiriman ulang OTP + jejak audit status pengiriman.
--
-- Sebelumnya pekerjaan yang gagal langsung bisa diambil lagi pada putaran berikutnya, sehingga bila penyedia
-- OTP mati lama, jatah otp_dispatch_max_attempts habis dalam hitungan detik. Sekarang:
--   * gagal ke-n (masih ada jatah) -> QUEUED dengan next_attempt_at = sekarang + min(maks, dasar × 2^(n-1)) detik;
--   * klaim hanya mengambil QUEUED yang sudah jatuh tempo (atau lease yang habis karena worker mati);
--   * jatah habis -> FAILED; challenge kedaluwarsa/terpakai/batal -> EXPIRED (tidak dikirim);
--   * setiap kegagalan & penghentian dicatat di iam.auth_event TANPA nomor HP atau kode.
-- Parameter baru otp_dispatch_backoff_base_seconds & otp_dispatch_backoff_max_seconds: nilai produksi menunggu
-- keputusan Edgar; produksi menolak start bila kosong atau TEST_ONLY (iam.security_params_status).
--
-- Penanda uji mutasi: "-- @kontrol:NAMA" (dihapus saat mutasi), "-- @mutasi:NAMA " (diaktifkan).

set role migration_owner;
alter table iam.otp_outbox add column next_attempt_at timestamptz;
drop index iam.otp_outbox_ready;
create index otp_outbox_ready on iam.otp_outbox (coalesce(next_attempt_at, created_at)) where status in ('QUEUED', 'LEASED');

alter table iam.security_param drop constraint security_param_key_check;
alter table iam.security_param add constraint security_param_key_check check (key in (
  'otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
  'otp_send_max_per_window', 'otp_send_window_seconds',
  'login_max_failures', 'login_window_seconds',
  'ip_max_requests', 'ip_window_seconds',
  'session_ttl_seconds', 'max_active_sessions_per_user',
  'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds',
  'otp_dispatch_lease_seconds', 'otp_dispatch_max_attempts', 'reauth_ttl_seconds',
  'otp_dispatch_backoff_base_seconds', 'otp_dispatch_backoff_max_seconds'));
reset role;

set role auth_fn_owner;

create or replace function iam.otp_dispatch_claim(p_limit integer)
returns table (r_job uuid, r_lease bytea, r_purpose text, r_phone text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_now timestamptz := pg_catalog.clock_timestamp();
begin
  update iam.otp_outbox o set status = 'EXPIRED', lease_token = null, lease_until = null
    from iam.otp_challenge c
   where c.id = o.challenge_id and o.status in ('QUEUED', 'LEASED')
     and (c.used_at is not null or c.voided_at is not null
          or c.expires_at <= v_now                                                       -- @kontrol:OTP_EXPIRY
         )
     and (o.status = 'QUEUED' or o.lease_until < v_now);

  return query
  with picked as (
    select o.id from iam.otp_outbox o
      join iam.otp_challenge c on c.id = o.challenge_id
     where ((o.status = 'QUEUED'
             and (o.next_attempt_at is null or o.next_attempt_at <= v_now)              -- @kontrol:OTP_BACKOFF
            )
            or (o.status = 'LEASED' and o.lease_until < v_now))
       and o.send_attempts < iam.param('otp_dispatch_max_attempts')
       and c.used_at is null and c.voided_at is null
       and c.expires_at > v_now                                                          -- @kontrol:OTP_EXPIRY
     order by coalesce(o.next_attempt_at, o.created_at), o.id
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update of o skip locked)
  update iam.otp_outbox o set status = 'LEASED', send_attempts = o.send_attempts + 1,
         lease_token = ext.gen_random_bytes(32),
         lease_until = v_now + pg_catalog.make_interval(secs => iam.param('otp_dispatch_lease_seconds'))
    from picked where o.id = picked.id
  returning o.id, o.lease_token, o.purpose, o.phone_e164;

  -- Habis jatah (termasuk lease yang mati pada percobaan terakhir) -> FAILED, tidak diulang tanpa batas.
  with gone as (
    update iam.otp_outbox o set status = 'FAILED', lease_token = null, lease_until = null, next_attempt_at = null
     where o.send_attempts >= iam.param('otp_dispatch_max_attempts')
       and (o.status = 'QUEUED' or (o.status = 'LEASED' and o.lease_until < v_now))
    returning o.id, o.send_attempts)
  insert into iam.auth_event (tenant_id, actor_user_id, kind, detail)
  select null, null, 'OTP_DISPATCH_GAVE_UP', pg_catalog.jsonb_build_object('job', g.id, 'attempts', g.send_attempts) from gone g;
end $$;

-- Gagal kirim: kembali ke antrean dengan jeda bertahap bila jatah masih ada, selain itu FAILED. Diaudit.
create or replace function iam.otp_dispatch_fail(p_job uuid, p_lease bytea) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_now timestamptz := pg_catalog.clock_timestamp(); v_n integer; v_max bigint := iam.param('otp_dispatch_max_attempts');
        v_delay numeric; v_status text;
begin
  select o.send_attempts into v_n from iam.otp_outbox o
   where o.id = p_job and o.status = 'LEASED' and o.lease_token = p_lease for update;
  if v_n is null then
    return false;
  end if;
  v_delay := least(iam.param('otp_dispatch_backoff_max_seconds')::numeric,
                   iam.param('otp_dispatch_backoff_base_seconds')::numeric * pg_catalog.power(2::numeric, greatest(v_n - 1, 0)));
  v_status := case when v_n >= v_max then 'FAILED' else 'QUEUED' end;
  update iam.otp_outbox o
     set status = v_status, lease_token = null, lease_until = null, last_failed_at = v_now,
         next_attempt_at = case when v_status = 'QUEUED' then v_now + pg_catalog.make_interval(secs => v_delay::double precision) end
   where o.id = p_job;
  perform iam.audit(null, null, case when v_status = 'FAILED' then 'OTP_DISPATCH_GAVE_UP' else 'OTP_DISPATCH_FAILED' end,
                    pg_catalog.jsonb_build_object('job', p_job, 'attempts', v_n,
                      'retryInSeconds', case when v_status = 'QUEUED' then v_delay end));
  return true;
end $$;

create or replace function iam.security_params_status()
returns table (r_key text, r_present boolean, r_test_only boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select k.key, sp.key is not null, coalesce(sp.test_only, false)
    from pg_catalog.unnest(array['otp_ttl_seconds', 'otp_max_attempts', 'otp_resend_seconds',
              'otp_send_max_per_window', 'otp_send_window_seconds', 'login_max_failures', 'login_window_seconds',
              'ip_max_requests', 'ip_window_seconds', 'session_ttl_seconds', 'max_active_sessions_per_user',
              'password_min_length', 'bcrypt_cost', 'invite_ttl_seconds',
              'otp_dispatch_lease_seconds', 'otp_dispatch_max_attempts', 'reauth_ttl_seconds',
              'otp_dispatch_backoff_base_seconds', 'otp_dispatch_backoff_max_seconds']) as k(key)
    left join iam.security_param sp on sp.key = k.key
$$;
reset role;
