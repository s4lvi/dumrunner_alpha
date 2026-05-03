// Centralised env access. Throws clearly if something we need is missing.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const publicEnv = {
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  gameServerWsUrl: required('NEXT_PUBLIC_GAME_SERVER_WS_URL'),
  // Optional: empty string when Discord login isn't configured. Read via
  // discordEnabledClient() so consumers fall back gracefully.
  discordClientId: process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID ?? '',
};

export function discordEnabledClient(): boolean {
  return publicEnv.discordClientId.length > 0;
}

// Server-only. Do not import from client components.
export const serverEnv = {
  supabaseServiceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
  joinTokenSecret: () => required('JOIN_TOKEN_SECRET'),
  discordClientId: () => required('NEXT_PUBLIC_DISCORD_CLIENT_ID'),
  discordClientSecret: () => required('DISCORD_CLIENT_SECRET'),
  discordRedirectUri: () => required('DISCORD_REDIRECT_URI'),
};
