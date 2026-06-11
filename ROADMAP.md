# DÛM RUNNER — Roadmap

Master execution list. `GDD.md` is design intent; this doc is
execution state — what shipped, what's open, in what order. It
consolidates the former planning docs (`v2-finish-plan`,
`blueprint-editor-plan`, `editor-bridge-plan`, `editor-ux-plan`,
`animation-system-plan`); those files are deleted.

Last updated: 2026-06-09. **Every open/partial item below was
verified against the code on this date** — file references are
from that audit. When this doc and the code disagree, fix the doc.

## Sequencing

```
NOW  →  Economy redesign (components-first) — the GDD's Economy Law
        made real; includes blueprint permanence
        Known-bug burn-down                 — small, unblocked
THEN →  Design tuning                       — horde scaling, TTK,
                                              hazard curve, mid-cycle beat
        Sprint G (gameplay systems)         — pather on raised sectors,
                                              env ammo, anim Phase D
        Sprint C (content depth)            — champions, banding UI, suits
LATER → Sprint I (infrastructure)           — server lifecycle, browser UX,
                                              DM follow-ons, wrappers
        Sprint P (polish)                   — UX gaps, v2.1 renderer/collision
```

Sprints interleave freely once their architectural pieces exist —
pick the highest-leverage unblocked item.

---

## Current state (shipped)

High level; the code is the record. PROTOCOL_VERSION 44.

- **v2 engine** — Pixi v8 polygon-sector renderer (custom shaders,
  per-fragment fog + lighting, billboards), polygon collision with
  Z-aware step-up / jump / crouch / head-bonk / pits, per-sector
  noise floors/ceilings, linedef-native authoring + procgen
  (BSP + Tunneler, inset/corridorize, decorate, finalize with
  anchors + room-template stamping, locked-room doors). v1
  renderers fully deleted.
- **Core loop** — server-authoritative 20Hz sim; dungeon descent
  deterministic from `(worldSeed, cycle, floorIndex)`; per-floor
  extract; Power Link portal with frontier fast-travel +
  depth-scaled power capacity; perihelion horde with
  building-priority AI; async crafting with queues + output
  buffers; weapon/suit assembly benches with atomic transactions;
  blueprint shop; storage chests; chat; deathmatch mode with
  rounds + HUD.
- **Content pipeline** — all registries JSON-authored under
  `packages/shared/content/` (enemies, biomes, props, rooms,
  weapons, recipes, attachments, blueprints, buildings,
  animations, scenes, world), Zod-validated, hot-reloaded via
  `contentWatch.ts`. Editor suite at `/editor` covers every area
  (activity rail, Cmd-K palette, inline validation, If-Match
  conflict guard, refs walker, health page, CSG scene editor with
  undo/redo + live playtest reload).
- **Hazards** — biome × depth environmental DPS vs life-support
  resist (`shared/src/hazards.ts`, `Scene.tickHazards`).
- **Props** — full runtime (wire state, damage/destroy, explosive
  chains, lootable containers via `handleOpenContainer`,
  biome-palette spawning, fps.v2 billboards, editor category).
- **Status effects** — `activeEffects` pipe folded through
  `recomputePlayerStats`, tick expiry + rebroadcast; consumables
  stim / overcharge_kit / medkit_lg / medkit_xl. AoE-cone enemies
  (flame_drone burn, chem_bloater poison/slow) live.
- **Spawn safety** — `findSafeSpawnNear` (building-free +
  5-tile enemy clearance) + 2s respawn immunity.
- **Inventory verbs** — drop-to-loot, `give_item` with proximity
  validation, sort, salvage.
- **Animation system** — Phases A–C: `AnimationController` in
  shared, enemy/prop/projectile billboards + FPS view-model
  consume per-state frame animations; animations editor.
- **Mobile controls** — dual virtual joysticks, tap-to-fire,
  action buttons, orientation lock (`MobileControls.tsx`).
  Capacitor wrapper not started.
- **Discord** — OAuth login + Activity flow with instance-bound
  rooms (see `docs/discord-integration.md` for portal setup).
- **Infra** — Vercel client + Fly game servers, JoinToken auth,
  heartbeats, pause/resume, playtest servers, CI typechecks +
  auto-deploy.

---

## Known bugs

Open (verified against code 2026-06-10):

