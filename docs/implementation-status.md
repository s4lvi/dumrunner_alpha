# DUM RUNNER Implementation Status Audit

Audit date: 2026-05-05

Scope: `GDD.md` compared against the current repository. This document treats code as the source of truth. The GDD's own "Alpha Scope & Implementation Status" section is useful context, but some statements there are ahead of or behind the implementation.

## Executive Summary

The playable alpha loop is real: authenticated users can create or join persistent server worlds, connect to an authoritative websocket simulation, move/fight/extract, craft/build at stations, defend a Power Link during perihelion hordes, use inventories/equipment/blueprints, and persist server/character/world state through Supabase.

The largest missing design pillars are biome-driven dungeon identity, environmental hazards/resists, runtime props, traps/stealth/detection, faction champions/bosses, the full part-ontology assembly model, the Earth trade tree, true server-process orchestration per room, and mobile/wrapper distribution work.

There is also a substantial "editor/data migration" slice in progress: biome and enemy JSON files and forms exist, but the live server still uses TypeScript registries and rectangular procgen. Prop JSON/schema/editor forms exist, but no runtime prop entities exist.

## Fully Implemented

### Repo And Build Infrastructure

Status: implemented.

- npm workspace monorepo with `client`, `server`, `shared`, and `asset_gen` packages.
- Shared typecheck/build scripts exist at the root.
- CI typechecks shared, server, client, and asset_gen on push/PR.
- Fly deploy workflow typechecks shared/server and deploys the game server on relevant main-branch changes.
- Fly config and server Dockerfile exist for the websocket game server.

Evidence:

- `package.json`
- `.github/workflows/ci.yml`
- `.github/workflows/fly-deploy.yml`
- `fly.toml`
- `packages/server/Dockerfile`

### Supabase Auth, Accounts, And Profiles

Status: implemented.

- Email/password registration and login exist.
- Registration creates an `accounts` row with display name.
- Supabase email callback route exists.
- Settings page can update display name.
- Discord OAuth and Activity-specific auth integration are present.
- `/terms` and `/privacy` pages exist for Discord app requirements.

Evidence:

- `packages/client/app/register/actions.ts`
- `packages/client/app/login/actions.ts`
- `packages/client/app/auth/callback/route.ts`
- `packages/client/app/settings/actions.ts`
- `packages/client/lib/discord/auth.ts`
- `packages/client/app/api/auth/discord/*`
- `packages/client/app/discord/page.tsx`
- `supabase/migrations/0001_initial.sql`
- `supabase/migrations/0006_accounts_discord_provider.sql`

Notes:

- Email confirmation behavior depends on Supabase project settings, but the callback and redirect path are implemented.
- Discord identities are represented through synthetic Supabase users and account rows.

### Lobby: Server Creation, Join, Passwords, Deletion, Pause/Resume

Status: implemented for core flows.

- Authenticated users can create public/private servers.
- Server creation supports name, visibility, password/invite code, max slots, world seed, day length, days per cycle, death-loot toggle, and playtest mode.
- Password-protected join is enforced for non-owners.
- Owner bypasses password.
- Capacity check counts recently active characters via `last_seen_at`.
- Per-account/per-server character provisioning exists.
- Owners can delete servers.
- Owners can pause in-game or via API; paused servers reject non-owner joins.
- Owner rejoin resumes a paused server.
- Lobby shows paused state and owner delete/join controls.

Evidence:

- `packages/client/app/servers/new/NewServerForm.tsx`
- `packages/client/app/servers/new/actions.ts`
- `packages/client/app/api/servers/[id]/join/route.ts`
- `packages/client/app/api/servers/[id]/route.ts`
- `packages/client/app/api/servers/[id]/pause/route.ts`
- `packages/client/app/api/servers/[id]/resume/route.ts`
- `packages/client/app/servers/page.tsx`
- `supabase/migrations/0002_servers_has_password.sql`
- `supabase/migrations/0004_servers_world_config.sql`
- `supabase/migrations/0005_characters_last_seen.sql`
- `supabase/migrations/0009_servers_paused.sql`
- `supabase/migrations/0010_servers_playtest.sql`

Notes:

