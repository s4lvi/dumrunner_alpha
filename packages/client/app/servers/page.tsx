import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { AppNav } from '@/app/components/AppNav';
import { JoinByIdForm } from './JoinByIdForm';
import { DeleteServerButton } from './DeleteServerButton';

export const dynamic = 'force-dynamic';

type ServerRow = {
  id: string;
  name: string;
  visibility: string;
  max_slots: number;
  owner_id: string;
  created_at: string;
  has_password: boolean;
};

export default async function ServersPage() {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Query the safe view rather than the underlying table — the view only
  // exposes browser-safe columns, so future sensitive columns added to the
  // servers table can't accidentally leak through here. Requires migration
  // 0003_servers_public_view.sql.
  const { data: servers } = await supabase
    .from('servers_public')
    .select('id, name, visibility, max_slots, owner_id, created_at, has_password')
    .order('created_at', { ascending: false });

  const list = (servers ?? []) as ServerRow[];
  const publicList = list.filter((s) => s.visibility === 'public');
  const myPrivate = list.filter((s) => s.visibility === 'private' && s.owner_id === user.id);

  return (
    <>
      <AppNav />
      <main className="min-h-screen px-6 py-10 max-w-5xl mx-auto">
        <header className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-3xl font-bold">Servers</h1>
            <p className="text-zinc-400 text-sm">
              Browse public worlds or create your own.
            </p>
          </div>
          <Link
            href="/servers/new"
            className="px-4 py-2 rounded bg-[color:var(--accent)] text-black font-semibold"
          >
            Create server
          </Link>
        </header>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Public servers</h2>
        {publicList.length === 0 ? (
          <p className="text-zinc-500">No public servers yet. Create one.</p>
        ) : (
          <ul className="space-y-2">
            {publicList.map((s) => (
              <ServerRowCard key={s.id} server={s} currentUserId={user.id} />
            ))}
          </ul>
        )}
      </section>

      {myPrivate.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">Your private servers</h2>
          <ul className="space-y-2">
            {myPrivate.map((s) => (
              <ServerRowCard key={s.id} server={s} currentUserId={user.id} />
            ))}
          </ul>
        </section>
      )}

        <section>
          <h2 className="text-xl font-semibold mb-3">Join by code</h2>
          <p className="text-zinc-500 text-sm mb-3">
            For private servers — paste the server ID a friend shared with you.
          </p>
          <JoinByIdForm />
        </section>
      </main>
    </>
  );
}

function ServerRowCard({
  server,
  currentUserId,
}: {
  server: ServerRow;
  currentUserId: string;
}) {
  const locked = server.has_password;
  const isOwner = server.owner_id === currentUserId;
  return (
    <li className="flex items-center justify-between bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded px-4 py-3">
      <div>
        <div className="font-semibold flex items-center gap-2">
          {server.name}
          {locked && <span className="text-xs text-zinc-500">[password]</span>}
          <span className="text-xs text-zinc-500">[{server.visibility}]</span>
          {isOwner && (
            <span className="text-xs text-[color:var(--accent)]">[owner]</span>
          )}
        </div>
        <div className="text-xs text-zinc-500">
          slots: {server.max_slots} • id: {server.id.slice(0, 8)}…
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isOwner && <DeleteServerButton serverId={server.id} />}
        <Link
          href={`/play/${server.id}`}
          className="px-4 py-2 rounded border border-[color:var(--panel-border)] hover:bg-[color:var(--bg)]"
        >
          Join
        </Link>
      </div>
    </li>
  );
}
