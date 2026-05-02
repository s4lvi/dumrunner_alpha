// Recipe definitions for the alpha crafting system. Each recipe consumes
// stackable inputs from the player's inventory and produces a stackable
// output. Server is authoritative — clients only display recipes and send
// craft_request { recipeId }.
//
// Adding a new recipe = one entry below. Output kinds match the slot kinds
// in inventory.ts; inputs are { material | ammo } only for now.
//
// Two gates a recipe can carry:
//   - workstation : the player must be within range of a building of this
//                   kind on the surface to craft. null = craft anywhere
//                   (basics, e.g. wall).
//   - blueprintId : the player must have learned this blueprint. null = the
//                   recipe is always known. Per-cycle blueprints wipe at
//                   perihelion; legendary blueprints persist on the
//                   character (handled at storage layer, not here).

import type { AmmoKind, MaterialKind, WeaponKind } from './inventory';
import type { BuildingKind, WorkstationKind } from './protocol';

export type RecipeInput =
  | { kind: 'material'; materialId: MaterialKind; count: number }
  | { kind: 'ammo'; ammoId: AmmoKind; count: number }
  // "Weapon-as-component" — consumes a built weapon of the given family.
  // Powers the per-family turret variants (shotgun turret eats a shotgun).
  | { kind: 'weapon'; weaponId: WeaponKind; count: number };

export type RecipeOutput =
  | { kind: 'placeable'; buildingKind: BuildingKind; count: number }
  | { kind: 'ammo'; ammoId: AmmoKind; count: number }
  | { kind: 'weapon'; weaponId: WeaponKind }
  | { kind: 'attachment'; defId: string; count: number };

export type Recipe = {
  id: string;
  name: string;
  inputs: RecipeInput[];
  output: RecipeOutput;
  // Required workstation, or null for craft-on-person basics.
  workstation: WorkstationKind | null;
  // Required blueprint id, or null if always known.
  blueprintId: string | null;
  // Async craft duration in milliseconds. 0 (or omitted) = instant — used
  // for hand-craftable basics. Station recipes set this to give the dive
  // / craft loop a real "queue and go scavenge" flow.
  craftTimeMs?: number;
};

