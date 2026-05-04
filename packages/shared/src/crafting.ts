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

import {
  addAmmo,
  addAttachment,
  addConsumable,
  addPlaceable,
  addWeapon,
  consumeAmmo,
  consumeMaterial,
  consumeWeapons,
  countAmmo,
  countMaterial,
  countWeapons,
  makeWeapon,
  rollAttachmentInstance,
  type AmmoKind,
  type ConsumableKind,
  type Inventory,
  type InventorySlot,
  type MaterialKind,
  type WeaponKind,
} from './inventory';
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
  | { kind: 'attachment'; defId: string; count: number }
  | { kind: 'consumable'; consumableId: ConsumableKind; count: number };

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
  storage_chest: {
    id: 'storage_chest',
    name: 'Storage Chest',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 15 },
      // Wire is now common-tier (drops from chasers + drones + swarmers
      // post-rebalance), so a brand-new player can craft a chest after
      // a single early dungeon clear instead of needing armored loot.
      { kind: 'material', materialId: 'wire', count: 6 },
    ],
    output: { kind: 'placeable', buildingKind: 'storage_chest', count: 1 },
    // Hand-craftable — no station required so a brand-new player
    // can drop one immediately on landing.
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
  medkit: {
    id: 'medkit',
    name: 'Medkit (1)',
    inputs: [
      { kind: 'material', materialId: 'biotic', count: 2 },
      { kind: 'material', materialId: 'wire', count: 1 },
    ],
    output: { kind: 'consumable', consumableId: 'medkit', count: 1 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 8_000,
  },
  medkit_lg: {
    id: 'medkit_lg',
    name: 'Medkit Large (1)',
    inputs: [
      { kind: 'material', materialId: 'biotic', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 1 },
    ],
    output: { kind: 'consumable', consumableId: 'medkit_lg', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: null,
    craftTimeMs: 12_000,
  },
  medkit_xl: {
    id: 'medkit_xl',
    name: 'Medkit XL (1)',
    inputs: [
      { kind: 'material', materialId: 'biotic', count: 8 },
      { kind: 'material', materialId: 'circuit', count: 2 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'consumable', consumableId: 'medkit_xl', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: null,
    craftTimeMs: 18_000,
  },
  stim: {
    id: 'stim',
    name: 'Stim (1)',
    inputs: [
      { kind: 'material', materialId: 'biotic', count: 3 },
      { kind: 'material', materialId: 'circuit', count: 1 },
    ],
    output: { kind: 'consumable', consumableId: 'stim', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: null,
    craftTimeMs: 10_000,
  },
  overcharge_kit: {
    id: 'overcharge_kit',
    name: 'Overcharge Kit (1)',
    inputs: [
      { kind: 'material', materialId: 'circuit', count: 3 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'consumable', consumableId: 'overcharge_kit', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: null,
    craftTimeMs: 15_000,
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
  // Sniper / Heavy / Energy — late-game ranged. Crafted at the
  // Weapon Bench so they sit a tier above the Workbench-built
  // Pistol/SMG/Shotgun/Rifle.
  sniper: {
    id: 'sniper',
    name: 'Sniper Rifle',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 4 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'weapon', weaponId: 'sniper' },
    workstation: 'weapon_bench',
    blueprintId: 'bp_sniper',
    craftTimeMs: 75_000,
  },
  heavy: {
    id: 'heavy',
    name: 'Heavy Slug Cannon',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 25 },
      { kind: 'material', materialId: 'alloy', count: 10 },
      { kind: 'material', materialId: 'circuit', count: 3 },
    ],
    output: { kind: 'weapon', weaponId: 'heavy' },
    workstation: 'weapon_bench',
    blueprintId: 'bp_heavy',
    craftTimeMs: 80_000,
  },
  energy: {
    id: 'energy',
    name: 'Energy Carbine',
    inputs: [
      { kind: 'material', materialId: 'circuit', count: 8 },
      { kind: 'material', materialId: 'crystal', count: 2 },
      { kind: 'material', materialId: 'wire', count: 6 },
    ],
    output: { kind: 'weapon', weaponId: 'energy' },
    workstation: 'weapon_bench',
    blueprintId: 'bp_energy',
    craftTimeMs: 70_000,
  },
  // Ammo recipes for the new families.
  sniper_rounds: {
    id: 'sniper_rounds',
    name: 'Sniper Rounds (10)',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 2 },
      { kind: 'material', materialId: 'circuit', count: 1 },
    ],
    output: { kind: 'ammo', ammoId: 'sniper_rounds', count: 10 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 12_000,
  },
  heavy_slugs: {
    id: 'heavy_slugs',
    name: 'Heavy Slugs (12)',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 6 },
      { kind: 'material', materialId: 'alloy', count: 3 },
    ],
    output: { kind: 'ammo', ammoId: 'heavy_slugs', count: 12 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 12_000,
  },
  energy_cells: {
    id: 'energy_cells',
    name: 'Energy Cells (60)',
    inputs: [
      { kind: 'material', materialId: 'wire', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 2 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'ammo', ammoId: 'energy_cells', count: 60 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 12_000,
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
  craft_mod_compensator: {
    id: 'craft_mod_compensator',
    name: 'Compensator Mod',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 8 },
      { kind: 'material', materialId: 'wire', count: 3 },
    ],
    output: { kind: 'attachment', defId: 'mod_compensator', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_compensator',
    craftTimeMs: 30_000,
  },
  craft_mod_stabilizer: {
    id: 'craft_mod_stabilizer',
    name: 'Recoil Stabilizer Mod',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 2 },
    ],
    output: { kind: 'attachment', defId: 'mod_stabilizer', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_stabilizer',
    craftTimeMs: 30_000,
  },
  craft_mod_overclock: {
    id: 'craft_mod_overclock',
    name: 'Overclock Module',
    inputs: [
      { kind: 'material', materialId: 'circuit', count: 5 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'attachment', defId: 'mod_overclock', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_overclock',
    craftTimeMs: 30_000,
  },
  craft_mod_dampener: {
    id: 'craft_mod_dampener',
    name: 'Recoil Dampener Mod',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 5 },
      { kind: 'material', materialId: 'circuit', count: 3 },
      { kind: 'material', materialId: 'wire', count: 2 },
    ],
    output: { kind: 'attachment', defId: 'mod_dampener', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_dampener',
    craftTimeMs: 35_000,
  },
  craft_mod_armor_piercer: {
    id: 'craft_mod_armor_piercer',
    name: 'AP Core Mod',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 7 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'attachment', defId: 'mod_armor_piercer', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_armor_piercer',
    craftTimeMs: 40_000,
  },
  craft_mod_lightweight: {
    id: 'craft_mod_lightweight',
    name: 'Lightweight Frame Mod',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 3 },
      { kind: 'material', materialId: 'wire', count: 5 },
    ],
    output: { kind: 'attachment', defId: 'mod_lightweight', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_lightweight',
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

// ---------- recipe IO dispatch helpers ----------
//
// The server's craft handlers used to repeat the same N-branch if/else
// for every kind of input/output. These helpers collapse the dispatch
// into one place per phase so adding a new RecipeInput/RecipeOutput
// variant is a single edit instead of four.

// True iff the inventory holds at least the recipe input's count.
export function hasRecipeInput(inv: Inventory, input: RecipeInput): boolean {
  switch (input.kind) {
    case 'material':
      return countMaterial(inv, input.materialId) >= input.count;
    case 'ammo':
      return countAmmo(inv, input.ammoId) >= input.count;
    case 'weapon':
      return countWeapons(inv, input.weaponId) >= input.count;
  }
}

// Consume the recipe input from inventory. Caller must check
// hasRecipeInput first; this helper does not roll back partial
// consumption on failure.
export function consumeRecipeInput(inv: Inventory, input: RecipeInput): void {
  switch (input.kind) {
    case 'material':
      consumeMaterial(inv, input.materialId, input.count);
      return;
    case 'ammo':
      consumeAmmo(inv, input.ammoId, input.count);
      return;
    case 'weapon':
      consumeWeapons(inv, input.weaponId, input.count);
      return;
  }
}

// Convert a recipe output into the InventorySlot shape used by
// station output buffers. Used by the async craft job pipeline when
// depositing finished work to a station's output cells.
export function recipeOutputToSlot(out: RecipeOutput): InventorySlot {
  switch (out.kind) {
    case 'placeable':
      return { kind: 'placeable', buildingKind: out.buildingKind, count: out.count };
    case 'ammo':
      return { kind: 'ammo', ammoId: out.ammoId, count: out.count };
    case 'weapon':
      return { kind: 'weapon', weapon: makeWeapon(out.weaponId) };
    case 'attachment':
      // Roll a fresh AttachmentInstance at craft time so each craft
      // produces a unique attachment with rolled stats. count > 1
      // is interpreted by the caller as "loop and roll N times" via
      // addInventorySlotToInventory; the slot itself only carries
      // a single instance.
      return {
        kind: 'attachment',
        instance: rollAttachmentInstance(out.defId, 'Mk1'),
      };
    case 'consumable':
      return { kind: 'consumable', consumableId: out.consumableId, count: out.count };
  }
}

// Add a recipe output directly to the player's inventory. Used for
// instant crafts and as a fallback when a station's output buffer is
// saturated or the station was destroyed mid-job. Returns true on
// success; false only when the bag is full and the output couldn't fit.
export function addRecipeOutputToInventory(
  inv: Inventory,
  out: RecipeOutput
): boolean {
  switch (out.kind) {
    case 'placeable':
      return addPlaceable(inv, out.buildingKind, out.count) === 0;
    case 'ammo':
      return addAmmo(inv, out.ammoId, out.count) === 0;
    case 'weapon':
      return addWeapon(inv, makeWeapon(out.weaponId));
    case 'attachment':
      // Each craft rolls its own instance so a recipe with
      // count > 1 gives N unique attachments, not N copies.
      return addAttachment(inv, out.defId, 'Mk1', out.count);
    case 'consumable':
      return addConsumable(inv, out.consumableId, out.count);
  }
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
  bp_sniper: {
    id: 'bp_sniper',
    recipeId: 'sniper',
    displayName: 'Sniper Rifle',
    description:
      'Pinpoint accuracy, devastating per-shot damage, four-round mag. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
  },
  bp_heavy: {
    id: 'bp_heavy',
    recipeId: 'heavy',
    displayName: 'Heavy Slug Cannon',
    description:
      'Tank-buster slug. Slow projectile, slow cadence, ridiculous damage. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
  },
  bp_energy: {
    id: 'bp_energy',
    recipeId: 'energy',
    displayName: 'Energy Carbine',
    description:
      'High-cadence laser carbine. Lower per-hit damage but blinding projectile speed. Crafted at the Weapon Bench.',
    cost: 12,
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
    displayName: 'Foregrip',
    description: '-30% spread. Slots into any ranged weapon mod slot.',
    cost: 4,
    tier: 'uncommon',
  },
  bp_mod_high_velocity: {
    id: 'bp_mod_high_velocity',
    recipeId: 'craft_mod_high_velocity',
    displayName: 'High-Velocity Barrel',
    description: '+500 px/sec projectile speed. Slots into any mod slot.',
    cost: 5,
    tier: 'uncommon',
  },
  bp_mod_compensator: {
    id: 'bp_mod_compensator',
    recipeId: 'craft_mod_compensator',
    displayName: 'Compensator',
    description: '-50% spread. Tighter than a Foregrip.',
    cost: 6,
    tier: 'uncommon',
  },
  bp_mod_stabilizer: {
    id: 'bp_mod_stabilizer',
    recipeId: 'craft_mod_stabilizer',
    displayName: 'Recoil Stabilizer',
    description: '+10% damage. Heavier action, harder hits.',
    cost: 6,
    tier: 'uncommon',
  },
  bp_mod_overclock: {
    id: 'bp_mod_overclock',
    recipeId: 'craft_mod_overclock',
    displayName: 'Overclock Module',
    description: '+18% fire rate. Burns through ammo faster.',
    cost: 7,
    tier: 'rare',
  },
  bp_mod_dampener: {
    id: 'bp_mod_dampener',
    recipeId: 'craft_mod_dampener',
    displayName: 'Recoil Dampener',
    description: '-25% spread, +150 px/sec projectile speed.',
    cost: 7,
    tier: 'rare',
  },
  bp_mod_armor_piercer: {
    id: 'bp_mod_armor_piercer',
    recipeId: 'craft_mod_armor_piercer',
    displayName: 'AP Core',
    description: '+18% damage. Engineered for armoured targets.',
    cost: 8,
    tier: 'rare',
  },
  bp_mod_lightweight: {
    id: 'bp_mod_lightweight',
    recipeId: 'craft_mod_lightweight',
    displayName: 'Lightweight Frame',
    description: '+10% fire rate, -10% damage. Faster trigger, weaker rounds.',
    cost: 5,
    tier: 'uncommon',
  },
  bp_aff_damage_15: {
    id: 'bp_aff_damage_15',
    recipeId: 'craft_aff_damage_15',
    displayName: 'Reinforced Frame',
    description: '+15% damage on every shot. Slots into a weapon frame.',
    cost: 6,
    tier: 'rare',
  },
  bp_aff_firerate_25: {
    id: 'bp_aff_firerate_25',
    recipeId: 'craft_aff_firerate_25',
    displayName: 'Lightweight Grip',
    description: '25% faster cadence. Slots into a weapon grip.',
    cost: 6,
    tier: 'rare',
  },
  bp_aff_shield_25: {
    id: 'bp_aff_shield_25',
    recipeId: 'craft_aff_shield_25',
    displayName: 'Hardened Plating',
    description: '+25 max shield. Slots into a suit plating piece.',
    cost: 5,
    tier: 'uncommon',
  },
  bp_aff_speed_5: {
    id: 'bp_aff_speed_5',
    recipeId: 'craft_aff_speed_5',
    displayName: 'Servomotor Tune',
    description: '+5% movement speed. Slots into a suit utility mod.',
    cost: 5,
    tier: 'uncommon',
  },
};

// Blueprint label for the uplink shop. Bare noun — blueprints are
// recipes for stable, repeatable items, so flavor wrapping there
// would be misleading ("buy a different Vorpal Pistol of Storms each
// time?"). The crafted weapon's name comes from weaponDisplayName,
// which composes from family + tier + attached mods.
export function blueprintDisplayName(bp: BlueprintCatalogEntry): string {
  return bp.displayName;
}

export function listBlueprints(): BlueprintCatalogEntry[] {
  return Object.values(BLUEPRINT_CATALOG);
}

// ---------- salvage ----------
//
// Find a recipe whose output matches the given attachment defId or
// weapon id. Used by salvage to compute the refund. Returns null if
// there's no recipe (manually-spawned content, debug items).
export function findRecipeForAttachmentDefId(defId: string): Recipe | null {
  for (const r of Object.values(RECIPES)) {
    if (r.output.kind === 'attachment' && r.output.defId === defId) return r;
  }
  return null;
}

export function findRecipeForWeapon(weaponId: WeaponKind): Recipe | null {
  for (const r of Object.values(RECIPES)) {
    if (r.output.kind === 'weapon' && r.output.weaponId === weaponId) return r;
  }
  return null;
}

// Compute the salvage refund from a single inventory slot. Default
// yield is 20%; suit affixes that grant `salvage_yield_pct` push it
// up. Returns the refunded slots (always 'material' / 'ammo' kinds —
// the original inputs we'd reverse-engineer back). Undefined input
// kinds yield nothing.
export function salvageRefund(
  slot: InventorySlot,
  yieldPct: number = 0.20
): InventorySlot[] {
  let recipe: Recipe | null = null;
  if (slot.kind === 'attachment') {
    recipe = findRecipeForAttachmentDefId(slot.instance.defId);
  } else if (slot.kind === 'weapon') {
    recipe = findRecipeForWeapon(slot.weapon.weaponId);
  } else if (slot.kind === 'placeable') {
    // Placeables salvage back into building recipe inputs too.
    for (const r of Object.values(RECIPES)) {
      if (
        r.output.kind === 'placeable' &&
        r.output.buildingKind === slot.buildingKind
      ) {
        recipe = r;
        break;
      }
    }
  }
  if (!recipe) return [];

  const refunds: InventorySlot[] = [];
  for (const input of recipe.inputs) {
    if (input.kind !== 'material' && input.kind !== 'ammo') continue;
    const refund = Math.floor(input.count * yieldPct);
    if (refund <= 0) continue;
    if (input.kind === 'material') {
      refunds.push({
        kind: 'material',
        materialId: input.materialId,
        count: refund,
      });
    } else if (input.kind === 'ammo') {
      refunds.push({
        kind: 'ammo',
        ammoId: input.ammoId,
        count: refund,
      });
    }
  }
  return refunds;
}
