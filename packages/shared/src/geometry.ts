// Geometry helpers for the SceneLayout shape. Server and client both consume
// these — server for movement collision and AI line-of-sight, client for
// visual line-of-sight against the same wall data.

import type { Rect, TileGrid } from './protocol';

// Shared 2D point. Used by the sector model + helpers below. Kept
// here rather than in protocol.ts because protocol stays focussed
// on on-wire shapes; this is geometry.
export type Vec2 = { x: number; y: number };

// Hit-radius the server uses to decide which Interactable an
// E-press resolves to. The client renderers read this same value
// to gate the "Press E to …" prompt — anything bigger on the
// client makes the prompt appear at distances where the server
// will refuse to interact, which reads as a broken affordance.
// Adjust here, not in copies.
export const INTERACTABLE_RADIUS = 40;

// Decode a TileGrid's base64-packed `tilesB64` into a Uint8Array.
// Works in browser + Node (atob in browsers, Buffer on the server).
// Cache the result outside this helper if you'll read the grid more
// than once — base64 decode is allocating.
export function decodeTileGrid(grid: TileGrid): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(grid.tilesB64, 'base64'));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (globalThis as any).atob(grid.tilesB64) as string;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Sample the tile id at a world-space point. Returns 0 (void) when
// the point lies outside the grid's footprint.
export function tileIdAt(
  grid: TileGrid,
  tiles: Uint8Array,
  worldX: number,
  worldY: number,
): number {
  const tx = Math.floor(worldX / grid.tileSize) - grid.originTileX;
  const ty = Math.floor(worldY / grid.tileSize) - grid.originTileY;
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return 0;
  return tiles[ty * grid.width + tx];
}

// Sample the tile id at a tile-space coord. Cell-space variant of
// tileIdAt — used by raycasters that already track integer tile
// coords (mx, my) so they don't round-trip through world coords.
export function tileIdAtCell(
  grid: TileGrid,
  tiles: Uint8Array,
  cellX: number,
  cellY: number,
): number {
  const tx = cellX - grid.originTileX;
  const ty = cellY - grid.originTileY;
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return 0;
  return tiles[ty * grid.width + tx];
}

// Walkability convention: tile id 1 (DEFAULT_FLOOR_TILE_ID) is
// walkable, everything else (including 0 / void and 2 / wall) is
// blocked. Renderers and server collision read this to classify
// cells from the tile grid. Future work: when biome tileSets ship
// per-id walkable flags to clients, swap this for a per-id lookup.
export function isWalkableTileId(id: number): boolean {
  return id === 1;
}

