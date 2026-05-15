// Billboard sprite layer for the v2 renderer.
//
// Each renderable entity (enemy / prop / projectile / corpse /
// loot) becomes a screen-facing quad whose vertices we rebuild
// on the CPU every frame. The cost is acceptable at our entity
// counts (~50 max in dense scenes) and the alternative — sprite
// instancing through a vertex shader that builds the quad
// itself — adds shader complexity for no measurable win here.
//
// Vertex layout matches the sector mesh (aPosition + aBaseColor)
// so we can reuse the existing sector shader. Texturing comes
// in P3.2; v2.0's first pass renders solid-colour billboards so
// the player can see where things are while we wire the
// animation pipeline.

import {
  Buffer,
  BufferUsage,
  Geometry,
  Mesh,
  type Shader,
} from 'pixi.js';
import type { Camera } from './camera';

// Maximum sprites pre-allocated. The geometry buffers grow on
// demand if we exceed it, but pre-sizing means a stable scene
// never realloc's.
const INITIAL_CAPACITY = 64;
const VERTS_PER_SPRITE = 4;
const FLOATS_PER_POS = 3;
const FLOATS_PER_COLOR = 3;
const INDICES_PER_SPRITE = 6;

export type SpriteRequest = {
  // World position. x/y are horizontal; `anchorZ` is the world
  // height of the BOTTOM of the quad (floor-anchored sprites
  // pass 0, ceiling-hung pass ceilingZ - height, floating
  // projectiles pass eyeZ - height/2).
  x: number;
  y: number;
  anchorZ: number;
  // Quad height in world units. Width is the same (square
  // billboards for now; varied sprite aspect comes with
  // texturing).
  height: number;
  // Tint colour as 0xrrggbb. Until texturing lands, the fragment
  // shader paints solid colour, so this is what the player sees.
  color: number;
};

// Mesh<Geometry, Shader> — pin the generics so the default
// `Mesh<MeshGeometry, TextureShader>` doesn't get inferred when
// callers store the mesh in a typed container.
export type SpriteLayer = {
  mesh: Mesh<Geometry, Shader>;
  // Rebuild the sprite mesh against the current entity list +
  // camera. Caller passes the camera so we can read its
  // right/up vectors without coupling this module to the
  // renderer's state.
  update(requests: SpriteRequest[], camera: Camera): void;
  destroy(): void;
};

