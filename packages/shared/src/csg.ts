// CSG-based scene model. Authoring stores each region as a 2D
// polygon with elevation overrides; z-ordered overlap resolves
// who owns the surface where shapes intersect. The runtime data
// (LinedefScene) is computed at save time from this list of
// shapes via boolean polygon operations — the editor never has
// to maintain linedef topology by hand, so the whole class of
// "carving corrupted the front/back claim on this edge" bugs
// goes away.
//
// Conversion direction:
//   CsgScene  ──csgSceneToLinedefScene──▶  LinedefScene  (save)
//   LinedefScene  ──linedefSceneToCsgScene──▶  CsgScene   (load)
//
// At runtime the editor's working model is CsgScene; on save we
// emit LinedefScene; on load we ingest LinedefScene as one shape
// per sector (so existing scenes import cleanly with no manual
// migration).

import polygonClipping, {
  type MultiPolygon,
  type Polygon as PCPolygon,
  type Ring,
} from 'polygon-clipping';
import type { Vec2 } from './geometry';
import type { Interactable } from './protocol';
import type { TerrainConfig } from './terrain';
import {
  SENTINEL_SECTOR_ID,
  type Linedef,
  type LinedefMap,
  type LinedefScene,
  type LinedefSector,
  type Sidedef,
  linedefMapToPolygonMap,
  linedefSceneToPolygonScene,
} from './linedef';
import type {
  SectorLight,
  SectorScene as PolygonSectorScene,
} from './sector';

// One drawn shape in the editor. Each shape becomes one or more
// sectors at save time depending on overlap with higher-zOrder
// shapes.
export type CsgShape = {
  id: number;
  name?: string;
  // Polygon outer perimeter, CCW. Holes (CW) are optional and
  // get carried through directly to the output sector when this
  // shape isn't itself fully consumed by higher-z shapes.
  outer: Vec2[];
  holes?: Vec2[][];
  // Sector properties applied to the area this shape covers.
  floorZ: number;
  ceilingZ: number;
  biomeId: string;
  ambient?: number;
  floorTextureId?: string | null;
  ceilingTextureId?: string | null;
  // Stacking order: a shape with higher zOrder wins in overlap
  // regions (its polygon replaces the area in any underlying
  // shape). Pits, platforms, vents are just shapes drawn on top
  // of a room shape with different floor/ceiling. New shapes get
  // appended at max(zOrder)+1 by default.
  zOrder: number;
  // Sub-classification for renderer-only behavior (skipped
  // buildings, etc.). Mirrors LinedefSector.buildingKind.
  buildingKind?: string;
  // Subtractive shape — area is removed from any lower-zOrder
  // shape it overlaps, but the shape itself does NOT emit a
  // sector at save time. Use for cutting arches / tunnels /
  // holes that don't have their own floor.
  subtractive?: boolean;
  // Perlin/value noise displacement applied to the floor (or
  // ceiling) on top of the flat z. Falloff toward the polygon
  // perimeter is applied at runtime so the noise vanishes at
  // portals / shared edges — heights match where rooms meet
  // and walls touch the floor cleanly. Omit to keep flat.
  floorNoise?: TerrainConfig;
  ceilingNoise?: TerrainConfig;
};

export type CsgScene = {
  // Sentinel for the SceneDef union — lets the editor / loader
  // discriminate this from LinedefScene / SectorScene by shape.
  kind: 'csg';
  id: string;
  name: string;
  biome: string;
  spawn: Vec2;
  // Explicit player drop-in Z. When omitted, the server falls
  // back to spawnFloorAt(spawn.x, spawn.y) which picks the lowest
  // walkable sector at the spawn point — that's usually right
  // for outdoor scenes but spawns the player inside an overlapping
  // pit if one exists. Pin spawnZ to the actual room floor (e.g.
  // 0 for a default room, 16 for a platform) to override.
  spawnZ?: number;
  shapes: CsgShape[];
  lights: SectorLight[];
  interactables: Interactable[];
  meta?: { author?: string; createdAt?: string; modifiedAt?: string };
};

