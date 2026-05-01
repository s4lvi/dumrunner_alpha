import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';

// Shared top navigation for all out-of-game pages (server browser, server
// create, account settings). Renders the brand mark, links, and the signed-in
// account's display name with a sign-out button.
export async function AppNav() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let displayName: string | null = null;
  if (user) {
    const { data: account } = await supabase
      .from('accounts')
      .select('display_name')
      .eq('id', user.id)
      .single();
    displayName = account?.display_name ?? null;
  }

  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-[color:var(--bg)]/80 border-b border-[color:var(--panel-border)]">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center gap-6">
        <Link
          href="/servers"
          className="font-black tracking-widest text-lg"
          style={{ color: 'var(--accent)' }}
        >
          DÛM RUNNER
        </Link>
        <nav className="flex items-center gap-4 text-sm text-zinc-400">
          <Link
            href="/servers"
            className="hover:text-zinc-100 transition-colors"
          >
            Servers
          </Link>
          <Link
            href="/settings"
            className="hover:text-zinc-100 transition-colors"
          >
            Settings
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {displayName && (
            <span className="text-zinc-300">{displayName}</span>
          )}
          {user && (
            <form action="/auth/sign-out" method="post">
              <button
                type="submit"
                className="px-3 py-1.5 rounded border border-[color:var(--panel-border)] text-zinc-400 hover:bg-[color:var(--panel)]"
              >
                Sign out
              </button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
