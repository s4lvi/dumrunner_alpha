// Slot-based inventory model. Replaces the older `CarriedPart[]` to support
// heterogeneous items: procgen parts (unique), stackable materials and ammo,
// individual weapons, and placeable build blueprints.
//
// Layout: a fixed-size flat array. The first HOTBAR_SIZE entries are the
// hotbar (1–9 keys); the rest are bag slots accessible via the inventory
// panel.

import type { Affix, CarriedPart, BuildingKind, PartSlot, PartTier } from './protocol';
import { flavoredItemName } from './itemNames';

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
  | 'alloy_mk3'
  | 'alloy_mk4'
  | 'biotic'
  | 'crystal'
  | 'artifact'
  | 'key';

// Single source of truth for material metadata. Server uses this for loot
// rolls; client uses it for icon tint + tooltip name.
export type MaterialDef = {
  id: MaterialKind;
  name: string;
  // Rough rarity tier — drives drop weights and recipe costing. 1 = abundant
  // common scavenge, 2 = mid-floor crafting components, 3 = late-floor / boss,
  // 4 = top-tier (alloy_mk4 only at the Forge).
  tier: 1 | 2 | 3 | 4;
  // Hex color for the inventory icon.
  color: number;
};

export const MATERIALS: Record<MaterialKind, MaterialDef> = {
  scrap:   { id: 'scrap',   name: 'Scrap',            tier: 1, color: 0xc2410c },
  wire:    { id: 'wire',    name: 'Wire',             tier: 1, color: 0xeab308 },
  // Base alloy. Drops from armored/brute kills, also craftable at
  // the Forge from scrap + wire so a player without late-floor
  // kills isn't gated entirely on lucky drops.
  alloy:   { id: 'alloy',   name: 'Alloy Plate',      tier: 2, color: 0x94a3b8 },
  // Higher-tier alloys are *only* produced at the Forge (Phase 2)
  // by refining lower-tier alloys with circuits / crystals /
  // artifacts. They feed the Weapon Bench's tier-upgrade items and
  // (later) high-tier weapon assemblies.
  alloy_mk3: {
    id: 'alloy_mk3',
    name: 'Refined Alloy',
    tier: 3,
    color: 0xfde047,
  },
  alloy_mk4: {
    id: 'alloy_mk4',
    name: 'Precision Alloy',
    tier: 4,
    color: 0xfb923c,
  },
  circuit: { id: 'circuit', name: 'Circuit Board',    tier: 2, color: 0x10b981 },
  biotic:  { id: 'biotic',  name: 'Biotic Tissue',    tier: 2, color: 0xa855f7 },
  crystal: { id: 'crystal', name: 'Resonant Crystal', tier: 3, color: 0x06b6d4 },
  // Artifacts are the "currency" tier — only spent at the artifact uplink
  // to learn blueprints. Drop weighting handled in the AI loot tables.
  artifact: { id: 'artifact', name: 'Artifact', tier: 3, color: 0xf472b6 },
  // Keys unlock dungeon doors. Drops from dungeon enemies; later tiers
  // will add craftable variants. V1: any key opens any locked door.
  key: { id: 'key', name: 'Key', tier: 2, color: 0xfacc15 },
};

// Flat artifact-per-key price at the artifact uplink. Tunable; cheap
// enough that the player can stockpile a few without grinding.
export const KEY_ARTIFACT_COST = 1;

export type AmmoKind =
  | 'pistol_basic'
  | 'smg_basic'
  | 'shotgun_shells'
  | 'rifle_rounds'
  | 'sniper_rounds'
  | 'heavy_slugs'
  | 'energy_cells';

// Consumables — single-use items the player triggers from a hotbar
// slot to apply an effect (heal, buff, etc). New entries: add to the
// union AND to CONSUMABLES below.
export type ConsumableKind =
  | 'medkit'
  | 'medkit_lg'
  | 'medkit_xl'
  | 'stim'
  | 'overcharge_kit';

export type ConsumableDef = {
  id: ConsumableKind;
  name: string;
  description: string;
  // Color tint for the inventory icon.
  color: number;
  // Instant HP restored on use. 0 = no instant heal.
  healHp: number;
  // Optional timed effects applied to the user. Server attaches via
  // World.applyPlayerEffect for each; matching id refreshes / replaces
  // an existing effect instead of stacking. Stim ships two effects
  // (speed + stamina regen) under different ids so each refreshes
  // independently.
  effects?: Array<{
    id: string;
    kind:
      | 'speed_mult'
      | 'stamina_regen_add'
      | 'shield_flat'
      | 'hp_max_flat';
    magnitude: number;
    durationMs: number;
    label: string;
  }>;
};

export const CONSUMABLES: Record<ConsumableKind, ConsumableDef> = {
  medkit: {
    id: 'medkit',
    name: 'Medkit',
    description: 'Restores 60 HP.',
    color: 0xef4444,
    healHp: 60,
  },
  medkit_lg: {
    id: 'medkit_lg',
    name: 'Medkit (Large)',
    description: 'Restores 120 HP.',
    color: 0xdc2626,
    healHp: 120,
  },
  medkit_xl: {
    id: 'medkit_xl',
    name: 'Medkit (XL)',
    description: 'Restores 220 HP.',
    color: 0x991b1b,
    healHp: 220,
  },
  stim: {
    id: 'stim',
    name: 'Stim',
    description: '+30% move speed and +5/s stamina regen for 30s.',
    color: 0x22d3ee,
    healHp: 0,
    effects: [
      {
        id: 'stim_speed',
        kind: 'speed_mult',
        magnitude: 0.3,
        durationMs: 30_000,
        label: 'Stim',
      },
      {
        id: 'stim_stamina',
        kind: 'stamina_regen_add',
        magnitude: 5,
        durationMs: 30_000,
        label: 'Stim',
      },
    ],
  },
  overcharge_kit: {
    id: 'overcharge_kit',
    name: 'Overcharge Kit',
    description: '+50 max shield for 60s. Refills the bar on use.',
    color: 0xa78bfa,
    healHp: 0,
    effects: [
      {
        id: 'overcharge',
        kind: 'shield_flat',
        magnitude: 50,
        durationMs: 60_000,
        label: 'Overcharge',
      },
    ],
  },
};

// Workstation tier-upgrade items. Crafted at the Forge from
// tiered alloys; applied to an existing workstation via the
// `upgrade_workstation` server message to lift its tier. A Mk1
// Weapon Bench can only assemble Mk1 weapons; Mk2 unlocks Mk2
// assembly; etc. Fungible (stackable count); the Mk2 upgrade is
// generic — any Mk1→Mk2 step uses one.
export type UpgradeKind =
  | 'weapon_bench_mk2'
  | 'weapon_bench_mk3'
  | 'weapon_bench_mk4';

export type UpgradeDef = {
  id: UpgradeKind;
  name: string;
  description: string;
  // Which BuildingKind this upgrade item targets.
  targetBuilding: BuildingKind;
  // Tier this upgrade lifts the building TO. Server validates that
  // current.benchTier === targetTier - 1 (no skipping tiers).
  targetTier: 2 | 3 | 4;
  color: number;
};

export const UPGRADES: Record<UpgradeKind, UpgradeDef> = {
  weapon_bench_mk2: {
    id: 'weapon_bench_mk2',
    name: 'Weapon Bench Mk2 Upgrade',
    description:
      'Lifts a Weapon Bench from Mk1 to Mk2. Apply at the bench (right-click → Apply).',
    targetBuilding: 'weapon_bench',
    targetTier: 2,
    color: 0xfde047,
  },
  weapon_bench_mk3: {
    id: 'weapon_bench_mk3',
    name: 'Weapon Bench Mk3 Upgrade',
    description: 'Lifts a Weapon Bench from Mk2 to Mk3.',
    targetBuilding: 'weapon_bench',
    targetTier: 3,
    color: 0xfb923c,
  },
  weapon_bench_mk4: {
    id: 'weapon_bench_mk4',
    name: 'Weapon Bench Mk4 Upgrade',
    description: 'Lifts a Weapon Bench from Mk3 to Mk4.',
    targetBuilding: 'weapon_bench',
    targetTier: 4,
    color: 0xef4444,
  },
};

