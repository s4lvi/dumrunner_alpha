// Deterministic floor layout generator. Same (worldSeed, cycle, floorIndex)
// always produces the same layout — enables persistence-free regeneration
// (the layout itself never enters world_states snapshots) and lets shared
// servers see consistent floors.

import type {
  HazardZoneCategory,
  Interactable,
  Rect,
  RoomRole,
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
import { BIOMES } from './biomes.js';
import { PROPS } from './props.js';
import {
  eligibleTemplates,
  pickTemplate,
  stampTemplate,
  templateTiles,
} from './rooms.js';

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

const FLOOR_HALF_TILES = 80;       // 80 * 32 = 2560 px from origin

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

// Biased size roll. Squaring rng() pushes the distribution toward
// `lo` — most rolls are small, larger results are rare. Used by
// the tunneler when picking room dimensions.
function rngSizeBiased(rng: () => number, lo: number, hi: number): number {
  return Math.floor(lo + rng() * rng() * (hi - lo));
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

// Top-level dispatcher. Picks a generator based on the biome's
// `generation.generator` field; defaults to 'tunneling' so biomes
// that pre-date the walker keep their behaviour. Walker is wired
// into Alien Core today; other biomes can opt in by setting their
// generation block accordingly.
export function generateFloorLayout(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
  biome: string,
): SceneLayout {
  const kind = BIOMES[biome]?.generation.generator ?? 'tunneling';
  if (kind === 'walker') {
    return generateFloorLayoutWalker(worldSeed, cycle, floorIndex, biome);
  }
  return generateFloorLayoutTunneling(worldSeed, cycle, floorIndex, biome);
}

// Tunneling generator — DungeonMaker 2 Tunneler model.
// Source: dungeonmaker.sourceforge.net/dungeonmaker-2.05 (Peter
// Henningsen). The algorithm referenced by Cogmind's Grid Sage
// Games blog at gridsagegames.com/blog/2014/06/mapgen-tunneling-algorithm.
//
// Map starts ENTIRELY CLOSED (every cell wall). Tunneler agents
// walk forward and CARVE a `length × (2*tunnelWidth + 1)` strip
// of floor each step (BuildTunnel). They turn, spawn babies on
// turns + rare straight-line spawns, place rooms (anterooms) on
// the side, and try to Join existing tunnels when running out of
// room or aging out — joins create loops naturally.
//
// Output: rooms[] = anteroom rects placed by the tunnelers,
// walkables = single bounds rect (renderer paints floor over the
// whole world; tile grid walls draw on top), tile grid is the
// source of truth for what's walkable.
const TUN_GRID_HALF = 60;            // 121×121-tile world
const TUN_BORDER = 1;                // outer-wall thickness
const TUN_DEFAULT_TUNNELERS = 2;
const TUN_DEFAULT_STEP_LENGTH = 4;
const TUN_DEFAULT_TURN_CHANCE = 0.25;
const TUN_DEFAULT_BRANCH_CHANCE = 0.20;     // single-baby spawn chance per turn
const TUN_DEFAULT_DOUBLE_BRANCH = 0.10;     // second-baby chance per turn (gated by branch)
const TUN_DEFAULT_INITIAL_WIDTH = 0;        // tunnelWidth: 0 → 1-tile, 1 → 3-tile
const TUN_DEFAULT_ROOM_MIN = 4;
const TUN_DEFAULT_ROOM_MAX = 9;
const TUN_DEFAULT_ROOM_COUNT_MIN = 25;
const TUN_DEFAULT_ROOM_COUNT_MAX = 60;
const TUN_DEFAULT_ROOM_RIGHT_PROB = 0.40;
const TUN_DEFAULT_ROOM_LEFT_PROB = 0.40;
const TUN_DEFAULT_JOIN_PREF = 0.60;
const TUN_MAX_ALIVE = 32;
const TUN_DEFAULT_MAX_ITERATIONS = 1500;
const TUN_CRAWLER_MAX_AGE = 30;

// Working-buffer cell ids during the carve simulation. The grid
// starts entirely TUN_WALL; tunnelers carve TUN_FLOOR; rooms
// (anterooms) carve TUN_ROOM_FLOOR so we can identify room
// extents post-hoc. At the end TUN_ROOM_FLOOR collapses to the
// standard FLOOR id.
const TUN_FLOOR = DEFAULT_FLOOR_TILE_ID;       // 1
const TUN_WALL = DEFAULT_WALL_TILE_ID;         // 2
const TUN_ROOM_FLOOR = 3;                      // collapses to TUN_FLOOR at end

function generateFloorLayoutTunneling(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
  biome: string,
): SceneLayout {
  const mixed =
    (worldSeed * 0x9e3779b1) ^
    (cycle * 0x85ebca77) ^
    (floorIndex * 0xc2b2ae3d);
  const rng = mulberry32(mixed);

  const gen = BIOMES[biome]?.generation;
  const tunnelerCount = Math.max(
    1,
    gen?.tunnelerCount ?? TUN_DEFAULT_TUNNELERS,
  );
  const maxIterations =
    gen?.tunnelerStepBudget ?? TUN_DEFAULT_MAX_ITERATIONS;
  const turnChance = gen?.turnChance ?? TUN_DEFAULT_TURN_CHANCE;
  const branchChance = gen?.branching ?? TUN_DEFAULT_BRANCH_CHANCE;
  // tunnelWidth: 0 → 1-tile corridor, 1 → 3-tile, 2 → 5-tile.
  // Map biome's `corridorWidth` (full tile count) to DM2's
  // (full = 1 + 2*tw). Allow bumping by ±1 in babies.
  const corridorWidthRaw = gen?.corridorWidth ?? 1;
  const initialTunnelWidth = Math.max(
    0,
    Math.floor((corridorWidthRaw - 1) / 2),
  );
  const lockCorridorWidth = gen?.lockCorridorWidth ?? false;
  void TUN_DEFAULT_INITIAL_WIDTH;
  const stepLength = TUN_DEFAULT_STEP_LENGTH;
  const roomMinTiles = gen?.roomSizeMin ?? TUN_DEFAULT_ROOM_MIN;
  const roomMaxTiles = gen?.roomSizeMax ?? TUN_DEFAULT_ROOM_MAX;
  const roomCountMin = gen?.roomCountMin ?? TUN_DEFAULT_ROOM_COUNT_MIN;
  void roomCountMin;
  const roomCountMax = gen?.roomCountMax ?? TUN_DEFAULT_ROOM_COUNT_MAX;
  const mRRP = gen?.roomChance ?? TUN_DEFAULT_ROOM_RIGHT_PROB;
  const mRLP = gen?.roomChance ?? TUN_DEFAULT_ROOM_LEFT_PROB;
  const joinPref = TUN_DEFAULT_JOIN_PREF;

  // ---------- Grid init: ALL WALLS ----------
  const originTileX = -TUN_GRID_HALF;
  const originTileY = -TUN_GRID_HALF;
  const gridW = TUN_GRID_HALF * 2 + 1;
  const gridH = TUN_GRID_HALF * 2 + 1;
  const tiles = new Uint8Array(gridW * gridH);
  tiles.fill(TUN_WALL);

  function getCell(lx: number, ly: number): number {
    if (lx < 0 || ly < 0 || lx >= gridW || ly >= gridH) return TUN_WALL;
    return tiles[ly * gridW + lx];
  }
  function setCell(lx: number, ly: number, v: number): void {
    if (lx < TUN_BORDER || ly < TUN_BORDER) return;
    if (lx >= gridW - TUN_BORDER || ly >= gridH - TUN_BORDER) return;
    tiles[ly * gridW + lx] = v;
  }

  // ---------- Tunneler simulation ----------
  // Each tunneler walks forward and carves a strip via
  // BuildTunnel(length, width). When clearance ahead drops below
  // 2*stepLength it tries Join (creating loops) or builds a
  // terminating anteroom and dies. Children spawn on turns + (rare)
  // straight runs with modified params.
  type Tunneler = {
    lx: number;
    ly: number;
    fdx: number;
    fdy: number;
    stepLength: number;
    tunnelWidth: number;
    age: number;
    maxAge: number;
  };
  const tunnelers: Tunneler[] = [];
  function spawnTunneler(t: Tunneler): void {
    if (tunnelers.length >= TUN_MAX_ALIVE) return;
    tunnelers.push(t);
  }

  // FrontFree: how many full-width rows ahead are pure WALL
  // (carvable). DM2's check looks for OPEN squares as the BLOCKER
  // in carving — opposite of WallCrawler. Stop when any cell in
  // the perpendicular span is non-wall.
  function frontFreeAt(
    lx: number,
    ly: number,
    fdx: number,
    fdy: number,
    width: number,
  ): number {
    const rdx = fdy;
    const rdy = -fdx;
    let free = 0;
    for (let dist = 1; dist <= gridW + gridH; dist++) {
      let blocked = false;
      for (let i = -width; i <= width && !blocked; i++) {
        const tlx = lx + dist * fdx + i * rdx;
        const tly = ly + dist * fdy + i * rdy;
        if (
          tlx < TUN_BORDER ||
          tly < TUN_BORDER ||
          tlx >= gridW - TUN_BORDER ||
          tly >= gridH - TUN_BORDER
        ) {
          blocked = true;
          break;
        }
        if (tiles[tly * gridW + tlx] !== TUN_WALL) {
          blocked = true;
          break;
        }
      }
      if (blocked) return free;
      free = dist;
    }
    return free;
  }

  function buildTunnel(
    t: Tunneler,
    length: number,
    width: number,
  ): void {
    const rdx = t.fdy;
    const rdy = -t.fdx;
    for (let fwd = 1; fwd <= length; fwd++) {
      for (let side = -width; side <= width; side++) {
        setCell(
          t.lx + fwd * t.fdx + side * rdx,
          t.ly + fwd * t.fdy + side * rdy,
          TUN_FLOOR,
        );
      }
    }
  }

  // Anteroom placement. Returns the placed Rect (in tile-space
  // world coords) or null if it didn't fit. Rooms are carved as
  // TUN_ROOM_FLOOR so we can later flood-find their bounds.
  //
  // Layout: room's near edge sits at distance D = corrExtent + 2
  // from the tunneler's centre, in the push direction. corrExtent
  // is the corridor's perpendicular reach in that direction —
  // tunnelWidth for sideways pushes, 0 for forward pushes (the
  // corridor doesn't reach past the tunneler in its own forward
  // axis). That puts a 1-tile entrance cell BETWEEN the corridor's
  // outer edge and the room's near edge, regardless of corridor
  // width.
  const roomsTiles: Rect[] = [];
  function tryAnteroom(
    t: Tunneler,
    pushFdx: number,
    pushFdy: number,
  ): Rect | null {
    if (roomsTiles.length >= roomCountMax) return null;
    const rw = rngSizeBiased(rng, roomMinTiles, roomMaxTiles + 1);
    const rh = rngSizeBiased(rng, roomMinTiles, roomMaxTiles + 1);
    const tw = t.tunnelWidth;
    // Push axis aligned with tunneler heading? If yes, corridor
    // doesn't extend into the push direction beyond the tunneler.
    // If no (sideways push), corridor reaches `tw` past the centre.
    const alongPushIsTunnelerDir =
      (pushFdx !== 0) === (t.fdx !== 0);
    const corrExtent = alongPushIsTunnelerDir ? 0 : tw;
    // Distance from tunneler centre to room's NEAR edge (cell).
    // = corrExtent + 1 (gap cell) + 1 (the near edge cell itself).
    const D = corrExtent + 2;
    const cx = t.lx + originTileX;
    const cy = t.ly + originTileY;
    let rx: number;
    let ry: number;
    if (pushFdx > 0) {
      rx = cx + D;
      ry = cy - Math.floor(rh / 2);
    } else if (pushFdx < 0) {
      rx = cx - D - rw + 1;
      ry = cy - Math.floor(rh / 2);
    } else if (pushFdy > 0) {
      rx = cx - Math.floor(rw / 2);
      ry = cy + D;
    } else {
      rx = cx - Math.floor(rw / 2);
      ry = cy - D - rh + 1;
    }
    const lx0 = rx - originTileX;
    const ly0 = ry - originTileY;
    if (
      lx0 < TUN_BORDER ||
      ly0 < TUN_BORDER ||
      lx0 + rw >= gridW - TUN_BORDER ||
      ly0 + rh >= gridH - TUN_BORDER
    )
      return null;
    // Reject overlap with any existing non-wall content.
    for (let yy = 0; yy < rh; yy++) {
      for (let xx = 0; xx < rw; xx++) {
        const cell = tiles[(ly0 + yy) * gridW + (lx0 + xx)];
        if (cell !== TUN_WALL) return null;
      }
    }
    // Connector cells: 1-tile-wide door from corridor edge to
    // room's near edge, through the gap. Length = corrExtent + 1
    // (the cells between tunneler centre and room near edge,
    // exclusive on both ends).
    const connectorLen = corrExtent + 1;
    for (let i = 1; i <= connectorLen; i++) {
      setCell(t.lx + i * pushFdx, t.ly + i * pushFdy, TUN_FLOOR);
    }
    // Carve the room.
    for (let yy = 0; yy < rh; yy++) {
      for (let xx = 0; xx < rw; xx++) {
        setCell(lx0 + xx, ly0 + yy, TUN_ROOM_FLOOR);
      }
    }
    const rect: Rect = { x: rx, y: ry, w: rw, h: rh };
    roomsTiles.push(rect);
    return rect;
  }

  function spawnBabiesOnTurn(parent: Tunneler, oldFdx: number, oldFdy: number): void {
    // Both babies are gated. Without gating the first, every turn
    // doubles the active agent count and the map becomes a maze.
    if (rng() >= branchChance) return;
    // First baby looks back along the parent's new direction so
    // the corridor extends both ways from the turn point.
    spawnTunneler({
      lx: parent.lx,
      ly: parent.ly,
      fdx: -parent.fdx,
      fdy: -parent.fdy,
      stepLength: parent.stepLength,
      tunnelWidth: jitterTunnelWidth(parent.tunnelWidth),
      age: 0,
      maxAge: TUN_CRAWLER_MAX_AGE,
    });
    // Second baby in the parent's OLD forward direction (the
    // path the parent abandoned). Rare — gated by doubleBranch
    // probability ON TOP of the first-baby gate.
    if (rng() < TUN_DEFAULT_DOUBLE_BRANCH) {
      spawnTunneler({
        lx: parent.lx,
        ly: parent.ly,
        fdx: oldFdx,
        fdy: oldFdy,
        stepLength: parent.stepLength,
        tunnelWidth: jitterTunnelWidth(parent.tunnelWidth),
        age: 0,
        maxAge: TUN_CRAWLER_MAX_AGE,
      });
    }
  }

  function jitterTunnelWidth(w: number): number {
    if (lockCorridorWidth) return w;
    // ±1 with low probability so most children inherit width.
    const r = rng();
    if (r < 0.15) return Math.max(0, w - 1);
    if (r < 0.30) return Math.min(2, w + 1);
    return w;
  }

  // Initial tunnelers: seed inward from the centre of each
  // cardinal edge. DM2 also spawns from corners; one-per-edge is
  // enough variety for our floor sizes.
  const midX = Math.floor(gridW / 2);
  const midY = Math.floor(gridH / 2);
  const seedFwd = TUN_BORDER + initialTunnelWidth;
  for (let i = 0; i < tunnelerCount; i++) {
    const idx = i % 4;
    if (idx === 0) {
      spawnTunneler({
        lx: midX,
        ly: seedFwd,
        fdx: 0,
        fdy: 1,
        stepLength,
        tunnelWidth: initialTunnelWidth,
        age: 0,
        maxAge: TUN_CRAWLER_MAX_AGE,
      });
    } else if (idx === 1) {
      spawnTunneler({
        lx: seedFwd,
        ly: midY,
        fdx: 1,
        fdy: 0,
        stepLength,
        tunnelWidth: initialTunnelWidth,
        age: 0,
        maxAge: TUN_CRAWLER_MAX_AGE,
      });
    } else if (idx === 2) {
      spawnTunneler({
        lx: midX,
        ly: gridH - 1 - seedFwd,
        fdx: 0,
        fdy: -1,
        stepLength,
        tunnelWidth: initialTunnelWidth,
        age: 0,
        maxAge: TUN_CRAWLER_MAX_AGE,
      });
    } else {
      spawnTunneler({
        lx: gridW - 1 - seedFwd,
        ly: midY,
        fdx: -1,
        fdy: 0,
        stepLength,
        tunnelWidth: initialTunnelWidth,
        age: 0,
        maxAge: TUN_CRAWLER_MAX_AGE,
      });
    }
  }

  // Carve the initial position so each tunneler starts on floor.
  for (const t of tunnelers) {
    const rdx = t.fdy;
    const rdy = -t.fdx;
    for (let i = -t.tunnelWidth; i <= t.tunnelWidth; i++) {
      setCell(t.lx + i * rdx, t.ly + i * rdy, TUN_FLOOR);
    }
  }

  // Try to join an existing tunnel/room directly ahead. Returns
  // true if joined (caller kills the tunneler).
  function tryJoin(t: Tunneler, frontFree: number): boolean {
    if (frontFree < 1) return false;
    // Cell directly past frontFree.
    const tx = t.lx + (frontFree + 1) * t.fdx;
    const ty = t.ly + (frontFree + 1) * t.fdy;
    const id = getCell(tx, ty);
    if (id === TUN_FLOOR || id === TUN_ROOM_FLOOR) {
      // Carve through the wall up to the join point.
      buildTunnel(t, frontFree, t.tunnelWidth);
      return true;
    }
    return false;
  }

  let iter = 0;
  while (tunnelers.length > 0 && iter++ < maxIterations) {
    for (let i = tunnelers.length - 1; i >= 0; i--) {
      const t = tunnelers[i];
      t.age++;
      if (t.age >= t.maxAge) {
        crawlerTerminate(t);
        tunnelers.splice(i, 1);
        continue;
      }
      const tw = t.tunnelWidth;
      const frontFree = frontFreeAt(t.lx, t.ly, t.fdx, t.fdy, tw);
      if (frontFree === 0) {
        // Pinned. Try sideways relocation; else die.
        const rdx = t.fdy;
        const rdy = -t.fdx;
        const rightFree = frontFreeAt(t.lx, t.ly, rdx, rdy, tw);
        const leftFree = frontFreeAt(t.lx, t.ly, -rdx, -rdy, tw);
        if (rightFree === 0 && leftFree === 0) {
          tunnelers.splice(i, 1);
          continue;
        }
        if (rightFree >= leftFree) {
          t.fdx = rdx;
          t.fdy = rdy;
        } else {
          t.fdx = -rdx;
          t.fdy = -rdy;
        }
        continue;
      }

      // Running out of room or aging out: try to join, else
      // build a terminating anteroom + die.
      if (
        frontFree < 2 * t.stepLength ||
        t.age >= t.maxAge - 1
      ) {
        const wantJoin = rng() < joinPref;
        if (wantJoin && tryJoin(t, frontFree)) {
          tunnelers.splice(i, 1);
          continue;
        }
        // Carve as much as we can, then drop a terminating room.
        const lay = Math.min(frontFree, t.stepLength);
        buildTunnel(t, lay, tw);
        t.lx += lay * t.fdx;
        t.ly += lay * t.fdy;
        tryAnteroom(t, t.fdx, t.fdy);
        tunnelers.splice(i, 1);
        continue;
      }

      // Normal step: BuildTunnel(stepLength).
      const lay = Math.min(t.stepLength, frontFree);
      buildTunnel(t, lay, tw);
      t.lx += lay * t.fdx;
      t.ly += lay * t.fdy;

      // Sideways rooms — independent rolls.
      const rdx = t.fdy;
      const rdy = -t.fdx;
      if (rng() < mRRP) {
        tryAnteroom(t, rdx, rdy);
      }
      if (rng() < mRLP) {
        tryAnteroom(t, -rdx, -rdy);
      }

      // Turn?
      if (rng() < turnChance) {
        const oldFdx = t.fdx;
        const oldFdy = t.fdy;
        const turnRight = rng() < 0.5;
        if (turnRight) {
          t.fdx = rdx;
          t.fdy = rdy;
        } else {
          t.fdx = -rdx;
          t.fdy = -rdy;
        }
        // Wider corridors leave a perpendicular footprint that the
        // new direction's lookahead immediately trips over (a
        // tunnelWidth=1 east corridor has cells at ly±1 across its
        // path, and turning north puts those cells right at
        // dist=1). Carve a (2*tw+1)² junction at the turn point
        // and teleport the tunneler past it so the next lookahead
        // sees fresh wall ahead.
        if (t.tunnelWidth > 0) {
          for (let dy = -t.tunnelWidth; dy <= t.tunnelWidth; dy++) {
            for (let dx = -t.tunnelWidth; dx <= t.tunnelWidth; dx++) {
              setCell(t.lx + dx, t.ly + dy, TUN_FLOOR);
            }
          }
          t.lx += t.tunnelWidth * t.fdx;
          t.ly += t.tunnelWidth * t.fdy;
        }
        spawnBabiesOnTurn(t, oldFdx, oldFdy);
        // Anteroom at the turn point.
        if (rng() < mRRP + mRLP) {
          tryAnteroom(t, t.fdx, t.fdy);
        }
      }
    }
  }

  // Terminating builder: try one last join or anteroom for the
  // tunneler that aged out.
  function crawlerTerminate(t: Tunneler): void {
    const tw = t.tunnelWidth;
    const frontFree = frontFreeAt(t.lx, t.ly, t.fdx, t.fdy, tw);
    if (frontFree > 0 && tryJoin(t, frontFree)) return;
    tryAnteroom(t, t.fdx, t.fdy);
  }

  // Collapse TUN_ROOM_FLOOR → TUN_FLOOR for the final tile grid.
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === TUN_ROOM_FLOOR) tiles[i] = TUN_FLOOR;
  }

  // ---------- Degenerate fallback ----------
  if (roomsTiles.length === 0) {
    const r: Rect = { x: -2, y: -2, w: 5, h: 5 };
    roomsTiles.push(r);
    for (let yy = 0; yy < r.h; yy++) {
      for (let xx = 0; xx < r.w; xx++) {
        setCell(r.x + xx - originTileX, r.y + yy - originTileY, TUN_FLOOR);
      }
    }
  }

  // Reorder rooms so room 0 is the entrance (closest to origin).
  let entranceIdx = 0;
  let entranceDistSq = Infinity;
  for (let i = 0; i < roomsTiles.length; i++) {
    const r = roomsTiles[i];
    const cxT = r.x + r.w / 2;
    const cyT = r.y + r.h / 2;
    const dsq = cxT * cxT + cyT * cyT;
    if (dsq < entranceDistSq) {
      entranceDistSq = dsq;
      entranceIdx = i;
    }
  }
  if (entranceIdx !== 0) {
    [roomsTiles[0], roomsTiles[entranceIdx]] = [
      roomsTiles[entranceIdx],
      roomsTiles[0],
    ];
  }

  const rooms = roomsTiles.map(tilesToPixels);
  const entrance = rooms[0];
  const spawn = center(entrance);

  const worldBounds: Rect = {
    x: originTileX * TILE_SIZE,
    y: originTileY * TILE_SIZE,
    w: gridW * TILE_SIZE,
    h: gridH * TILE_SIZE,
  };
  const tileGridShape: TileGridShape = {
    width: gridW,
    height: gridH,
    originTileX,
    originTileY,
    tileSize: TILE_SIZE,
  };

  // Walkables: single bounds rect. Renderer paints floor across
  // the whole world and tile-grid walls draw on top — so wall
  // placement is purely tile-grid driven.
  const walkables: Rect[] = [worldBounds];

  let stairsRoomIndex = -1;
  if (rooms.length > 1) {
    let furthestDistSq = 0;
    for (let i = 1; i < rooms.length; i++) {
      const c = center(rooms[i]);
      const dxs = c.x - spawn.x;
      const dys = c.y - spawn.y;
      const dsq = dxs * dxs + dys * dys;
      if (dsq > furthestDistSq) {
        stairsRoomIndex = i;
        furthestDistSq = dsq;
      }
    }
  }

  const interactables: Interactable[] = [];
  if (rooms.length > 0) {
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
  if (stairsRoomIndex >= 0) {
    const c = center(rooms[stairsRoomIndex]);
    interactables.push({
      id: 'stairs_down',
      kind: 'stairs_down',
      x: c.x,
      y: c.y,
      label: `Descend to floor ${floorIndex + 1}`,
    });
  }

  const safeChance = gen?.safeRoomChance ?? 0;
  const extremeChance = gen?.extremeRoomChance ?? 0;
  const roomCategories: HazardZoneCategory[] = rooms.map((_, idx) => {
    if (idx === 0) return 'safe';
    if (idx === stairsRoomIndex) return 'hazard';
    const r = rng();
    if (r < safeChance) return 'safe';
    if (r < safeChance + extremeChance) return 'extreme';
    return 'hazard';
  });

  const roomGraph: number[][] = rooms.map((_, i) =>
    rooms.map((_, j) => j).filter((j) => j !== i),
  );

  const templateRng = mulberry32(
    ((worldSeed * 0xb5297a4d) ^
      (cycle * 0x68e31da4) ^
      (floorIndex * 0x9e3779b1)) >>>
      0,
  );
  const templateAssignments = pickAndResizeRooms(
    rooms,
    roomCategories,
    stairsRoomIndex,
    biome,
    templateRng,
    gen?.roomTemplateChance ?? 1,
  );
  const anchors = stampRoomTemplates(
    tileGridShape,
    tiles,
    rooms,
    templateAssignments,
    [],
  );
  const finalSpawn =
    resolveAnchorOverride(anchors, rooms[0], 'spawn') ?? spawn;
  const finalInteractables = applyAnchorOverridesToInteractables(
    interactables,
    anchors,
    rooms[0],
    stairsRoomIndex >= 0 ? rooms[stairsRoomIndex] : null,
  );
  const safeSpawn = snapToWalkable(
    tileGridShape,
    tiles,
    finalSpawn.x,
    finalSpawn.y,
  );

  const tileGrid: TileGrid = {
    ...tileGridShape,
    tilesB64: Buffer.from(tiles).toString('base64'),
  };
  const variantSeed = makeVariantSeed(worldSeed, cycle, floorIndex);

  return {
    worldBounds,
    walkables,
    rooms,
    spawn: safeSpawn,
    interactables: finalInteractables,
    tileSize: TILE_SIZE,
    biome,
    roomCategories,
    tileGrid,
    variantSeed,
    anchors,
    roomGraph,
  };
}


// Drunkard's-walk generator. Carves a single contiguous floor
// region from a random walk starting at the origin, then emits a
// SceneLayout shaped like the tunneling output but with one
// "room" rect (the carve's pixel bounding box) and no corridors.
// Room-template stamping and locked rooms are skipped — both
// assume rect rooms separated by clear corridors, which doesn't
// fit an organic blob. Loot / enemies / props all run from
// SceneLayout in the existing pipeline; with one room flagged
// 'safe', density becomes uniform across the carve.
//
// Wired today for Alien Core (set in alien_core.json's
// generation.generator). Other biomes can opt in by setting
// the same field.
const WALKER_TARGET_CELLS_DEFAULT = 600;
const WALKER_CHAMBER_COUNT_DEFAULT = 2;
const WALKER_CHAMBER_RADIUS_DEFAULT = 2;
const WALKER_MOMENTUM_DEFAULT = 0;

function generateFloorLayoutWalker(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
  biome: string,
): SceneLayout {
  // Distinct mixing constants from tunneling so a biome flipping
  // generators between cycles re-rolls the layout instead of
  // reusing the tunneling seed's tendencies.
  const mixed =
    (worldSeed * 0x27d4eb2d) ^
    (cycle * 0x165667b1) ^
    (floorIndex * 0xd1b54a32);
  const rng = mulberry32(mixed);

  // Walker tuning. Each is optional in the schema; falls through
  // to the same defaults the legacy hardcoded constants used.
  const gen = BIOMES[biome]?.generation;
  const targetCells = gen?.walkerCellTarget ?? WALKER_TARGET_CELLS_DEFAULT;
  const chamberCount = Math.max(
    1,
    gen?.walkerChamberCount ?? WALKER_CHAMBER_COUNT_DEFAULT,
  );
  const chamberRadius = Math.max(
    1,
    gen?.walkerChamberRadius ?? WALKER_CHAMBER_RADIUS_DEFAULT,
  );
  const momentum = gen?.walkerMomentum ?? WALKER_MOMENTUM_DEFAULT;
  const maxSteps = targetCells * 8;

  // Carve cells in tile space. Origin is always carved (the
  // walker's starting cell) so spawn placement is guaranteed.
  const carved = new Set<number>();
  const keyOf = (tx: number, ty: number): number =>
    (ty + 1024) * 4096 + (tx + 1024);
  carved.add(keyOf(0, 0));
  let minTx = 0;
  let maxTx = 0;
  let minTy = 0;
  let maxTy = 0;

  let cx = 0;
  let cy = 0;
  let lastDir = -1;
  for (
    let step = 0;
    step < maxSteps && carved.size < targetCells;
    step++
  ) {
    // Momentum: with probability `momentum`, repeat the last
    // direction (longer corridor-like passes); otherwise roll a
    // fresh random direction. First step always rolls fresh.
    let dir: number;
    if (lastDir >= 0 && rng() < momentum) {
      dir = lastDir;
    } else {
      dir = Math.floor(rng() * 4);
    }
    lastDir = dir;
    if (dir === 0) cx++;
    else if (dir === 1) cx--;
    else if (dir === 2) cy++;
    else cy--;
    // Clamp inside the floor footprint. When the walker bumps the
    // edge, snap it back to the nearest carved cell so the carve
    // stays connected and doesn't get pinned at the boundary.
    if (
      cx < -FLOOR_HALF_TILES ||
      cx > FLOOR_HALF_TILES ||
      cy < -FLOOR_HALF_TILES ||
      cy > FLOOR_HALF_TILES
    ) {
      cx = 0;
      cy = 0;
      lastDir = -1;
      continue;
    }
    carved.add(keyOf(cx, cy));
    if (cx < minTx) minTx = cx;
    if (cx > maxTx) maxTx = cx;
    if (cy < minTy) minTy = cy;
    if (cy > maxTy) maxTy = cy;
  }

  // Pixel bounding box of the carve, with a 2-tile margin so the
  // wall ring around the carve has somewhere to land.
  const margin = 2;
  const worldBounds: Rect = {
    x: (minTx - margin) * TILE_SIZE,
    y: (minTy - margin) * TILE_SIZE,
    w: (maxTx - minTx + 1 + margin * 2) * TILE_SIZE,
    h: (maxTy - minTy + 1 + margin * 2) * TILE_SIZE,
  };

  // Build the tile grid directly from the carved set instead of
  // running the rect rasterizer. Floor where carved; wall on void
  // cells with at least one carved 8-neighbour; void elsewhere.
  const originTileX = Math.floor(worldBounds.x / TILE_SIZE);
  const originTileY = Math.floor(worldBounds.y / TILE_SIZE);
  const width =
    Math.ceil((worldBounds.x + worldBounds.w) / TILE_SIZE) - originTileX;
  const height =
    Math.ceil((worldBounds.y + worldBounds.h) / TILE_SIZE) - originTileY;
  const tiles = new Uint8Array(width * height);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const wx = originTileX + tx;
      const wy = originTileY + ty;
      if (carved.has(keyOf(wx, wy))) {
        tiles[ty * width + tx] = DEFAULT_FLOOR_TILE_ID;
      }
    }
  }
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      if (tiles[ty * width + tx] !== VOID_TILE_ID) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1 && !touches; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (tiles[ny * width + nx] === DEFAULT_FLOOR_TILE_ID) touches = true;
        }
      }
      if (touches) tiles[ty * width + tx] = DEFAULT_WALL_TILE_ID;
    }
  }

  const tileGridShape: TileGridShape = {
    width,
    height,
    originTileX,
    originTileY,
    tileSize: TILE_SIZE,
  };

  // Spawn at the origin (always carved by construction).
  const spawn = { x: 0.5 * TILE_SIZE, y: 0.5 * TILE_SIZE };

  // Stairs at the carved cell furthest from origin. Picking by
  // Euclidean distance produces a satisfying "all the way across
  // the cave" placement on most rolls.
  let stairsTx = 0;
  let stairsTy = 0;
  let stairsDistSq = 0;
  for (const k of carved) {
    const ty = Math.floor(k / 4096) - 1024;
    const tx = (k % 4096) - 1024;
    const dsq = tx * tx + ty * ty;
    if (dsq > stairsDistSq) {
      stairsDistSq = dsq;
      stairsTx = tx;
      stairsTy = ty;
    }
  }
  const stairsPos = {
    x: (stairsTx + 0.5) * TILE_SIZE,
    y: (stairsTy + 0.5) * TILE_SIZE,
  };

  // Run-length encode the carved set into horizontal floor strips.
  // The client renderer paints one floor mesh per walkable rect;
  // emitting the bounding box would paint floor under non-carved
  // void cells too, producing visible disconnected "floor" between
  // pockets of the carve. Per-row strips keep the painted floor
  // tight to the actual walkable area (~60-100 strips for a 600-
  // cell carve).
  const walkables: Rect[] = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    let runStart = -1;
    for (let tx = minTx; tx <= maxTx + 1; tx++) {
      const inCarve = tx <= maxTx && carved.has(keyOf(tx, ty));
      if (inCarve && runStart < 0) {
        runStart = tx;
      } else if (!inCarve && runStart >= 0) {
        walkables.push({
          x: runStart * TILE_SIZE,
          y: ty * TILE_SIZE,
          w: (tx - runStart) * TILE_SIZE,
          h: TILE_SIZE,
        });
        runStart = -1;
      }
    }
  }

  // Chambers — small rect "rooms" placed on carved cells. Chamber
  // 0 is always at the origin (entrance, hazard='safe'); chamber
  // 1 is at the furthest carved cell (stairs, 'hazard'); any
  // additional chambers are picked from carved cells far from
  // both, giving the prop / enemy density passes more scatter
  // pockets without bunching them up.
  function chamberRectFor(cellTx: number, cellTy: number): Rect {
    return {
      x: (cellTx - chamberRadius) * TILE_SIZE,
      y: (cellTy - chamberRadius) * TILE_SIZE,
      w: (chamberRadius * 2 + 1) * TILE_SIZE,
      h: (chamberRadius * 2 + 1) * TILE_SIZE,
    };
  }
  const chamberCells: Array<{ tx: number; ty: number }> = [
    { tx: 0, ty: 0 },
    { tx: stairsTx, ty: stairsTy },
  ];
  if (chamberCount > 2) {
    // Pick remaining chamber centres greedily by max-min distance
    // from already-picked centres. Sample a fixed cap of carved
    // cells to cap cost; 256 samples is plenty for visual variety.
    const carvedArr: Array<{ tx: number; ty: number }> = [];
    for (const k of carved) {
      const ty = Math.floor(k / 4096) - 1024;
      const tx = (k % 4096) - 1024;
      carvedArr.push({ tx, ty });
    }
    const sampleCap = Math.min(carvedArr.length, 256);
    const stride = Math.max(1, Math.floor(carvedArr.length / sampleCap));
    while (chamberCells.length < chamberCount) {
      let bestCell = chamberCells[0];
      let bestMinDist = -1;
      for (let i = 0; i < carvedArr.length; i += stride) {
        const c = carvedArr[i];
        let minD = Infinity;
        for (const picked of chamberCells) {
          const dx = c.tx - picked.tx;
          const dy = c.ty - picked.ty;
          const d = dx * dx + dy * dy;
          if (d < minD) minD = d;
        }
        if (minD > bestMinDist) {
          bestMinDist = minD;
          bestCell = c;
        }
      }
      chamberCells.push(bestCell);
    }
  }
  const rooms: Rect[] = chamberCells.map((c) => chamberRectFor(c.tx, c.ty));

  const interactables: Interactable[] = [
    {
      id: 'extract_pad',
      kind: 'extract_pad',
      x: spawn.x + TILE_SIZE * 1.5,
      y: spawn.y,
      label: 'Extract to base',
    },
    {
      id: 'stairs_down',
      kind: 'stairs_down',
      x: stairsPos.x,
      y: stairsPos.y,
      label: `Descend to floor ${floorIndex + 1}`,
    },
  ];

  const safeSpawn = snapToWalkable(tileGridShape, tiles, spawn.x, spawn.y);
  const safePadPos = snapToWalkable(
    tileGridShape,
    tiles,
    interactables[0].x,
    interactables[0].y,
  );
  interactables[0].x = safePadPos.x;
  interactables[0].y = safePadPos.y;

  const tileGrid: TileGrid = {
    ...tileGridShape,
    tilesB64: Buffer.from(tiles).toString('base64'),
  };
  const variantSeed = makeVariantSeed(worldSeed, cycle, floorIndex);

  return {
    worldBounds,
    walkables,
    rooms,
    spawn: safeSpawn,
    interactables,
    tileSize: TILE_SIZE,
    biome,
    roomCategories: rooms.map((_, i) => (i === 0 ? 'safe' : 'hazard')),
    tileGrid,
    variantSeed,
    anchors: [],
    // Fully-connected graph: every chamber reaches every other
    // through the carved blob. Locked-room placement reads this
    // for reachability — without "every other room" edges the
    // BFS would believe chambers are isolated.
    roomGraph: rooms.map((_, i) =>
      rooms.map((_, j) => j).filter((j) => j !== i),
    ),
  };
}

