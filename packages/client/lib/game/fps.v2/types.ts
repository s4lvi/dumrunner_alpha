// Shared data shapes for the v2 sector renderer. Lives client-
// side only; nothing here goes on the wire. Sectors are derived
// (from a v1 tile grid by `converter.ts`, eventually also from
// hand-authored content) so the server never sees them.

// All world units are pixels, same as v1 SceneLayout. Z is the
// new axis — height above the floor baseline. Camera height is
// fixed at WALL_HEIGHT_WORLD / 2 today (mirrors v1).

export type Vec2 = { x: number; y: number };

export type SectorMap = {
  sectors: Sector[];
  walls: Wall[];
  lights: V2Light[];
  // World-space bounding box. Used to size the far-plane and the
  // skybox dome; not load-bearing for geometry.
  bounds: { x: number; y: number; w: number; h: number };
};

export type Sector = {
  id: number;
  // Convex (or simple-concave; earcut handles either) polygon
  // on the world plane. Counter-clockwise winding.
  verts: Vec2[];
  // Floor / ceiling heights in world units. floorZ < ceilingZ.
  floorZ: number;
  ceilingZ: number;
  floorTextureId: string | null;
  ceilingTextureId: string | null;
  // Per-sector ambient contribution (0..1). Combined with light
  // contributions in the fragment shader.
  ambient: number;
  // Biome identifier — drives fog colour + texture fallback.
  biomeId: string;
  // Optional discriminator. Set to the building kind on
  // building-cap sectors so the colored mesh can skip them
  // when a textured shell exists. Absent on room sectors.
  buildingKind?: string;
};

export type Wall = {
  // Endpoint references: a wall is the edge between two ordered
  // verts of its front sector. The back sector (if any) shares
  // these vertices in its own winding.
  sectorId: number;
  vertIdx: number; // start vertex (winding direction)
  // null when this wall faces the void (outer perimeter); set
  // when the wall is a portal between two sectors at different
  // floor / ceiling heights → renders an "upper" or "lower"
  // wall segment for the height difference.
  backSectorId: number | null;
  textureId: string | null;
  // Mirrors the gameplay-level walkable test: if this wall is a
  // collision boundary the server's tile grid already enforces
  // (the renderer only reads this to decide whether to draw it).
  solid: boolean;
  // Optional explicit vertical span. Used for building-cube
  // walls: the cap sector sits at the top of the room
  // (floorZ = ceilingZ) so its own heights describe the cap,
  // not the cube's sides. When these are present the wall
  // geometry uses them directly instead of the front sector's
  // floor / ceiling. Absent for tile / sector walls.
  floorZOverride?: number;
  ceilingZOverride?: number;
  // Optional discriminator — set to the building kind on
  // building-cube walls so the colored mesh can omit them when
  // a textured shell exists for that kind. Mirrors the
  // matching field on Sector.
  buildingKind?: string;
};

export type V2Light = {
  // Stable id so dynamic lights can be addressed for update /
  // removal. Static lights use deterministic ids from the
  // converter (`"static:<sectorId>:<n>"`).
  id: string;
  x: number;
  y: number;
  z: number; // height above sector floor
  radius: number; // falloff to zero at this distance
  colour: number; // 0xrrggbb
  intensity: number; // multiplier, 0..n
  // Sector ids the light's volume can reach (own sector +
  // neighbours through compatible-height portals). Computed
  // offline for static lights, updated each frame for dynamic
  // lights whose owner moves. Empty = light is unculled
  // (defensive fallback; should never happen in practice).
  reachableSectors: number[];
};
