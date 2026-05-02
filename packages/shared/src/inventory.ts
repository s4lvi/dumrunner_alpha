// Slot-based inventory model. Replaces the older `CarriedPart[]` to support
// heterogeneous items: procgen parts (unique), stackable materials and ammo,
// individual weapons, and placeable build blueprints.
//
// Layout: a fixed-size flat array. The first HOTBAR_SIZE entries are the
// hotbar (1–9 keys); the rest are bag slots accessible via the inventory
// panel.

import type { CarriedPart, BuildingKind, PartSlot, PartTier } from './protocol';

export const HOTBAR_SIZE = 9;
export const INVENTORY_SIZE = 36;

// Materials = stackable crafting components. New entries: add to the union
// AND to the MATERIALS registry below; everything else (recipes, loot tables,
// inventory rendering) keys off these ids.
export type MaterialKind =
  | 'scrap'
  | 'wire'
  | 'circuit'
  | 'alloy'
  | 'biotic'
  | 'crystal'
  | 'artifact';

// Single source of truth for material metadata. Server uses this for loot
// rolls; client uses it for icon tint + tooltip name.
export type MaterialDef = {
  id: MaterialKind;
  name: string;
  // Rough rarity tier — drives drop weights and recipe costing. 1 = abundant
  // common scavenge, 2 = mid-floor crafting components, 3 = late-floor / boss.
  tier: 1 | 2 | 3;
  // Hex color for the inventory icon.
  color: number;
};

export const MATERIALS: Record<MaterialKind, MaterialDef> = {
  scrap:   { id: 'scrap',   name: 'Scrap',            tier: 1, color: 0xc2410c },
  wire:    { id: 'wire',    name: 'Wire',             tier: 1, color: 0xeab308 },
  alloy:   { id: 'alloy',   name: 'Alloy Plate',      tier: 2, color: 0x94a3b8 },
  circuit: { id: 'circuit', name: 'Circuit Board',    tier: 2, color: 0x10b981 },
  biotic:  { id: 'biotic',  name: 'Biotic Tissue',    tier: 2, color: 0xa855f7 },
  crystal: { id: 'crystal', name: 'Resonant Crystal', tier: 3, color: 0x06b6d4 },
  // Artifacts are the "currency" tier — only spent at the artifact uplink
  // to learn blueprints. Drop weighting handled in the AI loot tables.
  artifact: { id: 'artifact', name: 'Artifact', tier: 3, color: 0xf472b6 },
};

export type AmmoKind = 'pistol_basic';
export type WeaponKind = 'pistol' | 'knife';

export type InventorySlot =
  | { kind: 'empty' }
  | { kind: 'part'; part: CarriedPart }
  | { kind: 'material'; materialId: MaterialKind; count: number }
  | { kind: 'ammo'; ammoId: AmmoKind; count: number }
  | { kind: 'weapon'; weaponId: WeaponKind }
  | { kind: 'placeable'; buildingKind: BuildingKind; count: number };

export type Inventory = InventorySlot[];

// Suit equipment slots — the 5 part categories that constitute a suit.
// Weapons assemble through a separate (future) weapon-assembly UI.
export type SuitSlotKind =
  | 'chassis'
  | 'plating'
  | 'life_support'
  | 'utility_mod'
  | 'cargo_grid';

export const SUIT_SLOT_KINDS: SuitSlotKind[] = [
  'chassis',
  'plating',
  'life_support',
  'utility_mod',
  'cargo_grid',
];

export type Equipment = {
  chassis: CarriedPart | null;
  plating: CarriedPart | null;
  life_support: CarriedPart | null;
  utility_mod: CarriedPart | null;
  cargo_grid: CarriedPart | null;
};

export function emptyEquipment(): Equipment {
  return {
    chassis: null,
    plating: null,
    life_support: null,
    utility_mod: null,
    cargo_grid: null,
  };
}

// ---------- suit stat bonuses ----------
// Each suit slot has one primary stat that scales with tier. Affixes are a
// later expansion (parts already carry an affixCount roll); for the alpha
// every Mk1 chassis grants the same +HP, every Mk2 chassis grants 2× that,
// and so on.
//
// Adding a new slot or new tier is one entry below — server +
// client read these constants directly and re-derive everything.

export type SuitStats = {
  hpBonus: number;
  shieldBonus: number;
  staminaMaxBonus: number;
  staminaRegenBonus: number; // per second
  // Multiplier applied additively to base move speed: 0.10 = +10%.
  moveSpeedMult: number;
};