- The GDD's full filterable browser is not implemented; see "Partial Or Stubbed".
- Owner admin edit/kick/ban is not implemented.

### Websocket Auth, Protocol Validation, And Session Liveness

Status: implemented.

- Client sends an auth message with HMAC-signed join token and protocol version.
- Server verifies `PROTOCOL_VERSION`.
- Inbound client messages are Zod-validated by `ClientMessageSchema`.
- Join tokens are signed/verified in shared code.
- Server sends websocket ping/pong heartbeat to keep Fly sessions alive.
- Game server stamps `last_seen_at` on join and every 30 seconds.

Evidence:

- `packages/shared/src/protocol.ts`
- `packages/shared/src/token.ts`
- `packages/server/src/index.ts`
- `packages/client/app/api/servers/[id]/join/route.ts`

### Core Realtime Simulation

Status: implemented.

- Server-authoritative movement at 20 Hz.
- Client sends input vectors, not authoritative positions.
- Sprint, stamina drain, stamina regen delay, stamina broadcast throttling.
- Shield soak and delayed shield regen.
- Player respawn after death with short immunity.
- Client prediction/smoothing and soft reconciliation exist in renderers.

Evidence:

- `packages/server/src/combat.ts`
- `packages/server/src/scene.ts`
- `packages/client/lib/game/pixi.ts`
- `packages/client/lib/game/iso.ts`
- `packages/client/lib/game/fps.ts`

### Combat: Weapons, Ammo, Reload, Melee, Status Effects

Status: implemented and broader than the original alpha set.

- Ranged weapon families implemented: pistol, SMG, shotgun, rifle, sniper, heavy, energy.
- Melee weapons implemented: knife, sword, hammer, energy blade.
- Weapon stats include damage, fire interval, projectile speed/TTL/radius, pellet count, spread, accuracy, magazine size, reload time, and ammo kind.
- Server applies per-shot accuracy jitter and pellet spread.
- Magazine ammo is tracked per weapon instance.
- `R` reloads from reserve ammo and locks firing until complete.
- Player and turret projectiles share the projectile path.
- Melee arc swings damage enemies and broadcast swing visuals.
- Weapon mods and affixes resolve through `computeWeaponEffect`.
- Status-effect imbue mods apply burn, poison, and slow to enemies.
- Enemy AoE cone attacks can apply burn/poison/slow to players.

Evidence:

- `packages/shared/src/weaponStats.ts`
- `packages/shared/src/inventory.ts`
- `packages/server/src/scene.ts`
- `packages/server/src/ai/templates.ts`
- `packages/client/app/play/[id]/Game.tsx`

Notes:

- Heavy projectiles currently use generic slug behavior/visuals; GDD calls richer heavy variants deferred.
- PvP is absent, matching alpha co-op-only intent.

### Enemy Templates And AI Runtime

Status: implemented.

- Live TypeScript enemy templates exist for dummy_target, chaser_melee, shooter_drone, swarmer, armored, flame_drone, chem_bloater, and brute_chaser.
- Movement profiles include stationary, chase, kite, flee at low HP.
- Attacks include melee, projectile, and AoE cone effects.
- Hit stun is per template.
- Line-of-sight and collision are provided to AI in collision scenes.
- Horde AI receives building targets with priority.

Evidence:

- `packages/server/src/ai/templates.ts`
- `packages/server/src/ai/types.ts`
- `packages/server/src/ai/fsm.ts`
- `packages/server/src/ai/runtime.ts`
- `packages/server/src/scene.ts`

Notes:

- The JSON `EnemyDef` files are not the live spawn source yet.

### Dungeon: Rectangular Procgen, Stairs, Extract, Locked Rooms, Persistence Until Reset

Status: implemented for the rectangular alpha dungeon.

- Dungeon floor layouts are deterministic from `(worldSeed, cycle, floorIndex)`.
- Rooms and corridors are tile-aligned on a 32 px grid.
- Every floor has an extract pad back to surface.
- Stairs descend to the next floor.
- Surface Power Link descends to the current frontier depth.
- Enemy spawns and scatter loot are deterministic from seed/cycle/floor.
- Killed enemies do not respawn until cycle reset because scenes persist while active/snapshotted.
- Locked rooms and door buildings exist.
- Door opening consumes a key.
- Critical path to stairs is protected from locked-door gating.
- Dynamic floor state snapshots include enemies, loot, corpses, and buildings.

