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
  },
};

export function listRecipes(): Recipe[] {
  return Object.values(RECIPES);
}
