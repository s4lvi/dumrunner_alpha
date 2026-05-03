# Discord integration plan (deferred)

Status: **deferred** — pick this back up after the inflight bug list lands.

Two separate things the user wants, on the same Discord app credentials:

- **Discord Activity** — iframe SDK, in-call game launches, instance-id-bound rooms.
- **Discord OAuth login** — non-Activity web sign-in via "Continue with Discord" button on `/login`.

Reference implementation: `/Users/jordansalvi/Projects/historyengine` (auth routes, models,
`client/src/utils/discord.js`, `client/src/components/DiscordActivity.jsx`).

---

## Architecture target

Every Discord identity ends up in `public.accounts` with a `discord_sub`. From there the
existing `/api/servers/[id]/join` flow + JoinToken HMAC still works unchanged — game-server
auth never has to know whether the player came from email/password, Activity, or OAuth.

### Supabase ↔ Discord identity stitch

Two options. **Recommend the JWT approach** for production sanity:

1. **Synthetic email** (~50 LOC, hacky): create a `${discord_sub}@discord.dumrunner` user in
   Supabase Auth on first sight, store a random server-side password in `accounts`, sign in
   on subsequent visits. Reuses Supabase's session machinery wholesale. Easy to ship.
2. **Self-issued JWT** (~150 LOC, clean): mint a JWT signed with `JOIN_TOKEN_SECRET` (or a
   sibling secret) for Discord users. The game server validates either Supabase JWTs OR our
   self-issued ones. Email users stay in Supabase Auth; Discord users skip it entirely. Real
   separation; no fake-email rows in `auth.users`.

The user wants real Discord OAuth login on the web, so the JWT approach is probably right —
it cleanly handles both Activity and non-Activity Discord users.

---

## Phase A — Auth plumbing (no game changes)

### Env vars

| Var | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_DISCORD_CLIENT_ID` | client bundle | Activity SDK + OAuth redirect URL |
| `DISCORD_CLIENT_SECRET` | Vercel server-only | Token exchange |
| `DISCORD_REDIRECT_URI` | Vercel server-only | Web OAuth callback (e.g. `https://dumrunner.app/api/auth/discord/callback`) |

### Migration `0006_accounts_discord_provider.sql`

```sql
alter table public.accounts
  add column if not exists discord_sub text unique,
  add column if not exists discord_username text,
  add column if not exists discord_avatar text;
create index if not exists accounts_discord_sub_idx on public.accounts (discord_sub);
```

### New files

- `packages/client/lib/discord/sdk.ts` — wraps `@discord/embedded-app-sdk`, exports
  `getDiscordSdk()`, `isInDiscordActivity()` (checks `frame_id` query param or
  `*.discordsays.com` host).
- `packages/client/app/api/auth/discord/exchange/route.ts` — POST handler used by **the
  Activity flow**. Body `{code}`. Hits `discord.com/api/oauth2/token` server-side, fetches
  `/users/@me`, upserts into `accounts`, returns a session token (Supabase OR our JWT).
- `packages/client/app/api/auth/discord/callback/route.ts` — GET handler for **the web
  login flow**. Receives `code` + `state` from Discord redirect, runs the same exchange,
  sets the session cookie, redirects to `/servers`.
- `packages/client/app/api/auth/discord/start/route.ts` — GET handler that builds the
  Discord OAuth URL (`https://discord.com/oauth2/authorize?...`) with a CSRF state nonce
  and redirects the browser there.
- `packages/client/app/login/page.tsx` — add "Continue with Discord" button → `/api/auth/discord/start`.

---

## Phase B — Activity instance ↔ game-server linkage

### Schema

```sql
alter table public.servers
  add column if not exists discord_instance_id text;
create unique index if not exists servers_discord_instance_idx
  on public.servers (discord_instance_id) where discord_instance_id is not null;
```

### Endpoint

`packages/client/app/api/discord/instance/route.ts`:

- `POST { instance_id }` → look up `servers` by `discord_instance_id`. If found, return
  `{ server_id }`. If not, create a new server (auto-generated name from Discord channel
  if available, default world config), bind `discord_instance_id`, return `{ server_id }`.
- Owner = the first authed Discord user in the call.
- No password gate — the Activity instance is the gate.

### Client flow

- `packages/client/app/discord/page.tsx`:
  ```
  SDK.ready() → SDK.authorize({scope:['identify']}) → POST /api/auth/discord/exchange
  → POST /api/discord/instance → router.replace(`/play/${server_id}`)
  ```

---

## Phase C — Game server (mostly free)

The ws server already validates JoinTokens. **No change needed** if we use Supabase sessions.
If we go with self-issued JWTs (recommended), the game server's `verifyJoinToken` needs to
also accept the new token kind. Add a small `tokenSource: 'supabase' | 'discord'` field on
the JoinToken payload — handled in `packages/shared/src/token.ts`.

Optional: add `discord_instance_id` to the JoinToken payload so the game server can refuse
cross-instance bleed. Defensive; the unique-index already prevents two servers per
instance, but belt-and-suspenders for multi-shard play.

---

## Phase D — Discord Developer Portal config (manual)

User must do this once:

1. Create a Discord application at https://discord.com/developers/applications
2. **OAuth2 → Redirects**: add `https://dumrunner.app/api/auth/discord/callback`
3. **OAuth2 → Scopes**: `identify` (and optionally `guilds` for channel-name lookups)
4. **Activities → URL Mappings**: root `/` → `<vercel-domain>/discord` (Activity-only path)
5. **Activities → Install Link**: enable so the app appears in the Apps menu
6. Copy `Client ID` / `Client Secret` into Vercel + Fly env

---

## Phase E — Detection + entry routing in the existing app

URL-map approach (cleaner): tell Discord to map `/` → `/discord`. The Activity iframe goes
to `/discord`; the public site stays unchanged at `/`. No detection logic in the React
tree. Existing `/login` page just gains the "Continue with Discord" button.

---

## v1 scope vs. defer

**Ship in v1:**
- Phase A (with the JWT path), B, D, E.
- Both Activity and web OAuth login working.

**Defer:**
- Discord bot + slash commands.
- Voice-channel → in-game position binding (Activity SDK supports it).
- Rich presence cards on the launcher.
- Tying friend-list / guild membership to in-game social features.

---

## Open questions to resolve before starting

- Do we want Discord users to be able to **rename themselves** (override `discord_username`
  with a custom display name in `accounts.display_name`)? Probably yes.
- Should an existing email user be able to **link** Discord to their account? Add later;
  for v1 the two flows produce separate `accounts` rows.
- Do we need to handle Discord token refresh? Only if we keep the access token around for
  later API calls. For Activity / login-only flows we don't — we get the user once at
  exchange time and that's it.
