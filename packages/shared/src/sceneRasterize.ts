// Authored SectorScene → runtime SceneLayout converter. Used by
// the editor's playtest path (and eventually by the server-side
// scene_overrides loader from the editor plan) so a hand-authored
// scene can ride the same runtime pipeline a procgen layout uses.
//
// Approach: rasterise the scene's walkable sector polygons onto
// a tile grid at the scene's tile size (default 32 px). Anything
// inside a non-building sector → floor; outside → void. Lifts
// raised sectors (floorZ > 0) into `platforms[]` so step-up
// collision keeps working. Server's polygon collision still
// queries the per-tile-derived SectorMap; the editor's actual
// authored sector polygons aren't passed through yet — non-rect
// authored shapes will rasterise into tile rects. Round-tripping
// real polygons goes through a follow-up `authoredSectorMap`
// pathway.

import {
  DEFAULT_FLOOR_TILE_ID,
  VOID_TILE_ID,
} from './content/types';
import type { Vec2 } from './geometry';
import type { Rect, SceneLayout, TileGrid } from './protocol';
import type { Sector, SectorScene } from './sector';

const DEFAULT_TILE_SIZE = 32;

export function rasterizeSectorSceneToLayout(scene: SectorScene): SceneLayout {
  const tileSize = DEFAULT_TILE_SIZE;
  const b = scene.map.bounds ?? sectorBounds(scene.map.sectors);
  // Pad bounds outward by one tile so the rasterised walkable
  // area has a margin of void around it. Without the pad,
  // sector edges land exactly on the tile boundary and the last
  // row / column can quantise out depending on float precision.
  const padded = {
    x: b.x - tileSize,
    y: b.y - tileSize,
    w: b.w + tileSize * 2,
    h: b.h + tileSize * 2,
  };
  const originTileX = Math.floor(padded.x / tileSize);
  const originTileY = Math.floor(padded.y / tileSize);
  const width = Math.ceil(padded.w / tileSize);
  const height = Math.ceil(padded.h / tileSize);
  const tiles = new Uint8Array(width * height);

  // Per-tile sector test: walk every non-building sector and
  // mark tiles whose centre lands inside the polygon. O(W·H·S)
  // — fine at editor scales (tens of tiles, ~tens of sectors).
  const walkable = scene.map.sectors.filter(
    (s) => s.buildingKind === undefined && s.verts.length >= 3,
  );
  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      const wx = (originTileX + lx + 0.5) * tileSize;
      const wy = (originTileY + ly + 0.5) * tileSize;
      let inside = false;
      for (const s of walkable) {
        if (pointInPolygon(s.verts, wx, wy)) {
          inside = true;
          break;
        }
      }
      tiles[ly * width + lx] = inside ? DEFAULT_FLOOR_TILE_ID : VOID_TILE_ID;
    }
  }

  // Platforms — every sector with floorZ > 0 contributes a
  // tile-bounded PlatformRect covering its footprint. Multiple
  // overlapping platforms resolve at lookup time (max-combine
  // in floorAt), so we don't need a more careful merge here.
  const platforms = walkable
    .filter((s) => s.floorZ > 0)
    .map((s) => {
      const bb = sectorBoundingBox(s);
      return {
        tileX: Math.floor(bb.x / tileSize),
        tileY: Math.floor(bb.y / tileSize),
        w: Math.max(1, Math.ceil(bb.w / tileSize)),
        h: Math.max(1, Math.ceil(bb.h / tileSize)),
        floorZ: s.floorZ,
      };
    });

  // walkables: one big bounding rect — the tileGrid is the
  // authoritative passability source, walkables[] is the legacy
  // fallback (used by code paths that pre-date the grid).
  const walkables: Rect[] = [
    { x: padded.x, y: padded.y, w: padded.w, h: padded.h },
  ];

  const tileGrid: TileGrid = {
    width,
    height,
    originTileX,
    originTileY,
    tileSize,
    tilesB64: encodeTiles(tiles),
  };

  return {
    worldBounds: padded,
    walkables,
    rooms: [],
    spawn: scene.spawn,
    spawnZ: scene.spawnZ,
    interactables: scene.interactables,
    tileSize,
    biome: scene.biome,
    tileGrid,
    platforms,
    terrain: scene.terrain,
    // Keep the authored polygons intact for the runtime — polygon
    // collision (server) + the v2 renderer (client) read this
    // directly instead of going through the tile grid.
    authoredSectorMap: scene.map,
  };
}

function encodeTiles(tiles: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(tiles).toString('base64');
  }
  let s = '';
  for (let i = 0; i < tiles.length; i++) s += String.fromCharCode(tiles[i]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).btoa(s) as string;
}

function sectorBounds(sectors: Sector[]): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of sectors) {
    for (const v of s.verts) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 32, h: 32 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function sectorBoundingBox(s: Sector): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const v of s.verts) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function pointInPolygon(poly: ReadonlyArray<Vec2>, px: number, py: number): boolean {
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
