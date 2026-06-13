// A Scene is one bounded place in the world: the surface base, or a single
// dungeon floor. It owns all entities that exist in that place — enemies,
// projectiles, ground loot — and runs the per-scene simulation tick.
//
// Players connect to the World; at any moment each player is *in* exactly
// one Scene. The World routes input/fire commands to the right Scene by
// looking up the connection's current sceneId.
//
// Phase A only instantiates 'surface' scenes. Dungeon floor scenes land in
// Phase B; their addition does not require changing this file.

import type { WebSocket } from 'ws';
import type {
  BuildingKind,
  BuildingState,
  CorpseState,
  EnemyState,
  Equipment,
  Inventory,
  InteractableKind,
  LootContent,
  LootState,
  MaterialKind,
  PlayerEffect,
  ProjectileOwnerKind,
  ProjectileState,
  PropState,
  SceneLayout,
  ServerMessage,
  WeaponFamily,
} from '@dumrunner/shared';
import {
  addAmmo,
  addAttachment,
  addConsumable,
  addUpgrade,
  addInventorySlotToInventory,
  addMaterial,
  addPart,
  addPlaceable,
  addWeapon,
  buildingHordePriority,
  buildingMaxHp,
  computeWeaponImbues,
  consumeAmmo,
  consumePlaceable,
  countAmmo,
  effectiveWeaponStats,
  isStationKind,
  swapSlotsBetween,
  weaponFamily,
} from '@dumrunner/shared';
import {
  COMBAT,
  MAX_INACCURACY_RAD,
  MELEE_STATS,
  TURRET_VARIANTS,
} from './combat.js';
import { TEMPLATES, SURFACE_SPAWNS } from './ai/templates.js';
import {
  instantiateEnemy,
  tickEnemy,
  type AiPlayer,
  type AiBuildingTarget,
} from './ai/fsm.js';
import type { EnemyRuntime } from './ai/runtime.js';
import { PROPS, type PropRuntime } from './props.js';
import {
  rollDropsForKill,
  rollAttachmentDropForKill,
  killTierBiasFromHp,
} from './loot.js';
import {
  ensureBuildingAsset,
  ensureEnemyAsset,
  ensureMaterialAsset,
} from './assetGenClient.js';
import {
  createWallIndex,
  decodeTileGrid,
  INTERACTABLE_RADIUS,
  isInsideAny,
  isWalkableTileId,
  pointInPolygon,
  pointSegmentDistance,
  riserifyWalls,
  splitOverlappingWalls,
  segmentInsideWalkables,
  segmentSegmentIntersect,
  sectorNoiseOffsetAt,
  sweptCircleClearsSegment,
  terrainHeightAt,
  tileIdAt,
  type SectorMap,
  type WallIndex,
} from '@dumrunner/shared';
import {
  buildSectorMap,
  emitBuildingCubes,
  WALL_HEIGHT_WORLD,
} from './sectorBuild.js';
import {
  type InitialDoor,
  type InitialEnemySpawn,
  type InitialLootDrop,
  type InitialPropSpawn,
} from './procgen.js';
import type { AiEnvironment } from './ai/fsm.js';
import { BIOMES, getOverworldBiome } from './biomes.js';
import {
  HAZARD_TICK_INTERVAL_MS,
  categoryAt,
  effectiveHazardDps,
  resistFor,
} from '@dumrunner/shared';

// INTERACTABLE_RADIUS now lives in shared/geometry.ts so the
// client renderers + server can't drift apart. Both halves
// import the same constant; adjusting the value adjusts both.

// Polygon-collision toggle. v2 phase 2 swaps grid sampling for
// swept-circle-vs-wall + point-in-walkable-sector. Defaults on;
// set POLY_COLLISION=0 to revert to the legacy tile path while
// the swap is bedding in.
const POLY_COLLISION = process.env.POLY_COLLISION !== '0';

// Resolve a wall's endpoints. Inner-loop walls (around carved
// sub-sectors) carry explicit ax/ay/bx/by coords because their
// vertIdx doesn't index into sector.verts (which holds only the
// outer perimeter loop in linedef-sourced maps). Outer-loop walls
// and procgen/tile-grid walls fall back to the modulo wrap.
function wallEndpoints(
  wall: import('@dumrunner/shared').Wall,
  sector: import('@dumrunner/shared').Sector,
): { a: import('@dumrunner/shared').Vec2; b: import('@dumrunner/shared').Vec2 } | null {
  const a =
    wall.ax !== undefined && wall.ay !== undefined
      ? { x: wall.ax, y: wall.ay }
      : sector.verts[wall.vertIdx];
  const b =
    wall.bx !== undefined && wall.by !== undefined
      ? { x: wall.bx, y: wall.by }
      : sector.verts[(wall.vertIdx + 1) % sector.verts.length];
  if (!a || !b) return null;
  return { a, b };
}

// Single source of truth for stamping an InputMsg onto a
// SceneConnection. Both the live World and the editor sandbox
// import this so movement / sprint / jump / crouch behave
// identically in either context — adding a new input field
// touches this one helper, not two parallel call sites.
export function applyInputToConnection(
  conn: SceneConnection,
  moveX: number,
  moveY: number,
  sprint: boolean,
  jump: boolean = false,
  crouch: boolean = false,
): void {
  conn.inputX = clamp(moveX, -1, 1);
  conn.inputY = clamp(moveY, -1, 1);
  conn.inputSprint = sprint;
  if (jump) conn.inputJump = true;
  conn.inputCrouch = crouch;
  conn.inputAt = Date.now();
}

// 16 unit-circle directions used by Scene.circlePassable. Mirrors the
// shared geometry sampler so player and AI bounding-circle tests are
// consistent.
const COLLISION_SAMPLES = 16;
const COLLISION_UNITS: ReadonlyArray<{ ux: number; uy: number }> = (() => {
  const out: { ux: number; uy: number }[] = [];
  for (let i = 0; i < COLLISION_SAMPLES; i++) {
    const a = (i / COLLISION_SAMPLES) * Math.PI * 2;
    out.push({ ux: Math.cos(a), uy: Math.sin(a) });
  }
  return out;
})();

// Minimal view of a world-level connection that Scene needs to read or mutate.
// Defined as an interface so World can pass `Connection` objects without
// causing circular type dependencies.
export interface SceneConnection {
  ws: WebSocket;
  characterId: string;
  displayName: string;
  alive: boolean;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  shield: number;
  maxShield: number;
  // Last time the player took any damage. Drives shield regen delay.
  lastDamageAt: number;
  x: number;
  y: number;
  inputX: number;
  inputY: number;
  inputAt: number;
  inputSprint: boolean;
  // Vertical-movement input. `inputJump` is edge-triggered:
  // the World writes `true` when the client reports a fresh
  // jump press; Scene clears it after consuming the impulse.
  // `inputCrouch` is held-state — true while the key is down.
  inputJump: boolean;
  inputCrouch: boolean;
  // Vertical-movement state. `z` is the ABSOLUTE world-z of the
  // player's feet; `vz` the vertical velocity (wu/s). Grounded
  // ⇔ z <= floorZ with vz <= 0; airborne integrates z/vz under
  // gravity. crouching halves the hitbox height and dims walk
  // speed.
  z: number;
  vz: number;
  crouching: boolean;
  // Server-tracked floor height under the player — the grounded
  // collision anchor. Updated each tick AFTER the move resolves,
  // bounded by the previous floor + STEP_UP_MAX — so the player
  // can only climb one step-height per tick, even when their XY
  // happens to fall inside an overhead sector's polygon. Without
  // this state, `floorAt(x, y)` (stateless) would snap them up
  // to that overhead's floor on the next tick. While grounded,
  // z === floorZ.
  floorZ: number;
  // Last broadcast vertical state — triggers a fresh player_moved
  // whenever jump or crouch changes even if XY is unchanged.
  lastZSent: number;
  lastCrouchSent: boolean;
  inventory: Inventory;
  equipment: Equipment;
  hotbarSelection: number;
  // Bookkeeping flags Scene flips so the World knows to flush.
  dirty: boolean;
  inventoryDirty: boolean;
  // Scene mutates these to schedule respawn / fire-rate gating + stamina/shield broadcast throttle.
  lastFireAt: number;
  // Epoch ms at which an in-progress reload completes. 0 = not
  // reloading. Fire is locked while now < reloadingUntil.
  reloadingUntil: number;
  // Inventory index the reload was started on. The refill applies
  // to THIS slot, not whatever is equipped when the timer expires —
  // otherwise swapping mid-reload transfers a fast weapon's reload
  // time onto a slow one. -1 = none.
  reloadingSlot: number;
  respawnAt: number | null;
  // Damage immunity window after respawn so a player doesn't get
  // re-killed by enemies clustered around the spawn point. Set in
  // World.respawnPlayerToSurface; checked in applyDamage.
  respawnImmunityUntil: number;
  // Active timed status effects (stims, overcharge kits, future
  // debuffs from environmental damage). World mutates this; Scene
  // reads it through suitSpeedMult / suitStaminaRegenBonus already
  // present on this struct (those fields now reflect suit + active
  // effects after recomputePlayerStats folds them in). World expires
  // them on each tick.
  activeEffects: PlayerEffect[];
  lastStaminaSentAt: number;
  lastShieldSentAt: number;
  lastStaminaSent: number;
  lastShieldSent: number;
  // Earliest epoch ms when stamina is allowed to start regenerating.
  // Bumped whenever the player sprints (so releasing Shift starts the
  // recovery clock) or when stamina drains to 0.
  staminaRegenAt: number;
  // Suit-derived modifiers, recomputed by World whenever equipment
  // changes. Scene reads them in the simulation tick.
  suitSpeedMult: number; // additive to 1.0 (0.10 = +10%)
  suitStaminaRegenBonus: number; // per second
  // Extra tiles of build reach granted by the equipped suit
  // (chassis primary stat + cargo grid). Already floor()'d to whole
  // tiles in recomputePlayerStats.
  suitBuildRadiusBonus: number;
  // Hazard resists from the equipped life-support, 0..1. Cached
  // per-connection so the per-second hazard tick doesn't have to
  // walk the equipment tree. Recomputed in lockstep with the rest
  // of the suit stats whenever equipment changes.
  suitHeatResist: number;
  suitColdResist: number;
  suitRadiationResist: number;
  suitToxicResist: number;
  // Deathmatch score counters. Incremented by `killPlayer` when the
  // mode binding has PvP on; broadcast in the round-end summary.
  // Reset to 0 on `World.beginDeathmatchRound`. Always present so
  // we don't need to special-case the type — they just stay 0 in
  // live mode.
  kills: number;
  deaths: number;
}

type ProjectileRuntime = ProjectileState & {
  expiresAt: number;
  damage: number;
  radius: number;
  // World-Z height the projectile travels at. Captured from the
  // shooter's eye position at spawn so a crouching shooter's
  // bullet flies low and a jumping shooter's bullet flies high.
  // Used to filter player-hit checks against the target's
  // vertical span (feet z to feet z + height).
  // Server-only; no wire impact.
  originZ: number;
  // Optional status effects to apply to whatever this projectile
  // lands on. Populated when the firing weapon has imbue mods (see
  // computeWeaponImbues in shared). Each on-hit handler walks this
  // and stamps the effect on the target.
  imbues?: Array<{
    kind: 'burn_dps' | 'poison_dps' | 'slow_pct';
    magnitude: number;
    durationMs: number;
    label: string;
  }>;
};

type LootRuntime = LootState & {
  expiresAt: number;
  // Player who just dropped this slot. Pickup logic skips them
  // until `dropperImmuneUntil` elapses so the same-tick pickup
  // loop doesn't scoop the drop right back into their bag. Other
  // players in range can still pick it up immediately.
  dropperCharacterId?: string;
  dropperImmuneUntil?: number;
};

// Corpses persist for the entire cycle — no expiry timestamp needed. They're
// dropped at perihelion alongside the dungeon reset.
type CorpseRuntime = CorpseState;

type BuildingRuntime = BuildingState & {
  // Turrets only — last shot fired (epoch ms). Walls leave it 0.
  lastFireAt: number;
  // Workstation output buffer. Each station holds STATION_OUTPUT_SLOTS
  // worth of completed craft outputs until the player picks them up.
  // Non-station buildings keep this as an empty array.
  output: import('@dumrunner/shared').InventorySlot[];
};

// Output slot count per station. Stack-merging means materials and
// placeables collapse, so 8 is generous.
const STATION_OUTPUT_SLOTS = 8;
// Storage chests get a bigger grid since they're meant to hold a
// crew's stockpile across cycles.
const STORAGE_CHEST_SLOTS = 16;
// Container props (E5) — small per-instance grids. Sized for one
// or two stacks of loot; the player either takes everything in
// one E-interact or moves on. Distinct from STORAGE_CHEST_SLOTS
// since chests are persistent player infrastructure and these
// are world-loot pickups.
const CONTAINER_PROP_SLOTS = 8;

function emptyOutputBuffer(): import('@dumrunner/shared').InventorySlot[] {
  return Array.from({ length: STATION_OUTPUT_SLOTS }, () => ({ kind: 'empty' as const }));
}

function emptyChestBuffer(): import('@dumrunner/shared').InventorySlot[] {
  return Array.from({ length: STORAGE_CHEST_SLOTS }, () => ({
    kind: 'empty' as const,
  }));
}

function emptyContainerInventory(): import('@dumrunner/shared').Inventory {
  return Array.from({ length: CONTAINER_PROP_SLOTS }, () => ({
    kind: 'empty' as const,
  }));
}

// Roll a container's starting inventory from its lootTable. The
// table is walked `rollCount` times — each pass adds entries that
// pass their per-drop chance, with stack count rolled in
// [min, max]. Stack-merges via addMaterial so duplicates collapse.
function rollContainerInventory(
  table: import('@dumrunner/shared').LootDrop[],
  rollCount: number,
): import('@dumrunner/shared').Inventory {
  const inv = emptyContainerInventory();
  for (let pass = 0; pass < rollCount; pass++) {
    for (const drop of table) {
      if (Math.random() > drop.chance) continue;
      const count =
        drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
      if (count <= 0) continue;
      addMaterial(inv, drop.materialId as MaterialKind, count);
    }
  }
  return inv;
}

function emptyBufferForKind(
  kind: import('@dumrunner/shared').BuildingKind
): import('@dumrunner/shared').InventorySlot[] {
  if (kind === 'storage_chest') return emptyChestBuffer();
  if (isStationKind(kind)) return emptyOutputBuffer();
  return [];
}

const CORPSE_PICKUP_RADIUS = COMBAT.LOOT_PICKUP_RADIUS;
const EMPTY_BUILDING_TARGETS: AiBuildingTarget[] = [];

export type SceneKind = 'surface' | 'dungeon_floor';

// Persistent snapshot shape for a single scene. We only snapshot state that
// can't be regenerated from world seed + cycle (enemy hp/positions/respawn,
// loot on the ground). Procedural content (walls, room layout) regenerates
// from the world seed, so it never lands here.
export type SceneSnapshot = {
  enemies: Array<{
    id: string;
    kind: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    respawnAt: number | null;
    spawnX: number;
    spawnY: number;
  }>;
  loot: Array<{
    id: string;
    content: LootContent;
    x: number;
    y: number;
    expiresAt: number;
  }>;
  corpses: Array<{
    id: string;
    ownerCharacterId: string;
    ownerDisplayName: string;
    x: number;
    y: number;
    inventory: Inventory;
  }>;
  buildings: Array<{
    id: string;
    kind: BuildingKind;
    tileX: number;
    tileY: number;
    width: number;
    height: number;
    hp: number;
    maxHp: number;
    // Persisted only for chests; station output buffers reset on
    // hydrate. Optional for backwards compatibility with snapshots
    // written before storage chests existed.
    output?: import('@dumrunner/shared').InventorySlot[];
    // Per-bench tier (Phase 2.2). Persisted so Mk3 benches stay
    // Mk3 across server restarts. Optional for backward compat
    // with snapshots written before Phase 2.
    benchTier?: 1 | 2 | 3 | 4;
    // Wall_door only — the open/closed state. Persisted so a
    // base layout reloads with the same door states the player
    // left them in.
    open?: boolean;
  }>;
  nextEnemyId: number;
  nextProjectileId: number;
  nextCorpseId: number;
  nextBuildingId: number;
  savedAt: number;
};

export class Scene {
  readonly id: string;
  readonly kind: SceneKind;

  // Connections currently in this scene. The Connection objects themselves
  // live on the World; Scene only stores ids.
  readonly members = new Set<string>();

  private enemies = new Map<string, EnemyRuntime>();
  private projectiles = new Map<string, ProjectileRuntime>();
  private loot = new Map<string, LootRuntime>();
  private corpses = new Map<string, CorpseRuntime>();
  private buildings = new Map<string, BuildingRuntime>();
  // Decorator props (barrels, crates, conduits, …). Spawned by
  // procgen per biome.propPalette; destroyed by player/enemy
  // damage. Solid props block movement + projectiles via the
  // same collision helpers buildings use.
  private props = new Map<string, PropRuntime>();
  // Tracks turret ids we've already logged as "no power" so the log
  // line fires once per power-state transition rather than every
  // tick. Cleared per-id when the turret comes back online.
  private unpoweredLogged = new Set<string>();
  private nextEnemyId = 0;
  private nextPropId = 0;
  private nextProjectileId = 0;
  private nextCorpseId = 0;
  private nextBuildingId = 0;

  // Horde state — only meaningful for the surface scene. World drives these
  // via startHorde() / endHorde().
  private hordeActive = false;
  private hordeEndsAt = 0;
  private hordeCycle = 1;
  private nextHordeWaveAt = 0;

  // Hooks the Scene calls back into for connection lookup + cross-scene work.
  private readonly bindings: SceneBindings;

  // Static layout for dungeon floors (rooms + corridors + interactables).
  // Surface scenes have layout = null and skip collision.
  readonly layout: SceneLayout | null;

  // Decoded tile grid bytes (one allocation per scene) — collision
  // and AI line-of-sight read from this when present so template-
  // stamped walls block movement and projectiles. Null for layouts
  // without a tileGrid (surface, legacy snapshots).
  private readonly layoutTiles: Uint8Array | null;

  // Parsed from the scene id (`dungeon:N` → N). 0 for surface and
  // any other non-dungeon scene. Drives the hazard tick's depth
  // ramp without forcing every Scene caller to pass it in.
  readonly floorIndex: number;

  // Hazard tick accumulator. Counts up by `dt` each frame; once
  // it crosses HAZARD_TICK_INTERVAL_MS we apply one tick of
  // damage and reset.
  private hazardAccumulator = 0;

  // Sector-model collision data, built from the tile grid (until
  // the procgen rewrite emits sectors natively). Rebuilt when
  // buildings change so cube walls track placement / destruction.
  // Null when the scene has no geometry (e.g. surface without
  // worldBounds).
  private sectorMap: SectorMap | null = null;
  private wallIndex: WallIndex | null = null;
  // Per-tile walkable-sector lookup, populated alongside the
  // sector map when the layout has a tileGrid. Key = ly * width
  // + lx in the grid's local frame; value = sector index. Lets
  // walkableSectorAt skip the O(N) point-in-polygon scan in the
  // common (tile-derived) case. Null on tile-less layouts
  // (surface), where the polygon scan is still cheap (1-N sectors).
  private sectorByTile: Int32Array | null = null;
  // Cell size for the wall-bucket index. 32 px matches tile size
  // and keeps per-cell wall counts small for tile-derived scenes.
  private static readonly WALL_INDEX_CELL = 32;

  constructor(
    id: string,
    kind: SceneKind,
    bindings: SceneBindings,
    layout: SceneLayout | null = null,
    initialSpawns: InitialEnemySpawn[] | null = null,
    initialLoot: InitialLootDrop[] | null = null,
    initialDoors: InitialDoor[] | null = null,
    initialProps: InitialPropSpawn[] | null = null,
  ) {
    this.id = id;
    this.kind = kind;
    this.bindings = bindings;
    this.layout = layout;
    this.layoutTiles = layout?.tileGrid ? decodeTileGrid(layout.tileGrid) : null;
    // Parse the 1-based floor index from `dungeon:N`; surface and
    // unknown scene ids fall through to 0 (no hazard).
    if (id.startsWith('dungeon:')) {
      const n = Number(id.slice('dungeon:'.length));
      this.floorIndex = Number.isInteger(n) && n > 0 ? n : 0;
    } else {
      this.floorIndex = 0;
    }

    this.rebuildSectorMap();

    if (kind === 'surface') {
      this.populateSurface();
    } else if (kind === 'dungeon_floor' && initialSpawns) {
      this.populateFromSpawns(initialSpawns);
    }
    if (kind === 'dungeon_floor' && initialLoot) {
      this.populateInitialLoot(initialLoot);
    }
    if (kind === 'dungeon_floor' && initialDoors) {
      this.populateDoors(initialDoors);
      // Doors are buildings, and buildings enter collision via the
      // sector-map rebuild — which already ran above, BEFORE these
      // doors existed. Rebuild so locked doors actually block. This
      // was masked when doors sat behind sealed polygon walls; they
      // now sit in open doorway portals where the cube is the only
      // thing in the way.
      this.rebuildSectorMap();
    }
    if (kind === 'dungeon_floor' && initialProps) {
      this.populateInitialProps(initialProps);
    }
  }

  private populateInitialProps(spawns: InitialPropSpawn[]): void {
    for (const s of spawns) {
      const def = PROPS[s.kind];
      if (!def) continue;
      const id = `prop_${this.nextPropId++}`;
      const runtime: PropRuntime = {
        id,
        kind: s.kind,
        x: s.x,
        y: s.y,
        hp: def.hp,
        maxHp: def.hp,
        alive: true,
      };
      this.applyContainerInit(runtime, def);
      this.props.set(id, runtime);
    }
  }

  // Promote a freshly-spawned prop into a container if its def
  // carries a `container` block: snap (x, y) to the centre of its
  // tile footprint, record cube fields for the wire payload, and
  // roll initial inventory. No-op for non-container props.
  private applyContainerInit(
    runtime: PropRuntime,
    def: import('@dumrunner/shared').PropDef,
  ): void {
    if (!def.container) return;
    const tileSize = this.layout?.tileSize ?? 32;
    const c = def.container;
    // Snap so the prop lands cleanly on the tile grid the
    // raycaster reads. Tile coords = floor(centre / tileSize),
    // world centre is back-computed so wide containers sit
    // symmetrically over their footprint.
    const tileX = Math.floor(runtime.x / tileSize);
    const tileY = Math.floor(runtime.y / tileSize);
    runtime.tileX = tileX;
    runtime.tileY = tileY;
    runtime.tileWidth = c.tileWidth;
    runtime.tileDepth = c.tileDepth;
    runtime.heightMult = c.heightMult;
    runtime.opened = false;
    runtime.inventory = rollContainerInventory(c.lootTable, c.rollCount);
    runtime.x = (tileX + c.tileWidth / 2) * tileSize;
    runtime.y = (tileY + c.tileDepth / 2) * tileSize;
  }

