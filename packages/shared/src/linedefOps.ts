// Mutation helpers for the linedef scene model. The editor's
// in-memory state is `LinedefScene` (see `./linedef.ts`); these
// helpers produce a *new* map for each edit so the editor's
// undo stack can snapshot before/after states without
// alias-sharing.
//
// Everything here is pure: input map is never mutated; the
// helpers return either the new map or a `{ map, ...refs }`
// shape so the caller can wire up newly-created ids.

import type { Vec2 } from './geometry';
import type {
  Linedef,
  LinedefMap,
  LinedefSector,
  LinedefScene,
  Sidedef,
} from './linedef';
import { deriveSectorPolygons, SENTINEL_SECTOR_ID } from './linedef';
import { pointInPolygon, segmentSegmentIntersect } from './geometry';

// Find an existing sector whose derived polygon contains the
// given point. Used by make-sector to refuse double-fill (which
// would otherwise wire the existing perimeter's single-sided
// walls into two-sided portals and visually erase them).
export function findContainingSectorId(
  map: LinedefMap,
  p: Vec2,
): number | null {
  const polys = deriveSectorPolygons(map);
  // Smallest-area-containing wins so a sub-region painted over
  // a bigger one matches the smaller (more specific) sector.
  let best: number | null = null;
  let bestArea = Infinity;
  for (const [id, verts] of polys) {
    if (!verts) continue;
    if (!pointInPolygon(verts, p.x, p.y)) continue;
    let area = 0;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      area += a.x * b.y - b.x * a.y;
    }
    area = Math.abs(area) * 0.5;
    if (area < bestArea) {
      bestArea = area;
      best = id;
    }
  }
  return best;
}

const VERTEX_DEDUP_EPS = 0.25; // wu — finer than the converter's
                                // EPS so authoring snap-to-grid
                                // (16/32 wu) doesn't accidentally
                                // merge unrelated verts.
// Point-to-segment distance below which a new vertex is treated
// as lying on an existing linedef → auto-split. Loose enough
// that a grid-snapped corner colocated on a wall reliably
// triggers the split.
const VERTEX_ON_LINE_EPS = 0.5;

// ---------- Vertex ops ----------

// Intern a vertex by position with auto-split.
//   1. If any existing vertex is within EPS → return its id
//      (dedup; same point becomes a single shared vert).
//   2. If `p` lies on the interior of any existing linedef
//      (point-to-segment distance < VERTEX_ON_LINE_EPS, with
//      projection parameter strictly between endpoints) → SPLIT
//      that linedef at the projected point and return the new
//      vert's id. This is the move that makes UDB-style authoring
//      work: dropping a corner on a room's wall splits the wall
//      so the wall and the new corner share the vert by
//      construction. Without this, the new corner sits next to
//      the wall and you end up with two overlapping linedefs.
//   3. Otherwise append a fresh vertex.
export function addVertex(
  map: LinedefMap,
  p: Vec2,
): { map: LinedefMap; vertexId: number } {
  for (let i = 0; i < map.vertices.length; i++) {
    const v = map.vertices[i];
    if (
      Math.abs(v.x - p.x) < VERTEX_DEDUP_EPS &&
      Math.abs(v.y - p.y) < VERTEX_DEDUP_EPS
    ) {
      return { map, vertexId: i };
    }
  }
  // Linedef intersection scan. Stop on the first match; a single
  // call only ever splits one linedef. If `p` happens to sit at
  // a T-junction of two collinear lines (rare), both can split
  // across successive addVertex calls.
  for (let i = 0; i < map.linedefs.length; i++) {
    const ld = map.linedefs[i];
    const a = map.vertices[ld.v1];
    const b = map.vertices[ld.v2];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    // Skip if the projection is at or beyond endpoints — dedup
    // would have caught a true endpoint match already, so a
    // projection at t ≈ 0 / 1 is just "near but not on" and we
    // shouldn't split.
    if (t < 0.01 || t > 0.99) continue;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    const ddx = p.x - projX;
    const ddy = p.y - projY;
    if (ddx * ddx + ddy * ddy > VERTEX_ON_LINE_EPS * VERTEX_ON_LINE_EPS) {
      continue;
    }
    const split = splitLinedef(map, i, { x: projX, y: projY });
    if (split) {
      return { map: split.map, vertexId: split.vertexId };
    }
  }
  return {
    map: { ...map, vertices: [...map.vertices, { x: p.x, y: p.y }] },
    vertexId: map.vertices.length,
  };
}

// Move a vertex to a new position. Every linedef that references
// it picks up the new coords automatically (linedefs reference
// the vertex by id, not value).
export function moveVertex(
  map: LinedefMap,
  vertexId: number,
  p: Vec2,
): LinedefMap {
  if (vertexId < 0 || vertexId >= map.vertices.length) return map;
  const vertices = map.vertices.slice();
  vertices[vertexId] = { x: p.x, y: p.y };
  return { ...map, vertices };
}

