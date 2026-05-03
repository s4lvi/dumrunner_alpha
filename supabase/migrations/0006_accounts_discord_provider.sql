-- Discord identity columns on accounts. Web OAuth + Activity SDK both
-- upsert here keyed on discord_sub.
alter table public.accounts
  add column if not exists discord_sub text unique,
  add column if not exists discord_username text,
  add column if not exists discord_avatar text;

create index if not exists accounts_discord_sub_idx
  on public.accounts (discord_sub);
