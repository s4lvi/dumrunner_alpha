# Asset Requirements

Tracks game assets the engine needs but doesn't yet have. Source the
samples / sprites listed below and drop them into the matching path;
the wiring instructions for each tier explain how the engine picks
them up.

This document is the source of truth for "what assets are missing."
The GDD describes the design intent; this file is the procurement
list.

---

## SFX

### Wiring (one-time)

To add a new SFX id end-to-end:

1. Drop the file at `packages/client/public/sounds/<id>.mp3`.
2. Open `packages/client/lib/audio.ts`:
   - Add the id to the `SfxId` union.
   - Add a `SFX_FILES[id] = '/sounds/<id>.mp3'` entry.
   - Add a `SFX_VOLUME[id]` entry (0.0–1.0; tune by ear against the
     master). Defaults to 0.6 if omitted.
3. Add the trigger site (typically a `audio.playSfx('<id>')` call in
   `Game.tsx` next to the matching event handler).

The pool size is fixed at 4 clones per id. Short samples that can
overlap themselves (footsteps, weapon shots) cycle through the pool
so consecutive plays don't cut each other off.

### Conventions

- **Format**: MP3, mono or stereo, 44.1 kHz. Keep individual samples
  under 200 KB; the audio manager preloads everything at boot.
- **Naming**: `kebab-case-event.mp3` mirroring the `SfxId` string.
- **Length**: most should be under 1.5 s. Reload / craft-complete
  can run up to 3 s.
- **Headroom**: leave ~6 dB; the master volume + per-sfx gain stack
  on top, and live combat already has a lot of overlapping fire.

### Tier 1 — combat-essential (~15 samples)

Highest play-count events. Differentiating these is the single
biggest sound-design lift for the alpha.

| Id | Trigger | Notes |
|---|---|---|
| `weapon-pistol-shoot` | per shot, family `pistol` | replaces shared `player-shoot` |
| `weapon-smg-shoot` | per shot, family `smg` | rapid snappy crack; throttled to one play per ~60ms |
| `weapon-shotgun-shoot` | per shot, family `shotgun` | chunky boom; the per-shooter throttle handles the 6-pellet burst |
| `weapon-rifle-shoot` | per shot, family `rifle` | high-velocity supersonic |
| `weapon-sniper-shoot` | per shot, family `sniper` | very loud; long tail |
| `weapon-heavy-shoot` | per shot, family `heavy` | low slow boom; follows the slug-cannon cadence |
| `weapon-energy-shoot` | per shot, family `energy` | sci-fi zap / laser |
| `weapon-reload-start` | `reload_started` for self | currently `collect-scrap` placeholder |
| `weapon-reload-end` | `weapon_reloaded` for self | bolt-slap thunk |
| `weapon-dry-fire` | fire input pressed with mag = 0 (currently silent no-op) | single hammer click |
| `melee-knife-swing` | `weapon_swung` weaponId `knife` | quick whoosh |
| `melee-sword-swing` | `weapon_swung` weaponId `sword` | wider arc whoosh |
| `melee-hammer-swing` | `weapon_swung` weaponId `hammer` | heavy whoomph |
| `melee-energy-blade-swing` | `weapon_swung` weaponId `energy_blade` | electric hum |
| `melee-hit-flesh` | melee swing connects with chaser/swarmer/etc | wet impact |
| `melee-hit-armor` | melee swing connects with armored/brute | metal clang |

### Tier 2 — combat polish (~13 samples)

Lower play-count but each one matters for the moment-to-moment feel.

