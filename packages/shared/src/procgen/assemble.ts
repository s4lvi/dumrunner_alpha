import {
  DEFAULT_FLOOR_TILE_ID,
  type HazardZoneCategory,
} from '../content/types';
import type { Vec2 } from '../geometry';
import { pointInPolygon } from '../geometry';
import { linedefMapToPolygonMap, polygonMapToLinedefMap } from '../linedef';
import type {
  DoorwaySpec,
  Interactable,
  Rect,
  SceneAnchor,
  SceneLayout,
  TileGrid,
} from '../protocol';
import { insertVertsOnEdge, splitOverlappingWalls, vecNear } from '../sector';
import type { Sector, SectorMap, Wall } from '../sector';
import { stampTemplate } from '../roomTemplates';
import type { Region, RegionSet } from './regions';
import type { RoomStamp } from './finalize';

const DEFAULT_TILE_SIZE = 32;
const FLOOR_Z = 0;
const CEILING_Z = 64;
const AMBIENT = 0.5;

export type AssembleOpts = {
  biome: string;
  floorIndex: number;
  tileSize?: number;
  roomGraph?: number[][];
  anchors?: SceneAnchor[];
  stamps?: RoomStamp[];
};

export function assembleSceneLayout(
  regionSet: RegionSet,
  opts: AssembleOpts,
): SceneLayout {
  const tileSize = opts.tileSize ?? DEFAULT_TILE_SIZE;
  const { regions } = regionSet;
  if (regions.length === 0) {
    throw new Error('procgen/pipeline: cannot assemble an empty region set');
  }

  const sectors: Sector[] = regions.map((r, idx) => {
    // Use the region's authored polygonVerts (chamfered corners
    // emit octagonal polygons) when present, else build the
    // four-corner rect from tileX/Y/W/H. tileX/Y/W/H always
    // stays as the bounding box for rasterisation + anchor
    // placement, so this swap is purely about wall geometry.
    const verts =
      r.polygonVerts && r.polygonVerts.length >= 3
        ? r.polygonVerts.map((v) => ({ x: v.x, y: v.y }))
        : (() => {
            const px = r.tileX * tileSize;
            const py = r.tileY * tileSize;
            const pw = r.tileW * tileSize;
            const ph = r.tileH * tileSize;
            return [
              { x: px, y: py },
              { x: px + pw, y: py },
              { x: px + pw, y: py + ph },
              { x: px, y: py + ph },
            ];
          })();
    return {
      id: idx,
      verts,
      floorZ: FLOOR_Z,
      ceilingZ: CEILING_Z,
      floorTextureId: null,
      ceilingTextureId: null,
      ambient: AMBIENT,
      biomeId: opts.biome,
    };
  });
  const walls: Wall[] = [];
  for (const sector of sectors) {
    for (let i = 0; i < sector.verts.length; i++) {
      walls.push({
        sectorId: sector.id,
        vertIdx: i,
        backSectorId: null,
        textureId: null,
        solid: true,
      });
    }
  }
  // Pillars: floor-to-ceiling solid blocks inside large rooms.
  // Emitted as separate building-cube-style sectors so they
  // render with cube walls + cap and block movement via the
  // existing buildingKind path. We use `buildingKind: 'pillar'`
  // as the marker; no BuildingState entry is needed because
  // these are static procgen geometry, not destructibles.
  for (const r of regions) {
    if (!r.pillars) continue;
    for (const p of r.pillars) {
      const px = p.tileX * tileSize;
      const py = p.tileY * tileSize;
      const pw = p.tileW * tileSize;
      const ph = p.tileH * tileSize;
      const sectorId = sectors.length;
      sectors.push({
        id: sectorId,
        verts: [
          { x: px, y: py },
          { x: px + pw, y: py },
          { x: px + pw, y: py + ph },
          { x: px, y: py + ph },
        ],
        floorZ: CEILING_Z,
        ceilingZ: -1,
        floorTextureId: null,
        ceilingTextureId: null,
        ambient: AMBIENT,
        biomeId: opts.biome,
        buildingKind: 'pillar',
      });
      for (let i = 0; i < 4; i++) {
        walls.push({
          sectorId,
          vertIdx: i,
          backSectorId: null,
          textureId: null,
          solid: true,
          floorZOverride: FLOOR_Z,
          ceilingZOverride: CEILING_Z,
          buildingKind: 'pillar',
        });
      }
    }
  }
  // Vertical sub-sectors — platforms (floorZ > 0) and pits
  // (floorZ < 0). Each emits a polygon sector that overlaps the
  // room's footprint at the raised / sunken floor height. The
  // perimeter walls become explicit RISERS: solid:false (so the
  // step-up gate in `circleSweepPassable` lets the player climb)
  // with floorZOverride / ceilingZOverride pinning the riser's
  // vertical band to the floor delta. We don't rely on the
  // downstream `riserifyWalls` to set these because the linedef
  // round-trip's shadow-parent extension would have already
  // pinned `floorZOverride` first, making riserifyWalls skip
  // them.
  //
  // We also carve the sub-sector's footprint as a HOLE in the
  // parent room sector. Without the hole, the room's floor mesh
  // tessellates over the entire room rect including the pit
  // footprint — the pit's z=-8 floor renders behind the room's
  // z=0 floor and you fall into an invisible hole. Cutting the
  // hole lets earcut subtract that area so the sub-sector's
  // floor is the only thing covering that XY.
  for (let regionIdx = 0; regionIdx < regions.length; regionIdx++) {
    const r = regions[regionIdx];
    if (!r.verticalSubSectors) continue;
    const parentSector = sectors[regionIdx];
    for (const v of r.verticalSubSectors) {
      const px = v.tileX * tileSize;
      const py = v.tileY * tileSize;
      const pw = v.tileW * tileSize;
      const ph = v.tileH * tileSize;
      const sectorId = sectors.length;
      sectors.push({
        id: sectorId,
        verts: [
          { x: px, y: py },
          { x: px + pw, y: py },
          { x: px + pw, y: py + ph },
          { x: px, y: py + ph },
        ],
        floorZ: v.floorZ,
        ceilingZ: CEILING_Z,
        floorTextureId: null,
        ceilingTextureId: null,
        ambient: AMBIENT,
        biomeId: opts.biome,
      });
      // Hole in the parent room's polygon. Inner rings use CW
      // winding (parent outer is CCW), so reverse the sub-sector's
      // CCW rect.
      if (parentSector) {
        const hole = [
          { x: px, y: py },
          { x: px, y: py + ph },
          { x: px + pw, y: py + ph },
          { x: px + pw, y: py },
        ];
        parentSector.holes = [...(parentSector.holes ?? []), hole];
      }
      // Riser walls span the delta between room floor (0) and
      // sub-sector floor. For platforms that's [0, +floorZ];
      // for pits [+floorZ, 0]. Either way the geometry is "wall
      // from the lower of the two floors to the higher", which
      // is the natural step-up / step-down riser.
      const riserBot = Math.min(FLOOR_Z, v.floorZ);
      const riserTop = Math.max(FLOOR_Z, v.floorZ);
      for (let i = 0; i < 4; i++) {
        walls.push({
          sectorId,
          vertIdx: i,
          backSectorId: null,
          textureId: null,
          solid: false,
          floorZOverride: riserBot,
          ceilingZOverride: riserTop,
        });
      }
    }
  }
  // Static lights — per-room point lights from decorate. Emitted
  // with deterministic ids tied to the source region's sector id
  // so they can be addressed for later updates if needed.
  const initialLights: SectorMap['lights'] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (!r.lights) continue;
    for (let k = 0; k < r.lights.length; k++) {
      const l = r.lights[k];
      initialLights.push({
        id: `static:${i}:${k}`,
        x: l.x,
        y: l.y,
        z: l.z,
        radius: l.radius,
        colour: l.color,
        intensity: l.intensity,
      });
    }
  }
  const bounds = computeBounds(sectors);
  const rawMap: SectorMap = { sectors, walls, lights: initialLights, bounds };

  // Punch doorways at the midpoint of each adjacency BEFORE the
  // linedef round trip. Without this, the round trip pairs every
  // shared edge into a two-sided linedef and (with the linedef→
  // polygon converter preserving `impassable` verbatim) we'd get
  // sealed-off rooms with no way to traverse the dungeon. The
  // door insertion splits each adjacency into [side, door, side]
  // sub-walls; the side sub-walls stay solid:true on both sides
  // (sealed) while the door sub-wall is flipped to solid:false on
  // both sides (passable portal). After the round trip the door
  // becomes a real two-sided portal with `impassable=false`.
  //
  // applyRuntimePatches=true runs splitOverlappingWalls before
  // vertex interning so cousin-region partial overlaps still
  // resolve to shared two-sided linedefs.
  const doorways = insertDoorways(rawMap, regions, opts.roomGraph, tileSize);
  // Split partial-overlap walls between cousin regions (BSP
  // cousins commonly share only part of an edge). MUST run
  // BEFORE polygon→linedef so the resulting sub-walls bucket
  // into shared two-sided linedefs. We do NOT call
  // `riserifyWalls` here (it force-sets every shared-edge wall
  // to solid:false, which would undo our sealed-divider walls
  // between adjacent regions — solid intent is already wired
  // by insertDoorways above). For the same reason we pass
  // `applyRuntimePatches: false` to the linedef conversion
  // instead of letting it run both passes again on its clone.
  splitOverlappingWalls(rawMap);
  const linedef = polygonMapToLinedefMap(rawMap, { applyRuntimePatches: false });
  const finalMap = linedefMapToPolygonMap(linedef);
  // The polygon→linedef conversion is single-loop (no holes), so
  // the hole rings carved into parent rooms above do NOT survive
  // the round trip — every floor was shipping with zero holes and
  // parent floors tessellated straight across pit footprints
  // (visible floor, invisible drop). Re-carve them onto the final
  // map. Sector ids are re-derived by the loop walker, so match
  // geometrically: a sub-sector's footprint holes every final
  // sector that contains its centroid at a different floor height.
  recarveSubSectorHoles(finalMap, regions, tileSize);

  const { tileGrid, walkables, rooms } = rasterize(
    regions,
    tileSize,
    opts.stamps ?? [],
  );
  const roomCategories: HazardZoneCategory[] = regions.map((r) => r.category);

  const spawnRoom = rooms[regionSet.spawnRegionIndex];
  const interactables: Interactable[] = [];
  // Push the extract_pad to the north wall of the spawn room and
  // the player spawn to the south wall, so the 1-tile portal cube
  // doesn't intersect with the player's body radius at scene
  // load. Previously extract_pad sat 1 tile north of dead-centre
  // and the player spawned ON dead-centre, leaving the player's
  // hitbox clipping into the portal's south face — "stuck in the
  // stairs/extract cube, jump to get out".
  if (spawnRoom) {
    interactables.push({
      id: 'extract_pad',
      kind: 'extract_pad',
      x: spawnRoom.x + spawnRoom.w / 2,
      y: spawnRoom.y + tileSize * 1.5,
      label: 'Extract to base',
    });
  }
  if (regionSet.stairsRegionIndex !== null) {
    const stairsRoom = rooms[regionSet.stairsRegionIndex];
    if (stairsRoom) {
      interactables.push({
        id: 'stairs_down',
        kind: 'stairs_down',
        x: stairsRoom.x + stairsRoom.w / 2,
        y: stairsRoom.y + stairsRoom.h / 2,
        label: `Descend to floor ${opts.floorIndex + 1}`,
      });
    }
  }

  const spawn = spawnRoom
    ? {
        x: spawnRoom.x + spawnRoom.w / 2,
        // 2 tiles south of room centre so the player's body
        // radius (~10wu) stays clear of the extract_pad cube
        // sitting at 1.5 tiles from the north wall.
        y: spawnRoom.y + spawnRoom.h / 2 + tileSize * 2,
      }
    : { x: 0, y: 0 };

  return {
    worldBounds: bounds,
    walkables,
    rooms,
    spawn,
    spawnZ: FLOOR_Z,
    interactables,
    tileSize,
    biome: opts.biome,
    roomCategories,
    roomGraph: opts.roomGraph,
    doorways,
    anchors: opts.anchors,
    tileGrid,
    authoredSectorMap: finalMap,
  };
}

