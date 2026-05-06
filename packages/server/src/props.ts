// Server-side prop registry. Mirrors the templates.ts pattern
// for enemies — JSON content under packages/shared/content/props/
// loaded at boot, exposed as a runtime PROPS map keyed by id.
//
// Spawning runs as part of dungeon procgen (per-biome propPalette
// is sampled to pick which props go where). Damage / destruction
// flows through scene.ts using the same projectile + melee paths
// that target enemies and buildings.

import { loadProps } from '@dumrunner/shared/content/loader';
import type { PropDef } from '@dumrunner/shared';

export const PROPS: Record<string, PropDef> = {};

export async function initProps(): Promise<void> {
  const defs = await loadProps();
  for (const k of Object.keys(PROPS)) delete PROPS[k];
  for (const def of defs) PROPS[def.id] = def;
  if (defs.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      '[props] no prop JSON files found — biomes will spawn empty propPalettes only',
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[props] loaded ${defs.length} prop kinds from JSON: ${defs
        .map((d) => d.id)
        .join(', ')}`,
    );
  }
}

// Per-scene runtime state for a single prop instance. Static
// position, mutable HP. The fsm-light here: alive flag flips
// when hp hits 0; the destruction handler in scene.ts then
// applies onDestroy (drop_loot / explode) before the entry
// is removed from the scene's props map.
export type PropRuntime = {
  id: string;
  kind: string;       // PropDef.id cross-ref
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
};
