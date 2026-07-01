// Wire protocol between the browser client and the websocket game server.
// Both sides must agree on these types.
//
// Client → Server messages are validated at runtime via Zod (see schemas at
// the bottom of this file). Server → Client messages stay TypeScript-only;
// the client trusts the server.

import { z } from 'zod';
import type { BlueprintCatalogEntry, Recipe } from './crafting';
import type { BaseLayoutDef, WeaponDef } from './content/types';
import type { AttachmentDef, AttachmentStatRanges } from './inventory';
import type { Equipment, Inventory, InventorySlot, MaterialKind } from './inventory';

// ---------- Parts (loot / inventory) ----------
// Subset of the GDD part ontology — enough to flow loot from kill to inventory.
// Stats and affix details land here once crafting/equipping comes online.

export type PartSlot =
  | 'barrel'
  | 'frame'
  | 'grip'
  | 'magazine'
  | 'weapon_mod'
  | 'chassis'
  | 'plating'
  | 'life_support'
  | 'utility_mod'
  | 'cargo_grid';

export type PartTier = 'Mk1' | 'Mk2' | 'Mk3' | 'Mk4' | 'Alien';

export type WeaponClass =
  | 'pistol'
  | 'smg'
  | 'rifle'
  | 'shotgun'
  | 'sniper'
  | 'heavy'
  | 'energy';

// One rolled affix on a CarriedPart. `id` matches an entry in AFFIX_DEFS;
// `value` is the rolled magnitude (already tier-scaled). Display text
// comes from AFFIX_DEFS[id].label(value).
export type Affix = {
  id: string;
  value: number;
};

export type CarriedPart = {
  id: string;
  slot: PartSlot;
  tier: PartTier;
  // Class-locked weapon parts (barrel/frame/grip/magazine) carry a class.
  // Universal slots (weapon_mod, all suit slots) leave this null.
  weaponClass: WeaponClass | null;
  // Number of randomly rolled affix slots. Mirrors affixes.length for
  // legacy parts that pre-date the real-rolls system.
  affixCount: number;
  // Real rolled affixes. Optional so DB-loaded inventories from before
  // affix rolling shipped don't fail to deserialize; treated as [] when
  // missing.
  affixes?: Affix[];
  // Crafted suit-affix attachment instances glued onto this part.
  // Each entry is a unique rolled instance, not a class id, so
  // detaching returns the same rolled stats to inventory. Slots
  // gained at the workbench are baked here. Stacks with rolled
  // affixes. Older saves that stored plain string defIds get
  // migrated on character hydrate (see worldsnapshot migration).
  appliedAttachments?: import('./inventory').AttachmentInstanceFwd[];
  // Life-support only: which hazard kind this part specialises
  // against (highest resist roll). The other 3 hazards roll the
  // off-coverage value at the same tier. Pre-E3.3 saves omit this
  // field; the resist computation in inventory.ts falls back to
  // `defaultSpecialtyForPartId` (deterministic from the part id)
  // so legacy parts still produce sensible numbers.
  specialtyHazard?: 'heat' | 'radiation' | 'cold' | 'toxic';
};

// Active timed buff/debuff on a player. Server tracks the
// authoritative list per connection; clients receive a `player_effects`
// broadcast for HUD rendering of buff timers. Stims/overcharge/medkit
// tiers are the first consumers; future hazard ticks (radiation,
// poison) and environmental ammo (burn, slow, EMP) attach effects
// of the same shape.
export type PlayerEffectKind =
  | 'speed_mult'        // multiplicative move-speed bonus, magnitude = +N (0.30 = +30%)
  | 'stamina_regen_add' // flat stamina/sec added to regen
  | 'shield_flat'       // flat extra max shield while active
  | 'hp_max_flat'       // flat extra max hp while active
  | 'burn_dps'          // damage per second while active (incendiary)
  | 'poison_dps'        // damage per second while active (chem)
  | 'slow_pct';         // % movement slow (chem). magnitude = +N (0.25 = -25% speed)

export type PlayerEffect = {
  // Stable id within a connection. Same id refreshes the timer
  // instead of stacking, so back-to-back stims extend duration.
  id: string;
  kind: PlayerEffectKind;
  magnitude: number;
  expiresAt: number;
  // Display label for HUD tooltips (e.g. 'Stim', 'Overcharge').
  label: string;
};

// Loot on the ground. Discriminated by `content.kind`:
//   - 'part'     : a CarriedPart (legacy enemy-drop behaviour).
//   - 'material' : a stack of a MaterialKind (scavenged components).
//   - 'slot'     : a generic dropped inventory slot — used for the
//                  "drop item from your bag" action so weapons,
//                  consumables, attachments, etc. can land on the
//                  ground without inventing a new variant for each.
// New variants slot in here; the client renders by `content.kind`.
export type LootContent =
  | { kind: 'part'; part: CarriedPart }
  | { kind: 'material'; materialId: MaterialKind; count: number }
  | { kind: 'slot'; slot: InventorySlot };

export type LootState = {
  id: string;
  content: LootContent;
  x: number;
  y: number;
};

// A corpse is what's left when a player dies in a scene. Holds the full
// inventory the player was carrying. Anyone can recover it (including the
// owner) via proximity pickup; the corpse despawns when looted, or at
// perihelion (cycle reset) if untouched.
export type CorpseState = {
  id: string;
  ownerCharacterId: string;
  ownerDisplayName: string;
  x: number;
  y: number;
  // Snapshot of the player's slot-based inventory at time of death. Looter
  // gets all non-empty slots transferred into their own inventory.
  inventory: Inventory;
};

// Static layout for a scene. Surface scenes have no layout (open world,
// camera follows player). Dungeon floor scenes ship a list of walkable
// rectangles (rooms + corridors); anything outside those AABBs is wall.
//
// Players can only stand inside walkable rects — the server enforces this
// via collision; the client uses the same data to render the floor.
export type Rect = { x: number; y: number; w: number; h: number };

export type InteractableKind = 'stairs_down' | 'extract_pad' | 'dm_spawn';

// Server world mode. `live` is the canonical game (surface base,
// dungeon, perihelion, no PvP). `sandbox` is a single-client
// editor playtest session (no surface, no persistence, no horde).
// `deathmatch` is a PvP arena bound to a single authored scene
// — no surface, no dungeon, no perihelion, but PvP damage is on
// and players respawn at `dm_spawn` interactables.
export type WorldMode = 'live' | 'sandbox' | 'deathmatch';

export type Interactable = {
  id: string;
  kind: InteractableKind;
  x: number;
  y: number;
  // Visible label shown when the player is in range.
  label: string;
};

// ---------- Async craft jobs ----------
// Recipes whose Recipe.craftTimeMs > 0 don't materialize instantly — they
// queue as a CraftJob at a workstation. Server holds the truth; client
// renders progress bars from these.
//
// `completesAt > 0` means the job is active (currently being worked).
// `completesAt === 0` means it's queued behind another job at the same
// station; the server promotes the oldest queued job when an active
// one finishes.
export type CraftJobState = {
  id: string;
  recipeId: string;
  characterId: string;
  // The station kind this job runs at. Currently informational; future
  // rules (e.g. "destroying the station cancels its jobs") use it.
  stationKind: 'workbench' | 'forge' | 'electronics_bench' | 'weapon_bench';
  // The specific station building running the job. Each station has its
  // own parallel-slot budget; jobs are bound to the building so multiple
  // stations of the same kind work as parallel queues.
  stationBuildingId: string;
  // Epoch ms. 0 if the job is queued (not yet started).
  startedAt: number;
  // Epoch ms. 0 if the job is queued.
  completesAt: number;
  // FIFO order across queued jobs at the same station. Newer jobs get
  // a higher value. Set on enqueue; doesn't change on promote.
  queueIndex?: number;
};