// Cheap point-in-any-rect for the corridor reassertion pass.
// rooms[] is short (≤10) so the linear scan is fine.
function cellInsideAnyRoom(rooms: Rect[], wx: number, wy: number): boolean {
  for (const r of rooms) {
    if (wx >= r.x && wx < r.x + r.w && wy >= r.y && wy < r.y + r.h) {
      return true;
    }
  }
  return false;
}

// Find an anchor of `kind` whose position falls inside `room`, if
// any. Returns the world-space anchor point, or null.
function resolveAnchorOverride(
  anchors: SceneAnchor[],
  room: Rect,
  kind: SceneAnchor['kind'],
): { x: number; y: number } | null {
  for (const a of anchors) {
    if (a.kind !== kind) continue;
    if (
      a.x >= room.x &&
      a.x < room.x + room.w &&
      a.y >= room.y &&
      a.y < room.y + room.h
    ) {
      return { x: a.x, y: a.y };
    }
  }
  return null;
}

// Apply 'stairs_down' / 'extract' anchor overrides to the procgen-
// placed interactable list. Each override moves the matching
// interactable to the anchor's world coords; absence keeps the
// procgen position. The stairs anchor is searched in the stairs
// room (deepest); the extract anchor in the entrance room.
function applyAnchorOverridesToInteractables(
  interactables: Interactable[],
  anchors: SceneAnchor[],
  entranceRoom: Rect,
  stairsRoom: Rect | null,
): Interactable[] {
  const stairs = stairsRoom
    ? resolveAnchorOverride(anchors, stairsRoom, 'stairs_down')
    : null;
  const extract = resolveAnchorOverride(anchors, entranceRoom, 'extract');
  if (!stairs && !extract) return interactables;
  return interactables.map((it) => {
    if (it.kind === 'stairs_down' && stairs) {
      return { ...it, x: stairs.x, y: stairs.y };
    }
    if (it.kind === 'extract_pad' && extract) {
      return { ...it, x: extract.x, y: extract.y };
    }
    return it;
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

// First of two passes. For each rect-placed room, attempt to pick
// a fitting template; on a match, shrink the room rect to the
// template's exact tile dimensions, centered on the original slot
// centre. Returns the per-room template assignments for the second
// pass to consume — picking is RNG-bound, stamping isn't, so we
// split them so the resize can run before the tile grid is built.
function pickAndResizeRooms(
  rooms: Rect[],
  roomCategories: HazardZoneCategory[],
  stairsRoomIndex: number,
  biome: string,
  rng: () => number,
  templateChance: number,
): Array<RoomTemplate | null> {
  const out: Array<RoomTemplate | null> = new Array(rooms.length).fill(null);
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const role = roleForRoom(i, stairsRoomIndex, roomCategories[i] ?? 'hazard');
    // Per-room roll: skip the template lookup entirely and leave
    // the room as a procedural rect sized by the placement
    // sampler. Roll happens BEFORE the candidate list is built so
    // every room consumes the same rng pattern regardless of how
    // many templates are authored — adding a template to a biome
    // doesn't reshuffle existing floors.
    if (rng() >= templateChance) continue;
    const slotW = Math.floor(room.w / TILE_SIZE);
    const slotH = Math.floor(room.h / TILE_SIZE);
    // Phase 3 doesn't enforce per-side connectivity yet — once
    // entry anchors land in templates we can pass requiredEntries
    // computed from corridor connection points.
    const candidates = eligibleTemplates(biome, role, slotW, slotH, []);
    const tpl = pickTemplate(candidates, rng);
    if (!tpl) continue;
    // Shrink the room rect to the template's exact size, centered
    // on the slot centre. World floor + corridor centres stay put;
    // only the room boundary moves inward.
    const cx = room.x + room.w / 2;
    const cy = room.y + room.h / 2;
    const newW = tpl.width * TILE_SIZE;
    const newH = tpl.height * TILE_SIZE;
    rooms[i] = {
      x: cx - newW / 2,
      y: cy - newH / 2,
      w: newW,
      h: newH,
    };
    out[i] = tpl;
  }
  return out;
}

// Second of two passes. Stamps each picked template into the tile
// grid at its room's (now resized) position and translates every
// template anchor from template-local tile coords into world
// coords. After stamping, re-asserts corridor cells as floor so a
// template's perimeter wall can't seal off a corridor entry.
function stampRoomTemplates(
  grid: TileGridShape,
  tiles: Uint8Array,
  rooms: Rect[],
  assignments: Array<RoomTemplate | null>,
  corridors: Rect[],
): SceneAnchor[] {
  const anchors: SceneAnchor[] = [];
  let stamped = 0;
  let skipped = 0;
  for (let i = 0; i < rooms.length; i++) {
    const tpl = assignments[i];
    if (!tpl) {
      skipped++;
      continue;
    }
    stamped++;
    const room = rooms[i];
    // Room rect was resized to template size in pickAndResizeRooms,
    // so the template's origin is the room origin in world tiles.
    const tplTileOriginX = Math.floor(room.x / TILE_SIZE);
    const tplTileOriginY = Math.floor(room.y / TILE_SIZE);
    const gridOriginX = tplTileOriginX - grid.originTileX;
    const gridOriginY = tplTileOriginY - grid.originTileY;
    stampTemplate(
      { ...grid, tilesB64: '' },
      tiles,
      tpl,
      gridOriginX,
      gridOriginY,
    );
    for (const a of tpl.anchors) {
      anchors.push({
        kind: a.kind,
        x: (tplTileOriginX + a.tx + 0.5) * TILE_SIZE,
        y: (tplTileOriginY + a.ty + 0.5) * TILE_SIZE,
        overrideId: a.overrideId,
      });
    }
    templateTiles(tpl);
  }
  // Corridor reassertion: corridors connect room *centres*, so
  // their strips pass through every connected room's interior.
  // Re-flooring those cells would nuke template walls along the
  // corridor's path. Restrict the reassertion to corridor cells
  // that fall OUTSIDE every room rect — connectors between rooms
  // stay open; template content inside rooms wins.
  for (const c of corridors) {
    const tx0 = Math.floor(c.x / TILE_SIZE) - grid.originTileX;
    const ty0 = Math.floor(c.y / TILE_SIZE) - grid.originTileY;
    const tx1 = Math.ceil((c.x + c.w) / TILE_SIZE) - grid.originTileX;
    const ty1 = Math.ceil((c.y + c.h) / TILE_SIZE) - grid.originTileY;
    for (let ty = ty0; ty < ty1; ty++) {
      if (ty < 0 || ty >= grid.height) continue;
      for (let tx = tx0; tx < tx1; tx++) {
        if (tx < 0 || tx >= grid.width) continue;
        const wx = (tx + grid.originTileX + 0.5) * TILE_SIZE;
        const wy = (ty + grid.originTileY + 0.5) * TILE_SIZE;
        if (cellInsideAnyRoom(rooms, wx, wy)) continue;
        tiles[ty * grid.width + tx] = DEFAULT_FLOOR_TILE_ID;
      }
    }
  }
  console.log(
    `[procgen] rooms=${rooms.length} templates_stamped=${stamped} no_match=${skipped} anchors=${anchors.length}`,
  );
  return anchors;
}

// Map a room's procgen position to a template role:
//   - entrance (index 0)        → 'safe'
//   - stairs-down room           → 'normal'
//   - 'extreme' hazard category  → 'extreme'
//   - 'safe' hazard category     → 'safe'
//   - everything else            → 'normal'
function roleForRoom(
  index: number,
  stairsRoomIndex: number,
  category: HazardZoneCategory,
): RoomRole {
  if (index === 0) return 'safe';
  if (index === stairsRoomIndex) return 'normal';
  if (category === 'extreme') return 'extreme';
  if (category === 'safe') return 'safe';
  return 'normal';
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
  const graph = layout.roomGraph;
  for (let i = 1; i < layout.rooms.length; i++) {
    if (i === stairsRoomIndex) continue;
    if (rng() > lockChance) continue;
    if (graph) {
      // Skip if locking room i disconnects entrance (room 0)
      // from the stairs room.
      if (
        stairsRoomIndex >= 0 &&
        !reachableInGraph(graph, 0, stairsRoomIndex, i)
      ) {
        continue;
      }
    } else {
      // Legacy chain heuristic.
      if (stairsRoomIndex >= 0 && i <= stairsRoomIndex) continue;
    }
    const room = layout.rooms[i];
    const tiles = pickDoorTilesForRoom(room, corridorRects, tileSize);
    if (tiles.length === 0) continue;
    lockedSet.add(i);
    doors.push(...tiles);
  }

  return { lockedRoomIndices: [...lockedSet], doors };
}

// BFS from `from` to `to` in `graph`, treating `excluded` as
// removed. Returns true if `to` is reachable. Used by lock
// placement to verify a candidate doesn't sever the entrance →
// stairs path.
function reachableInGraph(
  graph: number[][],
  from: number,
  to: number,
  excluded: number,
): boolean {
  if (from === excluded || to === excluded) return false;
  if (from === to) return true;
  const visited = new Set<number>([from, excluded]);
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

