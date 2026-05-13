// Animation client runtime — manifest + spritesheet loader.
//
// Sits between the texture-override pipeline and the renderer.
// Callers ask for an animation by (category, textureId); this
// module:
//
//   1. Fetches the AnimationDef manifest from the content API
//      (cached per slug). When no manifest exists the asset stays
//      a static texture — caller can fall through to its existing
//      single-PNG code path.
//   2. Loads per-state spritesheet PNGs from getStateOverride,
//      slices each into Texture[] keyed by frame index. The slice
//      assumes a single-row horizontal strip; frame width =
//      sheet.width / state.frames, frame height = sheet.height.
//      Atlas / vertical layouts are a later add.
//   3. Re-loads on texture-override notifications so an editor
//      save lights up live without a page reload. Spritesheet
//      Texture[] arrays get destroyed before re-slicing so we
//      don't leak GPU memory on hot-reload.
//
// Renderer-agnostic at the controller level (see shared/animation
// for the state machine); this module is the Pixi-bound texture
// half.

'use client';

import { Texture, Rectangle, Assets } from 'pixi.js';
import type { AnimationDef } from '@dumrunner/shared';
import {
  getFrameOverride,
  getStateOverride,
  subscribe as subscribeOverrides,
} from './textureOverrides';

// Force pixel-art sampling on a loaded Texture's underlying
// source. Animation sprites are pixel art; the default linear
// filter blurs them noticeably, especially on the FPS view-model.
// Mirrors the same call shape fps.ts uses for its static cache.
function applyPixelPerfectSampling(tex: Texture): void {
  try {
    const style = (tex.source as unknown as {
      style?: {
        scaleMode?: string;
        magFilter?: string;
        minFilter?: string;
        update?: () => void;
      };
    }).style;
    if (style) {
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

// ---------- manifest cache ----------

const manifestCache = new Map<string, AnimationDef | null>();
const manifestPending = new Map<string, Promise<AnimationDef | null>>();

// Animation textures (sheet or per-frame) live under this
// single texture category, keyed by the animation's id slug.
// Decoupled from the entity's own (category, textureId) override
// path so the same anim can be shared across entities.
const ANIM_TEXTURE_CATEGORY = 'anim';

async function fetchManifest(
  animationId: string,
): Promise<AnimationDef | null> {
  try {
    const r = await fetch(
      `/api/editor/content/animations?id=${encodeURIComponent(animationId)}`,
      { cache: 'no-store' },
    );
    if (r.status === 404) return null;
    if (!r.ok) return null;
    const payload = (await r.json()) as AnimationDef;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Returns the cached AnimationDef for `animationId`, or null
 * when none is authored. First call kicks off a background
 * fetch; subscribe to notify() if you need to know when it lands.
 */
export function getAnimationDef(
  animationId: string,
): AnimationDef | null {
  if (manifestCache.has(animationId)) {
    return manifestCache.get(animationId) ?? null;
  }
  if (!manifestPending.has(animationId) && typeof window !== 'undefined') {
    const p = fetchManifest(animationId).then((def) => {
      manifestCache.set(animationId, def);
      manifestPending.delete(animationId);
      notify();
      return def;
    });
    manifestPending.set(animationId, p);
  }
  return null;
}

/**
 * Promise variant for callers that need to wait for the manifest
 * (e.g. controller construction). Resolves to null when no
 * manifest exists.
 */
export function loadAnimationDef(
  animationId: string,
): Promise<AnimationDef | null> {
  if (manifestCache.has(animationId)) {
    return Promise.resolve(manifestCache.get(animationId) ?? null);
  }
  const existing = manifestPending.get(animationId);
  if (existing) return existing;
  const p = fetchManifest(animationId).then((def) => {
    manifestCache.set(animationId, def);
    manifestPending.delete(animationId);
    notify();
    return def;
  });
  manifestPending.set(animationId, p);
  return p;
}

// ---------- spritesheet cache ----------

type SheetEntry = {
  // For source='sheet': single URL of the spritesheet.
  // For source='frames': joined URLs of each frame (delimited by
  // '|'). When this string differs from the current URLs the
  // cache entry is invalidated and re-loaded.
  signature: string;
  frames: Texture[];
};

type SheetSource = 'sheet' | 'frames';

// Keyed by `${category}::${textureId}::${state}::${frames}::${source}`.
// frames count + source are part of the key so re-authoring an
// animation (sheet ↔ frames, or N → M frames) invalidates the
// cached array on next access.
const sheetCache = new Map<string, SheetEntry>();
const sheetPending = new Map<string, Promise<Texture[]>>();

function sheetKey(
  animationId: string,
  state: string,
  frames: number,
  source: SheetSource,
): string {
  return `${animationId}::${state}::${frames}::${source}`;
}

// Compute the signature that gets cached alongside the Texture
// array. Changing it on a re-load invalidates the cache.
function urlSignature(
  animationId: string,
  state: string,
  frames: number,
  source: SheetSource,
): string {
  if (source === 'frames') {
    const parts: string[] = [];
    for (let i = 0; i < frames; i++) {
      parts.push(
        getFrameOverride(ANIM_TEXTURE_CATEGORY, animationId, state, i) ?? '',
      );
    }
    return parts.join('|');
  }
  return getStateOverride(ANIM_TEXTURE_CATEGORY, animationId, state) ?? '';
}

async function loadSheet(
  animationId: string,
  state: string,
  frames: number,
): Promise<Texture[]> {
  const url = getStateOverride(ANIM_TEXTURE_CATEGORY, animationId, state);
  if (!url) return [];
  // Strip cache-buster query so Assets.load can dedupe against
  // prior loads of the same path; the override cache holds the
  // ?v= query for browser cache invalidation but Pixi's asset
  // cache uses string equality.
  const cleanUrl = url.split('?')[0];
  let baseTexture: Texture;
  try {
    baseTexture = (await Assets.load(cleanUrl)) as Texture;
  } catch {
    return [];
  }
  applyPixelPerfectSampling(baseTexture);
  const sheetW = baseTexture.width || 1;
  const sheetH = baseTexture.height || 1;
  const frameW = Math.max(1, Math.floor(sheetW / Math.max(1, frames)));
  const out: Texture[] = [];
  for (let i = 0; i < frames; i++) {
    out.push(
      new Texture({
        source: baseTexture.source,
        frame: new Rectangle(i * frameW, 0, frameW, sheetH),
      }),
    );
  }
  return out;
}

// source='frames' load path: one PNG per frame index. Missing
// frames stay as Texture.EMPTY so the renderer draws nothing for
// the gap (visible authoring incompletion signal).
async function loadFrames(
  animationId: string,
  state: string,
  frames: number,
): Promise<Texture[]> {
  const out: Texture[] = [];
  for (let i = 0; i < frames; i++) {
    const url = getFrameOverride(
      ANIM_TEXTURE_CATEGORY,
      animationId,
      state,
      i,
    );
    if (!url) {
      out.push(Texture.EMPTY);
      continue;
    }
    const cleanUrl = url.split('?')[0];
    try {
      const tex = (await Assets.load(cleanUrl)) as Texture;
      applyPixelPerfectSampling(tex);
      out.push(tex);
    } catch {
      out.push(Texture.EMPTY);
    }
  }
  return out;
}

/**
 * Returns the array of frame Textures for one animation state, or
 * an empty array when the textures aren't loaded yet / not
 * authored. Cached — subsequent calls with the same key are O(1).
 *
 * `source` mirrors AnimationState.source:
 *   - 'sheet'  (default): one PNG per state, sliced horizontally.
 *   - 'frames':           one PNG per frame index.
 *
 * Renderer call shape: `getStateFrames(...)[frameIndex]` indexed
 * against the AnimationController's currentFrame().frameIndex.
 */
export function getStateFrames(
  animationId: string,
  state: string,
  frames: number,
  source: SheetSource = 'sheet',
): Texture[] {
  const key = sheetKey(animationId, state, frames, source);
  const cached = sheetCache.get(key);
  const signature = urlSignature(animationId, state, frames, source);
  if (cached) {
    if (signature && cached.signature !== signature) {
      destroyEntry(cached);
      sheetCache.delete(key);
    } else {
      return cached.frames;
    }
  }
  if (!signature) return [];
  if (!sheetPending.has(key) && typeof window !== 'undefined') {
    const loader =
      source === 'frames'
        ? loadFrames(animationId, state, frames)
        : loadSheet(animationId, state, frames);
    const p = loader.then((textures) => {
      sheetCache.set(key, { signature, frames: textures });
      sheetPending.delete(key);
      notify();
      return textures;
    });
    sheetPending.set(key, p);
  }
  return [];
}

function destroyEntry(entry: SheetEntry): void {
  for (const t of entry.frames) {
    try {
      // Destroy the per-frame view; the BaseTexture stays in Pixi's
      // Assets cache so re-loading the same URL is cheap.
      t.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ---------- change notification ----------

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeAnimations(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* swallow */
    }
  }
}

// Tie hot-reload of state textures back into the animation cache
// so a re-uploaded sheet invalidates the sliced frame array.
// Manifest changes (re-authored frame counts / fps) are picked up
// the same way — the editor save POSTs the new JSON and we drop
// the cached manifest so the next lookup re-fetches.
if (typeof window !== 'undefined') {
  subscribeOverrides(() => {
    // Drop sliced-frame caches whose underlying URL signature no
    // longer matches the current overrides. Each cached entry's
    // signature folds in source + per-frame URLs (for 'frames'
    // mode) or the spritesheet URL (for 'sheet' mode); when it
    // drifts we re-slice on the next access.
    for (const [key, entry] of sheetCache) {
      const parts = key.split('::');
      const animationId = parts[0];
      const state = parts[1];
      const framesCount = parseInt(parts[2] ?? '0', 10);
      const source = (parts[3] as SheetSource | undefined) ?? 'sheet';
      const signature = urlSignature(animationId, state, framesCount, source);
      if (!signature || signature !== entry.signature) {
        destroyEntry(entry);
        sheetCache.delete(key);
      }
    }
    notify();
  });
}

/**
 * Force-drop the cached manifest for `animationId` so the next
 * `getAnimationDef` call re-fetches. Used by the editor save
 * flow after writing a manifest via the content API.
 */
export function invalidateAnimationManifest(animationId: string): void {
  manifestCache.delete(animationId);
  manifestPending.delete(animationId);
  notify();
}
