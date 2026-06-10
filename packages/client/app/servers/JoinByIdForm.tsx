'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';

export function JoinByIdForm() {
  const router = useRouter();
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = id.trim();
    if (!trimmed) return;
    setError(null);
    setPending(true);

    const supabase = supabaseBrowser();
    const { data, error: queryError } = await supabase
      .from('servers_public')
      .select('id, is_paused')
      .eq('id', trimmed)
      .maybeSingle();

    if (queryError) {
      setPending(false);
      setError('Could not reach the server browser. Try again.');
      return;
    }
    if (!data) {
      setPending(false);
      setError('No server with that ID.');
      return;
    }
    if (data.is_paused) {
      setPending(false);
      setError('That server is paused.');
      return;
    }

    router.push(`/play/${data.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Server ID"
          className="flex-1 bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)] font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending || id.trim().length === 0}
          className="px-4 py-2 rounded border border-[color:var(--panel-border)] hover:bg-[color:var(--panel)] disabled:opacity-50"
        >
          {pending ? 'Checking…' : 'Join'}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
