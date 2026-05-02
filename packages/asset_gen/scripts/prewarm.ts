import type { BuildingKind, PartSlot, PartTier, WeaponClass } from '@dumrunner/shared';
import { MATERIALS } from '@dumrunner/shared/inventory';
import { TEMPLATES } from '../../server/src/ai/templates.js';
import {
  buildingAssetRequest,
  enemyAssetRequest,
  materialAssetRequest,
  partAssetRequest,
  projectileAssetRequest,
} from '../src/gameRequests.js';
import type { AssetGenerateRequest } from '../src/schemas.js';

const DEFAULT_BASE_URL = process.env.ASSET_GEN_PUBLIC_BASE_URL ?? 'http://localhost:8787';
const serviceToken = process.env.ASSET_GEN_SERVICE_TOKEN ?? null;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const includeAllParts = args.has('--all-parts');

function buildRequests(options: { includeAllParts: boolean }): AssetGenerateRequest[] {
  const requestMap = new Map<string, AssetGenerateRequest>();
  for (const template of Object.values(TEMPLATES)) {
    add(requestMap, enemyAssetRequest({
      templateId: template.id,
      label: labelForEnemy(template.id),
      faction: template.faction,
      color: numberColorToHex(template.visual.color),
      radius: template.radius,
      movementKind: template.movement.kind,
      attackKinds: template.attacks.map((attack) => attack.kind),
    }));

    for (const attack of template.attacks) {
      if (attack.kind === 'projectile') {
        add(requestMap, projectileAssetRequest({
          id: `${template.id}_projectile`,
          label: `${labelForEnemy(template.id)} projectile`,
          color: numberColorToHex(attack.projectileColor ?? 0xffffff),
        }));
      }
    }
  }

  for (const materialId of Object.keys(MATERIALS) as (keyof typeof MATERIALS)[]) {
    add(requestMap, materialAssetRequest(materialId));
  }

  const partCombos = options.includeAllParts ? exhaustivePartCombos() : alphaPartCombos();
  for (const part of partCombos) {
    add(requestMap, partAssetRequest({
      id: `${part.slot}_${part.tier}_${part.weaponClass ?? 'universal'}`,
      slot: part.slot,
      tier: part.tier,
      weaponClass: part.weaponClass,
    }));
  }

  for (const kind of BUILDING_KINDS) {
    add(requestMap, buildingAssetRequest(kind));
  }

  return [...requestMap.values()];
}

function add(map: Map<string, AssetGenerateRequest>, request: AssetGenerateRequest): void {
  map.set(request.requestId ?? `${request.assetKind}:${request.gameObject.id}`, request);
}

function alphaPartCombos(): { slot: PartSlot; tier: PartTier; weaponClass: WeaponClass | null }[] {
  const combos: { slot: PartSlot; tier: PartTier; weaponClass: WeaponClass | null }[] = [];
  for (const tier of PART_TIERS) {
    for (const slot of SUIT_SLOTS) {
      combos.push({ slot, tier, weaponClass: null });
    }
  }
  for (const tier of ['Mk1', 'Mk2', 'Mk3'] as PartTier[]) {
    for (const slot of WEAPON_PART_SLOTS) {
      combos.push({ slot, tier, weaponClass: 'pistol' });
      combos.push({ slot, tier, weaponClass: 'smg' });
    }
  }
  return combos;
}

function exhaustivePartCombos(): { slot: PartSlot; tier: PartTier; weaponClass: WeaponClass | null }[] {
  const combos: { slot: PartSlot; tier: PartTier; weaponClass: WeaponClass | null }[] = [];
  for (const tier of PART_TIERS) {
    for (const slot of SUIT_SLOTS) {
      combos.push({ slot, tier, weaponClass: null });
    }
    for (const slot of WEAPON_PART_SLOTS) {
      for (const weaponClass of WEAPON_CLASSES) {
        combos.push({ slot, tier, weaponClass });
      }
    }
  }
  combos.push(...PART_TIERS.map((tier) => ({ slot: 'weapon_mod' as const, tier, weaponClass: null })));
  return combos;
}

function labelForEnemy(templateId: string): string {
  switch (templateId) {
    case 'dummy_target':
      return 'scrap target dummy';
    case 'chaser_melee':
      return 'rat-like tunnel scavenger';
    case 'shooter_drone':
      return 'frosted shooter drone';
    case 'brute_chaser':
      return 'sun-bleached armored brute';
    default:
      return templateId.replaceAll('_', ' ');
  }
}

function numberColorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

const BUILDING_KINDS: BuildingKind[] = [
  'wall',
  'turret',
  'workbench',
  'forge',
  'electronics_bench',
  'artifact_uplink',
  'power_link',
];

const SUIT_SLOTS: PartSlot[] = [
  'chassis',
  'plating',
  'life_support',
  'utility_mod',
  'cargo_grid',
];

const WEAPON_PART_SLOTS: PartSlot[] = [
  'barrel',
  'frame',
  'grip',
  'magazine',
];

const PART_TIERS: PartTier[] = ['Mk1', 'Mk2', 'Mk3', 'Mk4', 'Alien'];

const WEAPON_CLASSES: WeaponClass[] = [
  'pistol',
  'smg',
  'rifle',
  'shotgun',
  'sniper',
  'heavy',
  'energy',
];

async function main(): Promise<void> {
  const requests = buildRequests({ includeAllParts });

  if (dryRun) {
    console.log(JSON.stringify({ count: requests.length, requests }, null, 2));
    return;
  }

  const response = await fetch(`${DEFAULT_BASE_URL}/v1/assets/prewarm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
    },
    body: JSON.stringify({
      requestId: `prewarm:${new Date().toISOString()}`,
      reason: 'manual',
      requests,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`prewarm failed ${response.status}: ${text}`);
  }
  console.log(text);
}

await main();