// ---------- Buildings (player-placed structures) ----------
// Defenses (wall, turret), crafting stations (workbench, forge,
// electronics_bench), and — later — storage / artifact uplink. All share the
// BuildingState shape and tile placement model.
export type BuildingKind =
  | 'wall'
  | 'wall_mk2'
  | 'wall_mk3'
  | 'wall_mk4'
  | 'turret'
  | 'turret_smg'
  | 'turret_shotgun'
  | 'turret_rifle'
  | 'workbench'
  | 'forge'
  | 'electronics_bench'
  | 'weapon_bench'
  | 'precision_mill'
  | 'suit_bench'
  | 'artifact_uplink'
  | 'power_link'
  | 'door'
  | 'wall_door'
  | 'storage_chest'
  // Procgen-spawned portal buildings, one per dungeon scene each.
  // stairs_down occupies the deepest room's centre tile; extract_pad
  // the entrance room's pad tile. They share their world position
  // with the same-named Interactable so E-press still resolves via
  // the existing interactable code path. Indestructible (high HP,
  // hordePriority 0) and dungeon-only — the surface descent uses
  // the power_link building instead.
  | 'stairs_down'
  | 'extract_pad';

// Subset of BuildingKind that acts as a crafting workstation. Recipes can
// require the player to be in range of one of these to craft.
export type WorkstationKind =
  | 'workbench'
  | 'forge'
  | 'electronics_bench'
  | 'weapon_bench';
export const WORKSTATION_KINDS: WorkstationKind[] = [
  'workbench',
  'forge',
  'electronics_bench',
  'weapon_bench',
];
export function isWorkstationKind(k: BuildingKind): k is WorkstationKind {
  return (
    k === 'workbench' ||
    k === 'forge' ||
    k === 'electronics_bench' ||
    k === 'weapon_bench'
  );
}

export type BuildingState = {
  id: string;
  kind: BuildingKind;
  // Tile coordinates. Pixel position = tile * sceneLayout.tileSize.
  // Buildings always occupy whole tiles.
  tileX: number;
  tileY: number;
  // Footprint in tiles. 1×1 for walls; multi-tile structures will use larger.
  width: number;
  height: number;
  hp: number;
  maxHp: number;
  // Workstation output buffer. Completed craft jobs deposit their output
  // here; the player picks them up at the station modal. Non-station
  // buildings leave this empty / undefined.
  output?: InventorySlot[];
  // Per-bench tier (Phase 2). Currently only meaningful on
  // weapon_bench: 1-4. A Mk1 bench can only assemble Mk1 weapons;
  // higher tiers are unlocked by applying a Bench Upgrade item
  // crafted at the Forge. Undefined for non-bench buildings.
  benchTier?: 1 | 2 | 3 | 4;
  // Door state — only meaningful on the `wall_door` kind. Open
  // doors don't block movement / projectiles. Undefined on every
  // other building kind.
  open?: boolean;
  // Turret mount binding (base layouts P3). Only meaningful on turret
  // kinds: the index into the active layout's `turretMounts` this
  // turret occupies. The occupied-mount set is DERIVED from these
  // fields (never stored separately) so it can't drift; a destroyed
  // turret frees its mount automatically. Undefined on non-turrets
  // and on legacy turrets placed before mounts existed.
  mountIndex?: number;
};

// Per-cell tile id grid for the dungeon floor. Phase 1 of E3.4.
//
// Each cell carries a single byte tile id (0 = void / out of bounds,
// 1..N = biome-defined). The biome's `tileSet` (on BiomeDef) maps
// each id to its TileDef which carries walkable / blocksLOS / etc.
//
// Wire encoding: `tilesB64` is the base64 of the underlying byte
// array. JSON.stringify on a Uint8Array would expand to a per-index
// object; base64 is ~5 KB for a typical 70×70 dungeon.
//
// Origin: (originTileX, originTileY) is the tile-space coord of cell
// (0, 0). World-space cell origin = (originTileX*tileSize, originTileY*tileSize).
//
// Phase 1 keeps the legacy `walkables[]` field on SceneLayout
// populated alongside this grid — collision still resolves through
// walkables for now. The grid is consumed by renderers for wall /
// floor lookup. A future phase will switch collision to the grid
// and remove walkables[].
export type TileGrid = {
  width: number;
  height: number;
  originTileX: number;
  originTileY: number;
  tileSize: number;
  tilesB64: string;
};

// Spawn directives emitted by stamped room templates. Anchors land
// at world-coord positions translated from a template's tile-local
// `(tx, ty)`. Server resolves them into enemies / props / loot /
// interactables when the scene initializes; client may overlay
// them for debug.
export type SceneAnchor = {
  kind:
    | 'spawn'
    | 'extract'
    | 'stairs_down'
    | 'enemy'
    | 'prop'
    | 'loot'
    | 'door'
    | 'entry';
  x: number;
  y: number;
  // Optional override id — when set, server uses it instead of
  // rolling from the biome roster / palette.
  overrideId?: string;
};

// A doorway portal punched between two adjacent regions by the
// procgen assembler. The opening lies on the shared-edge line at
// `coord` (x for vertical edges, y for horizontal), spanning
// [lo, hi] in world units along the other axis. `a` / `b` are
// region indices (parallel to SceneLayout.rooms); the corridor
// flags let consumers pick which side of the boundary a door
// building should occupy.
export type DoorwaySpec = {
  axis: 'vertical' | 'horizontal';
  coord: number;
  lo: number;
  hi: number;
  a: number;
  b: number;
  aIsCorridor: boolean;
  bIsCorridor: boolean;
};

