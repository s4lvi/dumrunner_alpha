// Linedef-based scene model (Doom WAD lineage). Refactor target
// for the polygon-per-sector model in `./sector`. Shared edges
// become first-class data — every linedef carries (front, back?)
// sidedefs and a single pair of endpoint vertex ids, so authoring
// a door / tunnel / partial-overlap wall is a graph edit rather
// than a heuristic detection problem at scene load.
//
// Sectors carry only metadata (floorZ, ceilingZ, textures, etc.);
// the sector's outline is DERIVED from the loop of linedefs that
// reference it. The renderer + collision both consume the graph
// directly.
//
// During migration this lives alongside the existing polygon
// types in `./sector`. Phase 5 of v2-finish-plan.md retires the
// polygon types once nothing imports them.

import type { Vec2 } from './geometry';
import { pointInPolygon } from './geometry';
import {
  riserifyWalls,
  splitOverlappingWalls,
  type Sector as PolygonSector,
  type SectorLight,
  type SectorMap as PolygonSectorMap,
  type SectorScene as PolygonSectorScene,
  type Wall as PolygonWall,
} from './sector';

// Sentinel sector id assigned to a linedef's sidedef during
// authoring when the linedef doesn't yet belong to any real
// sector (drawn into empty space, chain not yet closed). The
// adjacency builder skips sentinel sidedefs so they don't
// pollute real sectors' perimeter walks. Saves persist sentinel
// linedefs as-is; the runtime renderer / reverse converter
// skip them via the same adjacency-build rule.
export const SENTINEL_SECTOR_ID = -1;

// ---------- Core types ----------

export type Linedef = {
  // Endpoints by index into LinedefMap.vertices[].
  v1: number;
  v2: number;
  // Sidedef indices. Front mandatory; back null = one-sided
  // (solid wall, faces the void or an unmapped region).
  front: number;
  back: number | null;
  // Gameplay flags. Defaults follow Doom conventions:
  //  - one-sided linedef (back === null) blocks player +
  //    projectiles + monsters by definition.
  //  - two-sided linedef defaults all-passable; height diff
  //    between front/back sectors creates upper/lower visible
  //    walls that gameplay-collide implicitly via step-up gates.
  // Flags can override these defaults for setpieces (e.g. an
  // invisible monster-blocker line, or a door that blocks
  // projectiles even when ajar).
  impassable: boolean;
  blockProjectiles: boolean;
  blockMonsters: boolean;
};

export type Sidedef = {
  sectorId: number;
  // Texture refs — render-side. For one-sided linedefs the
  // visible quad is `midTex`. For two-sided, `upperTex` paints
  // the slab above the back-sector's ceiling and `lowerTex`
  // paints the slab below the back-sector's floor; `midTex` is
  // usually null (transparent) but can be set for railings /
  // grilles.
  midTex: string | null;
  upperTex: string | null;
  lowerTex: string | null;
  // Per-side UV scroll. Authoring nicety; renderer adds them
  // directly into the wall's UVs.
  texOffsetX: number;
  texOffsetY: number;
};

// Sector metadata. The outline is DERIVED from linedefs; no
// `verts` field. `id` matches the array index but is stored
// explicitly so linedefs can reference it stably across edits.
export type LinedefSector = {
  id: number;
  floorZ: number;
  ceilingZ: number;
  floorTextureId: string | null;
  ceilingTextureId: string | null;
  // 0..1 ambient contribution combined with light sampling in
  // the fragment shader. Same scale as PolygonSector.ambient.
  ambient: number;
  biomeId: string;
  // Optional discriminator. Set on building-cube sectors so
  // colored-mesh passes can skip them when a textured shell
  // exists.
  buildingKind?: string;
  // Per-sector noise displacement applied on top of the flat
  // floor/ceiling. Falloff at the polygon perimeter at runtime
  // keeps portals seamless. Mirrors `CsgShape.floorNoise`.
  floorNoise?: import('./terrain').TerrainConfig;
  ceilingNoise?: import('./terrain').TerrainConfig;
};

export type LinedefMap = {
  vertices: Vec2[];
  linedefs: Linedef[];
  sidedefs: Sidedef[];
  sectors: LinedefSector[];
  // Reuse the existing scene-light shape. Lights aren't part of
  // the geometry graph; they live in world space and reference
  // sectors only via `reachableSectors` (an offline cull list).
  lights: SectorLight[];
  bounds: { x: number; y: number; w: number; h: number };
};

export type LinedefScene = {
  id: string;
  name: string;
  biome: string;
  map: LinedefMap;
  interactables: import('./protocol').Interactable[];
  anchors?: import('./protocol').SceneAnchor[];
  spawn: Vec2;
  // Explicit spawn Z override. When omitted, the server uses
  // spawnFloorAt(spawn.x, spawn.y).
  spawnZ?: number;
  terrain?: import('./terrain').TerrainConfig;
  meta?: {
    author?: string;
    createdAt?: string;
    modifiedAt?: string;
  };
};

// ---------- Polygon → Linedef converter ----------

const VERTEX_EPS = 0.5; // world units. Author snap-to-grid is
                        // 0.5+ wu so colocated verts collapse
                        // without false-merging distinct corners.