// Merge `sourceId` into `targetId`: every linedef referencing
// source now references target. Source vertex stays in the array
// (don't compact — would shift every other id); becomes orphan.
// Compact pass is a separate operation.
export function mergeVertices(
  map: LinedefMap,
  sourceId: number,
  targetId: number,
): LinedefMap {
  if (sourceId === targetId) return map;
  if (sourceId < 0 || sourceId >= map.vertices.length) return map;
  if (targetId < 0 || targetId >= map.vertices.length) return map;
  const linedefs = map.linedefs.map((ld) => {
    let { v1, v2 } = ld;
    if (v1 === sourceId) v1 = targetId;
    if (v2 === sourceId) v2 = targetId;
    return v1 === ld.v1 && v2 === ld.v2 ? ld : { ...ld, v1, v2 };
  });
  // Drop linedefs that collapsed to v1 === v2 (degenerate).
  const culled = linedefs.filter((ld) => ld.v1 !== ld.v2);
  return { ...map, linedefs: culled };
}

// Drop unreferenced vertices + sidedefs and rewrite ids. Run
// periodically (e.g. before save) to keep arrays compact.
export function compactMap(map: LinedefMap): LinedefMap {
  // Vertices.
  const usedVerts = new Set<number>();
  for (const ld of map.linedefs) {
    usedVerts.add(ld.v1);
    usedVerts.add(ld.v2);
  }
  const vertOldToNew = new Map<number, number>();
  const newVerts: Vec2[] = [];
  for (let i = 0; i < map.vertices.length; i++) {
    if (!usedVerts.has(i)) continue;
    vertOldToNew.set(i, newVerts.length);
    newVerts.push(map.vertices[i]);
  }
  // Sidedefs.
  const usedSides = new Set<number>();
  for (const ld of map.linedefs) {
    usedSides.add(ld.front);
    if (ld.back !== null) usedSides.add(ld.back);
  }
  const sideOldToNew = new Map<number, number>();
  const newSides: Sidedef[] = [];
  for (let i = 0; i < map.sidedefs.length; i++) {
    if (!usedSides.has(i)) continue;
    sideOldToNew.set(i, newSides.length);
    newSides.push(map.sidedefs[i]);
  }
  // Linedefs (remap).
  const newLines: Linedef[] = map.linedefs.map((ld) => ({
    ...ld,
    v1: vertOldToNew.get(ld.v1)!,
    v2: vertOldToNew.get(ld.v2)!,
    front: sideOldToNew.get(ld.front)!,
    back: ld.back !== null ? sideOldToNew.get(ld.back) ?? null : null,
  }));
  return {
    ...map,
    vertices: newVerts,
    linedefs: newLines,
    sidedefs: newSides,
  };
}

// ---------- Sidedef ops ----------

// Append a new sidedef referencing the given sector. Default
// textures absent (renderer falls back to the biome's authored
// wall texture).
export function addSidedef(
  map: LinedefMap,
  sectorId: number,
): { map: LinedefMap; sidedefId: number } {
  const sd: Sidedef = {
    sectorId,
    midTex: null,
    upperTex: null,
    lowerTex: null,
    texOffsetX: 0,
    texOffsetY: 0,
  };
  return {
    map: { ...map, sidedefs: [...map.sidedefs, sd] },
    sidedefId: map.sidedefs.length,
  };
}

// ---------- Linedef ops ----------

