// Starter loadout for brand-new characters and existing characters whose
// stored inventory predates the slot-based format. Lives here so the
// loadout is one place to tune.

import {
  emptyInventory,
  type Inventory,
} from '@dumrunner/shared';

export function buildStarterInventory(): Inventory {
  const inv = emptyInventory();
  inv[0] = { kind: 'weapon', weaponId: 'pistol' };
  inv[1] = { kind: 'weapon', weaponId: 'knife' };
  // Slot 3 is a generous starter stack of scrap. The player crafts walls
  // (or whatever else lands later) from this — no pre-built wall items.
  inv[2] = { kind: 'material', materialId: 'scrap', count: 50 };
  inv[3] = { kind: 'ammo', ammoId: 'pistol_basic', count: 100 };
  return inv;
}
