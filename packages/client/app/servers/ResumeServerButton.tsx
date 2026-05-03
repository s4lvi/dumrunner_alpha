'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ResumeServerButton({ serverId }: { serverId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleResume() {
    setError(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/resume`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <button
        onClick={handleResume}
        disabled={isPending}
        className="px-3 py-2 rounded text-sm border border-amber-900 text-amber-300 hover:bg-amber-900/20 disabled:opacity-50"
      >
        {isPending ? 'Resuming…' : 'Unpause'}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </>
  );
}
