# Editor & Render Architecture

How a scene goes from author clicks to a triangulated mesh on screen, plus
the server-side collision view of the same data. Captures the invariants
the system relies on and the sharp edges that have already been stepped on.

## 1. Data model

### 1.1 LinedefMap (authoring + runtime canonical form)

`packages/shared/src/linedef.ts`

```
LinedefMap {
  vertices : Vec2[]
  linedefs : Linedef[]
  sidedefs : Sidedef[]
  sectors  : LinedefSector[]
}

Linedef {
  v1, v2  : vertex indices
  front   : sidedef index (always set)
  back    : sidedef index | null
  impassable, blockProjectiles, blockMonsters : bool
}

Sidedef {
  sectorId : number       // -1 = SENTINEL_SECTOR_ID (unowned placeholder)
  upperTex, midTex, lowerTex : textureId | null
}

LinedefSector {
  id, floorZ, ceilingZ, ambient, biomeId
  floorTextureId, ceilingTextureId
  buildingKind?           // set => render as a colored building cube
  floorNoise?  : TerrainConfig    // per-sector value-noise hills
  ceilingNoise?: TerrainConfig    // per-sector value-noise vaults (visual-only)
}
```

`TerrainConfig` (`packages/shared/src/terrain.ts`) carries
`amplitude / frequency / octaves / seed`. The runtime helper
`sectorNoiseOffsetAt(cfg, outer, holes, x, y)` returns the per-point
displacement: `terrainHeightAt(cfg, x, y) * perimeterFalloff(...)`.
The falloff is a smoothstep from 0 at any polygon edge to 1 at
`PERIMETER_FADE_WU = 48` wu inside, so a noise sector's height
matches the neighbour's flat floor at every shared portal edge —
without this, a wavy floor would leave a vertical seam at every
doorway.

This is the **only** scene representation that survives saves. Polygons
are derived on demand; they are never authored or stored.

### 1.2 PolygonMap / Sector (derived runtime form)

`packages/shared/src/sector.ts`

```
Sector {
  id, floorZ, ceilingZ, ...
  verts : Vec2[]          // CCW outer perimeter
  holes?: Vec2[][]        // CW inner rings (carved sub-regions)
}

Wall {
  sectorId, vertIdx
  ax, ay, bx, by?         // explicit endpoints for inner-loop walls
  textureId, solid, floorZOverride, ceilingZOverride
  buildingKind?
}
```

`PolygonMap` is what the renderer and the server collision actually
consume. It is recomputed by `linedefMapToPolygonMap` whenever the
underlying `LinedefMap` changes (on every editor save and on server
scene load).

## 2. Side convention (the load-bearing invariant)

A linedef has two sides. The sidedef referenced by `front` corresponds
to the **LEFT** half-plane of the directed line `v1 → v2` (positive
2D cross product). `back` corresponds to the RIGHT half-plane.

Equivalently: a sector that owns the FRONT of a linedef sits in the
LEFT half-plane. Verified against every outer room's CCW perimeter
(e.g. `s0`'s `l0..l3` all have `front=s0` with `s0`'s centroid on the
left of each edge).

**Every tool, every walker, and the collision system depends on this
convention.** If carve produces a linedef where the new sector's
geometric position disagrees with its claimed side, the polygon
walker can still close *a* loop but the resulting polygon doesn't
correspond to the sector's true region. Symptom catalogue:

- Renderer draws floor over a pit (parent polygon includes the
  carved area).
- Walls disappear on a room because the renderer treats the
  shared edge as an open portal to a sector that isn't there.
- 3-way junctions break the walker (multiple sector-incident edges
  per vertex, walker picks arbitrarily).

## 3. The editor

`packages/client/app/editor/scenes/SceneCanvas.tsx`
`packages/shared/src/linedefOps.ts`

### 3.1 Drawing tools

Tools convert authoring intent into linedef operations:

| Tool          | Action                                                    |
|---------------|-----------------------------------------------------------|
| Vert          | `addVertex` (with auto-split if it lands on a linedef)    |
| Line          | `addLinedef` (with auto-split + crossing-split)           |
| Rect-room     | Build explicit 4-corner chain → `makeSectorFromInteriorPoint` |
| Polygon-room  | Free-form chain → close → `makeSectorFromInteriorPoint`   |
| Pit / platform / vent / window | Rect with preset floor/ceiling overrides |

All tools eventually funnel through `makeSectorFromInteriorPoint`.

### 3.2 `addLinedef` auto-split chain

`addLinedef(map, v1, v2, sectorIdHint)`:

1. **Crossing split** — scan existing linedefs for true intersections
   with the new segment; for each, call `addVertex` at the
   intersection point. `addVertex` itself splits any linedef the new
   vertex lands on.