- **Cycle clock vs downtime.** On rejoin after an empty period the
  snapshot-restored `cycleStartedAt` isn't adjusted for the gap —
  verify whether offline time burns cycle time (and decide which
  behavior is wanted) before changing the stasis logic.
- ~~Loot drop TTL~~ — bumped 90s → 180s (2026-06-10); revisit
  floor-depth scaling if it still pinches.

Minor watchlist (low): input zeroed on server stalls
(`PLAYER_INPUT_TTL_MS` vs variable dt); turret targeting is
O(turrets × enemies) and AI LoS O(enemies × players) per tick —
the horde perf ceiling; `lastLandedAt` grace written but never
read; `findBlockingWall` uses standing height while crouched;
post-eviction corpses at cycle end escape the wipe; loot pickup
tie-break is map-iteration order.

Note on the "empty-server clock stasis" item previously listed
here: the world's timers stop entirely when the last player
leaves, so the slide path barely runs — the review's read was
off. Real behavior to verify instead: whether downtime counts
against the cycle on rejoin (cycleStartedAt is restored from
snapshot without adjusting for the gap).

Fixed 2026-06-10 (gameplay-systems review + playtest report):
corpse looting destroyed `upgrade` items; blueprint per-cycle wipe
+ missing persistence (economy step 1); reload not bound to the
originating slot; `slow_pct` stacking unclamped; horde waves
spawning inside geometry; DoT landing one tick past expiry; stun
mid-windup landing a frozen swing; cornered kite freeze; melee
chasers blocked by geometry (tile-grid BFS waypoint steering via
`env.nextWaypoint`); crouch-release ceiling clip; airborne floor
re-anchoring (pit flyover height drop); stepped jump rendering
(client ballistic prediction); footsteps while airborne; locked
doors misplaced relative to punched portals + corridors lockable
("walls of doors"); pit/platform holes lost in the linedef
round-trip (recarve pass); craft queue power-wait opacity
(per-bench tags + "low power" rows); projectiles ignoring terrain
height (floor-crossing despawn); flee wall-grind (waypoint retreat
via the same BFS hook); craft durability gap (world snapshot v4
persists in-flight jobs, station output buffers survive hydrate;
v3 snapshots still load).

---

## Economy redesign — components-first (NOW)

Implements the GDD's **Economy Law**: the dungeon produces all
inputs, the base only converts inputs into capability, nothing at
the base creates inputs. Design rationale in GDD §The Economy Law;
this is the migration. Steps are roughly ordered; 1 ships alone,
2–4 are one coherent recipe/loot change, 5–7 follow.

1. ~~**Blueprint permanence.**~~ **Shipped 2026-06-10.** Cycle-reset
   wipe removed; the learned set persists in the character row
   (additive `blueprints` field on the schema-4 inventory JSON) and
   hydrates on join. Old saves hydrate to the starter set.
2. **Weapon pieces become drops.** `frame` / `barrel` / `grip` /
   `magazine` drop as class-locked, tier-rolled, affix-rolled
   components in enemy/container loot tables. Raise the component
   drop rate from 5% to an every-kill-drops-something
   distribution — rarity lives in tier + affix count, not drought.
3. **Recipe graph flip.** Weapon recipes consume a dropped frame +
   pieces + material binder instead of raw scrap/wire. Delete the
   Forge's alloy-production recipes; Refined/Precision Alloy
   become band-gated drops and salvage outputs.
4. **Attachments drop-only.** Remove attachment crafting recipes;
   add `weapon_mod` / `weapon_affix` / `suit_affix` instances to
   loot tables (exotics — homing, ricochet, explode-on-kill —
   drop-only and rare).
5. **Forge → salvage & reroll.** Break components into materials;
   reroll a component's affixes for a material + artifact cost.
   The sink for bad drops; reuses the existing salvage verb.
6. **Benches from components.** Turret/station recipes consume
   dropped components (e.g. turret = built weapon + actuator
   component); `bench_upgrade_mkN` assembled at the Workbench from
   band-gated drops. The bench ladder mirrors dungeon depth.
7. **Schematic scope.** Blueprints gate products only (buildings,
   turrets, consumable kits, exotic assemblies); ungate basic
   weapon piece-assembly.