// Canonical built-in weapon ids. Used as the autocomplete surface
// for the WeaponKind type (via const-tagged intersection below) and
// as a fallback identity if WEAPON_FAMILY hasn't been populated yet.
export const KNOWN_WEAPON_KINDS = [
  'pistol',
  'smg',
  'shotgun',
  'rifle',
  'sniper',
  'heavy',
  'energy',
  'knife',
  'sword',
  'hammer',
  'energy_blade',
] as const;
export type KnownWeaponKind = (typeof KNOWN_WEAPON_KINDS)[number];

// WeaponKind permits any string. The literal union keeps IDE
// autocomplete for the built-ins while letting JSON-authored
// entries flow through without a TS code change. Exhaustive
// switches over WeaponKind are no longer safe — code paths that
// need to branch on weapon kind should look it up against the
// runtime registry instead.
export type WeaponKind = KnownWeaponKind | (string & {});

// Family groups weapons that share ammo, mod compatibility, and turret
// variants. `melee` covers the knife (no ammo, no piece-affix slots).
// This stays a closed enum because the runtime branches on family in
// several places — adding a new family is a code change.
export type WeaponFamily =
  | 'pistol'
  | 'smg'
  | 'shotgun'
  | 'rifle'
  | 'sniper'
  | 'heavy'
  | 'energy'
  | 'melee';

// Populated at server boot from WeaponDef JSON (setWeaponRegistry)
// and shipped to clients in the welcome message. Starts empty;
// consumers must read on use, not at import time.
export const WEAPON_FAMILY: Record<string, WeaponFamily> = {};

// Tiering controls slot count + crafting station gate. T1 craftable at
// the Workbench; T2+ requires a Weapon Bench.
export type WeaponTier = 1 | 2 | 3 | 4;
export const WEAPON_TIERS: WeaponTier[] = [1, 2, 3, 4];

// Pieces are the affix attach points on a weapon. Higher tier unlocks
// more pieces (= more stackable affix slots). Affixes within the same
// piece don't stack — different pieces do.
export type WeaponPieceKind = 'frame' | 'grip' | 'magazine' | 'barrel';

export const TIER_PIECE_SLOTS: Record<WeaponTier, WeaponPieceKind[]> = {
  1: ['frame'],
  2: ['frame', 'grip'],
  3: ['frame', 'grip', 'magazine'],
  4: ['frame', 'grip', 'magazine', 'barrel'],
};

// Mods are discrete attachments that aren't piece-bound (suppressor,
// scope, foregrip). Mod slot count also scales with tier.
export const TIER_MOD_SLOTS: Record<WeaponTier, number> = {
  1: 0,
  2: 1,
  3: 2,
  4: 3,
};

// Per-weapon piece-affix map. Each piece holds a full
// AttachmentInstance once Sprint C lands, not just an id — every
// rolled piece is unique. Only entries for pieces unlocked by the
// weapon's current tier should be populated; the rest stay omitted.
// AttachmentInstance is defined later in the file; we forward-declare
// the relevant shape here to keep the type ordering manageable.
export type WeaponPieces = Partial<
  Record<WeaponPieceKind, AttachmentInstanceFwd | null>
>;

export type WeaponMod = AttachmentInstanceFwd;

// Forward-declared mirror of AttachmentInstance so the type can
// reference it before its fully expanded definition below. Exported
// so protocol.ts (CarriedPart.appliedAttachments) can refer to it
// without importing the larger AttachmentInstance type and creating
// a cycle.
export type AttachmentInstanceFwd = {
  id: string;
  defId: string;
  tier: PartTier;
  rolls: Record<string, number>;
  legacyValue?: number;
};

// A weapon instance carries the base id + its rolled affixes/mods,
// plus a per-instance magazine count. Two pistols of the same family
// but different tiers/affixes/mag state are distinct items. Slotted
// into the inventory as `{ kind: 'weapon', weapon }`.
export type WeaponItem = {
  weaponId: WeaponKind;
  tier: WeaponTier;
  pieces: WeaponPieces;
  mods: WeaponMod[];
  // Bullets currently loaded. Optional only so existing saves without
  // the field deserialize cleanly; treat undefined as "freshly
  // crafted, full mag" at use time. Melee weapons leave it undefined.
  magazineRemaining?: number;
};

// Initial magazine size on a freshly-crafted weapon. Mirrors
// `WEAPON_STATS[family].magazineSize` on the server but lives here so
// shared callers (starter inventory, recipe output) can stamp the
// right starting count without taking a server-only dep.
const INITIAL_MAGAZINE: Record<WeaponFamily, number> = {
  pistol: 12,
  smg: 30,
  shotgun: 6,
  rifle: 10,
  sniper: 4,
  heavy: 5,
  energy: 20,
  melee: 0,
};

export function makeWeapon(
  weaponId: WeaponKind,
  tier: WeaponTier = 1
): WeaponItem {
  const family = WEAPON_FAMILY[weaponId];
  const magazineRemaining =
    family === 'melee' ? undefined : INITIAL_MAGAZINE[family];
  return { weaponId, tier, pieces: {}, mods: [], magazineRemaining };
}

export function weaponFamily(weaponId: WeaponKind): WeaponFamily {
  return WEAPON_FAMILY[weaponId];
}

export type InventorySlot =
  | { kind: 'empty' }
  | { kind: 'part'; part: CarriedPart }
  | { kind: 'material'; materialId: MaterialKind; count: number }
  | { kind: 'ammo'; ammoId: AmmoKind; count: number }
  | { kind: 'weapon'; weapon: WeaponItem }
  | { kind: 'attachment'; instance: AttachmentInstanceFwd }
  | { kind: 'consumable'; consumableId: ConsumableKind; count: number }
  | { kind: 'placeable'; buildingKind: BuildingKind; count: number }
  // Workstation tier-upgrade items — crafted at the Forge,
  // applied to a target workstation building via the
  // `upgrade_workstation` server message to lift its tier.
  | { kind: 'upgrade'; upgradeId: UpgradeKind; count: number };

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
  // Extra tiles added to the base BUILD_RADIUS_TILES on the chassis
  // primary stat. Higher-tier chassis lets you place buildings
  // further from your character. Cargo grid grants a smaller bonus
  // too (see SLOT_CONTRIBUTION below).
  buildRadiusBonus: number;
  // Extra inventory bag slots granted by the cargo grid. Server
  // ensures conn.inventory.length matches INVENTORY_SIZE +
  // inventoryBonus on equipment changes; never shrinks below the
  // last non-empty slot to avoid item loss.
  inventoryBonus: number;
  // Hazard resists, 0..1 (capped at 0.95 effective at damage time).
  // Driven by the equipped life-support part's tier + specialty.
  // The specialty hazard rolls higher than the off-coverage three.
  heatResist: number;
  coldResist: number;
  radiationResist: number;
  toxicResist: number;
};

// Player base stats — must mirror the server's COMBAT constants. Used by
// the character stats panel to render "base + suit" lines.
export const PLAYER_BASE_STATS = {
  maxHp: 100,
  maxShield: 0,
  maxStamina: 100,
  staminaRegenPerSec: 25,
};

export function emptySuitStats(): SuitStats {
  return {
    hpBonus: 0,
    shieldBonus: 0,
    staminaMaxBonus: 0,
    staminaRegenBonus: 0,
    moveSpeedMult: 0,
    buildRadiusBonus: 0,
    inventoryBonus: 0,
    heatResist: 0,
    coldResist: 0,
    radiationResist: 0,
    toxicResist: 0,
  };
}

// Per-tier life-support resist values. Specialty hazard gets
// `spec`, the other 3 hazards get `off` — represents "every LS
// has one focus + partial coverage on the rest" per the GDD.
// Adding tiers is one entry; specialty selection is per-instance.
//
// Targets calibrated to the GDD progression promise:
//   no resist     → seconds before death in a deep biome
//   mid spec match → minutes of viable exploration
//   high spec match → full run including band's deepest floors
export const LIFE_SUPPORT_RESIST_TABLE: Record<
  PartTier,
  { spec: number; off: number }
> = {
  Mk1: { spec: 0.3, off: 0.05 },
  Mk2: { spec: 0.45, off: 0.15 },
  Mk3: { spec: 0.6, off: 0.25 },
  Mk4: { spec: 0.75, off: 0.4 },
  Alien: { spec: 0.85, off: 0.65 },
};

export type LifeSupportSpecialty = 'heat' | 'radiation' | 'cold' | 'toxic';
export const LIFE_SUPPORT_SPECIALTIES: readonly LifeSupportSpecialty[] = [
  'heat',
  'radiation',
  'cold',
  'toxic',
] as const;

