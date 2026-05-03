import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Bind a Discord Activity instance_id to a server row.
//
// First caller in the call creates a fresh public server scoped to
// that instance and becomes the owner. Subsequent callers from the
// same instance look up and rejoin. The unique partial index on
// `discord_instance_id` enforces one server per instance.

type Body = { instance_id?: string };

export async function POST(request: NextRequest) {
  const auth = await supabaseServer();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const instanceId = body.instance_id?.trim();
  if (!instanceId) {
    return NextResponse.json({ error: 'missing_instance_id' }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Existing instance? Return it.
  const { data: existing } = await admin
    .from('servers')
    .select('id')
    .eq('discord_instance_id', instanceId)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ server_id: existing.id, created: false });
  }

  // Otherwise, create a new server scoped to this instance.
  const { data: created, error: createErr } = await admin
    .from('servers')
    .insert({
      name: `Discord Activity ${instanceId.slice(0, 8)}`,
      owner_id: user.id,
      visibility: 'public',
      password_hash: null,
      max_slots: 10,
      world_seed: null,
      discord_instance_id: instanceId,
    })
    .select('id')
    .single();

  // Race: another caller in the same instance may have just inserted.
  // Fall back to a re-lookup on unique-violation.
  if (createErr) {
    if (createErr.code === '23505') {
      const { data: raceWinner } = await admin
        .from('servers')
        .select('id')
        .eq('discord_instance_id', instanceId)
        .maybeSingle();
      if (raceWinner) {
        return NextResponse.json({ server_id: raceWinner.id, created: false });
      }
    }
    console.error('[discord/instance] create_failed', createErr);
    return NextResponse.json(
      { error: 'create_failed', detail: createErr.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ server_id: created!.id, created: true });
}
