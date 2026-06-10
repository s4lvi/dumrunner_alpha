// BSP post-process: shrink each leaf into a smaller room within
// its partition, then carve corridor rects through the void
// between adjacent rooms. Converts BSP's "packed rectangles
// touching at every edge" output into a classic Roguelike
// rooms-connected-by-hallways layout.
//
// Pure — input is the BSP RegionSet, output mutates it in place
// (rooms shrunk, corridors appended). The original BSP leaf
// bounds drive adjacency detection (we want to corridorize the
// pairs that USED to share an edge, not the post-shrink shapes).

import type { Vec2 } from '../geometry';
import type { Region, RegionSet } from './regions';

// World units per tile. The corridor polygon code builds its
// verts in world coords directly so the chamfer + assembly
// passes see consistent units. Procgen always uses 32 today;
// kept as a constant for clarity since it's structural.
const TILE_SIZE_WU = 32;

export type InsetCorridorConfig = {
  // Per-side tile padding subtracted from each BSP leaf to form
  // its inset room. Range is [min, max]; per-room picked uniformly
  // so different rooms feel different sizes within the same map.
  insetMin: number;
  insetMax: number;
  // Smallest dimension a room is allowed to shrink to. Leaves
  // smaller than ~2× this skip insetting (they'd vanish).
  minRoomTiles: number;
  // Corridor width range in tiles. Each adjacency picks one
  // independently — narrow chokepoints + wide halls feel different
  // from each other instead of every corridor reading the same.
  corridorWidthMin: number;
  corridorWidthMax: number;
  // Chance to add a corridor for an adjacency that's NOT required
  // for connectivity. Spanning-tree corridors always go in.
  // Extras add loops but visually stack as multiple doors on one
  // wall when several cousin pairs share a side — kept at 0 by
  // default so each room has exactly the spanning-tree set of
  // connections.
  extraCorridorChance: number;
  // Once spanning-tree connectivity is established, enforce a cap
  // on how many corridors any single room is allowed to host. The
  // cap is reached by iterating already-placed corridors and
  // dropping any that would push a room past the limit. Default 3
  // keeps the perimeter readable even in the densest BSP layouts.
  maxCorridorsPerRoom: number;
};

const DEFAULT_CONFIG: InsetCorridorConfig = {
  insetMin: 2,
  insetMax: 4,
  minRoomTiles: 4,
  corridorWidthMin: 2,
  corridorWidthMax: 4,
  extraCorridorChance: 0,
  maxCorridorsPerRoom: 3,
};

type LeafBounds = {
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
};

export function insetAndCorridorize(
  regionSet: RegionSet,
  rng: () => number,
  cfg: Partial<InsetCorridorConfig> = {},
): void {
  const config: InsetCorridorConfig = { ...DEFAULT_CONFIG, ...cfg };
  const originalLeafs: LeafBounds[] = regionSet.regions.map((r) => ({
    tileX: r.tileX,
    tileY: r.tileY,
    tileW: r.tileW,
    tileH: r.tileH,
  }));

  // Shrink each leaf into an inset room. Centre the inset (could
  // jitter but centring keeps rooms feeling deliberate; jitter
  // tends to read as "off centre" rather than "natural").
  for (let i = 0; i < regionSet.regions.length; i++) {
    const r = regionSet.regions[i];
    r.kind = r.kind ?? 'room';
    if (r.kind === 'corridor') continue;
    const padX = pickInset(r.tileW, config, rng);
    const padY = pickInset(r.tileH, config, rng);
    r.tileX += padX;
    r.tileY += padY;
    r.tileW -= padX * 2;
    r.tileH -= padY * 2;
  }

  // Now generate corridors. Two passes:
  //   1) Spanning tree: for every adjacency, if it would join
  //      previously disconnected room components, carve it.
  //      Guarantees a single connected dungeon with no extra
  //      density.
  //   2) Extras: for the remaining adjacencies, roll a low
  //      probability per pair. These add cycles so the dungeon
  //      isn't a single Hamiltonian path; they read as alternate
  //      routes the player can use to flank or escape.
  //
  // Earlier this ran a corridor PER adjacency, which made dense
  // BSP layouts emit 3-4 corridors onto the same room wall —
  // the "wall of doors" effect: a single wall punctuated by
  // multiple closely-spaced openings instead of one clear
  // corridor entrance.
  const roomCount = originalLeafs.length;
  const adjacencies: Array<{ i: number; j: number }> = [];
  for (let i = 0; i < originalLeafs.length; i++) {
    for (let j = i + 1; j < originalLeafs.length; j++) {
      if (!leafEdgeAdjacent(originalLeafs[i], originalLeafs[j])) continue;
      const roomA = regionSet.regions[i];
      const roomB = regionSet.regions[j];
      if (roomA.kind === 'corridor' || roomB.kind === 'corridor') continue;
      adjacencies.push({ i, j });
    }
  }
  // Shuffle so spanning-tree selection isn't biased by adjacency
  // enumeration order. Same seed → same shuffle, deterministic.
  for (let i = adjacencies.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [adjacencies[i], adjacencies[j]] = [adjacencies[j], adjacencies[i]];
  }
  // Union-find for connectivity. Two rooms in the same set already
  // have a path; adding another corridor between them is an
  // "extra" cycle, not required for connectivity.
  const parent = new Array(roomCount).fill(0).map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): boolean {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[ra] = rb;
    return true;
  }
  for (const { i, j } of adjacencies) {
    const a = originalLeafs[i];
    const b = originalLeafs[j];
    const roomA = regionSet.regions[i];
    const roomB = regionSet.regions[j];
    const isSpanning = find(i) !== find(j);
    if (!isSpanning && rng() >= config.extraCorridorChance) continue;
    const before = regionSet.regions.length;
    const width = pickCorridorWidth(config, rng);
    carveBetween(a, b, roomA, roomB, width, rng, regionSet);
    if (regionSet.regions.length > before && isSpanning) {
      union(i, j);
    }
  }
}

