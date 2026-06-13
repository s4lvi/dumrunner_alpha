// Turret mount socket markers (base layouts P3).
//
// Renders a small flat translucent pad on the ground at each FREE
// turret mount so the player can see where turrets snap. Occupied
// mounts (a turret already bound to that index) are omitted by the
// caller. All free mounts live in one Geometry (rebuilt only when the
// free-mount set changes) drawn with the same fogged, depth-tested /
// no-depth-write style as the build ghost so they read as part of the
// world.

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
attribute vec3 aPos;

uniform mat4 uViewProj;

varying vec3 vWorldPos;

void main() {
  vWorldPos = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
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

export type MountSocketsLayer = {
  mesh: Mesh<Geometry, Shader>;
  cameraMatrix: Float32Array;
  flushCamera: () => void;
  // Replace the rendered pads. `mounts` is the world-coord position of
  // each FREE mount; `z` is the pad floor height there; `half` is the
  // pad half-extent in world units. Empty list hides the layer.
  setMounts: (
    mounts: ReadonlyArray<{ x: number; y: number; z: number }>,
    half: number,
  ) => void;
  setColor: (rgb: number, alpha: number) => void;
  setVisible: (v: boolean) => void;
  destroy: () => void;
};

export function createMountSocketsLayer(
  fog: FogUniformsHandle,
): MountSocketsLayer {
  // Start with an empty 1-quad buffer; setMounts rewrites it. Sized
  // generously so the initial allocation rarely needs to grow (mounts
  // are a handful per layout).
  const posBuffer = new Buffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const indexBuffer = new Buffer({
    data: new Uint16Array(0),
    usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
  });
  const geometry = new Geometry({
    attributes: {
      aPos: { buffer: posBuffer, format: 'float32x3' },
    },
    indexBuffer,
  });

  const cameraUniforms = new UniformGroup({
    uViewProj: { value: new Float32Array(16), type: 'mat4x4<f32>' },
  });
  const styleUniforms = new UniformGroup({
    uColor: { value: new Float32Array([0.33, 1, 0.53]), type: 'vec3<f32>' },
    uAlpha: { value: 0.3, type: 'f32' },
  });
  const glProgram = GlProgram.from({
    vertex: VERTEX_SRC,
    fragment: FRAGMENT_SRC,
    name: 'mount-sockets-v2',
  });
  const shader = new Shader({
    glProgram,
    resources: {
      cameraUniforms,
      styleUniforms,
      fogUniforms: fog.group,
    },
  });
  const mesh = new Mesh({ geometry, shader });
  mesh.cullable = false;
  mesh.eventMode = 'none';
  mesh.state.depthTest = true;
  mesh.state.depthMask = false;
  mesh.state.culling = false;
  mesh.state.blend = true;
  mesh.visible = false;

  const cameraMatrix = cameraUniforms.uniforms.uViewProj as Float32Array;
  const uColor = styleUniforms.uniforms.uColor as Float32Array;

  return {
    mesh,
    cameraMatrix,
    flushCamera: () => cameraUniforms.update(),
    setMounts: (mounts, half) => {
      if (mounts.length === 0) {
        mesh.visible = false;
        return;
      }
      // One flat quad per mount, lifted a hair off the floor to dodge
      // z-fighting with the ground mesh.
      const pos = new Float32Array(mounts.length * 4 * 3);
      const idx = new Uint16Array(mounts.length * 6);
      for (let i = 0; i < mounts.length; i++) {
        const m = mounts[i];
        const z = m.z + 0.5;
        const v = i * 4;
        const p = v * 3;
        // CCW from above so the top face shows.
        pos[p + 0] = m.x - half; pos[p + 1] = m.y - half; pos[p + 2] = z;
        pos[p + 3] = m.x + half; pos[p + 4] = m.y - half; pos[p + 5] = z;
        pos[p + 6] = m.x + half; pos[p + 7] = m.y + half; pos[p + 8] = z;
        pos[p + 9] = m.x - half; pos[p + 10] = m.y + half; pos[p + 11] = z;
        const e = i * 6;
        idx[e + 0] = v + 0;
        idx[e + 1] = v + 2;
        idx[e + 2] = v + 1;
        idx[e + 3] = v + 0;
        idx[e + 4] = v + 3;
        idx[e + 5] = v + 2;
      }
      posBuffer.data = pos;
      indexBuffer.data = idx;
      mesh.visible = true;
    },
    setColor: (rgb, alpha) => {
      uColor[0] = ((rgb >> 16) & 0xff) / 255;
      uColor[1] = ((rgb >> 8) & 0xff) / 255;
      uColor[2] = (rgb & 0xff) / 255;
      (styleUniforms.uniforms as { uAlpha: number }).uAlpha = alpha;
      styleUniforms.update();
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
