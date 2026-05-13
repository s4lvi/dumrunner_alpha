# DÛM RUNNER — Game Design Document

## Concept

DÛM RUNNER is a browser-based multiplayer tactical extraction shooter with roguelike dungeon-diving and persistent base-building. Runners scavenge alien ruins on a hostile planet, reverse-engineer the technology, and ship artifacts back to Earth in exchange for manufacturing tech. Every three in-game days the planet reaches perihelion, monsters frenzy, and the surface base must survive a horde assault.

## Setting

Post-apocalyptic cyberpunk future. The colony sits on the surface of a hostile alien world strewn with the ruins of an ancient advanced civilization. Earth funds the expedition in exchange for recovered alien tech.

## Core Loop

1. **Dive** — descend into the persistent Dungeon of Dûm via the surface **Power Link** structure to scavenge parts, artifacts, components, and materials. Each floor descended raises the base's power capacity.
2. **Extract** — reach a per-floor extract teleporter to bank loot at the surface base.
3. **Build & craft** — assemble weapons and suit mods from parts; expand the base with grid-placed walls, turrets, crafting stations, and the artifact uplink. Crafting consumes time + power, not just materials.
4. **Trade for blueprints** — spend artifacts at the uplink to permanently unlock new craftable items.
5. **Defend** — every third in-game day at perihelion, the surface is attacked by a horde that prioritises destroying the Power Link and player defences. Survive together.
6. **Reset & repeat** — perihelion regenerates the dungeon, restores the Power Link, and resets the depth-power chain; players return to fresh shallow floors and push the frontier again.

## Perspective & Controls

The game ships with two interchangeable render modes; players toggle freely with **V**.

- **Isometric** *(default)* — Pixi-rendered iso projection. WASD movement, mouse aim, click to fire. Tactical clarity for build mode and combat readability; entities render as billboarded sprites that depth-sort with terrain.
- **2.5D first-person** *(toggle with V)* — Wolfenstein/Doom-style raycaster on the same Pixi canvas. WASD becomes yaw-relative (forward / strafe), pointer-lock mouse-look (yaw + pseudo-pitch via horizon shift), click to fire. Feels like a boomer-shooter; build mode uses a floor-reticle ray pick to target the tile under the camera. The renderer is a drop-in replacement that reads the same `SceneState` — server is unchanged.

Both modes share the same React HUD chrome (status bars, hotbar, controls hint, crosshair) and the same texture-override / asset pipeline — sprites uploaded once render in both views. Target platform is desktop browser first; touch + mobile come later via Capacitor.

> **Top-down (Pixi) renderer is deprecated.** Earlier builds shipped a third overhead 2D view alongside iso + FPS. Maintaining three render paths against the same scene state was costing more than the third perspective added — and iso + FPS share an asset pipeline (billboard sprites) that the overhead view didn't. The `pixi.ts` runner stays in the codebase for now (no UI path reaches it; the V-cycle skips it) so we can revive or salvage code if needed, but no further work goes into it. Future renderer work concentrates on iso + FPS.

## Combat

Tactical extraction-shooter feel. Slower and more deliberate than arcade twin-stick:

- Ammo is finite and worth managing.
- Individual enemies are dangerous; positioning matters more than reflexes.
- Time-to-kill on both sides is meaningful — you can die to a single bad engagement.
- **Server-authoritative simulation.** Every hit, every projectile path, every enemy AI decision is computed on the server; the client is a thin renderer with prediction. Players can't desync into "client-side wins" because the server owns the truth.
- **Stamina + sprint.** Hold Shift to sprint at 1.6×; drains 35/s, regen 25/s with a 1.5s post-sprint delay buffer so empty-tank fakery isn't possible.
- **Shield system.** Damage soaks shield first; overflow goes to HP. Shield regenerates 15/s after 3 seconds of no damage.
- **Per-template enemy stuns.** Hits briefly stun the enemy (200ms typical, 80ms for brutes who shrug it off), so kiting and burst windows are real.
- **Player-vs-player is off** in the alpha. All servers are co-op only.

**Weapon classes shipped in the alpha:** seven ranged families — **Pistol** (balanced baseline), **SMG** (high RoF, low damage), **Shotgun** (6-pellet pattern, short range), **Rifle** (high single-shot damage, slower cadence), **Sniper** (single-shot, long range), **Heavy** (chunky slug, generic projectile for now — variants deferred), **Energy** — plus four melee weapons: **Knife**, **Sword**, **Hammer**, **Energy Blade**. Each ranged weapon carries a per-family stat sheet:

- `damage` / `fireIntervalMs` / `projectileSpeed` / `projectileTtlMs`.
- `pelletCount` + `spreadRad` (the shotgun's pattern; pellet count = 1 collapses to a single shot).
- `accuracy` ∈ [0..1] — per-shot uniform jitter offset within `(1 - acc) × MAX_INACCURACY_RAD`. Independent of pellet pattern; a tight shotgun can have wide pellets.
- `magazineSize` + `reloadMs`. Reserve ammo lives in inventory; only consumed during reload, not per shot. **R** triggers a reload; fire is locked while reloading.
- `ammoKind` per family (`pistol_basic`, `smg_basic`, `shotgun_shells`, `rifle_rounds`).

Mods + piece-affix attachments scale these stats per weapon instance via `computeWeaponEffect` (damage / fire-interval / spread / projectile-speed multipliers stack from every attached piece + mod). The full part-driven assembly described in [Items & Procedural Generation](#items--procedural-generation) is the long-term direction; today's mods + affixes are the alpha foundation of that system.

## Multiplayer

- **Server size:** 5–10 players per server.
- **Server types:** public or private, created by registered users.
- **Authentication & account data:** Supabase. Discord OAuth + Discord Activity flows are planned (see `docs/discord-integration.md`); v1 ships email/password.
- **Dungeon model:** **shared co-op dungeon with async entry/exit.** All players on a server occupy the same dungeon instance, but can dive, retreat to base, and rejoin parties asynchronously.
- **Rejoining a party in progress:** you spawn at the surface base. Pressing E on the Power Link teleports you to the cycle's deepest reached floor (the "frontier"), so a rejoiner lands at the same depth as the rest of the party — no walk-down. Intra-dungeon stairs still work normally for floor-by-floor descent within a session. The earlier "must walk down floor by floor" rule was superseded by the frontier-fast-travel design once the Power Link became the dungeon portal — see [Power System](#power-system).
- **In-game chat:** top-left panel, always visible. Press **Enter** to focus, type, **Enter** to send, **Esc** to cancel. Server-wide channel — every connected player sees every message. Server emits italic system lines on player joins, leaves, and deaths. Player chat is rate-limited (~1.6 msg/sec) and capped at 280 chars.

## Dungeon

### Structure

- **Persistent across runs**, regenerates only at perihelion (every 3 in-game days).
- **Roguelike depth progression:** stairs lead down to progressively harder floors. The dungeon is divided into **bands of roughly five floors each**, and the number of bands is **effectively infinite** — there is no fixed bottom. Each band is assigned one of the four alpha biomes at cycle start. The "frontier" is the deepest floor any player has pushed to on the current cycle.
- **Per-floor extract teleporter:** every floor has an extract pad that returns players to the surface base with whatever they're carrying. Removes the need to walk back up; makes deep dives committing but not punishing on the run-out.

### Persistence Behavior

- Cleared enemies stay dead until perihelion.
- Looted containers stay empty until perihelion.
- Sprung traps stay sprung until perihelion.
- Shallow floors therefore decay into safe transit zones over the cycle — natural depth gating, natural new-player on-ramps.
- Difficulty does **not** escalate as perihelion approaches. The dungeon stays at baseline; the horde is the escalation.

### Procedural Generation

- Each floor's layout is **deterministic from `(worldSeed, cycle, floorIndex)`** — every player on the same server sees the exact same map for floor N during cycle K. Re-rolling only happens at perihelion (cycle increment).
- Rooms + corridors are tile-aligned axis-aligned rectangles built on a 32-pixel grid, so wall raycasting works with exact DDA (no fractional-step wobble).
- Initial enemy spawns and scatter loot piles are seeded from the same world hash so co-op crews see the same starting fight.

### Hazards

Suit life-support and plating determine **how deep and how long** a player can survive in a hostile biome. There are no hard gates — any player can attempt any floor — but hazard ticks scale with depth and biome intensity, so under-geared dives face a brutal damage clock. Hazard categories:

- **Environmental:** radiation, toxic atmosphere, cold, heat. Each biome has a dominant environmental hazard; matching life-support reduces (does not negate) the tick.
- **Trap-based damage types:** kinetic, electric, acid. Mitigated by armor plating.
- **Detection / stealth:** sound, light, heat signature. Suit utility mods reduce enemy detection radius and enable stealth playstyles.

### Biomes

The dungeon contains four biomes for the alpha. Each biome has its own environmental hazard, enemy faction, trap suite, and aesthetic — each is a distinct place, not just a reskin.

**Biome rotation.** The dungeon is divided into bands of roughly five floors each, and the number of bands is unbounded. At each perihelion, every band is independently rolled to one of the four biomes (with repeats permitted) — so a cycle's layout might look like Catacombs / Frozen / Frozen / Sun-Bleached / Alien Core / Sun-Bleached / … extending as deep as anyone pushes. *(Planned)* a base UI exposes the layout for known bands so crews can plan loadouts around it; today the rotation is deterministic but unsurfaced — players learn the layout by diving. Biome rotation does not interfere with corpse recovery because perihelion wipes corpses anyway.

**Difficulty curve.** Hazard intensity, enemy strength, and loot tier all scale with **absolute floor depth**, not just within-band position. Past a certain depth (~floor 20 / band 4), Mk4 drops become the norm and further escalation comes from harder enemies, higher affix rolls, more elites and faction champions per floor, and richer artifact density — not from a higher Mk tier. Deep pushes are about hunting artifacts and affix god-rolls, not new tiers.

| Biome | Dominant Hazard | Secondary Hazards | Faction & Theme | Aesthetic |
|-------|-----------------|-------------------|-----------------|-----------|
| **Sun-Bleached Ruins** | Heat | Kinetic traps (collapsing masonry, shrapnel); high light/sound detection | Feral scavenger bio-mechs picking the surface clean | Sand-blasted alien plazas, broken pillars, harsh exposed light |
| **Irradiated Catacombs** | Radiation | Acid traps (corroded pipes, leakages); low-light favors stealth | Mutated former colonists, glowing wraith-like things | Cramped tunnels, glowing crystals, decay and rust |
| **Frozen Vaults** | Cold | Electric traps (exposed alien circuitry, ice-conductive); heat-signature stands out | Cryo-preserved alien sentinels, ice predators | Blue ice, mirrored frozen alien tech, brittle glass |
| **Alien Core** | Toxic atmosphere | Mixed traps (exotic energy fields); sound carries far in resonant chambers | Pure alien constructs and guardians | Bioluminescent geometry, organic-mechanical hybrid, otherworldly |

**Hazard density rule:** each biome has **one dominant environmental hazard** that gates entry — without matching life-support, the player takes constant damage and can't dive deep into the biome. Secondary hazards are encounter-level (specific traps in specific rooms, enemy attack types) rather than constant ticks, so they don't compound the gating but make each biome's combat feel distinct.

**Loot & enemy tier by depth.** Loot tier is driven by absolute floor depth, with band position contributing texture:

- **Floors 1–5** (band 1): Mk1 drops dominate, Mk2 occasional. Baseline enemies.
- **Floors 6–10** (band 2): Mk2 dominant, Mk3 occasional. Elites appear.
- **Floors 11–15** (band 3): Mk3 dominant, Mk4 occasional. Multiple elites; minor artifacts surface.
- **Floors 16–20** (band 4): Mk4 dominant. Faction champions guard band exits; artifacts more common.
- **Floors 21+** (deep bands): Mk4 saturated. Escalation = stronger enemies, richer affix rolls, more champions, denser artifact spawns.

Within any band, the last floor (the fifth) hosts a faction champion (themed to that band's biome) guarding the stairs down. Artifacts (the only Alien-tier source) become more common with depth and drop most reliably from faction champions.

### Props (planned)

Non-NPC billboards that populate rooms — barrels, cargo containers, conduits, terminals, trees, rocks, scrap heaps, alien growths, broken furniture. Server-authoritative, destructible by attacks, biome-themed. Scope: pure set-dressing first, then a thin layer of interactive specials (explosive barrels, lootable crates, EMP terminals). Lands as Roadmap **E3.2** once the biome scaffolding (E3.1) and editor suite (E3.0) are in place — prop spawn rules are biome-coupled and prop kinds are authored in the decorator editor, not by hand.

**Design intent.**

- **Density makes the world.** Empty floor tiles read as a placeholder dungeon; props are how a room reads as "a sun-bleached marketplace" vs "a frozen alien chamber" without bespoke per-room art.
- **Destructible by default.** Anything visible is a tile the player can shoot, melee, or grenade. High-HP for most kinds (props eat ammo; sustained fire breaks them eventually); a few low-HP exceptions (explosive barrels, fragile crystals).
- **No HP bar.** Floating bars over a room's worth of barrels would be visual noise. Damage is communicated by hit-flash + chip-off particles + "thunk" SFX. Players learn HP through play, not from a readout.
- **Loot pull, not loot push.** Most props drop nothing or low-value scrap. A few kinds (cargo containers, terminals) have meaningful loot tables to reward map awareness without making prop-breaking the dominant resource loop.

**Initial roster** (alpha plan; biome integration adds the natural ones).

| Kind | Solid? | HP | On break | Notes |
|------|--------|----|----------|-------|
| `barrel` | yes | 40 | 30% scrap×1 | Generic industrial. Common across biomes. |
| `explosive_barrel` | yes | 5 | AoE damage 60 in 96px (player + enemies) | The exception to the high-HP rule. Visually distinct (red banding). |
| `crate` | yes | 60 | scrap×3 + 20% material roll | Lootable. Wood/metal variant per biome. |
| `cargo_container` | yes | 120 | alloy×1 + 40% part roll | High-value, takes a magazine to crack. |
| `conduit` | yes | 30 | nothing | Pure decoration; hides power-ish theming. |
| `terminal` | yes | 80 | 5% blueprint roll | Telegraphs as "interactable looking" but isn't — pure breakable. |
| `tree` | yes | 80 | scrap×2 (biomatter once a wood material lands) | Sun-Bleached / Catacombs only. |
| `rock` | yes | 150 | scrap×1 (mineral once a stone material lands) | All biomes. |
| `pillar` | yes | ∞ | n/a | Indestructible cover. Architectural. |
| `grass_tuft` | no | 5 | nothing | Walk-through, instantly destructible. Adds Sun-Bleached texture. |

**Schema.**

```ts
type PropKind =
  | 'barrel' | 'explosive_barrel'
  | 'crate' | 'cargo_container'
  | 'conduit' | 'terminal'
  | 'tree' | 'rock' | 'pillar'
  | 'grass_tuft';

type PropState = {
  id: string;
  kind: PropKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
};

type PropDef = {
  maxHp: number;
  solid: boolean;            // blocks movement + projectiles
  onDestroy?: 'explode' | 'drop_loot';
  explodeRadius?: number;
  explodeDamage?: number;
  lootTable?: LootRoll[];     // shared with corpse loot rolls
};

const PROP_REGISTRY: Record<PropKind, PropDef> = { /* ... */ };
```

Lives alongside `BUILDING_REGISTRY` in `packages/shared/src/props.ts`. PropState is read-only client-side (no equivalent of `build_request`) — props are placed by the dungeon generator, not by players.

**Wire protocol additions.**

- `props: PropState[]` on `welcome` + `scene_changed` payloads.
- `prop_damaged { id, hp }` server → client, on every damage tick.
- `prop_destroyed { id }` server → client, on HP ≤ 0. Loot drops + `explosive_barrel` AoE damage are server-side, broadcast via the existing `loot_spawned` / `player_damaged` / `enemy_damaged` messages.

**Combat integration.**

- Server: extend the projectile-tick collision pass to include props alongside enemies + buildings. Server-side hp tracking; on hit, decrement, broadcast `prop_damaged` (throttled to ~10 Hz like enemy hp).
- Melee: same — extend swingMelee target list.
- Solid props block movement and projectiles via existing `circleFits` / segment-collision helpers (treated like a 1-tile wall for that check). Non-solid (`grass_tuft`) skips both.
- `explosive_barrel.onDestroy = 'explode'`: AoE damage to players + enemies + adjacent props (chain explosions are fun and read clearly).

**Renderer integration.**

- All three views render props as billboard sprites — same path as enemies, same texture-override pipeline (see `lib/textureOverrides.ts`). New `prop` category in `/editor`'s side panel surfaces every PropKind for upload.
- **No HP bar** — explicitly skip the `hpBar` Graphics that `EnemySprite` carries. Hit-flash overlay (white tint, 90 ms decay) reuses the enemy hit-flash code path so damage feels readable without the bar.
- Iso depth-sorts props with everything else via `worldX + worldY` z-index. FPS uses the same per-column sprite path as enemies. Top-down fits a static `Sprite` per prop into `lootLayer` (or a new `propsLayer`) — they don't move, so no per-frame transform updates.

**Spawning (biome-coupled).**

- Each `BiomeDef` declares a **prop palette** with weighted spawn entries: `{ kind, weight, allowDoorway: boolean, naturalOnly: boolean }`.
- Generator pass after rooms+corridors: walk every walkable tile, roll against the room's biome palette at a per-biome density (Sun-Bleached high — debris everywhere; Frozen sparse — empty halls). Reject placement if the tile is a doorway / spawn pad / interactable footprint.
- **Naturalness gating.** `naturalOnly: true` props (trees, rocks, grass) only spawn in surface / outdoor-feeling rooms; industrial props (terminals, conduits) only in alien / vault rooms. Catacombs sits in between — both palettes, leaning industrial.
- Same world-seed determinism as enemies + scatter loot — every player on the cycle sees the same prop layout for floor N.

**Editor support.**

- New `prop` category in the `/editor` side panel (parallel to `enemy` and `building`). Each PropKind from PROP_REGISTRY gets a row.
- Renderer hooks consult `getOverride('prop', kind)` to swap procedural billboard for textured sprite — same flow as enemies.
- Stored alongside enemies + buildings under `public/textures/prop/<kind>.png`.

## Death & Loot

- **Bag-loot stakes.** On death, the player's **inventory bag** drops as a corpse — every loose item, every part, every material stack, every ammo pile, every placeable. **Equipped gear** (chassis, plating, life-support, utility mod, cargo grid) **stays on the player.** "What you're wearing" is yours; "what you were carrying" is up for grabs.
- **Corpse persists where you died** until the next perihelion. You (or anyone) can return to that floor and recover the bag.
- **Perihelion wipes corpses** along with the dungeon reset — anything left unrecovered is lost forever.
- **Naked respawn.** Respawning at the surface base does **not** restore the starter loadout into the bag — you reappear at the surface entrance with the suit you died in but an empty bag. You either recover your corpse, scavenge fresh, or get a teammate to hand you a weapon.

This creates a meaningful corpse-run loop without making death feel like total ladder-reset: gear that defines your build survives, but everything you scavenged that run is on the line. The perihelion clock makes recovery time-pressured.

## Items & Procedural Generation

Every weapon, suit, and mod is procedurally generated from a typed part ontology. Parts are the loot; players scavenge raw parts from the dungeon and assemble them at base.

### Part Ontology — Overview

A **part** is a typed object that fits into one slot of a weapon or suit assembly. Every part has:

- A **slot** (which assembly slot it fits — e.g. `barrel`, `chassis`, `mod`).
- A **class** binding (e.g. `rifle`, or `null` for universal mod parts).
- A **tier** (`Mk1` → `Mk4` → `Alien`).
- **Base stats** drawn from a fixed template for that part type.
- **Affixes** — randomly rolled bonus stats, gated by tier.

Two parts of the same template can roll very different affixes, so loot variety comes from affixes; identity and balance live in the base stats.

### Tiers

| Tier | Source | Base-stat strength | Affix slots |
|------|--------|--------------------|-------------|
| Mk1 | Shallow dungeon | Low | 0 (chance of 1) |
| Mk2 | Mid dungeon | Low-Mid | 1 (chance of 2) |
| Mk3 | Mid-deep dungeon | Mid-High | 2 (chance of 3) |
| Mk4 | Deep dungeon | High | 3 (chance of 4) |
| Alien | Artifacts only | Highest, exotic | 4 (chance of 5) |

Each tier rolls its listed affix count, with a small chance to roll one extra. Higher-tier drops are concentrated on deeper floors. Alien parts are obtained exclusively by recovering artifacts and analyzing them at base — not as direct dungeon drops.

### Weapons

Weapons assemble from five slot types. The **frame** locks the weapon's class; class-specific slots (barrel, grip, magazine) must match that class. **Mod parts are universal** and fit any frame.

| Slot | Role | Primary stats |
|------|------|---------------|
| **Frame** (class-locked) | Defines weapon class, fire mode, recoil profile, mod slot count | `class`, `fireMode` (semi/burst/auto), `baseRecoil`, `modSlots` (2–3), `swapSpeed`, `handsRequired` |
| **Barrel** (class-locked) | Projectile shaping | `damage`, `damageType` (kinetic/electric/acid/energy/etc.), `range`, `accuracy`/`spread`, `projectileSpeed`, optional `pelletCount` (shotgun) and `penetration` |
| **Grip** (class-locked) | Handling | `recoilControl`, `aimSpeed`, `moveAccuracy`, `reloadSpeed` (multiplier with magazine) |
| **Magazine** (class-locked) | Ammo capacity & feed | `magCapacity`, `reserveCapacity`, `reloadSpeed`, optional `ammoVariant` (subsonic/AP/incendiary) |
| **Mod** (universal, 2–3 slots from frame) | Special effect | One discrete effect — e.g. homing rounds, ricochet, lifesteal, explode-on-kill, chain-electric, `+%` damage, status proc — at a strength scaled by the mod's tier |

**Weapon classes (alpha):** Pistol, SMG, Rifle, Shotgun, Sniper, Heavy (LMG/launcher), Energy/Alien.

### Suits

Suits assemble from five slot types. The **chassis** defines class and slot capacity; **plating** is class-locked to chassis weight class; **life-support, utility mods, and cargo grids are universal** within their slot type.

| Slot | Role | Primary stats |
|------|------|---------------|
| **Chassis** (class: light/medium/heavy) | Defines suit class and slot envelope | `class`, `baseHealth`, `baseShield`, `moveSpeed` multiplier, `staminaPool`, `utilityModSlots` (1–3), `platingCapacity`, `cargoGridDimensions` (max grid the chassis accepts) |
| **Plating** (class-locked to chassis weight) | Damage-type resistance | `kineticResist`, `electricResist`, `acidResist`, `bonusHP` |
| **Life-Support** (universal) | Environmental hazard resistance | `radiationResist`, `toxicResist`, `coldResist`, `heatResist`, optional `airSupplyDuration` |
| **Utility mod(s)** (universal, 1–3 slots from chassis) | Stealth, movement, scanning, support | One discrete effect — sound dampening, light dampening, heat-signature dampening, sprint/dash, loot scanner, minimap reveal, auto-medkit, faster-revive, etc. |
| **Cargo grid** (universal) | Tetris-style inventory grid for run loot | `gridShape` (W×H within chassis envelope), optional bonuses (e.g. extra slots for artifacts, faster artifact stash) |

**Chassis classes:**
- **Light** — fast, low health, fewer plating/utility slots, smaller cargo. Built for stealth and speed.
- **Medium** — balanced. The default workhorse.
- **Heavy** — slow, high health, more plating/utility slots, largest cargo. Built for fortified pushes and extracting fat.

#### Suit Progression Curve

**Starter kit.** Every new account starts with a Mk1 Medium chassis, a basic Mk1 life-support, basic Mk1 plating, a small Mk1 cargo grid, and a Mk1 pistol. Utility-mod and weapon-mod slots start empty — players install mods as they scavenge them. Enough to survive shallow floors of any biome briefly; not enough to push deep without scavenging.

**Progression shape.** Continuous and incremental — there are no hard biome gates. Any player can attempt any biome, but hazard ticks scale with depth and biome intensity, so an under-geared player faces a brutal damage clock. Better life-support reduces (does not negate) the tick. Practically:

- No matching resist: seconds before the hazard kills you.
- Mid-tier matching resist: minutes of viable exploration on the band's first floors.
- High-tier matching resist: a full run including the band's deepest floors.

Players therefore *can* always push, but expected viable depth in a biome is a function of their life-support tier.

**Chassis classes are parallel playstyles, not a ladder.** Light, Medium, and Heavy exist at every tier. A veteran player typically maintains multiple suits and swaps based on the dive plan: Light for scout/stealth runs in detection-heavy biomes, Heavy for big extractions or pre-horde stockpiling, Medium for general-purpose runs.

**Illustrative cargo grid scaling** (cell counts; numbers are placeholders for balance):

| Chassis class | Mk1 | Mk2 | Mk3 | Mk4 | Alien |
|---------------|-----|-----|-----|-----|-------|
| Light         | 6   | 9   | 13  | 18  | 25    |
| Medium        | 10  | 14  | 19  | 26  | 35    |
| Heavy         | 16  | 22  | 30  | 40  | 55    |

These cell counts assume the player has equipped a same-tier cargo grid part that fills the chassis envelope. A higher-tier chassis with an old Mk1 cargo grid in it will only deliver the Mk1 cell count — chassis sets the maximum capacity, the cargo grid part fills it.

Cargo capacity is the primary driver of run economy: a Heavy Mk4 extraction is several Light Mk1 runs in one trip.

**Illustrative resist scaling.** Each Life-Support part has one specialty hazard (rolls highest resist there) plus partial coverage of the other three environmental hazards. Higher tier = higher specialty cap *and* better off-coverage. Alien Life-Support reaches strong coverage on all four hazards simultaneously. Players therefore typically maintain a small wardrobe of life-supports (one per hazard) and swap to match the biome layout for the current cycle, until a single Mk4+ life-support can cover most situations.

**Other slot progression** (chassis, plating, utility mods, cargo grids) follows the standard tier ramp: each Mk increases base stats and the affix slot budget. Plating gains additional damage-type resist points per tier; chassis gains health, stamina, and additional utility-mod slots at higher tiers; utility mods gain stronger effect magnitudes.

**Why this shape works.** Combined with the biome-rotation cycle, the progression curve creates two parallel chases: a horizontal one (specialized life-supports for each hazard, swapped per cycle) and a vertical one (better chassis = larger extractions, more slots, deeper viable pushes). Players never plateau on one upgrade path.

### Affixes

Affixes are bonus stat lines drawn from a per-slot pool. Each affix is one of:

- A flat or percent boost to a base stat (e.g. `+8 damage`, `+12% reload speed`).
- A new stat the part doesn't normally roll (e.g. `+5% crit chance` on a barrel).
- A status proc chance (e.g. `8% chance to apply Burn on hit`).
- A small conditional behavior (e.g. `+15% damage to enemies above 75% HP`).

**Pool by slot** (representative, not exhaustive):

- **Barrel** — extra damage, extra range, crit chance, status proc by damage type, penetration.
- **Frame** — handling, sprint speed while equipped, swap speed, reduced ADS penalty.
- **Grip** — recoil reduction, hipfire accuracy, ADS bonus, move-while-shooting bonus.
- **Magazine** — extra capacity, faster reload, ammo regen, special-ammo proc.
- **Weapon Mod** — flat boost to its own effect's strength, extra effect duration.
- **Chassis** — bonus health, bonus stamina, faster sprint, reduced stamina drain.
- **Plating** — extra resist of any single damage type, damage reflect, brief invuln on damage taken.
- **Life-Support** — extra resist of a hazard type, extended air supply, hazard-tick reduction.
- **Utility Mod** — strength boost to its own effect, extra effect duration.
- **Cargo Grid** — extra cells, weight reduction for a category, secure pocket (1–4 cells that survive death).

#### Affix System — Alpha Implementation

Two parallel paths, both folded into the same stat accumulator:

**1. Rolled affixes on dropped parts.** Five affix kinds live in `AFFIX_DEFS`, usable on any suit slot. They roll *automatically* on dropped `CarriedPart` instances — the player doesn't craft them, and they're permanent on that part instance. Each has a flavored display name:

| Affix id | Flavor name | Effect | Roll range (Mk1 base × tier mult) |
|----------|-------------|--------|-----------------------------------|
| `add_hp` | Adrenal Surge | +N max HP | 4–10 |
| `add_shield` | Pulsewall Aegis | +N max shield | 3–9 |
| `add_stamina_max` | Lung Augment | +N max stamina | 3–8 |
| `add_stamina_regen` | Aerobic Conditioning | +N stamina/sec | 0.5–2 |
| `add_move_speed` | Lightfoot | +N% move speed | +1–4% |

Tier multiplier curve: Mk1 ×1, Mk2 ×2.2, Mk3 ×4, Mk4 ×7, Alien ×12.

**2. Crafted attachments via `ATTACHMENT_DEFS` (per-instance rolls, Sprint C).** Three attachment kinds: `weapon_mod`, `weapon_affix`, `suit_affix`. Crafted attachments are *unique instances* (`AttachmentInstance` with rolled stats inside per-class `ATTACHMENT_STAT_RANGES`) — two Compensators in the bag are not interchangeable. The class registry defines what *can* roll; each crafted instance picks a roll, scaled by tier. Same shape across all three kinds; only the slot a finished instance bolts into differs.

- **Weapon mods** sit in a free mod-slot list on the weapon. Slot count tier-gated (T1 = 0, T4 = 3).
- **Weapon piece affixes** are piece-bound: at most one per `frame / grip / magazine / barrel` slot. Slot count tier-gated (T1 = frame only, T4 = all four).
- **Suit-part affixes** are *piece-bound to a specific equipped suit part*. They bolt onto a particular plating / utility-mod / etc. via `CarriedPart.appliedAttachments`, mirroring how weapon mods bolt onto a `WeaponItem`. The two shipped suit affix classes (`aff_shield_25` "Hardened Plating", `aff_speed_5` "Servomotor Tune") have no UI surface for the alpha — they're modeled but unused. The proper home is a dedicated **Suit Assembly Bench** mirroring the Weapon Bench (Sprint D.3 — see Roadmap).

**Stat composition.** `computeWeaponEffect(weapon)` walks every piece affix instance + mod instance and returns one resolved multiplier set (damage / fire-interval / spread / projectile-speed). Server's fire path applies them; client's tooltip + Weapon Bench stats panel show the resulting "effective" stats so the player sees real numbers, not the bare baseline. Suit affix effects fold into `computeSuitStats` alongside the primary slot stat and rolled affixes — `appliedAttachments` is read via `attachmentInstanceSuitEffect` for per-instance rolls.

Adding a new attachment class is one entry in `ATTACHMENT_DEFS` + (optional) `ATTACHMENT_STAT_RANGES` row + a recipe + a blueprint catalog row.

### Item Naming

Three different naming rules for three different categories — the words "Junk" and "Razorback" both happen, but never in the same item.

**1. Weapons — Borderlands-style adjective stack from attachments.**

```
{TierLabel} {adj1} {adj2} … {Family}
```

- Tier labels for weapons (1..4): **Junk → Rusty → Standard → Precision**.
- Bare base reads as "Junk Pistol", "Standard Shotgun".
- Each attached mod / piece affix contributes one adjective from `ATTACHMENT_DEFS[id].adjective`. Order: piece order (frame → grip → magazine → barrel) then mod order. Capped at 3 adjectives so a fully-built rifle stays readable.
- Example: a Standard Shotgun with a Foregrip + Compensator + Reinforced Frame → **"Standard Brutal Steady Vented Shotgun"**.

**2. Dropped CarriedParts — cyberpunk Diablo-style flavor.**

```
{cyberpunk prefix?} {TierLabel} {weaponClass?} {coreNoun}
```

- Tier labels for parts (Mk1..Alien): **Junk → Rusty → Standard → Precision → Military**.
- Junk-tier (Mk1) drops *skip* the prefix and read as plain scrap: "Junk Carapace Frame".
- Higher tiers wear a cyberpunk prefix from a deterministic 28-entry pool keyed on `part.id` (Razorback, Synth, Pulse, Chrome, Quantum, Ion, Vector, Subwave, Crypto, Nullshade, Photon, Rad-Hardened, Servo, Glasswire, Voltaic, Static, Tachyon, Magnetar, Recursive, Splinter, Daemon, Threnodic, Greywire, Carbonyte, Phaseborn, Driftcore, Ferrosynth, Plasmaforged).
- Same `part.id` always reads as the same name across sessions / clients — names are descriptive, not random per session.

**3. Blueprints + crafted attachments — bare nouns, no flavor.**

The shop lists "Pistol", "Shotgun", "Reinforced Frame", "Foregrip" — no `Vorpal Reinforced Frame of Storms` wrapper. Crafted attachments are fungible stackable items, not unique drops; flavoring them would mislead. The crafted *weapon's* name comes from the weapon namer above and includes whatever's attached.

### Components & Materials

Crafting consumes typed component stacks scavenged from the world. Each enemy template carries a probabilistic loot table; dungeon rooms also seed scatter piles weighted by floor depth. Components stack in inventory and merge automatically on pickup.

| Material | Tier | Source | Use |
|----------|------|--------|-----|
| **Scrap** | 1 | Every enemy, every floor | Universal ingredient — walls, basic stations, ammo, every weapon recipe |
| **Wire** | 1 | Drones, dungeon scatter | Electronics tier recipes, every weapon recipe |
| **Alloy Plate** | 2 | Brutes / armored mid+ floors *or* Forge (12 scrap + 4 wire) | Heavy-tier defenses, turrets, weapon mods, Forge feedstock |
| **Refined Alloy** | 3 | Forge only (4 alloy + 2 circuit) | Weapon Bench Mk3 upgrade, high-tier weapon attachments |
| **Precision Alloy** | 4 | Forge only (4 refined alloy + 1 crystal + 1 artifact) | Weapon Bench Mk4 upgrade, top-tier weapon attachments |
| **Circuit Board** | 2 | Drones, mid+ floors | Electronics bench, turret core, AP/overclock mods, alloy refining |
| **Biotic Tissue** | 2 | Chasers (rare), deep floors | Medkits, stims, overcharge kits |
| **Resonant Crystal** | 3 | Brutes (rare), deep floors | Artifact uplink, AP-core mod, precision-alloy synthesis |
| **Artifact** | 3 | Kill-drop only (chaser 4% / drone 5% / brute 12% / armored 9% / swarmer none / others rare) | Currency at the Artifact Uplink (blueprints, keys); precision-alloy synthesis |
| **Key** | 2 | Kill-drop (~2-6%) + buyable at Uplink (1 artifact each) | Opens locked dungeon doors |

The registry (`MATERIALS` in shared) is one entry per material; adding a new component is one line plus loot-table tuning.

### Crafting & Assembly

Crafting in the alpha is **station-driven, blueprint-gated, and (planned) time-and-power-bound**.

**Workstations.** Each crafting station is a placeable building on the surface. Recipes declare which station they require; the player has to be physically near it to craft. Multiple players can share a station.

| Station | Tier | Crafted at | Recipes |
|---------|------|------------|---------|
| **Workbench** | Basic | Hand-craft (no station) | Forge, Electronics Bench, Weapon Bench, Precision Machining Mill, Artifact Uplink, all base weapons, all ammo types, medkits |
| **Forge** | Mid | Workbench | **Alloy production** — converts scrap-tier feedstock into the higher-tier alloys (Refined Alloy, Precision Alloy) consumed by Weapon Bench tier-upgrade items and high-tier attachment recipes. Also a craftable path to base Alloy Plate so a player without late-floor kills isn't gated on lucky drops. |
| **Electronics Bench** | Mid | Workbench | Auto-Turret + per-family turret variants; consumable-tier kits (large medkit, stim, overcharge); suit affix attachments. |
| **Weapon Bench** | Mid | Workbench | **Weapon assembly only** — crafts mods + weapon-piece affixes; assembles them onto base weapons via the assembly modal. **No tier-up here** — that lives at the Precision Machining Mill. |
| **Precision Machining Mill** | Mid | Workbench | **Vendor-shaped** (no recipes) — modal lists every non-melee weapon in the player's inventory and tier-ups it (T1 → T4) for a tier-scaled material cost. |
| **Artifact Uplink** | Mid | Workbench (requires 1 crystal) | **Vendor only** (no crafting): blueprint shop + keys shop. Tabbed UI. |

**Hand-crafted basics.** Walls and the first Workbench are craftable from inventory anywhere — bootstrap so a fresh character can always build out a base.

**Blueprints.** Every recipe carries an optional `blueprintId`. Recipes without one are always known. Recipes with one are gated — the player must learn the blueprint before the recipe even appears in their crafting UI.
- **Per-cycle blueprints** wipe at perihelion. The player has to re-acquire each cycle.
- **Persistent (legendary-tier) blueprints** stay on the character across cycles; even so, **the player still has to re-craft the materials every server cycle** because the dungeon resets.

**Acquisition source.** Blueprints come from the **Artifact Uplink trade store** — players spend artifacts (the kill-drop currency) to learn them. Each catalog entry has a cost, tier, and description. Buying transfers the blueprint into the player's known set, which propagates to the server. (See Artifact Uplink section below.)

**Crafting UI.** Two surfaces:
- **Inventory's "Field Craft" tab** lists hand-craftable basics only.
- **Each workstation opens its own modal** (E to interact when in range). The modal is two-column: blueprint list on the left, full requirement / output / craft button on the right. Each ingredient row shows `have/need` so deficits read at a glance.

**Async crafting.** Each recipe with a workstation has a `craftTimeMs`. Crafting at a station starts a job; output materializes when the timer expires. Jobs draw power for their duration. Hand-craftable basics stay instant. (See [Power System](#power-system) below.)

**Per-station parallel slots.** Each station building has its own queue capacity — by default **1 active job at a time** for every station kind. Want more parallelism? You either build another station or upgrade an existing one. Server binds each new job to a specific station building; if every nearby station of the kind is already saturated, the request is rejected with `station_busy`.

The progression shape:

| Tier | Parallel slots | Source |
|------|----------------|--------|
| Basic (alpha-shipped) | 1 | Default for every station |
| Upgraded (planned) | 2–3 | Spend materials at the station to upgrade it; raises that specific building's slot count |
| Advanced (planned) | 4+ | Higher-tier station kinds (e.g. "Industrial Workbench" blueprint sold at the Artifact Uplink) ship with more slots by default |

The upgrade path is the long-term answer to "I want to mass-produce ammo while the turret recipe is also queued" — start with one bench, scale to a fabrication wing.

**Station output buffers.** Crafted output does **not** drop straight into the player's inventory. Each station has an 8-slot output buffer that completed jobs deposit into (stack-merging materials / ammo / placeables of the same id). The player walks up, opens the modal, and taps **Take All** — every output slot across nearby stations of that kind transfers to their bag. Fallback: if a station was destroyed mid-craft (or the buffer is somehow saturated), the output spills directly to the requesting player so the craft is never silently lost.

This is what makes "queue and go scavenge" feel right — you come back to a stocked rack of finished gear, not an inventory you have to micromanage during the dive.

### Weapon Assembly & Tier Progression

Weapon modification is split across two stations so each surface has a single, focused job.

**Weapon Bench — assembly.** A weapon is a base chassis (its `weaponId`) plus rolled procedural attachments slotted into pieces and mod slots. The bench's modal:

1. Lists every non-melee weapon in the player's inventory (any tier).
2. When a weapon is selected, renders a **labeled slot grid**: four piece tiles (Frame · Grip · Magazine · Barrel — locked-out tiles past the weapon's tier) and a row of mod slots (count = `TIER_MOD_SLOTS[tier]`).
3. Clicking a filled slot stages a detach. Clicking an empty slot opens an inline chooser of compatible attachments — sourced from inventory **and** the weapon's currently-attached pieces, so the player can re-route a previously-detached attachment without first reverting.
4. A live `WeaponStatsPanel` underneath renders the *staged* configuration's effective stats, with green/red diff against the live weapon's current stats.
5. **Assemble** is dim until the staged configuration differs from the live weapon (compared by `AttachmentInstance.id`) and the player is in range. Clicking Assemble fires a single atomic `assemble_weapon` message.

**Atomic assembly transaction.** The server:

1. Clones the player's inventory and the target weapon.
2. Walks each piece slot the message specifies; for any change, detaches the current attachment back into the working inventory, then consumes the requested instance from the working inventory and slots it. Validates the def kind (`weapon_affix` with the correct `pieceKind`), family compatibility, and tier-allowed piece slots.
3. Walks the target mod list in order — keeps still-attached mods whose ids appear in the target, detaches anything not in the target back into inventory, consumes new mods from inventory.
4. If any step fails (missing inventory instance, no room to detach, def mismatch, family mismatch), the **entire transaction is rejected** and the player's live state is unchanged. On success, the working state is committed and an `inventory_changed` is broadcast.

This atomicity matters because the staged-changes model invites the player to plan a multi-step rework — detach two pieces, attach three new ones, swap a mod — and a half-applied state would be confusing. There's a single commit point.

**Precision Machining Mill — tier progression.** A vendor-shaped station with no recipes; its modal hosts the tier-up flow. Each non-melee weapon in inventory gets a row showing the next-tier label and the materials cost from `TIER_UP_COSTS` (tier-scaled: T1→T2 ~6 alloy + 2 circuit; T3→T4 includes crystal + artifact). Tiering up preserves all attached pieces and mods; the new tier just exposes additional piece slots and mod slots.

**Tier-mismatch.** Any tier of attachment can be slotted onto any tier of weapon. When tiers don't match, a small penalty folds into the resolved stats: each attachment's deviation from neutral (1.0 for multipliers, 0 for additive) is scaled by `1 - 0.05 × |attachmentTier − weaponTier|`, capped at 0.80. So a Mk3 attachment on a T1 weapon delivers 90% of its bonus; an Alien attachment on a T1 weapon delivers 80%. Same direction either way — a Mk1 attachment on a T4 weapon is also penalised because the precision chassis expects matching parts. Math lives in `computeWeaponEffect`; the cap means a strong roll always beats an empty slot.

**Bench-tier upgrade items.** A fresh Weapon Bench is Mk1 and can only assemble Mk1 weapons. Higher tiers are unlocked by crafting a `bench_upgrade_mkN` item at the Forge (consuming the matching alloy stratum: Mk2 from base alloy, Mk3 from Refined Alloy, Mk4 from Precision Alloy) and applying it to the bench via right-click → Apply on the upgrade item. Each step is single-tier — a Mk1 bench needs the Mk2 upgrade first; you can't skip from Mk1 to Mk3. Per-building tier persists in the world snapshot. The Forge's alloy loop is now load-bearing rather than vestigial.

**Per-tier weapon base-stat scaling.** The weapon's tier is a real chassis upgrade, not just an attachment-slot count bump. `effectiveWeaponStats` applies a per-tier multiplier on top of the family base stats: each tier-up adds +15% damage, –5% fire interval, +2 magazine, +2% accuracy, +5% projectile speed, and –5% spread. So a T4 weapon hits 45% harder, fires 15% faster, and is noticeably tighter than the T1 of the same family — even before attachments. Tier-mismatch math (above) still applies to attachments on top of this base scaling.

### Artifacts & The Earth Trade Tree

Artifacts are the long-form progression currency. They drop from kills (heavily weighted toward elites and faction champions) and have **three possible fates** at the Artifact Uplink. The player chooses one per artifact, creating real spend tension:
1. **Trade for blueprint** — spend N artifacts to learn a recipe permanently for the cycle (or persistently for legendary tier). This is the alpha's primary uplink interaction.
2. **Ship to Earth** *(post-alpha)* — sacrifices the artifact for a **server-wide** tech-tree unlock that opens a new craftable template for every player on the server.
3. **Burn as crafting ingredient** *(post-alpha)* — consume as a high-tier component in a specific recipe, e.g. Alien-tier suit assemblies.

The three-way choice lands once the post-alpha tech-tree pass ships. Today, only fate #1 is implemented; the other two reserve their place in the design.

### Data Schema (sketch)

```jsonc
// Part instance
{
  "id": "uuid",
  "kind": "weapon_part" | "suit_part",
  "slot": "barrel" | "frame" | "grip" | "magazine" | "weapon_mod"
        | "chassis" | "plating" | "life_support" | "utility_mod" | "cargo_grid",
  "class": "rifle" | null,        // null for universal slots
  "tier": "Mk1" | "Mk2" | "Mk3" | "Mk4" | "Alien",
  "templateId": "rifle_barrel_long_03",
  "baseStats": { /* from template, denormalized for portability */ },
  "affixes": [
    { "type": "extra_damage", "value": 4 },
    { "type": "crit_chance", "value": 0.05 }
  ]
}

// Weapon assembly
{
  "id": "uuid",
  "kind": "weapon",
  "frame":   "<part_id>",
  "barrel":  "<part_id>",
  "grip":    "<part_id>",
  "magazine":"<part_id>",
  "mods":    ["<part_id>", "<part_id>", "<part_id>?"]   // 2–3 from frame
}

// Suit assembly
{
  "id": "uuid",
  "kind": "suit",
  "chassis":     "<part_id>",
  "plating":     "<part_id>",
  "lifeSupport": "<part_id>",
  "utilityMods": ["<part_id>", "<part_id>?", "<part_id>?"], // 1–3 from chassis
  "cargoGrid":   "<part_id>"
}
```

Computed assembly stats = sum/composition of base stats + affixes from all slots, applied through fixed combination rules (e.g. recoil = `frame.baseRecoil * grip.recoilControl`, reload = `magazine.reloadSpeed * grip.reloadSpeed`).

## Base Building

- **Grid-snapped tile placement** on the 32-pixel surface grid.
- Build mode is driven by the equipped hotbar slot — selecting a placeable item enters build mode automatically; deselecting exits. No separate toggle key.
- In top-down view, the build ghost shows under the cursor; in first-person, a translucent **3D ghost cube** is raycast at the tile under the camera reticle.
- Base persists across deaths and perihelion cycles. The Power Link auto-rebuilds at cycle reset; everything else stays as the player left it.
- Build mode is **surface-only** — not accessible inside the dungeon.

### Buildings (alpha set)

Single-source-of-truth registry: `BUILDING_REGISTRY` in `@dumrunner/shared/buildings.ts`. Each entry carries `maxHp`, `hordePriority`, `isStation`, `isWorkstation`, `parallelSlots`, `label`. Adding a building = one registry entry; everything else (server stats, horde AI priority, station-modal eligibility, label rendering) reads from the registry.

| Building | HP | Role |
|----------|----|------|
| **Wall** | 200 | Block enemy movement; soak attacks. Hand-craftable from scrap. |
| **Door** | 9999 | Indestructible. Opened with a key (1 key consumed per locked door). Generated by procgen on dungeon floors; not player-placeable. |
| **Auto-Turret** *(pistol)* | 120 | 520-px range, 750ms cadence, single-shot. Powered. |
| **Auto-Turret** *(SMG)* | 120 | 480-px range, 130ms cadence, low damage. Crafted from a built SMG + materials. |
| **Auto-Turret** *(Shotgun)* | 140 | 320-px range, 6-pellet burst. Crafted from a built Shotgun + materials. |
| **Auto-Turret** *(Rifle)* | 120 | 720-px range, single-shot high damage, 1.1s cadence. Crafted from a built Rifle + materials. |
| **Workbench** | 150 | Crafting station — base weapons, ammo, medkit, gates Forge / Electronics Bench / Weapon Bench / Uplink. |
| **Forge** | 220 | Crafting station — heavy/alloy recipes (planned content). |
| **Electronics Bench** | 130 | Crafting station — turret variants, suit affixes. |
| **Weapon Bench** | 160 | Crafting station — weapon mods + weapon affixes; attach/detach UI; tier-up. |
| **Artifact Uplink** | 200 | Vendor only (no recipes): blueprint shop + key shop. |
| **Power Link** | 800 | Central structure that doubles as the dungeon entrance and the base's power source. Auto-spawned on world boot; rebuilt at perihelion if destroyed. See [Power System](#power-system). |

## Power System

The Power Link is the load-bearing piece of the base — both the dungeon portal and the central power source for active defences and crafting. **Fully shipped.**

**Power Link as the dungeon portal.** The static `stairs_down` interactable is replaced by a destructible Power Link building at the surface origin. The Link is a real building: it has HP and enemies can attack it.

**Depth-bound descent.** The Power Link tracks the **deepest floor any crewmate has reached on the current cycle**. Pressing E on the surface Link teleports you straight to that floor — not always floor 1. So if the crew has pushed to floor 6 and then comes back up to extract, re-entering the Link drops them at floor 6, not the entrance. Intra-dungeon stairs still work normally for floor-by-floor descent.

This means coming back up to bank loot or repair the base is cheap (the portal is a fast-travel back to the frontier), and crewmates who join mid-dive land at the same depth as the rest of the party.

**Destruction = dungeon reset.** When the Power Link is destroyed, the deepest-reached counter resets to 1 and **every dungeon scene is dropped + reseeded**. The next time anyone enters the Link, they land in a fresh floor 1 with a brand-new procgen layout. This is intentionally heavy: losing the Link mid-cycle costs the crew their entire dungeon push. Defending the Link during a horde matters because its destruction is *not* a per-perihelion reset — it can happen mid-cycle and the crew has to climb the dungeon all over again. (Cycle-end perihelion still resets the dungeon as before; this is the "intentional" reset path.)

**Powered buildings.** Auto-turrets and (later) crafting stations require power to function:
- While the Power Link is alive, all powered buildings work normally.
- When the Power Link is destroyed, **all turrets stop firing** and (post-async-crafting) all running craft jobs pause.
- The Link auto-rebuilds at full HP when perihelion ends, so the cycle reset always restores defences.

**Capacity scales with depth.** Capacity = `POWER_BASE_CAPACITY (2) + POWER_PER_DEPTH (1) × deepestFloorReached`. Each new floor pushed on the current cycle adds 1 to surface power capacity. Buildings declare a `powerDraw`: each turret = 1, each in-progress craft job = 1. Turrets get powered first in iteration order until capacity exhausts; over-capacity displays as overdraw on the HUD. Pushing deeper directly fuels a stronger surface base — dive loop and build loop wired together.

**Destruction = reset.** When the Link goes down (during a horde or otherwise), the depth-power chain resets. The crew has to push the dungeon again to rebuild capacity. This makes defending the Link the single most important objective during perihelion.

**Async crafting** is shipped: recipes carry `craftTimeMs`, station crafts queue as jobs that materialize on completion. Each station has a `parallelSlots` budget (default 1; tunable in `BUILDING_REGISTRY`). Jobs draw power for their duration. Hand-craftable basics stay instant. Output lands in the station's 8-slot output buffer; players walk up and tap **Take All** to drain.

## Perihelion & Horde

- The planet reaches perihelion every **3 in-game days**. One in-game day = 5 real minutes during the alpha (a full cycle is 15 real minutes — short enough to test the loop in one sitting; the GDD-canonical 1–2 hr/day pacing returns post-alpha).
- A world clock + countdown HUD is always visible at the top of the screen: `Cycle N • perihelion in M:SS`. The HUD turns red and pulses while a horde is active.

### Horde Mechanics (alpha-shipped)

- At perihelion, surface waves spawn at the perimeter (~700px ring) every ~15 seconds for 60 seconds total. Wave size and composition scale with cycle index.
- Enemies in the wave can **damage walls** — melee enemies in contact with a building tile chew through it at their melee DPS rate. Walls and structures take real damage; the player can repair (re-place) afterward.
- **Auto-turrets** acquire any enemy in range and fire on cooldown. Player projectiles and turret projectiles share the same ownership path.
- At horde **start**, players still inside dungeon scenes receive `link_severed` and die in place (then respawn at the surface). The dungeon is the riskier place to be at perihelion by design.
- When the horde **ends**, the cycle counter increments. Cycle reset:
  1. All dungeon scenes are dropped; procgen reseeds them next descent.
  2. Surface corpses + dropped loot are wiped (the "recover before perihelion or lose it" pressure).
  3. Per-cycle blueprints wipe; persistent blueprints stay.
  4. The Power Link is rebuilt at full HP.

### Hostile AI During Perihelion

Enemies during the horde acquire targets by priority instead of sitting still until the player walks close. **Fully shipped** via `BUILDING_TARGET_PRIORITY` in `BUILDING_REGISTRY`:

```
Power Link (100) > turret variants (50) > workstations (25) > Artifact Uplink (25) > wall (10) > player
```

Enemies greedy-pathfind toward the highest-priority target in range — no full A*; walls become natural choke points because melee enemies will path into them, get stuck, and start chewing through. After the horde ends, AI reverts to wander/idle (or only attacks players on sight). The horde is now an active **defend-the-objective** event, not a wave-survival timer.

## Lobby & Server-Creation UX

### Account & Character Model

- **Accounts** are global, managed by Supabase Auth. Account-level identity (display name, cosmetic avatar) is the same wherever the player goes.
- **Characters are per-server.** When an account joins a server for the first time, a fresh character record is created on that server with the starter kit. Each server has its own independent inventory, base, tech-tree progress, and dungeon state for that account.
- This prevents cross-server loot exploits and aligns with the server-wide tech tree: the tech tree is a property of the server world, not the account.
- **No PvP** in the alpha. All servers are co-op only.

### Flow

1. **Landing** (anonymous, on Vercel) — sign in / create account.
2. **Auth** (Supabase Auth) — email + password registration; standard email confirmation flow.
3. **Main menu** (post-auth):
   - **Browse Servers** → filterable server list.
   - **Create Server** → server config form.
   - **My Servers** → servers this account owns (manage / delete).
   - **Join by Code** → enter invite code or password to access a private server not shown in the list.
   - Account profile (display name, avatar), settings, logout.
4. **Server browser**:
   - Filters: name search, current player count, has-password yes/no, age, sort (newest, most active).
   - Public servers appear here. Private servers do not appear and must be joined via code.
   - Click a server → join handshake → drop into that server's surface base.
5. **Server creation form** (owner configures):
   - **Name** (required).
   - **Visibility:** public (listed) or private (code-only).
   - **Password** (optional for public; required or auto-generated invite code for private).
   - **Max player slots** within the supported range of 5–10.
   - **World seed** (optional advanced field) — fixes biome rotation order and procedural RNG. Lets friend groups share a known seed.
   - **World tuning:**
     - **Day length** (30–3600 seconds; default 300). Sets how fast the perihelion clock ticks.
     - **Days per perihelion** (1–7; default 3). Multiplied by day length = full cycle length.
     - **Drop bag on death** (default on). Off makes the server "softer" — full-loot extraction stays for the GDD canonical mode, but groups testing or running a more casual server can flip it. Equipped suit gear stays in either case.
   - On submit: server record created in Supabase; a game-server process is spun up (or scheduled on demand); creating account is dropped into the new world's surface base as the first character.
6. **In-server**:
   - First join on this server: per-server character record created with starter kit (Mk1 Medium chassis, basic life-support, basic plating, small Mk1 cargo grid, Mk1 pistol).
   - Subsequent joins: load existing per-server character, inventory, base.
   - Owner-only admin panel: edit name/password/max slots, kick/ban players, delete server.

### Server Lifetime

- Servers are **persistent until the owner deletes them**. World state (base, tech tree, dungeon state at last perihelion, all per-server character inventories) lives in Supabase indefinitely.
- The game-server process spins down when idle (no players connected for some grace period) to save infra cost. State is flushed to Supabase on graceful shutdown.
- Next time any player tries to join, the registry spins a process back up and restores state from Supabase before completing the handshake.

## Tech Stack

- **Client:** browser, **PixiJS** (v8) for 2D rendering, **Next.js 15 (App Router)** + **React 19** for the lobby pages and UI shell. TypeScript everywhere.
- **Auth & persistent data:** Supabase. Stores accounts, server records, per-server character records, inventories (incl. equipment), base layouts, tech-tree progress, dungeon state at last perihelion, and event logs.
- **Web hosting (client + auth/lobby APIs):** **Vercel.** Serves the static client, handles auth flows, and exposes the lobby API (server browser query, server create, join handshake → returns a signed token + the websocket URL for the game-server process hosting that server).
- **Game servers:** long-lived Node websocket processes on **Fly.io.** One process per active server world. Loads state from Supabase on boot, flushes on idle shutdown. Fly's free tier (3 small VMs + monthly credit) covers the alpha; paid scaling is linear.
- **Game-server registry:** a small service (or table in Supabase + a controller) that maps `server_id → { host, port, status }`. The lobby API queries the registry on join to find or spawn the right game-server process.
- **Wire validation:** Zod schemas in `@dumrunner/shared` validate every inbound client message at the websocket boundary. `PROTOCOL_VERSION` is checked during the auth handshake — version mismatch is rejected cleanly.
- **The websocket layer must be host-agnostic and portable;** Vercel's serverless model cannot host stateful realtime game rooms.

### Why this split

- Vercel is best-in-class for the static + serverless API workload (auth, lobby, signed-token mint).
- Fly hosts the long-lived stateful Node processes that Vercel can't.
- Supabase is the single durable store — accounts, server registry, per-server character snapshots all live there.
- No part of the stack is uniquely cloud-vendor-locked; the Node code is portable and could move to Railway / Hetzner / a self-hosted VM if Fly stops working.

## Distribution

### Primary launch surface — itch.io

**itch.io** is the public discovery / "store page" for the game. The game itself is **not** uploaded to itch — the page links out to the live URL hosted on Vercel. This is the standard pattern for browser-based multiplayer games (the actual play happens on infrastructure we control; itch is the front door).

itch.io provides for free:

- A store page with screenshots, description, devlog, tags, and reviews.
- Discovery via tags and category browse pages (e.g. `multiplayer`, `roguelike`, `top-down`, `extraction`).
- Pay-what-you-want / free / paid pricing — you set the cut to itch.
- Game jam visibility (Ludum Dare, 7DRL, etc.) for concentrated bursts of attention.

External promotion channels: Reddit (`r/WebGames`, `r/IndieGaming`, `r/roguelikes`), the indie game-dev Discord, Bluesky/Twitter game-dev tags, "Show HN" once the game is solid.

### Future distribution paths

Beyond browser-on-Vercel, three platforms are realistic targets later:

1. **Steam (desktop).** Wrap the browser client in **Electron** (well-trodden — Discord, Slack, Among Us are Electron). Steam takes 30%, $100 one-time submission fee per game. Heaviest lift but biggest audience for indie multiplayer. Realistic timing: post-beta, when the game is feature-complete enough to want broad reach.
2. **Mobile (iOS / Android).** Wrap with **Capacitor** (Ionic) — packages the existing browser client as a native shell app. Apple developer fee $99/year, Google one-time $25. The websocket layer works fine over mobile; the harder part is touch controls. Lower priority than desktop for an extraction shooter.
3. **Consoles (Switch / PS5 / Xbox).** **Not a wrapper** — these platforms don't run web apps. Porting requires either a rewrite in a console-friendly engine (Unity, Unreal) or a third-party porting service (e.g. Phoenix for Switch). Console SDKs require licensing, NDAs, and dev-kit hardware. Realistic only if the game becomes commercially significant and a publisher is interested.

### Wrapper recommendations

- **Electron** for desktop. Mature, Steam-compatible, ~150 MB binary. The browser client runs unchanged inside it.
- **Tauri** is a smaller alternative (~5 MB binary) using the OS's native webview. Worth considering if Electron's binary size becomes a complaint, with the trade-off that webview behaviour differs across Windows (Chromium) and macOS (Safari).
- **Capacitor** for mobile. Wraps the Vercel-hosted client as a native iOS/Android app. Far lighter than rewriting in React Native or native code. Works with multiplayer over wifi/cell.

For the alpha and first public beta, **stay browser-only on Vercel + itch.io.** Wrappers are a beta+ concern; they're worth the effort once organic browser traction proves the game.

## Content Pipeline & Editor Suite

As the systems land, **content creation is going to become the bottleneck** — every new biome, enemy, prop, weapon, recipe, or drop table is a TypeScript edit, a server restart, and a manual playtest. The plan is to invest in editor tooling **before** the content gets large, so adding a new enemy class or rebalancing weapon stats is a few minutes in a UI rather than a multi-file PR.

The editor suite lives at `/editor` in the client app. Each tool is its own sub-route with shared infrastructure (demo scene, repo persistence, hot-reload via the override / content fetch). Authoring writes JSON or PNG files into the repo so the dev can `git diff` what they made; nothing is dev-machine local.

### Authoring philosophy: data-driven first

**Anything currently hardcoded as a TypeScript config-style table should move to JSON content + an editor.** The principle covers:

- Base weapons (`WEAPON_STATS`, per-tier scaling, tier-mismatch curve).
- Buildings (`BUILDING_REGISTRY`, station-tier upgrades).
- Enemies (`ENEMY_VISUALS`, server-side templates, AI parameters).
- Props (`PROP_REGISTRY` once it exists).
- Biomes (palette, generation params, asset palettes).
- Crafting recipes + station / tier requirements.
- Blueprint tree (when E1 lands — DAG nodes + edges as content data).
- Drop tables — corpse loot, scatter-loot, prop-break loot, enemy drops.
- Affix / RNG tables — procedural attachment stat ranges, affix pools, weights.
- Combat globals (`COMBAT` constants — player speed, regen rates, etc).

**Migration policy.** Existing tables stay in TS until their editor lands; no big-bang JSON migration. When an editor ships, that area's data ports over and the TS module becomes a thin loader that reads + Zod-validates the JSON. Adding new entries before the editor ships is fine in TS — it's still authoring; just be aware the JSON port will need to pick those up.

**Storage + deploy.** All content is plain JSON committed to the repo under `packages/shared/content/<area>/`. The server reads it at boot. No database, no runtime mutation, no live tuning loop — for the alpha's authoring scale (one dev, occasional collaborators), the **edit → save → commit → push** cycle is fast enough and keeps every change in version control. If we ever need live tuning (ops dashboard, A/B tests), DB is a later add; the JSON shape is forward-compatible.

### Editor coverage plan

| Editor | Scope | Status |
|--------|-------|--------|
| **Texture** | PNG/WEBP per `(category, id)`. | shipped |
| **Biome** | `BiomeDef` — palette, generation params, asset palettes, hazard intensity. Preview = generated demo dungeon. | E3.0 |
| **Enemy** | `EnemyDef` — stats, AI template + params, visual, loot. Preview = AI sandbox vs dummy player. | E3.0 |
| **Decorator** (props) | `PropDef` — HP, solid flag, on-destroy behavior, loot. Preview = row of the selected prop kinds. | E3.0 |
| **Weapon** | `WeaponDef` — base stats per kind, per-tier scaling table, tier-mismatch curve. Preview = side-by-side DPS / TTK panel against a dummy. | shipped (PR 2) |
| **Building** | `BuildingDef` — HP, footprint, station + workstation flags, upgrade chains. Preview = placed cube with stats panel. | post-E3 |
| **Recipe** | `RecipeDef` — inputs, outputs, station, tier requirement, time cost. UI is an item-input/output composer. | aligns with E1 |
| **Blueprint Tree** | DAG nodes + edges + station unlock prerequisites. Pannable tree visualisation; nodes coloured by state. | shipped (E1 PR 1) |
| **Loot Tables** | Drop pools per source (corpse / prop-break / scatter / champion). Weighted entry list with rarity tiers and tier scaling. | post-E3 |
| **Affix / RNG** | Procedural attachment classes — stat ranges, weight tables, affix pools per class. Preview = roll-N-times sampler so distributions are visible. | post-E3 |
| **Combat Tuning** | The `COMBAT` constants table — player speed, sprint multiplier, stamina rates, shield regen, perihelion windows. Single-form editor; saves to one JSON. | post-E3 |

The "post-E3" tag means **no dependency on E3** — these can land in any order once their authoring is annoying enough to justify. They share the same API + schema infrastructure E3.0 builds, so each later editor is mostly a form + preview pane against an existing JSON shape.

### Architecture

- **Sub-routes** under `/editor`:
  - `/editor/textures` — what shipped (formerly just `/editor`).
  - `/editor/biomes` — planned.
  - `/editor/enemies` — planned.
  - `/editor/decorators` — planned (props).
  - Future: `/editor/weapons`, `/editor/recipes`, `/editor/blueprint-tree`, `/editor/loot`, `/editor/affixes`, `/editor/combat`.
- **Persistence model.** Two on-disk shapes:
  - **Asset files** (PNG/WEBP) live under `packages/client/public/textures/<category>/<id>.<ext>`. Served as static URLs.
  - **Content data** (biomes, enemies, props, weapons, recipes, drop tables, …) lives under `packages/shared/content/<area>/`. Two file layouts depending on the area:
    - **File-per-entity** for entity-shaped content (one file per biome / enemy / prop / weapon / building): `<area>/<id>.json`. Easy git diffs per entry; idiomatic.
    - **Single-file table** for cross-cutting tables (combat globals, affix pools, blueprint-tree edges): `<area>/index.json`. Atomic commits; smaller files.
  - Both shapes are loaded at server boot. No DB.
- **Edit flow.** `POST /api/editor/content/<area>` writes the JSON; `GET` lists. The route Zod-validates against the area's schema before touching disk so a malformed save can never make it into the repo.
- **Hot-reload story.** Texture changes are picked up live (the renderer subscribes to `textureOverrides` notifications). Content changes apply on the next dungeon regen (cycle perihelion) — restarting the dev server is fine for the iteration loop. A "regenerate now" dev button on each editor's preview pane forces a regen without waiting for a real perihelion.
- **Schema validation.** Each content area exports a TypeScript shape (`BiomeDef`, `EnemyDef`, `PropDef`, …) from shared, plus a co-located Zod schema. The editor forms are derived from those shapes; the API route runs Zod validation before writing. Bad edits never hit disk.
- **Demo scene** (already shipped for textures). Each editor mounts the iso renderer with a hand-built scene tailored to that domain — biome editor renders a generated dungeon, enemy editor spawns one of the selected enemy in front of the camera, weapon editor puts a dummy in front of the player so you can fire and read stats, etc.

### Texture Editor (shipped)

Already live at `/editor`. Side panel lists every `EnemyKind` and `BuildingKind` (via shared registries), each row shows current texture preview + Upload/Replace + Clear, demo scene mounts iso/top-down/FPS with V-cycling and WASD walking via local physics. Files write to `public/textures/<category>/<id>.<ext>` via the `/api/editor/textures` route. Renderers subscribe to override notifications and live-refresh on save.

When the suite expands, `/editor` becomes a top-nav landing page; the existing texture UI moves to `/editor/textures` unchanged. Build a `prop` category alongside `enemy` and `building` so prop sprites land in the same flow.

### Biome Editor (planned)

`/editor/biomes`. Author and tune the 4-biome lore set (Sun-Bleached / Catacombs / Frozen / Alien Core) plus any future biomes.

**Schema (`BiomeDef` in `packages/shared/content/biomes/<id>.json`):**

```ts
type BiomeDef = {
  id: string;
  label: string;
  dominantHazard: 'heat' | 'radiation' | 'cold' | 'toxic';
  // Floor / wall / accent colours used as palette fallbacks
  // when per-tile sprites haven't been authored.
  palette: { floor: string; wall: string; accent: string };
  generation: {
    roomCountMin: number;
    roomCountMax: number;
    roomSizeMin: number;       // tiles per dim
    roomSizeMax: number;
    corridorWidth: number;     // tiles
    branching: number;         // 0..1 — corridor branching probability
    propDensity: number;       // props per walkable tile
    enemyDensity: number;      // enemies per walkable tile (×depth multiplier server-side)
    lootDensity: number;       // scatter loot piles per room
    hazardIntensity: number;   // 0..1 — multiplier on the dominant hazard tick
  };
  enemyRoster: { id: string; weight: number }[];      // pulls EnemyDef ids
  propPalette: {
    id: string;
    weight: number;
    naturalOnly?: boolean;
    allowDoorway?: boolean;
  }[];                                                 // pulls PropDef ids
  lootBias: { materialId: string; multiplier: number }[]; // tilts scatter loot rolls
  tileTextures?: {
    floor?: string;            // texture-override id, e.g. 'biome::sun_bleached::floor'
    wall?: string;
  };
};
```

**UI:**

- Left sidebar: list of biome ids (CRUD — duplicate, rename, delete).
- Centre: form bound to the selected biome's `BiomeDef`, grouped by section (palette / generation / enemyRoster / propPalette / lootBias). Asset pickers (enemy id, prop id, material id) are dropdowns populated from the registries — typing creates a new entry; weight is a slider.
- Right preview pane: iso-rendered demo dungeon generated from the current params. Buttons:
  - **Generate** — runs procgen with `(seed, biomeId)` and renders.
  - **Re-roll** — bumps the seed.
  - **Stats** — room count, walkable tile count, avg corridor length, prop count, enemy count rendered live.

**Save** writes the JSON file. Server reads `packages/shared/content/biomes/*.json` at boot; the next perihelion uses the new params. Preview's "Generate" runs purely client-side (no server round-trip) so iteration is instant.

### Enemy Editor (planned)

`/editor/enemies`. Author and tune enemy classes — stats, AI behavior, visual.

**Schema (`EnemyDef` in `packages/shared/content/enemies/<id>.json`):**

```ts
type EnemyDef = {
  id: string;
  label: string;
  faction: 'catacombs' | 'sun_bleached' | 'frozen' | 'alien_core' | 'neutral';
  biomeAffinity: string[];          // biome ids this enemy can spawn in
  stats: {
    hp: number;
    contactDamage: number;
    moveSpeed: number;              // px/sec
    aggroRadius: number;            // px
    deaggroRadius: number;          // px
    bodyRadius: number;             // collision radius
  };
  ai: AiSpec;                       // see below
  visual: {
    shape: 'circle' | 'square' | 'triangle';
    color: string;                  // hex
    size: number;                   // existing EnemyVisual size
    // textureId optional — looked up via getOverride('enemy', id)
    // automatically; this field is just for documentation.
  };
  loot: {
    materialDrops?: { materialId: string; min: number; max: number; chance: number }[];
    partDropChance?: number;        // 0..1
    blueprintDropChance?: number;   // 0..1
  };
};

// Behavior templates. Each has its own typed parameter shape.
type AiSpec =
  | { kind: 'chaser_melee'; attackInterval: number; meleeRange: number }
  | {
      kind: 'ranged_pulser';
      attackInterval: number;
      preferredRange: { min: number; max: number };
      projectile: ProjectileSpec;
    }
  | { kind: 'swarmer'; aggression: number; chaseStickiness: number }
  | { kind: 'brute'; chargeWindupMs: number; chargeDamage: number; chargeRange: number }
  | {
      kind: 'sniper';
      attackInterval: number;
      sightlineRequired: true;
      retreatBelowHpRatio: number;
      projectile: ProjectileSpec;
    };

type ProjectileSpec = {
  speed: number;
  damage: number;
  ttlMs: number;
  radius: number;
  color: string;
};
```

**UI:**

- Left sidebar: list of `EnemyDef` ids with shape/color thumbnail + biome chips.
- Centre: form for the selected enemy:
  - **Identity** section (id, label, faction, biomeAffinity multi-select).
  - **Stats** section (HP, damage, speed, aggro/deaggro radii, body radius — all numeric inputs with sane min/max).
  - **AI** section: behavior template dropdown swaps the parameter form (chaser_melee shows `attackInterval` + `meleeRange`; ranged_pulser shows `attackInterval` + `preferredRange` + nested `ProjectileSpec` form; etc).
  - **Visual** section: shape / color / size + a "Upload sprite" button that hands off to the texture editor's `enemy/<id>` slot.
  - **Loot** section: material drops table, part-drop chance, blueprint-drop chance.
- Right preview pane: iso scene with one of the selected enemy in front of the camera, plus a stationary "dummy player" 200px away. Buttons:
  - **Spawn one** — adds the enemy to the demo scene; you can shoot it to verify HP / death FX.
  - **AI sandbox** — toggles a "let AI run" mode where the enemy chases / attacks the dummy player so you can see the behavior.
  - **Reset**.

Server's spawn picker reads `packages/shared/content/enemies/*.json` at boot; biome roster references resolve against this list. Existing hand-coded enemy templates (in `server/src/ai/templates.ts`) migrate into JSON files as a one-time port.

### Decorator Editor (planned)

`/editor/decorators`. Same shape as the Enemy Editor, but for `PropDef` (see [Dungeon → Props](#props-planned) for the design).

**Schema (`PropDef` in `packages/shared/content/props/<id>.json`):**

```ts
type PropDef = {
  id: string;
  label: string;
  biomeAffinity: string[];
  hp: number;
  solid: boolean;                   // blocks movement + projectiles
  onDestroy: 'nothing' | 'drop_loot' | 'explode';
  explode?: { radius: number; damage: number };
  loot?: { materialId: string; min: number; max: number; chance: number }[];
  visual: { textureId?: string; tint?: string };
};
```

**UI:**

- Same three-pane layout as Enemy Editor (sidebar / form / preview).
- Form sections: **Identity** (id, label, biomeAffinity), **Behavior** (HP, solid, onDestroy with conditional explode params), **Loot table**, **Visual** (texture upload).
- Preview: iso scene with a row of the selected prop kind. Shoot to verify HP / break FX / loot drops / explosion radius.

### Roadmap dependency

These tools are the **prerequisite** for the dungeon overhaul, not an afterthought. Without them, every new biome / enemy / prop is a multi-file edit + restart cycle, and the four-biome lore commitment becomes a labour wall. They ship as **E3.0** before any of the system work in E3.1+. See [Roadmap → E3.0](#sprint-e--ux-overhauls) for the implementation slice.

## Alpha Scope & Implementation Status

The hardest risk to get out of the way was realtime sync over websockets between authenticated players in created servers. That work shipped first; gameplay systems layered on top of proven netcode.

### Shipped

**Infrastructure**
- Account & auth (Supabase): register, login, email confirmation flow with `/auth/callback`, account profile, settings page.
- Lobby: server browser with filters, server-creation form (name, visibility, password, max slots, world seed, world tuning), join-by-id, owner-only delete.
- Game-server registry: server records in Supabase, on-demand process spin-up via Fly.io, idle shutdown + state flush, per-server character provisioning. Active-occupancy via `last_seen_at` heartbeat (30s) — capacity check counts seats live in last 60s, not historic character rows.
- Wire protocol: Zod schemas in `@dumrunner/shared` validate every inbound message; PROTOCOL_VERSION negotiation on auth handshake; HMAC-SHA256-signed JoinTokens.
- Deployment: client + lobby on Vercel, game server on Fly with `min_machines_running = 1` so the WS proxy doesn't drop sessions during quiet menu time. Tracked via `JOIN_TOKEN_SECRET` shared across both. 25s server-side WebSocket ping/pong heartbeat keeps Fly's edge proxy from idling connections; 60-min Supabase character heartbeat tracks active occupancy.
- CI: GitHub Actions runs `typecheck:{shared,server,client,asset_gen}` on every push + PR. Auto-deploys the game server to Fly on pushes that touch `packages/server`, `packages/shared`, `packages/asset_gen`, the workspace manifests, or `fly.toml` — gated on the same typechecks. Manual `workflow_dispatch` available for re-deploys without a fresh commit.

**Core gameplay**
- Server-authoritative movement with client prediction + soft reconciliation. Stamina + sprint, shield system, per-template enemy stuns. Snap-on-jump + always-lerp client smoothing fixes invisible-attacker / rubber-band desync class.
- Dungeon descent with procedural floor layouts, deterministic from `(worldSeed, cycle, floorIndex)`. Per-floor extract pad → surface. Locked-rooms procgen (key-gated doors, indestructible) with guaranteed-clear entrance→stairs path. LoS thickness fix prevents visibility leaking through diagonal-corner gaps.
- Top-down (Pixi) renderer + 2.5D first-person renderer (raycaster with grid DDA + sprite billboards). Toggle with **V**. Fog visibility cache: per-tile LoS scan only re-runs on player tile / layout / buildings change.
- 8 enemy templates (chaser_melee, shooter_drone, brute_chaser, swarmer, armored, flame_drone, chem_bloater, dummy_target) with mix-and-match movement / attack profiles, FSM, line-of-sight gating. Templates are now JSON-authored under `packages/shared/content/enemies/<id>.json` and loaded into `TEMPLATES` at boot via `initTemplates()`; the legacy `DEPTH_WEIGHTS` table is consulted only when a biome's `enemyRoster` is empty.
- Slot-based inventory (base 36 slots, hotbar 9 + bag 27), grows with cargo grid tier (Mk1 +4 ⋯ Alien +48). Drag/drop, sort, suit equipment slots.
- **Combat**: 7 ranged weapon families (pistol/SMG/shotgun/rifle/sniper/heavy/energy) + 4 melee (knife/sword/hammer/energy_blade). Per-weapon stats (damage / fire rate / projectile speed / pellet count / spread / accuracy / magazine / reload). Per-shot accuracy jitter (±~8.6° max half-cone scaled by `1 - accuracy`). Magazine + **R**-key reload. Mods + piece affixes scale stats via `computeWeaponEffect`. Status-effect imbue mods (burn / poison / slow) apply to enemies; enemy AoE cone attacks can apply the same to players. Borderlands-style adjective-stacking weapon names. Effective stats shown in inventory tooltip.
- Naked respawn (corpse retains all loot at death position; corpse persists until perihelion or pickup). Per-server `dropItemsOnDeath` toggle.
- Audio: per-event SFX (player-shoot per-family, enemy-shoot, hits, footsteps, pickups, UI click/hover, modal open, reload), music with crossfade per scene. Volume + mute persisted to localStorage. **M** toggles mute.

**Items & crafting**
- 8-material component schema (`scrap`, `wire`, `alloy`, `circuit`, `biotic`, `crystal`, `artifact`, `key`).
- Per-template enemy loot tables + dungeon scatter loot in rooms. Drop rates rebalanced so artifacts/keys/crystals are the rare prize and tier-rolled gear drops at ~5% per kill (down from 80%).
- Suit equipment with **real stat effects**: chassis +HP +build radius, plating +shield, life support +stamina +regen, utility_mod +move speed, cargo grid +inventory slots +small build radius.
- Affix system shipped — two paths under one roof:
  - **Rolled affixes** on dropped CarriedParts (5 kinds, tier-scaled, stack into the suit stats accumulator). Each has a flavored display name (Adrenal Surge, Pulsewall Aegis, etc.).
  - **Crafted attachments** via `ATTACHMENT_DEFS`: weapon mods, weapon affixes, suit affixes. 8 weapon mods + 2 weapon affixes + 2 suit affixes shipping. Each carries a Borderlands-style adjective for weapon name composition.
- 7 base weapon families (pistol/SMG/shotgun/rifle/sniper/heavy/energy) + 4 melee (knife/sword/hammer/energy_blade), all blueprint-gated. Player starts with `bp_pistol`. Tier-up (T1→T4) preserves attached pieces and mods.
- Workstation buildings (workbench, forge, electronics_bench, **weapon_bench**, **precision_mill**) + Artifact Uplink + 4 turret variants (pistol-tier baseline + per-family with weapon-as-component recipes).
- **Weapon Bench redesign (Sprint D.1).** Bench is now assembly-only: picker lists every non-melee weapon, labeled slot grid (4 piece tiles + N mod tiles), inline candidate chooser, live `WeaponStatsPanel` with green/red diff, atomic Assemble button. Tier-up moved to its own **Precision Machining Mill**.
- **Atomic `assemble_weapon` server message.** Single transaction encoding the target piece + mod configuration (instance ids). Server clones inventory + weapon, walks the diff by `AttachmentInstance.id`, validates def/family/tier compatibility, and either commits the whole transaction or rejects it — no half-applied state.
- Recipe schema with workstation + blueprintId + 5 input/output kinds. Per-station crafting modals (2-column UI, blueprint list left, requirements detail right). Async crafting with parallel slots + 8-slot output buffer + Take All. Inventory's "Field Craft" tab for hand-craftable basics.
- **Craft queue** — up to 5 jobs per station (active + queued). Materials deduct at enqueue; queued rows render greyed; oldest queued promotes when an active completes. Power-aware: jobs sit in queue while the Link is over-capacity, slip in as headroom returns.
- **Storage chests** — 16-slot bidirectional buckets, hand-craftable for 15 scrap + 4 alloy. Click-to-transfer modal (your inventory ↔ chest). Contents persist across cycles + game-server restarts via the world snapshot. Activity-bound rooms hide them in the public lobby just like the rest of the row.
- **Recipe IO dispatch helpers** in shared (`hasRecipeInput`, `consumeRecipeInput`, `recipeOutputToSlot`, `addRecipeOutputToInventory`) — single-place dispatch over material/ammo/weapon/attachment/consumable variants.
- **`BUILDING_REGISTRY`** in shared: single source of truth for HP, horde priority, parallel slots, isStation, isWorkstation, label.
- Blueprint catalog + artifact trade store (vendor-only Uplink with Blueprints + Keys tabs). Per-cycle vs persistent blueprint sets (persistent slot reserved for legendary tier).
- Procedurally-named CarriedPart drops (deterministic cyberpunk prefix + class + base noun + flavored affixes).
- Character stats panel (base + suit modifiers) + per-part hover tooltip listing each rolled affix + per-weapon hover tooltip listing effective damage / fire rate / accuracy / mag / reload / attached mods / piece affixes.
- Medkit consumable (craftable, heals 60 HP, **F**-key from hotbar or right-click → Use).

**Horde mechanic**
- Cycle clock + perihelion countdown HUD. 15 minutes per cycle in alpha (3 days × 5 min/day, configurable per-server).
- Wave spawning at the surface perimeter during perihelion. Walls take damage from melee enemies.
- **Hostile AI target-priority hierarchy** (Power Link 100 > turrets 50 > workstations 25 > wall 10 > player) — enemies during the horde prioritise the Power Link, walls become natural choke points.
- **Power Link** is shipped as the central building (HP 800, auto-spawns on world boot, rebuilds at perihelion, doubles as dungeon portal).
- **Power capacity scales with depth** (`base 2 + 1/floor reached this cycle`). Turrets and craft jobs each draw 1.
- **Async crafting** shipped with `craftTimeMs`, parallel slots, output buffers.
- 4 turret variants (pistol-baseline + per-family) with their own per-variant range / damage / cadence / pellet pattern.
- Cycle reset wipes corpses, drops dungeon scenes (regen on next descent), wipes per-cycle blueprints, rebuilds Power Link, increments cycle counter.

**Communication**
- Top-left in-game chat panel. Server-wide channel. System messages on player join / leave / death.

**Server lifecycle**
- **Owner-only pause/resume.** In-game two-click PauseServerControl (no native `confirm()` so it works inside Discord's Activity sandbox). Pausing flushes state, broadcasts `server_paused`, closes every WS with code 4090, marks `servers.is_paused = true`, evicts the World from the in-process registry so the next join hydrates fresh. Game-server tick polls `is_paused` every 5s so a lobby-side pause without the owner connected still kicks everyone.
- Pause-driven WS close redirects clients to `/servers?notice=server_paused` with an amber banner — no generic disconnect error.
- Lobby browser shows `[paused]` badge on owner-owned rows; Join button labels itself "Resume" when paused; the join route auto-flips `is_paused = false` for owners. Non-owners see a disabled "Paused" button.
- Server-creation form defaults the name to `<display_name>'s server` (both lobby `/servers/new` and Discord Activity setup form).

**Discord integration**
- "Continue with Discord" OAuth button on `/login` and `/register` (web). Server-side code exchange + synthetic-email upsert into `auth.users` and `public.accounts`, then standard Supabase session — so `/api/servers/[id]/join` and the rest of the auth-gated flow work unchanged for Discord identities.
- Discord Activity entry point at `/discord`. Boots `@discord/embedded-app-sdk` (lazy import), authorises with `identify` scope, exchanges through `/api/auth/discord/exchange`, calls `sdk.commands.authenticate`, and binds the call's `instance_id` → a server row via `/api/discord/instance`. First caller in the call provisions the room (full server-config form: name, max slots, world seed, day length, days/perihelion, drop-on-death) + display name; subsequent callers see a read-only room summary and just confirm display name. Activity-bound rooms are hidden from the public lobby.
- **Iframe survival kit:** Supabase session cookies forced to `SameSite=None; Secure; Partitioned` (CHIPS) so they survive Discord's third-party iframe context; `/` server-redirects to `/discord` when `frame_id` is present so URL Mappings can stay at `prefix=/`; game-server WebSocket routed through a second URL Mapping (`/game-ws` → fly host) so the cross-origin `wss://` upgrade isn't blocked by the Activity CSP.
- `/terms` + `/privacy` pages cover Discord app-verification requirements; both linked from the landing page footer + below each auth form.

**Asset generation pipeline (separate package)**
- `@dumrunner/asset_gen`: HTTP service that generates sprite PNGs on demand via OpenAI's image API. Stable cache-key dedup. Live game posts `/v1/assets/generate` for entities it doesn't have yet; client fetches `/v1/assets/index` at boot to build a kind→texture map. Single-call animation sheet (one image-edit call → wide canvas → trim+slice into N frames) replaces the legacy per-frame N-call pipeline.

### Roadmap

The post-alpha plan grouped by sprint. Each sprint is internally
ordered (top items unblock bottom items). Sprints run in order
unless explicitly noted.

**Naming convention.** One scheme top-to-bottom:

- **Sprint X** — top-level work block (capital letter, e.g. Sprint
  D, Sprint E, v2). Sub-passes use a dot suffix (Sprint D.1, D.2,
  D.3 — the three system passes that landed between Sprint D core
  and Sprint E).
- **X.N** — items inside a sprint (E1, E2, E3, …, E8).
- **X.N.M** — sub-slices inside an item (E3.0 through E3.4).
- **X.N.M.K** — steps inside a sub-slice (E3.4.1 through E3.4.4).

The word "phase" is now generic prose ("the next phase of work")
and does **not** carry a numeric ID. Earlier drafts used
`Phase 1` / `Phase 2` / `Phase 2.5` for the post-Sprint-D system
passes and `E3.4 Phase 1–4` for the room-template steps; both
were renamed to `Sprint D.1–D.3` and `E3.4.1–E3.4.4`
respectively.

#### ~~Sprint D.2~~ — Forge + bench tiers + tier-mismatch (shipped)

All three pieces of the system pass landed:

1. **Forge alloy production.** Three Forge recipes producing
   `alloy` (12 scrap + 4 wire), `alloy_mk3` (4 alloy + 2 circuit),
   and `alloy_mk4` (4 alloy_mk3 + 1 crystal + 1 artifact). The
   Forge buildable recipe restored at the Workbench. Tiered
   alloys feed bench-tier upgrades + (future) high-tier
   attachment recipes.
2. **Weapon Bench tier-upgrade items.** Per-building
   `benchTier: 1|2|3|4` on `BuildingState`. New
   `upgrade_workstation` server message + `handleUpgradeWorkstation`
   handler. New `UpgradeKind` inventory slot variant + Forge
   recipes (`forge_bench_upgrade_mk{2,3,4}`). The Weapon Bench
   modal shows the bench tier in the header; weapons above the
   bench tier are greyed out in the picker; Assemble disabled
   with a cap-too-low hint. Right-click an upgrade item to
   "Apply to Bench" — the renderer exposes the in-range bench
   ids + tiers so the menu finds the matching-tier bench
   automatically. PROTOCOL_VERSION 36 → 37.
3. **Tier-mismatch math.** Lives in `computeWeaponEffect`. Each
   attachment's deviation-from-neutral is scaled by
   `1 - 0.05 × |attachmentTier − weaponTier|`, capped at 0.80.
   Mk3 attachment on T1 weapon → 90% effectiveness; Alien on
   T1 → 80%. Same direction either way. Suit-side mismatch
   lands with Sprint D.3's Suit Assembly Bench.

#### ~~Sprint D.3~~ — Suit Assembly Bench (shipped)

Mirror of the Weapon Bench redesign (Sprint D.1) for suit parts.
Closes the orphaned `aff_shield_25` / `aff_speed_5` blueprints —
they craft into instances that the Suit Assembly Bench can now
attach to equipped suit parts.

- New building kind `suit_bench` (HP 160, station, not workstation).
  Hand-craftable at the Workbench (25 scrap + 8 alloy + 4 wire).
- Per-part attachment slot cap: `SUIT_ATTACHMENT_SLOTS[PartTier]`
  → Mk1=1, Mk2=2, Mk3=3, Mk4=4, Alien=4.
- New atomic server message `assemble_suit_part { suitSlot,
  attachments: instanceId[] }` + `handleAssembleSuitPart`. Same
  diff-and-commit pattern as `assemble_weapon` — clone equipment +
  inventory, walk diff by `AttachmentInstance.id`, validate def
  kind / `slotKind` matches the target slot, recompute suit stats
  via `recomputePlayerStats` on commit (so HP/shield/stamina/speed
  caps update + broadcasts go out).
- New `SuitAssemblyPanel` mirror of `WeaponAssemblyPanel`: picker
  over equipped suit parts (with tier badge), labeled slot grid
  sized by part tier, inline chooser of compatible instances from
  inventory + the part's currently-attached pool, live
  `SuitStatsPanel` showing current → staged diff.
- Suit-side tier-mismatch via `suitTierMismatchScale` (mirror of
  weapon-side curve, both directions, capped at 0.80) — the
  `appliedAttachments` fold in `computeSuitStats` scales each
  attachment's effect by `(attachment.tier vs part.tier)`.
- `bp_aff_shield_25` / `bp_aff_speed_5` restored in
  `BLUEPRINT_CATALOG`. PROTOCOL_VERSION 37 → 38.

#### Sprint E — UX overhauls

E1 / E2 are independent; each ships on its own timeline. **E3 is
the biggest single piece on the board** and is now sliced into
five steps (E3.0 → E3.4) that ship sequentially — each one
playable, each one unblocking the next. The slicing puts
**editor tooling first** so we don't author the four-biome lore
commitment by hand-editing TypeScript.

**E1. Blueprint progression tree.** Replace the flat
`BLUEPRINT_CATALOG` listing with a DAG: unlocking the Workbench
exposes Tier-1 nodes; crafting a "Forge Uplink" upgrade exposes
Tier-2 nodes under the Forge; etc. Recipes gain a `stationTier`
requirement. UI: pannable tree visualisation, Path-of-Exile-
style passive-tree feel, nodes coloured by state (locked /
unlockable / unlocked). Workstation-tier upgrades from Sprint D.2
plug into this naturally.

**Status.** The data layer and DAG were already shipped before
E1 was formally named (see Blueprint System review in commits).
E1's PR 1 (2026-05-11) **completed the migration of
`BLUEPRINT_CATALOG` to JSON content** under
`packages/shared/content/blueprints/<id>.json` and shipped an
authoring UI at `/editor/blueprints`: sidebar list, form
(identity / economy / unlocks / prerequisites), inline cycle
detection, dependents panel, draft-aware DAG preview pane. The
generic `/api/editor/content/blueprints` API runs cross-area
validation (recipeId exists in RECIPES, prereqs resolve, DAG
acyclic) before writing to disk. Server boot loads via
`initBlueprints()`; the existing content watcher hot-reloads on
save without a restart. Connected clients pick up authored
changes on next welcome.

Still open under E1: workstation-tier upgrade items for non-
Weapon-Bench stations (so high `stationTier` recipes at the
Forge / Electronics / etc. become reachable), and the persistent-
blueprints write path (legendary tier surviving perihelion). Plan
doc at `docs/blueprint-editor-plan.md`.

**E2. Mobile controls.** Detected via `matchMedia('(hover: none)
and (pointer: coarse)')` at mount. `MobileControls` overlay:
virtual stick bottom-left (feeds the existing `input` ws
message), virtual fire button bottom-right, button row for
reload / use / interact, hamburger for inventory. FPS view
needs a touch-look gesture (right-half drag for aim + auto-fire
on tap) — trickier; can ship with top-down only at first.

**~~E3.0~~. Editor suite (shipped).** Prerequisite for everything else in E3.
Full design under [Content Pipeline & Editor Suite](#content-pipeline--editor-suite). Slice:

- Top-nav landing at `/editor`. Existing texture editor moves
  under `/editor/textures` unchanged.
- **Schemas first.** `BiomeDef`, `EnemyDef`, `PropDef` in
  `packages/shared/content/types.ts`, with Zod validators.
  Migrate the existing hand-coded `ENEMY_VISUALS` + planned
  `PROP_REGISTRY` data into JSON files under
  `packages/shared/content/<area>/`.
- **API routes.** `POST /api/editor/content/<area>` (write JSON,
  Zod-validated), `GET /api/editor/content/<area>` (list).
  Mirrors the texture API pattern.
- `/editor/biomes`. Sidebar list + form (palette, generation
  params, asset palettes) + preview pane that runs procgen
  client-side and renders in the iso renderer.
- `/editor/enemies`. Sidebar list + form (identity, stats, AI
  template + per-template params, visual, loot) + preview pane
  with Spawn / AI-sandbox buttons.
- `/editor/decorators`. Same shape as enemies but for `PropDef`.
- **Server boot reads JSON content** for biomes / enemies /
  props (alongside the existing TypeScript-source registries
  during the migration). New "regenerate dungeon now" dev
  control on each editor's preview reaches into the running
  game session via a dev-only WS message — no real perihelion
  needed for iteration.

**~~E3.1~~. Biome scaffolding + per-band assignment + enemy rosters (shipped).**
Foundation. Lands once the editor suite from E3.0 can author the data.

`packages/server/src/biomes.ts` carries `pickBandBiome()` (deterministic
per `(worldSeed, cycle, bandIndex)` with optional `world.json`
overrides). Procgen reads `BiomeDef.enemyRoster` per floor and the
FPS renderer reads `layout.biome` for floor / ceiling / skybox
overrides. Surface UI for the upcoming-band layout has **not**
shipped yet — the dungeon picks bands deterministically but
players currently learn the layout by diving.

- `Biome` enum + `BiomeDef` JSON content (4 biomes: Sun-Bleached
  / Catacombs / Frozen / Alien Core), authored in the biome
  editor.
- Per-band assignment at perihelion (each band rolls a biome
  independently per the GDD's biome rotation rule). `layout.biome`
  field on `SceneLayout`. Surface UI shows the cycle's biome
  layout for known bands.
- Existing enemies migrate to `EnemyDef` JSON with `biomeAffinity`
  set; spawn picker pulls from `BiomeDef.enemyRoster` weighted
  list.
- **No procgen change** — existing rectangular rooms keep
  working but now know what biome they are, with per-biome
  floor / wall colour palettes from `BiomeDef.palette`.

**~~E3.2~~. Props system (shipped).** Self-contained, slots into biome
palettes from E3.1. Full design under
[Dungeon → Props](#props-planned).

`packages/server/src/props.ts` + `generateInitialProps` in
`procgen.ts` spawn props from `BiomeDef.propPalette`;
`prop_damaged` / `prop_changed` broadcasts in `scene.ts` carry
HP + container state. Container variants (lootable crates,
cargo containers) are wired. Renderer billboard support landed
in FPS; iso/topdown integration is partial — track in the
[Cleanup & Bug List](#cleanup--bug-list) if it bites.

- Server-side prop entities with HP + destruction handling.
  `PROP_REGISTRY` migrates to `PropDef` JSON; biome palettes
  reference prop ids.
- Three-renderer billboard pass (no HP bar, hit-flash on
  damage). Editor's `prop` category mirrors `enemy` / `building`
  so art iteration uses the same texture upload flow.
- Spawning hooks into the existing rectangular procgen via
  `BiomeDef.propPalette`; biome-flavoured scenery (trees, rocks,
  conduits, terminals) plus the explosive-barrel and
  lootable-cargo specials.

**~~E3.3~~. Hazard system (shipped).** Independent of WFC. Lands on existing
rectangular rooms with the biome data from E3.1.

Shared `packages/shared/src/hazards.ts` exports the pure DPS
math; `Scene.tickHazards` accumulates a 1Hz tick driven by
biome's dominant hazard, depth-scaled DPS, and the player's
life-support specialty resist (folded through `computeSuitStats`
on hydrate / equipment change). Comment at the tick site
("snap instead of carry remainder so a long pause doesn't fire
a burst of catch-up ticks") earns its keep.

- Resist fields on life-support `CarriedPart` (heat / cold /
  radiation / toxic).
- Per-floor hazard spec derived from `BiomeDef.dominantHazard` +
  `hazardIntensity` + depth scaling.
- Server tick applies environmental damage scaled by the
  resist gap. Folds the "depth gating via life-support tier"
  loop the GDD describes.

**E3.4. Room templates + multi-texture biomes.** The dungeon
overhaul. Authoring-first, not algorithmic — modeled on what
shipping roguelikes (Spelunky, Dead Cells, Hades, Diablo,
Returnal) actually do, not on the academic WFC track that the
original E3.4 framing took. Full implementation plan at
`docs/e3.4-implementation-plan.md`.

- **E3.4.1 (shipped).** Per-cell `TileGrid` on `SceneLayout`,
  base64-encoded over the wire. `TileDef` + `BiomeDef.tileSet`
  schemas. FPS + iso renderers do per-cell tile lookup, paint
  dungeon walls from `('biome_wall', biomeId)` overrides. Biome
  editor exposes wall texture upload alongside floor / ceiling /
  skybox.
- **E3.4.2. Multi-texture biomes (schema in).** `TileDef.textureIds`
  is an array on the schema (`packages/shared/src/content/types.ts`);
  per-cell stable hash picks one variant. Authoring path for N
  wall / floor textures per biome works through the biome editor.
  Renderer-side variant pick is partial — confirm in
  `packages/client/lib/game/fps.ts` / `iso.ts` before declaring
  shipped.
- **E3.4.3. Room template engine (scaffolded — partial).** Each biome
  owns a pool of hand-authored room templates (JSON: tile grid +
  anchors for enemy / prop / loot / extract / stairs / door spawn
  points). `packages/server/src/rooms.ts` + `corridors.ts` load
  `RoomTemplate` / `CorridorTemplate` from
  `packages/shared/content/{rooms,corridors}/<id>.json`; procgen
  calls `stampRoomTemplates()` from `procgen.ts`. Existing rect
  generator stays as a fallback for biomes with empty pools, so
  each biome migrates independently. Status: 4 room templates
  authored (one biome-specific `frozen_pillared`, three editor-
  output ids); no corridor templates yet; per-biome role
  coverage (boss / vault / extreme) not started.
- **E3.4.4. Room editor.** Browser-based template authoring —
  paint the tile grid, drop anchors, save to JSON via the same
  content-API pattern as biomes / enemies / props.

WFC was rejected. Survey of shipped roguelikes turned up
essentially zero AAA / well-funded indie titles using textbook
WFC for level generation; the dominant pattern is hand-authored
rooms + procedural placement. Templates trade adjacency-table
authoring for room-layout authoring, and the room layouts double
as combat scenes with intentional sightlines + cover.

**E4. Buildable variety.** Today's buildable set is walls +
turrets + workstations + Power Link + chests. Expand:

- **Doors** as a player-placed buildable. Single-cell door entity
  with open/close state, hostile-AI pathing aware. Hand-craftable
  at the Workbench. Cheaper than a wall and lets players gate
  rooms during the horde without sealing themselves in.
- **Wall tiers.** Today's wall is a single HP / cost. Add tiered
  walls (Mk2 / Mk3) via Forge upgrade items, mirroring the
  bench-tier system. Tiered walls have proportionally more HP
  and slightly higher horde priority.
- **Decoration buildables.** Light fixtures, banners, signs,
  rugs — purely cosmetic, hand-craftable cheap, give players a
  way to personalise their base. Not horde-prioritised.

**E5. Container & lootable props.** Add openable containers as a
prop subclass — barrels (already explosive), crates, lockers,
terminals — that hold a loot table and require an interaction
(E to open) rather than auto-pickup. Crates roll the same scatter
loot table the rooms use today; lockers in dungeons can hold
guaranteed-tier gear; terminals can drop blueprints. Containers
don't damage on melee (they're interacted with, not destroyed)
unlike today's destructible barrels.

**E6. Enemy corpse persistence.** When an enemy dies, leave a
visible corpse billboard at the death position. Persists for the
floor's lifetime (until perihelion / re-descent). Pure visual —
no loot, no collision, no LOS block — but reads as combat
history. Player corpses already work this way.

**E7. Hand-authored "tier" rooms.** Layered on top of the room
template engine (E3.4.3). Each biome ships hand-crafted
"tier" templates that only roll on deeper floors — increasingly
complex layouts, denser hostile placements, and harder hazard
zones. The procgen role-pool already supports `boss` / `vault` /
`extreme`; this is the content track that fills them. Future:
AI-generated room layouts feeding the same template format,
authored at runtime per-cycle so players don't memorise.

**E8. Editor sprite catalogue + procedural weapon visuals.**

- Add per-class texture rows in the editor for player / weapon /
  consumable / building sprites. Missing today; only enemies and
  props have a TextureRow path.
- **Base + overlay sprite composition for weapons + carried
  parts.** Each weapon's visual = a base sprite (frame) + N
  overlay sprites (barrel / grip / magazine / stock) keyed by
  the attached `AttachmentInstance` ids. Same trick for procedural
  carried-part drops — base armour sprite + overlays for affix
  type. Lets the asset_gen pipeline generate components rather
  than `O(weapons × mod combos)` complete sprites. The composition
  logic lives client-side; the catalogue lives in the texture
  editor.

#### Deferred past alpha

These are reserved-place-in-the-design items, not actively
scheduled. Listed so the next agent doesn't re-discover them.

- **Full weapon part-assembly drops.** The part ontology in
  [Items & Procedural Generation](#items--procedural-generation)
  describes `Frame / Barrel / Grip / Magazine` as *dropped
  parts*, not just attachment slots. Today's loop is mod / affix
  attachments + tier-up; the part-driven assembly is the long-
  term direction once procedural attachments + suit assembly
  land.
- **Faction champions / boss enemies** + the
  artifact-as-Alien-tier-part path.
- **Earth tech-tree unlocks.** Currently the Artifact Uplink
  only trades blueprints. The "Ship to Earth" + "Burn as
  ingredient" fates land later.
- **Cargo grid (Tetris-style) inventory model.** Today's slot
  inventory grows linearly with cargo tier; the actual W×H grid
  lands later.
- **Wall repair.** Right-click "Repair" consuming a fraction of
  the recipe cost. Quality-of-life; not blocking.
- **Loot drop TTL polish.** Current 90s expiry is short for
  tactical pacing. Consider 180s or scaling by floor depth.
- **Manual loot pickup** (E to grab) replacing auto-walk-into-it.
  Better fit for the deliberate tactical-extraction tone.
- **Heavy-class bullet variants.** The Heavy Slug Cannon currently
  fires a generic round (just chunkier radius / orange tint). Add
  per-projectile visual variants (slug, HE, incendiary tracer) +
  optionally per-variant on-impact behaviour (small AoE, knockback,
  proximity burst). Either tied to ammo subtypes (`heavy_slugs_he`,
  `heavy_slugs_incendiary`) or a weapon-mod that swaps the
  projectile shape. Lands when heavy weapons get more than the
  single-shape sample.
- **Demolish confirm** for high-value buildings (workstations,
  Power Link).
- **"Abandon corpse"** option for stuck players (sprints A2 v2
  deferred polish).
- **Melee customization.** Pieces / mods / tier-up apply to
  ranged only today. If melee is meant to be "a real combat
  verb," eventually it needs its own piece system or shared
  mod compatibility.
- **Pixel-art textures** — comprehensive coverage of all
  entities + animations is its own roadmap (the asset_gen
  pipeline + runtime is shipped; the catalog is incremental).
- **Mobile (Capacitor) + desktop (Electron) wrappers.**

#### Pending external work

- ~~**Discord Developer Portal config + first end-to-end test.**~~
  *Done.* Web OAuth + Activity SDK + instance-bound rooms shipped
  and validated end-to-end. See `docs/discord-integration.md` for
  the historical setup notes.
- **Add prewarm labels** for D3 enemies (`flame_drone`,
  `chem_bloater`) and `precision_mill` in
  `assetGenClient.ENEMY_LABELS`. Falls back to auto-generated
  labels today — works, but produces less-specific prompts.

#### v2 — engine refresh

Reserved for a clean break after the current alpha closes. The
tile-grid engine carries us through the alpha scope, but a few
visual + design goals can't land cheaply on top of it. v2 plans
a deliberate replacement (likely Three.js / WebGPU or a
sector-based renderer in the same vein as Doom / Build engines)
so the items below can ship together rather than each fighting
the tile substrate.

- **Vector / sector-based geometry.** Non-orthogonal walls,
  arbitrary room shapes, polygon-based collision. Tile grids
  guarantee right angles; some setpiece rooms (cathedrals,
  alien geometry, naturally-curved caves) need angles.
- **Multi-height floors + ceilings.** Pits, raised platforms,
  stairs as actual height transitions, low ceilings, varying
  ceiling heights for atmosphere. Tile-z-offset hacks could fake
  *fixed* deltas on top of the current engine, but real
  per-sector heights need a sector model to be readable + cheap.
- **Lighting.** Coloured point lights, directional ambient, LOS
  shadowing. Today's renderers have a flat ambient with fog-fade.
  Easier to retrofit on a 3D engine than add to the raycaster.
- **Iso renderer no longer in scope** — dropped during the alpha
  close. v2 ships first-person + topdown only.

### Architectural notes for the next agent

- **Sprints A through D.3 all shipped.** The previous
  `docs/sprints.md` plan is now mostly cleared. The Roadmap
  above supersedes it.
- **Sprint C (procedural attachments) is the keystone:** every
  dropped / crafted attachment is a unique `AttachmentInstance`
  with rolled stats inside a class. Per-class roll ranges live
  in `ATTACHMENT_STAT_RANGES` in `shared/inventory.ts`. Bare
  `defId` references to attachments are gone — all consumers
  pass the instance.
- **Migration runs on character hydrate**
  (`server/src/index.ts:migrateLegacyAttachmentSlots`) for
  legacy `defId/count` slots and bare-id weapon pieces / mods.
  If you change attachment shapes again, update the migration.
  Pre-Sprint-D.2 cleanup included a fix for an over-expansion bug
  there.
- **`PROTOCOL_VERSION` is 43** (bumped repeatedly through
  Sprint D.2 → D.3 → E3 wire shape changes; current value lives in
  `packages/shared/src/protocol.ts`). Bump on any wire-shape
  change.
- **`BUILDING_REGISTRY`** is the single source of truth for HP,
  horde priority, parallel slots, station / workstation flags,
  and label. Every per-kind lookup goes through it.
- **`WeaponAssemblyPanel` + atomic `assemble_weapon`** are the
  template for the Sprint D.3 Suit Assembly Bench. Mirror the
  pattern; the diff-and-commit logic generalises cleanly.
- **Playtest mode** (`is_playtest` boolean on servers, migration
  `0010_servers_playtest.sql`) — every join rebuilds inventory
  + equipment from `buildPlaytest{Inventory,Equipment}()`.
  Treat it as a sandbox; persistence within a single session
  only.
- **Auto-deploy:** GitHub Actions `fly-deploy.yml` runs on
  pushes that touch `packages/server`, `packages/shared`,
  `packages/asset_gen`, workspace manifests, or `fly.toml`.
  Vercel handles client deploys automatically.

## Codebase Review Notes (2026-05-06)

Findings from a deep pass on auth, persistence, RLS, and protocol
boundaries. Each item was verified against the actual code at the
cited path. Ordered by severity.

### Security / correctness

1. **Unvalidated cast of persisted character JSON (low-risk —
   RLS-protected).** `packages/server/src/index.ts:493-495,500`
   casts `obj.slots as Inventory` and `obj.equipment as Equipment`
   from `characters.inventory` JSONB straight onto the live
   player without a Zod parse. Only safe because migration
   `0001_initial.sql:87-90` declares no insert/update RLS policy
   on `characters` — clients can't write the column; only the
   service-role-bypassed game server can. If a future migration
   ever adds `characters_update_own`, this becomes a trivial
   path to forged inventory state. Gate with a Zod parse anyway.

2. **CSRF state uses `Math.random()`.**
   `packages/client/lib/discord/auth.ts:180-185` —
   `makeOauthState()` builds OAuth state from `Date.now() +
   Math.random() + process.pid`, hashed and truncated. Not
   cryptographically random. Replace with
   `crypto.randomBytes(16).toString('hex')`. One-line fix.

3. **Discord lookup paginates only the first 200 users.**
   `packages/client/lib/discord/auth.ts:144-149` —
   `listUsers({ perPage: 200 })` then filters by email. Once
   the user count grows past 200, anyone whose row falls off
   page 1 can't sign in via the recovery branch. Capture the
   id elsewhere or paginate.

4. **Single secret reused for two auth flows.**
   `JOIN_TOKEN_SECRET` is the HMAC key for join tokens
   (`shared/src/token.ts:41`) AND the password seed for every
   Discord user (`discord/auth.ts:33-40`). Rotating it
   silently invalidates every Discord user's password (the
   provision path self-heals on next sign-in, so it's only a
   smell, not a break). Add `DISCORD_USER_SECRET` if/when
   independent rotation matters.

5. **No WebSocket-level rate limit.** `index.ts:175-299` —
   only `handleChat` (`world.ts:2521`, ~1.6 msg/s) is rate
   limited. `fire`, `build_request`, `craft_request`,
   `inventory_swap` rely on per-handler gating. A malicious
   client can saturate the 256 MB Fly machine with valid
   `inventory_swap` calls. Add a token bucket per connection
   in `index.ts` before dispatch.

6. **Tile coordinates unbounded in protocol.**
   `shared/src/protocol.ts:390-391` — `tileX/tileY:
   z.number().int()` with no min/max. Build-handler safety
   relies on player-distance check at `scene.ts:652-659`:
   huge values overflow `(tileX + 0.5) * tileSize` to
   Infinity, distance fails, early return. Works, but it's
   load-bearing IEEE-754 behavior. Add `.min(-100000).max(100000)`
   for defense in depth. Same applies to dir/move vectors
   (currently `finiteNumber` only — finite but unbounded magnitude).

### Correctness / maintainability

7. **Persistence table is `world_states`, snapshot constant
   says `WORLD_SNAPSHOT_SCHEMA`.** Actual table is
   `world_states` (`world.ts:354,439`; migration `0001:54`).
   Constant at `world.ts:136` says `WORLD_SNAPSHOT_SCHEMA`.
   Both code reviews and the explore agent mis-named the
   table. Rename the constant to `WORLD_STATE_SCHEMA` to stop
   the drift.

8. **`heartbeatTimer` shadows itself.**
   `packages/server/src/index.ts:131` is the WS-ping sweep
   timer; line 158 is an inner-scope `touchLastSeen` timer
   with the same name. Different jobs, same identifier.
   Rename the inner to `lastSeenTimer`.

9. **Legacy attachment migration drops overflow silently.**
   `index.ts:435-446` — `migrateLegacyAttachmentSlots` queues
   overflow attachments and only places them into empty
   slots; `if (!placed) break;` quietly discards the rest.
   Pre-Sprint-C saves only, so blast radius is small. At
   minimum log the discard count so you'd notice if it ever
   fires unexpectedly.

10. **Per-character DB write every 30s.** `index.ts:276-279` —
    each connected character writes `last_seen_at` on a
    30s interval. Trivial at the 5–10 player cap; if the cap
    rises, batch into a single `update ... in (...)` per world
    tick.

### What looks right (worth calling out)

- **Join token verification** (`shared/src/token.ts:53-78`):
  version prefix, length-checked digest, `timingSafeEqual`,
  `exp` check. Correct.
- **Pre-auth gate** (`index.ts:167-173,195-215`): 5s auth
  timeout, drops non-`auth` first message, validates
  `protocolVersion`, returns specific 4001-4005 close codes.
- **Hazard tick** (`scene.ts:984-1025`): biome lookup +
  depth-scaled DPS + suit resist + accumulator-snap on long
  pauses. Comment at 988-991 ("snap instead of carry
  remainder so a long pause doesn't fire a burst of catch-up
  ticks") earns its keep.
- **RLS deny-by-default for `world_states`** (migration
  `0001:92-93`): no client policies created.
- **Heartbeat WS pattern** (`index.ts:131-146`): standard
  `isAlive` flip-on-pong, terminate stale, clear timer on
  `wss.close`.

### Highest-leverage next moves

1. Wrap `parseInventoryJson` with a Zod parse against the
   inventory + equipment schemas. Pre-empts #1 if RLS ever
   loosens.
2. Replace `Math.random()` in `makeOauthState`. One-line crypto fix.
3. Add bounds to `tileX/tileY` + dir/move magnitudes in
   `protocol.ts`.
4. Per-connection token bucket in `index.ts` before dispatch.
5. Rename `WORLD_SNAPSHOT_SCHEMA` → `WORLD_STATE_SCHEMA`.

## Cleanup & Bug List

Running list of small bugs, polish gaps, and audit-driven cleanup
items. Lighter than a Roadmap entry — each line is a discrete fix
rather than a design slice. Strike items through (`~~text~~`) once
the fix lands; remove them on the next prune. New items added at
the bottom; date-stamp the source if known so future audits can
tell which review surfaced them.

### Open

**Auth / security (from `Codebase Review Notes (2026-05-06)`):**

- **Replace `Math.random()` in `makeOauthState`**
  (`packages/client/lib/discord/auth.ts:182`). CSRF state is
  derived from `Date.now() + Math.random() + process.pid`, hashed
  and truncated. Swap to `crypto.randomBytes(16).toString('hex')`.
  One-line fix.
- **Wrap `parseInventoryJson` with a Zod parse**
  (`packages/server/src/index.ts:582,584,591`). `obj.slots as
  Inventory` / `obj.equipment as Equipment` casts skip validation.
  Safe today only because no client-write RLS policy exists on
  `characters`; pre-empts the failure mode if RLS ever loosens.
- **Discord lookup paginates only the first 200 users**
  (`packages/client/lib/discord/auth.ts:144-149`). Capture the
  user id elsewhere or paginate.
- **No WebSocket-level rate limit before dispatch**
  (`packages/server/src/index.ts:175-299`). Only `handleChat`
  is rate-limited. Add a per-connection token bucket so a
  malicious client can't saturate the Fly machine via valid
  `inventory_swap` / `fire` / `build_request` calls.
- **Tile coords + dir/move magnitudes unbounded in protocol**
  (`packages/shared/src/protocol.ts:390-391`). `tileX/tileY:
  z.number().int()` with no min/max; relies on IEEE-754
  overflow-then-distance-check at `scene.ts:652-659`. Add
  `.min(-100000).max(100000)` and equivalent magnitude bounds
  on dir/move.
- **`JOIN_TOKEN_SECRET` reused for two flows.** HMAC key for
  join tokens *and* password seed for every Discord user. Add
  `DISCORD_USER_SECRET` if/when independent rotation matters.

**Correctness / maintainability (from `Codebase Review Notes (2026-05-06)`):**

- **`heartbeatTimer` shadows itself**
  (`packages/server/src/index.ts:131,158`). WS-ping sweep timer
  and inner-scope `touchLastSeen` timer share the identifier.
  Rename the inner to `lastSeenTimer`.
- **Rename `WORLD_SNAPSHOT_SCHEMA` → `WORLD_STATE_SCHEMA`**
  (`packages/server/src/world.ts:136`). Actual table is
  `world_states`; constant name is misleading.
- **`migrateLegacyAttachmentSlots` discards overflow silently**
  (`packages/server/src/index.ts:435-446`). Pre-Sprint-C saves
  only. Log the discard count so it's observable if it ever
  fires unexpectedly.
- **Per-character DB write every 30s**
  (`packages/server/src/index.ts:276-279`). Trivial at the
  5–10 player cap; batch into one
  `update ... in (...)` per world tick if the cap rises.

### Done — pending prune

(Items here are verified shipped; remove on the next pass once
they've stuck for a cycle or two.)

- ~~All pre-Sprint-E cleanup items (sniper/heavy/energy crafting
  → Workbench, hand-craftable knife, horde audio stinger,
  scoped `title=` fallback, `migrateLegacyAttachmentSlots`
  length cap, Forge buildable status, drop equipped gear into
  corpse, pause perihelion when empty, perihelion warning text
  overlap, hide undamaged HP bars, friendly-fire on owned
  structures, FPS bullets at chest height, respawn position
  drift, melee enemy standoff, turrets as billboard sprites)~~ —
  verified 2026-05-10.
- ~~Corpse-pickup data loss for `attachment` / `consumable`
  kinds.~~ Verified fixed 2026-05-10 (`scene.ts:1350,1353`).
- ~~Hide orphan suit-affix blueprints.~~ Made moot by Sprint D.3
  (Suit Assembly Bench).
