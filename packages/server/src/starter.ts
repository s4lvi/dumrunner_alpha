// Starter loadout for brand-new characters and existing characters whose
// stored inventory predates the slot-based format. Lives here so the
// loadout is one place to tune.

import {
  emptyInventory,
  ATTACHMENT_DEFS,
  LIFE_SUPPORT_SPECIALTIES,
  makeWeapon,
  rollAffixesForPart,
  rollAttachmentInstance,
  type CarriedPart,
  type Inventory,
  type PartSlot,
  type PartTier,
} from '@dumrunner/shared';

let _testPartSeq = 0;
function makeTestPart(slot: PartSlot, tier: PartTier): CarriedPart {
  const id = `tp${_testPartSeq++}`;
  return {
    id,
    slot,
    tier,
    weaponClass: null,
    affixCount: 1,
    affixes: rollAffixesForPart(slot, tier, 1),
    appliedAttachments: [],
    // Pick a specialty for life_support; ignored for other slots.
    // Cycles through the four kinds across consecutive calls so a
    // playtest equipment with one of each tier gets variety.
    specialtyHazard:
      slot === 'life_support'
        ? LIFE_SUPPORT_SPECIALTIES[_testPartSeq % LIFE_SUPPORT_SPECIALTIES.length]
        : undefined,
  };
}

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