// Add a one-sided linedef from v1 to v2. The front sidedef is
// owned by SENTINEL_SECTOR_ID by default — a real sector takes
// ownership later when the user invokes Make Sector (or the
// draw tool's auto-close) and the linedef's loop is identified.
// Caller can pass an explicit `sectorId` when the linedef
// belongs to a known sector at construction time (rare; the
// tools all defer to the sentinel + reassign flow).
//
// Two transparent fixups happen here:
//   1. EXACT MATCH dedup. If a linedef with the same endpoints
//      (in either direction) already exists, REUSE it instead of
//      duplicating. Adjacent rooms share an edge by construction.
//   2. INTERMEDIATE-VERTEX AUTO-SPLIT. If existing vertices lie
//      strictly on the interior of the new line (e.g. a long
//      wall passes through a smaller room's corner verts), build
//      a CHAIN of sub-linedefs through them instead of one long
//      one. This is what makes hallway-into-room and adjacent-
//      rect-room authoring produce correct shared edges instead
//      of phantom overlapping linedefs.
export function addLinedef(
  map: LinedefMap,
  v1: number,
  v2: number,
  sectorId: number = SENTINEL_SECTOR_ID,
): { map: LinedefMap; linedefId: number } {
  // Endpoint match → reuse.
  for (let i = 0; i < map.linedefs.length; i++) {
    const ld = map.linedefs[i];
    if ((ld.v1 === v1 && ld.v2 === v2) || (ld.v1 === v2 && ld.v2 === v1)) {
      return { map, linedefId: i };
    }
  }
  const a = map.vertices[v1];
  const b = map.vertices[v2];
  if (!a || !b) return { map, linedefId: -1 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { map, linedefId: -1 };
  const T_EPS = 0.01;
  const PERP_EPS = 0.5;

  // STEP A: split any EXISTING linedef whose segment the new
  // line crosses at the interior of BOTH segments. Calls
  // addVertex at each intersection point, which auto-splits the
  // existing line — and inserts a new vertex into the map. The
  // intermediate-vertex scan below then picks up that vertex as
  // a chain stop.
  //
  // Without this step, a new wall drawn ACROSS an existing wall
  // (room edge crossing room edge, pit edge crossing a room
  // boundary) ends up as two co-located linedefs in space with
  // no shared identity — both render as separate walls, both
  // block movement, and the user can't pass between rooms even
  // though geometrically there's a portal.
  let working = map;
  const startCount = working.linedefs.length;
  for (let i = 0; i < startCount; i++) {
    const ld = working.linedefs[i];
    if (ld.v1 === v1 || ld.v1 === v2) continue;
    if (ld.v2 === v1 || ld.v2 === v2) continue;
    const c = working.vertices[ld.v1];
    const d = working.vertices[ld.v2];
    if (!c || !d) continue;
    const t = segmentSegmentIntersect(
      a.x, a.y, b.x, b.y,
      c.x, c.y, d.x, d.y,
    );
    if (t === null) continue;
    if (t < T_EPS || t > 1 - T_EPS) continue;
    // Also require the intersection to be in the interior of CD
    // (not at its endpoints — if it were, the new line would
    // pass through an existing vertex and the intermediate
    // scan would handle it). Re-derive u on CD from t.
    const ix = a.x + t * dx;
    const iy = a.y + t * dy;
    const cdx = d.x - c.x;
    const cdy = d.y - c.y;
    const cdLenSq = cdx * cdx + cdy * cdy;
    if (cdLenSq === 0) continue;
    const u = ((ix - c.x) * cdx + (iy - c.y) * cdy) / cdLenSq;
    if (u < T_EPS || u > 1 - T_EPS) continue;
    // addVertex auto-splits CD at the intersection point.
    const r = addVertex(working, { x: ix, y: iy });
    working = r.map;
  }

  // STEP B: scan vertices on the new line's interior (existing +
  // any just inserted by STEP A) and chain through them.
  const aNow = working.vertices[v1];
  const bNow = working.vertices[v2];
  if (!aNow || !bNow) return { map: working, linedefId: -1 };
  const dxNow = bNow.x - aNow.x;
  const dyNow = bNow.y - aNow.y;
  const lenSqNow = dxNow * dxNow + dyNow * dyNow;
  if (lenSqNow === 0) return { map: working, linedefId: -1 };
  const intermediates: Array<{ vid: number; t: number }> = [];
  for (let i = 0; i < working.vertices.length; i++) {
    if (i === v1 || i === v2) continue;
    const p = working.vertices[i];
    const t = ((p.x - aNow.x) * dxNow + (p.y - aNow.y) * dyNow) / lenSqNow;
    if (t < T_EPS || t > 1 - T_EPS) continue;
    const px = aNow.x + t * dxNow;
    const py = aNow.y + t * dyNow;
    const ddx = p.x - px;
    const ddy = p.y - py;
    if (ddx * ddx + ddy * ddy > PERP_EPS * PERP_EPS) continue;
    intermediates.push({ vid: i, t });
  }
  if (intermediates.length === 0) {
    return addSingleLinedef(working, v1, v2, sectorId);
  }
  intermediates.sort((x, y) => x.t - y.t);
  let prevVid = v1;
  let firstLdId = -1;
  for (const m of intermediates) {
    const r = addSingleLinedef(working, prevVid, m.vid, sectorId);
    working = r.map;
    if (firstLdId === -1) firstLdId = r.linedefId;
    prevVid = m.vid;
  }
  const last = addSingleLinedef(working, prevVid, v2, sectorId);
  if (firstLdId === -1) firstLdId = last.linedefId;
  return { map: last.map, linedefId: firstLdId };
}

// The simple add — also handles endpoint-dedup so chain segments
// from the splitting branch correctly reuse existing edges.
function addSingleLinedef(
  map: LinedefMap,
  v1: number,
  v2: number,
  sectorId: number,
): { map: LinedefMap; linedefId: number } {
  for (let i = 0; i < map.linedefs.length; i++) {
    const ld = map.linedefs[i];
    if ((ld.v1 === v1 && ld.v2 === v2) || (ld.v1 === v2 && ld.v2 === v1)) {
      return { map, linedefId: i };
    }
  }
  const withFront = addSidedef(map, sectorId);
  const ld: Linedef = {
    v1,
    v2,
    front: withFront.sidedefId,
    back: null,
    impassable: true,
    blockProjectiles: true,
    blockMonsters: true,
  };
  return {
    map: { ...withFront.map, linedefs: [...withFront.map.linedefs, ld] },
    linedefId: withFront.map.linedefs.length,
  };
}

// Split a linedef at world-coord `p`. Inserts a new vertex along
// the segment, then replaces the original linedef with two
// adjacent sub-linedefs sharing the new vert. Metadata + sidedef
// refs are cloned onto both halves (the original front sidedef
// is reused on the first half; a new sidedef is appended for the
// second half so subsequent edits to one side don't bleed onto
// the other).
export function splitLinedef(
  map: LinedefMap,
  linedefId: number,
  p: Vec2,
): { map: LinedefMap; vertexId: number; newLinedefId: number } | null {
  if (linedefId < 0 || linedefId >= map.linedefs.length) return null;
  const ld = map.linedefs[linedefId];
  const a = map.vertices[ld.v1];
  const b = map.vertices[ld.v2];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return null;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  if (t < 0.01 || t > 0.99) return null;
  const insertion: Vec2 = {
    x: a.x + t * dx,
    y: a.y + t * dy,
  };
  // Add new vertex (always a fresh id — dedup would defeat the
  // split if there happens to be a coincident vert).
  const newVertId = map.vertices.length;
  const verticesNext = [...map.vertices, insertion];
  // Clone sidedefs for the second half so per-side texture
  // edits don't bleed.
  const frontSrc = map.sidedefs[ld.front];
  const newFront = map.sidedefs.length;
  const sidedefsNext = [...map.sidedefs, { ...frontSrc }];
  let backForSecondHalf: number | null = null;
  if (ld.back !== null) {
    const backSrc = map.sidedefs[ld.back];
    backForSecondHalf = sidedefsNext.length;
    sidedefsNext.push({ ...backSrc });
  }
  // First half keeps the original linedef's slot; second half
  // appended.
  const linedefsNext = map.linedefs.slice();
  linedefsNext[linedefId] = {
    ...ld,
    v2: newVertId,
  };
  linedefsNext.push({
    ...ld,
    v1: newVertId,
    v2: ld.v2,
    front: newFront,
    back: backForSecondHalf,
  });
  return {
    map: {
      ...map,
      vertices: verticesNext,
      sidedefs: sidedefsNext,
      linedefs: linedefsNext,
    },
    vertexId: newVertId,
    newLinedefId: linedefsNext.length - 1,
  };
}

// ---------- Sector ops ----------

// Append a new sector with default metadata. Caller assigns the
// id; convention is `map.sectors.length`. Linedefs belonging to
// the sector are wired up separately (via their sidedef refs).
export function addSector(
  map: LinedefMap,
  defaults: Partial<LinedefSector> & { biomeId: string },
): { map: LinedefMap; sectorId: number } {
  const id = map.sectors.length;
  const sector: LinedefSector = {
    id,
    floorZ: defaults.floorZ ?? 0,
    ceilingZ: defaults.ceilingZ ?? 32,
    floorTextureId: defaults.floorTextureId ?? null,
    ceilingTextureId: defaults.ceilingTextureId ?? null,
    ambient: defaults.ambient ?? 1,
    biomeId: defaults.biomeId,
    buildingKind: defaults.buildingKind,
  };
  return {
    map: { ...map, sectors: [...map.sectors, sector] },
    sectorId: id,
  };
}

// Make-sector tool's core: from a point inside a closed linedef
// loop, build a new sector with that loop as its outline. Each
// linedef in the loop gets the new sector as front sidedef. If a
// linedef already has a front (belongs to another sector), the
// new sector becomes its back.
//
// `explicitLoop` (optional): when the caller knows the loop
// vertices exactly (e.g. the rect tool — 4 corners with optional
// intermediates from auto-splits), skip the topology walk and
// use the explicit chain. Avoids the 4-way junction ambiguity
// where findEnclosingLoop's clockwise-most-turn could pick a
// wall of an overlapping room instead of continuing the new
// sector's perimeter.
//
// Returns null if no loop can be found / built.
export function makeSectorFromInteriorPoint(
  map: LinedefMap,
  interior: Vec2,
  defaults: Partial<LinedefSector> & { biomeId: string },
  explicitLoop?: number[],
): { map: LinedefMap; sectorId: number } | null {
  let candidate: LoopCandidate | null = null;
  if (explicitLoop && explicitLoop.length >= 3) {
    // Build a candidate loop from the explicit vertex chain.
    // Each consecutive pair must have a linedef between them in
    // the map; without that the loop isn't representable in the
    // graph and we fall back to the topology walk.
    candidate = buildLoopFromVertices(map, explicitLoop);
  }
  if (!candidate) candidate = findEnclosingLoop(map, interior);
  if (!candidate) return null;
  const { map: mapAfterSector, sectorId } = addSector(map, defaults);
  const existingPolys = deriveSectorPolygons(map);
  // Loop centroid drives the "inward vs outward" determination
  // per linedef.
  let cx = 0;
  let cy = 0;
  for (const vid of candidate.vertexIds) {
    cx += map.vertices[vid].x;
    cy += map.vertices[vid].y;
  }
  cx /= candidate.vertexIds.length;
  cy /= candidate.vertexIds.length;

  const OUTWARD_EPS = 1; // wu

  function findOutwardSector(
    polys: Map<number, Vec2[] | null>,
    ldIdx: number,
  ): number | null {
    const ld = mapAfterSector.linedefs[ldIdx];
    const a = mapAfterSector.vertices[ld.v1];
    const b = mapAfterSector.vertices[ld.v2];
    if (!a || !b) return null;
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const dx = cx - mx;
    const dy = cy - my;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const ox = -dx / len;
    const oy = -dy / len;
    const sx = mx + ox * OUTWARD_EPS;
    const sy = my + oy * OUTWARD_EPS;
    // Pick the SMALLEST containing sector. For nested geometry
    // (platform inside a platform inside a room), every level
    // contains the sample point; the outward sector should be
    // the immediate parent, not the outermost ancestor.
    let bestSid: number | null = null;
    let bestArea = Infinity;
    for (const [sid, poly] of polys) {
      if (!poly) continue;
      if (sid === sectorId) continue;
      if (!pointInPolygon(poly, sx, sy)) continue;
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        area += p.x * q.y - q.x * p.y;
      }
      const absArea = Math.abs(area) * 0.5;
      if (absArea < bestArea) {
        bestArea = absArea;
        bestSid = sid;
      }
    }
    return bestSid;
  }

  // Side assignment: for each candidate linedef, compute which
  // side (front=LEFT, back=RIGHT of v1→v2) the new sector's
  // centroid lies on via cross product, and claim THAT side for
  // the new sector. Transferring an existing real-sector claim
  // when the geometric side matches is intentional — it handles
  // the carving case where a sub-sector replaces the parent in
  // the area it covers (the parent loses adjacency to that edge,
  // its polygon shrinks accordingly when re-derived).
  //
  // Convention verified against an outer room's CCW perimeter:
  // sector owning the FRONT sidedef sits in the LEFT half-plane
  // of v1→v2 (positive 2D cross product).
  let working = mapAfterSector;
  for (const ldIdx of candidate.linedefIds) {
    const ld = working.linedefs[ldIdx];
    const v1 = working.vertices[ld.v1];
    const v2 = working.vertices[ld.v2];
    if (!v1 || !v2) continue;
    const cross =
      (v2.x - v1.x) * (cy - v1.y) - (v2.y - v1.y) * (cx - v1.x);
    const newSide: 'front' | 'back' = cross >= 0 ? 'front' : 'back';

    if (newSide === 'front') {
      // Claim front. Overwrites the existing front sidedef's
      // sectorId, which may have been (a) a sentinel placeholder
      // from a fresh draw, (b) the parent sector being carved
      // away, or (c) an authoring-hint owner like sector-0 from
      // the polygon tool — all of which should yield to the new
      // sector's geometric claim.
      const sidedefsNext = working.sidedefs.slice();
      sidedefsNext[ld.front] = { ...sidedefsNext[ld.front], sectorId };
      let workingNext: LinedefMap = { ...working, sidedefs: sidedefsNext };
      // Opposite (back) side: leave any existing owner intact.
      // When back is null AND the outward sample lands in another
      // sector, link to it so the renderer treats this as a
      // two-sided portal instead of a void-facing wall.
      if (ld.back === null) {
        const outwardSectorId = findOutwardSector(existingPolys, ldIdx);
        if (outwardSectorId !== null) {
          const withBack = addSidedef(workingNext, outwardSectorId);
          const linedefsNext = withBack.map.linedefs.slice();
          linedefsNext[ldIdx] = {
            ...ld,
            back: withBack.sidedefId,
            impassable: false,
            blockProjectiles: false,
            blockMonsters: false,
          };
          workingNext = { ...withBack.map, linedefs: linedefsNext };
        }
      }
      working = workingNext;
      continue;
    }

    // newSide === 'back'. Add a back sidedef pointing at the new
    // sector (or overwrite an existing back). Front side: keep
    // its current owner if real; if it's sentinel and there's an
    // outward sector, fill it in so both sides reference a real
    // sector.
    if (ld.back === null) {
      const sidedefsNext = working.sidedefs.slice();
      const frontSidedef = sidedefsNext[ld.front];
      if (frontSidedef && frontSidedef.sectorId === SENTINEL_SECTOR_ID) {
        const outwardSectorId = findOutwardSector(existingPolys, ldIdx);
        if (outwardSectorId !== null) {
          sidedefsNext[ld.front] = {
            ...frontSidedef,
            sectorId: outwardSectorId,
          };
        }
      }
      const tmpMap: LinedefMap = { ...working, sidedefs: sidedefsNext };
      const withBack = addSidedef(tmpMap, sectorId);
      const linedefsNext = withBack.map.linedefs.slice();
      linedefsNext[ldIdx] = {
        ...ld,
        back: withBack.sidedefId,
        impassable: false,
        blockProjectiles: false,
        blockMonsters: false,
      };
      working = { ...withBack.map, linedefs: linedefsNext };
      continue;
    }
    // Existing back sidedef — overwrite its sectorId. Same
    // transfer-on-geometric-match logic as the front branch.
    const sidedefsNext = working.sidedefs.slice();
    sidedefsNext[ld.back] = { ...sidedefsNext[ld.back], sectorId };
    working = { ...working, sidedefs: sidedefsNext };
  }
  return { map: working, sectorId };
}

