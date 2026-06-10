-- Deathmatch mode. `mode='deathmatch'` boots the world bound to a
-- single authored arena scene (no surface, no procgen dungeon, no
-- perihelion clock); PvP damage is on; players respawn at the
-- arena's `dm_spawn` interactables. `arena_scene_id` references a
-- scene file under packages/shared/content/scenes/. The pair is
-- nullable / optional so existing rows keep behaving as 'live'.

alter table public.servers
  add column if not exists mode text not null default 'live'
    check (mode in ('live', 'deathmatch')),
  add column if not exists arena_scene_id text;

-- Sanity: deathmatch rows must point at a scene; live rows must not.
-- We enforce this client-side and in the create action; a DB-level
-- check would also work but coupling it lets older clients without
-- the new columns continue to insert.

-- Rebuild the public projection so the lobby browser can show
-- the mode badge ("DM") + the arena scene id (so a player can see
-- which map a deathmatch server is running before joining).
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
  is_paused,
  mode,
  arena_scene_id
from public.servers
where discord_instance_id is null;

grant select on public.servers_public to authenticated;
