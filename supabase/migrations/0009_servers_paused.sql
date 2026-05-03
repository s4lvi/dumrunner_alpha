-- Owner-controlled pause/resume. While `is_paused = true` the game
-- server kicks every connection on its next tick and refuses new
-- joins from anyone but the owner. The owner rejoining (or hitting
-- the resume endpoint) flips the flag back to false.

alter table public.servers
  add column if not exists is_paused boolean not null default false;

-- Re-build the public projection so the lobby browser can see the
-- pause flag (owner needs it to render the Resume button; everyone
-- else just sees "Paused").
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
  has_password,
  is_paused
from public.servers
where discord_instance_id is null;

grant select on public.servers_public to authenticated;