type LoopCandidate = {
  linedefIds: number[];
  vertexIds: number[];
};

// Convert an explicit vertex-chain into a LoopCandidate by
// looking up the linedef between each consecutive pair. Returns
// null if any pair has no linedef between them in the map (the
// chain isn't connected).
function buildLoopFromVertices(
  map: LinedefMap,
  chain: number[],
): LoopCandidate | null {
  const n = chain.length;
  const linedefIds: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = chain[i];
    const b = chain[(i + 1) % n];
    let found = -1;
    for (let j = 0; j < map.linedefs.length; j++) {
      const ld = map.linedefs[j];
      if ((ld.v1 === a && ld.v2 === b) || (ld.v1 === b && ld.v2 === a)) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    linedefIds.push(found);
  }
  return { vertexIds: chain.slice(), linedefIds };
}

// Walk every linedef as a starting edge in both directions,
// trying to close a loop by always turning along the EDGE WITH
// THE MOST CLOCKWISE TURN — that traces the smallest enclosing
// region (Doom's NODES algorithm follows the same intuition).
// Then test which closed loops contain the interior point;
// smallest-area-containing wins.
function findEnclosingLoop(
  map: LinedefMap,
  interior: Vec2,
): LoopCandidate | null {
  const incident = new Map<number, number[]>();
  for (let i = 0; i < map.linedefs.length; i++) {
    const ld = map.linedefs[i];
    push(incident, ld.v1, i);
    push(incident, ld.v2, i);
  }
  let best: { loop: LoopCandidate; area: number } | null = null;
  for (let startLd = 0; startLd < map.linedefs.length; startLd++) {
    for (const reverse of [false, true]) {
      const loop = traceLoop(map, incident, startLd, reverse);
      if (!loop) continue;
      const polyVerts = loop.vertexIds.map((vid) => map.vertices[vid]);
      if (!pointInPolygon(polyVerts, interior.x, interior.y)) continue;
      const area = Math.abs(polygonArea(polyVerts));
      if (!best || area < best.area) {
        best = { loop, area };
      }
    }
  }
  return best?.loop ?? null;
}

