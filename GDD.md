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

- **Top-down 2D twin-stick** *(default)* — Pixi-rendered overhead view. WASD movement, mouse aim, click to fire. The right tool for build mode and tactical map awareness.
- **2.5D first-person** *(toggle with V)* — Wolfenstein/Doom-style raycaster running on the same Pixi canvas. WASD becomes yaw-relative (forward / strafe), pointer-lock mouse-look (yaw + pseudo-pitch via horizon shift), click to fire. Feels like a boomer-shooter; build mode uses a floor-reticle ray pick to target the tile under the camera. The renderer is a drop-in replacement that reads the same `SceneState` — server is unchanged.

Both modes share the same React HUD chrome (status bars, hotbar, controls hint, crosshair). Target platform is desktop browser first; touch + mobile come later via Capacitor.

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

**Weapon classes that ship in the alpha:** four ranged families — **Pistol** (balanced baseline), **SMG** (high RoF, low damage), **Shotgun** (6-pellet pattern, short range), **Rifle** (high single-shot damage, slower cadence) — plus a **Knife** (melee arc swing). Each ranged weapon carries a per-family stat sheet:

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
- **Rejoining a party in progress:** you spawn at the dungeon entrance and must traverse down to reach your party's current floor. Extract teleporter pads only return upward to the surface base — there is no fast-travel down. Going deeper means finding the stairs on each floor and walking down them, level by level. This is a real time cost, not a free teleport (though shallow floors are typically picked clean, so transit is fast).
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

**Biome rotation.** The dungeon is divided into bands of roughly five floors each, and the number of bands is unbounded. At each perihelion, every band is independently rolled to one of the four biomes (with repeats permitted) — so a cycle's layout might look like Catacombs / Frozen / Frozen / Sun-Bleached / Alien Core / Sun-Bleached / … extending as deep as anyone pushes. Crews see the layout for known bands at base before the dive and plan loadouts around it. Biome rotation does not interfere with corpse recovery because perihelion wipes corpses anyway.

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

The alpha ships **two parallel affix paths** plus a unified attachment system that bridges them:

**1. Rolled affixes on dropped suit parts.** Five affix kinds live in `AFFIX_DEFS`, all usable on any suit slot. They roll *automatically* on dropped `CarriedPart` instances — the player doesn't craft them. Each has a flavored display name shown alongside the technical effect:

| Affix id | Flavor name | Effect | Roll range (Mk1 base × tier mult) |
|----------|-------------|--------|-----------------------------------|
| `add_hp` | Adrenal Surge | +N max HP | 4–10 |
| `add_shield` | Pulsewall Aegis | +N max shield | 3–9 |
| `add_stamina_max` | Lung Augment | +N max stamina | 3–8 |
| `add_stamina_regen` | Aerobic Conditioning | +N stamina/sec | 0.5–2 |
| `add_move_speed` | Lightfoot | +N% move speed | +1–4% |

Tier multiplier curve: Mk1 ×1, Mk2 ×2.2, Mk3 ×4, Mk4 ×7, Alien ×12.

**2. Crafted attachments via the `ATTACHMENT_DEFS` registry.** Three attachment kinds (`weapon_mod`, `weapon_affix`, `suit_affix`) live in one registry. Each carries a fixed effect, a `description`, a clean `displayName`, and a Borderlands-style `adjective` that gets stitched into a weapon's name when equipped. Players craft attachments at the Weapon Bench (weapon mods/affixes) or Electronics Bench (suit affixes), then attach via the bench UI. Attached mods/affixes are removable — detaching returns the attachment to inventory.

**Weapon affixes** are piece-bound: each weapon has up to four piece slots (`frame`, `grip`, `magazine`, `barrel`), with the slot count gated by tier (T1 unlocks frame; +1 piece per tier-up). At most one affix per piece. **Weapon mods** sit in a separate slot list, also tier-gated (T1 = 0 mod slots, T4 = 3). **Suit affixes** attach to equipped suit parts via the Suit Affix panel in the inventory; they need an Electronics Bench in range to attach/detach.

