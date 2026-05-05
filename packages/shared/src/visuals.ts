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

// Mutable enemy-visual registry. Populated at runtime from the
// JSON content under packages/shared/content/enemies/<id>.json:
//   - Server: ai/templates.ts initTemplates() calls setEnemyVisuals
//     after reading the JSON.
//   - Client: Game.tsx calls setEnemyVisuals on the welcome
//     message's enemyVisuals payload.
// Until either side populates, lookups fall back to the seed
// dummy_target entry below — keeps the renderer from crashing
// before the wire data arrives.
export const ENEMY_VISUALS: Record<string, EnemyVisual> = {
  dummy_target: { shape: 'square', color: 0xef4444, size: 18 },
};

export const FALLBACK_ENEMY_VISUAL: EnemyVisual = ENEMY_VISUALS.dummy_target;

export function enemyVisualFor(kind: string): EnemyVisual {
  return ENEMY_VISUALS[kind] ?? FALLBACK_ENEMY_VISUAL;
}

// Replace the visual registry. Called from server/index.ts boot
// (post-initTemplates) and from Game.tsx welcome handler.
export function setEnemyVisuals(
  visuals: Record<string, EnemyVisual>,
): void {
  for (const k of Object.keys(ENEMY_VISUALS)) delete ENEMY_VISUALS[k];
  Object.assign(ENEMY_VISUALS, visuals);
}

// ---------- Biome registry ----------
//
// Per-biome render palette shipped to the client at session
// start (welcome message → setBiomePalettes). Renderers look up
// `BIOMES[layout.biome]` when drawing a scene to pick the right
// floor / wall hues. Falls back to defaults when a biome isn't
// in the registry (e.g. surface scene with biome='default'
// before any biomes are authored).
export type BiomePalette = {
  floor: string;
  wall: string;
  accent: string;
};
export const BIOMES: Record<string, BiomePalette> = {};

export const FALLBACK_BIOME_PALETTE: BiomePalette = {
  floor: '#1f242c',
  wall: '#52525b',
  accent: '#94a3b8',
};

export function biomePaletteFor(biomeId: string | undefined | null): BiomePalette {
  if (!biomeId) return FALLBACK_BIOME_PALETTE;
  return BIOMES[biomeId] ?? FALLBACK_BIOME_PALETTE;
}

export function setBiomePalettes(palettes: Record<string, BiomePalette>): void {
  for (const k of Object.keys(BIOMES)) delete BIOMES[k];
  Object.assign(BIOMES, palettes);
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