| Id | Trigger | Notes |
|---|---|---|
| `shield-break` | shield depletes from non-zero to zero | glass-shatter / electric pop |
| `shield-regen-loop` | (optional) loops while shield is regenerating | soft hum; fades on full |
| `player-death` | `player_died` for self | short gasp / static cut |
| `player-respawn` | `player_respawned` for self | power-up hum / breath-in |
| `imbue-burn-applied` | projectile/melee with incendiary mod hits | sizzle |
| `imbue-chem-applied` | with chem mod hits | drip / hiss |
| `imbue-cryo-applied` | with cryo mod hits | freeze tick |
| `enemy-melee-chaser` | `chaser_melee` attack contact | rat-bite |
| `enemy-melee-brute` | `brute_chaser` attack contact | heavy slam |
| `enemy-melee-swarmer` | `swarmer` attack contact | skitter chitter |
| `enemy-melee-armored` | `armored` attack contact | metal stomp |
| `enemy-aoe-flame` | `flame_drone` cone attack fires | flamethrower wash; gives the player a moment to dodge |
| `enemy-aoe-chem` | `chem_bloater` cone attack fires | wet vomit gurgle |

### Tier 3 — crafting & inventory (~16 samples)

Fires often during base time. Sells the "queue and go scavenge"
loop the GDD describes.

| Id | Trigger | Notes |
|---|---|---|
| `build-place` | `building_placed` (any kind) | clunk / hammer-hit |
| `build-demolish` | `building_destroyed` from player demolish | wrench-disassembly |
| `craft-start` | `craft_job_started` for self | mechanical engage |
| `craft-complete` | `craft_job_completed` for self | soft chime / ding |
| `craft-take-all` | `pickup_station_outputs` send | quick whoosh |
| `tier-up` | tier-up commit at Precision Mill | heavy mechanical lock-in clack |
| `weapon-assemble` | `assemble_weapon` commit | multi-piece click-together |
| `salvage` | `salvage_request` send | unscrew / break-apart |
| `consumable-medkit` | `use_consumable` for medkit/medkit_lg/medkit_xl | hiss + heartbeat |
| `consumable-stim` | `use_consumable` for stim | sharp inhale / power-up surge |
| `consumable-overcharge` | `use_consumable` for overcharge_kit | electric crackle |
| `pickup-weapon` | inventory diff shows a new weapon slot | distinct heavier metallic clink |
| `pickup-attachment` | inventory diff shows a new attachment slot | micro-mechanical click |
| `drop-item` | `inventory_drop` send | small thump |
| `equip-armor` | `equip_request` send | strap-tighten / fit clack |
| `purchase-blueprint` | uplink Buy clicked | cash-register / receipt chime |

### Tier 4 — world interaction & power (~9 samples)

| Id | Trigger | Notes |
|---|---|---|
| `chest-open` | chest modal opens | hinge creak / hydraulic |
| `chest-transfer` | per-item shuffle in/out of chest | quiet swap |
| `door-unlock` | `open_door` send (key consumed) | mechanical lock disengage + hinge swing |
| `stairs-descend` | scene transition to deeper floor | brief rumble during transition |
| `extract-teleport` | extract pad interact, scene transition to surface | sci-fi whoosh / phase shift |
| `power-link-descend` | Power Link interact (descend via portal) | energetic hum / portal engage |
| `power-link-destroyed` | Power Link HP reaches 0 | heavy alarm — most catastrophic event |
| `turret-online` | turret enters powered set | soft servo wake |
| `turret-offline` | turret leaves powered set | power-down sigh |

### Tier 5 — perihelion / horde (~5 samples)

The most dramatic moments in the loop. Worth a dedicated pass.

| Id | Trigger | Notes |
|---|---|---|
| `perihelion-warning` | dungeon-side, secondsToPerihelion crosses ≤30 | currently `robot-detect` placeholder; want a clear alarm pulse, unmistakably "warning" not "an enemy spotted you" |
| `horde-start` | `horde_started` (surface, all players) | air-raid wail / brass hit; the moment, not the lead-up |
| `horde-end` | `horde_ended` | relief tone / wind-down chord |
| `horde-wave-spawn` | each surface wave fires (~every 15 s during the 60 s horde) | low rumble |
| `link-severed` | `link_severed` for self (in dungeon when horde fires) | sci-fi static / connection-lost glitch; pairs with the existing full-screen overlay |

### Tier 6 — UI / chat polish (2 samples)

| Id | Trigger | Notes |
|---|---|---|
| `chat-system` | system chat entry arrives (death notice, join, leave) | soft single tone |
| `chat-player` | player chat entry arrives | soft double tone — distinguishable from system without looking |

