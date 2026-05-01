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

  if (!name || name.length < 1 || name.length > 64) {
    return { error: 'Server name must be 1–64 characters.' };
  }
  if (!Number.isInteger(maxSlots) || maxSlots < 5 || maxSlots > 10) {
    return { error: 'Max slots must be between 5 and 10.' };
  }
  if (visibility !== 'public' && visibility !== 'private') {
    return { error: 'Invalid visibility.' };
  }
  if (visibility === 'private' && !password) {
    return { error: 'Private servers require a password (used as the invite code).' };
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
    })
    .select('id')
    .single();

  if (error || !data) {
    return { error: error?.message ?? 'Failed to create server.' };
  }

  redirect(`/play/${data.id}`);
}
