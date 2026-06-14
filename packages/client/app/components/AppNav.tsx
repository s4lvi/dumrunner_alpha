import Link from 'next/link';
import { getSessionUser } from './session';

export async function AppNav() {
  const user = await getSessionUser();

  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-[color:var(--bg)]/80 border-b border-[color:var(--panel-border)]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4 sm:gap-6">
        <Link
          href="/servers"
          className="font-black tracking-widest text-lg shrink-0"
          style={{ color: 'var(--accent)' }}
        >
          DÛM RUNNER
        </Link>
        <nav className="flex items-center gap-3 sm:gap-4 text-sm text-zinc-400">
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
          <span
            className="hidden sm:inline font-mono text-[10px] text-zinc-600"
            title={`commit ${process.env.NEXT_PUBLIC_COMMIT_SHA ?? 'dev'}`}
          >
            v{process.env.NEXT_PUBLIC_BUILD_NUMBER ?? '0'}·
            {process.env.NEXT_PUBLIC_COMMIT_SHA ?? 'dev'}
          </span>
          {user?.displayName && (
            <span className="hidden sm:inline text-zinc-300 truncate max-w-[12rem]">
              {user.displayName}
            </span>
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