### Minimum-viable bundles

If you can't source everything at once, these bundles each ship a
coherent pass on their own:

- **Bundle A — combat differentiation (Tier 1 only):** ~15 samples.
  Biggest single gameplay-feel improvement.
- **Bundle B — perihelion drama (Tier 5):** ~5 samples. Closes the
  "perihelion is silent" gap.
- **Bundle C — crafting & loop (Tier 3):** ~16 samples. Sells the
  base-management loop.

Tier 2, 4, 6 are polish that can land later in any order.

---

## Music

### Wiring

Music tracks live at `packages/client/public/music/<id>.mp3`. The
audio manager loops them and crossfades over 600 ms.

To add a new track:

1. Drop the file at `packages/client/public/music/<id>.mp3`.
2. In `audio.ts`:
   - Add the id to the `MusicId` exported union.
   - Add an entry to `MUSIC_FILES`.
3. Trigger via `audio.playMusic('<id>')`.

### Current

| Id | Used for |
|---|---|
| `dungeon` | playing while in any `dungeon:N` scene |
| `defense` | playing while on `surface` (whether horde-active or not) |

### Wishlist

| Id | Triggered when | Notes |
|---|---|---|
| `horde` | `horde_started` while on surface; reverts to `defense` on `horde_ended` | 60-second-friendly loop. Higher intensity than `defense`. The single biggest win for the perihelion moment — currently the surface plays the same `defense` track during attack and during quiet base-building. |

---

## Sprites

The `@dumrunner/asset_gen` service generates sprite PNGs on demand.
The runtime is shipped; the catalog is incremental. This section
captures sprite gaps the engine is currently filling with procedural
shapes.

### Wiring

- Server fires `ensureBuildingAsset(kind)`, `ensureEnemyAsset(template)`,
  and `ensureMaterialAsset(id)` from `assetGenClient.ts`. The asset
  service either returns a cached approved sprite immediately or
  queues a job; the game falls back to procedural shapes meanwhile.
- Editorial labels for each kind live in
  `packages/server/src/assetGenClient.ts` (`ENEMY_LABELS`, etc.).
  Auto-generated labels work but produce less-specific prompts.

### Missing editorial labels

| Kind | Suggested label |
|---|---|
| `flame_drone` enemy template | "sun-bleached flamethrower drone with a forward fire-cone nozzle" |
| `chem_bloater` enemy template | "bloated catacombs mutant that vomits a poison cone" |
| `precision_mill` building | "precision machining mill — central spindle disc on a steel base" |

These are server-side prompt enrichments only; they don't gate
gameplay. The `BUILDING_KINDS` and template-id auto-derivation
handles the wiring; editorial labels are for prompt quality.

### Catalog gaps (procedural fallback today)

These sprites can land incrementally as the asset service catches up.
None block gameplay.

- **All weapon families** (pistol/SMG/shotgun/rifle/sniper/heavy/
  energy/knife/sword/hammer/energy_blade): currently rendered as
  inline SVG `ItemIcon` for the inventory + procedural body shapes
  in pixi.ts. World-sprite versions for the equipped weapon held by
  the character would land via `ensureBuildingAsset`-shaped enemy/
  weapon-prop calls.
- **Suit parts**: rendered as tier-coloured diamond icons in the
  inventory. Bespoke per-slot sprites (chassis silhouette, plating
  pattern, life-support pack, etc.) would lift the Diablo-flavor
  read.
- **Per-material icons** (`scrap` / `wire` / `alloy` / `circuit` /
  `biotic` / `crystal` / `artifact` / `key`): currently inline SVG.
  Stylised crafting-game-style icons would fit the cyberpunk tone
  better than the geometric placeholders.
- **Buildings**: walls, turret variants, workstations, Power Link,
  Precision Mill, Suit Assembly Bench (when it ships) all have
  in-pixi procedural geometry. Real top-down sprite renders would
  unify the visual style.

The asset_gen service has prewarm support
(`packages/asset_gen/scripts/prewarm.ts`) — running it covers the
catalog ahead of player demand, with cache-key dedup making
subsequent runs near-free.
