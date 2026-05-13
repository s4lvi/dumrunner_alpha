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
  WEAPON_FAMILY,
  type AmmoKind,
  type WeaponItem,
} from './inventory';
import type { WeaponDef } from './content/types';

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

// Per-family ranged stats. Populated at server boot from
// shared/content/weapons/*.json via setWeaponRegistry and shipped
// to clients in the welcome message. Keyed by family so multiple
// kinds in the same family share a stat sheet (today the mapping
// is 1:1, but the structure preserves the option).
export const WEAPON_STATS: Record<string, RangedWeaponStats> = {};

// Per-weapon melee stats. Mirrors the ranged WEAPON_STATS table
// shape but with the swing-specific knobs. Server reads this when
// the equipped weapon's family is 'melee'.
export type MeleeWeaponStats = {
  damage: number;
  swingIntervalMs: number;
  // Reach in pixels from the player centre. Walls / collision are
  // ignored — the swing is fire-and-forget.
  range: number;
  // Half-arc of the cone in radians. Anything in front of the
  // player whose direction-to-target dot-product clears
  // cos(arcRad) is hit.
  arcRad: number;
  // Visual tint of the swipe trail.
  color: number;
};

// Per-kind melee stats. Same population path as WEAPON_STATS —
// populated at boot from JSON, shipped to clients via welcome.
// Lookup against this should treat misses as 'unknown weapon';
// callers typically fall back to MELEE_STATS.knife when present.
export const MELEE_STATS: Record<string, MeleeWeaponStats> = {};

// Per-weapon animation library references. Populated alongside
// the stat tables in setWeaponRegistry; the FPS renderer reads
// them to drive the view-model + projectile sprite.
//   WEAPON_VIEW_ANIM[weaponId]       — FPS first-person view-model
//   WEAPON_PROJECTILE_ANIM[weaponId] — per-weapon bullet sprite
// Family fallback for projectile is handled by the renderer
// helper (resolveProjectileAnimId), not stored here.
export const WEAPON_VIEW_ANIM: Record<string, string | undefined> = {};
export const WEAPON_PROJECTILE_ANIM: Record<string, string | undefined> = {};

// Replaces every entry in the live weapon registries from a JSON
// payload. Idempotent. Drops kinds not present in the new set —
// hot-reload semantics: the JSON files are the full canonical set.
export function setWeaponRegistry(weapons: ReadonlyArray<WeaponDef>): void {
  for (const k of Object.keys(WEAPON_STATS)) delete WEAPON_STATS[k];
  for (const k of Object.keys(MELEE_STATS)) delete MELEE_STATS[k];
  for (const k of Object.keys(WEAPON_FAMILY)) delete WEAPON_FAMILY[k];
  for (const k of Object.keys(WEAPON_VIEW_ANIM)) delete WEAPON_VIEW_ANIM[k];
  for (const k of Object.keys(WEAPON_PROJECTILE_ANIM)) {
    delete WEAPON_PROJECTILE_ANIM[k];
  }
  for (const w of weapons) {
    WEAPON_FAMILY[w.id] = w.family;
    if (w.viewAnimationId) WEAPON_VIEW_ANIM[w.id] = w.viewAnimationId;
    if (w.projectileAnimationId) {
      WEAPON_PROJECTILE_ANIM[w.id] = w.projectileAnimationId;
    }
    if (w.family === 'melee' && w.melee) {
      MELEE_STATS[w.id] = { ...w.melee };
    } else if (w.ranged) {
      // Ranged is keyed by family; multiple weapon ids in the same
      // family overwrite each other today (1:1 mapping in JSON).
      const { projectile: _unused, ...stats } = w.ranged;
      WEAPON_STATS[w.family] = stats as RangedWeaponStats;
    }
  }
}

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

// Per-weapon-tier base-stat scaling. Tier-up at the Precision Mill
// previously only changed the number of attachment slots — the
// chassis itself was static. With these multipliers, each tier-up
// is *also* a chassis upgrade: more damage, faster cadence, larger
// magazine, slightly tighter shots, faster projectile.
//
// Conservative-ish: T4 is ~45% more damage than T1 at 15% faster
// cadence, +6 mag, +6% accuracy, +15% projectile speed. Spread is
// reduced inversely so tier-up tightens the shot pattern. Multi-
// plicative with attachment effects (which also scale via
// computeWeaponEffect).
function tierStatScale(tier: 1 | 2 | 3 | 4): {
  damage: number;
  fireInterval: number;
  magazineSize: number;
  accuracy: number;
  projectileSpeed: number;
  spread: number;
} {
  const step = tier - 1; // 0..3
  return {
    damage: 1 + 0.15 * step,
    fireInterval: 1 - 0.05 * step,
    magazineSize: step * 2, // additive — flat +mag per tier
    accuracy: step * 0.02, // additive — capped at 1.0 below
    projectileSpeed: 1 + 0.05 * step,
    spread: 1 - 0.05 * step,
  };
}

export function effectiveWeaponStats(
  weapon: WeaponItem
): EffectiveWeaponStats | null {
  const family = weaponFamily(weapon.weaponId);
  if (family === 'melee') return null;
  const base = WEAPON_STATS[family];
  const eff = computeWeaponEffect(weapon);
  const tier = tierStatScale(weapon.tier);
  const fireIntervalMs = base.fireIntervalMs * tier.fireInterval * eff.fireIntervalMult;
  const damage = base.damage * tier.damage * eff.damageMult;
  const projectileSpeed =
    base.projectileSpeed * tier.projectileSpeed + eff.projectileSpeedAdd;
  const spreadRad = base.spreadRad * tier.spread * eff.spreadMult;
  const accuracy = Math.min(1, base.accuracy + tier.accuracy);
  const magazineSize = base.magazineSize + tier.magazineSize;
  return {
    ...base,
    damage,
    fireIntervalMs,
    projectileSpeed,
    spreadRad,
    accuracy,
    magazineSize,
    shotsPerSecond: 1000 / Math.max(1, fireIntervalMs),
    inaccuracyHalfRad: (1 - accuracy) * MAX_INACCURACY_RAD,
  };
}