// Factory for the editor's "+ new" action — produces a starter
// CSG scene with a single 256×256 room shape so the canvas isn't
// empty on first paint.
export function emptyCsgScene(id: string): CsgScene {
  return {
    kind: 'csg',
    id,
    name: id,
    biome: 'default',
    spawn: { x: 128, y: 128 },
    spawnZ: 0,
    shapes: [
      {
        id: 0,
        outer: [
          { x: 0, y: 0 },
          { x: 256, y: 0 },
          { x: 256, y: 256 },
          { x: 0, y: 256 },
        ],
        floorZ: 0,
        ceilingZ: 32,
        biomeId: 'default',
        ambient: 1,
        zOrder: 0,
      },
    ],
    lights: [],
    interactables: [],
  };
}

// Vertex-snap epsilon: distances ≤ this are considered the same
// point during edge collection. Chosen large enough to absorb
// polygon-clipping's internal float rounding (it uses fast,
// numerically-stable but not bit-exact arithmetic).
const VERT_SNAP_EPS = 1e-6;

// ---------- CSG → LinedefScene ----------

export function csgSceneToLinedefScene(csg: CsgScene): LinedefScene {
  const map = csgShapesToLinedefMap(csg.shapes, csg.biome);
  // Carry the scene's authored lights into the emitted map —
  // csgShapesToLinedefMap only handles geometry.
  map.lights = csg.lights.map((l) => ({ ...l }));
  return {
    id: csg.id,
    name: csg.name,
    biome: csg.biome,
    spawn: { ...csg.spawn },
    spawnZ: csg.spawnZ,
    map,
    interactables: csg.interactables.map((i) => ({ ...i })),
    meta: csg.meta ? { ...csg.meta } : undefined,
  };
}