// Returns the four-resist tuple a life-support of a given tier
// and specialty contributes. Used by computeSuitStats AND by the
// inventory tooltip so the displayed numbers match what the
// server applies during the hazard tick.
export function lifeSupportResists(
  tier: PartTier,
  specialty: LifeSupportSpecialty,
): {
  heatResist: number;
  coldResist: number;
  radiationResist: number;
  toxicResist: number;
} {
  const { spec, off } = LIFE_SUPPORT_RESIST_TABLE[tier];
  return {
    heatResist: specialty === 'heat' ? spec : off,
    coldResist: specialty === 'cold' ? spec : off,
    radiationResist: specialty === 'radiation' ? spec : off,
    toxicResist: specialty === 'toxic' ? spec : off,
  };
}

// Deterministic specialty pick when a part lacks one (legacy save
// migration, or a starter LS that hasn't been authored with a
// specific role). Hashes the part id for stability — same id
// always resolves to the same specialty across reloads.
export function defaultSpecialtyForPartId(id: string): LifeSupportSpecialty {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return LIFE_SUPPORT_SPECIALTIES[h % LIFE_SUPPORT_SPECIALTIES.length];
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
  // Chassis: bulk HP + extra build reach. Mk1 ≈ +15hp +0 tiles;
  // each tier multiplier nudges build radius by a fractional tile so
  // a Mk2 chassis grants +0 extra (still 0.4 < 1), Mk3 grants +1,
  // Mk4 +1, Alien +2 (after Math.floor in computeSuitStats).
  chassis: (m) => ({
    hpBonus: 15 * m,
    buildRadiusBonus: 0.4 * (m - 1),
  }),
  // Plating: shield max + a small regen rate kick.
  plating: (m) => ({ shieldBonus: 12 * m }),
  // Life support: stamina max + regen rate (max/4 per second).
  life_support: (m) => ({
    staminaMaxBonus: 8 * m,
    staminaRegenBonus: 2 * m,
  }),
  // Utility mod: move-speed multiplier.
  utility_mod: (m) => ({ moveSpeedMult: 0.04 * m }),
  // Cargo grid: extra bag slots (the primary point of the slot)
  // plus a small build-reach bonus. Mk1 = +4 slots, Mk2 ≈ +9,
  // Mk3 +16, Mk4 +28, Alien +48 (after Math.floor on the server).
  cargo_grid: (m) => ({
    inventoryBonus: 4 * m,
    buildRadiusBonus: 0.25 * (m - 1),
  }),
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
    stats.buildRadiusBonus += contrib.buildRadiusBonus ?? 0;
    stats.inventoryBonus += contrib.inventoryBonus ?? 0;
    // Life-support resists: derived from (tier, specialty). Other
    // slots can't roll resists today, so this is gated to
    // life_support. Tooltip surface mirrors this — a non-LS part
    // shows zero resists.
    if (slot === 'life_support') {
      const specialty: LifeSupportSpecialty =
        part.specialtyHazard ?? defaultSpecialtyForPartId(part.id);
      const resists = lifeSupportResists(part.tier, specialty);
      stats.heatResist += resists.heatResist;
      stats.coldResist += resists.coldResist;
      stats.radiationResist += resists.radiationResist;
      stats.toxicResist += resists.toxicResist;
    }
    // Stack rolled affix bonuses onto the same accumulator. Affixes use
    // the same units as the primary stat so they just add.
    for (const affix of part.affixes ?? []) {
      const def = AFFIX_DEFS[affix.id];
      if (def) def.apply(stats, affix.value);
    }
    // Crafted suit-affix attachments. Each appliedAttachment is a
    // unique rolled instance scaled by tier-mismatch (Phase 2.5):
    // a Mk4 attachment on a Mk1 part delivers ~80% of its rolled
    // bonus, same magnitude curve as the weapon-side mismatch.
    for (const inst of part.appliedAttachments ?? []) {
      const def = ATTACHMENT_DEFS[inst.defId];
      if (!def || def.kind !== 'suit_affix') continue;
      const eff = attachmentInstanceSuitEffect(inst);
      const scale = suitTierMismatchScale(inst.tier, part.tier);
      stats.hpBonus += eff.hpBonus * scale;
      stats.shieldBonus += eff.shieldBonus * scale;
      stats.staminaMaxBonus += eff.staminaMaxBonus * scale;
      stats.staminaRegenBonus += eff.staminaRegenBonus * scale;
      stats.moveSpeedMult += eff.moveSpeedMult * scale;
    }
  }
  return stats;
}

// Just the slot's primary stat contribution at this tier, no affixes.
// Used by the tooltip to render the line under the part name before
// listing each affix individually.
export function partPrimaryStat(part: CarriedPart): Partial<SuitStats> {
  if (!isSuitPart(part.slot)) return {};
  return SLOT_CONTRIBUTION[part.slot as SuitSlotKind](TIER_MULT[part.tier]);
}

// Stat contribution from a single part at its current tier. Used for
// inventory tooltips so the player knows what a part will grant before
// equipping it. Includes both the slot's primary stat AND its rolled
// affixes — they all stack.
export function partStatPreview(part: CarriedPart): Partial<SuitStats> {
  if (!isSuitPart(part.slot)) return {};
  const mult = TIER_MULT[part.tier];
  const primary = SLOT_CONTRIBUTION[part.slot as SuitSlotKind](mult);
  const stats: SuitStats = { ...emptySuitStats(), ...primary };
  for (const affix of part.affixes ?? []) {
    const def = AFFIX_DEFS[affix.id];
    if (def) def.apply(stats, affix.value);
  }
  // Strip zeroes so the caller can iterate non-empty entries cleanly.
  const out: Partial<SuitStats> = {};
  if (stats.hpBonus) out.hpBonus = stats.hpBonus;
  if (stats.shieldBonus) out.shieldBonus = stats.shieldBonus;
  if (stats.staminaMaxBonus) out.staminaMaxBonus = stats.staminaMaxBonus;
  if (stats.staminaRegenBonus) out.staminaRegenBonus = stats.staminaRegenBonus;
  if (stats.moveSpeedMult) out.moveSpeedMult = stats.moveSpeedMult;
  return out;
}

// ---------- Affix system ----------
//
// One AFFIX_DEFS entry per modifier kind. label() formats the rolled value
// for tooltips; apply() folds the value into a SuitStats accumulator. To
// add a new affix: drop it in here, list its valid slots, set min/max
// roll range. Server's loot roller filters AFFIX_DEFS by validSlots when
// building affixes for a freshly-dropped part.

export type AffixDef = {
  id: string;
  // Flavored display name ("Adrenal Surge"), shown above the technical
  // effect line in tooltips. Makes random rolls feel like loot, not stats.
  name: string;
  label: (value: number) => string;
  apply: (stats: SuitStats, value: number) => void;
  // Roll range. Real value = rand in [minRoll, maxRoll] × tier multiplier.
  minRoll: number;
  maxRoll: number;
  validSlots: PartSlot[];
};

const SUIT_SLOTS_ALL: PartSlot[] = [...SUIT_SLOT_KINDS];

export const AFFIX_DEFS: Record<string, AffixDef> = {
  add_hp: {
    id: 'add_hp',
    name: 'Adrenal Surge',
    label: (v) => `+${Math.round(v)} max HP`,
    apply: (s, v) => {
      s.hpBonus += v;
    },
    minRoll: 4,
    maxRoll: 10,
    validSlots: SUIT_SLOTS_ALL,
  },
  add_shield: {
    id: 'add_shield',
    name: 'Pulsewall Aegis',
    label: (v) => `+${Math.round(v)} max shield`,
    apply: (s, v) => {
      s.shieldBonus += v;
    },
    minRoll: 3,
    maxRoll: 9,
    validSlots: SUIT_SLOTS_ALL,
  },
  add_stamina_max: {
    id: 'add_stamina_max',
    name: 'Lung Augment',
    label: (v) => `+${Math.round(v)} max stamina`,
    apply: (s, v) => {
      s.staminaMaxBonus += v;
    },
    minRoll: 3,
    maxRoll: 8,
    validSlots: SUIT_SLOTS_ALL,
  },
  add_stamina_regen: {
    id: 'add_stamina_regen',
    name: 'Aerobic Conditioning',
    label: (v) => `+${v.toFixed(1)} stamina/s`,
    apply: (s, v) => {
      s.staminaRegenBonus += v;
    },
    minRoll: 0.5,
    maxRoll: 2,
    validSlots: SUIT_SLOTS_ALL,
  },
  add_move_speed: {
    id: 'add_move_speed',
    name: 'Lightfoot',
    label: (v) => `+${Math.round(v * 100)}% move speed`,
    apply: (s, v) => {
      s.moveSpeedMult += v;
    },
    minRoll: 0.01,
    maxRoll: 0.04,
    validSlots: SUIT_SLOTS_ALL,
  },
};

