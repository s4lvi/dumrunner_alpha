'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listEntities } from '@/lib/editorContentClient';

type Area =
  | 'biomes'
  | 'enemies'
  | 'props'
  | 'rooms'
  | 'blueprints'
  | 'weapons'
  | 'recipes'
  | 'attachments'
  | 'animations';

const AREAS: Area[] = [
  'biomes',
  'enemies',
  'props',
  'rooms',
  'blueprints',
  'weapons',
  'recipes',
  'attachments',
  'animations',
];

type Row = { area: Area; id: string; label: string };

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        AREAS.map(async (area) => {
          try {
            const entries = await listEntities(area);
            return entries.map((e) => ({
              area,
              id: e.id,
              label: (e as { label?: string }).label ?? e.id,
            }));
          } catch {
            return [] as Row[];
          }
        }),
      );
      if (cancelled) return;
      setRows(results.flat());
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  useEffect(() => {
    if (open) {
      setActive(0);
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows.slice(0, 80);
    return rows
      .filter(
        (r) =>
          r.id.toLowerCase().includes(q) ||
          r.label.toLowerCase().includes(q) ||
          r.area.toLowerCase().includes(q),
      )
      .slice(0, 80);
  }, [rows, query]);

  const go = useCallback(
    (row: Row) => {
      const path = `/editor/${row.area}?id=${encodeURIComponent(row.id)}`;
      setOpen(false);
      router.push(path);
    },
    [router],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-zinc-950/80"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl bg-zinc-900 border border-zinc-700 rounded-md shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const row = filtered[active];
              if (row) go(row);
            }
          }}
          placeholder={loaded ? 'search' : 'loading…'}
          className="w-full bg-transparent border-b border-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none"
        />
        <ul className="max-h-80 overflow-y-auto">
          {filtered.map((row, i) => (
            <li key={`${row.area}:${row.id}`}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(row)}
                className={`w-full text-left flex items-baseline gap-3 px-3 py-1.5 ${
                  i === active
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/60'
                }`}
              >
                <span className="text-[9px] uppercase tracking-[0.15em] text-zinc-500 w-20 shrink-0">
                  {row.area}
                </span>
                <span className="flex-1 truncate text-sm">{row.label}</span>
                <span className="font-mono text-[10px] text-zinc-500">
                  {row.id}
                </span>
              </button>
            </li>
          ))}
          {loaded && filtered.length === 0 && (
            <li className="px-3 py-2 text-xs text-zinc-500">no matches</li>
          )}
        </ul>
        <div className="border-t border-zinc-800 px-3 py-1 text-[10px] text-zinc-600 font-mono flex justify-between">
          <span>↑↓ ↵</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
