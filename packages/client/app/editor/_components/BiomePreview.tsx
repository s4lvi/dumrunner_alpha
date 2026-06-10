'use client';

// Biome preview pane. Hits /api/editor/procgen for a top-down
// view of the generated dungeon — no game server WS, no sandbox,
// no rendering pipeline. Just procgen output.

import { useCallback, useEffect, useState } from 'react';
import type { SceneLayout } from '@dumrunner/shared';
import { Button } from './Form';
import { TopdownMap } from './TopdownMap';

export function BiomePreview({ biomeId }: { biomeId: string }) {
  const [cycle, setCycle] = useState<number>(0);
  const [floorIndex, setFloorIndex] = useState<number>(1);
  const [worldSeed, setWorldSeed] = useState<number>(42);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [layout, setLayout] = useState<SceneLayout | null>(null);

  const regen = useCallback(async (): Promise<void> => {
    if (!biomeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/editor/procgen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ biome: biomeId, worldSeed, cycle, floorIndex }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `procgen ${res.status}`);
      }
      const body = (await res.json()) as { layout: SceneLayout };
      setLayout(body.layout);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [biomeId, cycle, floorIndex, worldSeed]);

  // Auto-fetch on mount + when the biome id changes.
  useEffect(() => {
    void regen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biomeId]);

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/40 shrink-0 text-[10px] text-zinc-400">
        <span className="font-mono">{loading ? 'generating…' : 'ready'}</span>
        <span className="ml-2">
          biome:{' '}
          <span className="text-zinc-300 font-mono">{biomeId || '(no id)'}</span>
        </span>
        <label className="flex items-center gap-1 ml-3">
          <span>cycle</span>
          <input
            type="number"
            value={cycle}
            min={0}
            onChange={(e) => setCycle(parseInt(e.target.value, 10) || 0)}
            className="w-14 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 font-mono"
          />
        </label>
        <label className="flex items-center gap-1">
          <span>floor</span>
          <input
            type="number"
            value={floorIndex}
            min={1}
            onChange={(e) =>
              setFloorIndex(Math.max(1, parseInt(e.target.value, 10) || 1))
            }
            className="w-14 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 font-mono"
          />
        </label>
        <label className="flex items-center gap-1">
          <span>seed</span>
          <input
            type="number"
            value={worldSeed}
            onChange={(e) => setWorldSeed(parseInt(e.target.value, 10) || 0)}
            className="w-20 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 font-mono"
          />
        </label>
        <Button onClick={regen} disabled={loading || !biomeId}>
          Regenerate
        </Button>
        {error && (
          <span className="ml-auto text-red-300 font-mono truncate max-w-[40%]">
            {error}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        <TopdownMap layout={layout} />
      </div>
    </div>
  );
}
