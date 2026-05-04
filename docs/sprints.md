# Post-alpha sprint plan

Living document. Source of truth for the next stretch of work between
"alpha is shipped" and "open beta." Sprints are scoped so each
delivers something observable; ordering minimises rework by
front-loading the architectural lifts that other features want to
build on.

Effort scale: **S** = hours, **M** = a session, **L** = 2–3 sessions,
**XL** = multi-week.

---

## Sprint A — quick wins (1 session)

Pure friction-removal so playtesting feels less janky. Nothing
architectural; ship and move on.

### A1. Spawn-in-walls bug · S · low risk
`SURFACE_ENTRANCE_X/Y` is hardcoded `(80, 0)`. If a wall lands on
that tile, every subsequent respawn / dungeon-extract puts the
player inside it. Fix in `World.respawnPlayerToSurface` + the
extract-return path: BFS outward from canonical spawn until a
clear, walkable, building-free tile is found. ~30 LOC.

### A2. Death recovery when base destroyed mid-perihelion · S · depends on A1
If Power Link is dead and the player respawns into hordeforce, they
die again instantly. Layer on top of A1's safe-tile pick: also
require no enemy within ~5 tiles before accepting a spawn point.
Fall-through case (whole arena swarmed) → grant 2s of damage
immunity on respawn. v2 (post-A): "abandon corpse" option for
players stuck in death loops.

### A3. Drop-rate retune · S
Audit every recipe input against per-template loot weights. Storage
chest needs alloy; alloy is currently weighted as "rare." Same audit
for circuit, biotic, crystal vs the recipes that need them. Pure
number tuning in `loot.ts` + `templates.ts`. Worth doing **before**
any new content lands so new content plays at correct rates.

---

## Sprint B — drop loop + status pipe + minimap (2–3 sessions)

Layered: drop/give is its own thing; stims build a status-effect
system that #8 also needs; minimap wraps it.

### B1. Drop / give items · M
Existing `inventory_discard` removes items silently. Two changes:
- **Drop:** new behaviour for the discard path → spawn a
  `LootState` at the player's position; existing pickup flow
  handles the rest.
- **Give:** new WS message `give_to_player { targetCharacterId,
  slot }`; server validates proximity (~CRAFT_STATION_RANGE_PX),
  swaps slot into recipient's first-empty inventory index, sends
  `inventory_changed` to both. Right-click slot menu gains
  Drop / Give options.