export type SceneLayout = {
  worldBounds: Rect;
  // Walkables = rooms ∪ corridors. Player position must lie inside ≥ 1.
  walkables: Rect[];
  // Just the rooms (subset of walkables). Used for placing enemies / props
  // that should sit in a room rather than a corridor.
  rooms: Rect[];
  // Where new arrivals spawn. Used for transition target positioning.
  spawn: { x: number; y: number };
  // Explicit player Z when dropping the player into this scene.
  // When undefined, the server uses `spawnFloorAt(spawn.x, spawn.y)`
  // (lowest walkable sector containing the spawn point). Authors
  // set this when they want to pin the player to a specific
  // sector floor (e.g. a platform, or "always start on the room
  // floor even when standing inside a pit's polygon").
  spawnZ?: number;
  // Stairs / extract pads as named entities the client can render and the
  // server can detect proximity against.
  interactables: Interactable[];
  // Pixel size of one grid tile. Walkable rect dimensions are integer
  // multiples of this. Surface ships 0 (open scene, no grid).
  tileSize: number;
  // Biome assigned to this floor — drives renderer palette + the
  // server-side spawn picker's enemy roster. The id matches a
  // BiomeDef.id authored under packages/shared/content/biomes/.
  // 'default' is the safe / surface starter biome (no hazard).
  biome: string;
  // Per-room hazard zone category, parallel to `rooms`. Procgen
  // tags every room with one of 'safe' / 'hazard' / 'extreme'
  // (corridors are uniformly the 'corridor' category — flat per
  // GDD design choice). The hazard tick on the server resolves
  // a player's current room → category → intensity → DPS via the
  // biome's hazardZoneIntensities table. Optional so pre-E3.3
  // snapshots (no per-room categories baked in) don't fail to
  // deserialize; absent ⇒ treat every room as 'hazard'.
  roomCategories?: Array<'safe' | 'corridor' | 'hazard' | 'extreme'>;
  // Per-tile id grid. Optional during the migration — pre-tile-grid
  // snapshots omit it; renderers fall through to the walkables-based
  // path when absent.
  tileGrid?: TileGrid;
  // Scene-level seed for stable per-cell variant picks. Server mixes
  // (worldSeed, cycle, floorIndex) → 32-bit value; renderers hash it
  // with (cellX, cellY) to pick wall / floor texture variants from
  // the biome's TileDef.textureIds list. Optional — absent ⇒
  // single-variant or palette-only render.
  variantSeed?: number;
  // Anchors emitted by stamped room templates. Server reads them
  // to drive enemy / prop / loot / interactable spawns. Optional —
  // absent ⇒ floors generated by the rect-only fallback path with
  // random scatter spawns.
  anchors?: SceneAnchor[];
  // Adjacency list: roomGraph[i] = indices of rooms reachable from
  // rooms[i] via a single corridor. Set by tunneling procgen so
  // server-side logic (e.g. locked-room placement) can ask
  // "if I remove this room, is entrance still connected to stairs?"
  // Optional — surface scenes have no rooms, walker biomes might
  // not produce a discrete graph.
  // (DoorwaySpec for the `doorways` field below is declared right
  // before SceneLayout.)
  roomGraph?: number[][];
  // Punched doorway portals between adjacent regions, recorded by
  // the assembler so downstream logic (locked-room door placement)
  // can put door buildings exactly where the openings are instead
  // of re-deriving shared edges. World units; the portal lies on
  // the shared-edge line `coord`, spanning [lo, hi] along the
  // other axis. Optional — rect-only fallback layouts don't set it.
  doorways?: DoorwaySpec[];
  // Axis-aligned raised platforms. Each rect specifies a tile-
  // aligned footprint and a `floorZ` height above the base room
  // floor (which is always 0). Multiple platforms at different
  // heights compose stairs — one tile per riser. Server uses
  // these for step-up collision; v2 renderer emits sectors with
  // the raised floor and auto-renders the side walls as risers.
  // v1 (raycaster) ignores the field — it renders flat anyway.
  // Optional — absent ⇒ no raised geometry, same as today.
  platforms?: PlatformRect[];
  // Optional procedural terrain heightmap. When set, the scene's
  // floor undulates per `terrainHeightAt(terrain, x, y)`. Server
  // simulates against it (player rises / falls with the ground,
  // sprites anchor to it). v1 raycaster ignores; v2 tessellates
  // the floor mesh and displaces vertices.
  // See @dumrunner/shared/terrain for the noise impl + tuning.
  terrain?: import('./terrain').TerrainConfig;
  // Base-layout free-build capacity (surface only). Caps how many
  // workstation / storage / wall buildings the player can place on the
  // pad; turrets are mount-gated (not counted here), doors are uncapped.
  // Server enforces; client uses it for the build HUD used/max.
  baseCapacity?: { workstations: number; storage: number; walls: number };
  // Turret mount sockets (surface only, base layouts P3). WORLD
  // coordinates, computed in world.ts from the active layout's
  // `turretMounts` offsets + the clearing centre (Power Link pos).
  // Index into this array is the `mountIndex` a placed turret records.
  // Client renders free mounts as socket pads and snaps the turret
  // build ghost to the nearest free mount. Optional — absent ⇒ no
  // mounts (non-surface scenes, layouts with no mounts).
  turretMounts?: { x: number; y: number }[];
  // Hand-authored sector geometry. When present, server polygon
  // collision + v2 renderer both consume this DIRECTLY instead
  // of rebuilding a SectorMap from `tileGrid`. Authored scenes
  // (from the level editor) ship this so non-axis-aligned
  // polygons survive end-to-end. The tile grid still rides
  // along for AI passability + the legacy v1 renderer; it's a
  // rasterised approximation of the authored shapes.
  authoredSectorMap?: import('./sector').SectorMap;
};

// Raised floor footprint. Tile coords are absolute (same frame
// as `Rect` and `Interactable.x/y`'s tile equivalent), not local
// to a containing room. floorZ is in world units (wall = 32);
// typical step is 8–12. Overlapping rects resolve to the
// highest floorZ via `floorAt(x, y)` lookup.
export type PlatformRect = {
  tileX: number;
  tileY: number;
  w: number;
  h: number;
  floorZ: number;
};

export type Player = {
  characterId: string;
  accountId: string;
  displayName: string;
  x: number;
  y: number;
  // Vertical-movement state. `z` is the ABSOLUTE world-z of the
  // player's feet (grounded ⇒ z === floor height at x,y);
  // `crouching` halves the eye / hitbox height. Optional so
  // welcome / state messages from older servers still deserialize.
  z?: number;
  crouching?: boolean;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  shield: number;
  maxShield: number;
  alive: boolean;
};

// Enemy `kind` is the template id from the server-side template library.
// The client uses it to pick a visual; new templates can be added without a
// protocol bump.
export type EnemyKind = string;

export type EnemyState = {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
};

// Decorator props (barrels, crates, conduits, …). Static
// position + HP. `kind` cross-references PropDef.id authored
// under packages/shared/content/props/. Renderers use it for
// the visual + texture-override lookup; server uses it for
// the destruction behaviour (drop_loot / explode).
export type PropState = {
  id: string;
  kind: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  // Container-only fields (PropDef.container). Tile-aligned
  // footprint is the cell rect the cube occupies; heightMult is
  // the vertical extent (0..1 of a wall). `opened` flips when
  // the player E-interacts; renderer swaps to the open-variant
  // textures. Absent on non-container props.
  tileX?: number;
  tileY?: number;
  tileWidth?: number;
  tileDepth?: number;
  heightMult?: number;
  opened?: boolean;
  // True when the container has at least one item left. Drives
  // the closed-vs-empty visual swap independently of opened —
  // an opened-then-emptied container reads as empty.
  hasItems?: boolean;
};

export type ProjectileOwnerKind = 'player' | 'enemy';

export type ProjectileState = {
  id: string;
  ownerCharacterId: string;       // characterId for player-owned, enemy id for enemy-owned
  ownerKind: ProjectileOwnerKind;
  x: number;
  y: number;
  // World-Z position + vertical velocity. Optional so pre-
  // Phase-7 clients can still deserialise; absent → treat as
  // 0 (flat shot at floor level). Server populates both for
  // every projectile.
  z?: number;
  vz?: number;
  vx: number;
  vy: number;
  // Optional client-render hint (RGB int). Hardcoded white if omitted.
  color?: number;
  // Which weapon spawned this projectile. Used by the client to
  // resolve a sprite override for the projectile billboard:
  //   1. ('projectile', weaponId)          — per-weapon override
  //   2. ('projectile', WEAPON_FAMILY[id]) — family fallback
  //   3. flat-color fill                   — procedural default
  // Server populates this for player-fired projectiles; turrets +
  // enemy fire leave it unset and fall through to the color path.
  weaponId?: string;
};