**Stat composition.** `computeWeaponEffect(weapon)` walks every piece affix + mod and returns one resolved multiplier set (damage / fire-interval / spread / projectile-speed). Server's fire path applies them; client's tooltip shows the resulting "effective" stats so the player sees real numbers, not the bare baseline. Suit affix effects fold into `computeSuitStats` the same way alongside primary slot stats and rolled affixes.

Adding a new attachment is **one entry in `ATTACHMENT_DEFS`** + a recipe + a blueprint catalog row.

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
| **Alloy Plate** | 2 | Brutes / armored, mid+ floors | Heavy-tier defenses, turrets, weapon mods |
| **Circuit Board** | 2 | Drones, mid+ floors | Electronics bench, turret core, AP/overclock mods |
| **Biotic Tissue** | 2 | Chasers (rare), deep floors | Medkits; reserved for future bio-tech recipes |
| **Resonant Crystal** | 3 | Brutes (rare), deep floors | Artifact uplink, AP-core mod, end-tier recipes |
| **Artifact** | 3 | Kill-drop only (chaser 4% / drone 5% / brute 12% / armored 9% / swarmer none / others rare) | Currency at the Artifact Uplink — buys blueprints + keys |
| **Key** | 2 | Kill-drop (~2-6%) + buyable at Uplink (1 artifact each) | Opens locked dungeon doors |

The registry (`MATERIALS` in shared) is one entry per material; adding a new component is one line plus loot-table tuning.

### Crafting & Assembly

Crafting in the alpha is **station-driven, blueprint-gated, and (planned) time-and-power-bound**.

**Workstations.** Each crafting station is a placeable building on the surface. Recipes declare which station they require; the player has to be physically near it to craft. Multiple players can share a station.

| Station | Tier | Crafted at | Recipes |
|---------|------|------------|---------|
| **Workbench** | Basic | Hand-craft (no station) | Forge, Electronics Bench, Weapon Bench, Artifact Uplink, all base weapons (pistol/SMG/shotgun/rifle), all ammo types, medkits |
| **Forge** | Mid | Workbench | Heavy alloy items (planned) |
| **Electronics Bench** | Mid | Workbench | Auto-Turret + per-family turret variants, suit affix attachments (shield, speed) |
| **Weapon Bench** | Mid | Workbench | Weapon mods + weapon-piece affixes; manage attached mods/affixes; tier-up weapons (T1→T4) |
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
- When the horde ends, the cycle counter increments. Cycle reset:
  1. Any players still in dungeon scenes are evicted to the surface.
  2. All dungeon scenes are dropped; procgen reseeds them next descent.
  3. Surface corpses + dropped loot are wiped (the "recover before perihelion or lose it" pressure).
  4. Per-cycle blueprints wipe; persistent blueprints stay.
  5. The Power Link is rebuilt at full HP *(once shipped)*.

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
- 6 enemy templates (chaser_melee, shooter_drone, brute_chaser, swarmer, armored, dummy_target) with mix-and-match movement / attack profiles, FSM, line-of-sight gating.
- Slot-based inventory (base 36 slots, hotbar 9 + bag 27), grows with cargo grid tier (Mk1 +4 ⋯ Alien +48). Drag/drop, sort, suit equipment slots.
- **Combat**: 4 ranged weapon families (pistol/SMG/shotgun/rifle) + knife. Per-weapon stats (damage / fire rate / projectile speed / pellet count / spread / accuracy / magazine / reload). Per-shot accuracy jitter (±~8.6° max half-cone scaled by `1 - accuracy`). Magazine + **R**-key reload. Mods + piece affixes scale stats via `computeWeaponEffect`. Borderlands-style adjective-stacking weapon names. Effective stats shown in inventory tooltip.
- Naked respawn (corpse retains all loot at death position; corpse persists until perihelion or pickup). Per-server `dropItemsOnDeath` toggle.
- Audio: per-event SFX (player-shoot per-family, enemy-shoot, hits, footsteps, pickups, UI click/hover, modal open, reload), music with crossfade per scene. Volume + mute persisted to localStorage. **M** toggles mute.

