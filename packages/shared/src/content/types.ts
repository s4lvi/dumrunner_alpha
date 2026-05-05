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

export const HazardKindSchema = z.enum([
  'heat',
  'radiation',
  'cold',
  'toxic',
]);
export type HazardKind = z.infer<typeof HazardKindSchema>;

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
    contactDamage: z.number().nonnegative(),
    // px/sec.
    moveSpeed: z.number().nonnegative(),
    aggroRadius: z.number().nonnegative(),
    deaggroRadius: z.number().nonnegative(),
    bodyRadius: z.number().positive(),
  })
  .strict();

const enemyVisualSchema = z
  .object({
    // Procedural-shape fallback when no texture override exists.
    // Same triple `EnemyVisual` already uses in shared/visuals.ts.
    shape: z.enum(['circle', 'square', 'triangle']),
    color: hexColorSchema,
    size: z.number().positive(),
  })
  .strict();

const enemyLootSchema = z
  .object({
    materialDrops: z.array(LootDropSchema).optional(),
    partDropChance: z.number().min(0).max(1).optional(),
    blueprintDropChance: z.number().min(0).max(1).optional(),
  })
  .strict();

// AI behaviour templates. Each template owns its own parameter
// shape; the server picks an executor per `kind`. Adding a new
// template is "add a literal arm here + a server-side handler" —
// no changes to the editor's other AI types.
const aiChaserMeleeSchema = z
  .object({
    kind: z.literal('chaser_melee'),
    attackInterval: z.number().positive(),
    meleeRange: z.number().positive(),
  })
  .strict();

const aiRangedPulserSchema = z
  .object({
    kind: z.literal('ranged_pulser'),
    attackInterval: z.number().positive(),
    preferredRange: z
      .object({
        min: z.number().positive(),
        max: z.number().positive(),
      })
      .strict()
      .refine((r) => r.max >= r.min, {
        message: 'preferredRange.max must be ≥ preferredRange.min',
        path: ['max'],
      }),
    projectile: ProjectileSpecSchema,
  })
  .strict();

const aiSwarmerSchema = z
  .object({
    kind: z.literal('swarmer'),
    // 0..1 — tendency to commit to a target rather than wander.
    aggression: z.number().min(0).max(1),
    // 0..1 — how long a swarmer keeps chasing once committed.
    chaseStickiness: z.number().min(0).max(1),
  })
  .strict();

const aiBruteSchema = z
  .object({
    kind: z.literal('brute'),
    chargeWindupMs: z.number().nonnegative(),
    chargeDamage: z.number().positive(),
    chargeRange: z.number().positive(),
  })
  .strict();

const aiSniperSchema = z
  .object({
    kind: z.literal('sniper'),
    attackInterval: z.number().positive(),
    // Below this HP fraction, kite away from the player.
    retreatBelowHpRatio: z.number().min(0).max(1),
    projectile: ProjectileSpecSchema,
  })
  .strict();

export const AiSpecSchema = z.discriminatedUnion('kind', [
  aiChaserMeleeSchema,
  aiRangedPulserSchema,
  aiSwarmerSchema,
  aiBruteSchema,
  aiSniperSchema,
]);
export type AiSpec = z.infer<typeof AiSpecSchema>;

export const EnemyDefSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    faction: FactionSchema,
    // Cross-reference: BiomeDef.id values this enemy can spawn in.
    biomeAffinity: z.array(idSchema),
    stats: enemyStatsSchema,
    ai: AiSpecSchema,
    visual: enemyVisualSchema,
    loot: enemyLootSchema,
  })
  .strict();
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
