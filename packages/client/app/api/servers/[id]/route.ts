import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

// Owner-only: delete a server world. Cascading FKs (servers ← characters,
// servers ← world_states) clean up downstream rows automatically.
//
// Active players still in the running game-server process keep their socket
// open until their next persist attempt fails (the character row is gone).
// New join attempts immediately fail with `server_not_found`. The world's
// in-memory state is dropped on idle-shutdown the next time the room
// empties.
export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // RLS on the servers table only allows UPDATE/DELETE by owner_id, so this
  // delete naturally returns 0 rows for non-owners. We still verify
  // explicitly so we can return a clean 403 instead of a silent success.
  const { data: existing, error: lookupErr } = await supabase
    .from('servers')
    .select('id, owner_id')
    .eq('id', id)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json(
      { error: 'lookup_failed', detail: lookupErr.message },
      { status: 500 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (existing.owner_id !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { error: delErr } = await supabase.from('servers').delete().eq('id', id);
  if (delErr) {
    return NextResponse.json(
      { error: 'delete_failed', detail: delErr.message },
      { status: 500 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
