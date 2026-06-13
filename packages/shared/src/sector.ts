// Sector-native scene primitives. The polygon-collision plan
// makes these the authoritative scene model on the server; until
// then the v2 client renderer is the only consumer. Shapes mirror
// `packages/client/lib/game/fps.v2/types.ts` (the original home),
// promoted here so the server can speak the same data without
// reaching across packages.

import {
  pointInPolygon,
  pointSegmentDistance,
  type Vec2,
} from './geometry';

export type Sector = {
  id: number;
  // Convex (or simple-concave; earcut handles either on the
  // renderer side, but collision assumes convex — auto-split at
  // scene load if you author concave). Counter-clockwise winding.
  verts: Vec2[];
  // Optional inner-loop hole rings (CW winding). Carved sub-
  // sectors inside this sector produce holes here so floor /
  // ceiling triangulation can subtract them via earcut. Empty
  // or absent = no holes.
  holes?: Vec2[][];
  // Floor / ceiling heights in world units. floorZ < ceilingZ.
  // floorZ may be > 0 (raised platform); ceilingZ < floorZ is the
  // building-cube-cap sentinel and means "no ceiling geometry".
  floorZ: number;
  ceilingZ: number;
  floorTextureId: string | null;
  ceilingTextureId: string | null;
  // 0..1 ambient contribution combined with light sampling in
  // the fragment shader.
  ambient: number;
  // Biome identifier — drives fog colour + texture fallback.
  biomeId: string;
  // Optional discriminator. Set to the building kind on building-
  // cap sectors so the colored mesh can skip them when a textured
  // shell exists. Absent on room / platform sectors.
  buildingKind?: string;
  // Per-sector value-noise displacement applied on top of floorZ /
  // ceilingZ. The renderer tessellates the floor / ceiling mesh on
  // a grid and offsets per-vertex Z; server collision sums noise
  // into floorAt / ceilingAt. A perimeter-distance falloff makes
  // the noise vanish at the polygon edge so portals stitch
  // cleanly with the neighbour's flat floor.
  floorNoise?: import('./terrain').TerrainConfig;
  ceilingNoise?: import('./terrain').TerrainConfig;
};

export type Wall = {
  sectorId: number;
  vertIdx: number; // start vertex (winding direction)
  // Optional explicit endpoint coords. When present, the renderer
  // uses these directly instead of indexing into sector.verts.
  // Set by the linedef → polygon converter for inner-loop walls
  // (around carved pits / vents / windows) whose endpoints live
  // in sector.holes, not sector.verts.
  ax?: number;
  ay?: number;
  bx?: number;
  by?: number;
  // null when this wall faces the void (outer perimeter); set
  // when the wall is a portal between two sectors at different
  // floor / ceiling heights → renders an "upper" or "lower"
  // wall segment for the height difference.
  backSectorId: number | null;
  textureId: string | null;
  // Mirrors the gameplay-level walkable test: if this wall is a
  // collision boundary the server's tile grid already enforces
  // (the renderer only reads this to decide whether to draw it).
  solid: boolean;
  // Optional explicit vertical span. Used for building-cube
  // walls and platform-tile risers: the wall's geometry uses
  // these directly instead of the sector's floor / ceiling.
  // Absent for full-height room walls.
  floorZOverride?: number;
  ceilingZOverride?: number;
  // Optional discriminator — set to the building kind on
  // building-cube walls so the colored mesh can omit them when
  // a textured shell exists for that kind.
  buildingKind?: string;
};

// Static light authored / generated per scene. Distinct from the
// dynamic-light pool the renderer maintains for muzzle flashes
// and other ephemera; these are scene-tied and persist for the
// scene's lifetime.
export type SectorLight = {
  // Stable id so dynamic lights can be addressed for update /
  // removal. Authored lights use deterministic ids
  // (`"static:<sectorId>:<n>"`).
  id: string;
  x: number;
  y: number;
  // Height above sector floor.
  z: number;
  // Falloff to zero at this distance (world units).
  radius: number;
  // 0xrrggbb.
  colour: number;
  intensity: number;
  // Sector ids the light's volume can reach (own sector +
  // neighbours through compatible-height portals). Optional —
  // empty / absent means "unculled" (defensive fallback for
  // generated lights; authored ones should set it offline).
  reachableSectors?: number[];
};