// Beefed-up inventory for playtest servers. Every material in bulk
// (including the Phase 2 alloys), every ammo kind topped off, a
// curated sample of attachment classes spanning tiers so the tier-
// mismatch math is observable, and Phase 2.2's bench upgrade items
// pre-stocked so the tester can climb Mk1 → Mk4 in two right-clicks.
// The tester is expected to also have every blueprint pre-unlocked
// via the world's playtest flag, plus suit equipment pre-mounted via
// buildPlaytestEquipment so the cargo grid grows the bag for the
// extra entries below.
export function buildPlaytestInventory(): Inventory {
  const inv = emptyInventory();
  // Hotbar: T1 base ranged + a couple of higher-tier weapons so the
  // bench tier-cap UX is testable in one session — Mk1 bench rejects
  // the T2 sniper until the player applies a Mk2 upgrade. Knife in
  // the last slot so quick-melee is always a hotkey away.
  inv[0] = { kind: 'weapon', weapon: makeWeapon('pistol') };
  inv[1] = { kind: 'weapon', weapon: makeWeapon('smg') };
  inv[2] = { kind: 'weapon', weapon: makeWeapon('shotgun') };
  inv[3] = { kind: 'weapon', weapon: makeWeapon('rifle') };
  inv[4] = { kind: 'weapon', weapon: makeWeapon('sniper', 2) };
  inv[5] = { kind: 'weapon', weapon: makeWeapon('heavy', 3) };
  inv[6] = { kind: 'weapon', weapon: makeWeapon('energy', 4) };
  inv[7] = { kind: 'weapon', weapon: makeWeapon('energy_blade') };
  inv[8] = { kind: 'weapon', weapon: makeWeapon('knife') };

  // Bag: ammo, materials, upgrade items, attachments, consumables.
  // Ordered roughly by playtest utility — most-used in lower slots,
  // samples toward the end.
  const slots: Inventory = [];
  slots.push({ kind: 'ammo', ammoId: 'pistol_basic', count: 200 });
  slots.push({ kind: 'ammo', ammoId: 'smg_basic', count: 300 });
  slots.push({ kind: 'ammo', ammoId: 'shotgun_shells', count: 60 });
  slots.push({ kind: 'ammo', ammoId: 'rifle_rounds', count: 60 });
  slots.push({ kind: 'ammo', ammoId: 'sniper_rounds', count: 30 });
  slots.push({ kind: 'ammo', ammoId: 'heavy_slugs', count: 30 });
  slots.push({ kind: 'ammo', ammoId: 'energy_cells', count: 200 });
  slots.push({ kind: 'material', materialId: 'scrap', count: 500 });
  slots.push({ kind: 'material', materialId: 'wire', count: 300 });
  slots.push({ kind: 'material', materialId: 'alloy', count: 200 });
  // Phase 2.1 tiered alloys — pre-stocked so the tester doesn't have
  // to grind the Forge to test bench upgrades.
  slots.push({ kind: 'material', materialId: 'alloy_mk3', count: 30 });
  slots.push({ kind: 'material', materialId: 'alloy_mk4', count: 10 });
  slots.push({ kind: 'material', materialId: 'circuit', count: 200 });
  slots.push({ kind: 'material', materialId: 'biotic', count: 150 });
  slots.push({ kind: 'material', materialId: 'crystal', count: 50 });
  slots.push({ kind: 'material', materialId: 'artifact', count: 25 });
  slots.push({ kind: 'material', materialId: 'key', count: 10 });
  // Phase 2.2 bench upgrade items — one of each so the tester can
  // climb Mk1 → Mk2 → Mk3 → Mk4 by right-clicking each in sequence.
  slots.push({ kind: 'upgrade', upgradeId: 'weapon_bench_mk2', count: 1 });
  slots.push({ kind: 'upgrade', upgradeId: 'weapon_bench_mk3', count: 1 });
  slots.push({ kind: 'upgrade', upgradeId: 'weapon_bench_mk4', count: 1 });
  // Curated sample of attachments spanning tiers so Phase 2.3's
  // tier-mismatch scaling is observable. A T1 weapon with the Alien
  // Foregrip should read clearly weaker than the same weapon with
  // the Mk1 Foregrip (80% effective at delta-4, vs 100% at delta-0).
  const seedAttachments: Array<{ defId: string; tier: PartTier }> = [
    { defId: 'mod_compensator', tier: 'Mk1' },
    { defId: 'mod_foregrip', tier: 'Alien' },
    { defId: 'mod_armor_piercer', tier: 'Mk4' },
    { defId: 'aff_damage_15', tier: 'Mk2' },
    { defId: 'aff_firerate_25', tier: 'Mk3' },
    { defId: 'mod_incendiary', tier: 'Mk1' },
    { defId: 'mod_cryo', tier: 'Mk2' },
  ];
  for (const { defId, tier } of seedAttachments) {
    if (ATTACHMENT_DEFS[defId]) {
      slots.push({
        kind: 'attachment',
        instance: rollAttachmentInstance(defId, tier),
      });
    }
  }
  // Sample of every consumable so the buff bar and heal numbers can
  // be exercised without crafting.
  slots.push({ kind: 'consumable', consumableId: 'medkit', count: 5 });
  slots.push({ kind: 'consumable', consumableId: 'medkit_lg', count: 5 });
  slots.push({ kind: 'consumable', consumableId: 'medkit_xl', count: 3 });
  slots.push({ kind: 'consumable', consumableId: 'stim', count: 5 });
  slots.push({ kind: 'consumable', consumableId: 'overcharge_kit', count: 5 });

  // Splat into the bag region (slots 9..). Anything that doesn't fit
  // is silently dropped — the loadout is calibrated to fit a standard
  // bag plus the cargo-grid bonus from buildPlaytestEquipment().
  for (let i = 0; i < slots.length && 9 + i < inv.length; i++) {
    inv[9 + i] = slots[i];
  }
  return inv;
}

// Pre-mounted suit equipment for playtest servers. Five Mk2 parts —
// one of each suit slot — already equipped on arrival so the tester
// has the HP / shield / speed / cargo-grid bonuses applied without
// having to learn the drag-to-armor-slot UX first. Right-click any
// armor slot in the inventory panel to unequip and try a different
// part if needed.
export function buildPlaytestEquipment() {
  return {
    chassis: makeTestPart('chassis', 'Mk2'),
    plating: makeTestPart('plating', 'Mk2'),
    life_support: makeTestPart('life_support', 'Mk2'),
    utility_mod: makeTestPart('utility_mod', 'Mk2'),
    cargo_grid: makeTestPart('cargo_grid', 'Mk2'),
  };
}
