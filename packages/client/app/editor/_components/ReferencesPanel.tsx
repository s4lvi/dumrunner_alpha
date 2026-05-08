'use client';

// References panel — drops into editor pages to show "this
// entity references X" + "this entity is referenced by Y" for
// the currently-edited entry. Pulls the cross-reference graph
// from /api/editor/refs and filters to the active id.
//
// Refresh on demand (and after a save in the parent page) by
// passing a `key` that changes whenever the dependent state
// updates. The endpoint is cheap; refreshing per save is fine.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  AssetSlot,
  RefEdge,
  RefEntity,
  RefsResponse,
} from '@/app/api/editor/refs/route';

const AREA_LABEL: Record<RefEntity['area'], string> = {
  biomes: 'Biome',
  enemies: 'Enemy',
  props: 'Prop',
  rooms: 'Room',
  corridors: 'Corridor',
};

export function ReferencesPanel({
  area,
  id,
}: {
  area: RefEntity['area'];
  id: string;
}) {
  const [edges, setEdges] = useState<RefEdge[]>([]);
  const [assets, setAssets] = useState<AssetSlot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch('/api/editor/refs', { cache: 'no-store' });
        if (!r.ok) throw new Error(`refs fetch ${r.status}`);
        const body = (await r.json()) as RefsResponse;
        if (cancelled) return;
        setEdges(body.edges);
        setAssets(body.assets);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [area, id]);

  // What this entity references.
  const outgoing = edges.filter(
    (e) => e.from.area === area && e.from.id === id,
  );
  // Who references this entity.
  const incoming = edges.filter(
    (e) => e.to.area === area && e.to.id === id,
  );
  // Asset slots tied to this entity.
  const ownAssets = assets.filter(
    (a) => a.required_by.area === area && a.required_by.id === id,
  );
  const missingAssets = ownAssets.filter((a) => !a.present);

  if (!id) return null;
  return (
    <div className="space-y-3 text-[11px] font-mono">
      {error && (
        <pre className="bg-red-950/50 border border-red-900 text-red-200 p-2 rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {loading && <div className="text-zinc-500">loading refs…</div>}
      {!loading && (
        <>
          <Block
            title={`References (${outgoing.length})`}
            empty="no outgoing references"
          >
            {outgoing.map((e, i) => (
              <RefRow key={i} ref={e.to} field={e.field} />
            ))}
          </Block>
          <Block
            title={`Referenced by (${incoming.length})`}
            empty="not referenced anywhere"
          >
            {incoming.map((e, i) => (
              <RefRow key={i} ref={e.from} field={e.field} reverse />
            ))}
          </Block>
          <Block
            title={`Assets (${ownAssets.length - missingAssets.length}/${ownAssets.length})`}
            empty="no asset slots required"
          >
            {ownAssets.map((a, i) => (
              <AssetRow key={i} slot={a} />
            ))}
          </Block>
        </>
      )}
    </div>
  );
}

function Block({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children?: React.ReactNode;
}) {
  const hasChildren =
    Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div>
      <div className="text-[10px] uppercase text-zinc-500 mb-1">{title}</div>
      <div className="space-y-0.5">
        {hasChildren ? (
          children
        ) : (
          <div className="text-zinc-600">{empty}</div>
        )}
      </div>
    </div>
  );
}

function RefRow({
  ref,
  field,
  reverse,
}: {
  ref: RefEntity;
  field: string;
  reverse?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-zinc-600 w-16 shrink-0">
        {AREA_LABEL[ref.area]}
      </span>
      <Link
        href={`/editor/${ref.area}?id=${encodeURIComponent(ref.id)}`}
        className="text-zinc-300 hover:text-zinc-100 underline-offset-2 hover:underline truncate"
      >
        {ref.id}
      </Link>
      <span className="text-zinc-600 text-[10px] truncate ml-auto">
        {reverse ? '← ' : '→ '}
        {field}
      </span>
    </div>
  );
}

function AssetRow({ slot }: { slot: AssetSlot }) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={`w-3 text-center ${
          slot.present ? 'text-emerald-400' : 'text-red-400'
        }`}
      >
        {slot.present ? '✓' : '✗'}
      </span>
      <span className="text-zinc-600 w-24 shrink-0 truncate">
        {slot.category}
      </span>
      <span className="text-zinc-300 truncate">{slot.id}</span>
      <span className="text-zinc-600 text-[10px] ml-auto truncate">
        {slot.reason}
      </span>
    </div>
  );
}
