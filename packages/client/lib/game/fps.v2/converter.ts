// Tile-grid → SectorMap converter. v2's content model is sector-
// based, but every existing dungeon is authored as a tile grid;
// this converter bridges the two so we get free coverage of every
// authored level the day v2 lights up.
//
// Phase 2.0 strategy: emit one sector per walkable tile (no
// merging). The "real" converter that detects connected
// components and triangulates them into convex polygons can come
// later as an optimisation — it cuts the draw count but doesn't
// change the visual output. For now the priority is making the
// geometry pipeline correct end-to-end on real maps.
//
// Walls: for each walkable tile, scan its 4 neighbours. Any
// neighbour that's non-walkable becomes a wall edge between the
// two cells.
//
// Output coordinate convention: floor at z=0, ceiling at
// z=WALL_HEIGHT_WORLD × biome.wallHeightTiles. World (x, y) in
// pixels, matching the rest of the codebase.

import {
  biomePaletteFor,
  biomeWallHeightTilesFor,
  decodeTileGrid,
  isWalkableTileId,
  type BuildingState,
  type SceneLayout,
} from '@dumrunner/shared';
import type { SectorMap, Sector, Wall, Vec2 } from './types';

// Mirrors v1's WALL_HEIGHT_WORLD constant. Kept local to the v2
// module so the renderer doesn't reach into fps.ts internals.
// Biome wallHeightTiles scales the ceiling independently per
// biome (a wallHeightTiles of 1.5 = 1.5 × this).
const WALL_HEIGHT_WORLD = 32;

export type ConverterResult = {
  map: SectorMap;
  // Floor colour (0xrrggbb) sampled from the biome palette,
  // used by sectorGeometry as a per-vertex tint until textures
  // are wired in Phase 2.5.
  floorColor: number;
  // Ceiling colour for visual contrast against the floor while
  // we lack textures.
  ceilingColor: number;
  // Wall colour. Slightly darker than floor for readability.
  wallColor: number;
};

export function convertLayoutToSectorMap(
  layout: SceneLayout,
  buildings: BuildingState[] = [],
): ConverterResult | null {
  const tileGrid = layout.tileGrid;
  if (!tileGrid) {
    // Surface / no-grid scenes: emit a single open-air sector
    // covering the layout's worldBounds. No walls, no ceiling —
    // the geometry builder skips both when ceilingZ <= floorZ.
    // Buildings still drop cubes on top so the player can see
    // them.
    return convertOpenLayout(layout, buildings);
  }
  const tiles = decodeTileGrid(tileGrid);
  const { width, height, originTileX, originTileY, tileSize } = tileGrid;

  // Walkability lookup by local grid coordinates (0..width,
  // 0..height) — the grid's "local" frame, not world tile coords.
  function isWalkable(lx: number, ly: number): boolean {
    if (lx < 0 || ly < 0 || lx >= width || ly >= height) return false;
    return isWalkableTileId(tiles[ly * width + lx]);
  }

  // World-coord helpers. Local cell (lx, ly) corresponds to
  // tile (originTileX + lx, originTileY + ly) which spans
  // world coords [tx * tileSize, (tx + 1) * tileSize).
  function worldX(lx: number): number {
    return (originTileX + lx) * tileSize;
  }
  function worldY(ly: number): number {
    return (originTileY + ly) * tileSize;
  }

  const biomeId = layout.biome ?? 'default';
  const palette = biomePaletteFor(biomeId);
  const floorColor = parseHex(palette.floor);
  const wallColor = darkenColor(parseHex(palette.wall), 0.15);
  const ceilingColor = darkenColor(floorColor, 0.45);
  const wallHeightTiles = biomeWallHeightTilesFor(biomeId);
  const ceilingZ = WALL_HEIGHT_WORLD * wallHeightTiles;

  const sectors: Sector[] = [];
  const walls: Wall[] = [];
  // World-space bounding box accumulator. Used by the camera
  // far-plane + the skybox sizing; trivial cost to compute here.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      if (!isWalkable(lx, ly)) continue;
      const x0 = worldX(lx);
      const y0 = worldY(ly);
      const x1 = x0 + tileSize;
      const y1 = y0 + tileSize;
      // Sector vertices counter-clockwise (viewed from above):
      //   SW → SE → NE → NW
      // Matches the right-hand-rule winding we'll later assume
      // when generating wall normals.
      const verts: Vec2[] = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
      const sectorId = sectors.length;
      sectors.push({
        id: sectorId,
        verts,
        floorZ: 0,
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

      // Wall edges: each side that touches a non-walkable
      // neighbour becomes a wall. The vert pair is keyed to the
      // sector's vertex ordering above so the renderer can pull
      // both endpoints by sectorId + vertIdx.
      //   side 0: SW→SE (south, y- side)
      //   side 1: SE→NE (east, x+ side)
      //   side 2: NE→NW (north, y+ side)
      //   side 3: NW→SW (west, x- side)
      if (!isWalkable(lx, ly - 1)) {
        walls.push({
          sectorId,
          vertIdx: 0,
          backSectorId: null,
          textureId: null,
          solid: true,
        });
      }
      if (!isWalkable(lx + 1, ly)) {
        walls.push({
          sectorId,
          vertIdx: 1,
          backSectorId: null,
          textureId: null,
          solid: true,
        });
      }
      if (!isWalkable(lx, ly + 1)) {
        walls.push({
          sectorId,
          vertIdx: 2,
          backSectorId: null,
          textureId: null,
          solid: true,
        });
      }
      if (!isWalkable(lx - 1, ly)) {
        walls.push({
          sectorId,
          vertIdx: 3,
          backSectorId: null,
          textureId: null,
          solid: true,
        });
      }
    }
  }

  if (sectors.length === 0) {
    return null;
  }

  // Buildings on dungeon floors render as solid cubes. Same
  // height as the surrounding walls so they fit visually; their
  // own ceiling+floor pass paints a top cap so the cube reads
  // as a closed volume from above.
  emitBuildingCubes(buildings, sectors, walls, tileSize, ceilingZ, biomeId);

  const map: SectorMap = {
    sectors,
    walls,
    lights: [],
    bounds: {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
    },
  };
  return { map, floorColor, ceilingColor, wallColor };
}

