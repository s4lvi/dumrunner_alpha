import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Bind a Discord Activity instance_id to a server row.
//
// GET ?instance_id=X — does this instance already have a server?
//   Returns { server_id, server, display_name } where server_id is
//   null on miss. Lets the client render either the "first user
//   creates the room" form or the "joiner just picks a name" form.
//
// POST { instance_id, display_name, server? } — create or join.
//   First caller must include `server` config. Subsequent callers
//   omit it; we just stamp display_name and rejoin.
//
// The unique partial index on `discord_instance_id` enforces one
// server per instance even under racing creators (we 23505→re-lookup).

type ServerConfig = {
  name?: string;
  max_slots?: number;
  world_seed?: number | null;
  day_duration_sec?: number;
  days_per_cycle?: number;
  drop_items_on_death?: boolean;
};

type PostBody = {
  instance_id?: string;
  display_name?: string;
  server?: ServerConfig;
};

type ServerSummaryRow = {
  id: string;
  name: string;
  max_slots: number;
  world_seed: number | null;
  day_duration_sec: number | null;
  days_per_cycle: number | null;
  drop_items_on_death: boolean | null;
  owner_id: string;
};

function validateDisplayName(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string') return { error: 'display_name_required' };
  const trimmed = raw.trim();
  if (trimmed.length < 2 || trimmed.length > 32) {
    return { error: 'display_name_length' };
  }
  return trimmed;
}

function validateServerConfig(
  raw: ServerConfig | undefined
): { name: string; max_slots: number; world_seed: number | null;
     day_duration_sec: number; days_per_cycle: number;
     drop_items_on_death: boolean } | { error: string } {
  if (!raw) return { error: 'server_config_required' };
  const name = (raw.name ?? '').trim();
  if (name.length < 1 || name.length > 64) return { error: 'name_length' };
  const max_slots = Number(raw.max_slots);
  if (!Number.isInteger(max_slots) || max_slots < 5 || max_slots > 10) {
    return { error: 'max_slots_range' };
  }
  const day_duration_sec = Number(raw.day_duration_sec);
  if (
    !Number.isInteger(day_duration_sec) ||
    day_duration_sec < 30 ||
    day_duration_sec > 3600
  ) {
    return { error: 'day_duration_sec_range' };
  }
  const days_per_cycle = Number(raw.days_per_cycle);
  if (
    !Number.isInteger(days_per_cycle) ||
    days_per_cycle < 1 ||
    days_per_cycle > 7
  ) {
    return { error: 'days_per_cycle_range' };
  }
  let world_seed: number | null = null;
  if (raw.world_seed !== null && raw.world_seed !== undefined) {
    const n = Number(raw.world_seed);
    if (!Number.isFinite(n)) return { error: 'world_seed_number' };
    world_seed = Math.trunc(n);
  }
  return {
    name,
    max_slots,
    world_seed,
    day_duration_sec,
    days_per_cycle,
    drop_items_on_death: raw.drop_items_on_death !== false,
  };
}

async function setDisplayName(userId: string, displayName: string): Promise<void> {
  const admin = supabaseAdmin();
  // Upsert because Discord users may not have an `accounts` row yet
  // if something interrupted the provision flow before this point.
  await admin
    .from('accounts')
    .upsert({ id: userId, display_name: displayName }, { onConflict: 'id' });
}

export async function GET(request: NextRequest) {
  const auth = await supabaseServer();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const instanceId = new URL(request.url).searchParams.get('instance_id')?.trim();
  if (!instanceId) {
    return NextResponse.json({ error: 'missing_instance_id' }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const [{ data: server }, { data: account }] = await Promise.all([
    admin
      .from('servers')
      .select(
        'id, name, max_slots, world_seed, day_duration_sec, days_per_cycle, drop_items_on_death, owner_id'
      )
      .eq('discord_instance_id', instanceId)
      .maybeSingle<ServerSummaryRow>(),
    admin.from('accounts').select('display_name').eq('id', user.id).maybeSingle(),
  ]);

  return NextResponse.json({
    server_id: server?.id ?? null,
    server: server
      ? {
          name: server.name,
          max_slots: server.max_slots,
          world_seed: server.world_seed,
          day_duration_sec: server.day_duration_sec,
          days_per_cycle: server.days_per_cycle,
          drop_items_on_death: server.drop_items_on_death,
          is_owner: server.owner_id === user.id,
        }
      : null,
    display_name: account?.display_name ?? null,
  });
}

export async function POST(request: NextRequest) {
  const auth = await supabaseServer();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const instanceId = body.instance_id?.trim();
  if (!instanceId) {
    return NextResponse.json({ error: 'missing_instance_id' }, { status: 400 });
  }

  const dn = validateDisplayName(body.display_name);
  if (typeof dn !== 'string') {
    return NextResponse.json(dn, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Existing instance? Stamp the display name and rejoin.
  const { data: existing } = await admin
    .from('servers')
    .select('id')
    .eq('discord_instance_id', instanceId)
    .maybeSingle();
  if (existing) {
    await setDisplayName(user.id, dn);
    return NextResponse.json({ server_id: existing.id, created: false });
  }

  // First caller — needs server config.
  const cfg = validateServerConfig(body.server);
  if ('error' in cfg) {
    return NextResponse.json(cfg, { status: 400 });
  }

  // Display name first so the row exists if creating the server hits
  // a foreign-key snag.
  await setDisplayName(user.id, dn);

  const { data: created, error: createErr } = await admin
    .from('servers')
    .insert({
      name: cfg.name,
      owner_id: user.id,
      visibility: 'public',
      password_hash: null,
      max_slots: cfg.max_slots,
      world_seed: cfg.world_seed,
      day_duration_sec: cfg.day_duration_sec,
      days_per_cycle: cfg.days_per_cycle,
      drop_items_on_death: cfg.drop_items_on_death,
      discord_instance_id: instanceId,
    })
    .select('id')
    .single();

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
