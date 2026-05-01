import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { AppNav } from '@/app/components/AppNav';
import { NewServerForm } from './NewServerForm';

export default async function NewServerPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <>
      <AppNav />
      <main className="min-h-screen px-6 py-10 max-w-2xl mx-auto">
        <div className="mb-6">
          <Link href="/servers" className="text-sm text-zinc-400">
            ← Back to servers
          </Link>
        </div>

        <h1 className="text-3xl font-bold mb-1">Create server</h1>
        <p className="text-zinc-400 mb-8">
          Set up a world for you and up to 9 friends.
        </p>

        <NewServerForm />
      </main>
    </>
  );
}