export type PolygonToLinedefOpts = {
  // Run splitOverlappingWalls + riserifyWalls on a clone of the
  // input before converting. Bakes the runtime patches into
  // static linedef topology so the resulting scene needs no
  // further fixup. Default true.
  applyRuntimePatches?: boolean;
};

// Convert a polygon-shaped SectorMap to the linedef shape. Pure
// — does NOT mutate the input (clones internally when running
// the runtime patches).
export function polygonMapToLinedefMap(
  src: PolygonSectorMap,
  opts: PolygonToLinedefOpts = {},
): LinedefMap {
  const applyPatches = opts.applyRuntimePatches !== false;
  // Clone before patching so the caller's input stays intact.
  const work: PolygonSectorMap = applyPatches
    ? clonePolygonMap(src)
    : src;
  if (applyPatches) {
    splitOverlappingWalls(work);
    riserifyWalls(work);
  }

  // Step 1: dedup vertices. Build a (sectorId, vertIdx) →
  // globalVertexId table along the way.
  const vertices: Vec2[] = [];
  const vertOf: Map<string, number> = new Map();
  const polyVertToGlobal: Map<string, number> = new Map();
  function internVertex(v: Vec2): number {
    // Quantise to EPS to coalesce floating-point drift.
    const qx = Math.round(v.x / VERTEX_EPS) * VERTEX_EPS;
    const qy = Math.round(v.y / VERTEX_EPS) * VERTEX_EPS;
    const key = `${qx},${qy}`;
    const existing = vertOf.get(key);
    if (existing !== undefined) return existing;
    const idx = vertices.length;
    vertices.push({ x: qx, y: qy });
    vertOf.set(key, idx);
    return idx;
  }
  for (const sector of work.sectors) {
    for (let i = 0; i < sector.verts.length; i++) {
      const gid = internVertex(sector.verts[i]);
      polyVertToGlobal.set(`${sector.id}:${i}`, gid);
    }
  }

  // Step 2: bucket walls by undirected edge. Filter out lintel
  // duplicates (a second wall on the same (sectorId, vertIdx)
  // with riserifyWalls-style overrides describing a slab above
  // the back-sector ceiling). The lintel is implicit in
  // upper-texture rendering on the resulting linedef.
  type WallRef = {
    wall: PolygonWall;
    sectorId: number;
    v1: number;
    v2: number;
    // Direction this wall would face if linedef.v1→v2 follows
    // the polygon's CCW winding from this sector.
    forward: boolean;
  };
  const edgeBuckets: Map<string, WallRef[]> = new Map();
  function edgeKey(g1: number, g2: number): string {
    return g1 < g2 ? `${g1}-${g2}` : `${g2}-${g1}`;
  }
  const wallSeenAtSlot: Set<string> = new Set();
  for (const wall of work.walls) {
    const owner = work.sectors[wall.sectorId];
    if (!owner) continue;
    if (owner.verts.length < 3) continue;
    if (wall.vertIdx < 0 || wall.vertIdx >= owner.verts.length) continue;
    // Lintel dedup: keep only the first wall encountered per
    // (sectorId, vertIdx) — the original. Lintels get pushed
    // after the original by riserifyWalls and carry overrides
    // above the sector floor; we drop them since the linedef
    // upper-texture path covers the same visual.
    const slot = `${wall.sectorId}:${wall.vertIdx}`;
    if (wallSeenAtSlot.has(slot)) continue;
    wallSeenAtSlot.add(slot);

    const g1 = polyVertToGlobal.get(slot)!;
    const g2 = polyVertToGlobal.get(
      `${wall.sectorId}:${(wall.vertIdx + 1) % owner.verts.length}`,
    )!;
    if (g1 === g2) continue; // degenerate
    const k = edgeKey(g1, g2);
    let bucket = edgeBuckets.get(k);
    if (!bucket) {
      bucket = [];
      edgeBuckets.set(k, bucket);
    }
    bucket.push({ wall, sectorId: wall.sectorId, v1: g1, v2: g2, forward: true });
  }

  // Step 3: emit one linedef per edge bucket. One-sided buckets
  // produce a solid linedef; two-sided buckets pair front/back.
  // 3+ are degenerate (should not happen on well-formed input);
  // we keep the first two and log via a runtime-friendly stub.
  const linedefs: Linedef[] = [];
  const sidedefs: Sidedef[] = [];
  function makeSidedef(wall: PolygonWall): number {
    const idx = sidedefs.length;
    sidedefs.push({
      sectorId: wall.sectorId,
      midTex: wall.textureId,
      upperTex: wall.textureId,
      lowerTex: wall.textureId,
      texOffsetX: 0,
      texOffsetY: 0,
    });
    return idx;
  }
  for (const [, bucket] of edgeBuckets) {
    if (bucket.length === 0) continue;
    const a = bucket[0];
    if (bucket.length === 1) {
      // One-sided wall. Direction = polygon winding.
      const front = makeSidedef(a.wall);
      linedefs.push({
        v1: a.v1,
        v2: a.v2,
        front,
        back: null,
        impassable: a.wall.solid,
        blockProjectiles: a.wall.solid,
        blockMonsters: a.wall.solid,
      });
    } else {
      // Two-sided. Pick deterministic front (smaller sector id).
      // Direction follows the front's winding.
      let frontRef = a;
      let backRef = bucket[1];
      if (backRef.sectorId < frontRef.sectorId) {
        [frontRef, backRef] = [backRef, frontRef];
      }
      const front = makeSidedef(frontRef.wall);
      const back = makeSidedef(backRef.wall);
      // Use the front's directed edge.
      const v1 = frontRef.v1;
      const v2 = frontRef.v2;
      // A two-sided linedef defaults all-passable. If both
      // walls were authored solid (e.g. an editor mistake) we
      // honour the stricter side — solid wins.
      const impassable =
        frontRef.wall.solid && backRef.wall.solid;
      linedefs.push({
        v1,
        v2,
        front,
        back,
        impassable,
        blockProjectiles: impassable,
        blockMonsters: impassable,
      });
    }
  }

  // Step 4: sectors. Drop verts; copy metadata.
  const sectors: LinedefSector[] = work.sectors.map((s) => ({
    id: s.id,
    floorZ: s.floorZ,
    ceilingZ: s.ceilingZ,
    floorTextureId: s.floorTextureId,
    ceilingTextureId: s.ceilingTextureId,
    ambient: s.ambient,
    biomeId: s.biomeId,
    buildingKind: s.buildingKind,
  }));

  return {
    vertices,
    linedefs,
    sidedefs,
    sectors,
    lights: work.lights.map((l) => ({ ...l })),
    bounds: { ...work.bounds },
  };
}

