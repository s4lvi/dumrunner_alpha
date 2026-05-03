import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Owner-only resume. Just clears the is_paused flag — joining is
// a separate action. Lobby uses this to "unpause" without entering.

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: serverId } = await ctx.params;

  const auth = await supabaseServer();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data: server, error: lookupErr } = await admin
    .from('servers')
    .select('id, owner_id')
    .eq('id', serverId)
    .maybeSingle();
  if (lookupErr || !server) {
    return NextResponse.json({ error: 'server_not_found' }, { status: 404 });
  }
  if (server.owner_id !== user.id) {
    return NextResponse.json({ error: 'not_owner' }, { status: 403 });
  }

  const { error: updErr } = await admin
    .from('servers')
    .update({ is_paused: false })
    .eq('id', serverId);
  if (updErr) {
    return NextResponse.json(
      { error: 'resume_failed', detail: updErr.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
