// Server-side corridor template registry. Mirrors rooms.ts —
// loaded from packages/shared/content/corridors/<id>.json at
// boot, hot-reloaded on file change. Procgen consults the
// registry per corridor edge to pick a width (and eventually a
// decorative tile pattern). Empty pool → corridors fall back to
// the default 2-tile-wide rect strip.

import { loadCorridors } from '@dumrunner/shared/content/loader';
import type { CorridorTemplate } from '@dumrunner/shared';

export const CORRIDORS: Record<string, CorridorTemplate> = {};

export async function initCorridors(): Promise<void> {
  const defs = await loadCorridors();
  for (const k of Object.keys(CORRIDORS)) delete CORRIDORS[k];
  for (const def of defs) CORRIDORS[def.id] = def;
  if (defs.length > 0) {
    console.log(
      `[corridors] loaded ${defs.length} templates: ${defs.map((d: CorridorTemplate) => d.id).join(', ')}`,
    );
  }
}

// Pick a corridor template from the biome's pool, weighted by
// each template's `weight`. Returns null when the biome has no
// corridor templates authored — caller falls back to the
// default 2-tile rect.
export function pickCorridorTemplate(
  biome: string,
  rng: () => number,
): CorridorTemplate | null {
  const candidates: CorridorTemplate[] = [];
  for (const id of Object.keys(CORRIDORS).sort()) {
    const t = CORRIDORS[id];
    if (t.biomeAffinity.includes(biome)) candidates.push(t);
  }
  if (candidates.length === 0) return null;
  const total = candidates.reduce((s, t) => s + t.weight, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const t of candidates) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return candidates[candidates.length - 1];
}
