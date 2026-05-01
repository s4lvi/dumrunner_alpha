-- A safe public projection of the servers table for browser-side queries.
-- The browser only ever needs these columns; selecting from the view instead
-- of the table prevents accidental future leaks of sensitive columns
-- (password_hash, host/port game-server registry fields, etc.).
--
-- security_invoker = on means the view runs under the calling user's
-- privileges, so the underlying table's RLS still applies — users see only
-- public servers + their own.

create view public.servers_public
with (security_invoker = on)
as
select
  id,
  name,
  visibility,
  max_slots,
  owner_id,
  created_at,
  has_password
from public.servers;

grant select on public.servers_public to authenticated;
