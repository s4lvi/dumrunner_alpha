// Pack a SectorMap into a single triangulated Geometry the v2
// renderer's Mesh can draw. One mesh = the whole scene's floors
// + ceilings + walls; Pixi will issue one indexed draw call per
// frame, which is what we want for mobile.
//
// Vertex layout (aPosition vec3, aBaseColor vec3) matches the
// Phase 1 shader so we can render real geometry without changing
// the shader. Phase 2.5 will swap the colour attribute for UVs +
// a sampler when textures land.
//
// Each sector polygon is fan-triangulated. The Phase 2 converter
// only emits convex 4-vert sectors (one quad per walkable tile),
// so fan-triangulation is exact. When the converter starts
// merging tiles into concave polygons we'll need earcut here;
// the call site is one function so the upgrade is local.

import { Buffer, BufferUsage, Geometry } from 'pixi.js';
import earcut from 'earcut';
import { sectorNoiseOffsetAt, terrainHeightAt } from '@dumrunner/shared';
import type { SectorMap, Sector } from './types';

// Earcut wrapper for a sector polygon with optional hole rings.
// Returns triangle indices into a synthetic vertex buffer that
// is outer.verts CONCATENATED with each hole's verts (in order).
// The caller builds the positions buffer in the same order.
function triangulateWithHoles(
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][],
): number[] {
  const flat: number[] = [];
  for (const v of outer) flat.push(v.x, v.y);
  const holeIdx: number[] = [];
  for (const h of holes) {
    holeIdx.push(flat.length / 2);
    for (const v of h) flat.push(v.x, v.y);
  }
  return earcut(flat, holeIdx, 2);
}

type ColorChoice = {
  floor: number;
  ceiling: number;
  wall: number;
};

type GeometryBundle = {
  geometry: Geometry;
  // Vertex count is exposed so the renderer can log scene
  // complexity for tuning the per-fragment light budget later.
  vertexCount: number;
  triangleCount: number;
};

