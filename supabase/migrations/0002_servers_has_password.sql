-- Adds a derived has_password boolean to public.servers so the client can
-- show a "locked" indicator without ever receiving the actual hash.
-- Generated columns are computed by Postgres and read like any other column,
-- so they're safe to expose via RLS.

alter table public.servers
  add column has_password boolean
  generated always as (password_hash is not null) stored;
