// Deterministic floor layout generator. Same (worldSeed, cycle, floorIndex)
// always produces the same layout — enables persistence-free regeneration
// (the layout itself never enters world_states snapshots) and lets shared
// servers see consistent floors.

import type {
  Rect,
  RoomTemplate,
  SceneAnchor,
  SceneLayout,
  TileGrid,
} from '@dumrunner/shared';
import {
  DEFAULT_FLOOR_TILE_ID,
  DEFAULT_WALL_TILE_ID,
  VOID_TILE_ID,
  isInsideAny,
  makeVariantSeed,
} from '@dumrunner/shared';
import { generateFloorLayoutPipeline, stampTemplate } from '@dumrunner/shared';
import { BIOMES } from './biomes.js';
import { PROPS } from './props.js';
import { ROOMS } from './rooms.js';

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

export function generateFloorLayout(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
  biome: string,
): SceneLayout {
  const gen = BIOMES[biome]?.generation;
  const generator = gen?.generator === 'tunneler' ? 'tunneler' : 'bsp';
  return generateFloorLayoutPipeline(worldSeed, cycle, floorIndex, biome, {
    generator,
    biomeConfig: {
      safeRoomChance: gen?.safeRoomChance,
      extremeRoomChance: gen?.extremeRoomChance,
    },
    roomTemplates: Object.values(ROOMS),
  });
}



// Walk outward from (x, y) in concentric rings of tile cells,
// returning the first cell-centre that's walkable. Caps at a
// 16-tile radius so a fully-walled-off region doesn't loop
// forever; on cap, returns the original point so the caller has
// SOMETHING to use even if the player ends up clipped briefly.
function snapToWalkable(
  grid: TileGridShape,
  tiles: Uint8Array,
  x: number,
  y: number,
): { x: number; y: number } {
  const tx0 = Math.floor(x / grid.tileSize) - grid.originTileX;
  const ty0 = Math.floor(y / grid.tileSize) - grid.originTileY;
  const at = (lx: number, ly: number): number => {
    if (lx < 0 || ly < 0 || lx >= grid.width || ly >= grid.height) return 0;
    return tiles[ly * grid.width + lx];
  };
  if (at(tx0, ty0) === DEFAULT_FLOOR_TILE_ID) return { x, y };
  for (let r = 1; r <= 16; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Only sample the outer ring at radius r.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (at(tx0 + dx, ty0 + dy) === DEFAULT_FLOOR_TILE_ID) {
          const cellX = tx0 + dx + grid.originTileX;
          const cellY = ty0 + dy + grid.originTileY;
          return {
            x: (cellX + 0.5) * grid.tileSize,
            y: (cellY + 0.5) * grid.tileSize,
          };
        }
      }
    }
  }
  return { x, y };
}

// Produce a per-cell tile id grid from the rect-based layout.
// Walkable cells get DEFAULT_FLOOR_TILE_ID; cells outside walkables
// that border a walkable (8-neighbour) get DEFAULT_WALL_TILE_ID;
// everything else stays VOID_TILE_ID.
//
// Returned in two parts so the caller can mutate the raw tile
// array (room-template stamping) before encoding it for the wire.
type TileGridShape = Omit<TileGrid, 'tilesB64'>;

