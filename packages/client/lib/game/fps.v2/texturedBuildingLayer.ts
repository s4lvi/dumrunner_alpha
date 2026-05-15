// Per-kind building cube textures.
//
// Each unique building kind in a scene gets one Mesh sampling
// `building/<kind>` from the texture-override pipeline. The cap
// (top face) + 4 wall quads are emitted with tile-space UVs so
// a `wall.png` tiles cleanly across multi-tile structures.
//
// Layered ON TOP of the colored building cube (which the
// existing colored sector mesh still emits). When the texture
// isn't authored the per-kind mesh stays invisible and the
// colored cube acts as the visual fallback. When the texture
// IS authored, polygon offset wins z-fight against the colored
// cube's walls (vertical surfaces — polygonOffset works on
// non-horizontal quads); the cap is shifted +0.1 world units
// upward to defeat the same z-fight on the horizontal top face
// without relying on polygon offset there.

import {
  Buffer,
  BufferUsage,
  Container,
  Geometry,
  Mesh,
  Shader,
  Texture,
  type BLEND_MODES,
} from 'pixi.js';
import type { BuildingState } from '@dumrunner/shared';
import {
  createTexturedSectorCameraUniforms,
  createTexturedSectorShader,
  type TexturedSectorCameraUniforms,
} from './texturedSectorShader';
import type { FogUniformsHandle } from './fogUniforms';
import type { LightingUniformsHandle } from './lightingUniforms';

const TEXTURE_TILE_PX = 32;
// Per-face outward offset. The colored cube sits at the cube's
// exact footprint; the textured shell sits 0.1 world units
// OUTSIDE that, so every textured face is slightly closer to
// the camera than the corresponding colored face and wins
// Pixi v8's GL_LESS depth comparison from any viewing angle.
// polygonOffset is weak here because `factor * dz_max` swings
// with view angle (zero for axis-aligned walls seen head-on),
// so an explicit world-space offset is the reliable shape.
const FACE_NUDGE = 0.1;

type Batch = {
  kind: string;
  shader: Shader;
  mesh: Mesh<Geometry, Shader>;
  textureLoaded: boolean;
};

export type TexturedBuildingLayer = {
  container: Container;
  cameraMatrix: Float32Array;
  flushCamera: () => void;
  // Rebuild geometry per kind. Called whenever the buildings
  // map changes (spawn/remove/scene swap). Cheap — buildings
  // are typically <20 per scene.
  rebuild: (
    buildings: BuildingState[],
    tileSize: number,
    ceilingZ: number,
  ) => void;
  // Per-frame: re-poll the texture-override cache and bind
  // whichever textures resolved since last frame. Hides the
  // mesh until its texture lands. Returns the set of kinds
  // that currently have a visible textured shell — the
  // renderer feeds this back into the colored geometry pass
  // so those kinds skip their fallback cube.
  refreshTextures: (
    lookup: (kind: string) => Texture | null,
  ) => Set<string>;
  destroy: () => void;
};