Shipped so far: step 1 (2026-06-10), steps 2+4 (attachments
drop-only, rates up), step 3 (weapons assemble from a class-pinned
frame drop + binder; new 'part' recipe-input matcher; frames
weighted 3x in the slot roll). Open: 5 (Forge salvage/reroll),
6 (benches from components), 7 (schematic scoping audit).

---

## Base layouts (NEW — requested 2026-06-10)

Design in GDD §Base Building › Base Layouts: the surface base is a
swappable designed platform (flat ground in hilly desolate
overworld) with turret mounts, wall geometry, and
workbench/storage capacity slots; built + swapped at the Power
Link; starter = square with 4 corner mounts. Implementation
slices:

1. **`BaseLayoutDef`** content type (footprint tile mask /
   polygon, turret-mount sockets, wall pieces, bench + storage
   slot counts) + the starter square layout as authored content.
2. **Surface integration** — platform renders as flat sectors
   standing over the terrain noise (per-sector noise machinery
   already supports flat overrides); buildings constrain to the
   platform; turrets only at mounts.
3. **Swap flow at the Power Link** — uplink tab lists known layout
   schematics; build consumes components (economy law); swapping
   re-seats existing buildings into the new layout's slots,
   spilling overflow to storage.
4. **Authoring** — layout editor reusing the rooms-editor pattern
   (tile paint + socket anchors), and/or a procgen generator for
   per-cycle variety.

Migration notes: PROTOCOL_VERSION bump; inventory-schema migration
for any new slot kinds; existing recipe JSON rewritten in place
(the editor suite makes this authoring, not engineering). Champions
as component jackpots ride with Sprint C but the loot tables should
anticipate them.

---

## Design tuning (from the 2026-06-10 playability review)

Numbers-driven adjustments; each is a tuning pass, not a system.
Full analysis in the review (session notes); key targets:

- ~~Horde scales with depth, not cycle index.~~ **Shipped
  2026-06-10** — threat = `max(deepestFloorReached, cycle)`, so
  pressure mirrors earned power capacity and never regresses on
  veteran worlds.
- **Combat TTK pass toward "deliberate."** Rifle/shotgun/sniper
  one-shot most of the roster; trash dies <1s. Raise trash HP or
  trim burst so engagements land in the 1.5–4s band the GDD
  describes.
- **Backpedal penalty.** Player moves 140 px/s omnidirectionally;
  chasers move 110 — backpedal-firing permanently kites every
  melee enemy except the swarmer. ~0.75× reverse-move multiplier,
  or chaser lunges.
- **Enemy projectile speeds are functionally hitscan** (2200+ px/s
  vs 140 player) — slow them until dodging is a verb (Doom
  veneer).
- **Weapon DPS inversions.** Energy (145 DPS, 0.92 acc) dominates
  SMG/Rifle; Heavy has best burst *and* near-best sustained;
  Energy Blade (250 DPS) out-damages every gun. Re-spread the
  table so each family owns a niche.
- **Hazard curve + faucet.** Unresisted survival is 18.5s at
  floor 5 (a wall, not a clock) while life-support drops at
  ~1 per 200 kills. Soften the early exponent and weight part
  drops toward missing slots (or guarantee life-support from
  cargo containers / champions).
- **Mid-cycle beat.** Minutes 4–13 of the cycle are flat; the
  extraction deadline is the only beat. Cheapest additions:
  roaming elite patrols on cleared floors (also fixes dead
  shallow floors), or a timed mid-cycle event room.
- **Cycle length decision.** 15-min alpha cycles compress every
  persistence system; with blueprint permanence landed, decide
  the playtest cadence (30–45 min?) deliberately rather than
  inheriting 5-min days.

---

## Sprint Q/S remainders (small, unblocked)

What's left after the 2026-06-09 audit closed most of Q and S:

- **`repair_kit` consumable** — the only one of the five planned
  consumables not implemented (`shared/src/inventory.ts:126` has
  the other four).
- **Drop-rate retune** — superseded by the economy redesign's
  loot-table rework (steps 2–4); fold any per-recipe audit into
  that pass.
- **Prewarm label gaps** — `assetGenClient.ENEMY_LABELS`
  (`packages/server/src/assetGenClient.ts:28`) missing
  `flame_drone`, `chem_bloater`, `precision_mill`. Falls back to
  snake-case labels; works, less specific prompts.
