// Server-side per-BuildingKind override registry. Mirrors props.ts
// — JSON content under packages/shared/content/buildings/<kind>.json
// loaded at boot, exposed via setBuildingVisuals so both halves
// resolve building animations through the same shared registry.
//
// Today this carries only animationId. Hardcoded structural
// metadata (HP, priority, station flags) intentionally stays in
// shared/buildings.ts where it shapes server behaviour; overrides
// only touch presentation.

import { loadBuildingOverrides } from '@dumrunner/shared/content/loader';
import {
  BUILDING_REGISTRY,
  setBuildingVisuals,
  type BuildingKind,
  type BuildingVisual,
} from '@dumrunner/shared';

// Wire-shape map shipped to clients in welcome. Only kinds with
// authored content land in the payload — absent entries fall
// through to the renderer's `{}` default via buildingVisualFor.
// Snapshot from the live BUILDING_VISUALS registry so the wire
// shape always tracks the server's current state (including
// post-hot-reload updates).
import { BUILDING_VISUALS } from '@dumrunner/shared';

export function getBuildingVisualsForWire(): Record<string, BuildingVisual> {
  const out: Record<string, BuildingVisual> = {};
  for (const [kind, v] of Object.entries(BUILDING_VISUALS)) {
    out[kind] = { ...v };
  }
  return out;
}

export async function initBuildingOverrides(): Promise<void> {
  const defs = await loadBuildingOverrides();
  const visuals: Record<string, BuildingVisual> = {};
  const knownKinds = new Set(Object.keys(BUILDING_REGISTRY));
  let appliedCount = 0;
  for (const def of defs) {
    if (!knownKinds.has(def.id)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[buildings] override for unknown kind '${def.id}' — ignored. Rename or remove packages/shared/content/buildings/${def.id}.json`,
      );
      continue;
    }
    visuals[def.id] = { animationId: def.animationId };
    appliedCount++;
  }
  setBuildingVisuals(visuals);
  // eslint-disable-next-line no-console
  console.log(
    `[buildings] loaded ${appliedCount} per-kind override(s) from JSON`,
  );
}

// Re-export so wire callers don't have to dual-import.
export type { BuildingKind };
