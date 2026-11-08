-- Peran layanan autentikasi (identitas & sesi). Tabel iam dibuat di schema.sql.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='auth_svc') then
    create role auth_svc login nosuperuser nobypassrls;
  end if;
end $$;
grant usage on schema iam to auth_svc;
grant usage on schema app to auth_svc;
grant select, insert, update, delete on all tables in schema iam to auth_svc;
grant insert, select on app.tenant to auth_svc;
create policy p_auth_insert on app.tenant for insert to auth_svc with check (true);
create policy p_auth_select on app.tenant for select to auth_svc using (true);
