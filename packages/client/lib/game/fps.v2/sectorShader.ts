// Vertex + fragment shaders for the colored sector + colored
// sprite path. Both reuse this single shader (we hand the
// shader to spriteLayer at construction). Distance fog blends
// each fragment toward the biome's fog colour using a linear
// falloff between uFogStart and uFogEnd; fog distance is
// computed PER-FRAGMENT (not per-vertex) because the surface
// floor is a sparse 4-vertex polygon spanning thousands of
// world units — per-vertex interpolation rounds every fragment
// to maximum fog there. Per-fragment costs one length() per
// pixel but the cost is negligible at our triangle counts.

import { Shader, GlProgram, UniformGroup } from 'pixi.js';
import type { FogUniformsHandle } from './fogUniforms';

// NOTE: attribute MUST be named `aPosition` so Pixi v8's
// getGeometryBounds can compute bounds for the Mesh.
const VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec3 aBaseColor;

uniform mat4 uViewProj;

varying vec3 vColor;
varying vec3 vWorldPos;

void main() {
  vColor = aBaseColor;
  vWorldPos = aPosition;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;

varying vec3 vColor;
varying vec3 vWorldPos;

uniform vec3 uCameraPos;
uniform float uFogStart;
uniform float uFogEnd;
uniform vec3 uFogColor;

void main() {
  float d = distance(vWorldPos, uCameraPos);
  float fogT = clamp(
    (d - uFogStart) / max(0.0001, uFogEnd - uFogStart),
    0.0,
    1.0
  );
  vec3 lit = mix(vColor, uFogColor, fogT);
  gl_FragColor = vec4(lit, 1.0);
}
`;

export type SectorShaderHandle = {
  shader: Shader;
  uViewProj: Float32Array;
  flush: () => void;
};

export function createSectorShader(fog: FogUniformsHandle): SectorShaderHandle {
  const cameraUniforms = new UniformGroup({
    uViewProj: { value: new Float32Array(16), type: 'mat4x4<f32>' },
  });
  const glProgram = GlProgram.from({
    vertex: VERTEX_SRC,
    fragment: FRAGMENT_SRC,
    name: 'sector-shader-v2',
  });
  const shader = new Shader({
    glProgram,
    resources: {
      cameraUniforms,
      fogUniforms: fog.group,
    },
  });
  const uViewProj = cameraUniforms.uniforms.uViewProj as Float32Array;
  return {
    shader,
    uViewProj,
    flush: () => cameraUniforms.update(),
  };
}