**Items & crafting**
- 8-material component schema (`scrap`, `wire`, `alloy`, `circuit`, `biotic`, `crystal`, `artifact`, `key`).
- Per-template enemy loot tables + dungeon scatter loot in rooms. Drop rates rebalanced so artifacts/keys/crystals are the rare prize and tier-rolled gear drops at ~5% per kill (down from 80%).
- Suit equipment with **real stat effects**: chassis +HP +build radius, plating +shield, life support +stamina +regen, utility_mod +move speed, cargo grid +inventory slots +small build radius.
- Affix system shipped — two paths under one roof:
  - **Rolled affixes** on dropped CarriedParts (5 kinds, tier-scaled, stack into the suit stats accumulator). Each has a flavored display name (Adrenal Surge, Pulsewall Aegis, etc.).
  - **Crafted attachments** via `ATTACHMENT_DEFS`: weapon mods, weapon affixes, suit affixes. 8 weapon mods + 2 weapon affixes + 2 suit affixes shipping. Each carries a Borderlands-style adjective for weapon name composition.
- 4 base weapons (pistol/SMG/shotgun/rifle) craftable at Workbench, blueprint-gated. Player starts with `bp_pistol`. Tier-up at Weapon Bench (T1→T4) preserves attached mods/affixes.
- Workstation buildings (workbench, forge, electronics_bench, **weapon_bench**) + Artifact Uplink + 4 turret variants (pistol-tier baseline + per-family with weapon-as-component recipes).
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

### Active / Next Up

The post-alpha roadmap lives in `docs/sprints.md` with effort
estimates, dependencies, and concrete plans-of-attack for each
item. Headlines:

**Sprint A — quick wins.** Spawn-in-walls bug; death recovery when
the base is destroyed mid-perihelion; drop-rate retune so every
recipe input is reachable in real playtime.

**Sprint B — drop loop + status pipe + minimap.** Drop / give items
between players; a generic status-effect pipe powering stims,
overcharge kits, multiple medkit tiers (load-bearing for Sprint D's
environmental ammo); a corner-mounted minimap for both top-down
and FPS views.

**Sprint C — procedural attachments.** Replace the static
`ATTACHMENT_DEFS` registry with a class registry + per-instance
rolled stats. Every dropped/crafted attachment becomes unique.
Single biggest commit; unblocks meaningful versions of salvage,
weapon assembly UI, and infinite mod variety.

**Sprint D — content built on procedural attachments.**
- Salvage system (return ~20% of cost; suit affix `salvage_yield_pct`
  scales the rate).
- Remaining ranged weapons (sniper, heavy, energy) + melee
  progression as a real combat verb.
- Environmental ammo (`incendiary`, `chem`, `emp`) + AoE-status
  enemies (flamethrower drone, chem bloater).
- Weapon assembly UI: drag-drop pieces at the Weapon Bench with a
  live ghost-stats preview.

**Sprint E — UX overhauls.** Blueprint tree progression with
workstation-tier upgrades and a Path-of-Exile-style passive UI.
Mobile controls (virtual stick + fire + hotbar). Dungeon overhaul
via Wave Function Collapse with biome palettes (mechanical /
organic / cave / open).

**Hazard system** still on deck (radiation, toxic, cold, heat) —
biome-specific environmental damage ticks gated by life-support
resists. Lands naturally with Sprint E's biome palettes.

**Discord Developer Portal config + first end-to-end test.** Code
is shipped (web OAuth + Activity SDK, instance-bound rooms);
waiting on Portal setup + a real Discord call to validate the
flow. See `docs/discord-integration.md` for the manual steps.

### Deferred Past Alpha

- Full weapon part-assembly drops (the part ontology in [Items & Procedural Generation](#items--procedural-generation)). Today's loop is mod / affix attachments + tier-up; the part-driven assembly is the long-term direction.
- Faction champions / boss enemies + the artifact-as-Alien-tier-part path.
- Earth tech-tree unlocks (currently the artifact uplink only trades blueprints; "Ship to Earth" + "Burn as ingredient" fates land later).
- Cargo grid (Tetris-style) inventory model. Today's slot inventory grows linearly with cargo tier; the actual W×H grid lands later.
- Pixel-art textures (the asset_gen pipeline ships the runtime; comprehensive coverage of all entities + animations is its own roadmap).
- Mobile (Capacitor) + desktop (Electron) wrappers.