export type SectorMap = {
  sectors: Sector[];
  walls: Wall[];
  lights: SectorLight[];
  // World-space bounding box. Used to size the far-plane + skybox
  // and to bound the AI grid raster on the server.
  bounds: { x: number; y: number; w: number; h: number };
};

// Hand-authored scene format — the editor's output, server's
// input. SectorMap carries the geometry; everything else mirrors
// the runtime SceneLayout fields the server needs to populate
// a Scene without going through procgen. Loaded by id from
// `packages/shared/content/scenes/<id>.json`. Stored alongside
// the rest of the editor content tree.
export type SectorScene = {
  id: string;
  // Human-facing label shown in the editor sidebar + scene list.
  name: string;
  // Biome identifier — drives palette + texture fallback.
  biome: string;
  // Sector geometry (polygons + walls + lights).
  map: SectorMap;
  // Gameplay anchors. Same shapes as the runtime protocol.
  interactables: import('./protocol').Interactable[];
  anchors?: import('./protocol').SceneAnchor[];
  spawn: { x: number; y: number };
  // Explicit spawn Z. When omitted, server uses spawnFloorAt.
  spawnZ?: number;
  // Optional terrain heightmap. Same field as on SceneLayout.
  terrain?: import('./terrain').TerrainConfig;
  // Author + timestamp metadata. Editor-only; server ignores.
  meta?: {
    author?: string;
    createdAt?: string;
    modifiedAt?: string;
  };
};

// ---------- Spatial index ----------
//
// Wall lookup by world cell. Each wall lives in every cell its
// segment passes through; queries collapse duplicates. Granularity
// is a constructor parameter — pick the largest stride that keeps
// per-cell wall counts low for your scene density. 32 px works
// well for current dungeon scales.

