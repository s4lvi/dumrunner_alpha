// CPU impact-particle system for the v2 renderer.
//
// Replaces the single flat "impact billboard" with short physical
// bursts: blood droplets on flesh hits (enemy / PvP player),
// spark streaks + a brief flash on surface hits (wall / terrain /
// building / prop). Each particle is a tiny camera-facing quad
// pushed through the existing solid-colour sprite layer, so depth
// testing against world geometry comes for free — a burst behind
// a wall is occluded exactly like any other billboard.
//
// Design constraints:
//   - Fixed pool (MAX_PARTICLES) stored as structure-of-arrays
//     typed arrays. Spawning past capacity overwrites the oldest
//     slot (ring cursor), so a bullet-hose firefight degrades by
//     evicting old particles instead of growing memory.
//   - Zero steady-state allocation: the per-slot SpriteRequest
//     objects are preallocated once and mutated in place each
//     frame before being pushed into the caller's scratch array.
//   - Floor height is sampled ONCE at spawn time and cached per
//     particle. Droplets travel a few tiles at most, so the
//     spawn-point floor is visually right and avoids 512
//     sector-scan floor queries per frame.

import type { SpriteRequest } from './spriteLayer';

export type ImpactKind = 'flesh' | 'surface';

export type ParticleSystem = {
  // Spawn a burst at a world-space contact point. `dirX/Y/Z` is
  // the incoming projectile velocity (unnormalised is fine) used
  // to bias the spray back toward the shooter; omit for a
  // uniform spread. `intensity` scales particle count (e.g. 0.5
  // for the small melee-hit blood tick); default 1.
  spawnImpact(
    kind: ImpactKind,
    x: number,
    y: number,
    z: number,
    now: number,
    floorZ: number,
    dirX?: number,
    dirY?: number,
    dirZ?: number,
    intensity?: number,
  ): void;
  // Advance all live particles to `now` and emit one sprite per
  // survivor into `out`. dt is derived internally from the last
  // update call (clamped so a background-tab stall doesn't
  // teleport droplets through the floor).
  update(now: number, out: SpriteRequest[]): void;
};

const MAX_PARTICLES = 512;
// dt clamp — a stalled tab resumes with one normal-ish step
// instead of integrating seconds of gravity at once.
const MAX_DT_S = 0.1;

// Flesh burst tuning. World units match the rest of the renderer
// (tile = 32, wall height = 32).
const FLESH_COUNT_MIN = 10;
const FLESH_COUNT_VAR = 7; // 10..16
const FLESH_SPEED_MIN = 30;
const FLESH_SPEED_VAR = 70;
const FLESH_GRAVITY = 240;
const FLESH_LIFE_MIN_MS = 350;
const FLESH_LIFE_VAR_MS = 250;
const FLESH_SIZE_MIN = 1.6;
const FLESH_SIZE_VAR = 1.4;

// Surface (spark) burst tuning.
const SPARK_COUNT_MIN = 8;
const SPARK_COUNT_VAR = 5; // 8..12
const SPARK_SPEED_MIN = 80;
const SPARK_SPEED_VAR = 160;
const SPARK_GRAVITY = 100;
const SPARK_LIFE_MIN_MS = 200;
const SPARK_LIFE_VAR_MS = 150;
const SPARK_SIZE_MIN = 0.9;
const SPARK_SIZE_VAR = 0.9;
// The brief flash quad that sells the "spark" read — one larger
// stationary particle that dies in ~70ms.
const FLASH_SIZE = 5;
const FLASH_LIFE_MS = 70;