export const RECIPES: Record<string, Recipe> = {
  // ---- Basics: craftable from inventory anywhere, no blueprint. ----
  wall: {
    id: 'wall',
    name: 'Wall',
    inputs: [{ kind: 'material', materialId: 'scrap', count: 5 }],
    output: { kind: 'placeable', buildingKind: 'wall', count: 1 },
    workstation: null,
    blueprintId: null,
  },
  workbench: {
    id: 'workbench',
    name: 'Workbench',
    inputs: [{ kind: 'material', materialId: 'scrap', count: 30 }],
    output: { kind: 'placeable', buildingKind: 'workbench', count: 1 },
    workstation: null,
    blueprintId: null,
  },

  // ---- Workbench tier: tier-2 stations + ammo. ----
  forge: {
    id: 'forge',
    name: 'Forge',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 20 },
      { kind: 'material', materialId: 'alloy', count: 8 },
    ],
    output: { kind: 'placeable', buildingKind: 'forge', count: 1 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 30_000,
  },
  electronics_bench: {
    id: 'electronics_bench',
    name: 'Electronics Bench',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 15 },
      { kind: 'material', materialId: 'wire', count: 10 },
      { kind: 'material', materialId: 'circuit', count: 4 },
    ],
    output: { kind: 'placeable', buildingKind: 'electronics_bench', count: 1 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 30_000,
  },
  weapon_bench: {
    id: 'weapon_bench',
    name: 'Weapon Bench',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 25 },
      { kind: 'material', materialId: 'alloy', count: 10 },
      { kind: 'material', materialId: 'wire', count: 6 },
    ],
    output: { kind: 'placeable', buildingKind: 'weapon_bench', count: 1 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 30_000,
  },
  artifact_uplink: {
    id: 'artifact_uplink',
    name: 'Artifact Uplink',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 30 },
      { kind: 'material', materialId: 'circuit', count: 8 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'placeable', buildingKind: 'artifact_uplink', count: 1 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 45_000,
  },
  pistol_basic_ammo: {
    id: 'pistol_basic_ammo',
    name: 'Pistol Ammo (50)',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 4 },
      { kind: 'material', materialId: 'wire', count: 1 },
    ],
    output: { kind: 'ammo', ammoId: 'pistol_basic', count: 50 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 10_000,
  },
  smg_basic_ammo: {
    id: 'smg_basic_ammo',
    name: 'SMG Ammo (75)',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 5 },
      { kind: 'material', materialId: 'wire', count: 2 },
    ],
    output: { kind: 'ammo', ammoId: 'smg_basic', count: 75 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 10_000,
  },
  shotgun_shells: {
    id: 'shotgun_shells',
    name: 'Shotgun Shells (24)',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 6 },
      { kind: 'material', materialId: 'alloy', count: 1 },
    ],
    output: { kind: 'ammo', ammoId: 'shotgun_shells', count: 24 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 10_000,
  },
  rifle_rounds: {
    id: 'rifle_rounds',
    name: 'Rifle Rounds (30)',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 4 },
      { kind: 'material', materialId: 'alloy', count: 1 },
      { kind: 'material', materialId: 'circuit', count: 1 },
    ],
    output: { kind: 'ammo', ammoId: 'rifle_rounds', count: 30 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 10_000,
  },

  // ---- Base weapon recipes (T1, craftable at the Workbench). All four
  // are gated by their blueprint; bp_pistol is the only one granted at
  // start. Higher tiers are crafted at the Weapon Bench (tier-up recipe). ----
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 12 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'weapon', weaponId: 'pistol' },
    workstation: 'workbench',
    blueprintId: 'bp_pistol',
    craftTimeMs: 30_000,
  },
  smg: {
    id: 'smg',
    name: 'SMG',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 18 },
      { kind: 'material', materialId: 'wire', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 2 },
    ],
    output: { kind: 'weapon', weaponId: 'smg' },
    workstation: 'workbench',
    blueprintId: 'bp_smg',
    craftTimeMs: 45_000,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 20 },
      { kind: 'material', materialId: 'alloy', count: 4 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'weapon', weaponId: 'shotgun' },
    workstation: 'workbench',
    blueprintId: 'bp_shotgun',
    craftTimeMs: 45_000,
  },
  rifle: {
    id: 'rifle',
    name: 'Rifle',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 22 },
      { kind: 'material', materialId: 'alloy', count: 5 },
      { kind: 'material', materialId: 'circuit', count: 4 },
    ],
    output: { kind: 'weapon', weaponId: 'rifle' },
    workstation: 'workbench',
    blueprintId: 'bp_rifle',
    craftTimeMs: 60_000,
  },

  // ---- Weapon Bench: mods + weapon affixes ----
  craft_mod_foregrip: {
    id: 'craft_mod_foregrip',
    name: 'Foregrip Mod',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'attachment', defId: 'mod_foregrip', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_foregrip',
    craftTimeMs: 25_000,
  },
  craft_mod_high_velocity: {
    id: 'craft_mod_high_velocity',
    name: 'High-Velocity Barrel Mod',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 5 },
      { kind: 'material', materialId: 'circuit', count: 3 },
    ],
    output: { kind: 'attachment', defId: 'mod_high_velocity', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_high_velocity',
    craftTimeMs: 25_000,
  },
  craft_aff_damage_15: {
    id: 'craft_aff_damage_15',
    name: 'Reinforced Frame (+15% dmg)',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 4 },
      { kind: 'material', materialId: 'wire', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 1 },
    ],
    output: { kind: 'attachment', defId: 'aff_damage_15', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_aff_damage_15',
    craftTimeMs: 30_000,
  },
  craft_aff_firerate_25: {
    id: 'craft_aff_firerate_25',
    name: 'Lightweight Grip (+25% RoF)',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 3 },
      { kind: 'material', materialId: 'wire', count: 5 },
      { kind: 'material', materialId: 'circuit', count: 1 },
    ],
    output: { kind: 'attachment', defId: 'aff_firerate_25', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_aff_firerate_25',
    craftTimeMs: 30_000,
  },

  // ---- Electronics Bench: suit affixes ----
  craft_aff_shield_25: {
    id: 'craft_aff_shield_25',
    name: 'Hardened Plating (+25 shield)',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 2 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'attachment', defId: 'aff_shield_25', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: 'bp_aff_shield_25',
    craftTimeMs: 30_000,
  },
  craft_aff_speed_5: {
    id: 'craft_aff_speed_5',
    name: 'Servomotor Tune (+5% speed)',
    inputs: [
      { kind: 'material', materialId: 'wire', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 4 },
    ],
    output: { kind: 'attachment', defId: 'aff_speed_5', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: 'bp_aff_speed_5',
    craftTimeMs: 25_000,
  },

  // ---- Electronics bench tier: blueprinted gear. ----
  turret: {
    id: 'turret',
    name: 'Auto-Turret',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 3 },
      { kind: 'material', materialId: 'wire', count: 8 },
    ],
    output: { kind: 'placeable', buildingKind: 'turret', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: 'bp_turret',
    craftTimeMs: 60_000,
  },

  // ---- Family-specific turrets (consume a built weapon as a build
  // component; turret inherits the family's shape). ----
  turret_smg: {
    id: 'turret_smg',
    name: 'SMG Turret',
    inputs: [
      { kind: 'weapon', weaponId: 'smg', count: 1 },
      { kind: 'material', materialId: 'alloy', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 2 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'placeable', buildingKind: 'turret_smg', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: 'bp_turret_smg',
    craftTimeMs: 60_000,
  },
  turret_shotgun: {
    id: 'turret_shotgun',
    name: 'Shotgun Turret',
    inputs: [
      { kind: 'weapon', weaponId: 'shotgun', count: 1 },
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 2 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'placeable', buildingKind: 'turret_shotgun', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: 'bp_turret_shotgun',
    craftTimeMs: 60_000,
  },
  turret_rifle: {
    id: 'turret_rifle',
    name: 'Rifle Turret',
    inputs: [
      { kind: 'weapon', weaponId: 'rifle', count: 1 },
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 4 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'placeable', buildingKind: 'turret_rifle', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: 'bp_turret_rifle',
    craftTimeMs: 75_000,
  },
};

export function listRecipes(): Recipe[] {
  return Object.values(RECIPES);
}

// ---------- blueprint catalog (artifact uplink trade store) ----------
//
// Source of truth for every blueprint a player can buy. Adding a new
// purchasable recipe = one entry below + one Recipe entry above with
// blueprintId set to the matching id.
//
// `cost` = number of artifacts required. `tier` is informational for now;
// higher-tier blueprints will be the persistent (legendary) ones in a
// later pass.

export type BlueprintTier = 'common' | 'uncommon' | 'rare' | 'legendary';

export type BlueprintCatalogEntry = {
  id: string;
  recipeId: string;
  displayName: string;
  description: string;
  cost: number; // in artifacts
  tier: BlueprintTier;
};

export const BLUEPRINT_CATALOG: Record<string, BlueprintCatalogEntry> = {
  bp_pistol: {
    id: 'bp_pistol',
    recipeId: 'pistol',
    displayName: 'Pistol',
    description:
      'Balanced sidearm. Crafted at the Workbench. Granted at the start of every cycle.',
    cost: 0,
    tier: 'common',
  },
  bp_smg: {
    id: 'bp_smg',
    recipeId: 'smg',
    displayName: 'SMG',
    description:
      'High rate of fire, low damage per shot. Hose down packs. Crafted at the Workbench.',
    cost: 4,
    tier: 'uncommon',
  },
  bp_shotgun: {
    id: 'bp_shotgun',
    recipeId: 'shotgun',
    displayName: 'Shotgun',
    description:
      'Six-pellet burst, short range. Devastating at point-blank. Crafted at the Workbench.',
    cost: 4,
    tier: 'uncommon',
  },
  bp_rifle: {
    id: 'bp_rifle',
    recipeId: 'rifle',
    displayName: 'Rifle',
    description:
      'High-damage long-range slug. Slow rate of fire. Crafted at the Workbench.',
    cost: 6,
    tier: 'rare',
  },
  bp_turret: {
    id: 'bp_turret',
    recipeId: 'turret',
    displayName: 'Auto-Turret',
    description: 'Builds a self-targeting defence turret. Crafted at an Electronics Bench.',
    cost: 3,
    tier: 'common',
  },
  bp_turret_smg: {
    id: 'bp_turret_smg',
    recipeId: 'turret_smg',
    displayName: 'SMG Turret',
    description:
      'High-RoF turret. Consumes a built SMG. Crafted at an Electronics Bench.',
    cost: 6,
    tier: 'uncommon',
  },
  bp_turret_shotgun: {
    id: 'bp_turret_shotgun',
    recipeId: 'turret_shotgun',
    displayName: 'Shotgun Turret',
    description:
      'Close-range pellet sweeper. Consumes a built Shotgun. Crafted at an Electronics Bench.',
    cost: 6,
    tier: 'uncommon',
  },
  bp_turret_rifle: {
    id: 'bp_turret_rifle',
    recipeId: 'turret_rifle',
    displayName: 'Rifle Turret',
    description:
      'Long-range single-shot turret. Consumes a built Rifle. Crafted at an Electronics Bench.',
    cost: 8,
    tier: 'rare',
  },
  bp_mod_foregrip: {
    id: 'bp_mod_foregrip',
    recipeId: 'craft_mod_foregrip',
    displayName: 'Mod: Foregrip',
    description: 'Weapon mod. -30% spread. Slots into any ranged weapon mod slot.',
    cost: 4,
    tier: 'uncommon',
  },
  bp_mod_high_velocity: {
    id: 'bp_mod_high_velocity',
    recipeId: 'craft_mod_high_velocity',
    displayName: 'Mod: High-Velocity Barrel',
    description: 'Weapon mod. +500 px/sec projectile speed.',
    cost: 5,
    tier: 'uncommon',
  },
  bp_aff_damage_15: {
    id: 'bp_aff_damage_15',
    recipeId: 'craft_aff_damage_15',
    displayName: 'Affix: +15% Damage (Frame)',
    description: 'Weapon affix. Reinforced frame: +15% damage.',
    cost: 6,
    tier: 'rare',
  },
  bp_aff_firerate_25: {
    id: 'bp_aff_firerate_25',
    recipeId: 'craft_aff_firerate_25',
    displayName: 'Affix: +25% Fire Rate (Grip)',
    description: 'Weapon affix. Lightweight grip: 25% faster cadence.',
    cost: 6,
    tier: 'rare',
  },
  bp_aff_shield_25: {
    id: 'bp_aff_shield_25',
    recipeId: 'craft_aff_shield_25',
    displayName: 'Affix: +25 Shield (Plating)',
    description: 'Suit affix. Hardened plating: +25 max shield.',
    cost: 5,
    tier: 'uncommon',
  },
  bp_aff_speed_5: {
    id: 'bp_aff_speed_5',
    recipeId: 'craft_aff_speed_5',
    displayName: 'Affix: +5% Speed (Utility)',
    description: 'Suit affix. Servomotor tune: +5% movement speed.',
    cost: 5,
    tier: 'uncommon',
  },
};

export function listBlueprints(): BlueprintCatalogEntry[] {
  return Object.values(BLUEPRINT_CATALOG);
}
