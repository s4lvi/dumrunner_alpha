-- Per-server world configuration. The owner sets these on creation; the
-- game-server process reads them on hydrate and applies the values
-- instead of the global COMBAT defaults.
--
-- Defaults match the alpha tuning (5-min day, 3-day cycle, full-loot
-- bag drops on death) so existing servers behave the same after this
-- migration applies.

alter table public.servers
  add column day_duration_sec int not null default 300
    check (day_duration_sec between 30 and 3600),
  add column days_per_cycle int not null default 3
    check (days_per_cycle between 1 and 7),
  add column drop_items_on_death boolean not null default true;

-- Re-create the public projection so the new fields are visible to the
-- browser without exposing anything sensitive. Drop + recreate keeps the
-- view definition tidy.
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
  day_duration_sec,
  days_per_cycle,
  drop_items_on_death
from public.servers;

grant select on public.servers_public to authenticated;