Evidence:

- `packages/server/src/procgen.ts`
- `packages/server/src/world.ts`
- `packages/server/src/scene.ts`
- `packages/shared/src/protocol.ts`

Notes:

- This is not the biome/band/WFC dungeon described for the longer-term plan.

### Loot, Death, Corpses, Item Drop/Give/Salvage

Status: implemented.

- Enemy kill drops include material table rolls and tier-biased carried-part drops.
- Scatter loot exists in dungeon rooms.
- Loot auto-pickup exists.
- On death, loose inventory drops to a corpse if `dropItemsOnDeath` is enabled.
- Equipped suit parts stay equipped on death.
- Respawn does not restore starter bag contents.
- Corpses persist until looted or cycle reset.
- Corpse pickup handles all current inventory slot variants.
- Players can drop one/all from an inventory slot.
- Players can give one/all to nearby players.
- Workbench salvage exists for attachments, weapons, and placeables.

Evidence:

- `packages/server/src/loot.ts`
- `packages/server/src/scene.ts`
- `packages/server/src/world.ts`
- `packages/shared/src/crafting.ts`
- `packages/client/app/play/[id]/Game.tsx`

Notes:

- Manual loot pickup is deferred; current behavior is proximity auto-pickup.
- Loot TTL is 90 seconds, which GDD marks as likely too short for later polish.

### Inventory, Equipment, Suit Stat Effects, And Item Names

Status: implemented.

- Slot-based inventory with hotbar and bag.
- Bag grows with cargo grid tier.
- Inventory supports material, ammo, part, weapon, attachment, consumable, placeable, and upgrade slots.
- Drag/drop/swap/sort/equip/unequip surfaces exist.
- Suit equipment slots: chassis, plating, life_support, utility_mod, cargo_grid.
- Suit parts affect max HP, shield, stamina, stamina regen, movement speed, build radius, and inventory size.
- Rolled suit affixes on carried parts are implemented.
- Crafted suit-affix attachments are implemented through the Suit Assembly Bench.
- Item names for weapons, carried parts, and attachment instances are implemented.
- Character stats panel and tooltips expose effective stats.

Evidence:

- `packages/shared/src/inventory.ts`
- `packages/shared/src/itemNames.ts`
- `packages/server/src/world.ts`
- `packages/client/app/play/[id]/Game.tsx`

Notes:

- Suit weight classes and environmental/damage resist fields are not implemented.
- Cargo is still a linear slot count, not a Tetris/grid inventory.

### Crafting, Blueprints, Workstations, Queues, Output Buffers

Status: implemented.

- Recipe registry supports material/ammo/weapon inputs and placeable/ammo/weapon/attachment/consumable/material/upgrade outputs.
- Workstation-gated recipes exist.
- Blueprint-gated recipes exist.
- Artifact Uplink can sell blueprints and keys.
- Workstation modals show recipes, requirements, progress, and output buffers.
- Async crafting exists with `craftTimeMs`.
- Materials are deducted on enqueue.
- Up to 5 jobs can exist per station, including queued jobs.
- Station parallel slot budget comes from `BUILDING_REGISTRY`.
- Completed station jobs deposit into 8-slot output buffers.
- `Take All` drains nearby station outputs.
- Forge alloy recipes exist for alloy, refined alloy, and precision alloy.
- Weapon Bench crafts attachments and assembles weapons.
- Precision Machining Mill tiers ranged weapons up to T4.
- Electronics Bench crafts turrets, consumables, and suit affixes.
- Field Craft tab lists hand-craftable basics.

Evidence:

- `packages/shared/src/crafting.ts`
- `packages/shared/src/buildings.ts`
- `packages/server/src/world.ts`
- `packages/server/src/scene.ts`
- `packages/client/app/play/[id]/Game.tsx`

Notes:

- Persistent legendary blueprints are represented in code as a set but no current store path grants or persists them.

### Weapon Assembly, Bench Tiers, Tier Mismatch