// ---------- attachment registry ----------
// Three flavours of attachment items live in the player inventory and slot
// onto a target item:
//   - weapon_mod    → goes into a weapon's mod slot list (count-based)
//   - weapon_affix  → goes into a weapon piece (frame/grip/magazine/barrel)
//   - suit_affix    → goes into a suit slot (plating/utility/etc)
// All three crafted from blueprints at the relevant station; the stack
// `kind: 'attachment'` slot stores them in inventory by id.

export type WeaponEffect = {
  // Multiplicative on damage. 1.0 = no change.
  damageMult?: number;
  // Multiplicative on fire interval (lower = faster cadence).
  fireIntervalMult?: number;
  // Multiplicative on spread cone (lower = tighter pattern).
  spreadMult?: number;
  // Additive to projectile speed (px/sec).
  projectileSpeedAdd?: number;
};

export type SuitEffect = {
  hpBonus?: number;
  shieldBonus?: number;
  staminaMaxBonus?: number;
  staminaRegenBonus?: number;
  moveSpeedMult?: number;
};

export type AttachmentDef =
  | {
      kind: 'weapon_mod';
      id: string;
      displayName: string;
      description: string;
      // Borderlands-style adjective the weapon picks up when this
      // attachment is equipped. Stacks into the weapon's display name
      // in piece-then-mod order (capped at 3 adjectives so longer-
      // term builds don't read as a tongue-twister).
      adjective: string;
      // null = any ranged family
      family: WeaponFamily | null;
      effect: WeaponEffect;
      // Optional projectile imbue — when this mod is on the weapon,
      // every hit applies the corresponding status effect to the
      // target. Server reads this off computeWeaponImbue at fire
      // time. Magnitude / duration are flat-baked here so adding
      // a new imbue is data-only.
      imbue?: {
        kind: 'burn_dps' | 'poison_dps' | 'slow_pct';
        magnitude: number;
        durationMs: number;
        label: string;
      };
    }
  | {
      kind: 'weapon_affix';
      id: string;
      displayName: string;
      description: string;
      adjective: string;
      pieceKind: WeaponPieceKind;
      family: WeaponFamily | null;
      effect: WeaponEffect;
      value: number;
    }
  | {
      kind: 'suit_affix';
      id: string;
      displayName: string;
      description: string;
      // Adjective shows up when this is applied to a suit piece —
      // future suit-display-name work can use it.
      adjective: string;
      slotKind: SuitSlotKind;
      effect: SuitEffect;
      value: number;
    };

export const ATTACHMENT_DEFS: Record<string, AttachmentDef> = {};

export function listAttachments(): AttachmentDef[] {
  return Object.values(ATTACHMENT_DEFS);
}

// ---------- procedural roll system ----------
// Static ATTACHMENT_DEFS above act as the *class* catalog. An
// AttachmentInstance is one realised drop / craft within a class:
// same family + same effect *kinds*, but with rolled magnitudes
// inside per-class ranges, scaled by tier. Two "Compensator" mods
// in your bag are no longer interchangeable — one might be -45%
// spread + 5% damage, another -52% spread + nothing extra.
//
// Implementation strategy: each class declares `statRanges`
// (parallel to `effect`) describing what *can* roll on instances
// of that class. The class's static `effect` is the baseline
// (zero-roll instance) so legacy migrations from saved data convert
// cleanly. A fresh roll multiplies the baseline by a tier-scaled
// factor sampled from each range.

// What can roll on instances of a class. Each entry maps a stat
// key into a [min, max] range. min < 0 means the stat can roll
// negative (debuff), > 0 means buff. Ranges below are written as
// *multipliers/adders on top of the base effect* so an instance's
// effect math is `base + roll`.
export type AttachmentStatRanges = {
  damageMultBonus?: [number, number];        // adds to damageMult (1 + base + roll)
  fireIntervalMultBonus?: [number, number];  // multiplied INTO fireIntervalMult
  spreadMultBonus?: [number, number];        // multiplied INTO spreadMult
  projectileSpeedAddBonus?: [number, number];// added to projectileSpeedAdd
  hpBonusAdd?: [number, number];             // added to hpBonus
  shieldBonusAdd?: [number, number];         // added to shieldBonus
  staminaMaxBonusAdd?: [number, number];
  staminaRegenBonusAdd?: [number, number];
  moveSpeedMultBonus?: [number, number];
};

// Range table per class. Keys mirror ATTACHMENT_DEFS keys; classes
// missing here roll 0 deltas (legacy / un-rolled). This way every
// existing def has a roll path without us hand-tuning all 12
// catalog entries up front — defaults are fine, only call out the
// ones whose roll variance defines the class fantasy.
export const ATTACHMENT_STAT_RANGES: Record<string, AttachmentStatRanges> = {};

// Replaces every entry in both attachment registries from a list
// of authored AttachmentDef-with-rolls JSON entries. The disk
// format folds the def + its roll ranges into one shape; the
// runtime splits them back into the two records consumers expect.
// Mirrors setBlueprintCatalog / setWeaponRegistry / setRecipes.
export function setAttachmentRegistry(
  entries: ReadonlyArray<AttachmentDef & { rolls?: AttachmentStatRanges }>,
): void {
  for (const k of Object.keys(ATTACHMENT_DEFS)) delete ATTACHMENT_DEFS[k];
  for (const k of Object.keys(ATTACHMENT_STAT_RANGES)) {
    delete ATTACHMENT_STAT_RANGES[k];
  }
  for (const e of entries) {
    const { rolls, ...def } = e;
    ATTACHMENT_DEFS[def.id] = def as AttachmentDef;
    if (rolls && Object.keys(rolls).length > 0) {
      ATTACHMENT_STAT_RANGES[def.id] = rolls;
    }
  }
}

// One realised attachment instance. Lives directly inside inventory
// slots, weapon piece slots, and suit-part appliedAttachments
// arrays — never identified by defId alone. `id` is unique per
// instance (used for naming flavor + future per-instance metadata).
//
// Same shape as AttachmentInstanceFwd above; this is the canonical
// public alias most code uses. Two names exist purely so
// CarriedPart in protocol.ts can refer to the type without an
// import cycle.
export type AttachmentInstance = AttachmentInstanceFwd;

const TIER_ROLL_SCALE: Record<PartTier, number> = {
  Mk1: 0.5,
  Mk2: 0.7,
  Mk3: 0.85,
  Mk4: 1.0,
  Alien: 1.2,
};

let _nextAttachmentId = 1;
function nextAttachmentInstanceId(): string {
  return `att${_nextAttachmentId++}`;
}

// Roll a fresh AttachmentInstance for a class. tier scales the roll
// magnitude. Stats whose class has no range entry come back as 0
// (so the resulting effect equals the def's base effect exactly).
export function rollAttachmentInstance(
  defId: string,
  tier: PartTier = 'Mk1'
): AttachmentInstance {
  const ranges = ATTACHMENT_STAT_RANGES[defId] ?? {};
  const scale = TIER_ROLL_SCALE[tier] ?? 1;
  const rolls: Record<string, number> = {};
  for (const [k, range] of Object.entries(ranges)) {
    if (!range) continue;
    const [lo, hi] = range as [number, number];
    const t = Math.random();
    rolls[k] = (lo + t * (hi - lo)) * scale;
  }
  return {
    id: nextAttachmentInstanceId(),
    defId,
    tier,
    rolls: rolls as AttachmentInstance['rolls'],
  };
}

