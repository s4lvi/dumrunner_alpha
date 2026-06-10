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
  is_paused: boolean;
  mode: 'live' | 'deathmatch' | null;
  arena_scene_id: string | null;
  player_count: number | null;
};

const NOTICE_MESSAGES: Record<string, string> = {
  server_paused:
    'The server you were on was paused by its owner. Rejoin (as owner) or wait for them to resume.',
};

export default async function ServersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const noticeKey = typeof sp.notice === 'string' ? sp.notice : null;
  const notice = noticeKey ? NOTICE_MESSAGES[noticeKey] ?? null : null;

  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: servers } = await supabase
    .from('servers_public')
    .select(
      'id, name, visibility, max_slots, owner_id, created_at, has_password, is_paused, mode, arena_scene_id, player_count'
    )
    .order('created_at', { ascending: false });

  const list = (servers ?? []) as ServerRow[];
  const publicList = list.filter((s) => s.visibility === 'public');
  const myPrivate = list.filter(
    (s) => s.visibility === 'private' && s.owner_id === user.id,
  );
  // Treat null mode as live for the legacy row case but bucket by
  // explicit value so an unknown future mode doesn't get hidden in
  // the Live section.
  const publicDM = publicList.filter((s) => s.mode === 'deathmatch');
  const publicLive = publicList.filter((s) => s.mode === 'live' || s.mode === null);

  return (
    <>
      <AppNav />
      <main className="min-h-screen px-6 py-10 max-w-5xl mx-auto">
        {notice && (
          <div className="mb-6 text-sm text-amber-300 border border-amber-700/40 bg-amber-900/20 rounded px-4 py-3">
            {notice}
          </div>
        )}
        <header className="flex items-center justify-between mb-10">
          <h1 className="text-3xl font-bold">Servers</h1>
          <Link
            href="/servers/new"
            className="px-4 py-2 rounded bg-[color:var(--accent)] text-black font-semibold"
          >
            Create server
          </Link>
        </header>

        <ServerSection
          title="Deathmatch arenas"
          accent="red"
          servers={publicDM}
          currentUserId={user.id}
          emptyHint={
            <>
              No deathmatch arenas live.{' '}
              <Link
                href="/servers/new"
                className="underline text-[color:var(--accent)]"
              >
                Create one.
              </Link>
            </>
          }
        />

        <ServerSection
          title="Live worlds"
          accent="green"
          servers={publicLive}
          currentUserId={user.id}
          emptyHint={<>No public live worlds yet.</>}
        />

        {myPrivate.length > 0 && (
          <ServerSection
            title="Your private servers"
            accent="zinc"
            servers={myPrivate}
            currentUserId={user.id}
            emptyHint={null}
          />
        )}

        <section className="mt-12 pt-8 border-t border-[color:var(--panel-border)]">
          <h2 className="text-xl font-semibold mb-3">Join by code</h2>
          <JoinByIdForm />
        </section>
      </main>
    </>
  );
}

function ServerSection({
  title,
  accent,
  servers,
  currentUserId,
  emptyHint,
}: {
  title: string;
  accent: 'red' | 'green' | 'zinc';
  servers: ServerRow[];
  currentUserId: string;
  emptyHint: React.ReactNode;
}) {
  const dotClass =
    accent === 'red'
      ? 'bg-red-500'
      : accent === 'green'
        ? 'bg-emerald-500'
        : 'bg-zinc-500';
  return (
    <section className="mb-10">
      <div className="flex items-baseline gap-3 mb-3">
        <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
        <h2 className="text-xl font-semibold">{title}</h2>
        <span className="text-xs text-zinc-500">{servers.length}</span>
      </div>
      {servers.length === 0 ? (
        emptyHint ? (
          <p className="text-sm text-zinc-500">{emptyHint}</p>
        ) : null
      ) : (
        <ul className="space-y-2">
          {servers.map((s) => (
            <ServerRowCard key={s.id} server={s} currentUserId={currentUserId} />
          ))}
        </ul>
      )}
    </section>
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
  const paused = server.is_paused;
  const playerCount = server.player_count ?? 0;
  const isLive = playerCount > 0;
  return (
    <li className="bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded px-4 py-3 hover:border-[color:var(--accent)]/50 transition-colors">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-semibold flex items-center gap-2 flex-wrap">
            <span className="truncate">{server.name}</span>
            {locked && (
              <span
                className="text-[10px] uppercase tracking-wider text-zinc-400 bg-zinc-800 rounded px-1.5 py-0.5"
                title="Password required"
              >
                Locked
              </span>
            )}
            {isOwner && (
              <span className="text-[10px] uppercase tracking-wider text-[color:var(--accent)] border border-[color:var(--accent)]/50 rounded px-1.5 py-0.5">
                Owner
              </span>
            )}
            {paused && (
              <span className="text-[10px] uppercase tracking-wider text-amber-400 border border-amber-700/60 rounded px-1.5 py-0.5">
                Paused
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 mt-1 flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  isLive ? 'bg-emerald-500' : 'bg-zinc-600'
                }`}
                aria-hidden
              />
              <span className={isLive ? 'text-zinc-300' : ''}>
                {playerCount}/{server.max_slots}
              </span>
            </span>
            <span>·</span>
            <span className="font-mono">{server.id.slice(0, 8)}</span>
            {server.mode === 'deathmatch' && server.arena_scene_id && (
              <>
                <span>·</span>
                <span className="text-red-300/80">{server.arena_scene_id}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isOwner && <DeleteServerButton serverId={server.id} />}
          {paused && !isOwner ? (
            <span className="px-4 py-2 rounded border border-[color:var(--panel-border)] text-zinc-500 text-sm">
              Paused
            </span>
          ) : (
            <Link
              href={`/play/${server.id}`}
              className="px-4 py-2 rounded border border-[color:var(--panel-border)] hover:bg-[color:var(--bg)] hover:border-[color:var(--accent)] text-sm font-medium"
            >
              {paused && isOwner ? 'Resume' : 'Join'}
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}
