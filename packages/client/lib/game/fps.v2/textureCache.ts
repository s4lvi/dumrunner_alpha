// Texture loader for v2. Resolves a (category, id) pair to a
// Pixi Texture by going through the existing textureOverrides
// pipeline:
//
//   1. textureOverrides.getOverride(category, id) → URL string
//   2. Assets.load(url) → Texture
//   3. force nearest-neighbour sampling so pixel-art biome
//      textures don't get blurred (v1 does the same)
//
// Each (category, id) pair is loaded once; the result is cached
// in a Map keyed by URL string. Subsequent reads are
// synchronous against the cache. The first call kicks off the
// async fetch; the caller sees `null` until the texture lands,
// then a subscribe-notification fires so consumers can re-poll.

import { Assets, Texture } from 'pixi.js';
import { getOverride } from '../../textureOverrides';

const cache = new Map<string, Texture>();
const loading = new Set<string>();

// Apply pixel-perfect sampling. Same code shape v1 uses, copied
// rather than imported because v1's helper isn't exported.
function applyPixelPerfectSampling(tex: Texture): void {
  try {
    const style = (tex.source as unknown as {
      style?: {
        addressMode?: string;
        scaleMode?: string;
        magFilter?: string;
        minFilter?: string;
        update?: () => void;
      };
    }).style;
    if (style) {
      // Wrap so biome floor / wall textures tile cleanly across
      // multiple cells. NEAREST so pixel-art stays crisp.
      style.addressMode = 'repeat';
      style.scaleMode = 'nearest';
      style.magFilter = 'nearest';
      style.minFilter = 'nearest';
      style.update?.();
    }
    const src = tex.source as unknown as { scaleMode?: string };
    if ('scaleMode' in src) src.scaleMode = 'nearest';
  } catch {
    /* best-effort */
  }
}

// Synchronous lookup. Kicks off async load on first call;
// returns null until it lands. The renderer polls this each
// frame, so the texture appears as soon as it lands without an
// explicit notification path.
export function lookupTexture(
  category: string,
  id: string,
): Texture | null {
  const url = getOverride(category, id);
  if (!url) return null;
  // Strip cache-buster query so Assets.load can dedupe against
  // prior loads of the same path. The override cache uses the
  // ?v= query for HTTP cache invalidation but Pixi keys on the
  // exact URL string.
  const cleanUrl = url.split('?')[0];
  const cached = cache.get(cleanUrl);
  if (cached) return cached;
  if (loading.has(cleanUrl)) return null;
  loading.add(cleanUrl);
  void (async () => {
    try {
      const tex = (await Assets.load(cleanUrl)) as Texture;
      applyPixelPerfectSampling(tex);
      cache.set(cleanUrl, tex);
    } catch {
      /* swallow — the lookup will return null next call too */
    } finally {
      loading.delete(cleanUrl);
    }
  })();
  return null;
}
