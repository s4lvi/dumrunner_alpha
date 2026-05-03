import { NextResponse, type NextRequest } from 'next/server';
import { exchangeDiscordCode, provisionDiscordSession } from '@/lib/discord/auth';
import { supabaseServer } from '@/lib/supabase/server';

const STATE_COOKIE = 'dr_discord_state';

function loginWithError(req: NextRequest, code: string): NextResponse {
  const url = new URL('/login', req.url);
  url.searchParams.set('discord_error', code);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = request.cookies.get(STATE_COOKIE)?.value ?? null;

  // Always clear the state cookie on the way out, success or fail.
  const finish = (res: NextResponse): NextResponse => {
    res.cookies.set(STATE_COOKIE, '', { path: '/', maxAge: 0 });
    return res;
  };

  if (!code || !state || !expectedState || state !== expectedState) {
    return finish(loginWithError(request, 'state_mismatch'));
  }

  const exchange = await exchangeDiscordCode(code, 'web');
  if (!exchange) {
    return finish(loginWithError(request, 'exchange_failed'));
  }

  let creds: Awaited<ReturnType<typeof provisionDiscordSession>>;
  try {
    creds = await provisionDiscordSession(exchange.profile);
  } catch (err) {
    console.error('[discord/callback] provision_failed', err);
    return finish(loginWithError(request, 'provision_failed'));
  }

  const supabase = await supabaseServer();
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  });
  if (signInErr) {
    console.error('[discord/callback] sign_in_failed', signInErr);
    return finish(loginWithError(request, 'sign_in_failed'));
  }

  return finish(NextResponse.redirect(new URL('/servers', request.url)));
}
