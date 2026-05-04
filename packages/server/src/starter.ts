// Starter loadout for brand-new characters and existing characters whose
// stored inventory predates the slot-based format. Lives here so the
// loadout is one place to tune.

import {
  emptyInventory,
  ATTACHMENT_DEFS,
  makeWeapon,
  rollAttachmentInstance,
  type Inventory,
} from '@dumrunner/shared';

export function buildStarterInventory(): Inventory {
  const inv = emptyInventory();
  inv[0] = { kind: 'weapon', weapon: makeWeapon('pistol') };
  inv[1] = { kind: 'weapon', weapon: makeWeapon('knife') };
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

// Beefed-up inventory for playtest servers. Every material in bulk,
// every ammo kind topped off, sample attachment instances of every
// class (so the procedural-rolls + assembly-preview UX has something
// to chew on), and 5 artifacts so testers can immediately buy through
// the uplink store. The tester is expected to also have every
// blueprint pre-unlocked via the world's playtest flag.
export function buildPlaytestInventory(): Inventory {
  const inv = emptyInventory();
  // Hotbar: pistol + knife to fire-test, smg + shotgun + rifle so all
  // four ranged families are immediately swappable, sword + hammer to
  // exercise melee progression.
  inv[0] = { kind: 'weapon', weapon: makeWeapon('pistol') };
  inv[1] = { kind: 'weapon', weapon: makeWeapon('smg') };
  inv[2] = { kind: 'weapon', weapon: makeWeapon('shotgun') };
  inv[3] = { kind: 'weapon', weapon: makeWeapon('rifle') };
  inv[4] = { kind: 'weapon', weapon: makeWeapon('sword') };
  inv[5] = { kind: 'weapon', weapon: makeWeapon('hammer') };
  inv[6] = { kind: 'weapon', weapon: makeWeapon('knife') };
  // Ammo. Every magazine starts full so testers can dive immediately;
  // reserve mass is generous so accuracy / fire-rate tuning is testable
  // without re-crafting.
  inv[7] = { kind: 'ammo', ammoId: 'pistol_basic', count: 200 };
  inv[8] = { kind: 'ammo', ammoId: 'smg_basic', count: 300 };

  // Bag: materials, ammo, attachments. Ordered roughly by playtest
  // utility — most-used in lower bag slots, samples toward the end.
  const slots: Inventory = [];
  slots.push({ kind: 'ammo', ammoId: 'shotgun_shells', count: 60 });
  slots.push({ kind: 'ammo', ammoId: 'rifle_rounds', count: 60 });
  slots.push({ kind: 'ammo', ammoId: 'sniper_rounds', count: 30 });
  slots.push({ kind: 'ammo', ammoId: 'heavy_slugs', count: 30 });
  slots.push({ kind: 'ammo', ammoId: 'energy_cells', count: 200 });
  slots.push({ kind: 'material', materialId: 'scrap', count: 500 });
  slots.push({ kind: 'material', materialId: 'wire', count: 300 });
  slots.push({ kind: 'material', materialId: 'alloy', count: 200 });
  slots.push({ kind: 'material', materialId: 'circuit', count: 200 });
  slots.push({ kind: 'material', materialId: 'biotic', count: 150 });
  slots.push({ kind: 'material', materialId: 'crystal', count: 50 });
  slots.push({ kind: 'material', materialId: 'artifact', count: 25 });
  slots.push({ kind: 'material', materialId: 'key', count: 10 });
  // One rolled instance of every attachment class so testers see the
  // full procedural-attachment surface immediately. Each slot is
  // unique post-Sprint C; rolls populate from the class's stat ranges.
  for (const def of Object.values(ATTACHMENT_DEFS)) {
    slots.push({
      kind: 'attachment',
      instance: rollAttachmentInstance(def.id, 'Mk2'),
    });
  }
  // Sample of every consumable so the buff bar and heal numbers can be
  // exercised without crafting.
  slots.push({ kind: 'consumable', consumableId: 'medkit', count: 5 });
  slots.push({ kind: 'consumable', consumableId: 'medkit_lg', count: 5 });
  slots.push({ kind: 'consumable', consumableId: 'medkit_xl', count: 3 });
  slots.push({ kind: 'consumable', consumableId: 'stim', count: 5 });
  slots.push({ kind: 'consumable', consumableId: 'overcharge_kit', count: 5 });

  // Splat into the bag region (slots 9..). Anything that doesn't fit
  // is silently dropped — the loadout is calibrated to fit the
  // default bag size.
  for (let i = 0; i < slots.length && 9 + i < inv.length; i++) {
    inv[9 + i] = slots[i];
  }
  return inv;
}
