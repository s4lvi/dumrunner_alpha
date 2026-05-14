# DUM RUNNER v2 Graphics — Implementation Plan

Status: drafted, not started. Lives on the `v2-graphics` branch off main
(commit your in-flight fps.ts fog fix first, then this branch tracks the
engine refresh in isolation so the live raycaster keeps shipping).

## Goals

Three things the GDD's "v2 engine refresh" section commits to and the
current tile-raycaster can't deliver cheaply:

1. **Non-orthogonal walls (vector geometry).** Arbitrary polygon room
   shapes — cathedrals, alien-geometry chambers, naturally-curved
   caves. The tile grid guarantees right angles; we need sector
   polygons to break that.
2. **Multi-height floors + ceilings.** Pits, raised platforms,
   stairs as real height transitions, varying ceiling heights for
   atmosphere. Per-sector heights, not tile-height hacks.
3. **Lighting.** Coloured point lights with falloff, per-sector
   ambient, LOS shadowing. Today's renderer is flat ambient +
   distance fog.

## Non-goals

Spell these out so we don't drift:

- **No server changes.** Simulation stays where it is — 2D
  `(x, y)` positions, tile-grid collision, AI pathfinding, scene
  state shape. Sectors carry **visual height only**. The server
  doesn't know v2 exists.
- **No gameplay changes.** Extraction-shooter rules, loot,
  perihelion, etc. all unchanged.
- **No v1 removal.** The Wolfenstein raycaster keeps shipping on
  `main`. v2 lands as a parallel renderer behind a toggle and only
  becomes default after parity testing.
- **No 3D-models-for-entities (yet).** Enemies/props/projectiles
  stay as billboard sprites in 3D space — the existing animation
  system feeds frames into a textured quad facing the camera.
  Voxel/glTF enemies are a v3 conversation.

## Architectural choice — sector 2.5D, not full 3D

The current sim is fundamentally 2D — every `(x, y)` collision,
every AI pather, every minimap. Going full 3D for rendering only
buys us complexity without unlocking gameplay we want.

Sector model (Doom / Build engine lineage):

- **Sector**: a convex 2D polygon on the world plane, plus a
  `floorHeight`, `ceilingHeight`, `lightLevel`, and texture refs
  for floor and ceiling. A room is one sector or several stitched
  by portals.
- **Wall**: an edge between two vertices. Solid walls separate
  the sector from the outside; portal walls are transparent
  (connect two sectors at different heights → step / ledge).
- **Lights**: point lights with `(x, y, z, radius, colour,
  intensity)` baked or dynamic.

Why this is right for us:

- Gameplay simulation stays on the 2D plane. A pit is visually
  deep but the player can't fall into it (matches our existing
  collision model — the floor is wherever the tile grid says it
  is for movement, even if the renderer paints it at z=-32).
- Sector heights drive **visual** parallax + sense of place
  without rewriting AI or building placement.
- The tile-grid → sector converter is straightforward: each
  connected tile region of identical height + texture becomes one
  sector. Existing dungeons render in v2 with zero hand authoring.

## Renderer tech — Pixi v8 with custom shaders

We extend the existing Pixi v8 setup with our own `Mesh` +
`Shader` for sector geometry and a forward-shading fragment
shader for lighting. No new render-engine dependency. Pixi
continues to own the HUD, animation system, minimap, and editor
— and now also owns the v2 FPS viewport via custom geometry.

Why Pixi + custom shaders over Three.js / Babylon / raw WebGPU:

- **Zero bundle add.** Pixi v8 already ships with the app.
  Three.js would add ~600KB gzipped; on the Discord mobile
  embed first-paint that's a real cost.
- **Direct texture pipeline.** The existing animation system
  already returns `pixi.Texture`. No marshalling layer between
  one engine and another every frame a sprite changes.
- **Constrained scope = no engine needed.** Sector polygons,
  vertical walls, billboard sprites, ≤8 lights/fragment, no
  GLTF, no skeletal animation, no physics, no PBR materials.
  Pulling a full 3D engine to get a feature subset is overkill.
- **We already write Pixi-based 3D-ish projection math** in
  `fps.ts` (per-column ray + Mesh quads for textured walls).
  Same headspace, just generalised to non-axis-aligned geometry.

Cost vs Three.js: roughly +1–2 sessions on Foundation to write
the perspective camera matrix and the forward-shading fragment
shader. After that the per-phase velocity is the same.