// Effective WeaponEffect for an instance — base def effect plus
// rolled deltas. Returns a fully-populated WeaponEffect (every
// stat present, sensible defaults).
export function attachmentInstanceWeaponEffect(
  instance: AttachmentInstance
): Required<WeaponEffect> {
  const def = ATTACHMENT_DEFS[instance.defId];
  const out: Required<WeaponEffect> = {
    damageMult: 1,
    fireIntervalMult: 1,
    spreadMult: 1,
    projectileSpeedAdd: 0,
  };
  if (
    def &&
    (def.kind === 'weapon_mod' || def.kind === 'weapon_affix')
  ) {
    out.damageMult = def.effect.damageMult ?? 1;
    out.fireIntervalMult = def.effect.fireIntervalMult ?? 1;
    out.spreadMult = def.effect.spreadMult ?? 1;
    out.projectileSpeedAdd = def.effect.projectileSpeedAdd ?? 0;
  }
  const r = instance.rolls as Partial<Record<string, number>>;
  if (r.damageMultBonus) out.damageMult += r.damageMultBonus;
  if (r.fireIntervalMultBonus) out.fireIntervalMult *= 1 + r.fireIntervalMultBonus;
  if (r.spreadMultBonus) out.spreadMult *= 1 + r.spreadMultBonus;
  if (r.projectileSpeedAddBonus) out.projectileSpeedAdd += r.projectileSpeedAddBonus;
  return out;
}

// Effective SuitEffect for a suit-affix instance. Same shape, just
// the suit-side fields.
export function attachmentInstanceSuitEffect(
  instance: AttachmentInstance
): Required<SuitEffect> {
  const def = ATTACHMENT_DEFS[instance.defId];
  const out: Required<SuitEffect> = {
    hpBonus: 0,
    shieldBonus: 0,
    staminaMaxBonus: 0,
    staminaRegenBonus: 0,
    moveSpeedMult: 0,
  };
  if (def && def.kind === 'suit_affix') {
    out.hpBonus = def.effect.hpBonus ?? 0;
    out.shieldBonus = def.effect.shieldBonus ?? 0;
    out.staminaMaxBonus = def.effect.staminaMaxBonus ?? 0;
    out.staminaRegenBonus = def.effect.staminaRegenBonus ?? 0;
    out.moveSpeedMult = def.effect.moveSpeedMult ?? 0;
  }
  const r = instance.rolls as Partial<Record<string, number>>;
  if (r.hpBonusAdd) out.hpBonus += r.hpBonusAdd;
  if (r.shieldBonusAdd) out.shieldBonus += r.shieldBonusAdd;
  if (r.staminaMaxBonusAdd) out.staminaMaxBonus += r.staminaMaxBonusAdd;
  if (r.staminaRegenBonusAdd) out.staminaRegenBonus += r.staminaRegenBonusAdd;
  if (r.moveSpeedMultBonus) out.moveSpeedMult += r.moveSpeedMultBonus;
  return out;
}

// Display name for an instance. Bare class name (e.g. "Compensator")
// at Mk1 — keeps the early game readable. Mk2+ wraps with a
// deterministic flavored prefix from the cyberpunk pool seeded by
// instance id, so "Photon Compensator", "Razorback Compensator",
// etc. read as distinct rolls without us authoring per-instance
// names.
export function attachmentInstanceName(
  instance: AttachmentInstance
): string {
  const def = ATTACHMENT_DEFS[instance.defId];
  const base = def?.displayName ?? instance.defId;
  if (instance.tier === 'Mk1') return base;
  // Defer the actual flavor wrapper to the consumer (display layer
  // imports flavoredItemName from itemNames). We just signal "wrap
  // it" by returning the flavor seed alongside the base; full
  // composition lives in attachmentDisplayName.
  return base;
}

// Display name for an attachment. Pass an instance for the
// per-roll name (Mk1 = bare noun, Mk2+ flavor-wrapped); pass a
// raw defId to render the class noun without a roll. Sprint C
// kept the dual signature so legacy callers (blueprint listings,
// recipe outputs that haven't been crafted yet) still work.
export function attachmentDisplayName(
  arg: string | AttachmentInstance
): string {
  if (typeof arg === 'string') {
    const def = ATTACHMENT_DEFS[arg];
    return def?.displayName ?? arg;
  }
  const def = ATTACHMENT_DEFS[arg.defId];
  const base = def?.displayName ?? arg.defId;
  if (arg.tier === 'Mk1') return base;
  return flavoredItemName(arg.id, base);
}

// Aggregate every imbue (status-effect-on-hit) defined by mods
// attached to this weapon. Server stamps each into the projectile
// metadata so the on-hit handler can apply the effect to whatever
// the projectile lands on. Multiple imbues stack (a Pyro + Frost
// build burns AND chills) — server applies each independently.
export function computeWeaponImbues(weapon: WeaponItem): Array<{
  kind: 'burn_dps' | 'poison_dps' | 'slow_pct';
  magnitude: number;
  durationMs: number;
  label: string;
}> {
  const out: Array<{
    kind: 'burn_dps' | 'poison_dps' | 'slow_pct';
    magnitude: number;
    durationMs: number;
    label: string;
  }> = [];
  for (const mod of weapon.mods) {
    const def = ATTACHMENT_DEFS[mod.defId];
    if (def && def.kind === 'weapon_mod' && def.imbue) {
      out.push({ ...def.imbue });
    }
  }
  return out;
}

// Map PartTier (which is what AttachmentInstance.tier is) to a
// numeric scalar so we can compare against WeaponTier (1–4) for
// tier-mismatch math. Alien is treated as tier 5 — it's the
// top-end attachment tier with no equivalent weapon chassis tier.
function tierToNumber(t: PartTier): number {
  switch (t) {
    case 'Mk1':
      return 1;
    case 'Mk2':
      return 2;
    case 'Mk3':
      return 3;
    case 'Mk4':
      return 4;
    case 'Alien':
      return 5;
  }
}

// Phase 2.3 tier-mismatch scale. Returns a multiplier in [0.8, 1.0]
// that scales an attachment instance's deviation from the neutral
// effect (1.0 for multipliers, 0 for additive). Same direction
// either way — a Mk4 attachment on a T1 weapon is penalised
// because the chassis can't house the precision; a Mk1 attachment
// on a T4 weapon is also penalised because the precision chassis
// expects matching parts. Magnitude: 5% per tier delta, capped so
// even a delta-4 mismatch (Alien on T1) keeps 80% effectiveness.
// A strong roll still beats no attachment.
export function tierMismatchScale(
  attachmentTier: PartTier,
  weaponTier: WeaponTier
): number {
  const delta = Math.abs(tierToNumber(attachmentTier) - weaponTier);
  return Math.max(0.8, 1 - delta * 0.05);
}

// Suit-side equivalent — both sides are PartTier. Same magnitude
// curve as the weapon version. Used by the Phase 2.5 Suit Assembly
// Bench: a Mk4 Hardened Plating attachment on a Mk1 plating part
// is penalised the same way a Mk4 weapon mod on a T1 weapon is.
export function suitTierMismatchScale(
  attachmentTier: PartTier,
  partTier: PartTier
): number {
  const delta = Math.abs(
    tierToNumber(attachmentTier) - tierToNumber(partTier)
  );
  return Math.max(0.8, 1 - delta * 0.05);
}

// How many crafted suit_affix attachments a part of a given tier
// can hold. Mirrors weapon piece-slot tiering: low tiers expose
// fewer slots so a Mk1 plating can't run a stack of buffs the same
// way an Alien plating can. Phase 2.5 introduces the slot grid in
// the Suit Assembly Bench.
export const SUIT_ATTACHMENT_SLOTS: Record<PartTier, number> = {
  Mk1: 1,
  Mk2: 2,
  Mk3: 3,
  Mk4: 4,
  Alien: 4,
};

// Apply a tier-mismatch scale to a resolved weapon effect, taking
// each multiplier's deviation from neutral (1.0 for *Mult, 0 for
// projectileSpeedAdd) and shrinking it toward neutral by `scale`.
// scale = 1 → no change; scale = 0.8 → 80% as effective.
function scaleWeaponEffect(
  eff: Required<WeaponEffect>,
  scale: number
): Required<WeaponEffect> {
  return {
    damageMult: 1 + (eff.damageMult - 1) * scale,
    fireIntervalMult: 1 + (eff.fireIntervalMult - 1) * scale,
    spreadMult: 1 + (eff.spreadMult - 1) * scale,
    projectileSpeedAdd: eff.projectileSpeedAdd * scale,
  };
}