Status: implemented.

- Weapon Bench assembly UI lists non-melee weapons.
- Slot grid covers frame, grip, magazine, barrel by weapon tier.
- Mod slot count scales by weapon tier.
- Inline chooser stages compatible attachment instances.
- Live stats preview compares staged versus current stats.
- Server applies atomic `assemble_weapon`.
- Server validates instance id, attachment kind, piece slot, family compatibility, tier slot availability, inventory availability, and detach space.
- Weapon Bench tier is per building and persists in world snapshot.
- Forge creates Weapon Bench upgrade items.
- Upgrade item applies to a nearby eligible bench.
- Precision Mill tier-up preserves mods/pieces.
- Tier mismatch math scales attachment effect by tier distance.

Evidence:

- `packages/shared/src/inventory.ts`
- `packages/shared/src/crafting.ts`
- `packages/shared/src/weaponStats.ts`
- `packages/server/src/world.ts`
- `packages/server/src/scene.ts`
- `packages/client/app/play/[id]/Game.tsx`

### Suit Assembly Bench

Status: implemented.

- `suit_bench` building exists.
- Suit Assembly Bench modal exists.
- Equipped suit part picker exists.
- Attachment slot count is tier-based.
- Inline chooser filters compatible suit-affix instances.
- Live suit stat preview exists.
- Server applies atomic `assemble_suit_part`.
- Suit tier mismatch math scales attachment effect by part/attachment tier distance.

Evidence:

- `packages/shared/src/buildings.ts`
- `packages/shared/src/inventory.ts`
- `packages/shared/src/crafting.ts`
- `packages/server/src/world.ts`
- `packages/client/app/play/[id]/Game.tsx`

### Base Building And Buildings

Status: implemented.

- Surface-only grid placement exists.
- Placement consumes a placeable inventory item.
- Placement validates range, tile occupancy, and player overlap.
- Demolish exists and refunds the placeable item.
- Buildings block movement/projectiles.
- Buildings take damage.
- `BUILDING_REGISTRY` is the single source of truth for HP, horde priority, station/workstation flags, parallel slots, and labels.
- Implemented building kinds include wall, turret variants, workbench, forge, electronics bench, weapon bench, precision mill, suit bench, artifact uplink, power link, door, and storage chest.
- Storage chests are 16-slot shared buffers and persist via world snapshots.

Evidence:

- `packages/shared/src/buildings.ts`
- `packages/shared/src/protocol.ts`
- `packages/server/src/scene.ts`
- `packages/client/app/play/[id]/Game.tsx`

Notes:

- Wall repair is not implemented.
- No high-value demolish confirmation exists.

### Power Link And Power System

Status: implemented.

- Power Link auto-spawns on surface.
- Power Link is a real destructible building with HP.
- Power Link acts as dungeon portal.
- Surface descent targets deepest floor reached this cycle.
- Power capacity is `base + per-depth * deepestFloorReached`.
- Turrets and active craft jobs draw power.
- Power state broadcasts to clients.
- Turrets require power.
- Craft jobs only start/promote when power capacity fits.
- Power Link destruction disables power, evicts dungeon players, drops dungeon scenes, and resets frontier depth.
- Cycle reset rebuilds/restores Power Link and resets frontier depth.

Evidence:

- `packages/server/src/world.ts`
- `packages/server/src/scene.ts`
- `packages/server/src/combat.ts`
- `packages/client/app/play/[id]/Game.tsx`

### Perihelion And Horde

Status: implemented.

- Configurable world clock exists.
- Default alpha cycle is 3 days * 300 seconds.
- Server broadcasts countdown state.
- Client renders cycle/perihelion HUD.
- Horde starts at perihelion.
- Horde waves spawn on the surface perimeter.
- Horde duration is 60 seconds.
- Horde enemy count and composition scale by cycle.
- Horde enemies target buildings by priority.
- Walls and structures take real enemy damage.
- Cycle reset increments cycle, drops dungeon scenes, wipes surface corpses/loot, wipes per-cycle blueprints, rebuilds Power Link, and recomputes power.
- Players in dungeon at horde start get `link_severed` and die in place, then respawn.

Evidence:

