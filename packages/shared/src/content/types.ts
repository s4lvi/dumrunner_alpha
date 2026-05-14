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

// Floor generator selector. 'tunneling' = the legacy rect-rooms +
// MST/loop corridor pipeline (Catacombs / Frozen / Sun-Bleached);
// 'walker' = drunkard's-walk carve producing one organic blob with
// implicit chambers (Alien Core). Walker output skips room
// templates and locked rooms in this slice — those are
// rect-coupled and don't fit the carved-region model. New biomes
// without an explicit value default to 'tunneling'.
export const BiomeGeneratorKindSchema = z.enum(['tunneling', 'walker']);
export type BiomeGeneratorKind = z.infer<typeof BiomeGeneratorKindSchema>;

const biomeGenerationSchema = z
  .object({
    generator: BiomeGeneratorKindSchema.optional(),
    // ---- tunneling params (rect rooms + MST/loop corridors) ----
    // All optional with built-in defaults so walker biomes don't
    // need to author them. Tunneling biomes that don't set these
    // get the legacy hardcoded values: 10 rooms of 5..64 tiles,
    // 2-tile corridors, 0.25 loop chance.
    roomCountMin: z.number().int().positive().optional(),
    roomCountMax: z.number().int().positive().optional(),
    // Tiles per dim — 4 means a min 4×4 room.
    roomSizeMin: z.number().int().positive().optional(),
    roomSizeMax: z.number().int().positive().optional(),
    // Initial tunneler width in tiles. Tunnelers can step their
    // width up / down via widthChangeChance, but most corridors
    // settle around this value. 1 = thin Cogmind-style corridors,
    // 3 = wide industrial halls.
    corridorWidth: z.number().int().positive().optional(),
    // When true, every tunneler (parents + babies) keeps the
    // initial corridorWidth — no jitter on spawn, no width-change
    // rolls per step. Useful when a biome wants strictly uniform
    // corridors (e.g. a vault layout where every door fits).
    lockCorridorWidth: z.boolean().optional(),
    // 0..1 — chance per step a tunneler spawns a child tunneler
    // (a new agent at the same position with a perpendicular
    // direction). Higher = denser, more-junction maps.
    branching: z.number().min(0).max(1).optional(),
    // 0..1 — chance an eligible authored room template is used
    // for a room slot. 1 = always try template first (legacy);
    // 0 = ignore templates entirely and keep every room as a
    // procedural rect sized by roomSizeMin / roomSizeMax. Lower
    // values mix designed rooms with random rects so a biome
    // doesn't feel hand-crafted at every step.
    roomTemplateChance: z.number().min(0).max(1).optional(),
    // ---- tunneler-only knobs ----
    // Number of agents seeded at origin at the start of generation.
    // 2 produces a Cogmind-style "two-arm" map; 4 fills the floor
    // faster from all directions.
    tunnelerCount: z.number().int().positive().optional(),
    // Cap on total agent steps across the whole generation. The
    // run stops early if all agents die first; this is just a
    // fail-safe + density knob.
    tunnelerStepBudget: z.number().int().positive().optional(),
    // 0..1 per step: chance an agent rotates 90° (left or right
    // with equal probability). 0 = straight tunnels forever; 0.2
    // = jagged, lots of corners.
    turnChance: z.number().min(0).max(1).optional(),
    // 0..1 per step: chance an agent spawns a room next to its
    // current position (perpendicular to its direction). Stops
    // once roomCountMax is reached.
    roomChance: z.number().min(0).max(1).optional(),
    // 0..1 per step: chance an agent's width steps by ±1 (clamped
    // to 1..corridorWidth+2). Low values = uniform corridors;
    // high values = corridors that pinch and bulge.
    widthChangeChance: z.number().min(0).max(1).optional(),
    // 0..1 per step: chance an agent dies. The run also forces
    // agents to live until at least roomCountMin rooms exist.
    quitChance: z.number().min(0).max(1).optional(),
    // ---- walker params (drunkard's walk carve + chambers) ----
    // Cells the walker tries to carve. Higher = bigger floors.
    // 600 reads as a typical multi-room cave; 1200 is sprawling.
    walkerCellTarget: z.number().int().positive().optional(),
    // Chamber count = "rooms" the walker bulges into the carve.
    // Each chamber is a small rect placed on a carved cell, used
    // by prop / enemy density passes (corridors stay quiet).
    walkerChamberCount: z.number().int().positive().optional(),
    // Half-extent of each chamber rect in tiles. 2 = 5×5 chamber.
    walkerChamberRadius: z.number().int().positive().optional(),
    // 0..1 — chance the walker keeps its last direction this step
    // instead of rolling a fresh random one. 0 = pure random
    // (jittery, blob-shaped); 0.7 = mostly straight (long
    // corridor-like passages with the occasional turn).
    walkerMomentum: z.number().min(0).max(1).optional(),
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
  .refine(
    (g) =>
      g.roomCountMin === undefined ||
      g.roomCountMax === undefined ||
      g.roomCountMax >= g.roomCountMin,
    {
      message: 'roomCountMax must be ≥ roomCountMin',
      path: ['roomCountMax'],
    },
  )
  .refine(
    (g) =>
      g.roomSizeMin === undefined ||
      g.roomSizeMax === undefined ||
      g.roomSizeMax >= g.roomSizeMin,
    {
      message: 'roomSizeMax must be ≥ roomSizeMin',
      path: ['roomSizeMax'],
    },
  );

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

// Per-biome tile registry. Each tile carries an id (1..255 within
// the biome; 0 reserved for void), a role that determines how
// procgen treats it (floor/wall stamp pass), and the collision
// flags renderers and future server-side collision read.
//
// `textureIds` is a list of variant ids. Renderers pick one per
// cell via a stable hash so the same world+floor+cell always
// resolves to the same variant. Empty array (Phase 1 default)
// falls back through:
//   1. ('biome_wall' / 'biome_floor', `${biomeId}__${variantIdx}`)
//   2. ('biome_wall' / 'biome_floor', biomeId)         (single-texture upload)
//   3. ('building', 'wall')                             (legacy default)
//
// Reserved tile ids that procgen + renderers rely on. Each biome's
// tileSet is expected to author at least these two; if absent (or
// no tileSet at all), procgen still emits a grid using these
// constants and renderers fall through to the legacy palette-only
// path.
export const VOID_TILE_ID = 0;
export const DEFAULT_FLOOR_TILE_ID = 1;
export const DEFAULT_WALL_TILE_ID = 2;

export const TileDefSchema = z
  .object({
    id: z.number().int().min(1).max(255),
    label: z.string().min(1),
    role: z.enum(['floor', 'wall', 'door_frame', 'pillar', 'decoration']),
    walkable: z.boolean(),
    blocksLOS: z.boolean(),
    blocksProjectiles: z.boolean(),
    textureIds: z.array(idSchema).optional(),
    // Reserved for room-template tag filtering.
    tags: z.array(z.string()).optional(),
    // Reserved for weighted variant picks (skews the hash output).
    weight: z.number().nonnegative().optional(),
  })
  .strict();
export type TileDef = z.infer<typeof TileDefSchema>;

const biomeTileSetSchema = z
  .object({
    tiles: z.array(TileDefSchema),
    // Reserved for Phase 3 — symmetrical adjacency authored by
    // tag-pair, not tile-pair (per Decision 4 in the plan).
    adjacency: z
      .array(
        z
          .object({
            a: z.string().min(1),
            b: z.string().min(1),
            allowed: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .refine(
    (s) => {
      // Tile ids unique within the set.
      const ids = new Set<number>();
      for (const t of s.tiles) {
        if (ids.has(t.id)) return false;
        ids.add(t.id);
      }
      return true;
    },
    { message: 'tile ids must be unique within a biome', path: ['tiles'] },
  );

// Two flavours of biome share the same schema:
//  - dungeon (default): authored layouts with rooms, corridors,
//    hazards, etc. The procgen + dungeon scene init reads these.
//  - overworld: drives the surface scene. Rooms / hazards / tile
//    set are unused; propPalette + overworldDensity drive the
//    scattered props on the surface, palette + biome_floor /
//    biome_skybox texture overrides drive its look. Only the
//    first authored overworld biome is used (one surface per
//    server). Older biomes without `kind` are treated as dungeon.
const BiomeKindSchema = z
  .enum(['dungeon', 'overworld'])
  .default('dungeon');
export type BiomeKind = z.infer<typeof BiomeKindSchema>;

const overworldParamsSchema = z
  .object({
    // Props scattered per 100 surface tiles. 0 = none. Reasonable
    // values are 0.5..3 (sparse to dense rubble-strewn surface).
    propDensity: z.number().min(0).max(10).default(1),
  })
  .strict();

export const BiomeDefSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    kind: BiomeKindSchema,
    dominantHazard: HazardKindSchema,
    palette: biomePaletteSchema,
    generation: biomeGenerationSchema,
    enemyRoster: z.array(biomeRosterEntrySchema),
    propPalette: z.array(biomePropPaletteEntrySchema),
    lootBias: z.array(biomeLootBiasEntrySchema),
    tileTextures: biomeTileTexturesSchema.optional(),
    // E3.4 Phase 1: per-tile registry. Optional — biomes without a
    // tileSet keep the legacy palette-only render path.
    tileSet: biomeTileSetSchema.optional(),
    // FPS-renderer wall + ceiling height, in tiles (1 tile =
    // TILE_SIZE world units, square-feeling at default 1.0). 1.0
    // is the floor — going below 1 would clip standard sprites
    // (enemies / props ~1 tile tall) through the ceiling. Higher
    // values open up the room (Sun-Bleached plazas, Alien Core
    // resonant chambers). Camera/player eye level stays fixed at
    // half a standard tile — only the ceiling rises.
    // Defaults to 1.0 when omitted.
    wallHeightTiles: z.number().min(1).max(8).optional(),
    // Library references — ambient looping animations for biome
    // walls / floors / ceilings. The FPS column raycaster + floor
    // strip use these to drive the active frame. Empty = static
    // texture only.
    wallAnimationId: idSchema.optional(),
    floorAnimationId: idSchema.optional(),
    ceilingAnimationId: idSchema.optional(),
    // Only meaningful when kind === 'overworld'. Ignored otherwise.
    overworld: overworldParamsSchema.optional(),
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
    // Library reference. Empty = use the static enemy/<id> texture
    // override only. When set, the FPS renderer plays the named
    // animation's idle/walk/attack/hit/death states.
    animationId: idSchema.optional(),
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
    // FPS billboard sprite size in world units (1.0 = matches one
    // tile / wall height; 0.5 = half a wall; 2.0 = double-tall).
    // Author-tunable per prop so a barrel and a pillar can read at
    // their natural scale. Optional; the FPS renderer falls back
    // to its built-in default when omitted.
    spriteSize: z.number().positive().max(8).optional(),
    // Vertical anchor 0..1: 0 = sprite sits flush on the floor
    // (default), 1 = sprite hangs from the ceiling. Useful for
    // floating debris, hanging banners, ceiling-mounted lamps.
    spriteGroundOffset: z.number().min(0).max(1).optional(),
  })
  .strict();

const propExplodeSchema = z
  .object({
    radius: z.number().positive(),
    damage: z.number().positive(),
  })
  .strict();

// Container props are interactable raycast cubes (a la workstation
// buildings) — player presses E to open a modal of rolled contents.
// `tileWidth/Depth` set the footprint in tiles; `heightMult` scales
// the cube height (0..1 of a wall). Loot rolls from `lootTable` once
// per container instance at scene init. Distinct from
// onDestroy='drop_loot' which drops items only when the prop is
// broken — a container yields its contents on E-interact and
// persists as an open shell after.
const propContainerSchema = z
  .object({
    tileWidth: z.number().int().min(1).max(8).default(1),
    tileDepth: z.number().int().min(1).max(8).default(1),
    heightMult: z.number().min(0.1).max(1).default(0.5),
    // How many distinct loot rolls to attempt at spawn. Each roll
    // walks the lootTable and adds entries that pass their chance
    // — same shape as biome.lootBias / prop.loot. Empty
    // lootTable + rollCount > 0 produces an empty container shell.
    rollCount: z.number().int().min(0).max(32).default(3),
    lootTable: z.array(LootDropSchema),
  })
  .strict();
export type PropContainerDef = z.infer<typeof propContainerSchema>;

// ---------- RoomTemplate ----------
//
// A hand-authored room layout. Procgen picks templates from each
// biome's pool and stamps them into the floor's tile grid. Each
// template carries:
//   - a tile grid (row-major byte array of tile ids matching the
//     biome's TileDef.id values; base64-encoded so JSON files stay
//     compact for larger templates)
//   - entrySides flags marking which edges have at least one
//     corridor-connectable floor cell, so procgen can match a
//     template against a slot's connectivity needs
//   - anchors marking spawn points for enemies / props / loot /
//     interactables (extract pad, stairs, doors). Anchors are tile
//     coords relative to the template's top-left.
//   - role for pool filtering. 'normal' = main pool; 'safe' /
//     'extreme' / 'boss' / 'vault' restrict to specific slots
//     (entrance always picks 'safe'; deepest picks 'normal' or
//     'boss'; locked rooms pick 'vault').
//   - weight = relative selection probability among matches.

export const AnchorKindSchema = z.enum([
  'spawn',
  'extract',
  'stairs_down',
  'enemy',
  'prop',
  'loot',
  'door',
  // Entry: marks a cell where a corridor connects into the room.
  // Procgen reads these to determine which sides a template can
  // serve (template-local position relative to a perimeter →
  // entry side). Future work: route corridors to specific entry
  // tiles instead of just sides.
  'entry',
]);
export type AnchorKind = z.infer<typeof AnchorKindSchema>;

export const RoomEdgeSchema = z.enum(['N', 'S', 'E', 'W']);
export type RoomEdge = z.infer<typeof RoomEdgeSchema>;

export const RoomAnchorSchema = z
  .object({
    kind: AnchorKindSchema,
    // Tile coords relative to template origin (0,0 = top-left).
    tx: z.number().int().nonnegative(),
    ty: z.number().int().nonnegative(),
    // Optional override id (e.g. force a specific enemy template
    // or prop kind). Empty = roll from biome roster / palette.
    overrideId: idSchema.optional(),
  })
  .strict();
export type RoomAnchor = z.infer<typeof RoomAnchorSchema>;

export const RoomRoleSchema = z.enum([
  'normal',
  'safe',
  'extreme',
  'boss',
  'vault',
]);
export type RoomRole = z.infer<typeof RoomRoleSchema>;

// ---------- CorridorTemplate ----------
//
// Authored connector that procgen stamps between two rooms.
// Today's procgen uses hardcoded 2-tile-wide rect strips for
// every corridor; corridor templates let each biome ship its own
// width + (eventually) decorative tile patterns so spaceship
// corridors look pressurized + ribbed while cave tunnels look
// organic.
//
// Phase 1 — width-only (this slice). The procgen reads `width`
// to size the corridor strip per biome. `tilesB64` is reserved
// for a future pattern-stamping pass: a small grid that tiles
// along the corridor's length axis and lays decorative cells
// (support beams, conduit panels) on top of the strip.
export const CorridorStyleSchema = z.enum([
  'door',
  'open',
  'tunnel',
  'organic',
]);
export type CorridorStyle = z.infer<typeof CorridorStyleSchema>;

export const CorridorTemplateSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    biomeAffinity: z.array(idSchema),
    // Width perpendicular to the corridor's length axis. 1-6
    // tiles covers everything from a creep-tube to a 3-lane
    // industrial walkway.
    width: z.number().int().min(1).max(6),
    // Selection weight when picking among biome-affinity matches.
    weight: z.number().positive(),
    // Style hint for future per-edge matching (e.g. doors only at
    // room boundaries, organic only in walker biomes). Procgen
    // ignores this in the first slice; reserved.
    style: CorridorStyleSchema,
    // Optional length-axis tile pattern that repeats along the
    // corridor strip. Same encoding as room templates'
    // `tilesB64` (row-major byte array, base64). Pattern dim is
    // `width × patternLength`, where `patternLength` is derived
    // from `tilesB64.length / width` after decode. Absent =
    // plain floor strip with biome's default tiles.
    tilesB64: z.string().optional(),
    // Optional explicit pattern length when `tilesB64` is set —
    // saves clients from having to decode just to know the
    // length. Required when `tilesB64` is set.
    patternLength: z.number().int().positive().max(32).optional(),
  })
  .strict()
  .refine(
    (d) => !d.tilesB64 || d.patternLength !== undefined,
    {
      message: 'patternLength required when tilesB64 is set',
      path: ['patternLength'],
    },
  );
export type CorridorTemplate = z.infer<typeof CorridorTemplateSchema>;

export const RoomTemplateSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    biomeAffinity: z.array(idSchema),
    // Tile grid dimensions. 64-tile cap supports large arena
    // rooms; the editor canvas scales cell size down to keep
    // bigger templates manageable.
    width: z.number().int().min(3).max(64),
    height: z.number().int().min(3).max(64),
    // Row-major byte array (length = width * height) of tile ids
    // matching the biome's TileDef.id values. Encoded as base64 so
    // larger templates stay compact in JSON.
    tilesB64: z.string(),
    // Edges with at least one corridor-connectable floor cell.
    // Empty = leaf template (boss/vault), can only attach via one
    // explicit corridor entry.
    entrySides: z.array(RoomEdgeSchema),
    anchors: z.array(RoomAnchorSchema),
    role: RoomRoleSchema,
    weight: z.number().positive(),
  })
  .strict();
export type RoomTemplate = z.infer<typeof RoomTemplateSchema>;

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
    // Container props (E5): when present, the prop renders as a
    // tile-snapped raycast cube and the player can E-interact to
    // open it and pull rolled loot from a chest-style modal.
    // Mutually compatible with onDestroy — a container that's
    // broken before being opened spills its contents like any
    // drop_loot prop. Renderer swaps to ('prop_open', id) +
    // ('prop_open_top', id) textures once opened.
    container: propContainerSchema.optional(),
    visual: propVisualSchema,
    // Library reference for the prop's idle/destroy animation.
    animationId: idSchema.optional(),
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

// ---------- BuildingOverride ----------
//
// Per-BuildingKind editor-authored overrides for the otherwise
// hardcoded BUILDING_REGISTRY (shared/buildings.ts). Today this
// holds only an optional animationId; intentionally narrow so the
// existing structural metadata (HP, horde priority, station
// flags) stays in code where it shapes server behaviour. `id`
// must match a known BuildingKind at server load — entries
// referencing unknown kinds are dropped with a warning so a
// renamed kind doesn't crash boot.
export const BuildingOverrideSchema = z
  .object({
    id: idSchema,
    animationId: idSchema.optional(),
  })
  .strict();
export type BuildingOverride = z.infer<typeof BuildingOverrideSchema>;

// ---------- BlueprintDef ----------
//
// Mirrors the runtime BlueprintCatalogEntry shape (shared/crafting.ts)
// 1:1. Authoring lives here so the editor + server boot read the
// same JSON. Cross-area validation (recipeId exists, prerequisites
// resolve, DAG acyclic) runs at the API save boundary — per-file
// Zod parse only enforces shape.

export const BlueprintTierSchema = z.enum([
  'common',
  'uncommon',
  'rare',
  'legendary',
]);
export type BlueprintTier = z.infer<typeof BlueprintTierSchema>;

export const BlueprintDefSchema = z
  .object({
    id: idSchema,
    // Recipe this blueprint unlocks. Cross-checked against the
    // RECIPES table at save time.
    recipeId: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string(),
    cost: z.number().int().nonnegative(),
    tier: BlueprintTierSchema,
    // Hidden blueprints don't appear in the uplink shop or the
    // crafting modals but stay resolvable by id (legacy grants,
    // orphan-station migration). Optional — default false.
    hidden: z.boolean().optional(),
    // Other blueprint ids that must be in the player's known set
    // before this one becomes purchasable. Empty / omitted = root
    // node. Cross-validated for existence + acyclicity at save.
    prerequisites: z.array(idSchema).optional(),
  })
  .strict();
export type BlueprintDef = z.infer<typeof BlueprintDefSchema>;

// ---------- Sprite fit helpers ----------
//
// Both the editor (inline warnings) and the API route (save-time
// rejection) need to know how tall a sprite renders relative to a
// biome's ceiling. The conversions:
//
//   enemy: rendered world-height = visual.size * 2
//   prop:  rendered world-height = WALL_HEIGHT_WORLD * (spriteSize ?? 22/32)
//
// Expressed in "tile heights" (1 tile = TILE_SIZE = 32 world
// units, matching SceneLayout.tileSize), this becomes
// visual.size/16 for enemies and spriteSize for props.
//
// The biome's wallHeightTiles is also in tile heights, so the
// comparison is direct: sprite ≤ wallHeightTiles fits.

const TILE_SIZE = 32;
const PROP_DEFAULT_SPRITE_SIZE = 22 / TILE_SIZE;

export function enemySpriteHeightTiles(def: EnemyDef): number {
  return (def.visual.size * 2) / TILE_SIZE;
}

export function propSpriteHeightTiles(def: PropDef): number {
  return def.visual.spriteSize ?? PROP_DEFAULT_SPRITE_SIZE;
}

export type SpriteFitOffender = {
  kind: 'enemy' | 'prop';
  id: string;
  spriteTiles: number;
};

// Returns the list of enemyRoster / propPalette entries whose
// sprite is taller than the biome's wallHeightTiles (defaulting
// to 1 when the biome doesn't set the field). Entries whose id
// can't be resolved in the supplied registries are skipped — a
// dangling id is a separate authoring issue and is surfaced by
// the existing cross-reference validation, not by this check.
export function findSpriteFitOffenders(
  biome: BiomeDef,
  enemies: ReadonlyMap<string, EnemyDef>,
  props: ReadonlyMap<string, PropDef>,
): SpriteFitOffender[] {
  const wallH = biome.wallHeightTiles ?? 1;
  const out: SpriteFitOffender[] = [];
  for (const entry of biome.enemyRoster) {
    const def = enemies.get(entry.id);
    if (!def) continue;
    const h = enemySpriteHeightTiles(def);
    if (h > wallH) out.push({ kind: 'enemy', id: entry.id, spriteTiles: h });
  }
  for (const entry of biome.propPalette) {
    const def = props.get(entry.id);
    if (!def) continue;
    const h = propSpriteHeightTiles(def);
    if (h > wallH) out.push({ kind: 'prop', id: entry.id, spriteTiles: h });
  }
  return out;
}

// ---------- WeaponDef ----------
//
// Authored shape for one weapon kind. Captures both ranged and
// melee in a single discriminated schema; the runtime registers
// each entry into the right table (WEAPON_STATS / MELEE_STATS)
// keyed by id. Tier scaling + tier-mismatch math stay code-side
// (effectiveWeaponStats) — those are logic, not data.
//
// `family` is a fixed enum the runtime uses for ammo routing,
// mod compatibility, and turret variants. New weapons must pick
// an existing family; introducing a new family is a runtime
// change, not a data change.

export const WeaponFamilySchema = z.enum([
  'pistol',
  'smg',
  'shotgun',
  'rifle',
  'sniper',
  'heavy',
  'energy',
  'melee',
]);
export type WeaponFamilyKind = z.infer<typeof WeaponFamilySchema>;

// Bullet shape. `single` is the default round; `pellets` is the
// shotgun-style spread; `explosive` is reserved for the heavy-
// projectile pass and is not yet wired in the projectile runtime
// — authoring is allowed (the editor lights it up) but the
// server falls back to `single` behaviour until support lands.
export const ProjectileKindSchema = z.enum(['single', 'pellets', 'explosive']);
export type ProjectileKind = z.infer<typeof ProjectileKindSchema>;

const rangedStatsSchema = z
  .object({
    damage: z.number().positive(),
    fireIntervalMs: z.number().positive(),
    projectileSpeed: z.number().positive(),
    projectileTtlMs: z.number().positive(),
    projectileRadius: z.number().positive(),
    pelletCount: z.number().int().positive(),
    spreadRad: z.number().min(0),
    // Packed 0xRRGGBB. Stored as a number for cheap renderer
    // consumption; the editor offers a hex string picker that
    // translates on save.
    color: z.number().int().nonnegative(),
    ammoKind: z.string().min(1),
    accuracy: z.number().min(0).max(1),
    magazineSize: z.number().int().positive(),
    reloadMs: z.number().nonnegative(),
    projectile: z
      .object({
        kind: ProjectileKindSchema,
        // Explosive-only — radius/damage of the on-impact AoE.
        // Runtime support pending; authoring already gated to
        // explosive entries only.
        explosionRadius: z.number().positive().optional(),
        explosionDamage: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const meleeStatsSchema = z
  .object({
    damage: z.number().positive(),
    swingIntervalMs: z.number().positive(),
    // Reach in pixels from the player centre.
    range: z.number().positive(),
    // Half-arc of the cone in radians.
    arcRad: z.number().positive(),
    color: z.number().int().nonnegative(),
  })
  .strict();

export const WeaponDefSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1),
    family: WeaponFamilySchema,
    // Renderer + tooltip use this; sidebar swatch reads it too.
    color: z.number().int().nonnegative(),
    // Designer notes / tooltip body. Optional; the runtime
    // doesn't surface this anywhere player-facing today.
    description: z.string().optional(),
    // Where this weapon is crafted. Free string — must match a
    // BuildingKind on the server; the editor offers a dropdown
    // of known workstations.
    craftingStation: z.string().optional(),
    // Exactly one of these is required, gated by family. Melee
    // families set `melee`; everything else sets `ranged`. The
    // refine below enforces the pairing.
    ranged: rangedStatsSchema.optional(),
    melee: meleeStatsSchema.optional(),
    // Library references — animations from /editor/animations.
    //   viewAnimationId       FPS view-model (idle/fire/reload)
    //   projectileAnimationId Per-weapon projectile sprite. Falls
    //                         through to per-family fallback when
    //                         omitted (resolved client-side).
    viewAnimationId: idSchema.optional(),
    projectileAnimationId: idSchema.optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.family === 'melee' ? d.melee !== undefined : d.ranged !== undefined,
    {
      message:
        "ranged weapons require a `ranged` stat block; melee weapons require a `melee` stat block",
    },
  )
  .refine(
    (d) =>
      d.family === 'melee' ? d.ranged === undefined : d.melee === undefined,
    {
      message: "can't set both `ranged` and `melee` on the same weapon",
    },
  );
export type WeaponDef = z.infer<typeof WeaponDefSchema>;

// ---------- RecipeDef ----------
//
// Authored shape of one entry in the runtime RECIPES table. Inputs
// and outputs are discriminated unions; kind ids stay as loose
// strings here (MaterialKind / AmmoKind / WeaponKind / etc. are
// runtime unions and validating against them in Zod would tie the
// schema to a closed set we want to remain editable). The API
// save layer cross-validates references against the live
// registries before writing to disk.

const recipeInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('material'),
      materialId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ammo'),
      ammoId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weapon'),
      weaponId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
]);

const recipeOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('placeable'),
      buildingKind: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ammo'),
      ammoId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weapon'),
      weaponId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('attachment'),
      defId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('consumable'),
      consumableId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('material'),
      materialId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('upgrade'),
      upgradeId: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict(),
]);

