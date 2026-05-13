// Blueprint registry boot. Reads
// packages/shared/content/blueprints/<id>.json at server boot and
// pushes the loaded entries into the shared BLUEPRINT_CATALOG via
// setBlueprintCatalog. Mirrors biomes.ts / ai/templates.ts.
//
// The wire shape exposed to clients is the BlueprintCatalogEntry
// shape verbatim — Object.values(BLUEPRINT_CATALOG) — so no
// transform is needed before sending.

import { loadBlueprints } from '@dumrunner/shared/content/loader';
import {
  BLUEPRINT_CATALOG,
  setBlueprintCatalog,
  type BlueprintCatalogEntry,
} from '@dumrunner/shared';

export async function initBlueprints(): Promise<void> {
  const defs = await loadBlueprints();
  if (defs.length === 0) {
    console.warn(
      '[blueprints] no blueprint JSON files found in shared/content/blueprints — uplink shop will be empty',
    );
  } else {
    console.log(
      `[blueprints] loaded ${defs.length} blueprints (${defs.filter((d) => d.hidden).length} hidden)`,
    );
  }
  // BlueprintDef shape is identical to BlueprintCatalogEntry —
  // hidden / prerequisites are optional in both.
  setBlueprintCatalog(defs);
}

// Subset shipped to the client in the welcome message. Same shape
// as the registry — clients call setBlueprintCatalog on receive.
export function getBlueprintsForWire(): BlueprintCatalogEntry[] {
  return Object.values(BLUEPRINT_CATALOG);
}
