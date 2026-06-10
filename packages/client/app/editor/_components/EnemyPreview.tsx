'use client';

// Enemy preview pane. Embeds a sandbox arena, gives the editor
// player a creative loadout once the connection is ready, and
// exposes "spawn this enemy" + "test fight" actions in a small
// toolbar above the canvas. The author can spawn the entity
// they're editing as a target dummy or fight it directly with
// the full creative kit.
//
// `enemyId` drives the spawn — when the editor renames or saves
// the enemy, this prop updates and subsequent spawns use the
// new id.

import { useEffect, useRef, useState } from 'react';
import {
  SandboxPreview,
  type SandboxPreviewHandle,
  type SandboxPreviewMode,
} from './SandboxPreview';
import { Button } from './Form';
import type { SandboxConnectionStatus } from '@/lib/sandbox';

export function EnemyPreview({ enemyId }: { enemyId: string }) {
  const previewRef = useRef<SandboxPreviewHandle | null>(null);
  const [status, setStatus] = useState<SandboxConnectionStatus>('idle');
  const mode: SandboxPreviewMode = 'fps-v2';
  const [error, setError] = useState<string | null>(null);
  const [loadoutApplied, setLoadoutApplied] = useState(false);

  // Apply creative loadout automatically once connected so click-
  // to-fire works without an extra step.
  useEffect(() => {
    if (status !== 'connected' || loadoutApplied) return;
    previewRef.current?.setLoadout('creative');
    setLoadoutApplied(true);
  }, [status, loadoutApplied]);

  function spawn(): void {
    if (!enemyId) return;
    previewRef.current?.spawnEnemyNearSelf(enemyId);
  }

  function clearEnemies(): void {
    previewRef.current?.clear('enemies');
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <span className="text-[10px] font-mono text-zinc-500">{status}</span>
        <span className="ml-3 text-[10px] font-mono text-zinc-500">
          spawning: <span className="text-zinc-300">{enemyId || '(no id)'}</span>
        </span>
        <Button
          onClick={spawn}
          disabled={status !== 'connected' || !enemyId}
        >
          Spawn
        </Button>
        <Button
          variant="danger"
          onClick={clearEnemies}
          disabled={status !== 'connected'}
        >
          Clear
        </Button>
        {error && (
          <span className="ml-auto text-[10px] text-red-300 font-mono truncate max-w-[40%]">
            {error}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        <SandboxPreview
          ref={previewRef}
          mode={mode}
          onStatusChange={setStatus}
          onError={(e) => setError(e.message)}
        />
      </div>
    </div>
  );
}

