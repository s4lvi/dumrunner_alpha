'use client';

import { useState, type ReactNode } from 'react';
import { Button } from './Form';

export function EntityList<T extends { id: string }>({
  title,
  entries,
  selectedId,
  onSelect,
  onNew,
  emptyHint,
  renderItem,
}: {
  title: string;
  entries: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: (id?: string) => boolean | void;
  emptyHint?: string;
  renderItem: (entry: T) => ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [draftId, setDraftId] = useState('');

  function submit(): void {
    const result = onNew(draftId);
    if (result === false) return;
    setCreating(false);
    setDraftId('');
  }

  return (
    <aside className="w-60 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 space-y-2">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-xs uppercase text-zinc-500">{title}</h2>
        {!creating && (
          <Button onClick={() => setCreating(true)}>+ new</Button>
        )}
      </div>
      {creating && (
        <div className="flex gap-1 mb-2">
          <input
            autoFocus
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setCreating(false);
                setDraftId('');
              }
            }}
            placeholder="id"
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs font-mono text-zinc-100 outline-none focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={submit}
            className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            ↵
          </button>
        </div>
      )}
      {entries.length === 0 && emptyHint && !creating && (
        <p className="text-[11px] text-zinc-500">{emptyHint}</p>
      )}
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onSelect(entry.id)}
          className={`w-full text-left px-2 py-1.5 rounded text-sm ${
            selectedId === entry.id
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-800/40'
          }`}
        >
          {renderItem(entry)}
        </button>
      ))}
    </aside>
  );
}
