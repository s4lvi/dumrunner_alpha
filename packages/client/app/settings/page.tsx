import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { AppNav } from '@/app/components/AppNav';
import { SettingsForm } from './SettingsForm';
import { AudioSettings } from './AudioSettings';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: account } = await supabase
    .from('accounts')
    .select('display_name')
    .eq('id', user.id)
    .single();

  return (
    <>
      <AppNav />
      <main className="min-h-screen px-6 py-10 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-1">Account settings</h1>
        <p className="text-zinc-400 text-sm mb-8">{user.email}</p>

        <SettingsForm initialDisplayName={account?.display_name ?? ''} />

        <h2 className="text-xl font-semibold mt-10 mb-3">Audio</h2>
        <AudioSettings />
      </main>
    </>
  );
}
