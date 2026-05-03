// Lightweight client for the asset_gen service. Fetches the public
// /v1/assets/index at boot, builds a Map<gameObjectId, pngUrl>, and
// hands it to the renderers. Renderers can swap procedural geometry
// for the AI-generated sprite when a URL is present, and fall back
// when it isn't (asset_gen offline / unset / no asset for that kind).

'use client';

type ApprovedAsset = {
  assetId: string;
  request: {
    gameObject: { id: string };
    assetKind: string;
  };
  urls: { png: string };
};

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
  baseUrl: string | undefined
): Promise<AssetIndex> {
  if (!baseUrl) return EMPTY_INDEX;
  let payload: { assets: ApprovedAsset[] } | null = null;
  try {
    const r = await fetch(`${baseUrl}/v1/assets/index`, {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return EMPTY_INDEX;
    payload = (await r.json()) as { assets: ApprovedAsset[] };
  } catch {
    return EMPTY_INDEX;
  }
  if (!payload?.assets) return EMPTY_INDEX;

  // Group by assetKind → keep the most recent enemy sprite per
  // gameObject id (the index returns assets in creation order; later
  // entries shadow earlier).
  const enemyByKind = new Map<string, string>();
  for (const a of payload.assets) {
    const url = absoluteUrl(baseUrl, a.urls?.png ?? '');
    if (!url) continue;
    if (a.request.assetKind === 'enemy') {
      enemyByKind.set(a.request.gameObject.id, url);
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[asset_gen] index loaded: ${enemyByKind.size} enemy sprites (${[...enemyByKind.keys()].join(', ') || '—'})`
  );

  return {
    getEnemyTexture: (kind: string) => enemyByKind.get(kind) ?? null,
  };
}

// asset_gen returns absolute urls when ASSET_GEN_PUBLIC_BASE_URL is
// set; otherwise it returns paths like '/assets/<id>.png'. Make
// everything absolute against the configured base url.
function absoluteUrl(baseUrl: string, raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return `${baseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`;
}