export function emptySuitStats(): SuitStats {
  return {
    hpBonus: 0,
    shieldBonus: 0,
    staminaMaxBonus: 0,
    staminaRegenBonus: 0,
    moveSpeedMult: 0,
  };
}

// Tier multipliers — exponential-ish curve so high-tier loot is
// meaningfully better but not absurd at endgame.
const TIER_MULT: Record<PartTier, number> = {
  Mk1: 1,
  Mk2: 2.2,
  Mk3: 4,
  Mk4: 7,
  Alien: 12,
};

// Per-slot primary contribution at Mk1. Multiply by TIER_MULT[part.tier].
type SlotContribution = (mult: number) => Partial<SuitStats>;
const SLOT_CONTRIBUTION: Record<SuitSlotKind, SlotContribution> = {
  // Chassis: bulk HP. Mk1 chassis ≈ +15hp, Alien ≈ +180hp.
  chassis: (m) => ({ hpBonus: 15 * m }),
  // Plating: shield max + a small regen rate kick.
  plating: (m) => ({ shieldBonus: 12 * m }),
  // Life support: stamina max + regen rate (max/4 per second).
  life_support: (m) => ({
    staminaMaxBonus: 8 * m,
    staminaRegenBonus: 2 * m,
  }),
  // Utility mod: move-speed multiplier.
  utility_mod: (m) => ({ moveSpeedMult: 0.04 * m }),
  // Cargo grid is reserved for the future bag-size expansion. No stat
  // contribution yet — equipping it is currently a no-op for V1.
  cargo_grid: () => ({}),
};

export function computeSuitStats(equipment: Equipment): SuitStats {
  const stats = emptySuitStats();
  for (const slot of SUIT_SLOT_KINDS) {
    const part = equipment[slot];
    if (!part) continue;
    const mult = TIER_MULT[part.tier];
    const contrib = SLOT_CONTRIBUTION[slot](mult);
    stats.hpBonus += contrib.hpBonus ?? 0;
    stats.shieldBonus += contrib.shieldBonus ?? 0;
    stats.staminaMaxBonus += contrib.staminaMaxBonus ?? 0;
    stats.staminaRegenBonus += contrib.staminaRegenBonus ?? 0;
    stats.moveSpeedMult += contrib.moveSpeedMult ?? 0;
  }
  return stats;
}

// Stat contribution from a single part at its current tier. Used for
// inventory tooltips so the player knows what a part will grant before
// equipping it.
export function partStatPreview(part: CarriedPart): Partial<SuitStats> {
  if (!isSuitPart(part.slot)) return {};
  const mult = TIER_MULT[part.tier];
  return SLOT_CONTRIBUTION[part.slot as SuitSlotKind](mult);
}

// Parts whose slot matches a SuitSlotKind are equippable on the suit.
export function isSuitPart(slot: PartSlot): slot is SuitSlotKind {
  return (
    slot === 'chassis' ||
    slot === 'plating' ||
    slot === 'life_support' ||
    slot === 'utility_mod' ||
    slot === 'cargo_grid'
  );
}

const EMPTY: InventorySlot = { kind: 'empty' };

export function emptyInventory(): Inventory {
  return Array.from({ length: INVENTORY_SIZE }, () => ({ ...EMPTY }));
}

function isEmpty(slot: InventorySlot): boolean {
  return slot.kind === 'empty';
}

// Returns the first slot whose contents match (kind+id) and have headroom in
// the stack. -1 if none. `maxStack` defaults to Infinity for now (no caps).
export function findStackableSlot(
  inv: Inventory,
  kind: 'material' | 'ammo',
  id: string,
  maxStack = Infinity
): number {
  for (let i = 0; i < inv.length; i++) {
    const s = inv[i];
    if (kind === 'material' && s.kind === 'material' && s.materialId === id && s.count < maxStack) return i;
    if (kind === 'ammo' && s.kind === 'ammo' && s.ammoId === id && s.count < maxStack) return i;
  }
  return -1;
}

// Returns the first empty slot index, or -1 if none.
export function findEmptySlot(inv: Inventory): number {
  for (let i = 0; i < inv.length; i++) {
    if (isEmpty(inv[i])) return i;
  }
  return -1;
}

// Adds a unique part to the first empty slot. Returns true on success.
export function addPart(inv: Inventory, part: CarriedPart): boolean {
  const i = findEmptySlot(inv);
  if (i < 0) return false;
  inv[i] = { kind: 'part', part };
  return true;
}