function traceLoop(
  map: LinedefMap,
  incident: Map<number, number[]>,
  startLd: number,
  reverse: boolean,
): LoopCandidate | null {
  const ld0 = map.linedefs[startLd];
  const startV = reverse ? ld0.v2 : ld0.v1;
  const firstNext = reverse ? ld0.v1 : ld0.v2;
  const vertexIds: number[] = [startV];
  const linedefIds: number[] = [startLd];
  let curV = firstNext;
  let prevLd = startLd;
  const maxSteps = map.linedefs.length + 1;
  for (let step = 0; step < maxSteps; step++) {
    if (curV === startV) {
      if (linedefIds.length < 3) return null;
      return { vertexIds, linedefIds };
    }
    vertexIds.push(curV);
    const cands = incident.get(curV);
    if (!cands || cands.length < 2) return null;
    // Pick the next linedef that turns the MOST clockwise from
    // the prev linedef's incoming direction. Smallest enclosing
    // loop = always turn clockwise.
    const prevLine = map.linedefs[prevLd];
    const fromV = prevLine.v1 === curV ? prevLine.v2 : prevLine.v1;
    const inDx = map.vertices[curV].x - map.vertices[fromV].x;
    const inDy = map.vertices[curV].y - map.vertices[fromV].y;
    let chosen = -1;
    let chosenAngle = Infinity;
    for (const cand of cands) {
      if (cand === prevLd) continue;
      const candLine = map.linedefs[cand];
      const otherV = candLine.v1 === curV ? candLine.v2 : candLine.v1;
      const outDx = map.vertices[otherV].x - map.vertices[curV].x;
      const outDy = map.vertices[otherV].y - map.vertices[curV].y;
      // Signed angle from in→out, rotating clockwise. Range
      // [0, 2π); pick the smallest (most clockwise turn).
      const a = clockwiseAngle(inDx, inDy, outDx, outDy);
      if (a < chosenAngle) {
        chosenAngle = a;
        chosen = cand;
      }
    }
    if (chosen < 0) return null;
    linedefIds.push(chosen);
    const chosenLine = map.linedefs[chosen];
    curV = chosenLine.v1 === curV ? chosenLine.v2 : chosenLine.v1;
    prevLd = chosen;
  }
  return null;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  let arr = m.get(k);
  if (!arr) {
    arr = [];
    m.set(k, arr);
  }
  arr.push(v);
}