export const RecipeDefSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    inputs: z.array(recipeInputSchema),
    output: recipeOutputSchema,
    // null = hand-craftable from inventory anywhere. Any string =
    // requires the named workstation kind in range.
    workstation: z.string().min(1).nullable(),
    // null = always known. Set to a blueprint id to gate.
    blueprintId: z.string().min(1).nullable(),
    // Async craft duration in milliseconds. 0 / omitted = instant.
    craftTimeMs: z.number().int().nonnegative().optional(),
    // Bench-tier requirement (1..4). Omitted = no gate.
    stationTier: z.number().int().min(1).max(4).optional(),
  })
  .strict();
export type RecipeDef = z.infer<typeof RecipeDefSchema>;

// ---------- AttachmentDef ----------
//
// Authored shape for one attachment class — these are the
// `weapon_mod` / `weapon_affix` / `suit_affix` entries that
// live in the runtime ATTACHMENT_DEFS table plus the matching
// ATTACHMENT_STAT_RANGES row. Folded into one JSON shape with
// an optional `rolls` field so a single file owns each class's
// base effect + roll variance.

const weaponEffectSchema = z
  .object({
    damageMult: z.number().optional(),
    fireIntervalMult: z.number().optional(),
    spreadMult: z.number().optional(),
    projectileSpeedAdd: z.number().optional(),
  })
  .strict();