export function createParticleSystem(): ParticleSystem {
  // Structure-of-arrays particle pool. lifeMs === 0 marks a dead
  // slot. spawnedAt needs f64 — f32's 24-bit mantissa loses
  // millisecond precision a few hours into a session.
  const px = new Float32Array(MAX_PARTICLES);
  const py = new Float32Array(MAX_PARTICLES);
  const pz = new Float32Array(MAX_PARTICLES);
  const vx = new Float32Array(MAX_PARTICLES);
  const vy = new Float32Array(MAX_PARTICLES);
  const vz = new Float32Array(MAX_PARTICLES);
  const grav = new Float32Array(MAX_PARTICLES);
  const floor = new Float32Array(MAX_PARTICLES);
  const size = new Float32Array(MAX_PARTICLES);
  const lifeMs = new Float32Array(MAX_PARTICLES);
  const spawnedAt = new Float64Array(MAX_PARTICLES);
  // Start / end colours, lerped over the particle's life
  // (white→orange sparks, red→dark-red blood).
  const r0 = new Float32Array(MAX_PARTICLES);
  const g0 = new Float32Array(MAX_PARTICLES);
  const b0 = new Float32Array(MAX_PARTICLES);
  const r1 = new Float32Array(MAX_PARTICLES);
  const g1 = new Float32Array(MAX_PARTICLES);
  const b1 = new Float32Array(MAX_PARTICLES);
  // 1 once the particle has come to rest on the floor (blood
  // splat) — integration stops, the fade keeps running.
  const settled = new Uint8Array(MAX_PARTICLES);

  // Preallocated emit objects, mutated in place every frame.
  const sprites: SpriteRequest[] = new Array(MAX_PARTICLES);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    sprites[i] = { x: 0, y: 0, anchorZ: 0, height: 0, color: 0 };
  }

  // Ring cursor — next slot to write. Overwrites the oldest
  // particle when the pool is saturated.
  let cursor = 0;
  let lastUpdateAt = 0;

  function alloc(): number {
    const i = cursor;
    cursor = (cursor + 1) % MAX_PARTICLES;
    return i;
  }

  // Spray basis: unit vector pointing back along the incoming
  // projectile path (toward the shooter), or straight up when no
  // direction is available. Written into outDir (reused scratch).
  const outDir = new Float32Array(3);
  function sprayBasis(dirX?: number, dirY?: number, dirZ?: number): void {
    if (dirX !== undefined && dirY !== undefined) {
      const dz = dirZ ?? 0;
      const len = Math.hypot(dirX, dirY, dz);
      if (len > 0.001) {
        outDir[0] = -dirX / len;
        outDir[1] = -dirY / len;
        outDir[2] = -dz / len;
        return;
      }
    }
    outDir[0] = 0;
    outDir[1] = 0;
    outDir[2] = 1;
  }

  function spawnOne(
    x: number,
    y: number,
    z: number,
    velX: number,
    velY: number,
    velZ: number,
    gravity: number,
    floorZ: number,
    sz: number,
    life: number,
    now: number,
    cr0: number,
    cg0: number,
    cb0: number,
    cr1: number,
    cg1: number,
    cb1: number,
  ): void {
    const i = alloc();
    px[i] = x;
    py[i] = y;
    pz[i] = z;
    vx[i] = velX;
    vy[i] = velY;
    vz[i] = velZ;
    grav[i] = gravity;
    floor[i] = floorZ;
    size[i] = sz;
    lifeMs[i] = life;
    spawnedAt[i] = now;
    r0[i] = cr0;
    g0[i] = cg0;
    b0[i] = cb0;
    r1[i] = cr1;
    g1[i] = cg1;
    b1[i] = cb1;
    settled[i] = 0;
  }

  return {
    spawnImpact(kind, x, y, z, now, floorZ, dirX, dirY, dirZ, intensity = 1) {
      sprayBasis(dirX, dirY, dirZ);
      const bx = outDir[0];
      const by = outDir[1];
      const bz = outDir[2];
      if (kind === 'flesh') {
        const count = Math.max(
          1,
          Math.round(
            (FLESH_COUNT_MIN + Math.random() * FLESH_COUNT_VAR) * intensity,
          ),
        );
        for (let n = 0; n < count; n++) {
          // Random unit vector (uniform on the sphere), blended
          // toward the spray basis so the burst reads as coming
          // OUT of the hit side, with a touch of lift so drops
          // arc before gravity takes them.
          const u = Math.random() * 2 - 1;
          const theta = Math.random() * Math.PI * 2;
          const s = Math.sqrt(1 - u * u);
          let dx = s * Math.cos(theta) + bx * 0.9;
          let dy = s * Math.sin(theta) + by * 0.9;
          let dz = u + bz * 0.9 + 0.5;
          const dl = Math.hypot(dx, dy, dz) || 1;
          const speed = FLESH_SPEED_MIN + Math.random() * FLESH_SPEED_VAR;
          dx = (dx / dl) * speed;
          dy = (dy / dl) * speed;
          dz = (dz / dl) * speed;
          // Dark red, slightly varied per droplet, darkening as
          // it ages so settled splats fade toward dried blood.
          const v = 0.45 + Math.random() * 0.25;
          spawnOne(
            x,
            y,
            z,
            dx,
            dy,
            dz,
            FLESH_GRAVITY,
            floorZ,
            FLESH_SIZE_MIN + Math.random() * FLESH_SIZE_VAR,
            FLESH_LIFE_MIN_MS + Math.random() * FLESH_LIFE_VAR_MS,
            now,
            v,
            v * 0.12,
            v * 0.12,
            0.25,
            0.03,
            0.03,
          );
        }
      } else {
        const count = Math.max(
          1,
          Math.round(
            (SPARK_COUNT_MIN + Math.random() * SPARK_COUNT_VAR) * intensity,
          ),
        );
        for (let n = 0; n < count; n++) {
          const u = Math.random() * 2 - 1;
          const theta = Math.random() * Math.PI * 2;
          const s = Math.sqrt(1 - u * u);
          let dx = s * Math.cos(theta) + bx * 1.2;
          let dy = s * Math.sin(theta) + by * 1.2;
          let dz = u + bz * 1.2 + 0.3;
          const dl = Math.hypot(dx, dy, dz) || 1;
          const speed = SPARK_SPEED_MIN + Math.random() * SPARK_SPEED_VAR;
          dx = (dx / dl) * speed;
          dy = (dy / dl) * speed;
          dz = (dz / dl) * speed;
          spawnOne(
            x,
            y,
            z,
            dx,
            dy,
            dz,
            SPARK_GRAVITY,
            floorZ,
            SPARK_SIZE_MIN + Math.random() * SPARK_SIZE_VAR,
            SPARK_LIFE_MIN_MS + Math.random() * SPARK_LIFE_VAR_MS,
            now,
            // White-hot → ember orange.
            1,
            1,
            1,
            1,
            0.55,
            0.1,
          );
        }
        // Contact flash — a single stationary quad that pops and
        // dies before the sparks finish.
        spawnOne(
          x,
          y,
          z,
          0,
          0,
          0,
          0,
          floorZ,
          FLASH_SIZE,
          FLASH_LIFE_MS,
          now,
          1,
          1,
          0.95,
          1,
          0.82,
          0.48,
        );
      }
    },

    update(now, out) {
      const dt = Math.min(
        MAX_DT_S,
        lastUpdateAt > 0 ? (now - lastUpdateAt) / 1000 : 0,
      );
      lastUpdateAt = now;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const life = lifeMs[i];
        if (life <= 0) continue;
        const age = now - spawnedAt[i];
        if (age >= life) {
          lifeMs[i] = 0;
          continue;
        }
        if (settled[i] === 0 && dt > 0) {
          px[i] += vx[i] * dt;
          py[i] += vy[i] * dt;
          vz[i] -= grav[i] * dt;
          pz[i] += vz[i] * dt;
          const halfSize = size[i] * 0.5;
          if (pz[i] - halfSize <= floor[i]) {
            // Touch down: rest on the cached spawn-time floor.
            // Blood reads as a splat that keeps fading; sparks
            // die quickly anyway so a grounded ember is fine.
            pz[i] = floor[i] + halfSize;
            vx[i] = 0;
            vy[i] = 0;
            vz[i] = 0;
            settled[i] = 1;
          }
        }
        const frac = age / life;
        // Shrink over life so the burst dissipates instead of
        // popping out — 100% → 35% of spawn size.
        const h = size[i] * (1 - 0.65 * frac);
        const cr = r0[i] + (r1[i] - r0[i]) * frac;
        const cg = g0[i] + (g1[i] - g0[i]) * frac;
        const cb = b0[i] + (b1[i] - b0[i]) * frac;
        const sp = sprites[i];
        sp.x = px[i];
        sp.y = py[i];
        sp.anchorZ = pz[i] - h * 0.5;
        sp.height = h;
        sp.color =
          ((Math.round(cr * 255) & 0xff) << 16) |
          ((Math.round(cg * 255) & 0xff) << 8) |
          (Math.round(cb * 255) & 0xff);
        out.push(sp);
      }
    },
  };
}
