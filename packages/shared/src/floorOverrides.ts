// Floor override registry — pins authored scenes to specific
// dungeon floor indices. The server's createDungeonScene path
// looks here BEFORE running procgen; a hit means "load this
// authored scene instead." Stored on disk at
// `content/floor-overrides.json`, populated into this module at
// server boot.
//
// Resolution order: per-server override beats global. Per-server
// is post-MVP (no editor UI for it yet); global is the everyday
// case the pin-to-floor button writes to.

import type { FloorOverrides } from './content/types';
import type { SectorScene as PolygonSectorScene } from './sector';

// Mutable singleton — server boot calls setFloorOverrides once;
// the rest of the runtime reads via floorOverrideFor(...).
let FLOOR_OVERRIDES: FloorOverrides = {};

export function setFloorOverrides(data: FloorOverrides): void {
  FLOOR_OVERRIDES = data;
}

export function getFloorOverrides(): FloorOverrides {
  return FLOOR_OVERRIDES;
}

// Returns the pinned scene id for (serverId, floorIndex), or
// null if procgen should run.
export function floorOverrideFor(
  serverId: string | null,
  floorIndex: number,
): string | null {
  const key = String(floorIndex);
  if (serverId) {
    const perServer = FLOOR_OVERRIDES.servers?.[serverId]?.[key];
    if (perServer) return perServer;
  }
  return FLOOR_OVERRIDES.global?.[key] ?? null;
}

// Pre-loaded scene cache. Server boot loads every scene that
// any override references and stashes it here so the dungeon
// floor creation path (which is synchronous) can look it up
// without any I/O.
const OVERRIDE_SCENES = new Map<string, PolygonSectorScene>();

export function setOverrideScene(
  sceneId: string,
  scene: PolygonSectorScene,
): void {
  OVERRIDE_SCENES.set(sceneId, scene);
}

export function getOverrideScene(
  sceneId: string,
): PolygonSectorScene | undefined {
  return OVERRIDE_SCENES.get(sceneId);
}

export function clearOverrideScenes(): void {
  OVERRIDE_SCENES.clear();
}