What we write ourselves (vs getting free from Three):

- **Perspective projection.** A camera matrix (~30 lines) + the
  vertex shader that applies it. Yaw/pitch already plumbed
  through `applyLookDelta`.
- **Forward lighting shader.** Per-fragment loop over ≤8 lights
  with quadratic falloff (~50 lines GLSL). Lights bound as a
  uniform array; sector clustering keeps the count low.
- **Sector-aware draw order.** Front-to-back via depth buffer
  (Pixi v8 supports a depth-tested render pass via custom
  `RenderTexture` + WebGL state). No portal traversal needed.
- **Sprite billboarding.** Per-sprite quad oriented to the
  camera each frame. The animation system feeds the texture.

Why not Three.js / Babylon: bundle size + texture marshalling
cost, plus the engine surface area we'd consume is small enough
that "fighting the engine's abstractions" is a real ongoing
tax we'd rather not pay.

Why not raw WebGL / WebGPU: Pixi already gives us the GL
context, asset cache, shader compilation pipeline, render-loop,
input event integration. Dropping that to write everything from
scratch is months of work for zero gameplay payoff.

Why not WebGPU yet: browser support is mature but mobile
(especially Safari / Discord iOS embed) still lags. Pixi v8
has a WebGPU backend we can flip on later when adoption catches
up; our shader code is GLSL-with-uniforms which ports cleanly.

## Project structure

```
packages/client/lib/game/
  fps.ts                    # v1 raycaster (unchanged, lives forever)
  fps.v2/
    index.ts                # runFpsV2Game(host, init): GameHandle
    scene.ts                # Pixi renderer lifecycle + render loop
    camera.ts               # perspective matrix from yaw/pitch + selfX/Y
    sectorGeometry.ts       # sector polygon → triangulated Mesh; walls → quads
    sectorShader.ts         # vertex + fragment shaders (GLSL),
                            # uniform layout, light packing
    sectorLighting.ts       # static + dynamic light registry; sector clustering
    spriteLayer.ts          # billboard sprites for entities/projectiles
    skybox.ts               # ports v1's per-biome skybox
    input.ts                # mouse/touch → yaw/pitch (same contract as v1)
    converter.ts            # SceneLayout (tile grid) → SectorMap
    types.ts                # SectorMap, Sector, Wall, V2Light shape
```

The new renderer implements the existing `GameHandle` contract
verbatim — no callsite changes in `Game.tsx`. The dispatch in
`runnerFor(mode)` gains a third entry: `'fps-v2'`.

## Content model — SectorMap

New parallel-to-`SceneLayout` shape. Lives in the client; **not**
on the wire. Generated either by the auto-converter (v1 grids) or
by a new sector editor (v2 hand-authored levels).

```ts
type SectorMap = {
  sectors: Sector[];
  walls: Wall[];      // every edge in the map
  lights: V2Light[];
  // World-space bounding box, used to size camera far-plane +
  // skybox dome.
  bounds: { x: number; y: number; w: number; h: number };
};

type Sector = {
  id: number;
  // Convex polygon on the world plane (x, y).
  // Tessellated into triangles at scene build time.
  verts: { x: number; y: number }[];
  floorZ: number;      // world units; 0 = baseline
  ceilingZ: number;    // > floorZ
  floorTextureId: string | null;
  ceilingTextureId: string | null;
  // Ambient light contribution from this sector (0..1). Mixed
  // with point-light contributions per-fragment.
  ambient: number;
  // Biome reference for fog colour + ceiling/floor texture
  // fallback. Same id as today.
  biomeId: string;
};

type Wall = {
  // Endpoints reference sector vertices by index so a shared
  // edge between two sectors is one wall.
  from: { sector: number; vertIdx: number };
  to: { sector: number; vertIdx: number };
  // Null when this is an outer wall (sector → void). Set when
  // it's a portal between two sectors (different floor / ceiling
  // → upper / lower step rendering).
  backSector: number | null;
  textureId: string | null;
  // True when the wall blocks projectiles + LOS at gameplay
  // level — passed through to the server's existing 2D collision
  // (which uses `walkables` / tileGrid). The renderer reads this
  // for which faces to skip drawing.
  solid: boolean;
};

type V2Light = {
  x: number;
  y: number;
  z: number;             // world height above floor
  radius: number;        // falloff to zero at this distance
  colour: number;        // 0xrrggbb
  intensity: number;     // multiplier, 0..n
  // Optional: tied to an entity (a torch prop, a power link
  // pulse). Renderer updates `(x, y)` from the entity each frame.
  attachToPropId?: string;
};
```