// Adds count to an existing material stack, or to a new empty slot. Returns
// the leftover that didn't fit (when inventory is full).
export function addMaterial(
  inv: Inventory,
  materialId: MaterialKind,
  count: number
): number {
  if (count <= 0) return 0;
  let remaining = count;
  while (remaining > 0) {
    let i = findStackableSlot(inv, 'material', materialId);
    if (i < 0) i = findEmptySlot(inv);
    if (i < 0) return remaining;
    const s = inv[i];
    if (s.kind === 'material') {
      s.count += remaining;
      return 0;
    }
    inv[i] = { kind: 'material', materialId, count: remaining };
    return 0;
  }
  return remaining;
}

export function addAmmo(
  inv: Inventory,
  ammoId: AmmoKind,
  count: number
): number {
  if (count <= 0) return 0;
  let i = findStackableSlot(inv, 'ammo', ammoId);
  if (i < 0) i = findEmptySlot(inv);
  if (i < 0) return count;
  const s = inv[i];
  if (s.kind === 'ammo') {
    s.count += count;
    return 0;
  }
  inv[i] = { kind: 'ammo', ammoId, count };
  return 0;
}

export function addWeapon(inv: Inventory, weaponId: WeaponKind): boolean {
  const i = findEmptySlot(inv);
  if (i < 0) return false;
  inv[i] = { kind: 'weapon', weaponId };
  return true;
}

// Adds count to an existing placeable stack of the same kind, or to a new
// empty slot. Returns leftover that didn't fit (when inventory is full).
export function addPlaceable(
  inv: Inventory,
  buildingKind: BuildingKind,
  count: number
): number {
  if (count <= 0) return 0;
  for (const s of inv) {
    if (s.kind === 'placeable' && s.buildingKind === buildingKind) {
      s.count += count;
      return 0;
    }
  }
  const i = findEmptySlot(inv);
  if (i < 0) return count;
  inv[i] = { kind: 'placeable', buildingKind, count };
  return 0;
}

export function countPlaceable(
  inv: Inventory,
  buildingKind: BuildingKind
): number {
  let total = 0;
  for (const s of inv) {
    if (s.kind === 'placeable' && s.buildingKind === buildingKind) {
      total += s.count;
    }
  }
  return total;
}

export function consumePlaceable(
  inv: Inventory,
  buildingKind: BuildingKind,
  amount: number
): boolean {
  if (countPlaceable(inv, buildingKind) < amount) return false;
  let remaining = amount;
  for (let i = 0; i < inv.length && remaining > 0; i++) {
    const s = inv[i];
    if (s.kind !== 'placeable' || s.buildingKind !== buildingKind) continue;
    const take = Math.min(s.count, remaining);
    s.count -= take;
    remaining -= take;
    if (s.count <= 0) inv[i] = { ...EMPTY };
  }
  return true;
}

// Total count of a material across all slots.
export function countMaterial(inv: Inventory, materialId: MaterialKind): number {
  let total = 0;
  for (const s of inv) {
    if (s.kind === 'material' && s.materialId === materialId) total += s.count;
  }
  return total;
}

export function countAmmo(inv: Inventory, ammoId: AmmoKind): number {
  let total = 0;
  for (const s of inv) {
    if (s.kind === 'ammo' && s.ammoId === ammoId) total += s.count;
  }
  return total;
}

// Decrement `amount` of material across slots, removing emptied stacks.
// Returns true if successful, false if insufficient.
export function consumeMaterial(
  inv: Inventory,
  materialId: MaterialKind,
  amount: number
): boolean {
  if (countMaterial(inv, materialId) < amount) return false;
  let remaining = amount;
  for (let i = 0; i < inv.length && remaining > 0; i++) {
    const s = inv[i];
    if (s.kind !== 'material' || s.materialId !== materialId) continue;
    const take = Math.min(s.count, remaining);
    s.count -= take;
    remaining -= take;
    if (s.count <= 0) inv[i] = { ...EMPTY };
  }
  return true;
}

export function consumeAmmo(
  inv: Inventory,
  ammoId: AmmoKind,
  amount: number
): boolean {
  if (countAmmo(inv, ammoId) < amount) return false;
  let remaining = amount;
  for (let i = 0; i < inv.length && remaining > 0; i++) {
    const s = inv[i];
    if (s.kind !== 'ammo' || s.ammoId !== ammoId) continue;
    const take = Math.min(s.count, remaining);
    s.count -= take;
    remaining -= take;
    if (s.count <= 0) inv[i] = { ...EMPTY };
  }
  return true;
}

