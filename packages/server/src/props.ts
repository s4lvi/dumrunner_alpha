// Server-side prop registry. Mirrors the templates.ts pattern
// for enemies — JSON content under packages/shared/content/props/
// loaded at boot, exposed as a runtime PROPS map keyed by id.
//
// Spawning runs as part of dungeon procgen (per-biome propPalette
// is sampled to pick which props go where). Damage / destruction
// flows through scene.ts using the same projectile + melee paths
// that target enemies and buildings.

import { loadProps } from '@dumrunner/shared/content/loader';
import type { PropDef, PropVisual, Inventory } from '@dumrunner/shared';

export const PROPS: Record<string, PropDef> = {};

// Wire-shaped subset of PropDef.visual for the welcome message.
// Mirrors the enemyVisuals + biomes pattern so the FPS renderer
// has per-prop billboard scale + ground anchor at session start.
// Container props also carry the cube-render hints so the FPS
// raycaster knows to switch into cube mode for those kinds.
export function getPropVisualsForWire(): Record<string, PropVisual> {
  const out: Record<string, PropVisual> = {};
  for (const id of Object.keys(PROPS)) {
    const def = PROPS[id];
    const v = def.visual;
    out[id] = {
      tint: v.tint,
      spriteSize: v.spriteSize,
      spriteGroundOffset: v.spriteGroundOffset,
      animationId: def.animationId,
      ...(def.container
        ? {
            isContainer: true,
            containerHeightMult: def.container.heightMult,
          }
        : {}),
    };
  }
  return out;
}

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
  // Container-only state (PropDef.container present). Tile-snapped
  // footprint, cube height, persistent inventory, and an
  // open/closed flag for the visual swap. Inventory is rolled at
  // spawn; once `opened` flips no further rolls happen — items
  // remaining are pure "pick up what's left" semantics.
  tileX?: number;
  tileY?: number;
  tileWidth?: number;
  tileDepth?: number;
  heightMult?: number;
  opened?: boolean;
  inventory?: Inventory;
};