export function polygonSceneToLinedefScene(
  src: PolygonSectorScene,
  opts: PolygonToLinedefOpts = {},
): LinedefScene {
  return {
    id: src.id,
    name: src.name,
    biome: src.biome,
    map: polygonMapToLinedefMap(src.map, opts),
    interactables: src.interactables.map((i) => ({ ...i })),
    anchors: src.anchors?.map((a) => ({ ...a })),
    spawn: { ...src.spawn },
    terrain: src.terrain ? { ...src.terrain } : undefined,
    meta: src.meta ? { ...src.meta } : undefined,
  };
}

// ---------- Sector polygon derivation ----------
//
// Walk each sector's incident linedefs to assemble its perimeter
// vertex loop in CCW order. Exposed for editor rendering, picking,
// and any consumer that needs polygon-shaped sector geometry
// without going through the full polygon-SectorMap rebuild.
//
// Limitations: single-loop sectors only (no holes / donuts).
// Donut sectors are uncommon in our current content; revisit if
// procgen produces them.

function buildSectorAdjacency(
  src: LinedefMap,
): Map<number, Map<number, Array<{ ldIdx: number; side: 'front' | 'back' }>>> {
  const perSectorAdj = new Map<
    number,
    Map<number, Array<{ ldIdx: number; side: 'front' | 'back' }>>
  >();
  function getAdj(
    sectorId: number,
  ): Map<number, Array<{ ldIdx: number; side: 'front' | 'back' }>> {
    let a = perSectorAdj.get(sectorId);
    if (!a) {
      a = new Map();
      perSectorAdj.set(sectorId, a);
    }
    return a;
  }
  function addIncidence(
    sectorId: number,
    vertexId: number,
    ldIdx: number,
    side: 'front' | 'back',
  ): void {
    const a = getAdj(sectorId);
    let list = a.get(vertexId);
    if (!list) {
      list = [];
      a.set(vertexId, list);
    }
    list.push({ ldIdx, side });
  }
  // Skip sentinel-owned sidedefs (authoring-time placeholders
  // for linedefs not yet adopted by any real sector). Without
  // this guard, a dangling draw-chain pointing at the placeholder
  // sector poisons that sector's perimeter walk.
  for (let i = 0; i < src.linedefs.length; i++) {
    const ld = src.linedefs[i];
    const frontSector = src.sidedefs[ld.front]?.sectorId;
    if (frontSector !== undefined && frontSector !== SENTINEL_SECTOR_ID) {
      addIncidence(frontSector, ld.v1, i, 'front');
      addIncidence(frontSector, ld.v2, i, 'front');
    }
    if (ld.back !== null) {
      const backSector = src.sidedefs[ld.back]?.sectorId;
      if (backSector !== undefined && backSector !== SENTINEL_SECTOR_ID) {
        addIncidence(backSector, ld.v1, i, 'back');
        addIncidence(backSector, ld.v2, i, 'back');
      }
    }
  }
  return perSectorAdj;
}

// Per-sector polygon verts in CCW order, derived from the linedef
// graph. Returns null entries for sectors whose loop couldn't be
// closed (degenerate / not-yet-connected during authoring).
//
// For sectors with HOLES (carved sub-regions like pits / vents
// inside an outer room), this returns only the OUTER loop. Use
// `deriveSectorLoops` to get the holes too.
export function deriveSectorPolygons(
  src: LinedefMap,
): Map<number, Vec2[] | null> {
  const allLoops = deriveSectorLoops(src);
  const out = new Map<number, Vec2[] | null>();
  for (const sector of src.sectors) {
    const loops = allLoops.get(sector.id);
    if (!loops) {
      out.set(sector.id, null);
      continue;
    }
    out.set(sector.id, loops.outer);
  }
  return out;
}