// Move/merge from one slot to another. Same-kind same-id stackables merge;
// otherwise the two slots are swapped. Returns true if anything changed.
export function swapSlots(inv: Inventory, from: number, to: number): boolean {
  if (from === to) return false;
  if (from < 0 || to < 0 || from >= inv.length || to >= inv.length) return false;
  const a = inv[from];
  const b = inv[to];

  // Stack merge: same material/ammo/placeable id.
  if (a.kind === 'material' && b.kind === 'material' && a.materialId === b.materialId) {
    b.count += a.count;
    inv[from] = { ...EMPTY };
    return true;
  }
  if (a.kind === 'ammo' && b.kind === 'ammo' && a.ammoId === b.ammoId) {
    b.count += a.count;
    inv[from] = { ...EMPTY };
    return true;
  }
  if (
    a.kind === 'placeable' &&
    b.kind === 'placeable' &&
    a.buildingKind === b.buildingKind
  ) {
    b.count += a.count;
    inv[from] = { ...EMPTY };
    return true;
  }
  // Plain swap.
  inv[from] = b;
  inv[to] = a;
  return true;
}

// Discard the contents of a slot. `all` discards the entire stack; otherwise
// stackables decrement by 1, non-stackables empty regardless.
export function discardSlot(inv: Inventory, slot: number, all: boolean): boolean {
  if (slot < 0 || slot >= inv.length) return false;
  const s = inv[slot];
  if (s.kind === 'empty') return false;
  if (
    !all &&
    (s.kind === 'material' || s.kind === 'ammo' || s.kind === 'placeable') &&
    s.count > 1
  ) {
    s.count -= 1;
    return true;
  }
  inv[slot] = { ...EMPTY };
  return true;
}

// Stable categorical sort. The hotbar (first HOTBAR_SIZE slots) is preserved
// — we only re-pack the bag (slots 9..N-1) so quick-select assignments don't
// jump on the player.
//
// Within the bag, items are grouped by category: weapons → placeables →
// materials → ammo → parts → empty. Stacks of the same kind+id collapse.
export function sortBag(inv: Inventory): void {
  const head = inv.slice(0, HOTBAR_SIZE);
  const tail = inv.slice(HOTBAR_SIZE);

  // First, collapse stackables by id across the bag.
  type Stack = {
    ammo: Map<string, number>;
    material: Map<string, number>;
    placeable: Map<string, number>;
  };
  const stacks: Stack = {
    ammo: new Map(),
    material: new Map(),
    placeable: new Map(),
  };
  const others: InventorySlot[] = [];
  for (const s of tail) {
    if (s.kind === 'empty') continue;
    if (s.kind === 'material') {
      stacks.material.set(
        s.materialId,
        (stacks.material.get(s.materialId) ?? 0) + s.count
      );
    } else if (s.kind === 'ammo') {
      stacks.ammo.set(s.ammoId, (stacks.ammo.get(s.ammoId) ?? 0) + s.count);
    } else if (s.kind === 'placeable') {
      stacks.placeable.set(
        s.buildingKind,
        (stacks.placeable.get(s.buildingKind) ?? 0) + s.count
      );
    } else {
      others.push(s);
    }
  }

  const order = (s: InventorySlot): number => {
    switch (s.kind) {
      case 'weapon':
        return 0;
      case 'placeable':
        return 1;
      case 'material':
        return 2;
      case 'ammo':
        return 3;
      case 'part':
        return 4;
      default:
        return 99;
    }
  };

  const rebuilt: InventorySlot[] = [];
  // Re-emit non-stackables in category order.
  others.sort((x, y) => order(x) - order(y));
  rebuilt.push(...others);
  // Then placeables.
  for (const [id, count] of stacks.placeable) {
    rebuilt.push({ kind: 'placeable', buildingKind: id as BuildingKind, count });
  }
  // Then materials.
  for (const [id, count] of stacks.material) {
    rebuilt.push({ kind: 'material', materialId: id as MaterialKind, count });
  }
  // Then ammo.
  for (const [id, count] of stacks.ammo) {
    rebuilt.push({ kind: 'ammo', ammoId: id as AmmoKind, count });
  }
  // Pad to original tail length.
  while (rebuilt.length < tail.length) rebuilt.push({ ...EMPTY });

  for (let i = 0; i < HOTBAR_SIZE; i++) inv[i] = head[i];
  for (let i = 0; i < tail.length; i++) inv[HOTBAR_SIZE + i] = rebuilt[i];
}