### B2. Status-effect system + stims/overcharge/medkit tiers · M
**Architectural piece** that lots of later work depends on (#8 env
weapons, #10 itself, future suit affixes that confer temp buffs).

- New `Connection.activeEffects: Effect[]` where `Effect = { id,
  expiresAt, kind: 'speed' | 'stamina_regen' | 'shield_flat' | …,
  magnitude }`.
- `recomputePlayerStats` already exists — extend to fold active
  effects into derived numbers each tick.
- Tick loop expires effects and re-broadcasts stats.
- `useConsumable` for new kinds adds the right effect.

Then add consumables:
- `stim` (+30% speed + stamina regen, 30s)
- `overcharge_kit` (+50 shield flat, 60s)
- `medkit_lg` (heals 120 instant)
- `medkit_xl` (heals 220 instant)
- `repair_kit` (instant heal nearest player-built building 100 HP)

All five = ~30 LOC of data each once the pipe exists.

### B3. Minimap · M
Top-right corner overlay, both top-down and FPS. Renders directly
with Pixi Graphics:
- Walkables dim, fog-visible bright, buildings as colored squares
- Self as arrow, other players as dots, enemies-in-LoS as red dots
- Re-uses `currentLayout.walkables` + the fog visibility cache
  the renderer already maintains
- Toggle key (M? — currently mute; pick another, maybe **N**)

Shared `MinimapPainter` class so pixi.ts and fps.ts stay in sync.
~200 LOC.

---

## Sprint C — procedural attachments (the keystone) — L–XL

The architectural lift that unlocks #5/#7/#8/#11 properly.

### C1. Procedural attachment generation · L · high risk
**Why now:** every other content addition that touches mods/affixes
is cheaper after this lands, more expensive before.

Today `ATTACHMENT_DEFS: Record<defId, AttachmentDef>` is a static
table — every "Foregrip Mod" in the world is the same identical
object. Want unique-instance attachments with rolled stats inside
classes:

- **Class registry**: `AttachmentClass { id, slot, statRanges:
  { damageMul: [lo,hi], reloadFlatMs: [lo,hi], … } }`. Defines what
  *can* roll on this class.
- **Instance type**: `Attachment { id, classId, tier, rolledStats:
  Record<stat, number>, name }`. Naming reuses the cyberpunk
  prefix system.
- Inventory slot becomes `{ kind: 'attachment'; instance:
  Attachment }`. **Stacking dies** — every instance is unique.
  Bag accounting works fine since slots are still 1 per item.
- `computeWeaponEffect` reads `instance.rolledStats` instead of
  the static effect.
- Recipe outputs of attachments roll a fresh instance at craft
  time; loot drops do the same.
- **Save/load**: bump character schema version. Migration converts
  old `defId`-based slots into deterministic class instances
  seeded by `defId` so existing inventories don't lose items.

Roughly 800–1500 LOC plus migration. Single biggest commit on the
roadmap.

---

## Sprint D — content built on procedural attachments

### D1. Salvage parts (#5) · M · depends on C1
For attachment instances, refund = `~0.20 * sum(rolledStats *
rarityWeight)`. For weapons, refund = `~0.20 * Recipe.inputs`. New
suit affix `salvage_yield_pct` boosts refund 20% → 25/30/35 by
tier. Salvage station kind (or Salvage tab on Workbench).

### D2. Remaining weapon families + melee progression (#7) · L
**Ranged:** sniper, heavy, energy. Each = `WEAPON_STATS` row +
`WEAPON_FAMILY` mapping + recipe + blueprint + sprite + matching
ammo + turret variant. ~200 LOC each.

**Melee:** the hard part — new combat verb. New stats type:
`{ damage, swingIntervalMs, range, arcRad }`. Server-side hit
detection sweeps a cone in front of the player. Visual swipe
trail. Then 4 melee weapons (knife / sword / hammer / energy_blade)
ranging across the same tier ladder ranged weapons use.

### D3. Environmental ammo + AoE-status enemies (#8) · L · depends on B2
Ammo types: `incendiary` (burn DoT 30 dps × 4s), `chem`
(poison DoT + 25% slow × 6s), `emp` (disable buildings 5s, double
damage to shielded enemies). Each piggybacks on the B2 status pipe.

Enemy templates with AoE: new attack profile `aoe_cone` with
`effectId, ticksMs, durationMs`. Two enemies: `flamethrower_drone`
(applies burn in a forward cone), `chem_bloater` (leaves a poison
puddle on death).

### D4. Weapon assembly UI (#11) · M · cleanest after C1
Weapon Bench drag-drop modal: 4 piece slots + mod bar + ghost
stats panel. `effectiveWeaponStats(weapon)` already runs over
piece+mod composition — feed the in-progress assembly through it
to render preview stats live.

---

## Sprint E — UX overhauls (parallelisable)

### E1. Blueprint tree progression (#9) · L
Today blueprints are flat in `BLUEPRINT_CATALOG`. Want a DAG:
unlocking workbench unlocks tier-1 nodes; crafting a "Forge Uplink"
upgrades the forge to tier-2 nodes, etc. Recipes gain `stationTier`
requirement.

UI: tree visualisation similar to Path of Exile passive tree but
simpler. Pannable canvas, nodes coloured by state (locked /
unlockable / unlocked). Reuses the trade modal shell. The UI is
the bulk of the work; data model is straightforward.

### E2. Mobile controls (#1) · L · cuts across renderer + input
- Detect via `matchMedia('(hover: none) and (pointer: coarse)')`
  at mount.
- `MobileControls` overlay: virtual stick bottom-left (feeds
  `input` WS msg), virtual fire button bottom-right, button row
  for reload/use/interact, hamburger for inventory.
- FPS view: right-half drag for aim + auto-fire on tap, or second
  virtual stick. Trickier.

### E3. Dungeon overhaul / WFC + biomes (#12) · XL · highest blast radius
- `Biome` enum: `mechanical / organic / cave / open`. Each ships a
  tile palette, room-shape constraints, enemy bias.
- WFC implementation (~600 LOC) with adjacency rules per tile,
  propagation, backtracking.
- Per-biome enemy roster + scatter-loot material bias (organic
  drops biotic; mechanical drops circuit; cave drops crystal).
- Renderer per-tile sprite support. asset_gen catalog needs
  biome-tile sprites.

Defer to last in the polish pass. Big payoff, high risk, asset_gen-
heavy.

---

## Notes

- **Why C1 before more content:** every later attachment-touching
  feature pays an architectural debt up front otherwise. Doing it
  once when there's still relatively little saved state is much
  cheaper than after.
- **B2 (status pipe) is load-bearing for D3 and beyond.** Ship it
  with stims/medkit tiers so we have at-least-one consumer to
  validate the API while building it.
- **Sprints D and E can interleave** once C1 is in. E items don't
  share files with D items, so two parallel branches of work are
  possible.
