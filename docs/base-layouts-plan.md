# Base Layouts — implementation plan

Design intent: GDD §Base Building › Base Layouts. This doc is the
engineering plan. File:line anchors are from the 2026-06-13 code
survey.

**Status: P0–P4 shipped 2026-06-13** (terrain-clearing mechanism,
data-driven `BaseLayoutDef` + persistence/migration, pad-constrained
build + capacity caps, turret mounts, swap flow + economy). The one
deferred piece is the `/editor/base-layouts` authoring form (P4 item
5) — layouts are authored as JSON for now. Remaining: the in-game
playtest pass (renderer apron/pad, live horde on the base, swap
mid-session with 2+ players). All phases verified server-side via
diag-base / diag-base-swap / diag-dungeon-persistence.

## Goal

Turn the surface base from an implicit terrain plane with a
hardcoded Power Link and unconstrained free-build into an explicit,
swappable, authored **base layout**: a flat platform standing in the
hilly desolate overworld, carrying fixed **turret mounts** and a
declared number of **workbench / storage slots**. New layouts are
products under [the Economy Law](../GDD.md#the-economy-law) — schematic
bought at the Power Link, assembled from dungeon components — and the
starter layout is a plain square with a mount at each corner.

## Current state (what we're refactoring)

- The surface scene is built in `World` from `surfaceLayout()`
  (`packages/server/src/world.ts:147-192`): a 4000×4000 plane with
  hilly terrain noise (`amplitude 64, freq 1/384, octaves 2`,
  deterministic seed), **no `authoredSectorMap`** — pure terrain.
  Spawn at `(80,0)`; Power Link at tile `(6,-1)` via
  `ensurePowerLink` (`world.ts:488-493`).
- Buildings are free-placed by `handleBuildRequest`
  (`scene.ts:894-984`): grid-snap, range (`BUILD_RADIUS_TILES 3` +
  suit bonus), tile-overlap and player-overlap checks, consume one
  placeable item. Stored in `this.buildings: Map<id, BuildingRuntime>`
  (`scene.ts:474`); wired as `BuildingState`
  (`protocol.ts:252-277`). **No per-kind cap exists** — you can place
  unlimited workbenches/turrets/chests.
- Turrets are ordinary free-placed buildings (`turret`,
  `turret_smg/shotgun/rifle`), targeted/fired in the turret tick
  (`scene.ts:1329-1401`), power-gated by the capacity system
  (`world.ts:3284-3323`). **No mount concept.**
- Power Link (`kind 'power_link'`) is the dungeon portal via the
  `stairs_down` interactable (`world.ts:1607-1641`); the artifact
  uplink is a separate building whose modal handles blueprint
  purchase (`world.ts:2310-2353`, modal in `Game.tsx`).
- Buildings persist in the `world_states` snapshot
  (`scene.snapshot()`/`hydrate()`, `WORLD_STATE_SCHEMA = 4`,
  `world.ts:201`).
- Authored scenes already rasterize to playable layouts:
  `SectorScene` JSON → `rasterizeSectorSceneToLayout()`
  (`sceneRasterize.ts:27-117`) → `SceneLayout` with flat/raised
  sectors, biome, terrain, `authoredSectorMap` for polygon
  collision + renderer. Deathmatch arenas and floor overrides
  already use this path (`floorOverrides.ts`, `world.ts:891-910`).

## Key decision: reuse the SectorScene pipeline

A base layout **is** an authored `SectorScene` plus base metadata.
Do not invent a parallel geometry format. The scene already gives
us flat platform sectors over terrain, the renderer, polygon
collision, biome, and the scenes-csg editor. `BaseLayoutDef` wraps
a scene reference with the base-specific fields:

```ts
type BaseLayoutDef = {
  id: string;                 // 'base_square_mk1'
  label: string;
  sceneId: string;            // authored SectorScene (rasterized at boot)
  // Fixed turret sockets, world-coord, derived from 'turret_mount'
  // anchors in the scene (authored visually, not hand-typed).
  turretMounts: { x: number; y: number }[];
  // Numeric capacity for free-placed station/storage buildings on
  // the platform. Turrets are NOT counted here — they're mount-gated.
  capacity: {
    workstations: number;     // workbench/forge/electronics/weapon/suit/mill/uplink total
    storage: number;          // storage_chest count
  };
  // Economy: schematic gating the build + component cost to assemble.
  blueprintId: string | null;
  cost: RecipeInput[];        // dropped components + binder (reuses recipe IO)
};
```

The platform footprint = the layout scene's walkable sectors. The
surrounding terrain hills stay non-buildable (build validation
already requires a walkable tile once the surface carries an
`authoredSectorMap` — see P2). The Power Link is part of every
base layout scene (authored at a fixed anchor) so it survives swaps.

## Key decision: an at-grade leveled clearing (raised pad deferred)

The base layout is the first scene that is **both** authored
geometry **and** terrain noise — every existing scene is one or the
other (dungeons/arenas: authored, no terrain; surface today: terrain,
no authored map). Naively flooring the platform at z=0 over ±64wu
noise breaks three things that assume a flat surrounding floor:
`floorAt` resolution (a terrain peak pokes *through* the pad; a
trough leaves it floating), riser/hole geometry (perimeter risers
computed against varying terrain), and ledge-fall (the edge becomes a
±64wu cliff).

A raised pad with clean drop-off edges *looks* right, but it is
**incompatible with the horde**, which is the entire reason the
surface base exists. Enemy collision (`circlePassable` →
`pointPassable`, `scene.ts:4144`) and enemy pathfinding
(`nextAiWaypoint` BFS, `fsm.ts`) are **purely 2D — no floorZ or
step-up awareness** (the open Sprint G "enemy pathing on raised
sectors" item). The horde spawns on terrain outside the base and
paths to the Power Link. Against a raised pad that means either the
perimeter walls block enemies and the horde *can't reach the base at
all*, or the walls are passable and enemies clip vertically up the
cliff face. Both are broken; the first kills the defend-the-Link
event outright.

**Resolution: v1 is an AT-GRADE leveled clearing — flat, flush,
walkable straight in. Defense is walls + turrets, not elevation
(which is the 7D2D fantasy anyway — you wall the horde out, you
don't hover above it).** The raised-platform aesthetic is deferred
until enemy AI gains floorZ/step-up pathing (Sprint G); see
"Raised pads, later" below.

At-grade mechanics (**implemented in P0**, `shared/src/terrain.ts`):

- **The clearing is carved into the terrain height field itself, not
  an authored sector map.** `terrainHeightAt(cfg, x, y)` is the single
  chokepoint both server collision and client rendering sample, so a
  `TerrainConfig.clearing { cx, cy, radius, apron, padZ }` field makes
  the pad appear everywhere at once from one implementation. There is
  **no authored sector map on the surface, no solid riser walls** —
  which is exactly what dodges the review's killer: nothing solid to
  block the 2D floorZ-agnostic horde, nothing for it to clip up. The
  base is one continuous surface that's simply flat in the middle.
- **Footprint clamp:** inside `radius`, `terrainHeightAt` returns
  `padZ` (≈ terrain mean, 0 → at grade). `insideClearingPad()` is the
  buildable-footprint test (P2 uses it).
- **Apron ramp:** across the `apron` ring the height smoothsteps from
  `padZ` to the natural noise — a fully walkable slope whose per-step
  delta is bounded under `STEP_UP_MAX` (measured 2.18wu/step at
  radius 352 / apron 192, vs the 12 limit). No riser to climb, no
  cliff to draw.
- **Beyond the apron**, terrain is the untouched hilly overworld
  backdrop; non-buildable (build requires a pad-footprint tile, P2).
- **No ledge-fall on the base** — the apron is a gentle slope, not a
  drop-off; verified by a real player walk onto the pad (0 airborne
  ticks). Ledge-fall stays a dungeon concern.

This keeps the genre-true picture (a leveled compound in the hills),
stays inside what the 2D AI navigates, and — by living in the height
field rather than an authored-pad-over-terrain hybrid — avoids the
riser/hole machinery and the authored+terrain seam **entirely**. The
hybrid scene type the earlier draft worried about never gets created;
that whole risk class is designed out, not mitigated.

### Raised pads, later

A true raised platform with drop-off edges and ramp lanes the horde
must funnel up is a real upgrade — but it is **hard-blocked on
Sprint G enemy floorZ/step-up pathing**. Until that lands, raised
geometry on the surface is unreachable or visually broken for
enemies. Treat raised pads (and maze/kill-lane layout geometry, see
Authoring) as a post-Sprint-G enhancement that reuses everything
here; do not build them into v1.

## P0 spike (do this before P1)

Two seams are the highest-risk unknowns — the player seam (does the
pad+apron read as flat stable ground?) and, more importantly, the
**enemy seam (can the horde cross the apron and attack the base?)**.
The enemy seam is the one that, if wrong, kills the feature, and it's
the one the obvious player-side checks miss. Prototype both on a
throwaway branch before committing:

1. Give the live surface an `authoredSectorMap`: one flat square pad
   (~20×20 tiles) at `padZ` ≈ local mean, via a hand-built
   `SectorScene` (no new types yet).
2. Apply the footprint clamp **and the apron ramp** in the surface
   `floorAt`/terrain sampler so noise can't pierce the pad and the
   approach slopes gently to grade.
3. Player seam, in-game: stand/build on the pad (flat, stable), walk
   the apron in/out (no stutter-fall, no clip), confirm spawn lands
   on the pad, confirm the renderer draws the apron slope without
   z-fighting or missing risers.
4. **Enemy seam, in-game: fire a horde wave** (or hand-spawn enemies
   at the 700px ring) and confirm they path across the apron onto the
   pad and attack the Power Link — no enemies stuck at the edge, no
   vertical clip-up.
5. Diagnostics (`diag-jump.ts` + extend `diag-procgen.ts` or a new
   `diag-base.ts`):
   - terrain never exceeds `padZ` inside the footprint;
   - apron per-tile floor delta ≤ `STEP_UP_MAX` everywhere (no riser
     the AI must climb);
   - **tile-grid BFS from the horde spawn ring reaches the Power Link
     tile** (the horde-can-attack invariant, the same connectivity
     check pattern diag-procgen uses for dungeon exits);
   - a sampled enemy walk from the ring across the apron stays
     walkable every tick.

Exit criteria: flat stable pad + walkable apron (player), **horde
reaches and attacks the Power Link** (enemy), spawn on pad, all diag
invariants green. The enemy-reaches-base criterion is the gate — a
green player seam alone is **not** sufficient to proceed. Promote the
working pad+apron into the starter layout content in P1.

## Turret mounts (the one real gameplay change — confirm)

Turrets stop being free-placed. A `turret_mount` is a positional
socket on the layout:

- The layout declares mount positions (`turretMounts`, authored as
  `turret_mount` anchors in the scene).
- `handleBuildRequest` for a turret-kind placeable requires the
  target tile to be a **free mount** (no existing turret bound).
  The turret snaps to the mount centre rather than the cursor tile.
- New runtime linkage: `BuildingRuntime.mountIndex?: number` on the
  turret (which mount it occupies); a per-scene `Set<number>` of
  occupied mounts **rebuilt deterministically on hydrate** by
  scanning turret `mountIndex` fields (not stored separately, so it
  can't drift). On a collision (two turrets claiming one mount from
  a corrupt save) keep the lowest-id turret and refund the other.
  No child/parent cascade — mounts are layout geometry, not
  buildings; a destroyed turret frees its mount.
- **Power-id churn caveat:** turrets are powered in id order
  (lowest-id first, `world.ts:3284-3323`). Refunding + rebuilding
  turrets on a layout swap mints new ids, so *which* turrets are
  powered can shift after a swap. Acceptable, but the swap should
  re-seat surviving turrets onto mounts **preserving id order** so
  the power assignment stays stable where it can.
- Client: render empty mounts as a visible socket pad; build mode
  for a turret highlights free mounts instead of the floor ring.

This is the item to confirm before P3 — it changes how players
place turrets. Walls, stations, and chests stay free-placed on the
platform (capacity-capped for stations/storage; walls uncapped).

## Capacity slots

`capacity.{workstations, storage}` cap free-placed buildings by
category. `handleBuildRequest` counts existing buildings of the
category and rejects past the cap (new error `base_slot_full`).
Client greys the placeable and shows `used/max` in the build HUD.
Walls remain uncapped (they're the defensive barrier material). Turret
count is bounded by mount count, not capacity.

## Horde integration

The horde is why the base exists, so the spawn geometry has to track
the layout, not a constant:

- **Spawn ring derives from the footprint.** Today waves spawn at a
  hardcoded 700px ring (`scene.ts:1456`). A larger layout (the
  bastion) can extend past 700px, spawning enemies *on* the base.
  Replace the constant with `footprintRadius + HORDE_RING_MARGIN`
  (footprintRadius = the layout's bounding radius incl. apron;
  margin a fixed ~200px), so the ring is always just outside the
  walkable approach regardless of layout size. Spawn points still
  snap to clear walkable ground via `findSafeSpawnNear`.
- **Reachability is a layout invariant.** Every authored/generated
  layout must satisfy the P0 BFS check (horde ring → Power Link tile
  walkable). The base-layout loader rejects a layout that fails it,
  the same way procgen asserts entrance→stairs connectivity — a base
  the horde can't besiege is a content bug, caught at load.
- **At grade, building-priority targeting just works:** enemies path
  to the Power Link / turrets / walls on the flat approach exactly as
  they do today. No AI change needed for v1 (which is the whole
  reason v1 is at-grade).

## Swap flow at the Power Link

The Power Link interaction becomes tabbed:
`[ Descend | Base | Uplink ]` (Descend = existing dungeon portal,
Uplink = existing blueprint/keys shop, Base = new).

Base tab:
- Lists known base-layout schematics (bought at the Uplink like any
  blueprint — layouts are products). The active layout is marked.
- Building a new layout consumes `cost` (dropped components +
  materials), validated like a craft.
- **Swap re-seating:** on swap, walls/stations/chests whose tiles
  still land on the new platform footprint and fit its caps stay;
  everything else (over-cap stations, all mounted turrets, off-
  platform buildings) is **refunded as items** → storage chest if
  one survives, else player inventory, else dropped as loot at the
  Power Link. Refund-not-destroy keeps a swap from eating gear.
- **Power Link is transferred, not recreated.** It keeps its
  building id, hp, and powered status; only its tile position is
  re-anchored to the new layout's Power Link anchor. The World-level
  `deepestFloorReached` / power-capacity chain is World state, not
  building state, so it's untouched by the swap — but the Power Link
  building itself must NOT be destroyed-and-rebuilt (that would drop
  hp to full mid-cycle and could desync the dungeon-portal
  interactable). Move it; don't respawn it.

**Swap is the trickiest transaction in the game — treat it like
`assemble_weapon`.** It mutates building state + storage contents +
player inventory at once, and the refund targets interact (a chest
being refunded can't also be a refund destination). Implement as
clone → validate → commit:
1. Compute the keep/refund partition against the new footprint +
   caps without mutating anything.
2. Resolve refund destinations in a fixed order — chests that
   *survive* the swap first, then inventory, then ground at the
   Power Link — computing capacity as you go so nothing is refunded
   into a container that's itself being removed or already full.
3. Only if the whole partition + refund plan is consistent, commit:
   swap geometry, apply building changes, write inventories/chests,
   broadcast. A failure at any step aborts with the live base
   unchanged (return a `base_swap_failed` error).
Ground-drop is the guaranteed sink so the transaction can always
complete; dropped items land on the new pad near the Power Link
(inside the footprint, never on the terrain you can't reach).

Server: new `set_base_layout { layoutId }` client message
(PROTOCOL_VERSION bump). Handler validates schematic known +
on-surface + cost, runs the clone-validate-commit swap above, and
rebroadcasts `scene_changed` for the surface.

**Mid-session reload caveat:** `scene_changed` normally fires on a
transition into a fresh scene; a layout swap fires it for the
surface **while every surface player is standing on it**. The
client `swapScene` path resets vertical state, fog, and camera —
exercise this with 2+ players on the surface: each must reload the
new geometry, re-resolve their footing onto the new pad (not fall
through), and keep seeing each other. The active `baseLayoutId` is
server-authoritative and shipped in `welcome`, so a player who
joins after a swap and one who was present converge on the same
layout.

## Persistence + protocol

- `WorldSnapshot` gains `baseLayoutId?: string` (additive →
  `WORLD_STATE_SCHEMA 5`; v4 snapshots load with the starter
  layout). Buildings already persist; re-seating runs only on
  explicit swap, not on hydrate.
- On hydrate, the surface scene is rebuilt from the saved
  `baseLayoutId`'s scene (starter if absent), then buildings
  overlay as today.
- `BuildingState` gains `mountIndex?` for turrets; `SceneLayout`
  carries the layout's `turretMounts` + `capacity` so the client can
  render sockets and gate the build HUD.
- PROTOCOL_VERSION bump covers the new client message + wire fields.

### Migration of existing worlds (decide up front)

Flipping the surface from a free-build terrain plane to a
constrained pad is **not backward-compatible with saved bases**:
buildings persisted at old terrain-plane tile coords won't land on
the new (smaller) footprint, the hardcoded Power Link at tile
`(6,-1)` won't match the layout's Power Link anchor, and a world
with more stations than the starter cap loads over-capacity. Three
problems, one decision:

- **Chosen policy (alpha): reset surface bases on the schema-5
  boundary.** `parseWorldSnapshot` keeps accepting schema 3/4/5; on
  hydrating any snapshot that lacks `baseLayoutId` (i.e. pre-v5),
  the World assigns the starter layout and drops all *surface-scene*
  buildings, then proceeds normally. Dungeon scenes, the cycle
  clock, craft jobs, characters, inventories, and blueprints all
  load untouched — the reset is scoped to the surface scene's
  building set only.
- **Caveat — storage chests are not free to wipe.** Surface storage
  chests persist player loot across cycles; resetting the surface
  destroys their contents. That's the one genuinely precious thing
  on the surface (corpses are perihelion-wiped, the rest is
  re-buildable). Acceptable on a pre-public alpha with effectively
  no live worlds. **If** the reset ever needs to run somewhere that
  matters, the fallback is: before dropping buildings, sweep every
  `storage_chest` + station output buffer into a holding stash keyed
  by `characterId` and re-grant on that character's next join
  (mail-style). Build that only if a world worth preserving exists
  before this ships — not for v1.
- Log the reset with a content count (`[world] surface base reset
  for base-layouts migration — dropped N buildings, M chest items`)
  so it's observable.
- The alternative full migration (snap old coords onto the pad,
  relocate the Power Link, grandfather over-cap) is real code for
  users who don't exist yet — explicitly **not** doing it.

## Authoring

- **Editor reuse:** base layouts are authored in scenes-csg like any
  `SectorScene`. Add a `turret_mount` anchor kind (the only new
  authoring primitive) so designers drop mounts visually; capacity +
  cost + blueprintId live in a small `BaseLayoutDef` JSON beside the
  scene (new `/editor/base-layouts` form, mirroring the blueprint
  editor — sidebar list + form, no new geometry editor needed).
- **Starter layout** ships as authored content: a square flat
  platform, Power Link anchor at centre-rear, four `turret_mount`
  anchors at the corners, `capacity { workstations: 4, storage: 2 }`,
  `blueprintId: null` (always owned), `cost: []`.
- **Procgen (later):** a generator emitting `BaseLayoutDef` +
  scene for variety/higher tiers — reuses the same rasterization
  output, so it's purely a generator that writes the same shape.
  Out of scope for the first build.

### What layout progression can actually offer in v1 (be honest)

The pitch was "layouts grow more complex with wall mazes and kill
lanes." That kind of **geometry** progression is circular with the
AI problem: a wall maze only matters if the horde must thread it,
and the 2D floorZ-agnostic pather doesn't navigate cleverly enough
for a maze to read as designed (it greedily BFSes the shortest
walkable route; intricate internal geometry just becomes a longer
path, not a kill lane). So v1 layout value is **quantity, not
geometry**:

- more turret mounts (more guns),
- higher workstation/storage capacity,
- a larger buildable footprint (more room for player-built walls —
  and player walls at grade *are* real horde barriers today, which
  is where the defensive depth actually comes from),
- optionally a few pre-placed wall segments as a starting perimeter.

Genuine **geometry** progression (mazes, funnels, kill lanes, raised
tiers) is deferred to post-Sprint-G alongside raised pads, when the
AI can be made to honor it. Don't sell layouts on maze geometry in
v1 UI copy — sell them on capacity + mounts + size.

## Phased plan

**P0 — Pad+apron spike. ✅ DONE (server-side) 2026-06-13.** Carved the
clearing into `terrainHeightAt` (`TerrainConfig.clearing` +
`insideClearingPad`) — see the at-grade mechanics above; this turned
out cleaner than an authored pad (no sector map, no riser/hole
machinery, no enemy-blocking solid walls). Surface gets an at-grade
clearing on the Power Link. `diag-base.ts` proves it on the real
surface Scene: flat pad (dev 0), apron 2.18wu/step (≪ 12), natural
terrain beyond, player walks onto the pad with 0 blocked / 0 airborne.
Because the clearing is a smooth heightfield with no solid risers,
the 2D horde walks onto it for free — the enemy seam is satisfied by
construction, not by a BFS gate. **Remaining P0 = the in-game
playtest check** (renderer draws the apron/pad without z-fighting; a
live horde wave reads right). Do that before P1 hardens anything on
top.

**P1 — Layout data + starter, surface built from it (no behavior change yet).**
- `BaseLayoutDef` type + Zod (`shared/src/content/types.ts`), loader
  + registry (`server/src`), `initBaseLayouts()` at boot.
- Author the starter square scene (the proven P0 pad) +
  `base_square_mk1.json`.
- `World` builds the surface from the active layout's rasterized
  scene instead of the bare `surfaceLayout()` terrain plane, with the
  footprint terrain clamp from P0; Power Link comes from the layout
  anchor (drop `ensurePowerLink`'s hardcoded tile). `baseLayoutId`
  persisted (schema 5), defaults to starter.
- **Migration:** pre-v5 snapshot → reset surface buildings + starter
  layout (see Migration above), logged.
- Verify: surface loads as a flat clearing, Power Link present,
  descend still works, building places on the pad, spawn on the pad,
  pre-v5 snapshot resets cleanly, snapshot round-trips (extend
  diag-dungeon-persistence with a surface-layout + migration case).
  Typechecks green.

**P2 — Build constrained to the platform + capacity slots.**
- `handleBuildRequest` rejects off-platform (non-walkable) tiles
  (falls out of the authored surface automatically) and enforces
  `capacity` per category (`base_slot_full`). Client build HUD shows
  `used/max` and greys full categories. Walls uncapped.
- Verify: can't build on terrain hills; station/storage caps hold;
  walls unaffected.

**P3 — Turret mounts.** (gated on the confirm above)
- `turretMounts` on the layout; turret placeables snap to free
  mounts; `mountIndex` on turret runtime + wire; occupied-mount set;
  client renders sockets + mount-targeted build mode; destroyed
  turret frees its mount.
- Verify: turrets only on mounts, count bounded by mounts, free on
  destroy.

**P4 — Swap flow + economy.**
- `/editor/base-layouts` form; a second authored layout (e.g. a
  walled `base_bastion_mk1`) + its schematic in the Uplink catalog.
- Power Link `[Descend|Base|Uplink]` tabs; `set_base_layout` handler
  with cost validation + re-seating refund; `scene_changed` reload.
- Verify: buy schematic → build layout → buildings re-seat/refund
  correctly → persists across restart.

**P5 (later) — procgen base generator** for variety/tiers.

## Open decisions

1. **At-grade v1, raised pads deferred** — RESOLVED (above): v1 is a
   flat at-grade clearing with a walkable apron because the 2D
   floorZ-agnostic enemy AI can't besiege a raised pad. Raised pads +
   maze/kill-lane geometry are post-Sprint-G. This is the load-
   bearing decision; flag if the raised aesthetic is considered
   non-negotiable for v1 (then Sprint G becomes a hard prerequisite
   and the timeline grows).
2. **Turret mounts replacing free turret placement** — confirm
   (changes player muscle memory; everything else is additive).
3. **Swap re-seating policy** — proposed refund-to-storage/
   inventory/ground; alternative is block-swap-until-cleared. Refund
   is friendlier.
4. **Migration: reset surface bases on schema-5** — proposed
   (above), with the storage-chest caveat. Confirm acceptable, or
   commit to the mail-stash fallback.
5. **Multiple bases / one per server** — assume one active layout
   per server world (matches the single surface scene). Multi-base
   is out of scope.
6. **Capacity granularity** — single `workstations` pool vs per-kind
   caps (e.g. max 1 uplink). Start with a pool + a hardcoded "max 1
   uplink/power_link"; refine if needed.

## Dependency note

This feature's *full* vision (raised fortress, maze defenses) is
gated on **Sprint G enemy floorZ/step-up pathing**. v1 ships the
at-grade subset that needs no AI work; the geometry-progression half
should be scheduled *after* Sprint G, not before, or it ships
cosmetic.