  private populateDoors(doors: InitialDoor[]): void {
    const doorMaxHp = buildingMaxHp('door');
    for (const d of doors) {
      const id = `b${this.nextBuildingId++}`;
      this.buildings.set(id, {
        id,
        kind: 'door',
        tileX: d.tileX,
        tileY: d.tileY,
        width: 1,
        height: 1,
        hp: doorMaxHp,
        maxHp: doorMaxHp,
        lastFireAt: 0,
        output: [],
      });
    }
  }

  private populateInitialLoot(drops: InitialLootDrop[]): void {
    const now = Date.now();
    for (const d of drops) {
      const id = `lm${nextLootCounter()}`;
      this.loot.set(id, {
        id,
        content: { kind: 'material', materialId: d.materialId, count: d.count },
        x: d.x,
        y: d.y,
        // Floor scatter uses a much longer TTL than kill drops — this is the
        // dungeon's intrinsic loot, not a transient corpse pile.
        expiresAt: now + COMBAT.LOOT_TTL_MS * 10,
      });
    }
  }

  // ---------- membership ----------

  addMember(characterId: string): void {
    this.members.add(characterId);
  }

  removeMember(characterId: string): void {
    this.members.delete(characterId);
  }

  get memberCount(): number {
    return this.members.size;
  }

  // ---------- persistent snapshot ----------

  snapshot(): SceneSnapshot {
    return {
      enemies: [...this.enemies.values()].map((e) => ({
        id: e.id,
        kind: e.kind,
        x: e.x,
        y: e.y,
        hp: e.hp,
        maxHp: e.maxHp,
        alive: e.alive,
        respawnAt: e.respawnAt,
        spawnX: e.spawnX,
        spawnY: e.spawnY,
      })),
      loot: [...this.loot.values()].map((l) => ({
        id: l.id,
        content: l.content,
        x: l.x,
        y: l.y,
        expiresAt: l.expiresAt,
      })),
      corpses: [...this.corpses.values()].map((c) => ({
        id: c.id,
        ownerCharacterId: c.ownerCharacterId,
        ownerDisplayName: c.ownerDisplayName,
        x: c.x,
        y: c.y,
        inventory: c.inventory,
      })),
      buildings: [...this.buildings.values()].map((b) => ({ ...b })),
      nextEnemyId: this.nextEnemyId,
      nextProjectileId: this.nextProjectileId,
      nextCorpseId: this.nextCorpseId,
      nextBuildingId: this.nextBuildingId,
      savedAt: Date.now(),
    };
  }

  // Hydrate is called after construction; the constructor has already populated
  // default state (e.g. surface template enemies). We overlay the snapshot on
  // top: enemies match by id and have their dynamic state replaced; loot is
  // reset to whatever the snapshot recorded (with expired entries dropped).
  hydrate(snap: SceneSnapshot): void {
    const now = Date.now();

    for (const saved of snap.enemies) {
      const existing = this.enemies.get(saved.id);
      if (!existing) continue; // template removed since save — skip
      existing.x = saved.x;
      existing.y = saved.y;
      existing.hp = saved.hp;
      existing.maxHp = saved.maxHp;
      existing.alive = saved.alive;
      existing.respawnAt = saved.respawnAt;
      existing.spawnX = saved.spawnX;
      existing.spawnY = saved.spawnY;
      existing.lastBroadcastX = saved.x;
      existing.lastBroadcastY = saved.y;
      existing.fsm = saved.alive ? 'idle' : 'dead';
      existing.targetCharacterId = null;
      existing.attackReadyAt = existing.attackReadyAt.map(() => 0);
    }

    this.loot.clear();
    for (const saved of snap.loot) {
      if (saved.expiresAt <= now) continue;
      this.loot.set(saved.id, {
        id: saved.id,
        content: saved.content,
        x: saved.x,
        y: saved.y,
        expiresAt: saved.expiresAt,
      });
    }

    this.corpses.clear();
    if (snap.corpses) {
      for (const saved of snap.corpses) {
        this.corpses.set(saved.id, {
          id: saved.id,
          ownerCharacterId: saved.ownerCharacterId,
          ownerDisplayName: saved.ownerDisplayName,
          x: saved.x,
          y: saved.y,
          inventory: saved.inventory,
        });
      }
    }

    this.buildings.clear();
    if (snap.buildings) {
      for (const saved of snap.buildings) {
        // Storage chests AND station output buffers persist across
        // restarts — completed-but-uncollected craft outputs must
        // survive an idle shutdown or crash (craft durability; the
        // world snapshot now also restores in-flight jobs).
        const restoredOutput =
          Array.isArray(saved.output) && saved.output.length > 0
            ? saved.output
            : emptyBufferForKind(saved.kind);
        // Default benchTier to 1 for Weapon Benches that pre-date
        // Phase 2.2 (no field in the saved snapshot). Other kinds
        // leave it undefined.
        const benchTier =
          saved.benchTier ??
          (saved.kind === 'weapon_bench' ? 1 : undefined);
        this.buildings.set(saved.id, {
          ...saved,
          lastFireAt: 0,
          output: restoredOutput,
          benchTier,
        });
      }
    }

    // Continue id sequences past the snapshot so we never collide with old ids.
    if (snap.nextEnemyId > this.nextEnemyId) this.nextEnemyId = snap.nextEnemyId;
    if (snap.nextProjectileId > this.nextProjectileId) {
      this.nextProjectileId = snap.nextProjectileId;
    }
    if (snap.nextCorpseId !== undefined && snap.nextCorpseId > this.nextCorpseId) {
      this.nextCorpseId = snap.nextCorpseId;
    }
    if (
      snap.nextBuildingId !== undefined &&
      snap.nextBuildingId > this.nextBuildingId
    ) {
      this.nextBuildingId = snap.nextBuildingId;
    }

    // The building set was just replaced wholesale; the sector map
    // still reflects the constructor-time set. Rebuild so restored
    // buildings (surface base walls, dungeon doors) collide and
    // buildings removed before the save stop blocking. Direct
    // rebuild — not notifyBuildingsChanged — because hydrate runs
    // mid-World-restore, before the power bindings expect events.
    this.rebuildSectorMap();
  }

  // ---------- wire snapshot for welcome / scene_changed ----------

  toWireSnapshot(): {
    enemies: EnemyState[];
    projectiles: ProjectileState[];
    loot: LootState[];
    corpses: CorpseState[];
    buildings: BuildingState[];
    props: PropState[];
  } {
    return {
      enemies: [...this.enemies.values()].filter((e) => e.alive).map(toEnemyState),
      projectiles: [...this.projectiles.values()].map(toProjectileState),
      loot: [...this.loot.values()].map(toLootState),
      corpses: [...this.corpses.values()].map(toCorpseState),
      buildings: [...this.buildings.values()].map(toBuildingState),
      props: [...this.props.values()].filter((p) => p.alive).map(toPropState),
    };
  }

  // ---------- broadcasting (to members of this scene only) ----------

