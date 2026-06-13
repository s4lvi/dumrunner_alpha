// Per-kind cube sizing for rendered buildings. Re-exported from the
// shared definition so the client render paths (texturedBuildingLayer
// + converter.emitBuildingCubes) and the server collision geometry
// (sectorBuild.emitBuildingCubes) all use ONE source — the drawn cube
// and its hitbox stay identical.
export {
  buildingCubeScale,
  type BuildingCubeScale,
} from '@dumrunner/shared';
