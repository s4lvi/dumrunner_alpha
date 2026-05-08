'use client';

// Asset health dashboard. Lists every required asset slot and
// flags missing ones so a content audit takes seconds instead
// of "click through every biome / enemy looking for ✗ marks."
//
// Pulls the same /api/editor/refs payload the per-entity panel
// uses; this page just slices it differently — grouped by area,
// missing-first.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  AssetSlot,
  RefEntity,
  RefsResponse,
} from '@/app/api/editor/refs/route';

const AREA_LABEL: Record<RefEntity['area'], string> = {
  biomes: 'Biomes',
  enemies: 'Enemies',
  props: 'Props',
  rooms: 'Rooms',
  corridors: 'Corridors',
};

export default function AssetHealthPage() {
  const [assets, setAssets] = useState<AssetSlot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPresent, setShowPresent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch('/api/editor/refs', { cache: 'no-store' });
        if (!r.ok) throw new Error(`refs fetch ${r.status}`);
        const body = (await r.json()) as RefsResponse;
        if (cancelled) return;
        setAssets(body.assets);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(
    () => (showPresent ? assets : assets.filter((a) => !a.present)),
    [assets, showPresent],
  );
  const grouped = useMemo(() => {
    const out: Record<RefEntity['area'], AssetSlot[]> = {
      biomes: [],
      enemies: [],
      props: [],
      rooms: [],
      corridors: [],
    };
    for (const a of filtered) {
      out[a.required_by.area].push(a);
    }
    return out;
  }, [filtered]);

  const totalCount = assets.length;
  const presentCount = assets.filter((a) => a.present).length;
  const missingCount = totalCount - presentCount;

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-bold">Asset health</h1>
        <span className="text-[11px] text-zinc-500 font-mono">
          {presentCount}/{totalCount} present · {missingCount} missing
        </span>
        <label className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={showPresent}
            onChange={(e) => setShowPresent(e.target.checked)}
          />
          show present too
        </label>
      </div>
      {loading && <div className="text-zinc-500 text-sm">loading…</div>}
      {error && (
        <pre className="bg-red-950/50 border border-red-900 text-red-200 text-[11px] font-mono p-2 rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {!loading && !error && missingCount === 0 && !showPresent && (
        <div className="text-emerald-400 text-sm">
          ✓ all required assets are present
        </div>
      )}
      {(['biomes', 'enemies', 'props', 'rooms'] as const).map((area) => {
        const items = grouped[area];
        if (items.length === 0) return null;
        return (
          <section key={area} className="space-y-1">
            <h2 className="text-xs uppercase text-zinc-500">
              {AREA_LABEL[area]}{' '}
              <span className="text-zinc-600 lowercase">({items.length})</span>
            </h2>
            <div className="border border-zinc-800 rounded divide-y divide-zinc-800 text-[11px] font-mono">
              {items.map((a, i) => (
                <div
                  key={i}
                  className="px-2 py-1 flex items-baseline gap-2"
                >
                  <span
                    className={`w-3 text-center ${
                      a.present ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {a.present ? '✓' : '✗'}
                  </span>
                  <Link
                    href={`/editor/${area}?id=${encodeURIComponent(
                      a.required_by.id,
                    )}`}
                    className="text-zinc-300 hover:text-zinc-100 hover:underline w-32 truncate"
                  >
                    {a.required_by.id}
                  </Link>
                  <span className="text-zinc-500 w-28 truncate">
                    {a.category}
                  </span>
                  <span className="text-zinc-300 truncate">{a.id}</span>
                  <span className="text-zinc-600 ml-auto truncate text-[10px]">
                    {a.reason}
                  </span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
