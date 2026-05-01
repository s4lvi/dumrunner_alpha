-- DÛM RUNNER initial schema.
-- Run this against your Supabase project (SQL editor, or `supabase db push`).

-- ---------- accounts ----------
-- Extends auth.users with our public-facing profile.
create table public.accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 32),
  created_at timestamptz not null default now()
);

-- ---------- servers ----------
create table public.servers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 64),
  owner_id uuid not null references public.accounts(id) on delete cascade,
  visibility text not null check (visibility in ('public', 'private')),
  -- Hashed password / invite code. Optional for public, required for private (enforced in app code).
  password_hash text,
  max_slots int not null check (max_slots between 5 and 10),
  -- Optional world seed for deterministic biome rotation.
  world_seed bigint,
  created_at timestamptz not null default now(),

  -- Game-server registry fields. Populated by the game-server process when it boots/shuts down.
  game_server_host text,
  game_server_port int,
  game_server_status text not null default 'idle'
    check (game_server_status in ('idle', 'starting', 'running', 'stopping')),
  last_active_at timestamptz
);

create index servers_visibility_idx on public.servers (visibility, created_at desc);
create index servers_owner_idx on public.servers (owner_id);

-- ---------- characters ----------
-- One per (account, server). Holds the per-server character state.
create table public.characters (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  pos_x real not null default 0,
  pos_y real not null default 0,
  -- Inventory + equipment serialised as JSON. Will become structured tables when we get past placeholder.
  inventory jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (account_id, server_id)
);

create index characters_server_idx on public.characters (server_id);

-- ---------- world_states ----------
-- Per-server persistent world: base layout, tech tree, dungeon state at last perihelion.
create table public.world_states (
  server_id uuid primary key references public.servers(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- Row Level Security ----------
-- The websocket game server uses the SERVICE ROLE key, which bypasses RLS.
-- These policies are for direct client (browser) access via the anon key.

alter table public.accounts enable row level security;
alter table public.servers enable row level security;
alter table public.characters enable row level security;
alter table public.world_states enable row level security;

-- Accounts: each user can read/write their own row.
create policy "accounts_select_own" on public.accounts
  for select using (auth.uid() = id);
create policy "accounts_insert_self" on public.accounts
  for insert with check (auth.uid() = id);
create policy "accounts_update_own" on public.accounts
  for update using (auth.uid() = id);

-- Servers: anyone authenticated can see public servers; owners can always see/modify their own.
create policy "servers_select_public_or_own" on public.servers
  for select using (visibility = 'public' or owner_id = auth.uid());
create policy "servers_insert_owned" on public.servers
  for insert with check (owner_id = auth.uid());
create policy "servers_update_owner" on public.servers
  for update using (owner_id = auth.uid());
create policy "servers_delete_owner" on public.servers
  for delete using (owner_id = auth.uid());

-- Characters: each account reads its own characters across servers.
-- Writes happen via the game server (service role); we still allow the owning client to read.
create policy "characters_select_own" on public.characters
  for select using (account_id = auth.uid());

-- world_states: no client-side access. Game server uses service role.
-- (No policies created => default deny for anon/authenticated.)