const suitEffectSchema = z
  .object({
    hpBonus: z.number().optional(),
    shieldBonus: z.number().optional(),
    staminaMaxBonus: z.number().optional(),
    staminaRegenBonus: z.number().optional(),
    moveSpeedMult: z.number().optional(),
  })
  .strict();

// Symmetric [lo, hi] roll range. Both bounds required so the
// loader doesn't have to guess. lo > hi is allowed (the rng
// uniform handles either ordering).
const rollRange = z.tuple([z.number(), z.number()]);

const attachmentRollRangesSchema = z
  .object({
    damageMultBonus: rollRange.optional(),
    fireIntervalMultBonus: rollRange.optional(),
    spreadMultBonus: rollRange.optional(),
    projectileSpeedAddBonus: rollRange.optional(),
    hpBonusAdd: rollRange.optional(),
    shieldBonusAdd: rollRange.optional(),
    staminaMaxBonusAdd: rollRange.optional(),
    staminaRegenBonusAdd: rollRange.optional(),
    moveSpeedMultBonus: rollRange.optional(),
  })
  .strict();

const weaponFamilyOrAny = z
  .union([WeaponFamilySchema, z.null()])
  .describe('null = applies to any ranged family');

const weaponPieceKindSchema = z.enum([
  'frame',
  'grip',
  'magazine',
  'barrel',
]);

