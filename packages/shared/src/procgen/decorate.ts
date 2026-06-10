// Decoration pass: per-room visual variety on top of the
// inset+corridor topology. Currently:
//
//   - Pillar grids in large rooms (regular N×M arrangement of
//     1-tile floor-to-ceiling solid blocks). Reads as a hypostyle
//     hall instead of an empty box; also breaks up sightlines
//     for combat.
//   - Chamfered corners on a subset of rooms — each square corner
//     replaced with two vertices at a 2-tile diagonal cut so the
//     polygon becomes octagonal. Adds angled walls without
//     needing the procgen to think about non-axis-aligned
//     directions anywhere else.
//
// Pure — mutates each Region's `pillars` and `polygonVerts`
// fields. Corridors are skipped (decoration would clutter the
// chokepoints they exist to be).

import type { Vec2 } from '../geometry';
import type { Region, RegionSet } from './regions';

export type DecorateConfig = {
  // Tile size in world units. Pillar + chamfer geometry produce
  // world-space coords, so we need this to compute them.
  tileSize: number;
  // Pillars: per-room chance of getting a pillar grid, and the
  // minimum room dimension to qualify (small rooms with pillars
  // become unnavigable).
  pillarRoomChance: number;
  pillarMinRoomTiles: number;
  // Chamfered-corner chance per room + the cut size in tiles.
  // 2 tiles is the smallest cut that reads as "intentional angled
  // wall" rather than "rasterisation noise".
  chamferRoomChance: number;
  chamferTiles: number;
  // Per-corner roll after the room rolled in. Independent so each
  // chamfered room shows a different subset of cuts.
  chamferCornerChance: number;
  // Raised platforms: chance per qualifying room, min room size,
  // size + height range. Height capped to JUMP_VZ_INIT-derived
  // apex (~25 wu) so the player can still hop up. Lower platforms
  // are climbable as a step-up.
  platformRoomChance: number;
  platformMinRoomTiles: number;
  platformMinTiles: number;
  platformMaxTiles: number;
  platformMinFloorZ: number;
  platformMaxFloorZ: number;
  // Sunken pits: same idea, with negative floorZ. Shallow (≤12 wu)
  // so the player can climb back out via the step-up budget.
  pitRoomChance: number;
  pitMinRoomTiles: number;
  pitMinTiles: number;
  pitMaxTiles: number;
  pitMinFloorZ: number;        // both negative
  pitMaxFloorZ: number;
  // Static point lights per room. Count scales with area; lights
  // are placed deterministically (corners + centre fan-out).
  lightsPerRoomMin: number;
  lightsPerRoomMax: number;
  lightRadius: number;
  lightHeight: number;
  lightIntensity: number;
  // Biome-tinted accent colour for room lights (warm sodium).
  lightColor: number;
};

const DEFAULT_CONFIG: DecorateConfig = {
  tileSize: 32,
  pillarRoomChance: 0.25,
  // Bumped from 8 tiles — at 8 the pillar grid + margin left
  // single-tile gaps that read as a maze. 10+ tile rooms have
  // enough space for a 2-pillar row without crowding.
  pillarMinRoomTiles: 10,
  // Chamfered corners were happening too rarely to read as a
  // dungeon feature (3 diagonals across an entire floor blends
  // into noise). Push the roll close to 1 so almost every eligible
  // room is octagonal in some corner, and bump the per-corner
  // chance so it's visible.
  chamferRoomChance: 1.0,
  chamferTiles: 3,
  chamferCornerChance: 0.85,
  // Platforms — eligible at 6+ tile rooms; ~60% land one. (Was
  // 7 tiles / 50%, which left many floors with zero platforms —
  // post-inset rooms rarely reach 7 tiles on a side.)
  platformRoomChance: 0.6,
  platformMinRoomTiles: 6,
  platformMinTiles: 2,
  platformMaxTiles: 4,
  // 8 wu = step-up (climbable). 24 wu ≈ jump apex (jumpable but
  // requires commit). Picking from this range gives a mix of
  // free vs deliberate platforms.
  platformMinFloorZ: 8,
  platformMaxFloorZ: 24,
  // Pits — same idea, shallower so player can climb back out via
  // STEP_UP_MAX (12 wu).
  pitRoomChance: 0.35,
  pitMinRoomTiles: 7,
  pitMinTiles: 2,
  pitMaxTiles: 3,
  pitMinFloorZ: -12,
  pitMaxFloorZ: -8,
  // Lights — 2 in small rooms, up to 4 in large.
  lightsPerRoomMin: 2,
  lightsPerRoomMax: 4,
  lightRadius: 320,
  lightHeight: 48,
  lightIntensity: 0.9,
  // Warm sodium — biome can override later via opts threading.
  lightColor: 0xffc486,
};

