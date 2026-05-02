import type { BuildingKind, CarriedPart } from '@dumrunner/shared';
import { MATERIALS, type MaterialKind } from '@dumrunner/shared/inventory';
import type { AssetGenerateRequest } from './schemas.js';

type EnemyAssetInput = {
  templateId: string;
  label: string;
  faction: string;
  biome?: string;
  color: string;
  radius?: number;
  movementKind?: string;
  attackKinds?: string[];
};

export function enemyAssetRequest(input: EnemyAssetInput): AssetGenerateRequest {
  return {
    requestId: `enemy:${input.templateId}:${input.faction}`,
    assetKind: 'enemy',
    renderTarget: 'world_sprite',
    size: 64,
    style: {
      camera: 'top_down',
      renderStyle: 'painted_sprite',
      outline: true,
      transparentBackground: true,
    },
    gameObject: {
      id: input.templateId,
      label: input.label,
      faction: input.faction,
      biome: input.biome ?? null,
    },
    visualBrief: {
      subject: input.label,
      materials: ['wasteland mutation', 'scrap armor'],
      colors: [input.color, '#111827', '#22c55e'],
      mustInclude: [
        'readable top-down silhouette',
        input.movementKind ? `${input.movementKind} movement personality` : 'clear enemy posture',
        ...(input.attackKinds ?? []).map((kind) => `${kind} combat cue`),
      ],
      mustAvoid: ['friendly character', 'multiple creatures', 'floor tile'],
    },
    constraints: {
      safeMarginPx: 4,
      anchor: 'center_bottom',
      maxOpaqueBoundsRatio: 0.86,
      minReadableAtPx: 32,
    },
  };
}

export function enemyAnimationRequest(input: EnemyAssetInput & {
  action?: 'idle' | 'walk' | 'attack' | 'death';
  frameCount?: 2 | 3 | 4;
  baseAssetId?: string;
}): AssetGenerateRequest {
  const action = input.action ?? 'idle';
  return {
    ...enemyAssetRequest(input),
    requestId: `enemy_animation:${input.templateId}:${input.faction}:${action}:${input.frameCount ?? 2}`,
    assetKind: 'enemy_animation',
    animation: {
      baseAssetId: input.baseAssetId,
      action,
      frameCount: input.frameCount ?? 2,
      directionMode: 'omnidirectional',
      fps: action === 'idle' ? 4 : 8,
      maxFrameDriftPx: action === 'death' ? 8 : 4,
    },
  };
}

export function partAssetRequest(part: Pick<CarriedPart, 'id' | 'slot' | 'tier' | 'weaponClass'>): AssetGenerateRequest {
  const isWeapon = part.slot === 'barrel' || part.slot === 'frame' || part.slot === 'grip' || part.slot === 'magazine' || part.slot === 'weapon_mod';
  return {
    requestId: `part:${part.slot}:${part.tier}:${part.weaponClass ?? 'universal'}`,
    assetKind: isWeapon ? 'weapon_part' : 'suit_part',
    renderTarget: 'inventory_icon',
    size: 64,
    style: {
      camera: isWeapon ? 'side_view' : 'three_quarter',
      renderStyle: 'clean_icon',
      outline: true,
      transparentBackground: true,
    },
    gameObject: {
      id: part.id,
      label: `${part.tier} ${part.weaponClass ? `${part.weaponClass} ` : ''}${part.slot.replaceAll('_', ' ')}`,
      tier: part.tier,
      slot: part.slot,
      weaponClass: part.weaponClass,
    },
    visualBrief: {
      subject: `${part.tier} ${part.weaponClass ? `${part.weaponClass} ` : ''}${part.slot.replaceAll('_', ' ')}`,
      materials: part.tier === 'Alien' ? ['alien alloy', 'glowing embedded circuitry'] : ['scratched metal', 'worn polymer', 'dust'],
      colors: tierPalette(part.tier),
      mustInclude: [`clearly a ${part.slot.replaceAll('_', ' ')}`],
      mustAvoid: ['full character', 'hands', 'text label'],
    },
    constraints: {
      safeMarginPx: 5,
      anchor: 'center',
      maxOpaqueBoundsRatio: 0.9,
      minReadableAtPx: 32,
    },
  };
}