// Stable per-cell variant pick. Same (variantSeed, cellX, cellY)
// always returns the same index, so two clients on the same scene
// see identical variant placement. variantCount = 0 → 0;
// variantCount = 1 → 0; otherwise modulo a 32-bit mix.
//
// `variantSeed` is the scene-level seed produced by the server
// from (worldSeed, cycle, floorIndex). Renderers don't need the
// raw inputs — the layout ships `variantSeed` directly.
export function pickCellVariant(
  variantSeed: number,
  cellX: number,
  cellY: number,
  variantCount: number,
): number {
  if (variantCount <= 1) return 0;
  let h = variantSeed >>> 0;
  h = (h ^ Math.imul(cellX | 0, 0x27d4eb2f)) >>> 0;
  h = (h ^ Math.imul(cellY | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  return h % variantCount;
}

// Server-side mix that produces the scene-level variantSeed shipped
// to clients. Co-located with pickCellVariant so the two stay in
// sync — change the mix here and every client picks new variants
// on the next snapshot.
export function makeVariantSeed(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
): number {
  let h = (worldSeed | 0) >>> 0;
  h = (h ^ Math.imul(cycle | 0, 0x85ebca6b)) >>> 0;
  h = (h ^ Math.imul(floorIndex | 0, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae3d) >>> 0;
  return h >>> 0;
}

export function isInsideAny(rects: Rect[], x: number, y: number): boolean {
  for (const r of rects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

// Bounding-circle fit: true iff a circle of `radius` at (x, y) lies entirely
// inside the walkable union. Samples 16 points around the circle (every
// 22.5°); worst-case "peek" between samples is < 0.5 × cos(11.25°) ≈ sub-px
// at common entity radii.
const COLLISION_SAMPLES = 16;
const COLLISION_UNITS: ReadonlyArray<{ ux: number; uy: number }> = (() => {
  const out: { ux: number; uy: number }[] = [];
  for (let i = 0; i < COLLISION_SAMPLES; i++) {
    const a = (i / COLLISION_SAMPLES) * Math.PI * 2;
    out.push({ ux: Math.cos(a), uy: Math.sin(a) });
  }
  return out;
})();

export function circleFits(
  rects: Rect[],
  x: number,
  y: number,
  radius: number
): boolean {
  for (const u of COLLISION_UNITS) {
    if (!isInsideAny(rects, x + u.ux * radius, y + u.uy * radius)) return false;
  }
  return true;
}

const LOS_SAMPLE_STEP_PX = 8;
// Half-thickness of the LoS "ribbon" tested perpendicular to the segment.
// Without it, a 0-width segment can pass through the single point shared
// by two diagonally-adjacent walkables — geometrically a wall corner —
// and erroneously return "visible." 4px is small enough not to clip
// legitimate corridor turns.
const LOS_THICKNESS_HALF_PX = 4;

// Returns true iff a thick segment from (x1,y1) to (x2,y2) stays
// entirely inside the union of walkable rects. Samples along the
// centre of the segment AND at ±LOS_THICKNESS_HALF_PX perpendicular
// offsets so diagonal-corner gaps don't leak sight.
// ---------- Polygon primitives ----------
//
// Used by polygon collision: point-in-sector membership, circle-vs-wall
// distance for player movement, segment-vs-segment intersection for
// LOS + projectile traces. All work in world units; callers feed in
// raw coordinates and don't need to know about tile scaling.

// Standard ray-casting point-in-polygon. Accepts an open polygon
// (verts in winding order, last vert NOT duplicated). Edge cases:
// the "on edge" answer is implementation-defined; we don't promise
// either way. Used for sector membership where a wall solid check
// catches edge ambiguity separately.
export function pointInPolygon(
  poly: ReadonlyArray<Vec2>,
  px: number,
  py: number,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
    const a = poly[i];
    const b = poly[j];
    const intersects =
      a.y > py !== b.y > py &&
      px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Shortest distance from point (px, py) to the line segment a→b.
// Used for circle-vs-wall: if the result is less than the player
// radius, the move is blocked. Returns 0 when the point lies on
// the segment.
export function pointSegmentDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) return Math.hypot(apx, apy);
  // Project (a → p) onto (a → b), clamped to [0, 1].
  let t = (apx * abx + apy * aby) / abLenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

// Swept circle-vs-segment: returns true iff a circle of `radius`
// moving in a straight line from (x0, y0) to (x1, y1) clears the
// segment a→b without intersecting it. The conservative test (point
// (x1,y1)'s distance to a→b ≥ radius) misses early-collision cases
// where the circle "passes through" a wall on the way; we sample
// along the swept path at step ≤ radius/2 so the test catches any
// tunneling at our per-tick move magnitudes (~7 px at PLAYER_RADIUS
// 10 — well under one sample).
export function sweptCircleClearsSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const moveLen = Math.hypot(dx, dy);
  if (moveLen === 0) {
    return pointSegmentDistance(ax, ay, bx, by, x0, y0) >= radius;
  }
  const stepLen = radius * 0.5;
  const steps = Math.max(1, Math.ceil(moveLen / stepLen));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sx = x0 + dx * t;
    const sy = y0 + dy * t;
    if (pointSegmentDistance(ax, ay, bx, by, sx, sy) < radius) return false;
  }
  return true;
}

// Segment-vs-segment intersection. Returns the parameter t along
// (a → b) at which the segments cross, in [0, 1], or null if they
// don't cross. Used by LOS + projectile traces — the smallest t
// over all crossed walls is the first hit.
export function segmentSegmentIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx2: number,
  dy2: number,
): number | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx2 - cx;
  const sy = dy2 - cy;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null; // parallel
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

// AABB query helper for spatial indexes that bucket segments into
// world-grid cells. Returns the inclusive cell range
// [cellX0..cellX1] × [cellY0..cellY1] that a segment passes through.
// Caller chooses cellSize.
export function segmentCellRange(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cellSize: number,
): { cellX0: number; cellY0: number; cellX1: number; cellY1: number } {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return {
    cellX0: Math.floor(minX / cellSize),
    cellY0: Math.floor(minY / cellSize),
    cellX1: Math.floor(maxX / cellSize),
    cellY1: Math.floor(maxY / cellSize),
  };
}

export function segmentInsideWalkables(
  rects: Rect[],
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  if (rects.length === 0) return true;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) return isInsideAny(rects, x1, y1);

  // Perpendicular unit vector for the offset samples.
  const px = -dy / length;
  const py = dx / length;
  const offX = px * LOS_THICKNESS_HALF_PX;
  const offY = py * LOS_THICKNESS_HALF_PX;

  const steps = Math.max(1, Math.ceil(length / LOS_SAMPLE_STEP_PX));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sx = x1 + dx * t;
    const sy = y1 + dy * t;
    if (!isInsideAny(rects, sx, sy)) return false;
    if (!isInsideAny(rects, sx + offX, sy + offY)) return false;
    if (!isInsideAny(rects, sx - offX, sy - offY)) return false;
  }
  return true;
}
