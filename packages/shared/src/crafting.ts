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

import type { AmmoKind, MaterialKind } from './inventory';
import type { BuildingKind, WorkstationKind } from './protocol';

export type RecipeInput =
  | { kind: 'material'; materialId: MaterialKind; count: number }
  | { kind: 'ammo'; ammoId: AmmoKind; count: number };

export type RecipeOutput =
  | { kind: 'placeable'; buildingKind: BuildingKind; count: number }
  | { kind: 'ammo'; ammoId: AmmoKind; count: number };

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
  bp_turret: {
    id: 'bp_turret',
    recipeId: 'turret',
    displayName: 'Auto-Turret',
    description: 'Builds a self-targeting defence turret. Crafted at an Electronics Bench.',
    cost: 3,
    tier: 'common',
  },
};

export function listBlueprints(): BlueprintCatalogEntry[] {
  return Object.values(BLUEPRINT_CATALOG);
}
