'use client';

import { createBrowserClient } from '@supabase/ssr';
import { publicEnv } from '../env';

// Use this in client components. Reads/writes session cookies via the browser.
export function supabaseBrowser() {
  return createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
}
