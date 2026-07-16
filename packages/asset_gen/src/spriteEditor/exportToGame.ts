// Hook finished sprite docs into the live art pipeline.
//
// Static slots  → public/textures/<category>/<id>.png
// Animated slots → frame PNGs at public/textures/anim/<animId>/<state>/<i>.png
//                  + a content animation manifest
//                    (packages/shared/content/animations/<animId>.json)
//                  + the entity's content JSON gets animationId set
//
// Frame names in a SpriteDoc are '<state>/<index>'; exportAnimation
// groups them by state, validates state names against the shared
// STATES_BY_CATEGORY allowlist via AnimationDefSchema, and writes
// everything the game needs. After this runs the renderer picks the
// art up with zero further wiring (art-audit flips the slot).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AnimationDefSchema,
  type AnimationCategory,
  type AnimationDef,
} from '@dumrunner/shared';
import { renderNative, type SpriteDoc } from './engine.js';

const DEFAULT_FPS: Record<string, number> = {
  idle: 4,
  walk: 8,
  attack: 10,
  hit: 10,
  death: 8,
  fire: 12,
  reload: 8,
  destroy: 8,
};
const LOOPING_STATES = new Set(['idle', 'walk']);

export function parseFrameName(
  name: string,
): { state: string; index: number } {
  const sep = name.lastIndexOf('/');
  const state = sep === -1 ? name : name.slice(0, sep);
  const index = sep === -1 ? 0 : Number(name.slice(sep + 1));
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`frame '${name}' must be named <state>/<index>`);
  }
  return { state, index };
}

export async function exportStatic(
  doc: SpriteDoc,
  frame: string,
  texturesDir: string,
  category: string,
  id: string,
): Promise<string> {
  const png = await renderNative(doc, frame);
  const dir = join(texturesDir, category);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.png`);
  await writeFile(path, png);
  return path;
}

export type ExportAnimationOptions = {
  texturesDir: string;
  // packages/shared/content — manifests land in <contentDir>/animations.
  contentDir: string;
  animId: string;
  name: string;
  category: AnimationCategory;
  // Per-state overrides; defaults from DEFAULT_FPS / LOOPING_STATES.
  fps?: Record<string, number>;
  loop?: Record<string, boolean>;
};

export async function exportAnimation(
  doc: SpriteDoc,
  opts: ExportAnimationOptions,
): Promise<{ manifestPath: string; states: Record<string, number> }> {
  // Group frames by state; indexes must be dense 0..n-1.
  const byState = new Map<string, Map<number, string>>();
  for (const frameName of Object.keys(doc.frames)) {
    const { state, index } = parseFrameName(frameName);
    const m = byState.get(state) ?? new Map<number, string>();
    if (m.has(index)) throw new Error(`duplicate frame ${state}/${index}`);
    m.set(index, frameName);
    byState.set(state, m);
  }
  if (byState.size === 0) throw new Error('sprite has no frames');

  const states: AnimationDef['states'] = {};
  for (const [state, frames] of byState) {
    for (let i = 0; i < frames.size; i++) {
      if (!frames.has(i)) {
        throw new Error(
          `state '${state}' frames must be dense 0..${frames.size - 1}; missing ${state}/${i}`,
        );
      }
    }
    states[state] = {
      frames: frames.size,
      fps: opts.fps?.[state] ?? DEFAULT_FPS[state] ?? 8,
      loop: opts.loop?.[state] ?? LOOPING_STATES.has(state),
      source: 'frames',
    };
  }

  const manifest = AnimationDefSchema.parse({
    id: opts.animId,
    name: opts.name,
    category: opts.category,
    states,
  });

  // Frame PNGs.
  for (const [state, frames] of byState) {
    const dir = join(opts.texturesDir, 'anim', opts.animId, state);
    await mkdir(dir, { recursive: true });
    for (const [index, frameName] of frames) {
      await writeFile(
        join(dir, `${index}.png`),
        await renderNative(doc, frameName),
      );
    }
  }

  // Content manifest.
  const animDir = join(opts.contentDir, 'animations');
  await mkdir(animDir, { recursive: true });
  const manifestPath = join(animDir, `${opts.animId}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifestPath,
    states: Object.fromEntries(
      Object.entries(states).map(([k, v]) => [k, v.frames]),
    ),
  };
}

// Point an entity's content JSON at an animation manifest.
// Area is the content subdir holding the entity. Weapons use
// dedicated fields (viewAnimationId / projectileAnimationId);
// enemies and props use `animationId` (the default).
export async function wireEntityAnimation(
  contentDir: string,
  area: 'enemies' | 'props' | 'weapons',
  entityId: string,
  animId: string,
  field:
    | 'animationId'
    | 'viewAnimationId'
    | 'projectileAnimationId' = 'animationId',
): Promise<string> {
  if (area === 'weapons' && field === 'animationId') {
    throw new Error(
      'weapons wire via viewAnimationId or projectileAnimationId',
    );
  }
  const path = join(contentDir, area, `${entityId}.json`);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  parsed[field] = animId;
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return path;
}
