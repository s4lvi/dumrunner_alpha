function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  port: Number(process.env.GAME_SERVER_PORT ?? 8080),
  // Bind interface. Localhost during dev (no exposure on the LAN); 0.0.0.0
  // in containers (Fly's proxy reaches us over the internal network and only
  // matches when we bind on all interfaces).
  host: process.env.GAME_SERVER_HOST ?? '127.0.0.1',
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  joinTokenSecret: required('JOIN_TOKEN_SECRET'),
  // Optional asset_gen base URL. When set, the game server fires a
  // single fire-and-forget /v1/assets/prewarm bundle at boot for every
  // entity it knows about; asset_gen's cache key dedups, so anything
  // already generated is a no-op. Unset → no asset gen integration.
  assetGenUrl: process.env.ASSET_GEN_URL ?? null,
  // Optional bearer token for the asset_gen service. Required only if
  // the asset_gen instance has ASSET_GEN_SERVICE_TOKEN set.
  assetGenServiceToken: process.env.ASSET_GEN_SERVICE_TOKEN ?? null,
};
