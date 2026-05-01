import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { publicEnv, serverEnv } from '../env';

// Service-role client for API routes that need to write character/world rows
// without RLS. NEVER import from a client component.
export function supabaseAdmin() {
  return createClient(publicEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
