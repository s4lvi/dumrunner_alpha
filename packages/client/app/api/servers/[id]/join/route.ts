import { NextResponse, type NextRequest } from 'next/server';
import { signJoinToken, DEFAULT_TOKEN_TTL_SECONDS } from '@dumrunner/shared/token';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { verifyPassword } from '@/lib/passwords';
import { publicEnv, serverEnv } from '@/lib/env';

type Body = { password?: string };

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: serverId } = await ctx.params;

  const auth = await supabaseServer();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Fetch the account row for display name. If missing (e.g. an auth user from
  // an earlier test before the accounts insert worked), auto-provision one so
  // the user can still play. They can rename later.
  let displayName: string;
  {
    const { data: account } = await auth
      .from('accounts')
      .select('display_name')
      .eq('id', user.id)
      .single();
    if (account) {
      displayName = account.display_name;
    } else {
      const fallback = (user.email?.split('@')[0] ?? 'runner').slice(0, 32) || 'runner';
      const adminInit = supabaseAdmin();
      const { error: provisionErr } = await adminInit
        .from('accounts')
        .insert({ id: user.id, display_name: fallback });
      if (provisionErr) {
        console.error('[join] account_provision_failed', provisionErr);
        return NextResponse.json(
          { error: 'account_provision_failed', detail: provisionErr.message },
          { status: 500 }
        );
      }
      displayName = fallback;
    }
  }

  // Use admin to read the server row regardless of RLS visibility (private servers
  // aren't covered by the public select policy unless you're the owner — but if
  // you have the id, we treat it as legitimate access pending password check).
  const admin = supabaseAdmin();
  const { data: server, error: serverErr } = await admin
    .from('servers')
    .select('id, password_hash, max_slots, owner_id, is_paused')
    .eq('id', serverId)
    .single();
  if (serverErr || !server) {
    return NextResponse.json({ error: 'server_not_found' }, { status: 404 });
  }

  // Pause gate. Owner rejoining auto-resumes; everyone else is
  // rejected until the owner unpauses (either by joining or via
  // /api/servers/[id]/resume).
  if (server.is_paused) {
    if (server.owner_id !== user.id) {
      return NextResponse.json({ error: 'server_paused' }, { status: 403 });
    }
    const { error: resumeErr } = await admin
      .from('servers')
      .update({ is_paused: false })
      .eq('id', server.id);
    if (resumeErr) {
      console.error('[join] resume_on_owner_failed', resumeErr);
      return NextResponse.json(
        { error: 'resume_failed', detail: resumeErr.message },
        { status: 500 }
      );
    }
  }

  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    // empty body is fine
  }

  // Owners always bypass the password.
  if (server.password_hash && server.owner_id !== user.id) {
    if (!body.password) {
      return NextResponse.json({ error: 'password_required' }, { status: 401 });
    }
    const ok = await verifyPassword(body.password, server.password_hash);
    if (!ok) {
      return NextResponse.json({ error: 'bad_password' }, { status: 401 });
    }
  }

  // Capacity check — count *active* characters (last_seen_at within
  // the heartbeat-window) instead of every character ever created.
  // The game server stamps last_seen_at at ws auth + every 30s while
  // connected; we use a 60s grace window to forgive single-tick gaps.
  const activeCutoff = new Date(Date.now() - 60_000).toISOString();
  const { count: occupancy } = await admin
    .from('characters')
    .select('id', { count: 'exact', head: true })
    .eq('server_id', server.id)
    .gt('last_seen_at', activeCutoff);

  // Get-or-create character row for this (account, server).
  const { data: existing } = await admin
    .from('characters')
    .select('id')
    .eq('account_id', user.id)
    .eq('server_id', server.id)
    .maybeSingle();

  let characterId: string;
  if (existing) {
    characterId = existing.id;
  } else {
    if ((occupancy ?? 0) >= server.max_slots) {
      return NextResponse.json({ error: 'server_full' }, { status: 403 });
    }
    const starterInventory = {
      schema: 1,
      starter: true,
      // Real per-part records will land here once the inventory system is built.
      notes: 'Mk1 Medium chassis + basic life-support + basic plating + small Mk1 cargo grid + Mk1 pistol',
    };
    const { data: created, error: createErr } = await admin
      .from('characters')
      .insert({
        account_id: user.id,
        server_id: server.id,
        inventory: starterInventory,
      })
      .select('id')
      .single();
    if (createErr || !created) {
      console.error('[join] character_create_failed', {
        accountId: user.id,
        serverId: server.id,
        message: createErr?.message,
        details: createErr?.details,
        hint: createErr?.hint,
        code: createErr?.code,
      });
      return NextResponse.json(
        {
          error: 'character_create_failed',
          detail: createErr?.message,
          hint: createErr?.hint,
          code: createErr?.code,
        },
        { status: 500 }
      );
    }
    characterId = created.id;
  }

  const exp = Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS;
  const token = signJoinToken(
    {
      accountId: user.id,
      characterId,
      serverId: server.id,
      displayName: displayName,
      exp,
    },
    serverEnv.joinTokenSecret()
  );

  return NextResponse.json({
    wsUrl: publicEnv.gameServerWsUrl,
    token,
    characterId,
    displayName: displayName,
    isOwner: server.owner_id === user.id,
  });
}
