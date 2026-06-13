// Server-side tile-grid → SectorMap converter. Mirrors the client's
// `fps.v2/converter.ts` polygon emission (so both sides see the same
// shape) but drops the colour bundle: server collision doesn't render,
// it just needs the geometry. Stays in sync structurally with the
// client converter; if you change one, change both until the procgen
// rewrite makes both call-sites obsolete.

import {
  buildingCubeScale,
  decodeTileGrid,
  isWalkableTileId,
  terrainHeightAt,
  type BuildingState,
  type SceneLayout,
  type Sector,
  type SectorMap,
  type TerrainConfig,
  type Vec2,
  type Wall,
} from '@dumrunner/shared';

// Mirrors v1's WALL_HEIGHT_WORLD. Biome wallHeightTiles scales the
// ceiling — server doesn't need the biome to be authoritative (no
// gameplay reads non-default ceilings today), so we hard-code the
// default. Client gets the per-biome value via its own converter.
export const WALL_HEIGHT_WORLD = 32;

export function buildSectorMap(
  layout: SceneLayout,
  buildings: BuildingState[] = [],
): SectorMap | null {
  const tileGrid = layout.tileGrid;
  if (!tileGrid) {
    return buildOpenSectorMap(layout, buildings);
  }
  const tiles = decodeTileGrid(tileGrid);
  const { width, height, originTileX, originTileY, tileSize } = tileGrid;

  function isWalkable(lx: number, ly: number): boolean {
    if (lx < 0 || ly < 0 || lx >= width || ly >= height) return false;
    return isWalkableTileId(tiles[ly * width + lx]);
  }

  function worldX(lx: number): number {
    return (originTileX + lx) * tileSize;
  }
  function worldY(ly: number): number {
    return (originTileY + ly) * tileSize;
  }

  const biomeId = layout.biome ?? 'default';
  const ceilingZ = WALL_HEIGHT_WORLD;
  const platforms = layout.platforms ?? [];

  function tileFloorZ(lx: number, ly: number): number {
    if (platforms.length === 0) return 0;
    const tx = originTileX + lx;
    const ty = originTileY + ly;
    let best = 0;
    for (const p of platforms) {
      if (tx < p.tileX || tx >= p.tileX + p.w) continue;
      if (ty < p.tileY || ty >= p.tileY + p.h) continue;
      if (p.floorZ > best) best = p.floorZ;
    }
    return best;
  }

  const sectors: Sector[] = [];
  const walls: Wall[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const sides: Array<{ vertIdx: number; nx: number; ny: number }> = [
    { vertIdx: 0, nx: 0, ny: -1 },
    { vertIdx: 1, nx: 1, ny: 0 },
    { vertIdx: 2, nx: 0, ny: 1 },
    { vertIdx: 3, nx: -1, ny: 0 },
  ];

  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      if (!isWalkable(lx, ly)) continue;
      const x0 = worldX(lx);
      const y0 = worldY(ly);
      const x1 = x0 + tileSize;
      const y1 = y0 + tileSize;
      const verts: Vec2[] = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
      const myFloorZ = tileFloorZ(lx, ly);
      const sectorId = sectors.length;
      sectors.push({
        id: sectorId,
        verts,
        floorZ: myFloorZ,
        ceilingZ,
        floorTextureId: null,
        ceilingTextureId: null,
        ambient: 1.0,
        biomeId,
      });
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;

      for (const side of sides) {
        const nlx = lx + side.nx;
        const nly = ly + side.ny;
        if (!isWalkable(nlx, nly)) {
          walls.push({
            sectorId,
            vertIdx: side.vertIdx,
            backSectorId: null,
            textureId: null,
            solid: true,
            ...(myFloorZ > 0
              ? { floorZOverride: 0, ceilingZOverride: ceilingZ }
              : {}),
          });
          continue;
        }
        const nFloorZ = tileFloorZ(nlx, nly);
        if (nFloorZ < myFloorZ) {
          // Neighbour at lower floor → emit riser owned by this tile.
          walls.push({
            sectorId,
            vertIdx: side.vertIdx,
            backSectorId: null,
            textureId: null,
            solid: false,
            floorZOverride: nFloorZ,
            ceilingZOverride: myFloorZ,
          });
        }
      }
    }
  }

  if (sectors.length === 0) return null;

  emitBuildingCubes(buildings, sectors, walls, tileSize, ceilingZ, biomeId);

  return {
    sectors,
    walls,
    lights: [],
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

function buildOpenSectorMap(
  layout: SceneLayout,
  buildings: BuildingState[],
): SectorMap | null {
  const wb = layout.worldBounds;
  if (!wb) return null;
  const biomeId = layout.biome ?? 'default';
  const sector: Sector = {
    id: 0,
    verts: [
      { x: wb.x, y: wb.y },
      { x: wb.x + wb.w, y: wb.y },
      { x: wb.x + wb.w, y: wb.y + wb.h },
      { x: wb.x, y: wb.y + wb.h },
    ],
    floorZ: 0,
    // ceilingZ < floorZ ⇒ "no ceiling geometry" sentinel.
    ceilingZ: -1,
    floorTextureId: null,
    ceilingTextureId: null,
    ambient: 1.0,
    biomeId,
  };
  const tileSize = layout.tileSize ?? 32;
  const ceilingZ = WALL_HEIGHT_WORLD;
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
  return {
    sectors,
    walls,
    lights: [],
    bounds: { ...wb },
  };
}

export function emitBuildingCubes(
  buildings: BuildingState[],
  sectors: Sector[],
  walls: Wall[],
  tileSize: number,
  ceilingZ: number,
  biomeId: string,
  terrain?: TerrainConfig | null,
): void {
  for (const b of buildings) {
    // Open doors: movement + projectiles pass through, so we
    // intentionally don't emit cube walls. Closed / non-door
    // buildings emit normally. Matches the legacy collision
    // path's `isPointInAnyBuilding` open-door bypass.
    if (b.kind === 'wall_door' && b.open === true) continue;
    // Bench-sized buildings collide as a smaller cube than their tile
    // footprint (matches the visual shrink in the client render paths
    // via the shared buildingCubeScale). The tile footprint stays full
    // for placement/occupancy; only the solid extent shrinks so the
    // player can brush past a bench instead of a full wall.
    const scale = buildingCubeScale(b.kind);
    const insetPx = scale.inset * tileSize;
    const x0 = b.tileX * tileSize + insetPx;
    const y0 = b.tileY * tileSize + insetPx;
    const x1 = (b.tileX + b.width) * tileSize - insetPx;
    const y1 = (b.tileY + b.height) * tileSize - insetPx;
    const verts: Vec2[] = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    // Anchor the cube to terrain on hilly open scenes. Without
    // this collision uses floorZ=0 walls — players see the cube
    // floating at z=0 (client) AND can wedge under it (server),
    // because both sides take floorZOverride=0 as gospel even
    // when the terrain at the footprint dips well below. Sample
    // the 4 corners and use the LOWEST so the cube is always
    // grounded somewhere (no visible float on slopes; the high
    // side gets buried).
    let baseZ = 0;
    if (terrain) {
      const z00 = terrainHeightAt(terrain, x0, y0);
      const z10 = terrainHeightAt(terrain, x1, y0);
      const z11 = terrainHeightAt(terrain, x1, y1);
      const z01 = terrainHeightAt(terrain, x0, y1);
      baseZ = Math.min(z00, z10, z11, z01);
    }
    const topZ = baseZ + ceilingZ * scale.heightFrac;
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