- `packages/server/src/world.ts`
- `packages/server/src/scene.ts`
- `packages/server/src/combat.ts`
- `packages/client/app/play/[id]/Game.tsx`

Notes:

- GDD text says cycle reset evicts dungeon players; code currently kills dungeon-side players at horde start through the Link Severed path, then also drops dungeon scenes at horde end.

### Chat

Status: implemented.

- Top-left chat panel exists.
- Enter focuses/sends; Escape cancels.
- Server-wide player chat exists.
- System messages exist for joins, leaves, and deaths.
- Server rate-limits chat to roughly 1.6 messages/sec.
- Message length is capped to 280 by protocol schema/server slicing.

Evidence:

- `packages/shared/src/protocol.ts`
- `packages/server/src/world.ts`
- `packages/client/app/play/[id]/Game.tsx`

### Rendering And HUD

Status: implemented.

- Top-down Pixi renderer exists.
- Iso renderer exists.
- 2.5D/FPS raycaster renderer exists.
- Runtime renderer cycling with `V` exists.
- Shared React HUD includes hotbar, HP/shield/stamina, ammo/reload, world clock, power, chat, minimap, status effects, prompts, and overlays.
- FPS renderer uses stubs for non-rendered entity methods where appropriate but handles the playable scene path.
- Texture overrides are consulted by renderers.

Evidence:

- `packages/client/lib/game/pixi.ts`
- `packages/client/lib/game/iso.ts`
- `packages/client/lib/game/fps.ts`
- `packages/client/lib/game/minimap.ts`
- `packages/client/app/play/[id]/Game.tsx`

### Audio And Settings

Status: implemented.

- SFX and music assets exist.
- Audio manager supports preload, unlock, volume, mute, SFX, and music crossfade.
- Settings UI exists for audio.
- `M` toggles mute in-game.

Evidence:

- `packages/client/lib/audio.ts`
- `packages/client/public/sounds/*`
- `packages/client/public/music/*`
- `packages/client/app/settings/AudioSettings.tsx`
- `packages/client/app/play/[id]/Game.tsx`

### Texture Editor

Status: implemented for enemy/building textures.

- `/editor` redirects to `/editor/textures`.
- Texture editor lists enemy kinds and building kinds.
- Upload/replace/clear writes files under `packages/client/public/textures/<category>/<id>.<ext>`.
- Supported API categories are `enemy` and `building`.
- Demo scene supports iso/top-down/FPS cycling and local WASD movement.
- Renderers subscribe to texture override updates.

Evidence:

- `packages/client/app/editor/page.tsx`
- `packages/client/app/editor/layout.tsx`
- `packages/client/app/editor/textures/page.tsx`
- `packages/client/app/api/editor/textures/route.ts`
- `packages/client/lib/textureOverrides.ts`

## Partial Or Stubbed

### Server Browser UX

Status: partial.

Implemented:

- Public server list.
- Owner private-server list.
- Join-by-id form.
- Password indicator.
- Paused badge.
- Owner delete button.

Missing from GDD:

- Name search.
- Current player count display.
- Has-password filter.
- Age filter.
- Sort controls.
- "Most active" sorting.
- Rich "My Servers" manage panel.
- Owner edit name/password/max slots.
- Kick/ban players.

Evidence:

- `packages/client/app/servers/page.tsx`
- `packages/client/app/servers/JoinByIdForm.tsx`
- `packages/client/app/servers/DeleteServerButton.tsx`

### Game-Server Registry And Lifecycle

Status: partial.

Implemented:

- In-process registry maps `serverId` to `World`.
- Concurrent joins share the same hydrate promise.
- World snapshots persist to Supabase.
- Last-player-out flushes snapshots and stops timers.
- Pause evicts the world from the in-process registry.
- Fly deployment config exists and keeps one machine warm.

Missing from GDD:

- Real external registry/controller that maps `server_id -> host/port/status`.
- One process per active server world.
- Actual process spin-up per room.
- Actual idle process shutdown. Current code logs `idle, would shut down here`.
- Use of the `game_server_host`, `game_server_port`, and `game_server_status` DB fields as an active registry.

Evidence:

