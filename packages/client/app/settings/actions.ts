'use server';

import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase/server';

export type SettingsState =
  | { kind: 'idle' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

export async function updateDisplayNameAction(
  _prev: SettingsState,
  formData: FormData
): Promise<SettingsState> {
  const displayName = String(formData.get('display_name') ?? '').trim();
  if (displayName.length < 2 || displayName.length > 32) {
    return { kind: 'error', message: 'Display name must be 2–32 characters.' };
  }

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: 'error', message: 'Not signed in.' };

  const { error } = await supabase
    .from('accounts')
    .update({ display_name: displayName })
    .eq('id', user.id);
  if (error) {
    return { kind: 'error', message: error.message };
  }

  // Bust the nav cache so the new name shows up on /servers.
  revalidatePath('/');
  return { kind: 'ok', message: 'Display name updated.' };
}
