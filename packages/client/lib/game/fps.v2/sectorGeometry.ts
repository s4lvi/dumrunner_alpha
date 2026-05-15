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
import type { SectorMap, Sector } from './types';

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
    // Room floors / ceilings (floorZ === 0 sectors) are owned
    // by the textured-surface pass.
    if (sector.floorZ === 0) continue;
    // Building cube cap: skip if a textured shell exists for
    // this kind. Without that filter, every cube would show its
    // colored fallback peeking through the textured shell's
    // edges (FACE_NUDGE creates a small overhang).
    if (sector.buildingKind && skipBuildingKinds.has(sector.buildingKind)) {
      continue;
    }
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
    // Room walls (no floor/ceiling overrides) belong to the
    // textured-wall pass. Building-cube walls carry explicit
    // overrides — those are this mesh's job…
    if (
      wall.floorZOverride === undefined &&
      wall.ceilingZOverride === undefined
    ) {
      continue;
    }
    // …unless this building kind has a textured shell, in
    // which case the textured wall replaces this one.
    if (wall.buildingKind && skipBuildingKinds.has(wall.buildingKind)) {
      continue;
    }
    const sector = map.sectors[wall.sectorId];
    if (!sector) continue;
    const a = sector.verts[wall.vertIdx];
    const b = sector.verts[(wall.vertIdx + 1) % sector.verts.length];
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
// Only real dungeon surfaces are emitted (sector.floorZ === 0).
// Building cubes (floorZ > 0) and their walls (Wall with
// floorZOverride set) are excluded so they continue to render
// via the colored mesh — their visual identity is the cube
// itself, not the biome wall texture.

const TEXTURE_TILE_PX = 32;

export function buildTexturedFloorGeometry(
  map: SectorMap,
): Geometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vCursor = 0;
  for (const sector of map.sectors) {
    if (sector.floorZ !== 0) continue;
    const baseV = vCursor;
    for (const v of sector.verts) {
      positions.push(v.x, v.y, sector.floorZ);
      uvs.push(v.x / TEXTURE_TILE_PX, v.y / TEXTURE_TILE_PX);
    }
    vCursor += sector.verts.length;
    for (let i = 1; i < sector.verts.length - 1; i++) {
      indices.push(baseV + 0, baseV + i, baseV + i + 1);
    }
  }
  if (indices.length === 0) return null;
  return makeTexturedSurfaceGeometry(positions, uvs, indices);
}

export function buildTexturedCeilingGeometry(
  map: SectorMap,
): Geometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vCursor = 0;
  for (const sector of map.sectors) {
    if (sector.floorZ !== 0) continue;
    if (sector.ceilingZ <= sector.floorZ) continue;
    const baseV = vCursor;
    for (const v of sector.verts) {
      positions.push(v.x, v.y, sector.ceilingZ);
      uvs.push(v.x / TEXTURE_TILE_PX, v.y / TEXTURE_TILE_PX);
    }
    vCursor += sector.verts.length;
    // Reverse winding so the front face points down at the
    // camera (which sits below the ceiling looking up).
    for (let i = 1; i < sector.verts.length - 1; i++) {
      indices.push(baseV + 0, baseV + i + 1, baseV + i);
    }
  }
  if (indices.length === 0) return null;
  return makeTexturedSurfaceGeometry(positions, uvs, indices);
}

export function buildTexturedWallGeometry(
  map: SectorMap,
): Geometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vCursor = 0;
  for (const wall of map.walls) {
    if (
      wall.floorZOverride !== undefined ||
      wall.ceilingZOverride !== undefined
    ) {
      continue;
    }
    const sector = map.sectors[wall.sectorId];
    if (!sector) continue;
    if (sector.floorZ !== 0 || sector.ceilingZ <= sector.floorZ) continue;
    const a = sector.verts[wall.vertIdx];
    const b = sector.verts[(wall.vertIdx + 1) % sector.verts.length];
    const floorZ = sector.floorZ;
    const ceilingZ = sector.ceilingZ;
    const wallLen = Math.hypot(b.x - a.x, b.y - a.y);
    const uB = wallLen / TEXTURE_TILE_PX;
    const vTop = (ceilingZ - floorZ) / TEXTURE_TILE_PX;
    const baseV = vCursor;
    positions.push(
      a.x, a.y, floorZ,
      b.x, b.y, floorZ,
      b.x, b.y, ceilingZ,
      a.x, a.y, ceilingZ,
    );
    uvs.push(
      0, 0,
      uB, 0,
      uB, vTop,
      0, vTop,
    );
    vCursor += 4;
    indices.push(
      baseV + 0, baseV + 1, baseV + 2,
      baseV + 0, baseV + 2, baseV + 3,
    );
  }
  if (indices.length === 0) return null;
  return makeTexturedSurfaceGeometry(positions, uvs, indices);
}

function makeTexturedSurfaceGeometry(
  positions: number[],
  uvs: number[],
  indices: number[],
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
    },
    indexBuffer: new Buffer({
      data: new Uint32Array(indices),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
  });
}
