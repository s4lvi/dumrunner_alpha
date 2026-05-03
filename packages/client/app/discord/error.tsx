'use client';

// Activity error boundary. Inside the Discord iframe, Next.js's
// default "Application error: a client-side exception has occurred"
// hides the actual cause. This boundary surfaces the message + name
// + stack so we can read it without opening DevTools.

import { useEffect } from 'react';

export default function DiscordError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[discord/error]', error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-start justify-center bg-[color:var(--bg)] text-zinc-200 px-6 py-10">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-2xl font-bold text-red-400">Activity error</h1>
        <p className="text-sm text-zinc-400">
          The Activity boot crashed. Details below — paste these back to debug.
        </p>
        <div className="bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded p-3 text-xs font-mono break-all whitespace-pre-wrap">
          <div><span className="text-zinc-500">name:</span> {error.name}</div>
          <div><span className="text-zinc-500">message:</span> {error.message}</div>
          {error.digest && (
            <div><span className="text-zinc-500">digest:</span> {error.digest}</div>
          )}
          {error.stack && (
            <details className="mt-2">
              <summary className="cursor-pointer text-zinc-500">stack</summary>
              <pre className="mt-2 text-[10px] leading-snug">{error.stack}</pre>
            </details>
          )}
        </div>
        <button
          type="button"
          onClick={reset}
          className="px-4 py-2 rounded bg-[color:var(--accent)] text-black font-semibold"
        >
          Retry
        </button>
      </div>
    </main>
  );
}
