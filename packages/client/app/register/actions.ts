'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type RegisterState = { error?: string } | null;

export async function registerAction(
  _prev: RegisterState,
  formData: FormData
): Promise<RegisterState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const displayName = String(formData.get('display_name') ?? '').trim();

  if (!email || !password || !displayName) {
    return { error: 'Email, password, and display name are required.' };
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }
  if (displayName.length < 2 || displayName.length > 32) {
    return { error: 'Display name must be 2–32 characters.' };
  }

  const supabase = await supabaseServer();

  // Build absolute URL for the email-confirm callback so Supabase sends users
  // to /auth/callback (which handles the code exchange) rather than to /.
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const emailRedirectTo = `${proto}://${host}/auth/callback`;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo },
  });
  if (error || !data.user) {
    return { error: error?.message ?? 'Sign-up failed.' };
  }

  // Create the public accounts row using the service-role client so this works
  // whether or not email confirmation is enabled.
  const admin = supabaseAdmin();
  const { error: accountErr } = await admin
    .from('accounts')
    .insert({ id: data.user.id, display_name: displayName });
  if (accountErr) {
    return { error: `Account creation failed: ${accountErr.message}` };
  }

  // If a session was created (email confirmation off), go straight to lobby.
  // Otherwise show a confirm-email message.
  if (data.session) {
    redirect('/servers');
  }
  redirect('/login?confirm=1');
}
