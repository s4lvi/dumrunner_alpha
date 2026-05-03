import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '../env';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

// Cookies set by Supabase need iframe-friendly attributes so they
// survive a Discord Activity. Inside the discordsays.com iframe the
// browser treats us as a third-party context: a Lax cookie set by
// the embedded page is silently dropped by Chrome/Safari, so the
// follow-up GET sees `auth.getUser() === null` and every gated route
// 401s. SameSite=None + Secure + Partitioned scopes the cookie to
// the top-level partition (CHIPS) and lets the browser keep it.
//
// Same-site=None is fine for regular browser visits — Supabase
// session cookies are HttpOnly, mutating endpoints all use POST
// with a JSON body so they preflight under CORS, and we don't have
// any GET endpoints that mutate state.
const IFRAME_FRIENDLY: Partial<CookieOptions> = {
  sameSite: 'none',
  secure: true,
  // `partitioned` is supported by Next 15's CookieOptions type but
  // older @supabase/ssr d.ts may not surface it; cast keeps both
  // paths happy.
};

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
            cookieStore.set(name, value, {
              ...(options ?? {}),
              ...IFRAME_FRIENDLY,
              partitioned: true,
            } as CookieOptions & { partitioned: boolean });
          }
        } catch {
          // setAll is called from Server Components which can't write cookies;
          // middleware handles refresh.
        }
      },
    },
  });
}
