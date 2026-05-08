'use client';

// Sandbox preview test bench. Embeds an iso-rendered sandbox
// scene; controls along the top spawn enemies + clear. Player
// movement (WASD) is wired through SandboxPreview's input
// callback, so the editor user can walk around the arena and
// observe AI behaviour. Click-to-fire works too if the editor
// player gets a weapon — none equipped by default in this
// minimal slice; future enhancement is a "loadout: creative"
// command that hands the editor a pistol.

import { useRef, useState } from 'react';
import {
  SandboxPreview,
  type SandboxPreviewHandle,
  type SandboxPreviewMode,
} from '../_components/SandboxPreview';
import { Button } from '../_components/Form';
import type { SandboxConnectionStatus } from '@/lib/sandbox';

export default function SandboxTestPage() {
  const previewRef = useRef<SandboxPreviewHandle | null>(null);
  const [status, setStatus] = useState<SandboxConnectionStatus>('idle');
  const [mode, setMode] = useState<SandboxPreviewMode>('fps');
  const [enemyKinds, setEnemyKinds] = useState<string[]>([]);
  const [biomeIds, setBiomeIds] = useState<string[]>([]);
  const [selectedKind, setSelectedKind] = useState<string>('');
  const [floorBiome, setFloorBiome] = useState<string>('default');
  const [floorCycle, setFloorCycle] = useState<number>(0);
  const [floorIndex, setFloorIndex] = useState<number>(1);
  const [worldSeed, setWorldSeed] = useState<number>(42);
  const [error, setError] = useState<string | null>(null);

  function spawn(): void {
    if (!previewRef.current || !selectedKind) return;
    // Drop the enemy near the editor player so it's always on
    // screen, regardless of where they've walked.
    previewRef.current.spawnEnemyNearSelf(selectedKind);
  }

  function clearAll(): void {
    previewRef.current?.clear('all');
  }

  function equipCreative(): void {
    previewRef.current?.setLoadout('creative');
  }

  function equipUnarmed(): void {
    previewRef.current?.setLoadout('unarmed');
  }

  function regenFloor(): void {
    previewRef.current?.regenFloor({
      biome: floorBiome,
      cycle: floorCycle,
      floorIndex: floorIndex,
      worldSeed: worldSeed,
    });
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <span className="text-[10px] font-mono text-zinc-500">
          status: <span className="text-zinc-300">{status}</span>
        </span>
        <div className="ml-2 flex gap-1">
          <button
            type="button"
            onClick={() => setMode('fps')}
            className={`text-[10px] px-2 py-0.5 rounded border ${
              mode === 'fps'
                ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800/50'
            }`}
          >
            fps
          </button>
          <button
            type="button"
            onClick={() => setMode('topdown')}
            className={`text-[10px] px-2 py-0.5 rounded border ${
              mode === 'topdown'
                ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800/50'
            }`}
          >
            topdown
          </button>
        </div>
        <label className="ml-4 flex items-center gap-1 text-xs">
          <span className="text-zinc-300">enemy kind</span>
          <select
            value={selectedKind}
            onChange={(e) => setSelectedKind(e.target.value)}
            disabled={enemyKinds.length === 0}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-xs font-mono"
          >
            {enemyKinds.length === 0 && <option>(loading)</option>}
            {enemyKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={spawn}
          disabled={status !== 'connected' || !selectedKind}
        >
          Spawn
        </Button>
        <Button
          variant="danger"
          onClick={clearAll}
          disabled={status !== 'connected'}
        >
          Clear all
        </Button>
        <div className="ml-2 flex gap-1">
          <Button
            onClick={equipCreative}
            disabled={status !== 'connected'}
          >
            Creative loadout
          </Button>
          <Button
            onClick={equipUnarmed}
            disabled={status !== 'connected'}
          >
            Unarmed
          </Button>
        </div>
        {error && (
          <span className="ml-auto text-[10px] text-red-300 font-mono truncate max-w-[40%]">
            {error}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-1 border-b border-zinc-800 bg-zinc-900/20 shrink-0 text-[10px] text-zinc-400">
        <span className="font-mono">regen floor:</span>
        <label className="flex items-center gap-1">
          <span>biome</span>
          <select
            value={floorBiome}
            onChange={(e) => setFloorBiome(e.target.value)}
            disabled={biomeIds.length === 0}
            className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 font-mono"
          >
            {biomeIds.length === 0 && <option>(loading)</option>}
            {biomeIds.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span>cycle</span>
          <input
            type="number"
            value={floorCycle}
            min={0}
            onChange={(e) => setFloorCycle(parseInt(e.target.value, 10) || 0)}
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
          onClick={regenFloor}
          disabled={status !== 'connected' || !floorBiome}
        >
          Regenerate
        </Button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <SandboxPreview
          ref={previewRef}
          mode={mode}
          onStatusChange={setStatus}
          onError={(e) => setError(e.message)}
          onWelcome={(welcome) => {
            const kinds = Object.keys(welcome.enemyVisuals).sort();
            setEnemyKinds(kinds);
            if (kinds.length > 0 && !selectedKind) {
              setSelectedKind(kinds[0]);
            }
            const biomes = Object.keys(welcome.biomes).sort();
            setBiomeIds(biomes);
            if (biomes.length > 0 && !biomes.includes(floorBiome)) {
              setFloorBiome(biomes[0]);
            }
          }}
        />
      </div>
    </div>
  );
}
