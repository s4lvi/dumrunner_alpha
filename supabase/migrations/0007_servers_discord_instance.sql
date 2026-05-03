-- Bind a server row to a Discord Activity instance. The Activity SDK
-- gives us `instance_id` per voice-call session; we get-or-create a
-- server scoped to that instance so everyone in the call lands on the
-- same world.
alter table public.servers
  add column if not exists discord_instance_id text;

create unique index if not exists servers_discord_instance_idx
  on public.servers (discord_instance_id)
  where discord_instance_id is not null;