// Per-sector OUTER perimeter + any HOLE loops. Sectors with carved
// sub-regions (pit / vent / window inside an outer room) produce
// one outer loop and one or more holes. Used by the reverse
// converter (so inner-loop linedefs emit as walls too — risers,
// lintels, etc.) and by the renderer (polygon-with-holes
// triangulation for floor / ceiling meshes).
//
// Outer loop is CCW-wound, holes are CW-wound (earcut convention).
//
// Limitations: assumes well-formed topology where each vertex has
// at most 2 linedefs incident per sector. Junctions with 3+
// incidents per sector are degenerate and can produce surprising
// loop walks; validation should flag them.
export type SectorLoops = {
  outer: Vec2[];
  holes: Vec2[][];
  // The linedef + side sequence for each loop, in walk order.
  // Used by the reverse converter to emit walls for every loop
  // (not just the outer).
  loopLinedefs: Array<{
    vertexIds: number[];
    linedefIds: number[];
    sides: Array<'front' | 'back'>;
  }>;
};

export function deriveSectorLoops(
  src: LinedefMap,
): Map<number, SectorLoops> {
  const adjBySector = buildSectorAdjacency(src);
  const out = new Map<number, SectorLoops>();
  for (const sector of src.sectors) {
    const adj = adjBySector.get(sector.id);
    if (!adj || adj.size < 3) continue;
    // Walk every linedef incident to this sector that hasn't been
    // visited yet. Each walk yields one closed loop.
    const visited = new Set<number>();
    const rawLoops: Array<{
      vertexIds: number[];
      linedefIds: number[];
      sides: Array<'front' | 'back'>;
      area: number;
    }> = [];
    for (const [startVid, incidents] of adj) {
      for (const startInc of incidents) {
        if (visited.has(startInc.ldIdx)) continue;
        // Only START a walk from a vertex that is the
        // walk-direction origin for this side: front starts at v1
        // and walks toward v2; back starts at v2 and walks toward
        // v1. The other-endpoint entries in adj are still useful
        // mid-walk (they're incoming, not outgoing), so we don't
        // remove them from adj — we just skip them as start points.
        const sld = src.linedefs[startInc.ldIdx];
        if (!sld) continue;
        const startOriginV = startInc.side === 'front' ? sld.v1 : sld.v2;
        if (startOriginV !== startVid) continue;
        const loop = walkOneLoop(adj, src, startVid, startInc, visited);
        if (!loop) continue;
        const area = signedAreaIds(loop.vertexIds, src.vertices);
        rawLoops.push({ ...loop, area });
      }
    }
    if (rawLoops.length === 0) continue;
    // Pick the loop with the largest absolute area as the outer
    // perimeter; the rest are holes.
    rawLoops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const outerRaw = rawLoops[0];
    const holesRaw = rawLoops.slice(1);
    // Normalise winding: outer = CCW (positive area), holes = CW
    // (negative area). When reversing, KEEP the first vertex in
    // place and reverse the rest — a naive .reverse() puts the
    // start vertex at the end, which misaligns vertexIds with
    // linedefIds (linedefIds[i] connects vertexIds[i] and
    // vertexIds[(i+1)%n], so the start vertex must stay at index
    // 0). Symptom of the misalignment: every wall emits at a
    // bogus endpoint and the room renders with random missing
    // walls.
    function reverseLoop<T extends { vertexIds: number[]; linedefIds: number[]; sides: Array<'front' | 'back'> }>(
      raw: T,
    ): T {
      const v = raw.vertexIds;
      const rotated = [v[0], ...v.slice(1).reverse()];
      return {
        ...raw,
        vertexIds: rotated,
        linedefIds: raw.linedefIds.slice().reverse(),
        sides: raw.sides.slice().reverse(),
      };
    }
    const outerNormalised =
      outerRaw.area >= 0 ? outerRaw : reverseLoop(outerRaw);
    const holesNormalised = holesRaw.map((h) =>
      h.area <= 0 ? h : reverseLoop(h),
    );
    const outer = outerNormalised.vertexIds.map((v) => ({
      ...src.vertices[v],
    }));
    const holes = holesNormalised.map((h) =>
      h.vertexIds.map((v) => ({ ...src.vertices[v] })),
    );
    const loopLinedefs: SectorLoops['loopLinedefs'] = [
      {
        vertexIds: outerNormalised.vertexIds,
        linedefIds: outerNormalised.linedefIds,
        sides: outerNormalised.sides,
      },
      ...holesNormalised.map((h) => ({
        vertexIds: h.vertexIds,
        linedefIds: h.linedefIds,
        sides: h.sides,
      })),
    ];
    out.set(sector.id, { outer, holes, loopLinedefs });
  }
  return out;
}