export function buildSectorGeometry(
  map: SectorMap,
  colors: ColorChoice,
  // Building kinds with a textured shell — their colored cube
  // is suppressed so only the textured one renders. Kinds NOT
  // in this set keep their colored fallback (this is what
  // shows when a building has no authored texture or animation).
  skipBuildingKinds: ReadonlySet<string> = new Set(),
): GeometryBundle {
  // Estimate buffer sizes up front so we don't reallocate while
  // pushing. Each sector contributes (verts × 2) vertices for
  // its floor + ceiling rings plus the matching triangle fans.
  // Open-air sectors (ceilingZ <= floorZ — surface) contribute
  // only the floor half. Each wall contributes 4 vertices + 2
  // triangles.
  let estVerts = 0;
  let estTris = 0;
  for (const s of map.sectors) {
    const hasCeiling = s.ceilingZ > s.floorZ;
    estVerts += s.verts.length * (hasCeiling ? 2 : 1);
    estTris += (s.verts.length - 2) * (hasCeiling ? 2 : 1);
  }
  estVerts += map.walls.length * 4;
  estTris += map.walls.length * 2;

  const positions = new Float32Array(estVerts * 3);
  const colorsBuf = new Float32Array(estVerts * 3);
  const indices = new Uint32Array(estTris * 3);
  let vCursor = 0;
  let iCursor = 0;

  // Color encoding: pack 0xrrggbb → vec3 floats in [0..1].
  const floorRGB = unpackRGB(colors.floor);
  const ceilingRGB = unpackRGB(colors.ceiling);
  const wallRGB = unpackRGB(colors.wall);

  // Sector ID → base vertex offset for the floor and ceiling
  // rings of that sector. Wall pass below reads it to pull the
  // matching wall endpoint Z values without re-deriving them.
  // (Not strictly needed today since Wall already references a
  // vertIdx into Sector.verts; but having the lookup in place
  // means walls and polygons stay in lockstep when we start
  // merging tiles into multi-vert sectors.)
  const sectorVertOffset: number[] = new Array(map.sectors.length).fill(0);

  for (const sector of map.sectors) {
    // Only building-cube caps render here. Room floors AND
    // platform tops belong to the textured-surface pass —
    // their visual identity is the biome floor texture, not
    // a flat tint.
    if (sector.buildingKind === undefined) continue;
    // Skip cube caps whose kind has a textured shell.
    if (skipBuildingKinds.has(sector.buildingKind)) continue;
    const offset = vCursor;
    sectorVertOffset[sector.id] = offset;
    const hasCeiling = sector.ceilingZ > sector.floorZ;
    // Push floor ring; ceiling ring only when this sector has a
    // ceiling. Floor + ceiling stay contiguous so the wall pass
    // can address ceiling vertices by `offset + verts.length`.
    pushRing(
      positions,
      colorsBuf,
      vCursor,
      sector,
      sector.floorZ,
      floorRGB,
    );
    if (hasCeiling) {
      pushRing(
        positions,
        colorsBuf,
        vCursor + sector.verts.length,
        sector,
        sector.ceilingZ,
        ceilingRGB,
      );
    }
    vCursor += sector.verts.length * (hasCeiling ? 2 : 1);

    // Fan-triangulate the floor ring. Winding is CCW viewed from
    // above; the camera is above the floor looking down, so this
    // is the front face.
    iCursor = pushFloorFan(
      indices,
      iCursor,
      offset,
      sector.verts.length,
    );
    if (hasCeiling) {
      // Ceiling fan winding is reversed so its front face points
      // down at the camera (which sits below the ceiling looking
      // up). Same vertex set, opposite triangle orientation.
      iCursor = pushCeilingFan(
        indices,
        iCursor,
        offset + sector.verts.length,
        sector.verts.length,
      );
    }
  }

  // Walls: each wall is a vertical quad spanning from the floor
  // to the ceiling, between two consecutive sector vertices.
  // Quad winding (viewed from the outside of the sector, i.e.
  // from the void side):
  //   v0 = floor at vertIdx
  //   v1 = floor at vertIdx+1
  //   v2 = ceiling at vertIdx+1
  //   v3 = ceiling at vertIdx
  // CCW: v0 → v1 → v2 → v3 forms the outward-facing face. Two
  // triangles: (v0, v1, v2) and (v0, v2, v3).
  for (const wall of map.walls) {
    // Building-cube walls live here (their visual identity is
    // the cube colour, not a biome wall texture). Everything
    // else — room walls, platform risers — belongs to the
    // textured pass.
    if (wall.buildingKind === undefined) continue;
    // Skip when a textured shell is replacing this cube.
    if (skipBuildingKinds.has(wall.buildingKind)) continue;
    const sector = map.sectors[wall.sectorId];
    if (!sector) continue;
    // Explicit endpoint coords win (set by the linedef converter
    // for inner-loop walls around carved sub-sectors). Else fall
    // back to indexing sector.verts (procgen / tile-grid maps).
    const a =
      wall.ax !== undefined && wall.ay !== undefined
        ? { x: wall.ax, y: wall.ay }
        : sector.verts[wall.vertIdx];
    const b =
      wall.bx !== undefined && wall.by !== undefined
        ? { x: wall.bx, y: wall.by }
        : sector.verts[(wall.vertIdx + 1) % sector.verts.length];
    if (!a || !b) continue;
    const floorZ =
      wall.floorZOverride !== undefined ? wall.floorZOverride : sector.floorZ;
    const ceilingZ =
      wall.ceilingZOverride !== undefined
        ? wall.ceilingZOverride
        : sector.ceilingZ;
    if (ceilingZ <= floorZ) continue;
    const base = vCursor;
    pushVertex(positions, colorsBuf, base + 0, a.x, a.y, floorZ, wallRGB);
    pushVertex(positions, colorsBuf, base + 1, b.x, b.y, floorZ, wallRGB);
    pushVertex(positions, colorsBuf, base + 2, b.x, b.y, ceilingZ, wallRGB);
    pushVertex(positions, colorsBuf, base + 3, a.x, a.y, ceilingZ, wallRGB);
    vCursor += 4;
    indices[iCursor++] = base + 0;
    indices[iCursor++] = base + 1;
    indices[iCursor++] = base + 2;
    indices[iCursor++] = base + 0;
    indices[iCursor++] = base + 2;
    indices[iCursor++] = base + 3;
  }

  // Trim to actual usage. Our estimates were exact for the
  // current converter, but trimming is defensive: a future
  // converter that emits sectors with shared walls (so the
  // wall count is lower than n_neighbours suggests) will need
  // these slices to not over-upload empty regions to the GPU.
  const finalPositions = positions.subarray(0, vCursor * 3);
  const finalColors = colorsBuf.subarray(0, vCursor * 3);
  const finalIndices = indices.subarray(0, iCursor);

  const geometry = new Geometry({
    attributes: {
      aPosition: {
        buffer: new Buffer({
          data: new Float32Array(finalPositions),
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x3',
      },
      aBaseColor: {
        buffer: new Buffer({
          data: new Float32Array(finalColors),
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x3',
      },
    },
    indexBuffer: new Buffer({
      data: new Uint32Array(finalIndices),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
  });
  return {
    geometry,
    vertexCount: vCursor,
    triangleCount: iCursor / 3,
  };
}

function unpackRGB(c: number): [number, number, number] {
  return [
    ((c >> 16) & 0xff) / 255,
    ((c >> 8) & 0xff) / 255,
    (c & 0xff) / 255,
  ];
}

function pushVertex(
  positions: Float32Array,
  colors: Float32Array,
  vIndex: number,
  x: number,
  y: number,
  z: number,
  rgb: [number, number, number],
): void {
  const pi = vIndex * 3;
  positions[pi + 0] = x;
  positions[pi + 1] = y;
  positions[pi + 2] = z;
  colors[pi + 0] = rgb[0];
  colors[pi + 1] = rgb[1];
  colors[pi + 2] = rgb[2];
}

function pushRing(
  positions: Float32Array,
  colors: Float32Array,
  vBase: number,
  sector: Sector,
  z: number,
  rgb: [number, number, number],
): void {
  for (let i = 0; i < sector.verts.length; i++) {
    const v = sector.verts[i];
    pushVertex(positions, colors, vBase + i, v.x, v.y, z, rgb);
  }
}

function pushFloorFan(
  indices: Uint32Array,
  iCursor: number,
  vBase: number,
  vertCount: number,
): number {
  for (let i = 1; i < vertCount - 1; i++) {
    indices[iCursor++] = vBase + 0;
    indices[iCursor++] = vBase + i;
    indices[iCursor++] = vBase + i + 1;
  }
  return iCursor;
}

function pushCeilingFan(
  indices: Uint32Array,
  iCursor: number,
  vBase: number,
  vertCount: number,
): number {
  for (let i = 1; i < vertCount - 1; i++) {
    // Reverse winding for ceiling (faces down, toward the camera).
    indices[iCursor++] = vBase + 0;
    indices[iCursor++] = vBase + i + 1;
    indices[iCursor++] = vBase + i;
  }
  return iCursor;
}

// ---------- Textured surface geometry ----------
//
// Three flavours, each emits only the triangles for one surface
// type with UVs computed in tile-space (one UV repeat per
// TEXTURE_TILE_PX world units). Render order in the v2
// renderer: colored sector mesh first → textured floor →
// textured ceiling → textured wall. Pixi v8 depth test is
// LEQUAL so co-planar triangles drawn later win — the textured
// pass overdraws the colored fallback without z-fighting where
// textures are loaded.
//
// Only real dungeon surfaces are emitted. Building cubes
// (`buildingKind` set on the sector / wall) are excluded so they
// continue to render via the colored mesh — their visual
// identity is the cube itself, not the biome wall texture.
// Platforms (sectors with `floorZ > 0` and no `buildingKind`)
// ARE emitted: their top reads as a raised biome floor and the
// ceiling-line stays the same as the surrounding room.

const TEXTURE_TILE_PX = 32;

export function buildTexturedFloorGeometry(
  map: SectorMap,
  terrain?: import('@dumrunner/shared').TerrainConfig | null,
): Geometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const brightness: number[] = [];
  let vCursor = 0;
  // Tessellation stride (world units). 64 px gives ~80×80 ≈ 6k
  // verts on a typical 5000×5000 worldbounds — chunky but fine
  // on desktop. Tune down for sharper hills, up for mobile.
  const TERRAIN_STRIDE = 64;
  // Floors face +Z (up). Same brightness for every floor vertex.
  const floorBrightness = brightnessForNormal(0, 0, 1);
  for (const sector of map.sectors) {
    if (sector.buildingKind !== undefined) continue;
    if (terrain && isBigQuadSector(sector)) {
      vCursor = tessellateRectFloor(
        sector,
        terrain,
        TERRAIN_STRIDE,
        positions,
        uvs,
        indices,
        brightness,
        vCursor,
      );
      continue;
    }
    // Polygon-with-holes path when the sector carries inner-loop
    // holes (set by the linedef → polygon converter for carved
    // sub-sectors). The renderer triangulates the outer minus
    // every hole so a pit's lower floor is actually visible from
    // above. For sectors without holes, fall back to fan-tri.
    const useNoise = !!sector.floorNoise;
    if (sector.holes && sector.holes.length > 0) {
      const ringVerts: { x: number; y: number }[] = [
        ...sector.verts,
        ...sector.holes.flat(),
      ];
      const tris = triangulateWithHoles(sector.verts, sector.holes);
      vCursor = emitFloorMesh(
        ringVerts,
        tris,
        sector,
        floorBrightness,
        positions,
        uvs,
        brightness,
        indices,
        vCursor,
        useNoise,
      );
      continue;
    }
    // No holes: still use earcut. Fan triangulation only works
    // on convex polygons — when a sector's outer perimeter has
    // notches (e.g. a sub-sector that touches the outer wall
    // gets carved as a detour instead of a separate hole), fan
    // tris span across the notch and overdraw adjacent sectors'
    // floors. earcut handles arbitrary simple polygons.
    const ringVerts = sector.verts.map((v) => ({ x: v.x, y: v.y }));
    const tris = triangulateWithHoles(sector.verts, []);
    vCursor = emitFloorMesh(
      ringVerts,
      tris,
      sector,
      floorBrightness,
      positions,
      uvs,
      brightness,
      indices,
      vCursor,
      useNoise,
    );
  }
  if (indices.length === 0) return null;
  return makeTexturedSurfaceGeometry(positions, uvs, indices, brightness);
}

// Stride (wu) used when subdividing a noise-enabled sector's
// floor or ceiling. Smaller → smoother hills, more verts. 24 wu
// reads visually-continuous against typical amplitudes 4–12 wu.
const NOISE_SUBDIV_STRIDE = 24;

// Emit a sector's floor mesh, applying per-vertex Z displacement
// when the sector has `floorNoise` set. Without noise, this is a
// thin wrapper over the existing flat-floor codepath.
//
// With noise: subdivide each earcut triangle 1-to-4 until no edge
// exceeds NOISE_SUBDIV_STRIDE, then sample noise + perimeter
// falloff at each output vertex. This is more expensive than the
// flat path (~20× verts on a 256x256 sector) but only runs for
// sectors that opt in.
function emitFloorMesh(
  ringVerts: { x: number; y: number }[],
  tris: number[],
  sector: Sector,
  floorBrightness: number,
  positions: number[],
  uvs: number[],
  brightness: number[],
  indices: number[],
  vCursor: number,
  useNoise: boolean,
): number {
  const noiseCfg = sector.floorNoise ?? null;
  if (!useNoise || !noiseCfg) {
    const baseV = vCursor;
    for (const v of ringVerts) {
      positions.push(v.x, v.y, sector.floorZ);
      uvs.push(v.x / TEXTURE_TILE_PX, v.y / TEXTURE_TILE_PX);
      brightness.push(floorBrightness);
    }
    for (const idx of tris) indices.push(baseV + idx);
    return vCursor + ringVerts.length;
  }
  // Subdivide once and stop when no triangle has a long edge.
  // Cap iterations so authoring mistakes (e.g. amplitude=0 noise
  // with stride=0.001) can't lock the renderer.
  const sub = subdivideTriangles(
    ringVerts.map((v) => ({ x: v.x, y: v.y })),
    tris,
    NOISE_SUBDIV_STRIDE,
    6,
  );
  const baseV = vCursor;
  for (const v of sub.verts) {
    const dz = sectorNoiseOffsetAt(
      noiseCfg,
      sector.verts,
      sector.holes,
      v.x,
      v.y,
    );
    positions.push(v.x, v.y, sector.floorZ + dz);
    uvs.push(v.x / TEXTURE_TILE_PX, v.y / TEXTURE_TILE_PX);
    brightness.push(floorBrightness);
  }
  for (const idx of sub.tris) indices.push(baseV + idx);
  return vCursor + sub.verts.length;
}

// Ceiling counterpart of `emitFloorMesh`. Same subdivision +
// noise pipeline; winding reversed so the front face points
// DOWN (camera sees the ceiling from below).
function emitCeilingMesh(
  ringVerts: { x: number; y: number }[],
  tris: number[],
  sector: Sector,
  ceilingBrightness: number,
  positions: number[],
  uvs: number[],
  brightness: number[],
  indices: number[],
  vCursor: number,
  useNoise: boolean,
): number {
  const noiseCfg = sector.ceilingNoise ?? null;
  if (!useNoise || !noiseCfg) {
    const baseV = vCursor;
    for (const v of ringVerts) {
      positions.push(v.x, v.y, sector.ceilingZ);
      uvs.push(v.x / TEXTURE_TILE_PX, v.y / TEXTURE_TILE_PX);
      brightness.push(ceilingBrightness);
    }
    for (let i = 0; i < tris.length; i += 3) {
      indices.push(
        baseV + tris[i],
        baseV + tris[i + 2],
        baseV + tris[i + 1],
      );
    }
    return vCursor + ringVerts.length;
  }
  const sub = subdivideTriangles(
    ringVerts.map((v) => ({ x: v.x, y: v.y })),
    tris,
    NOISE_SUBDIV_STRIDE,
    6,
  );
  const baseV = vCursor;
  for (const v of sub.verts) {
    const dz = sectorNoiseOffsetAt(
      noiseCfg,
      sector.verts,
      sector.holes,
      v.x,
      v.y,
    );
    // Ceiling noise drops the ceiling LOWER (negative offset) so
    // hills hang from the ceiling toward the floor — feels right
    // for cave-style overheads. Use abs() so the amplitude is the
    // magnitude regardless of noise sign.
    positions.push(v.x, v.y, sector.ceilingZ - Math.abs(dz));
    uvs.push(v.x / TEXTURE_TILE_PX, v.y / TEXTURE_TILE_PX);
    brightness.push(ceilingBrightness);
  }
  for (let i = 0; i < sub.tris.length; i += 3) {
    indices.push(
      baseV + sub.tris[i],
      baseV + sub.tris[i + 2],
      baseV + sub.tris[i + 1],
    );
  }
  return vCursor + sub.verts.length;
}

// Midpoint subdivision until every edge in the mesh is ≤ `maxEdge`
// (or until `maxIters` is hit — bound on runtime for tiny
// amplitudes or pathologically large sectors). Only edges that
// individually exceed the threshold get split, and the resulting
// 1/2/3-edge cases each emit a topology that places the new vertex
// on the shared edge — so adjacent triangles agree on every shared
// edge and the mesh stays watertight (no T-junctions, no cracking
// visible against the wall mesh or skybox).
function subdivideTriangles(
  initialVerts: { x: number; y: number }[],
  initialTris: number[],
  maxEdge: number,
  maxIters: number,
): { verts: { x: number; y: number }[]; tris: number[] } {
  const verts = initialVerts.slice();
  let triPairs: number[][] = [];
  for (let i = 0; i < initialTris.length; i += 3) {
    triPairs.push([initialTris[i], initialTris[i + 1], initialTris[i + 2]]);
  }
  const midCache = new Map<string, number>();
  const edgeKey = (a: number, b: number): string =>
    a < b ? `${a}_${b}` : `${b}_${a}`;
  const midpoint = (a: number, b: number): number => {
    const key = edgeKey(a, b);
    const cached = midCache.get(key);
    if (cached !== undefined) return cached;
    const av = verts[a];
    const bv = verts[b];
    const idx = verts.length;
    verts.push({ x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 });
    midCache.set(key, idx);
    return idx;
  };
  for (let iter = 0; iter < maxIters; iter++) {
    const next: number[][] = [];
    let didSplit = false;
    for (const [a, b, c] of triPairs) {
      const av = verts[a];
      const bv = verts[b];
      const cv = verts[c];
      const sAB = Math.hypot(bv.x - av.x, bv.y - av.y) > maxEdge;
      const sBC = Math.hypot(cv.x - bv.x, cv.y - bv.y) > maxEdge;
      const sCA = Math.hypot(av.x - cv.x, av.y - cv.y) > maxEdge;
      const count = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0);
      if (count === 0) {
        next.push([a, b, c]);
        continue;
      }
      didSplit = true;
      if (count === 3) {
        const mAB = midpoint(a, b);
        const mBC = midpoint(b, c);
        const mCA = midpoint(c, a);
        next.push([a, mAB, mCA]);
        next.push([mAB, b, mBC]);
        next.push([mCA, mBC, c]);
        next.push([mAB, mBC, mCA]);
      } else if (count === 1) {
        // Bisect the one long edge. Splits the triangle into two
        // sub-triangles sharing the new vertex; the short edges
        // (CA in the AB-split case, etc.) stay intact so the
        // unsplit neighbour across them still tiles cleanly.
        if (sAB) {
          const m = midpoint(a, b);
          next.push([a, m, c]);
          next.push([m, b, c]);
        } else if (sBC) {
          const m = midpoint(b, c);
          next.push([a, b, m]);
          next.push([a, m, c]);
        } else {
          const m = midpoint(c, a);
          next.push([a, b, m]);
          next.push([m, b, c]);
        }
      } else {
        // count === 2: split both long edges, emit 3 triangles
        // that share the two new midpoints. The remaining short
        // edge stays as-is for the unsplit neighbour.
        if (sAB && sBC) {
          const mAB = midpoint(a, b);
          const mBC = midpoint(b, c);
          next.push([a, mAB, c]);
          next.push([mAB, b, mBC]);
          next.push([mAB, mBC, c]);
        } else if (sBC && sCA) {
          const mBC = midpoint(b, c);
          const mCA = midpoint(c, a);
          next.push([a, b, mBC]);
          next.push([a, mBC, mCA]);
          next.push([mCA, mBC, c]);
        } else {
          const mAB = midpoint(a, b);
          const mCA = midpoint(c, a);
          next.push([a, mAB, mCA]);
          next.push([mAB, b, mCA]);
          next.push([mCA, b, c]);
        }
      }
    }
    triPairs = next;
    if (!didSplit) break;
  }
  const flat: number[] = [];
  for (const [a, b, c] of triPairs) {
    flat.push(a, b, c);
  }
  return { verts, tris: flat };
}

// Heuristic: a 4-vert axis-aligned rectangle, as emitted by
// `convertOpenLayout` for surface scenes. We tessellate these
// when the layout has a terrain config; everything else (tile-
// derived sectors) stays a single quad and gets terrain through
// the per-vertex displacement on its corners.
function isBigQuadSector(s: import('@dumrunner/shared').Sector): boolean {
  if (s.verts.length !== 4) return false;
  const xs = s.verts.map((v) => v.x);
  const ys = s.verts.map((v) => v.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  // Each vert must sit at a corner of the bounding rect.
  for (const v of s.verts) {
    if (v.x !== xMin && v.x !== xMax) return false;
    if (v.y !== yMin && v.y !== yMax) return false;
  }
  // Threshold to avoid tessellating tile-sized rectangles which
  // are already small enough that per-vertex displacement at the
  // corners suffices.
  return xMax - xMin > 256 && yMax - yMin > 256;
}

function tessellateRectFloor(
  sector: import('@dumrunner/shared').Sector,
  terrain: import('@dumrunner/shared').TerrainConfig,
  stride: number,
  positions: number[],
  uvs: number[],
  indices: number[],
  brightness: number[],
  vCursor: number,
): number {
  const xs = sector.verts.map((v) => v.x);
  const ys = sector.verts.map((v) => v.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const cols = Math.max(2, Math.ceil((xMax - xMin) / stride) + 1);
  const rows = Math.max(2, Math.ceil((yMax - yMin) / stride) + 1);
  const baseV = vCursor;
  const epsilon = stride * 0.5;
  for (let r = 0; r < rows; r++) {
    const ty = r / (rows - 1);
    const y = yMin + (yMax - yMin) * ty;
    for (let c = 0; c < cols; c++) {
      const tx = c / (cols - 1);
      const x = xMin + (xMax - xMin) * tx;
      const z = sector.floorZ + terrainHeightAt(terrain, x, y);
      positions.push(x, y, z);
      uvs.push(x / TEXTURE_TILE_PX, y / TEXTURE_TILE_PX);
      // Terrain normal from finite differences of the height
      // field — hilltops face +Z, slopes have lateral tilt that
      // varies brightness across the surface for a "rolling
      // hills under sunlight" read.
      const dzx =
        (terrainHeightAt(terrain, x + epsilon, y) -
          terrainHeightAt(terrain, x - epsilon, y)) /
        (2 * epsilon);
      const dzy =
        (terrainHeightAt(terrain, x, y + epsilon) -
          terrainHeightAt(terrain, x, y - epsilon)) /
        (2 * epsilon);
      // Normal = normalize((-dzx, -dzy, 1)).
      const nx = -dzx;
      const ny = -dzy;
      const nz = 1;
      const nLen = Math.hypot(nx, ny, nz);
      brightness.push(brightnessForNormal(nx / nLen, ny / nLen, nz / nLen));
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i00 = baseV + r * cols + c;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      indices.push(i00, i10, i11);
      indices.push(i00, i11, i01);
    }
  }
  return vCursor + rows * cols;
}

export function buildTexturedCeilingGeometry(
  map: SectorMap,
): Geometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const brightness: number[] = [];
  let vCursor = 0;
  const ceilingBrightness = brightnessForNormal(0, 0, -1);
  for (const sector of map.sectors) {
    if (sector.buildingKind !== undefined) continue;
    if (sector.ceilingZ <= sector.floorZ) continue;
    const useNoise = !!sector.ceilingNoise;
    const ringVerts =
      sector.holes && sector.holes.length > 0
        ? [...sector.verts, ...sector.holes.flat()].map((v) => ({
            x: v.x,
            y: v.y,
          }))
        : sector.verts.map((v) => ({ x: v.x, y: v.y }));
    const tris =
      sector.holes && sector.holes.length > 0
        ? triangulateWithHoles(sector.verts, sector.holes)
        : triangulateWithHoles(sector.verts, []);
    vCursor = emitCeilingMesh(
      ringVerts,
      tris,
      sector,
      ceilingBrightness,
      positions,
      uvs,
      brightness,
      indices,
      vCursor,
      useNoise,
    );
  }
  if (indices.length === 0) return null;
  return makeTexturedSurfaceGeometry(positions, uvs, indices, brightness);
}

export function buildTexturedWallGeometry(
  map: SectorMap,
): Geometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const brightness: number[] = [];
  let vCursor = 0;
  for (const wall of map.walls) {
    // Skip building-cube walls — colored mesh owns those.
    if (wall.buildingKind !== undefined) continue;
    // Authored portal walls: author flagged `solid: false` and
    // didn't supply a vertical override, meaning "this edge is
    // the seam between two adjacent walkable sectors — render
    // nothing." Riser walls also have solid:false but DO carry
    // overrides (a short visible quad spanning the floor delta),
    // so they pass through this filter.
    if (
      !wall.solid &&
      wall.floorZOverride === undefined &&
      wall.ceilingZOverride === undefined
    ) {
      continue;
    }
    const sector = map.sectors[wall.sectorId];
    if (!sector) continue;
    if (sector.ceilingZ <= sector.floorZ) continue;
    const a =
      wall.ax !== undefined && wall.ay !== undefined
        ? { x: wall.ax, y: wall.ay }
        : sector.verts[wall.vertIdx];
    const b =
      wall.bx !== undefined && wall.by !== undefined
        ? { x: wall.bx, y: wall.by }
        : sector.verts[(wall.vertIdx + 1) % sector.verts.length];
    if (!a || !b) continue;
    // Overrides take precedence so platform-tile solid walls
    // start at z=0 (instead of the lifted sector floor) and
    // risers span the floor-delta between adjacent tiles.
    const floorZ =
      wall.floorZOverride !== undefined ? wall.floorZOverride : sector.floorZ;
    const ceilingZ =
      wall.ceilingZOverride !== undefined
        ? wall.ceilingZOverride
        : sector.ceilingZ;
    if (ceilingZ <= floorZ) continue;
    const wallLen = Math.hypot(b.x - a.x, b.y - a.y);
    const uB = wallLen / TEXTURE_TILE_PX;
    // Anchor the UV-v origin at world z=0 so tile-aligned wall
    // textures stay continuous up a riser → wall stack instead
    // of restarting at each segment's bottom.
    const vBot = floorZ / TEXTURE_TILE_PX;
    const vTop = ceilingZ / TEXTURE_TILE_PX;
    // Wall normal — perpendicular to the wall direction in XY,
    // pointing OUT of the sector (toward the void / lower
    // neighbour). With CCW sector winding, the outward normal
    // for edge a→b is (-dy, dx) rotated 90° clockwise →
    // (dy, -dx). Normalised, used for sun-direction shading.
    const wdx = b.x - a.x;
    const wdy = b.y - a.y;
    const nLen = Math.hypot(wdx, wdy);
    const nx = nLen > 0 ? wdy / nLen : 0;
    const ny = nLen > 0 ? -wdx / nLen : 0;
    const wallBrightness = brightnessForNormal(nx, ny, 0);
    const baseV = vCursor;
    positions.push(
      a.x, a.y, floorZ,
      b.x, b.y, floorZ,
      b.x, b.y, ceilingZ,
      a.x, a.y, ceilingZ,
    );
    uvs.push(
      0, vBot,
      uB, vBot,
      uB, vTop,
      0, vTop,
    );
    brightness.push(
      wallBrightness,
      wallBrightness,
      wallBrightness,
      wallBrightness,
    );
    vCursor += 4;
    indices.push(
      baseV + 0, baseV + 1, baseV + 2,
      baseV + 0, baseV + 2, baseV + 3,
    );
  }
  if (indices.length === 0) return null;
  return makeTexturedSurfaceGeometry(positions, uvs, indices, brightness);
}

function makeTexturedSurfaceGeometry(
  positions: number[],
  uvs: number[],
  indices: number[],
  brightness: number[],
): Geometry {
  return new Geometry({
    attributes: {
      aPosition: {
        buffer: new Buffer({
          data: new Float32Array(positions),
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x3',
      },
      aUV: {
        buffer: new Buffer({
          data: new Float32Array(uvs),
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x2',
      },
      aBrightness: {
        buffer: new Buffer({
          data: new Float32Array(brightness),
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32',
      },
    },
    indexBuffer: new Buffer({
      data: new Uint32Array(indices),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
  });
}

// Direction-of-arrival shading helper. Returns 0.55..1.0
// brightness for the given normal — same formula the shader
// used before we moved this CPU-side. Sun direction lives
// here as a constant; can be promoted to a uniform later.
const SUN_DIR_X = 0.4;
const SUN_DIR_Y = 0.3;
const SUN_DIR_Z = 0.866;
function brightnessForNormal(nx: number, ny: number, nz: number): number {
  const dot = Math.abs(nx * SUN_DIR_X + ny * SUN_DIR_Y + nz * SUN_DIR_Z);
  return 0.55 + 0.45 * Math.max(0, dot);
}
