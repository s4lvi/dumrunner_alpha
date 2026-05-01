// Deterministic floor layout generator. Same (worldSeed, cycle, floorIndex)
// always produces the same layout — enables persistence-free regeneration
// (the layout itself never enters world_states snapshots) and lets shared
// servers see consistent floors.

import type { Interactable, Rect, SceneLayout } from '@dumrunner/shared';

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
  floorIndex: number
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

  return { worldBounds, walkables, rooms, spawn, interactables, tileSize: TILE_SIZE };
}

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
const DEPTH_WEIGHTS: { maxFloor: number; weights: TemplateWeights }[] = [
  { maxFloor: 2, weights: { dummy_target: 30, chaser_melee: 50, shooter_drone: 20 } },
  { maxFloor: 5, weights: { chaser_melee: 35, shooter_drone: 35, brute_chaser: 20, dummy_target: 10 } },
  { maxFloor: 10, weights: { chaser_melee: 25, shooter_drone: 35, brute_chaser: 35, dummy_target: 5 } },
  { maxFloor: Infinity, weights: { brute_chaser: 50, shooter_drone: 35, chaser_melee: 15 } },
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

  const weights =
    DEPTH_WEIGHTS.find((b) => floorIndex <= b.maxFloor)?.weights ??
    DEPTH_WEIGHTS[DEPTH_WEIGHTS.length - 1].weights;

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

// Scatter loot — material piles dropped into rooms. Same seed → same piles
// so two clients see the same dungeon scavenge at start-of-cycle.
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
  floorIndex: number
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

  // Skip the entrance room — leave the safe-arrival cell empty.
  const candidateRooms = layout.rooms.slice(1);
  const drops: InitialLootDrop[] = [];
  for (const room of candidateRooms) {
    const big = room.w * room.h > 30_000;
    // Roughly 60% chance of a pile per small room, 100% for big rooms; big
    // rooms can have two piles.
    const piles = big ? (rng() < 0.5 ? 2 : 1) : rng() < 0.6 ? 1 : 0;
    for (let i = 0; i < piles; i++) {
      const materialId = pickWeighted(rng, weights) as InitialLootDrop['materialId'];
      // Stack size scales with depth — a tier-1 pile on floor 1 is 2-4 scrap;
      // on floor 10 it's 4-7. Higher-tier piles are smaller.
      const tierScale =
        materialId === 'scrap' || materialId === 'wire' ? 1.0
        : materialId === 'alloy' || materialId === 'circuit' ? 0.6
        : 0.4;
      const base = 2 + Math.floor(floorIndex / 3);
      const count = Math.max(
        1,
        Math.floor((base + Math.floor(rng() * 3)) * tierScale)
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

// Re-exported from @dumrunner/shared/geometry so both server and client
// share identical collision/LoS logic.
export { isInsideAny, segmentInsideWalkables } from '@dumrunner/shared';

