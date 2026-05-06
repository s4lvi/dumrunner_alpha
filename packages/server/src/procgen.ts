// Deterministic floor layout generator. Same (worldSeed, cycle, floorIndex)
// always produces the same layout — enables persistence-free regeneration
// (the layout itself never enters world_states snapshots) and lets shared
// servers see consistent floors.

import type { Interactable, Rect, SceneLayout } from '@dumrunner/shared';
import { BIOMES } from './biomes.js';
import { PROPS } from './props.js';

// Initial door placement returned alongside the layout. Each door is a
// 1×1 building seeded by Scene.constructor at a tile that bridges a
// corridor and a locked room — so the player has to consume a key to
// open it before the room is enterable.
export type InitialDoor = {
  tileX: number;
  tileY: number;
};

// Set of room indices that are locked this floor (parallel to the
// rooms[] array on the layout). Tagged outputs from generateFloorLayout
// so generateInitialLoot can bias the scatter pile toward locked rooms.
export type FloorMeta = {
  lockedRoomIndices: number[];
  doors: InitialDoor[];
};

// Tile size — every dungeon dimension is a multiple of this. Keeping a single
// world tile size (32 px) means client renders, server collision, and future
// base-building can all share the same grid.
export const TILE_SIZE = 32;

// Room/corridor sizes in tiles. Pixel dimensions = tiles * TILE_SIZE.
const ROOM_MIN_TILES = 5;          // 5 * 32 = 160 px
const ROOM_MAX_TILES = 8;          // 8 * 32 = 256 px
const TARGET_ROOMS = 10;
const PLACEMENT_BUDGET = 200;
const FLOOR_HALF_TILES = 35;       // 35 * 32 = 1120 px from origin
const ROOM_PADDING_TILES = 1;      // ≥ 1 tile gap between rooms
const CORRIDOR_WIDTH_TILES = 2;    // 2 * 32 = 64 px wide corridors

// Seeded 32-bit PRNG. Cheap, deterministic, fine for layout choice.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rng32(rng: () => number, lo: number, hi: number): number {
  return Math.floor(lo + rng() * (hi - lo));
}

