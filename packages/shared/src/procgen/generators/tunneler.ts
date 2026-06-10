// Tunneler generator. Drunkard's-walk agents carve corridor
// segments + periodically widen into rooms. Each agent step
// proposes a new region (corridor strip or room rect); the
// proposal is rejected if it overlaps an existing region beyond
// a shared edge. Output is a `RegionSet` of disjoint rects ready
// for the assembler's linedef round-trip.
//
// Lighter than the deleted polygon tunneler: this version doesn't
// vary corridor width, doesn't spawn child agents, and doesn't
// run a Join pass. Those land back as needed once we have a
// parity target.

import type { Region, RegionSet } from '../regions';

const DEFAULT: TunnelerConfig = {
  bounds: { tileX: -40, tileY: -40, tileW: 80, tileH: 80 },
  spawnRoomTiles: 5,
  corridorWidth: 2,
  corridorLength: 4,
  roomMinTiles: 4,
  roomMaxTiles: 8,
  turnChance: 0.18,
  roomChancePerStep: 0.30,
  agentCount: 4,
  targetRooms: 12,
  maxSteps: 400,
};

export type TunnelerConfig = {
  bounds: { tileX: number; tileY: number; tileW: number; tileH: number };
  spawnRoomTiles: number;
  corridorWidth: number;
  corridorLength: number;
  roomMinTiles: number;
  roomMaxTiles: number;
  turnChance: number;
  roomChancePerStep: number;
  agentCount: number;
  targetRooms: number;
  maxSteps: number;
};

type Agent = { x: number; y: number; dx: number; dy: number };

const DIRS: Array<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: -1 },
];

export function generateTunnelerRegions(
  rng: () => number,
  cfg?: Partial<TunnelerConfig>,
): RegionSet {
  const c: TunnelerConfig = { ...DEFAULT, ...cfg };
  const rects: Region[] = [];

  const spawn: Region = {
    tileX: -Math.floor(c.spawnRoomTiles / 2),
    tileY: -Math.floor(c.spawnRoomTiles / 2),
    tileW: c.spawnRoomTiles,
    tileH: c.spawnRoomTiles,
    category: 'safe',
  };
  rects.push(spawn);

  // Seed agents at the spawn room's outer edges, facing outward.
  // One agent per direction (round-robin) so up to 4 agents fan
  // out cleanly instead of stacking on the same edge.
  const agents: Agent[] = [];
  const halfSpawn = Math.floor(c.spawnRoomTiles / 2);
  for (let i = 0; i < c.agentCount; i++) {
    const dir = DIRS[i % DIRS.length];
    agents.push({
      x: dir.dx * halfSpawn,
      y: dir.dy * halfSpawn,
      dx: dir.dx,
      dy: dir.dy,
    });
  }

  let roomCount = 1;
  let steps = 0;
  while (steps < c.maxSteps && roomCount < c.targetRooms && agents.length > 0) {
    steps++;
    for (let i = agents.length - 1; i >= 0; i--) {
      const a = agents[i];
      if (rng() < c.turnChance) {
        // Rotate ±90°.
        const left = rng() < 0.5;
        const ndx = left ? -a.dy : a.dy;
        const ndy = left ? a.dx : -a.dx;
        a.dx = ndx;
        a.dy = ndy;
      }

      // Try the agent's current direction first, then up to 3
      // rotations before giving up this tick.
      let placed = false;
      for (let tries = 0; tries < 4; tries++) {
        const corridor = makeCorridor(a, c);
        if (corridor && fits(corridor, c.bounds) && !overlapsAny(corridor, rects)) {
          rects.push(corridor);
          a.x += a.dx * c.corridorLength;
          a.y += a.dy * c.corridorLength;
          placed = true;
          break;
        }
        // Rotate clockwise and try again.
        const ndx = -a.dy;
        const ndy = a.dx;
        a.dx = ndx;
        a.dy = ndy;
      }
      if (!placed) {
        agents.splice(i, 1);
        continue;
      }

      if (rng() < c.roomChancePerStep) {
        const room = makeRoom(a, c, rng);
        if (fits(room, c.bounds) && !overlapsAny(room, rects)) {
          rects.push(room);
          roomCount++;
        }
      }
    }
  }

  // Last-added room (or last region) is the stairs target.
  const stairsRegionIndex = rects.length > 1 ? rects.length - 1 : null;
  return { regions: rects, spawnRegionIndex: 0, stairsRegionIndex };
}

function makeCorridor(a: Agent, c: TunnelerConfig): Region | null {
  if (a.dx !== 0 && a.dy !== 0) return null;
  const w = c.corridorWidth;
  const len = c.corridorLength;
  // Corridor strip starting just past the agent's current tile.
  if (a.dx === 1) {
    return {
      tileX: a.x + 1,
      tileY: a.y - Math.floor(w / 2),
      tileW: len,
      tileH: w,
      category: 'hazard',
      kind: 'corridor',
    };
  }
  if (a.dx === -1) {
    return {
      tileX: a.x - len,
      tileY: a.y - Math.floor(w / 2),
      tileW: len,
      tileH: w,
      category: 'hazard',
      kind: 'corridor',
    };
  }
  if (a.dy === 1) {
    return {
      tileX: a.x - Math.floor(w / 2),
      tileY: a.y + 1,
      tileW: w,
      tileH: len,
      category: 'hazard',
      kind: 'corridor',
    };
  }
  if (a.dy === -1) {
    return {
      tileX: a.x - Math.floor(w / 2),
      tileY: a.y - len,
      tileW: w,
      tileH: len,
      category: 'hazard',
      kind: 'corridor',
    };
  }
  return null;
}

function makeRoom(a: Agent, c: TunnelerConfig, rng: () => number): Region {
  const w =
    c.roomMinTiles +
    Math.floor(rng() * (c.roomMaxTiles - c.roomMinTiles + 1));
  const h =
    c.roomMinTiles +
    Math.floor(rng() * (c.roomMaxTiles - c.roomMinTiles + 1));
  // Drop the room centred on the agent's current cell.
  return {
    tileX: a.x - Math.floor(w / 2),
    tileY: a.y - Math.floor(h / 2),
    tileW: w,
    tileH: h,
    category: 'hazard',
  };
}

function fits(r: Region, bounds: TunnelerConfig['bounds']): boolean {
  return (
    r.tileX >= bounds.tileX &&
    r.tileY >= bounds.tileY &&
    r.tileX + r.tileW <= bounds.tileX + bounds.tileW &&
    r.tileY + r.tileH <= bounds.tileY + bounds.tileH
  );
}

function overlapsAny(r: Region, existing: ReadonlyArray<Region>): boolean {
  for (const e of existing) {
    if (overlap(r, e)) return true;
  }
  return false;
}

// Strict overlap — touching edges (shared boundary) is allowed
// because that's how the linedef round-trip emits passable
// portals between adjacent rects.
function overlap(a: Region, b: Region): boolean {
  return (
    a.tileX < b.tileX + b.tileW &&
    b.tileX < a.tileX + a.tileW &&
    a.tileY < b.tileY + b.tileH &&
    b.tileY < a.tileY + a.tileH
  );
}
