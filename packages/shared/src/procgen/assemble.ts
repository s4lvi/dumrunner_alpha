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
      // Per-region ceiling rolled by the pipeline's ceiling pass
      // (rooms {48,64,80,96}, corridors {40,48}); the linedef
      // round trip expresses the deltas between adjacent sectors
      // as upper "lintel" wall bands.
      ceilingZ: r.ceilingZ ?? CEILING_Z,
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
    // Pillars span floor → the OWNING ROOM's ceiling so they stay
    // flush under varied ceiling heights.
    const roomCeiling = r.ceilingZ ?? CEILING_Z;
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
        floorZ: roomCeiling,
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
          ceilingZOverride: roomCeiling,
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
    // Pits and platforms inherit the PARENT room's ceiling — a
    // pit must not punch its own lower ceiling into the room, and
    // a platform's airspace tops out at the same lid as the room
    // around it.
    const parentCeiling = r.ceilingZ ?? CEILING_Z;
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
        ceilingZ: parentCeiling,
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
  // Connectivity backstop. The roomGraph can claim adjacencies
  // that never produced a punched doorway (shared edge under the
  // min-shared thresholds, punch failures on chamfered polygons).
  // Everything downstream must trust the PUNCHED graph — the
  // DoorwaySpec list above — not roomGraph. If the punched graph
  // leaves the stairs unreachable from the spawn room, force-punch
  // the widest available shared edge between the reachable and
  // unreachable sets (relaxing the min-shared rule for that punch)
  // until the route exists.
  ensureRouteConnectivity(
    rawMap,
    regions,
    opts.roomGraph,
    doorways,
    regionSet.spawnRegionIndex,
    regionSet.stairsRegionIndex,
    tileSize,
  );
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
        // sitting at 1.5 tiles from the north wall — CLAMPED to
        // the last tile row inside the room. In small spawn rooms
        // (4 tiles tall) h/2 + 2 tiles lands exactly ON the south
        // wall; world spawn placement uses this point verbatim, so
        // the player spawned embedded in (or through) the wall
        // with no way to traverse the floor.
        y: Math.min(
          spawnRoom.y + spawnRoom.h / 2 + tileSize * 2,
          spawnRoom.y + spawnRoom.h - tileSize / 2,
        ),
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

// Merge shared-edge spans that lie on the same boundary line
// (same axis + coord) and overlap or touch, so each boundary
// gets at most one contiguous opening per contiguous contact
// patch. Disjoint spans on the same line stay separate (two
// genuinely distinct openings).
function mergeSharedEdges(edges: SharedEdge[]): SharedEdge[] {
  const byLine = new Map<string, SharedEdge[]>();
  for (const e of edges) {
    const key = `${e.axis}:${e.coord}`;
    const list = byLine.get(key);
    if (list) list.push(e);
    else byLine.set(key, [e]);
  }
  const out: SharedEdge[] = [];
  for (const list of byLine.values()) {
    list.sort((a, b) => a.lo - b.lo);
    let cur = { ...list[0] };
    for (let i = 1; i < list.length; i++) {
      const e = list[i];
      if (e.lo <= cur.hi) {
        if (e.hi > cur.hi) cur.hi = e.hi;
      } else {
        out.push(cur);
        cur = { ...e };
      }
    }
    out.push(cur);
  }
  return out;
}

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
      const isCorridor = a.kind === 'corridor' || b.kind === 'corridor';
      const minShared = isCorridor ? minCorridorShared : minRoomShared;
      // mergedContactEdges collects every sub-rect contact patch
      // FIRST, then merges overlapping/touching spans on the same
      // boundary line. An L-shaped corridor whose two stub rects
      // both touch the same room edge yields two OVERLAPPING
      // shared edges; punching both broke silently — the second
      // `punchDoor` can't find a single polygon edge containing
      // its endpoints once the first punch split the edge, so the
      // opening stayed at the first punch's extent while the
      // recorded DoorwaySpec (and the locked-room doors placed
      // from it) claimed the wider span. Result: door tiles
      // embedded in solid wall beside the real opening.
      for (const edge of mergedContactEdges(a, b, tileSize)) {
        if (edge.hi - edge.lo < minShared) continue;
        const spec = punchPortal(map, i, j, a, b, edge, doorWidth, tileSize);
        // Record ONLY portals that actually punched — downstream
        // consumers (locked-room door placement, the punched-
        // doorway connectivity graph) treat each DoorwaySpec as a
        // real traversable opening. Recording a failed punch used
        // to make the graph claim paths that had no opening.
        if (spec) doorways.push(spec);
      }
    }
  }
  return doorways;
}