  broadcast(msg: ServerMessage, exceptCharacterId?: string): void {
    const data = JSON.stringify(msg);
    for (const id of this.members) {
      if (id === exceptCharacterId) continue;
      const conn = this.bindings.connection(id);
      if (!conn) continue;
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(data);
      }
    }
  }

  // ---------- editor sandbox API ----------
  // Public spawning + clearing entry points used by SandboxWorld.
  // Live game code never calls these — it's the same code path as
  // the per-floor enemy seeding but exposed as one-off helpers.

  spawnEnemyFromTemplate(
    templateId: string,
    x: number,
    y: number,
  ): boolean {
    const tpl = TEMPLATES[templateId];
    if (!tpl) return false;
    const id = `e${this.nextEnemyId++}`;
    const enemy = instantiateEnemy(id, tpl, x, y);
    this.enemies.set(id, enemy);
    this.broadcast({ type: 'enemy_spawned', enemy: toEnemyState(enemy) });
    ensureEnemyAsset(tpl);
    return true;
  }

  clearAllEnemies(): void {
    for (const id of [...this.enemies.keys()]) {
      this.enemies.delete(id);
      this.broadcast({ type: 'enemy_killed', id });
    }
  }

  clearAllProps(): void {
    for (const id of [...this.props.keys()]) {
      this.props.delete(id);
      this.broadcast({ type: 'prop_destroyed', id });
    }
  }

  // ---------- input handlers (called from World) ----------

  handleBuildRequest(
    characterId: string,
    kind: BuildingKind,
    tileX: number,
    tileY: number
  ): void {
    // Build mode is surface-only for now. Dungeon scenes can opt in later
    // (deployable barricades, traps, etc.).
    if (this.kind !== 'surface') return;
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return;

    const conn = this.bindings.connection(characterId);
    if (!conn || !conn.alive) return;
    if (!this.members.has(characterId)) return;

    // Range check: tile centre must be within BUILD_RADIUS_TILES of the
    // player. Generous-feeling but bounded — keeps players from building
    // half a map away.
    const tileCenterX = (tileX + 0.5) * tileSize;
    const tileCenterY = (tileY + 0.5) * tileSize;
    const reach =
      (COMBAT.BUILD_RADIUS_TILES + conn.suitBuildRadiusBonus + 0.5) *
      tileSize;
    const dxc = tileCenterX - conn.x;
    const dyc = tileCenterY - conn.y;
    if (dxc * dxc + dyc * dyc > reach * reach) return;

    // Tile already occupied?
    for (const b of this.buildings.values()) {
      if (b.tileX === tileX && b.tileY === tileY) return;
    }

    // Players currently overlapping the tile? Avoid trapping someone.
    const tilePxX = tileX * tileSize;
    const tilePxY = tileY * tileSize;
    const tilePxR = tilePxX + tileSize;
    const tilePxB = tilePxY + tileSize;
    const r = COMBAT.PLAYER_RADIUS;
    for (const memberId of this.members) {
      const c = this.bindings.connection(memberId);
      if (!c) continue;
      // Player AABB intersects tile AABB?
      if (
        c.x + r > tilePxX &&
        c.x - r < tilePxR &&
        c.y + r > tilePxY &&
        c.y - r < tilePxB
      ) {
        return;
      }
    }

    const maxHp = buildingMaxHp(kind);

    // Item cost: placement consumes one wall item (or whatever the
    // matching placeable kind is) from the player's inventory. The crafting
    // step earlier already paid the scrap.
    const ok = consumePlaceable(conn.inventory, kind, 1);
    if (!ok) return;
    conn.inventoryDirty = true;
    this.bindings.send(conn.characterId, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });

    const id = `b${this.nextBuildingId++}`;
    const building: BuildingRuntime = {
      id,
      kind,
      tileX,
      tileY,
      width: 1,
      height: 1,
      hp: maxHp,
      maxHp,
      lastFireAt: 0,
      output: emptyBufferForKind(kind),
      // Weapon Bench starts at Mk1; gets lifted via the
      // upgrade_workstation message + a Bench Upgrade item from the
      // Forge. Other building kinds leave benchTier undefined.
      benchTier: kind === 'weapon_bench' ? 1 : undefined,
      // Player-built doors start CLOSED so a freshly-placed door
      // gates the doorway by default — opening is an explicit act.
      open: kind === 'wall_door' ? false : undefined,
    };
    this.buildings.set(id, building);
    this.broadcast({ type: 'building_placed', building: toBuildingState(building) });
    this.notifyBuildingsChanged();
    ensureBuildingAsset(kind);
  }

  handleDemolishRequest(characterId: string, buildingId: string): void {
    if (this.kind !== 'surface') return;
    const conn = this.bindings.connection(characterId);
    if (!conn) return;
    if (!this.members.has(characterId)) return;
    const b = this.buildings.get(buildingId);
    if (!b) return;
    this.buildings.delete(buildingId);
    this.broadcast({ type: 'building_destroyed', id: buildingId });
    this.notifyBuildingsChanged();

    // Refund the placeable item itself (so demolish lets you reposition
    // without losing the wall). Demolish doesn't refund any of the scrap
    // that originally crafted it.
    addPlaceable(conn.inventory, b.kind, 1);
    conn.inventoryDirty = true;
    this.bindings.send(conn.characterId, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleFire(
    characterId: string,
    dirX: number,
    dirY: number,
    dirZ: number = 0,
  ): void {
    const conn = this.bindings.connection(characterId);
    if (!conn || !conn.alive) return;

    // What's in the selected hotbar slot? Only weapons fire.
    const slot = conn.inventory[conn.hotbarSelection];
    if (!slot || slot.kind !== 'weapon') return;

    // Normalise the full 3D aim. Players send the raw camera-
    // forward vector; we keep the XY components for the existing
    // 2D spread / pellet math and propagate the Z for the
    // projectile's vertical velocity.
    const len3 = Math.hypot(dirX, dirY, dirZ);
    if (!Number.isFinite(len3) || len3 < 0.001) return;
    const len2 = Math.hypot(dirX, dirY);
    if (len2 < 0.001) return;
    const nx = dirX / len2;
    const ny = dirY / len2;
    // Slope: dirZ per unit horizontal distance. Multiplied into
    // projectile speed below to yield vz.
    const slope = dirZ / len2;

    const family = weaponFamily(slot.weapon.weaponId);
    if (family === 'melee') {
      this.swingMelee(conn, nx, ny);
    } else {
      this.fireRanged(conn, nx, ny, slope, family);
    }
  }

  private fireRanged(
    conn: SceneConnection,
    nx: number,
    ny: number,
    slope: number,
    family: Exclude<WeaponFamily, 'melee'>
  ): void {
    const slot = conn.inventory[conn.hotbarSelection];
    if (!slot || slot.kind !== 'weapon') return;
    // effectiveWeaponStats applies BOTH the per-weapon-tier base
    // scaling (Phase 2.2) AND the attachment effects (mods + piece
    // affixes, including tier-mismatch from Phase 2.3). Reading
    // through it keeps the server's fire path in lockstep with the
    // client's stats panel — no chance of drift.
    const stats = effectiveWeaponStats(slot.weapon);
    if (!stats) return; // melee — caller already gated this
    const fireInterval = stats.fireIntervalMs;
    const damage = stats.damage;
    const projectileSpeed = stats.projectileSpeed;
    const spreadRad = stats.spreadRad;
    void family;
    // Imbues from incendiary / chem / cryo mods. Each pellet
    // carries them so a 6-pellet shotgun blast lays on the status
    // generously.
    const imbues = computeWeaponImbues(slot.weapon);
    const now = Date.now();
    // Reload lock-out: can't fire while a reload is in progress.
    if (now < conn.reloadingUntil) return;
    if (now - conn.lastFireAt < fireInterval) return;

    // Magazine gate: pull from the weapon's loaded mag instead of the
    // reserve. Reserve is only consumed during reload.
    const mag = slot.weapon.magazineRemaining ?? stats.magazineSize;
    if (mag <= 0) return;
    slot.weapon.magazineRemaining = mag - 1;
    conn.inventoryDirty = true;
    this.bindings.send(conn.characterId, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });

    conn.lastFireAt = now;

    // Per-shot accuracy: rotate the aim ray by a uniform random angle
    // in [-(1-acc) * MAX_INACC, +(1-acc) * MAX_INACC]. This is
    // independent of the pellet pattern below.
    const inaccHalf = (1 - stats.accuracy) * MAX_INACCURACY_RAD;
    const aimJitter = inaccHalf > 0
      ? (Math.random() * 2 - 1) * inaccHalf
      : 0;
    const ja = Math.cos(aimJitter);
    const jb = Math.sin(aimJitter);
    const ax = nx * ja - ny * jb;
    const ay = nx * jb + ny * ja;

    // Pellet pattern. Pellets fan out evenly around the (now jittered)
    // aim line; pelletCount=1 collapses to a single shot.
    const pellets = Math.max(1, stats.pelletCount);
    for (let i = 0; i < pellets; i++) {
      const t = pellets === 1 ? 0 : i / (pellets - 1) - 0.5; // [-0.5, 0.5]
      const angle = t * spreadRad;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = ax * cos - ay * sin;
      const dy = ax * sin + ay * cos;
      this.spawnProjectile({
        ownerKind: 'player',
        ownerId: conn.characterId,
        fromX: conn.x,
        fromY: conn.y,
        dirX: dx,
        dirY: dy,
        speed: projectileSpeed,
        damage,
        ttlMs: stats.projectileTtlMs,
        radius: stats.projectileRadius,
        color: stats.color,
        // Shooter eye height — crouching flips the bullet origin
        // low, so a duck-and-shoot exchange between two crouching
        // players reads naturally and a standing shot misses a
        // crouched target.
        originZ:
          conn.z +
          (conn.crouching ? COMBAT.EYE_HEIGHT_CROUCH : COMBAT.EYE_HEIGHT_STAND),
        // Vertical velocity from the camera pitch (slope = dz/dxy
        // at fire time). projectileSpeed is the horizontal speed;
        // multiplying yields wu/s vertical. Per-pellet spread
        // does not jitter Z — keeps shotgun pellet patterns flat
        // for now.
        vzInit: slope * projectileSpeed,
        imbues: imbues.length > 0 ? imbues : undefined,
        // Stamp the weapon id so the FPS client can swap to a
        // per-weapon (or per-family) projectile sprite.
        weaponId: slot.weapon.weaponId,
      });
    }
  }

  // Player pressed R: refill the equipped weapon's magazine from
  // reserve ammo. Returns success; on success the scene starts the
  // reload timer and the World/Scene tick fires weapon_reloaded once
  // it elapses.
  handleReloadWeapon(characterId: string): void {
    const conn = this.bindings.connection(characterId);
    if (!conn || !conn.alive) return;
    const slot = conn.inventory[conn.hotbarSelection];
    if (!slot || slot.kind !== 'weapon') return;
    const stats = effectiveWeaponStats(slot.weapon);
    if (!stats) return; // melee
    const now = Date.now();
    if (now < conn.reloadingUntil) return; // already reloading
    const mag = slot.weapon.magazineRemaining ?? stats.magazineSize;
    if (mag >= stats.magazineSize) return; // already full
    if (countAmmo(conn.inventory, stats.ammoKind) <= 0) return;

    conn.reloadingUntil = now + stats.reloadMs;
    conn.reloadingSlot = conn.hotbarSelection;
    this.broadcast({
      type: 'reload_started',
      characterId: conn.characterId,
      durationMs: stats.reloadMs,
    });
  }

  // Tick reloads to completion. Called from the world loop.
  tickReloads(now: number): void {
    for (const id of this.members) {
      const conn = this.bindings.connection(id);
      if (!conn) continue;
      if (conn.reloadingUntil === 0) continue;
      if (now < conn.reloadingUntil) continue;
      // Reload just finished — refill the mag of the weapon the
      // reload was STARTED on (reloadingSlot), not whatever is
      // currently equipped. Swapping mid-reload neither transfers
      // the reload to the new weapon nor eats it.
      const completedAt = conn.reloadingUntil;
      conn.reloadingUntil = 0;
      const slotIdx = conn.reloadingSlot;
      conn.reloadingSlot = -1;
      if (slotIdx < 0) continue;
      const slot = conn.inventory[slotIdx];
      if (!slot || slot.kind !== 'weapon') continue;
      const stats = effectiveWeaponStats(slot.weapon);
      if (!stats) continue; // melee
      const mag = slot.weapon.magazineRemaining ?? stats.magazineSize;
      const need = stats.magazineSize - mag;
      if (need <= 0) continue;
      const have = countAmmo(conn.inventory, stats.ammoKind);
      const take = Math.min(need, have);
      if (take <= 0) continue;
      consumeAmmo(conn.inventory, stats.ammoKind, take);
      slot.weapon.magazineRemaining = mag + take;
      conn.inventoryDirty = true;
      this.bindings.send(conn.characterId, {
        type: 'inventory_changed',
        inventory: conn.inventory,
      });
      this.broadcast({
        type: 'weapon_reloaded',
        characterId: conn.characterId,
        magazineRemaining: slot.weapon.magazineRemaining ?? stats.magazineSize,
      });
      void completedAt; // reserved for future reload telemetry
    }
  }

  private swingMelee(conn: SceneConnection, nx: number, ny: number): void {
    const slot = conn.inventory[conn.hotbarSelection];
    if (!slot || slot.kind !== 'weapon') return;
    const weaponId = slot.weapon.weaponId;
    // Pull stats from MELEE_STATS. Falls back to knife defaults so
    // any future melee weapon added to WEAPON_FAMILY before its
    // stats land still does *something*.
    const stats =
      MELEE_STATS[weaponId as keyof typeof MELEE_STATS] ?? MELEE_STATS.knife;
    const now = Date.now();
    if (now - conn.lastFireAt < stats.swingIntervalMs) return;
    conn.lastFireAt = now;

    // Half-arc threshold via dot product. Anything in front of the player
    // and within range takes damage.
    const cosThreshold = Math.cos(stats.arcRad);
    const reachSq = stats.range * stats.range;

    // Melee swings carry the same imbues as ranged shots — chem
    // sword poisons what it cuts, cryo blade chills targets in arc.
    const imbues = computeWeaponImbues(slot.weapon);

    for (const enemy of this.enemies.values()) {
      if (!enemy.alive) continue;
      const dx = enemy.x - conn.x;
      const dy = enemy.y - conn.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > reachSq) continue;
      const dist = Math.sqrt(distSq);
      if (dist < 0.001) continue;
      const dot = (dx / dist) * nx + (dy / dist) * ny;
      if (dot < cosThreshold) continue;
      this.damageEnemy(enemy, stats.damage, now);
      for (const imb of imbues) {
        this.applyEnemyEffect(enemy.id, {
          id: `imbue_${imb.kind}`,
          kind: imb.kind,
          magnitude: imb.magnitude,
          expiresAt: now + imb.durationMs,
        });
      }
    }

    // Family is melee by construction (caller checks before
    // dispatching here), so the cast is safe; TS just can't narrow
    // weaponId from WeaponKind to the melee subset.
    this.broadcast({
      type: 'weapon_swung',
      characterId: conn.characterId,
      weaponId: weaponId as 'knife' | 'sword' | 'hammer' | 'energy_blade',
      dirX: nx,
      dirY: ny,
    });
  }

  // ---------- per-tick simulation ----------

  tick(dt: number, now: number): void {
    this.simulatePlayerMovement(dt, now);
    this.runEnemyAi(dt, now);
    this.tickTurrets(now);
    this.tickReloads(now);
    this.advanceProjectiles(dt, now);
    this.handlePickupsAndLootExpiry(now);
    this.handleCorpsePickups();
    this.handleHordeWaves(now);
    this.tickHazards(dt, now);
    this.respawnDeadEntities(now);
  }

  // Per-second environmental hazard pass. Sources the biome's
  // `dominantHazard` from the registry, the player's current
  // hazard zone category from layout, and the resist value from
  // the player's cached suit stats. Skips entirely when the
  // scene has no layout (surface) or the biome's hazard is
  // 'none' (default / safe-zone biomes).
  private tickHazards(dt: number, now: number): void {
    if (!this.layout || this.floorIndex <= 0) return;
    this.hazardAccumulator += dt * 1000;
    if (this.hazardAccumulator < HAZARD_TICK_INTERVAL_MS) return;
    // Snap the accumulator instead of carrying remainder so a
    // long pause (e.g. server hitch) doesn't fire a burst of
    // catch-up ticks the player can't react to.
    this.hazardAccumulator = 0;
    const biome = BIOMES[this.layout.biome];
    if (!biome || biome.dominantHazard === 'none') return;
    // Adapt the full server BiomeDef into the shared
    // BiomeHazardInfo shape effectiveHazardDps expects. Same
    // fields with a thin projection so the math lives in shared.
    const hazardInfo = {
      dominantHazard: biome.dominantHazard,
      hazardIntensity: biome.generation.hazardIntensity,
      hazardZoneIntensities: biome.generation.hazardZoneIntensities,
    };
    for (const characterId of this.members) {
      const conn = this.bindings.connection(characterId);
      if (!conn || !conn.alive) continue;
      const category = categoryAt(this.layout, conn.x, conn.y);
      const { kind, dps } = effectiveHazardDps(
        hazardInfo,
        this.floorIndex,
        category,
      );
      if (kind === 'none' || dps <= 0) continue;
      const resist = resistFor(
        {
          heatResist: conn.suitHeatResist,
          coldResist: conn.suitColdResist,
          radiationResist: conn.suitRadiationResist,
          toxicResist: conn.suitToxicResist,
        },
        kind,
      );
      const damage = dps * (1 - resist);
      if (damage <= 0) continue;
      this.applyDamageToPlayer(characterId, damage, now);
    }
  }

  private tickTurrets(now: number): void {
    if (this.buildings.size === 0) return;
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return;
    // Powered defences require an alive Power Link AND an available
    // power slot under the depth-scaled capacity. Both conditions are
    // checked per-building via isPowered.
    for (const b of this.buildings.values()) {
      const variant = TURRET_VARIANTS[b.kind];
      if (!variant) continue;
      if (!this.bindings.isPowered(b.id)) {
        // One-time-per-build log so a silent turret during a horde
        // shows up in Fly logs and we can diagnose. Not noisy because
        // each turret only logs once until power state changes.
        if (!this.unpoweredLogged.has(b.id)) {
          this.unpoweredLogged.add(b.id);
          console.log(
            `[scene ${this.id}] turret ${b.id} (${b.kind}) idle: no power`
          );
        }
        continue;
      } else {
        this.unpoweredLogged.delete(b.id);
      }
      if (now - b.lastFireAt < variant.fireIntervalMs) continue;

      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;

      let target: EnemyRuntime | null = null;
      let bestDist: number = variant.range;
      for (const e of this.enemies.values()) {
        if (!e.alive) continue;
        const dx = e.x - cx;
        const dy = e.y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > bestDist) continue;
        target = e;
        bestDist = dist;
      }
      if (!target) continue;

      const dx = target.x - cx;
      const dy = target.y - cy;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) continue;

      b.lastFireAt = now;
      const nx = dx / len;
      const ny = dy / len;
      // Pellet-aware spawning so the shotgun turret fans out the way
      // the player's shotgun does.
      const pellets = Math.max(1, variant.pelletCount);
      for (let i = 0; i < pellets; i++) {
        const t = pellets === 1 ? 0 : i / (pellets - 1) - 0.5;
        const angle = t * variant.spreadRad;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        this.spawnProjectile({
          ownerKind: 'player',
          ownerId: b.id,
          fromX: cx,
          fromY: cy,
          dirX: nx * c - ny * s,
          dirY: nx * s + ny * c,
          speed: variant.projectileSpeed,
          damage: variant.damage,
          ttlMs: variant.projectileTtlMs,
          radius: variant.projectileRadius,
          color: variant.color,
        });
      }
    }
  }

  // ---------- horde control ----------

  // Called by World at perihelion. Surface only; dungeon scenes ignore.
  // `threat` drives wave size + composition — the World passes the
  // crew's deepest floor reached this cycle (floored by cycle index)
  // so horde pressure mirrors the power capacity the crew earned by
  // diving, instead of scaling on wall-clock cycles alone. A crew
  // that pushed to floor 8 faces a floor-8 horde on cycle 1.
  startHorde(endsAt: number, threat: number): void {
    if (this.kind !== 'surface') return;
    this.hordeActive = true;
    this.hordeEndsAt = endsAt;
    this.hordeCycle = Math.max(1, threat);
    // First wave fires immediately so the player feels the shift right away.
    this.nextHordeWaveAt = Date.now();
  }

  endHorde(): void {
    this.hordeActive = false;
    // Despawn any horde leftovers so the base isn't littered with stragglers.
    for (const [id, e] of this.enemies) {
      if (!e.alive) continue;
      e.alive = false;
      this.broadcast({ type: 'enemy_killed', id });
      this.enemies.delete(id);
    }
  }

  // Cycle reset: any unrecovered corpses + dropped loot vanish at perihelion.
  // Buildings and player-held inventories are untouched. Called by World
  // immediately after a horde ends.
  wipeCorpsesAndLoot(): void {
    for (const id of [...this.corpses.keys()]) {
      this.corpses.delete(id);
      this.broadcast({ type: 'corpse_looted', id, byCharacterId: '' });
    }
    for (const id of [...this.loot.keys()]) {
      this.loot.delete(id);
      this.broadcast({ type: 'loot_despawned', id, reason: 'expired' });
    }
  }

  private handleHordeWaves(now: number): void {
    if (!this.hordeActive) return;
    if (now < this.nextHordeWaveAt) return;
    if (now >= this.hordeEndsAt) return;
    this.spawnHordeWave();
    // ~15 seconds between waves; tweak per cycle for difficulty later.
    this.nextHordeWaveAt = now + 15_000;
  }

  private spawnHordeWave(): void {
    const count = 3 + Math.floor(this.hordeCycle / 2);
    const ringRadius = 700;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = ringRadius + (Math.random() - 0.5) * 100;
      let x = Math.cos(angle) * r;
      let y = Math.sin(angle) * r;
      // The raw ring point can land inside terrain-height walls or
      // a building footprint, leaving the enemy embedded where the
      // pather can't free it. Snap to the nearest clear tile (no
      // enemy-clearance requirement — hordes are allowed to clump).
      const safe = this.findSafeSpawnNear(x, y, 0, 6);
      x = safe.x;
      y = safe.y;

      // Composition by cycle: more variety + harder enemies later.
      let templateId = 'chaser_melee';
      const roll = Math.random();
      if (this.hordeCycle <= 2) {
        templateId = roll < 0.85 ? 'chaser_melee' : 'shooter_drone';
      } else if (this.hordeCycle <= 5) {
        templateId =
          roll < 0.6
            ? 'chaser_melee'
            : roll < 0.85
            ? 'shooter_drone'
            : 'brute_chaser';
      } else {
        templateId =
          roll < 0.4
            ? 'chaser_melee'
            : roll < 0.7
            ? 'shooter_drone'
            : 'brute_chaser';
      }
      const tpl = TEMPLATES[templateId];
      if (!tpl) continue;

      const id = `e${this.nextEnemyId++}`;
      const enemy = instantiateEnemy(id, tpl, x, y);
      this.enemies.set(id, enemy);
      this.broadcast({ type: 'enemy_spawned', enemy: toEnemyState(enemy) });
      ensureEnemyAsset(tpl);
    }
  }

  private handleCorpsePickups(): void {
    if (this.corpses.size === 0) return;
    const r = CORPSE_PICKUP_RADIUS;
    const rsq = r * r;

    for (const [id, c] of this.corpses) {
      // Closest live player wins (mirrors loot pickup).
      let closest: SceneConnection | null = null;
      let closestDsq = rsq;
      for (const memberId of this.members) {
        const conn = this.bindings.connection(memberId);
        if (!conn || !conn.alive) continue;
        const dx = c.x - conn.x;
        const dy = c.y - conn.y;
        const dsq = dx * dx + dy * dy;
        if (dsq <= closestDsq) {
          closest = conn;
          closestDsq = dsq;
        }
      }
      if (!closest) continue;

      // Transfer every non-empty slot from the corpse into the looter's
      // inventory, using the right helper per kind so stacks merge.
      // Every InventorySlot variant must be handled here — missing
      // cases silently destroy items at the corpse-to-looter handoff.
      for (const slot of c.inventory) {
        switch (slot.kind) {
          case 'empty':
            break;
          case 'part':
            addPart(closest.inventory, slot.part);
            break;
          case 'material':
            addMaterial(closest.inventory, slot.materialId, slot.count);
            break;
          case 'ammo':
            addAmmo(closest.inventory, slot.ammoId, slot.count);
            break;
          case 'weapon':
            addWeapon(closest.inventory, slot.weapon);
            break;
          case 'placeable':
            addPlaceable(closest.inventory, slot.buildingKind, slot.count);
            break;
          case 'attachment':
            addAttachment(closest.inventory, slot.instance);
            break;
          case 'consumable':
            addConsumable(closest.inventory, slot.consumableId, slot.count);
            break;
          case 'upgrade':
            addUpgrade(closest.inventory, slot.upgradeId, slot.count);
            break;
        }
      }
      closest.inventoryDirty = true;
      this.corpses.delete(id);
      this.broadcast({
        type: 'corpse_looted',
        id,
        byCharacterId: closest.characterId,
      });
      this.bindings.send(closest.characterId, {
        type: 'inventory_changed',
        inventory: closest.inventory,
      });
    }
  }

  private simulatePlayerMovement(dt: number, now: number): void {
    for (const id of this.members) {
      const conn = this.bindings.connection(id);
      if (!conn || !conn.alive) continue;

      let ix = conn.inputX;
      let iy = conn.inputY;
      let sprintHeld = conn.inputSprint;
      if (now - conn.inputAt > COMBAT.PLAYER_INPUT_TTL_MS) {
        ix = 0;
        iy = 0;
        sprintHeld = false;
      }

      // Stamina + sprint resolution. Sprinting requires moving AND held key
      // AND enough stamina. While sprinting, drain; otherwise regen — but
      // only after a fixed delay (no continuous "barely-sprint" refills).
      const moving = ix !== 0 || iy !== 0;
      const canSprint =
        sprintHeld &&
        moving &&
        conn.stamina >= COMBAT.STAMINA_MIN_TO_SPRINT;
      const sprintActive = canSprint && conn.stamina > 0;
      if (sprintActive) {
        conn.stamina = Math.max(0, conn.stamina - COMBAT.SPRINT_DRAIN_PER_SEC * dt);
        // Push the regen clock out as long as the player is actively
        // sprinting OR while their tank is empty.
        conn.staminaRegenAt = now + COMBAT.STAMINA_REGEN_DELAY_MS;
      } else if (sprintHeld && conn.stamina < COMBAT.STAMINA_MIN_TO_SPRINT) {
        // Tried to sprint but tank is too low — keep blocking regen until
        // they release the key.
        conn.staminaRegenAt = now + COMBAT.STAMINA_REGEN_DELAY_MS;
      } else if (now >= conn.staminaRegenAt) {
        conn.stamina = Math.min(
          conn.maxStamina,
          conn.stamina +
            (COMBAT.STAMINA_REGEN_PER_SEC + conn.suitStaminaRegenBonus) * dt
        );
      }

      // Throttled stamina broadcast to that player only.
      if (
        Math.abs(conn.stamina - conn.lastStaminaSent) > 0.5 &&
        now - conn.lastStaminaSentAt >= COMBAT.STAMINA_BROADCAST_INTERVAL_MS
      ) {
        conn.lastStaminaSentAt = now;
        conn.lastStaminaSent = conn.stamina;
        this.bindings.send(conn.characterId, {
          type: 'player_stamina',
          stamina: conn.stamina,
          maxStamina: conn.maxStamina,
        });
      }

      // Shield regen, also throttled.
      if (
        conn.shield < conn.maxShield &&
        now - conn.lastDamageAt >= COMBAT.SHIELD_REGEN_DELAY_MS
      ) {
        conn.shield = Math.min(
          conn.maxShield,
          conn.shield + COMBAT.SHIELD_REGEN_PER_SEC * dt
        );
        if (
          Math.abs(conn.shield - conn.lastShieldSent) > 0.5 &&
          now - conn.lastShieldSentAt >= COMBAT.SHIELD_BROADCAST_INTERVAL_MS
        ) {
          conn.lastShieldSentAt = now;
          conn.lastShieldSent = conn.shield;
          this.bindings.send(conn.characterId, {
            type: 'player_damaged',
            characterId: conn.characterId,
            hp: conn.hp,
            maxHp: conn.maxHp,
            shield: conn.shield,
            maxShield: conn.maxShield,
          });
        }
      }

      // ---------- Vertical: jump + crouch ----------
      // Always runs (even when XY input is zero) so the player
      // falls naturally after walking off a platform / hill.
      if (conn.inputCrouch) {
        conn.crouching = true;
      } else if (conn.crouching) {
        // Stand up only if standing height fits under the ceiling —
        // releasing crouch in a low passage keeps the player crouched
        // instead of clipping the head through the ceiling. The
        // ceiling context is the grounded anchor (conn.floorZ), NOT
        // the uncapped floorAt — under an overhead platform the
        // uncapped lookup returns the platform's own floor, which
        // would make ceilingAt report the headroom ABOVE the
        // platform instead of the underside above the player.
        const standCeiling = this.ceilingAt(conn.x, conn.y, conn.floorZ);
        if (conn.z + COMBAT.PLAYER_HEIGHT_STAND <= standCeiling) {
          conn.crouching = false;
        }
      }
      const grounded = conn.z <= conn.floorZ && conn.vz <= 0;
      if (conn.inputJump && grounded) {
        conn.vz = COMBAT.JUMP_VZ_INIT;
      }
      conn.inputJump = false;
      if (!(conn.z <= conn.floorZ && conn.vz === 0)) {
        // In the air OR falling onto a lower floor — integrate
        // absolute z under gravity.
        conn.vz -= COMBAT.GRAVITY * dt;
        conn.z += conn.vz * dt;
        // Head-bonk: if the player's head would clip into a
        // ceiling at the current XY, cap z and zero out the
        // upward velocity so they drop back down instead of
        // tunneling through. PLAYER_HEIGHT_STAND is the upper
        // bound — crouching mid-air gives no extra clearance
        // since we don't auto-uncrouch.
        if (conn.vz > 0) {
          // Ceiling context = grounded anchor, same reasoning as
          // the stand-up gate above: jumping while under an
          // overhead platform must bonk against the platform's
          // underside, not the ceiling above the platform.
          const ceiling = this.ceilingAt(conn.x, conn.y, conn.floorZ);
          if (conn.z + COMBAT.PLAYER_HEIGHT_STAND > ceiling) {
            conn.z = Math.max(
              conn.floorZ,
              ceiling - COMBAT.PLAYER_HEIGHT_STAND,
            );
            conn.vz = 0;
          }
        }
        // Landing: first contact with the floor anchor. (Rising
        // terrain mid-flight lands via the airborne re-anchor in
        // the xyMoved block below.)
        if (conn.z <= conn.floorZ && conn.vz <= 0) {
          conn.z = conn.floorZ;
          conn.vz = 0;
        }
      }

      // Vertical-only updates still need to reach clients (e.g.
      // jumping in place). Skip the XY-simulation block when not
      // moving, but fall through to the broadcast check below.
      if (!moving) {
        // Jump straight to the broadcast check.
        const verticalChanged =
          conn.z !== conn.lastZSent ||
          conn.crouching !== conn.lastCrouchSent;
        if (verticalChanged) {
          conn.lastZSent = conn.z;
          conn.lastCrouchSent = conn.crouching;
          this.broadcast({
            type: 'player_moved',
            characterId: conn.characterId,
            x: conn.x,
            y: conn.y,
            z: conn.z,
            crouching: conn.crouching,
            airborne: conn.z > conn.floorZ || conn.vz !== 0,
          });
        }
        continue;
      }

      const baseSpeed = COMBAT.PLAYER_MOVE_SPEED * (1 + conn.suitSpeedMult);
      let speed = sprintActive
        ? baseSpeed * COMBAT.SPRINT_SPEED_MULTIPLIER
        : baseSpeed;
      // Crouch slows ground movement (sprint + crouch interacts
      // multiplicatively — crouch-sprint is rare but possible if
      // both keys are held).
      if (conn.crouching) speed *= COMBAT.CROUCH_SPEED_MULT;

      const len = Math.hypot(ix, iy);
      const nx = len > 0 ? ix / len : 0;
      const ny = len > 0 ? iy / len : 0;

      const stepX = nx * speed * dt;
      const stepY = ny * speed * dt;

      // Compute the candidate position with world-bound clamps.
      let proposedX = clamp(
        conn.x + stepX,
        -COMBAT.PLAYER_BOUND,
        COMBAT.PLAYER_BOUND
      );
      let proposedY = clamp(
        conn.y + stepY,
        -COMBAT.PLAYER_BOUND,
        COMBAT.PLAYER_BOUND
      );

      // Wall collision. POLY_COLLISION switches between the legacy
      // tile-sampled circle test and the v2 polygon path (swept
      // circle vs. wall segments, point-in-walkable-sector for the
      // candidate). Step-up rule applies in both modes — a wall /
      // platform delta > STEP_UP_MAX reads as blocked.
      // Step-down is unrestricted.
      if (this.hasCollisionGeometry()) {
        // Stateful floor — only ever changes by ±STEP_UP_MAX per
        // tick (climb) or unbounded down (gravity). Reading
        // `floorAt(x, y)` raw would snap the player up to any
        // overhead sector whose polygon they incidentally fall
        // inside (sliding past an angled wall, for example).
        const fromFloor = conn.floorZ;
        // Height of the feet above the grounded anchor — the
        // airborne climb budget (a jumping player can clear
        // risers up to their current height). 0 when grounded.
        const heightAboveFloor = Math.max(0, conn.z - conn.floorZ);
        const usePolygon = POLY_COLLISION && this.sectorMap !== null;
        const fits = usePolygon
          ? (x: number, y: number) =>
              this.circleSweepPassable(
                conn.x,
                conn.y,
                x,
                y,
                COMBAT.PLAYER_RADIUS,
                fromFloor,
                heightAboveFloor,
                conn.crouching,
              )
          : (x: number, y: number) => {
              if (!this.circlePassable(x, y, COMBAT.PLAYER_RADIUS)) return false;
              const toFloor = this.floorAt(x, y);
              if (toFloor - fromFloor > COMBAT.STEP_UP_MAX) return false;
              return true;
            };
        if (!fits(proposedX, proposedY)) {
          // First try sliding ALONG the blocking wall, not just
          // along cardinal axes. Project the desired (dx, dy)
          // onto the wall's tangent vector, see if that slid
          // position is clear. This gives proper wall-slide on
          // angled geometry; the X/Y fallback below is the
          // last-resort for the rare case the projection lands
          // in another wall.
          const dxFull = proposedX - conn.x;
          const dyFull = proposedY - conn.y;
          let resolved = false;
          if (usePolygon) {
            const tangent = this.findBlockingWall(
              conn.x,
              conn.y,
              proposedX,
              proposedY,
              COMBAT.PLAYER_RADIUS,
              fromFloor,
              heightAboveFloor,
            );
            if (tangent) {
              const dot = dxFull * tangent.tx + dyFull * tangent.ty;
              const slideX = conn.x + tangent.tx * dot;
              const slideY = conn.y + tangent.ty * dot;
              if (fits(slideX, slideY)) {
                proposedX = slideX;
                proposedY = slideY;
                resolved = true;
              }
            }
          }
          if (!resolved) {
            const xOnly = fits(proposedX, conn.y);
            const yOnly = fits(conn.x, proposedY);
            if (xOnly) {
              proposedY = conn.y;
            } else if (yOnly) {
              proposedX = conn.x;
            } else {
              proposedX = conn.x;
              proposedY = conn.y;
            }
          }
        }
      }

      // Depenetration: stepping off a platform crosses the riser
      // wall freely (it's skip-overable from above), but lands
      // the player with their center too close to the wall's
      // back face — the wall, now non-skip from the lower side,
      // blocks every subsequent move ("stuck on the side of the
      // platform"). Push the player back to PLAYER_RADIUS distance
      // from any blocking wall. A few iterations settle multi-
      // wall corner cases.
      if (POLY_COLLISION && this.sectorMap && this.wallIndex) {
        const pushed = this.depenetratePosition(
          proposedX,
          proposedY,
          Math.max(0, conn.z - conn.floorZ),
          conn.crouching,
        );
        proposedX = pushed.x;
        proposedY = pushed.y;
      }

      const xyMoved = proposedX !== conn.x || proposedY !== conn.y;
      const verticalChanged =
        conn.z !== conn.lastZSent ||
        conn.crouching !== conn.lastCrouchSent;
      if (!xyMoved && !verticalChanged) continue;

      if (xyMoved) {
        conn.x = proposedX;
        conn.y = proposedY;
        conn.dirty = true;
        // Resolve the new floor with a one-step cap. The player
        // climbs at most STEP_UP_MAX per tick (anything taller
        // was already blocked by circleSweepPassable). This
        // prevents an overhead sector at the new XY from
        // snapping them up; they'd have to enter through a
        // legitimate step-up boundary.
        const airborne = conn.z > conn.floorZ || conn.vz !== 0;
        if (airborne) {
          // Absolute z is invariant while flying — only the floor
          // anchor re-resolves under the new XY, so the arc stays
          // a clean parabola over uneven terrain. floorAt's
          // terrain baseline ignores the cap, so ground that rose
          // ABOVE the feet comes back as newFloor >= z — that is
          // first contact with rising ground: land exactly there.
          const newFloor = this.floorAt(proposedX, proposedY, conn.z);
          conn.floorZ = newFloor;
          if (newFloor >= conn.z) {
            conn.z = newFloor;
            conn.vz = 0;
          }
        } else {
          // Grounded: resolve the floor under the new position with
          // the normal step-up cap.
          const stepFloor = this.floorAt(
            proposedX,
            proposedY,
            conn.floorZ + COMBAT.STEP_UP_MAX,
          );
          const drop = conn.z - stepFloor;
          conn.floorZ = stepFloor;
          if (drop <= COMBAT.STEP_UP_MAX) {
            // Small step down (stairs, curbs, pit lips, terrain
            // ripples) — stay glued so walking doesn't bounce.
            // Symmetric with the step-up budget: anything you could
            // step UP onto, you can step DOWN off without falling.
            conn.z = stepFloor;
          }
          // else: a real ledge. Leave z at the higher position —
          // the player is now airborne (z > floorZ) and the
          // vertical block integrates the fall under gravity on the
          // next tick, so walking off reads as a fall, not a snap.
        }
      }

      conn.lastZSent = conn.z;
      conn.lastCrouchSent = conn.crouching;
      this.broadcast({
        type: 'player_moved',
        characterId: conn.characterId,
        x: proposedX,
        y: proposedY,
        z: conn.z,
        crouching: conn.crouching,
        airborne: conn.z > conn.floorZ || conn.vz !== 0,
      });
    }
  }

  // Explicit interact: client sends `interact { interactableId }` when the
  // player presses the interact key while in range. We re-check proximity
  // here (don't trust the client) and fire onInteractable.
  handleInteract(characterId: string, interactableId: string): void {
    if (!this.layout) return;
    const conn = this.bindings.connection(characterId);
    if (!conn || !conn.alive) return;
    if (!this.members.has(characterId)) return;

    const it = this.layout.interactables.find((i) => i.id === interactableId);
    if (!it) return;

    const dx = conn.x - it.x;
    const dy = conn.y - it.y;
    const r = INTERACTABLE_RADIUS;
    if (dx * dx + dy * dy > r * r) return;

    this.bindings.onInteractable(characterId, this.id, it.kind);
  }

  private runEnemyAi(dt: number, now: number): void {
    if (this.enemies.size === 0) return;

    const livePlayers: AiPlayer[] = [];
    for (const id of this.members) {
      const conn = this.bindings.connection(id);
      if (!conn || !conn.alive) continue;
      livePlayers.push({
        characterId: conn.characterId,
        x: conn.x,
        y: conn.y,
      });
    }

    // Collision + LoS apply when walkable walls exist OR buildings are
    // present. Surface with no buildings yields an empty env.
    const env: AiEnvironment = this.hasCollisionGeometry()
      ? {
          collisionTest: (x: number, y: number, r: number) =>
            this.circlePassable(x, y, r),
          lineOfSight: (
            fx: number,
            fy: number,
            tx: number,
            ty: number
          ) => this.segmentClear(fx, fy, tx, ty),
          nextWaypoint: (fx: number, fy: number, tx: number, ty: number) =>
            this.nextAiWaypoint(fx, fy, tx, ty),
        }
      : {};

    // Building targets are passed only on the surface during horde, so
    // dungeon AI keeps targeting players exclusively (no base structures
    // down there anyway). Priority hierarchy:
    //   power_link 100 > turret 50 > workbench/forge/etc 25 > wall 10
    const buildingTargets =
      this.kind === 'surface' && this.hordeActive
        ? this.buildBuildingTargets()
        : EMPTY_BUILDING_TARGETS;

    for (const enemy of this.enemies.values()) {
      if (!enemy.alive) continue;
      this.tickEnemyEffects(enemy, dt, now);
      // tickEnemyEffects can drop hp to 0 — re-check before AI runs.
      if (!enemy.alive) continue;
      const outcome = tickEnemy(
        enemy,
        dt,
        now,
        livePlayers,
        env,
        buildingTargets
      );

      for (const hit of outcome.meleeDamage) {
        const target = this.bindings.connection(hit.targetCharacterId);
        if (!target || !target.alive) continue;
        this.applyDamage(target, hit.amount, now);
        if (target.hp <= 0) {
          this.killPlayer(target, now);
        }
      }

      for (const fire of outcome.projectileFires) {
        this.spawnProjectile({
          ownerKind: 'enemy',
          ownerId: fire.ownerEnemyId,
          fromX: fire.fromX,
          fromY: fire.fromY,
          dirX: fire.dirX,
          dirY: fire.dirY,
          speed: fire.spec.projectileSpeed,
          damage: fire.spec.projectileDamage,
          ttlMs: fire.spec.projectileTtlMs,
          radius: fire.spec.projectileRadius,
          color: fire.spec.projectileColor,
        });
      }

      // AoE cones: walk every player member and stamp the effect on
      // anyone whose position lies inside the cone (range + half-arc
      // tolerance). Bindings.applyPlayerEffect routes through World
      // so timer-refresh + broadcast happen consistently.
      for (const app of outcome.aoeConeApplications) {
        const halfArc = app.arcRad * 0.5;
        for (const memberId of this.members) {
          const conn = this.bindings.connection(memberId);
          if (!conn || !conn.alive) continue;
          const dxp = conn.x - app.originX;
          const dyp = conn.y - app.originY;
          const dist = Math.hypot(dxp, dyp);
          if (dist > app.range || dist < 0.001) continue;
          const dot = (dxp * app.axisX + dyp * app.axisY) / dist;
          if (dot < Math.cos(halfArc)) continue;
          this.bindings.applyPlayerEffect(conn.characterId, {
            id: `enemy_${app.effectKind}`,
            kind: app.effectKind,
            magnitude: app.effectMagnitude,
            expiresAt: Date.now() + app.effectDurationMs,
            label: app.effectLabel,
          });
        }
        // Telegraph for the client — reuse projectile_spawned with a
        // very short ttl so a cone flash renders without inventing a
        // new wire message. Spawn a wide, short-lived 'projectile' at
        // the cone origin pointing along axis; clients render it like
        // a transient burst.
        const TELEGRAPH_TTL = 250;
        this.spawnProjectile({
          ownerKind: 'enemy',
          ownerId: app.ownerEnemyId,
          fromX: app.originX + app.axisX * 8,
          fromY: app.originY + app.axisY * 8,
          dirX: app.axisX,
          dirY: app.axisY,
          speed: app.range * 4, // projectile dies before reaching tip — visual only
          damage: 0,
          ttlMs: TELEGRAPH_TTL,
          radius: 14,
          color: app.coneColor,
        });
      }

      if (outcome.positionDirty) {
        enemy.lastBroadcastX = enemy.x;
        enemy.lastBroadcastY = enemy.y;
        this.broadcast({
          type: 'enemy_state',
          id: enemy.id,
          x: enemy.x,
          y: enemy.y,
        });
      }

      // Wall-bashing — any melee enemy in melee range of a building chews
      // through it. This is what makes walls feel like a real defence:
      // horde waves stall on them instead of warping through. Doesn't
      // require explicit AI re-targeting; the wall just happens to be in
      // contact, so the enemy hits it.
      if (this.buildings.size > 0) {
        this.tickEnemyBuildingAttacks(enemy, dt, now);
      }
    }
  }

  // True if (px, py) is within range of any building of `kind`. Used by the
  // crafting workstation proximity check. Range is in pixels.
  hasBuildingNearby(
    px: number,
    py: number,
    kind: BuildingKind,
    rangePx: number
  ): boolean {
    return this.findBuildingsNearby(px, py, kind, rangePx).length > 0;
  }

  // All alive buildings of `kind` within rangePx of the point. Sorted by
  // building id for deterministic queue assignment when multiple stations
  // of the same kind are in range.
  findBuildingsNearby(
    px: number,
    py: number,
    kind: BuildingKind,
    rangePx: number
  ): BuildingState[] {
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return [];
    const out: BuildingState[] = [];
    for (const b of this.buildings.values()) {
      if (b.kind !== kind) continue;
      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;
      const halfW = (b.width * tileSize) / 2;
      const halfH = (b.height * tileSize) / 2;
      const dx = Math.max(Math.abs(px - cx) - halfW, 0);
      const dy = Math.max(Math.abs(py - cy) - halfH, 0);
      if (dx * dx + dy * dy <= rangePx * rangePx) {
        out.push({ ...b, output: b.output.map((s) => ({ ...s })) });
      }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  // Deposit a recipe output into a station's output buffer. Stack-merges
  // materials/ammo/placeables of the same id; falls back to the first
  // empty slot. Returns true on success, false if the buffer is full.
  // Caller is responsible for falling back to player inventory.
  // Inventory ↔ storage chest move. Validates the chest exists, is a
  // chest, the player is in range, and both slot indices are sane,
  // then swaps the slots (with stack-merge) and broadcasts the
  // updated chest state. Inventory diff goes only to the moving
  // player.
  handleStorageMove(
    conn: SceneConnection,
    buildingId: string,
    fromKind: 'inventory' | 'chest',
    fromIdx: number,
    toKind: 'inventory' | 'chest',
    toIdx: number
  ): boolean {
    const b = this.buildings.get(buildingId);
    if (!b || b.kind !== 'storage_chest') return false;
    // Range gate — same radius as crafting interactions.
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return false;
    const cx = (b.tileX + b.width / 2) * tileSize;
    const cy = (b.tileY + b.height / 2) * tileSize;
    const dx = cx - conn.x;
    const dy = cy - conn.y;
    if (dx * dx + dy * dy > COMBAT.CRAFT_STATION_RANGE_PX * COMBAT.CRAFT_STATION_RANGE_PX) {
      return false;
    }

    const src = fromKind === 'inventory' ? conn.inventory : b.output;
    const dst = toKind === 'inventory' ? conn.inventory : b.output;
    const changed = swapSlotsBetween(src, fromIdx, dst, toIdx);
    if (!changed) return false;

    // Push diffs.
    if (fromKind === 'inventory' || toKind === 'inventory') {
      conn.inventoryDirty = true;
      this.bindings.send(conn.characterId, {
        type: 'inventory_changed',
        inventory: conn.inventory,
      });
    }
    this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
    return true;
  }

  depositToStationOutput(
    stationId: string,
    output: import('@dumrunner/shared').InventorySlot
  ): boolean {
    const b = this.buildings.get(stationId);
    if (!b) return false;
    const buf = b.output;
    if (output.kind === 'empty') return true;
    // Merge into existing stackable slot of same id.
    for (const slot of buf) {
      if (
        slot.kind === 'material' &&
        output.kind === 'material' &&
        slot.materialId === output.materialId
      ) {
        slot.count += output.count;
        this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
        return true;
      }
      if (
        slot.kind === 'ammo' &&
        output.kind === 'ammo' &&
        slot.ammoId === output.ammoId
      ) {
        slot.count += output.count;
        this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
        return true;
      }
      if (
        slot.kind === 'placeable' &&
        output.kind === 'placeable' &&
        slot.buildingKind === output.buildingKind
      ) {
        slot.count += output.count;
        this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
        return true;
      }
    }
    // No merge — find first empty slot.
    for (let i = 0; i < buf.length; i++) {
      if (buf[i].kind === 'empty') {
        buf[i] = { ...output };
        this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
        return true;
      }
    }
    return false; // buffer full
  }

  // Drain every output slot from every station of `kind` within range
  // into the player's inventory. Server-side proximity check; returns
  // true if anything was transferred.
  collectStationOutputs(
    px: number,
    py: number,
    kind: BuildingKind,
    rangePx: number,
    inventory: import('@dumrunner/shared').Inventory
  ): boolean {
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return false;
    let any = false;
    for (const b of this.buildings.values()) {
      if (b.kind !== kind) continue;
      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;
      const halfW = (b.width * tileSize) / 2;
      const halfH = (b.height * tileSize) / 2;
      const dx = Math.max(Math.abs(px - cx) - halfW, 0);
      const dy = Math.max(Math.abs(py - cy) - halfH, 0);
      if (dx * dx + dy * dy > rangePx * rangePx) continue;
      let buildingChanged = false;
      for (let i = 0; i < b.output.length; i++) {
        const s = b.output[i];
        if (s.kind === 'empty') continue;
        // Try to add to player inventory; if it doesn't fit (rare; bag
        // is huge), leave the slot in the station for next pickup.
        const placed = this.tryAddSlotToInventory(inventory, s);
        if (placed) {
          b.output[i] = { kind: 'empty' };
          any = true;
          buildingChanged = true;
        }
      }
      if (buildingChanged) {
        this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
      }
    }
    return any;
  }

  // Helper: route an InventorySlot into an Inventory using the standard
  // add* helpers per kind. Returns true if the full count fit.
  private tryAddSlotToInventory(
    inv: import('@dumrunner/shared').Inventory,
    s: import('@dumrunner/shared').InventorySlot
  ): boolean {
    if (s.kind === 'material') {
      const left = addMaterial(inv, s.materialId, s.count);
      if (left > 0) {
        s.count = left;
        return false;
      }
      return true;
    }
    if (s.kind === 'ammo') {
      const left = addAmmo(inv, s.ammoId, s.count);
      if (left > 0) {
        s.count = left;
        return false;
      }
      return true;
    }
    if (s.kind === 'placeable') {
      const left = addPlaceable(inv, s.buildingKind, s.count);
      if (left > 0) {
        s.count = left;
        return false;
      }
      return true;
    }
    if (s.kind === 'part') {
      return addPart(inv, s.part);
    }
    if (s.kind === 'weapon') {
      return addWeapon(inv, s.weapon);
    }
    if (s.kind === 'attachment') {
      // Unique-instance attachments — pass the instance through so
      // its rolled stats survive the round-trip.
      return addAttachment(inv, s.instance);
    }
    if (s.kind === 'consumable') {
      return addConsumable(inv, s.consumableId, s.count);
    }
    return true;
  }

  // Build the AiBuildingTarget list for horde-mode AI. Priority hierarchy
  // shapes which structures enemies path toward first.
  private buildBuildingTargets(): AiBuildingTarget[] {
    if (this.buildings.size === 0) return EMPTY_BUILDING_TARGETS;
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return EMPTY_BUILDING_TARGETS;
    const out: AiBuildingTarget[] = [];
    for (const b of this.buildings.values()) {
      if (b.hp <= 0) continue;
      const priority = buildingHordePriority(b.kind);
      // 0 = ignored by horde pathing (e.g. doors).
      if (priority <= 0) continue;
      out.push({
        buildingId: b.id,
        x: (b.tileX + b.width / 2) * tileSize,
        y: (b.tileY + b.height / 2) * tileSize,
        priority,
      });
    }
    return out;
  }

  // Damage any building within melee range of this enemy. Uses the first
  // melee attack the template defines; stationary turrets won't apply.
  private tickEnemyBuildingAttacks(
    enemy: EnemyRuntime,
    dt: number,
    now: number
  ): void {
    if (now < enemy.stunUntil) return;
    let melee: { range: number; damagePerSec: number } | null = null;
    for (const atk of enemy.template.attacks) {
      if (atk.kind === 'melee') {
        melee = { range: atk.range, damagePerSec: atk.damagePerSec };
        break;
      }
    }
    if (!melee) return;

    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return;

    let nearest: BuildingRuntime | null = null;
    let nearestDist = Infinity;
    for (const b of this.buildings.values()) {
      // Doors are dungeon fixtures, not destructible — wandering enemies
      // shouldn't chew through them.
      if (b.kind === 'door') continue;
      // Open player-built doors are walk-through, so they're not a
      // valid melee target either. Closed wall_doors still get chewed.
      if (b.kind === 'wall_door' && b.open === true) continue;
      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;
      // AABB-vs-circle distance (treat the building footprint as a rect).
      const halfW = (b.width * tileSize) / 2;
      const halfH = (b.height * tileSize) / 2;
      const dx = Math.max(Math.abs(enemy.x - cx) - halfW, 0);
      const dy = Math.max(Math.abs(enemy.y - cy) - halfH, 0);
      const dist = Math.hypot(dx, dy);
      if (dist > enemy.template.radius + melee.range) continue;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = b;
      }
    }
    if (!nearest) return;

    this.damageBuilding(nearest, melee.damagePerSec * dt, now);
  }

  private damageBuilding(
    b: BuildingRuntime,
    amount: number,
    _now: number
  ): void {
    if (amount <= 0) return;
    b.hp -= amount;
    if (b.hp <= 0) {
      const wasPowerLink = b.kind === 'power_link';
      this.buildings.delete(b.id);
      this.broadcast({ type: 'building_destroyed', id: b.id });
      // Power Link destruction kicks off the world-level reset (drop
      // dungeon scenes, evict players, reset deepest-floor counter,
      // disable powered defences). World handles the cascade.
      if (wasPowerLink) this.bindings.onPowerLinkDestroyed();
      this.notifyBuildingsChanged();
      return;
    }
    this.broadcast({
      type: 'building_damaged',
      id: b.id,
      hp: b.hp,
      maxHp: b.maxHp,
    });
  }

  private advanceProjectiles(dt: number, now: number): void {
    for (const [id, p] of this.projectiles) {
      // Swept-segment collision. With pistol speed at 1500 px/s and a
      // 50ms tick, naïve point-in-radius leaves the projectile able to
      // skip past a 12-radius drone in a single step (75px > 12+4).
      // Test the full motion segment from old → new position against
      // each potential target's radius and stop at the earliest hit.
      const fromX = p.x;
      const fromY = p.y;
      const fromZ = p.z ?? p.originZ;
      const stepX = p.vx * dt;
      const stepY = p.vy * dt;
      // No gravity on projectiles for first cut — they fly in a
      // straight 3D line from the aim. vz comes from the camera
      // pitch at fire time and persists. Gravity-affected
      // ballistics (grenade / arc) are a v2.1 follow-up.
      const stepZ = (p.vz ?? 0) * dt;
      const newX = fromX + stepX;
      const newY = fromY + stepY;
      const newZ = fromZ + stepZ;

      if (now >= p.expiresAt) {
        this.projectiles.delete(id);
        this.broadcast({ type: 'projectile_despawned', id, reason: 'expired' });
        continue;
      }

      let hit = false;
      let earliestT = 1;
      let hitAction: (() => void) | null = null;
      // What kind of thing the earliest hit struck — drives the
      // client's impact particles (blood vs sparks). Every branch
      // that wins earliestT must also set this, since a later
      // candidate with a smaller t overwrites a prior winner.
      let hitKind: 'flesh' | 'surface' = 'surface';

      if (p.ownerKind === 'player') {
        for (const enemy of this.enemies.values()) {
          if (!enemy.alive) continue;
          const t = sweptCircleHit(
            fromX,
            fromY,
            stepX,
            stepY,
            enemy.x,
            enemy.y,
            enemy.template.radius + p.radius
          );
          if (t !== null && t < earliestT) {
            earliestT = t;
            hitKind = 'flesh';
            hitAction = () => {
              this.damageEnemy(enemy, p.damage, now);
              // Apply each imbue to the enemy. burn_dps and
              // poison_dps push DoT into activeEffects; slow_pct
              // does the same and gets read by fsm's speed mult.
              if (p.imbues) {
                for (const imb of p.imbues) {
                  this.applyEnemyEffect(enemy.id, {
                    id: `imbue_${imb.kind}`,
                    kind: imb.kind,
                    magnitude: imb.magnitude,
                    expiresAt: now + imb.durationMs,
                  });
                }
              }
            };
          }
        }
        // Player-owned buildings block player bullets — your walls
        // and turrets are cover, not targets. Round consumes on hit
        // but no damage transfers. (All buildings in alpha are
        // player-placed, so any projectile-vs-building from a
        // player-owned projectile is friendly fire.)
        const tileSize = this.layout?.tileSize ?? 0;
        if (tileSize > 0) {
          for (const b of this.buildings.values()) {
            const cx = (b.tileX + b.width / 2) * tileSize;
            const cy = (b.tileY + b.height / 2) * tileSize;
            const halfW = (b.width * tileSize) / 2 + p.radius;
            const halfH = (b.height * tileSize) / 2 + p.radius;
            const t = sweptAabbHit(
              fromX,
              fromY,
              stepX,
              stepY,
              cx - halfW,
              cy - halfH,
              cx + halfW,
              cy + halfH
            );
            if (t !== null && t < earliestT) {
              earliestT = t;
              hitKind = 'surface';
              hitAction = () => {
                /* friendly building absorbs the round, no damage */
              };
            }
          }
        }
        // Decorator props — solid props block bullets the same
        // way as buildings; non-solid (grass tufts, etc) let the
        // projectile pass.
        for (const prop of this.props.values()) {
          if (!prop.alive) continue;
          const def = PROPS[prop.kind];
          if (!def || !def.solid) continue;
          const radius = (this.layout?.tileSize ?? 32) * 0.4 + p.radius;
          const t = sweptCircleHit(
            fromX,
            fromY,
            stepX,
            stepY,
            prop.x,
            prop.y,
            radius,
          );
          if (t !== null && t < earliestT) {
            earliestT = t;
            hitKind = 'surface';
            const target = prop;
            hitAction = () => this.damageProp(target, p.damage, now);
          }
        }
        // Player-vs-player damage. Gated by the world rule so the
        // live PvE game never accidentally fires friendly damage;
        // enabled for deathmatch arenas. Self-hits are filtered
        // by the ownerCharacterId check.
        if (this.bindings.pvpEnabled()) {
          for (const memberId of this.members) {
            if (memberId === p.ownerCharacterId) continue;
            const conn = this.bindings.connection(memberId);
            if (!conn || !conn.alive) continue;
            const t = sweptCircleHit(
              fromX,
              fromY,
              stepX,
              stepY,
              conn.x,
              conn.y,
              COMBAT.PLAYER_RADIUS + p.radius,
            );
            if (t === null || t >= earliestT) continue;
            // Vertical hit filter — same shape as enemy → player.
            const hitZ = fromZ + stepZ * t;
            const tBot = conn.z;
            const tTop =
              tBot +
              (conn.crouching
                ? COMBAT.PLAYER_HEIGHT_CROUCH
                : COMBAT.PLAYER_HEIGHT_STAND);
            if (hitZ < tBot || hitZ > tTop) continue;
            earliestT = t;
            hitKind = 'flesh';
            const targetConn = conn;
            const killerId = p.ownerCharacterId;
            hitAction = () => {
              this.applyDamage(targetConn, p.damage, now);
              if (targetConn.hp <= 0)
                this.killPlayer(targetConn, now, killerId);
            };
          }
        }
      } else {
        for (const memberId of this.members) {
          const conn = this.bindings.connection(memberId);
          if (!conn || !conn.alive) continue;
          const t = sweptCircleHit(
            fromX,
            fromY,
            stepX,
            stepY,
            conn.x,
            conn.y,
            COMBAT.PLAYER_RADIUS + p.radius
          );
          if (t === null || t >= earliestT) continue;
          // Vertical hit filter — the bullet's Z at the hit time
          // must overlap the target's silhouette. Bullet Z
          // travels linearly along (fromZ → newZ), interpolated
          // by t; the target's vertical span is feet z to
          // feet z + height. Crouching halves the silhouette so
          // head-height shots sail over.
          const hitZ = fromZ + stepZ * t;
          const tBot = conn.z;
          const tTop =
            tBot +
            (conn.crouching
              ? COMBAT.PLAYER_HEIGHT_CROUCH
              : COMBAT.PLAYER_HEIGHT_STAND);
          if (hitZ < tBot || hitZ > tTop) continue;
          earliestT = t;
          hitKind = 'flesh';
          hitAction = () => {
            this.applyDamage(conn, p.damage, now);
            if (conn.hp <= 0) this.killPlayer(conn, now);
          };
        }
        // Enemy projectiles also damage buildings (drones erode the
        // base during horde). AABB-vs-segment via expanded box test.
        const tileSize = this.layout?.tileSize ?? 0;
        if (tileSize > 0) {
          for (const b of this.buildings.values()) {
            const cx = (b.tileX + b.width / 2) * tileSize;
            const cy = (b.tileY + b.height / 2) * tileSize;
            const halfW = (b.width * tileSize) / 2 + p.radius;
            const halfH = (b.height * tileSize) / 2 + p.radius;
            const t = sweptAabbHit(
              fromX,
              fromY,
              stepX,
              stepY,
              cx - halfW,
              cy - halfH,
              cx + halfW,
              cy + halfH
            );
            if (t !== null && t < earliestT) {
              earliestT = t;
              hitKind = 'surface';
              hitAction = () => this.damageBuilding(b, p.damage, now);
            }
          }
        }
      }

      // Wall collision (polygon mode). Tests the swept segment
      // against the WallIndex; earliest wall t shortens the step.
      // Despawns with reason 'hit' when no target lies before
      // the wall on the path. Vertical filter: a wall whose top
      // is below the bullet's Z at the contact moment lets the
      // round pass over — that's how you shoot over a riser /
      // low cover.
      if (POLY_COLLISION && this.sectorMap && this.wallIndex) {
        const wallT = this.segmentNearestWallTZ(
          fromX, fromY, fromZ,
          newX, newY, newZ,
        );
        if (wallT !== null && wallT < earliestT) {
          earliestT = wallT;
          hitAction = null;
          hitKind = 'surface';
        }
      }

      // Terrain / floor impact — the 3D flight line can dip below
      // the floor (downward aim, noise hills). An endpoint sample
      // is enough at 50ms steps; land at the crossing fraction so
      // the impact sprite sits on the ground instead of under it.
      const groundZ = this.floorAt(newX, newY);
      if (newZ <= groundZ) {
        const tGround =
          stepZ < 0
            ? Math.min(1, Math.max(0, (groundZ - fromZ) / stepZ))
            : 1;
        if (tGround < earliestT) {
          earliestT = tGround;
          hitAction = null;
          hitKind = 'surface';
        }
      }

      if (hitAction) {
        // Land the projectile at the contact point so the despawn
        // visual is at the actual hit location.
        p.x = fromX + stepX * earliestT;
        p.y = fromY + stepY * earliestT;
        p.z = fromZ + stepZ * earliestT;
        hitAction();
        this.projectiles.delete(id);
        this.broadcast({
          type: 'projectile_despawned',
          id,
          reason: 'hit',
          x: p.x,
          y: p.y,
          z: p.z,
          hitKind,
        });
        hit = true;
      } else if (earliestT < 1) {
        // Wall hit, no target — land at the contact point and
        // expire silently. Same `reason: 'hit'` so the client's
        // sparks-on-impact handler fires.
        p.x = fromX + stepX * earliestT;
        p.y = fromY + stepY * earliestT;
        p.z = fromZ + stepZ * earliestT;
        this.projectiles.delete(id);
        this.broadcast({
          type: 'projectile_despawned',
          id,
          reason: 'hit',
          x: p.x,
          y: p.y,
          z: p.z,
          hitKind,
        });
        hit = true;
      }
      if (hit) continue;

      // No hit — commit the full step.
      p.x = newX;
      p.y = newY;
      p.z = newZ;
    }
  }

  // Decorator-prop damage. Same shape as buildings: hp counts
  // down, broadcast on every hit, destruction flips alive=false +
  // applies the def's onDestroy (drop_loot / explode) before the
  // entry is removed from this.props.
  private damageProp(prop: PropRuntime, amount: number, now: number): void {
    if (!prop.alive || amount <= 0) return;
    prop.hp = Math.max(0, prop.hp - amount);
    this.broadcast({
      type: 'prop_damaged',
      id: prop.id,
      hp: prop.hp,
      maxHp: prop.maxHp,
    });
    if (prop.hp > 0) return;
    prop.alive = false;
    const def = PROPS[prop.kind];
    if (def) this.applyPropDestruction(prop, def, now);
    this.broadcast({ type: 'prop_destroyed', id: prop.id });
    this.props.delete(prop.id);
  }

  private applyPropDestruction(
    prop: PropRuntime,
    def: import('@dumrunner/shared').PropDef,
    now: number,
  ): void {
    if (def.onDestroy === 'explode' && def.explode) {
      // AoE damage: walk every entity in the blast radius and
      // route damage through the standard paths so kill detection
      // / drops / broadcasts stay consistent. Includes self
      // (player) — explosive barrels are dangerous to everyone.
      const r = def.explode.radius;
      const r2 = r * r;
      const dmg = def.explode.damage;
      // Players in radius.
      for (const memberId of this.members) {
        const conn = this.bindings.connection(memberId);
        if (!conn || !conn.alive) continue;
        const dx = conn.x - prop.x;
        const dy = conn.y - prop.y;
        if (dx * dx + dy * dy > r2) continue;
        this.applyDamageToPlayer(conn.characterId, dmg, now);
      }
      // Enemies in radius.
      for (const enemy of this.enemies.values()) {
        if (!enemy.alive) continue;
        const dx = enemy.x - prop.x;
        const dy = enemy.y - prop.y;
        if (dx * dx + dy * dy > r2) continue;
        this.damageEnemy(enemy, dmg, now);
      }
      // Chain-react adjacent props — explosive barrel + barrel
      // adjacency reads as fun emergent behaviour rather than
      // stacking detonation calculations. Skip self.
      for (const other of this.props.values()) {
        if (other === prop || !other.alive) continue;
        const dx = other.x - prop.x;
        const dy = other.y - prop.y;
        if (dx * dx + dy * dy > r2) continue;
        this.damageProp(other, dmg, now);
      }
    }
    if (def.onDestroy === 'drop_loot' && def.loot) {
      for (const drop of def.loot) {
        if (Math.random() > drop.chance) continue;
        const count =
          drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
        if (count <= 0) continue;
        const id = `lp${nextLootCounter()}`;
        const lr: LootRuntime = {
          id,
          content: {
            kind: 'material',
            materialId: drop.materialId as MaterialKind,
            count,
          },
          x: prop.x + (Math.random() - 0.5) * 24,
          y: prop.y + (Math.random() - 0.5) * 24,
          expiresAt: now + COMBAT.LOOT_TTL_MS,
        };
        this.loot.set(id, lr);
        this.broadcast({ type: 'loot_spawned', loot: toLootState(lr) });
      }
    }
  }

  private damageEnemy(enemy: EnemyRuntime, amount: number, now: number): void {
    enemy.hp = Math.max(0, enemy.hp - amount);
    // Hit-stun: refresh (don't stack). Per-template duration; brutes set a
    // small value so they're effectively stun-resistant.
    const stunMs = enemy.template.stunDurationOnHitMs;
    if (stunMs > 0) {
      enemy.stunUntil = now + stunMs;
    }
    this.broadcast({
      type: 'enemy_damaged',
      id: enemy.id,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
    });
    if (enemy.hp <= 0) {
      enemy.alive = false;
      enemy.fsm = 'dead';
      // No respawn — kills are permanent until perihelion (or a future
      // spawner mechanic) clears the floor.
      enemy.respawnAt = null;
      this.broadcast({ type: 'enemy_killed', id: enemy.id });
      this.spawnDropsFromKill(enemy, now);
    }
  }

  private spawnDropsFromKill(enemy: EnemyRuntime, now: number): void {
    const bias = killTierBiasFromHp(enemy.template.maxHp);
    const partDrops = rollDropsForKill(bias);
    for (const part of partDrops) {
      const lr: LootRuntime = {
        id: part.id,
        content: { kind: 'part', part },
        x: enemy.x + (Math.random() - 0.5) * 24,
        y: enemy.y + (Math.random() - 0.5) * 24,
        expiresAt: now + COMBAT.LOOT_TTL_MS,
      };
      this.loot.set(lr.id, lr);
      this.broadcast({ type: 'loot_spawned', loot: toLootState(lr) });
    }

    // Attachment drops — drop-only components per the economy law
    // (crafting recipes for them are gone). Rides the generic
    // slot-content loot path the drop-item feature already uses.
    const attachment = rollAttachmentDropForKill(bias);
    if (attachment) {
      const id = `la${nextLootCounter()}`;
      const lr: LootRuntime = {
        id,
        content: {
          kind: 'slot',
          slot: { kind: 'attachment', instance: attachment },
        },
        x: enemy.x + (Math.random() - 0.5) * 24,
        y: enemy.y + (Math.random() - 0.5) * 24,
        expiresAt: now + COMBAT.LOOT_TTL_MS,
      };
      this.loot.set(lr.id, lr);
      this.broadcast({ type: 'loot_spawned', loot: toLootState(lr) });
    }

    // Material drops from the enemy's loot table — independent rolls per row.
    for (const row of enemy.template.lootTable) {
      if (Math.random() > row.chance) continue;
      const count =
        row.min + Math.floor(Math.random() * (row.max - row.min + 1));
      if (count <= 0) continue;
      const id = `lm${nextLootCounter()}`;
      ensureMaterialAsset(row.materialId as MaterialKind);
      const lr: LootRuntime = {
        id,
        content: {
          kind: 'material',
          materialId: row.materialId as MaterialKind,
          count,
        },
        x: enemy.x + (Math.random() - 0.5) * 24,
        y: enemy.y + (Math.random() - 0.5) * 24,
        expiresAt: now + COMBAT.LOOT_TTL_MS,
      };
      this.loot.set(lr.id, lr);
      this.broadcast({ type: 'loot_spawned', loot: toLootState(lr) });
    }
  }

  // Tick DoT damage + slow expiry on a single enemy. DoT routes
  // through damageEnemy so kill detection + drops + broadcast all
  // happen consistently with bullets / melee. Slow doesn't apply
  // here — fsm reads activeEffects directly via currentEnemySpeedMult.
  private tickEnemyEffects(enemy: EnemyRuntime, dt: number, now: number): void {
    if (enemy.activeEffects.length === 0) return;
    let dotTotal = 0;
    for (const e of enemy.activeEffects) {
      if (e.kind === 'burn_dps' || e.kind === 'poison_dps') {
        dotTotal += e.magnitude * dt;
      }
    }
    if (dotTotal > 0) {
      this.damageEnemy(enemy, dotTotal, now);
    }
    enemy.activeEffects = enemy.activeEffects.filter((e) => e.expiresAt > now);
  }

  // Apply (or refresh) a timed status effect on an enemy. Same id
  // refreshes the timer in place. Mirrors World.applyPlayerEffect.
  applyEnemyEffect(
    enemyId: string,
    effect: import('./ai/runtime.js').EnemyEffect
  ): void {
    const enemy = this.enemies.get(enemyId);
    if (!enemy || !enemy.alive) return;
    const idx = enemy.activeEffects.findIndex((e) => e.id === effect.id);
    if (idx >= 0) enemy.activeEffects[idx] = effect;
    else enemy.activeEffects.push(effect);
  }

  // Public wrapper around applyDamage so World can route DoT/AoE
  // damage through the same death-detection path as bullets.
  // Bypasses the respawn-immunity check on purpose for tick-based
  // effects so a player who walks back into a flame puddle right
  // after respawn still takes damage.
  applyDamageToPlayer(
    characterId: string,
    amount: number,
    now: number
  ): void {
    const conn = this.bindings.connection(characterId);
    if (!conn || !conn.alive) return;
    if (!this.members.has(characterId)) return;
    // Inline a simplified applyDamage; the private one short-circuits
    // on respawnImmunity, which is intentional for projectiles but
    // wrong for DoT cleanup ticks.
    let remaining = amount;
    if (conn.shield > 0) {
      const absorbed = Math.min(conn.shield, remaining);
      conn.shield -= absorbed;
      remaining -= absorbed;
    }
    if (remaining > 0) {
      conn.hp = Math.max(0, conn.hp - remaining);
    }
    conn.lastDamageAt = now;
    conn.lastShieldSent = conn.shield;
    conn.lastShieldSentAt = now;
    this.broadcast({
      type: 'player_damaged',
      characterId: conn.characterId,
      hp: conn.hp,
      maxHp: conn.maxHp,
      shield: conn.shield,
      maxShield: conn.maxShield,
    });
    if (conn.hp <= 0) this.killPlayer(conn, now);
  }

  // Apply damage to a player. Shield soaks first; overflow goes to HP.
  // Marks lastDamageAt so the shield regen delay restarts. Broadcasts the
  // resulting hp+shield to everyone in the scene (everyone needs to see HP
  // updates; shield is sent alongside since the wire shape carries both).
  private applyDamage(conn: SceneConnection, amount: number, now: number): void {
    // Respawn-immunity grace window so a player who lands in a hot
    // surface doesn't get instantly re-killed before they can move.
    if (now < conn.respawnImmunityUntil) return;
    let remaining = amount;
    if (conn.shield > 0) {
      const absorbed = Math.min(conn.shield, remaining);
      conn.shield -= absorbed;
      remaining -= absorbed;
    }
    if (remaining > 0) {
      conn.hp = Math.max(0, conn.hp - remaining);
    }
    conn.lastDamageAt = now;
    conn.lastShieldSent = conn.shield;
    conn.lastShieldSentAt = now;
    this.broadcast({
      type: 'player_damaged',
      characterId: conn.characterId,
      hp: conn.hp,
      maxHp: conn.maxHp,
      shield: conn.shield,
      maxShield: conn.maxShield,
    });
  }

  // Drop an inventory slot on the ground at the given position.
  // Wraps the slot in a 'slot'-variant LootRuntime so the existing
  // pickup loop sees it; small jitter spreads multiple drops out.
  // Tags the loot with the dropper's id + a 2s immunity window so
  // the same-tick pickup loop doesn't immediately re-scoop it.
  spawnDroppedSlot(
    x: number,
    y: number,
    slot: import('@dumrunner/shared').InventorySlot,
    dropperCharacterId?: string
  ): void {
    if (slot.kind === 'empty') return;
    const id = `ld${nextLootCounter()}`;
    const now = Date.now();
    const lr: LootRuntime = {
      id,
      content: { kind: 'slot', slot },
      x: x + (Math.random() - 0.5) * 16,
      y: y + (Math.random() - 0.5) * 16,
      expiresAt: now + COMBAT.LOOT_TTL_MS,
      dropperCharacterId,
      dropperImmuneUntil: dropperCharacterId ? now + 2000 : undefined,
    };
    this.loot.set(id, lr);
    this.broadcast({ type: 'loot_spawned', loot: toLootState(lr) });
  }

  // Find a clear, enemy-free tile near a preferred pixel point, used
  // by spawn / respawn / extract-return so the player doesn't land
  // inside a wall or in the middle of a horde. Returns the *centre*
  // of an open tile in pixel coords. Walks outward in a square ring
  // pattern (BFS-ish but cheaper); falls back to the preferred point
  // if nothing safe is found within `maxRingTiles` rings.
  //
  // - "Clear" = no building footprint occupies the tile.
  // - "Safe" = no living enemy within `enemyClearRadiusPx`.
  // - The surface scene has no walkable bounds, so any tile is
  //   geometrically valid; this only matters for buildings + enemies.
  // Bounded BFS on the 32px tile grid toward (toX, toY); returns a
  // world-coord steering point for AI whose direct chase line is
  // blocked, or null when no path exists (e.g. behind a locked
  // door). The FSM throttles calls per-enemy (~450ms), so the node
  // cap is the worst-case cost, not the steady-state one. The walk
  // is floorZ-agnostic — same limitation as the rest of the AI grid
  // (raised-sector pathing is tracked in ROADMAP Sprint G).
  private static readonly AI_BFS_DIRS: ReadonlyArray<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  nextAiWaypoint(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): { x: number; y: number } | null {
    const grid = this.layout?.tileGrid;
    const tiles = this.layoutTiles;
    if (!grid || !tiles) return null;
    const ts = this.layout?.tileSize ?? 32;

    const buildingTiles = new Set<string>();
    for (const b of this.buildings.values()) {
      for (let dy = 0; dy < b.height; dy++) {
        for (let dx = 0; dx < b.width; dx++) {
          buildingTiles.add(`${b.tileX + dx},${b.tileY + dy}`);
        }
      }
    }
    const walkable = (tx: number, ty: number): boolean => {
      if (buildingTiles.has(`${tx},${ty}`)) return false;
      const id = tileIdAt(grid, tiles, (tx + 0.5) * ts, (ty + 0.5) * ts);
      return isWalkableTileId(id);
    };

    const sx = Math.floor(fromX / ts);
    const sy = Math.floor(fromY / ts);
    const gx = Math.floor(toX / ts);
    const gy = Math.floor(toY / ts);
    if (sx === gx && sy === gy) return null;

    const MAX_NODES = 600;
    const startKey = `${sx},${sy}`;
    const parent = new Map<string, string | null>([[startKey, null]]);
    const queue: Array<[number, number]> = [[sx, sy]];
    let best: [number, number] = [sx, sy];
    let bestD = Math.abs(gx - sx) + Math.abs(gy - sy);
    let found = false;
    while (queue.length > 0 && parent.size < MAX_NODES) {
      const [cx, cy] = queue.shift()!;
      if (cx === gx && cy === gy) {
        best = [cx, cy];
        found = true;
        break;
      }
      const d = Math.abs(gx - cx) + Math.abs(gy - cy);
      if (d < bestD) {
        bestD = d;
        best = [cx, cy];
      }
      for (const [dx, dy] of Scene.AI_BFS_DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        const key = `${nx},${ny}`;
        if (parent.has(key)) continue;
        if (!walkable(nx, ny)) continue;
        parent.set(key, `${cx},${cy}`);
        queue.push([nx, ny]);
      }
    }
    void found;
    // Reconstruct start→best, then string-pull: take the furthest
    // node along the path the enemy can reach in a straight line so
    // steering hugs corners instead of zig-zagging tile centres.
    const path: Array<[number, number]> = [];
    let cur: string | null = `${best[0]},${best[1]}`;
    while (cur) {
      const [px, py] = cur.split(',').map(Number);
      path.push([px, py]);
      cur = parent.get(cur) ?? null;
    }
    path.reverse(); // start → best
    if (path.length < 2) return null;
    for (let i = path.length - 1; i >= 1; i--) {
      const wx = (path[i][0] + 0.5) * ts;
      const wy = (path[i][1] + 0.5) * ts;
      if (this.segmentClear(fromX, fromY, wx, wy)) {
        return { x: wx, y: wy };
      }
    }
    const [fx, fy] = path[1];
    return { x: (fx + 0.5) * ts, y: (fy + 0.5) * ts };
  }

  findSafeSpawnNear(
    preferredX: number,
    preferredY: number,
    enemyClearRadiusPx = 5 * 32,
    maxRingTiles = 12
  ): { x: number; y: number } {
    const tileSize = this.layout?.tileSize ?? 32;
    const px = Math.floor(preferredX / tileSize);
    const py = Math.floor(preferredY / tileSize);

    const buildingTiles = new Set<string>();
    for (const b of this.buildings.values()) {
      for (let dy = 0; dy < b.height; dy++) {
        for (let dx = 0; dx < b.width; dx++) {
          buildingTiles.add(`${b.tileX + dx},${b.tileY + dy}`);
        }
      }
    }
    const clearR2 = enemyClearRadiusPx * enemyClearRadiusPx;
    const enemies = [...this.enemies.values()].filter((e) => e.alive);

    const checkTile = (tx: number, ty: number): { x: number; y: number } | null => {
      if (buildingTiles.has(`${tx},${ty}`)) return null;
      const cx = (tx + 0.5) * tileSize;
      const cy = (ty + 0.5) * tileSize;
      for (const e of enemies) {
        const ex = e.x - cx;
        const ey = e.y - cy;
        if (ex * ex + ey * ey < clearR2) return null;
      }
      return { x: cx, y: cy };
    };

    // Ring 0 — preferred tile itself.
    const at = checkTile(px, py);
    if (at) return at;

    // Spiral outward by rings.
    for (let r = 1; r <= maxRingTiles; r++) {
      // Top + bottom edges of the ring.
      for (let dx = -r; dx <= r; dx++) {
        const top = checkTile(px + dx, py - r);
        if (top) return top;
        const bot = checkTile(px + dx, py + r);
        if (bot) return bot;
      }
      // Left + right edges (excluding corners already covered).
      for (let dy = -r + 1; dy <= r - 1; dy++) {
        const left = checkTile(px - r, py + dy);
        if (left) return left;
        const right = checkTile(px + r, py + dy);
        if (right) return right;
      }
    }
    // Whole ring search exhausted (very unlikely on the surface) —
    // fall back to the preferred tile centre. Caller can always
    // hand out respawn immunity to compensate.
    return {
      x: (px + 0.5) * tileSize,
      y: (py + 0.5) * tileSize,
    };
  }

  // Public entry for World-driven kills (Power Link severance, future
  // forced deaths). Looks up the scene member by characterId; no-op if
  // they're not in this scene or already dead.
  killMemberInPlace(characterId: string, now: number): void {
    if (!this.members.has(characterId)) return;
    const conn = this.bindings.connection(characterId);
    if (!conn || !conn.alive) return;
    conn.hp = 0;
    this.killPlayer(conn, now);
  }

  private killPlayer(
    conn: SceneConnection,
    now: number,
    killerCharacterId: string | null = null,
  ): void {
    conn.alive = false;
    conn.respawnAt = now + COMBAT.PLAYER_RESPAWN_MS;
    conn.deaths += 1;
    let killer: SceneConnection | null = null;
    if (
      killerCharacterId !== null &&
      killerCharacterId !== conn.characterId &&
      this.bindings.pvpEnabled()
    ) {
      killer = this.bindings.connection(killerCharacterId) ?? null;
      if (killer) killer.kills += 1;
    }
    this.broadcast({
      type: 'player_died',
      characterId: conn.characterId,
    });
    // Server-wide system chat line. Killer attribution would need
    // damage source plumbing through projectile/melee paths — leave
    // null for now and let the chat just say "X died".
    this.bindings.onPlayerDied(
      conn.characterId,
      killer?.characterId ?? null,
    );
    // Surface kill in score broadcast so the client can update
    // the scoreboard. Only meaningful in deathmatch; the binding
    // gates whether the World cares.
    if (killer) {
      this.bindings.onDeathmatchKill?.(
        killer.characterId,
        conn.characterId,
        killer.kills,
        conn.deaths,
      );
    }

    // Drop the player's bag AND equipped suit gear to a corpse at the
    // death position. Per-server `dropItemsOnDeath` rule controls full-
    // loot — when false, the player keeps everything (bag + suit) on
    // respawn.
    const dropItems = this.bindings.dropItemsOnDeath();
    if (dropItems) {
      // Build the corpse inventory: live bag slots first, then any
      // currently-equipped suit pieces wrapped as `part` slots.
      const corpseInventory: typeof conn.inventory = conn.inventory.map(
        (s) => ({ ...s }),
      );
      let droppedAnyEquipment = false;
      for (const slotKey of Object.keys(conn.equipment) as Array<
        keyof typeof conn.equipment
      >) {
        const part = conn.equipment[slotKey];
        if (!part) continue;
        // Append to corpse inventory; grow if the bag was already full.
        // The corpse inventory has no length cap — it's a transient
        // pickup buffer, not a wearable slot grid.
        corpseInventory.push({ kind: 'part', part: { ...part } });
        conn.equipment[slotKey] = null;
        droppedAnyEquipment = true;
      }
      const hasAny =
        droppedAnyEquipment ||
        corpseInventory.some((s) => s.kind !== 'empty');
      if (hasAny) {
        const corpseId = `c${this.nextCorpseId++}`;
        const corpse: CorpseRuntime = {
          id: corpseId,
          ownerCharacterId: conn.characterId,
          ownerDisplayName: conn.displayName,
          x: conn.x,
          y: conn.y,
          inventory: corpseInventory,
        };
        this.corpses.set(corpseId, corpse);
        this.broadcast({ type: 'corpse_spawned', corpse: toCorpseState(corpse) });
      }
      // Wipe the bag.
      for (let i = 0; i < conn.inventory.length; i++) {
        conn.inventory[i] = { kind: 'empty' };
      }
      conn.inventoryDirty = true;
      this.bindings.send(conn.characterId, {
        type: 'inventory_changed',
        inventory: conn.inventory,
      });
      // World re-derives suit stats off the now-empty equipment and
      // broadcasts equipment_changed so the HUD catches up.
      if (droppedAnyEquipment) {
        this.bindings.onPlayerEquipmentChanged(conn.characterId);
      }
    }
  }

  private handlePickupsAndLootExpiry(now: number): void {
    if (this.loot.size === 0) return;

    const pickupR = COMBAT.LOOT_PICKUP_RADIUS;
    const pickupSq = pickupR * pickupR;

    for (const [id, lr] of this.loot) {
      if (now >= lr.expiresAt) {
        this.loot.delete(id);
        this.broadcast({ type: 'loot_despawned', id, reason: 'expired' });
        continue;
      }

      let closest: SceneConnection | null = null;
      let closestDistSq = pickupSq;
      for (const memberId of this.members) {
        const conn = this.bindings.connection(memberId);
        if (!conn || !conn.alive) continue;
        // Dropper-immunity: skip the player who just dropped this
        // until the brief window elapses. Other players in range
        // can still scoop it up immediately, so giving by drop
        // (drop near a teammate) still works.
        if (
          lr.dropperCharacterId === conn.characterId &&
          lr.dropperImmuneUntil !== undefined &&
          now < lr.dropperImmuneUntil
        ) {
          continue;
        }
        const dx = lr.x - conn.x;
        const dy = lr.y - conn.y;
        const dsq = dx * dx + dy * dy;
        if (dsq <= closestDistSq) {
          closest = conn;
          closestDistSq = dsq;
        }
      }
      if (!closest) continue;

      let placed = false;
      if (lr.content.kind === 'part') {
        placed = addPart(closest.inventory, lr.content.part);
      } else if (lr.content.kind === 'slot') {
        placed = addInventorySlotToInventory(closest.inventory, lr.content.slot);
      } else {
        // Material stacks merge into existing slots; leftover stays on the
        // ground so a near-full inventory still scoops what it can next pass.
        const leftover = addMaterial(
          closest.inventory,
          lr.content.materialId,
          lr.content.count
        );
        if (leftover < lr.content.count) {
          lr.content = {
            kind: 'material',
            materialId: lr.content.materialId,
            count: leftover,
          };
          placed = leftover === 0;
          if (!placed) {
            closest.inventoryDirty = true;
            this.bindings.send(closest.characterId, {
              type: 'inventory_changed',
              inventory: closest.inventory,
            });
            continue;
          }
        }
      }
      if (!placed) continue; // inventory full — leave loot on the ground
      closest.inventoryDirty = true;
      this.loot.delete(id);
      this.broadcast({ type: 'loot_despawned', id, reason: 'picked_up' });
      this.bindings.send(closest.characterId, {
        type: 'inventory_changed',
        inventory: closest.inventory,
      });
    }
  }

  private respawnDeadEntities(now: number): void {
    for (const memberId of this.members) {
      const conn = this.bindings.connection(memberId);
      if (!conn || conn.alive) continue;
      if (conn.respawnAt === null || now < conn.respawnAt) continue;
      // Hand the respawn off to the World — extraction-shooter rules say
      // death lands you back at the surface base, not the scene you died in.
      // The corpse stays where it dropped for recovery later.
      conn.respawnAt = null;
      this.bindings.onPlayerRespawn(conn.characterId);
    }
    // Enemies don't respawn — kills stay until cycle reset.
  }

  // ---------- collision predicates (used by player + AI movement) ----------

  // True if this scene has any wall geometry — walkables (dungeons) or
  // player-placed buildings (surface). When false, movement is unbounded.
  private hasCollisionGeometry(): boolean {
    if (this.layout && this.layout.walkables.length > 0) return true;
    if (this.buildings.size > 0) return true;
    return false;
  }

  // Single-point passability. Tile grid is the authoritative wall
  // map when present (carries template stamps that walkables[]
  // doesn't represent). Falls back to walkables for surface +
  // legacy layouts.
  private pointPassable(x: number, y: number): boolean {
    if (this.layout?.tileGrid && this.layoutTiles) {
      const id = tileIdAt(this.layout.tileGrid, this.layoutTiles, x, y);
      if (!isWalkableTileId(id)) return false;
    } else {
      const walkables = this.layout?.walkables ?? [];
      if (walkables.length > 0 && !isInsideAny(walkables, x, y)) return false;
    }
    if (this.isPointInAnyBuilding(x, y)) return false;
    return true;
  }

  // Rebuild the local SectorMap + WallIndex from the current
  // layout + buildings. Called at scene init and whenever
  // buildings change. O(walkable tiles + buildings) — fast at
  // current scene scales (~1ms for a 121×121 grid). Until the
  // procgen rewrite emits sectors natively, this is the bridge
  // that lets the server speak the v2 sector model.
  private rebuildSectorMap(): void {
    if (!this.layout) {
      this.sectorMap = null;
      this.wallIndex = null;
      this.sectorByTile = null;
      return;
    }
    // Authored scenes (level editor playtest, hand-authored
    // scene overrides) pass their SectorMap intact through
    // `layout.authoredSectorMap`. Use it as-is for polygon
    // collision instead of round-tripping through the tile-
    // grid → sectors rasteriser, which would quantise non-
    // axis-aligned shapes. Player-placed buildings still need
    // their cube walls appended; we deep-copy so we don't
    // mutate the layout's shared map across rebuilds.
    let map: typeof this.sectorMap;
    if (this.layout.authoredSectorMap) {
      const src = this.layout.authoredSectorMap;
      map = {
        sectors: src.sectors.map((s) => ({
          ...s,
          verts: s.verts.map((v) => ({ x: v.x, y: v.y })),
        })),
        walls: src.walls.map((w) => ({ ...w })),
        lights: src.lights.map((l) => ({ ...l })),
        bounds: { ...src.bounds },
      };
      const buildings = [...this.buildings.values()].map((b) => ({
        id: b.id,
        kind: b.kind,
        tileX: b.tileX,
        tileY: b.tileY,
        width: b.width,
        height: b.height,
        hp: b.hp,
        maxHp: b.maxHp,
      }));
      const tileSize = this.layout.tileSize ?? 32;
      emitBuildingCubes(
        buildings,
        map.sectors,
        map.walls,
        tileSize,
        WALL_HEIGHT_WORLD,
        this.layout.biome ?? 'default',
      );
    } else {
      map = buildSectorMap(this.layout, [...this.buildings.values()]);
    }
    this.sectorMap = map;
    if (!map) {
      this.wallIndex = null;
      this.sectorByTile = null;
      return;
    }
    // Split walls whose segments partially overlap walls of
    // OTHER sectors (door inside a longer wall) so the
    // overlapping portion is its own segment. Then auto-derive
    // riser + lintel overrides on shared-edge walls. Both
    // passes are idempotent for tile-derived maps that already
    // emit overrides directly from the converter.
    splitOverlappingWalls(map);
    riserifyWalls(map);
    const index = createWallIndex(Scene.WALL_INDEX_CELL);
    for (let i = 0; i < map.walls.length; i++) {
      const w = map.walls[i];
      const sector = map.sectors[w.sectorId];
      if (!sector) continue;
      const ends = wallEndpoints(w, sector);
      if (!ends) continue;
      index.addWall(i, ends.a.x, ends.a.y, ends.b.x, ends.b.y);
    }
    this.wallIndex = index;
    // Build the per-tile sector index when the layout has a grid.
    // Walkable tile sectors map 1:1 to (lx, ly) cells in the order
    // buildSectorMap emits them. Building-cube sectors come after
    // the tile sectors and aren't recorded here (walkableSectorAt
    // filters them anyway). Surface scenes skip this — they have
    // one big sector and the polygon scan is cheap.
    const grid = this.layout.tileGrid;
    if (grid) {
      const sbt = new Int32Array(grid.width * grid.height).fill(-1);
      const tiles = this.layoutTiles;
      if (tiles) {
        let sectorId = 0;
        for (let ly = 0; ly < grid.height; ly++) {
          for (let lx = 0; lx < grid.width; lx++) {
            if (isWalkableTileId(tiles[ly * grid.width + lx])) {
              sbt[ly * grid.width + lx] = sectorId++;
            }
          }
        }
      }
      this.sectorByTile = sbt;
    } else {
      this.sectorByTile = null;
    }
  }

  // Combined building-mutation notifier. Rebuilds the local sector
  // map so cube walls track placement / destruction, then fires
  // the world-level binding so cross-scene state (UI, asset prewarm)
  // stays in sync. Always call this instead of the binding directly.
  private notifyBuildingsChanged(): void {
    this.rebuildSectorMap();
    this.bindings.onBuildingsChanged();
  }

  // Read-only accessors. Exposed for code paths that want to
  // sample the polygon model (future projectile / LOS pass);
  // current player-movement still uses tile + AABB collision.
  getSectorMap(): SectorMap | null {
    return this.sectorMap;
  }
  getWallIndex(): WallIndex | null {
    return this.wallIndex;
  }

  // Push (x, y) out of any walls whose blocking-from-this-side
  // distance is < PLAYER_RADIUS. Called after a step-down to
  // resolve the radius-overlap left by walking over a riser:
  // the wall is skip-overable from the high side (player
  // crosses freely), but the moment they're on the lower side
  // the same wall is a blocker — and they're already inside
  // its radius. We iterate a few passes so multi-wall corners
  // (player landing in an L-shaped riser) settle cleanly.
  private depenetratePosition(
    x: number,
    y: number,
    heightAboveFloor: number,
    crouching: boolean,
  ): { x: number; y: number } {
    if (!this.sectorMap || !this.wallIndex) return { x, y };
    const sectors = this.sectorMap.sectors;
    const radius = COMBAT.PLAYER_RADIUS;
    const playerHeight = crouching
      ? COMBAT.PLAYER_HEIGHT_CROUCH
      : COMBAT.PLAYER_HEIGHT_STAND;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      const fromFloor = this.floorAt(x, y);
      const climbBudget = Math.max(COMBAT.STEP_UP_MAX, heightAboveFloor);
      const stepLimitTop = fromFloor + climbBudget;
      const playerTop = fromFloor + playerHeight;
      for (const wallIdx of this.wallIndex.cellsTouchingSegmentPadded(
        x,
        y,
        x,
        y,
        radius,
      )) {
        const wall = this.sectorMap.walls[wallIdx];
        if (!wall) continue;
        // Authored portal walls don't block — same rule as
        // circleSweepPassable so depenetration doesn't push the
        // player out of a doorway they should be standing in.
        if (
          !wall.solid &&
          wall.floorZOverride === undefined &&
          wall.ceilingZOverride === undefined
        ) {
          continue;
        }
        const wallTop =
          wall.ceilingZOverride !== undefined
            ? wall.ceilingZOverride
            : sectors[wall.sectorId]?.ceilingZ ?? 0;
        const wallBot =
          wall.floorZOverride !== undefined
            ? wall.floorZOverride
            : sectors[wall.sectorId]?.floorZ ?? 0;
        // Head clearance — lintels above the player's top pass.
        if (wallBot >= playerTop) continue;
        // Step-overable from this side → not a blocker, skip.
        if (wallTop <= stepLimitTop) continue;
        const sector = sectors[wall.sectorId];
        if (!sector) continue;
        const ends = wallEndpoints(wall, sector);
        if (!ends) continue;
        const a = ends.a;
        const b = ends.b;
        const d = pointSegmentDistance(a.x, a.y, b.x, b.y, x, y);
        if (d >= radius) continue;
        // Push outward along the perpendicular from the segment.
        // Compute the closest point, then the normal from there.
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 === 0) continue;
        let tParam = ((x - a.x) * abx + (y - a.y) * aby) / abLen2;
        if (tParam < 0) tParam = 0;
        else if (tParam > 1) tParam = 1;
        const cx = a.x + abx * tParam;
        const cy = a.y + aby * tParam;
        const nx = x - cx;
        const ny = y - cy;
        const nLen = Math.hypot(nx, ny);
        if (nLen < 0.0001) continue;
        const push = radius - d + 0.02;
        x += (nx / nLen) * push;
        y += (ny / nLen) * push;
        moved = true;
      }
      // Vertical clearance can also pull the player onto a
      // walkable spot — bail early when settled.
      if (!moved) break;
      void crouching; // wall depenetration is XY-only; vertical
                      // clearance handled in circleSweepPassable.
    }
    return { x, y };
  }

  // Walkable sector containing (x, y). "Walkable" excludes
  // building-cap sectors (they're at ceiling height, not floor)
  // and any sector with a buildingKind. Returns null when the
  // point is outside playable space (void, inside a cube footprint
  // is also "walkable" 2D-wise but blocked by the cube walls; the
  // walls handle that).
  //
  // Fast path: tile-derived scenes use the per-tile sector index,
  // O(1) lookup. Tile-less scenes (surface) fall back to a polygon
  // scan, cheap at 1-N sectors.
  // Walkable sector containing (x, y) whose floorZ is at or
  // below `cap`. Picks the HIGHEST qualifying floor — so a
  // step-height platform sitting on the base floor returns
  // the platform, while a tall overhead platform (above cap)
  // returns the base. Pass cap = Infinity for the "where am
  // I currently standing" query; pass `fromFloor + STEP_UP_MAX`
  // for the "where could I step to" query.
  private walkableSectorAt(
    x: number,
    y: number,
    cap: number = Infinity,
  ): import('@dumrunner/shared').Sector | null {
    if (!this.sectorMap) return null;
    // Fast path only valid for the tile-grid-derived sector
    // map. Authored scenes replace it; the per-tile index no
    // longer aligns, so fall through to the polygon scan.
    const useFastPath =
      !this.layout?.authoredSectorMap && !!this.sectorByTile;
    const grid = this.layout?.tileGrid;
    if (useFastPath && grid && this.sectorByTile) {
      const lx = Math.floor(x / grid.tileSize) - grid.originTileX;
      const ly = Math.floor(y / grid.tileSize) - grid.originTileY;
      if (lx < 0 || ly < 0 || lx >= grid.width || ly >= grid.height) return null;
      const sId = this.sectorByTile[ly * grid.width + lx];
      if (sId < 0) return null;
      const s = this.sectorMap.sectors[sId] ?? null;
      if (s && s.floorZ > cap) return null;
      return s;
    }
    // Open-air sentinel sector (`ceilingZ <= floorZ`) is the
    // surface scene's "no ceiling" marker. Its flat floorZ (0)
    // is NOT the real ground at the destination — the actual
    // ground is the terrain heightmap. Comparing the sentinel's
    // raw floorZ to `cap` (which is fromFloor + climbBudget)
    // rejects the sector whenever the player has stepped below
    // z=0 on the terrain. Resolve the sentinel's effective floor
    // via the terrain instead so cap comparison reflects the
    // ACTUAL ground at (x,y), not the placeholder z=0.
    const terrain = this.layout?.terrain;
    let best: import('@dumrunner/shared').Sector | null = null;
    let bestFloor = -Infinity;
    for (const s of this.sectorMap.sectors) {
      if (s.buildingKind !== undefined) continue;
      const effFloor =
        s.ceilingZ <= s.floorZ && terrain
          ? terrainHeightAt(terrain, x, y)
          : s.floorZ;
      if (effFloor > cap) continue;
      if (!pointInPolygon(s.verts, x, y)) continue;
      if (effFloor > bestFloor) {
        best = s;
        bestFloor = effFloor;
      }
    }
    return best;
  }

  // Find the first wall the swept circle would intersect during
  // the move, along with the wall's tangent unit vector. Used by
  // simulatePlayerMovement to slide ALONG the wall when the
  // diagonal move blocks — without this the X/Y fallback gives
  // tile-corner sliding feel even on a 30° wall. Returns null
  // when no wall blocks (move is clear). Honours the same step-
  // up / portal / non-solid filters as `circleSweepPassable`.
  private findBlockingWall(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    fromFloor: number,
    heightAboveFloor: number = 0,
  ): { tx: number; ty: number } | null {
    if (!this.sectorMap || !this.wallIndex) return null;
    const climbBudget = Math.max(COMBAT.STEP_UP_MAX, heightAboveFloor);
    const stepLimitTop = fromFloor + climbBudget;
    // Use standing height for the head-clearance test — slightly
    // conservative when crouched but avoids needing a per-call
    // crouching flag here. (Worst case: a crouching player can't
    // squeeze under a soffit that's between crouch and stand
    // heights; rare.)
    const playerTop = fromFloor + COMBAT.PLAYER_HEIGHT_STAND;
    const sectors = this.sectorMap.sectors;
    let bestDsq = Infinity;
    let bestTangent: { tx: number; ty: number } | null = null;
    for (const wallIdx of this.wallIndex.cellsTouchingSegmentPadded(
      x0,
      y0,
      x1,
      y1,
      radius,
    )) {
      const wall = this.sectorMap.walls[wallIdx];
      if (!wall) continue;
      if (
        !wall.solid &&
        wall.floorZOverride === undefined &&
        wall.ceilingZOverride === undefined
      ) {
        continue;
      }
      const wallTop =
        wall.ceilingZOverride !== undefined
          ? wall.ceilingZOverride
          : sectors[wall.sectorId]?.ceilingZ ?? 0;
      const wallBot =
        wall.floorZOverride !== undefined
          ? wall.floorZOverride
          : sectors[wall.sectorId]?.floorZ ?? 0;
      if (wallBot >= playerTop) continue; // head clearance
      if (wallTop <= stepLimitTop) continue;
      const sector = sectors[wall.sectorId];
      if (!sector) continue;
      const ends = wallEndpoints(wall, sector);
      if (!ends) continue;
      const a = ends.a;
      const b = ends.b;
      const d = pointSegmentDistance(a.x, a.y, b.x, b.y, x1, y1);
      if (d >= radius) continue;
      const dsq = d * d;
      if (dsq < bestDsq) {
        bestDsq = dsq;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        bestTangent = { tx: dx / len, ty: dy / len };
      }
    }
    return bestTangent;
  }

  // Polygon circle-passability: returns true iff a circle of
  // `radius` sweeping from (x0,y0) to (x1,y1) doesn't intersect
  // any blocking wall AND p1 lies inside a walkable sector. Walls
  // whose effective top is ≤ stepUpThreshold above `fromFloor`
  // are ignored — they're step-up risers the player can climb.
  // Non-solid walls (riser perimeters) are also ignored; the
  // sector-membership + step-up gates at the caller handle them.
  private circleSweepPassable(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    fromFloor: number,
    heightAboveFloor: number = 0,
    crouching: boolean = false,
  ): boolean {
    if (!this.sectorMap || !this.wallIndex) return true;
    // Enable verbose movement diagnostics by setting the env var
    // MOVE_DEBUG=1 on the server. Prints WHY a move was rejected
    // — `floorAt`, `ceilingAt`, dest sector, and which wall (if
    // any) blocked. Use this when the editor / playtest disagree
    // about whether the player can enter a pit / platform / etc.
    const debug = process.env.MOVE_DEBUG === '1';
    const climbBudget = Math.max(COMBAT.STEP_UP_MAX, heightAboveFloor);
    const floorCap = fromFloor + climbBudget;
    const dest = this.walkableSectorAt(x1, y1, floorCap);
    if (debug) {
      console.log(
        `[MOVE] from=(${x0.toFixed(1)},${y0.toFixed(1)}) to=(${x1.toFixed(1)},${y1.toFixed(1)}) ` +
          `r=${radius} fromFloor=${fromFloor} heightAboveFloor=${heightAboveFloor} crouch=${crouching} ` +
          `climbBudget=${climbBudget} floorCap=${floorCap} dest=${dest ? `s${dest.id}(floorZ=${dest.floorZ})` : 'NONE'}`,
      );
    }
    if (!dest) {
      if (debug) console.log(`[MOVE] REJECT: no walkable sector at dest`);
      return false;
    }
    // Step-up uses the TRUE floor at the destination (terrain +
    // platforms + authored sectors), capped so we don't reach
    // for an out-of-reach overhead. On hilly surfaces the sector
    // floorZ is 0 while the real floor can dip below or rise
    // above it.
    const toFloor = this.floorAt(x1, y1, floorCap);
    if (debug) {
      console.log(
        `[MOVE] toFloor=${toFloor} step=${toFloor - fromFloor} climbBudget=${climbBudget}`,
      );
    }
    if (toFloor - fromFloor > climbBudget) {
      if (debug)
        console.log(
          `[MOVE] REJECT: step ${toFloor - fromFloor} > budget ${climbBudget}`,
        );
      return false;
    }
    // Vertical clearance: the destination needs enough headroom
    // for the player's current vertical extent (crouch = 14,
    // stand = 24). Pass the destination floor to ceilingAt so
    // an overhead platform CAPS the headroom at its underside,
    // not at the room ceiling above it.
    const playerHeight = crouching
      ? COMBAT.PLAYER_HEIGHT_CROUCH
      : COMBAT.PLAYER_HEIGHT_STAND;
    const ceiling = this.ceilingAt(x1, y1, toFloor);
    if (debug) {
      console.log(
        `[MOVE] ceiling=${ceiling} headroom=${ceiling - toFloor} need=${playerHeight}`,
      );
    }
    if (ceiling - toFloor < playerHeight) {
      if (debug)
        console.log(
          `[MOVE] REJECT: headroom ${ceiling - toFloor} < ${playerHeight}`,
        );
      return false;
    }
    const stepLimitTop = fromFloor + climbBudget;
    const playerTop = fromFloor + playerHeight;
    const sectors = this.sectorMap.sectors;
    // Pad the query by radius so a wall the circle grazes without
    // its midpoint entering the cell still gets considered.
    for (const wallIdx of this.wallIndex.cellsTouchingSegmentPadded(
      x0,
      y0,
      x1,
      y1,
      radius,
    )) {
      const wall = this.sectorMap.walls[wallIdx];
      if (!wall) continue;
      // Authored portal walls — author flagged `solid: false`
      // with no vertical override (an open seam between two
      // walkable sectors). Movement passes through. Riser walls
      // are also `solid: false` but DO carry overrides; they
      // fall through to the height check below.
      if (
        !wall.solid &&
        wall.floorZOverride === undefined &&
        wall.ceilingZOverride === undefined
      ) {
        continue;
      }
      const wallTop =
        wall.ceilingZOverride !== undefined
          ? wall.ceilingZOverride
          : sectors[wall.sectorId]?.ceilingZ ?? 0;
      const wallBot =
        wall.floorZOverride !== undefined
          ? wall.floorZOverride
          : sectors[wall.sectorId]?.floorZ ?? 0;
      // Head clearance: the wall's bottom is above the player's
      // top. Lintels / soffits at the top of doorways pass this
      // check — player walks under them without colliding.
      if (wallBot >= playerTop) continue;
      // Step-overable: a riser whose top is within the player's
      // step-up reach. They naturally walk up; collision skips.
      // Solid full-height walls (always > stepLimitTop) and
      // un-climbable risers (top > stepLimitTop) both fall through
      // to the swept-circle check and block.
      if (wallTop <= stepLimitTop) continue;
      const sector = sectors[wall.sectorId];
      if (!sector) continue;
      const ends = wallEndpoints(wall, sector);
      if (!ends) continue;
      const a = ends.a;
      const b = ends.b;
      if (
        !sweptCircleClearsSegment(x0, y0, x1, y1, radius, a.x, a.y, b.x, b.y)
      ) {
        if (debug) {
          console.log(
            `[MOVE] REJECT: wall ${wallIdx} sector=s${wall.sectorId} ` +
              `seg=(${a.x.toFixed(1)},${a.y.toFixed(1)})→(${b.x.toFixed(1)},${b.y.toFixed(1)}) ` +
              `top=${wallTop} bot=${wallBot} solid=${wall.solid} ` +
              `playerTop=${playerTop} stepLimitTop=${stepLimitTop}`,
          );
        }
        return false;
      }
    }
    if (debug) console.log(`[MOVE] PASS`);
    return true;
  }

  // Spawn-flavoured floor lookup. Returns the LOWEST walkable
  // sector's floorZ at (x, y) — so a player whose authored spawn
  // point happens to fall inside an overlapping high platform
  // still lands on the ground level instead of on top of the
  // platform. Falls back to terrain / 0 when no sector matches.
  spawnFloorAt(x: number, y: number): number {
    if (!this.sectorMap) {
      const terrain = this.layout?.terrain;
      return terrain ? terrainHeightAt(terrain, x, y) : 0;
    }
    let lowest: number | null = null;
    for (const s of this.sectorMap.sectors) {
      if (s.buildingKind !== undefined) continue;
      // Skip open-air sentinel sectors (surface bounds) so spawn
      // resolves to terrain height when only the open sector
      // contains the point.
      if (s.ceilingZ <= s.floorZ) continue;
      if (!pointInPolygon(s.verts, x, y)) continue;
      if (lowest === null || s.floorZ < lowest) lowest = s.floorZ;
    }
    if (lowest === null) {
      const terrain = this.layout?.terrain;
      return terrain ? terrainHeightAt(terrain, x, y) : 0;
    }
    return lowest;
  }

  // Ceiling above a world point WITH a "from floor" context.
  // Used by jump head-bonk + vertical-clearance collision when
  // sectors stack vertically (a high platform overhead while
  // the player walks underneath at ground level). Picks the
  // lowest sector floor strictly above `fromFloor` at this XY,
  // else the containing sector's own ceilingZ. Open-air sectors
  // (ceilingZ < floorZ sentinel) return Infinity when no sector
  // overhead exists.
  ceilingAt(x: number, y: number, fromFloor: number = 0): number {
    if (!this.sectorMap) return Infinity;
    function polygonArea(s: import('@dumrunner/shared').Sector): number {
      let a = 0;
      for (let i = 0; i < s.verts.length; i++) {
        const p = s.verts[i];
        const q = s.verts[(i + 1) % s.verts.length];
        a += p.x * q.y - q.x * p.y;
      }
      return Math.abs(a) * 0.5;
    }
    // Step 1: find the SMALLEST containing sector at or below
    // the player's floor — that's the immediately-containing
    // sector and its ceiling is the baseline headroom.
    //
    // The floor-vs-fromFloor disqualifier compares the sector's
    // EFFECTIVE floor at (x, y) — baseline floorZ plus per-sector
    // noise displacement — not its raw floorZ. Without this,
    // floor noise that dips below the baseline would knock the
    // sector OUT of the containing-sector scan (its baseline 0
    // > the player's noise-displaced fromFloor of -0.04), the
    // overhead pass would then see the very same sector as an
    // overhead (smaller-area, floorZ > fromFloor), and ceiling
    // would collapse to 0 — head-clearance fails everywhere a
    // noise trough lands. Reproduced in MOVE_DEBUG output:
    // `ceiling=0 headroom=0.036 REJECT` at points right after
    // a noise trough.
    let containingArea = Infinity;
    let containingFloor = -Infinity;
    let containingCeiling = Infinity;
    for (const s of this.sectorMap.sectors) {
      if (s.buildingKind !== undefined) continue;
      if (!pointInPolygon(s.verts, x, y)) continue;
      const sFloor =
        s.floorZ +
        (s.floorNoise
          ? sectorNoiseOffsetAt(s.floorNoise, s.verts, s.holes, x, y)
          : 0);
      if (sFloor > fromFloor + 0.5) continue;
      if (s.ceilingZ <= s.floorZ) continue;
      const area = polygonArea(s);
      if (area < containingArea) {
        containingArea = area;
        containingFloor = sFloor;
        containingCeiling = s.ceilingZ;
      }
    }
    // Ceiling noise is RENDERER-ONLY — server collision uses the
    // flat ceilingZ. This way crank-it-up amplitudes can't
    // accidentally seal a room from movement (combined floor+
    // ceiling narrowing dropping headroom below playerHeight).
    // The visual cave-ceiling effect still renders; the player
    // just clips through any low overhang silhouette. If a real
    // collision-affecting low-ceiling primitive is wanted, the
    // user can carve a vent sub-sector with an explicit
    // ceilingZ instead — that hits the head-clearance check
    // because it's authored as a hard geometric primitive.
    // Step 2: a true "overhead" is a sub-sector INSIDE the
    // containing sector that has its floor strictly above the
    // player's. The outer parent room (whose floor is also
    // technically above the player when the player is in a
    // sunken sub-sector) is NOT an overhead — it's the parent,
    // and physically the player is below an opening, not under
    // a slab. Detect overhead = smaller-than-containing-sector
    // with floor > fromFloor.
    let lowestOverhead = Infinity;
    for (const s of this.sectorMap.sectors) {
      if (s.buildingKind !== undefined) continue;
      if (!pointInPolygon(s.verts, x, y)) continue;
      // Open-air sentinel (`ceilingZ <= floorZ`) is not a slab —
      // it's an explicit "no ceiling here" marker (surface scene,
      // convertOpenLayout). Without this skip, when an open-air
      // sector is the ONLY sector at the point the containing scan
      // misses it (correctly) AND the overhead scan picks it up
      // (incorrectly) — its `floorZ:0 > containingFloor:-Infinity`,
      // area < Infinity, so it reads as an overhead and collapses
      // the ceiling to 0. Headroom 0 rejects every move on the
      // surface.
      if (s.ceilingZ <= s.floorZ) continue;
      // Overhead = sub-sector strictly above the CONTAINING
      // sector's floor (not the player's noise-displaced one).
      // Same reason as above — without this, the player's own
      // sector reads as an overhead when a noise trough drops
      // their feet a fraction below the baseline.
      if (s.floorZ <= containingFloor + 0.5) continue;
      const area = polygonArea(s);
      if (area >= containingArea) continue; // parent or peer, skip
      if (s.floorZ < lowestOverhead) lowestOverhead = s.floorZ;
    }
    return Math.min(containingCeiling, lowestOverhead);
  }

  // Floor height under a world point. Three sources combined
  // through a ceiling-aware max: the player's "current floor"
  // wins over a higher sector at the same XY only when reaching
  // it would exceed the floor cap. Used both for step-up gating
  // (cap = fromFloor + STEP_UP_MAX so you don't snap onto a
  // taller platform) and for "where am I standing now" queries
  // (cap = +Infinity).
  //
  // Sources, in order:
  //   1. Noise terrain (signed; baseline). Always applies.
  //   2. Tile-rect platforms (legacy procgen primitive).
  //   3. Authored sector floors. Skipped when sector.floorZ
  //      exceeds the cap — that's what lets you walk UNDER a
  //      high platform without snapping up onto it.
  floorAt(x: number, y: number, cap: number = Infinity): number {
    let z = 0;
    const terrain = this.layout?.terrain;
    if (terrain) z = terrainHeightAt(terrain, x, y);
    const platforms = this.layout?.platforms;
    if (platforms && platforms.length > 0) {
      const tileSize = this.layout?.tileSize ?? 32;
      if (tileSize > 0) {
        for (const p of platforms) {
          const x0 = p.tileX * tileSize;
          const y0 = p.tileY * tileSize;
          const x1 = x0 + p.w * tileSize;
          const y1 = y0 + p.h * tileSize;
          if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
          if (p.floorZ > cap) continue;
          if (p.floorZ > z) z = p.floorZ;
        }
      }
    }
    if (this.sectorMap) {
      // Pick the SMALLEST containing sector's floor (by polygon
      // area) — that's the immediate sub-sector the point lies
      // in. Carved pits / vents inside an outer room win because
      // they're smaller, so the player drops into the pit instead
      // of standing on the parent room's floor. Sectors whose
      // floor is above `cap` (= currentFloor + STEP_UP_MAX) are
      // skipped — out-of-reach platforms can't be stepped onto;
      // a deeper containing sector (e.g. outer room) wins.
      let bestArea = Infinity;
      let bestFloor: number | null = null;
      let bestSector: typeof this.sectorMap.sectors[number] | null = null;
      for (const s of this.sectorMap.sectors) {
        if (s.buildingKind !== undefined) continue;
        // Open-air sentinel sectors (ceilingZ<=floorZ) are bounds
        // markers, not authored floors. Skip them so terrain wins
        // on the surface — otherwise the sector's flat floorZ:0
        // overrides terrain height and the player walks through
        // hills + projectiles spawn at z=0 instead of the shooter's
        // actual elevation.
        if (s.ceilingZ <= s.floorZ) continue;
        if (s.floorZ > cap) continue;
        if (!pointInPolygon(s.verts, x, y)) continue;
        let a = 0;
        for (let i = 0; i < s.verts.length; i++) {
          const p = s.verts[i];
          const q = s.verts[(i + 1) % s.verts.length];
          a += p.x * q.y - q.x * p.y;
        }
        const area = Math.abs(a) * 0.5;
        if (area < bestArea) {
          bestArea = area;
          bestFloor = s.floorZ;
          bestSector = s;
        }
      }
      if (bestFloor !== null) {
        z = bestFloor;
        // Per-sector noise displacement, falling off to 0 at the
        // polygon perimeter so portals match the neighbour's flat
        // floor.
        if (bestSector?.floorNoise) {
          z += sectorNoiseOffsetAt(
            bestSector.floorNoise,
            bestSector.verts,
            bestSector.holes,
            x,
            y,
          );
        }
      }
    }
    return z;
  }

  // Bounding-circle passability: 16 perimeter samples must all pass.
  // Rebuilt locally rather than reusing circleFits — that helper checks
  // walkables only and doesn't know about buildings.
  private circlePassable(x: number, y: number, radius: number): boolean {
    const samples = COLLISION_UNITS;
    for (const u of samples) {
      if (!this.pointPassable(x + u.ux * radius, y + u.uy * radius)) return false;
    }
    return true;
  }

  // Segment passability for LoS: stays inside walkable cells AND
  // doesn't pass through any building tile. When the tile grid is
  // present, sample along the segment and reject any cell that
  // isn't a floor tile id (catches template-stamped walls).
  private segmentClear(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): boolean {
    if (POLY_COLLISION && this.sectorMap && this.wallIndex) {
      return this.segmentClearPolygon(x1, y1, x2, y2);
    }
    if (this.layout?.tileGrid && this.layoutTiles) {
      const grid = this.layout.tileGrid;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      // Sample at half-tile stride so a 1-tile-wide pillar can't
      // slip between samples.
      const step = Math.max(8, grid.tileSize / 2);
      const steps = Math.max(1, Math.ceil(len / step));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const sx = x1 + dx * t;
        const sy = y1 + dy * t;
        const id = tileIdAt(grid, this.layoutTiles, sx, sy);
        if (!isWalkableTileId(id)) return false;
      }
    } else {
      const walkables = this.layout?.walkables ?? [];
      if (
        walkables.length > 0 &&
        !segmentInsideWalkables(walkables, x1, y1, x2, y2)
      ) {
        return false;
      }
    }
    if (this.buildings.size === 0) return true;
    // 8px sample stride — half the smallest tile dimension we ship
    // (32px tiles, 1×1 doors). Cheap; guarantees no door is missed.
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len / 8));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this.isPointInAnyBuilding(x1 + dx * t, y1 + dy * t)) return false;
    }
    return true;
  }

  // Polygon LOS / projectile path. True iff the segment doesn't
  // intersect any solid wall whose vertical span overlaps the
  // sight-line's plane. We ignore Z for now — projectiles travel
  // in the (x, y) plane at a fixed eye-relative height; v2.1 adds
  // a vertical filter (so e.g. a 12-wu riser doesn't block a
  // shoulder-height shot). Cube walls span the full room height
  // and block reliably already.
  //
  // Risers below the LOS threshold are step-overable for movement
  // but for sight / projectiles they DO block — you can't see /
  // shoot through a 2-wu lip just because you could walk over it.
  // First-cut rule: every wall blocks except risers shorter than
  // 4 wu, which we treat as "feet-only" geometry (no door / wall
  // lower than this in the current content).
  private segmentClearPolygon(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): boolean {
    return this.segmentNearestWallT(x1, y1, x2, y2) === null;
  }

  // First wall-segment intersection along (x1,y1,z1) →
  // (x2,y2,z2), as a parameter t ∈ [0, 1]. Filters walls whose
  // vertical span doesn't overlap the bullet's Z at the
  // intersection — so a bullet flying over a low riser passes
  // freely. Used by the projectile loop for terrain-aware hits.
  private segmentNearestWallTZ(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
  ): number | null {
    if (!this.sectorMap || !this.wallIndex) return null;
    const sectors = this.sectorMap.sectors;
    let best: number | null = null;
    for (const wallIdx of this.wallIndex.cellsTouchingSegment(x1, y1, x2, y2)) {
      const wall = this.sectorMap.walls[wallIdx];
      if (!wall) continue;
      // Authored portal walls — open seam, no collision for
      // movement, projectiles, OR sight.
      if (
        !wall.solid &&
        wall.floorZOverride === undefined &&
        wall.ceilingZOverride === undefined
      ) {
        continue;
      }
      const wallTop =
        wall.ceilingZOverride !== undefined
          ? wall.ceilingZOverride
          : sectors[wall.sectorId]?.ceilingZ ?? 0;
      const wallBot =
        wall.floorZOverride !== undefined
          ? wall.floorZOverride
          : sectors[wall.sectorId]?.floorZ ?? 0;
      if (wallTop - wallBot < 4) continue;
      const sector = sectors[wall.sectorId];
      if (!sector) continue;
      const ends = wallEndpoints(wall, sector);
      if (!ends) continue;
      const a = ends.a;
      const b = ends.b;
      const t = segmentSegmentIntersect(
        x1, y1, x2, y2,
        a.x, a.y, b.x, b.y,
      );
      if (t === null) continue;
      const hitZ = z1 + (z2 - z1) * t;
      if (hitZ < wallBot || hitZ > wallTop) continue;
      if (best === null || t < best) best = t;
    }
    return best;
  }

  // First wall-segment intersection along (x1,y1) → (x2,y2), as
  // a parameter t ∈ [0, 1]. Returns null when the segment passes
  // freely. Used by LOS (boolean wrapper via segmentClearPolygon)
  // and by the projectile loop (consumes t to land the despawn
  // at the contact point). Low risers (< 4 wu) are ignored — the
  // first-cut sight rule treats them as feet-level geometry.
  private segmentNearestWallT(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): number | null {
    if (!this.sectorMap || !this.wallIndex) return null;
    const sectors = this.sectorMap.sectors;
    let best: number | null = null;
    for (const wallIdx of this.wallIndex.cellsTouchingSegment(x1, y1, x2, y2)) {
      const wall = this.sectorMap.walls[wallIdx];
      if (!wall) continue;
      // Authored portal walls — open seam, no collision for
      // movement, projectiles, OR sight.
      if (
        !wall.solid &&
        wall.floorZOverride === undefined &&
        wall.ceilingZOverride === undefined
      ) {
        continue;
      }
      const wallTop =
        wall.ceilingZOverride !== undefined
          ? wall.ceilingZOverride
          : sectors[wall.sectorId]?.ceilingZ ?? 0;
      const wallBot =
        wall.floorZOverride !== undefined
          ? wall.floorZOverride
          : sectors[wall.sectorId]?.floorZ ?? 0;
      if (wallTop - wallBot < 4) continue;
      const sector = sectors[wall.sectorId];
      if (!sector) continue;
      const ends = wallEndpoints(wall, sector);
      if (!ends) continue;
      const a = ends.a;
      const b = ends.b;
      const t = segmentSegmentIntersect(
        x1, y1, x2, y2,
        a.x, a.y, b.x, b.y,
      );
      if (t === null) continue;
      if (best === null || t < best) best = t;
    }
    return best;
  }

  private isPointInAnyBuilding(x: number, y: number): boolean {
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return false;
    for (const b of this.buildings.values()) {
      // Open player-built doors are walk-through. Same check
      // doubles for projectile collision (LoS goes through too).
      if (b.kind === 'wall_door' && b.open === true) continue;
      const px = b.tileX * tileSize;
      const py = b.tileY * tileSize;
      const pw = b.width * tileSize;
      const ph = b.height * tileSize;
      if (x >= px && x <= px + pw && y >= py && y <= py + ph) return true;
    }
    return false;
  }

  // ---------- enemy spawning ----------

  // Idempotently seed the surface Power Link at the configured tile.
  // Skips if a power_link already exists (e.g. loaded from snapshot or
  // already alive). Returns the building (existing or new).
  ensurePowerLink(
    tileX: number,
    tileY: number,
    width: number,
    height: number
  ): BuildingRuntime {
    if (this.kind !== 'surface') {
      throw new Error('ensurePowerLink called on non-surface scene');
    }
    for (const b of this.buildings.values()) {
      if (b.kind === 'power_link') return b;
    }
    const linkMaxHp = buildingMaxHp('power_link');
    const id = `b${this.nextBuildingId++}`;
    const building: BuildingRuntime = {
      id,
      kind: 'power_link',
      tileX,
      tileY,
      width,
      height,
      hp: linkMaxHp,
      maxHp: linkMaxHp,
      lastFireAt: 0,
      output: [],
    };
    this.buildings.set(id, building);
    this.broadcast({ type: 'building_placed', building: toBuildingState(building) });
    this.notifyBuildingsChanged();
    return building;
  }

  // Spawn the portal cubes (stairs_down + extract_pad) at the
  // matching interactables' tile positions. Same role as
  // ensurePowerLink on the surface: gives each portal a physical,
  // animatable building visual at the spot the player E-presses.
  // Idempotent — if a building of the same kind already exists
  // (snapshot rehydrate, second call) we skip it. Dungeon-only;
  // calling on a surface scene is a no-op because the surface uses
  // the power_link building for the entrance instead.
  ensurePortalBuildings(): void {
    if (this.kind !== 'dungeon_floor') return;
    const layout = this.layout;
    if (!layout) return;
    const tileSize = layout.tileSize;
    if (!tileSize || tileSize <= 0) return;
    const PORTAL_KINDS: ReadonlySet<BuildingKind> = new Set([
      'stairs_down',
      'extract_pad',
    ]);
    // Index existing kinds so re-runs are O(1).
    const existing = new Set<BuildingKind>();
    for (const b of this.buildings.values()) existing.add(b.kind);
    for (const it of layout.interactables) {
      const kind = it.kind as BuildingKind;
      if (!PORTAL_KINDS.has(kind)) continue;
      if (existing.has(kind)) continue;
      const tileX = Math.floor(it.x / tileSize);
      const tileY = Math.floor(it.y / tileSize);
      const maxHp = buildingMaxHp(kind);
      const id = `b${this.nextBuildingId++}`;
      const building: BuildingRuntime = {
        id,
        kind,
        tileX,
        tileY,
        width: 1,
        height: 1,
        hp: maxHp,
        maxHp,
        lastFireAt: 0,
        output: [],
      };
      this.buildings.set(id, building);
      existing.add(kind);
      this.broadcast({
        type: 'building_placed',
        building: toBuildingState(building),
      });
    }
    this.notifyBuildingsChanged();
    // Procgen places the extract_pad ~1.5 tiles from the entrance
    // centre — in narrow (3-tile) entrance rooms that collapses
    // onto the spawn cell, so a fresh descend would teleport the
    // player inside the newly-placed cube and they'd be stuck.
    // Snap the spawn to a clear neighbour cell whenever the cube
    // and the spawn collide.
    this.snapSpawnClearOfBuildings();
  }

  // If the layout's spawn point now sits inside any building's
  // footprint (e.g. a portal cube placed on top of it), search
  // outward in one-tile rings for the nearest passable cell and
  // rewrite layout.spawn to its centre. No-op when the existing
  // spawn is already clear.
  private snapSpawnClearOfBuildings(): void {
    const layout = this.layout;
    if (!layout) return;
    const tileSize = layout.tileSize ?? 32;
    if (tileSize <= 0) return;
    const spawn = layout.spawn;
    if (this.circlePassable(spawn.x, spawn.y, COMBAT.PLAYER_RADIUS)) return;
    const tx0 = Math.floor(spawn.x / tileSize);
    const ty0 = Math.floor(spawn.y / tileSize);
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = (tx0 + dx + 0.5) * tileSize;
          const cy = (ty0 + dy + 0.5) * tileSize;
          if (this.circlePassable(cx, cy, COMBAT.PLAYER_RADIUS)) {
            spawn.x = cx;
            spawn.y = cy;
            return;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[scene] snapSpawnClearOfBuildings exhausted search in ${this.id}; spawn left at (${spawn.x},${spawn.y})`,
    );
  }

  // Sandbox playtest helper. Drops a starter set of workstations on
  // the surface so the tester doesn't have to hand-craft + place
  // each one to start exercising Phase 2's flows. Idempotent — for
  // each spec, only places a building if no building of that kind
  // already exists on the surface (lets the player demolish and
  // re-place; only re-spawns on a fresh world). Skips a spec if its
  // tile is already occupied by a different building.
  ensurePlaytestStations(
    specs: { kind: BuildingKind; tileX: number; tileY: number }[]
  ): void {
    if (this.kind !== 'surface') return;
    const existingKinds = new Set<BuildingKind>();
    const occupiedTiles = new Set<string>();
    for (const b of this.buildings.values()) {
      existingKinds.add(b.kind);
      occupiedTiles.add(`${b.tileX},${b.tileY}`);
    }
    for (const spec of specs) {
      if (existingKinds.has(spec.kind)) continue;
      if (occupiedTiles.has(`${spec.tileX},${spec.tileY}`)) continue;
      const maxHp = buildingMaxHp(spec.kind);
      const id = `b${this.nextBuildingId++}`;
      const building: BuildingRuntime = {
        id,
        kind: spec.kind,
        tileX: spec.tileX,
        tileY: spec.tileY,
        width: 1,
        height: 1,
        hp: maxHp,
        maxHp,
        lastFireAt: 0,
        output: emptyBufferForKind(spec.kind),
        benchTier: spec.kind === 'weapon_bench' ? 1 : undefined,
      };
      this.buildings.set(id, building);
      occupiedTiles.add(`${spec.tileX},${spec.tileY}`);
      existingKinds.add(spec.kind);
      this.broadcast({
        type: 'building_placed',
        building: toBuildingState(building),
      });
      ensureBuildingAsset(spec.kind);
    }
    this.notifyBuildingsChanged();
  }

  // Open (remove) a door building AND every adjacent door connected to
  // it via 4-connected adjacency. A 2-wide corridor produces 2 adjacent
  // door tiles that the player perceives as a single door — flood-fill
  // means one key opens the whole entrance instead of charging per tile.
  openDoor(buildingId: string): boolean {
    const start = this.buildings.get(buildingId);
    if (!start || start.kind !== 'door') return false;
    const visited = new Set<string>();
    const queue: BuildingRuntime[] = [start];
    while (queue.length > 0) {
      const b = queue.shift()!;
      if (visited.has(b.id)) continue;
      visited.add(b.id);
      this.buildings.delete(b.id);
      this.broadcast({ type: 'building_destroyed', id: b.id });
      for (const other of this.buildings.values()) {
        if (other.kind !== 'door') continue;
        if (visited.has(other.id)) continue;
        const dx = Math.abs(other.tileX - b.tileX);
        const dy = Math.abs(other.tileY - b.tileY);
        if (dx + dy === 1) queue.push(other);
      }
    }
    // Doors are buildings; their cube walls live in the sector map.
    // Without a rebuild the opened door keeps blocking movement +
    // projectiles even though it no longer renders.
    this.notifyBuildingsChanged();
    return true;
  }

  // E5: look up a container prop by id. Returns null when the
  // prop doesn't exist OR isn't a container (caller validates).
  getContainerProp(propId: string): PropRuntime | null {
    const p = this.props.get(propId);
    if (!p || !p.alive) return null;
    if (!p.inventory) return null;
    return p;
  }

  // Flip a container's `opened` flag and broadcast the new state.
  // Idempotent — already-opened containers just rebroadcast (cheap).
  openContainerProp(propId: string): PropRuntime | null {
    const p = this.getContainerProp(propId);
    if (!p) return null;
    p.opened = true;
    this.broadcast({ type: 'prop_changed', prop: toPropState(p) });
    return p;
  }

  // Move a single inventory slot from a container into the target
  // inventory (player). Stack-merges via addInventorySlot. Returns
  // true on success; rebroadcasts prop_changed so other clients
  // refresh hasItems for the visual swap.
  takeFromContainer(
    propId: string,
    slot: number,
    target: import('@dumrunner/shared').Inventory,
  ): { ok: boolean; remaining?: import('@dumrunner/shared').InventorySlot } {
    const p = this.getContainerProp(propId);
    if (!p || !p.inventory) return { ok: false };
    if (slot < 0 || slot >= p.inventory.length) return { ok: false };
    const src = p.inventory[slot];
    if (src.kind === 'empty') return { ok: false };
    const remaining = this.routeSlotIntoInventory(src, target);
    p.inventory[slot] =
      remaining ?? ({ kind: 'empty' } as import('@dumrunner/shared').InventorySlot);
    this.broadcast({ type: 'prop_changed', prop: toPropState(p) });
    return { ok: true, remaining: remaining ?? undefined };
  }

  // Send the container's full inventory to a single connection
  // (the opener). Mirrors the chest open flow but uses the
  // prop_inventory message type so the client routes it to the
  // container modal.
  shipContainerInventory(propId: string, characterId: string): void {
    const p = this.getContainerProp(propId);
    if (!p || !p.inventory) return;
    this.bindings.send(characterId, {
      type: 'prop_inventory',
      propId: p.id,
      inventory: p.inventory.map((s) => ({ ...s })),
    });
  }

  // Helper: route a single InventorySlot into an Inventory using
  // the per-kind add helpers. Returns the leftover slot when the
  // target couldn't accept the full count (stack overflow);
  // returns null when fully consumed.
  private routeSlotIntoInventory(
    s: import('@dumrunner/shared').InventorySlot,
    inv: import('@dumrunner/shared').Inventory,
  ): import('@dumrunner/shared').InventorySlot | null {
    if (s.kind === 'empty') return null;
    if (s.kind === 'material') {
      const left = addMaterial(inv, s.materialId, s.count);
      return left > 0 ? { kind: 'material', materialId: s.materialId, count: left } : null;
    }
    // For non-material types we'd need parallel add helpers; for
    // now containers are material-only (matches the lootTable
    // schema). Fall through to "couldn't route" so the caller
    // leaves the slot in the container.
    return s;
  }

  // Toggle a player-built wall_door's open state. Unlike openDoor,
  // the building persists — only the `open` flag flips, and the new
  // state is re-broadcast as building_placed so each client refreshes
  // its renderer / collision state. No flood-fill: each wall_door is
  // an independent 1x1 placeable.
  toggleWallDoor(buildingId: string): boolean {
    const b = this.buildings.get(buildingId);
    if (!b || b.kind !== 'wall_door') return false;
    b.open = !b.open;
    // Open/close changes whether the door's cube walls block —
    // SectorMap rebuild keeps polygon collision in sync.
    this.rebuildSectorMap();
    this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
    return true;
  }

  // Look up a building by id (for World callbacks that need to inspect
  // the live state, e.g. checking whether the Power Link is still alive).
  getBuilding(id: string): BuildingState | null {
    const b = this.buildings.get(id);
    return b ? { ...b } : null;
  }

  // Phase 2.2: lift a workstation building's tier. Mutates the live
  // state and re-broadcasts building_placed so every client picks up
  // the new tier (the assembly modal reads benchTier off the live
  // building snapshot).
  setBuildingTier(id: string, tier: 1 | 2 | 3 | 4): boolean {
    const b = this.buildings.get(id);
    if (!b) return false;
    b.benchTier = tier;
    this.broadcast({ type: 'building_placed', building: toBuildingState(b) });
    return true;
  }

  // Returns the first alive building of the given kind, or null. Used to
  // gate the surface descent on the Power Link being intact.
  findBuildingByKind(kind: BuildingKind): BuildingState | null {
    for (const b of this.buildings.values()) {
      if (b.kind === kind) return { ...b };
    }
    return null;
  }

  // All alive buildings whose kind is in the requested set, sorted by
  // building id for deterministic iteration. Used by the power system to
  // pick which turrets fit under capacity.
  findBuildingsByKind(kinds: BuildingKind[]): BuildingState[] {
    const allowed = new Set(kinds);
    const out: BuildingState[] = [];
    for (const b of this.buildings.values()) {
      if (allowed.has(b.kind)) out.push({ ...b });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  private populateSurface(): void {
    for (const spawn of SURFACE_SPAWNS) {
      const tpl = TEMPLATES[spawn.templateId];
      if (!tpl) {
        console.warn(`[scene ${this.id}] unknown template ${spawn.templateId}`);
        continue;
      }
      const id = `e${this.nextEnemyId++}`;
      this.enemies.set(id, instantiateEnemy(id, tpl, spawn.x, spawn.y));
      ensureEnemyAsset(tpl);
    }
    this.scatterOverworldProps();
  }

  // Scatter decorative props across the surface, driven by the
  // first authored overworld biome's propPalette + propDensity.
  // No-ops when no overworld biome exists or its palette is empty.
  // Skips a clear zone around the spawn / power link so the player
  // never lands inside a rock.
  private scatterOverworldProps(): void {
    const biome = getOverworldBiome();
    if (!biome) return;
    const palette = biome.propPalette;
    if (palette.length === 0) return;
    const density = biome.overworld?.propDensity ?? 1;
    if (density <= 0) return;
    const layout = this.layout;
    if (!layout || !layout.worldBounds) return;
    const ts = layout.tileSize;
    const tilesW = Math.floor(layout.worldBounds.w / ts);
    const tilesH = Math.floor(layout.worldBounds.h / ts);
    // density = props per 100 tiles. Total area in tiles → count.
    const propCount = Math.floor((tilesW * tilesH * density) / 100);
    if (propCount <= 0) return;
    // Cumulative weights for biased pick. Rolled with a deterministic
    // RNG seeded by world bounds + density so reboots reproduce the
    // same scatter (until the user re-authors the biome).
    const totalWeight = palette.reduce((s, e) => s + Math.max(0, e.weight), 0);
    if (totalWeight <= 0) return;
    let seed = (tilesW * 0x9e3779b1) ^ (tilesH * 0x85ebca77);
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Clear zone around the surface entry / power link so the
    // player isn't trapped in scatter on spawn.
    const CLEAR_RADIUS_PX = 256;
    const clearX = layout.spawn?.x ?? 0;
    const clearY = layout.spawn?.y ?? 0;
    const clearR2 = CLEAR_RADIUS_PX * CLEAR_RADIUS_PX;
    for (let i = 0; i < propCount; i++) {
      const x = layout.worldBounds.x + rand() * layout.worldBounds.w;
      const y = layout.worldBounds.y + rand() * layout.worldBounds.h;
      const dxc = x - clearX;
      const dyc = y - clearY;
      if (dxc * dxc + dyc * dyc < clearR2) continue;
      // Weighted palette pick.
      const roll = rand() * totalWeight;
      let acc = 0;
      let chosen = palette[0];
      for (const entry of palette) {
        acc += Math.max(0, entry.weight);
        if (roll <= acc) {
          chosen = entry;
          break;
        }
      }
      const def = PROPS[chosen.id];
      if (!def) continue;
      const id = `prop_${this.nextPropId++}`;
      const runtime: PropRuntime = {
        id,
        kind: chosen.id,
        x,
        y,
        hp: def.hp,
        maxHp: def.hp,
        alive: true,
      };
      this.applyContainerInit(runtime, def);
      // Container collision: skip placement if the snapped tile
      // footprint overlaps another container or the spawn-clear
      // zone. Cheap O(N) check; container counts stay low.
      if (def.container && this.containerOverlaps(runtime)) continue;
      this.props.set(id, runtime);
    }
  }

  // True when the container's tile footprint overlaps any other
  // existing container or building — used during scatter to keep
  // placements from stacking on the same tiles.
  private containerOverlaps(c: PropRuntime): boolean {
    if (c.tileX === undefined || c.tileY === undefined) return false;
    const w = c.tileWidth ?? 1;
    const d = c.tileDepth ?? 1;
    for (const other of this.props.values()) {
      if (other.tileX === undefined || other.tileY === undefined) continue;
      const ow = other.tileWidth ?? 1;
      const od = other.tileDepth ?? 1;
      if (
        c.tileX < other.tileX + ow &&
        c.tileX + w > other.tileX &&
        c.tileY < other.tileY + od &&
        c.tileY + d > other.tileY
      ) {
        return true;
      }
    }
    for (const b of this.buildings.values()) {
      if (
        c.tileX < b.tileX + b.width &&
        c.tileX + w > b.tileX &&
        c.tileY < b.tileY + b.height &&
        c.tileY + d > b.tileY
      ) {
        return true;
      }
    }
    return false;
  }

  private populateFromSpawns(spawns: InitialEnemySpawn[]): void {
    for (const spawn of spawns) {
      const tpl = TEMPLATES[spawn.templateId];
      if (!tpl) {
        console.warn(`[scene ${this.id}] unknown template ${spawn.templateId}`);
        continue;
      }
      const id = `e${this.nextEnemyId++}`;
      this.enemies.set(id, instantiateEnemy(id, tpl, spawn.x, spawn.y));
      ensureEnemyAsset(tpl);
    }
  }

  // ---------- projectile spawn helper ----------

  private spawnProjectile(args: {
    ownerKind: ProjectileOwnerKind;
    ownerId: string;
    fromX: number;
    fromY: number;
    dirX: number;
    dirY: number;
    speed: number;
    damage: number;
    ttlMs: number;
    radius: number;
    color: number;
    // Optional world-Z origin. When unset, defaults to standing
    // eye height above terrain floor — fine for AI / turret fire
    // which doesn't have a meaningful crouch / jump state.
    originZ?: number;
    // Vertical velocity at spawn (wu/s). Comes from the camera
    // pitch for player fire; defaults to 0 (flat) for AI / turrets.
    vzInit?: number;
    imbues?: ProjectileRuntime['imbues'];
    weaponId?: string;
  }): void {
    const id = `p${this.nextProjectileId++}`;
    const originZ =
      args.originZ ??
      this.floorAt(args.fromX, args.fromY) + COMBAT.EYE_HEIGHT_STAND;
    const proj: ProjectileRuntime = {
      id,
      ownerCharacterId: args.ownerId,
      ownerKind: args.ownerKind,
      x: args.fromX,
      y: args.fromY,
      z: originZ,
      vx: args.dirX * args.speed,
      vy: args.dirY * args.speed,
      vz: args.vzInit ?? 0,
      color: args.color,
      expiresAt: Date.now() + args.ttlMs,
      damage: args.damage,
      radius: args.radius,
      originZ,
      imbues: args.imbues,
      weaponId: args.weaponId,
    };
    this.projectiles.set(id, proj);
    this.broadcast({ type: 'projectile_spawned', projectile: toProjectileState(proj) });
  }
}

// ---------- world bindings interface ----------
// What Scene needs from its containing World. Lets Scene stay decoupled from
// the World class implementation and easy to test in isolation.
export interface SceneBindings {
  connection(characterId: string): SceneConnection | undefined;
  send(characterId: string, msg: ServerMessage): void;
  // Triggered by Scene when a player walks onto an interactable (stairs,
  // extract pad). World decides what scene to transition to based on kind.
  onInteractable(
    characterId: string,
    fromSceneId: string,
    kind: InteractableKind
  ): void;
  // Triggered by Scene after the post-death timer elapses. World restores
  // HP and transitions the player back to the surface base. The corpse
  // stays in the original scene for recovery.
  onPlayerRespawn(characterId: string): void;
  // Triggered the moment a player's hp hits 0. World posts a system
  // chat line; killer name is passed when known (otherwise null for
  // environmental / generic deaths).
  onPlayerDied(characterId: string, killer: string | null): void;
  // Triggered the moment a power_link building is destroyed. World owns
  // the cascading reset (drop dungeon scenes, evict any players in them,
  // reset deepest-floor counter, mark power offline).
  onPowerLinkDestroyed(): void;
  // Read-only: whether the world's Power Link is alive. Scene's turret
  // tick gates fire on this so destroying the Link silences defences.
  isPowerOnline(): boolean;
  // Read-only per-building powered state. World decides which consumers
  // (turrets + Phase 4 craft jobs) fit under the depth-scaled capacity.
  isPowered(buildingId: string): boolean;
  // Called by Scene when a building is placed, destroyed, or has its
  // kind/identity change. World recomputes power capacity / draw and
  // broadcasts the new power state.
  onBuildingsChanged(): void;
  // Per-server world rule: true = bag + equipped suit drops as a corpse
  // on death (full-loot mode), false = both stay with the player.
  dropItemsOnDeath(): boolean;
  // Triggered when Scene mutates a player's equipment (currently only
  // killPlayer's death-drop). World recomputes suit stats and clamps
  // hp/shield/stamina against the new lower maxes; then broadcasts
  // 'equipment_changed' so the client HUD catches up.
  onPlayerEquipmentChanged(characterId: string): void;
  // Apply a timed status effect to a player. Routes through World so
  // the same id refreshes the timer instead of stacking, and the
  // 'player_effects' broadcast carries the authoritative list.
  applyPlayerEffect(
    characterId: string,
    effect: import('@dumrunner/shared').PlayerEffect
  ): void;
  // True when the world allows player-vs-player damage. Live and
  // sandbox return false; deathmatch returns true. Gates the
  // PvP collision loop in projectile + melee processing.
  pvpEnabled(): boolean;
  // Optional: notified on every PvP kill so the World can update
  // round score, check win condition, broadcast scoreboard. Only
  // present on deathmatch worlds — live / sandbox don't wire it.
  onDeathmatchKill?(
    killerCharacterId: string,
    victimCharacterId: string,
    killerKills: number,
    victimDeaths: number,
  ): void;
}

// ---------- helpers ----------

// Swept circle-vs-circle. Origin (ox,oy), motion (mx,my), target circle
// (cx,cy) of effective radius r. Returns the first t in [0,1] at which
// the moving point enters the circle, or null on miss. Reduces to the
// classic segment-vs-circle quadratic.
function sweptCircleHit(
  ox: number,
  oy: number,
  mx: number,
  my: number,
  cx: number,
  cy: number,
  r: number
): number | null {
  // Stationary moving point — fall back to a contains check.
  if (mx === 0 && my === 0) {
    const dx = ox - cx;
    const dy = oy - cy;
    return dx * dx + dy * dy <= r * r ? 0 : null;
  }
  const fx = ox - cx;
  const fy = oy - cy;
  const a = mx * mx + my * my;
  const b = 2 * (fx * mx + fy * my);
  const c = fx * fx + fy * fy - r * r;
  // Already inside — hit at t = 0.
  if (c <= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  return null;
}

// Swept point-vs-AABB. (ox,oy)+motion against the box [minX,minY,maxX,
// maxY]. The projectile's radius is folded into the box (caller expands
// the half-extents by r), so this is a plain point-vs-box ray clip.
function sweptAabbHit(
  ox: number,
  oy: number,
  mx: number,
  my: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number | null {
  // Slab method.
  let tEnter = 0;
  let tExit = 1;
  const test = (origin: number, dir: number, lo: number, hi: number) => {
    if (Math.abs(dir) < 1e-8) {
      if (origin < lo || origin > hi) return false;
      return true;
    }
    let t1 = (lo - origin) / dir;
    let t2 = (hi - origin) / dir;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tEnter = Math.max(tEnter, t1);
    tExit = Math.min(tExit, t2);
    return tEnter <= tExit;
  };
  if (!test(ox, mx, minX, maxX)) return null;
  if (!test(oy, my, minY, maxY)) return null;
  if (tEnter > 1 || tExit < 0) return null;
  return Math.max(0, tEnter);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function toEnemyState(e: EnemyRuntime): EnemyState {
  return { id: e.id, kind: e.kind, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp };
}

function toLootState(l: LootRuntime): LootState {
  return { id: l.id, content: l.content, x: l.x, y: l.y };
}

// Process-unique counter for material/scatter loot ids. Part loot reuses the
// CarriedPart.id from loot.ts; this only covers non-part drops.
let _lootCounter = 0;
function nextLootCounter(): number {
  return _lootCounter++;
}

function toCorpseState(c: CorpseRuntime): CorpseState {
  return {
    id: c.id,
    ownerCharacterId: c.ownerCharacterId,
    ownerDisplayName: c.ownerDisplayName,
    x: c.x,
    y: c.y,
    inventory: c.inventory,
  };
}

function toPropState(p: PropRuntime): PropState {
  // Container props ship their footprint + open flag every tick
  // (cheap — handful of integers). Inventory contents are NOT
  // broadcast — only sent privately to the player who has the
  // container open via prop_inventory_changed.
  const hasItems = p.inventory
    ? p.inventory.some((s) => s.kind !== 'empty')
    : false;
  return {
    id: p.id,
    kind: p.kind,
    x: p.x,
    y: p.y,
    hp: p.hp,
    maxHp: p.maxHp,
    ...(p.tileX !== undefined ? { tileX: p.tileX } : {}),
    ...(p.tileY !== undefined ? { tileY: p.tileY } : {}),
    ...(p.tileWidth !== undefined ? { tileWidth: p.tileWidth } : {}),
    ...(p.tileDepth !== undefined ? { tileDepth: p.tileDepth } : {}),
    ...(p.heightMult !== undefined ? { heightMult: p.heightMult } : {}),
    ...(p.opened !== undefined ? { opened: p.opened } : {}),
    ...(p.inventory ? { hasItems } : {}),
  };
}

function toBuildingState(b: BuildingRuntime): BuildingState {
  // For stations (workbench / forge / etc) we only ship `output`
  // when something's in the buffer — saves bytes when most stations
  // are idle. Storage chests always ship the full 16-slot array so
  // the open-chest modal can render an empty grid; otherwise the
  // client thinks the chest has zero slots.
  const isChest = b.kind === 'storage_chest';
  const hasOutput = b.output.some((s) => s.kind !== 'empty');
  const includeOutput = isChest || hasOutput;
  return {
    id: b.id,
    kind: b.kind,
    tileX: b.tileX,
    tileY: b.tileY,
    width: b.width,
    height: b.height,
    hp: b.hp,
    maxHp: b.maxHp,
    ...(includeOutput ? { output: b.output.map((s) => ({ ...s })) } : {}),
    ...(b.benchTier !== undefined ? { benchTier: b.benchTier } : {}),
    ...(b.open !== undefined ? { open: b.open } : {}),
  };
}

function toProjectileState(p: ProjectileRuntime): ProjectileState {
  return {
    id: p.id,
    ownerCharacterId: p.ownerCharacterId,
    ownerKind: p.ownerKind,
    x: p.x,
    y: p.y,
    // Vertical origin + velocity. Without these, the FPS client
    // falls back to its own camera eyeZ for z (so bullets appear
    // at the LOCAL player's eye level, not the shooter's) and
    // vz=0 (so bullets travel parallel to the ground even when
    // aimed up or down). Including them makes pitch-aware aim
    // work and pit / platform shooters fire from where they
    // actually are.
    z: p.z,
    vz: p.vz,
    vx: p.vx,
    vy: p.vy,
    color: p.color,
    weaponId: p.weaponId,
  };
}