## Lighting model

**Per-fragment forward shading with N lights — both static and
dynamic, day one.** Each fragment samples each in-range light,
sums contributions, multiplies the texture. No shadow maps in
v2.0; sector-cluster occlusion gives us "light doesn't reach
through a wall" for free.

- **Sector ambient** sets the base. Dark sectors read as dark
  even with no lights.
- **Static lights** — torches, fluorescents, glow strips placed
  in the SectorMap. Sector-clustered offline (at SectorMap build
  time): each light tagged with the sector set it can reach
  (own sector + neighbours through portals). The shader only
  iterates lights whose cluster contains the fragment's sector.
- **Dynamic lights** — muzzle flashes, explosions, grenade
  detonations, attached-to-prop pulses (e.g. Power Link). Same
  shader path as static; re-clustered each frame against the
  light's current world position. Cheap because re-cluster is
  just "which sector is this point in" plus a neighbour lookup.
- **Light count budget** — ≤8 lights affecting any one fragment
  (uniform array cap). The clustering keeps this realistic in
  practice: a corridor is one cluster, even a busy room rarely
  carries more than 4-5 in-range lights.
- **Distance fog** keeps the existing per-biome fog colour at
  the same `FOG_FULL_DIST` curve. Layers on top of lighting
  (lit fragment → fog blend) so a fog-tinted floor matches a
  fog-tinted wall (fixes the v1 hue parity issue at the
  architecture level).
- **Player flashlight** (optional, v2.1): a spotlight attached
  to the camera, narrow cone. Off by default.
- **Shadow maps**: deferred to v2.1+.

The clustering trick is straight Build-engine — we know which
sectors any given light can affect before the shader runs, so
the per-fragment loop iterates a small candidate set instead of
every light in the scene. No GPU spatial hash, no SSBO, no
compute shader.

Dynamic light API (called from gameplay code, e.g. on
`projectile_spawned` for a muzzle flash):

```ts
const id = lighting.addDynamic({
  x, y, z: 24,
  radius: 80,
  colour: 0xfff5a0,
  intensity: 2.0,
  ttlMs: 60,           // auto-removed after ttl
});
// or
lighting.attachToProp(propId, { ... });  // tracks the prop each frame
```

## Phases — v2.0 ship plan

Six phases. Each ships in isolation, each is a single PR-shaped
chunk. The renderer becomes daily-driver only after Phase 6.
Sector editor and shadow maps are scoped out of v2.0 — they
land in v2.1.

### Phase 1 — Foundation (2–3 sessions)

Goal: an empty Pixi v8 scene with custom-shader geometry
rendering a single flat-coloured quad in front of the camera,
camera responding to mouse + touch look.

- New `runFpsV2Game(host, init)` implementing `GameHandle`.
  Most methods stub; the renderer lifecycle is real.
- `camera.ts` — perspective matrix from `yaw`, `pitch`,
  `selfX/Y`, vertical FOV, aspect ratio. Yaw/pitch plumbed
  through the existing `applyLookDelta`. Same constants v1
  uses (`POINTER_SENSITIVITY`, `PITCH_LIMIT`).
- `sectorShader.ts` — minimal vertex shader that applies the
  camera matrix to world-space vertex positions; minimal
  fragment shader that samples a texture. No lighting yet.
- Wire a single test mesh (a tinted quad on the floor) to
  confirm projection works.
- Wire into `Game.tsx` `runnerFor()` and add `'fps-v2'` to
  `RENDERER_CYCLE`. Hidden behind a `?v2=1` query-string gate
  so it doesn't reach production users.
- HUD (Pixi overlay containing the existing HUD layers) keeps
  rendering on top of the v2 scene; both are children of the
  same Pixi `Application`.

Exit criteria: load a server, hit `?v2=1`, see a flat-coloured
quad with the camera responding to mouse-look. Mobile look
joystick rotates the camera correctly.

### Phase 2 — Sector geometry (2–3 sessions)

Goal: render a SectorMap with floors, ceilings, and walls.

- Implement `sectorGeometry.ts` — earcut-triangulate each sector
  polygon, emit floor + ceiling meshes. Walls become quads with
  proper UVs (vertical span = ceilingZ - floorZ, horizontal
  span = world distance between vert pair).
