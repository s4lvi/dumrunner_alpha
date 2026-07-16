import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';

type SearchParams = Record<string, string | string[] | undefined>;

// Discord Activity URL Mappings serve the proxy at `/`, so the
// iframe lands here. Detect the launch by `frame_id` (Discord
// always injects it) and bounce to `/discord` preserving every
// query param — the embedded SDK reads them when constructing
// `new DiscordSDK(...)`.
function isDiscordActivityLaunch(sp: SearchParams): boolean {
  return typeof sp.frame_id === 'string' && sp.frame_id.length > 0;
}

function buildQueryString(sp: SearchParams): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((vv) => usp.append(k, vv));
    else if (typeof v === 'string') usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export default async function Landing({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  if (isDiscordActivityLaunch(sp)) {
    redirect(`/discord${buildQueryString(sp)}`);
  }

  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    redirect('/servers');
  }

  return (
    <main className="scanlines min-h-screen flex flex-col items-center justify-center px-6">
      <div className="max-w-xl text-center">
        <p className="font-mono text-[11px] tracking-[0.35em] text-zinc-500 mb-4">
          DÛM ORBITAL RELAY · INCOMING TRANSMISSION
          <span className="cursor-blink">▮</span>
        </p>
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
            className="px-6 py-3 rounded-sm font-mono font-semibold tracking-[0.15em] border border-[color:var(--panel-border)] hover:bg-[color:var(--panel)]"
          >
            SIGN IN
          </Link>
          <Link
            href="/register"
            className="px-6 py-3 rounded-sm font-mono font-bold tracking-[0.15em] bg-[color:var(--accent)] text-black hover:brightness-110"
          >
            ENLIST
          </Link>
        </div>
        <div className="mt-12 flex gap-4 justify-center text-xs text-zinc-500">
          <Link href="/terms" className="hover:text-zinc-300">Terms</Link>
          <span aria-hidden>·</span>
          <Link href="/privacy" className="hover:text-zinc-300">Privacy</Link>
        </div>
      </div>
    </main>
  );
}