function polygonArea(verts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s * 0.5;
}

// Angle from in-direction to out-direction, measured clockwise
// (so smaller = sharper right turn). Range [0, 2π).
function clockwiseAngle(
  inX: number,
  inY: number,
  outX: number,
  outY: number,
): number {
  // Reverse the in-direction to get the "coming from" ray, then
  // measure the angle from outDir to that ray going clockwise.
  // Equivalent: angle = atan2(cross, dot) of (out, -in), then
  // wrap to [0, 2π) with sign convention for clockwise.
  const dot = -inX * outX + -inY * outY;
  const cross = -inX * outY - -inY * outX;
  let a = Math.atan2(cross, dot);
  if (a < 0) a += 2 * Math.PI;
  return a;
}

// ---------- Repair ----------

export type LinedefMapRepair = {
  map: LinedefMap;
  // Human-readable summary of every change. Empty array = no
  // repairs needed.
  changes: string[];
};

// Drop dangling references + degenerates so a corrupted map
// becomes save-safe. Runs unconditionally before save; cheap
// (linear in everything). Anything we can't unambiguously fix is
// left for the validator's warning path.
export function repairLinedefMap(map: LinedefMap): LinedefMapRepair {
  const changes: string[] = [];
  // Sectors are keyed by id; build a set for fast membership.
  const sectorIds = new Set(map.sectors.map((s) => s.id));

  // 1. Sidedefs pointing at non-existent sectors → drop. Sentinel
  //    (-1) is preserved — it's an explicit "no sector yet" marker.
  const sidedefKeep = new Set<number>();
  for (let i = 0; i < map.sidedefs.length; i++) {
    const sid = map.sidedefs[i].sectorId;
    if (sid === SENTINEL_SECTOR_ID || sectorIds.has(sid)) {
      sidedefKeep.add(i);
    } else {
      changes.push(`Dropped sidedef ${i} (points at missing sector ${sid}).`);
    }
  }

  // 2. Snap near-coincident vertices to a canonical one. Authors
  //    using free-snap drawing can land a click 0.1wu off an
  //    existing vert; without this pass those two verts stay
  //    distinct and any linedef chain that should have been
  //    closed (or shared) silently isn't. EPS chosen so that
  //    grid-snapped (16/32wu) layouts are never affected.
  const SNAP_EPS = 0.5; // wu
  const SNAP_EPS_SQ = SNAP_EPS * SNAP_EPS;
  const remapVert = new Map<number, number>();
  for (let i = 0; i < map.vertices.length; i++) {
    const v = map.vertices[i];
    let canonical = i;
    for (let j = 0; j < i; j++) {
      const w = map.vertices[j];
      const dx = v.x - w.x;
      const dy = v.y - w.y;
      if (dx * dx + dy * dy <= SNAP_EPS_SQ) {
        // Follow chains: w may itself remap to an earlier canon.
        canonical = remapVert.get(j) ?? j;
        break;
      }
    }
    if (canonical !== i) {
      remapVert.set(i, canonical);
    }
  }
  let mergedVertCount = 0;
  for (const [from, to] of remapVert) {
    if (from !== to) mergedVertCount++;
  }
  if (mergedVertCount > 0) {
    changes.push(
      `Snapped ${mergedVertCount} near-coincident vertex/vertices (within ${SNAP_EPS}wu) to existing.`,
    );
  }

  // 3. Linedefs: rewrite v1/v2 via the snap remap, then drop
  //    invalid / degenerate / duplicate. A duplicate is any later
  //    linedef whose unordered {v1, v2} pair already exists; we
  //    drop the duplicate AND warn since its sidedef metadata
  //    would otherwise silently overwrite the canonical's during
  //    rendering.
  const vertCount = map.vertices.length;
  const sideCount = map.sidedefs.length;
  const fixedLinedefs: Linedef[] = [];
  const seenEdges = new Set<string>();
  for (let i = 0; i < map.linedefs.length; i++) {
    const raw = map.linedefs[i];
    const v1 = remapVert.get(raw.v1) ?? raw.v1;
    const v2 = remapVert.get(raw.v2) ?? raw.v2;
    if (v1 < 0 || v1 >= vertCount) {
      changes.push(`Dropped linedef ${i} (v1=${v1} out of range).`);
      continue;
    }
    if (v2 < 0 || v2 >= vertCount) {
      changes.push(`Dropped linedef ${i} (v2=${v2} out of range).`);
      continue;
    }
    if (v1 === v2) {
      changes.push(`Dropped linedef ${i} (degenerate: v1===v2 after snap).`);
      continue;
    }
    const edgeKey = v1 < v2 ? `${v1}_${v2}` : `${v2}_${v1}`;
    if (seenEdges.has(edgeKey)) {
      changes.push(`Dropped linedef ${i} (duplicate of an earlier edge).`);
      continue;
    }
    if (raw.front < 0 || raw.front >= sideCount || !sidedefKeep.has(raw.front)) {
      changes.push(`Dropped linedef ${i} (front sidedef invalid).`);
      continue;
    }
    let back = raw.back;
    if (
      back !== null &&
      (back < 0 || back >= sideCount || !sidedefKeep.has(back))
    ) {
      changes.push(`Linedef ${i}: back sidedef invalid, cleared to one-sided.`);
      back = null;
    }
    seenEdges.add(edgeKey);
    fixedLinedefs.push({ ...raw, v1, v2, back });
  }

  // 4. compactMap drops unreferenced vertices + sidedefs and
  //    rewrites all ids consistently.
  const compacted = compactMap({
    ...map,
    linedefs: fixedLinedefs,
  });
  return { map: compacted, changes };
}