const suitSlotKindSchema = z.enum([
  'chassis',
  'plating',
  'life_support',
  'utility_mod',
  'cargo_grid',
]);

const imbueKindSchema = z.enum([
  'burn_dps',
  'poison_dps',
  'slow_pct',
]);

const weaponModImbueSchema = z
  .object({
    kind: imbueKindSchema,
    magnitude: z.number().positive(),
    durationMs: z.number().int().positive(),
    label: z.string().min(1),
  })
  .strict();

export const AttachmentDefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('weapon_mod'),
      id: idSchema,
      displayName: z.string().min(1),
      description: z.string(),
      adjective: z.string().min(1),
      family: weaponFamilyOrAny,
      effect: weaponEffectSchema,
      imbue: weaponModImbueSchema.optional(),
      rolls: attachmentRollRangesSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weapon_affix'),
      id: idSchema,
      displayName: z.string().min(1),
      description: z.string(),
      adjective: z.string().min(1),
      pieceKind: weaponPieceKindSchema,
      family: weaponFamilyOrAny,
      effect: weaponEffectSchema,
      value: z.number(),
      rolls: attachmentRollRangesSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('suit_affix'),
      id: idSchema,
      displayName: z.string().min(1),
      description: z.string(),
      adjective: z.string().min(1),
      slotKind: suitSlotKindSchema,
      effect: suitEffectSchema,
      value: z.number(),
      rolls: attachmentRollRangesSchema.optional(),
    })
    .strict(),
]);
export type AttachmentDefData = z.infer<typeof AttachmentDefSchema>;

