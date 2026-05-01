'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function DeleteServerButton({ serverId }: { serverId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleDelete() {
    setError(null);
    try {
      const res = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // Refresh the server list so the deleted row disappears.
      startTransition(() => router.refresh());
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="px-3 py-2 rounded border border-[color:var(--panel-border)] text-zinc-400 hover:text-red-400 hover:border-red-900 text-sm"
      >
        Delete
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-400">Sure?</span>
      <button
        onClick={handleDelete}
        disabled={isPending}
        className="px-3 py-2 rounded text-sm bg-red-900 text-red-100 hover:bg-red-800 disabled:opacity-50"
      >
        {isPending ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
        className="px-3 py-2 rounded border border-[color:var(--panel-border)] text-sm text-zinc-400 hover:bg-[color:var(--bg)]"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
