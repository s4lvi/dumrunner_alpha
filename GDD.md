# DÛM RUNNER — Game Design Document

## Concept

DÛM RUNNER is a browser-based multiplayer tactical extraction shooter with roguelike dungeon-diving and persistent base-building. Runners scavenge alien ruins on a hostile planet, reverse-engineer the technology, and ship artifacts back to Earth in exchange for manufacturing tech. Every three in-game days the planet reaches perihelion, monsters frenzy, and the surface base must survive a horde assault.

## Setting

Post-apocalyptic cyberpunk future. The colony sits on the surface of a hostile alien world strewn with the ruins of an ancient advanced civilization. Earth funds the expedition in exchange for recovered alien tech.

## Core Loop

1. **Dive** — descend into the persistent Dungeon of Dûm to scavenge parts, artifacts, and materials.
2. **Extract** — reach a per-floor extract teleporter to bank loot at the surface base.
3. **Build & craft** — assemble weapons and suit mods from parts; expand the base with grid-placed walls, turrets, and crafters.
4. **Ship & unlock** — send artifacts back to Earth to unlock manufacturing tech tree nodes (server-wide).
5. **Defend** — every third in-game day at perihelion, the surface is attacked by a horde. Survive together.
6. **Reset & repeat** — perihelion regenerates the dungeon; players return to fresh shallow floors and push the frontier again.

## Perspective & Controls

- **Top-down 2D twin-stick.**
- WASD movement, mouse aim, click to fire.
- Browser game; targets desktop first.

## Combat

Tactical extraction-shooter feel. Slower and more deliberate than arcade twin-stick:

- Ammo is finite and worth managing.
- Individual enemies are dangerous; positioning matters more than reflexes.
- Time-to-kill on both sides is meaningful — you can die to a single bad engagement.

## Multiplayer

- **Server size:** 5–10 players per server.
- **Server types:** public or private, created by registered users.
- **Authentication & account data:** Supabase.
- **Dungeon model:** **shared co-op dungeon with async entry/exit.** All players on a server occupy the same dungeon instance, but can dive, retreat to base, and rejoin parties asynchronously.
- **Rejoining a party in progress:** you spawn at the dungeon entrance and must traverse down to reach your party's current floor. Extract teleporter pads only return upward to the surface base — there is no fast-travel down. Going deeper means finding the stairs on each floor and walking down them, level by level. This is a real time cost, not a free teleport (though shallow floors are typically picked clean, so transit is fast).

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

- **Full-loot stakes.** On death, you drop **everything you were carrying that run, including equipped weapons and suit.**
- **Corpse persists where you died** until the next perihelion. You (or anyone) can return to that floor and recover the gear.
- **Perihelion wipes corpses** along with the dungeon reset — gear left unrecovered is lost forever.

This creates a meaningful corpse-run loop: a bad death deep in the dungeon is recoverable but expensive, and the perihelion clock makes recovery time-pressured.

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

### Crafting & Assembly

- Players craft assemblies at base benches (one bench per assembly type — weapon, suit).
- Crafting an assembly requires the constituent parts plus base materials (scrap, polymer, etc., scavenged from the dungeon).
- **Tech-tree unlocks** gate which part *templates* are craftable from raw materials, vs. only obtainable as drops. Loot keeps flowing from day 1; tech tree expands the deterministic crafting options over time.
- **Artifacts have three possible fates** at the artifact uplink/analyzer. The player chooses one per artifact, creating real spend tension:
  1. **Analyze and equip** — yields an Alien-tier weapon or suit part the player can immediately use.
  2. **Ship to Earth** — sacrifices the artifact for a server-wide tech-tree unlock.
  3. **Burn as crafting ingredient** — consumes the artifact as a high-tier component in a specific craft recipe.

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

## Earth Trade & Tech Tree

Every artifact recovered from the dungeon is, by default, an Alien-tier part. At the artifact uplink/analyzer, the player chooses one of three fates per artifact (full list and trade-offs in the [Crafting & Assembly](#crafting--assembly) section):

- **Equip** — keep the artifact as the Alien-tier part it is.
- **Ship to Earth** — sacrifice it for a server-wide tech-tree unlock (a new blueprint, part template, or base module made craftable for everyone).
- **Burn as crafting ingredient** — consume it as a component in a specific high-tier recipe.

The three-way choice creates real spend tension: do you keep the rare part, donate it for a permanent server-wide unlock, or burn it crafting a one-off endgame item? Tech-tree unlocks tell players *what they can build*; players still have to scavenge their own parts (or trade with crewmates) to actually build it.

## Base Building

- **Grid-snapped tile placement** on the surface.
- Buildables include walls, auto-turrets, crafting stations, storage, suit/weapon assembly benches, artifact uplink (to ship loot to Earth).
- Base persists across deaths and perihelion cycles. Base damage from horde nights must be repaired with parts.
- Intuitive build/edit mode toggle on the surface; not accessible from inside the dungeon.

## Perihelion & Horde

- The planet reaches perihelion every **3 in-game days**.
- One in-game day ≈ **1–2 hours real-time** (so a perihelion cycle is ~3–6 real-time hours).
- At perihelion: monsters frenzy and assault the surface base in a horde.
- **Combat model:** auto-turrets provide baseline DPS; players fill gaps, repair damaged structures, kite elites, focus high-priority targets. Horde is survivable solo with a strong base, but designed for the whole crew to be online and active.
- After the horde, the dungeon regenerates: enemies repopulate, traps re-arm, loot containers refill, and any unrecovered corpses (and their gear) are lost.

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

## Alpha Scope

**Build multiplayer infrastructure first.** The hardest technical risk is realtime sync over websockets between authenticated players in created servers. De-risk that before any gameplay systems.

Phase 1 — Multiplayer infra spike:

1. **Account & auth** (Supabase Auth): register, login, account profile (display name).
2. **Lobby**: server browser (filterable list of public servers), create-server form (name, visibility, password, max slots, optional seed), join-by-code for private servers.
3. **Game-server registry**: thin service mapping `server_id → host:port`, with on-demand spin-up of an empty game-server process when a player joins a dormant server.
4. **Per-server character provisioning**: on first join to a server, create the character record with the starter kit; on subsequent joins, restore.
5. **Websocket position sync**: two authenticated players in the same server see each other move in real time on a placeholder surface map.
6. **Idle shutdown + state flush**: game-server process flushes character/world state back to Supabase on graceful shutdown and restores on next boot.

Once Phase 1 is solid, layer combat, the dungeon, items, base-building, and the horde on top of the proven netcode.
