'use client';

// Room template preview pane. Embeds a sandbox arena and stamps
// the template into a single-room scene so the author sees the
// painted layout exactly as it'll render in-game (with the
// chosen biome's tileset). A biome dropdown lets you preview
// the same template across every biome it targets.

import { useEffect, useRef, useState } from 'react';
import {
  SandboxPreview,
  type SandboxPreviewHandle,
  type SandboxPreviewMode,
} from './SandboxPreview';
import { Button } from './Form';
import type { SandboxConnectionStatus } from '@/lib/sandbox';

export function RoomPreview({
  templateId,
  biomeAffinity,
}: {
  templateId: string;
  biomeAffinity: string[];
}) {
  const previewRef = useRef<SandboxPreviewHandle | null>(null);
  const [status, setStatus] = useState<SandboxConnectionStatus>('idle');
  const mode: SandboxPreviewMode = 'fps-v2';
  const [biome, setBiome] = useState<string>(biomeAffinity[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [autoStamped, setAutoStamped] = useState(false);

  // Keep the biome selection in sync if the template's affinity
  // list changes and the current pick is no longer valid.
  useEffect(() => {
    if (biomeAffinity.length === 0) return;
    if (!biomeAffinity.includes(biome)) {
      setBiome(biomeAffinity[0]);
    }
  }, [biomeAffinity, biome]);

  // Stamp on first connect so the canvas shows the room
  // immediately — no extra click required.
  useEffect(() => {
    if (status !== 'connected' || autoStamped || !templateId) return;
    previewRef.current?.stampRoom(templateId, biome || undefined);
    setAutoStamped(true);
  }, [status, autoStamped, templateId, biome]);

  function stamp(): void {
    if (!templateId) return;
    previewRef.current?.stampRoom(templateId, biome || undefined);
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/40 shrink-0 text-[10px] text-zinc-400">
        <span className="font-mono">{status}</span>
        <span className="ml-2">
          template: <span className="text-zinc-300 font-mono">{templateId || '(no id)'}</span>
        </span>
        <label className="flex items-center gap-1 ml-3">
          <span>biome</span>
          <select
            value={biome}
            onChange={(e) => setBiome(e.target.value)}
            disabled={biomeAffinity.length === 0}
            className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 font-mono"
          >
            {biomeAffinity.length === 0 && <option>(no affinity)</option>}
            {biomeAffinity.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={stamp}
          disabled={status !== 'connected' || !templateId}
        >
          Restamp
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
          mode={mode}
          onStatusChange={setStatus}
          onError={(e) => setError(e.message)}
        />
      </div>
    </div>
  );
}

