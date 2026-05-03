// Combat constants. Tuning lives here so balance changes are one-place.

import type { AmmoKind, BuildingKind, WeaponFamily } from '@dumrunner/shared';

// Per-family stat sheet for ranged weapons. SMG = high RoF, low dmg; shotgun
// = burst pellets, short range; rifle = single high-dmg slug; pistol = the
// balanced baseline. `pelletCount > 1` means a single trigger pull spawns
// multiple projectiles within `spreadRad` radians of the aim line.
export type RangedWeaponStats = {
  damage: number;
  fireIntervalMs: number;
  projectileSpeed: number;
  projectileTtlMs: number;
  projectileRadius: number;
  pelletCount: number;
  // Pellet pattern spread (per-pellet for shotguns); not affected by
  // accuracy. Single-pellet weapons leave this 0.
  spreadRad: number;
  color: number;
  ammoKind: AmmoKind;
  // Accuracy [0..1]. 1.0 = perfectly on the aim ray. Lower values
  // sample a uniform angle offset from [-(1-acc) * MAX_INACC_RAD,
  // +(1-acc) * MAX_INACC_RAD] and rotate the aim direction by it on
  // each fire. Independent of `spreadRad` (pellet pattern), so a
  // shotgun can have wide pellets AND tight aim, or vice-versa.
  accuracy: number;
  // Magazine size: how many shots a fresh weapon holds before needing
  // a reload. Reserve ammo lives in inventory and is only consumed
  // during reload, not per-shot.
  magazineSize: number;
  // Time-to-reload in ms. Locks fire while in progress.
  reloadMs: number;
};

// Maximum half-cone (in radians) when accuracy = 0. Roughly ±4°.
export const MAX_INACCURACY_RAD = 0.07;

export const WEAPON_STATS: Record<
  Exclude<WeaponFamily, 'melee'>,
  RangedWeaponStats
> = {
  pistol: {
    damage: 25,
    fireIntervalMs: 250,
    projectileSpeed: 2250,
    projectileTtlMs: 800,
    projectileRadius: 4,
    pelletCount: 1,
    spreadRad: 0,
    color: 0xfafafa,
    ammoKind: 'pistol_basic',
    accuracy: 0.95,
    magazineSize: 12,
    reloadMs: 1200,
  },
  smg: {
    damage: 12,
    fireIntervalMs: 90,
    projectileSpeed: 2200,
    projectileTtlMs: 700,
    projectileRadius: 3,
    pelletCount: 1,
    spreadRad: 0.07,
    color: 0xffe066,
    ammoKind: 'smg_basic',
    accuracy: 0.78,
    magazineSize: 30,
    reloadMs: 1600,
  },
  shotgun: {
    damage: 14, // per pellet; 6 pellets ≈ 84 dmg burst at point-blank
    fireIntervalMs: 700,
    projectileSpeed: 1900,
    projectileTtlMs: 350,
    projectileRadius: 4,
    pelletCount: 6,
    spreadRad: 0.35,
    color: 0xff8a3d,
    ammoKind: 'shotgun_shells',
    accuracy: 0.92,
    magazineSize: 6,
    reloadMs: 2200,
  },
  rifle: {
    damage: 60,
    fireIntervalMs: 700,
    projectileSpeed: 2800,
    projectileTtlMs: 1200,
    projectileRadius: 4,
    pelletCount: 1,
    spreadRad: 0,
    color: 0x7dd3fc,
    ammoKind: 'rifle_rounds',
    accuracy: 0.98,
    magazineSize: 10,
    reloadMs: 1800,
  },
};

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
  // buildings.
  turret: {
    range: 380,
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
    range: 360,
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
    range: 240,
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
    range: 520,
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
  PLAYER_RADIUS: 14,
  PLAYER_MOVE_SPEED: 220,        // px/sec — must match client prediction speed
  PLAYER_INPUT_TTL_MS: 200,      // input older than this snaps back to zero
  PLAYER_BOUND: 10_000,          // hard clamp on position; world-specific later
  PLAYER_RESPAWN_MS: 3000,
  PLAYER_RESPAWN_X: 0,
  PLAYER_RESPAWN_Y: 0,

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

  LOOT_TTL_MS: 90_000,
  LOOT_PICKUP_RADIUS: 40,

  // Players can only place buildings within this many tiles of their current
  // position. Server validates; client shades the same ring.
  BUILD_RADIUS_TILES: 2,

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
