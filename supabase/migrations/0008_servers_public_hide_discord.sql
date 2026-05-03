-- Hide Activity-bound servers from the browser view. They should
-- only be reachable via /api/discord/instance from inside Discord;
-- a randomly-named public room from a Discord call has no business
-- showing up in the public lobby.

drop view if exists public.servers_public;

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
from public.servers
where discord_instance_id is null;

grant select on public.servers_public to authenticated;