function rectsOverlap(a: Rect, b: Rect, padding = 0): boolean {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

// Corridor centred on (x1,y1)→(x2,y2). All inputs/outputs are in tiles.
function makeCorridorTiles(
  x1t: number,
  y1t: number,
  x2t: number,
  y2t: number
): Rect {
  if (x1t === x2t) {
    return {
      x: x1t - Math.floor(CORRIDOR_WIDTH_TILES / 2),
      y: Math.min(y1t, y2t),
      w: CORRIDOR_WIDTH_TILES,
      h: Math.abs(y2t - y1t),
    };
  }
  return {
    x: Math.min(x1t, x2t),
    y: y1t - Math.floor(CORRIDOR_WIDTH_TILES / 2),
    w: Math.abs(x2t - x1t),
    h: CORRIDOR_WIDTH_TILES,
  };
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function tilesToPixels(r: Rect): Rect {
  return {
    x: r.x * TILE_SIZE,
    y: r.y * TILE_SIZE,
    w: r.w * TILE_SIZE,
    h: r.h * TILE_SIZE,
  };
}

export function generateFloorLayout(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
  biome: string,
): SceneLayout {
  // Mix the inputs into a single 32-bit seed. Off-the-shelf mixing constants.
  const mixed =
    (worldSeed * 0x9E3779B1) ^
    (cycle * 0x85EBCA77) ^
    (floorIndex * 0xC2B2AE3D);
  const rng = mulberry32(mixed);

  // Place rooms in tile coords with rejection sampling.
  const roomsTiles: Rect[] = [];
  for (let i = 0; i < PLACEMENT_BUDGET && roomsTiles.length < TARGET_ROOMS; i++) {
    const w = rng32(rng, ROOM_MIN_TILES, ROOM_MAX_TILES + 1);
    const h = rng32(rng, ROOM_MIN_TILES, ROOM_MAX_TILES + 1);
    const x = rng32(rng, -FLOOR_HALF_TILES, FLOOR_HALF_TILES - w);
    const y = rng32(rng, -FLOOR_HALF_TILES, FLOOR_HALF_TILES - h);
    const candidate: Rect = { x, y, w, h };
    if (roomsTiles.every((r) => !rectsOverlap(r, candidate, ROOM_PADDING_TILES))) {
      roomsTiles.push(candidate);
    }
  }

  // Connect each new room to the previous one. Centres are computed in tile
  // space so corridors land on integer tiles.
  const corridorsTiles: Rect[] = [];
  for (let i = 1; i < roomsTiles.length; i++) {
    const a = center(roomsTiles[i - 1]);
    const b = center(roomsTiles[i]);
    const ax = Math.floor(a.x);
    const ay = Math.floor(a.y);
    const bx = Math.floor(b.x);
    const by = Math.floor(b.y);
    const horizontalFirst = rng() < 0.5;
    if (horizontalFirst) {
      corridorsTiles.push(makeCorridorTiles(ax, ay, bx, ay));
      corridorsTiles.push(makeCorridorTiles(bx, ay, bx, by));
    } else {
      corridorsTiles.push(makeCorridorTiles(ax, ay, ax, by));
      corridorsTiles.push(makeCorridorTiles(ax, by, bx, by));
    }
  }

  // Convert tile rects to pixel rects (the game world is in pixels).
  const rooms = roomsTiles.map(tilesToPixels);
  const corridors = corridorsTiles.map(tilesToPixels);

  // Spawn point — entrance is the first room.
  const entrance = rooms[0];
  const spawn = center(entrance);

  // Place interactables.
  // - Extract pad in the entrance room.
  // - Stairs down in the room furthest from the entrance.
  const interactables: Interactable[] = [];
  if (rooms.length > 0) {
    // Position the pad on a tile inside the entrance room, offset from spawn.
    const padX = entrance.x + entrance.w - TILE_SIZE * 1.5;
    const padY = entrance.y + entrance.h / 2;
    interactables.push({
      id: 'extract_pad',
      kind: 'extract_pad',
      x: padX,
      y: padY,
      label: 'Extract to base',
    });
  }
  if (rooms.length > 1) {
    let furthest = rooms[1];
    let furthestDistSq = 0;
    for (let i = 1; i < rooms.length; i++) {
      const r = rooms[i];
      const c = center(r);
      const dx = c.x - spawn.x;
      const dy = c.y - spawn.y;
      const dsq = dx * dx + dy * dy;
      if (dsq > furthestDistSq) {
        furthest = r;
        furthestDistSq = dsq;
      }
    }
    const c = center(furthest);
    interactables.push({
      id: 'stairs_down',
      kind: 'stairs_down',
      x: c.x,
      y: c.y,
      label: `Descend to floor ${floorIndex + 1}`,
    });
  }

  const walkables = [...rooms, ...corridors];
  const minX = Math.min(...walkables.map((r) => r.x));
  const minY = Math.min(...walkables.map((r) => r.y));
  const maxX = Math.max(...walkables.map((r) => r.x + r.w));
  const maxY = Math.max(...walkables.map((r) => r.y + r.h));
  const worldBounds: Rect = {
    x: minX - TILE_SIZE * 2,
    y: minY - TILE_SIZE * 2,
    w: maxX - minX + TILE_SIZE * 4,
    h: maxY - minY + TILE_SIZE * 4,
  };

  return {
    worldBounds,
    walkables,
    rooms,
    spawn,
    interactables,
    tileSize: TILE_SIZE,
    biome,
  };
}

// Initial prop placement. Same seed shape as enemies, so all
// players on the cycle see the same scattered barrels / crates.
export type InitialPropSpawn = {
  kind: string;       // PropDef.id cross-reference
  x: number;
  y: number;
};

// Initial enemy placement for a dungeon floor. Same seed → same spawns, so
// two clients joining the same world see the same starting fight.
export type InitialEnemySpawn = {
  templateId: string;
  x: number;
  y: number;
};

// Depth-weighted template pool. As floor index grows, harder templates become
// more common. Arrays must enumerate templates known to the server's template
// library — keep in sync with packages/server/src/ai/templates.ts.
type TemplateWeights = Record<string, number>;
// dummy_target was a placeholder for combat testing — stationary, no
// interesting behaviour. Removed from the live spawn pool; the
// template stays in the AI library for ad-hoc smoke tests.
// Resolve the spawn-weight table for a given floor. Prefers the
// floor's biome roster (authored via /editor/biomes); falls back
// to legacy depth-banded weights when the biome has no roster.
function weightsForFloor(
  layout: SceneLayout,
  floorIndex: number,
): TemplateWeights {
  const biome = BIOMES[layout.biome];
  if (biome && biome.enemyRoster.length > 0) {
    const w: TemplateWeights = {};
    for (const entry of biome.enemyRoster) {
      if (entry.weight > 0) w[entry.id] = entry.weight;
    }
    if (Object.keys(w).length > 0) return w;
  }
  return (
    DEPTH_WEIGHTS.find((b) => floorIndex <= b.maxFloor)?.weights ??
    DEPTH_WEIGHTS[DEPTH_WEIGHTS.length - 1].weights
  );
}

const DEPTH_WEIGHTS: { maxFloor: number; weights: TemplateWeights }[] = [
  { maxFloor: 2, weights: { swarmer: 30, chaser_melee: 50, shooter_drone: 20 } },
  { maxFloor: 5, weights: { swarmer: 20, chaser_melee: 22, shooter_drone: 22, brute_chaser: 14, armored: 10, flame_drone: 8, chem_bloater: 4 } },
  { maxFloor: 10, weights: { swarmer: 12, chaser_melee: 18, shooter_drone: 20, brute_chaser: 22, armored: 14, flame_drone: 8, chem_bloater: 6 } },
  { maxFloor: Infinity, weights: { brute_chaser: 30, shooter_drone: 20, armored: 20, chaser_melee: 12, flame_drone: 10, chem_bloater: 8 } },
];

function pickWeighted(rng: () => number, weights: TemplateWeights): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

export function generateInitialEnemies(
  layout: SceneLayout,
  worldSeed: number,
  cycle: number,
  floorIndex: number
): InitialEnemySpawn[] {
  const mixed =
    (worldSeed * 0xC2B2AE3D) ^
    (cycle * 0x27D4EB2F) ^
    (floorIndex * 0x165667B1);
  const rng = mulberry32(mixed);

  // Prefer the biome-authored roster when one is set on the
  // layout. Empty roster (or an absent / missing biome) falls
  // through to the legacy depth-banded weights so existing
  // saves don't lose enemies during the migration.
  const weights = weightsForFloor(layout, floorIndex);

  // First room is the entrance — leave it empty for safe arrival.
  const candidateRooms = layout.rooms.slice(1);
  if (candidateRooms.length === 0) return [];

  // Roughly one enemy per non-entrance room, two for big rooms.
  const spawns: InitialEnemySpawn[] = [];
  for (const room of candidateRooms) {
    const count = room.w * room.h > 30_000 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const templateId = pickWeighted(rng, weights);
      // Random point inside the room, with a small inset so enemies aren't
      // flush against walls.
      const x = room.x + 24 + rng() * (room.w - 48);
      const y = room.y + 24 + rng() * (room.h - 48);
      spawns.push({ templateId, x, y });
    }
  }
  return spawns;
}

// Initial prop placement. Reads the layout's biome propPalette
// (authored under packages/shared/content/biomes/<id>.json) and
// stamps weighted picks across walkable tiles up to the biome's
// propDensity budget. Same (worldSeed, cycle, floorIndex) inputs
// → same prop layout for every player on the cycle.
export function generateInitialProps(
  layout: SceneLayout,
  worldSeed: number,
  cycle: number,
  floorIndex: number,
): InitialPropSpawn[] {
  const biome = BIOMES[layout.biome];
  if (!biome) return [];
  // Build the weighted pool once. Skip palette entries whose
  // PropDef hasn't been authored — author warns then, but a
  // missing prop kind shouldn't break floor generation.
  const palette = biome.propPalette
    .filter((entry) => entry.weight > 0 && PROPS[entry.id])
    .map((entry) => ({
      id: entry.id,
      weight: entry.weight,
      naturalOnly: entry.naturalOnly ?? false,
      allowDoorway: entry.allowDoorway ?? false,
    }));
  if (palette.length === 0) return [];
  const density = biome.generation.propDensity;
  if (density <= 0) return [];

  const mixed =
    (worldSeed * 0x68e31da4) ^
    (cycle * 0xb5297a4d) ^
    (floorIndex * 0x9e3779b1);
  const rng = mulberry32(mixed);
  const spawns: InitialPropSpawn[] = [];
  // First room is the entrance — keep it clean of obstacles so
  // arrival doesn't faceplant into a barrel.
  const candidateRooms = layout.rooms.slice(1);
  for (const room of candidateRooms) {
    const tile = layout.tileSize;
    const tilesW = Math.max(1, Math.floor(room.w / tile));
    const tilesH = Math.max(1, Math.floor(room.h / tile));
    const tilesTotal = tilesW * tilesH;
    // Budget = density × tile-count, rounded with the rng to
    // avoid systematic bias toward floor.
    const budgetExact = density * tilesTotal;
    const count = Math.floor(budgetExact + rng());
    if (count === 0) continue;
    // Reject placement near room edges so props don't clip into
    // walls (24px inset matches the enemy spawn inset).
    for (let i = 0; i < count; i++) {
      const entry = pickWeighted(rng, paletteWeights(palette));
      const x = room.x + 24 + rng() * Math.max(0, room.w - 48);
      const y = room.y + 24 + rng() * Math.max(0, room.h - 48);
      spawns.push({ kind: entry, x, y });
    }
  }
  return spawns;
}

function paletteWeights(
  palette: { id: string; weight: number }[],
): TemplateWeights {
  const w: TemplateWeights = {};
  for (const e of palette) w[e.id] = e.weight;
  return w;
}

// Scatter loot — material piles dropped into rooms. Same seed → same piles
// so two clients see the same dungeon scavenge at start-of-cycle.
//
// Artifacts intentionally don't appear in floor scatter — they're a kill-
// drop only currency, sold to the artifact uplink for blueprints.
export type InitialLootDrop = {
  materialId: 'scrap' | 'wire' | 'circuit' | 'alloy' | 'biotic' | 'crystal';
  count: number;
  x: number;
  y: number;
};

// Material weights by floor depth. Higher floors push higher-tier components.
const LOOT_WEIGHTS: { maxFloor: number; weights: Record<string, number> }[] = [
  { maxFloor: 2, weights: { scrap: 70, wire: 30 } },
  { maxFloor: 5, weights: { scrap: 45, wire: 30, alloy: 15, circuit: 10 } },
  {
    maxFloor: 10,
    weights: { scrap: 30, wire: 20, alloy: 25, circuit: 15, biotic: 10 },
  },
  {
    maxFloor: Infinity,
    weights: {
      scrap: 20,
      wire: 15,
      alloy: 25,
      circuit: 20,
      biotic: 15,
      crystal: 5,
    },
  },
];

export function generateInitialLoot(
  layout: SceneLayout,
  worldSeed: number,
  cycle: number,
  floorIndex: number,
  lockedRoomIndices: number[] = []
): InitialLootDrop[] {
  const mixed =
    (worldSeed * 0x85ebca6b) ^
    (cycle * 0xc2b2ae35) ^
    (floorIndex * 0x27d4eb2f) ^
    0x5c2d4af1; // distinct constant from enemy rng
  const rng = mulberry32(mixed);

  const weights =
    LOOT_WEIGHTS.find((b) => floorIndex <= b.maxFloor)?.weights ??
    LOOT_WEIGHTS[LOOT_WEIGHTS.length - 1].weights;

  const lockedSet = new Set(lockedRoomIndices);

  // Skip the entrance room — leave the safe-arrival cell empty. Iterate
  // by index so we know if a room is locked (locked rooms get extra loot
  // and a tier-skewed weight to reward the key cost).
  const drops: InitialLootDrop[] = [];
  for (let i = 1; i < layout.rooms.length; i++) {
    const room = layout.rooms[i];
    const isLocked = lockedSet.has(i);
    const big = room.w * room.h > 30_000;
    // Locked rooms always have at least one pile and double the chance
    // of a second; unlocked rooms keep the default 60% / 1-2 distribution.
    let piles: number;
    if (isLocked) {
      piles = big ? 2 + (rng() < 0.5 ? 1 : 0) : rng() < 0.7 ? 2 : 1;
    } else {
      piles = big ? (rng() < 0.5 ? 2 : 1) : rng() < 0.6 ? 1 : 0;
    }
    for (let p = 0; p < piles; p++) {
      // Locked rooms upgrade the weights toward higher-tier materials.
      const w = isLocked ? upgradeWeights(weights) : weights;
      const materialId = pickWeighted(rng, w) as InitialLootDrop['materialId'];
      const tierScale =
        materialId === 'scrap' || materialId === 'wire' ? 1.0
        : materialId === 'alloy' || materialId === 'circuit' ? 0.6
        : 0.4;
      const base = 2 + Math.floor(floorIndex / 3);
      const count = Math.max(
        1,
        Math.floor((base + Math.floor(rng() * 3)) * tierScale * (isLocked ? 1.4 : 1))
      );
      drops.push({
        materialId,
        count,
        x: room.x + 24 + rng() * (room.w - 48),
        y: room.y + 24 + rng() * (room.h - 48),
      });
    }
  }
  return drops;
}

// Bias a weight table toward higher-tier materials — used for locked
// rooms so the key cost feels rewarded.
function upgradeWeights(w: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...w };
  for (const k of Object.keys(out)) {
    if (k === 'scrap' || k === 'wire') out[k] = Math.max(0, out[k] * 0.4);
    if (k === 'alloy' || k === 'circuit') out[k] = (out[k] ?? 0) + 25;
    if (k === 'biotic' || k === 'crystal') out[k] = (out[k] ?? 0) + 10;
  }
  return out;
}

