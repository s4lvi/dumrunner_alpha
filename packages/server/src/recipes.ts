// Recipe registry boot. Reads
// packages/shared/content/recipes/<id>.json at server boot and
// pushes the entries into the shared RECIPES table via setRecipes.
// Mirrors blueprints.ts / weapons.ts.

import { loadRecipes } from '@dumrunner/shared/content/loader';
import { setRecipes, type Recipe } from '@dumrunner/shared';

let RECIPES_WIRE: Recipe[] = [];

export async function initRecipes(): Promise<void> {
  // RecipeDef is structurally identical to Recipe (same field set,
  // string ids in place of WeaponKind / MaterialKind / etc. — the
  // runtime unions widen to string without a behaviour change).
  // Cast through unknown to acknowledge the structural-only match.
  const defs = (await loadRecipes()) as unknown as Recipe[];
  if (defs.length === 0) {
    console.warn(
      '[recipes] no recipe JSON files found in shared/content/recipes — craft modals will be empty',
    );
  } else {
    console.log(`[recipes] loaded ${defs.length} recipes`);
  }
  RECIPES_WIRE = defs;
  setRecipes(defs);
}

// Subset shipped to the client in the welcome message. Same shape
// as the registry — clients call setRecipes on receive.
export function getRecipesForWire(): Recipe[] {
  return RECIPES_WIRE;
}
