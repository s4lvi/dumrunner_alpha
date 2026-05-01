import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

// Handles the OAuth / email-confirmation redirect from Supabase.
// Supabase sends the user to a URL with `?code=<...>`; we exchange that code
// for a session (which sets the auth cookies) and then redirect to /servers.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/servers';

  if (code) {
    const supabase = await supabaseServer();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
