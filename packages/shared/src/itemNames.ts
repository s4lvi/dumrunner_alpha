// Deterministic procedural item-name generator.
//
// Every flavored name comes out of the same function: a seed string
// hashes into a (prefix, suffix) pair from fixed pools. Same seed →
// same name forever. Used both for dropped CarriedParts (seed =
// part.id) and for blueprint/component listings (seed = blueprint.id
// or attachment defId), so the rolled name is stable across sessions.

// Adjective-feeling prefixes — vibe across "extraction shooter mid-
// horror" with a few sci-fi accents. ~24 entries → enough variation
// that nearby drops rarely repeat.
const PREFIXES: readonly string[] = [
  'Vorpal',
  'Aetheric',
  'Phantom',
  'Solar',
  'Frigid',
  'Stormbound',
  'Howling',
  'Ember',
  'Voidsteel',
  'Ironclad',
  'Resonant',
  'Searing',
  'Eclipse',
  'Tempered',
  'Wraith',
  'Crimson',
  'Spectral',
  'Plasmaforged',
  'Cinderborn',
  'Pulsewrought',
  'Cryptic',
  'Glacial',
  'Sunderstrike',
  'Nightveil',
];

// Genitive-flavoured suffixes. Each one is added as " of <suffix>" so
// the entries here drop the leading "of" — the formatter adds it.
const SUFFIXES: readonly string[] = [
  'Storms',
  'the Wolverine',
  'Conduction',
  'Vengeance',
  'Rending',
  'Flux',
  'Burning',
  'the Pack',
  'Eclipse',
  'Resonance',
  'Sundering',
  'the Forge',
  'Solar Wind',
  'the Void',
  'Quickening',
  'Embers',
  'the Heretic',
  'Ash',
  'the Crater',
  'Rust',
  'the Long Watch',
  'Reckoning',
  'the Static',
  'Thunder',
];

// Stable string hash. 32-bit djb2 — collisions don't matter, we only
// need it to spread inputs across the pools deterministically.
function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export function nameFlavor(seed: string): {
  prefix: string;
  suffix: string;
} {
  const h = hashSeed(seed);
  return {
    prefix: PREFIXES[h % PREFIXES.length],
    // Bit-shift so the suffix index doesn't lock-step with the prefix.
    suffix: SUFFIXES[(h >>> 11) % SUFFIXES.length],
  };
}

// `[Prefix] [core] of [Suffix]` — wraps a base noun with deterministic
// flavor for an at-a-glance "this is a unique-looking drop" feel.
export function flavoredItemName(seed: string, core: string): string {
  const { prefix, suffix } = nameFlavor(seed);
  return `${prefix} ${core} of ${suffix}`;
}
