import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadScenes } from '@dumrunner/shared/content/loader';
import { supabaseServer } from '@/lib/supabase/server';
import { AppNav } from '@/app/components/AppNav';
import { getSessionUser } from '@/app/components/session';
import { NewServerForm } from './NewServerForm';

export const dynamic = 'force-dynamic';

export default async function NewServerPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const session = await getSessionUser();
  const defaultName = session?.displayName
    ? `${session.displayName}'s server`
    : '';

  const scenes = (await loadScenes()).map((s) => ({ id: s.id, name: s.name }));

  return (
    <>
      <AppNav />
      <main className="min-h-screen px-6 py-10 max-w-2xl mx-auto">
        <div className="mb-6">
          <Link href="/servers" className="text-sm text-zinc-400">
            ← Back to servers
          </Link>
        </div>

        <h1 className="text-3xl font-bold mb-6">Create server</h1>

        <NewServerForm defaultName={defaultName} scenes={scenes} />
      </main>
    </>
  );
}
