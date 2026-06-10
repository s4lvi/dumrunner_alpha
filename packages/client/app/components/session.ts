import { cache } from 'react';
import { supabaseServer } from '@/lib/supabase/server';

export type SessionUser = {
  id: string;
  email: string | null;
  displayName: string | null;
};

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: account } = await supabase
    .from('accounts')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();

  return {
    id: user.id,
    email: user.email ?? null,
    displayName: account?.display_name ?? null,
  };
});
