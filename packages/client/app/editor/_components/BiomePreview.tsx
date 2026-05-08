'use client';

// Biome preview pane. Top-down generation overview only —
// designed for validating procgen output (room placement,
// corridor shape, hazard pockets) at a glance. The full iso /
// fps sandbox lives at /editor/sandbox-test for actual play
// testing. This view is passive: regen sliders + the topdown
// canvas, no input.

import { useEffect, useRef, useState } from 'react';
import {
  SandboxPreview,
  type SandboxPreviewHandle,
} from './SandboxPreview';
import { Button } from './Form';
import type { SandboxConnectionStatus } from '@/lib/sandbox';

export function BiomePreview({ biomeId }: { biomeId: string }) {
  const previewRef = useRef<SandboxPreviewHandle | null>(null);
  const [status, setStatus] = useState<SandboxConnectionStatus>('idle');
  const [cycle, setCycle] = useState<number>(0);
  const [floorIndex, setFloorIndex] = useState<number>(1);
  const [worldSeed, setWorldSeed] = useState<number>(42);
  const [error, setError] = useState<string | null>(null);
  const [autoRegenned, setAutoRegenned] = useState(false);

  // Auto-regen on first connect so the canvas starts on the
  // biome rather than the empty surface.
  useEffect(() => {
    if (status !== 'connected' || autoRegenned || !biomeId) return;
    previewRef.current?.regenFloor({ biome: biomeId, cycle, floorIndex, worldSeed });
    setAutoRegenned(true);
  }, [status, autoRegenned, biomeId, cycle, floorIndex, worldSeed]);

  function regen(): void {
    if (!biomeId) return;
    previewRef.current?.regenFloor({ biome: biomeId, cycle, floorIndex, worldSeed });
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/40 shrink-0 text-[10px] text-zinc-400">
        <span className="font-mono">{status}</span>
        <span className="ml-2">biome: <span className="text-zinc-300 font-mono">{biomeId || '(no id)'}</span></span>
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
        <Button
          onClick={regen}
          disabled={status !== 'connected' || !biomeId}
        >
          Regenerate
        </Button>
        {error && (
          <span className="ml-auto text-red-300 font-mono truncate max-w-[40%]">
            {error}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        <SandboxPreview
          ref={previewRef}
          mode="topdown"
          onStatusChange={setStatus}
          onError={(e) => setError(e.message)}
        />
      </div>
    </div>
  );
}
