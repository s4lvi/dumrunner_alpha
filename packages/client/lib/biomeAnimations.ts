// Phase D: biome ambient tile animations.
//
// Maps the time-driven frame index + per-cell offset to a
// pre-sliced Pixi Texture. Built on top of the manifest +
// spritesheet caches in animations.ts — adds zero new state.
//
// Hot-path budget:
//   Wall raycaster runs ~1000 columns × 60fps. The lookup must
//   stay O(1) per call. Three dict lookups (manifest, frames,
//   array index) is exactly that, and the manifest + frames are
//   cached the first time the spritesheet loads.
//
// Per-cell offset (decision #3 of the animation plan): each cell
// rolls its own time offset so flicker reads independently. For
// walls the caller feeds pickCellVariant's hash as `cellSeed`.
// Floor and ceiling strips can't subdivide per cell without
// exploding the mesh count, so they pass `cellSeed = 0` and the
// whole surface shares one frame at a time.

'use client';

import type { Texture } from 'pixi.js';
import { getAnimationDef, getStateFrames } from './animations';

/**
 * Returns the active frame Texture for a biome tile, or null
 * when no animation manifest is authored for `animationId`.
 * Caller falls through to the static texture override path in
 * that case.
 *
 * Convention: biome animations carry a single `idle` looping
 * state.
 */
export function getBiomeTileTexture(
  animationId: string | undefined | null,
  now: number,
  cellSeed: number,
): Texture | null {
  if (!animationId) return null;
  const def = getAnimationDef(animationId);
  if (!def) return null;
  const state = def.states.idle;
  if (!state || state.frames < 1 || state.fps <= 0) return null;
  const tick = Math.floor((now * state.fps) / 1000);
  const offset = cellSeed | 0;
  const idx =
    ((tick + offset) % state.frames + state.frames) % state.frames;
  const frames = getStateFrames(
    animationId,
    'idle',
    state.frames,
    state.source ?? 'sheet',
  );
  return frames[idx] ?? null;
}
