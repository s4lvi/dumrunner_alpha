// Textured-sprite shader. Camera projection + tinted texture
// sample + per-fragment distance fog + forward point-light
// contribution. Sprites pick up the same lighting model as the
// world geometry so muzzle flashes / explosion flashes brighten
// enemies and props in step with the walls around them.

import { Shader, GlProgram, UniformGroup, type Texture } from 'pixi.js';
import type { FogUniformsHandle } from './fogUniforms';
import { MAX_LIGHTS, type LightingUniformsHandle } from './lightingUniforms';

const VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec2 aUV;
attribute vec3 aTint;

uniform mat4 uViewProj;

varying vec2 vUV;
varying vec3 vTint;
varying vec3 vWorldPos;

void main() {
  vUV = aUV;
  vTint = aTint;
  vWorldPos = aPosition;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;

#define MAX_LIGHTS ${MAX_LIGHTS}

varying vec2 vUV;
varying vec3 vTint;
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
  if (tex.a < 0.01) discard;
  vec3 lit = tex.rgb * vTint;
  lit = lit + sampleLights(vWorldPos) * lit;
  float d = distance(vWorldPos, uCameraPos);
  float fogT = clamp(
    (d - uFogStart) / max(0.0001, uFogEnd - uFogStart),
    0.0,
    1.0
  );
  lit = mix(lit, uFogColor, fogT);
  gl_FragColor = vec4(lit, tex.a);
}
`;

let cachedGlProgram: GlProgram | null = null;
function getGlProgram(): GlProgram {
  if (cachedGlProgram) return cachedGlProgram;
  cachedGlProgram = GlProgram.from({
    vertex: VERTEX_SRC,
    fragment: FRAGMENT_SRC,
    name: 'textured-sprite-v2',
  });
  return cachedGlProgram;
}

export type TexturedSpriteCameraUniforms = {
  group: UniformGroup;
  uViewProj: Float32Array;
  flush: () => void;
};

export function createTexturedSpriteCameraUniforms(): TexturedSpriteCameraUniforms {
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

export function createTexturedSpriteShader(
  cameraUniforms: TexturedSpriteCameraUniforms,
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
