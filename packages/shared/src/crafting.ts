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

// Runtime recipe registry. Populated from
// packages/shared/content/recipes/*.json at server boot via
// initRecipes → setRecipes, and replicated on each client via the
// welcome message. Mirrors the BLUEPRINT_CATALOG / WEAPON_STATS
// pattern — starts empty, setRecipes is the only way data lands.
export const RECIPES: Record<string, Recipe> = {};

// Replaces every entry in the live recipe registry. Mirrors the
// blueprint / weapon setter pattern — called at server boot from
// loaded JSON, again on hot-reload, and on the client when the
// welcome message carries the catalog.
export function setRecipes(entries: ReadonlyArray<Recipe>): void {
  for (const k of Object.keys(RECIPES)) delete RECIPES[k];
  for (const r of entries) RECIPES[r.id] = r;
}

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

// BlueprintTier lives in content/types (the JSON-on-disk source).
// Re-exported from here for backwards-compat with import sites
// that historically pulled it from this module.
export type { BlueprintTier } from './content/types';
import type { BlueprintTier } from './content/types';

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

// Runtime registry. Populated from JSON files at server boot
// (see packages/server/src/blueprints.ts) and then shipped to
// clients in the welcome message (handler calls
// setBlueprintCatalog with the wire payload). Mirrors the
// BIOMES / ENEMY_VISUALS pattern.
//
// Source of truth: packages/shared/content/blueprints/<id>.json.
// Edit those (or use the /editor/blueprints UI) to change the
// catalog; this record is intentionally empty at module load.
export const BLUEPRINT_CATALOG: Record<string, BlueprintCatalogEntry> = {};

// Replaces every entry in the live catalog. Idempotent. Existing
// keys not in the new set are dropped — feed the full catalog
// every call (don't merge piecemeal). Called by:
//   - server boot, after loadBlueprints()
//   - client welcome handler, with the wire payload
//   - hot-reload (later) on dev WS message
export function setBlueprintCatalog(
  entries: ReadonlyArray<BlueprintCatalogEntry>,
): void {
  for (const k of Object.keys(BLUEPRINT_CATALOG)) {
    delete BLUEPRINT_CATALOG[k];
  }
  for (const e of entries) {
    BLUEPRINT_CATALOG[e.id] = e;
  }
}

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