- **`EntityEditorShell` extraction** — `useEntityEditor` is shared
  but every editor page still carries 600–800 LOC of duplicated
  list/form/preview layout. Extract the shell component
  (~400 LOC removal).
- **Editor diff view** — per-entity diff of draft vs disk (the
  last open item from the editor-bridge plan).
- **Editor validation polish** — per-field error rendering;
  broken-refs coverage extended to recipes / blueprints / weapons
  / attachments.

---

## Sprint G — Gameplay systems (multi-session)

The design pillars still on paper. Hazards, props, anchors, and
the status-effect pipe shipped; these remain:

### Traps + detection + stealth (GDD §Dungeon › Hazards)
Nothing exists in code. Kinetic / electric / acid trap entities
with sprung-state persistence across the cycle; plating
mitigation; sound / light / heat signature stats on suits;
stealth utility mods reducing enemy detection radius.

### Enemy pathing on raised sectors
The AI pather operates on a floorZ-agnostic 16px walkable bitmap —
enemies don't follow players onto platforms or into pits; the
player takes high ground and the chaser bounces against the riser.
Extend the pather to read `floorAt` deltas with the same step-up
gates as player movement; tag bitmap cells with sector floorZ.
The editor's AI-grid preview overlay needs the same upgrade
(today it's pure 2D point-in-polygon — too-tall platforms read as
walkable).

### Environmental ammo
`AmmoKind` (`shared/src/inventory.ts:81-88`) has only the base
per-family kinds. Add incendiary (burn DoT), chem (poison + slow),
emp (disable buildings, bonus vs shields). The status-effect pipe
and AoE-status enemies these depend on are already live.

### Animation Phase D — ambient tile animations
The last unshipped phase of the animation plan: looping animations
on biome walls / floors / ceilings. Carried decisions from the
plan: fixed fps per state; independent timing per tile variant;
renderer does per-cell frame-index lookup (today's biome surface
binding is static — `fps.v2/index.ts:785-791`).

---

## Sprint C — Content depth (multi-session, post-G)

Dungeon identity. Biome scaffolding + per-band assignment shipped
(`biomes.ts:pickBandBiome`, BAND_SIZE 5); the rest is open:

### Dungeon banding remainder
- Base UI showing the cycle's known band layout (rotation is
  deterministic but unsurfaced — players learn by diving).
- Absolute-depth loot tier table per GDD (today `loot.ts` rolls
  from enemy `killTierBias` only, not floor depth).
- Mk4 saturation beyond floor ~20.

### Faction champions + bosses
Nothing in code. Fifth-floor champion per band, per-faction
templates, artifact reliability from champion kills. Pairs with
**E7 tier rooms**: `RoomTemplate.role` exists but only `"normal"`
is authored — no `boss` / `vault` / `extreme` templates and no
role-based spawn logic.

### Full part ontology (GDD §Items)
The weapon-parts half (dropped Frame / Barrel / Grip / Magazine as
assembly-required items) is **promoted into the economy redesign**
(steps 2–3 above). Remaining here:
- Chassis weight classes (light / medium / heavy).
- Cargo grid W×H Tetris layout.
- Multiple suits + loadout swapping.
- Alien-tier parts via artifact analysis.

### Earth trade tree (GDD §Artifacts)
Only fate #1 (trade for schematic) is implemented. Ship-to-Earth
server-wide tech unlocks; burn-as-ingredient; schematic DAG
player-facing UI (PoE-style tree). Schematic permanence lands with
economy redesign step 1; with one-time purchases, the recurring
artifact sinks are keys, Forge rerolls, and (later) these two
fates.

### Station upgrades
`handleUpgradeWorkstation` (`world.ts:2767-2829`) is hardcoded to
`weapon_bench`. Generalize tier upgrades to Forge / Electronics /
etc. (closes the E1 remainder: high `stationTier` recipes are
currently unreachable at those stations), and make `parallelSlots`
upgradable (every station ships `parallelSlots: 1` with no
upgrade path).

### Buildable variety (E4 remainder)
Wall tiers Mk2–Mk4 are in the registry; still missing:
player-placeable doors (recipe + placement + AI pathing
awareness) and cheap decoration buildables (lights, banners,
signs — not horde-prioritised).

### Enemy corpse persistence (E6)
Visible corpse billboard at enemy death position, persisting for
the floor's lifetime. Pure visual — no loot, no collision.

