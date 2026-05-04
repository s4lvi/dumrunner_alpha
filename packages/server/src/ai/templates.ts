import type { EnemyTemplate } from './types.js';

// Hand-authored template library. Four archetypes that exercise the schema's
// expressiveness:
//   - dummy_target  : stationary + melee → original target dummy
//   - chaser_melee  : chase + melee
//   - shooter_drone : kite + projectile
//   - brute_chaser  : chase + heavy melee + flee at low hp
//
// Procedural generation will later sample these archetypes (or derived
// configurations) per dungeon depth and biome faction.

export const TEMPLATES: Record<string, EnemyTemplate> = {
  dummy_target: {
    id: 'dummy_target',
    faction: 'neutral',
    maxHp: 100,
    radius: 18,
    moveSpeed: 0,
    senseRadius: 80,
    movement: { kind: 'stationary' },
    attacks: [
      { kind: 'melee', range: 44, damagePerSec: 30 },
    ],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 200,
    lootTable: [
      { materialId: 'scrap', chance: 1.0, min: 1, max: 2 },
    ],
    visual: { shape: 'square', color: 0xef4444, size: 18 },
  },

  chaser_melee: {
    id: 'chaser_melee',
    faction: 'catacombs',
    maxHp: 60,
    radius: 14,
    moveSpeed: 110,
    senseRadius: 420,
    movement: { kind: 'chase' },
    attacks: [
      { kind: 'melee', range: 36, damagePerSec: 25 },
    ],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 200,
    lootTable: [
      { materialId: 'scrap',    chance: 1.0,  min: 1, max: 3 },
      // Wire is heavily demanded by recipes (16 references) but only
      // dropped by drones today — chasers carry frayed cabling now too.
      { materialId: 'wire',     chance: 0.45, min: 1, max: 2 },
      { materialId: 'biotic',   chance: 0.15, min: 1, max: 1 },
      { materialId: 'artifact', chance: 0.04, min: 1, max: 1 },
      { materialId: 'key',      chance: 0.02, min: 1, max: 1 },
    ],
    visual: { shape: 'triangle', color: 0xa855f7, size: 16 },
  },

  shooter_drone: {
    id: 'shooter_drone',
    faction: 'frozen',
    maxHp: 50,
    radius: 12,
    moveSpeed: 130,
    senseRadius: 520,
    movement: { kind: 'kite', minRange: 180, maxRange: 280 },
    attacks: [
      {
        kind: 'projectile',
        range: 320,
        cooldownMs: 1200,
        projectileSpeed: 520,
        projectileDamage: 12,
        projectileTtlMs: 1200,
        projectileRadius: 5,
        projectileColor: 0x60a5fa,
      },
    ],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 250,
    // Drones are mechanical — circuits + wiring, no biotic.
    lootTable: [
      { materialId: 'scrap',    chance: 0.8,  min: 1, max: 2 },
      { materialId: 'wire',     chance: 0.85, min: 1, max: 3 },
      { materialId: 'circuit',  chance: 0.45, min: 1, max: 2 },
      { materialId: 'artifact', chance: 0.05, min: 1, max: 1 },
      { materialId: 'key',      chance: 0.04, min: 1, max: 1 },
    ],
    visual: { shape: 'circle', color: 0x60a5fa, size: 14 },
  },

  // Swarmer: low-HP, fast melee. Spawns in packs of 4-6 (procgen
  // multiplies its room weight). Solo it's trivial; the threat model is
  // the SHOTGUN bait — clusters of weak enemies that reward a wide-spread
  // weapon over a single-target pistol/rifle.
  swarmer: {
    id: 'swarmer',
    faction: 'catacombs',
    maxHp: 22,
    radius: 11,
    moveSpeed: 165,
    senseRadius: 380,
    movement: { kind: 'chase' },
    attacks: [
      { kind: 'melee', range: 30, damagePerSec: 14 },
    ],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 140,
    lootTable: [
      { materialId: 'scrap',  chance: 0.8,  min: 1, max: 2 },
      // Swarmers chew on conduit; gives the alloy/circuit-light early
      // game a wire trickle when they appear in packs.
      { materialId: 'wire',   chance: 0.30, min: 1, max: 1 },
      { materialId: 'biotic', chance: 0.2,  min: 1, max: 1 },
      { materialId: 'key',    chance: 0.02, min: 1, max: 1 },
    ],
    visual: { shape: 'triangle', color: 0xfb7185, size: 12 },
  },

  // Armored: high HP, slow, the rifle bait. Pistol/SMG sponging vs.
  // single-shot rifle clearing it in 5-6 hits.
  armored: {
    id: 'armored',
    faction: 'sun_bleached',
    maxHp: 320,
    radius: 20,
    moveSpeed: 60,
    senseRadius: 360,
    movement: { kind: 'chase' },
    attacks: [
      { kind: 'melee', range: 44, damagePerSec: 35 },
    ],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 60,
    lootTable: [
      { materialId: 'scrap',    chance: 1.0,  min: 2, max: 4 },
      { materialId: 'alloy',    chance: 0.95, min: 2, max: 4 },
      { materialId: 'circuit',  chance: 0.55, min: 1, max: 2 },
      { materialId: 'artifact', chance: 0.09, min: 1, max: 1 },
      { materialId: 'key',      chance: 0.04, min: 1, max: 1 },
    ],
    visual: { shape: 'square', color: 0x4b5563, size: 22 },
  },

  // Flame drone: kites at medium range and breathes a forward cone of
  // fire that lands a 4s burn DoT. Lower hp than a shooter drone but
  // hurts a lot more if you don't break the cone or close to melee.
  flame_drone: {
    id: 'flame_drone',
    faction: 'sun_bleached',
    maxHp: 65,
    radius: 14,
    moveSpeed: 105,
    senseRadius: 380,
    movement: { kind: 'kite', minRange: 120, maxRange: 220 },
    attacks: [
      {
        kind: 'aoe_cone',
        range: 180,
        cooldownMs: 1500,
        arcRad: 0.7,
        effectKind: 'burn_dps',
        effectMagnitude: 8,
        effectDurationMs: 4000,
        effectLabel: 'Burning',
        coneColor: 0xfb923c,
      },
    ],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 200,
    lootTable: [
      { materialId: 'scrap',    chance: 1.0,  min: 1, max: 2 },
      { materialId: 'wire',     chance: 0.55, min: 1, max: 2 },
      { materialId: 'circuit',  chance: 0.30, min: 1, max: 1 },
      { materialId: 'crystal',  chance: 0.06, min: 1, max: 1 },
      { materialId: 'artifact', chance: 0.06, min: 1, max: 1 },
    ],
    visual: { shape: 'circle', color: 0xfb923c, size: 14 },
  },

  // Chem bloater: slow tank that vomits a slow + poison cone at close
  // range. Pairs with chasers — the bloater locks you down, chasers
  // close. Drops biotic.
  chem_bloater: {
    id: 'chem_bloater',
    faction: 'catacombs',
    maxHp: 130,
    radius: 18,
    moveSpeed: 75,
    senseRadius: 320,
    movement: { kind: 'chase' },
    attacks: [
      // Up-close melee swat for when the player is hugging it.
      { kind: 'melee', range: 40, damagePerSec: 18 },
      // Cone vomit. Two effects: poison DoT + slow.
      {
        kind: 'aoe_cone',
        range: 140,
        cooldownMs: 1800,
        arcRad: 0.9,
        effectKind: 'poison_dps',
        effectMagnitude: 10,
        effectDurationMs: 5000,
        effectLabel: 'Poisoned',
        coneColor: 0x84cc16,
      },
      {
        kind: 'aoe_cone',
        range: 140,
        cooldownMs: 1800,
        arcRad: 0.9,
        effectKind: 'slow_pct',
        effectMagnitude: 0.30,
        effectDurationMs: 4000,
        effectLabel: 'Slowed',
        coneColor: 0x84cc16,
      },
    ],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 200,
    lootTable: [
      { materialId: 'scrap',    chance: 1.0,  min: 2, max: 3 },
      { materialId: 'biotic',   chance: 0.85, min: 1, max: 3 },
      { materialId: 'crystal',  chance: 0.06, min: 1, max: 1 },
      { materialId: 'artifact', chance: 0.08, min: 1, max: 1 },
    ],
    visual: { shape: 'square', color: 0x84cc16, size: 22 },
  },

  brute_chaser: {
    id: 'brute_chaser',
    faction: 'sun_bleached',
    maxHp: 180,
    radius: 22,
    moveSpeed: 70,
    senseRadius: 360,
    movement: { kind: 'chase' },
    attacks: [
      { kind: 'melee', range: 50, damagePerSec: 50 },
    ],
    fleeBelowHpRatio: 0.3,
    // Heavy armour shrugs off most stuns.
    stunDurationOnHitMs: 80,
    // Brutes drop heavy materials — alloy plate from their carapace, with a
    // small chance of a resonant crystal. Best source of artifacts in the
    // alpha (boss-tier enemies will replace this once they ship).
    lootTable: [
      { materialId: 'scrap',    chance: 1.0,  min: 2, max: 4 },
      { materialId: 'alloy',    chance: 0.85, min: 1, max: 3 },
      { materialId: 'circuit',  chance: 0.30, min: 1, max: 2 },
      { materialId: 'crystal',  chance: 0.10, min: 1, max: 1 },
      { materialId: 'artifact', chance: 0.12, min: 1, max: 1 },
      { materialId: 'key',      chance: 0.06, min: 1, max: 1 },
    ],
    visual: { shape: 'square', color: 0xb45309, size: 26 },
  },
};

// Surface is the player's base — peaceful by default. Enemies only appear
// here during perihelion hordes (mechanic lands later). Adding entries to
// this list spawns ambient enemies on the surface and is intended for
// debugging only.
export const SURFACE_SPAWNS: { templateId: string; x: number; y: number }[] = [];
