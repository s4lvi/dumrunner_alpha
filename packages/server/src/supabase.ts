import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Service-role client. Bypasses RLS. Used by the game server to read/write
// any character/world row. Never expose this client (or its key) to the browser.
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
