// Hazard system — environmental damage tick driven by biome
// `dominantHazard` × per-room category × depth. Lands as Roadmap
// E3.3.
//
// Authoring data lives on BiomeDef (`dominantHazard`,
// `hazardIntensity`, `safeRoomChance`, `extremeRoomChance`,
// `hazardZoneIntensities`); per-room categories are baked into
// `SceneLayout.roomCategories` by procgen.
//
// Pure functions only — both server (Scene.tickHazards) and
// client (HUD indicator) use the same math so the player's
// indicator and the actual damage agree to the cent.

import {
  DEFAULT_HAZARD_ZONE_INTENSITIES,
  type HazardKind,
  type HazardZoneCategory,
} from './content/types';
import type { BiomeHazardInfo } from './visuals';
import type { SceneLayout } from './protocol';

// Floor-1 base hazard DPS. Tuned so an unprotected player on a
// shallow hazard floor takes meaningful damage but doesn't die in
// 5 seconds — the GDD's "seconds to die without resist" target
// kicks in around floor 5+ where the ramp has compounded.
const BASE_DPS_AT_FLOOR_0 = 2.5;

// Multiplier applied per 5-floor band. With 1.25×, a band-2 floor
// is ~1.6× a surface floor, band-4 is ~2.4× — softened from 1.4 so
// band 2 isn't an RNG-gated wall, while deep pushes still carry a
// compounding damage clock without exponential blowup.
const DEPTH_RAMP_PER_5_FLOORS = 1.25;

// Resist cap during damage application. Even maxed-out specialty
// life support can't fully negate a hazard — there's always some
// trickle so the loop doesn't reduce to "stand here forever once
// you have the right LS."
export const HAZARD_RESIST_CAP = 0.95;

// Per-second tick interval. The scene tick accumulator fires this
// once per accumulated second; reducing this would just spread
// the same total damage over more ticks (rounding-friendly to
// 1 Hz).
export const HAZARD_TICK_INTERVAL_MS = 1000;

// Base hazard DPS at a given depth. Independent of biome and
// category — those layer on top via effectiveHazardDps.
export function baseHazardDps(floorIndex: number): number {
  const f = Math.max(0, floorIndex);
  return BASE_DPS_AT_FLOOR_0 * Math.pow(DEPTH_RAMP_PER_5_FLOORS, f / 5);
}

// Resolve a category's intensity multiplier from the biome's
// (optional) override table, falling back to the global defaults
// (safe 0, corridor 0.4, hazard 1, extreme 2).
export function categoryIntensity(
  biome: BiomeHazardInfo | undefined | null,
  category: HazardZoneCategory,
): number {
  const override = biome?.hazardZoneIntensities?.[category];
  if (typeof override === 'number') return override;
  return DEFAULT_HAZARD_ZONE_INTENSITIES[category];
}

// Net DPS at (biome, depth, category). 0 when the biome has no
// dominant hazard ('default' / 'none' biomes — the surface and
// the safe-zone starter biome).
export function effectiveHazardDps(
  biome: BiomeHazardInfo | undefined | null,
  floorIndex: number,
  category: HazardZoneCategory,
): { kind: HazardKind; dps: number } {
  if (!biome || biome.dominantHazard === 'none') {
    return { kind: 'none', dps: 0 };
  }
  const dps =
    baseHazardDps(floorIndex) *
    biome.hazardIntensity *
    categoryIntensity(biome, category);
  return { kind: biome.dominantHazard, dps };
}

// Find which room or corridor a player position falls inside, and
// return that zone's category. Rooms take priority over corridors
// when they overlap (rooms are placed first in walkables[]). A
// position outside every walkable returns 'safe' — out-of-bounds
// shouldn't tick damage; if that ever becomes possible, the scene
// has bigger issues to surface than a hazard tick.
export function categoryAt(
  layout: SceneLayout,
  x: number,
  y: number,
): HazardZoneCategory {
  for (let i = 0; i < layout.rooms.length; i++) {
    const r = layout.rooms[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      return layout.roomCategories?.[i] ?? 'hazard';
    }
  }
  // Walkables = rooms ∪ corridors. The corridor-only check is
  // "in any walkable but no room" — same hit-test as above on
  // the walkables tail.
  for (let i = layout.rooms.length; i < layout.walkables.length; i++) {
    const r = layout.walkables[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      return 'corridor';
    }
  }
  return 'safe';
}

// Resist multiplier for a player's stats vs a hazard kind. Caps
// at HAZARD_RESIST_CAP so even maxed coverage trickles damage.
export function resistFor(
  stats: {
    heatResist: number;
    coldResist: number;
    radiationResist: number;
    toxicResist: number;
  },
  kind: HazardKind,
): number {
  switch (kind) {
    case 'heat':
      return Math.min(HAZARD_RESIST_CAP, stats.heatResist);
    case 'cold':
      return Math.min(HAZARD_RESIST_CAP, stats.coldResist);
    case 'radiation':
      return Math.min(HAZARD_RESIST_CAP, stats.radiationResist);
    case 'toxic':
      return Math.min(HAZARD_RESIST_CAP, stats.toxicResist);
    case 'none':
      return 1;
  }
}
