// Mints a short-lived sandbox-flagged join token + returns the
// game server WS URL. Editor opens a WS to the URL and presents
// the token in the auth message; the WS server detects the
// sandbox flag and routes the connection into SandboxWorld.
//
// Auth: requires a logged-in Supabase user. The sandbox is one-
// per-user — `characterId` is the user's auth id, no Supabase
// `characters` row required (sandbox bypasses that lookup).

import { NextResponse } from 'next/server';
import {
  signJoinToken,
  DEFAULT_TOKEN_TTL_SECONDS,
} from '@dumrunner/shared/token';
import { supabaseServer } from '@/lib/supabase/server';
import { publicEnv, serverEnv } from '@/lib/env';

export async function POST() {
  const auth = await supabaseServer();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Pull the account display name for the editor's player label
  // shown in the sandbox arena. Best-effort fallback to email or
  // a literal so a missing accounts row doesn't 500.
  let displayName = 'editor';
  const { data: account } = await auth
    .from('accounts')
    .select('display_name')
    .eq('id', user.id)
    .single();
  if (account?.display_name) {
    displayName = account.display_name;
  } else if (user.email) {
    displayName = user.email.split('@')[0]?.slice(0, 32) ?? 'editor';
  }

  const exp = Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS;
  const token = signJoinToken(
    {
      accountId: user.id,
      // Sandbox identity. The server's character lookup is
      // skipped on sandbox tokens, so this just tags the
      // connection — it never references a Supabase row.
      characterId: `sandbox-${user.id}`,
      serverId: 'sandbox',
      displayName,
      exp,
      sandbox: true,
    },
    serverEnv.joinTokenSecret(),
  );

  return NextResponse.json({
    wsUrl: publicEnv.gameServerWsUrl,
    token,
    displayName,
  });
}
