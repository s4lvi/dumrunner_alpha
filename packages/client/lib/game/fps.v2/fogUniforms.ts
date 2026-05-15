// Shared fog parameter UniformGroup.
//
// Every v2 shader samples this so a single write per frame (in
// the renderer's tick) reaches the colored sector mesh, the
// textured surface meshes, the building cubes, and both sprite
// layers. Centralising the layout means changing the fog model
// later (e.g. exponential falloff) is a one-file edit.
//
// Uniforms:
//   uCameraPos  (vec3)  — world-space camera position
//   uFogStart   (float) — world units; closer than this = no fog
//   uFogEnd     (float) — world units; beyond this = full fog
//   uFogColor   (vec3)  — RGB to blend toward at full fog
//
// Linear fog factor t = clamp((d - start) / (end - start), 0, 1).
// Computed in the vertex shader and interpolated as a varying;
// fragment just runs a mix. Per-vertex interpolation is fine for
// dense meshes (sector floors/walls/ceilings); sprite quads only
// have 4 vertices so fog is constant across each quad's span —
// acceptable because sprites are small relative to their fog
// distance.

import { UniformGroup } from 'pixi.js';

export type FogUniformsHandle = {
  group: UniformGroup;
  // Direct refs to the underlying Float32Array views — bypass
  // Pixi's proxy accessor for per-frame writes.
  uCameraPos: Float32Array;
  uFogColor: Float32Array;
  setRange: (start: number, end: number) => void;
  flush: () => void;
};

export function createFogUniforms(): FogUniformsHandle {
  const group = new UniformGroup({
    uCameraPos: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
    uFogStart: { value: 200, type: 'f32' },
    uFogEnd: { value: 600, type: 'f32' },
    uFogColor: { value: new Float32Array([0.04, 0.05, 0.06]), type: 'vec3<f32>' },
  });
  return {
    group,
    uCameraPos: group.uniforms.uCameraPos as Float32Array,
    uFogColor: group.uniforms.uFogColor as Float32Array,
    setRange(start, end) {
      group.uniforms.uFogStart = start;
      group.uniforms.uFogEnd = end;
    },
    flush: () => group.update(),
  };
}