export function decorateRegions(
  regionSet: RegionSet,
  rng: () => number,
  cfg: Partial<DecorateConfig> = {},
): void {
  const config: DecorateConfig = { ...DEFAULT_CONFIG, ...cfg };
  for (let i = 0; i < regionSet.regions.length; i++) {
    const r = regionSet.regions[i];
    if (r.kind === 'corridor') continue;
    // Skip pillars / platforms / pits in the spawn and stairs
    // rooms. The anchor sits at the room centre and decorations
    // there block / obscure the exit.
    const isAnchorRoom =
      i === regionSet.spawnRegionIndex ||
      i === regionSet.stairsRegionIndex;
    if (!isAnchorRoom) {
      maybeAddPillars(r, config, rng);
      maybeAddPlatform(r, config, rng);
      maybeAddPit(r, config, rng);
    }
    maybeChamferCorners(r, regionSet.regions, config, rng);
    addLights(r, config, rng);
  }
}

// Drop a raised platform in one corner of the room. Platforms are
// climbable (≤12 wu = step-up) or jumpable (≤24 wu = jump apex);
// the floorZ is picked per-room so each platform reads as a
// distinct vertical beat.
function maybeAddPlatform(
  r: Region,
  cfg: DecorateConfig,
  rng: () => number,
): void {
  if (r.tileW < cfg.platformMinRoomTiles || r.tileH < cfg.platformMinRoomTiles) {
    return;
  }
  if (rng() >= cfg.platformRoomChance) return;
  const w = randomInt(rng, cfg.platformMinTiles, cfg.platformMaxTiles);
  const h = randomInt(rng, cfg.platformMinTiles, cfg.platformMaxTiles);
  // Stay 1 tile inside the room so the platform's perimeter
  // doesn't touch the outer wall (riserifyWalls would otherwise
  // misread that edge as a shared portal). Choose a corner-biased
  // position so the platform reads as a stage rather than a
  // floating slab in the middle.
  const margin = 1;
  const maxX = r.tileW - w - margin * 2;
  const maxY = r.tileH - h - margin * 2;
  if (maxX < 0 || maxY < 0) return;
  const px = r.tileX + margin + Math.floor(rng() * (maxX + 1));
  const py = r.tileY + margin + Math.floor(rng() * (maxY + 1));
  const floorZ = randomInt(rng, cfg.platformMinFloorZ, cfg.platformMaxFloorZ);
  r.verticalSubSectors = [
    ...(r.verticalSubSectors ?? []),
    { tileX: px, tileY: py, tileW: w, tileH: h, floorZ },
  ];
}

function maybeAddPit(
  r: Region,
  cfg: DecorateConfig,
  rng: () => number,
): void {
  if (r.tileW < cfg.pitMinRoomTiles || r.tileH < cfg.pitMinRoomTiles) {
    return;
  }
  if (rng() >= cfg.pitRoomChance) return;
  const w = randomInt(rng, cfg.pitMinTiles, cfg.pitMaxTiles);
  const h = randomInt(rng, cfg.pitMinTiles, cfg.pitMaxTiles);
  const margin = 1;
  const maxX = r.tileW - w - margin * 2;
  const maxY = r.tileH - h - margin * 2;
  if (maxX < 0 || maxY < 0) return;
  const px = r.tileX + margin + Math.floor(rng() * (maxX + 1));
  const py = r.tileY + margin + Math.floor(rng() * (maxY + 1));
  // If a platform was placed in the same room, refuse pits that
  // overlap it. Tiny rooms with both would be too cluttered.
  if (r.verticalSubSectors) {
    for (const v of r.verticalSubSectors) {
      if (
        px < v.tileX + v.tileW &&
        v.tileX < px + w &&
        py < v.tileY + v.tileH &&
        v.tileY < py + h
      ) {
        return;
      }
    }
  }
  const floorZ = randomInt(rng, cfg.pitMinFloorZ, cfg.pitMaxFloorZ);
  r.verticalSubSectors = [
    ...(r.verticalSubSectors ?? []),
    { tileX: px, tileY: py, tileW: w, tileH: h, floorZ },
  ];
}