export function materialAssetRequest(materialId: MaterialKind): AssetGenerateRequest {
  const material = MATERIALS[materialId];
  return {
    requestId: `material:${materialId}`,
    assetKind: 'material',
    renderTarget: 'inventory_icon',
    size: 64,
    style: {
      camera: 'three_quarter',
      renderStyle: 'clean_icon',
      outline: true,
      transparentBackground: true,
    },
    gameObject: {
      id: materialId,
      label: material.name,
      materialId,
    },
    visualBrief: {
      subject: material.name,
      materials: [material.name.toLowerCase()],
      colors: [numberColorToHex(material.color), '#111827'],
      mustInclude: ['small stackable pickup icon'],
      mustAvoid: ['text', 'coin', 'large crate'],
    },
    constraints: {
      safeMarginPx: 5,
      anchor: 'center',
      maxOpaqueBoundsRatio: 0.82,
      minReadableAtPx: 32,
    },
  };
}

export function buildingAssetRequest(kind: BuildingKind): AssetGenerateRequest {
  return {
    requestId: `building:${kind}`,
    assetKind: 'building',
    renderTarget: 'world_sprite',
    size: 64,
    style: {
      camera: 'top_down',
      renderStyle: 'painted_sprite',
      outline: true,
      transparentBackground: true,
    },
    gameObject: {
      id: kind,
      label: kind.replaceAll('_', ' '),
      buildingKind: kind,
    },
    visualBrief: {
      subject: `player-built ${kind.replaceAll('_', ' ')}`,
      materials: ['scrap metal', 'bolted plates', 'industrial wiring'],
      colors: ['#94a3b8', '#f59e0b', '#111827'],
      mustInclude: ['reads as a placed base structure from top-down view'],
      mustAvoid: ['background floor', 'human operator', 'text'],
    },
    constraints: {
      safeMarginPx: 3,
      anchor: 'center',
      maxOpaqueBoundsRatio: 0.92,
      minReadableAtPx: 32,
    },
  };
}

export function projectileAssetRequest(input: {
  id: string;
  label: string;
  color: string;
}): AssetGenerateRequest {
  return {
    requestId: `projectile:${input.id}`,
    assetKind: 'projectile',
    renderTarget: 'world_sprite',
    size: 32,
    style: {
      camera: 'top_down',
      renderStyle: 'pixel_art',
      outline: true,
      transparentBackground: true,
    },
    gameObject: {
      id: input.id,
      label: input.label,
    },
    visualBrief: {
      subject: input.label,
      materials: ['glowing projectile trail', 'energy core'],
      colors: [input.color, '#f8fafc', '#111827'],
      mustInclude: ['small readable projectile shape'],
      mustAvoid: ['weapon', 'shooter', 'text', 'large explosion'],
    },
    constraints: {
      safeMarginPx: 3,
      anchor: 'center',
      maxOpaqueBoundsRatio: 0.78,
      minReadableAtPx: 16,
    },
  };
}

function tierPalette(tier: CarriedPart['tier']): string[] {
  switch (tier) {
    case 'Mk1':
      return ['#94a3b8', '#52525b', '#d6d3d1'];
    case 'Mk2':
      return ['#9a3412', '#71717a', '#d6d3d1'];
    case 'Mk3':
      return ['#0f766e', '#94a3b8', '#111827'];
    case 'Mk4':
      return ['#7c3aed', '#06b6d4', '#111827'];
    case 'Alien':
      return ['#22c55e', '#a855f7', '#020617'];
  }
}

function numberColorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
