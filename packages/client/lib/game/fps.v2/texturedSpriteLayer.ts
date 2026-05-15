// Textured-sprite layer. Each unique texture gets its own
// batch (Mesh + Geometry + Shader) since Pixi binds texture
// resources per-shader. The renderer routes any entity whose
// animation system returns a Texture through here; entities
// without a texture fall back to the colored sprite layer.
//
// Batch lifecycle: created lazily on first use of a texture,
// kept across frames (we re-use the upload). Sprites with the
// same texture this frame share one batch and one draw call.
// Unused batches just emit zero-indexed draws — cheap. We don't
// prune yet; per-renderer leak is small.

import {
  Buffer,
  BufferUsage,
  Container,
  Geometry,
  Mesh,
  Shader,
  type Texture,
} from 'pixi.js';
import type { Camera } from './camera';
import {
  createTexturedSpriteCameraUniforms,
  createTexturedSpriteShader,
} from './texturedSpriteShader';
import type { FogUniformsHandle } from './fogUniforms';
import type { LightingUniformsHandle } from './lightingUniforms';

export type TexturedSpriteRequest = {
  // Identifies the texture for batching. Pixi Texture.uid is
  // a monotonically-increasing integer assigned per Texture
  // instance — stable for the texture's lifetime.
  textureKey: number;
  // The texture itself. Looked up once when a new batch
  // initialises; subsequent same-key requests use the cached
  // shader binding.
  texture: Texture;
  x: number;
  y: number;
  anchorZ: number;
  height: number;
  // Aspect ratio of the sprite (width / height). Computed from
  // the texture's natural dimensions; lets enemies/props have
  // taller-than-wide sprites without stretching.
  aspect: number;
  // RGB tint (0xrrggbb). Multiplies texture colour in the
  // fragment shader. Used by hit-flash overlays + dimming
  // unseen entities. Pass 0xffffff for "no tint".
  tint: number;
};

type Batch = {
  texture: Texture;
  shader: Shader;
  geometry: Geometry;
  mesh: Mesh<Geometry, Shader>;
  // Buffer-backing typed arrays; rebound when capacity grows.
  positions: Float32Array;
  uvs: Float32Array;
  tints: Float32Array;
  indices: Uint32Array;
  posBuffer: Buffer;
  uvBuffer: Buffer;
  tintBuffer: Buffer;
  indexBuffer: Buffer;
  capacity: number;
  // Sprite count written this frame. Reset on beginFrame.
  count: number;
};

const VERTS_PER_SPRITE = 4;
const FLOATS_POS = 3;
const FLOATS_UV = 2;
const FLOATS_TINT = 3;
const INDICES_PER_SPRITE = 6;
const INITIAL_CAPACITY = 16;

export type TexturedSpriteLayer = {
  // Container holding every batch's Mesh. Add to the stage
  // above the colored sprite layer so texturing wins on
  // depth ties.
  container: Container;
  // Shared camera matrix buffer. Renderer writes the current
  // view*projection here once per frame; endFrame() flushes
  // the UniformGroup so all batches see the new value.
  cameraMatrix: Float32Array;
  beginFrame: () => void;
  push: (req: TexturedSpriteRequest, camera: Camera) => void;
  // Upload buffers + commit camera uniform once. Called once
  // after all push()es per frame.
  endFrame: () => void;
  destroy: () => void;
};