2. **Intermediate-vertex split** — scan all vertices for ones that
   lie on the new segment's interior, sort by `t` along the segment,
   and emit a *chain* of sub-linedefs between them rather than a
   single linedef.
3. **Endpoint dedup** — `addSingleLinedef` returns the existing
   linedef when one already connects v1 and v2 (in either order),
   instead of creating a duplicate.

The `sectorIdHint` argument seeds the front sidedef's `sectorId` so
the linedef has *some* owner pre-carve. It is then overwritten by
`makeSectorFromInteriorPoint` per the geometric side rule (§3.3),
so the hint value doesn't matter for correctness — only for
intermediate editor preview rendering.

### 3.3 `makeSectorFromInteriorPoint` (the carve)

After a tool has produced a closed loop of linedefs around an
interior point, this function:

1. Adds a new sector with the requested floor/ceiling/biome.
2. Computes the loop's centroid `(cx, cy)`.
3. For each candidate linedef in the loop, computes the cross
   product `(v2-v1) × (centroid-v1)` and assigns the new sector
   to the **front** side if positive (LEFT), **back** if negative
   (RIGHT). **Existing claims on the chosen side are overwritten
   (transferred) to the new sector** — this is intentional and
   handles the carve case where a sub-sector replaces the parent
   in the area it covers.
4. On the opposite side, leaves existing claims intact. When the
   opposite side is null (no back sidedef), samples outward 1 wu
   from the linedef midpoint away from the centroid; if that
   sample lands inside another sector (smallest-containing wins),
   adds a back sidedef pointing at it. Otherwise the opposite
   side is left as void.

The parent's polygon is never updated explicitly — it just
re-derives correctly from the updated linedef topology when
`linedefMapToPolygonMap` runs.