// Walk one closed loop in the sector adjacency starting at the
// given vertex + incident. Marks visited linedefs in `visited`.
//
// Rules:
// - Each linedef is walked in a single direction tied to its side
//   for the sector being traced: front → v1→v2, back → v2→v1.
//   At each vertex, only OUTGOING candidates (the side's walk
//   starts at this vertex) are considered. The other-endpoint
//   adj entries are silently skipped — they're the incoming side
//   of edges we already walked or that another vertex will walk.
// - At 3+ way junctions, pick the outgoing candidate that turns
//   LEFT the most relative to the incoming direction (the largest
//   CCW angle from the back-direction curVertex→prevVertex). This
//   is the canonical "next edge in face" rotation rule and keeps
//   the sector face consistently on the left throughout the walk.
function walkOneLoop(
  adj: Map<number, Array<{ ldIdx: number; side: 'front' | 'back' }>>,
  src: LinedefMap,
  startVid: number,
  startInc: { ldIdx: number; side: 'front' | 'back' },
  visited: Set<number>,
): {
  vertexIds: number[];
  linedefIds: number[];
  sides: Array<'front' | 'back'>;
} | null {
  const startLd = src.linedefs[startInc.ldIdx];
  if (!startLd) return null;
  // First step: walk startLd in the direction implied by its side.
  const firstNext =
    startInc.side === 'front' ? startLd.v2 : startLd.v1;

  const vertexIds: number[] = [startVid];
  const linedefIds: number[] = [startInc.ldIdx];
  const sides: Array<'front' | 'back'> = [startInc.side];
  visited.add(startInc.ldIdx);

  let curVertex = firstNext;
  let prevVertex = startVid;
  let prevLd = startInc.ldIdx;
  const maxSteps = src.linedefs.length + 2;
  for (let step = 0; step < maxSteps; step++) {
    if (curVertex === startVid) {
      if (linedefIds.length < 3) return null;
      return { vertexIds, linedefIds, sides };
    }
    vertexIds.push(curVertex);
    const candidates = adj.get(curVertex);
    if (!candidates) return null;
    const cv = src.vertices[curVertex];
    const pv = src.vertices[prevVertex];
    if (!cv || !pv) return null;
    const backAngle = Math.atan2(pv.y - cv.y, pv.x - cv.x);
    let chosen: { ldIdx: number; side: 'front' | 'back' } | null = null;
    let chosenNextV: number = -1;
    let bestDelta = -Infinity;
    for (const c of candidates) {
      if (c.ldIdx === prevLd) continue;
      if (visited.has(c.ldIdx)) continue;
      const ld = src.linedefs[c.ldIdx];
      if (!ld) continue;
      // Outgoing iff curVertex is the walk-origin for this side.
      const originV = c.side === 'front' ? ld.v1 : ld.v2;
      if (originV !== curVertex) continue;
      const nextV = c.side === 'front' ? ld.v2 : ld.v1;
      const nv = src.vertices[nextV];
      if (!nv) continue;
      const outAngle = Math.atan2(nv.y - cv.y, nv.x - cv.x);
      let delta = outAngle - backAngle;
      while (delta <= 0) delta += 2 * Math.PI;
      while (delta > 2 * Math.PI) delta -= 2 * Math.PI;
      if (delta > bestDelta) {
        bestDelta = delta;
        chosen = c;
        chosenNextV = nextV;
      }
    }
    if (!chosen || chosenNextV < 0) return null;
    visited.add(chosen.ldIdx);
    linedefIds.push(chosen.ldIdx);
    sides.push(chosen.side);
    prevLd = chosen.ldIdx;
    prevVertex = curVertex;
    curVertex = chosenNextV;
  }
  return null;
}

function signedAreaIds(vertexIds: number[], vertices: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < vertexIds.length; i++) {
    const a = vertices[vertexIds[i]];
    const b = vertices[vertexIds[(i + 1) % vertexIds.length]];
    s += a.x * b.y - b.x * a.y;
  }
  return s * 0.5;
}

// ---------- Linedef → Polygon reverse converter ----------
//
// Walks each sector's incident linedefs to assemble a vertex
// loop, then emits a PolygonSectorMap with one wall per linedef-
// side. Used during migration so v1 callsites that still want
// polygon-shaped data can consume linedef-shaped storage.
//
// Limitations: single-loop sectors only (no holes / donuts).
// Donut sectors are uncommon in our current content; revisit
// if procgen produces them.