export type WallIndex = {
  // Cell size (world units) the index was built at.
  cellSize: number;
  // Add a wall (referenced by its index in the source array) to
  // every cell its segment passes through. Cheap; called once per
  // wall at scene load.
  addWall(
    wallIdx: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void;
  // Yield the wall indices in any cell touched by the segment.
  // Duplicates collapsed — each wallIdx returned at most once
  // per call. Caller still needs to apply the actual distance /
  // intersection test; this is a broad-phase prune.
  cellsTouchingSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Iterable<number>;
  // Yield wall indices in any cell whose AABB intersects the
  // (radius-padded) bounding box of the segment. Used by swept-
  // circle collision where the moving circle's swept volume is
  // wider than a point segment.
  cellsTouchingSegmentPadded(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    pad: number,
  ): Iterable<number>;
};

export function createWallIndex(cellSize: number): WallIndex {
  if (cellSize <= 0) throw new Error('WallIndex cellSize must be > 0');
  // Sparse grid: cell key = `${cellX},${cellY}`. We don't pre-
  // allocate a dense bitmap because scenes are usually <100×100
  // wall-cells but bounds-positioned in a much larger world frame.
  const cells = new Map<string, number[]>();

  function key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  function* rangeIter(
    cellX0: number,
    cellY0: number,
    cellX1: number,
    cellY1: number,
  ): Iterable<number> {
    const seen = new Set<number>();
    for (let cy = cellY0; cy <= cellY1; cy++) {
      for (let cx = cellX0; cx <= cellX1; cx++) {
        const list = cells.get(key(cx, cy));
        if (!list) continue;
        for (const w of list) {
          if (seen.has(w)) continue;
          seen.add(w);
          yield w;
        }
      }
    }
  }

  return {
    cellSize,
    addWall(wallIdx, x1, y1, x2, y2) {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      const cellX0 = Math.floor(minX / cellSize);
      const cellY0 = Math.floor(minY / cellSize);
      const cellX1 = Math.floor(maxX / cellSize);
      const cellY1 = Math.floor(maxY / cellSize);
      // Bounding-box stamp. We could rasterise the segment via
      // Bresenham to skip empty cells in long diagonals, but at
      // 32 px cells and walls typically aligned to the grid, the
      // box stamp is exact enough.
      for (let cy = cellY0; cy <= cellY1; cy++) {
        for (let cx = cellX0; cx <= cellX1; cx++) {
          const k = key(cx, cy);
          let list = cells.get(k);
          if (!list) {
            list = [];
            cells.set(k, list);
          }
          list.push(wallIdx);
        }
      }
    },
    cellsTouchingSegment(x1, y1, x2, y2) {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      return rangeIter(
        Math.floor(minX / cellSize),
        Math.floor(minY / cellSize),
        Math.floor(maxX / cellSize),
        Math.floor(maxY / cellSize),
      );
    },
    cellsTouchingSegmentPadded(x1, y1, x2, y2, pad) {
      const minX = Math.min(x1, x2) - pad;
      const maxX = Math.max(x1, x2) + pad;
      const minY = Math.min(y1, y2) - pad;
      const maxY = Math.max(y1, y2) + pad;
      return rangeIter(
        Math.floor(minX / cellSize),
        Math.floor(minY / cellSize),
        Math.floor(maxX / cellSize),
        Math.floor(maxY / cellSize),
      );
    },
  };
}

// Auto-derive riser overrides on walls that share an edge with
// a lower-floor neighbour sector. Editor-authored polygons come
// in with solid full-height perimeter walls; without this pass
// a step-height platform's perimeter would render + collide as
// a full-height blocker even though the player should be able
// to walk onto it. Server runs this in Scene.rebuildSectorMap;
// client v2 renderer runs it in the authored-map converter so
// the visual + collision representations stay aligned.
//
// Idempotent — walls that already carry overrides are left
// alone (procgen risers, building-cube walls). Mutates the
// SectorMap in place.
// Pre-pass — splits walls of different sectors whose segments
// are collinear and partially overlap. Inserts vertices into
// the owning polygons at the overlap endpoints and regenerates
// the walls so each split sub-wall becomes its own segment.
// `riserifyWalls` then sees a true shared-edge wall (the
// overlapping portion) plus the unshared remnants, and only
// portals the shared one.
//
// Authoring intent: drawing a tunnel that attaches to part of
// a room's wall no longer requires manually inserting verts
// into the room polygon up front — the loader does it.
export function splitOverlappingWalls(map: SectorMap): void {
  const EPS = 0.5;
  // Iterate until stable. Each pass splits AT MOST one wall per
  // overlap pair so subsequent overlaps with the newly-created
  // sub-walls get caught on the next pass. Bounded by the number
  // of overlap relations; small.
  const MAX_ITERATIONS = 8;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (!splitOnePass(map, EPS)) return;
  }
}

function splitOnePass(map: SectorMap, EPS: number): boolean {
  // Find one pair of collinear overlapping walls, split the
  // longer one (or both) at the overlap endpoints. Returns
  // true if any split happened so the caller re-iterates.
  for (let i = 0; i < map.walls.length; i++) {
    const w1 = map.walls[i];
    if (w1.buildingKind !== undefined) continue;
    const s1 = map.sectors[w1.sectorId];
    if (!s1 || s1.buildingKind !== undefined) continue;
    const a1 = s1.verts[w1.vertIdx];
    const b1 = s1.verts[(w1.vertIdx + 1) % s1.verts.length];
    if (!a1 || !b1) continue;
    for (let j = i + 1; j < map.walls.length; j++) {
      const w2 = map.walls[j];
      if (w2.buildingKind !== undefined) continue;
      if (w2.sectorId === w1.sectorId) continue;
      const s2 = map.sectors[w2.sectorId];
      if (!s2 || s2.buildingKind !== undefined) continue;
      const a2 = s2.verts[w2.vertIdx];
      const b2 = s2.verts[(w2.vertIdx + 1) % s2.verts.length];
      if (!a2 || !b2) continue;
      const overlap = collinearOverlap(a1, b1, a2, b2, EPS);
      if (!overlap) continue;
      // Insert verts into both polygons at any overlap endpoint
      // that isn't already a vertex of the polygon, then
      // regenerate walls for the affected sectors. Return true
      // so the outer loop re-iterates.
      const changed1 = insertVertsOnEdge(s1, map.walls, w1.vertIdx, overlap.p, overlap.q, EPS);
      const changed2 = insertVertsOnEdge(s2, map.walls, w2.vertIdx, overlap.p, overlap.q, EPS);
      if (changed1 || changed2) return true;
    }
  }
  return false;
}

