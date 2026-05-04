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
  | 'rifle_rounds';

// Consumables — single-use items the player triggers from a hotbar
// slot to apply an effect (heal, buff, etc). New entries: add to the
// union AND to CONSUMABLES below.
export type ConsumableKind = 'medkit';

export type ConsumableDef = {
  id: ConsumableKind;
  name: string;
  description: string;
  // Color tint for the inventory icon.
  color: number;
  // Hp restored when used. Future variants will add other effects.
  healHp: number;
};

export const CONSUMABLES: Record<ConsumableKind, ConsumableDef> = {
  medkit: {
    id: 'medkit',
    name: 'Medkit',
    description: 'Restores 60 HP. Use from hotbar.',
    color: 0xef4444,
    healHp: 60,
  },
};
export type WeaponKind = 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'knife';

// Family groups weapons that share ammo, mod compatibility, and turret
// variants. `melee` covers the knife (no ammo, no piece-affix slots).
export type WeaponFamily = 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'melee';
export const WEAPON_FAMILY: Record<WeaponKind, WeaponFamily> = {
  pistol: 'pistol',
  smg: 'smg',
  shotgun: 'shotgun',
  rifle: 'rifle',
  knife: 'melee',
};

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

// Weapon affix instance — same shape as suit affix (id + rolled value).
// The affix definition registry (kept separate from suit affixes since
// the apply() target is different) lives in `weapon-affix.ts` once the
// content lands in commit 5; the type is open enough that both registries
// can use it.
export type WeaponAffix = {
  id: string;
  value: number;
};

// Per-weapon piece-affix map. Only entries for pieces unlocked by the
// weapon's current tier should be populated; the rest stay omitted.
export type WeaponPieces = Partial<Record<WeaponPieceKind, WeaponAffix | null>>;