### Melee customization
Pieces / mods / tier-up apply to ranged only. Melee needs its own
piece system or shared mod compatibility.

### Heavy-class bullet variants
Slug / HE / incendiary tracer projectiles with per-variant
on-impact behaviour (small AoE, knockback, proximity burst).

### Editor sprite catalogue + composed weapon visuals (E8)
Texture rows for player / weapon / consumable categories; base +
overlay sprite composition for weapons + carried parts (frame base
+ per-attachment overlays) so asset_gen generates components, not
`O(weapons × mod combos)` full sprites.

---

## Sprint I — Infrastructure (multi-session)

### Game-server process lifecycle
Idle shutdown still just logs "idle, would shut down here"
(`world.ts:3859`). DB columns `game_server_host/_port/_status`
exist but are never written back. Implement: real shutdown with
state flush, registry write-back on boot/shutdown, on-demand
respawn.

### Server browser UX
No name search, no player-count / has-password / age filters, no
sort options (`app/servers/page.tsx` — mode grouping + status
cards shipped, nothing else). Rich "My Servers" panel; owner edit
name/password/slots; kick/ban.

### Deathmatch follow-ons
All open: `dm_kills_to_win` / `dm_round_duration_sec` per-server
columns (hardcoded 20 / 10min — `world.ts:498-500`), loadout
selection, `dm_results` score persistence, spectate mode, map
vote.

### Distribution
Touch controls shipped; remaining: Capacitor wrapper (iOS /
Android), Electron or Tauri desktop wrapper, Steam packaging,
itch.io page. (GDD §Distribution has the strategy.)

### asset_gen reactivation (decision pending)
Service runs; client `loadAssetIndex` is deliberately disabled
(`client/lib/assetGen.ts:21`). If reactivated: index reactivation
path, ready-notifications, verifier upgrade to VLM grading.
`docs/ASSET_REQ.md` tracks the SFX/music/sprite procurement list
independently.

---

## Sprint P — Polish (interleavable)

Pick whatever causes friction this week:

- **Wall repair** — right-click Repair consuming a fraction of
  recipe cost.
- **Manual loot pickup** — E to grab, replacing auto-walk-into-it.
- **Abandon corpse** — escape hatch for stuck players.
- **Demolish confirm** — for workstations / Power Link.
- **Minimap** — LOS-gating (explicitly absent:
  `fps.v2/index.ts:1099`), expand painter coverage.
- **Resume position on refresh** — preserve scene + xy + facing
  instead of rehydrating at the surface portal.
- **Crosshair fire flash** — the one combat-feedback item not yet
  in fps.v2 (damage overlay, enemy hit flash, melee swing all
  shipped).
- **Sprite drop shadows + loot pickup rings.**
- **Texture coverage gaps** — building_top, prop variants,
  per-cell biome variants, door states.
- **Perf harness** — mobile @ 30fps target.

### v2.1 renderer follow-ons (all open)
- **Direct linedef-to-geometry** — skip the intermediate polygon
  `SectorMap` at scene load. Pure perf.
- **Player flashlight** — camera-attached spotlight, toggle.
- **Shadow maps** — per-light passes for the ~3-5 most
  load-bearing static lights per scene, cluster-aware.
- **Decals** — bullet holes / blood splatter projected onto walls.
- **Bloom post-fx** — muzzle flash, Power Link, perihelion sky.

### v2.1 collision/movement follow-ons
Pits and head-bonk shipped; still open:
- **Low-ceiling sectors force crouch** (`ceilingZ <
  PLAYER_HEIGHT_STAND`) — crouch is input-only today, and ceiling
  noise is renderer-only by design (`scene.ts:3762-3771`).
- **Coyote time + jump buffering** — game-feel grace windows.
- **Enemy jump / crouch** — enemies stay at floor Z, full height;
  tied to melee design needing vertical engagement.
- **Projectile vs terrain** — listed under Known bugs.

### Procgen pipeline depth (all open)
- **Walker generator** — organic blob carves.
- **Voronoi generator** — honeycomb layouts.
- **Stitcher** — connect disjoint regions.
- **Declarative biome pipeline config** — generator selection is a
  single `'bsp' | 'tunneler'` field; no composable pass list.