export function createSpriteLayer(shader: Shader): SpriteLayer {
  // Capacity grows on demand; start small to avoid wasting GPU
  // memory on empty scenes (e.g. the surface).
  let capacity = INITIAL_CAPACITY;
  let positions = new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_PER_POS);
  let colors = new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_PER_COLOR);
  let indices = new Uint32Array(capacity * INDICES_PER_SPRITE);
  rebuildIndices(indices, 0, capacity);

  const posBuffer = new Buffer({
    data: positions,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const colorBuffer = new Buffer({
    data: colors,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const indexBuffer = new Buffer({
    data: indices,
    usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
  });
  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: posBuffer, format: 'float32x3' },
      aBaseColor: { buffer: colorBuffer, format: 'float32x3' },
    },
    indexBuffer,
  });
  // Initial size matches buffer capacity but we set the active
  // index count to 0 — Pixi v8 lets us tell the renderer how
  // many indices to actually draw via geometry.instanceCount /
  // a separate draw range. With no entities, no draws happen.
  // Setting it to 0 avoids painting garbage on the first frame.
  geometry.indexBuffer.update(0);

  const mesh = new Mesh({ geometry, shader });
  mesh.cullable = false;
  mesh.eventMode = 'none';
  // Sprites need depth test (so a sprite behind a wall is
  // occluded) but should NOT write to depth — back-to-front
  // ordering would otherwise be required to handle transparency
  // correctly. For now we write depth too (opaque sprites only);
  // texturing P3.2 may flip depthMask off if we ship alpha cuts.
  mesh.state.depthTest = true;
  mesh.state.depthMask = true;
  mesh.state.culling = false;

  function ensureCapacity(n: number): void {
    if (n <= capacity) return;
    // Double until it fits — same growth heuristic as Array.push.
    let next = capacity;
    while (next < n) next *= 2;
    capacity = next;
    positions = new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_PER_POS);
    colors = new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_PER_COLOR);
    indices = new Uint32Array(capacity * INDICES_PER_SPRITE);
    rebuildIndices(indices, 0, capacity);
    // Re-bind the new typed-arrays as the underlying buffer
    // data. Pixi will re-upload on the next draw.
    posBuffer.data = positions;
    colorBuffer.data = colors;
    indexBuffer.data = indices;
  }

  return {
    mesh,
    update(requests, camera) {
      const n = requests.length;
      ensureCapacity(Math.max(1, n));
      // Per-sprite right vector (point-at-camera billboarding).
      // Each sprite faces its own camera-vector, not a shared
      // screen-aligned vector — so two sprites at the edges of
      // the field of view aren't parallel to each other, they
      // both individually face the camera. World-Z is the up
      // axis (sprites stay vertical regardless of pitch).
      for (let i = 0; i < n; i++) {
        const r = requests[i];
        const dxCam = r.x - camera.selfX;
        const dyCam = r.y - camera.selfY;
        const lenCam = Math.hypot(dxCam, dyCam);
        let rX: number;
        let rY: number;
        if (lenCam < 0.001) {
          // Standing on top of the sprite — fall back to the
          // camera's screen-right so the quad still has size.
          rX = camera.rightX;
          rY = camera.rightY;
        } else {
          // right = sprite_normal × up, where sprite_normal
          // points from sprite toward camera. Simplifies to:
          rX = -dyCam / lenCam;
          rY = dxCam / lenCam;
        }
        const halfW = r.height * 0.5;
        const top = r.anchorZ + r.height;
        const bot = r.anchorZ;
        // 4 corners, CCW when viewed from the camera-front:
        //   0: bot-left (anchor - right*halfW, z=bot)
        //   1: bot-right (anchor + right*halfW, z=bot)
        //   2: top-right
        //   3: top-left
        const baseP = i * VERTS_PER_SPRITE * FLOATS_PER_POS;
        const x = r.x;
        const y = r.y;
        positions[baseP + 0]  = x - rX * halfW;
        positions[baseP + 1]  = y - rY * halfW;
        positions[baseP + 2]  = bot;
        positions[baseP + 3]  = x + rX * halfW;
        positions[baseP + 4]  = y + rY * halfW;
        positions[baseP + 5]  = bot;
        positions[baseP + 6]  = x + rX * halfW;
        positions[baseP + 7]  = y + rY * halfW;
        positions[baseP + 8]  = top;
        positions[baseP + 9]  = x - rX * halfW;
        positions[baseP + 10] = y - rY * halfW;
        positions[baseP + 11] = top;
        // Pack RGB once and replicate to all 4 vertices.
        const cr = ((r.color >> 16) & 0xff) / 255;
        const cg = ((r.color >> 8) & 0xff) / 255;
        const cb = (r.color & 0xff) / 255;
        const baseC = i * VERTS_PER_SPRITE * FLOATS_PER_COLOR;
        for (let v = 0; v < VERTS_PER_SPRITE; v++) {
          colors[baseC + v * 3 + 0] = cr;
          colors[baseC + v * 3 + 1] = cg;
          colors[baseC + v * 3 + 2] = cb;
        }
      }
      // Upload — Pixi v8 reads from the Buffer.data reference,
      // but we need to mark it dirty so the GPU re-upload runs.
      posBuffer.update();
      colorBuffer.update();
      // Limit the draw count to live sprites by trimming the
      // indexBuffer's data array. Pixi v8 draws
      // `indexBuffer.data.length` indices regardless of any
      // size hint passed to `update()` — using subarray gives
      // us a zero-copy view that's exactly N indices long.
      // Without this, sprites from a previous scene linger
      // with stale world positions (we never overwrote those
      // entries because the new scene has fewer sprites).
      indexBuffer.data = indices.subarray(0, n * INDICES_PER_SPRITE);
      indexBuffer.update();
    },
    destroy() {
      try {
        geometry.destroy(true);
      } catch {
        /* best-effort */
      }
    },
  };
}

// Standard 2-triangle indexing for sprite quads in slot order:
//   tri0: (0, 1, 2)
//   tri1: (0, 2, 3)
function rebuildIndices(
  indices: Uint32Array,
  startSprite: number,
  endSprite: number,
): void {
  for (let i = startSprite; i < endSprite; i++) {
    const baseV = i * VERTS_PER_SPRITE;
    const baseI = i * INDICES_PER_SPRITE;
    indices[baseI + 0] = baseV + 0;
    indices[baseI + 1] = baseV + 1;
    indices[baseI + 2] = baseV + 2;
    indices[baseI + 3] = baseV + 0;
    indices[baseI + 4] = baseV + 2;
    indices[baseI + 5] = baseV + 3;
  }
}
