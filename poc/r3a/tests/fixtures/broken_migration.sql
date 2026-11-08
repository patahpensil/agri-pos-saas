-- Migrasi yang SENGAJA salah: setup wajib berhenti dengan exit != 0 (audit R2-03).
create schema app;
create table app.t(id int primary key);
create table app.t(id int primary key);   -- duplikat -> ERROR
