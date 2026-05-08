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
  addMaterial,
  addPlaceable,
  addUpgrade,
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
  type UpgradeKind,
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
  | { kind: 'consumable'; consumableId: ConsumableKind; count: number }
  // Material output supports the Forge alloy recipes (Phase 2):
  // raw scrap-tier inputs → higher-tier alloy materials. Stack-
  // merges in the inventory like any other material drop.
  | { kind: 'material'; materialId: MaterialKind; count: number }
  // Workstation upgrade items (Phase 2.2). Crafted at the Forge,
  // consumed when applied to a target workstation building.
  | { kind: 'upgrade'; upgradeId: UpgradeKind; count: number };

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
  // Minimum bench tier required to craft, mapped against the
  // building's `benchTier` (1..4). Omitted = no tier gate (default
  // for tier-agnostic recipes like materials and basic mods).
  // Higher-tier weapons / mods set this so a Mk1 bench can't
  // crank out Mk4-only recipes.
  stationTier?: number;
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
  // Player-built openable door. Cheaper than a wall but lower
  // HP — a real defensive trade-off (you can pass through your
  // own perimeter without breaking it down). Hand-craftable so
  // a fresh player can gate a doorway from the start.
  // Reinforced wall tiers. Each tier roughly doubles HP and steps
  // up the workstation gate (workbench → electronics → forge), so
  // the player has to tech up before a stronger perimeter is in
  // reach. Recipes blueprint-gated through the E1 DAG.
  wall_mk2: {
    id: 'wall_mk2',
    name: 'Reinforced Wall',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 8 },
      { kind: 'material', materialId: 'alloy', count: 2 },
    ],
    output: { kind: 'placeable', buildingKind: 'wall_mk2', count: 1 },
    workstation: 'workbench',
    blueprintId: 'bp_wall_mk2',
    craftTimeMs: 4000,
  },
  wall_mk3: {
    id: 'wall_mk3',
    name: 'Composite Wall',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 4 },
      { kind: 'material', materialId: 'wire', count: 2 },
    ],
    output: { kind: 'placeable', buildingKind: 'wall_mk3', count: 1 },
    workstation: 'electronics_bench',
    blueprintId: 'bp_wall_mk3',
    craftTimeMs: 6000,
  },
  wall_mk4: {
    id: 'wall_mk4',
    name: 'Reactive Wall',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 2 },
    ],
    output: { kind: 'placeable', buildingKind: 'wall_mk4', count: 1 },
    workstation: 'forge',
    blueprintId: 'bp_wall_mk4',
    craftTimeMs: 9000,
  },
  wall_door: {
    id: 'wall_door',
    name: 'Door',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 8 },
      { kind: 'material', materialId: 'wire', count: 2 },
    ],
    output: { kind: 'placeable', buildingKind: 'wall_door', count: 1 },
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
  // Forge recipes — alloy production. Three tiers; output feeds
  // bench-tier upgrade items and high-tier weapon attachments.
  // The base 'forge_alloy' recipe lets a fresh player bootstrap
  // alloy without farming armored/brute kills; the higher tiers
  // are only craftable at the Forge.
  forge_alloy: {
    id: 'forge_alloy',
    name: 'Alloy Plate (1)',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 12 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'material', materialId: 'alloy', count: 1 },
    workstation: 'forge',
    blueprintId: null,
    craftTimeMs: 18_000,
  },
  forge_alloy_mk3: {
    id: 'forge_alloy_mk3',
    name: 'Refined Alloy (1)',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 2 },
    ],
    output: { kind: 'material', materialId: 'alloy_mk3', count: 1 },
    workstation: 'forge',
    blueprintId: null,
    craftTimeMs: 30_000,
  },
  forge_alloy_mk4: {
    id: 'forge_alloy_mk4',
    name: 'Precision Alloy (1)',
    inputs: [
      { kind: 'material', materialId: 'alloy_mk3', count: 4 },
      { kind: 'material', materialId: 'crystal', count: 1 },
      { kind: 'material', materialId: 'artifact', count: 1 },
    ],
    output: { kind: 'material', materialId: 'alloy_mk4', count: 1 },
    workstation: 'forge',
    blueprintId: null,
    craftTimeMs: 60_000,
  },
  // Weapon Bench upgrade items. Apply at the bench (right-click →
  // Apply) to lift it to the next tier. Each tier consumes its
  // own alloy stratum: Mk2 from base alloy, Mk3 from Refined,
  // Mk4 from Precision.
  forge_bench_upgrade_mk2: {
    id: 'forge_bench_upgrade_mk2',
    name: 'Weapon Bench Mk2 Upgrade',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 8 },
      { kind: 'material', materialId: 'circuit', count: 4 },
    ],
    output: { kind: 'upgrade', upgradeId: 'weapon_bench_mk2', count: 1 },
    workstation: 'forge',
    blueprintId: null,
    craftTimeMs: 45_000,
  },
  forge_bench_upgrade_mk3: {
    id: 'forge_bench_upgrade_mk3',
    name: 'Weapon Bench Mk3 Upgrade',
    inputs: [
      { kind: 'material', materialId: 'alloy_mk3', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 6 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'upgrade', upgradeId: 'weapon_bench_mk3', count: 1 },
    workstation: 'forge',
    blueprintId: null,
    craftTimeMs: 75_000,
  },
  forge_bench_upgrade_mk4: {
    id: 'forge_bench_upgrade_mk4',
    name: 'Weapon Bench Mk4 Upgrade',
    inputs: [
      { kind: 'material', materialId: 'alloy_mk4', count: 4 },
      { kind: 'material', materialId: 'crystal', count: 2 },
      { kind: 'material', materialId: 'artifact', count: 2 },
    ],
    output: { kind: 'upgrade', upgradeId: 'weapon_bench_mk4', count: 1 },
    workstation: 'forge',
    blueprintId: null,
    craftTimeMs: 120_000,
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
  precision_mill: {
    id: 'precision_mill',
    name: 'Precision Machining Mill',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 30 },
      { kind: 'material', materialId: 'alloy', count: 8 },
      { kind: 'material', materialId: 'circuit', count: 4 },
    ],
    output: { kind: 'placeable', buildingKind: 'precision_mill', count: 1 },
    workstation: 'workbench',
    blueprintId: null,
    craftTimeMs: 35_000,
  },
  suit_bench: {
    id: 'suit_bench',
    name: 'Suit Assembly Bench',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 25 },
      { kind: 'material', materialId: 'alloy', count: 8 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'placeable', buildingKind: 'suit_bench', count: 1 },
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
  // Sniper / Heavy / Energy — late-game ranged. All base weapons
  // craft at the Workbench (the bench split moved assembly /
  // tier-up to the Weapon Bench + Precision Mill, so all chassis
  // crafting is centralised at the Workbench for symmetry).
  // Phase 2's bench-tier upgrades will gate higher-tier
  // assembly per-bench; the chassis recipe stays at the workbench.
  sniper: {
    id: 'sniper',
    name: 'Sniper Rifle',
    inputs: [
      { kind: 'material', materialId: 'alloy', count: 6 },
      { kind: 'material', materialId: 'circuit', count: 4 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'weapon', weaponId: 'sniper' },
    workstation: 'workbench',
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
    workstation: 'workbench',
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
    workstation: 'workbench',
    blueprintId: 'bp_energy',
    craftTimeMs: 70_000,
  },
  // Melee weapons. All four melee chassis (knife / sword / hammer
  // / energy_blade) craft at the Workbench for symmetry with
  // ranged. Knife is hand-craftable so a player who loses their
  // starter never ends up melee-less.
  sword: {
    id: 'sword',
    name: 'Sword',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 12 },
      { kind: 'material', materialId: 'alloy', count: 4 },
    ],
    output: { kind: 'weapon', weaponId: 'sword' },
    workstation: 'workbench',
    blueprintId: 'bp_sword',
    craftTimeMs: 35_000,
  },
  hammer: {
    id: 'hammer',
    name: 'Hammer',
    inputs: [
      { kind: 'material', materialId: 'scrap', count: 18 },
      { kind: 'material', materialId: 'alloy', count: 8 },
    ],
    output: { kind: 'weapon', weaponId: 'hammer' },
    workstation: 'workbench',
    blueprintId: 'bp_hammer',
    craftTimeMs: 45_000,
  },
  energy_blade: {
    id: 'energy_blade',
    name: 'Energy Blade',
    inputs: [
      { kind: 'material', materialId: 'circuit', count: 6 },
      { kind: 'material', materialId: 'crystal', count: 2 },
      { kind: 'material', materialId: 'alloy', count: 4 },
    ],
    output: { kind: 'weapon', weaponId: 'energy_blade' },
    workstation: 'workbench',
    blueprintId: 'bp_energy_blade',
    craftTimeMs: 60_000,
  },
  // Knife — starter melee, hand-craftable from raw scrap so a
  // player who loses theirs (drop / death / despawn) is never
  // permanently melee-less. No blueprint required.
  knife: {
    id: 'knife',
    name: 'Knife',
    inputs: [{ kind: 'material', materialId: 'scrap', count: 6 }],
    output: { kind: 'weapon', weaponId: 'knife' },
    workstation: null,
    blueprintId: null,
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
    stationTier: 2,
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
    stationTier: 2,
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
    stationTier: 3,
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
    stationTier: 3,
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
    stationTier: 3,
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
  // Imbue mods — apply status effects on every projectile hit.
  craft_mod_incendiary: {
    id: 'craft_mod_incendiary',
    name: 'Incendiary Core',
    inputs: [
      { kind: 'material', materialId: 'biotic', count: 4 },
      { kind: 'material', materialId: 'circuit', count: 2 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'attachment', defId: 'mod_incendiary', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_incendiary',
    craftTimeMs: 50_000,
    stationTier: 4,
  },
  craft_mod_chem: {
    id: 'craft_mod_chem',
    name: 'Chem Injector',
    inputs: [
      { kind: 'material', materialId: 'biotic', count: 5 },
      { kind: 'material', materialId: 'circuit', count: 2 },
      { kind: 'material', materialId: 'crystal', count: 1 },
    ],
    output: { kind: 'attachment', defId: 'mod_chem', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_chem',
    craftTimeMs: 50_000,
    stationTier: 4,
  },
  craft_mod_cryo: {
    id: 'craft_mod_cryo',
    name: 'Cryo Coil',
    inputs: [
      { kind: 'material', materialId: 'circuit', count: 3 },
      { kind: 'material', materialId: 'crystal', count: 2 },
      { kind: 'material', materialId: 'wire', count: 4 },
    ],
    output: { kind: 'attachment', defId: 'mod_cryo', count: 1 },
    workstation: 'weapon_bench',
    blueprintId: 'bp_mod_cryo',
    craftTimeMs: 50_000,
    stationTier: 4,
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
    stationTier: 2,
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
    stationTier: 2,
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

// Materials consumed when tier-upping a weapon at the Precision
// Machining Mill. Indexed by *current* tier — TIER_UP_COSTS[1] is
// what you pay to go T1 → T2. No entry for tier 4 (cap). Lives in
// shared so the client can render the cost line in the mill modal
// alongside the Tier Up button.
export const TIER_UP_COSTS: Record<
  1 | 2 | 3,
  { materialId: MaterialKind; count: number }[]
> = {
  1: [
    { materialId: 'alloy', count: 6 },
    { materialId: 'circuit', count: 2 },
  ],
  2: [
    { materialId: 'alloy', count: 12 },
    { materialId: 'circuit', count: 5 },
    { materialId: 'crystal', count: 1 },
  ],
  3: [
    { materialId: 'alloy', count: 24 },
    { materialId: 'circuit', count: 10 },
    { materialId: 'crystal', count: 3 },
    { materialId: 'artifact', count: 2 },
  ],
};

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
    case 'material':
      return { kind: 'material', materialId: out.materialId, count: out.count };
    case 'upgrade':
      return { kind: 'upgrade', upgradeId: out.upgradeId, count: out.count };
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
    case 'material':
      return addMaterial(inv, out.materialId, out.count) === 0;
    case 'upgrade':
      return addUpgrade(inv, out.upgradeId, out.count);
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
  // When true, the blueprint is hidden from uplink listings + the
  // crafting modal but still resolvable by id. Used for orphan
  // blueprints whose station hasn't shipped yet (suit-affix mods
  // need the Suit Assembly Bench which is Phase 2.5+).
  hidden?: boolean;
  // Other blueprint ids that must already be known before this one
  // becomes available at the artifact uplink. Forms the DAG of
  // E1's progression tree. Empty / omitted = root node, available
  // from the start (subject to the cost still being paid).
  // Locked blueprints still appear in the uplink UI but greyed
  // out with their unlock conditions visible.
  prerequisites?: string[];
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
    prerequisites: ['bp_smg'],
  },
  bp_sniper: {
    id: 'bp_sniper',
    recipeId: 'sniper',
    displayName: 'Sniper Rifle',
    description:
      'Pinpoint accuracy, devastating per-shot damage, four-round mag. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
    prerequisites: ['bp_rifle'],
  },
  bp_heavy: {
    id: 'bp_heavy',
    recipeId: 'heavy',
    displayName: 'Heavy Slug Cannon',
    description:
      'Tank-buster slug. Slow projectile, slow cadence, ridiculous damage. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
    prerequisites: ['bp_rifle'],
  },
  bp_energy: {
    id: 'bp_energy',
    recipeId: 'energy',
    displayName: 'Energy Carbine',
    description:
      'High-cadence laser carbine. Lower per-hit damage but blinding projectile speed. Crafted at the Weapon Bench.',
    cost: 12,
    tier: 'rare',
    prerequisites: ['bp_mod_overclock'],
  },
  bp_sword: {
    id: 'bp_sword',
    recipeId: 'sword',
    displayName: 'Sword',
    description:
      'Wide-arc melee — clears a chaser cleanly, carries through a swarmer cluster. Crafted at the Workbench.',
    cost: 4,
    tier: 'uncommon',
  },
  bp_hammer: {
    id: 'bp_hammer',
    recipeId: 'hammer',
    displayName: 'Hammer',
    description:
      'Slow, devastating, AoE-feeling cone. Pulps brutes in two hits. Crafted at the Workbench.',
    cost: 6,
    tier: 'rare',
    prerequisites: ['bp_sword'],
  },
  bp_energy_blade: {
    id: 'bp_energy_blade',
    recipeId: 'energy_blade',
    displayName: 'Energy Blade',
    description:
      'Fast, high-damage, narrow arc. Pairs well with imbue mods — every cut chills, burns, or poisons. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
    prerequisites: ['bp_hammer'],
  },
  bp_turret: {
    id: 'bp_turret',
    recipeId: 'turret',
    displayName: 'Auto-Turret',
    description: 'Builds a self-targeting defence turret. Crafted at an Electronics Bench.',
    cost: 3,
    tier: 'common',
  },
  // Wall tier upgrades — root chain that doesn't depend on the
  // weapon tree. Each tier doubles HP and steps the workstation
  // up, so a fully-tech'd base needs every workshop online.
  bp_wall_mk2: {
    id: 'bp_wall_mk2',
    recipeId: 'wall_mk2',
    displayName: 'Reinforced Wall',
    description:
      '2x wall HP. Scrap + alloy. Crafted at the Workbench.',
    cost: 4,
    tier: 'uncommon',
  },
  bp_wall_mk3: {
    id: 'bp_wall_mk3',
    recipeId: 'wall_mk3',
    displayName: 'Composite Wall',
    description:
      '4x wall HP. Alloy + wire. Crafted at the Electronics Bench.',
    cost: 8,
    tier: 'rare',
    prerequisites: ['bp_wall_mk2'],
  },
  bp_wall_mk4: {
    id: 'bp_wall_mk4',
    recipeId: 'wall_mk4',
    displayName: 'Reactive Wall',
    description:
      '8x wall HP. Alloy + circuit. Crafted at the Forge.',
    cost: 14,
    tier: 'legendary',
    prerequisites: ['bp_wall_mk3'],
  },
  bp_turret_smg: {
    id: 'bp_turret_smg',
    recipeId: 'turret_smg',
    displayName: 'SMG Turret',
    description:
      'High-RoF turret. Consumes a built SMG. Crafted at an Electronics Bench.',
    cost: 6,
    tier: 'uncommon',
    prerequisites: ['bp_turret', 'bp_smg'],
  },
  bp_turret_shotgun: {
    id: 'bp_turret_shotgun',
    recipeId: 'turret_shotgun',
    displayName: 'Shotgun Turret',
    description:
      'Close-range pellet sweeper. Consumes a built Shotgun. Crafted at an Electronics Bench.',
    cost: 6,
    tier: 'uncommon',
    prerequisites: ['bp_turret', 'bp_shotgun'],
  },
  bp_turret_rifle: {
    id: 'bp_turret_rifle',
    recipeId: 'turret_rifle',
    displayName: 'Rifle Turret',
    description:
      'Long-range single-shot turret. Consumes a built Rifle. Crafted at an Electronics Bench.',
    cost: 8,
    tier: 'rare',
    prerequisites: ['bp_turret', 'bp_rifle'],
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
    prerequisites: ['bp_mod_foregrip'],
  },
  bp_mod_stabilizer: {
    id: 'bp_mod_stabilizer',
    recipeId: 'craft_mod_stabilizer',
    displayName: 'Recoil Stabilizer',
    description: '+10% damage. Heavier action, harder hits.',
    cost: 6,
    tier: 'uncommon',
    prerequisites: ['bp_mod_high_velocity'],
  },
  bp_mod_overclock: {
    id: 'bp_mod_overclock',
    recipeId: 'craft_mod_overclock',
    displayName: 'Overclock Module',
    description: '+18% fire rate. Burns through ammo faster.',
    cost: 7,
    tier: 'rare',
    prerequisites: ['bp_aff_firerate_25'],
  },
  bp_mod_dampener: {
    id: 'bp_mod_dampener',
    recipeId: 'craft_mod_dampener',
    displayName: 'Recoil Dampener',
    description: '-25% spread, +150 px/sec projectile speed.',
    cost: 7,
    tier: 'rare',
    prerequisites: ['bp_mod_compensator'],
  },
  bp_mod_armor_piercer: {
    id: 'bp_mod_armor_piercer',
    recipeId: 'craft_mod_armor_piercer',
    displayName: 'AP Core',
    description: '+18% damage. Engineered for armoured targets.',
    cost: 8,
    tier: 'rare',
    prerequisites: ['bp_aff_damage_15'],
  },
  bp_mod_lightweight: {
    id: 'bp_mod_lightweight',
    recipeId: 'craft_mod_lightweight',
    displayName: 'Lightweight Frame',
    description: '+10% fire rate, -10% damage. Faster trigger, weaker rounds.',
    cost: 5,
    tier: 'uncommon',
  },
  bp_mod_incendiary: {
    id: 'bp_mod_incendiary',
    recipeId: 'craft_mod_incendiary',
    displayName: 'Incendiary Core',
    description: 'Hits ignite the target — 8 dps burn for 4s. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
    prerequisites: ['bp_mod_armor_piercer'],
  },
  bp_mod_chem: {
    id: 'bp_mod_chem',
    recipeId: 'craft_mod_chem',
    displayName: 'Chem Injector',
    description: 'Hits poison the target — 10 dps for 5s. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
    prerequisites: ['bp_mod_armor_piercer'],
  },
  bp_mod_cryo: {
    id: 'bp_mod_cryo',
    recipeId: 'craft_mod_cryo',
    displayName: 'Cryo Coil',
    description: 'Hits chill the target — 35% slow for 3s. Crafted at the Weapon Bench.',
    cost: 10,
    tier: 'rare',
    prerequisites: ['bp_mod_armor_piercer'],
  },
  bp_aff_damage_15: {
    id: 'bp_aff_damage_15',
    recipeId: 'craft_aff_damage_15',
    displayName: 'Reinforced Frame',
    description: '+15% damage on every shot. Slots into a weapon frame.',
    cost: 6,
    tier: 'rare',
    prerequisites: ['bp_mod_stabilizer'],
  },
  bp_aff_firerate_25: {
    id: 'bp_aff_firerate_25',
    recipeId: 'craft_aff_firerate_25',
    displayName: 'Lightweight Grip',
    description: '25% faster cadence. Slots into a weapon grip.',
    cost: 6,
    tier: 'rare',
    prerequisites: ['bp_mod_lightweight'],
  },
  bp_aff_shield_25: {
    id: 'bp_aff_shield_25',
    recipeId: 'craft_aff_shield_25',
    displayName: 'Hardened Plating',
    description:
      '+25 max shield (rolled). Slots into a suit plating piece via the Suit Assembly Bench.',
    cost: 5,
    tier: 'uncommon',
    hidden: true,
  },
  bp_aff_speed_5: {
    id: 'bp_aff_speed_5',
    recipeId: 'craft_aff_speed_5',
    displayName: 'Servomotor Tune',
    description:
      '+5% movement speed (rolled). Slots into a suit utility mod via the Suit Assembly Bench.',
    cost: 5,
    tier: 'uncommon',
    hidden: true,
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
  // Hides orphan blueprints whose station hasn't shipped yet.
  // Lookup by id still works — `BLUEPRINT_CATALOG[id]` returns
  // hidden entries so existing-grant code paths keep functioning.
  return Object.values(BLUEPRINT_CATALOG).filter((b) => !b.hidden);
}

// E1 (Blueprint Progression Tree). All a blueprint's prerequisites
// must be present in `known` for the blueprint to be available
// (purchasable at the artifact uplink + craftable). Locked
// blueprints still surface in the UI greyed out so players can
// see what's around the corner.
export function isBlueprintAvailable(
  bp: BlueprintCatalogEntry,
  known: ReadonlySet<string>,
): boolean {
  const prereqs = bp.prerequisites;
  if (!prereqs || prereqs.length === 0) return true;
  for (const id of prereqs) {
    if (!known.has(id)) return false;
  }
  return true;
}

// Convenience: split the catalog into available / locked relative
// to a player's known-blueprint set. Hidden blueprints are
// excluded from both lists (same as `listBlueprints()`).
export function listBlueprintsForPlayer(
  known: ReadonlySet<string>,
): { available: BlueprintCatalogEntry[]; locked: BlueprintCatalogEntry[] } {
  const available: BlueprintCatalogEntry[] = [];
  const locked: BlueprintCatalogEntry[] = [];
  for (const bp of Object.values(BLUEPRINT_CATALOG)) {
    if (bp.hidden) continue;
    if (isBlueprintAvailable(bp, known)) available.push(bp);
    else locked.push(bp);
  }
  return { available, locked };
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