// All merged contact patches between two regions (sub-rect aware
// for L-shaped corridors).
function mergedContactEdges(
  a: Region,
  b: Region,
  tileSize: number,
): SharedEdge[] {
  const aRects = a.subRects ?? [
    { tileX: a.tileX, tileY: a.tileY, tileW: a.tileW, tileH: a.tileH },
  ];
  const bRects = b.subRects ?? [
    { tileX: b.tileX, tileY: b.tileY, tileW: b.tileW, tileH: b.tileH },
  ];
  const contactEdges: SharedEdge[] = [];
  for (const aRect of aRects) {
    for (const bRect of bRects) {
      const edge = sharedEdgeRects(aRect, bRect, tileSize);
      if (edge) contactEdges.push(edge);
    }
  }
  if (contactEdges.length === 0) return [];
  return mergeSharedEdges(contactEdges);
}

// Punch one portal between regions i and j along the given merged
// contact edge. Corridor adjacencies open the FULL shared edge;
// room-to-room get a centred `doorWidth` door. If the punch fails
// on BOTH sides (the span isn't contained in a single straight
// polygon edge — chamfered corners, L-corridor elbows), retry with
// the span clamped to the widest straight sub-span common to both
// polygons. Returns the DoorwaySpec actually punched, or null when
// no opening could be made.
function punchPortal(
  map: SectorMap,
  i: number,
  j: number,
  a: Region,
  b: Region,
  edge: SharedEdge,
  doorWidth: number,
  tileSize: number,
): DoorwaySpec | null {
  const isCorridor = a.kind === 'corridor' || b.kind === 'corridor';
  let doorLo: number;
  let doorHi: number;
  if (isCorridor || edge.hi - edge.lo <= doorWidth) {
    doorLo = edge.lo;
    doorHi = edge.hi;
  } else {
    const mid = (edge.lo + edge.hi) / 2;
    doorLo = mid - doorWidth / 2;
    doorHi = mid + doorWidth / 2;
  }
  const attempt = (lo: number, hi: number): boolean => {
    let p: Vec2;
    let q: Vec2;
    if (edge.axis === 'vertical') {
      p = { x: edge.coord, y: lo };
      q = { x: edge.coord, y: hi };
    } else {
      p = { x: lo, y: edge.coord };
      q = { x: hi, y: edge.coord };
    }
    const okA = punchDoor(map, i, p, q);
    const okB = punchDoor(map, j, p, q);
    // One-sided success still yields a passable portal: the
    // punched side's solid:false sub-wall partially overlaps the
    // other polygon's straight edge, splitOverlappingWalls splits
    // it, and the two-sided linedef's impassable is the AND of
    // both sides' solid flags.
    return okA || okB;
  };
  if (attempt(doorLo, doorHi)) {
    return {
      axis: edge.axis,
      coord: edge.coord,
      lo: doorLo,
      hi: doorHi,
      a: i,
      b: j,
      aIsCorridor: a.kind === 'corridor',
      bIsCorridor: b.kind === 'corridor',
    };
  }
  // Both sides failed — clamp the span to the widest straight
  // sub-span both polygons actually have on this boundary line.
  const spanA = straightSpanOnLine(map.sectors[i], edge, doorLo, doorHi);
  const spanB = straightSpanOnLine(map.sectors[j], edge, doorLo, doorHi);
  if (!spanA || !spanB) return null;
  const lo = Math.max(spanA[0], spanB[0]);
  const hi = Math.min(spanA[1], spanB[1]);
  // Need at least one tile of clear opening for the player's
  // body radius.
  if (hi - lo < tileSize) return null;
  if (!attempt(lo, hi)) return null;
  return {
    axis: edge.axis,
    coord: edge.coord,
    lo,
    hi,
    a: i,
    b: j,
    aIsCorridor: a.kind === 'corridor',
    bIsCorridor: b.kind === 'corridor',
  };
}

