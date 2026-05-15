// Textured sector shader. Camera projection + texture sample +
// per-fragment distance fog + per-fragment forward lighting
// (point lights with quadratic falloff). Per-fragment lighting
// uses the interpolated world position; the loop runs over
// MAX_LIGHTS uniform slots and skips empty ones via the
// radius==0 sentinel.

import { Shader, GlProgram, UniformGroup, type Texture } from 'pixi.js';
import type { FogUniformsHandle } from './fogUniforms';
import { MAX_LIGHTS, type LightingUniformsHandle } from './lightingUniforms';

const VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec2 aUV;

uniform mat4 uViewProj;

varying vec2 vUV;
varying vec3 vWorldPos;

void main() {
  vUV = aUV;
  vWorldPos = aPosition;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

// MAX_LIGHTS expands to a compile-time constant in the shader
// source via template substitution. WebGL 1 / GLSL 100 forbids
// non-constant loop bounds; mirroring the value here keeps the
// CPU + GPU sides aligned.
const FRAGMENT_SRC = `
precision mediump float;

#define MAX_LIGHTS ${MAX_LIGHTS}

varying vec2 vUV;
varying vec3 vWorldPos;

uniform sampler2D uTexture;
uniform vec3 uCameraPos;
uniform float uFogStart;
uniform float uFogEnd;
uniform vec3 uFogColor;
uniform vec4 uLightPosRadius[MAX_LIGHTS];
uniform vec4 uLightColorIntensity[MAX_LIGHTS];

vec3 sampleLights(vec3 worldPos) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    float radius = uLightPosRadius[i].w;
    if (radius <= 0.0) continue;
    vec3 toLight = uLightPosRadius[i].xyz - worldPos;
    float dist = length(toLight);
    if (dist > radius) continue;
    float t = dist / radius;
    float fall = 1.0 - t * t;
    sum += uLightColorIntensity[i].rgb
         * uLightColorIntensity[i].w
         * fall;
  }
  return sum;
}

void main() {
  vec4 tex = texture2D(uTexture, vUV);
  vec3 litRgb = tex.rgb + sampleLights(vWorldPos) * tex.rgb;
  float d = distance(vWorldPos, uCameraPos);
  float fogT = clamp(
    (d - uFogStart) / max(0.0001, uFogEnd - uFogStart),
    0.0,
    1.0
  );
  litRgb = mix(litRgb, uFogColor, fogT);
  gl_FragColor = vec4(litRgb, tex.a);
}
`;

let cachedGlProgram: GlProgram | null = null;
function getGlProgram(): GlProgram {
  if (cachedGlProgram) return cachedGlProgram;
  cachedGlProgram = GlProgram.from({
    vertex: VERTEX_SRC,
    fragment: FRAGMENT_SRC,
    name: 'textured-sector-v2',
  });
  return cachedGlProgram;
}

export type TexturedSectorCameraUniforms = {
  group: UniformGroup;
  uViewProj: Float32Array;
  flush: () => void;
};

export function createTexturedSectorCameraUniforms(): TexturedSectorCameraUniforms {
  const group = new UniformGroup({
    uViewProj: { value: new Float32Array(16), type: 'mat4x4<f32>' },
  });
  const uViewProj = group.uniforms.uViewProj as Float32Array;
  return {
    group,
    uViewProj,
    flush: () => group.update(),
  };
}

export function createTexturedSectorShader(
  cameraUniforms: TexturedSectorCameraUniforms,
  fog: FogUniformsHandle,
  lighting: LightingUniformsHandle,
  texture: Texture,
): Shader {
  return new Shader({
    glProgram: getGlProgram(),
    resources: {
      cameraUniforms: cameraUniforms.group,
      fogUniforms: fog.group,
      lightingUniforms: lighting.group,
      uTexture: texture.source,
    },
  });
}