// ---------- Client → Server ----------
//
// Schemas are the source of truth. ClientMessage is derived from the
// discriminated union below so adding a new message type only requires
// editing one place.

const finiteNumber = z.number().finite();
// Direction / movement vector components. Clients send unit-ish
// vectors; bound the magnitude so a hostile client can't feed
// huge components into downstream math (normalisation divides by
// length, but intermediate squares can overflow precision).
const unitishNumber = z.number().finite().min(-8).max(8);

export const AuthMsgSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1).max(4096),
  protocolVersion: z.number().int(),
});

// Input intent. Replaces absolute-position 'move' messages: client now sends
// its desired movement vector (-1..1 per axis) and the server runs the actual
// simulation. Server clamps + normalises.
export const InputMsgSchema = z.object({
  type: z.literal('input'),
  moveX: unitishNumber,
  moveY: unitishNumber,
  sprint: z.boolean(),
  // Phase 7 vertical inputs. `jump` is edge-triggered (true on
  // press, the server consumes it once). `crouch` is held. Both
  // optional — older clients omitting them treat as released.
  jump: z.boolean().optional(),
  crouch: z.boolean().optional(),
});

export const FireMsgSchema = z.object({
  type: z.literal('fire'),
  dirX: unitishNumber,
  dirY: unitishNumber,
  // Pitch-aware vertical aim. Optional so older clients still
  // fire (Phase 7 added this); server defaults to 0 (level) when
  // absent. Sent as the un-normalised Z component of the
  // camera's forward vector — server normalises the full vec3.
  dirZ: unitishNumber.optional(),
});

// Closed set of BuildingKinds that players are allowed to place
// via the build UI. Excludes procgen-only structures
// (stairs_down, extract_pad) — those are spawned by the server,
// never requested over the wire.
const BuildingKindSchema = z.enum([
  'wall',
  'wall_mk2',
  'wall_mk3',
  'wall_mk4',
  'turret',
  'turret_smg',
  'turret_shotgun',
  'turret_rifle',
  'workbench',
  'forge',
  'electronics_bench',
  'weapon_bench',
  'precision_mill',
  'suit_bench',
  'artifact_uplink',
  'power_link',
  'door',
  'wall_door',
  'storage_chest',
]);
// Player-buildable kinds, derived from the wire schema so the
// type stays in lock-step with the validator.
export type PlaceableBuildingKind = z.infer<typeof BuildingKindSchema>;

export const BuildRequestMsgSchema = z.object({
  type: z.literal('build_request'),
  kind: BuildingKindSchema,
  // Bounded so a hostile client can't send coordinates that only
  // fail via IEEE-754 overflow in downstream distance math.
  tileX: z.number().int().min(-100000).max(100000),
  tileY: z.number().int().min(-100000).max(100000),
});

export const DemolishRequestMsgSchema = z.object({
  type: z.literal('demolish_request'),
  buildingId: z.string().min(1).max(64),
});

export const SelectHotbarMsgSchema = z.object({
  type: z.literal('select_hotbar'),
  slot: z.number().int().min(0).max(8),
});

// Generous ceiling for slot indices — inventory base is 36 (9 hotbar
// + 27 bag) but the cargo_grid suit slot can grow it well past that
// (Alien-tier cargo grid adds 48). Server-side handlers always
// re-check the actual `conn.inventory.length` so a value past the
// real bag size is silently rejected; this Zod cap just keeps wildly
// out-of-range numbers off the wire.
const slotIndex = z.number().int().min(0).max(127);

export const InventorySwapMsgSchema = z.object({
  type: z.literal('inventory_swap'),
  from: slotIndex,
  to: slotIndex,
});

export const InventoryDiscardMsgSchema = z.object({
  type: z.literal('inventory_discard'),
  slot: slotIndex,
  all: z.boolean(),
});

export const InventorySortMsgSchema = z.object({
  type: z.literal('inventory_sort'),
});

const SuitSlotSchema = z.enum([
  'chassis',
  'plating',
  'life_support',
  'utility_mod',
  'cargo_grid',
]);

export const EquipRequestMsgSchema = z.object({
  type: z.literal('equip_request'),
  fromInventoryIdx: slotIndex,
  suitSlot: SuitSlotSchema,
});

export const UnequipRequestMsgSchema = z.object({
  type: z.literal('unequip_request'),
  suitSlot: SuitSlotSchema,
  toInventoryIdx: slotIndex.optional(),
});

export const InteractMsgSchema = z.object({
  type: z.literal('interact'),
  interactableId: z.string().min(1).max(64),
});

export const CraftRequestMsgSchema = z.object({
  type: z.literal('craft_request'),
  recipeId: z.string().min(1).max(64),
});

export const PurchaseBlueprintMsgSchema = z.object({
  type: z.literal('purchase_blueprint'),
  blueprintId: z.string().min(1).max(64),
});

// Player builds/activates a base layout at the Power Link's Base tab
// (base-layouts P4). Server validates: layout exists; its blueprint is
// known (or null = starter); player on the surface in range of the
// Power Link; player holds the layout's component cost. Runs the
// clone-validate-commit swap transaction (re-seat / refund buildings,
// transfer the Power Link) and rebroadcasts the surface scene.
export const SetBaseLayoutMsgSchema = z.object({
  type: z.literal('set_base_layout'),
  layoutId: z.string().min(1).max(64),
});

// Player buys keys at an artifact uplink. Flat per-key artifact cost
// (KEY_ARTIFACT_COST in inventory.ts). Server validates proximity +
// affordability; consumes artifacts and adds keys to inventory.
export const PurchaseKeyMsgSchema = z.object({
  type: z.literal('purchase_key'),
  count: z.number().int().min(1).max(10),
});

// Player picks up everything in the output buffers of nearby stations of
// the given kind. Server validates proximity; output stacks merge into
// the player's inventory.
export const PickupStationOutputsMsgSchema = z.object({
  type: z.literal('pickup_station_outputs'),
  kind: z.enum(['workbench', 'forge', 'electronics_bench', 'weapon_bench']),
});

// Player tries to open a locked door. Server validates proximity + that
// the player has a key in inventory; consumes one key and removes the
// door building so the room is enterable.
export const OpenDoorMsgSchema = z.object({
  type: z.literal('open_door'),
  buildingId: z.string().min(1).max(64),
});

// E5: open a container prop. Server validates range, flips
// prop.opened (broadcast), and ships the prop's inventory privately
// to the opener via prop_inventory_changed.
export const OpenContainerMsgSchema = z.object({
  type: z.literal('open_container'),
  propId: z.string().min(1).max(64),
});

// Take a single inventory slot from a container into the player's
// own inventory. Server validates range + that prop.opened is true;
// stack-merges into the player's grid and re-ships the container
// inventory to the player.
export const ContainerTakeMsgSchema = z.object({
  type: z.literal('container_take'),
  propId: z.string().min(1).max(64),
  // Container grids are small (8 slots) but bound generously so
  // future variants don't require a protocol bump.
  slot: z.number().int().min(0).max(63),
});