// ---------- AnimationDef ----------
//
// Library-style animation manifest. Each manifest is a named
// asset that an entity can REFERENCE by id. The category gates
// which state names are legal — `enemy` animations carry
// idle/walk/attack/hit/death, `weapon_view` animations carry
// idle/fire/reload, etc. Authors can't type a bad state name;
// the renderer can't request one that wasn't authored.
//
// Storage: spritesheet PNGs live under `public/textures/anim/
// <animationId>/<state>.<ext>` (sheet mode) or
// `public/textures/anim/<animationId>/<state>/<frameIndex>.<ext>`
// (frames mode). Animations own their textures; entities don't.
//
// `id` is a free slug — the author chooses it. Same slug must
// equal the JSON filename (the loader enforces).

export const ANIMATION_CATEGORIES = [
  'enemy',
  'prop',
  'weapon_view',
  'projectile',
  'biome_wall',
  'biome_floor',
  'biome_ceiling',
] as const;
export const AnimationCategorySchema = z.enum(ANIMATION_CATEGORIES);
export type AnimationCategory = z.infer<typeof AnimationCategorySchema>;

// Per-category state-name allowlist. The animation editor renders
// state names as a dropdown sourced from this map, and the
// AnimationDef schema's superRefine rejects manifests with state
// keys outside the allowed set for their category. Adding a new
// state name = one entry here plus a renderer code path that
// triggers it; nothing in the editor or manifest format needs to
// learn about it explicitly.
export const STATES_BY_CATEGORY = {
  enemy: ['idle', 'walk', 'attack', 'hit', 'death'],
  prop: ['idle', 'destroy'],
  weapon_view: ['idle', 'fire', 'reload'],
  projectile: ['idle'],
  biome_wall: ['idle'],
  biome_floor: ['idle'],
  biome_ceiling: ['idle'],
} as const satisfies Record<AnimationCategory, readonly string[]>;

