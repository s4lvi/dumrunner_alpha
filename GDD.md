# DÛM RUNNER — Game Design Document

## Concept

DÛM RUNNER is a browser-based multiplayer tactical extraction shooter with roguelike dungeon-diving and persistent base-building. Runners scavenge alien ruins on a hostile planet, reverse-engineer the technology, and ship artifacts back to Earth in exchange for manufacturing tech. Every three in-game days the planet reaches perihelion, monsters frenzy, and the surface base must survive a horde assault.

**Design pillars.** DÛM RUNNER is a mash-up of three lineages wearing a retro Doom-style veneer:

- **7 Days to Die** — a persistent surface base that must survive a periodic horde, where the base's infrastructure *is* your accumulated progress.
- **Borderlands** — loot-first itemization: the chase is the drop. Excitement comes out of enemies, not out of menus.
- **Classic roguelikes** — procedurally generated dungeon floors, depth-banded difficulty, dives shaped like runs. The roguelike contribution is the procgen descent itself, not trap/identification minigames.

The renderer is the veneer: a Doom-lineage 2.5D sector engine. [The Economy Law](#the-economy-law) is the contract that lets the first two pillars coexist instead of competing.

## Setting

Post-apocalyptic cyberpunk future. The colony sits on the surface of a hostile alien world strewn with the ruins of an ancient advanced civilization. Earth funds the expedition in exchange for recovered alien tech.

## Core Loop

1. **Dive** — descend into the persistent Dungeon of Dûm via the surface **Power Link** structure to scavenge parts, artifacts, components, and materials. Each floor descended raises the base's power capacity.
2. **Extract** — reach a per-floor extract teleporter to bank loot at the surface base.
3. **Build & craft** — assemble weapons and suit mods from parts; expand the base with grid-placed walls, turrets, crafting stations, and the artifact uplink. Crafting consumes time + power, not just materials.
4. **Trade for blueprints** — spend artifacts at the uplink to permanently unlock new craftable items.
5. **Defend** — every third in-game day at perihelion, the surface is attacked by a horde that prioritises destroying the Power Link and player defences. Survive together.
6. **Reset & repeat** — perihelion regenerates the dungeon, restores the Power Link, and resets the depth-power chain; players return to fresh shallow floors and push the frontier again.

## The Economy Law

One rule governs the whole item economy:

> **The dungeon produces all inputs. The base converts inputs into capability. Nothing at the base creates inputs.**

- **Components** — weapon pieces, suit parts, attachments, building cores, materials — enter the world exclusively as dungeon drops: enemies, containers, scatter piles, champions.
- **The base assembles.** Workstations combine components into products — weapons, suits, turrets, stations, consumables. No station ever manufactures a component; the Forge runs the only reverse path (salvaging components back into materials) plus affix rerolling.
- **Three keys, one lock.** Using a component takes all three progression axes, and each axis is fed by a different activity:

| Axis | Source | Activity it pulls |
|------|--------|-------------------|
| **Components** | dungeon drops only | dive, kill, extract |
| **Schematics** (blueprints) | Artifact Uplink — permanent | artifact economy, depth push |
| **Capability** (benches) | assembled at base; tiered, destructible | base building + horde defense |

A god-roll Mk3 barrel found on floor 2 is exciting immediately — but it needs a Mk3 weapon bench to slot, and the bench tier-up needs components that only drop in band 2+. The drop pulls you deeper; the depth feeds the bench; the bench unlocks the drop. Benches are accumulated capability built from loot, and the horde targets them — defending the base is defending your ability to use what you found.

**Schematics are permanent.** Blueprints gate *product* assemblies — buildings, turrets, consumable kits, exotic combinations — never basic weapon piece-assembly. Slotting pieces into a frame is always free; knowing how to assemble a rifle turret is knowledge you buy once with artifacts and keep forever.

**Drop philosophy.** Every kill drops something. Components are the common drop class; rarity is expressed through tier and affix count, not through drought. Band champions are component jackpots.

## Perspective & Controls

The game is a **2.5D first-person shooter** rendered through the
Pixi v8 sector engine (`packages/client/lib/game/fps.v2/`).
Wolfenstein/Doom-style camera over polygon sector geometry — not a
raycaster: walls are real quads in world space, floors and
ceilings are triangulated polygons with per-fragment fog and
lighting. WASD is yaw-relative (forward / strafe), pointer-lock
mouse-look (yaw + pitch), click to fire. Build mode uses a floor-
reticle ray pick to target the tile under the camera.

The React HUD chrome (status bars, hotbar, controls hint,
crosshair) and the texture-override / asset pipeline are owned by
the same renderer. Target platform is desktop browser first; touch
+ mobile come later via Capacitor.

> **Renderer history.** Earlier alpha builds shipped an isometric
> Pixi view (`pixi.ts`), a tile-grid raycaster FPS (`fps.ts`), and
> an overhead `topdown.ts`, toggled with **V**. All three were
> deleted with the v2 engine push. There is one renderer now; the
> **V** key is no longer bound.

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

Mods + piece-affix attachments scale these stats per weapon instance via `computeWeaponEffect` (damage / fire-interval / spread / projectile-speed multipliers stack from every attached piece + mod). The full part-driven assembly described in [Items & Procedural Generation](#items--procedural-generation) is the economy's spine under [The Economy Law](#the-economy-law); today's shipped mods + affixes are its foundation, and the components-first migration is tracked in `ROADMAP.md`.

## Multiplayer

- **Server size:** 5–10 players per server.
- **Server types:** public or private, created by registered users.
- **Authentication & account data:** Supabase. Email/password plus Discord OAuth; the Discord Activity (embedded-app) flow is shipped (see `docs/discord-integration.md` for setup notes).
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
- Floors are emitted by the v2 procgen pipeline in
  `packages/shared/src/procgen/`: a generator stage produces
  region rects, the assembler turns them into a polygon sector
  map via the same linedef round-trip the editor uses, and the
  result ships as `authoredSectorMap` on `SceneLayout`. The
  geometry is polygon-shaped; the 32px tile grid still rides
  along so spawn snap and the AI grid keep working.
- Generators shipped: BSP + Tunneler, picked per-biome through
  the `generation` block. Walker and Voronoi land behind the
  same pipeline later (see ROADMAP).
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

### Props

Non-NPC billboards that populate rooms — barrels, cargo containers, conduits, terminals, trees, rocks, scrap heaps, alien growths, broken furniture. Server-authoritative, destructible by attacks, biome-themed. **Shipped:** `PropDef` JSON authored in the props editor (`packages/shared/content/props/`), spawned by procgen from each biome's prop palette, rendered as billboards in `fps.v2`, with explosive-barrel AoE + chain reactions and lootable container variants live.

**Design intent.**

- **Density makes the world.** Empty floor tiles read as a placeholder dungeon; props are how a room reads as "a sun-bleached marketplace" vs "a frozen alien chamber" without bespoke per-room art.
- **Destructible by default.** Anything visible is a tile the player can shoot, melee, or grenade. High-HP for most kinds (props eat ammo; sustained fire breaks them eventually); a few low-HP exceptions (explosive barrels, fragile crystals).
- **No HP bar.** Floating bars over a room's worth of barrels would be visual noise. Damage is communicated by hit-flash + chip-off particles + "thunk" SFX. Players learn HP through play, not from a readout.
- **Loot pull, not loot push.** Most props drop nothing or low-value scrap. A few kinds (cargo containers, terminals) have meaningful loot tables to reward map awareness without making prop-breaking the dominant resource loop.

**Designed roster** (the live set is the JSON under `packages/shared/content/props/`; this table is the design target).

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

Props are placed by the dungeon generator, not by players — `PropState` is read-only client-side (no equivalent of `build_request`). Solid props block movement and projectiles; explosive barrels deal AoE to players + enemies + adjacent props (chain explosions read clearly). Damage feedback is hit-flash only — no HP bars. Schema, wire messages, and renderer integration live in code (`packages/shared/src/content/types.ts`, `protocol.ts`, `packages/server/src/props.ts`, `fps.v2`).

**Spawning (biome-coupled).**

- Each `BiomeDef` declares a **prop palette** with weighted spawn entries: `{ kind, weight, allowDoorway: boolean, naturalOnly: boolean }`.
- Generator pass after rooms+corridors: walk every walkable tile, roll against the room's biome palette at a per-biome density (Sun-Bleached high — debris everywhere; Frozen sparse — empty halls). Reject placement if the tile is a doorway / spawn pad / interactable footprint.
- **Naturalness gating.** `naturalOnly: true` props (trees, rocks, grass) only spawn in surface / outdoor-feeling rooms; industrial props (terminals, conduits) only in alien / vault rooms. Catacombs sits in between — both palettes, leaning industrial.
- Same world-seed determinism as enemies + scatter loot — every player on the cycle sees the same prop layout for floor N.

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

**2. Attachment instances via `ATTACHMENT_DEFS` (per-instance rolls).** Three attachment kinds: `weapon_mod`, `weapon_affix`, `suit_affix`. Attachments are *unique instances* (`AttachmentInstance` with rolled stats inside per-class `ATTACHMENT_STAT_RANGES`) — two Compensators in the bag are not interchangeable. The class registry defines what *can* roll; each instance picks a roll, scaled by tier. Same shape across all three kinds; only the slot a finished instance bolts into differs. Per [The Economy Law](#the-economy-law) attachments are **drop-only components** — they enter the world from kills, containers, and champions, never from a bench. (The shipped implementation still crafts them at stations; the migration is tracked in `ROADMAP.md`.)

- **Weapon mods** sit in a free mod-slot list on the weapon. Slot count tier-gated (T1 = 0, T4 = 3).
- **Weapon piece affixes** are piece-bound: at most one per `frame / grip / magazine / barrel` slot. Slot count tier-gated (T1 = frame only, T4 = all four).
- **Suit-part affixes** are *piece-bound to a specific equipped suit part*. They bolt onto a particular plating / utility-mod / etc. via `CarriedPart.appliedAttachments`, mirroring how weapon mods bolt onto a `WeaponItem`. Attached and detached at the dedicated **Suit Assembly Bench**, which mirrors the Weapon Bench (per-part slot caps tier-gated via `SUIT_ATTACHMENT_SLOTS`, atomic `assemble_suit_part` transaction, suit-side tier-mismatch curve).

**Stat composition.** `computeWeaponEffect(weapon)` walks every piece affix instance + mod instance and returns one resolved multiplier set (damage / fire-interval / spread / projectile-speed). Server's fire path applies them; client's tooltip + Weapon Bench stats panel show the resulting "effective" stats so the player sees real numbers, not the bare baseline. Suit affix effects fold into `computeSuitStats` alongside the primary slot stat and rolled affixes — `appliedAttachments` is read via `attachmentInstanceSuitEffect` for per-instance rolls.

Adding a new attachment class is one entry in `ATTACHMENT_DEFS` + (optional) `ATTACHMENT_STAT_RANGES` row + a loot-table weight.

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

**3. Schematics + attachment instances — bare nouns, no flavor.**

The shop lists "Pistol", "Shotgun", "Reinforced Frame", "Foregrip" — no `Vorpal Reinforced Frame of Storms` wrapper. Dropped attachment instances read as their class noun + tier ("Mk2 Compensator"); their flavor budget is spent in the *weapon* namer above, where each attached instance contributes its adjective. One item, one place to be flavorful.

### Components & Materials

Assembly consumes typed material stacks as binder alongside dropped components; materials are also what the Forge salvages unwanted components back into. Each enemy template carries a probabilistic loot table; dungeon rooms also seed scatter piles weighted by floor depth. Materials stack in inventory and merge automatically on pickup.

| Material | Tier | Source | Use |
|----------|------|--------|-----|
| **Scrap** | 1 | Every enemy, every floor | Universal ingredient — walls, basic stations, ammo, every weapon recipe |
| **Wire** | 1 | Drones, dungeon scatter | Electronics tier recipes, every weapon recipe |
| **Alloy Plate** | 2 | Brutes / armored mid+ floors; salvaging Mk2 components | Heavy-tier defenses, turrets, Mk2 assembly binder |
| **Refined Alloy** | 3 | Band 2+ drops; salvaging Mk3 components | Weapon Bench Mk3 upgrade, Mk3 assembly binder |
| **Precision Alloy** | 4 | Band 3+ drops; salvaging Mk4 components | Weapon Bench Mk4 upgrade, Mk4 assembly binder |
| **Circuit Board** | 2 | Drones, mid+ floors | Electronics bench, turret core, AP/overclock mods, alloy refining |
| **Biotic Tissue** | 2 | Chasers (rare), deep floors | Medkits, stims, overcharge kits |
| **Resonant Crystal** | 3 | Brutes (rare), deep floors | Artifact uplink, AP-core mod, precision-alloy synthesis |
| **Artifact** | 3 | Kill-drop only (chaser 4% / drone 5% / brute 12% / armored 9% / swarmer none / others rare) | Currency at the Artifact Uplink (blueprints, keys); precision-alloy synthesis |
| **Key** | 2 | Kill-drop (~2-6%) + buyable at Uplink (1 artifact each) | Opens locked dungeon doors |

The registry (`MATERIALS` in shared) is one entry per material; adding a new material is one line plus loot-table tuning.

### Crafting & Assembly

Assembly is **station-driven, schematic-gated, and time-and-power-bound**. Per [The Economy Law](#the-economy-law), stations never produce components — they assemble products from dropped components plus material binder; the Forge runs the only reverse path (salvage) plus affix rerolling.

**Workstations.** Each station is a placeable building on the surface. Recipes declare which station they require; the player has to be physically near it to assemble. Multiple players can share a station.

| Station | Tier | Crafted at | Recipes |
|---------|------|------------|---------|
| **Workbench** | Basic | Hand-assembled (no station) | Assembles the other stations, base weapons (from a dropped frame + pieces), ammo, medkits, bench-upgrade items |
| **Forge** | Mid | Workbench | **Salvage & reroll** — breaks unwanted components into materials; rerolls a component's affixes for a material + artifact cost. The sink that gives every bad drop a floor value and every good-base-bad-roll drop a second life. |
| **Electronics Bench** | Mid | Workbench | Assembles Auto-Turret + per-family turret variants (built weapon + components) and consumable kits (large medkit, stim, overcharge). |
| **Weapon Bench** | Mid | Workbench | **Weapon assembly only** — slots dropped pieces, mods, and affixes onto frames via the assembly modal. **No tier-up here** — that lives at the Precision Machining Mill. |
| **Precision Machining Mill** | Mid | Workbench | **Vendor-shaped** (no recipes) — modal lists every non-melee weapon in the player's inventory and tier-ups it (T1 → T4) for a tier-scaled cost in dropped materials. |
| **Artifact Uplink** | Mid | Workbench (requires 1 crystal) | **Vendor only** (no assembly): schematic shop + keys shop. Tabbed UI. |

**Hand-crafted basics.** Walls and the first Workbench are assemblable from inventory anywhere — the bootstrap exception to the economy law (material-only products) so a fresh character can always build out a base.

**Blueprints (schematics).** Every recipe carries an optional `blueprintId`. Recipes without one are always known. Recipes with one are gated — the player must learn the schematic before the recipe appears in their assembly UI. Schematics gate **products** — buildings, turrets, consumable kits, exotic assemblies — never basic weapon piece-assembly.

**Schematics are permanent** — learned once, kept across perihelion cycles and server restarts. The dungeon reset still forces re-sourcing components every cycle: knowledge persists, materials don't.

**Acquisition source.** Schematics come from the **Artifact Uplink trade store** — players spend artifacts (the kill-drop currency) to learn them. Each catalog entry has a cost, tier, and description. Buying transfers the schematic into the player's known set, which propagates to the server. (See Artifact Uplink section below.)

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

**Bench-tier upgrade items.** A fresh Weapon Bench is Mk1 and can only assemble Mk1 components. Higher tiers are unlocked by assembling a `bench_upgrade_mkN` item at the Workbench from the matching band-gated drops (Mk2 from base Alloy Plate, Mk3 from Refined Alloy, Mk4 from Precision Alloy — all dungeon-sourced per the economy law) and applying it to the bench via right-click → Apply on the upgrade item. Each step is single-tier — a Mk1 bench needs the Mk2 upgrade first; you can't skip from Mk1 to Mk3. Per-building tier persists in the world snapshot. The bench ladder is the base-side mirror of dungeon depth.

**Per-tier weapon base-stat scaling.** The weapon's tier is a real chassis upgrade, not just an attachment-slot count bump. `effectiveWeaponStats` applies a per-tier multiplier on top of the family base stats: each tier-up adds +15% damage, –5% fire interval, +2 magazine, +2% accuracy, +5% projectile speed, and –5% spread. So a T4 weapon hits 45% harder, fires 15% faster, and is noticeably tighter than the T1 of the same family — even before attachments. Tier-mismatch math (above) still applies to attachments on top of this base scaling.

### Artifacts & The Earth Trade Tree

Artifacts are the long-form progression currency. They drop from kills (heavily weighted toward elites and faction champions) and have **three possible fates** at the Artifact Uplink. The player chooses one per artifact, creating real spend tension:
1. **Trade for schematic** — spend N artifacts to permanently learn an assembly schematic. This is the alpha's primary uplink interaction.
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

### Base Layouts

The surface base is built on a **layout** — a swappable platform
standing on flat ground in the middle of the hilly, desolate
overworld. A layout is a designed footprint that provides:

- **Turret mounts** — fixed sockets; turrets are built into mounts,
  not free-placed. The starter layout is a plain square platform
  with one mount at each corner.
- **Flat buildable ground** — the platform is the base's level
  surface for benches and chests amid the terrain noise.
- **Wall geometry** — more advanced layouts ship increasingly
  complex defensive shapes (wall mazes, chokepoints, kill lanes).
- **Capacity slots** — each layout declares how many workbench and
  storage slots it supports, so layout progression is also base
  capability progression.

New layout designs are **built and swapped at the Power Link** (the
uplink that doubles as the dungeon entrance) — layouts are products
under the economy law: schematics bought with artifacts, assembled
from dungeon-sourced components. Swapping a layout preserves the
buildings on it where slots allow. Layouts are authored in a
dedicated editor (same content-pipeline pattern as room templates)
and/or generated procedurally; both feed one `BaseLayoutDef` format.

Engineering plan: `docs/base-layouts-plan.md`.

### Placement rules

- **Grid-snapped tile placement** on the 32-pixel surface grid.
- Build mode is driven by the equipped hotbar slot — selecting a placeable item enters build mode automatically; deselecting exits. No separate toggle key.
- A translucent **3D ghost cube** is raycast at the tile under the camera reticle (green = in range, red = out).
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
| **Workbench** | 150 | Assembly station — base weapons from dropped pieces, ammo, medkits; gates the other stations. |
| **Forge** | 220 | Salvage & reroll station — breaks components into materials; rerolls component affixes. |
| **Electronics Bench** | 130 | Assembly station — turret variants, consumable kits. |
| **Weapon Bench** | 160 | Assembly station — attach/detach dropped pieces, mods, affixes. |
| **Artifact Uplink** | 200 | Vendor only (no recipes): blueprint shop + key shop. |
| **Power Link** | 800 | Central structure that doubles as the dungeon entrance and the base's power source. Auto-spawned on world boot; rebuilt at perihelion if destroyed. See [Power System](#power-system). |

## Power System

The Power Link is the load-bearing piece of the base — both the dungeon portal and the central power source for active defences and crafting. **Fully shipped.**

**Power Link as the dungeon portal.** The static `stairs_down` interactable is replaced by a destructible Power Link building at the surface origin. The Link is a real building: it has HP and enemies can attack it.

**Depth-bound descent.** The Power Link tracks the **deepest floor any crewmate has reached on the current cycle**. Pressing E on the surface Link teleports you straight to that floor — not always floor 1. So if the crew has pushed to floor 6 and then comes back up to extract, re-entering the Link drops them at floor 6, not the entrance. Intra-dungeon stairs still work normally for floor-by-floor descent.

This means coming back up to bank loot or repair the base is cheap (the portal is a fast-travel back to the frontier), and crewmates who join mid-dive land at the same depth as the rest of the party.

**Destruction = dungeon reset.** When the Power Link is destroyed, the deepest-reached counter resets to 1 and **every dungeon scene is dropped + reseeded**. The next time anyone enters the Link, they land in a fresh floor 1 with a brand-new procgen layout. This is intentionally heavy: losing the Link mid-cycle costs the crew their entire dungeon push. Defending the Link during a horde matters because its destruction is *not* a per-perihelion reset — it can happen mid-cycle and the crew has to climb the dungeon all over again. (Cycle-end perihelion still resets the dungeon as before; this is the "intentional" reset path.)

**Powered buildings.** Auto-turrets and running assembly jobs require power to function:
- While the Power Link is alive, all powered buildings work normally.
- When the Power Link is destroyed, **all turrets stop firing** and all running craft jobs pause.
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
  3. The Power Link is rebuilt at full HP.

Schematics are **not** wiped — knowledge is permanent; only the world resets. (An early uplink implementation wiped blueprints per-cycle; that was an implementation artifact, never design — removal tracked in `ROADMAP.md`.)

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
- Props (`PropDef` JSON — shipped).
- Biomes (palette, generation params, asset palettes).
- Crafting recipes + station / tier requirements.
- Blueprint tree (DAG nodes + edges as content data — shipped).
- Drop tables — corpse loot, scatter-loot, prop-break loot, enemy drops.
- Affix / RNG tables — procedural attachment stat ranges, affix pools, weights.
- Combat globals (`COMBAT` constants — player speed, regen rates, etc).

**Migration policy.** Existing tables stay in TS until their editor lands; no big-bang JSON migration. When an editor ships, that area's data ports over and the TS module becomes a thin loader that reads + Zod-validates the JSON. Adding new entries before the editor ships is fine in TS — it's still authoring; just be aware the JSON port will need to pick those up.

**Storage + deploy.** All content is plain JSON committed to the repo under `packages/shared/content/<area>/`. The server reads it at boot. No database, no runtime mutation, no live tuning loop — for the alpha's authoring scale (one dev, occasional collaborators), the **edit → save → commit → push** cycle is fast enough and keeps every change in version control. If we ever need live tuning (ops dashboard, A/B tests), DB is a later add; the JSON shape is forward-compatible.

### Editor coverage plan

| Editor | Scope | Status |
|--------|-------|--------|
| **Texture** | PNG/WEBP per `(category, id)`. | shipped |
| **Biome** | `BiomeDef` — palette, generation params, rosters, hazard intensity. Preview = top-down procgen map. | shipped |
| **Enemy** | `EnemyDef` — stats, AI template + params, visual, loot. Preview = AI sandbox. | shipped |
| **Props** | `PropDef` — HP, solid flag, on-destroy behavior, loot. | shipped |
| **Weapon** | `WeaponDef` — base stats per family. | shipped |
| **Attachments** | `AttachmentDef` — mods, weapon affixes, suit affixes. | shipped |
| **Building** | `BuildingDef` — visuals, turret family links. | shipped |
| **Recipe** | `RecipeDef` — inputs, outputs, station, tier requirement, time cost. | shipped |
| **Blueprint Tree** | DAG nodes + edges + prerequisites; pannable tree, cycle detection. | shipped |
| **Rooms** | `RoomTemplate` — tile pattern + anchors for procgen stamping. | shipped |
| **Scenes (CSG)** | Linedef-native scene authoring with undo/redo + live playtest. | shipped |
| **Animations** | `AnimationDef` — per-state frame sequences + fps. | shipped |
| **Health** | Cross-area broken-reference / asset-health view. | shipped |
| **Loot Tables** | Drop pools per source (corpse / prop-break / scatter / champion). Weighted entry list with rarity tiers. | open |
| **Affix / RNG** | Stat ranges + weight tables per attachment class. Preview = roll-N-times sampler so distributions are visible. | open |
| **Combat Tuning** | The `COMBAT` constants table — player speed, sprint multiplier, stamina rates, shield regen, perihelion windows. Single-form editor; saves to one JSON. | open |

The open editors share the same API + schema infrastructure the suite already runs on, so each is mostly a form + preview pane against an existing JSON shape — they land whenever their authoring is annoying enough to justify.

### Architecture

- **Layout.** Activity rail (domain glyphs) + domain pill strip + entity list / form / preview panes, with a global Cmd-K command palette. Shared infrastructure: `useEntityEditor` hook (load / select / draft / save / delete, dirty-state guards, Cmd-S, inline Zod validation), `SandboxPreview` (embedded fps-v2 canvas against an ephemeral sandbox world), `/api/editor/refs` cross-reference walker, `/editor/health` asset-health page.
- **Live sub-routes** under `/editor`: `textures`, `biomes`, `enemies`, `props`, `weapons`, `attachments`, `buildings`, `recipes`, `blueprints`, `rooms`, `scenes` / `scenes-csg`, `animations`, `health`, `sandbox-test`.
- **Persistence model.** Two on-disk shapes:
  - **Asset files** (PNG/WEBP) live under `packages/client/public/textures/<category>/<id>.<ext>`. Served as static URLs.
  - **Content data** (biomes, enemies, props, weapons, recipes, drop tables, …) lives under `packages/shared/content/<area>/`. Two file layouts depending on the area:
    - **File-per-entity** for entity-shaped content (one file per biome / enemy / prop / weapon / building): `<area>/<id>.json`. Easy git diffs per entry; idiomatic.
    - **Single-file table** for cross-cutting tables (combat globals, affix pools, blueprint-tree edges): `<area>/index.json`. Atomic commits; smaller files.
  - Both shapes are loaded at server boot. No DB.
- **Edit flow.** `POST /api/editor/content/<area>` writes the JSON; `GET` lists. The route Zod-validates against the area's schema before touching disk so a malformed save can never make it into the repo.
- **Hot-reload story.** Texture changes are picked up live (the renderer subscribes to `textureOverrides` notifications). Content saves hot-reload the running server per area via `contentWatch.ts` (250ms debounce) — no restart; connected clients pick up registry changes on the next welcome. Editor sandboxes can force a floor regen without waiting for a real perihelion.
- **Schema validation.** Each content area exports a TypeScript shape (`BiomeDef`, `EnemyDef`, `PropDef`, …) from shared, plus a co-located Zod schema. The editor forms are derived from those shapes; the API route runs Zod validation before writing. Bad edits never hit disk.
- **Demo scene** (already shipped for textures). Each editor mounts the v2 sandbox preview with a hand-built scene tailored to that domain — biome editor renders a generated dungeon, enemy editor spawns one of the selected enemy in front of the camera, weapon editor puts a dummy in front of the player so you can fire and read stats, etc.

### Texture Editor

Live at `/editor/textures`. Side panel lists every texture category (enemies, props, buildings, weapon view-models, biome surfaces), each row shows current texture preview + Upload/Replace + Clear. Files write to `public/textures/<category>/<id>.<ext>` via the `/api/editor/textures` route. The renderer subscribes to override notifications and live-refreshes on save.

## Implementation Status

Execution state lives in `ROADMAP.md` — sprint sequencing, what
shipped, verified-open work, the cleanup/bug list, and
architectural notes for agents. This document is design intent
only; where the two disagree about what is built, the roadmap
(verified against code) wins.