export type WeaponMod = {
  id: string;
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
  | { kind: 'attachment'; defId: string; count: number }
  | { kind: 'consumable'; consumableId: ConsumableKind; count: number }
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
    // Stack rolled affix bonuses onto the same accumulator. Affixes use
    // the same units as the primary stat so they just add.
    for (const affix of part.affixes ?? []) {
      const def = AFFIX_DEFS[affix.id];
      if (def) def.apply(stats, affix.value);
    }
    // Crafted suit-affix attachments — slot independent, reads the
    // ATTACHMENT_DEFS registry and folds the effect onto the same
    // SuitStats accumulator.
    for (const attachId of part.appliedAttachments ?? []) {
      const def = ATTACHMENT_DEFS[attachId];
      if (!def || def.kind !== 'suit_affix') continue;
      stats.hpBonus += def.effect.hpBonus ?? 0;
      stats.shieldBonus += def.effect.shieldBonus ?? 0;
      stats.staminaMaxBonus += def.effect.staminaMaxBonus ?? 0;
      stats.staminaRegenBonus += def.effect.staminaRegenBonus ?? 0;
      stats.moveSpeedMult += def.effect.moveSpeedMult ?? 0;
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

export const ATTACHMENT_DEFS: Record<string, AttachmentDef> = {
  // ---- weapon mods (slot into a weapon's mod list) ----
  // Each `adjective` becomes part of the weapon's name when attached.
  // E.g. a Standard Shotgun + Foregrip + Compensator + Calibrated frame
  // reads as "Standard Steady Vented Brutal Shotgun".
  mod_foregrip: {
    kind: 'weapon_mod',
    id: 'mod_foregrip',
    displayName: 'Foregrip',
    description: '-30% spread. Best on shotguns and SMGs.',
    adjective: 'Steady',
    family: null,
    effect: { spreadMult: 0.7 },
  },
  mod_high_velocity: {
    kind: 'weapon_mod',
    id: 'mod_high_velocity',
    displayName: 'High-Velocity Barrel',
    description: '+500 px/sec projectile speed. Better tracking at range.',
    adjective: 'Hyper',
    family: null,
    effect: { projectileSpeedAdd: 500 },
  },
  mod_compensator: {
    kind: 'weapon_mod',
    id: 'mod_compensator',
    displayName: 'Compensator',
    description: '-50% spread. Tighter than a Foregrip, but louder.',
    adjective: 'Vented',
    family: null,
    effect: { spreadMult: 0.5 },
  },
  mod_stabilizer: {
    kind: 'weapon_mod',
    id: 'mod_stabilizer',
    displayName: 'Recoil Stabilizer',
    description: '+10% damage. Heavier action, harder hits.',
    adjective: 'Calibrated',
    family: null,
    effect: { damageMult: 1.10 },
  },
  mod_overclock: {
    kind: 'weapon_mod',
    id: 'mod_overclock',
    displayName: 'Overclock Module',
    description: '+18% fire rate. Burns through ammo faster.',
    adjective: 'Overclocked',
    family: null,
    effect: { fireIntervalMult: 0.85 },
  },
  mod_dampener: {
    kind: 'weapon_mod',
    id: 'mod_dampener',
    displayName: 'Recoil Dampener',
    description: '-25% spread, slight projectile speed bump.',
    adjective: 'Damped',
    family: null,
    effect: { spreadMult: 0.75, projectileSpeedAdd: 150 },
  },
  mod_armor_piercer: {
    kind: 'weapon_mod',
    id: 'mod_armor_piercer',
    displayName: 'AP Core',
    description: '+18% damage. Engineered for armoured targets.',
    adjective: 'Lance',
    family: null,
    effect: { damageMult: 1.18 },
  },
  mod_lightweight: {
    kind: 'weapon_mod',
    id: 'mod_lightweight',
    displayName: 'Lightweight Frame',
    description: '+10% fire rate, -10% damage. Faster trigger, weaker rounds.',
    adjective: 'Whisper',
    family: null,
    effect: { fireIntervalMult: 0.9, damageMult: 0.9 },
  },

  // ---- weapon affixes (slot onto a weapon piece) ----
  aff_damage_15: {
    kind: 'weapon_affix',
    id: 'aff_damage_15',
    // Clean noun phrase. Mechanical effect lives in `description`.
    displayName: 'Reinforced Frame',
    description: '+15% damage on every shot. Slots into a weapon frame.',
    adjective: 'Brutal',
    pieceKind: 'frame',
    family: null,
    effect: { damageMult: 1.15 },
    value: 0.15,
  },
  aff_firerate_25: {
    kind: 'weapon_affix',
    id: 'aff_firerate_25',
    displayName: 'Lightweight Grip',
    description: '25% faster cadence. Slots into a weapon grip.',
    adjective: 'Auto',
    pieceKind: 'grip',
    family: null,
    effect: { fireIntervalMult: 0.8 },
    value: 0.25,
  },

  // ---- suit affixes (slot onto a suit slot) ----
  aff_shield_25: {
    kind: 'suit_affix',
    id: 'aff_shield_25',
    displayName: 'Hardened Plating',
    description: '+25 max shield. Slots into a suit plating piece.',
    adjective: 'Hardplate',
    slotKind: 'plating',
    effect: { shieldBonus: 25 },
    value: 25,
  },
  aff_speed_5: {
    kind: 'suit_affix',
    id: 'aff_speed_5',
    displayName: 'Servomotor Tune',
    description: '+5% movement speed. Slots into a suit utility mod.',
    adjective: 'Servo',
    slotKind: 'utility_mod',
    effect: { moveSpeedMult: 0.05 },
    value: 0.05,
  },
};

export function listAttachments(): AttachmentDef[] {
  return Object.values(ATTACHMENT_DEFS);
}

// Display name for an attachment def. Bare noun phrase (no flavor
// wrapper) — these are crafted, fungible components, not unique
// drops. Ground-loot CarriedParts (which are unique-rolled) get the
// flavor treatment via partDisplayName instead.
export function attachmentDisplayName(defId: string): string {
  const def = ATTACHMENT_DEFS[defId];
  if (!def) return defId;
  return def.displayName;
}

// Combine a weapon's frame + piece-affix + mod effects into a single
// resolved multiplier set. Server uses this when firing to scale base
// WEAPON_STATS.
export function computeWeaponEffect(weapon: WeaponItem): Required<WeaponEffect> {
  const out: Required<WeaponEffect> = {
    damageMult: 1,
    fireIntervalMult: 1,
    spreadMult: 1,
    projectileSpeedAdd: 0,
  };
  for (const piece of Object.values(weapon.pieces)) {
    if (!piece) continue;
    const def = ATTACHMENT_DEFS[piece.id];
    if (!def || def.kind !== 'weapon_affix') continue;
    out.damageMult *= def.effect.damageMult ?? 1;
    out.fireIntervalMult *= def.effect.fireIntervalMult ?? 1;
    out.spreadMult *= def.effect.spreadMult ?? 1;
    out.projectileSpeedAdd += def.effect.projectileSpeedAdd ?? 0;
  }
  for (const mod of weapon.mods) {
    const def = ATTACHMENT_DEFS[mod.id];
    if (!def || def.kind !== 'weapon_mod') continue;
    out.damageMult *= def.effect.damageMult ?? 1;
    out.fireIntervalMult *= def.effect.fireIntervalMult ?? 1;
    out.spreadMult *= def.effect.spreadMult ?? 1;
    out.projectileSpeedAdd += def.effect.projectileSpeedAdd ?? 0;
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
  knife: 'Knife',
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

  const isStackable =
    s.kind === 'material' ||
    s.kind === 'ammo' ||
    s.kind === 'placeable' ||
    s.kind === 'attachment' ||
    s.kind === 'consumable';

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
    if (s.kind === 'attachment') {
      return { kind: 'attachment', defId: s.defId, count: 1 };
    }
    if (s.kind === 'consumable') {
      return { kind: 'consumable', consumableId: s.consumableId, count: 1 };
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
      return addAttachment(inv, slot.defId, slot.count);
    case 'consumable':
      return addConsumable(inv, slot.consumableId, slot.count);
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
  if (a.kind === 'attachment' && b.kind === 'attachment' && a.defId === b.defId) {
    b.count += a.count;
    src[srcIdx] = { kind: 'empty' };
    return true;
  }
  if (
    a.kind === 'consumable' &&
    b.kind === 'consumable' &&
    a.consumableId === b.consumableId
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
  if (
    a.kind === 'attachment' &&
    b.kind === 'attachment' &&
    a.defId === b.defId
  ) {
    b.count += a.count;
    inv[from] = { ...EMPTY };
    return true;
  }
  if (
    a.kind === 'consumable' &&
    b.kind === 'consumable' &&
    a.consumableId === b.consumableId
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
      s.kind === 'attachment' ||
      s.kind === 'consumable') &&
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

export function findAttachmentSlot(inv: Inventory, defId: string): number {
  for (let i = 0; i < inv.length; i++) {
    const s = inv[i];
    if (s.kind === 'attachment' && s.defId === defId) return i;
  }
  return -1;
}

export function addAttachment(
  inv: Inventory,
  defId: string,
  count = 1
): boolean {
  if (count <= 0) return true;
  const existing = findAttachmentSlot(inv, defId);
  if (existing >= 0) {
    const s = inv[existing];
    if (s.kind === 'attachment') {
      s.count += count;
      return true;
    }
  }
  const empty = findEmptySlot(inv);
  if (empty < 0) return false;
  inv[empty] = { kind: 'attachment', defId, count };
  return true;
}

export function consumeAttachment(
  inv: Inventory,
  defId: string,
  count = 1
): boolean {
  const i = findAttachmentSlot(inv, defId);
  if (i < 0) return false;
  const s = inv[i];
  if (s.kind !== 'attachment' || s.count < count) return false;
  s.count -= count;
  if (s.count <= 0) inv[i] = { kind: 'empty' };
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
    attachment: Map<string, number>;
    consumable: Map<string, number>;
  };
  const stacks: Stack = {
    ammo: new Map(),
    material: new Map(),
    placeable: new Map(),
    attachment: new Map(),
    consumable: new Map(),
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
    } else if (s.kind === 'attachment') {
      stacks.attachment.set(
        s.defId,
        (stacks.attachment.get(s.defId) ?? 0) + s.count
      );
    } else if (s.kind === 'consumable') {
      stacks.consumable.set(
        s.consumableId,
        (stacks.consumable.get(s.consumableId) ?? 0) + s.count
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
      case 'part':
        return 6;
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
  // Then attachments.
  for (const [defId, count] of stacks.attachment) {
    rebuilt.push({ kind: 'attachment', defId, count });
  }
  // Then consumables.
  for (const [id, count] of stacks.consumable) {
    rebuilt.push({
      kind: 'consumable',
      consumableId: id as ConsumableKind,
      count,
    });
  }
  // Pad to original tail length.
  while (rebuilt.length < tail.length) rebuilt.push({ ...EMPTY });

  for (let i = 0; i < HOTBAR_SIZE; i++) inv[i] = head[i];
  for (let i = 0; i < tail.length; i++) inv[HOTBAR_SIZE + i] = rebuilt[i];
}
