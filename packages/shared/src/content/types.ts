// Schemas for repo-backed content data (biomes, enemies, props,
// and any later-added domains). Each type is exported as both a
// Zod schema (runtime validation at the API boundary + at server
// boot) and an inferred TS type.
//
// File layout: one file per entity under
// packages/shared/content/<area>/<id>.json. The `id` field of
// every entity must match its filename slug — the server-side
// loader (lands with E3.0 too) cross-checks this on boot.

import { z } from 'zod';

// ---------- shared building blocks ----------

// Stable identifier slug. Used as filename + cross-references.
const idSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9_-]+$/,
    'lowercase id; alphanumeric, underscore, or hyphen only',
  );

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '6-digit hex colour with leading #');

// Per-projectile spec used by ranged AI templates. Mirrors the
// runtime ProjectileState fields the server needs to spawn one.
export const ProjectileSpecSchema = z
  .object({
    speed: z.number().positive(),
    damage: z.number().positive(),
    ttlMs: z.number().positive(),
    radius: z.number().positive(),
    color: hexColorSchema,
  })
  .strict();
export type ProjectileSpec = z.infer<typeof ProjectileSpecSchema>;

// One row of a weighted loot table. Used by enemy / prop drops.
export const LootDropSchema = z
  .object({
    materialId: idSchema,
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    chance: z.number().min(0).max(1),
  })
  .strict()
  .refine((d) => d.max >= d.min, {
    message: 'max must be ≥ min',
    path: ['max'],
  });
export type LootDrop = z.infer<typeof LootDropSchema>;

// ---------- BiomeDef ----------

// World-level configuration: per-cycle band biome overrides
// and other knobs that don't fit on any single entity. The
// shallowBandBiomes map fixes the biome for specific band
// indices (band 0 = floors 0-4, band 1 = 5-9, …); any band
// not in the map falls through to the deterministic roll
// in biomes.ts.
export const WorldDefSchema = z
  .object({
    // Map of band-index → biome id. Use string keys because JSON
    // doesn't have integer keys; the loader parses them.
    bandBiomes: z.record(z.string().regex(/^\d+$/), idSchema),
  })
  .strict();
export type WorldDef = z.infer<typeof WorldDefSchema>;

// 'none' represents the default / hazard-less biome (e.g.
// surface base, neutral starter zone). The hazard tick system
// no-ops for this kind.
export const HazardKindSchema = z.enum([
  'none',
  'heat',
  'radiation',
  'cold',
  'toxic',
]);
export type HazardKind = z.infer<typeof HazardKindSchema>;

// Per-room hazard zone category. Procgen tags every room with one
// of these; corridors are uniformly 'corridor'. The biome's
// `hazardZoneIntensities` table resolves each category to an
// intensity multiplier on the floor's base hazard DPS.
//
//   safe     0.0    Heal/save rooms — breathers between hot zones.
//   corridor 0.4    Transit space — elevated but survivable.
//   hazard   1.0    Biome's normal hazard level.
//   extreme  2.0    Pocket rooms / boss rooms / vault chambers.
//
// Defaults applied when a biome doesn't override
// `hazardZoneIntensities`. Tunable per-biome (Alien Core might
// want safe rooms still at 0.2 because the air is permanently
// bad).
export const HazardZoneCategorySchema = z.enum([
  'safe',
  'corridor',
  'hazard',
  'extreme',
]);
export type HazardZoneCategory = z.infer<typeof HazardZoneCategorySchema>;

export const DEFAULT_HAZARD_ZONE_INTENSITIES: Record<
  HazardZoneCategory,
  number
> = {
  safe: 0,
  corridor: 0.4,
  hazard: 1,
  extreme: 2,
};

const biomePaletteSchema = z
  .object({
    floor: hexColorSchema,
    wall: hexColorSchema,
    accent: hexColorSchema,
  })
  .strict();