function csgShapesToLinedefMap(
  shapes: CsgShape[],
  defaultBiome: string,
): LinedefMap {
  if (shapes.length === 0) {
    return emptyMap(defaultBiome);
  }
  // Z-sort ascending: shape[0] is the bottom layer, shape[N-1]
  // the top. Higher-z shapes subtract their area from every
  // lower-z shape's effective polygon.
  const sorted = [...shapes].sort((a, b) => a.zOrder - b.zOrder);

  // 1. Compute each shape's effective polygon (its own polygon
  //    minus the union of all higher-z shape polygons it overlaps).
  type EffectiveShape = {
    shape: CsgShape;
    rings: Vec2[][]; // outer + holes after CSG; outer CCW, holes CW
  };
  const effective: EffectiveShape[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const me = sorted[i];
    // Subtractive shapes never emit as their own sector — they
    // exist only to remove area from lower-z shapes. (Higher-z
    // shapes still subtract from this one, but since this won't
    // be emitted that's moot.)
    if (me.subtractive) continue;
    let mePoly: MultiPolygon = [shapeToPolygon(me)];
    for (let j = i + 1; j < sorted.length; j++) {
      const above = sorted[j];
      const result = polygonClipping.difference(
        mePoly,
        shapeToPolygon(above),
      );
      mePoly = result;
      if (mePoly.length === 0) break;
    }
    // Each polygon piece in mePoly becomes one entry — a shape
    // split in two by a higher overlay emits two sectors with
    // the same properties.
    for (const piece of mePoly) {
      effective.push({
        shape: me,
        rings: piece.map(ringToVerts),
      });
    }
  }

  if (effective.length === 0) {
    return emptyMap(defaultBiome);
  }

  // 2. Vertex propagation: any vertex of any ring that lies on
  //    the interior of another ring's edge must be inserted as
  //    an explicit vertex on that edge. Without this, two
  //    sectors that share part of an edge (T-junction) emit
  //    mismatched linedefs and the runtime sees a gap.
  const allRings: Vec2[][] = [];
  for (const e of effective) allRings.push(...e.rings);
  const propagated = propagateVertices(allRings);
  let ringCursor = 0;
  for (const e of effective) {
    for (let k = 0; k < e.rings.length; k++) {
      e.rings[k] = propagated[ringCursor++];
    }
  }

  // 3. Vertex set + lookup. Coincident points (within EPS) map
  //    to one vertex index.
  const vertices: Vec2[] = [];
  const vertexIndex = (p: Vec2): number => {
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      const dx = v.x - p.x;
      const dy = v.y - p.y;
      if (dx * dx + dy * dy <= VERT_SNAP_EPS * VERT_SNAP_EPS) return i;
    }
    vertices.push({ x: p.x, y: p.y });
    return vertices.length - 1;
  };

  // 4. Build sectors (one per effective piece) and walk each
  //    ring emitting edges. Collect edges into a map so two
  //    sectors sharing the same edge fold into one two-sided
  //    linedef.
  const sectors: LinedefSector[] = [];
  type EdgeInfo = {
    v1: number;
    v2: number;
    // Each side's owning sector when known. The sector that
    // walks v1→v2 with itself on the LEFT is FRONT; the sector
    // that walks v2→v1 (i.e. the same edge in reverse) is BACK.
    front: number | null;
    back: number | null;
  };
  const edges = new Map<string, EdgeInfo>();
  const edgeKey = (a: number, b: number): string =>
    a < b ? `${a}_${b}` : `${b}_${a}`;

  for (let sIdx = 0; sIdx < effective.length; sIdx++) {
    const piece = effective[sIdx];
    const newSectorId = sIdx;
    const src = piece.shape;
    sectors.push({
      id: newSectorId,
      floorZ: src.floorZ,
      ceilingZ: src.ceilingZ,
      ambient: src.ambient ?? 1,
      biomeId: src.biomeId,
      floorTextureId: src.floorTextureId ?? null,
      ceilingTextureId: src.ceilingTextureId ?? null,
      buildingKind: src.buildingKind,
      floorNoise: src.floorNoise,
      ceilingNoise: src.ceilingNoise,
    });
    // First ring is outer (CCW), rest are holes (CW). Both are
    // walked verbatim — the winding determines which side is
    // FRONT for each emitted edge.
    for (let rIdx = 0; rIdx < piece.rings.length; rIdx++) {
      const ring = piece.rings[rIdx];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        const ai = vertexIndex(a);
        const bi = vertexIndex(b);
        if (ai === bi) continue;
        const key = edgeKey(ai, bi);
        const existing = edges.get(key);
        if (!existing) {
          // First time we see this edge. Walking a→b puts this
          // sector on the LEFT (= front per project convention).
          // Record canonical orientation as v1→v2 = a→b.
          edges.set(key, {
            v1: ai,
            v2: bi,
            front: newSectorId,
            back: null,
          });
        } else {
          // Edge already exists. We must be walking it in the
          // OPPOSITE direction (CCW polygons can't traverse the
          // same edge twice in the same direction without
          // overlapping). Whichever direction we walk, this
          // sector is on the LEFT of our walk; relative to the
          // canonical v1→v2 orientation, that means we're on
          // the OPPOSITE side from the first walker → back.
          if (existing.v1 === ai && existing.v2 === bi) {
            // Same direction. Shouldn't happen with valid
            // CSG output but guard against it — overwrite front.
            existing.front = newSectorId;
          } else {
            existing.back = newSectorId;
          }
        }
      }
    }
  }

  // 5. Materialise edges into Linedefs + Sidedefs.
  const sidedefs: Sidedef[] = [];
  const linedefs: Linedef[] = [];
  for (const e of edges.values()) {
    const frontSidedef = sidedefs.length;
    sidedefs.push({
      sectorId: e.front ?? SENTINEL_SECTOR_ID,
      upperTex: null,
      midTex: null,
      lowerTex: null,
      texOffsetX: 0,
      texOffsetY: 0,
    });
    let backSidedef: number | null = null;
    if (e.back !== null) {
      backSidedef = sidedefs.length;
      sidedefs.push({
        sectorId: e.back,
        upperTex: null,
        midTex: null,
        lowerTex: null,
        texOffsetX: 0,
        texOffsetY: 0,
      });
    }
    linedefs.push({
      v1: e.v1,
      v2: e.v2,
      front: frontSidedef,
      back: backSidedef,
      impassable: backSidedef === null,
      blockProjectiles: backSidedef === null,
      blockMonsters: backSidedef === null,
    });
  }

  const bounds = computeBounds(vertices);
  return {
    vertices,
    linedefs,
    sidedefs,
    sectors,
    lights: [],
    bounds,
  };
}

