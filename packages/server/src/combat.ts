// Combat constants. Tuning lives here so balance changes are one-place.

import type { BuildingKind } from '@dumrunner/shared';

// RangedWeaponStats / WEAPON_STATS / MAX_INACCURACY_RAD now live in
// `@dumrunner/shared/weaponStats` so the inventory tooltip can read
// them. Re-exported here for callers that already imported from
// `./combat`.
export {
  MAX_INACCURACY_RAD,
  WEAPON_STATS,
  MELEE_STATS,
  effectiveWeaponStats,
  type RangedWeaponStats,
  type MeleeWeaponStats,
} from '@dumrunner/shared';

// Per-turret-kind firing profile. The base 'turret' is the pistol-tier
// auto-turret (legacy stats); the family variants pull from the same
// per-family stat sheet the player's gun uses, slightly slower and
// lower-damage so a turret is never strictly better than the equivalent
// player weapon. `range` is the targeting/projectile reach.
export type TurretStats = {
  range: number;
  damage: number;
  fireIntervalMs: number;
  projectileSpeed: number;
  projectileTtlMs: number;
  projectileRadius: number;
  pelletCount: number;
  spreadRad: number;
  color: number;
};

export const TURRET_VARIANTS: Partial<Record<BuildingKind, TurretStats>> = {
  // Original auto-turret. Kept for backward compat with already-placed
  // buildings. Range bumped from 380 → 520 so it actually engages
  // horde waves: enemies spawn at radius 700 from the world origin
  // and need to walk into range. The previous range left the player
  // watching their turret stand silent through most of perihelion.
  turret: {
    range: 520,
    damage: 18,
    fireIntervalMs: 750,
    projectileSpeed: 700,
    projectileTtlMs: 1500,
    projectileRadius: 4,
    pelletCount: 1,
    spreadRad: 0,
    color: 0x66ddff,
  },
  turret_smg: {
    range: 480,
    damage: 9,
    fireIntervalMs: 130,
    projectileSpeed: 1500,
    projectileTtlMs: 700,
    projectileRadius: 3,
    pelletCount: 1,
    spreadRad: 0.07,
    color: 0xfde68a,
  },
  turret_shotgun: {
    range: 320,
    damage: 11,
    fireIntervalMs: 1100,
    projectileSpeed: 1500,
    projectileTtlMs: 350,
    projectileRadius: 4,
    pelletCount: 6,
    spreadRad: 0.35,
    color: 0xff8a3d,
  },
  turret_rifle: {
    range: 720,
    damage: 50,
    fireIntervalMs: 1100,
    projectileSpeed: 2400,
    projectileTtlMs: 1200,
    projectileRadius: 4,
    pelletCount: 1,
    spreadRad: 0,
    color: 0x7dd3fc,
  },
};