export function allowedStatesFor(category: AnimationCategory): readonly string[] {
  return STATES_BY_CATEGORY[category];
}

export const AnimationStateSchema = z
  .object({
    // Number of frames in this state.
    //   source = 'sheet'  → frame width = sheet.width / frames
    //   source = 'frames' → one file per frame, indexed 0..frames-1
    frames: z.number().int().positive(),
    // Effective playback rate. The editor's speed slider sets
    // this directly — no separate base × multiplier so the value
    // on disk is exactly what runs.
    fps: z.number().positive().max(120),
    // true = restart at frame 0 when the last frame ends;
    // false = stop at the last frame (or transition via `next`).
    loop: z.boolean(),
    // What to do when a non-looping animation finishes:
    //   - omitted / null      stay on the last frame (e.g. death)
    //   - 'previous'          fall back to whichever state was
    //                         playing before this one was triggered
    //                         (useful for hit / reload overlays)
    //   - <stateName>         transition to that state
    next: z.string().nullable().optional(),
    // How the per-state textures are stored on disk:
    //   - 'sheet'  (default): one PNG at <category>/<id>/<state>.<ext>,
    //                         horizontally sliced into `frames` frames.
    //   - 'frames':           one PNG per frame at
    //                         <category>/<id>/<state>/<frameIndex>.<ext>.
    //                         Use this when authoring individual cels
    //                         (asset_gen one-shot, hand-painted, etc.).
    // Omitted = 'sheet' so existing manifests keep working.
    source: z.enum(['sheet', 'frames']).optional(),
  })
  .strict();
export type AnimationState = z.infer<typeof AnimationStateSchema>;

export const AnimationDefSchema = z
  .object({
    // Author-chosen slug. Must match the JSON filename.
    id: idSchema,
    // Player-facing / editor-facing display label. Picker
    // dropdowns on entity editors show this, not the raw id.
    name: z.string().min(1),
    // Which renderer category this animation drives. Gates the
    // allowed state names via STATES_BY_CATEGORY.
    category: AnimationCategorySchema,
    // Authored states. Keys are restricted by category — see
    // `superRefine` below. Sparse coverage is fine (you can
    // author idle alone and skip hit/death).
    states: z.record(z.string().min(1), AnimationStateSchema),
  })
  .strict()
  .superRefine((d, ctx) => {
    const allowed = STATES_BY_CATEGORY[d.category];
    const allowedSet = new Set<string>(allowed);
    for (const state of Object.keys(d.states)) {
      if (!allowedSet.has(state)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `state "${state}" not allowed for category "${d.category}" (allowed: ${allowed.join(', ')})`,
          path: ['states', state],
        });
      }
    }
  });
export type AnimationDef = z.infer<typeof AnimationDefSchema>;
