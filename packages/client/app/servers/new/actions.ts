'use server';

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { hashPassword } from '@/lib/passwords';

export type CreateState = { error?: string } | null;

export async function createServerAction(
  _prev: CreateState,
  formData: FormData
): Promise<CreateState> {
  const name = String(formData.get('name') ?? '').trim();
  const visibility = String(formData.get('visibility') ?? 'public');
  const password = String(formData.get('password') ?? '');
  const maxSlots = Number(formData.get('max_slots') ?? 8);
  const seedRaw = String(formData.get('world_seed') ?? '').trim();
  const dayDurationSec = Number(formData.get('day_duration_sec') ?? 300);
  const daysPerCycle = Number(formData.get('days_per_cycle') ?? 3);
  const dropItemsOnDeath =
    String(formData.get('drop_items_on_death') ?? 'on') === 'on';
  const isPlaytest = String(formData.get('is_playtest') ?? '') === 'on';
  const mode = String(formData.get('mode') ?? 'live');
  const arenaSceneIdRaw = String(formData.get('arena_scene_id') ?? '').trim();

  if (!name || name.length < 1 || name.length > 64) {
    return { error: 'Server name must be 1–64 characters.' };
  }
  if (!Number.isInteger(maxSlots) || maxSlots < 5 || maxSlots > 10) {
    return { error: 'Max slots must be between 5 and 10.' };
  }
  if (
    !Number.isInteger(dayDurationSec) ||
    dayDurationSec < 30 ||
    dayDurationSec > 3600
  ) {
    return { error: 'Day length must be 30–3600 seconds.' };
  }
  if (!Number.isInteger(daysPerCycle) || daysPerCycle < 1 || daysPerCycle > 7) {
    return { error: 'Days per cycle must be 1–7.' };
  }
  if (visibility !== 'public' && visibility !== 'private') {
    return { error: 'Invalid visibility.' };
  }
  if (visibility === 'private' && !password) {
    return { error: 'Private servers require a password (used as the invite code).' };
  }
  if (mode !== 'live' && mode !== 'deathmatch') {
    return { error: 'Invalid mode.' };
  }
  let arenaSceneId: string | null = null;
  if (mode === 'deathmatch') {
    if (!arenaSceneIdRaw) {
      return { error: 'Deathmatch mode requires picking a map.' };
    }
    // Server-side slug validation mirrors the loader's id schema —
    // prevents arbitrary file paths sneaking in via the form.
    if (!/^[a-z0-9_-]+$/i.test(arenaSceneIdRaw)) {
      return { error: 'Arena scene id has invalid characters.' };
    }
    arenaSceneId = arenaSceneIdRaw;
  }

  let worldSeed: number | null = null;
  if (seedRaw.length > 0) {
    const n = Number(seedRaw);
    if (!Number.isFinite(n)) return { error: 'World seed must be a number.' };
    worldSeed = Math.trunc(n);
  }

  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not signed in.' };

  const password_hash = password ? await hashPassword(password) : null;

  const { data, error } = await supabase
    .from('servers')
    .insert({
      name,
      owner_id: user.id,
      visibility,
      password_hash,
      max_slots: maxSlots,
      world_seed: worldSeed,
      day_duration_sec: dayDurationSec,
      days_per_cycle: daysPerCycle,
      drop_items_on_death: dropItemsOnDeath,
      is_playtest: isPlaytest,
      mode,
      arena_scene_id: arenaSceneId,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { error: error?.message ?? 'Failed to create server.' };
  }

  redirect(`/play/${data.id}`);
}
