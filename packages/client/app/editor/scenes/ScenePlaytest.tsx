'use client';

// Editor playtest overlay. Renders the live-game host
// (`<Game mode="sandbox" ... />`) so the editor session uses
// the exact same input handlers, WS dispatch, audio, and UI as
// a real game — the only difference is which session URL the
// page bootstraps against. No parallel host code, no parallel
// engine.

import { useEffect } from 'react';
import type { LinedefScene } from '@dumrunner/shared';
import { Game } from '@/app/play/[id]/Game';

type Props = {
  scene: LinedefScene;
  // Bumped by the editor on save. Each bump triggers a live
  // reload of the running sandbox.
  reloadTick: number;
  onClose: () => void;
};

export function ScenePlaytest({ scene, reloadTick, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/80 text-xs">
        <div className="flex items-center gap-3">
          <span className="text-zinc-200 font-medium">Playtest</span>
          <span className="text-zinc-500">{scene.name}</span>
        </div>
        <div className="flex items-center gap-3 text-zinc-500">
          <span className="text-zinc-600">Esc to exit</span>
          <button
            onClick={onClose}
            className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-200"
          >
            ✕ Close
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <Game
          mode="sandbox"
          sandboxScene={scene}
          sandboxReloadTick={reloadTick}
          onSandboxClose={onClose}
        />
      </div>
    </div>
  );
}