// ---------- weapon bench actions ----------
// All of these require the player to be in range of a weapon_bench
// building on the surface. Server validates each action against the
// rolled state of the target weapon (tier, slots, family compatibility)
// and the inventory contents.

const WEAPON_PIECE_KINDS = z.enum(['frame', 'grip', 'magazine', 'barrel']);
const SUIT_SLOT_KINDS_SCHEMA = z.enum([
  'chassis',
  'plating',
  'life_support',
  'utility_mod',
  'cargo_grid',
]);

// Player attaches a weapon affix (piece-bound) to a weapon. Server reads
// the attachment def to confirm it's a weapon_affix, the weapon's tier
// permits that piece, and the piece is empty.
export const AttachWeaponAffixMsgSchema = z.object({
  type: z.literal('attach_weapon_affix'),
  weaponInventoryIdx: slotIndex,
  pieceKind: WEAPON_PIECE_KINDS,
  attachmentDefId: z.string().min(1).max(64),
});

// Detach a piece affix; the affix returns to inventory as a stack.
export const DetachWeaponAffixMsgSchema = z.object({
  type: z.literal('detach_weapon_affix'),
  weaponInventoryIdx: slotIndex,
  pieceKind: WEAPON_PIECE_KINDS,
});

// Attach a weapon mod (free slot, not piece-bound). Server checks the
// weapon's tier mod-slot count.
export const AttachWeaponModMsgSchema = z.object({
  type: z.literal('attach_weapon_mod'),
  weaponInventoryIdx: slotIndex,
  attachmentDefId: z.string().min(1).max(64),
});

// Detach a weapon mod by index in the mods array.
export const DetachWeaponModMsgSchema = z.object({
  type: z.literal('detach_weapon_mod'),
  weaponInventoryIdx: slotIndex,
  modIndex: z.number().int().min(0).max(15),
});

// Attach a suit affix to the equipped suit. (Suit affixes attach to
// the part currently equipped in the matching slot.)
export const AttachSuitAffixMsgSchema = z.object({
  type: z.literal('attach_suit_affix'),
  suitSlot: SUIT_SLOT_KINDS_SCHEMA,
  attachmentDefId: z.string().min(1).max(64),
});

export const DetachSuitAffixMsgSchema = z.object({
  type: z.literal('detach_suit_affix'),
  suitSlot: SUIT_SLOT_KINDS_SCHEMA,
  attachmentIndex: z.number().int().min(0).max(15),
});

// Tier-up a weapon at the precision machining mill. Consumes materials
// (registered in TIER_UP_RECIPES on the server) and increments the
// weapon's tier, preserving every existing piece affix and mod. Adds
// slots up to the new tier's allotment.
export const TierUpWeaponMsgSchema = z.object({
  type: z.literal('tier_up_weapon'),
  weaponInventoryIdx: slotIndex,
});

// Atomic weapon assembly — the player has staged a target piece +
// mod configuration in the Weapon Bench UI; on commit, the server
// diffs against the live weapon by AttachmentInstance.id, validates
// every newly-attached id is in the player's inventory and every
// detached id has a slot to land in, and either applies the whole
// transaction or rejects it. `null` in a piece slot means "leave that
// piece empty post-assembly." `mods` is the desired full mod list,
// in order; existing mods not in the list are detached and new mods
// are consumed from inventory.
export const AssembleWeaponMsgSchema = z.object({
  type: z.literal('assemble_weapon'),
  weaponInventoryIdx: slotIndex,
  pieces: z.object({
    frame: z.string().min(1).max(64).nullable().optional(),
    grip: z.string().min(1).max(64).nullable().optional(),
    magazine: z.string().min(1).max(64).nullable().optional(),
    barrel: z.string().min(1).max(64).nullable().optional(),
  }),
  mods: z.array(z.string().min(1).max(64)).max(15),
});

// Atomic suit-part assembly. Mirrors AssembleWeaponMsgSchema for
// the suit-side: the player has staged a target attachment list
// for one equipped suit part; on commit, the server diffs against
// the live part by AttachmentInstance.id, validates each newly-
// attached id is in inventory and each detached id has a slot to
// land in, applies the whole transaction or rejects. The desired
// attachment list is sent in order; existing attachments not in
// the list are detached, new ones consumed from inventory.
export const AssembleSuitPartMsgSchema = z.object({
  type: z.literal('assemble_suit_part'),
  suitSlot: z.enum([
    'chassis',
    'plating',
    'life_support',
    'utility_mod',
    'cargo_grid',
  ]),
  attachments: z.array(z.string().min(1).max(64)).max(8),
});

// Apply a workstation upgrade item from the player's inventory to a
// specific building. Server validates: building exists + matches the
// upgrade's targetBuilding, player is in range, building's current
// benchTier is targetTier - 1 (no skipping), the upgrade item is
// in inventory. On success, building.benchTier becomes targetTier
// and one upgrade item is consumed.
export const UpgradeWorkstationMsgSchema = z.object({
  type: z.literal('upgrade_workstation'),
  buildingId: z.string().min(1).max(64),
  upgradeId: z.string().min(1).max(64),
});

// Trigger a single consumable (e.g. medkit) from the given inventory
// slot. Server validates the slot is a consumable + has a positive
// count, applies the effect, and decrements / clears the slot.
export const UseConsumableMsgSchema = z.object({
  type: z.literal('use_consumable'),
  slot: slotIndex,
});

// Player-typed chat. Server validates non-empty + length cap,
// rate-limits, and broadcasts a 'chat' message to all members of
// the world.
export const ChatMsgSchema = z.object({
  type: z.literal('chat'),
  text: z.string().min(1).max(280),
});

// Reload the currently-equipped (selected hotbar slot) weapon. Server
// validates the slot is a ranged weapon, the magazine has space, and
// the player has reserve ammo. Reload takes RangedWeaponStats.reloadMs;
// fire is locked out until completion. Server broadcasts
// 'weapon_reloaded' on completion.
export const ReloadWeaponMsgSchema = z.object({
  type: z.literal('reload_weapon'),
});

// Salvage a single inventory slot at a workbench. Server validates
// the slot is salvageable (attachment / weapon / placeable), the
// player is in range of a workbench, and a base recipe exists for
// the item. Returns the configured refund (~20% of recipe inputs,
// scaled by suit-affix salvage bonuses).
export const SalvageRequestMsgSchema = z.object({
  type: z.literal('salvage_request'),
  slot: slotIndex,
});

// Reroll a CarriedPart's affixes at the Forge. Server validates the
// slot holds a part, the player is in range of a forge, and the
// inventory covers the tier-scaled material + artifact cost
// (AFFIX_REROLL_COSTS in crafting.ts). Affix count re-rolls on the
// same tier-gated distribution drops use, then fresh affixes roll —
// the gamble that gives a good-base-bad-roll drop a second life.
export const RerollAffixesMsgSchema = z.object({
  type: z.literal('reroll_affixes'),
  slot: slotIndex,
});

// Drop a slot's contents on the ground at the player's current
// position. `all` = drop the whole stack; otherwise drop a single
// unit (matches the inventory_discard semantics).
export const InventoryDropMsgSchema = z.object({
  type: z.literal('inventory_drop'),
  slot: slotIndex,
  all: z.boolean(),
});

