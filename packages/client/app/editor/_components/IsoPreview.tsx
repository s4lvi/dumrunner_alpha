// Headless top-down preview wrapper for editor panes. Mounts
// runTopdownGame against a hand-built scene and tears down on
// unmount / when the init prop changes. Per-domain editors
// (biome, enemy, decorator) describe their own scene via the
// `buildInit` callback so the preview reflects whatever the
// form is editing in real time.
//
// Name retained for back-compat — was previously the iso renderer
// before the iso renderer was retired.

'use client';

import { useEffect, useRef } from 'react';
import { runTopdownGame } from '@/lib/game/topdown';
import type { GameHandle, GameInit } from '@/lib/game/pixi';

export function IsoPreview({
  buildInit,
  // Including a `signature` string forces the renderer to
  // remount when the editor's data changes. Caller computes a
  // simple "hash" (typically JSON.stringify of the relevant
  // bits) so we don't try to deeply diff GameInit.
  signature,
}: {
  buildInit: () => GameInit;
  signature: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let game: GameHandle | null = null;
    try {
      game = runTopdownGame(host, buildInit());
    } catch (e) {
      // Bad init (e.g. missing layout) shouldn't crash the page.
      // eslint-disable-next-line no-console
      console.error('[IsoPreview] failed to mount', e);
    }
    return () => {
      try {
        game?.destroy();
      } catch {
        /* swallow — destroy ordering races */
      }
    };
    // signature drives the remount; buildInit is intentionally
    // not in the deps because it captures the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return (
    <div
      ref={hostRef}
      className="w-full h-full bg-zinc-950 rounded border border-zinc-800 overflow-hidden"
    />
  );
}