const biomeGenerationSchema = z
  .object({
    roomCountMin: z.number().int().positive(),
    roomCountMax: z.number().int().positive(),
    // Tiles per dim — 4 means a min 4×4 room.
    roomSizeMin: z.number().int().positive(),
    roomSizeMax: z.number().int().positive(),
    corridorWidth: z.number().int().positive(),
    // 0..1 — corridor branching probability.
    branching: z.number().min(0).max(1),
    // Densities are "fraction of walkable tiles that get one";
    // generators clamp to per-room caps.
    propDensity: z.number().min(0).max(1),
    enemyDensity: z.number().min(0).max(1),
    lootDensity: z.number().min(0).max(1),
    // Multiplier on the dominant hazard's per-tick damage.
    hazardIntensity: z.number().min(0).max(1),
    // 0..1 — fraction of non-entrance, non-stairs rooms that roll
    // as `safe` hazard zones (breather pockets). Entrance always
    // forces safe regardless of this; stairs-down always forces
    // hazard. 0 = no breather rooms; 0.3 = ~3 of 10 rooms.
    safeRoomChance: z.number().min(0).max(1).optional(),
    // 0..1 — fraction of non-special rooms that roll as `extreme`
    // (high-risk, high-reward pockets). Mutually exclusive with
    // safe; the safe roll is checked first. Boss / champion rooms
    // (band-end floors) force extreme regardless.
    extremeRoomChance: z.number().min(0).max(1).optional(),
    // Per-category intensity overrides. Sparse — any category not
    // listed falls through to DEFAULT_HAZARD_ZONE_INTENSITIES.
    // Useful for Alien Core "even safe rooms aren't really safe"
    // (lift the safe value to 0.2) or Frozen "corridors are deadly
    // exposure" (lift corridor to 0.7).
    hazardZoneIntensities: z
      .object({
        safe: z.number().min(0).optional(),
        corridor: z.number().min(0).optional(),
        hazard: z.number().min(0).optional(),
        extreme: z.number().min(0).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((g) => g.roomCountMax >= g.roomCountMin, {
    message: 'roomCountMax must be ≥ roomCountMin',
    path: ['roomCountMax'],
  })
  .refine((g) => g.roomSizeMax >= g.roomSizeMin, {
    message: 'roomSizeMax must be ≥ roomSizeMin',
    path: ['roomSizeMax'],
  });

const biomeRosterEntrySchema = z
  .object({
    // Cross-reference: an EnemyDef.id authored elsewhere.
    id: idSchema,
    weight: z.number().nonnegative(),
  })
  .strict();

const biomePropPaletteEntrySchema = z
  .object({
    // Cross-reference: a PropDef.id authored elsewhere.
    id: idSchema,
    weight: z.number().nonnegative(),
    // True = only spawn in "natural" rooms (caves / outdoor) —
    // skip industrial / vault-style rooms.
    naturalOnly: z.boolean().optional(),
    // True = legal in doorway tiles (rare; most props are not).
    allowDoorway: z.boolean().optional(),
  })
  .strict();

const biomeLootBiasEntrySchema = z
  .object({
    // Cross-reference: a MaterialKind id from the materials table.
    materialId: idSchema,
    // Multiplier on this material's roll weight in scatter loot.
    // 1.0 = neutral; 2.0 = twice as common; 0.5 = half.
    multiplier: z.number().positive(),
  })
  .strict();

const biomeTileTexturesSchema = z
  .object({
    // Texture-override ids (consumed by getOverride('biome', …)).
    // Optional — palette colours are the fallback when no per-tile
    // sprite is authored.
    floor: idSchema.optional(),
    wall: idSchema.optional(),
  })
  .strict();

export const BiomeDefSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    dominantHazard: HazardKindSchema,
    palette: biomePaletteSchema,
    generation: biomeGenerationSchema,
    enemyRoster: z.array(biomeRosterEntrySchema),
    propPalette: z.array(biomePropPaletteEntrySchema),
    lootBias: z.array(biomeLootBiasEntrySchema),
    tileTextures: biomeTileTexturesSchema.optional(),
  })
  .strict();
export type BiomeDef = z.infer<typeof BiomeDefSchema>;

// ---------- EnemyDef ----------
//
// Faithful port of server/src/ai/types.ts EnemyTemplate, with two
// editor-friendly extensions:
//   - `label` for UI display ("Brute Chaser" vs the slug id).
//   - `biomeAffinity` so the spawn picker can filter by biome.
// Numeric `color` fields in the server type become hex strings
// here (JSON-friendly).

export const FactionSchema = z.enum([
  'catacombs',
  'sun_bleached',
  'frozen',
  'alien_core',
  'neutral',
]);
export type Faction = z.infer<typeof FactionSchema>;

const enemyStatsSchema = z
  .object({
    hp: z.number().positive(),
    radius: z.number().positive(),
    // px/sec; 0 disables movement.
    moveSpeed: z.number().nonnegative(),
    // Detect any live player within this radius.
    senseRadius: z.number().nonnegative(),
  })
  .strict();

const enemyVisualSchema = z
  .object({
    shape: z.enum(['circle', 'square', 'triangle']),
    color: hexColorSchema,
    size: z.number().positive(),
  })
  .strict();

// Movement profile — what the enemy does while it has a target.
const movementStationarySchema = z
  .object({ kind: z.literal('stationary') })
  .strict();
const movementChaseSchema = z
  .object({ kind: z.literal('chase') })
  .strict();
const movementKiteSchema = z
  .object({
    kind: z.literal('kite'),
    minRange: z.number().positive(),
    maxRange: z.number().positive(),
  })
  .strict();
// (maxRange ≥ minRange invariant is enforced at the EnemyDef
// level via .superRefine below — Zod's discriminatedUnion can't
// accept a refined arm.)

export const MovementSpecSchema = z.discriminatedUnion('kind', [
  movementStationarySchema,
  movementChaseSchema,
  movementKiteSchema,
]);
export type MovementSpec = z.infer<typeof MovementSpecSchema>;

// Attack templates. An enemy carries a list of these; each is
// independently rate-gated server-side. Adding a new attack kind
// is one new arm here + a matching executor in the AI runtime.
const meleeAttackSchema = z
  .object({
    kind: z.literal('melee'),
    range: z.number().positive(),
    damagePerSec: z.number().nonnegative(),
  })
  .strict();

const projectileAttackSchema = z
  .object({
    kind: z.literal('projectile'),
    range: z.number().positive(),
    cooldownMs: z.number().nonnegative(),
    projectileSpeed: z.number().positive(),
    projectileDamage: z.number().positive(),
    projectileTtlMs: z.number().positive(),
    projectileRadius: z.number().positive(),
    projectileColor: hexColorSchema,
  })
  .strict();

export const AoeConeEffectKindSchema = z.enum([
  'burn_dps',
  'poison_dps',
  'slow_pct',
]);
export type AoeConeEffectKind = z.infer<typeof AoeConeEffectKindSchema>;

const aoeConeAttackSchema = z
  .object({
    kind: z.literal('aoe_cone'),
    range: z.number().positive(),
    cooldownMs: z.number().nonnegative(),
    // Half-arc in radians.
    arcRad: z.number().positive(),
    effectKind: AoeConeEffectKindSchema,
    effectMagnitude: z.number().nonnegative(),
    effectDurationMs: z.number().nonnegative(),
    effectLabel: z.string().min(1),
    coneColor: hexColorSchema,
  })
  .strict();

export const AttackSpecSchema = z.discriminatedUnion('kind', [
  meleeAttackSchema,
  projectileAttackSchema,
  aoeConeAttackSchema,
]);
export type AttackSpec = z.infer<typeof AttackSpecSchema>;

export const EnemyDefSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    faction: FactionSchema,
    // Cross-reference: BiomeDef.id values this enemy can spawn in.
    biomeAffinity: z.array(idSchema),
    stats: enemyStatsSchema,
    movement: MovementSpecSchema,
    attacks: z.array(AttackSpecSchema),
    // Below this HP/maxHP ratio the enemy transitions to fleeing.
    // null disables flee behaviour entirely.
    fleeBelowHpRatio: z.number().min(0).max(1).nullable(),
    // Hit-stun duration on damage. 0 = stun-immune.
    stunDurationOnHitMs: z.number().nonnegative(),
    visual: enemyVisualSchema,
    lootTable: z.array(LootDropSchema),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (
      def.movement.kind === 'kite' &&
      def.movement.maxRange < def.movement.minRange
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'movement.kite.maxRange must be ≥ minRange',
        path: ['movement', 'maxRange'],
      });
    }
  });