export function linedefMapToPolygonMap(src: LinedefMap): PolygonSectorMap {
  // Build per-sector adjacency: vertex id → list of incident
  // linedef indices (with which side of each linedef faces the
  // sector).
  type Adjacency = Map<number, Array<{ ldIdx: number; side: 'front' | 'back' }>>;
  const perSectorAdj: Map<number, Adjacency> = new Map();
  function getAdj(sectorId: number): Adjacency {
    let a = perSectorAdj.get(sectorId);
    if (!a) {
      a = new Map();
      perSectorAdj.set(sectorId, a);
    }
    return a;
  }
  function addIncidence(
    sectorId: number,
    vertexId: number,
    ldIdx: number,
    side: 'front' | 'back',
  ): void {
    const a = getAdj(sectorId);
    let list = a.get(vertexId);
    if (!list) {
      list = [];
      a.set(vertexId, list);
    }
    list.push({ ldIdx, side });
  }
  for (let i = 0; i < src.linedefs.length; i++) {
    const ld = src.linedefs[i];
    const frontSector = src.sidedefs[ld.front]?.sectorId;
    if (frontSector !== undefined && frontSector !== SENTINEL_SECTOR_ID) {
      addIncidence(frontSector, ld.v1, i, 'front');
      addIncidence(frontSector, ld.v2, i, 'front');
    }
    if (ld.back !== null) {
      const backSector = src.sidedefs[ld.back]?.sectorId;
      if (backSector !== undefined && backSector !== SENTINEL_SECTOR_ID) {
        addIncidence(backSector, ld.v1, i, 'back');
        addIncidence(backSector, ld.v2, i, 'back');
      }
    }
  }

  // Walk every closed loop in each sector's adjacency (one outer
  // + zero or more holes for carved sub-sectors). Then emit a
  // wall per loop edge across ALL loops — the inner-loop edges
  // are the riser/lintel faces around pits, vents, windows. Walls
  // carry explicit endpoint coords (ax/ay/bx/by) so the renderer
  // doesn't need to figure out which loop in sector.verts owns
  // them — sector.verts stays as the OUTER perimeter only;
  // sector.holes carries the inner rings for floor/ceiling
  // polygon-with-holes triangulation.
  const sectorLoops = deriveSectorLoops(src);
  // Index each derived sector's outer polygon + area + heights so
  // the wall pass can geometrically locate a "shadow parent" for
  // each one-sided wall: the sector that geometrically contains
  // the area immediately inside the wall but doesn't appear on
  // the linedef's sides (because a sub-sector took the front
  // claim). We need this to render the missing wall slices when
  // a platform / vent / etc. touches a parent room's outer wall.
  type ShadowEntry = {
    poly: Vec2[];
    area: number;
    floorZ: number;
    ceilingZ: number;
  };
  const shadowIndex = new Map<number, ShadowEntry>();
  for (const ls of src.sectors) {
    const loops = sectorLoops.get(ls.id);
    if (!loops) continue;
    let signed = 0;
    for (let i = 0; i < loops.outer.length; i++) {
      const p = loops.outer[i];
      const q = loops.outer[(i + 1) % loops.outer.length];
      signed += p.x * q.y - q.x * p.y;
    }
    shadowIndex.set(ls.id, {
      poly: loops.outer,
      area: Math.abs(signed) * 0.5,
      floorZ: ls.floorZ,
      ceilingZ: ls.ceilingZ,
    });
  }
  function findShadowParent(
    ax: number, ay: number, bx: number, by: number,
    excludeSectorId: number,
  ): ShadowEntry | null {
    // Sample 0.5wu LEFT of the directed edge a→b (sector being
    // walked is on the LEFT of the loop direction). Skips the
    // wall's own sector and picks the SMALLEST containing sector
    // (the immediate parent if any).
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const lx = -dy / len;
    const ly = dx / len;
    const mx = (ax + bx) * 0.5 + lx * 0.5;
    const my = (ay + by) * 0.5 + ly * 0.5;
    let best: ShadowEntry | null = null;
    let bestArea = Infinity;
    for (const [sid, entry] of shadowIndex) {
      if (sid === excludeSectorId) continue;
      if (!pointInPolygon(entry.poly, mx, my)) continue;
      if (entry.area < bestArea) {
        bestArea = entry.area;
        best = entry;
      }
    }
    return best;
  }
  const sectors: PolygonSector[] = [];
  const walls: PolygonWall[] = [];
  for (const ls of src.sectors) {
    const loops = sectorLoops.get(ls.id);
    if (!loops) continue;
    sectors.push({
      id: ls.id,
      verts: loops.outer.map((v) => ({ ...v })),
      holes: loops.holes.length > 0
        ? loops.holes.map((h) => h.map((v) => ({ ...v })))
        : undefined,
      floorZ: ls.floorZ,
      ceilingZ: ls.ceilingZ,
      floorTextureId: ls.floorTextureId,
      ceilingTextureId: ls.ceilingTextureId,
      ambient: ls.ambient,
      biomeId: ls.biomeId,
      buildingKind: ls.buildingKind,
      floorNoise: ls.floorNoise,
      ceilingNoise: ls.ceilingNoise,
    });
    for (let loopIdx = 0; loopIdx < loops.loopLinedefs.length; loopIdx++) {
      const loop = loops.loopLinedefs[loopIdx];
      const loopN = loop.vertexIds.length;
      for (let i = 0; i < loopN; i++) {
        const ldIdx = loop.linedefIds[i];
        const ld = src.linedefs[ldIdx];
        const side = loop.sides[i];
        const ownSidedef =
          side === 'front' ? src.sidedefs[ld.front] : src.sidedefs[ld.back!];
        const otherSidedefIdx = side === 'front' ? ld.back : ld.front;
        const otherSectorId =
          otherSidedefIdx !== null && otherSidedefIdx !== undefined
            ? src.sidedefs[otherSidedefIdx]?.sectorId ?? null
            : null;
        const otherSector =
          otherSectorId !== null
            ? src.sectors.find((s) => s.id === otherSectorId) ?? null
            : null;
        const isOneSided = ld.back === null;
        let floorZOverride: number | undefined;
        let ceilingZOverride: number | undefined;
        if (!isOneSided && otherSector) {
          if (ls.floorZ > otherSector.floorZ) {
            floorZOverride = otherSector.floorZ;
            ceilingZOverride = ls.floorZ;
          }
        }
        const aId = loop.vertexIds[i];
        const bId = loop.vertexIds[(i + 1) % loopN];
        const a = src.vertices[aId];
        const b = src.vertices[bId];
        // Shadow-parent extension for one-sided walls: when a
        // platform / vent / etc. shares an edge with the
        // surrounding room's outer wall, the carve transferred
        // the front claim to the sub-sector, leaving the parent
        // room with no linedef on that edge. Geometrically the
        // parent still extends to the edge from z=parent.floorZ
        // to z=sub.floorZ (and from z=sub.ceilingZ to
        // z=parent.ceilingZ if heights mismatch the other way).
        // Detect this via a smallest-containing lookup INSIDE
        // the wall's front side and extend the wall's z-extent
        // to cover the gap.
        let shadowFloorExtend: number | null = null;
        let shadowCeilingExtend: number | null = null;
        if (isOneSided && a && b) {
          const shadow = findShadowParent(a.x, a.y, b.x, b.y, ls.id);
          if (shadow) {
            if (shadow.floorZ < ls.floorZ) shadowFloorExtend = shadow.floorZ;
            if (shadow.ceilingZ > ls.ceilingZ) shadowCeilingExtend = shadow.ceilingZ;
          }
        }
        // Main wall record. When a shadow parent extends the
        // floor downward, lower this wall's bottom (so it covers
        // parent.floorZ..ls.ceilingZ in one quad) and let the
        // server collision treat the bottom as the parent's
        // floor too (so a crouching player can't slip under).
        const effectiveFloorZOverride =
          shadowFloorExtend !== null && floorZOverride === undefined
            ? shadowFloorExtend
            : floorZOverride;
        walls.push({
          sectorId: ls.id,
          vertIdx: i,
          ax: a?.x,
          ay: a?.y,
          bx: b?.x,
          by: b?.y,
          backSectorId: otherSectorId,
          textureId: ownSidedef?.midTex ?? null,
          // Preserve the linedef's impassable flag verbatim — a
          // two-sided linedef can describe either a portal
          // (impassable=false) or a sealed dividing wall
          // (impassable=true, e.g. a procgen-emitted room
          // partition that hasn't had a doorway punched into
          // it). Forcing two-sided → solid:false collapsed the
          // BSP regions into one giant room because every
          // shared edge was treated as a portal regardless of
          // procgen intent.
          solid: ld.impassable,
          floorZOverride: effectiveFloorZOverride,
          ceilingZOverride,
          buildingKind: ls.buildingKind,
        });
        if (
          !isOneSided &&
          otherSector &&
          ls.ceilingZ > otherSector.ceilingZ
        ) {
          walls.push({
            sectorId: ls.id,
            vertIdx: i,
            ax: a?.x,
            ay: a?.y,
            bx: b?.x,
            by: b?.y,
            backSectorId: otherSectorId,
            textureId: ownSidedef?.upperTex ?? ownSidedef?.midTex ?? null,
            solid: true,
            floorZOverride: otherSector.ceilingZ,
            ceilingZOverride: ls.ceilingZ,
            buildingKind: ls.buildingKind,
          });
        }
        // One-sided wall with a shadow parent whose ceiling is
        // ABOVE this sector's: emit an extra "upper" quad from
        // ls.ceilingZ to shadow.ceilingZ so the parent room's
        // wall isn't missing the slice above a vent / window.
        if (isOneSided && shadowCeilingExtend !== null && a && b) {
          walls.push({
            sectorId: ls.id,
            vertIdx: i,
            ax: a.x,
            ay: a.y,
            bx: b.x,
            by: b.y,
            backSectorId: null,
            textureId: ownSidedef?.upperTex ?? ownSidedef?.midTex ?? null,
            solid: true,
            floorZOverride: ls.ceilingZ,
            ceilingZOverride: shadowCeilingExtend,
            buildingKind: ls.buildingKind,
          });
        }
      }
    }
  }

  return {
    sectors,
    walls,
    lights: src.lights.map((l) => ({ ...l })),
    bounds: { ...src.bounds },
  };
}

