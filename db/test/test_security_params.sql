-- TEST_ONLY: parameter keamanan khusus pengujian. BUKAN kebijakan produksi.
-- Nilai produksi wajib ditetapkan Edgar; aplikasi mode produksi menolak start bila ada test_only = true.
insert into iam.security_param (key, value, test_only) values
  ('otp_ttl_seconds',              300, true),
  ('otp_max_attempts',               5, true),
  ('otp_resend_seconds',             1, true),
  ('otp_send_max_per_window',     1000, true),
  ('otp_send_window_seconds',       60, true),
  ('login_max_failures',             5, true),
  ('login_window_seconds',         900, true),
  ('ip_max_requests',           100000, true),
  ('ip_window_seconds',             60, true),
  ('session_ttl_seconds',         3600, true),
  ('max_active_sessions_per_user',   3, true),
  ('password_min_length',           10, true),
  ('bcrypt_cost',                   10, true),
  ('invite_ttl_seconds',           600, true),
  ('otp_dispatch_lease_seconds',     2, true),
  ('otp_dispatch_max_attempts',      3, true),
  ('reauth_ttl_seconds',             5, true),
  ('otp_dispatch_backoff_base_seconds', 1, true),
  ('otp_dispatch_backoff_max_seconds',  2, true)
on conflict (key) do update set value = excluded.value, test_only = true, set_at = now();