function rasterize(
  regions: ReadonlyArray<Region>,
  tileSize: number,
  stamps: ReadonlyArray<RoomStamp>,
): { tileGrid: TileGrid; walkables: Rect[]; rooms: Rect[] } {
  let minTx = Infinity;
  let minTy = Infinity;
  let maxTx = -Infinity;
  let maxTy = -Infinity;
  for (const r of regions) {
    if (r.tileX < minTx) minTx = r.tileX;
    if (r.tileY < minTy) minTy = r.tileY;
    if (r.tileX + r.tileW > maxTx) maxTx = r.tileX + r.tileW;
    if (r.tileY + r.tileH > maxTy) maxTy = r.tileY + r.tileH;
  }
  const originTileX = minTx - 1;
  const originTileY = minTy - 1;
  const width = maxTx - minTx + 2;
  const height = maxTy - minTy + 2;
  const tiles = new Uint8Array(width * height);
  for (const r of regions) {
    // subRects override the bounding rect for the tile fill —
    // lets L-shaped corridors (single Region carrying multiple
    // stub rects) raster only their actual footprint instead of
    // the L's bounding box, which would mark the void inside the
    // L's concavity as walkable.
    const rects = r.subRects ?? [
      { tileX: r.tileX, tileY: r.tileY, tileW: r.tileW, tileH: r.tileH },
    ];
    for (const rect of rects) {
      for (let ty = rect.tileY; ty < rect.tileY + rect.tileH; ty++) {
        for (let tx = rect.tileX; tx < rect.tileX + rect.tileW; tx++) {
          const lx = tx - originTileX;
          const ly = ty - originTileY;
          if (lx < 0 || ly < 0 || lx >= width || ly >= height) continue;
          tiles[ly * width + lx] = DEFAULT_FLOOR_TILE_ID;
        }
      }
    }
  }
  // Carve pillar tiles back to void so the AI grid + walkables
  // exclude them. The polygon sectorMap blocks movement either
  // way, but un-carved pillar tiles would still claim "walkable"
  // for AI pathing / loot drop placement.
  for (const r of regions) {
    if (!r.pillars) continue;
    for (const p of r.pillars) {
      for (let ty = p.tileY; ty < p.tileY + p.tileH; ty++) {
        for (let tx = p.tileX; tx < p.tileX + p.tileW; tx++) {
          const lx = tx - originTileX;
          const ly = ty - originTileY;
          if (lx < 0 || ly < 0 || lx >= width || ly >= height) continue;
          tiles[ly * width + lx] = 0;
        }
      }
    }
  }
  const gridShape = { width, height, originTileX, originTileY, tileSize };
  for (const stamp of stamps) {
    stampTemplate(
      { ...gridShape, tilesB64: '' },
      tiles,
      stamp.template,
      stamp.tileX - originTileX,
      stamp.tileY - originTileY,
    );
  }
  const tileGrid: TileGrid = {
    ...gridShape,
    tilesB64: encodeTiles(tiles),
  };
  const rooms: Rect[] = regions.map((r) => ({
    x: r.tileX * tileSize,
    y: r.tileY * tileSize,
    w: r.tileW * tileSize,
    h: r.tileH * tileSize,
  }));
  return { tileGrid, walkables: rooms, rooms };
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

// Door geometry:
// - Corridor adjacencies (room ↔ corridor or corridor ↔ corridor)
//   open the FULL shared edge so the corridor's cross-section
//   becomes the doorway. Capping a 3-tile door inside a 4-tile
//   corridor opening leaves a half-tile wall stub on each side
//   that reads as a notch around the entrance.
// - Room-to-room adjacencies (no corridor between, mostly direct
//   BSP siblings before insetting kicks in) get a centred
//   3-tile door, requiring ≥5 tiles of shared edge so the door
//   has ≥1 tile of wall on each side.
const DOOR_WIDTH_TILES = 3;
const MIN_SHARED_TILES_FOR_ROOM_DOOR = 5;
const MIN_SHARED_TILES_FOR_CORRIDOR_OPENING = 2;

type SharedEdge = {
  axis: 'vertical' | 'horizontal';
  coord: number;
  lo: number;
  hi: number;
};

// Punch a passable doorway at the midpoint of every shared edge
// between adjacent regions. For each (i,j) in roomGraph the
// shared edge is computed in world coordinates, the door
// endpoints (p,q) are inserted into BOTH region polygons via
// `insertVertsOnEdge`, and the resulting sub-wall whose endpoints
// match (p,q) on each side is flipped to `solid:false`. The
// polygon→linedef round trip then reads matching solid:false
// walls on both sides → impassable:false → portal.
function insertDoorways(
  map: SectorMap,
  regions: ReadonlyArray<Region>,
  roomGraph: number[][] | undefined,
  tileSize: number,
): DoorwaySpec[] {
  const doorways: DoorwaySpec[] = [];
  if (!roomGraph) return doorways;
  const doorWidth = DOOR_WIDTH_TILES * tileSize;
  const minRoomShared = MIN_SHARED_TILES_FOR_ROOM_DOOR * tileSize;
  const minCorridorShared = MIN_SHARED_TILES_FOR_CORRIDOR_OPENING * tileSize;
  for (let i = 0; i < regions.length; i++) {
    const neighbors = roomGraph[i];
    if (!neighbors) continue;
    for (const j of neighbors) {
      if (j <= i) continue;
      const a = regions[i];
      const b = regions[j];
      if (!a || !b) continue;
      // For L-shaped corridors (Region with subRects) the
      // bounding rect overshoots the actual footprint, so the
      // bounding-rect shared edge with a neighbour can claim
      // extent that the polygon doesn't actually have. Match
      // sub-rect to sub-rect to get the true contact patch.
      const aRects = a.subRects ?? [
        { tileX: a.tileX, tileY: a.tileY, tileW: a.tileW, tileH: a.tileH },
      ];
      const bRects = b.subRects ?? [
        { tileX: b.tileX, tileY: b.tileY, tileW: b.tileW, tileH: b.tileH },
      ];
      const isCorridor = a.kind === 'corridor' || b.kind === 'corridor';
      const minShared = isCorridor ? minCorridorShared : minRoomShared;
      for (const aRect of aRects) {
        for (const bRect of bRects) {
          const edge = sharedEdgeRects(aRect, bRect, tileSize);
          if (!edge) continue;
          if (edge.hi - edge.lo < minShared) continue;
          // Corridor adjacencies: the entire shared edge is the
          // portal so the corridor's full cross-section opens
          // into the room (no 0-thickness wall stubs around the
          // entrance). Room-to-room: centred 3-tile door.
          let doorLo: number;
          let doorHi: number;
          if (isCorridor) {
            doorLo = edge.lo;
            doorHi = edge.hi;
          } else {
            const mid = (edge.lo + edge.hi) / 2;
            doorLo = mid - doorWidth / 2;
            doorHi = mid + doorWidth / 2;
          }
          let p: Vec2;
          let q: Vec2;
          if (edge.axis === 'vertical') {
            p = { x: edge.coord, y: doorLo };
            q = { x: edge.coord, y: doorHi };
          } else {
            p = { x: doorLo, y: edge.coord };
            q = { x: doorHi, y: edge.coord };
          }
          punchDoor(map, i, p, q);
          punchDoor(map, j, p, q);
          // Record the punched portal so downstream consumers
          // (locked-room door placement) can put door buildings
          // exactly in the opening instead of re-deriving edges.
          doorways.push({
            axis: edge.axis,
            coord: edge.coord,
            lo: doorLo,
            hi: doorHi,
            a: i,
            b: j,
            aIsCorridor: a.kind === 'corridor',
            bIsCorridor: b.kind === 'corridor',
          });
        }
      }
    }
  }
  return doorways;
}

type RectLike = {
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
};

function sharedEdgeRects(
  a: RectLike,
  b: RectLike,
  tileSize: number,
): SharedEdge | null {
  const aPx0 = a.tileX * tileSize;
  const aPx1 = (a.tileX + a.tileW) * tileSize;
  const aPy0 = a.tileY * tileSize;
  const aPy1 = (a.tileY + a.tileH) * tileSize;
  const bPx0 = b.tileX * tileSize;
  const bPx1 = (b.tileX + b.tileW) * tileSize;
  const bPy0 = b.tileY * tileSize;
  const bPy1 = (b.tileY + b.tileH) * tileSize;
  // Vertical shared edge: A's right meets B's left (or vice versa).
  if (aPx1 === bPx0 || bPx1 === aPx0) {
    const lo = Math.max(aPy0, bPy0);
    const hi = Math.min(aPy1, bPy1);
    if (hi > lo) {
      return {
        axis: 'vertical',
        coord: aPx1 === bPx0 ? aPx1 : aPx0,
        lo,
        hi,
      };
    }
  }
  // Horizontal shared edge: A's bottom meets B's top (or vice versa).
  if (aPy1 === bPy0 || bPy1 === aPy0) {
    const lo = Math.max(aPx0, bPx0);
    const hi = Math.min(aPx1, bPx1);
    if (hi > lo) {
      return {
        axis: 'horizontal',
        coord: aPy1 === bPy0 ? aPy1 : aPy0,
        lo,
        hi,
      };
    }
  }
  return null;
}

// Insert (p,q) into the sector polygon along whichever existing
// edge contains both — then locate the freshly-emitted sub-wall
// spanning (p,q) (in either direction) and flip it to solid:false.
function punchDoor(
  map: SectorMap,
  sectorId: number,
  p: Vec2,
  q: Vec2,
): void {
  const sector = map.sectors[sectorId];
  if (!sector) return;
  const EPS = 0.5;
  const N = sector.verts.length;
  for (let i = 0; i < N; i++) {
    const va = sector.verts[i];
    const vb = sector.verts[(i + 1) % N];
    if (!pointOnSegment(va, vb, p, EPS)) continue;
    if (!pointOnSegment(va, vb, q, EPS)) continue;
    insertVertsOnEdge(sector, map.walls, i, p, q, EPS);
    // Walls were rebuilt by insertVertsOnEdge. Scan for the
    // sub-wall whose endpoints match (p,q) — direction is the
    // CCW polygon winding, so we check both orderings.
    const M = sector.verts.length;
    for (let k = 0; k < M; k++) {
      const a = sector.verts[k];
      const b = sector.verts[(k + 1) % M];
      const ab = vecNear(a, p, EPS) && vecNear(b, q, EPS);
      const ba = vecNear(a, q, EPS) && vecNear(b, p, EPS);
      if (!ab && !ba) continue;
      for (const w of map.walls) {
        if (w.sectorId === sectorId && w.vertIdx === k) {
          w.solid = false;
        }
      }
      return;
    }
    return;
  }
}

// Whether point `p` lies on segment a→b within `eps` (collinear +
// parameter t ∈ [0, 1]). Used to find which existing edge of a
// rectangle polygon contains the door endpoints we're about to
// insert.
function pointOnSegment(a: Vec2, b: Vec2, p: Vec2, eps: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return vecNear(a, p, eps);
  const cross = (p.x - a.x) * dy - (p.y - a.y) * dx;
  if (Math.abs(cross) > eps * Math.sqrt(lenSq)) return false;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  return t >= -eps / Math.sqrt(lenSq) && t <= 1 + eps / Math.sqrt(lenSq);
}

// Re-apply sub-sector footprint holes to the post-round-trip map.
// `assembleSceneLayout` carves these into the raw map, but
// `polygonMapToLinedefMap` is single-loop (no holes), so they're
// lost in the conversion. Holes drive the renderer's earcut
// subtraction — without them the parent room's floor mesh covers
// pit footprints (and the floor under platforms).
function recarveSubSectorHoles(
  map: SectorMap,
  regions: ReadonlyArray<Region>,
  tileSize: number,
): void {
  for (const r of regions) {
    if (!r.verticalSubSectors) continue;
    for (const v of r.verticalSubSectors) {
      const px = v.tileX * tileSize;
      const py = v.tileY * tileSize;
      const pw = v.tileW * tileSize;
      const ph = v.tileH * tileSize;
      const cx = px + pw / 2;
      const cy = py + ph / 2;
      // Inner rings wind CW (parent outers are CCW) — mirrors the
      // raw-map carve in assembleSceneLayout.
      const hole = [
        { x: px, y: py },
        { x: px, y: py + ph },
        { x: px + pw, y: py + ph },
        { x: px + pw, y: py },
      ];
      for (const s of map.sectors) {
        if (s.floorZ === v.floorZ && pointInPolygon(s.verts, cx, cy)) {
          // The sub-sector itself. The round-trip also strips the
          // explicit riser bands assembleSceneLayout pinned on its
          // perimeter walls (floorZOverride/ceilingZOverride) — the
          // renderer needs them to draw the pit/platform sides.
          // Re-pin: band spans room floor (0) ↔ sub-sector floor,
          // solid:false so the step-up gate still allows climbing.
          const riserBot = Math.min(0, v.floorZ);
          const riserTop = Math.max(0, v.floorZ);
          for (const w of map.walls) {
            if (w.sectorId !== s.id) continue;
            w.solid = false;
            w.floorZOverride = riserBot;
            w.ceilingZOverride = riserTop;
          }
          continue;
        }
        // Other containing sectors (the parent room at floorZ 0)
        // get the footprint hole.
        if (!pointInPolygon(s.verts, cx, cy)) continue;
        s.holes = [...(s.holes ?? []), hole];
      }
    }
  }
}

function computeBounds(sectors: ReadonlyArray<Sector>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of sectors) {
    for (const v of s.verts) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
