import type {
  CarriedPart,
  PartSlot,
  PartTier,
  WeaponClass,
} from '@dumrunner/shared';
import { rollAffixesForPart } from '@dumrunner/shared';

// Roll a part-style drop on enemy kill. Slot, tier, and affix count are sampled
// from the GDD's ontology; concrete stat values are deferred until crafting /
// equipping lands. Drop IDs are process-unique strings — the part instance only
// needs to round-trip through the wire once before it lives in inventory.

const ALL_SLOTS: PartSlot[] = [
  'barrel', 'frame', 'grip', 'magazine', 'weapon_mod',
  'chassis', 'plating', 'life_support', 'utility_mod', 'cargo_grid',
];

const CLASS_LOCKED_SLOTS = new Set<PartSlot>([
  'barrel', 'frame', 'grip', 'magazine',
]);

const ALL_CLASSES: WeaponClass[] = [
  'pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'heavy', 'energy',
];

// Baseline tier weights for a "regular" enemy. Beefier enemies bias these
// toward higher tiers via killTierBias.
type TierWeights = Record<Exclude<PartTier, 'Alien'>, number>;
const BASELINE_WEIGHTS: TierWeights = { Mk1: 60, Mk2: 30, Mk3: 8, Mk4: 2 };

// Tier-gated affix count, with a small chance of +1 (per GDD).
const AFFIX_BASELINE: Record<PartTier, number> = {
  Mk1: 0, Mk2: 1, Mk3: 2, Mk4: 3, Alien: 4,
};
const AFFIX_BONUS_CHANCE = 0.1;

let _nextDropId = 0;
function nextDropId(): string {
  return `l${_nextDropId++}`;
}

function rollSlot(): PartSlot {
  return ALL_SLOTS[Math.floor(Math.random() * ALL_SLOTS.length)];
}

function rollTier(weights: TierWeights): PartTier {
  const total = weights.Mk1 + weights.Mk2 + weights.Mk3 + weights.Mk4;
  let r = Math.random() * total;
  if ((r -= weights.Mk1) < 0) return 'Mk1';
  if ((r -= weights.Mk2) < 0) return 'Mk2';
  if ((r -= weights.Mk3) < 0) return 'Mk3';
  return 'Mk4';
}

function rollAffixCount(tier: PartTier): number {
  const base = AFFIX_BASELINE[tier];
  return Math.random() < AFFIX_BONUS_CHANCE ? base + 1 : base;
}

function rollClass(): WeaponClass {
  return ALL_CLASSES[Math.floor(Math.random() * ALL_CLASSES.length)];
}

// killTierBias = small int (0..4); each step nudges weights toward higher tiers.
// Surface-map rough mapping: dummies=0, chasers/drones=1, brutes=2.
export function rollDropsForKill(killTierBias: number): CarriedPart[] {
  const weights: TierWeights = { ...BASELINE_WEIGHTS };
  for (let i = 0; i < killTierBias; i++) {
    weights.Mk1 = Math.max(5, weights.Mk1 - 12);
    weights.Mk2 += 6;
    weights.Mk3 += 4;
    weights.Mk4 += 2;
  }

  // ~5% chance of a part drop per kill. Gear drops are the rare prize;
  // material drops in the per-template lootTable carry the moment-to-
  // moment loot feedback.
  const dropCount = Math.random() < 0.05 ? 1 : 0;
  const drops: CarriedPart[] = [];
  for (let i = 0; i < dropCount; i++) {
    const slot = rollSlot();
    const tier = rollTier(weights);
    const affixCount = rollAffixCount(tier);
    drops.push({
      id: nextDropId(),
      slot,
      tier,
      weaponClass: CLASS_LOCKED_SLOTS.has(slot) ? rollClass() : null,
      affixCount,
      affixes: rollAffixesForPart(slot, tier, affixCount),
    });
  }
  return drops;
}

// killTierBias derived from a template's maxHp. Crude but stable; replace once
// templates carry an explicit `tierBias` field.
export function killTierBiasFromHp(maxHp: number): number {
  if (maxHp >= 200) return 3;
  if (maxHp >= 120) return 2;
  if (maxHp >= 70) return 1;
  return 0;
}
