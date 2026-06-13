// Per-kind visual cube sizing for rendered buildings.
//
// Collision and the server-side tile footprint are always the full
// tile(s); this is purely a visual shrink so workstations / storage
// read as bench-sized objects instead of full-height walls. Both
// render paths — the textured cube (texturedBuildingLayer) and the
// colored fallback cube (converter.emitBuildingCubes) — call this so
// the two meshes share an identical footprint and height and never
// z-fight or leave a tall colored shell under a short textured one.

import { isStationKind, type BuildingKind } from '@dumrunner/shared';

export type BuildingCubeScale = {
  // Fraction of the cube's full height to render (1 = full wall).
  heightFrac: number;
  // Inset per side as a fraction of ONE tile (0 = full footprint,
  // 0.5 = collapses to a point). Applied to every edge so the
  // footprint shrinks symmetrically and stays centered.
  inset: number;
};

const FULL: BuildingCubeScale = { heightFrac: 1, inset: 0 };
// Stations + storage_chest: half height, ~0.6-tile footprint
// (0.2 tile inset per side).
const BENCH: BuildingCubeScale = { heightFrac: 0.5, inset: 0.2 };

export function buildingCubeScale(kind: BuildingKind): BuildingCubeScale {
  return isStationKind(kind) ? BENCH : FULL;
}