export function createTexturedSpriteLayer(
  fog: FogUniformsHandle,
  lighting: LightingUniformsHandle,
): TexturedSpriteLayer {
  const cameraUniforms = createTexturedSpriteCameraUniforms();
  const container = new Container();
  const batches = new Map<number, Batch>();

  function newBatch(texture: Texture): Batch {
    const capacity = INITIAL_CAPACITY;
    const positions = new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_POS);
    const uvs = new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_UV);
    const tints = new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_TINT);
    const indices = new Uint32Array(capacity * INDICES_PER_SPRITE);
    fillIndices(indices, 0, capacity);
    const posBuffer = new Buffer({
      data: positions,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const uvBuffer = new Buffer({
      data: uvs,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const tintBuffer = new Buffer({
      data: tints,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const indexBuffer = new Buffer({
      data: indices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: posBuffer, format: 'float32x3' },
        aUV: { buffer: uvBuffer, format: 'float32x2' },
        aTint: { buffer: tintBuffer, format: 'float32x3' },
      },
      indexBuffer,
    });
    const shader = createTexturedSpriteShader(
      cameraUniforms,
      fog,
      lighting,
      texture,
    );
    const mesh = new Mesh({ geometry, shader }) as Mesh<Geometry, Shader>;
    mesh.cullable = false;
    mesh.eventMode = 'none';
    // Same depth setup as the colored sprite layer — sprites
    // depth-test against walls but write depth so they occlude
    // each other in z-order. Transparency cutout is handled by
    // the fragment shader's `discard` on tex.a < 0.01.
    mesh.state.depthTest = true;
    mesh.state.depthMask = true;
    mesh.state.culling = false;
    container.addChild(mesh);
    return {
      texture,
      shader,
      geometry,
      mesh,
      positions,
      uvs,
      tints,
      indices,
      posBuffer,
      uvBuffer,
      tintBuffer,
      indexBuffer,
      capacity,
      count: 0,
    };
  }

  function ensureCapacity(b: Batch, n: number): void {
    if (n <= b.capacity) return;
    let next = b.capacity;
    while (next < n) next *= 2;
    b.capacity = next;
    b.positions = new Float32Array(next * VERTS_PER_SPRITE * FLOATS_POS);
    b.uvs = new Float32Array(next * VERTS_PER_SPRITE * FLOATS_UV);
    b.tints = new Float32Array(next * VERTS_PER_SPRITE * FLOATS_TINT);
    b.indices = new Uint32Array(next * INDICES_PER_SPRITE);
    fillIndices(b.indices, 0, next);
    b.posBuffer.data = b.positions;
    b.uvBuffer.data = b.uvs;
    b.tintBuffer.data = b.tints;
    b.indexBuffer.data = b.indices;
  }

  return {
    container,
    cameraMatrix: cameraUniforms.uViewProj,
    beginFrame(): void {
      // Reset write cursors; batches stick around so their
      // buffers don't churn between frames.
      for (const b of batches.values()) b.count = 0;
    },
    push(req, camera): void {
      let b = batches.get(req.textureKey);
      if (!b) {
        b = newBatch(req.texture);
        batches.set(req.textureKey, b);
      }
      ensureCapacity(b, b.count + 1);
      const i = b.count;
      // Per-sprite right vector (point-at-camera billboarding).
      // See spriteLayer.ts for the derivation. World-Z is up;
      // right rotates around Z to face the camera horizontally.
      const dxCam = req.x - camera.selfX;
      const dyCam = req.y - camera.selfY;
      const lenCam = Math.hypot(dxCam, dyCam);
      let rX: number;
      let rY: number;
      if (lenCam < 0.001) {
        rX = camera.rightX;
        rY = camera.rightY;
      } else {
        rX = -dyCam / lenCam;
        rY = dxCam / lenCam;
      }
      // Quad corners around (x, y) at world heights [anchorZ,
      // anchorZ+height]. Half-width = height * aspect / 2 so the
      // sprite's image proportions are preserved.
      const halfW = (req.height * req.aspect) * 0.5;
      const bot = req.anchorZ;
      const top = req.anchorZ + req.height;
      const baseP = i * VERTS_PER_SPRITE * FLOATS_POS;
      const x = req.x;
      const y = req.y;
      const leftX = x - rX * halfW;
      const leftY = y - rY * halfW;
      const rightX = x + rX * halfW;
      const rightY = y + rY * halfW;
      b.positions[baseP + 0]  = leftX;
      b.positions[baseP + 1]  = leftY;
      b.positions[baseP + 2]  = bot;
      b.positions[baseP + 3]  = rightX;
      b.positions[baseP + 4]  = rightY;
      b.positions[baseP + 5]  = bot;
      b.positions[baseP + 6]  = rightX;
      b.positions[baseP + 7]  = rightY;
      b.positions[baseP + 8]  = top;
      b.positions[baseP + 9]  = leftX;
      b.positions[baseP + 10] = leftY;
      b.positions[baseP + 11] = top;
      // UVs map the full texture onto the quad. WebGL UVs have
      // v=0 at the BOTTOM of the texture; our quad's vertex
      // ordering (bot-left, bot-right, top-right, top-left)
      // already matches that convention so this is straight
      // through. We flip on Y because sprite art is typically
      // authored with origin top-left — without the flip, sprites
      // render upside-down.
      const baseU = i * VERTS_PER_SPRITE * FLOATS_UV;
      b.uvs[baseU + 0] = 0; b.uvs[baseU + 1] = 1; // bot-left
      b.uvs[baseU + 2] = 1; b.uvs[baseU + 3] = 1; // bot-right
      b.uvs[baseU + 4] = 1; b.uvs[baseU + 5] = 0; // top-right
      b.uvs[baseU + 6] = 0; b.uvs[baseU + 7] = 0; // top-left
      const tr = ((req.tint >> 16) & 0xff) / 255;
      const tg = ((req.tint >> 8) & 0xff) / 255;
      const tb = (req.tint & 0xff) / 255;
      const baseT = i * VERTS_PER_SPRITE * FLOATS_TINT;
      for (let v = 0; v < VERTS_PER_SPRITE; v++) {
        b.tints[baseT + v * 3 + 0] = tr;
        b.tints[baseT + v * 3 + 1] = tg;
        b.tints[baseT + v * 3 + 2] = tb;
      }
      b.count++;
    },
    endFrame(): void {
      cameraUniforms.flush();
      for (const b of batches.values()) {
        // Re-bind the live texture every frame. If a batch's
        // bound texture has been destroyed elsewhere we re-bind
        // defensively.
        b.shader.resources.uTexture = b.texture.source;
        b.posBuffer.update();
        b.uvBuffer.update();
        b.tintBuffer.update();
        // Trim the indexBuffer's data length to the live sprite
        // count. Pixi v8 draws `indexBuffer.data.length` indices
        // regardless of any size hint, so a capacity-sized
        // buffer would draw stale sprites from previous frames
        // (e.g. dungeon enemies persisting on the surface). The
        // subarray view is zero-copy.
        b.indexBuffer.data = b.indices.subarray(
          0,
          b.count * INDICES_PER_SPRITE,
        );
        b.indexBuffer.update();
      }
    },
    destroy(): void {
      for (const b of batches.values()) {
        try {
          b.geometry.destroy(true);
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

function fillIndices(
  indices: Uint32Array,
  startSprite: number,
  endSprite: number,
): void {
  for (let i = startSprite; i < endSprite; i++) {
    const v = i * VERTS_PER_SPRITE;
    const idx = i * INDICES_PER_SPRITE;
    indices[idx + 0] = v + 0;
    indices[idx + 1] = v + 1;
    indices[idx + 2] = v + 2;
    indices[idx + 3] = v + 0;
    indices[idx + 4] = v + 2;
    indices[idx + 5] = v + 3;
  }
}
