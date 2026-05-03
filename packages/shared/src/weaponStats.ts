// Per-family stat sheet for ranged weapons. Lives in shared so the
// game server reads it for simulation + the client reads it for the
// inventory tooltip; one source of truth.
//
// `pelletCount > 1` means a single trigger pull spawns multiple
// projectiles within `spreadRad` radians of the (jitter-rotated) aim
// line. `accuracy` is independent of pellet pattern: each shot's aim
// ray rotates by a uniform random angle in [-(1-acc) * MAX_INACCURACY_RAD,
// +], so a tight shotgun can still pattern wide pellets and a precise
// rifle holds the crosshair tight.

import {
  computeWeaponEffect,
  weaponFamily,
  type AmmoKind,
  type WeaponFamily,
  type WeaponItem,
} from './inventory';

export type RangedWeaponStats = {
  damage: number;
  fireIntervalMs: number;
  projectileSpeed: number;
  projectileTtlMs: number;
  projectileRadius: number;
  pelletCount: number;
  spreadRad: number;
  color: number;
  ammoKind: AmmoKind;
  // [0..1] — 1.0 holds the aim ray dead-center, 0.0 spreads to the
  // full MAX_INACCURACY_RAD half-cone.
  accuracy: number;
  magazineSize: number;
  reloadMs: number;
};

// Maximum half-cone (radians) when accuracy = 0. ~8.6° → at the
// fringes of a starter pistol every shot drifts visibly.
export const MAX_INACCURACY_RAD = 0.15;

export const WEAPON_STATS: Record<
  Exclude<WeaponFamily, 'melee'>,
  RangedWeaponStats
> = {
  // The starter pistol is intentionally slow + drifty so mods,
  // affixes, and tier-up have something to fix. Player can craft an
  // SMG / shotgun / rifle once they earn blueprints.
  pistol: {
    damage: 22,
    fireIntervalMs: 380,
    projectileSpeed: 2200,
    projectileTtlMs: 800,
    projectileRadius: 4,
    pelletCount: 1,
    spreadRad: 0,
    color: 0xfafafa,
    ammoKind: 'pistol_basic',
    accuracy: 0.65,
    magazineSize: 12,
    reloadMs: 1400,
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
    accuracy: 0.55,
    magazineSize: 30,
    reloadMs: 1700,
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
    accuracy: 0.85,
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
    accuracy: 0.96,
    magazineSize: 10,
    reloadMs: 1800,
  },
};

// Effective stats after applying piece affixes + mods. Damage,
// fireInterval, spread, and projectileSpeed scale per
// computeWeaponEffect; the remaining fields pass through unchanged.
// Returns null for melee weapons.
export type EffectiveWeaponStats = RangedWeaponStats & {
  // Convenience derived values for the tooltip.
  shotsPerSecond: number;
  // Resulting half-cone radians at the current accuracy. UI can
  // surface this in degrees if it wants.
  inaccuracyHalfRad: number;
};

export function effectiveWeaponStats(
  weapon: WeaponItem
): EffectiveWeaponStats | null {
  const family = weaponFamily(weapon.weaponId);
  if (family === 'melee') return null;
  const base = WEAPON_STATS[family];
  const eff = computeWeaponEffect(weapon);
  const fireIntervalMs = base.fireIntervalMs * eff.fireIntervalMult;
  return {
    ...base,
    damage: base.damage * eff.damageMult,
    fireIntervalMs,
    projectileSpeed: base.projectileSpeed + eff.projectileSpeedAdd,
    spreadRad: base.spreadRad * eff.spreadMult,
    shotsPerSecond: 1000 / Math.max(1, fireIntervalMs),
    inaccuracyHalfRad: (1 - base.accuracy) * MAX_INACCURACY_RAD,
  };
}