// Same wrapper for a whole LinedefScene.
export function repairLinedefScene(
  scene: LinedefScene,
): { scene: LinedefScene; changes: string[] } {
  const { map, changes } = repairLinedefMap(scene.map);
  return {
    scene: { ...scene, map: recomputeLinedefBounds(map) },
    changes,
  };
}

// ---------- Scene factory ----------

// Minimum-viable LinedefScene: one square sector, four linedefs,
// four vertices. Editor starts here for a new scene.
export function emptyLinedefScene(id: string): LinedefScene {
  const sectorBiome = 'default';
  const vertices: Vec2[] = [
    { x: 0, y: 0 },
    { x: 256, y: 0 },
    { x: 256, y: 256 },
    { x: 0, y: 256 },
  ];
  const sidedefs: Sidedef[] = [0, 1, 2, 3].map(() => ({
    sectorId: 0,
    midTex: null,
    upperTex: null,
    lowerTex: null,
    texOffsetX: 0,
    texOffsetY: 0,
  }));
  const linedefs: Linedef[] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ].map(([a, b], i) => ({
    v1: a,
    v2: b,
    front: i,
    back: null,
    impassable: true,
    blockProjectiles: true,
    blockMonsters: true,
  }));
  return {
    id,
    name: id === 'untitled' ? 'Untitled scene' : id,
    biome: sectorBiome,
    map: {
      vertices,
      linedefs,
      sidedefs,
      sectors: [
        {
          id: 0,
          floorZ: 0,
          ceilingZ: 32,
          floorTextureId: null,
          ceilingTextureId: null,
          ambient: 1.0,
          biomeId: sectorBiome,
        },
      ],
      lights: [],
      bounds: { x: -16, y: -16, w: 288, h: 288 },
    },
    interactables: [],
    spawn: { x: 128, y: 128 },
    meta: undefined,
  };
}

// Recompute bounds from vertices.
export function recomputeLinedefBounds(map: LinedefMap): LinedefMap {
  if (map.vertices.length === 0) return map;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of map.vertices) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return {
    ...map,
    bounds: {
      x: Math.floor(minX) - 16,
      y: Math.floor(minY) - 16,
      w: Math.ceil(maxX - minX) + 32,
      h: Math.ceil(maxY - minY) + 32,
    },
  };
}

// Re-derive sector polygons. Wrapper that returns a Map with
// only sectors whose loops successfully closed (skips the null
// entries from deriveSectorPolygons).
export function sectorPolygonsClosed(
  map: LinedefMap,
): Map<number, Vec2[]> {
  const derived = deriveSectorPolygons(map);
  const out = new Map<number, Vec2[]>();
  for (const [id, verts] of derived) {
    if (verts) out.set(id, verts);
  }
  return out;
}
