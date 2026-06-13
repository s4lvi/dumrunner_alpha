# Base Layouts — implementation plan

Design intent: GDD §Base Building › Base Layouts. This doc is the
engineering plan. Status: **planned, not started.** File:line
anchors are from the 2026-06-13 code survey.

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

## Key decision: a leveled clearing, not a platform floating over noise

The base layout is the first scene that is **both** authored
geometry **and** terrain noise — every existing scene is one or the
other (dungeons/arenas: authored, no terrain; surface today: terrain,
no authored map). Naively flooring the platform at z=0 over ±64wu
noise breaks three systems that assume a flat surrounding floor:

- **`floorAt` resolution** ("highest containing platform vs terrain
  baseline") lets a terrain peak poke *above* the platform floor —
  the hill erupts through the base; in a trough the platform floats
  64wu over the ground.
- **Riser/hole geometry** (the pit/platform machinery hardened over
  the last sessions) assumes the surrounding floor is 0. Perimeter
  risers computed against varying terrain render wrong at the seam.
- **Ledge-fall** (shipped 2026-06-13): the platform edge is now a
  real cliff — walk off into a trough = a 64wu fall; over a peak the
  ground is *above* the floor you're standing on.

**Resolution: the base sits in a leveled clearing.** Within the
layout footprint the surface floor is flat authored geometry at a
fixed pad height; the terrain noise is **suppressed to that height
inside the footprint** and only rises into hills *outside* it. The
hills are backdrop you can walk to the edge of and fall off (into the
desolate overworld), not ground the platform floats over. Concretely:

- The surface's effective floor = `max(platformFloor, terrainHeight)`
  becomes, inside the footprint, just `platformFloor` — terrain is
  clamped under the pad so it can never poke through. Implement as a
  footprint mask consulted by the surface `floorAt`/terrain sampler
  (terrain returns `min(terrainHeight, padZ)` — or simply `padZ` —
  for any xy inside the layout's walkable footprint).
- The pad sits slightly **above** the terrain's local mean so the
  clearing reads as a raised platform with a consistent drop-off at
  every edge, rather than a floor that's sometimes below grade.
- Outside the footprint, terrain is untouched (the existing hilly
  desolate overworld), non-buildable, and below the pad — so every
  platform edge is a uniform fall, which the ledge-fall code already
  handles cleanly.

This collapses the hybrid back toward the proven "authored, flat"
case for everything inside the base, and confines the terrain
interaction to a single well-defined seam (the pad edge), which is
exactly the ledge-fall case that's already tested.

## P0 spike (do this before P1)

The seam above is the highest-risk unknown; prototype it on a
throwaway branch before committing to the feature:

1. Give the live surface an `authoredSectorMap`: one flat square pad
   (~20×20 tiles) at a fixed `padZ` over the existing terrain, via a
   hand-built `SectorScene` (no new types yet).
2. Apply the footprint terrain clamp in the surface `floorAt`/terrain
   sampler so noise can't pierce the pad.
3. Walk it in-game: stand/build on the pad (flat, stable), walk to
   every edge (uniform fall onto the hills via ledge-fall), confirm
   the renderer draws the pad edge + drop-off without z-fighting or
   missing risers, confirm spawn lands on the pad.
4. Extend `diag-jump.ts` with a pad-edge walk-off case (real fall,
   lands on terrain, never below floor) and a "terrain never exceeds
   padZ inside footprint" assertion.

Exit criteria: flat stable pad, clean uniform edges, spawn on pad,
diag green. If the seam fights the renderer/collision harder than
expected, that's caught here for the cost of a spike instead of
mid-feature. Promote the spike's working pad into the starter layout
content in P1.

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
Walls remain uncapped (they're the defensive maze material). Turret
count is bounded by mount count, not capacity.

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
  Power Link itself is part of the layout and is re-anchored, never
  refunded.

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
  boundary.** On hydrating a pre-v5 (`schema < 5`) snapshot, drop
  all *surface* buildings, assign the starter layout, and let the
  Power Link come from its anchor. Dungeon scenes, characters,
  inventories, and blueprints are untouched — only the surface base
  resets. This is acceptable because the game is pre-public with
  effectively no live bases, and it dodges all three problems for
  zero migration code. Surface contents are not precious (no extract
  loot lives there; corpses are wiped at perihelion anyway).
- Log the reset (`[world] surface base reset for base-layouts
  migration`) so it's observable if it ever fires on a world that
  mattered.
- The alternative (snap old coords onto the pad, relocate the Power
  Link, grandfather over-cap) is real migration code for users who
  don't exist yet — explicitly **not** doing it. Revisit only if a
  world worth preserving exists before this ships.

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
  scene (wall mazes, more mounts) for variety/higher tiers — reuses
  the same rasterization output, so it's purely a generator that
  writes the same shape. Out of scope for the first build.

## Phased plan

**P0 — Terrain-seam spike (throwaway, gate on it).** See the P0
section above. Flat pad + footprint terrain clamp + leveled-clearing
edges on the live surface, walked in-game, diag-jump pad-edge case
green. Exit criteria there. **Do not start P1 until the seam is
proven** — if it fights collision/renderer, the whole feature's risk
lives here and it's cheapest to learn now. The working pad becomes
P1's starter content.

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

1. **Turret mounts replacing free turret placement** — confirm
   (changes player muscle memory; everything else is additive).
2. **Swap re-seating policy** — proposed refund-to-storage/
   inventory/ground; alternative is block-swap-until-cleared. Refund
   is friendlier.
3. **Multiple bases / one per server** — assume one active layout
   per server world (matches the single surface scene). Multi-base
   is out of scope.
4. **Capacity granularity** — single `workstations` pool vs per-kind
   caps (e.g. max 1 uplink). Start with a pool + a hardcoded "max 1
   uplink/power_link"; refine if needed.
