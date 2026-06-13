// Base-layout registry boot. Reads
// packages/shared/content/base-layouts/<id>.json at server boot and
// keeps the parsed BaseLayoutDefs in an in-memory registry the World
// resolves its active surface layout from. Mirrors blueprints.ts /
// recipes.ts (load → registry → getter). See docs/base-layouts-plan.md.
//
// A base layout carries only the SHAPE of the surface clearing
// (radius/apron/padZ) plus base metadata (turret mounts, build caps,
// economy). The clearing geometry itself is built in world.ts,
// centred on the Power Link world position.

import { loadBaseLayouts } from '@dumrunner/shared/content/loader';
import type { BaseLayoutDef } from '@dumrunner/shared';

// The layout every world starts on and every pre-v5 save migrates to.
// Must match an authored base_square_mk1.json on disk.
export const STARTER_BASE_LAYOUT_ID = 'base_square_mk1';

export const BASE_LAYOUTS: Record<string, BaseLayoutDef> = {};

export async function initBaseLayouts(): Promise<void> {
  const defs = await loadBaseLayouts();
  // Clear + repopulate so hot-reload reflects deletes, not just adds.
  for (const key of Object.keys(BASE_LAYOUTS)) delete BASE_LAYOUTS[key];
  for (const def of defs) BASE_LAYOUTS[def.id] = def;

  if (defs.length === 0) {
    console.warn(
      '[base-layouts] no base-layout JSON files found in shared/content/base-layouts — surface base will fall back to the starter clearing constants',
    );
  } else {
    console.log(`[base-layouts] loaded ${defs.length} base layouts`);
  }
  if (!BASE_LAYOUTS[STARTER_BASE_LAYOUT_ID]) {
    console.warn(
      `[base-layouts] starter layout "${STARTER_BASE_LAYOUT_ID}" not found — surface base will use built-in fallback geometry`,
    );
  }
}

export function getBaseLayout(id: string): BaseLayoutDef | null {
  return BASE_LAYOUTS[id] ?? null;
}
