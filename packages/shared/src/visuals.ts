// Shared visual constants used by BOTH client renderers (top-down Pixi
// and the FPS raycaster). Keeping them here means a tweak to enemy
// visuals or part tiers takes one edit instead of two — and any new
// enemy template the server adds gets a consistent fallback in both
// views.
//
// MATERIALS already carries per-material colors in inventory.ts; render
// callers should read `MATERIALS[id].color` directly instead of a
// parallel table here.

import { MATERIALS, type MaterialKind } from './inventory';
import type { PartTier } from './protocol';

export type EnemyVisual = {
  shape: 'square' | 'circle' | 'triangle';
  color: number;
  size: number;
};

// Keyed by enemy template id. Templates whose AI/data side land in
// server/ai/templates.ts SHOULD get an entry here; missing ids fall
// back to FALLBACK_ENEMY_VISUAL.
export const ENEMY_VISUALS: Record<string, EnemyVisual> = {
  dummy_target:  { shape: 'square',   color: 0xef4444, size: 18 },
  chaser_melee:  { shape: 'triangle', color: 0xa855f7, size: 16 },
  shooter_drone: { shape: 'circle',   color: 0x60a5fa, size: 14 },
  brute_chaser:  { shape: 'square',   color: 0xb45309, size: 26 },
  swarmer:       { shape: 'triangle', color: 0xfb7185, size: 12 },
  armored:       { shape: 'square',   color: 0x4b5563, size: 22 },
};

export const FALLBACK_ENEMY_VISUAL: EnemyVisual = ENEMY_VISUALS.dummy_target;

export function enemyVisualFor(kind: string): EnemyVisual {
  return ENEMY_VISUALS[kind] ?? FALLBACK_ENEMY_VISUAL;
}

// Part tier colours used by both the top-down loot drop tint and the
// inventory tooltip rail. Mirror set: hex string for CSS, raw number
// for Pixi.
export const TIER_COLORS_NUM: Record<PartTier, number> = {
  Mk1: 0x9ca3af,
  Mk2: 0x22c55e,
  Mk3: 0x3b82f6,
  Mk4: 0xa855f7,
  Alien: 0xf97316,
};

export const TIER_COLORS_HEX: Record<PartTier, string> = {
  Mk1: '#9ca3af',
  Mk2: '#22c55e',
  Mk3: '#3b82f6',
  Mk4: '#a855f7',
  Alien: '#f97316',
};

// Resolve a material kind to its render tint without re-stating the
// MATERIALS table. Both renderers and the FPS billboard pass-through use
// this.
export function materialTint(id: MaterialKind): number {
  return MATERIALS[id]?.color ?? 0xffffff;
}
