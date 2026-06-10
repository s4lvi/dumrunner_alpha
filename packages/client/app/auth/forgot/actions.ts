'use server';

import { headers } from 'next/headers';
import { supabaseServer } from '@/lib/supabase/server';

export type ForgotState = { error?: string; sent?: boolean } | null;

export async function forgotPasswordAction(
  _prev: ForgotState,
  formData: FormData
): Promise<ForgotState> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) {
    return { error: 'Email is required.' };
  }

  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const redirectTo = `${proto}://${host}/auth/callback?next=/auth/reset`;

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  // Always report success — leaking which emails are registered is
  // worse than the small UX cost of a silent failure path.
  if (error) {
    console.error('[auth/forgot] reset_email_failed', error);
  }
  return { sent: true };
}
