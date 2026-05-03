import { NextResponse, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env';
import { makeOauthState } from '@/lib/discord/auth';

const STATE_COOKIE = 'dr_discord_state';

export async function GET(_request: NextRequest) {
  const state = makeOauthState();
  const params = new URLSearchParams({
    client_id: serverEnv.discordClientId(),
    response_type: 'code',
    redirect_uri: serverEnv.discordRedirectUri(),
    scope: 'identify',
    state,
    prompt: 'none',
  });
  const url = `https://discord.com/oauth2/authorize?${params.toString()}`;

  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 5,
  });
  return res;
}