// ---------- Validation ----------

export type LinedefSceneValidation = {
  errors: string[];
  warnings: string[];
};

export function validateLinedefScene(
  scene: LinedefScene,
): LinedefSceneValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { map } = scene;
  // Structural integrity: every linedef references in-range
  // vertices + sidedefs; every sidedef references an in-range
  // sector.
  for (let i = 0; i < map.linedefs.length; i++) {
    const ld = map.linedefs[i];
    if (ld.v1 < 0 || ld.v1 >= map.vertices.length) {
      errors.push(`Linedef ${i}: v1 out of range (${ld.v1}).`);
    }
    if (ld.v2 < 0 || ld.v2 >= map.vertices.length) {
      errors.push(`Linedef ${i}: v2 out of range (${ld.v2}).`);
    }
    if (ld.v1 === ld.v2) {
      errors.push(`Linedef ${i}: v1 === v2 (degenerate).`);
    }
    if (ld.front < 0 || ld.front >= map.sidedefs.length) {
      errors.push(`Linedef ${i}: front sidedef out of range (${ld.front}).`);
    }
    if (ld.back !== null) {
      if (ld.back < 0 || ld.back >= map.sidedefs.length) {
        errors.push(`Linedef ${i}: back sidedef out of range (${ld.back}).`);
      }
    }
  }
  for (let i = 0; i < map.sidedefs.length; i++) {
    const sd = map.sidedefs[i];
    if (sd.sectorId === SENTINEL_SECTOR_ID) continue;
    if (!map.sectors.some((s) => s.id === sd.sectorId)) {
      errors.push(
        `Sidedef ${i}: references unknown sector ${sd.sectorId}.`,
      );
    }
  }
  // Sector closure: every sector should have a traceable loop
  // (at least three linedefs incident with valid topology).
  const polys = deriveSectorPolygons(map);
  for (const s of map.sectors) {
    const poly = polys.get(s.id);
    if (!poly) {
      warnings.push(
        `Sector ${s.id}: linedef loop not closed (or fewer than 3 linedefs incident).`,
      );
    }
  }
  // Spawn + interactables inside any walkable sector.
  const walkable = map.sectors.filter(
    (s) => s.buildingKind === undefined,
  );
  const inWalkable = (x: number, y: number): boolean => {
    for (const s of walkable) {
      const poly = polys.get(s.id);
      if (!poly) continue;
      let inside = false;
      let j = poly.length - 1;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[j];
        if (
          a.y > y !== b.y > y &&
          x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
        ) {
          inside = !inside;
        }
        j = k;
      }
      if (inside) return true;
    }
    return false;
  };
  if (!inWalkable(scene.spawn.x, scene.spawn.y)) {
    warnings.push(
      `Spawn (${scene.spawn.x}, ${scene.spawn.y}) is not inside any walkable sector.`,
    );
  }
  for (const it of scene.interactables) {
    if (!inWalkable(it.x, it.y)) {
      warnings.push(
        `Interactable "${it.id}" (${it.x}, ${it.y}) is not inside any walkable sector.`,
      );
    }
  }
  const hasExit = scene.interactables.some(
    (i) => i.kind === 'extract_pad' || i.kind === 'stairs_down',
  );
  if (!hasExit) {
    warnings.push(
      `Scene has no extract_pad or stairs_down interactable.`,
    );
  }
  // Orphan vertices (unreferenced by any linedef). Soft warn —
  // editor can compact them on save.
  const usedVerts = new Set<number>();
  for (const ld of map.linedefs) {
    usedVerts.add(ld.v1);
    usedVerts.add(ld.v2);
  }
  let orphanCount = 0;
  for (let i = 0; i < map.vertices.length; i++) {
    if (!usedVerts.has(i)) orphanCount++;
  }
  if (orphanCount > 0) {
    warnings.push(
      `${orphanCount} orphan vertex/vertices (no linedef references). Save with the editor's compact pass to drop them.`,
    );
  }
  return { errors, warnings };
}