- Pull `earcut` as a tiny dep (~5KB gzipped) — it's the standard
  polygon triangulator.
- Texture routing — sector + wall textures resolved by id
  through the existing texture-override pipeline. v1's textures
  work unchanged.
- `converter.ts` — generate a SectorMap from the v1
  `SceneLayout` + `tileGrid`. Every connected tile region of
  same biome becomes one sector at floor=0,
  ceiling=WALL_HEIGHT_WORLD × biome.wallHeightTiles. Walls
  between walkable + non-walkable cells become solid walls;
  between two walkables at different heights become portals
  (rare in v1 since heights are uniform — converter mostly
  emits one big sector).
- Depth buffer enabled on the render pass so geometry sorts
  correctly without manual front-to-back logic.

Exit criteria: load any existing dungeon in v2, walk around,
geometry matches v1 visually except for the lighting upgrade in
Phase 4.

### Phase 3 — Sprite layer (1–2 sessions)

Goal: enemies, props, projectiles, view-model show up.

- `spriteLayer.ts` — one billboard quad per renderable entity.
  Vertex shader orients the quad to face the camera (extract
  right/up vectors from the inverse camera matrix). Position
  comes from world `(x, y)` + entity's sprite-height /
  ground-offset (same fields v1 reads).
- Animation pipeline reuses `getAnimationFrame(animId, key,
  now, state)` from the existing system. Texture binding is
  direct — same Pixi texture object the v1 renderer uses, no
  marshalling.
- FPS view-model renders in a final overlay pass with depth
  test disabled so it never clips through walls.

Exit criteria: in v2, enemies walk around with their
animations, projectiles fly, view-model fires.

### Phase 4 — Lighting (3–4 sessions)

Goal: per-sector ambient, static + dynamic point lights with
falloff, fog parity.

- Expand `sectorShader.ts` fragment shader: per-fragment loop
  over up-to-8 lights from a uniform array. Each light:
  `vec4 posRadius`, `vec4 colourIntensity`. Quadratic falloff
  on distance, mask by radius.
- Sector clustering: offline pass at SectorMap build time tags
  each static light with the sector set it can reach (own
  sector + neighbours through portals at compatible heights).
  Pre-pack the cluster into a per-sector uniform block.
- Dynamic light registry (`sectorLighting.ts`): add/remove with
  ttl, optionally attached to a prop or projectile. Re-cluster
  on movement (constant-time — point-in-sector test against
  current + 4-neighbour candidates).
- Hook dynamic lights into existing game events:
  - `projectile_spawned` → muzzle-flash light at shooter
    (60ms ttl).
  - Explosive prop destruction → 250ms decay light.
  - Power Link → slow pulse attached to the building.
- Fog blend in fragment shader: lit colour → mix with fog
  colour by existing `applyFog` curve. Walls and floor/ceiling
  use the **same** math (kills the v1 hue parity issue at the
  architecture level).
- Sky / skybox port from v1's per-biome skybox renderer.

Exit criteria: a hand-authored test SectorMap with three
torches + a dark ambient looks like a torch-lit room; firing a
weapon paints a brief muzzle flash on surrounding walls; the
Power Link pulses; floor and walls share fog colour parity.

### Phase 5 — Parity testing + perf (1–2 sessions)

Goal: v2 looks at least as good as v1 on every existing dungeon
and matches the **Pixel 6 @ 30fps in Discord embed** target.

- Side-by-side comparison harness: same seed in v1 and v2,
  screenshot compare visually.
- Performance pass on real hardware:
  - Light-cluster sizing tuning.
  - Sector batching — pack co-textured sectors into a single
    draw call.
  - Texture atlasing if needed.
  - Mobile-specific: half-resolution offscreen render +
    upscale if framerate isn't hitting target.
- Edge cases: very large rooms, very many props, perihelion
  smoke effects, dense horde waves.

Exit criteria: green light from internal playtest on target
hardware. 30fps held in worst-case scenes.

### Phase 6 — Cutover (1 session)

Goal: v2 becomes default; v1 stays as a fallback toggle.

- `RENDERER_CYCLE` default is `'fps-v2'`. `'fps'` is still
  reachable via the V keybind / `?renderer=fps` for debugging.
- `v2-graphics` branch merges to `main`.
- v1 raycaster `fps.ts` keeps living for at least one cycle as
  a debugging escape hatch. We don't delete it.
