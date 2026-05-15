# v2 Graphics — Remaining Work

Tracking list. Lives alongside `docs/v2-graphics-plan.md`. Update as items
land; the plan is the architecture, this is the punch list.

## Combat / gameplay feedback

- **Damage red overlay** — full-screen red tint on player hit. HUD-layer
  overlay (Pixi 2D), driven by `setPlayerHp` damage detection or a
  separate "self damaged at" timestamp. v1 has this; v2 has nothing.
- **Enemy hit flash** — brief white tint on a sprite when its HP drops.
  Sprite shader already takes a per-vertex tint; just need a per-entity
  `lastHitAt` timestamp + tint lerp in `updateSprites`.
- **Melee swing visual** — `GameHandle.showWeaponSwung` is a noop in v2.
  v1 shows a swing arc / flash. Wire to the view-model's `attack` state
  if authored, or a quick screen-tilt + crosshair flash otherwise.
- **Build mode placement ghost** — when a build mode is active, draw a
  tile-aligned outline at the targeted cell. v1 renders this inside
  the FPS scene; v2 has no equivalent.
- **Crosshair fire flash** — pulse / colour shift on successful fire.
  Driven by `spawnProjectile` for self-owned projectiles (same hook
  used for the view-model's `fire` state).

## Texture coverage

- **`building_top` textures** — separate top-cap texture per building
  kind. Currently both cap and walls sample the same `building/<kind>`.
- **`prop_top` textures** — same for container props.
- **`prop_open/<kind>` textures** — opened-container variant. Today
  containers stay closed-looking regardless of `propState.opened`.
- **Per-cell biome variants** — `pickCellVariant` reads the biome's
  authored `tileSet` to hash-distribute multiple textures across cells
  (e.g. one in N cells uses a different stone). v2 uses one texture
  per biome.
- **Wall-door open/closed visual** — built doors should look different
  when `open === true`. v2 ignores the flag.

## Polish

- **Sprite drop-shadow** — small dark ellipse under each ground-anchored
  sprite. v1 has this; reads better against textured floors.
- **Loot pickup ring** — visual ring when the player is inside the
  loot pickup radius (28px today).
- **LOS-gated minimap entities** — enemies should hide on the minimap
  when not in line-of-sight. v2 minimap shows all of them today.

## Session persistence

- **Resume position/orientation on refresh** — server currently
  rehydrates every rejoin at the surface portal regardless of saved
  scene (`packages/server/src/world.ts` near "Always rehydrate at the
  surface portal"). Should preserve last scene + xy + facing so a
  refresh drops the player back where they were, including mid-
  dungeon. Watch for: dungeon scenes are per-cycle, so a stale scene
  id needs to fall back to the surface; PvP grief-by-refresh isn't a
  real concern here but worth being deliberate about.

## Phase 5 — parity + perf

- **Side-by-side comparison harness** — same seed in v1 and v2; visual
  diff to catch regressions.
- **Mobile target** — Pixel 6 @ 30fps in the Discord embed. Likely
  needs: sprite-batch tuning, draw-call reduction, possibly half-res
  offscreen render with upscale.

## Phase 6 — cutover

- Default `RENDERER_CYCLE` flips to `'fps-v2'`; v1 reachable via the
  V keybind / `?renderer=fps` for debugging.
- Merge `v2-graphics` to `main`.
- v1 raycaster `fps.ts` stays as a fallback for at least one cycle.
- Update `GDD.md` "v2 engine refresh" — shipped, no longer reserved.

## Deferred to v2.1 (per the plan)

- **Sector editor** (`/editor/v2-rooms`) — hand-authored multi-height
  rooms with vertex painter, per-room overrides into dungeon floors.
- **Shadow maps** — per-light shadow passes for the ~3-5 most
  load-bearing static lights per scene.
- **Player flashlight** — camera-attached spotlight, narrow cone,
  toggle on/off.
- **Decals** — bullet holes, blood splatter projected onto wall
  surfaces.
- **Bloom post-fx** — bright fragments (muzzle flash, perihelion sky)
  glow.
