-- 0001: role database, schema, dan ekstensi.
-- Dijalankan oleh admin database (superuser di CI; admin terkelola di cloud).
-- Kata sandi role LOGIN TIDAK diatur di sini; diatur di luar repo oleh operator.

do $$
declare r text;
begin
  -- Pemilik objek: tidak bisa login.
  foreach r in array array['migration_owner', 'auth_fn_owner', 'app_fn_owner'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls', r);
    end if;
  end loop;
  -- Role runtime: bisa login, tanpa hak tabel, tanpa BYPASSRLS.
  foreach r in array array['auth_runtime', 'app_runtime', 'otp_dispatch_runtime'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I login nosuperuser nocreatedb nocreaterole noinherit nobypassrls', r);
    end if;
  end loop;
end $$;

-- Tegaskan atribut (bila role sudah ada dengan atribut lain).
alter role migration_owner nologin nobypassrls nosuperuser;
alter role auth_fn_owner nologin nobypassrls nosuperuser;
alter role app_fn_owner nologin nobypassrls nosuperuser;
alter role auth_runtime nobypassrls nosuperuser;
alter role app_runtime nobypassrls nosuperuser;
alter role otp_dispatch_runtime nobypassrls nosuperuser;

-- Tutup schema public untuk semua role.
revoke create on schema public from public;
revoke all on schema public from public;

create schema if not exists ext authorization migration_owner;
create extension if not exists pgcrypto with schema ext;
-- Fungsi kriptografi hanya untuk pemilik fungsi identitas, bukan PUBLIC.
revoke execute on all functions in schema ext from public;
grant execute on all functions in schema ext to auth_fn_owner;

create schema if not exists platform authorization migration_owner;
create schema if not exists iam authorization migration_owner;
create schema if not exists app authorization migration_owner;

revoke all on schema ext, platform, iam, app from public;
-- Pemilik fungsi butuh USAGE untuk menjangkau objek; runtime hanya butuh USAGE schema fungsi.
grant usage on schema ext, platform, iam, app to auth_fn_owner, app_fn_owner;
grant create on schema iam to auth_fn_owner;
grant create on schema app to app_fn_owner;
grant usage on schema iam to auth_runtime, otp_dispatch_runtime;
grant usage on schema app to app_runtime;

-- Fungsi baru di schema ini tidak otomatis bisa dieksekusi PUBLIC.
alter default privileges for role auth_fn_owner revoke execute on functions from public;
alter default privileges for role app_fn_owner revoke execute on functions from public;
alter default privileges for role migration_owner revoke execute on functions from public;
