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
          <Link
            href="/servers"
            className="font-mono text-xs tracking-[0.2em] text-zinc-400 hover:text-zinc-200"
          >
            ← MISSION CONTROL
          </Link>
        </div>

        <header className="mb-6">
          <h1 className="font-mono font-bold tracking-[0.3em] text-2xl text-zinc-100">
            FOUND COLONY
          </h1>
          <p className="font-mono text-[11px] text-zinc-500 tracking-widest mt-1">
            COLONY CHARTER · DÛM ORBITAL RELAY
          </p>
        </header>

        <NewServerForm defaultName={defaultName} scenes={scenes} />
      </main>
    </>
  );
}
