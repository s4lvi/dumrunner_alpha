import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '../env';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

// Refreshes the Supabase session cookie on each request. Wired up in /middleware.ts.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet: CookieToSet[]) => {
        for (const { name, value } of toSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refresh session.
  await supabase.auth.getUser();

  return response;
}