function pickInset(
  dim: number,
  cfg: InsetCorridorConfig,
  rng: () => number,
): number {
  // Largest inset that keeps the room ≥ minRoomTiles wide on this
  // axis. Negative max means "too small to inset" — return 0.
  const maxAllowed = Math.floor((dim - cfg.minRoomTiles) / 2);
  if (maxAllowed <= 0) return 0;
  const lo = Math.min(cfg.insetMin, maxAllowed);
  const hi = Math.min(cfg.insetMax, maxAllowed);
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pickCorridorWidth(
  cfg: InsetCorridorConfig,
  rng: () => number,
): number {
  const lo = cfg.corridorWidthMin;
  const hi = cfg.corridorWidthMax;
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function leafEdgeAdjacent(a: LeafBounds, b: LeafBounds): boolean {
  const ax2 = a.tileX + a.tileW;
  const ay2 = a.tileY + a.tileH;
  const bx2 = b.tileX + b.tileW;
  const by2 = b.tileY + b.tileH;
  // Vertical shared edge.
  if (
    (ax2 === b.tileX || bx2 === a.tileX) &&
    Math.max(a.tileY, b.tileY) < Math.min(ay2, by2)
  ) {
    return true;
  }
  // Horizontal shared edge.
  if (
    (ay2 === b.tileY || by2 === a.tileY) &&
    Math.max(a.tileX, b.tileX) < Math.min(ax2, bx2)
  ) {
    return true;
  }
  return false;
}

// Carve a corridor (straight or L-shaped) between two inset
// rooms, given the original BSP-leaf bounds. The corridor lives
// in the void between the rooms; for siblings with overlapping
// projected ranges a single straight rect suffices, for cousins
// (asymmetric overlap) we emit one or two perpendicular rects to
// reach into each room from a shared elbow.
function carveBetween(
  leafA: LeafBounds,
  leafB: LeafBounds,
  roomA: Region,
  roomB: Region,
  width: number,
  rng: () => number,
  regionSet: RegionSet,
): void {
  const aRight = leafA.tileX + leafA.tileW;
  const bRight = leafB.tileX + leafB.tileW;
  const aBot = leafA.tileY + leafA.tileH;
  const bBot = leafB.tileY + leafB.tileH;
  // Vertical leaf partition: A's right meets B's left or vice versa.
  if (aRight === leafB.tileX || bRight === leafA.tileX) {
    const left = aRight === leafB.tileX ? roomA : roomB;
    const right = aRight === leafB.tileX ? roomB : roomA;
    carveHorizontalCorridor(left, right, width, rng, regionSet);
    return;
  }
  // Horizontal leaf partition: A's bottom meets B's top or vice versa.
  if (aBot === leafB.tileY || bBot === leafA.tileY) {
    const top = aBot === leafB.tileY ? roomA : roomB;
    const bottom = aBot === leafB.tileY ? roomB : roomA;
    carveVerticalCorridor(top, bottom, width, rng, regionSet);
    return;
  }
}

// Connect `left`'s east wall to `right`'s west wall. If their
// vertical (y) ranges overlap, emit a single horizontal corridor
// at a random y in the overlap. Otherwise emit an L: a horizontal
// stub from each room's wall + a vertical connector between them.
function carveHorizontalCorridor(
  left: Region,
  right: Region,
  width: number,
  rng: () => number,
  regionSet: RegionSet,
): void {
  const xStart = left.tileX + left.tileW;
  const xEnd = right.tileX;
  if (xEnd <= xStart) return;
  const leftY0 = left.tileY;
  const leftY1 = left.tileY + left.tileH;
  const rightY0 = right.tileY;
  const rightY1 = right.tileY + right.tileH;
  const overlapLo = Math.max(leftY0, rightY0);
  const overlapHi = Math.min(leftY1, rightY1);
  if (overlapHi - overlapLo >= width) {
    const y = pickStart(overlapLo, overlapHi - width, rng);
    const c = makeCorridor(xStart, y, xEnd - xStart, width);
    if (!corridorOverlapsExisting(c, regionSet.regions)) {
      regionSet.regions.push(c);
    }
    return;
  }
  // No straight path — emit a single L-shaped Region (one sector
  // with a 6-vertex polygon and a subRects union for the tile
  // raster). Earlier this was three disjoint rects; that worked
  // for connectivity but left dead-end walls at the inner corner
  // (the segments where one stub's wall ran past the joint with
  // no neighbour to share). One polygon means the inner corner is
  // a clean concave vertex and the perimeter has no orphans.
  if (leftY1 - leftY0 < width || rightY1 - rightY0 < width) return;
  if (xEnd - xStart < width * 2) return;
  const leftY = pickStart(leftY0, leftY1 - width, rng);
  const rightY = pickStart(rightY0, rightY1 - width, rng);
  const elbowX = pickStart(xStart, xEnd - width * 2, rng);
  const lc = makeLCorridorHorizontal(xStart, xEnd, leftY, rightY, elbowX, width);
  if (!corridorOverlapsExisting(lc, regionSet.regions)) {
    regionSet.regions.push(lc);
  }
}

function carveVerticalCorridor(
  top: Region,
  bottom: Region,
  width: number,
  rng: () => number,
  regionSet: RegionSet,
): void {
  const yStart = top.tileY + top.tileH;
  const yEnd = bottom.tileY;
  if (yEnd <= yStart) return;
  const topX0 = top.tileX;
  const topX1 = top.tileX + top.tileW;
  const botX0 = bottom.tileX;
  const botX1 = bottom.tileX + bottom.tileW;
  const overlapLo = Math.max(topX0, botX0);
  const overlapHi = Math.min(topX1, botX1);
  if (overlapHi - overlapLo >= width) {
    const x = pickStart(overlapLo, overlapHi - width, rng);
    const c = makeCorridor(x, yStart, width, yEnd - yStart);
    if (!corridorOverlapsExisting(c, regionSet.regions)) {
      regionSet.regions.push(c);
    }
    return;
  }
  if (topX1 - topX0 < width || botX1 - botX0 < width) return;
  if (yEnd - yStart < width * 2) return;
  const topX = pickStart(topX0, topX1 - width, rng);
  const botX = pickStart(botX0, botX1 - width, rng);
  const elbowY = pickStart(yStart, yEnd - width * 2, rng);
  const lc = makeLCorridorVertical(yStart, yEnd, topX, botX, elbowY, width);
  if (!corridorOverlapsExisting(lc, regionSet.regions)) {
    regionSet.regions.push(lc);
  }
}

function pickStart(lo: number, hi: number, rng: () => number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

type RectLike = {
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
};

// Two rects overlap iff each axis's intervals overlap on a
// positive-length sub-segment. Edge-touching (one rect's east
// == other's west, etc.) doesn't count as overlap — that's the
// intended adjacency between corridor and room.
function rectsOverlap(a: RectLike, b: RectLike): boolean {
  return (
    a.tileX < b.tileX + b.tileW &&
    b.tileX < a.tileX + a.tileW &&
    a.tileY < b.tileY + b.tileH &&
    b.tileY < a.tileY + a.tileH
  );
}

// Reject a candidate corridor if any of its sub-rects (or its
// bounding rect for plain corridors) overlap with an existing
// region's footprint — straight corridors interior, L-corridor
// sub-rects, or inset rooms. Without this guard, cousin
// corridors routinely run through space that's already a sibling
// corridor or another room, producing ghost duplicate sectors in
// the polygon round trip and orphaned no-walls sectors in the
// output.
function corridorOverlapsExisting(
  candidate: Region,
  existing: ReadonlyArray<Region>,
): boolean {
  const candidateRects = candidate.subRects ?? [
    {
      tileX: candidate.tileX,
      tileY: candidate.tileY,
      tileW: candidate.tileW,
      tileH: candidate.tileH,
    },
  ];
  for (const r of existing) {
    const rects = r.subRects ?? [
      { tileX: r.tileX, tileY: r.tileY, tileW: r.tileW, tileH: r.tileH },
    ];
    for (const a of candidateRects) {
      for (const b of rects) {
        if (rectsOverlap(a, b)) return true;
      }
    }
  }
  return false;
}

function makeCorridor(
  tileX: number,
  tileY: number,
  tileW: number,
  tileH: number,
): Region {
  return {
    tileX,
    tileY,
    tileW,
    tileH,
    category: 'hazard',
    kind: 'corridor',
  };
}

// Build an L-shaped horizontal corridor as a single Region with
// a 6-vertex polygon + 3-rect subRect footprint. The two stubs
// run along leftY/rightY and join via a vertical leg through
// elbowX. The polygon winding is CCW around the outer perimeter
// — the inner corner is a concave vertex (not two adjacent
// dead-end walls of disjoint rects).
function makeLCorridorHorizontal(
  xStart: number,
  xEnd: number,
  leftY: number,
  rightY: number,
  elbowX: number,
  width: number,
): Region {
  const ts = TILE_SIZE_WU;
  // Bounding rect for tileX/Y/W/H + rasteriser fallback.
  const tileX = xStart;
  const tileY = Math.min(leftY, rightY);
  const tileW = xEnd - xStart;
  const tileH = Math.max(leftY, rightY) + width - tileY;
  const subRects = [
    { tileX: xStart, tileY: leftY, tileW: elbowX - xStart, tileH: width },
    {
      tileX: elbowX,
      tileY: Math.min(leftY, rightY),
      tileW: width,
      tileH: Math.max(leftY, rightY) + width - Math.min(leftY, rightY),
    },
    {
      tileX: elbowX + width,
      tileY: rightY,
      tileW: xEnd - elbowX - width,
      tileH: width,
    },
  ];
  // Polygon: CCW outer perimeter of the L union.
  const verts: Vec2[] =
    leftY <= rightY
      ? [
          { x: xStart * ts, y: leftY * ts },
          { x: (elbowX + width) * ts, y: leftY * ts },
          { x: (elbowX + width) * ts, y: rightY * ts },
          { x: xEnd * ts, y: rightY * ts },
          { x: xEnd * ts, y: (rightY + width) * ts },
          { x: elbowX * ts, y: (rightY + width) * ts },
          { x: elbowX * ts, y: (leftY + width) * ts },
          { x: xStart * ts, y: (leftY + width) * ts },
        ]
      : [
          { x: xStart * ts, y: leftY * ts },
          { x: elbowX * ts, y: leftY * ts },
          { x: elbowX * ts, y: rightY * ts },
          { x: xEnd * ts, y: rightY * ts },
          { x: xEnd * ts, y: (rightY + width) * ts },
          { x: (elbowX + width) * ts, y: (rightY + width) * ts },
          { x: (elbowX + width) * ts, y: (leftY + width) * ts },
          { x: xStart * ts, y: (leftY + width) * ts },
        ];
  return {
    tileX,
    tileY,
    tileW,
    tileH,
    category: 'hazard',
    kind: 'corridor',
    polygonVerts: verts,
    subRects,
  };
}

function makeLCorridorVertical(
  yStart: number,
  yEnd: number,
  topX: number,
  botX: number,
  elbowY: number,
  width: number,
): Region {
  const ts = TILE_SIZE_WU;
  const tileX = Math.min(topX, botX);
  const tileY = yStart;
  const tileW = Math.max(topX, botX) + width - tileX;
  const tileH = yEnd - yStart;
  const subRects = [
    { tileX: topX, tileY: yStart, tileW: width, tileH: elbowY - yStart },
    {
      tileX: Math.min(topX, botX),
      tileY: elbowY,
      tileW: Math.max(topX, botX) + width - Math.min(topX, botX),
      tileH: width,
    },
    {
      tileX: botX,
      tileY: elbowY + width,
      tileW: width,
      tileH: yEnd - elbowY - width,
    },
  ];
  const verts: Vec2[] =
    topX <= botX
      ? [
          { x: topX * ts, y: yStart * ts },
          { x: (topX + width) * ts, y: yStart * ts },
          { x: (topX + width) * ts, y: elbowY * ts },
          { x: (botX + width) * ts, y: elbowY * ts },
          { x: (botX + width) * ts, y: yEnd * ts },
          { x: botX * ts, y: yEnd * ts },
          { x: botX * ts, y: (elbowY + width) * ts },
          { x: topX * ts, y: (elbowY + width) * ts },
        ]
      : [
          { x: topX * ts, y: yStart * ts },
          { x: (topX + width) * ts, y: yStart * ts },
          { x: (topX + width) * ts, y: (elbowY + width) * ts },
          { x: (botX + width) * ts, y: (elbowY + width) * ts },
          { x: (botX + width) * ts, y: yEnd * ts },
          { x: botX * ts, y: yEnd * ts },
          { x: botX * ts, y: elbowY * ts },
          { x: topX * ts, y: elbowY * ts },
        ];
  return {
    tileX,
    tileY,
    tileW,
    tileH,
    category: 'hazard',
    kind: 'corridor',
    polygonVerts: verts,
    subRects,
  };
}
