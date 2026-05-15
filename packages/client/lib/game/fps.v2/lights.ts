// Light manager.
//
// Owns two pools of point lights: dynamic (TTL-based — muzzle
// flashes, explosion flashes, attached pulses) and static
// (scene-tied — stairs, extract pads, future authored room
// lights). Both pools merge into a single per-frame uniform
// write; the manager ranks by camera distance so nearby lights
// always win the MAX_LIGHTS budget.

import { MAX_LIGHTS, type LightingUniformsHandle } from './lightingUniforms';

export type DynamicLight = {
  id: string;
  x: number;
  y: number;
  z: number;
  // World units. Light contribution falls off quadratically to
  // zero at this distance.
  radius: number;
  // 0..1 RGB triple, stored pre-multiplied.
  r: number;
  g: number;
  b: number;
  // Multiplier on the colour. <1 dims, >1 over-brightens
  // (clamped at shader output). Decays linearly to zero over
  // [spawnedAt, expiresAt].
  intensity: number;
  spawnedAt: number;
  expiresAt: number;
};

export type StaticLight = {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  r: number;
  g: number;
  b: number;
  // Steady intensity. Unlike dynamic lights this doesn't decay
  // — it holds until the scene replaces the set.
  intensity: number;
};

export type LightManager = {
  add: (light: Omit<DynamicLight, 'spawnedAt'> & { spawnedAt?: number }) => void;
  // Replace the static light set wholesale. Cheap — we rebuild
  // the per-frame uniform packing every tick anyway. Pass an
  // empty array on scene unload.
  setStaticLights: (lights: StaticLight[]) => void;
  // Drop the static set without re-adding (equivalent to
  // setStaticLights([])).
  clearStaticLights: () => void;
  // Remove expired + write the live set into the shared
  // uniforms. Pass the camera position so we can rank by
  // distance when there are more lights than MAX_LIGHTS.
  tick: (nowMs: number, camX: number, camY: number, camZ: number) => void;
};

export function createLightManager(uniforms: LightingUniformsHandle): LightManager {
  // Dynamic pool — muzzle flashes etc. We don't pre-allocate
  // since per-frame writes are uniform updates, not per-light
  // allocs.
  const lights: DynamicLight[] = [];
  // Static pool — replaced on scene swap.
  let staticLights: StaticLight[] = [];

  // Scratch buffer for the distance ranking to avoid per-frame
  // re-allocation. Indexed by `lights` index.
  let dsqScratch: number[] = [];

  return {
    add(light): void {
      lights.push({
        ...light,
        spawnedAt: light.spawnedAt ?? performance.now(),
      });
    },
    setStaticLights(next): void {
      // Copy so callers can mutate their array without leaking
      // back into our state. Small array — copy cost is trivial
      // compared to per-frame uniform writes.
      staticLights = next.slice();
    },
    clearStaticLights(): void {
      staticLights.length = 0;
    },
    tick(nowMs, camX, camY, camZ): void {
      // Drop expired dynamic lights. In-place compaction so we
      // don't allocate.
      let write = 0;
      for (let read = 0; read < lights.length; read++) {
        if (lights[read].expiresAt > nowMs) {
          if (write !== read) lights[write] = lights[read];
          write++;
        }
      }
      lights.length = write;

      uniforms.clear();
      const totalCount = lights.length + staticLights.length;
      if (totalCount === 0) {
        uniforms.flush();
        return;
      }

      // Rank by camera distance² (cheaper than sqrt). Top
      // MAX_LIGHTS slots go to the GPU. Dynamic and static
      // lights compete on equal terms — a far stairs glow loses
      // to a close muzzle flash, which is what we want.
      if (dsqScratch.length < totalCount) {
        dsqScratch = new Array<number>(totalCount).fill(0);
      }
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        const dx = l.x - camX;
        const dy = l.y - camY;
        const dz = l.z - camZ;
        dsqScratch[i] = dx * dx + dy * dy + dz * dz;
      }
      for (let i = 0; i < staticLights.length; i++) {
        const l = staticLights[i];
        const dx = l.x - camX;
        const dy = l.y - camY;
        const dz = l.z - camZ;
        dsqScratch[lights.length + i] = dx * dx + dy * dy + dz * dz;
      }
      // Index array sorted by dsq ascending (closest first).
      // Indices < lights.length point into the dynamic pool;
      // anything ≥ lights.length is a static-pool entry.
      const order: number[] = new Array(totalCount);
      for (let i = 0; i < totalCount; i++) order[i] = i;
      order.sort((a, b) => dsqScratch[a] - dsqScratch[b]);

      const count = Math.min(MAX_LIGHTS, totalCount);
      for (let slot = 0; slot < count; slot++) {
        const idx = order[slot];
        if (idx < lights.length) {
          const l = lights[idx];
          // Linear decay from full intensity at spawn to zero
          // at expiry. Smooths the cutoff so e.g. a muzzle flash
          // doesn't snap-disappear mid-frame.
          const lifetime = Math.max(1, l.expiresAt - l.spawnedAt);
          const elapsed = nowMs - l.spawnedAt;
          const t = Math.max(0, Math.min(1, 1 - elapsed / lifetime));
          uniforms.set(
            slot, l.x, l.y, l.z, l.radius,
            l.r, l.g, l.b, l.intensity * t,
          );
        } else {
          const l = staticLights[idx - lights.length];
          uniforms.set(
            slot, l.x, l.y, l.z, l.radius,
            l.r, l.g, l.b, l.intensity,
          );
        }
      }
      uniforms.flush();
    },
  };
}

// Convenience packers for common light templates so callers
// don't repeat the colour/radius math.

// Static glow at a stairs_down interactable. Cool blue —
// reads as "transition / descent" against the warm muzzle
// flashes and the desaturated dungeon palette.
export function stairsDownLightAt(
  id: string,
  x: number,
  y: number,
  z: number,
): StaticLight {
  return {
    id,
    x,
    y,
    z,
    radius: 160,
    r: 0.45,
    g: 0.65,
    b: 1.0,
    intensity: 1.1,
  };
}

// Static glow at an extract_pad interactable. Warm green —
// "safe exit" cue, contrasts with the cool stairs glow so the
// two are visually distinguishable in a dungeon entrance room.
export function extractPadLightAt(
  id: string,
  x: number,
  y: number,
  z: number,
): StaticLight {
  return {
    id,
    x,
    y,
    z,
    radius: 160,
    r: 0.55,
    g: 1.0,
    b: 0.6,
    intensity: 1.1,
  };
}

export function muzzleFlashAt(
  x: number,
  y: number,
  z: number,
  nowMs: number,
): Omit<DynamicLight, 'spawnedAt'> & { spawnedAt: number } {
  // Warm white-yellow, short and bright. 60ms TTL — the player
  // sees a single bright frame at the shot.
  return {
    id: `muzzle-${nowMs}-${Math.random()}`,
    x,
    y,
    z,
    radius: 140,
    r: 1.0,
    g: 0.96,
    b: 0.78,
    intensity: 1.4,
    spawnedAt: nowMs,
    expiresAt: nowMs + 60,
  };
}