function shapeToPolygon(s: CsgShape): PCPolygon {
  const rings: Ring[] = [vertsToRing(s.outer)];
  if (s.holes) {
    for (const h of s.holes) rings.push(vertsToRing(h));
  }
  return rings;
}

function vertsToRing(verts: Vec2[]): Ring {
  // polygon-clipping expects rings WITHOUT a duplicated closing
  // vertex; the first and last entries are auto-connected.
  return verts.map((v) => [v.x, v.y]);
}

function ringToVerts(ring: Ring): Vec2[] {
  // Strip a duplicated closing vertex if polygon-clipping
  // returned one (its docs say it does for some ops).
  const out: Vec2[] = ring.map(([x, y]) => ({ x, y }));
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.abs(first.x - last.x) <= VERT_SNAP_EPS &&
      Math.abs(first.y - last.y) <= VERT_SNAP_EPS
    ) {
      out.pop();
    }
  }
  return out;
}

// Insert vertices along each ring's interior edges wherever
// another ring's vertex lies on them. Resolves T-junctions
// between two adjacent shapes that share part of an edge.
function propagateVertices(rings: Vec2[][]): Vec2[][] {
  // Collect every unique vertex position once.
  const allVerts: Vec2[] = [];
  for (const ring of rings) {
    for (const v of ring) {
      let found = false;
      for (const ex of allVerts) {
        const dx = ex.x - v.x;
        const dy = ex.y - v.y;
        if (dx * dx + dy * dy <= VERT_SNAP_EPS * VERT_SNAP_EPS) {
          found = true;
          break;
        }
      }
      if (!found) allVerts.push({ x: v.x, y: v.y });
    }
  }
  // For each ring's edge, find all allVerts that lie strictly on
  // its interior, sort by t along the edge, and splice them in.
  return rings.map((ring) => {
    const out: Vec2[] = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      out.push({ x: a.x, y: a.y });
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      const inserts: Array<{ t: number; v: Vec2 }> = [];
      for (const p of allVerts) {
        // Skip endpoints.
        const dxA = p.x - a.x;
        const dyA = p.y - a.y;
        const dxB = p.x - b.x;
        const dyB = p.y - b.y;
        if (dxA * dxA + dyA * dyA <= VERT_SNAP_EPS * VERT_SNAP_EPS) continue;
        if (dxB * dxB + dyB * dyB <= VERT_SNAP_EPS * VERT_SNAP_EPS) continue;
        // Project onto the edge, check perpendicular distance.
        const t = (dxA * dx + dyA * dy) / lenSq;
        if (t <= 0 || t >= 1) continue;
        const projX = a.x + t * dx;
        const projY = a.y + t * dy;
        const perpX = p.x - projX;
        const perpY = p.y - projY;
        const perpSq = perpX * perpX + perpY * perpY;
        if (perpSq > VERT_SNAP_EPS * VERT_SNAP_EPS) continue;
        inserts.push({ t, v: { x: projX, y: projY } });
      }
      inserts.sort((u, w) => u.t - w.t);
      for (const ins of inserts) out.push(ins.v);
    }
    return out;
  });
}

function emptyMap(biome: string): LinedefMap {
  void biome;
  return {
    vertices: [],
    linedefs: [],
    sidedefs: [],
    sectors: [],
    lights: [],
    bounds: { x: 0, y: 0, w: 0, h: 0 },
  };
}

function computeBounds(
  verts: Vec2[],
): { x: number; y: number; w: number; h: number } {
  if (verts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const v of verts) {
    if (v.x < xMin) xMin = v.x;
    if (v.x > xMax) xMax = v.x;
    if (v.y < yMin) yMin = v.y;
    if (v.y > yMax) yMax = v.y;
  }
  return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
}

