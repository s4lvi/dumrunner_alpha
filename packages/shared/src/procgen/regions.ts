import type { HazardZoneCategory } from '../content/types';
import type { Vec2 } from '../geometry';

export type Region = {
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
  category: HazardZoneCategory;
  // Defaults to 'room'. Corridors are skinny connectors carved
  // between adjacent inset rooms; they don't accept room template
  // stamps, don't spawn enemies, and don't get hazard categories
  // beyond the base biome.
  kind?: 'room' | 'corridor';
  // World-space polygon override. When set, the assembler emits a
  // sector with these verts instead of the four-corner rect — this
  // is how chamfered corners produce octagonal rooms while still
  // keeping `tileX/Y/W/H` as the bounding box for rasterisation,
  // adjacency tests, and anchor placement.
  polygonVerts?: ReadonlyArray<Vec2>;
  // Tile-aligned solid obstacles inside the region. Each pillar
  // emits a floor-to-ceiling building-cube sector + carves its
  // tiles out of the walkable grid. Used to break up large rooms.
  pillars?: ReadonlyArray<{
    tileX: number;
    tileY: number;
    tileW: number;
    tileH: number;
  }>;
  // Tile-aligned footprint override. When set, the rasteriser
  // marks the union of these rects as walkable instead of the
  // full bounding rect. Lets a single Region encode a non-
  // rectangular footprint (e.g. an L-shaped corridor) without
  // splitting it across multiple Regions — which would otherwise
  // expose the inner-corner dead-end walls between the splits.
  subRects?: ReadonlyArray<{
    tileX: number;
    tileY: number;
    tileW: number;
    tileH: number;
  }>;
  // Vertical sub-sectors carved out of the room interior:
  // platforms (positive floorZ — raised stages, climbable / jumpable),
  // pits (negative floorZ — sunken hazards / shortcuts).
  // Each emits an extra polygon sector inside the room's footprint
  // at the given floorZ; riser walls fall out of the linedef
  // round-trip's shared-edge handling.
  verticalSubSectors?: ReadonlyArray<{
    tileX: number;
    tileY: number;
    tileW: number;
    tileH: number;
    floorZ: number;
  }>;
  // Static point lights placed inside the room. Procgen scatters
  // these from `decorate`; assemble emits them into
  // `authoredSectorMap.lights` with deterministic ids.
  lights?: ReadonlyArray<{
    x: number;          // world coords
    y: number;
    z: number;          // height above sector floor
    radius: number;
    color: number;      // 0xrrggbb
    intensity: number;
  }>;
};

export type RegionSet = {
  regions: Region[];
  spawnRegionIndex: number;
  stairsRegionIndex: number | null;
};
