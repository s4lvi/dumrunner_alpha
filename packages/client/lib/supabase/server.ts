import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '../env';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

// Server-side Supabase client tied to the current request's cookies.
// Use in Server Components, Route Handlers, Server Actions.
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet: CookieToSet[]) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll is called from Server Components which can't write cookies;
          // middleware handles refresh.
        }
      },
    },
  });
}
