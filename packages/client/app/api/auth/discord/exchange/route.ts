import { NextResponse, type NextRequest } from 'next/server';
import { exchangeDiscordCode, provisionDiscordSession } from '@/lib/discord/auth';
import { supabaseServer } from '@/lib/supabase/server';

// Activity-flow code exchange. Called from /discord (the Activity
// entry point) after `sdk.commands.authorize()` returns a code. We
// run the same provision-or-upsert as the web callback, then sign
// the user into Supabase so the rest of the app sees a normal
// session. Also returns `access_token` so the client can call
// `sdk.commands.authenticate({access_token})` to bind the SDK.
//
// Unlike the web callback this flow is POST + JSON — no CSRF state
// (the iframe is the gate; only Discord can deliver the code).

type Body = { code?: string };

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!body.code) {
    return NextResponse.json({ error: 'missing_code' }, { status: 400 });
  }

  const exchange = await exchangeDiscordCode(body.code, 'activity');
  if (!exchange) {
    return NextResponse.json({ error: 'exchange_failed' }, { status: 401 });
  }

  let creds: Awaited<ReturnType<typeof provisionDiscordSession>>;
  try {
    creds = await provisionDiscordSession(exchange.profile);
  } catch (err) {
    console.error('[discord/exchange] provision_failed', err);
    return NextResponse.json({ error: 'provision_failed' }, { status: 500 });
  }

  const supabase = await supabaseServer();
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  });
  if (signInErr) {
    console.error('[discord/exchange] sign_in_failed', signInErr);
    return NextResponse.json({ error: 'sign_in_failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    accessToken: exchange.accessToken,
    displayName: creds.displayName,
  });
}