// Append a "cap" sector + 4 outward-facing walls for each
// building. The cap sector sits flat at z=ceilingZ so its
// floor-fan paints the top face of the cube; ceilingZ<floorZ
// sentinel skips the unwanted ceiling. The 4 side walls carry
// explicit floorZOverride=0 / ceilingZOverride=ceilingZ so the
// geometry builder paints them spanning the full room height
// instead of reading from the cap sector's (degenerate-for-
// walls) heights.
function emitBuildingCubes(
  buildings: BuildingState[],
  sectors: Sector[],
  walls: Wall[],
  tileSize: number,
  ceilingZ: number,
  biomeId: string,
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
    const sectorId = sectors.length;
    sectors.push({
      id: sectorId,
      verts,
      // Floor=ceilingZ paints a cap at the top of the cube.
      floorZ: ceilingZ,
      // Sentinel: <floorZ → no ceiling geometry. Cube is one
      // closed top + 4 sides, nothing else.
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
        floorZOverride: 0,
        ceilingZOverride: ceilingZ,
        buildingKind: b.kind,
      });
    }
  }
}

// Open-floor surface: one big sector covering the layout's
// world bounds, no ceiling, no walls. Sky reads through where
// the ceiling would be (Phase 4 ships a skybox; until then we
// fall back to the Pixi background colour, which is fine).
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
  // Ceiling colour is unused (no ceiling geometry on the
  // surface), but the bundle requires a value so the geometry
  // builder doesn't crash if a future change starts referencing
  // it. Same hue as floor, dimmer.
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
    // Sentinel: ceilingZ < floorZ means "no ceiling" to the
    // geometry builder. Picked rather than an extra flag to keep
    // the Sector shape unchanged.
    ceilingZ: -1,
    floorTextureId: null,
    ceilingTextureId: null,
    ambient: 1.0,
    biomeId,
  };
  // Use a per-surface tileSize fallback. Surface scenes carry
  // their own (32 today); we read it off the layout when set
  // so building tiles align to whatever the server is using.
  const tileSize = layout.tileSize ?? 32;
  // No biome-authored wall height on the surface, so cube
  // height defaults to one wall.
  const wallHeightTiles = biomeWallHeightTilesFor(biomeId);
  const ceilingZ = WALL_HEIGHT_WORLD * wallHeightTiles;
  const sectors: Sector[] = [sector];
  const walls: Wall[] = [];
  emitBuildingCubes(buildings, sectors, walls, tileSize, ceilingZ, biomeId);
  const map: SectorMap = {
    sectors,
    walls,
    lights: [],
    bounds: { ...wb },
  };
  return { map, floorColor, ceilingColor, wallColor };
}

// "#rrggbb" or "rrggbb" → 0xrrggbb. Falls back to mid-grey on
// unparseable input so we never render void.
function parseHex(s: string | undefined): number {
  if (!s) return 0x555555;
  const clean = s.startsWith('#') ? s.slice(1) : s;
  const n = parseInt(clean, 16);
  return Number.isFinite(n) ? n : 0x555555;
}

// Lerp a colour toward black by `amount` (0..1). Used so the
// ceiling reads visibly darker than the floor without a separate
// palette entry today.
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