// Combine a weapon's frame + piece-affix + mod effects into a single
// resolved multiplier set. Server uses this when firing to scale base
// WEAPON_STATS. Each attachment's effect is scaled by its tier-
// mismatch with the weapon (Phase 2.3) before merging.
export function computeWeaponEffect(weapon: WeaponItem): Required<WeaponEffect> {
  const out: Required<WeaponEffect> = {
    damageMult: 1,
    fireIntervalMult: 1,
    spreadMult: 1,
    projectileSpeedAdd: 0,
  };
  for (const piece of Object.values(weapon.pieces)) {
    if (!piece) continue;
    const def = ATTACHMENT_DEFS[piece.defId];
    if (!def || def.kind !== 'weapon_affix') continue;
    const raw = attachmentInstanceWeaponEffect(piece);
    const eff = scaleWeaponEffect(
      raw,
      tierMismatchScale(piece.tier, weapon.tier)
    );
    out.damageMult *= eff.damageMult;
    out.fireIntervalMult *= eff.fireIntervalMult;
    out.spreadMult *= eff.spreadMult;
    out.projectileSpeedAdd += eff.projectileSpeedAdd;
  }
  for (const mod of weapon.mods) {
    const def = ATTACHMENT_DEFS[mod.defId];
    if (!def || def.kind !== 'weapon_mod') continue;
    const raw = attachmentInstanceWeaponEffect(mod);
    const eff = scaleWeaponEffect(
      raw,
      tierMismatchScale(mod.tier, weapon.tier)
    );
    out.damageMult *= eff.damageMult;
    out.fireIntervalMult *= eff.fireIntervalMult;
    out.spreadMult *= eff.spreadMult;
    out.projectileSpeedAdd += eff.projectileSpeedAdd;
  }
  return out;
}

// ---------- creative-name pools ----------
// Display names for dropped CarriedParts. The slot + tier and (for
// weapon parts) weapon class pick a pool; the part's id-hash picks
// a deterministic entry so the same part always reads as the same
// "thing" without needing an extra wire field.

const SUIT_PART_NAMES: Record<SuitSlotKind, string[]> = {
  chassis: [
    'Carapace Frame',
    'Battle Harness',
    'Skirmisher Rig',
    'Praetor Shell',
    'Exo-Skeleton',
    'Bulwark Chassis',
  ],
  plating: [
    'Aegis Plating',
    'Hardweave Vest',
    'Cataphract Plate',
    'Sentinel Mail',
    'Bulwark Mesh',
    'Stormsteel Lamellar',
  ],
  life_support: [
    'Pneumatic Rig',
    'Pulmoflex Unit',
    'Suspirator Pack',
    'Vital Loop',
    'Cyclic Bellows',
    'Aerogel Lung',
  ],
  utility_mod: [
    'Servo Pack',
    'Kinetic Weave',
    'Velocity Mesh',
    'Sprintwire Module',
    'Reflex Loom',
    'Gait Optimiser',
  ],
  cargo_grid: [
    'Cargo Lattice',
    'Loadout Grid',
    'Quartermaster Mesh',
    'Stowage Webbing',
    'Field Pack',
  ],
};

const WEAPON_PART_BASE_NAMES: Record<
  'barrel' | 'frame' | 'grip' | 'magazine' | 'weapon_mod',
  string[]
> = {
  barrel: [
    'Smoothbore',
    'Helical Bore',
    'Gauss Tube',
    'Coilstave',
    'Tracker Barrel',
    'Recoilless Bore',
  ],
  frame: [
    'Skeletal Frame',
    'Reinforced Chassis',
    'Field-Tempered Frame',
    'Voidsteel Spine',
    'Resonant Frame',
  ],
  grip: [
    'Thermogel Grip',
    'Ratchet Grip',
    'Servo Grip',
    'Stabilizer Grip',
    'Recoil-Dampened Grip',
  ],
  magazine: [
    'Hopper Mag',
    'Drum Mag',
    'Recursive Mag',
    'Linkfeed',
    'Cyclone Mag',
  ],
  weapon_mod: [
    'Stabilizer',
    'Targeting Auspex',
    'Recoil Damper',
    'Auxiliary Module',
    'Aim Assistor',
  ],
};

const WEAPON_CLASS_PREFIX: Record<string, string> = {
  pistol: 'Sidearm',
  smg: 'Burstfire',
  rifle: 'Marksman',
  shotgun: 'Sweeper',
  sniper: 'Longeye',
  heavy: 'Heavy',
  energy: 'Phase',
};

// Tier labels for dropped parts. The bottom tier reads as raw scrap
// quality; Military is reserved for the Alien (top) tier so it's an
// unmistakable upgrade. Mirrors WEAPON_TIER_LABEL below.
export const PART_TIER_LABEL: Record<PartTier, string> = {
  Mk1: 'Junk',
  Mk2: 'Rusty',
  Mk3: 'Standard',
  Mk4: 'Precision',
  Alien: 'Military',
};

// Same idea for crafted weapons, which have a smaller [1..4] tier
// space (no "Alien" tier on weapons). Military is unused here for
// now — drops in if/when a T5 weapon tier ships.
export const WEAPON_TIER_LABEL: Record<WeaponTier, string> = {
  1: 'Junk',
  2: 'Rusty',
  3: 'Standard',
  4: 'Precision',
};

// Friendly weapon-family titles (capitalised, for display). Helps
// the Borderlands-style name composer ("Standard Steady Shotgun").
const WEAPON_DISPLAY: Record<WeaponKind, string> = {
  pistol: 'Pistol',
  smg: 'SMG',
  shotgun: 'Shotgun',
  rifle: 'Rifle',
  sniper: 'Sniper',
  heavy: 'Heavy',
  energy: 'Carbine',
  knife: 'Knife',
  sword: 'Sword',
  hammer: 'Hammer',
  energy_blade: 'Energy Blade',
};

// The bottom tier ("Junk") gets no flavor prefix on dropped parts —
// it should read as a basic scrap noun. Higher tiers get a cyberpunk
// adjective from the deterministic pool in `itemNames.ts`.
const TIERS_WITHOUT_FLAVOR_PREFIX = new Set<PartTier>(['Mk1']);

// Stable string-hash used to pick a name from a pool deterministically
// from a part id. Same part always reads as the same item.
function hashId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// The "core" of a part name — tier + class prefix (for weapon parts)
// + a deterministic base noun from the slot's pool. The cyberpunk
// flavor prefix wraps this for tier ≥ Mk2.
function partCoreName(part: CarriedPart): string {
  const tier = PART_TIER_LABEL[part.tier] ?? part.tier;
  if (isSuitPart(part.slot)) {
    const pool = SUIT_PART_NAMES[part.slot as SuitSlotKind];
    const base = pool[hashId(part.id) % pool.length] ?? part.slot;
    return `${tier} ${base}`;
  }
  const isWeaponPart =
    part.slot === 'barrel' ||
    part.slot === 'frame' ||
    part.slot === 'grip' ||
    part.slot === 'magazine' ||
    part.slot === 'weapon_mod';
  if (isWeaponPart) {
    const pool =
      WEAPON_PART_BASE_NAMES[
        part.slot as 'barrel' | 'frame' | 'grip' | 'magazine' | 'weapon_mod'
      ];
    const base = pool[hashId(part.id) % pool.length] ?? part.slot;
    const cls = part.weaponClass
      ? WEAPON_CLASS_PREFIX[part.weaponClass] ?? part.weaponClass
      : '';
    return cls ? `${tier} ${cls} ${base}` : `${tier} ${base}`;
  }
  return `${tier} ${part.slot}`;
}

// Full display name for a dropped part. Deterministic on part.id so
// the same part always reads as the same name across sessions /
// clients.
//   Mk1 (Junk)  → "Junk Carapace Plate"
//   Mk2+ (rest) → "Razorback Rusty Marksman Helical Bore"
export function partDisplayName(part: CarriedPart): string {
  const core = partCoreName(part);
  if (TIERS_WITHOUT_FLAVOR_PREFIX.has(part.tier)) return core;
  return flavoredItemName(part.id, core);
}

// Borderlands-style weapon name. Adjectives come from attached mods
// + piece affixes; capped at 3 so a fully-built rifle doesn't read
// as a tongue-twister. Bare weapons just read as the tier + family.
//   T1 bare       → "Junk Pistol"
//   T2 + foregrip → "Rusty Steady Shotgun"
//   T3 + 4 mods   → "Standard Steady Vented Brutal Rifle"
const MAX_WEAPON_ADJECTIVES = 3;
const PIECE_ORDER: WeaponPieceKind[] = ['frame', 'grip', 'magazine', 'barrel'];