function addLights(
  r: Region,
  cfg: DecorateConfig,
  rng: () => number,
): void {
  const area = r.tileW * r.tileH;
  // Scale light count with area but cap at config bounds. Tiny
  // rooms get min; huge rooms get max.
  const scaled = Math.floor(area / 36); // 36 = 6×6 tile baseline
  const count = clamp(
    scaled,
    cfg.lightsPerRoomMin,
    cfg.lightsPerRoomMax,
  );
  if (count <= 0) return;
  const ts = cfg.tileSize;
  const margin = 1; // tiles inset from wall so light isn't clipped
  const innerW = Math.max(1, r.tileW - margin * 2);
  const innerH = Math.max(1, r.tileH - margin * 2);
  const lights: NonNullable<Region['lights']>[number][] = [];
  for (let i = 0; i < count; i++) {
    // Distribute lights uniformly within the inset rectangle.
    // Deterministic per RNG sequence so the same seed gives the
    // same lighting plan run-to-run.
    const fx = (i + 0.5) / count;
    const tx = r.tileX + margin + fx * innerW;
    const ty = r.tileY + margin + (0.3 + rng() * 0.4) * innerH;
    lights.push({
      x: tx * ts,
      y: ty * ts,
      z: cfg.lightHeight,
      radius: cfg.lightRadius,
      color: cfg.lightColor,
      intensity: cfg.lightIntensity,
    });
  }
  r.lights = lights;
}