**Why "transfer on geometric match" is the right thing**: when a
pit is carved on the corner of an existing pit (sharing 3 of 4
edges with the parent's outer perimeter), the parent doesn't
extend to those edges anymore. The new sub-sector owns them. If
the parent keeps a stale `front=parent` claim on those edges, the
polygon walker can't determine the parent's true L-shape; it
either traces the wrong outer or fails at 3-way junctions.

## 4. LinedefMap → PolygonMap conversion

`linedefMapToPolygonMap(src)` in `packages/shared/src/linedef.ts`:

1. **`deriveSectorLoops(src)`** — for each sector, builds an
   adjacency map of (vertex → list of {ldIdx, side}) entries from
   every linedef whose front- or back-side sidedef references this
   sector, then walks every unvisited start-edge to produce a list
   of closed loops.

2. **`walkOneLoop`** — at each vertex during the walk:
   - Each linedef has a single "walk direction" tied to its side
     for this sector: **front → v1→v2, back → v2→v1**.
   - A candidate is *outgoing* iff `curVertex` is the walk-origin
     for its side (`v1` for front, `v2` for back).
   - When multiple outgoing candidates exist (3+ way junction),
     pick the one with the **largest CCW angle from the
     back-direction** (`atan2(prevVertex.y - curVertex.y,
     prevVertex.x - curVertex.x)`). This is the canonical
     "next edge in face" rotation: keeps the sector face
     consistently on the LEFT of each traversed edge.
   - Loop closes when `curVertex === startVid`.

3. **Outer / hole classification** — for each sector, the loop
   with the largest absolute signed area is the outer perimeter;
   the rest are holes. Winding is normalized so outer is CCW
   (positive area) and holes are CW (negative area). When
   reversing, vertex 0 is held in place and the rest are
   reversed — naive `.reverse()` puts the start vertex at the
   end and misaligns `vertexIds[i] ↔ linedefIds[i]`.

4. **Wall emission** — for every loop edge across ALL loops
   (outer + holes), emit a `Wall` with explicit `(ax, ay)→(bx, by)`
   endpoints and any necessary `floorZOverride` /
   `ceilingZOverride` for risers/lintels at portal seams between
   sectors of different elevation.

5. **Sector polygon** — `sector.verts` is the OUTER perimeter only;
   `sector.holes` carries the inner rings for polygon-with-holes
   triangulation.

## 5. Renderer

`packages/client/lib/game/fps.v2/sectorGeometry.ts`

### 5.1 Pass structure

Pixi v8 mesh per pass, depth test `LEQUAL`:

1. **Colored sector mesh** (`buildSectorGeometry`) — building cubes
   only. Real dungeon floors/ceilings/walls fall through to the
   textured passes.
2. **Textured floor** (`buildTexturedFloorGeometry`) — one mesh
   for all non-building sector floors. Polygon-with-holes path
   when `sector.holes` is set (earcut); plain fan otherwise.
3. **Textured ceiling** (`buildTexturedCeilingGeometry`) — same
   shape as floor, reversed winding so the face points down.
4. **Textured wall** (`buildTexturedWallGeometry`) — one quad per
   wall, with overrides applied for riser/lintel heights. Wall
   normal is `(dy, -dx)` of `b-a`, used for sun-direction
   shading.

Co-planar later passes win on `LEQUAL` so textured overdraw cleanly
replaces the colored fallback where textures exist.

### 5.2 Polygon-with-holes triangulation

`triangulateWithHoles(outer, holes[])` concatenates outer verts
followed by each hole's verts into a single flat buffer, passes
hole-start indices to `earcut`, and returns triangle indices into
that synthetic buffer. The caller fills positions in the same
order so indices line up.

A pit is a separate sub-sector with its own floor/ceiling mesh AND
a hole in the parent's floor/ceiling mesh. Without the hole, the
parent's floor occludes the pit visually even when collision
correctly places the player inside the pit.

### 5.3 Noise-mesh subdivision

`sectorGeometry.ts:subdivideTriangles` runs on every floor/ceiling
mesh whose sector carries a noise config. It does midpoint
subdivision until every edge in the mesh is `≤ NOISE_SUBDIV_STRIDE`
(24 wu), then samples noise + perimeter falloff at every output
vertex.

The subdivider splits **only edges that individually exceed the
stride**, not the whole triangle: 1-edge → bisect into 2 sub-
triangles, 2-edge → 3 sub-triangles, 3-edge → standard 1-to-4
split. A persistent midpoint cache shares new vertices across
adjacent triangles. Without this rule, the old "split if any edge
is long → add midpoints on all three" version produced T-junctions
— a long-edged triangle would insert a midpoint on a short edge
shared with a neighbour whose own longest edge happened to be
short. The neighbour wouldn't split, so its un-midpointed edge
sat across from a new vertex → a crack opened against the skybox
on every noise-room floor.

### 5.4 Wall endpoint resolution

Outer-loop walls index into `sector.verts` via `wall.vertIdx`.
Inner-loop walls (around carved holes) have their endpoints stored
explicitly as `wall.ax, ay, bx, by` since `sector.verts` only
contains the outer perimeter. The renderer prefers explicit
endpoints when present, falls back to `sector.verts[vertIdx]`
otherwise.

`packages/server/src/scene.ts` has a `wallEndpoints(wall, sector)`
helper that mirrors this rule for the five collision call sites.
Without it, server crashes with
`Cannot read properties of undefined (reading 'x')` when an
inner-loop wall's `vertIdx` doesn't exist in `sector.verts`.

## 6. Server collision

`packages/server/src/scene.ts`

### 6.1 `floorAt(x, y, cap)` — smallest containing sector

For a query at `(x, y)` with a step-up cap, picks the sector whose
polygon contains the point AND whose `floorZ ≤ cap`, choosing the
one with the **smallest polygon area** (the innermost containing
sub-sector). This is the inverse of "highest floor wins" — it
naturally handles both pits (sub-sector below parent) and platforms
(sub-sector above parent) by picking the immediate parent in the
nest, regardless of sign.

When the picked sector carries `floorNoise`, `sectorNoiseOffsetAt`
is added on top so the returned floor matches the visible noise
mesh. Floor noise is collidable: the player walks on the hills,
step-up gating treats noise gradients like any other ramp, and
the perimeter falloff guarantees a smooth zero-displacement seam
at every shared portal edge.

### 6.2 `ceilingAt(x, y, fromFloor)` — two-step

1. Find the smallest containing sector. The disqualifier uses each
   candidate sector's **effective floor** at `(x, y)` (baseline
   `floorZ` plus its own floor-noise displacement), with a 0.5 wu
   tolerance, compared against `fromFloor`. Without the effective-
   floor comparison, a noise trough that put the player slightly
   below the baseline would knock the sector out of the scan, the
   overhead pass would then catch the same sector as an overhead,
   and the ceiling would collapse to 0 (head-clearance fails
   everywhere a trough lands).
2. Scan for overhead sub-sectors strictly above the containing
   sector's effective floor — those *cap* the headroom at the
   overhead's underside, not the room ceiling above them.

This is what lets the player walk *under* an overhead platform
without being teleported up onto it.

Ceiling noise is **renderer-only**. The renderer tessellates and
displaces the ceiling mesh; server collision uses the flat
`ceilingZ`. This is intentional — a big ceiling-noise amplitude
could otherwise pinch the headroom below `PLAYER_HEIGHT_STAND`
and seal off a room from movement. For collidable overhangs,
carve an authored sub-sector with an explicit lower `ceilingZ`
(a vent or soffit primitive) — those hit the head-clearance
check because they're hard geometric features.

### 6.3 Head-clearance check

