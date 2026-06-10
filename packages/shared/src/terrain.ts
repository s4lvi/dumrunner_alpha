// Procedural terrain heightmap. Server + client both import from
// here so the simulation and the renderer see the same hills.
//
// Algorithm: value noise (cheap, ~80 LoC, no dep) with optional
// fbm stacking. Same input (seed, x, y) → same output bit-for-bit.
// Tunables live on TerrainConfig and ship in the SceneLayout.

export type TerrainConfig = {
  // Peak-to-trough height in world units. 0 = flat.
  amplitude: number;
  // 1 / world-unit period. Higher = tighter hills. Typical values
  // 1/128 → 1/256 (one hill every 128–256 wu).
  frequency: number;
  // fbm layers. 1 = pure value noise; 2–4 stack progressively
  // halved-amplitude, doubled-frequency octaves to add detail.
  octaves: number;
  // Per-scene seed mixed with cell coords so different scenes
  // (or different cycles) produce different terrain.
  seed: number;
};

// Value-noise lookup. Returns a deterministic [-1, 1] value
// driven by integer (xi, yi) + the seed mix. Implementation is a
// standard cheap hash → cell corner → bilinear-smooth interp.
function valueNoise(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash(seed, xi, yi);
  const b = hash(seed, xi + 1, yi);
  const c = hash(seed, xi, yi + 1);
  const d = hash(seed, xi + 1, yi + 1);
  // Smoothstep on the fractional position for C1-continuous
  // gradients (no visible grid edges along integer lines).
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

// Integer hash → [-1, 1]. Mixed enough to avoid visible axis
// streaks at our amplitudes. Mulberry-style; cheap.
function hash(seed: number, x: number, y: number): number {
  let h = seed | 0;
  h = (h ^ Math.imul(x | 0, 0x27d4eb2f)) >>> 0;
  h = (h ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  // Map uint32 → [-1, 1]. The `>>> 0` above is load-bearing —
  // without it `h` is a signed int32 after the XOR, and the
  // division produces [-2, 0] instead of [-1, 1], biasing the
  // entire noise field downward by half its amplitude.
  return (h / 0xffffffff) * 2 - 1;
}

// Sample the terrain height at world-space (x, y). Output unit
// matches `cfg.amplitude` (world units). Zero when cfg is null.
export function terrainHeightAt(
  cfg: TerrainConfig | null | undefined,
  x: number,
  y: number,
): number {
  if (!cfg || cfg.amplitude === 0) return 0;
  let sum = 0;
  let amp = 1;
  let freq = cfg.frequency;
  let ampAccum = 0;
  const octaves = Math.max(1, cfg.octaves | 0);
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(cfg.seed + i * 0x1f87a, x * freq, y * freq) * amp;
    ampAccum += amp;
    amp *= 0.5;
    freq *= 2;
  }
  // Normalise so the final amplitude matches cfg.amplitude
  // regardless of octave count.
  return (sum / ampAccum) * cfg.amplitude;
}

// Perimeter-distance falloff used by per-sector noise. Returns a
// scalar in [0, 1] that's 0 ON the polygon's perimeter and 1 once
// the point is at least `fade` wu inside. Smoothstep'd so the
// floor transitions to flat seamlessly at portal edges instead of
// ending in a sharp ring.
//
// Cost: O(N) edges per sample. Sectors don't have many edges
// (single-digit verts in practice), and the renderer only calls
// this on tessellation grid points which is bounded by sector
// area. Server collision calls it once per floorAt query.
export function perimeterFalloff(
  outer: ReadonlyArray<{ x: number; y: number }>,
  holes: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> | undefined,
  x: number,
  y: number,
  fade: number,
): number {
  if (fade <= 0) return 1;
  let minDistSq = Infinity;
  const consider = (
    ring: ReadonlyArray<{ x: number; y: number }>,
  ): void => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const ddx = x - px;
      const ddy = y - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < minDistSq) minDistSq = d2;
    }
  };
  consider(outer);
  if (holes) for (const h of holes) consider(h);
  if (minDistSq === Infinity) return 1;
  const d = Math.sqrt(minDistSq);
  const t = d / fade;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Smoothstep.
  return t * t * (3 - 2 * t);
}

// Default perimeter fade distance. Big enough that a small noise
// amplitude reads smooth at the edges but not so big it kills the
// effect in small sectors. Tweakable per-sector later via
// `floorNoise.fadeOverride` if needed; for now it's a constant.
const PERIMETER_FADE_WU = 48;

// Net displacement for a noise field at (x, y) within a sector.
// Combines the raw noise value with the perimeter falloff so the
// floor / ceiling matches its flat baseline at every shared edge.
// Returns 0 when cfg is absent.
export function sectorNoiseOffsetAt(
  cfg: TerrainConfig | null | undefined,
  outer: ReadonlyArray<{ x: number; y: number }>,
  holes: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> | undefined,
  x: number,
  y: number,
): number {
  if (!cfg || cfg.amplitude === 0) return 0;
  const noise = terrainHeightAt(cfg, x, y);
  if (noise === 0) return 0;
  const fall = perimeterFalloff(outer, holes, x, y, PERIMETER_FADE_WU);
  return noise * fall;
}