// Two segments overlap iff they're collinear AND their parameter
// ranges intersect on a positive-length sub-segment. Returns
// the endpoints of the overlap (in world coords) or null.
function collinearOverlap(
  a1: Vec2,
  b1: Vec2,
  a2: Vec2,
  b2: Vec2,
  EPS: number,
): { p: Vec2; q: Vec2 } | null {
  // Direction of segment 1.
  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const len1Sq = dx * dx + dy * dy;
  if (len1Sq === 0) return null;
  // Check segment 2's endpoints lie on line 1 (cross product ≈ 0).
  const cross2a = (a2.x - a1.x) * dy - (a2.y - a1.y) * dx;
  const cross2b = (b2.x - a1.x) * dy - (b2.y - a1.y) * dx;
  const collinearTol = EPS * Math.sqrt(len1Sq);
  if (Math.abs(cross2a) > collinearTol) return null;
  if (Math.abs(cross2b) > collinearTol) return null;
  // Project a2, b2 onto segment 1's parameter t ∈ [0,1].
  const t2a = ((a2.x - a1.x) * dx + (a2.y - a1.y) * dy) / len1Sq;
  const t2b = ((b2.x - a1.x) * dx + (b2.y - a1.y) * dy) / len1Sq;
  const lo = Math.min(t2a, t2b);
  const hi = Math.max(t2a, t2b);
  const overlapLo = Math.max(0, lo);
  const overlapHi = Math.min(1, hi);
  if (overlapHi - overlapLo < EPS / Math.sqrt(len1Sq)) return null;
  // Skip when the overlap IS the full segment — nothing to
  // split, riserifyWalls handles full-overlap directly.
  if (overlapLo < EPS / Math.sqrt(len1Sq) && overlapHi > 1 - EPS / Math.sqrt(len1Sq)) {
    return null;
  }
  return {
    p: { x: a1.x + dx * overlapLo, y: a1.y + dy * overlapLo },
    q: { x: a1.x + dx * overlapHi, y: a1.y + dy * overlapHi },
  };
}

// Insert verts p, q into the polygon's vert ring along the edge
// `edgeVertIdx → edgeVertIdx+1` (in order along the edge), then
// rebuild the walls referencing that polygon so subsequent walls'
// vertIdx values stay correct. Returns true if anything changed.
export function insertVertsOnEdge(
  sector: Sector,
  walls: Wall[],
  edgeVertIdx: number,
  p: Vec2,
  q: Vec2,
  EPS: number,
): boolean {
  const a = sector.verts[edgeVertIdx];
  const b = sector.verts[(edgeVertIdx + 1) % sector.verts.length];
  // Sort p, q along the a→b direction so insertions stay in order.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const tp = (p.x - a.x) * dx + (p.y - a.y) * dy;
  const tq = (q.x - a.x) * dx + (q.y - a.y) * dy;
  const [first, second] = tp <= tq ? [p, q] : [q, p];
  const inserts: Vec2[] = [];
  if (
    !vecNear(a, first, EPS) &&
    !vecNear(b, first, EPS)
  ) {
    inserts.push(first);
  }
  if (
    !vecNear(a, second, EPS) &&
    !vecNear(b, second, EPS) &&
    !vecNear(first, second, EPS)
  ) {
    inserts.push(second);
  }
  if (inserts.length === 0) return false;
  const insertAt = edgeVertIdx + 1;
  // Splice the new verts into the polygon.
  sector.verts.splice(insertAt, 0, ...inserts);
  // Rebuild walls for this sector. Preserve metadata (textureId,
  // solid, overrides, buildingKind) for the ORIGINAL edge — every
  // newly-emitted sub-wall inherits it.
  const origIndex = walls.findIndex(
    (w) => w.sectorId === sector.id && w.vertIdx === edgeVertIdx,
  );
  const original = origIndex >= 0 ? walls[origIndex] : null;
  // Bump every wall (in EVERY sector) whose vertIdx points past
  // the insertion point in THIS sector.
  for (const w of walls) {
    if (w.sectorId !== sector.id) continue;
    if (w.vertIdx > edgeVertIdx) {
      w.vertIdx += inserts.length;
    }
  }
  // Emit sub-walls for the new edges that REPLACE the original
  // single wall. Sub-wall count = inserts.length + 1.
  if (original) {
    walls.splice(origIndex, 1); // remove original
    for (let k = 0; k <= inserts.length; k++) {
      walls.push({
        sectorId: sector.id,
        vertIdx: edgeVertIdx + k,
        backSectorId: original.backSectorId,
        textureId: original.textureId,
        solid: original.solid,
        floorZOverride: original.floorZOverride,
        ceilingZOverride: original.ceilingZOverride,
        buildingKind: original.buildingKind,
      });
    }
  }
  return true;
}

