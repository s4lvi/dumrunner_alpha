-- World-status heartbeat for the mission-control server browser.
-- The game server (service role) writes a WorldStatus snapshot
-- (cycle, seconds to perihelion, horde flag, Link HP, deepest floor,
-- player count) into world_status every ~15s while the world is
-- awake, plus on horde start/end and at sleep. The browser derives
-- live/asleep from world_status_at freshness — no explicit flag.

alter table public.servers
  add column if not exists world_status jsonb,
  add column if not exists world_status_at timestamptz;

drop view if exists public.servers_public;

create view public.servers_public
with (security_invoker = on)
as
select
  s.id,
  s.name,
  s.visibility,
  s.max_slots,
  s.owner_id,
  s.created_at,
  s.has_password,
  s.is_paused,
  s.mode,
  s.arena_scene_id,
  coalesce((
    select count(*)::int
    from public.characters c
    where c.server_id = s.id
      and c.last_seen_at > now() - interval '60 seconds'
  ), 0) as player_count,
  s.world_status,
  s.world_status_at
from public.servers s
where s.discord_instance_id is null;

grant select on public.servers_public to authenticated;
