import { createHash } from 'node:crypto';
import type { AssetFamilyMetadata, AssetGenerateRequest } from './schemas.js';

export function assetFamilyFor(
  request: AssetGenerateRequest,
  sourceModel: string
): AssetFamilyMetadata {
  const baseAssetId = request.animation?.baseAssetId;
  const familySeed = baseAssetId
    ? `base:${baseAssetId}`
    : `${request.assetKind}:${request.gameObject.id}:${request.gameObject.faction ?? ''}`;
  const animationAction = request.animation?.action;
  return {
    familyId: `family_${hash(familySeed).slice(0, 20)}`,
    baseAssetId,
    variantType: variantTypeFor(request),
    animationAction,
    sourceModel,
  };
}

function variantTypeFor(request: AssetGenerateRequest): AssetFamilyMetadata['variantType'] {
  if (request.assetKind === 'enemy_animation') return 'animation';
  if (request.assetKind === 'enemy') return 'base';
  if (request.assetKind === 'projectile') return 'projectile';
  if (request.assetKind === 'building') return 'building';
  return 'icon';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