export function vecNear(a: Vec2, b: Vec2, eps: number): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

// ---------- Validation ----------

export type SceneValidation = {
  errors: string[];
  warnings: string[];
  // The scene with auto-fixes applied: winding reversed to CCW
  // where needed, bounds recomputed. Errors are non-auto-fixable
  // (caller decides whether to refuse save).
  fixed: SectorScene;
};

// Shoelace signed area on a polygon. > 0 CCW, < 0 CW.
function polygonSignedArea(verts: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

function isPolygonConvex(verts: Vec2[]): boolean {
  if (verts.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const c = verts[(i + 2) % verts.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
  }
  return true;
}

export function validateSectorScene(scene: SectorScene): SceneValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Per-sector: fix CW winding, warn on concave, check wall refs.
  const fixedSectors: Sector[] = [];
  const wallFlipMap = new Map<number, Set<number>>(); // sectorId → vertIdxes that need bumping due to reverse
  for (const sector of scene.map.sectors) {
    if (sector.verts.length < 3) {
      errors.push(`Sector ${sector.id} has < 3 vertices.`);
      fixedSectors.push(sector);
      continue;
    }
    let verts = sector.verts;
    const area = polygonSignedArea(verts);
    if (area < 0) {
      // Reverse to CCW. Walls referencing vertIdx need a remap.
      verts = verts.slice().reverse();
      const n = sector.verts.length;
      const flips = new Set<number>();
      for (let i = 0; i < n; i++) flips.add(i);
      wallFlipMap.set(sector.id, flips);
    }
    if (!isPolygonConvex(verts)) {
      warnings.push(
        `Sector ${sector.id} is concave. Collision uses convex point-in-polygon; tunnel-shaped sectors may have slip-through. Consider splitting.`,
      );
    }
    fixedSectors.push({ ...sector, verts });
  }

  // Walls: bump vertIdx for reversed sectors. The reversal flips
  // edge ordering — old edge i (vert i → vert (i+1)) becomes the
  // edge starting at vert (n-1-i) after reversal.
  const fixedWalls: Wall[] = [];
  for (const wall of scene.map.walls) {
    const sec = fixedSectors[wall.sectorId];
    if (!sec) {
      errors.push(
        `Wall references missing sector ${wall.sectorId}.`,
      );
      fixedWalls.push(wall);
      continue;
    }
    if (wall.vertIdx < 0 || wall.vertIdx >= sec.verts.length) {
      errors.push(
        `Wall in sector ${wall.sectorId} has invalid vertIdx ${wall.vertIdx} (sector has ${sec.verts.length} verts).`,
      );
      fixedWalls.push(wall);
      continue;
    }
    const flipped = wallFlipMap.has(wall.sectorId);
    if (flipped) {
      const n = sec.verts.length;
      // Old edge i is now edge (n - 1 - i) in the reversed order.
      const newIdx = (n - 1 - wall.vertIdx + n) % n;
      fixedWalls.push({ ...wall, vertIdx: newIdx });
    } else {
      fixedWalls.push(wall);
    }
  }

  // Walkable sectors index for spawn / interactable checks.
  const walkable = fixedSectors.filter(
    (s) => s.buildingKind === undefined && s.verts.length >= 3,
  );
  const inWalkable = (x: number, y: number): boolean => {
    for (const s of walkable) {
      if (pointInPolygon(s.verts, x, y)) return true;
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
  // Soft: at least one extract / stairs.
  const hasExit = scene.interactables.some(
    (i) => i.kind === 'extract_pad' || i.kind === 'stairs_down',
  );
  if (!hasExit) {
    warnings.push(
      `Scene has no extract_pad or stairs_down interactable — players will be stuck on the scene.`,
    );
  }

  // Recompute bounds from sector verts. Defensive — editor
  // updates bounds on mutation but a hand-edited JSON might
  // drift.
  let bounds = scene.map.bounds;
  if (walkable.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of fixedSectors) {
      for (const v of s.verts) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
      }
    }
    bounds = {
      x: Math.floor(minX) - 16,
      y: Math.floor(minY) - 16,
      w: Math.ceil(maxX - minX) + 32,
      h: Math.ceil(maxY - minY) + 32,
    };
  }

  return {
    errors,
    warnings,
    fixed: {
      ...scene,
      map: {
        ...scene.map,
        sectors: fixedSectors,
        walls: fixedWalls,
        bounds,
      },
    },
  };
}

// Helper: walkable (non-building) sector containing (x, y).
// Used by riserifyWalls to look up the neighbour's ceiling when
// deciding whether to emit a lintel quad. Polygon scan; cheap
// at editor scales.
function findSectorAt(map: SectorMap, x: number, y: number): Sector | null {
  for (const s of map.sectors) {
    if (s.buildingKind !== undefined) continue;
    if (pointInPolygon(s.verts, x, y)) return s;
  }
  return null;
}

export function riserifyWalls(map: SectorMap): void {
  // Two-pass detection:
  //   1. SHARED EDGE: wall sits on the boundary between two
  //      walkable sectors. Outward sample lands in neighbour
  //      AND within `SHARED_EDGE_NEAR` of the neighbour's own
  //      perimeter. This catches all true shared edges
  //      regardless of winding / float drift, AND rejects
  //      OVERLAP-into-interior (sample lands deep in neighbour
  //      far from its perimeter → not shared).
  //   2. CONTAINED RISER: same midpoint sample, but accept only
  //      lower-floor neighbours that the sample lands DEEP
  //      inside (a step / platform drawn within a bigger room).
  // A wall that already carries overrides is left alone
  // (procgen-emitted risers, building-cube walls).
  const SHARED_EDGE_NEAR = 1.5; // wu — generous of the 0.5
                                 // outward nudge plus authoring
                                 // precision.
  for (const wall of map.walls) {
    if (wall.buildingKind !== undefined) continue;
    if (
      wall.floorZOverride !== undefined ||
      wall.ceilingZOverride !== undefined
    ) {
      continue;
    }
    const owner = map.sectors[wall.sectorId];
    if (!owner) continue;
    if (owner.buildingKind !== undefined) continue;
    const a = owner.verts[wall.vertIdx];
    const b = owner.verts[(wall.vertIdx + 1) % owner.verts.length];
    if (!a || !b) continue;
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const nx = dy / len;
    const ny = -dx / len;
    const sx = mx + nx * 0.5;
    const sy = my + ny * 0.5;

    let sharedNeighbour: { floorZ: number } | null = null;
    let containedLowerNeighbour: { floorZ: number } | null = null;
    for (const s of map.sectors) {
      if (s.id === owner.id) continue;
      if (s.buildingKind !== undefined) continue;
      if (!pointInPolygon(s.verts, sx, sy)) continue;
      // Distance to neighbour's nearest edge. If small → the
      // sample is on the neighbour's perimeter → shared edge.
      // If large → sample is interior → overlap, treat as
      // contained-riser candidate only.
      let minPerim = Infinity;
      for (let i = 0; i < s.verts.length; i++) {
        const va = s.verts[i];
        const vb = s.verts[(i + 1) % s.verts.length];
        const d = pointSegmentDistance(va.x, va.y, vb.x, vb.y, sx, sy);
        if (d < minPerim) minPerim = d;
      }
      if (minPerim <= SHARED_EDGE_NEAR) {
        if (
          !sharedNeighbour ||
          s.floorZ > sharedNeighbour.floorZ
        ) {
          sharedNeighbour = { floorZ: s.floorZ };
        }
      } else if (s.floorZ < owner.floorZ) {
        if (
          !containedLowerNeighbour ||
          s.floorZ > containedLowerNeighbour.floorZ
        ) {
          containedLowerNeighbour = { floorZ: s.floorZ };
        }
      }
    }

    if (sharedNeighbour) {
      // Lookup the neighbour sector so we can read its ceiling
      // for the lintel test. sharedNeighbour only carries the
      // floor; we need the full sector here.
      const neighbourSector = findSectorAt(map, sx, sy);
      const neighbourCeil =
        neighbourSector && neighbourSector.ceilingZ > neighbourSector.floorZ
          ? neighbourSector.ceilingZ
          : Infinity;
      const ownerCeil =
        owner.ceilingZ > owner.floorZ ? owner.ceilingZ : Infinity;
      const isFloorRiser = sharedNeighbour.floorZ < owner.floorZ;
      const isCeilingLintel =
        ownerCeil > neighbourCeil &&
        Number.isFinite(neighbourCeil) &&
        Number.isFinite(ownerCeil);
      // Floor delta → emit a riser quad (visible step-down on
      // this side). Clearing solid lets the player traverse the
      // portal above the riser.
      if (isFloorRiser) {
        wall.solid = false;
        wall.floorZOverride = sharedNeighbour.floorZ;
        wall.ceilingZOverride = owner.floorZ;
      }
      // Lintel: if owner's ceiling extends above the neighbour's
      // ceiling, the slab between them is visible from THIS side
      // as a wall above the doorway. Push a second Wall on the
      // same edge with the lintel's vertical span. The collision
      // path treats it like any other tall wall (head-bonk + LOS
      // already use the override range).
      //
      // The wall's own `solid` flag is respected verbatim — a
      // ceiling delta does NOT imply a doorway below. Procgen
      // rooms and corridors now roll different ceiling heights,
      // so most SEALED dividing walls sit between sectors of
      // unequal ceilingZ; the old `solid = false` here turned
      // every one of those dividers into an open portal. Authors
      // who want a passable opening under a lintel set
      // solid:false on the shared walls, exactly as they already
      // must for equal-height portals (see the comment below).
      if (isCeilingLintel) {
        // Skip the push when an identical lintel band already
        // exists on this edge — the linedef→polygon reverse
        // converter emits upper walls for two-sided ceiling
        // deltas, and re-running riserifyWalls on such a map
        // would stack a duplicate quad (z-fighting).
        const exists = map.walls.some(
          (w) =>
            w.sectorId === wall.sectorId &&
            w.vertIdx === wall.vertIdx &&
            w.floorZOverride === neighbourCeil &&
            w.ceilingZOverride === ownerCeil,
        );
        if (!exists) {
          map.walls.push({
            sectorId: wall.sectorId,
            vertIdx: wall.vertIdx,
            backSectorId: wall.backSectorId,
            textureId: wall.textureId,
            solid: true,
            floorZOverride: neighbourCeil,
            ceilingZOverride: ownerCeil,
            buildingKind: wall.buildingKind,
          });
        }
      }
      // No geometric delta (floors + ceilings match): respect the
      // author's solid flag verbatim. Procgen-emitted sealed walls
      // between adjacent rooms (`solid:true` + `backSectorId !==
      // null`) used to get force-cleared here, collapsing every
      // dungeon into one open hall. Tile-grid maps don't emit
      // walls between same-floor walkable tiles, so no convenience
      // is lost there either.
      continue;
    }
    if (containedLowerNeighbour) {
      wall.solid = false;
      wall.floorZOverride = containedLowerNeighbour.floorZ;
      wall.ceilingZOverride = owner.floorZ;
    }
  }
}