// Re-exported from @dumrunner/shared/geometry so both server and client
// share identical collision/LoS logic.
export { isInsideAny, segmentInsideWalkables } from '@dumrunner/shared';

// Pick a subset of rooms to lock and place a door on each. Doors sit at
// a perimeter tile of the room that's also covered by a corridor — the
// natural entrance. Index 0 (entrance room) is never locked.
export function generateLockedRoomMeta(
  layout: SceneLayout,
  worldSeed: number,
  cycle: number,
  floorIndex: number
): FloorMeta {
  // Distinct hash from the other generators so the same floor doesn't
  // lock-and-loot-pile the same tile.
  const mixed =
    (worldSeed * 0xb5297a4d) ^
    (cycle * 0x68e31da4) ^
    (floorIndex * 0xb5297a4d) ^
    0x1b873593;
  const rng = mulberry32(mixed);

  const tileSize = layout.tileSize;
  if (tileSize <= 0 || layout.rooms.length <= 1) {
    return { lockedRoomIndices: [], doors: [] };
  }

  // Corridor walkables = everything in walkables that isn't in rooms.
  // Detect by checking if the rect appears in rooms (object identity
  // since procgen builds them in order). For safety, do an x/y/w/h
  // compare so external callers can build a layout however they like.
  const corridorRects = layout.walkables.filter(
    (w) => !layout.rooms.some((r) => sameRect(r, w))
  );

  // Lock approximately 1 in 3 non-entrance rooms. Skew higher with
  // depth so deeper floors are more frequently gated. The room
  // containing the stairs-down interactable is excluded — locking it
  // would put progression behind a key drop, which is bad UX since
  // keys aren't guaranteed to appear on a floor.
  const stairs = layout.interactables.find((i) => i.kind === 'stairs_down');
  let stairsRoomIndex = -1;
  if (stairs) {
    for (let i = 0; i < layout.rooms.length; i++) {
      const r = layout.rooms[i];
      if (
        stairs.x >= r.x &&
        stairs.x <= r.x + r.w &&
        stairs.y >= r.y &&
        stairs.y <= r.y + r.h
      ) {
        stairsRoomIndex = i;
        break;
      }
    }
  }
  // Procgen connects rooms in a strict chain (each i is corridor-
  // connected only to i-1), so to reach room S the player must pass
  // through every preceding room. Locking ANY room in [1..S] blocks
  // progression. Restrict lock candidates to indices strictly past
  // the stairs room — those rooms are off the entrance→stairs
  // critical path and can be locked without breaking progression.
  // (When the stairs room is the last in the chain, no rooms qualify
  // and the floor simply has no locked doors. Acceptable until
  // procgen grows side-branches.)
  const lockedSet = new Set<number>();
  const lockChance = Math.min(
    0.55,
    0.33 + Math.max(0, floorIndex - 1) * 0.04
  );
  const doors: InitialDoor[] = [];
  for (let i = 1; i < layout.rooms.length; i++) {
    if (stairsRoomIndex >= 0 && i <= stairsRoomIndex) continue;
    if (rng() > lockChance) continue;
    const room = layout.rooms[i];
    const tiles = pickDoorTilesForRoom(room, corridorRects, tileSize);
    if (tiles.length === 0) continue;
    lockedSet.add(i);
    doors.push(...tiles);
  }

  return { lockedRoomIndices: [...lockedSet], doors };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// Find every perimeter tile of the room that overlaps an adjacent
// corridor. Returns ALL such tiles so the door fully spans the
// entrance — a 2-wide corridor placed against a room produces 2
// adjacent doors that open as one (server flood-fills by adjacency).
function pickDoorTilesForRoom(
  room: Rect,
  corridors: Rect[],
  tileSize: number
): InitialDoor[] {
  const tx0 = Math.floor(room.x / tileSize);
  const ty0 = Math.floor(room.y / tileSize);
  const txEnd = Math.floor((room.x + room.w) / tileSize);
  const tyEnd = Math.floor((room.y + room.h) / tileSize);

  const tiles: InitialDoor[] = [];
  // Top + bottom edges.
  for (let tx = tx0; tx < txEnd; tx++) {
    if (tileTouchesCorridor(tx, ty0 - 1, corridors, tileSize)) {
      tiles.push({ tileX: tx, tileY: ty0 });
    }
    if (tileTouchesCorridor(tx, tyEnd, corridors, tileSize)) {
      tiles.push({ tileX: tx, tileY: tyEnd - 1 });
    }
  }
  // Left + right edges.
  for (let ty = ty0; ty < tyEnd; ty++) {
    if (tileTouchesCorridor(tx0 - 1, ty, corridors, tileSize)) {
      tiles.push({ tileX: tx0, tileY: ty });
    }
    if (tileTouchesCorridor(txEnd, ty, corridors, tileSize)) {
      tiles.push({ tileX: txEnd - 1, tileY: ty });
    }
  }
  return tiles;
}

function tileTouchesCorridor(
  tx: number,
  ty: number,
  corridors: Rect[],
  tileSize: number
): boolean {
  const cx = (tx + 0.5) * tileSize;
  const cy = (ty + 0.5) * tileSize;
  for (const c of corridors) {
    if (cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h) {
      return true;
    }
  }
  return false;
}

