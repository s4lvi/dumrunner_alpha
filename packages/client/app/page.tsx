import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';

export default async function Landing() {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    redirect('/servers');
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="max-w-xl text-center">
        <h1 className="text-6xl font-black tracking-tight mb-2" style={{ color: 'var(--accent)' }}>
          DÛM RUNNER
        </h1>
        <p className="text-sm uppercase tracking-[0.3em] text-zinc-400 mb-8">
          tactical extraction from the ruins of an ancient world
        </p>
        <p className="text-zinc-300 mb-10 leading-relaxed">
          Dive the Dungeon of Dûm. Scavenge alien tech. Build your base. Survive
          the perihelion horde.
        </p>
        <div className="flex gap-3 justify-center">
          <Link
            href="/login"
            className="px-6 py-3 rounded font-semibold border border-[color:var(--panel-border)] hover:bg-[color:var(--panel)]"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="px-6 py-3 rounded font-semibold bg-[color:var(--accent)] text-black hover:opacity-90"
          >
            Create account
          </Link>
        </div>
      </div>
    </main>
  );
}