export function weaponDisplayName(weapon: WeaponItem): string {
  const tier = WEAPON_TIER_LABEL[weapon.tier] ?? `T${weapon.tier}`;
  const family = WEAPON_DISPLAY[weapon.weaponId] ?? weapon.weaponId;
  const adjectives: string[] = [];
  for (const piece of PIECE_ORDER) {
    const a = weapon.pieces[piece];
    if (!a) continue;
    const def = ATTACHMENT_DEFS[a.id];
    if (def && 'adjective' in def && def.adjective) {
      adjectives.push(def.adjective);
    }
  }
  for (const mod of weapon.mods) {
    const def = ATTACHMENT_DEFS[mod.id];
    if (def && 'adjective' in def && def.adjective) {
      adjectives.push(def.adjective);
    }
  }
  const trimmed = adjectives.slice(0, MAX_WEAPON_ADJECTIVES);
  return [tier, ...trimmed, family].join(' ');
}

export function affixIdsForSlot(slot: PartSlot): string[] {
  const out: string[] = [];
  for (const id of Object.keys(AFFIX_DEFS)) {
    if (AFFIX_DEFS[id].validSlots.includes(slot)) out.push(id);
  }
  return out;
}

// Server loot roller calls this. Pure function so client can mirror for
// previews if useful later.
export function rollAffixesForPart(
  slot: PartSlot,
  tier: PartTier,
  count: number,
  rand: () => number = Math.random
): Affix[] {
  if (count <= 0) return [];
  const pool = affixIdsForSlot(slot);
  if (pool.length === 0) return [];
  const tierMult = TIER_MULT[tier];
  const out: Affix[] = [];
  for (let i = 0; i < count; i++) {
    const def = AFFIX_DEFS[pool[Math.floor(rand() * pool.length)]];
    const rolled =
      def.minRoll + rand() * (def.maxRoll - def.minRoll);
    out.push({ id: def.id, value: rolled * tierMult });
  }
  return out;
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

// Resize an inventory in place. Cargo grid grants extra bag slots —
// when equipped, target = INVENTORY_SIZE + inventoryBonus and we pad
// with empties. When unequipped, we only shrink down to the last
// non-empty index so items in expanded slots aren't deleted (caller
// can re-equip a cargo grid to recover the headroom). Hotbar
// (first HOTBAR_SIZE) is always preserved.
export function resizeInventory(inv: Inventory, target: number): void {
  const want = Math.max(INVENTORY_SIZE, Math.floor(target));
  if (inv.length === want) return;
  if (inv.length < want) {
    while (inv.length < want) inv.push({ ...EMPTY });
    return;
  }
  // Shrinking: never below INVENTORY_SIZE, never below the last
  // non-empty slot.
  let lastUsed = inv.length - 1;
  while (lastUsed >= INVENTORY_SIZE && inv[lastUsed].kind === 'empty') {
    lastUsed--;
  }
  const safe = Math.max(want, lastUsed + 1, INVENTORY_SIZE);
  inv.length = safe;
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
// Pull a slot's contents out of the inventory and return them as a
// detached InventorySlot value. `all=true` empties the slot wholesale;
// `all=false` decrements stackable kinds by 1 (or empties non-stackables).
// Returns null if the slot is empty. Mirrors discardSlot's count
// semantics so drop/give and discard behave identically.
export function takeFromSlot(
  inv: Inventory,
  slot: number,
  all: boolean
): InventorySlot | null {
  if (slot < 0 || slot >= inv.length) return null;
  const s = inv[slot];
  if (s.kind === 'empty') return null;

  // Attachments are unique-instance (no count) so the "take 1"
  // branch can't apply to them; only the count-bearing kinds need
  // a partial-take path.
  const isStackable =
    s.kind === 'material' ||
    s.kind === 'ammo' ||
    s.kind === 'placeable' ||
    s.kind === 'consumable' ||
    s.kind === 'upgrade';

  if (!all && isStackable && (s as { count: number }).count > 1) {
    (s as { count: number }).count -= 1;
    if (s.kind === 'material') {
      return { kind: 'material', materialId: s.materialId, count: 1 };
    }
    if (s.kind === 'ammo') {
      return { kind: 'ammo', ammoId: s.ammoId, count: 1 };
    }
    if (s.kind === 'placeable') {
      return { kind: 'placeable', buildingKind: s.buildingKind, count: 1 };
    }
    if (s.kind === 'consumable') {
      return { kind: 'consumable', consumableId: s.consumableId, count: 1 };
    }
    if (s.kind === 'upgrade') {
      return { kind: 'upgrade', upgradeId: s.upgradeId, count: 1 };
    }
  }

  // Take the whole slot; clone the value before clearing so callers
  // hold their own copy.
  const taken: InventorySlot = JSON.parse(JSON.stringify(s));
  inv[slot] = { kind: 'empty' };
  return taken;
}

// Generic dispatcher for "place this slot into the inventory" —
// routes to the right add* helper by kind. Used by ground-loot
// pickup of dropped slots and give-to-player transfers. Returns
// true if anything landed; for stackable kinds with leftover, the
// caller is responsible for re-spawning the leftover (the underlying
// helpers report leftovers individually).
export function addInventorySlotToInventory(
  inv: Inventory,
  slot: InventorySlot
): boolean {
  switch (slot.kind) {
    case 'empty':
      return false;
    case 'material':
      return addMaterial(inv, slot.materialId, slot.count) < slot.count;
    case 'ammo':
      return addAmmo(inv, slot.ammoId, slot.count) < slot.count;
    case 'placeable':
      return addPlaceable(inv, slot.buildingKind, slot.count) < slot.count;
    case 'weapon':
      return addWeapon(inv, slot.weapon);
    case 'attachment':
      // Unique instance — pass the AttachmentInstance through so
      // its rolled stats survive the round-trip.
      return addAttachment(inv, slot.instance);
    case 'consumable':
      return addConsumable(inv, slot.consumableId, slot.count);
    case 'upgrade':
      return addUpgrade(inv, slot.upgradeId, slot.count);
    case 'part':
      return addPart(inv, slot.part);
  }
}

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

export function addWeapon(inv: Inventory, weapon: WeaponItem): boolean {
  const i = findEmptySlot(inv);
  if (i < 0) return false;
  inv[i] = { kind: 'weapon', weapon };
  return true;
}

export function countWeapons(inv: Inventory, weaponId: WeaponKind): number {
  let n = 0;
  for (const s of inv) {
    if (s.kind === 'weapon' && s.weapon.weaponId === weaponId) n++;
  }
  return n;
}

// Consume `count` weapons of the given id from inventory. Used by
// "weapon-as-component" recipes (e.g. shotgun turret eats a shotgun).
// Returns true on success, false if the player doesn't have enough.
export function consumeWeapons(
  inv: Inventory,
  weaponId: WeaponKind,
  count = 1
): boolean {
  if (countWeapons(inv, weaponId) < count) return false;
  let remaining = count;
  for (let i = 0; i < inv.length && remaining > 0; i++) {
    const s = inv[i];
    if (s.kind !== 'weapon' || s.weapon.weaponId !== weaponId) continue;
    inv[i] = { kind: 'empty' };
    remaining--;
  }
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
// Generic two-array slot swap with stack-merging. Used for inventory ↔
// storage chest moves; same merge rules as swapSlots within one inv.
// Returns true if anything changed.
export function swapSlotsBetween(
  src: InventorySlot[],
  srcIdx: number,
  dst: InventorySlot[],
  dstIdx: number
): boolean {
  if (src === dst && srcIdx === dstIdx) return false;
  if (
    srcIdx < 0 ||
    dstIdx < 0 ||
    srcIdx >= src.length ||
    dstIdx >= dst.length
  ) {
    return false;
  }
  const a = src[srcIdx];
  const b = dst[dstIdx];

  if (
    a.kind === 'material' &&
    b.kind === 'material' &&
    a.materialId === b.materialId
  ) {
    b.count += a.count;
    src[srcIdx] = { kind: 'empty' };
    return true;
  }
  if (a.kind === 'ammo' && b.kind === 'ammo' && a.ammoId === b.ammoId) {
    b.count += a.count;
    src[srcIdx] = { kind: 'empty' };
    return true;
  }
  if (
    a.kind === 'placeable' &&
    b.kind === 'placeable' &&
    a.buildingKind === b.buildingKind
  ) {
    b.count += a.count;
    src[srcIdx] = { kind: 'empty' };
    return true;
  }
  // Attachments never merge (every instance is unique). Fall through
  // to the swap branch so dragging stacks them but doesn't fuse them.
  if (
    a.kind === 'consumable' &&
    b.kind === 'consumable' &&
    a.consumableId === b.consumableId
  ) {
    b.count += a.count;
    src[srcIdx] = { kind: 'empty' };
    return true;
  }
  if (
    a.kind === 'upgrade' &&
    b.kind === 'upgrade' &&
    a.upgradeId === b.upgradeId
  ) {
    b.count += a.count;
    src[srcIdx] = { kind: 'empty' };
    return true;
  }
  src[srcIdx] = b;
  dst[dstIdx] = a;
  return true;
}

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
  // Attachments are unique-instance — never merge.
  if (
    a.kind === 'consumable' &&
    b.kind === 'consumable' &&
    a.consumableId === b.consumableId
  ) {
    b.count += a.count;
    inv[from] = { ...EMPTY };
    return true;
  }
  if (
    a.kind === 'upgrade' &&
    b.kind === 'upgrade' &&
    a.upgradeId === b.upgradeId
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
    (s.kind === 'material' ||
      s.kind === 'ammo' ||
      s.kind === 'placeable' ||
      s.kind === 'consumable' ||
      s.kind === 'upgrade') &&
    s.count > 1
  ) {
    s.count -= 1;
    return true;
  }
  inv[slot] = { ...EMPTY };
  return true;
}

export function findConsumableSlot(
  inv: Inventory,
  consumableId: ConsumableKind
): number {
  for (let i = 0; i < inv.length; i++) {
    const s = inv[i];
    if (s.kind === 'consumable' && s.consumableId === consumableId) return i;
  }
  return -1;
}

export function addConsumable(
  inv: Inventory,
  consumableId: ConsumableKind,
  count = 1
): boolean {
  if (count <= 0) return true;
  const existing = findConsumableSlot(inv, consumableId);
  if (existing >= 0) {
    const s = inv[existing];
    if (s.kind === 'consumable') {
      s.count += count;
      return true;
    }
  }
  const empty = findEmptySlot(inv);
  if (empty < 0) return false;
  inv[empty] = { kind: 'consumable', consumableId, count };
  return true;
}

export function consumeConsumable(
  inv: Inventory,
  slotIdx: number
): ConsumableKind | null {
  const s = inv[slotIdx];
  if (!s || s.kind !== 'consumable' || s.count <= 0) return null;
  const id = s.consumableId;
  s.count -= 1;
  if (s.count <= 0) inv[slotIdx] = { kind: 'empty' };
  return id;
}

// Workstation upgrade item helpers. Stack like consumables.
export function findUpgradeSlot(
  inv: Inventory,
  upgradeId: UpgradeKind
): number {
  for (let i = 0; i < inv.length; i++) {
    const s = inv[i];
    if (s.kind === 'upgrade' && s.upgradeId === upgradeId) return i;
  }
  return -1;
}

export function countUpgrade(
  inv: Inventory,
  upgradeId: UpgradeKind
): number {
  let total = 0;
  for (const s of inv) {
    if (s.kind === 'upgrade' && s.upgradeId === upgradeId) total += s.count;
  }
  return total;
}

export function addUpgrade(
  inv: Inventory,
  upgradeId: UpgradeKind,
  count = 1
): boolean {
  if (count <= 0) return true;
  const existing = findUpgradeSlot(inv, upgradeId);
  if (existing >= 0) {
    const s = inv[existing];
    if (s.kind === 'upgrade') {
      s.count += count;
      return true;
    }
  }
  const empty = findEmptySlot(inv);
  if (empty < 0) return false;
  inv[empty] = { kind: 'upgrade', upgradeId, count };
  return true;
}

export function consumeUpgrade(
  inv: Inventory,
  upgradeId: UpgradeKind,
  amount = 1
): boolean {
  if (countUpgrade(inv, upgradeId) < amount) return false;
  let remaining = amount;
  for (let i = 0; i < inv.length && remaining > 0; i++) {
    const s = inv[i];
    if (s.kind !== 'upgrade' || s.upgradeId !== upgradeId) continue;
    const take = Math.min(s.count, remaining);
    s.count -= take;
    remaining -= take;
    if (s.count <= 0) inv[i] = { kind: 'empty' };
  }
  return true;
}

export function findAttachmentSlot(inv: Inventory, defId: string): number {
  for (let i = 0; i < inv.length; i++) {
    const s = inv[i];
    if (s.kind === 'attachment' && s.instance.defId === defId) return i;
  }
  return -1;
}

// Place an attachment in the first empty inventory slot. Accepts
// either a full AttachmentInstance (use as-is) or a defId string
// (roll a fresh instance at the given tier — convenient for legacy
// callers and recipe outputs that don't pre-roll). Attachments do
// not stack now that every instance is unique; multiple of the
// same class take separate slots.
export function addAttachment(
  inv: Inventory,
  instanceOrDefId: AttachmentInstance | string,
  tierIfRolling: PartTier = 'Mk1',
  count = 1
): boolean {
  if (count <= 0) return true;
  for (let n = 0; n < count; n++) {
    const empty = findEmptySlot(inv);
    if (empty < 0) return false;
    const instance: AttachmentInstance =
      typeof instanceOrDefId === 'string'
        ? rollAttachmentInstance(instanceOrDefId, tierIfRolling)
        : n === 0
          ? instanceOrDefId
          : rollAttachmentInstance(instanceOrDefId.defId, instanceOrDefId.tier);
    inv[empty] = { kind: 'attachment', instance };
  }
  return true;
}

// Remove one attachment of the given class from the inventory and
// return its instance (so callers attaching to a weapon piece /
// suit slot keep the rolled stats). Returns null if no slot of
// that class is found.
export function consumeAttachment(
  inv: Inventory,
  defId: string
): AttachmentInstance | null {
  const i = findAttachmentSlot(inv, defId);
  if (i < 0) return null;
  const s = inv[i];
  if (s.kind !== 'attachment') return null;
  const taken = s.instance;
  inv[i] = { kind: 'empty' };
  return taken;
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

  // First, collapse stackables by id across the bag. Attachments
  // are unique-instance now, so they ride along with weapons / parts
  // in the `others` bucket — we just sort them by class so multiple
  // of the same Compensator end up adjacent in the bag.
  type Stack = {
    ammo: Map<string, number>;
    material: Map<string, number>;
    placeable: Map<string, number>;
    consumable: Map<string, number>;
    upgrade: Map<string, number>;
  };
  const stacks: Stack = {
    ammo: new Map(),
    material: new Map(),
    placeable: new Map(),
    consumable: new Map(),
    upgrade: new Map(),
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
    } else if (s.kind === 'consumable') {
      stacks.consumable.set(
        s.consumableId,
        (stacks.consumable.get(s.consumableId) ?? 0) + s.count
      );
    } else if (s.kind === 'upgrade') {
      stacks.upgrade.set(
        s.upgradeId,
        (stacks.upgrade.get(s.upgradeId) ?? 0) + s.count
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
      case 'attachment':
        return 4;
      case 'consumable':
        return 5;
      case 'upgrade':
        return 6;
      case 'part':
        return 7;
      default:
        return 99;
    }
  };

  // Sub-order for attachments so instances of the same class cluster.
  const attachmentTieBreaker = (s: InventorySlot): string =>
    s.kind === 'attachment' ? s.instance.defId : '';

  const rebuilt: InventorySlot[] = [];
  // Re-emit non-stackables in category order; attachments cluster
  // by class within the attachment bucket.
  others.sort((x, y) => {
    const d = order(x) - order(y);
    if (d !== 0) return d;
    return attachmentTieBreaker(x).localeCompare(attachmentTieBreaker(y));
  });
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
  // Then consumables.
  for (const [id, count] of stacks.consumable) {
    rebuilt.push({
      kind: 'consumable',
      consumableId: id as ConsumableKind,
      count,
    });
  }
  // Then upgrades — bench upgrades cluster after consumables.
  for (const [id, count] of stacks.upgrade) {
    rebuilt.push({
      kind: 'upgrade',
      upgradeId: id as UpgradeKind,
      count,
    });
  }
  // Pad to original tail length.
  while (rebuilt.length < tail.length) rebuilt.push({ ...EMPTY });

  for (let i = 0; i < HOTBAR_SIZE; i++) inv[i] = head[i];
  for (let i = 0; i < tail.length; i++) inv[HOTBAR_SIZE + i] = rebuilt[i];
}
