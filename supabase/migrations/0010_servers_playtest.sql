-- Playtest mode flag. When true, a brand-new character on this server
-- spawns with a fat debug inventory (every material + ammo type in
-- bulk, sample attachment instances of each class) and every blueprint
-- in the catalog pre-unlocked. Lets contributors smoke-test new content
-- without grinding the early game first.

alter table public.servers
  add column if not exists is_playtest boolean not null default false;
