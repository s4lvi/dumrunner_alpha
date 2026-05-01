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
};
