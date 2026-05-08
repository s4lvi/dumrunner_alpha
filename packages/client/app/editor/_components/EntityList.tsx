'use client';

// Sidebar list used by every per-entity editor. Renders the title,
// "+ new" button, empty-state hint, and a button per entry.
// Per-entry rendering is delegated to renderItem so each editor
// can show its domain-specific summary (palette swatch for biomes,
// damage tag for enemies, size for rooms, etc.).

import type { ReactNode } from 'react';
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
  onNew: () => void;
  emptyHint?: string;
  renderItem: (entry: T) => ReactNode;
}) {
  return (
    <aside className="w-60 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 space-y-2">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-xs uppercase text-zinc-500">{title}</h2>
        <Button onClick={onNew}>+ new</Button>
      </div>
      {entries.length === 0 && emptyHint && (
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
