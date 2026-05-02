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
  inv[2] = { kind: 'ammo', ammoId: 'pistol_basic', count: 100 };
  // Materials enough to bootstrap the full crafting chain for testing.
  // The recipes a fresh player needs are:
  //   Workbench         30 scrap
  //   Electronics Bench 15 scrap + 10 wire + 4 circuit
  //   Artifact Uplink   30 scrap + 8 circuit + 1 crystal
  // Total: 75 scrap, 10 wire, 12 circuit, 1 crystal — buffered below
  // so the player can also walls / ammo without going scavenging first.
  inv[9] = { kind: 'material', materialId: 'scrap', count: 100 };
  inv[10] = { kind: 'material', materialId: 'wire', count: 15 };
  inv[11] = { kind: 'material', materialId: 'circuit', count: 15 };
  inv[12] = { kind: 'material', materialId: 'crystal', count: 2 };
  return inv;
}