export function createTexturedBuildingLayer(
  fog: FogUniformsHandle,
  lighting: LightingUniformsHandle,
): TexturedBuildingLayer {
  const cameraUniforms: TexturedSectorCameraUniforms =
    createTexturedSectorCameraUniforms();
  const container = new Container();
  const batches = new Map<string, Batch>();

  function ensureBatch(kind: string): Batch {
    const existing = batches.get(kind);
    if (existing) return existing;
    const shader = createTexturedSectorShader(
      cameraUniforms,
      fog,
      lighting,
      Texture.EMPTY,
    );
    const mesh = new Mesh<Geometry, Shader>({
      geometry: new Geometry({ attributes: {} }),
      shader,
    });
    mesh.cullable = false;
    mesh.eventMode = 'none';
    mesh.state.depthTest = true;
    mesh.state.depthMask = true;
    mesh.state.culling = false;
    // Pixi v8 doesn't surface BLEND_MODES, but the default
    // 'normal' is what we want — textured cube fragments overdraw
    // the colored cube fragments where the depth test allows.
    void (null as BLEND_MODES | null);
    // No polygonOffset — we use explicit per-face outward
    // displacement (FACE_NUDGE) in the geometry instead.
    mesh.visible = false;
    container.addChild(mesh);
    const batch: Batch = { kind, shader, mesh, textureLoaded: false };
    batches.set(kind, batch);
    return batch;
  }

  return {
    container,
    cameraMatrix: cameraUniforms.uViewProj,
    flushCamera: () => cameraUniforms.flush(),
    rebuild(buildings, tileSize, ceilingZ): void {
      // Bucket buildings by kind so each batch's Geometry holds
      // every cube of that kind. Kinds with zero buildings
      // (e.g. all walls demolished) get their batch removed so
      // the container doesn't accumulate dead meshes.
      const byKind = new Map<string, BuildingState[]>();
      for (const b of buildings) {
        let arr = byKind.get(b.kind);
        if (!arr) {
          arr = [];
          byKind.set(b.kind, arr);
        }
        arr.push(b);
      }
      for (const [kind, list] of byKind) {
        const batch = ensureBatch(kind);
        const next = buildBuildingGeometry(list, tileSize, ceilingZ);
        const old = batch.mesh.geometry;
        batch.mesh.geometry = next;
        try {
          old.destroy(true);
        } catch {
          /* best-effort */
        }
      }
      // Sweep batches whose kind no longer exists.
      for (const [kind, batch] of batches) {
        if (!byKind.has(kind)) {
          batch.mesh.visible = false;
          try {
            batch.mesh.geometry.destroy(true);
          } catch {
            /* best-effort */
          }
          container.removeChild(batch.mesh);
          batches.delete(kind);
        }
      }
    },
    refreshTextures(lookup): Set<string> {
      const active = new Set<string>();
      for (const batch of batches.values()) {
        const tex = lookup(batch.kind);
        if (!tex) {
          batch.mesh.visible = false;
          batch.textureLoaded = false;
          continue;
        }
        if (!batch.shader) continue;
        batch.shader.resources.uTexture = tex.source;
        batch.mesh.visible = true;
        batch.textureLoaded = true;
        active.add(batch.kind);
      }
      return active;
    },
    destroy(): void {
      for (const batch of batches.values()) {
        try {
          batch.mesh.geometry.destroy(true);
        } catch {
          /* best-effort */
        }
      }
      batches.clear();
      try {
        container.destroy({ children: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// Emit per-building cube geometry. One cap quad + 4 wall quads
// per building, packed into a single Geometry with shared
// vertex format (aPosition + aUV).
function buildBuildingGeometry(
  buildings: BuildingState[],
  tileSize: number,
  ceilingZ: number,
): Geometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vCursor = 0;
  for (const b of buildings) {
    const x0 = b.tileX * tileSize;
    const y0 = b.tileY * tileSize;
    const x1 = x0 + b.width * tileSize;
    const y1 = y0 + b.height * tileSize;
    // Per-CORNER diagonal displacement so adjacent walls share
    // their endpoints. Earlier per-face displacement left a
    // notch at every corner (the north wall's NE endpoint and
    // the east wall's NE endpoint sat at different XY). The
    // diagonal offset means each cube corner snaps to one
    // shared XY, and the four walls meet cleanly.
    const xL = x0 - FACE_NUDGE;
    const xR = x1 + FACE_NUDGE;
    const yN = y0 - FACE_NUDGE;
    const yS = y1 + FACE_NUDGE;
    const capZ = ceilingZ + FACE_NUDGE;
    const widthTiles = b.width;
    const depthTiles = b.height;
    const wallTopV = ceilingZ / TEXTURE_TILE_PX;
    // Cap (top face) — extended to the displaced corners so
    // the cap meets the wall tops with no seam.
    const capBase = vCursor;
    positions.push(
      xL, yN, capZ,
      xR, yN, capZ,
      xR, yS, capZ,
      xL, yS, capZ,
    );
    uvs.push(
      0, 0,
      widthTiles, 0,
      widthTiles, depthTiles,
      0, depthTiles,
    );
    vCursor += 4;
    indices.push(
      capBase + 0, capBase + 1, capBase + 2,
      capBase + 0, capBase + 2, capBase + 3,
    );
    // ---- 4 wall quads, endpoints at shared diagonal corners ----
    // North face: NW → NE
    pushWall(
      positions, uvs, indices, vCursor,
      xL, yN, xR, yN,
      ceilingZ, widthTiles, wallTopV,
    );
    vCursor += 4;
    // East face: NE → SE
    pushWall(
      positions, uvs, indices, vCursor,
      xR, yN, xR, yS,
      ceilingZ, depthTiles, wallTopV,
    );
    vCursor += 4;
    // South face: SE → SW
    pushWall(
      positions, uvs, indices, vCursor,
      xR, yS, xL, yS,
      ceilingZ, widthTiles, wallTopV,
    );
    vCursor += 4;
    // West face: SW → NW
    pushWall(
      positions, uvs, indices, vCursor,
      xL, yS, xL, yN,
      ceilingZ, depthTiles, wallTopV,
    );
    vCursor += 4;
  }
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

function pushWall(
  positions: number[],
  uvs: number[],
  indices: number[],
  baseV: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ceilingZ: number,
  uTopRange: number,
  vTopRange: number,
): void {
  positions.push(
    ax, ay, 0,
    bx, by, 0,
    bx, by, ceilingZ,
    ax, ay, ceilingZ,
  );
  uvs.push(
    0, 0,
    uTopRange, 0,
    uTopRange, vTopRange,
    0, vTopRange,
  );
  indices.push(
    baseV + 0, baseV + 1, baseV + 2,
    baseV + 0, baseV + 2, baseV + 3,
  );
}