`circleSweepPassable` / `findBlockingWall` / `depenetratePosition`
all include `if (wallBot >= playerTop) continue;` — a wall whose
bottom is at or above the player's top doesn't block them. Lintels
above doorways pass this check. Riser walls (top within step-up
reach) similarly fall through to `wallTop <= stepLimitTop`.

### 6.4 `MOVE_DEBUG=1`

Setting this env var on the server enables diagnostic logging in
`circleSweepPassable`: each move attempt prints the dest sector,
floorAt / ceilingAt results, and which wall (if any) rejected the
sweep. Useful when collision and the editor disagree.

### 6.5 Client mirror

The client has its own `floorAt(x, y)` in
`packages/client/lib/game/fps.v2/index.ts` used to position the
camera. It mirrors the server's "smallest containing sector wins"
rule AND the floor-noise offset — without the noise term, the
renderer draws hills under the player but the camera sits at the
flat baseline, so the player visibly floats above (or sinks
below) the mesh by up to the noise amplitude.

## 7. Known sharp edges

- **Old scenes carry corrupt data.** The pre-fix carve assigned
  `front=parent, back=newSector` regardless of geometry, leaving
  the parent with a stale front claim on edges it no longer
  extends to. The fix is in for new carves, but existing scenes
  with corrupted linedefs must be redrawn to clean them up.

- **Platform-intersects-wall.** When a platform sub-sector shares
  an edge with the parent room's outer wall, the shared edge ends
  up with the platform on one side and void on the other — there
  is no wall texture to render. Geometrically correct; visually
  reads as a "missing texture" gap. Open.

- **Loop reversal preserves vertex 0.** The naive `.reverse()`
  moves `vertexIds[0]` to the end, which misaligns
  `linedefIds[i] ↔ vertexIds[i]/(i+1)%n`. Always rotate:
  `[v[0], ...v.slice(1).reverse()]` for `vertexIds`, plain reverse
  for `linedefIds` and `sides`.

- **3-way junctions resolve by rotational pick.** The walker now
  handles them deterministically, but the resulting loop is
  whatever the geometry implies — if the data is ambiguous (e.g.
  two sectors fully overlap), the walker still picks *some* loop.
  Validation should flag overlapping sectors at carve time.

- **Sentinel sector id (`-1`).** Legacy dumps and freshly-added
  linedefs can have sidedefs pointing at `SENTINEL_SECTOR_ID`.
  `buildSectorAdjacency` skips these so a dangling draw-chain
  pointing at the placeholder doesn't poison any real sector's
  perimeter walk. Zod's `SidedefSchema` accepts `min(-1)`.

## 8. The carve-then-render contract in one paragraph

The editor produces only linedefs. Carving any new sector assigns
each candidate edge to the side the new sector geometrically
occupies (front=LEFT, back=RIGHT of `v1→v2`), transferring stale
claims. The polygon converter walks each sector's incident edges
in direction-of-side order, picks the next-edge-in-face by
rotational angle, and emits an outer ring plus any holes. The
renderer earcuts the outer-minus-holes for floor/ceiling and
emits one quad per wall edge with explicit endpoints. The server
mirrors the same polygon model for collision; both client camera
floor and server step-up logic pick the smallest containing
sector at each query point so pits descend and platforms rise
naturally.

## 9. Procgen uses the same path

`packages/server/src/procgen/` builds polygon sectors from
generator-emitted region rects (`generators/bsp.ts` →
`RegionSet`), then runs the assembler at
`packages/server/src/procgen/assemble.ts`:

1. Build a raw `SectorMap` — one sector per region rect, four
   solid walls each. Shared edges are duplicated at this point
   (each side emits its own wall).
2. `polygonMapToLinedefMap` interns verts at 0.5wu and buckets
   walls by undirected edge — shared edges land as two-sided
   linedefs, all initially `impassable: true` because both source
   walls were solid.
3. The assembler flips two-sided linedefs to passable
   (`impassable / blockProjectiles / blockMonsters = false`) so
   the player can walk between regions. One-sided linedefs along
   the outer perimeter stay solid.
4. `linedefMapToPolygonMap` produces the final `SectorMap` the
   same way the editor's saved scenes do — same loop walk, same
   rotational pick at junctions, same wall emission with explicit
   endpoints.
5. The result rides on `SceneLayout.authoredSectorMap` next to a
   rasterised `tileGrid` that exists only for legacy spawn snap
   + AI grid.

So everything in §2-§7 applies to procgen scenes too: the side
convention, the loop walker's rotational pick, the smallest-
containing-sector lookup for floor / ceiling, the wall-endpoint
fallback. The runtime can't tell a procgen floor from an authored
scene by looking at the `SectorMap` it consumes.
