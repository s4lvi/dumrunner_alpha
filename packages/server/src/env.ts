function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  port: Number(process.env.GAME_SERVER_PORT ?? 8080),
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  joinTokenSecret: required('JOIN_TOKEN_SECRET'),
};
