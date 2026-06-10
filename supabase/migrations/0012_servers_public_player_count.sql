-- Add player_count to the servers_public view so the lobby browser can
-- show "is this server alive?" without an N+1 fan-out from the page
-- handler. Active = characters.last_seen_at within the 60s heartbeat
-- window (same definition the /api/servers/[id]/join capacity check
-- uses). The (server_id, last_seen_at) index from 0005 makes the
-- per-row subselect a small range scan.

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
  ), 0) as player_count
from public.servers s
where s.discord_instance_id is null;

grant select on public.servers_public to authenticated;