- Update GDD's "v2 engine refresh" section: shipped, no longer
  reserved.

## v2.1 — follow-up phases (post-cutover)

Scoped out of v2.0 to keep the initial ship tight. Order TBD
based on what playtest reveals matters most.

- **Sector editor.** `/editor/v2-rooms` page — 2D top-down
  sector painter. Click to drop vertices, close polygon, set
  heights + textures + ambient + lights. JSON under
  `packages/shared/content/v2-rooms/`. Per-room override into a
  dungeon floor (a specific tile slot renders the authored
  sector room; rest of the floor is converter output). Enables
  setpiece rooms — cathedrals, atriums, multi-height bosses.
- **Shadow maps.** Per-light shadow passes for the most
  visually load-bearing static lights (~3-5 per scene). Cheap
  optimization: cluster-aware — only render shadows for lights
  whose cluster contains the camera's sector.
- **Player flashlight.** Spotlight attached to the camera,
  narrow cone, toggle on/off. Off by default.
- **Decals.** Bullet holes, blood splatters projected onto wall
  surfaces. Texture-projection in shader.
- **Post-processing.** Bloom on bright fragments (muzzle flash,
  Power Link, perihelion sky). Cheap GLSL post-pass.

## Risks + mitigations

- **Shader bugs are silent.** A miscoded fragment shader paints
  a wrong colour with no stack trace — just visual breakage.
  Mitigation: shader-validation pass at startup (compile +
  log errors), reference test scene with known-good output
  used as a smoke test before every PR merge.
- **Mobile performance.** Sector geometry can blow draw calls
  on low-end phones. Mitigation: aggressive batching (co-
  textured sectors merged at build time), per-fragment light
  cap of 8, half-resolution offscreen + upscale as a fallback
  if the perf budget is missed.
- **Sector-converter edge cases.** Tile-grid dungeons that
  generate strange shapes (very thin corridors, isolated cells)
  might produce degenerate polygons. Mitigation: earcut handles
  concave + simple polygons; pre-merge obviously-co-linear edges
  before triangulating; visual diff test against v1 catches
  breakage.
- **Lighting tuning is bottomless.** Easy to spend weeks
  tweaking colour ramps. Mitigation: lock per-biome ambient +
  three standard archetypes (torch, fluorescent, glow) for v2.0;
  iterate post-launch.
- **WebGL state leaks.** Custom shaders + custom geometry mean
  manual GL state we have to remember to restore for Pixi's own
  2D batches to render correctly afterwards. Mitigation: scope
  every state change through a `withState()` helper that always
  restores on exit; verify by rendering a Pixi sprite atop the
  v2 scene as part of the test scene.

## What stays the same — guarantees

- Server `protocol.ts` doesn't change. Every wire message stays
  identical.
- `SceneLayout`, `tileGrid`, `walkables` keep being the source
  of truth for collision + AI + minimap. Sectors are derived,
  visual-only.
- Mobile controls, HUD, minimap, editor (other than the new v2-
  rooms page) — all unchanged.
- v1 raycaster `fps.ts` continues to receive bug fixes during
  the v2 development period (so playtest sessions on `main`
  aren't blocked).

## Decisions locked in

1. **Engine: Pixi v8 + custom shaders.** No new dependency.
   Sector geometry + lighting via custom `Mesh` + GLSL shaders.
2. **Sector editor moves to v2.1.** v2.0 ships converter-only —
   existing dungeons render in v2 with the new lighting model
   but no hand-authored multi-height setpiece rooms yet.
3. **Dynamic lights day-one.** Static + dynamic share the same
   shader path; dynamic lights wired into projectile spawn,
   explosion, Power Link, and a prop-attach API.
4. **Mobile target: Pixel 6 @ 30fps in Discord embed.** Light
   cap, batching, and half-res offscreen fallback budgeted
   against this.

## Timeline estimate

| Phase | Sessions |
|---|---|
| 1. Foundation | 2–3 |
| 2. Sector geometry + converter | 2–3 |
| 3. Sprite layer | 1–2 |
| 4. Lighting (static + dynamic + fog parity) | 3–4 |
| 5. Parity testing + mobile perf | 1–2 |
| 6. Cutover | 1 |
| **v2.0 total** | **10–15** |

v2.1 (sector editor, shadows, flashlight, decals, post-fx) is
separately scoped — each item is roughly 1-3 sessions.
