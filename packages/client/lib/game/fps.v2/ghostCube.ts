// Translucent 3D cube for build-mode placement preview.
//
// A single unit cube (1×1×1, world-space) whose origin + size +
// colour are updated each frame via uniforms. Alpha-blended, no
// depth write (so a partially-occluded cube still renders the
// nearest face on top of farther geometry without leaving a
// permanent hole in the depth buffer).
//
// Fog is applied the same way as the sector shader so the ghost
// reads as part of the world rather than a flat HUD overlay.

import {
  Buffer,
  BufferUsage,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  UniformGroup,
} from 'pixi.js';
import type { FogUniformsHandle } from './fogUniforms';

const VERTEX_SRC = `
attribute vec3 aLocal;

uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform vec3 uSize;

varying vec3 vWorldPos;

void main() {
  vec3 wp = uOrigin + aLocal * uSize;
  vWorldPos = wp;
  gl_Position = uViewProj * vec4(wp, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;

uniform vec3 uColor;
uniform float uAlpha;
uniform vec3 uCameraPos;
uniform float uFogStart;
uniform float uFogEnd;
uniform vec3 uFogColor;

varying vec3 vWorldPos;

void main() {
  float d = distance(vWorldPos, uCameraPos);
  float fogT = clamp(
    (d - uFogStart) / max(0.0001, uFogEnd - uFogStart),
    0.0,
    1.0
  );
  vec3 lit = mix(uColor, uFogColor, fogT);
  gl_FragColor = vec4(lit, uAlpha);
}
`;

export type GhostCubeLayer = {
  mesh: Mesh<Geometry, Shader>;
  cameraMatrix: Float32Array;
  flushCamera: () => void;
  setTransform: (
    originX: number,
    originY: number,
    originZ: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
  ) => void;
  setColor: (rgb: number, alpha: number) => void;
  setVisible: (v: boolean) => void;
  destroy: () => void;
};

export function createGhostCubeLayer(
  fog: FogUniformsHandle,
): GhostCubeLayer {
  // Unit cube in [0,1]^3. 8 verts, 12 triangles. CCW winding on
  // each face when viewed from outside the cube.
  const positions = new Float32Array([
    0, 0, 0, // 0
    1, 0, 0, // 1
    1, 1, 0, // 2
    0, 1, 0, // 3
    0, 0, 1, // 4
    1, 0, 1, // 5
    1, 1, 1, // 6
    0, 1, 1, // 7
  ]);
  const indices = new Uint16Array([
    // bottom (z=0), looking up
    0, 2, 1, 0, 3, 2,
    // top (z=1)
    4, 5, 6, 4, 6, 7,
    // -y
    0, 1, 5, 0, 5, 4,
    // +y
    3, 6, 2, 3, 7, 6,
    // -x
    0, 4, 7, 0, 7, 3,
    // +x
    1, 2, 6, 1, 6, 5,
  ]);
  const posBuffer = new Buffer({
    data: positions,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const indexBuffer = new Buffer({
    data: indices,
    usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
  });
  const geometry = new Geometry({
    attributes: {
      aLocal: { buffer: posBuffer, format: 'float32x3' },
    },
    indexBuffer,
  });

  const cameraUniforms = new UniformGroup({
    uViewProj: { value: new Float32Array(16), type: 'mat4x4<f32>' },
  });
  const transformUniforms = new UniformGroup({
    uOrigin: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
    uSize: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uColor: { value: new Float32Array([0.4, 1, 0.5]), type: 'vec3<f32>' },
    uAlpha: { value: 0.35, type: 'f32' },
  });
  const glProgram = GlProgram.from({
    vertex: VERTEX_SRC,
    fragment: FRAGMENT_SRC,
    name: 'ghost-cube-v2',
  });
  const shader = new Shader({
    glProgram,
    resources: {
      cameraUniforms,
      transformUniforms,
      fogUniforms: fog.group,
    },
  });
  const mesh = new Mesh({ geometry, shader });
  mesh.cullable = false;
  mesh.eventMode = 'none';
  // Translucent — depth test on (cube is occluded by closer
  // walls) but depth WRITE off so we don't punch a hole that
  // hides things drawn after us.
  mesh.state.depthTest = true;
  mesh.state.depthMask = false;
  mesh.state.culling = false;
  mesh.state.blend = true;
  mesh.visible = false;

  const cameraMatrix = cameraUniforms.uniforms.uViewProj as Float32Array;
  const uOrigin = transformUniforms.uniforms.uOrigin as Float32Array;
  const uSize = transformUniforms.uniforms.uSize as Float32Array;
  const uColor = transformUniforms.uniforms.uColor as Float32Array;

  return {
    mesh,
    cameraMatrix,
    flushCamera: () => cameraUniforms.update(),
    setTransform: (ox, oy, oz, sx, sy, sz) => {
      uOrigin[0] = ox;
      uOrigin[1] = oy;
      uOrigin[2] = oz;
      uSize[0] = sx;
      uSize[1] = sy;
      uSize[2] = sz;
      transformUniforms.update();
    },
    setColor: (rgb, alpha) => {
      uColor[0] = ((rgb >> 16) & 0xff) / 255;
      uColor[1] = ((rgb >> 8) & 0xff) / 255;
      uColor[2] = (rgb & 0xff) / 255;
      (transformUniforms.uniforms as { uAlpha: number }).uAlpha = alpha;
      transformUniforms.update();
    },
    setVisible: (v) => {
      mesh.visible = v;
    },
    destroy: () => {
      try {
        geometry.destroy(true);
      } catch {
        /* best-effort */
      }
    },
  };
}
