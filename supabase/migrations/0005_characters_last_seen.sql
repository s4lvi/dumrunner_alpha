-- Track recent character activity so the join-route capacity check can
-- count *active* sessions instead of every character ever created.
-- The game server stamps last_seen_at on ws auth and refreshes it on a
-- 30s heartbeat while connected; the join route filters by
-- last_seen_at > now() - interval '60 seconds'.

alter table public.characters
  add column if not exists last_seen_at timestamptz;

-- Index on (server_id, last_seen_at) makes the active-occupancy count
-- a small range scan instead of a full per-server table scan. Useful as
-- soon as servers start carrying meaningful character history.
create index if not exists characters_server_last_seen_idx
  on public.characters (server_id, last_seen_at);