function buildTileGridShape(
  worldBounds: Rect,
  walkables: Rect[],
): { grid: TileGridShape; tiles: Uint8Array } {
  const tileSize = TILE_SIZE;
  const originTileX = Math.floor(worldBounds.x / tileSize);
  const originTileY = Math.floor(worldBounds.y / tileSize);
  const width = Math.ceil((worldBounds.x + worldBounds.w) / tileSize) - originTileX;
  const height = Math.ceil((worldBounds.y + worldBounds.h) / tileSize) - originTileY;
  const tiles = new Uint8Array(width * height);

  // First pass: floor under every walkable cell.
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const cx = (originTileX + tx + 0.5) * tileSize;
      const cy = (originTileY + ty + 0.5) * tileSize;
      if (isInsideAny(walkables, cx, cy)) {
        tiles[ty * width + tx] = DEFAULT_FLOOR_TILE_ID;
      }
    }
  }

  // Second pass: wall = void cell with at least one floor neighbour.
  // 8-neighbour so corner stamps catch diagonal corridor turns.
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      if (tiles[ty * width + tx] !== VOID_TILE_ID) continue;
      let touchesFloor = false;
      for (let dy = -1; dy <= 1 && !touchesFloor; dy++) {
        for (let dx = -1; dx <= 1 && !touchesFloor; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (tiles[ny * width + nx] === DEFAULT_FLOOR_TILE_ID) {
            touchesFloor = true;
          }
        }
      }
      if (touchesFloor) tiles[ty * width + tx] = DEFAULT_WALL_TILE_ID;
    }
  }

  return {
    grid: { width, height, originTileX, originTileY, tileSize },
    tiles,
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

// Build a SceneLayout that contains a single room sized to the
// given room template, with the template's tiles already stamped
// into the grid and the template's anchors translated to world
// coords. Used by the editor's sandbox to preview a room
// template in isolation — the author sees exactly what they
// painted, in the chosen biome's tileset.
export function generateSingleRoomFloor(
  template: RoomTemplate,
  biome: string,
  worldSeed: number,
): SceneLayout {
  const padTiles = 2;
  const widthTiles = template.width + padTiles * 2;
  const heightTiles = template.height + padTiles * 2;
  // Centre the room around (0, 0) so the editor player spawns at
  // the room centre and the layout is symmetric.
  const roomTileX = -Math.floor(template.width / 2);
  const roomTileY = -Math.floor(template.height / 2);
  const room: Rect = {
    x: roomTileX * TILE_SIZE,
    y: roomTileY * TILE_SIZE,
    w: template.width * TILE_SIZE,
    h: template.height * TILE_SIZE,
  };
  const worldBounds: Rect = {
    x: (roomTileX - padTiles) * TILE_SIZE,
    y: (roomTileY - padTiles) * TILE_SIZE,
    w: widthTiles * TILE_SIZE,
    h: heightTiles * TILE_SIZE,
  };
  const walkables = [room];
  const rooms = [room];
  const spawn = { x: room.x + room.w / 2, y: room.y + room.h / 2 };

  const { grid: tileGridShape, tiles } = buildTileGridShape(
    worldBounds,
    walkables,
  );
  // Stamp the template directly. Origin in grid-local coords =
  // (roomTileX - grid.originTileX). buildTileGridShape sets
  // originTileX from worldBounds, so this lands cleanly.
  const gridOriginX = roomTileX - tileGridShape.originTileX;
  const gridOriginY = roomTileY - tileGridShape.originTileY;
  stampTemplate(
    { ...tileGridShape, tilesB64: '' },
    tiles,
    template,
    gridOriginX,
    gridOriginY,
  );
  // Translate every template anchor into world coords.
  const anchors: SceneAnchor[] = template.anchors.map((a) => ({
    kind: a.kind,
    x: (roomTileX + a.tx + 0.5) * TILE_SIZE,
    y: (roomTileY + a.ty + 0.5) * TILE_SIZE,
    overrideId: a.overrideId,
  }));
  // If the template has a 'spawn' anchor, use it for the editor's
  // arrival point so they don't land on a wall.
  let safeSpawn = spawn;
  for (const a of anchors) {
    if (a.kind === 'spawn') {
      safeSpawn = { x: a.x, y: a.y };
      break;
    }
  }
  const tileGrid: TileGrid = {
    ...tileGridShape,
    tilesB64: Buffer.from(tiles).toString('base64'),
  };
  const variantSeed = makeVariantSeed(worldSeed, 0, 0);
  return {
    worldBounds,
    walkables,
    rooms,
    spawn: safeSpawn,
    interactables: [],
    tileSize: TILE_SIZE,
    biome,
    roomCategories: ['safe'],
    tileGrid,
    variantSeed,
    anchors,
  };
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
  const enemySnap = makeWalkableSnapper(layout);

  // Anchors take precedence: rooms whose templates emitted enemy
  // anchors get exactly those spawns, no random scatter on top.
  // Rooms without enemy anchors fall through to the legacy room-
  // density spawn so half-authored biomes still produce fights.
  const anchorRoomIndices = roomsWithAnchorKind(layout, 'enemy');
  const spawns: InitialEnemySpawn[] = [];
  if (layout.anchors) {
    for (const a of layout.anchors) {
      if (a.kind !== 'enemy') continue;
      const templateId = a.overrideId ?? pickWeighted(rng, weights);
      spawns.push({ templateId, x: a.x, y: a.y });
    }
  }

  // First room is the entrance — leave it empty for safe arrival.
  // We iterate the original index space (0..N-1) so we can read
  // the parallel roomCategories without re-aligning indices.
  for (let i = 1; i < layout.rooms.length; i++) {
    if (anchorRoomIndices.has(i)) continue;
    const room = layout.rooms[i];
    const category = layout.roomCategories?.[i] ?? 'hazard';
    // Safe rooms host nothing (breather pockets); extreme rooms
    // stuff in extra spawns to make the risk-reward visible.
    if (category === 'safe') continue;
    const baseCount = room.w * room.h > 30_000 ? 2 : 1;
    const count =
      category === 'extreme' ? baseCount + 2 : baseCount;
    for (let j = 0; j < count; j++) {
      const templateId = pickWeighted(rng, weights);
      // Random point inside the room, with a small inset so enemies aren't
      // flush against walls. Snap onto the nearest walkable tile so
      // walker chambers (which can poke past the carved blob's edge)
      // don't drop enemies into cave walls.
      const sx = room.x + 24 + rng() * (room.w - 48);
      const sy = room.y + 24 + rng() * (room.h - 48);
      const { x, y } = enemySnap(sx, sy);
      spawns.push({ templateId, x, y });
    }
  }
  return spawns;
}

// Set of room indices that have at least one anchor of the given
// kind. Used by the spawn generators to skip random scatter on
// templated rooms (anchors take over) without affecting unt-
// emplated rooms (random scatter still runs).
function roomsWithAnchorKind(
  layout: SceneLayout,
  kind: SceneAnchor['kind'],
): Set<number> {
  const out = new Set<number>();
  if (!layout.anchors) return out;
  for (const a of layout.anchors) {
    if (a.kind !== kind) continue;
    for (let i = 0; i < layout.rooms.length; i++) {
      const r = layout.rooms[i];
      if (a.x >= r.x && a.x < r.x + r.w && a.y >= r.y && a.y < r.y + r.h) {
        out.add(i);
        break;
      }
    }
  }
  return out;
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
  const propSnap = makeWalkableSnapper(layout);

  // Anchor-driven props first (templated rooms author exact prop
  // placements). Random scatter then fills any room without prop
  // anchors so untemplated biomes still see decoration.
  const anchorRoomIndices = roomsWithAnchorKind(layout, 'prop');
  if (layout.anchors) {
    for (const a of layout.anchors) {
      if (a.kind !== 'prop') continue;
      const kind = a.overrideId ?? pickWeighted(rng, paletteWeights(palette));
      spawns.push({ kind, x: a.x, y: a.y });
    }
  }

  // First room is the entrance — keep it clean of obstacles so
  // arrival doesn't faceplant into a barrel.
  for (let i = 1; i < layout.rooms.length; i++) {
    if (anchorRoomIndices.has(i)) continue;
    const room = layout.rooms[i];
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
    for (let j = 0; j < count; j++) {
      const entry = pickWeighted(rng, paletteWeights(palette));
      const sx = room.x + 24 + rng() * Math.max(0, room.w - 48);
      const sy = room.y + 24 + rng() * Math.max(0, room.h - 48);
      const { x, y } = propSnap(sx, sy);
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

// Decode the layout's tile grid + return a closure that snaps an
// (x, y) sample point to the nearest walkable cell. Tunneling-
// generated layouts have rooms = fully-walkable rects so the snap
// is a no-op; walker-generated layouts have chamber rects that
// can extend a couple cells past the carved blob, and the snap
// pulls those samples onto an actual floor tile so enemies / props
// don't land embedded in cave walls.
function makeWalkableSnapper(
  layout: SceneLayout,
): (x: number, y: number) => { x: number; y: number } {
  const grid = layout.tileGrid;
  if (!grid) return (x, y) => ({ x, y });
  const tiles = Buffer.from(grid.tilesB64, 'base64');
  const shape: TileGridShape = {
    width: grid.width,
    height: grid.height,
    originTileX: grid.originTileX,
    originTileY: grid.originTileY,
    tileSize: grid.tileSize,
  };
  const tileBytes = new Uint8Array(
    tiles.buffer,
    tiles.byteOffset,
    tiles.byteLength,
  );
  return (x, y) => snapToWalkable(shape, tileBytes, x, y);
}

// Scatter loot — material piles dropped into rooms. Same seed → same piles
// so two clients see the same dungeon scavenge at start-of-cycle.
//
// Artifacts intentionally don't appear in floor scatter — they're a kill-
// drop only currency, sold to the artifact uplink for blueprints.
export type InitialLootDrop = {
  materialId:
    | 'scrap'
    | 'wire'
    | 'circuit'
    | 'alloy'
    | 'alloy_mk3'
    | 'alloy_mk4'
    | 'biotic'
    | 'crystal';
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
    weights: { scrap: 30, wire: 20, alloy: 25, alloy_mk3: 8, circuit: 15, biotic: 10 },
  },
  {
    maxFloor: Infinity,
    weights: {
      scrap: 20,
      wire: 15,
      alloy: 22,
      alloy_mk3: 15,
      alloy_mk4: 10,
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
    if (k === 'alloy_mk3' || k === 'alloy_mk4') out[k] = (out[k] ?? 0) + 15;
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
  // Branching procgen produces a corridor graph, not a strict
  // chain. A room is safe to lock iff removing it from the graph
  // still leaves the entrance reachable from the stairs — i.e.
  // it's not on every entrance→stairs path. Cheap check: BFS
  // with the candidate room temporarily removed. With ~10 rooms
  // per floor this is trivial cost. Falls back to the legacy
  // "past stairs index" heuristic if the layout has no roomGraph
  // (walker biomes, snapshots from before this change, etc.).
  const lockedSet = new Set<number>();
  const lockChance = Math.min(
    0.55,
    0.33 + Math.max(0, floorIndex - 1) * 0.04
  );
  const doors: InitialDoor[] = [];
  // The reachability check must run over the PUNCHED doorway
  // graph — the portals the assembler actually opened — not the
  // roomGraph. roomGraph is raw rect adjacency and lists edges
  // whose shared wall never got a doorway punched (contact patch
  // under the min-shared threshold), so it claims phantom
  // alternate routes; locking a room "covered" by such a route
  // sealed the only real entrance→stairs path behind key-doors.
  // A locked room seals ALL its portals, so removing the room's
  // node from the punched graph models the lock exactly.
  const doorwaySpecs = layout.doorways ?? [];
  let graph: number[][] | null = null;
  if (doorwaySpecs.length > 0) {
    graph = layout.rooms.map(() => [] as number[]);
    for (const dw of doorwaySpecs) {
      if (graph[dw.a] && graph[dw.b]) {
        graph[dw.a].push(dw.b);
        graph[dw.b].push(dw.a);
      }
    }
  } else if (layout.roomGraph) {
    // Pre-doorway-spec layouts (corridor-rect floors, old
    // snapshots): roomGraph is the only connectivity we have.
    graph = layout.roomGraph;
  }
  // layout.rooms is region-indexed and includes corridor regions;
  // locking a corridor puts key-doors across a hallway with no
  // loot behind them. The doorway specs flag which side of each
  // portal is a corridor — exclude those indices from locking.
  const corridorIndices = new Set<number>();
  for (const dw of doorwaySpecs) {
    if (dw.aIsCorridor) corridorIndices.add(dw.a);
    if (dw.bIsCorridor) corridorIndices.add(dw.b);
  }
  for (let i = 1; i < layout.rooms.length; i++) {
    if (i === stairsRoomIndex) continue;
    if (corridorIndices.has(i)) continue;
    if (rng() > lockChance) continue;
    if (graph) {
      // Skip if locking room i — TOGETHER with the rooms already
      // locked this floor — disconnects entrance (room 0) from
      // the stairs room. Checking the candidate in isolation let
      // two individually-safe locks jointly sever the route.
      if (
        stairsRoomIndex >= 0 &&
        !reachableInGraph(graph, 0, stairsRoomIndex, new Set([...lockedSet, i]))
      ) {
        continue;
      }
    } else {
      // Legacy chain heuristic.
      if (stairsRoomIndex >= 0 && i <= stairsRoomIndex) continue;
    }
    const room = layout.rooms[i];
    // Preferred: place doors exactly across the doorway portals
    // the assembler punched for this room — one short run per
    // opening, ON the opening, corridor-side when the neighbour
    // is a corridor. The older shared-edge fallbacks lined entire
    // walls with doors one tile inside the room ("walls of
    // doors" blocking nothing).
    let tiles = pickDoorTilesFromDoorways(i, room, layout.doorways, tileSize);
    // Fallbacks for layouts without doorway specs (corridor-rect
    // floors, pre-spec snapshots).
    if (tiles.length === 0) {
      tiles = pickDoorTilesForRoom(room, corridorRects, tileSize);
    }
    if (tiles.length === 0 && graph) {
      tiles = pickDoorTilesViaGraph(i, room, graph, layout.rooms, tileSize);
    }
    if (tiles.length === 0) continue;
    lockedSet.add(i);
    doors.push(...tiles);
  }

  return { lockedRoomIndices: [...lockedSet], doors };
}

// Doorway-spec door placement (v2 pipeline). The assembler records
// every punched portal as a DoorwaySpec; a locked room gets door
// tiles across each of its portals — sealing every way in — placed
// on the corridor side of the boundary when the neighbour is a
// corridor (so the door reads as blocking the hallway mouth, not
// floating inside the room) and on the room side for room↔room
// doors.
function pickDoorTilesFromDoorways(
  index: number,
  room: Rect,
  doorways: SceneLayout['doorways'],
  tileSize: number,
): InitialDoor[] {
  if (!doorways || doorways.length === 0) return [];
  const tiles: InitialDoor[] = [];
  const seen = new Set<string>();
  for (const dw of doorways) {
    if (dw.a !== index && dw.b !== index) continue;
    const neighborIsCorridor = dw.a === index ? dw.bIsCorridor : dw.aIsCorridor;
    // The portal lies on the boundary line at `coord`; a door tile
    // sits on one side of it. Room side vs neighbour side is
    // resolved from the room rect.
    const edgeTile = Math.round(dw.coord / tileSize);
    const tFirst = Math.floor(dw.lo / tileSize);
    const tLast = Math.ceil(dw.hi / tileSize) - 1;
    if (dw.axis === 'vertical') {
      const roomOnLeft = Math.abs(room.x + room.w - dw.coord) < 1;
      const roomSide = roomOnLeft ? edgeTile - 1 : edgeTile;
      const neighborSide = roomOnLeft ? edgeTile : edgeTile - 1;
      const tileX = neighborIsCorridor ? neighborSide : roomSide;
      for (let ty = tFirst; ty <= tLast; ty++) {
        const key = `${tileX}:${ty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({ tileX, tileY: ty });
      }
    } else {
      const roomOnTop = Math.abs(room.y + room.h - dw.coord) < 1;
      const roomSide = roomOnTop ? edgeTile - 1 : edgeTile;
      const neighborSide = roomOnTop ? edgeTile : edgeTile - 1;
      const tileY = neighborIsCorridor ? neighborSide : roomSide;
      for (let tx = tFirst; tx <= tLast; tx++) {
        const key = `${tx}:${tileY}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({ tileX: tx, tileY });
      }
    }
  }
  return tiles;
}

// Shared-edge door placement. Finds the longest run of tiles
// where this room touches an adjacent graph neighbour and emits
// door tiles along that run, on the locked room's side of the
// edge. Used by the v2 pipeline (BSP regions) where there are no
// separate corridor rects.
function pickDoorTilesViaGraph(
  index: number,
  room: Rect,
  graph: number[][],
  rooms: Rect[],
  tileSize: number,
): InitialDoor[] {
  const tx0 = Math.floor(room.x / tileSize);
  const ty0 = Math.floor(room.y / tileSize);
  const txEnd = Math.floor((room.x + room.w) / tileSize);
  const tyEnd = Math.floor((room.y + room.h) / tileSize);

  let bestRun: InitialDoor[] = [];

  for (const j of graph[index] ?? []) {
    const other = rooms[j];
    if (!other) continue;
    const ox0 = Math.floor(other.x / tileSize);
    const oy0 = Math.floor(other.y / tileSize);
    const oxEnd = Math.floor((other.x + other.w) / tileSize);
    const oyEnd = Math.floor((other.y + other.h) / tileSize);

    let run: InitialDoor[] = [];
    // Top wall — neighbour sits above.
    if (oyEnd === ty0) {
      const lo = Math.max(tx0, ox0);
      const hi = Math.min(txEnd, oxEnd);
      for (let tx = lo; tx < hi; tx++) {
        run.push({ tileX: tx, tileY: ty0 });
      }
    } else if (oy0 === tyEnd) {
      // Bottom wall — neighbour below.
      const lo = Math.max(tx0, ox0);
      const hi = Math.min(txEnd, oxEnd);
      for (let tx = lo; tx < hi; tx++) {
        run.push({ tileX: tx, tileY: tyEnd - 1 });
      }
    } else if (oxEnd === tx0) {
      // Left wall — neighbour to the left.
      const lo = Math.max(ty0, oy0);
      const hi = Math.min(tyEnd, oyEnd);
      for (let ty = lo; ty < hi; ty++) {
        run.push({ tileX: tx0, tileY: ty });
      }
    } else if (ox0 === txEnd) {
      // Right wall — neighbour to the right.
      const lo = Math.max(ty0, oy0);
      const hi = Math.min(tyEnd, oyEnd);
      for (let ty = lo; ty < hi; ty++) {
        run.push({ tileX: txEnd - 1, tileY: ty });
      }
    }
    if (run.length > bestRun.length) bestRun = run;
  }

  return bestRun;
}

// BFS from `from` to `to` in `graph`, treating every node in
// `excluded` as removed. Returns true if `to` is reachable. Used
// by lock placement to verify a candidate (plus the rooms already
// locked this floor) doesn't sever the entrance → stairs path.
function reachableInGraph(
  graph: number[][],
  from: number,
  to: number,
  excluded: ReadonlySet<number>,
): boolean {
  if (excluded.has(from) || excluded.has(to)) return false;
  if (from === to) return true;
  const visited = new Set<number>([from, ...excluded]);
  const queue: number[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of graph[cur] ?? []) {
      if (visited.has(next)) continue;
      if (next === to) return true;
      visited.add(next);
      queue.push(next);
    }
  }
  return false;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// Find the door spans where the room meets adjacent corridors.
// Each room wall (top/bottom/left/right) emits at most ONE
// contiguous span — the longest run of perimeter tiles that touch
// a corridor on that side. Without this cap, when a corridor
// grazes multiple sides of a room (common when the tunneler hugs
// it on more than one side), every touching tile becomes a door
// and the room reads as having doors around all borders.
// A multi-tile span is preserved as multiple adjacent doors that
// open as one (the server flood-fills by adjacency).
function pickDoorTilesForRoom(
  room: Rect,
  corridors: Rect[],
  tileSize: number
): InitialDoor[] {
  const tx0 = Math.floor(room.x / tileSize);
  const ty0 = Math.floor(room.y / tileSize);
  const txEnd = Math.floor((room.x + room.w) / tileSize);
  const tyEnd = Math.floor((room.y + room.h) / tileSize);

  // For one wall: walk the perimeter tiles in order and split into
  // contiguous runs of corridor-touching tiles. Returns the longest
  // run only; ties keep the first encountered.
  function longestRun(
    startIdx: number,
    endIdx: number,
    touches: (i: number) => boolean,
    makeDoor: (i: number) => InitialDoor,
  ): InitialDoor[] {
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = startIdx; i < endIdx; i++) {
      if (touches(i)) {
        if (curLen === 0) curStart = i;
        curLen++;
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
        }
      } else {
        curLen = 0;
      }
    }
    if (bestLen === 0) return [];
    const out: InitialDoor[] = [];
    for (let i = bestStart; i < bestStart + bestLen; i++) {
      out.push(makeDoor(i));
    }
    return out;
  }

  const tiles: InitialDoor[] = [];
  // Top wall — touching corridor on the row above.
  tiles.push(
    ...longestRun(
      tx0,
      txEnd,
      (tx) => tileTouchesCorridor(tx, ty0 - 1, corridors, tileSize),
      (tx) => ({ tileX: tx, tileY: ty0 }),
    ),
  );
  // Bottom wall.
  tiles.push(
    ...longestRun(
      tx0,
      txEnd,
      (tx) => tileTouchesCorridor(tx, tyEnd, corridors, tileSize),
      (tx) => ({ tileX: tx, tileY: tyEnd - 1 }),
    ),
  );
  // Left wall.
  tiles.push(
    ...longestRun(
      ty0,
      tyEnd,
      (ty) => tileTouchesCorridor(tx0 - 1, ty, corridors, tileSize),
      (ty) => ({ tileX: tx0, tileY: ty }),
    ),
  );
  // Right wall.
  tiles.push(
    ...longestRun(
      ty0,
      tyEnd,
      (ty) => tileTouchesCorridor(txEnd, ty, corridors, tileSize),
      (ty) => ({ tileX: txEnd - 1, tileY: ty }),
    ),
  );
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

