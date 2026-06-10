// SceneLayout → SectorMap for the v2 renderer. Every dungeon
// layout ships an `authoredSectorMap` (the v2 procgen pipeline +
// the level editor are the only producers); the surface scene
// has neither a tile grid nor an authored map and falls through
// to the open-layout single-sector path.

import {
  biomePaletteFor,
  biomeWallHeightTilesFor,
  riserifyWalls,
  splitOverlappingWalls,
  terrainHeightAt,
  type BuildingState,
  type SceneLayout,
  type TerrainConfig,
} from '@dumrunner/shared';
import type { SectorMap, Sector, Wall, Vec2 } from './types';

const WALL_HEIGHT_WORLD = 32;

export type ConverterResult = {
  map: SectorMap;
  floorColor: number;
  ceilingColor: number;
  wallColor: number;
};

export function convertLayoutToSectorMap(
  layout: SceneLayout,
  buildings: BuildingState[] = [],
): ConverterResult | null {
  if (layout.authoredSectorMap) {
    return convertAuthoredMap(layout, layout.authoredSectorMap, buildings);
  }
  return convertOpenLayout(layout, buildings);
}

// Append a cap sector + 4 outward-facing walls for each building.
// The cap sits flat at z=ceilingZ so its floor-fan paints the top
// face; ceilingZ<floorZ skips the unwanted ceiling. The 4 side
// walls carry explicit floorZOverride=0 / ceilingZOverride=ceilingZ
// so the geometry builder paints them spanning the full room
// height instead of reading the cap sector's degenerate heights.
function emitBuildingCubes(
  buildings: BuildingState[],
  sectors: Sector[],
  walls: Wall[],
  tileSize: number,
  ceilingZ: number,
  biomeId: string,
  terrain: TerrainConfig | null | undefined,
): void {
  for (const b of buildings) {
    const x0 = b.tileX * tileSize;
    const y0 = b.tileY * tileSize;
    const x1 = x0 + b.width * tileSize;
    const y1 = y0 + b.height * tileSize;
    const verts: Vec2[] = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    // Anchor the cube to the terrain. Without this every building
    // floats at z=0 on hilly surface scenes — the player ends up
    // underneath or above its actual cube. Sample the 4 corners
    // and use the LOWEST so the cube's bottom is fully below
    // ground (any visible gap reads as the cube resting on the
    // highest corner instead of floating mid-air over the lowest).
    // Authored maps + dungeons don't ship a terrain config, so
    // this collapses to 0 there.
    let baseZ = 0;
    if (terrain) {
      const z00 = terrainHeightAt(terrain, x0, y0);
      const z10 = terrainHeightAt(terrain, x1, y0);
      const z11 = terrainHeightAt(terrain, x1, y1);
      const z01 = terrainHeightAt(terrain, x0, y1);
      baseZ = Math.min(z00, z10, z11, z01);
    }
    const topZ = baseZ + ceilingZ;
    const sectorId = sectors.length;
    sectors.push({
      id: sectorId,
      verts,
      floorZ: topZ,
      ceilingZ: -1,
      floorTextureId: null,
      ceilingTextureId: null,
      ambient: 1.0,
      biomeId,
      buildingKind: b.kind,
    });
    for (let i = 0; i < verts.length; i++) {
      walls.push({
        sectorId,
        vertIdx: i,
        backSectorId: null,
        textureId: null,
        solid: true,
        floorZOverride: baseZ,
        ceilingZOverride: topZ,
        buildingKind: b.kind,
      });
    }
  }
}

function convertAuthoredMap(
  layout: SceneLayout,
  src: SectorMap,
  buildings: BuildingState[],
): ConverterResult {
  const biomeId = layout.biome ?? 'default';
  const palette = biomePaletteFor(biomeId);
  const floorColor = parseHex(palette.floor);
  const wallColor = darkenColor(parseHex(palette.wall), 0.15);
  const ceilingColor = darkenColor(floorColor, 0.45);
  const wallHeightTiles = biomeWallHeightTilesFor(biomeId);
  const ceilingZ = WALL_HEIGHT_WORLD * wallHeightTiles;
  const tileSize = layout.tileSize ?? 32;
  const sectors: Sector[] = src.sectors.map((s) => ({
    ...s,
    verts: s.verts.map((v) => ({ x: v.x, y: v.y })),
  }));
  const walls: Wall[] = src.walls.map((w) => ({ ...w }));
  // Authored maps (dungeons + editor) never carry terrain — pass
  // null so building floors anchor at the authored z=0.
  emitBuildingCubes(
    buildings,
    sectors,
    walls,
    tileSize,
    ceilingZ,
    biomeId,
    null,
  );
  const map = {
    sectors,
    walls,
    lights: src.lights.map((l) => ({ ...l })),
    bounds: { ...src.bounds },
  };
  // Split partially-overlapping walls into shared sub-segments,
  // then auto-promote shared-edge walls into risers + lintels —
  // mirror of the server's preprocessing in Scene.rebuildSectorMap.
  splitOverlappingWalls(map);
  riserifyWalls(map);
  return { map, floorColor, ceilingColor, wallColor };
}

function convertOpenLayout(
  layout: SceneLayout,
  buildings: BuildingState[],
): ConverterResult | null {
  const wb = layout.worldBounds;
  if (!wb) return null;
  const biomeId = layout.biome ?? 'default';
  const palette = biomePaletteFor(biomeId);
  const floorColor = parseHex(palette.floor);
  const wallColor = darkenColor(parseHex(palette.wall), 0.15);
  const ceilingColor = darkenColor(floorColor, 0.45);
  const sector: Sector = {
    id: 0,
    verts: [
      { x: wb.x, y: wb.y },
      { x: wb.x + wb.w, y: wb.y },
      { x: wb.x + wb.w, y: wb.y + wb.h },
      { x: wb.x, y: wb.y + wb.h },
    ],
    floorZ: 0,
    // ceilingZ < floorZ = no ceiling geometry (surface).
    ceilingZ: -1,
    floorTextureId: null,
    ceilingTextureId: null,
    ambient: 1.0,
    biomeId,
  };
  const tileSize = layout.tileSize ?? 32;
  const wallHeightTiles = biomeWallHeightTilesFor(biomeId);
  const ceilingZ = WALL_HEIGHT_WORLD * wallHeightTiles;
  const sectors: Sector[] = [sector];
  const walls: Wall[] = [];
  emitBuildingCubes(
    buildings,
    sectors,
    walls,
    tileSize,
    ceilingZ,
    biomeId,
    layout.terrain,
  );
  const map: SectorMap = {
    sectors,
    walls,
    lights: [],
    bounds: { ...wb },
  };
  return { map, floorColor, ceilingColor, wallColor };
}

function parseHex(s: string | undefined): number {
  if (!s) return 0x555555;
  const clean = s.startsWith('#') ? s.slice(1) : s;
  const n = parseInt(clean, 16);
  return Number.isFinite(n) ? n : 0x555555;
}

function darkenColor(c: number, amount: number): number {
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  const t = Math.max(0, Math.min(1, 1 - amount));
  return (
    (Math.round(r * t) << 16) |
    (Math.round(g * t) << 8) |
    Math.round(b * t)
  );
}