// Widest sub-interval of [lo, hi] covered by a SINGLE straight
// polygon edge of `sector` collinear with the boundary line.
function straightSpanOnLine(
  sector: Sector | undefined,
  edge: SharedEdge,
  lo: number,
  hi: number,
): [number, number] | null {
  if (!sector) return null;
  const EPS = 0.5;
  let best: [number, number] | null = null;
  const N = sector.verts.length;
  for (let k = 0; k < N; k++) {
    const va = sector.verts[k];
    const vb = sector.verts[(k + 1) % N];
    let elo: number;
    let ehi: number;
    if (edge.axis === 'vertical') {
      if (Math.abs(va.x - edge.coord) > EPS || Math.abs(vb.x - edge.coord) > EPS) continue;
      elo = Math.max(lo, Math.min(va.y, vb.y));
      ehi = Math.min(hi, Math.max(va.y, vb.y));
    } else {
      if (Math.abs(va.y - edge.coord) > EPS || Math.abs(vb.y - edge.coord) > EPS) continue;
      elo = Math.max(lo, Math.min(va.x, vb.x));
      ehi = Math.min(hi, Math.max(va.x, vb.x));
    }
    if (ehi - elo > (best ? best[1] - best[0] : 0)) best = [elo, ehi];
  }
  return best;
}

// Assert the spawn room can reach the stairs room over the PUNCHED
// doorway graph; when it can't, force-punch shared edges between
// the reachable and unreachable sets (widest contact first, min-
// shared relaxed to a single tile) until it can. Operates on the
// raw pre-round-trip map so the punches flow through the same
// linedef conversion as regular doorways.
function ensureRouteConnectivity(
  map: SectorMap,
  regions: ReadonlyArray<Region>,
  roomGraph: number[][] | undefined,
  doorways: DoorwaySpec[],
  spawnIndex: number,
  stairsIndex: number | null,
  tileSize: number,
): void {
  if (!roomGraph || stairsIndex === null || stairsIndex === spawnIndex) return;
  const doorWidth = DOOR_WIDTH_TILES * tileSize;
  const reachable = (): Set<number> => {
    const adj: number[][] = regions.map(() => []);
    for (const dw of doorways) {
      adj[dw.a].push(dw.b);
      adj[dw.b].push(dw.a);
    }
    const seen = new Set<number>([spawnIndex]);
    const queue = [spawnIndex];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of adj[cur] ?? []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        queue.push(nxt);
      }
    }
    return seen;
  };
  // Each iteration punches one frontier portal, which strictly
  // grows the reachable set — bounded by the region count.
  for (let guard = 0; guard < regions.length; guard++) {
    const seen = reachable();
    if (seen.has(stairsIndex)) return;
    // Candidate frontier edges: roomGraph adjacencies from the
    // reachable set into the unreachable set, widest contact
    // patch first.
    let best: { i: number; j: number; edge: SharedEdge } | null = null;
    for (const i of seen) {
      for (const j of roomGraph[i] ?? []) {
        if (seen.has(j)) continue;
        const a = regions[i];
        const b = regions[j];
        if (!a || !b) continue;
        for (const edge of mergedContactEdges(a, b, tileSize)) {
          if (edge.hi - edge.lo < tileSize) continue;
          if (!best || edge.hi - edge.lo > best.edge.hi - best.edge.lo) {
            best = { i, j, edge };
          }
        }
      }
    }
    if (!best) {
      // No frontier contact at all — region topology itself is
      // disconnected. Nothing to punch; surface loudly so the
      // diag sweep flags the seed.
      console.warn(
        `procgen/assemble: stairs room ${stairsIndex} unreachable from spawn ` +
          `room ${spawnIndex} and no shared edge available to force-punch`,
      );
      return;
    }
    const spec = punchPortal(
      map,
      best.i,
      best.j,
      regions[best.i],
      regions[best.j],
      best.edge,
      doorWidth,
      tileSize,
    );
    if (spec) {
      doorways.push(spec);
    } else {
      // Punch failed even with the clamp retry — remove this pair
      // from contention by treating it as visited won't work
      // (we recompute each pass); instead warn and stop to avoid
      // an infinite loop on degenerate geometry.
      console.warn(
        `procgen/assemble: force-punch failed between regions ${best.i} and ${best.j}`,
      );
      return;
    }
  }
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
// Returns true when a sub-wall was actually flipped — callers use
// this to decide whether the portal really opened (a punch can
// fail when no single straight edge contains both endpoints, e.g.
// the span crosses a chamfer cut or an L-corridor elbow vertex).
function punchDoor(
  map: SectorMap,
  sectorId: number,
  p: Vec2,
  q: Vec2,
): boolean {
  const sector = map.sectors[sectorId];
  if (!sector) return false;
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
      let flipped = false;
      for (const w of map.walls) {
        if (w.sectorId === sectorId && w.vertIdx === k) {
          w.solid = false;
          flipped = true;
        }
      }
      return flipped;
    }
    return false;
  }
  return false;
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