// Hand a slot's contents to a nearby player. Server validates
// proximity (within crafting station range), copies the slot into
// the recipient's first available stackable/empty slot, clears
// the source. Same `all` semantics as drop.
export const GiveItemMsgSchema = z.object({
  type: z.literal('give_item'),
  targetCharacterId: z.string().min(1).max(64),
  slot: slotIndex,
  all: z.boolean(),
});

// Owner-only: pause the server. Server validates the requester is
// the owner, persists state, broadcasts 'server_paused' to all
// connections, closes them, and exits. Lobby browser shows the
// server with a Resume button until the owner rejoins.
export const PauseServerMsgSchema = z.object({
  type: z.literal('pause_server'),
});

// Editor sandbox messages. Only valid when the connection's
// auth token had `sandbox: true`. The sandbox world routes them;
// regular game worlds reject them.
export const SandboxSpawnEnemyMsgSchema = z.object({
  type: z.literal('sandbox_spawn_enemy'),
  // EnemyTemplate id from server's templates registry. The
  // sandbox world looks up the template and adds an enemy at
  // (x, y) with full HP.
  kind: z.string().min(1).max(64),
  x: finiteNumber,
  y: finiteNumber,
});
export const SandboxClearMsgSchema = z.object({
  type: z.literal('sandbox_clear'),
  // Which entity types to drop. Defaults to 'all' on the server
  // when omitted. Wipes everything except the editor player.
  scope: z.enum(['enemies', 'props', 'all']).optional(),
});

// Hand the editor user a curated inventory + equipment set. Used
// before a "test fight" so the editor has weapons + ammo + suit
// to actually engage spawned enemies.
//   creative — full playtest loadout (every weapon family + ammo
//     + suit) so any combat scenario is testable.
//   unarmed  — empty inventory + empty equipment for a "naked"
//     evaluation of an enemy's threat.
export const SandboxSetLoadoutMsgSchema = z.object({
  type: z.literal('sandbox_set_loadout'),
  kind: z.enum(['creative', 'unarmed']),
});

// Regenerate the sandbox scene as a dungeon floor with the
// requested parameters. Server runs the live procgen, swaps
// the scene's layout, and broadcasts a scene_changed so the
// editor's renderer repaints with the new floor. Used by the
// biome editor's "preview" tab to walk a generated dungeon.
export const SandboxRegenFloorMsgSchema = z.object({
  type: z.literal('sandbox_regen_floor'),
  biome: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  cycle: z.number().int().nonnegative().max(10000),
  floorIndex: z.number().int().nonnegative().max(100),
  worldSeed: z.number().int(),
});

// Replace the sandbox scene with a hand-authored SectorScene
// from the level editor. The server rasterises the scene onto
// a tile grid (sceneRasterize.rasterizeSectorSceneToLayout)
// and rebuilds the sandbox arena around it. Payload validation
// is intentionally loose — the editor is a trusted authoring
// surface, and full SectorScene Zod schemas would be heavy.
// Server clamps geometry size + tile count defensively.
export const SandboxLoadAuthoredSceneMsgSchema = z.object({
  type: z.literal('sandbox_load_authored_scene'),
  scene: z.unknown(),
});

// Build an isolated single-room scene from a room template. The
// scene's layout is sized to the template's footprint, the
// template's tiles are stamped directly into the tile grid, and
// the template's anchors drive the initial spawns. Used by the
// room editor's preview tab so authors see exactly what they
// painted in iso/FPS.
export const SandboxStampRoomMsgSchema = z.object({
  type: z.literal('sandbox_stamp_room'),
  templateId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  // Biome to render the room in (drives tileset / wall textures).
  // When omitted, the server picks the template's first
  // biomeAffinity entry.
  biome: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
});

