// Server-side biome registry. Loaded from the JSON content under
// packages/shared/content/biomes/ at boot. The runtime exposes
//   - BIOMES: full BiomeDef map (used by the spawn picker etc.)
//   - pickBandBiome(): deterministic per-band biome assignment
//   - getBiomesForWire(): subset shipped to the client renderer
//
// Biomes are assigned **per band** (5 floors per band). Each band
// rolls a biome independently from `(worldSeed, cycle, bandIndex)`
// — same inputs across the cycle yield the same layout, so all
// players on the same server see the same dive plan.

import { loadBiomes, loadWorld } from '@dumrunner/shared/content/loader';
import { setBiomePalettes } from '@dumrunner/shared';
import type { BiomeDef, WorldDef } from '@dumrunner/shared';

export const BIOMES: Record<string, BiomeDef> = {};

// World config — populated by initBiomes(). bandBiomes maps a
// band index (as a number) to a biome id; biomeForFloor consults
// this before doing the random per-band roll, so the dev can
// pin specific bands (e.g. "first 1-2 levels = default safe
// zone") without changing the seed math.
let worldConfig: WorldDef = { bandBiomes: {} };

// Floors per band — same as the GDD's "roughly five floors each".
export const BAND_SIZE = 5;
// Fallback biome id when nothing has been authored. Maps to the
// 'default' starter JSON in packages/shared/content/biomes/.
export const DEFAULT_BIOME_ID = 'default';

export function bandIndexOf(floorIndex: number): number {
  return Math.floor(Math.max(0, floorIndex) / BAND_SIZE);
}

// Cheap PRNG for the band-biome roll. Same deterministic-mix
// approach the procgen helpers already use so two independent
// callers (server boot, client preview) produce the same biome
// layout for the cycle.
function bandRng(worldSeed: number, cycle: number, bandIndex: number): number {
  // mulberry32 stepped once on a mixed seed.
  let x =
    ((worldSeed * 0x9e3779b1) ^
      (cycle * 0x85ebca77) ^
      (bandIndex * 0xc2b2ae3d)) >>>
    0;
  x = (x + 0x6d2b79f5) >>> 0;
  let t = Math.imul(x ^ (x >>> 15), 1 | x);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Eligible biomes for band-rolling: skip the 'default' biome
// (reserved for surface / safe zone) and any biome whose
// enemyRoster is empty (would spawn nothing).
function eligibleBiomeIds(): string[] {
  const ids: string[] = [];
  for (const id of Object.keys(BIOMES)) {
    if (id === DEFAULT_BIOME_ID) continue;
    const def = BIOMES[id];
    if (def.enemyRoster.length === 0) continue;
    ids.push(id);
  }
  // Stable order — sort by id so the band roll is deterministic
  // across reorders / new biomes added in different positions.
  return ids.sort();
}

export function pickBandBiome(
  worldSeed: number,
  cycle: number,
  bandIndex: number,
): string {
  // World-config override wins. Useful for "first N bands always
  // default safe-zone" without touching the seed math.
  const override = worldConfig.bandBiomes[String(bandIndex)];
  if (override && BIOMES[override]) return override;
  const eligible = eligibleBiomeIds();
  if (eligible.length === 0) return DEFAULT_BIOME_ID;
  const r = bandRng(worldSeed, cycle, bandIndex);
  const idx = Math.min(eligible.length - 1, Math.floor(r * eligible.length));
  return eligible[idx];
}

// Resolve the biome for a specific dungeon floor.
export function biomeForFloor(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
): string {
  return pickBandBiome(worldSeed, cycle, bandIndexOf(floorIndex));
}

// Snapshot for the welcome message. Per-id palette + the hazard
// fields the client needs to drive the HUD indicator and compute
// a local-DPS estimate. Also carries flattened wall / floor variant
// id lists derived from the biome's tileSet — renderers hash a
// per-cell variant index into these arrays. Empty arrays preserve
// the single-texture fallback. The rest of BiomeDef (generation
// params, rosters) is server-only.
export type BiomeWireEntry = {
  floor: string;
  wall: string;
  accent: string;
  dominantHazard: BiomeDef['dominantHazard'];
  hazardIntensity: number;
  hazardZoneIntensities?: BiomeDef['generation']['hazardZoneIntensities'];
  wallTextureIds: string[];
  floorTextureIds: string[];
};

function tileVariantsForRole(
  def: BiomeDef,
  role: 'wall' | 'floor',
): string[] {
  const set = def.tileSet;
  if (!set) return [];
  for (const tile of set.tiles) {
    if (tile.role === role) return tile.textureIds ? [...tile.textureIds] : [];
  }
  return [];
}

export function getBiomesForWire(): Record<string, BiomeWireEntry> {
  const out: Record<string, BiomeWireEntry> = {};
  for (const id of Object.keys(BIOMES)) {
    const def = BIOMES[id];
    out[id] = {
      ...def.palette,
      dominantHazard: def.dominantHazard,
      hazardIntensity: def.generation.hazardIntensity,
      hazardZoneIntensities: def.generation.hazardZoneIntensities,
      wallTextureIds: tileVariantsForRole(def, 'wall'),
      floorTextureIds: tileVariantsForRole(def, 'floor'),
    };
  }
  return out;
}

export async function initBiomes(): Promise<void> {
  const [defs, world] = await Promise.all([loadBiomes(), loadWorld()]);
  worldConfig = world;
  const overrideKeys = Object.keys(world.bandBiomes);
  if (overrideKeys.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[biomes] world override active for ${overrideKeys.length} band(s): ${overrideKeys
        .map((k) => `${k}→${world.bandBiomes[k]}`)
        .join(', ')}`,
    );
  }
  // Empty content dir is a soft fault — we fall back to a
  // hardcoded 'default' biome so the server can still boot
  // without any biome JSON authored. The dungeon spawn picker
  // will use depth-banded weights as its fallback path.
  for (const k of Object.keys(BIOMES)) delete BIOMES[k];
  for (const def of defs) BIOMES[def.id] = def;
  if (defs.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[biomes] no biome JSON files found; spawn picker falls back to legacy depth weights and palettes default to dark dungeon hues',
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[biomes] loaded ${defs.length} biomes from JSON: ${defs
        .map((d) => d.id)
        .join(', ')}`,
    );
  }
  // Mirror the palette subset into shared/visuals so server-side
  // calls to biomePaletteFor() resolve without going through
  // BiomeDef. Client gets the same data via the welcome message.
  const palettes: Record<
    string,
    { floor: string; wall: string; accent: string }
  > = {};
  for (const def of defs) {
    palettes[def.id] = { ...def.palette };
  }
  setBiomePalettes(palettes);
}