- `packages/server/src/registry.ts`
- `packages/server/src/world.ts`
- `supabase/migrations/0001_initial.sql`
- `fly.toml`

### Content Pipeline And Editor Suite

Status: partial.

Implemented:

- Shared Zod schemas for `BiomeDef`, `EnemyDef`, and `PropDef`.
- Repo-backed content loader/saver.
- API CRUD route for `/api/editor/content/<area>`.
- Biome editor form.
- Enemy editor form.
- Decorator/prop editor form.
- JSON files exist for four biomes.
- JSON files exist for current enemy templates.

Stubbed/missing:

- Live server does not consume JSON content for biomes/enemies/props.
- Live procgen does not use biome JSON.
- Enemy spawns still come from TypeScript `TEMPLATES` and `DEPTH_WEIGHTS`.
- Biome editor preview is a color/summary stub, not generated dungeon preview.
- Enemy editor preview explicitly says live AI sandbox lands later.
- Decorator editor preview explicitly says prop runtime is not wired.
- Props content directory has no prop JSON files.
- No "regenerate dungeon now" dev WS action exists.

Evidence:

- `packages/shared/src/content/types.ts`
- `packages/shared/src/content/loader.ts`
- `packages/shared/content/biomes/*.json`
- `packages/shared/content/enemies/*.json`
- `packages/client/app/api/editor/content/[area]/route.ts`
- `packages/client/app/editor/biomes/page.tsx`
- `packages/client/app/editor/enemies/page.tsx`
- `packages/client/app/editor/decorators/page.tsx`
- `packages/server/src/ai/templates.ts`
- `packages/server/src/procgen.ts`

### Biomes

Status: data exists, runtime not started.

Implemented:

- Biome schema.
- Four biome JSON files: Sun-Bleached, Catacombs, Frozen, Alien Core.
- Enemy roster, prop palette, loot bias, palette, generation knobs are represented in JSON.
- Enemy JSON files include biome affinity.

Missing from GDD:

- Per-band biome assignment at cycle start.
- `layout.biome` or equivalent runtime scene biome.
- Biome-specific enemy roster selection.
- Biome-specific floor/wall colors in live renderers.
- Base UI showing known band layout.
- Biome-coupled loot bias in live scatter loot.
- Biome-coupled prop palette in live procgen.

Evidence:

- `packages/shared/content/biomes/*.json`
- `packages/shared/content/enemies/*.json`
- `packages/server/src/procgen.ts`
- `packages/server/src/world.ts`

### Asset Generation Runtime Integration

Status: service implemented, live client integration disabled/partial.

Implemented:

- `@dumrunner/asset_gen` HTTP service.
- Generate, prewarm, job polling, approved asset index, asset serving, and viewer endpoints.
- OpenAI image provider and placeholder provider exist.
- Animation-sheet pipeline exists.
- Server calls `ensureEnemyAsset`, `ensureBuildingAsset`, and `ensureMaterialAsset` on relevant runtime events if `ASSET_GEN_URL` is configured.

Stubbed/disabled:

- Client `loadAssetIndex` always returns an empty index and documents asset_gen as disabled while manual texture overrides are used.
- Server-side enemy prompt labels are missing newer `flame_drone` and `chem_bloater` labels, so they fall back to generated snake-case labels.
- Building label prewarm also has known label gaps per GDD pending work.
- No push notification from asset service to clients when assets become ready.

Evidence:

- `packages/asset_gen/src/server.ts`
- `packages/asset_gen/src/service.ts`
- `packages/asset_gen/src/providers/openaiImage.ts`
- `packages/server/src/assetGenClient.ts`
- `packages/client/lib/assetGen.ts`

### Discord Integration

Status: implemented for auth/activity room flow; external portal config is outside repo.

Implemented:

- Web OAuth button paths exist.
- Discord Activity entry page exists.
- Activity instance binds to a server row.
- Activity-bound servers are hidden from public lobby.
- Iframe cookie strategy is implemented in Supabase server client.
- `/game-ws` URL rewrite support exists for Discord.

Partial/external:

- Discord Developer Portal URL mappings and app verification are not codebase state.
- Account linking between an existing email account and Discord is called out as later work in docs.

Evidence:

- `packages/client/app/discord/page.tsx`
- `packages/client/app/api/discord/instance/route.ts`
- `packages/client/app/api/auth/discord/*`
- `packages/client/lib/discord/*`
- `packages/client/lib/supabase/server.ts`
- `supabase/migrations/0007_servers_discord_instance.sql`
- `supabase/migrations/0008_servers_public_hide_discord.sql`
- `docs/discord-integration.md`

## Not Started

### Runtime Props System

Status: not started at runtime.

Not implemented:

- `PropState` in wire protocol.
- `props` in `welcome` / `scene_changed`.
- `prop_damaged` / `prop_destroyed` messages.
- `PROP_REGISTRY` runtime module.
- Server-side prop entities.
- Prop spawn pass in procgen.
- Prop projectile/melee collision.
- Explosive-barrel AoE/chaining.
- Prop loot drops.
- Prop rendering in top-down/iso/FPS.
- Texture editor `prop` category.

Existing pieces:

- `PropDef` schema exists.
- Decorator editor form exists.
- `packages/shared/content/props` exists but has no prop JSON entries.

Evidence:

- `packages/shared/src/content/types.ts`
- `packages/client/app/editor/decorators/page.tsx`
- `packages/shared/content/props/.gitkeep`
- absence from `packages/shared/src/protocol.ts`

### Environmental Hazards, Resists, Traps, Detection, Stealth

Status: not started.

Not implemented:

- Heat/radiation/cold/toxic resist fields on live suit parts.
- Hazard tick derived from biome/depth.
- Environmental damage clock.
- Kinetic/electric/acid trap entities.
- Trap persistence/sprung state.
- Trap mitigation through plating.
- Sound/light/heat signature detection stats.
- Stealth utility mods that affect enemy detection.

Evidence:

- `CarriedPart` has no resist fields in `packages/shared/src/protocol.ts`.
- `computeSuitStats` has no hazard/damage resist outputs in `packages/shared/src/inventory.ts`.
- `Scene`/`World` contain no environmental hazard tick path.
- `procgen.ts` has no trap generation.

### Dungeon Banding, Infinite Biome Rotation, Champions

Status: not started.

Not implemented:

- Bands of roughly five floors.
- Independent biome roll per band at perihelion.
- Known-band planning UI at base.
- Absolute-depth loot tier table as described in GDD.
- Mk4 saturation beyond floor 20 by biome/champion rules.
- Fifth-floor faction champion per band.
- Artifact reliability from champions.
- Faction champion/boss enemy templates.

Current substitute:

- Enemy and scatter loot weights scale by floor ranges in `DEPTH_WEIGHTS` and `LOOT_WEIGHTS`.

Evidence:

- `packages/server/src/procgen.ts`
- `packages/server/src/ai/templates.ts`

### WFC Procgen And Per-Tile Sprite Support

Status: not started.

Not implemented:

- WFC generator.
- Tile adjacency/content rules.
- Backtracking/propagation.
- Per-biome tile texture category.
- Renderer per-tile sprite support driven by `BiomeDef.tileTextures`.
- Rectangular-generator fallback flag per biome.

Current substitute:

- Rectangular rooms and corridors are live.

Evidence:

- `packages/server/src/procgen.ts`
- `packages/client/lib/game/pixi.ts`
- `packages/client/lib/game/iso.ts`
- `packages/client/lib/game/fps.ts`

### Full Part-Ontology Weapon And Suit Assembly

Status: not started for the GDD's complete ontology.

Not implemented:

- Dropped weapon frame/barrel/grip/magazine parts as actual assembly requirements.
- A weapon item composed from separate dropped part ids.
- Weapon frame determining fire mode, recoil, mod slots, swap speed, hands required.
- Barrel/grip/magazine base-stat composition as separate part stats.
- Suit chassis weight classes: light/medium/heavy.
- Plating class-lock to chassis weight.
- Cargo grid W x H shape.
- Utility mod slot arrays from chassis.
- Multiple suits per character and loadout swapping.
- Alien-tier parts from artifact analysis.

Current substitute:

- Weapons are base chassis items plus crafted attachment instances.
- Suit equipment is one part per slot with stat bonuses and optional suit-affix attachments.
- Attachments and rolled affixes are the alpha foundation of the future ontology.

Evidence:

- `packages/shared/src/inventory.ts`
- `packages/shared/src/weaponStats.ts`
- `packages/server/src/world.ts`

### Earth Trade Tree And Artifact Fates

Status: mostly not started.

Implemented:

- Artifact Uplink can buy blueprints.
- Artifact Uplink can buy keys.
- Per-cycle blueprint set exists.

Not implemented:

- Ship artifact to Earth.
- Server-wide Earth tech-tree unlocks.
- Burn artifact as ingredient as a distinct Uplink fate.
- Alien-tier part generation/analyze flow.
- Blueprint progression DAG/tree UI.
- Persistent legendary blueprints actually granted/persisted.

Evidence:

- `packages/shared/src/crafting.ts`
- `packages/server/src/world.ts`
- `packages/client/app/play/[id]/Game.tsx`

### Station Upgrades Beyond Weapon Bench

Status: not started.

Not implemented:

- Upgrading arbitrary stations for more parallel slots.
- Advanced station kinds with more slots.
- Industrial Workbench or equivalent.
- Station-tier requirements on recipes.
- Blueprint tree tied to station tiers.

Current substitute:

- `BUILDING_REGISTRY` has static `parallelSlots`.
- Weapon Bench tier exists, but it gates weapon assembly only.

Evidence:

- `packages/shared/src/buildings.ts`
- `packages/shared/src/crafting.ts`

### Mobile And Wrapper Distribution

Status: not started.

Not implemented:

- Touch/mobile controls.
- Capacitor wrapper.
- Electron/Tauri desktop wrapper.
- Steam packaging.
- itch.io page assets are not codebase-managed here.

Evidence:

- No Capacitor/Electron/Tauri config files.
- No mobile-control component or touch input path found in client app.

### Other Deferred Gameplay Polish

Status: not started or intentionally deferred.

Not implemented:

- Wall repair action.
- Manual loot pickup.
- Loot drop TTL tuning beyond current 90 seconds.
- Abandon corpse option.
- Demolish confirmation for high-value buildings.
- Melee customization with its own pieces/mods/tier-up.
- Rich heavy projectile variants.
- Comprehensive pixel-art/animation coverage.

Evidence:

- GDD "Deferred past alpha" list.
- Current code paths in `packages/server/src/scene.ts`, `packages/shared/src/weaponStats.ts`, and `packages/client/app/play/[id]/Game.tsx`.

## Important Mismatches With The GDD

- The GDD says a shared co-op dungeon has async rejoin where rejoining players must traverse down floor-by-floor. Current implementation makes the surface Power Link descend directly to the deepest reached floor. This appears to supersede the older GDD text because the Power System section explicitly describes frontier fast-travel.
- The GDD's "server process spins down when idle" is not actually implemented. The world stops timers and logs that it "would shut down here."
- The GDD's "game-server registry" table/controller is represented only by an in-process registry in this codebase.
- The GDD's server browser filters are not implemented.
- The GDD's texture editor says a prop category should be added; current texture API only allows `enemy` and `building`.
- The content editor suite is further along than "planned" in some ways: schemas, routes, JSON files, and forms exist. But live game consumption is not wired yet.
- The live combat roster is beyond the GDD's four ranged plus knife alpha list: sniper, heavy, energy, sword, hammer, energy blade, and status-effect mods are present.
- The GDD's "props planned" section has schema/prose, but no runtime protocol/entity implementation.

## Highest-Leverage Next Work

1. Wire JSON enemy content into the server as a read-only boot registry or explicitly mark the JSON as editor-only until E3.1. Right now there are two enemy sources of truth.
2. Add biome assignment to dungeon scene creation using existing biome JSON. Even before WFC, palette/roster/loot-bias use would make the dungeon roadmap tangible.
3. Decide whether `asset_gen` is paused or reactivated. The service exists, but the client index is deliberately disabled.
4. Add prop protocol/runtime only after biome assignment, because props need biome palettes to avoid hand-placed generic clutter.
5. Implement lobby filters/current occupancy if public playtesting is a near-term goal.