// Move an inventory slot ↔ storage-chest slot. Either side may be
// 'inventory' or 'chest'; the server validates proximity to the
// chest and that both slots are within bounds, then swaps them.
// Stack-merging (same material id) consolidates count where
// possible; otherwise the slots simply trade.
export const StorageMoveMsgSchema = z.object({
  type: z.literal('storage_move'),
  buildingId: z.string().min(1).max(64),
  fromKind: z.enum(['inventory', 'chest']),
  fromIdx: z.number().int().nonnegative(),
  toKind: z.enum(['inventory', 'chest']),
  toIdx: z.number().int().nonnegative(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  AuthMsgSchema,
  InputMsgSchema,
  FireMsgSchema,
  BuildRequestMsgSchema,
  DemolishRequestMsgSchema,
  SelectHotbarMsgSchema,
  InventorySwapMsgSchema,
  InventoryDiscardMsgSchema,
  InventorySortMsgSchema,
  EquipRequestMsgSchema,
  UnequipRequestMsgSchema,
  InteractMsgSchema,
  CraftRequestMsgSchema,
  PurchaseBlueprintMsgSchema,
  SetBaseLayoutMsgSchema,
  PurchaseKeyMsgSchema,
  PickupStationOutputsMsgSchema,
  OpenDoorMsgSchema,
  OpenContainerMsgSchema,
  ContainerTakeMsgSchema,
  AttachWeaponAffixMsgSchema,
  DetachWeaponAffixMsgSchema,
  AttachWeaponModMsgSchema,
  DetachWeaponModMsgSchema,
  AttachSuitAffixMsgSchema,
  DetachSuitAffixMsgSchema,
  TierUpWeaponMsgSchema,
  AssembleWeaponMsgSchema,
  AssembleSuitPartMsgSchema,
  UpgradeWorkstationMsgSchema,
  UseConsumableMsgSchema,
  ReloadWeaponMsgSchema,
  ChatMsgSchema,
  PauseServerMsgSchema,
  StorageMoveMsgSchema,
  InventoryDropMsgSchema,
  GiveItemMsgSchema,
  SalvageRequestMsgSchema,
  RerollAffixesMsgSchema,
  SandboxSpawnEnemyMsgSchema,
  SandboxClearMsgSchema,
  SandboxSetLoadoutMsgSchema,
  SandboxRegenFloorMsgSchema,
  SandboxStampRoomMsgSchema,
  SandboxLoadAuthoredSceneMsgSchema,
]);


export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- Server → Client ----------
export type ServerMessage =
  | {
      type: 'welcome';
      sceneId: string;
      self: Player;
      players: Player[];
      enemies: EnemyState[];
      projectiles: ProjectileState[];
      loot: LootState[];
      corpses: CorpseState[];
      buildings: BuildingState[];
      props: PropState[];
      inventory: Inventory;
      equipment: Equipment;
      hotbarSelection: number;
      layout: SceneLayout | null;
      // Blueprint ids the player currently has access to (per-cycle +
      // persistent, merged). Used by the client to enable/disable recipes.
      knownBlueprints: string[];
      // Full blueprint catalog (every entry, including hidden ones).
      // Populated from packages/shared/content/blueprints/*.json at
      // server boot. Client calls setBlueprintCatalog on receive so
      // the UI / DAG view sees authored data without a redeploy.
      blueprints: BlueprintCatalogEntry[];
      // Full weapon registry. Populated from
      // packages/shared/content/weapons/*.json at server boot.
      // Client calls setWeaponRegistry on receive so WEAPON_STATS /
      // MELEE_STATS / WEAPON_FAMILY agree across both halves.
      weapons: WeaponDef[];
      // Full recipe registry. Populated from
      // packages/shared/content/recipes/*.json at server boot.
      // Client calls setRecipes on receive so crafting modals + the
      // blueprint editor pick up authored changes without a redeploy.
      recipes: Recipe[];
      // Attachment classes. Disk format folds def + roll ranges into
      // one entry; clients call setAttachmentRegistry on receive
      // which splits them back into ATTACHMENT_DEFS +
      // ATTACHMENT_STAT_RANGES.
      attachments: Array<AttachmentDef & { rolls?: AttachmentStatRanges }>;
      // Enemy visual registry derived from the JSON content
      // (packages/shared/content/enemies/*.json). Client
      // populates the runtime ENEMY_VISUALS map from this so a
      // newly-authored enemy renders without a deploy.
      enemyVisuals: Record<
        string,
        {
          shape: 'square' | 'circle' | 'triangle';
          color: number;
          size: number;
          // Library reference to an AnimationDef. When set, the
          // FPS renderer plays this animation against the enemy's
          // server-side state machine.
          animationId?: string;
        }
      >;
      // Per-prop visual fields the client renderer needs (FPS
      // billboard size + ground offset + tint fallback). Server
      // populates from the JSON content at boot; sent in welcome
      // so newly-authored props render without a deploy.
      propVisuals: Record<
        string,
        {
          tint?: string;
          spriteSize?: number;
          spriteGroundOffset?: number;
          animationId?: string;
        }
      >;
      // Biome registry — per-id palette + hazard summary used by
      // the renderer for layout.biome lookup. Hex strings; hazard
      // fields drive the HUD indicator + client-side hazard DPS
      // estimate (server is authoritative for damage application).
      biomes: Record<
        string,
        {
          floor: string;
          wall: string;
          accent: string;
          dominantHazard: 'none' | 'heat' | 'radiation' | 'cold' | 'toxic';
          hazardIntensity: number;
          hazardZoneIntensities?: Partial<{
            safe: number;
            corridor: number;
            hazard: number;
            extreme: number;
          }>;
          // Variant id lists derived from the biome's tileSet.
          // Renderers hash a per-cell index into these arrays to
          // pick `biome_wall/<biomeId>__<idx>` /
          // `biome_floor/<biomeId>__<idx>` texture overrides.
          // Empty arrays preserve the single-texture fallback.
          wallTextureIds: string[];
          floorTextureIds: string[];
          // FPS-renderer wall + ceiling height, in tiles. Optional
          // — falls back to 1.0 when omitted.
          wallHeightTiles?: number;
          // Library references for ambient looping animations on
          // each of the biome's three surface types. Empty = static
          // texture only.
          wallAnimationId?: string;
          floorAnimationId?: string;
          ceilingAnimationId?: string;
        }
      >;
      // Per-BuildingKind editor-authored overrides — today, just an
      // optional animationId. Hardcoded structural metadata (HP,
      // priority, station flags) stays in BUILDING_REGISTRY in
      // code; this payload only carries presentation. Only kinds
      // with authored content land here; absent kinds fall through
      // to a no-op visual.
      buildingVisuals: Record<
        string,
        {
          animationId?: string;
        }
      >;
      // World mode the player just joined. Drives mode-specific HUD
      // (deathmatch shows round timer + scoreboard, hides cycle clock
      // and inventory) and mode-specific behavior (TAB binds to
      // scoreboard in DM, inventory in live). Optional so wire-compat
      // with older servers stays intact; client falls back to 'live'.
      mode?: WorldMode;
      // Current deathmatch round snapshot. Sent in welcome so a
      // joining player gets the timer + scoreboard without waiting
      // for the next round transition. null in non-deathmatch worlds.
      deathmatchRound?: {
        startedAt: number;
        killsToWin: number;
        durationMs: number;
        // When set, the round is in intermission — render the
        // scoreboard overlay until `endsAt`. null = active round.
        intermissionEndsAt: number | null;
        scores: Array<{
          characterId: string;
          displayName: string;
          kills: number;
          deaths: number;
        }>;
      } | null;
      // Active surface base-layout id (base-layouts P4). Lets the
      // Power Link's Base tab mark which layout is currently built.
      // Optional so older clients tolerate it; absent ⇒ starter.
      baseLayoutId?: string;
      // Full base-layout catalog (base-layouts P4). Populated from
      // packages/shared/content/base-layouts/*.json at server boot.
      // Client calls setBaseLayoutCatalog on receive so the Power
      // Link's Base tab lists every layout with its cost / blueprint
      // gate / caps. Optional for wire-compat with older servers.
      baseLayouts?: BaseLayoutDef[];
    }
  | {
      // Sent when the player transitions between scenes (stairs, extract pad,
      // death respawn). Contains the full state of the new scene; client
      // drops anything from the previous scene and resyncs. Equipment is
      // preserved across scene transitions so we re-include it.
      type: 'scene_changed';
      sceneId: string;
      self: Player;
      players: Player[];
      enemies: EnemyState[];
      projectiles: ProjectileState[];
      loot: LootState[];
      corpses: CorpseState[];
      buildings: BuildingState[];
      props: PropState[];
      equipment: Equipment;
      layout: SceneLayout | null;
      // Active surface base-layout id (base-layouts P4). Sent so a
      // base-layout swap (which fires scene_changed for the surface
      // every player is standing on) carries the new active id to
      // mark in the Base tab. Optional; absent ⇒ unchanged/starter.
      baseLayoutId?: string;
    }
  | { type: 'player_joined'; player: Player }
  | { type: 'player_left'; characterId: string }
  | {
      type: 'player_moved';
      characterId: string;
      x: number;
      y: number;
      // Vertical state: absolute world-z of the feet. Optional so
      // renderers from older builds tolerate the message;
      // absent ⇒ grounded at the local floor / not crouching.
      z?: number;
      crouching?: boolean;
      // Server-authoritative grounded/airborne bit (true ⇔ the
      // player is mid-jump / falling: z above the floor anchor or
      // vz ≠ 0). The client's vertical camera prediction keys off
      // this instead of comparing the broadcast z against its
      // LOCAL floor mirror — that mirror is sampled at the
      // smoothed (lagging) XY, so while walking over sloped
      // terrain the comparison misclassifies grounded movement as
      // airborne and integrates gravity into the camera height.
      // Absent ⇒ grounded.
      airborne?: boolean;
    }
  | { type: 'player_damaged'; characterId: string; hp: number; maxHp: number; shield: number; maxShield: number }
  | { type: 'player_stamina'; stamina: number; maxStamina: number }
  | { type: 'player_died'; characterId: string }
  | { type: 'player_respawned'; characterId: string; x: number; y: number; hp: number; maxHp: number; stamina: number; maxStamina: number; shield: number; maxShield: number }
  | { type: 'enemy_spawned'; enemy: EnemyState }
  | { type: 'enemy_state'; id: string; x: number; y: number }
  | { type: 'enemy_damaged'; id: string; hp: number; maxHp: number }
  | { type: 'enemy_killed'; id: string }
  | { type: 'projectile_spawned'; projectile: ProjectileState }
  | {
      type: 'projectile_despawned';
      id: string;
      reason: 'hit' | 'expired';
      // Impact position for 'hit' despawns — the contact point
      // the server resolved against the target / wall. Optional
      // so 'expired' (TTL timeout) can omit it. Client renders
      // an impact decal here when present.
      x?: number;
      y?: number;
      z?: number;
      // What the projectile struck, for the client's impact
      // particles: 'flesh' (enemy or player body) sprays blood,
      // 'surface' (wall / terrain / building / prop) sprays
      // sparks. Optional so 'expired' despawns omit it.
      hitKind?: 'flesh' | 'surface';
    }
  | { type: 'loot_spawned'; loot: LootState }
  | { type: 'loot_despawned'; id: string; reason: 'picked_up' | 'expired' }
  | { type: 'corpse_spawned'; corpse: CorpseState }
  | { type: 'corpse_looted'; id: string; byCharacterId: string }
  | { type: 'building_placed'; building: BuildingState }
  | { type: 'building_damaged'; id: string; hp: number; maxHp: number }
  | { type: 'building_destroyed'; id: string }
  | { type: 'prop_spawned'; prop: PropState }
  | { type: 'prop_damaged'; id: string; hp: number; maxHp: number }
  | { type: 'prop_destroyed'; id: string }
  // Container open/close + take state (E5). prop_changed is broadcast
  // so every client refreshes the cube visuals; prop_inventory is
  // sent only to the player who has the container open so contents
  // stay private until interacted with.
  | { type: 'prop_changed'; prop: PropState }
  | {
      type: 'prop_inventory';
      propId: string;
      inventory: InventorySlot[];
    }
  | {
      // Periodic world-clock broadcast. cycle = current cycle index
      // (1-based). secondsToPerihelion = real seconds until the next horde
      // fires; 0 while the horde is active. hordeActive lets the client
      // switch the HUD into "siege mode".
      type: 'world_clock';
      cycle: number;
      secondsToPerihelion: number;
      hordeActive: boolean;
    }
  | {
      // Surface power state — sent whenever capacity, draw, or the
      // powered subset changes. Client renders a Power N/M HUD line and
      // dims unpowered buildings.
      type: 'power_state';
      capacity: number;
      draw: number;
      online: boolean;
      poweredBuildingIds: string[];
    }
  | {
      // Sent to a single player who was caught in a dungeon scene at the
      // moment perihelion fires. Client renders a "LINK SEVERED" glitch
      // overlay; the server kills them in place (corpse drops where they
      // were standing) and the standard respawn timer puts them back on
      // the surface a few seconds later.
      type: 'link_severed';
    }
  | {
      // Sent at the moment perihelion fires. Client can play a stinger /
      // colour shift / camera shake.
      type: 'horde_started';
      cycle: number;
      durationMs: number;
    }
  | {
      // Sent when the horde ends (timer expired or last enemy died).
      // Cycle has already been incremented server-side by this point.
      type: 'horde_ended';
      newCycle: number;
    }
  | {
      // Melee weapon swing event — broadcast to all in the scene so they
      // can render the slash. Server has already applied damage.
      // Melee swing visual cue. weaponId picks the swipe color in
      // the renderer (different blade colors per kind).
      type: 'weapon_swung';
      characterId: string;
      weaponId: 'knife' | 'sword' | 'hammer' | 'energy_blade';
      dirX: number;
      dirY: number;
    }
  | {
      // A craft job has begun at a station. Client adds it to its local
      // job queue so the workstation modal can render a progress bar.
      type: 'craft_job_started';
      job: CraftJobState;
    }
  | {
      // Craft job finished and the output landed in the player's
      // inventory (the server also sends an inventory_changed alongside).
      type: 'craft_job_completed';
      jobId: string;
    }
  | {
      // Full snapshot of currently-running jobs for this client. Sent on
      // welcome / scene change so the modal can paint progress bars
      // mid-job for cycles where the player reconnected.
      type: 'craft_jobs_state';
      jobs: CraftJobState[];
    }
  | { type: 'inventory_changed'; inventory: Inventory }
  | { type: 'equipment_changed'; equipment: Equipment }
  | { type: 'hotbar_selection'; slot: number }
  | {
      // Full snapshot of the player's currently-known blueprints (per-cycle
      // + persistent, merged). Sent on grant, on cycle-reset wipe, and any
      // time the set changes. Client replaces its local Set wholesale.
      type: 'blueprints_changed';
      knownBlueprints: string[];
    }
  | {
      // Reload started: client locks fire input + plays the reload SFX.
      // Server emits this on accepted reload_weapon; the matching
      // weapon_reloaded fires once reloadMs has elapsed.
      type: 'reload_started';
      characterId: string;
      durationMs: number;
    }
  | {
      // Reload finished. Server has already filled the weapon's mag and
      // decremented reserve ammo (broadcast in inventory_changed).
      type: 'weapon_reloaded';
      characterId: string;
      magazineRemaining: number;
    }
  | {
      // Chat message broadcast. `kind: 'player'` = a real player typed
      // the message; `kind: 'system'` = server-issued (joins, leaves,
      // deaths, perihelion notices, etc). Client renders both in the
      // same chat window with different styling.
      type: 'chat';
      kind: 'player' | 'system';
      characterId: string | null;
      displayName: string;
      text: string;
      ts: number;
    }
  | {
      // Server has been paused by the owner. Clients should
      // disconnect, optionally surface a "paused by owner" toast,
      // and route back to the lobby. The actual ws close follows
      // immediately so this is mostly cosmetic.
      type: 'server_paused';
    }
  | {
      // Authoritative list of active timed effects on a player.
      // Sent direct to the affected player; future enhancement may
      // broadcast a stripped-down version so other players can see
      // each other's stim halos. Empty list means "all effects
      // expired."
      type: 'player_effects';
      characterId: string;
      effects: PlayerEffect[];
    }
  // ---------- Deathmatch round events ----------
  // Per-kill chat lines ride on the existing `chat` system messages
  // (server posts "A killed B" via `notifyPlayerDied` → `systemChat`),
  // so there's no separate `dm_kill` wire event.
  //
  // Live scoreboard update. Sent after every kill that doesn't
  // end the round, and once at the start of each round. Sorted
  // server-side by (kills desc, deaths asc) so the client renders
  // in order without resorting.
  | {
      type: 'dm_scores';
      scores: Array<{
        characterId: string;
        displayName: string;
        kills: number;
        deaths: number;
      }>;
    }
  // Round ended. The intermission timer runs until
  // `intermissionEndsAt`. Client shows the scoreboard during the
  // window; server transitions to a fresh round when it elapses.
  // `reason: 'cap'` = someone hit the kill target; `'timeout'` =
  // wall-clock ran out.
  | {
      type: 'dm_round_end';
      reason: 'cap' | 'timeout';
      winnerCharacterId: string | null;
      intermissionEndsAt: number;
      scores: Array<{
        characterId: string;
        displayName: string;
        kills: number;
        deaths: number;
      }>;
    }
  // New round starting. Scores have been zeroed; the wall-clock
  // and kill target the client should display ride on this event.
  | {
      type: 'dm_round_start';
      startedAt: number;
      killsToWin: number;
      durationMs: number;
    }
  | { type: 'error'; message: string };

// Bump on any wire-incompatible change. The auth handshake includes this
// number; servers reject mismatched clients with a clear error.
export const PROTOCOL_VERSION = 51;