export type EnemyDef = z.infer<typeof EnemyDefSchema>;

// ---------- PropDef ----------

const propVisualSchema = z
  .object({
    // Optional override id; when present the renderer pulls
    // textureOverrides.getOverride('prop', textureId).
    textureId: idSchema.optional(),
    // Tint applied to procedural fallback when no texture override.
    tint: hexColorSchema.optional(),
  })
  .strict();

const propExplodeSchema = z
  .object({
    radius: z.number().positive(),
    damage: z.number().positive(),
  })
  .strict();

export const PropDefSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    biomeAffinity: z.array(idSchema),
    hp: z.number().positive(),
    // Solid props block player movement + projectiles. Non-solid
    // (grass tufts, dust clouds) are walk-through.
    solid: z.boolean(),
    onDestroy: z.enum(['nothing', 'drop_loot', 'explode']),
    explode: propExplodeSchema.optional(),
    loot: z.array(LootDropSchema).optional(),
    visual: propVisualSchema,
  })
  .strict()
  // Cross-field sanity: behaviour kind matches its required block.
  .refine((d) => d.onDestroy !== 'explode' || d.explode !== undefined, {
    message: 'onDestroy=explode requires an explode block',
    path: ['explode'],
  })
  .refine(
    (d) => d.onDestroy !== 'drop_loot' || (d.loot && d.loot.length > 0),
    {
      message: 'onDestroy=drop_loot requires a non-empty loot table',
      path: ['loot'],
    },
  );
export type PropDef = z.infer<typeof PropDefSchema>;