// Tagged-union helper for runtime input. The editor + content
// API may serialise either polygon-shaped or linedef-shaped
// scenes; consumers (server hydrate, client renderer) hit this
// to get a polygon-shaped scene back regardless of source.
// Detection is shape-based: a linedef scene has `vertices` +
// `linedefs` at map level; a polygon scene has `sectors[].verts`.
export function coerceToPolygonScene(raw: unknown): PolygonSectorScene {
  if (!raw || typeof raw !== 'object') {
    throw new Error('coerceToPolygonScene: input is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const map = obj.map as Record<string, unknown> | undefined;
  if (!map || typeof map !== 'object') {
    throw new Error('coerceToPolygonScene: missing map field');
  }
  if (Array.isArray(map.linedefs) && Array.isArray(map.vertices)) {
    return linedefSceneToPolygonScene(raw as LinedefScene);
  }
  return raw as PolygonSectorScene;
}

export function linedefSceneToPolygonScene(
  src: LinedefScene,
): PolygonSectorScene {
  return {
    id: src.id,
    name: src.name,
    biome: src.biome,
    map: linedefMapToPolygonMap(src.map),
    interactables: src.interactables.map((i) => ({ ...i })),
    anchors: src.anchors?.map((a) => ({ ...a })),
    spawn: { ...src.spawn },
    spawnZ: src.spawnZ,
    terrain: src.terrain ? { ...src.terrain } : undefined,
    meta: src.meta ? { ...src.meta } : undefined,
  };
}

// Helper — walk an undirected perimeter loop. Returns the loop
// (walkSectorLoop replaced by walkOneLoop + deriveSectorLoops
// above; the single-loop helper is no longer needed.)

// ---------- internal helpers ----------

function clonePolygonMap(src: PolygonSectorMap): PolygonSectorMap {
  return {
    sectors: src.sectors.map((s) => ({
      ...s,
      verts: s.verts.map((v) => ({ ...v })),
    })),
    walls: src.walls.map((w) => ({ ...w })),
    lights: src.lights.map((l) => ({
      ...l,
      reachableSectors: l.reachableSectors
        ? [...l.reachableSectors]
        : undefined,
    })),
    bounds: { ...src.bounds },
  };
}
