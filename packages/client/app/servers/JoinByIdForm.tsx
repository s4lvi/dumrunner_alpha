'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function JoinByIdForm() {
  const router = useRouter();
  const [id, setId] = useState('');

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = id.trim();
    if (!trimmed) return;
    router.push(`/play/${trimmed}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex gap-2">
      <input
        type="text"
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="Server ID"
        className="flex-1 bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)]"
      />
      <button
        type="submit"
        className="px-4 py-2 rounded border border-[color:var(--panel-border)] hover:bg-[color:var(--panel)]"
      >
        Join
      </button>
    </form>
  );
}
