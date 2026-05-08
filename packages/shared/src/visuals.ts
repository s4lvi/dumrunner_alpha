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

// ---------- Prop visual registry ----------
//
// Per-prop visual data the renderer needs but that doesn't live in
// the per-tick PropState wire payload. Populated from JSON content
// (PropDef.visual) at server boot and shipped via welcome's
// propVisuals field so the client picks the right billboard scale
// + ground offset for each kind without a deploy.
export type PropVisual = {
  tint?: string;
  spriteSize?: number;        // FPS world-units; 1.0 = one wall height.
  spriteGroundOffset?: number; // 0..1 — 0 = floor-anchored, 1 = ceiling.
};

export const PROP_VISUALS: Record<string, PropVisual> = {};

export function propVisualFor(kind: string): PropVisual {
  return PROP_VISUALS[kind] ?? {};
}

export function setPropVisuals(
  visuals: Record<string, PropVisual>,
): void {
  for (const k of Object.keys(PROP_VISUALS)) delete PROP_VISUALS[k];
  Object.assign(PROP_VISUALS, visuals);
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

// Hazard summary the client needs to drive the HUD indicator and
// estimate per-zone DPS. Server is authoritative for damage; the
// client uses this for display only.
export type BiomeHazardInfo = {
  dominantHazard: 'none' | 'heat' | 'radiation' | 'cold' | 'toxic';
  hazardIntensity: number;
  hazardZoneIntensities?: Partial<{
    safe: number;
    corridor: number;
    hazard: number;
    extreme: number;
  }>;
};

export const BIOMES: Record<string, BiomePalette> = {};
export const BIOME_HAZARDS: Record<string, BiomeHazardInfo> = {};
// Per-biome variant id lists derived from each biome's tileSet.
// Renderers hash a per-cell variant index into these arrays to
// pick a wall / floor texture override. Empty arrays mean
// "single-texture fallback" — see pickCellVariant docs.
export const BIOME_TILE_VARIANTS: Record<
  string,
  { wallTextureIds: string[]; floorTextureIds: string[] }
> = {};

export const FALLBACK_BIOME_PALETTE: BiomePalette = {
  floor: '#1f242c',
  wall: '#52525b',
  accent: '#94a3b8',
};

export function biomePaletteFor(biomeId: string | undefined | null): BiomePalette {
  if (!biomeId) return FALLBACK_BIOME_PALETTE;
  return BIOMES[biomeId] ?? FALLBACK_BIOME_PALETTE;
}

export function biomeHazardFor(
  biomeId: string | undefined | null,
): BiomeHazardInfo | null {
  if (!biomeId) return null;
  return BIOME_HAZARDS[biomeId] ?? null;
}

export function biomeTileVariantsFor(
  biomeId: string | undefined | null,
  role: 'wall' | 'floor',
): string[] {
  if (!biomeId) return [];
  const entry = BIOME_TILE_VARIANTS[biomeId];
  if (!entry) return [];
  return role === 'wall' ? entry.wallTextureIds : entry.floorTextureIds;
}

export function setBiomePalettes(
  palettes: Record<
    string,
    BiomePalette &
      Partial<BiomeHazardInfo> & {
        wallTextureIds?: string[];
        floorTextureIds?: string[];
      }
  >,
): void {
  for (const k of Object.keys(BIOMES)) delete BIOMES[k];
  for (const k of Object.keys(BIOME_HAZARDS)) delete BIOME_HAZARDS[k];
  for (const k of Object.keys(BIOME_TILE_VARIANTS)) {
    delete BIOME_TILE_VARIANTS[k];
  }
  for (const id of Object.keys(palettes)) {
    const entry = palettes[id];
    BIOMES[id] = {
      floor: entry.floor,
      wall: entry.wall,
      accent: entry.accent,
    };
    if (entry.dominantHazard !== undefined) {
      BIOME_HAZARDS[id] = {
        dominantHazard: entry.dominantHazard,
        hazardIntensity: entry.hazardIntensity ?? 0,
        hazardZoneIntensities: entry.hazardZoneIntensities,
      };
    }
    BIOME_TILE_VARIANTS[id] = {
      wallTextureIds: entry.wallTextureIds ?? [],
      floorTextureIds: entry.floorTextureIds ?? [],
    };
  }
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