export const COMBAT = {
  TICK_HZ: 20,
  TICK_MS: 50,

  PLAYER_MAX_HP: 100,
  // 10 px on a 32-px tile leaves 6 px margin each side in a
  // single-tile corridor — wide enough that the circle-vs-AABB
  // check doesn't hang up on sub-pixel jitter at the wall edges.
  // Was 14 (only 2 px of margin), which felt sticky.
  PLAYER_RADIUS: 10,
  // 140 px/sec ≈ 4.4 tiles/sec at TILE_SIZE=32. Tuned for the
  // FPS view after walls were resized to cubes — at the previous
  // 220 px/sec the camera read as too fast against the now-square
  // wall faces. Server is authoritative; client prediction (in
  // pixi.ts) reads this same constant.
  PLAYER_MOVE_SPEED: 140,        // px/sec — must match client prediction speed
  PLAYER_INPUT_TTL_MS: 200,      // input older than this snaps back to zero
  PLAYER_BOUND: 10_000,          // hard clamp on position; world-specific later
  PLAYER_RESPAWN_MS: 3000,
  PLAYER_RESPAWN_X: 0,
  PLAYER_RESPAWN_Y: 0,

  // Max floor-height delta the player can climb in one step
  // (world units; one tile = 32 wu, one wall = 32 wu). Anything
  // taller is treated as a wall — the platform's perimeter
  // blocks the move. Step-down is unrestricted. Picked at 12 wu
  // ≈ 3/8 wall so stair risers fit comfortably under it.
  STEP_UP_MAX: 12,

  // Vertical movement (jump + crouch). Apex ≈ vz² / (2g) ≈ 25 wu
  // — just over half a wall (32 wu), enough to clear short
  // risers but not the full wall behind them. Total airtime
  // ≈ 2*vz/g = 1s; previously 1.24s read as floaty. GRAVITY in
  // wu/s² so per-tick integration uses dt in seconds.
  JUMP_VZ_INIT: 100,
  GRAVITY: 200,
  // Player vertical extents (world units). Crouching shrinks
  // the hitbox so head-height shots miss; standing eye sits at
  // mid-body for the "eye in the middle of the silhouette" look
  // that matches the standing sprite art.
  PLAYER_HEIGHT_STAND: 24,
  PLAYER_HEIGHT_CROUCH: 14,
  EYE_HEIGHT_STAND: 16,
  EYE_HEIGHT_CROUCH: 10,
  CROUCH_SPEED_MULT: 0.55,

  // Stamina / sprint
  PLAYER_MAX_STAMINA: 100,
  SPRINT_SPEED_MULTIPLIER: 1.6,
  SPRINT_DRAIN_PER_SEC: 35,
  STAMINA_REGEN_PER_SEC: 25,
  STAMINA_MIN_TO_SPRINT: 10,     // can't start sprinting below this
  // Wait this long after stamina drops to 0 OR sprint releases before regen
  // begins. Without it, holding Shift past empty produces continuous tiny
  // refills and effectively-infinite sprint.
  STAMINA_REGEN_DELAY_MS: 1500,
  STAMINA_BROADCAST_INTERVAL_MS: 200,

  // Shield (default 0; suit chassis or mods grant a non-zero pool)
  PLAYER_DEFAULT_MAX_SHIELD: 0,
  SHIELD_REGEN_DELAY_MS: 3000,   // wait after taking damage before regen starts
  SHIELD_REGEN_PER_SEC: 15,
  SHIELD_BROADCAST_INTERVAL_MS: 200,

  // Hardcoded pistol stats (will become per-weapon once parts land).
  PISTOL_DAMAGE: 25,
  PISTOL_PROJECTILE_SPEED: 2250, // px/sec
  PISTOL_PROJECTILE_TTL_MS: 800,
  PISTOL_PROJECTILE_RADIUS: 4,
  PISTOL_FIRE_INTERVAL_MS: 250, // 4 shots/sec

  // Knife: melee arc swing in front of the player.
  KNIFE_DAMAGE: 35,
  KNIFE_RANGE: 60,           // px from player center
  KNIFE_ARC_DEG: 100,        // total arc width centred on aim direction
  KNIFE_SWING_INTERVAL_MS: 400,

  // Default enemy stats — superseded by per-template values once an enemy
  // has a real archetype. Kept as fallbacks for tests / debug-spawned dummies.
  ENEMY_FALLBACK_HP: 100,
  ENEMY_FALLBACK_RADIUS: 18,

  // 180s — 90s read as too short for the deliberate tactical pacing
  // (loot vanished while players were still clearing the room).
  LOOT_TTL_MS: 180_000,
  LOOT_PICKUP_RADIUS: 28,

  // Players can only place buildings within this many tiles of their current
  // position. Server validates; client shades the same ring.
  BUILD_RADIUS_TILES: 3,

  // Day / cycle / horde clock. The GDD says cycle = 3 in-game days, ~1-2 hr
  // real-time per day. For the alpha we run 5 real minutes per day so a
  // full perihelion cycle is 15 minutes — short enough to test the loop in
  // a single sitting.
  DAY_DURATION_MS: 5 * 60 * 1000,
  DAYS_PER_CYCLE: 3,
  // The horde itself runs for this long after perihelion fires; cycle
  // resets when the horde ends.
  HORDE_DURATION_MS: 60_000,
  // Frequency at which the server broadcasts the world_clock tick. 1 Hz is
  // plenty for a countdown HUD.
  WORLD_CLOCK_INTERVAL_MS: 1000,

  // Auto-turret tuning. Turrets share the player projectile path so their
  // shots collide with enemies the same way pistol shots do.
  TURRET_RANGE: 380,
  TURRET_FIRE_INTERVAL_MS: 750,
  TURRET_DAMAGE: 18,
  TURRET_PROJECTILE_SPEED: 700,
  TURRET_PROJECTILE_TTL_MS: 1500,
  TURRET_PROJECTILE_RADIUS: 4,
  TURRET_PROJECTILE_COLOR: 0x66ddff,

  // Crafting station proximity. Player must be within this many pixels of a
  // workstation of the recipe's required kind to craft it. ~3 tiles.
  CRAFT_STATION_RANGE_PX: 96,

  // ---------- power system ----------
  // Power Link capacity = base + per-floor bonus × deepestFloorReached.
  // Base 2 means a fresh server can support 2 turrets before any depth
  // pushed; +1 per floor scales linearly so the dungeon push directly
  // fuels surface defences. Power Link destruction sets capacity to 0.
  POWER_BASE_CAPACITY: 2,
  POWER_PER_DEPTH: 1,
  // Per-consumer draw. Turrets draw 1 each; (Phase 4) each running craft
  // job also draws 1. When draw > capacity, the lowest-priority
  // consumers shut off (turrets sorted by id for determinism).
  POWER_DRAW_TURRET: 1,
  POWER_DRAW_CRAFT_JOB: 1,
} as const;

export const DUMMY_SPAWNS: { x: number; y: number }[] = [
  // Pentagon at radius 320 around origin.
  ...Array.from({ length: 5 }, (_, i) => {
    const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const r = 320;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  }),
];
