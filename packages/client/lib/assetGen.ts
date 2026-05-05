// asset_gen is currently disabled while we iterate on art via the
// /editor UI's manual texture overrides (see lib/textureOverrides.ts).
// loadAssetIndex always returns a no-op AssetIndex so renderers
// transparently fall back to procedural geometry; manual overrides
// are layered in by the renderer's own texture lookup, separate
// from this file.

'use client';

export type AssetIndex = {
  // Resolve a gameObject id (e.g. enemy template id like 'chaser_melee')
  // to a PNG url, or null if not in the index.
  getEnemyTexture(kind: string): string | null;
  // Future expansions can add getMaterialIcon, getBuildingTexture, etc.
};

const EMPTY_INDEX: AssetIndex = {
  getEnemyTexture: () => null,
};

export async function loadAssetIndex(
  _baseUrl: string | undefined,
): Promise<AssetIndex> {
  // Disabled — see file header. Returns empty so callers can keep
  // the same shape without running an asset_gen service.
  return EMPTY_INDEX;
}