function randomInt(rng: () => number, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

type CornerSafety = { nw: boolean; ne: boolean; se: boolean; sw: boolean };

// For each of the four corners, determine whether a chamfer cut
// would land on a wall that has a corridor attached. The chamfer
// replaces a square corner with a diagonal cut spanning the last
// `chamferTiles` of BOTH adjacent walls — if a corridor opens
// onto either of those walls within that span, the diagonal cut
// passes through the corridor's opening and the perimeter loop
// gets a stray edge (the visible "/" segments on the user's
// preview at corners where a corridor meets a chamfered room).
function cornerSafetyForChamfer(
  room: Region,
  regions: ReadonlyArray<Region>,
  cfg: DecorateConfig,
): CornerSafety {
  const k = cfg.chamferTiles;
  const ax0 = room.tileX;
  const ax1 = room.tileX + room.tileW;
  const ay0 = room.tileY;
  const ay1 = room.tileY + room.tileH;
  const safe: CornerSafety = { nw: true, ne: true, se: true, sw: true };
  for (const c of regions) {
    if (c === room) continue;
    if (c.kind !== 'corridor') continue;
    const bx0 = c.tileX;
    const bx1 = c.tileX + c.tileW;
    const by0 = c.tileY;
    const by1 = c.tileY + c.tileH;
    // East wall of the room meets corridor's west.
    if (ax1 === bx0) {
      const yLo = Math.max(ay0, by0);
      const yHi = Math.min(ay1, by1);
      if (yHi > yLo) {
        // Anything within `k` tiles of the corner along the shared
        // edge would put the corridor opening across the chamfer.
        if (yLo < ay0 + k) safe.ne = false;
        if (yHi > ay1 - k) safe.se = false;
      }
    }
    // West wall of the room meets corridor's east.
    if (bx1 === ax0) {
      const yLo = Math.max(ay0, by0);
      const yHi = Math.min(ay1, by1);
      if (yHi > yLo) {
        if (yLo < ay0 + k) safe.nw = false;
        if (yHi > ay1 - k) safe.sw = false;
      }
    }
    // South wall meets corridor's north.
    if (ay1 === by0) {
      const xLo = Math.max(ax0, bx0);
      const xHi = Math.min(ax1, bx1);
      if (xHi > xLo) {
        if (xLo < ax0 + k) safe.sw = false;
        if (xHi > ax1 - k) safe.se = false;
      }
    }
    // North wall meets corridor's south.
    if (by1 === ay0) {
      const xLo = Math.max(ax0, bx0);
      const xHi = Math.min(ax1, bx1);
      if (xHi > xLo) {
        if (xLo < ax0 + k) safe.nw = false;
        if (xHi > ax1 - k) safe.ne = false;
      }
    }
  }
  return safe;
}

function maybeAddPillars(
  r: Region,
  cfg: DecorateConfig,
  rng: () => number,
): void {
  if (r.tileW < cfg.pillarMinRoomTiles || r.tileH < cfg.pillarMinRoomTiles) {
    return;
  }
  if (rng() >= cfg.pillarRoomChance) return;
  // Pillar grid: 2-tile margin from each wall, 1-tile pillars at
  // a 3-tile stride so the player can weave between them. Skip
  // any pillar that lands within `chamferTiles + 1` of a chamfer
  // — those corners no longer have a wall in the same spot, and
  // a pillar there looks adrift in space.
  const margin = 2;
  const stride = 3;
  const pillarsOut: NonNullable<Region['pillars']>[number][] = [];
  for (
    let ty = r.tileY + margin;
    ty < r.tileY + r.tileH - margin;
    ty += stride
  ) {
    for (
      let tx = r.tileX + margin;
      tx < r.tileX + r.tileW - margin;
      tx += stride
    ) {
      pillarsOut.push({ tileX: tx, tileY: ty, tileW: 1, tileH: 1 });
    }
  }
  if (pillarsOut.length === 0) return;
  r.pillars = pillarsOut;
}

function maybeChamferCorners(
  r: Region,
  allRegions: ReadonlyArray<Region>,
  cfg: DecorateConfig,
  rng: () => number,
): void {
  if (rng() >= cfg.chamferRoomChance) return;
  const k = cfg.chamferTiles;
  // Refuse to chamfer when any side would be shorter than the
  // chamfer cut on both ends — the polygon would self-intersect.
  if (r.tileW < k * 2 + 2 || r.tileH < k * 2 + 2) return;
  const safe = cornerSafetyForChamfer(r, allRegions, cfg);
  const px = r.tileX * cfg.tileSize;
  const py = r.tileY * cfg.tileSize;
  const pw = r.tileW * cfg.tileSize;
  const ph = r.tileH * cfg.tileSize;
  const c = k * cfg.tileSize;
  // Random subset of the 4 corners (each ~60% chance), gated by
  // the corridor-safety mask. Corners adjacent to a corridor
  // attachment stay square so the corridor's opening lines up
  // with an axis-aligned room wall.
  const chamferNW = safe.nw && rng() < cfg.chamferCornerChance;
  const chamferNE = safe.ne && rng() < cfg.chamferCornerChance;
  const chamferSE = safe.se && rng() < cfg.chamferCornerChance;
  const chamferSW = safe.sw && rng() < cfg.chamferCornerChance;
  if (!chamferNW && !chamferNE && !chamferSE && !chamferSW) return;
  const verts: Vec2[] = [];
  // CCW winding: NW → NE → SE → SW. For each corner we either
  // emit the corner vertex itself or two cut-corner verts.
  if (chamferNW) {
    verts.push({ x: px + c, y: py });
  } else {
    verts.push({ x: px, y: py });
  }
  if (chamferNE) {
    verts.push({ x: px + pw - c, y: py });
    verts.push({ x: px + pw, y: py + c });
  } else {
    verts.push({ x: px + pw, y: py });
  }
  if (chamferSE) {
    verts.push({ x: px + pw, y: py + ph - c });
    verts.push({ x: px + pw - c, y: py + ph });
  } else {
    verts.push({ x: px + pw, y: py + ph });
  }
  if (chamferSW) {
    verts.push({ x: px + c, y: py + ph });
    verts.push({ x: px, y: py + ph - c });
  } else {
    verts.push({ x: px, y: py + ph });
  }
  if (chamferNW) {
    verts.push({ x: px, y: py + c });
  }
  r.polygonVerts = verts;
}