### Editor finish
- Auto-fix / validation for degenerate loops in the CSG editor.
- Scene overrides table (pin authored scenes to floors via UI).
- Open editors from the GDD coverage table: loot tables,
  affix/RNG sampler, combat tuning.

---

## Cleanup & bug list

From the 2026-05-06 code review; **all 10 re-verified still open
2026-06-09**. Strike items as they land.

**Security:**

- ~~`makeOauthState` uses `Math.random()`~~ — fixed 2026-06-10
  (`crypto.randomBytes(16)`).
- **`parseInventoryJson` casts without Zod**
  (`packages/server/src/index.ts:609,611`). `obj.slots as
  Inventory` / `obj.equipment as Equipment`. Safe only because no
  client-write RLS policy exists on `characters`; parse anyway.
- **Discord lookup paginates only the first 200 users**
  (`packages/client/lib/discord/auth.ts:144`). Capture the user id
  elsewhere or paginate.
- ~~No WebSocket-level rate limit before dispatch~~ — fixed
  2026-06-10: dual per-connection token buckets (wide 120/s for
  everything incl. the input stream; tight 25/s for non-input
  actions), sustained overflow closes 4008.
- ~~Tile coords + dir/move magnitudes unbounded~~ — fixed
  2026-06-10 (±100000 tile bounds, ±8 vector components).
- **`JOIN_TOKEN_SECRET` reused for two flows** — join-token HMAC
  key *and* Discord synthetic-user password seed. Add
  `DISCORD_USER_SECRET` if independent rotation ever matters.

**Maintainability:**

- ~~`heartbeatTimer` shadows itself~~ — fixed 2026-06-10 (inner
  timer renamed `lastSeenTimer`).
- ~~Rename `WORLD_SNAPSHOT_SCHEMA` → `WORLD_STATE_SCHEMA`~~ —
  done 2026-06-10 with the snapshot v4 change.
- ~~`migrateLegacyAttachmentSlots` discards overflow silently~~ —
  fixed 2026-06-10 (drop count logged).
- **Per-character `last_seen_at` write every 30s**
  (`packages/server/src/index.ts:378-380`). Fine at the 5–10
  player cap; batch per world tick if the cap rises.

---

## Architectural notes for the next agent

- **`PROTOCOL_VERSION` is 44** (`packages/shared/src/protocol.ts`).
  Bump on any wire-shape change.
- **Content is JSON-first.** Every registry loads from
  `packages/shared/content/<area>/` at boot, Zod-validated, and
  hot-reloads via `contentWatch.ts`. Adding content = a JSON file
  (usually via `/editor`), not a TS edit.
- **`BUILDING_REGISTRY`** (`shared/src/buildings.ts`) is the single
  source of truth for HP, horde priority, parallel slots,
  station/workstation flags, label.
- **Attachments are unique instances** — every dropped/crafted
  attachment is an `AttachmentInstance` with rolled stats from
  `ATTACHMENT_STAT_RANGES` (`shared/inventory.ts`). All consumers
  pass instances, never bare def ids.
- **Inventory migration runs on character hydrate**
  (`server/src/index.ts:migrateLegacyAttachmentSlots`). If
  attachment shapes change again, update the migration.
- **Atomic assembly transactions** — `assemble_weapon` /
  `assemble_suit_part` clone state, walk the diff by instance id,
  and commit-or-reject whole. Mirror this pattern for any future
  multi-step inventory mutation.
- **Side convention is load-bearing** in the linedef model:
  front = LEFT half-plane of v1→v2. Every tool, walker, and
  collision check depends on it — see
  `docs/editor-render-architecture.md` before touching geometry.
- **Playtest mode** (`servers.is_playtest`): every join rebuilds a
  fat debug loadout; treat as sandbox.
- **Auto-deploy:** GitHub Actions deploys the game server to Fly
  on pushes touching `packages/{server,shared,asset_gen}`,
  workspace manifests, or `fly.toml`. Vercel auto-deploys the
  client.

## Reference

- **`GDD.md`** — design intent. North star.
- **`docs/editor-render-architecture.md`** — scene authoring →
  rendering pipeline, collision invariants, sharp edges. Read
  before touching geometry code.
- **`docs/ASSET_REQ.md`** — SFX / music / sprite procurement list.
- **`docs/discord-integration.md`** — Discord portal setup notes
  (historical; flows shipped).
