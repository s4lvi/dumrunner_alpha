// Shared lighting uniforms.
//
// Every shader that samples lights reads from one shared
// UniformGroup so a single per-frame write reaches the textured
// sector + textured sprite passes at once. WebGL 1 / GLSL 100
// requires array sizes be compile-time constant — MAX_LIGHTS
// must match the literal in the shader source.
//
// Light layout per slot:
//   posRadius (vec4): xyz = world position, w = radius
//   colorIntensity (vec4): rgb = colour, w = intensity multiplier
//
// A slot is "empty" when its radius is 0 — the shader fast-
// paths an early-out on that.

import { UniformGroup } from 'pixi.js';

export const MAX_LIGHTS = 8;

export type LightingUniformsHandle = {
  group: UniformGroup;
  // Direct typed-array refs — writers update entries in place
  // and call flush() once after all writes per frame.
  posRadius: Float32Array; // MAX_LIGHTS × 4
  colorIntensity: Float32Array; // MAX_LIGHTS × 4
  flush: () => void;
  // Convenience — clear every slot (sets radius to 0).
  clear: () => void;
  // Write light i. Caller maintains the slot index; clearing a
  // slot is `set(i, x, y, z, 0, 0, 0, 0, 0)` (radius 0).
  set: (
    i: number,
    x: number,
    y: number,
    z: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    intensity: number,
  ) => void;
};

export function createLightingUniforms(): LightingUniformsHandle {
  const posRadius = new Float32Array(MAX_LIGHTS * 4);
  const colorIntensity = new Float32Array(MAX_LIGHTS * 4);
  const group = new UniformGroup({
    uLightPosRadius: { value: posRadius, type: 'vec4<f32>', size: MAX_LIGHTS },
    uLightColorIntensity: {
      value: colorIntensity,
      type: 'vec4<f32>',
      size: MAX_LIGHTS,
    },
  });
  return {
    group,
    posRadius,
    colorIntensity,
    flush: () => group.update(),
    clear: () => {
      posRadius.fill(0);
      colorIntensity.fill(0);
    },
    set(i, x, y, z, radius, r, g, b, intensity) {
      const baseP = i * 4;
      posRadius[baseP + 0] = x;
      posRadius[baseP + 1] = y;
      posRadius[baseP + 2] = z;
      posRadius[baseP + 3] = radius;
      colorIntensity[baseP + 0] = r;
      colorIntensity[baseP + 1] = g;
      colorIntensity[baseP + 2] = b;
      colorIntensity[baseP + 3] = intensity;
    },
  };
}
