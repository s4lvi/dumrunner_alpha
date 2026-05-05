// Centralised env access. Throws clearly if something we need is missing.
//
// IMPORTANT: NEXT_PUBLIC_* must be read as a *literal* property path
// (`process.env.NEXT_PUBLIC_FOO`), not via a computed key. Webpack's
// DefinePlugin only inlines literal references at build time; a
// computed access (`process.env[name]`) leaves the value missing in
// any chunk that doesn't *also* contain a literal reference to that
// var. That manifested as "Missing required env var" on the /discord
// page even though the var was set in Vercel.
//
// Public vars are exposed via getters so the throw happens at *read*
// time, not module load. Without this, `next build`'s page-data
// collection step instantiates this module and throws before any
// route gets a chance to run — even routes that don't actually use
// Supabase. Getters preserve the literal `process.env.FOO` reference
// inside the function body, which is what DefinePlugin needs.

function ensure(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const publicEnv = {
  get supabaseUrl(): string {
    return ensure(
      'NEXT_PUBLIC_SUPABASE_URL',
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
  },
  get supabaseAnonKey(): string {
    return ensure(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  },
  get gameServerWsUrl(): string {
    return ensure(
      'NEXT_PUBLIC_GAME_SERVER_WS_URL',
      process.env.NEXT_PUBLIC_GAME_SERVER_WS_URL,
    );
  },
  // Optional: empty string when Discord login isn't configured. Read
  // via discordEnabledClient() so consumers fall back gracefully.
  get discordClientId(): string {
    return process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID ?? '';
  },
};

export function discordEnabledClient(): boolean {
  return publicEnv.discordClientId.length > 0;
}

// Server-only. Do not import from client components. These functions
// run only in Node where `process.env` is the real environment, so
// computed-key access is fine here.
export const serverEnv = {
  supabaseServiceRoleKey: () =>
    ensure('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
  joinTokenSecret: () =>
    ensure('JOIN_TOKEN_SECRET', process.env.JOIN_TOKEN_SECRET),
  discordClientId: () =>
    ensure(
      'NEXT_PUBLIC_DISCORD_CLIENT_ID',
      process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID
    ),
  discordClientSecret: () =>
    ensure('DISCORD_CLIENT_SECRET', process.env.DISCORD_CLIENT_SECRET),
  discordRedirectUri: () =>
    ensure('DISCORD_REDIRECT_URI', process.env.DISCORD_REDIRECT_URI),
};