// ---------- LinedefScene → CsgScene ----------
//
// Ingest existing linedef-authored scenes as CSG shapes — one
// shape per sector, using the sector's outer perimeter and any
// inner-loop holes that survive the linedef→polygon conversion.
// zOrder is assigned by sector id so the original load order is
// preserved on re-export.

export function linedefSceneToCsgScene(scene: LinedefScene): CsgScene {
  // Re-use the existing linedef→polygon walker (same outer/holes
  // derivation the renderer consumes) so we get clean polygons.
  const polyMap = linedefMapToPolygonMap(scene.map);
  const shapes: CsgShape[] = polyMap.sectors.map((s, i) => ({
    id: i,
    outer: s.verts.map((v) => ({ ...v })),
    holes: s.holes ? s.holes.map((h) => h.map((v) => ({ ...v }))) : undefined,
    floorZ: s.floorZ,
    ceilingZ: s.ceilingZ,
    biomeId: s.biomeId ?? scene.biome,
    ambient: s.ambient ?? 1,
    floorTextureId: s.floorTextureId,
    ceilingTextureId: s.ceilingTextureId,
    zOrder: i,
    buildingKind: s.buildingKind,
    floorNoise: s.floorNoise,
    ceilingNoise: s.ceilingNoise,
  }));
  return {
    kind: 'csg',
    id: scene.id,
    name: scene.name,
    biome: scene.biome,
    spawn: { ...scene.spawn },
    shapes,
    lights: scene.map.lights.map((l) => ({ ...l })),
    interactables: scene.interactables.map((i) => ({ ...i })),
    meta: scene.meta ? { ...scene.meta } : undefined,
  };
}

// Convenience for runtime renderer consumers — convert a CSG
// scene end-to-end to the polygon SectorScene the v2 renderer
// already accepts.
export function csgSceneToPolygonScene(
  csg: CsgScene,
): PolygonSectorScene {
  const ld = csgSceneToLinedefScene(csg);
  const polyMap = linedefMapToPolygonMap(ld.map);
  return {
    id: csg.id,
    name: csg.name,
    biome: csg.biome,
    spawn: { ...csg.spawn },
    spawnZ: csg.spawnZ,
    map: polyMap,
    interactables: csg.interactables.map((i) => ({ ...i })),
    meta: csg.meta ? { ...csg.meta } : undefined,
  };
}

// Coerce any on-disk scene format (CSG / Linedef / Polygon) to
// a runtime PolygonSectorScene. Centralises the "what kind is
// this raw JSON" detection so consumers (server scene loader,
// sandbox playtest, scene_overrides) don't each reimplement it.
export function coerceAnySceneToPolygonScene(
  raw: unknown,
): PolygonSectorScene {
  if (!raw || typeof raw !== 'object') {
    throw new Error('coerceAnySceneToPolygonScene: input is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'csg') {
    return csgSceneToPolygonScene(raw as CsgScene);
  }
  // Falls back to the linedef/polygon coerce in linedef.ts.
  // Imported here to keep the entry point in one place.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return coerceLinedefOrPolygonScene(raw);
}

// Structural detection for Linedef/Polygon (CSG is detected by
// the caller via `kind === 'csg'`). Mirrors linedef.ts's
// `coerceToPolygonScene` without importing it (one less indirect
// dep from this module).
function coerceLinedefOrPolygonScene(raw: unknown): PolygonSectorScene {
  if (!raw || typeof raw !== 'object') {
    throw new Error('not an object');
  }
  const obj = raw as Record<string, unknown>;
  const map = obj.map as Record<string, unknown> | undefined;
  if (!map || typeof map !== 'object') {
    throw new Error('missing map field');
  }
  if (Array.isArray(map.linedefs) && Array.isArray(map.vertices)) {
    return linedefSceneToPolygonScene(raw as LinedefScene);
  }
  return raw as PolygonSectorScene;
}
