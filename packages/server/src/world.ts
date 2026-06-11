// World — the per-server simulation owner.
//
// Holds:
//   - the connection map (one entry per authenticated player ws)
//   - the scenes map (one entry per active place: 'surface', 'dungeon:1', …)
//
// Routes inbound input + fire commands to the scene the player is currently
// in, drives the global tick (which iterates scene.tick), and handles
// persistence (Supabase) for connection-level state (position, inventory).
//
// Phase A only ever instantiates the 'surface' scene. The transition machinery
// is here for B's stairs + extract entities.

import type { WebSocket } from 'ws';
import type {
  BuildingKind,
  Equipment,
  Inventory,
  InteractableKind,
  Player,
  RoomTemplate,
  ServerMessage,
  SuitSlotKind,
} from '@dumrunner/shared';
import {
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  addInventorySlotToInventory,
  coerceToPolygonScene,
  emptyEquipment,
  emptyInventory,
  floorOverrideFor,
  getOverrideScene,
  rasterizeSectorSceneToLayout,
  resizeInventory,
  swapSlots,
  discardSlot,
  sortBag,
  isSuitPart,
  findEmptySlot,
  takeFromSlot,
  addAttachment,
  addMaterial,
  addRecipeOutputToInventory,
  ATTACHMENT_DEFS,
  BLUEPRINT_CATALOG,
  isBlueprintAvailable,
  buildingParallelSlots,
  computeSuitStats,
  CONSUMABLES,
  consumeAttachment,
  consumeConsumable,
  consumeMaterial,
  consumeRecipeInput,
  consumeUpgrade,
  countMaterial,
  countUpgrade,
  hasRecipeInput,
  KEY_ARTIFACT_COST,
  UPGRADES,
  recipeOutputToSlot,
  RECIPES,
  salvageRefund,
  SUIT_ATTACHMENT_SLOTS,
  TIER_MOD_SLOTS,
  TIER_PIECE_SLOTS,
  TIER_UP_COSTS,
  weaponFamily as weaponFamilyOf,
  type AttachmentInstance,
  type WeaponPieceKind,
  type WeaponPieces,
  type WeaponTier,
} from '@dumrunner/shared';
import { supabase } from './supabase.js';
import { COMBAT } from './combat.js';
import {
  Scene,
  applyInputToConnection,
  type SceneBindings,
  type SceneConnection,
  type SceneSnapshot,
} from './scene.js';
import {
  generateFloorLayout,
  generateInitialEnemies,
  generateInitialLoot,
  generateInitialProps,
  generateLockedRoomMeta,
  generateSingleRoomFloor,
  type InitialDoor,
  type InitialEnemySpawn,
  type InitialLootDrop,
  type InitialPropSpawn,
} from './procgen.js';
import { ROOMS } from './rooms.js';
import {
  buildPlaytestEquipment,
  buildPlaytestInventory,
} from './starter.js';
import type { SceneLayout, WorldMode } from '@dumrunner/shared';
import { getEnemyVisualsForWire } from './ai/templates.js';
import {
  biomeForFloor,
  DEFAULT_BIOME_ID,
  getBiomesForWire,
  getOverworldBiome,
} from './biomes.js';
import { getPropVisualsForWire } from './props.js';
import { getBuildingVisualsForWire } from './buildingOverrides.js';
import { getBlueprintsForWire } from './blueprints.js';
import { getWeaponsForWire } from './weapons.js';
import { getRecipesForWire } from './recipes.js';
import { getAttachmentsForWire } from './attachments.js';

// Default open arena layout the sandbox spawns into before any
// editor command swaps in something specific. Empty walkables
// → no collision walls; enemies can move freely; same shape the
// live game's surface scene uses.
function makeSandboxArenaLayout(): SceneLayout {
  return {
    worldBounds: { x: -2000, y: -2000, w: 4000, h: 4000 },
    walkables: [],
    rooms: [],
    spawn: { x: 0, y: 0 },
    interactables: [],
    tileSize: 32,
    biome: 'default',
  };
}

// Surface is an open scene (no walls) but ships a layout so the client knows
// where the dungeon entrance is. Walkables are empty → collision is skipped.
// Surface entrance: where new arrivals + extract returns + respawns land.
// Sits a couple tiles west of the dungeon stairs (which are at x=200) so the
// player faces the entrance on arrival rather than appearing on top of it.
const SURFACE_ENTRANCE_X = 80;
const SURFACE_ENTRANCE_Y = 0;

// Tile location of the Power Link on the surface. The interactable sits
// at the same world-space centre so E-interact picks it up when the
// player walks up.
const POWER_LINK_TILE_X = 6;
const POWER_LINK_TILE_Y = -1; // straddles y=0 cleanly with a 1×2 footprint
const POWER_LINK_TILE_W = 1;
const POWER_LINK_TILE_H = 1;

function surfaceLayout(): SceneLayout {
  // Power Link sits at tile (6, -1). World-space centre = tile centre at
  // 32px tiles → (6.5*32, -0.5*32) = (208, -16). Use that as the
  // interactable's anchor so the prompt fires when the player is near.
  const linkX = (POWER_LINK_TILE_X + POWER_LINK_TILE_W / 2) * 32;
  const linkY = (POWER_LINK_TILE_Y + POWER_LINK_TILE_H / 2) * 32;
  return {
    worldBounds: { x: -2000, y: -2000, w: 4000, h: 4000 },
    walkables: [],
    rooms: [],
    spawn: { x: SURFACE_ENTRANCE_X, y: SURFACE_ENTRANCE_Y },
    interactables: [
      {
        id: 'power_link',
        kind: 'stairs_down',
        x: linkX,
        y: linkY,
        label: 'Descend — Power Link',
      },
    ],
    // Surface uses the same 32-px grid as dungeons so base-building snaps
    // cleanly. Walkables stays empty — no collision walls on the surface
    // itself; only player-placed buildings act as blockers.
    tileSize: 32,
    // Surface biome — pulls the first authored overworld biome,
    // falling back to the legacy 'default' id if none exists yet.
    // The renderer uses this id for biome_floor / biome_skybox /
    // biome_ceiling texture lookups so authors can reskin the
    // base entirely from the editor.
    biome: getOverworldBiome()?.id ?? DEFAULT_BIOME_ID,
    // Rolling terrain on the surface. Signed noise (can dip
    // below 0), so visual range is roughly [-amp, +amp]. 64 wu
    // amp = 2 walls peak-to-trough at a ~384 wu period (~12
    // tiles between hilltops). Per-tick gradient budget (worst-
    // case all-octaves-in-phase): ~10 wu per 7-px step, under
    // STEP_UP_MAX 12 with margin. octaves=2 — extra octaves
    // increase the max gradient without buying much detail
    // beyond what 384-wu wavelength already shows.
    terrain: {
      amplitude: 64,
      frequency: 1 / 384,
      octaves: 2,
      seed: 0x5e7117ed,
    },
  };
}

// Stored under world_states.state. Bump WORLD_STATE_SCHEMA on incompatible
// shape changes; incompatible old snapshots are discarded (no incremental
// migration yet) — additive-optional changes accept the prior schema.
//   1 — pre-slot inventory (corpse.inventory was CarriedPart[]).
//   2 — slot-based inventory (corpse.inventory is Inventory).
//   3 — adds cycle + cycleStartedAt for the perihelion clock.
//   4 — adds craftJobs (additive; v3 snapshots still load).
const WORLD_STATE_SCHEMA = 4;
type WorldSnapshot = {
  schema: number;
  scenes: Record<string, SceneSnapshot>;
  cycle: number;
  cycleStartedAt: number;
  // Active + queued craft jobs. Materials are consumed at enqueue,
  // so dropping these on restart eats player materials — they must
  // survive (craft durability). Optional: v3 snapshots lack it.
  craftJobs?: import('@dumrunner/shared').CraftJobState[];
};

// Connection — the per-ws record stored on the World. Implements SceneConnection
// so Scene can read/mutate the fields it cares about without knowing the full
// World type.
type Connection = SceneConnection & {
  accountId: string;
  sceneId: string;
  // After a scene transition, suppress further interactable triggers for a
  // brief window so the player doesn't re-trigger immediately on arrival.
  interactCooldownUntil: number;
  // Blueprints (schematics) the player has learned. Permanent per GDD
  // §The Economy Law — never wiped at perihelion, round-tripped through
  // the characters table on persist/hydrate.
  //   - persistentBlueprints is a legacy split (always empty today);
  //     mergedBlueprints() still unions it so old in-memory state can't
  //     lose entries. Collapse fully once a save-data audit confirms
  //     nothing populates it.
  knownBlueprints: Set<string>;
  persistentBlueprints: Set<string>;
};

const SURFACE_SCENE_ID = 'surface';
// Single arena scene id used in deathmatch mode. Mode-private,
// so we don't clash with any procgen dungeon-floor naming.
const ARENA_SCENE_ID = 'arena';
// Round structure constants for deathmatch. First-to-N kills OR
// wall-clock cap ends the round → intermission → fresh round.
// Configurable per-server later; sane defaults for now.
const DM_KILLS_TO_WIN_DEFAULT = 20;
const DM_ROUND_DURATION_MS_DEFAULT = 10 * 60 * 1000;
const DM_INTERMISSION_MS = 15 * 1000;
const DUNGEON_SCENE_PREFIX = 'dungeon:';
const TRANSITION_COOLDOWN_MS = 800;
// Per-kind parallel craft job capacity. Defaults to 1; mirror what the
// scene stores. Higher tiers / upgrades raise this later.
// Per-station parallel craft job capacity comes from the BUILDING_REGISTRY.
// Reading at use-time (instead of caching here) keeps the table in shared
// as the single source of truth.

// TIER_UP_COSTS now lives in shared/crafting.ts so the client can
// surface the cost in the Precision Machining Mill modal without
// duplicating the table.

// Starter blueprints granted on connect / re-granted at every cycle reset.
// The artifact-trade store is the real source of new blueprints; only
// items the player should always be able to make end up here. The pistol
// is the baseline weapon every run starts with.
const STARTER_BLUEPRINTS: string[] = ['bp_pistol'];

// Per-station ceiling on jobs (active + queued). When every nearby
// station of the requested kind hits this depth, the request gets
// rejected with `station_queue_full`. Active slot count is the
// per-kind parallelSlots (currently 1).
const MAX_QUEUE_PER_STATION = 5;

function dungeonSceneId(floorIndex: number): string {
  return `${DUNGEON_SCENE_PREFIX}${floorIndex}`;
}

function parseDungeonScene(sceneId: string): number | null {
  if (!sceneId.startsWith(DUNGEON_SCENE_PREFIX)) return null;
  const n = Number(sceneId.slice(DUNGEON_SCENE_PREFIX.length));
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export class World {
  readonly serverId: string;

  private connections = new Map<string, Connection>(); // characterId -> conn
  private scenes = new Map<string, Scene>();

  private tickTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  // Wall-clock of the previous tickHordeClock call. Drives the
  // empty-server pause: when nobody's connected, we slide
  // cycleStartedAt / hordeEndsAt forward by the empty gap so
  // perihelion doesn't fire while no one is around to defend.
  private lastHordeClockAt = 0;
  private hydrated = false;
  private worldSeed = 0;
  // Cycle counter — increments at the end of each horde. Procgen seeds
  // dungeon layouts off (worldSeed, cycle, floorIndex) so a cycle bump
  // automatically generates fresh floors.
  private cycle = 1;
  // Epoch ms when the current cycle started. The day clock + perihelion
  // countdown derives from this.
  private cycleStartedAt = Date.now();
  // Horde state. While `hordeActive` is true, the surface scene is under
  // attack; cycle++ when the horde ends.
  private hordeActive = false;
  private hordeEndsAt = 0;
  // Per-server world config loaded on hydrate. Defaults match the alpha
  // COMBAT constants so any code path that runs before hydrate still
  // behaves reasonably.
  private worldConfig: {
    dayDurationMs: number;
    daysPerCycle: number;
    dropItemsOnDeath: boolean;
    isPlaytest: boolean;
  } = {
    dayDurationMs: 300_000,
    daysPerCycle: 3,
    dropItemsOnDeath: true,
    isPlaytest: false,
  };
  // Owner accountId from the servers row. Pause is gated to this id.
  private ownerAccountId: string | null = null;

  // Whether this world was created as a playtest server. Drives the
  // starter inventory variant (every material/ammo + sample
  // attachments) and unlocks every blueprint in the catalog up front.
  isPlaytest(): boolean {
    return this.worldConfig.isPlaytest;
  }
  // Monotonic FIFO counter for craft-job queue ordering. Bumped on
  // every enqueue; queued jobs at the same station promote in
  // ascending queueIndex order.
  private nextQueueIndex = 1;
  // Last poll of `servers.is_paused`. Used to detect lobby-side pauses
  // when the owner isn't connected (poll runs every PAUSE_POLL_MS).
  private lastPauseCheckAt = 0;
  private pausing = false;
  // Deepest dungeon floor any crewmate has reached this cycle. Drives the
  // surface Power Link's descent target and (Phase 3) the power capacity.
  // Resets to 1 on cycle reset OR Power Link destruction.
  private deepestFloorReached = 1;
  // Powered defences (auto-turrets) require an alive Power Link. When the
  // Link is destroyed mid-cycle this flips false; cycle reset rebuilds it.
  private powerOnline = true;
  // Computed power state. Capacity scales with deepestFloorReached when
  // the Link is alive; otherwise 0. Draw is the count of currently-
  // consuming buildings (turrets + Phase-4 active craft jobs). Powered
  // set is the deterministic subset of consumers that fit under capacity.
  private powerCapacity = 0;
  private powerDraw = 0;
  private poweredBuildings = new Set<string>();
  // Async craft jobs in flight, keyed by job id. Each job draws 1 power
  // for its duration; output materializes to the requesting player's
  // inventory when completesAt elapses.
  private activeCraftJobs = new Map<string, import('@dumrunner/shared').CraftJobState>();
  private nextCraftJobId = 0;
  // Last clock broadcast time, throttled to WORLD_CLOCK_INTERVAL_MS.
  private lastClockBroadcastAt = 0;

  private readonly bindings: SceneBindings;

  // World mode — drives which top-level systems boot.
  //   'live'      → surface scene + dungeon + perihelion (canonical).
  //   'sandbox'   → editor playtest. Skip surface / dungeon / horde
  //                 / persistence. Scene arrives via
  //                 `sandboxLoadAuthoredScene` once the editor
  //                 connects.
  //   'deathmatch'→ single authored arena scene loaded at boot.
  //                 No surface, no dungeon, no perihelion. PvP
  //                 damage on. Players respawn at `dm_spawn`
  //                 interactables on a timer.
  readonly mode: WorldMode;
  // Scene id for the arena map (deathmatch mode only). Resolved
  // at boot from the pre-loaded override scene cache.
  readonly arenaSceneId: string | null;
  // Deathmatch round state — null in non-deathmatch modes, set
  // at boot for deathmatch worlds. `intermissionEndsAt` is null
  // during the active round and set during the post-round
  // scoreboard window; PvP damage gates on this so kills don't
  // count during intermission.
  private deathmatchRound: {
    startedAt: number;
    killsToWin: number;
    durationMs: number;
    intermissionEndsAt: number | null;
    winnerCharacterId: string | null;
    // Latest scoreboard. Frozen snapshot of (kills, deaths) at
    // round end so the intermission overlay reads consistent
    // numbers even as players disconnect.
    finalScores: Array<{
      characterId: string;
      displayName: string;
      kills: number;
      deaths: number;
    }> | null;
  } | null = null;
  // Kept for backwards compat with existing `if (this.isSandbox)`
  // call sites. Derived from `mode`.
  readonly isSandbox: boolean;
  get isDeathmatch(): boolean {
    return this.mode === 'deathmatch';
  }
  // True for any mode that doesn't get a surface base / dungeon /
  // perihelion clock.
  get skipsLiveSystems(): boolean {
    return this.mode !== 'live';
  }

  constructor(
    serverId: string,
    opts: {
      sandbox?: boolean;
      mode?: WorldMode;
      arenaSceneId?: string | null;
    } = {},
  ) {
    this.serverId = serverId;
    // Backwards-compat: if `sandbox: true` is passed, mode is
    // 'sandbox'. Otherwise mode comes through directly.
    this.mode =
      opts.mode ?? (opts.sandbox === true ? 'sandbox' : 'live');
    this.isSandbox = this.mode === 'sandbox';
    this.arenaSceneId = opts.arenaSceneId ?? null;
    this.bindings = {
      connection: (id) => this.connections.get(id),
      send: (id, msg) => this.sendTo(id, msg),
      onInteractable: (id, fromSceneId, kind) =>
        this.onInteractable(id, fromSceneId, kind),
      onPlayerRespawn: (id) => this.respawnPlayer(id),
      onPlayerDied: (id, killer) => this.notifyPlayerDied(id, killer),
      onPowerLinkDestroyed: () => this.handlePowerLinkDestroyed(),
      isPowerOnline: () => this.powerOnline,
      isPowered: (id: string) => this.poweredBuildings.has(id),
      onBuildingsChanged: () => this.recomputePowerState(),
      dropItemsOnDeath: () =>
        // Deathmatch never drops loot — gear stays with the
        // respawning player. Live mode respects the per-server
        // config flag.
        this.mode === 'deathmatch'
          ? false
          : this.worldConfig.dropItemsOnDeath,
      applyPlayerEffect: (id, effect) => this.applyPlayerEffect(id, effect),
      onPlayerEquipmentChanged: (id) => {
        const conn = this.connections.get(id);
        if (!conn) return;
        this.recomputePlayerStats(conn);
        // Clamp current pools against the new (lower) maxes.
        if (conn.hp > conn.maxHp) conn.hp = conn.maxHp;
        if (conn.shield > conn.maxShield) conn.shield = conn.maxShield;
        if (conn.stamina > conn.maxStamina) conn.stamina = conn.maxStamina;
        this.sendTo(id, {
          type: 'equipment_changed',
          equipment: conn.equipment,
        });
      },
      pvpEnabled: () =>
        this.mode === 'deathmatch' &&
        this.deathmatchRound?.intermissionEndsAt == null,
      onDeathmatchKill: (killerId) => {
        // Round-state side effects only — the kill-feed line lands
        // in chat via `notifyPlayerDied`, which the existing
        // ChatPanel already renders in every mode.
        this.handleDeathmatchKill(killerId);
      },
    };
    // Live worlds always boot with a surface scene + Power Link
    // dungeon portal. Sandbox worlds defer scene init — the
    // editor's authored scene arrives via `loadAuthoredScene`
    // once the player auths in. Deathmatch worlds load their
    // single arena scene from the pre-loaded override cache;
    // players land in it directly on join.
    if (this.mode === 'live') {
      const surface = new Scene(
        SURFACE_SCENE_ID,
        'surface',
        this.bindings,
        surfaceLayout()
      );
      this.scenes.set(SURFACE_SCENE_ID, surface);
      surface.ensurePowerLink(
        POWER_LINK_TILE_X,
        POWER_LINK_TILE_Y,
        POWER_LINK_TILE_W,
        POWER_LINK_TILE_H
      );
    } else if (this.mode === 'deathmatch') {
      if (!this.arenaSceneId) {
        throw new Error(
          '[world] deathmatch mode requires opts.arenaSceneId',
        );
      }
      const polyScene = getOverrideScene(this.arenaSceneId);
      if (!polyScene) {
        throw new Error(
          `[world] deathmatch arena scene "${this.arenaSceneId}" not in cache (pin it first in the editor, or check floor-overrides.json)`,
        );
      }
      const layout = rasterizeSectorSceneToLayout(polyScene);
      const arena = new Scene(
        ARENA_SCENE_ID,
        'dungeon_floor',
        this.bindings,
        layout,
      );
      this.scenes.set(ARENA_SCENE_ID, arena);
      this.deathmatchRound = {
        startedAt: Date.now(),
        killsToWin: DM_KILLS_TO_WIN_DEFAULT,
        durationMs: DM_ROUND_DURATION_MS_DEFAULT,
        intermissionEndsAt: null,
        winnerCharacterId: null,
        finalScores: null,
      };
    }
  }

  get playerCount(): number {
    return this.connections.size;
  }

  // ---------- hydrate / snapshot ----------

  // Called by the registry after construction, before any client joins.
  // Pulls the persisted snapshot from world_states and overlays it onto the
  // freshly-created default scenes. Idempotent — called once per world boot.
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    // Sandbox worlds never touch Supabase — no servers row, no
    // world_states snapshot, no characters row to restore from.
    // They live for the duration of one editor session.
    if (this.isSandbox) return;

    // Pull per-server world config + seed from the servers row.
    {
      const { data: serverRow } = await supabase
        .from('servers')
        .select(
          'world_seed, day_duration_sec, days_per_cycle, drop_items_on_death, owner_id, is_playtest'
        )
        .eq('id', this.serverId)
        .maybeSingle();
      this.ownerAccountId = serverRow?.owner_id ?? null;
      const seedRaw =
        serverRow?.world_seed != null ? Number(serverRow.world_seed) : NaN;
      this.worldSeed = Number.isFinite(seedRaw)
        ? seedRaw | 0
        : Math.floor(Math.random() * 0xffffffff);
      // Owner-configurable knobs. Defaults match the alpha COMBAT
      // constants so a row missing these columns (pre-migration) still
      // boots cleanly.
      this.worldConfig = {
        dayDurationMs:
          (serverRow?.day_duration_sec ?? 300) * 1000,
        daysPerCycle: serverRow?.days_per_cycle ?? 3,
        dropItemsOnDeath: serverRow?.drop_items_on_death ?? true,
        isPlaytest: serverRow?.is_playtest ?? false,
      };
    }

    const { data, error } = await supabase
      .from('world_states')
      .select('state')
      .eq('server_id', this.serverId)
      .maybeSingle();
    if (error) {
      console.error(
        `[world ${this.serverId}] hydrate failed:`,
        error.message
      );
      return;
    }
    if (!data) return;

    const snap = parseWorldSnapshot(data.state);
    if (!snap) return;

    // Restore the perihelion clock if the snapshot has it. Older snapshots
    // (without these fields) keep the constructor defaults — i.e. the clock
    // restarts from "Day 1, 0:00".
    if (typeof snap.cycle === 'number' && snap.cycle > 0) {
      this.cycle = snap.cycle;
    }
    if (typeof snap.cycleStartedAt === 'number') {
      this.cycleStartedAt = snap.cycleStartedAt;
    }

    // Surface scene already exists; dungeon scenes are recreated lazily.
    // Hydrate any scenes whose snapshots we still know about.
    for (const [sceneId, sceneSnap] of Object.entries(snap.scenes)) {
      let scene = this.scenes.get(sceneId);
      if (!scene) {
        // Recreate dungeon scenes that had saved state. The layout
        // regenerates from world_seed deterministically; the snapshot only
        // contains dynamic state (enemy hp, positions, loot).
        const floorIndex = parseDungeonScene(sceneId);
        if (floorIndex !== null) {
          scene = this.createDungeonScene(floorIndex);
        } else {
          continue;
        }
      }
      scene.hydrate(sceneSnap);
    }

    // Restore craft jobs AFTER scenes/buildings hydrate so completed
    // jobs can deposit into their station's (restored) output buffer.
    // Jobs whose completesAt elapsed during downtime finish on the
    // first tick. Counters advance past restored ids so new jobs
    // can't collide.
    if (snap.craftJobs) {
      for (const job of snap.craftJobs) {
        this.activeCraftJobs.set(job.id, job);
        const n = Number(job.id.replace(/^cj/, ''));
        if (Number.isFinite(n) && n >= this.nextCraftJobId) {
          this.nextCraftJobId = n + 1;
        }
        if ((job.queueIndex ?? 0) >= this.nextQueueIndex) {
          this.nextQueueIndex = (job.queueIndex ?? 0) + 1;
        }
      }
      if (snap.craftJobs.length > 0) this.recomputePowerState();
    }

    // Playtest sandbox: drop a starter set of workstations on the
    // surface so the tester doesn't have to hand-craft + place each
    // station to start exercising Phase 2 flows. Idempotent — only
    // adds a station kind if it doesn't already exist on the
    // surface, so the player can demolish + rebuild without the
    // server overwriting their layout.
    if (this.worldConfig.isPlaytest) {
      const surface = this.scenes.get(SURFACE_SCENE_ID);
      if (surface) {
        // A row 2 tiles south of the Power Link, separated by 2-tile
        // gaps so the player can walk between stations.
        surface.ensurePlaytestStations([
          { kind: 'workbench', tileX: 0, tileY: 2 },
          { kind: 'forge', tileX: 2, tileY: 2 },
          { kind: 'electronics_bench', tileX: 4, tileY: 2 },
          { kind: 'weapon_bench', tileX: 6, tileY: 2 },
          { kind: 'suit_bench', tileX: 8, tileY: 2 },
          { kind: 'precision_mill', tileX: 10, tileY: 2 },
          { kind: 'artifact_uplink', tileX: 12, tileY: 2 },
          { kind: 'storage_chest', tileX: 14, tileY: 2 },
        ]);
      }
    }
  }

  private buildSnapshot(): WorldSnapshot {
    const scenes: Record<string, SceneSnapshot> = {};
    for (const [id, scene] of this.scenes) {
      scenes[id] = scene.snapshot();
    }
    return {
      schema: WORLD_STATE_SCHEMA,
      scenes,
      cycle: this.cycle,
      cycleStartedAt: this.cycleStartedAt,
      craftJobs: [...this.activeCraftJobs.values()],
    };
  }

  private async flushSnapshot(): Promise<void> {
    if (this.isSandbox) return;
    await this.flushSnapshotInner();
  }
  private async flushSnapshotInner(): Promise<void> {
    const snap = this.buildSnapshot();
    const { error } = await supabase
      .from('world_states')
      .upsert({
        server_id: this.serverId,
        state: snap,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      console.error(
        `[world ${this.serverId}] snapshot failed:`,
        error.message
      );
    }
  }

  // ---------- lifecycle ----------

  // Sandbox player add. Mirrors `add` but skips the surface-
  // join, Supabase rehydrate, and starter-blueprint logic that
  // only make sense in a live world. Creates a Connection in
  // limbo (no sceneId) — the caller follows up with
  // `loadAuthoredScene` (or `regenSandboxFloor`) to drop the
  // player into an actual Scene. Inventory + equipment default
  // to the playtest kit so the editor's playtest button gives
  // the author a real combat loadout without separate plumbing.
  addSandboxPlayer(
    ws: WebSocket,
    characterId: string,
    displayName: string,
    inventory: Inventory,
    equipment: Equipment,
  ): void {
    this.cancelIdleShutdown();
    const conn: Connection = {
      ws,
      characterId,
      accountId: 'sandbox',
      displayName,
      x: 0,
      y: 0,
      hp: COMBAT.PLAYER_MAX_HP,
      maxHp: COMBAT.PLAYER_MAX_HP,
      stamina: COMBAT.PLAYER_MAX_STAMINA,
      maxStamina: COMBAT.PLAYER_MAX_STAMINA,
      shield: COMBAT.PLAYER_DEFAULT_MAX_SHIELD,
      maxShield: COMBAT.PLAYER_DEFAULT_MAX_SHIELD,
      lastDamageAt: 0,
      alive: true,
      inventory,
      equipment,
      hotbarSelection: 0,
      sceneId: '',
      inputX: 0,
      inputY: 0,
      inputAt: 0,
      inputSprint: false,
      inputJump: false,
      inputCrouch: false,
      z: 0,
      vz: 0,
      crouching: false,
      floorZ: 0,
      lastZSent: 0,
      lastCrouchSent: false,
      lastFireAt: 0,
      reloadingUntil: 0,
      reloadingSlot: -1,
      respawnAt: null,
      respawnImmunityUntil: 0,
      activeEffects: [],
      dirty: false,
      inventoryDirty: false,
      lastStaminaSentAt: 0,
      lastShieldSentAt: 0,
      lastStaminaSent: -1,
      lastShieldSent: -1,
      staminaRegenAt: 0,
      suitSpeedMult: 0,
      suitStaminaRegenBonus: 0,
      suitBuildRadiusBonus: 0,
      suitHeatResist: 0,
      suitColdResist: 0,
      suitRadiationResist: 0,
      suitToxicResist: 0,
      kills: 0,
      deaths: 0,
      interactCooldownUntil: 0,
      knownBlueprints: new Set<string>(Object.keys(BLUEPRINT_CATALOG)),
      persistentBlueprints: new Set<string>(),
    };
    this.connections.set(characterId, conn);
    this.recomputePlayerStats(conn);
    // Cap pools to the (possibly raised) maxes after suit eval.
    conn.hp = conn.maxHp;
    conn.shield = conn.maxShield;
    conn.stamina = conn.maxStamina;
    this.ensureTimers();
  }

  // ---------- Sandbox helpers ----------
  //
  // These are the editor-only operations that don't have an
  // analogue in the live game (regen a procgen floor, stamp a
  // single-room template, load a hand-authored sector scene,
  // swap loadout to the playtest kit). All operate on the
  // sandbox connection's current scene. Live-game messages
  // (input, fire, hotbar, reload, …) ride the existing
  // handleInput/handleFire/etc — same code path either way.

  // Build a Scene from a SceneLayout and drop the editor player
  // into it, replacing whatever scene they were in. Lower-level
  // primitive that the other sandbox helpers compose on.
  sandboxSwapScene(
    characterId: string,
    sceneId: string,
    layout: SceneLayout,
    initialSpawns: InitialEnemySpawn[] | null = null,
    initialLoot: InitialLootDrop[] | null = null,
    initialProps: InitialPropSpawn[] | null = null,
    broadcast: boolean = true,
    initialDoors: InitialDoor[] | null = null,
  ): void {
    if (!this.isSandbox) return;
    const conn = this.connections.get(characterId);
    if (!conn) return;
    // Tear down the current scene if any.
    if (conn.sceneId) {
      const old = this.scenes.get(conn.sceneId);
      old?.removeMember(characterId);
      this.scenes.delete(conn.sceneId);
    }
    const scene = new Scene(
      sceneId,
      'dungeon_floor',
      this.bindings,
      layout,
      initialSpawns,
      initialLoot,
      initialDoors,
      initialProps,
    );
    this.scenes.set(sceneId, scene);
    scene.addMember(characterId);
    conn.sceneId = sceneId;
    conn.x = layout.spawn.x;
    conn.y = layout.spawn.y;
    // Reset vertical state so a swap doesn't leave the player
    // mid-jump or stuck at a stale z from the prior scene.
    conn.vz = 0;
    // Seed the stateful floor from the spawn position. Use the
    // LOWEST sector at this XY (spawnFloorAt) — if the author's
    // spawn happens to land inside an overlapping platform's
    // polygon, we want the player on the ground, not on top of
    // the platform.
    conn.floorZ =
      layout.spawnZ !== undefined
        ? layout.spawnZ
        : scene.spawnFloorAt(layout.spawn.x, layout.spawn.y);
    conn.z = conn.floorZ;
    conn.lastZSent = conn.z;
    if (!broadcast) return;
    const snap = scene.toWireSnapshot();
    this.sendTo(characterId, {
      type: 'scene_changed',
      sceneId,
      self: this.toPlayerWire(conn),
      players: [],
      enemies: snap.enemies,
      projectiles: snap.projectiles,
      loot: snap.loot,
      corpses: snap.corpses,
      buildings: snap.buildings,
      props: snap.props,
      equipment: conn.equipment,
      layout: scene.layout,
    });
  }

  // First-cut sandbox scene the editor lands in before the user
  // does anything — empty 12×12 arena, no enemies, no objectives.
  // Skips the scene_changed broadcast because the follow-up
  // welcome carries the full snapshot anyway, and the openSandbox
  // helper on the client drops messages received before the
  // welcome.
  sandboxLoadInitialScene(characterId: string): void {
    this.sandboxSwapScene(
      characterId,
      `sandbox:${characterId}:arena`,
      makeSandboxArenaLayout(),
      null,
      null,
      null,
      false,
    );
  }

  // Editor playtest button → load a SectorScene authored in the
  // level editor. Rasterises onto a tile grid + carries the
  // authoredSectorMap so polygon collision + the v2 renderer
  // both consume the original polygons.
  sandboxLoadAuthoredScene(characterId: string, raw: unknown): void {
    if (!this.isSandbox) return;
    if (!raw || typeof raw !== 'object') return;
    let layout: SceneLayout;
    try {
      // Accept either polygon-shaped or linedef-shaped scenes.
      // Linedef scenes round-trip through the polygon model so
      // existing rasterise + collision pipeline stays unchanged.
      const polygonScene = coerceToPolygonScene(raw);
      layout = rasterizeSectorSceneToLayout(polygonScene);
    } catch (e) {
      console.error('[world.sandbox] load authored failed:', e);
      return;
    }
    this.sandboxSwapScene(
      characterId,
      `sandbox:${characterId}:authored`,
      layout,
    );
  }

  // Biome-editor "regen this floor with these params" command.
  // Runs the live procgen + sticks the output into a fresh scene.
  sandboxRegenFloor(
    characterId: string,
    biome: string,
    cycle: number,
    floorIndex: number,
    worldSeed: number,
  ): void {
    if (!this.isSandbox) return;
    const layout = generateFloorLayout(worldSeed, cycle, floorIndex, biome);
    const meta = generateLockedRoomMeta(layout, worldSeed, cycle, floorIndex);
    const initialSpawns = generateInitialEnemies(
      layout, worldSeed, cycle, floorIndex,
    );
    const initialLoot = generateInitialLoot(
      layout, worldSeed, cycle, floorIndex, meta.lockedRoomIndices,
    );
    const initialProps = generateInitialProps(
      layout, worldSeed, cycle, floorIndex,
    );
    this.sandboxSwapScene(
      characterId,
      `sandbox:${characterId}:${biome}:${floorIndex}`,
      layout,
      initialSpawns,
      initialLoot,
      initialProps,
      true,
      // Locked-room doors were silently dropped here — the editor's
      // "regen floor" preview spawned the locked-room loot but no
      // doors, so every locked room read as walk-through.
      meta.doors,
    );
  }

  // Room-editor "preview this template" command. Stamps the
  // template's tile bytes directly + drives spawns from anchors.
  sandboxStampRoom(
    characterId: string,
    templateId: string,
    biomeOverride?: string,
  ): void {
    if (!this.isSandbox) return;
    const template: RoomTemplate | undefined = ROOMS[templateId];
    if (!template) {
      this.sendTo(characterId, {
        type: 'error',
        message: `unknown room template: ${templateId}`,
      });
      return;
    }
    const biome = biomeOverride ?? template.biomeAffinity[0] ?? 'default';
    const layout = generateSingleRoomFloor(template, biome, 1);
    const initialSpawns: InitialEnemySpawn[] = [];
    const initialProps: InitialPropSpawn[] = [];
    const initialLoot: InitialLootDrop[] = [];
    if (layout.anchors) {
      for (const a of layout.anchors) {
        if (a.kind === 'enemy') {
          initialSpawns.push({
            templateId: a.overrideId ?? 'chaser_melee',
            x: a.x, y: a.y,
          });
        } else if (a.kind === 'prop') {
          initialProps.push({
            kind: a.overrideId ?? 'barrel',
            x: a.x, y: a.y,
          });
        } else if (a.kind === 'loot') {
          initialLoot.push({
            materialId: 'scrap', count: 5, x: a.x, y: a.y,
          });
        }
      }
    }
    this.sandboxSwapScene(
      characterId,
      `sandbox:${characterId}:room:${templateId}`,
      layout,
      initialSpawns,
      initialLoot,
      initialProps,
    );
  }

  // Swap the editor player's inventory + equipment to one of
  // the canned playtest kits. Recomputes suit stats / pools.
  sandboxSetLoadout(characterId: string, kind: 'creative' | 'unarmed'): void {
    if (!this.isSandbox) return;
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const inventory =
      kind === 'creative' ? buildPlaytestInventory() : emptyInventory();
    const equipment =
      kind === 'creative' ? buildPlaytestEquipment() : emptyEquipment();
    // Replace inventory in-place so the cargo-grid bonus path
    // (resizeInventory) still applies via recomputePlayerStats.
    for (let i = 0; i < conn.inventory.length; i++) {
      conn.inventory[i] = { kind: 'empty' };
    }
    resizeInventory(conn.inventory, INVENTORY_SIZE);
    for (let i = 0; i < inventory.length; i++) {
      conn.inventory[i] = inventory[i] ?? { kind: 'empty' };
    }
    conn.equipment = equipment;
    conn.hotbarSelection = 0;
    this.recomputePlayerStats(conn);
    conn.hp = conn.maxHp;
    conn.shield = conn.maxShield;
    conn.stamina = conn.maxStamina;
    this.sendTo(characterId, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    this.sendTo(characterId, {
      type: 'equipment_changed',
      equipment: conn.equipment,
    });
  }

  // Spawn one enemy at world-coord (x, y). Used by the enemy
  // editor's "spawn one in front of me" button.
  sandboxSpawnEnemy(
    characterId: string,
    kind: string,
    x: number,
    y: number,
  ): boolean {
    if (!this.isSandbox) return false;
    const conn = this.connections.get(characterId);
    if (!conn) return false;
    const scene = this.scenes.get(conn.sceneId);
    if (!scene) return false;
    const ok = scene.spawnEnemyFromTemplate(kind, x, y);
    if (!ok) {
      this.sendTo(characterId, {
        type: 'error',
        message: `unknown enemy kind: ${kind}`,
      });
    }
    return ok;
  }

  // Bulk-remove enemies / props in the current sandbox scene.
  sandboxClear(
    characterId: string,
    scope: 'enemies' | 'props' | 'all',
  ): void {
    if (!this.isSandbox) return;
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    if (!scene) return;
    if (scope === 'enemies' || scope === 'all') scene.clearAllEnemies();
    if (scope === 'props' || scope === 'all') scene.clearAllProps();
  }

  // Sandbox-flavoured welcome — same shape live-game uses,
  // emitted after addSandboxPlayer + initial scene swap.
  sendSandboxWelcome(characterId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    if (!scene) return;
    const snap = scene.toWireSnapshot();
    this.sendTo(characterId, {
      type: 'welcome',
      sceneId: scene.id,
      self: this.toPlayerWire(conn),
      players: [],
      enemies: snap.enemies,
      projectiles: snap.projectiles,
      loot: snap.loot,
      corpses: snap.corpses,
      buildings: snap.buildings,
      props: snap.props,
      inventory: conn.inventory,
      equipment: conn.equipment,
      hotbarSelection: conn.hotbarSelection,
      layout: scene.layout,
      knownBlueprints: [],
      blueprints: getBlueprintsForWire(),
      weapons: getWeaponsForWire(),
      recipes: getRecipesForWire(),
      attachments: getAttachmentsForWire(),
      enemyVisuals: getEnemyVisualsForWire(),
      biomes: getBiomesForWire(),
      propVisuals: getPropVisualsForWire(),
      buildingVisuals: getBuildingVisualsForWire(),
      mode: this.mode,
      deathmatchRound: this.dmRoundForWire(),
    });
  }

  // Build the deathmatch-round payload included in welcome messages.
  // Returns null for non-deathmatch worlds so the client knows not
  // to mount the HUD.
  private dmRoundForWire(): {
    startedAt: number;
    killsToWin: number;
    durationMs: number;
    intermissionEndsAt: number | null;
    scores: Array<{
      characterId: string;
      displayName: string;
      kills: number;
      deaths: number;
    }>;
  } | null {
    const round = this.deathmatchRound;
    if (!round) return null;
    const scores = [...this.connections.values()].map((c) => ({
      characterId: c.characterId,
      displayName: c.displayName,
      kills: c.kills,
      deaths: c.deaths,
    }));
    scores.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return {
      startedAt: round.startedAt,
      killsToWin: round.killsToWin,
      durationMs: round.durationMs,
      intermissionEndsAt: round.intermissionEndsAt,
      scores: round.finalScores ?? scores,
    };
  }

  private toPlayerWire(conn: SceneConnection): Player {
    return {
      characterId: conn.characterId,
      accountId: 'sandbox',
      displayName: conn.displayName,
      x: conn.x,
      y: conn.y,
      z: conn.z,
      crouching: conn.crouching,
      hp: conn.hp,
      maxHp: conn.maxHp,
      stamina: conn.stamina,
      maxStamina: conn.maxStamina,
      shield: conn.shield,
      maxShield: conn.maxShield,
      alive: conn.alive,
    };
  }

  add(
    ws: WebSocket,
    player: Player,
    inventory: Inventory,
    equipment: Equipment,
    savedBlueprints?: string[],
  ): void {
    this.cancelIdleShutdown();

    const existing = this.connections.get(player.characterId);
    if (existing) {
      try {
        existing.ws.close(4000, 'replaced');
      } catch {
        // ignore
      }
      this.removeFromCurrentScene(existing);
      this.connections.delete(player.characterId);
    }

    // Initial scene + spawn point branch by world mode.
    //   live      → surface scene, at the portal entrance.
    //   deathmatch→ arena scene, at a random dm_spawn marker.
    //   sandbox   → still uses surface here; sandbox scene is
    //               swapped in via sandboxLoadAuthoredScene
    //               immediately after welcome.
    let sceneId: string;
    let spawn: { x: number; y: number };
    if (this.mode === 'deathmatch') {
      sceneId = ARENA_SCENE_ID;
      spawn = this.pickDeathmatchSpawn();
    } else {
      sceneId = SURFACE_SCENE_ID;
      // Always rehydrate at the surface portal regardless of the
      // saved pos_x / pos_y. Dungeon scenes are per-cycle so
      // resuming inside one isn't useful; surface-portal-on-join
      // is the safe default.
      const surface = this.scenes.get(SURFACE_SCENE_ID);
      spawn = surface
        ? surface.findSafeSpawnNear(SURFACE_ENTRANCE_X, SURFACE_ENTRANCE_Y)
        : { x: SURFACE_ENTRANCE_X, y: SURFACE_ENTRANCE_Y };
    }
    const conn: Connection = {
      ws,
      characterId: player.characterId,
      accountId: player.accountId,
      displayName: player.displayName,
      x: spawn.x,
      y: spawn.y,
      hp: player.hp,
      maxHp: player.maxHp,
      stamina: player.stamina,
      maxStamina: player.maxStamina,
      shield: player.shield,
      maxShield: player.maxShield,
      lastDamageAt: 0,
      alive: player.alive,
      inventory,
      equipment,
      hotbarSelection: 0,
      sceneId,
      inputX: 0,
      inputY: 0,
      inputAt: 0,
      inputSprint: false,
      inputJump: false,
      inputCrouch: false,
      z: 0,
      vz: 0,
      crouching: false,
      floorZ: 0,
      lastZSent: 0,
      lastCrouchSent: false,
      lastFireAt: 0,
      reloadingUntil: 0,
      reloadingSlot: -1,
      respawnAt: null,
      respawnImmunityUntil: 0,
      activeEffects: [],
      dirty: false,
      inventoryDirty: false,
      lastStaminaSentAt: 0,
      lastShieldSentAt: 0,
      lastStaminaSent: -1,
      lastShieldSent: -1,
      staminaRegenAt: 0,
      suitSpeedMult: 0,
      suitStaminaRegenBonus: 0,
      suitBuildRadiusBonus: 0,
      suitHeatResist: 0,
      suitColdResist: 0,
      suitRadiationResist: 0,
      suitToxicResist: 0,
      kills: 0,
      deaths: 0,
      // Mild grace window so the surface stairs aren't triggered the moment
      // a returning player reconnects on top of them.
      interactCooldownUntil: Date.now() + TRANSITION_COOLDOWN_MS,
      // Schematics are permanent (GDD §The Economy Law): the saved set
      // round-trips through the characters table, plus the starter grant
      // so a fresh character always has a complete loop to test. Playtest
      // servers grant the entire catalog up front so contributors can
      // exercise every recipe without grinding artifacts.
      knownBlueprints: this.worldConfig.isPlaytest
        ? new Set<string>(Object.keys(BLUEPRINT_CATALOG))
        : new Set<string>([...STARTER_BLUEPRINTS, ...(savedBlueprints ?? [])]),
      persistentBlueprints: new Set<string>(),
    };
    this.connections.set(player.characterId, conn);

    // Apply any suit stats from equipment loaded with the character. Sets
    // maxHp / maxShield / maxStamina + speed and regen modifiers off the
    // gear they spawned in. Skips the broadcast (no scene members yet);
    // the welcome message below carries the freshly-computed values.
    const stats = computeSuitStats(conn.equipment);
    // Round to integers so the HUD doesn't render 15-digit floats from
    // affix rolls. HP/shield/stamina maxes are always whole numbers in
    // every UI surface.
    conn.maxHp = Math.round(COMBAT.PLAYER_MAX_HP + stats.hpBonus);
    conn.maxShield = Math.round(
      COMBAT.PLAYER_DEFAULT_MAX_SHIELD + stats.shieldBonus
    );
    conn.maxStamina = Math.round(COMBAT.PLAYER_MAX_STAMINA + stats.staminaMaxBonus);
    conn.suitSpeedMult = stats.moveSpeedMult;
    conn.suitStaminaRegenBonus = stats.staminaRegenBonus;
    conn.suitBuildRadiusBonus = Math.floor(stats.buildRadiusBonus);
    conn.suitHeatResist = stats.heatResist;
    conn.suitColdResist = stats.coldResist;
    conn.suitRadiationResist = stats.radiationResist;
    conn.suitToxicResist = stats.toxicResist;
    // Cargo grid: grow/shrink the inventory bag accordingly. Server
    // never drops items — resizeInventory keeps existing entries even
    // if the bonus is removed (cargo unequip).
    resizeInventory(
      conn.inventory,
      INVENTORY_SIZE + Math.floor(stats.inventoryBonus)
    );
    if (conn.hp > conn.maxHp) conn.hp = conn.maxHp;
    if (conn.shield > conn.maxShield) conn.shield = conn.maxShield;
    if (conn.stamina > conn.maxStamina) conn.stamina = conn.maxStamina;

    const scene = this.requireScene(sceneId);
    scene.addMember(player.characterId);

    // Seed the vertical state from the spawn floor so the first
    // tick's grounded / step-up checks start from the real
    // ground height instead of z=0.
    conn.floorZ = scene.spawnFloorAt(conn.x, conn.y);
    conn.z = conn.floorZ;
    conn.lastZSent = conn.z;

    const others = this.playersInScene(sceneId, player.characterId);
    const wireSnap = scene.toWireSnapshot();

    this.sendDirect(ws, {
      type: 'welcome',
      sceneId,
      self: toPlayer(conn),
      players: others,
      enemies: wireSnap.enemies,
      projectiles: wireSnap.projectiles,
      loot: wireSnap.loot,
      corpses: wireSnap.corpses,
      buildings: wireSnap.buildings,
      props: wireSnap.props,
      inventory,
      equipment: conn.equipment,
      hotbarSelection: conn.hotbarSelection,
      layout: scene.layout,
      knownBlueprints: mergedBlueprints(conn),
      blueprints: getBlueprintsForWire(),
      weapons: getWeaponsForWire(),
      recipes: getRecipesForWire(),
      attachments: getAttachmentsForWire(),
      enemyVisuals: getEnemyVisualsForWire(),
      biomes: getBiomesForWire(),
      propVisuals: getPropVisualsForWire(),
      buildingVisuals: getBuildingVisualsForWire(),
      mode: this.mode,
      deathmatchRound: this.dmRoundForWire(),
    });

    scene.broadcast(
      { type: 'player_joined', player: toPlayer(conn) },
      player.characterId
    );
    // Surface this player on the deathmatch scoreboard immediately
    // (with 0/0) so the leader banner picks them up before their
    // first kill.
    if (this.deathmatchRound) this.broadcastDeathmatchScores();
    this.systemChat(`${conn.displayName} joined the server.`);

    // Sync any in-flight craft jobs the player owns so the workstation
    // modal can render their progress bars on reconnect / mid-cycle join.
    const myJobs: import('@dumrunner/shared').CraftJobState[] = [];
    for (const job of this.activeCraftJobs.values()) {
      if (job.characterId === player.characterId) myJobs.push(job);
    }
    if (myJobs.length > 0) {
      this.sendDirect(ws, { type: 'craft_jobs_state', jobs: myJobs });
    }
    // Same for the current power state — newly-joined client wouldn't
    // otherwise know the capacity / draw until something changes.
    this.sendDirect(ws, {
      type: 'power_state',
      capacity: this.powerCapacity,
      draw: this.powerDraw,
      online: this.powerCapacity > 0,
      poweredBuildingIds: [...this.poweredBuildings],
    });

    this.ensureTimers();
  }

  remove(characterId: string, ws: WebSocket): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (conn.ws !== ws) return;
    const departingName = conn.displayName;
    this.connections.delete(characterId);
    this.removeFromCurrentScene(conn);
    void this.persistConnection(conn);
    // Drop per-character bookkeeping that would otherwise grow with
    // unique-player history for the life of the process.
    this.lastChatAt.delete(conn.characterId);
    this.systemChat(`${departingName} left the server.`);

    if (this.connections.size === 0) {
      // Last player out: take a final snapshot before timers stop. This is
      // the durability guarantee — if the process exits before the next
      // periodic flush would have fired, world state is still safe.
      void this.flushSnapshot();
      this.stopTimers();
      this.scheduleIdleShutdown();
    }
  }

  // Move a player from their current scene to a new one. Phase B uses this
  // for stairs / extract pads. Defined here so the contract is locked early.
  transition(
    characterId: string,
    toSceneId: string,
    spawnX: number,
    spawnY: number
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (conn.sceneId === toSceneId) return;

    const fromScene = this.scenes.get(conn.sceneId);
    if (fromScene) {
      fromScene.removeMember(characterId);
      fromScene.broadcast({ type: 'player_left', characterId });
    }

    conn.sceneId = toSceneId;
    conn.x = spawnX;
    conn.y = spawnY;
    conn.inputX = 0;
    conn.inputY = 0;
    conn.dirty = true;

    const toScene = this.requireScene(toSceneId);
    toScene.addMember(characterId);

    // Reset vertical state — a transition mid-jump must not
    // carry airborne z/vz (or a stale floor anchor) into the
    // destination scene.
    conn.floorZ = toScene.spawnFloorAt(spawnX, spawnY);
    conn.z = conn.floorZ;
    conn.vz = 0;
    conn.lastZSent = conn.z;

    conn.interactCooldownUntil = Date.now() + TRANSITION_COOLDOWN_MS;

    const wireSnap = toScene.toWireSnapshot();
    this.sendDirect(conn.ws, {
      type: 'scene_changed',
      sceneId: toSceneId,
      self: toPlayer(conn),
      players: this.playersInScene(toSceneId, characterId),
      enemies: wireSnap.enemies,
      projectiles: wireSnap.projectiles,
      loot: wireSnap.loot,
      corpses: wireSnap.corpses,
      buildings: wireSnap.buildings,
      props: wireSnap.props,
      equipment: conn.equipment,
      layout: toScene.layout,
    });

    toScene.broadcast(
      { type: 'player_joined', player: toPlayer(conn) },
      characterId
    );
  }

  // Called by Scene after a dead player's respawn timer fires. Restores
  // their HP and sends them to the surface base. The corpse the Scene
  // already spawned stays where it dropped for recovery.
  // Pick a random `dm_spawn` interactable on the arena scene to
  // teleport a (re)spawning player to. Falls back to the scene's
  // canonical spawn point when no dm_spawn markers exist (sane
  // default for an unprepared arena map). Self-occupancy isn't
  // checked: a transient overlap on a busy spawn is acceptable
  // and self-resolves on the next tick.
  private pickDeathmatchSpawn(): { x: number; y: number } {
    const arena = this.scenes.get(ARENA_SCENE_ID);
    if (!arena || !arena.layout) return { x: 0, y: 0 };
    const dmSpawns = arena.layout.interactables.filter(
      (i) => i.kind === 'dm_spawn',
    );
    if (dmSpawns.length === 0) {
      return { x: arena.layout.spawn.x, y: arena.layout.spawn.y };
    }
    const pick = dmSpawns[Math.floor(Math.random() * dmSpawns.length)];
    return { x: pick.x, y: pick.y };
  }

  private respawnPlayer(characterId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    conn.alive = true;
    conn.hp = conn.maxHp;
    conn.stamina = conn.maxStamina;
    conn.shield = conn.maxShield;
    // 2s damage immunity covers both the case where the safe-tile
    // search couldn't find anywhere clean (whole arena swarmed) and
    // the few frames between teleport and the player taking input.
    conn.respawnImmunityUntil = Date.now() + 2000;

    // Deathmatch: re-enter the arena scene at a random dm_spawn
    // interactable. No corpse cleanup needed — killPlayer skipped
    // it in PvP mode (see Scene.killPlayer's bindings.dropItemsOnDeath
    // check; deathmatch's binding returns false so equipment stays).
    if (this.mode === 'deathmatch') {
      const arena = this.scenes.get(ARENA_SCENE_ID);
      const drop = this.pickDeathmatchSpawn();
      if (arena && conn.sceneId === ARENA_SCENE_ID) {
        conn.x = drop.x;
        conn.y = drop.y;
        conn.floorZ = arena.spawnFloorAt(drop.x, drop.y);
        conn.z = conn.floorZ;
        conn.vz = 0;
        conn.dirty = true;
        arena.broadcast({
          type: 'player_respawned',
          characterId: conn.characterId,
          x: conn.x,
          y: conn.y,
          hp: conn.hp,
          maxHp: conn.maxHp,
          stamina: conn.stamina,
          maxStamina: conn.maxStamina,
          shield: conn.shield,
          maxShield: conn.maxShield,
        });
        return;
      }
      // Mode mismatch (somehow not in arena) — fall through to
      // transition; this shouldn't happen in practice.
      this.transition(characterId, ARENA_SCENE_ID, drop.x, drop.y);
      return;
    }

    const surface = this.scenes.get(SURFACE_SCENE_ID);
    const safe = surface
      ? surface.findSafeSpawnNear(SURFACE_ENTRANCE_X, SURFACE_ENTRANCE_Y)
      : { x: SURFACE_ENTRANCE_X, y: SURFACE_ENTRANCE_Y };

    // Full-loot extraction: respawning naked is the point. Inventory was
    // already cleared into a corpse on death (see Scene.killPlayer) — don't
    // refill it here.
    if (conn.sceneId === SURFACE_SCENE_ID) {
      // Already on surface (e.g. died on surface) — just teleport to the
      // entrance and broadcast a respawn event without a scene swap.
      conn.x = safe.x;
      conn.y = safe.y;
      conn.floorZ = surface
        ? surface.spawnFloorAt(safe.x, safe.y)
        : 0;
      conn.z = conn.floorZ;
      conn.vz = 0;
      conn.dirty = true;
      surface?.broadcast({
        type: 'player_respawned',
        characterId: conn.characterId,
        x: conn.x,
        y: conn.y,
        hp: conn.hp,
        maxHp: conn.maxHp,
        stamina: conn.stamina,
        maxStamina: conn.maxStamina,
        shield: conn.shield,
        maxShield: conn.maxShield,
      });
      return;
    }
    // Cross-scene respawn: full transition handles broadcasts + state swap.
    this.transition(characterId, SURFACE_SCENE_ID, safe.x, safe.y);
  }

  // Called by Scene when a player walks onto an interactable. Owns the
  // cooldown gate and the transition target decision.
  private onInteractable(
    characterId: string,
    fromSceneId: string,
    kind: InteractableKind
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (Date.now() < conn.interactCooldownUntil) return;
    if (conn.sceneId !== fromSceneId) return;

    if (kind === 'extract_pad') {
      // Always lands at the surface entrance (near the stairs).
      // Pick a safe tile so a wall built on top of the canonical
      // entrance doesn't trap the returning player.
      const surface = this.scenes.get(SURFACE_SCENE_ID);
      const safe = surface
        ? surface.findSafeSpawnNear(SURFACE_ENTRANCE_X, SURFACE_ENTRANCE_Y)
        : { x: SURFACE_ENTRANCE_X, y: SURFACE_ENTRANCE_Y };
      this.transition(characterId, SURFACE_SCENE_ID, safe.x, safe.y);
      return;
    }

    if (kind === 'stairs_down') {
      let nextFloor: number;
      if (fromSceneId === SURFACE_SCENE_ID) {
        // Surface descent gates on a live Power Link AND uses the deepest
        // floor any crewmate has reached this cycle as the target. So once
        // the crew has pushed to floor 6, returning to the Link drops you
        // back at floor 6 — no re-traversal needed.
        const surface = this.scenes.get(SURFACE_SCENE_ID);
        const link = surface?.findBuildingByKind('power_link');
        if (!link || link.hp <= 0) {
          // No descent possible without an alive Power Link.
          this.sendDirect(conn.ws, {
            type: 'error',
            message: 'power_link_offline',
          });
          return;
        }
        nextFloor = this.deepestFloorReached;
      } else {
        const current = parseDungeonScene(fromSceneId);
        if (current === null) return;
        nextFloor = current + 1;
      }
      const targetSceneId = dungeonSceneId(nextFloor);
      const targetScene = this.requireScene(targetSceneId);
      const spawn = targetScene.layout?.spawn ?? { x: 0, y: 0 };
      this.transition(characterId, targetSceneId, spawn.x, spawn.y);
      // Update the depth marker if this push extends the frontier;
      // power capacity scales with the new value.
      if (nextFloor > this.deepestFloorReached) {
        this.deepestFloorReached = nextFloor;
        this.recomputePowerState();
      }
      return;
    }
  }

  // ---------- input dispatch ----------

  handleInput(
    characterId: string,
    moveX: number,
    moveY: number,
    sprint: boolean,
    jump: boolean = false,
    crouch: boolean = false,
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn || !conn.alive) return;
    applyInputToConnection(conn, moveX, moveY, sprint, jump, crouch);
  }

  handleFire(
    characterId: string,
    dirX: number,
    dirY: number,
    dirZ: number = 0,
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    scene?.handleFire(characterId, dirX, dirY, dirZ);
  }

  handleReloadWeapon(characterId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    scene?.handleReloadWeapon(characterId);
  }

  handleBuildRequest(
    characterId: string,
    kind: BuildingKind,
    tileX: number,
    tileY: number
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    scene?.handleBuildRequest(characterId, kind, tileX, tileY);
  }

  handleDemolishRequest(characterId: string, buildingId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    scene?.handleDemolishRequest(characterId, buildingId);
  }

  handleInteract(characterId: string, interactableId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    scene?.handleInteract(characterId, interactableId);
  }

  handleSelectHotbar(characterId: string, slot: number): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (slot < 0 || slot >= HOTBAR_SIZE) return;
    conn.hotbarSelection = slot;
  }

  handleStorageMove(
    characterId: string,
    buildingId: string,
    fromKind: 'inventory' | 'chest',
    fromIdx: number,
    toKind: 'inventory' | 'chest',
    toIdx: number
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (!surface) return;
    surface.handleStorageMove(
      conn,
      buildingId,
      fromKind,
      fromIdx,
      toKind,
      toIdx
    );
  }

  handleInventorySwap(characterId: string, from: number, to: number): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!swapSlots(conn.inventory, from, to)) return;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleInventoryDiscard(characterId: string, slot: number, all: boolean): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!discardSlot(conn.inventory, slot, all)) return;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Salvage an inventory slot at a workbench. Yields ~20% of the
  // base recipe's inputs (or whatever yieldPct the player's suit
  // is currently rolling). Empties the source slot and pushes the
  // refund materials into the bag.
  handleSalvageRequest(characterId: string, slot: number): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (
      !surface?.hasBuildingNearby(
        conn.x,
        conn.y,
        'workbench',
        COMBAT.CRAFT_STATION_RANGE_PX
      )
    ) {
      this.sendDirect(conn.ws, { type: 'error', message: 'salvage_needs_workbench' });
      return;
    }
    if (slot < 0 || slot >= conn.inventory.length) return;
    const src = conn.inventory[slot];
    if (src.kind === 'empty') return;
    if (src.kind !== 'attachment' && src.kind !== 'weapon' && src.kind !== 'placeable') {
      this.sendDirect(conn.ws, { type: 'error', message: 'salvage_unsupported_kind' });
      return;
    }

    // Future suit-affix `salvage_yield_pct` plugs in here. The
    // current default (0.20) maps every recipe input to 20% of its
    // count rounded down — small inputs round to 0, which is the
    // correct rate-limiter for trash items.
    const yieldPct = 0.20;
    const refunds = salvageRefund(src, yieldPct);
    if (refunds.length === 0) {
      this.sendDirect(conn.ws, { type: 'error', message: 'salvage_no_recipe' });
      return;
    }

    // Salvage placeables consumes one unit of the stack at a time
    // (matches the discard / drop "single" path), since stacks
    // really are N copies of the item. Attachments + weapons are
    // already singletons so we always burn the whole slot.
    if (src.kind === 'placeable' && src.count > 1) {
      src.count -= 1;
    } else {
      conn.inventory[slot] = { kind: 'empty' };
    }

    // Pump refunds back into inventory; failures (full bag) drop
    // the surplus on the ground at the player's feet so nothing is
    // silently lost.
    for (const r of refunds) {
      const placed = addInventorySlotToInventory(conn.inventory, r);
      if (!placed) {
        const scene = this.scenes.get(conn.sceneId);
        scene?.spawnDroppedSlot(conn.x, conn.y, r, conn.characterId);
      }
    }

    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Drop a slot's contents on the ground at the player's feet. Spawns
  // a 'slot' variant LootRuntime; the existing pickup loop picks it
  // up via addInventorySlotToInventory. all=false drops a single unit
  // (matches inventory_discard semantics).
  handleInventoryDrop(characterId: string, slot: number, all: boolean): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (slot < 0 || slot >= conn.inventory.length) return;
    const src = conn.inventory[slot];
    if (src.kind === 'empty') return;

    const dropped = takeFromSlot(conn.inventory, slot, all);
    if (!dropped) return;
    const scene = this.scenes.get(conn.sceneId);
    scene?.spawnDroppedSlot(conn.x, conn.y, dropped, conn.characterId);

    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Transfer a slot from one player to a nearby player. Proximity
  // check uses the same crafting-station radius. Stack-merging on
  // arrival handled by the dispatcher; if the recipient's bag has
  // no room, the give silently fails (no partial transfer).
  handleGiveItem(
    characterId: string,
    targetCharacterId: string,
    slot: number,
    all: boolean
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const target = this.connections.get(targetCharacterId);
    if (!target) return;
    if (target.sceneId !== conn.sceneId) return;
    const dx = target.x - conn.x;
    const dy = target.y - conn.y;
    if (dx * dx + dy * dy > COMBAT.CRAFT_STATION_RANGE_PX * COMBAT.CRAFT_STATION_RANGE_PX) {
      this.sendDirect(conn.ws, { type: 'error', message: 'give_too_far' });
      return;
    }

    if (slot < 0 || slot >= conn.inventory.length) return;
    const src = conn.inventory[slot];
    if (src.kind === 'empty') return;

    const taken = takeFromSlot(conn.inventory, slot, all);
    if (!taken) return;
    const placed = addInventorySlotToInventory(target.inventory, taken);
    if (!placed) {
      // Recipient was full — refund the source.
      addInventorySlotToInventory(conn.inventory, taken);
      this.sendDirect(conn.ws, { type: 'error', message: 'recipient_inventory_full' });
      return;
    }

    conn.inventoryDirty = true;
    target.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    this.sendDirect(target.ws, {
      type: 'inventory_changed',
      inventory: target.inventory,
    });
  }

  handleInventorySort(characterId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    sortBag(conn.inventory);
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Craft one batch of the given recipe. Validates that the player has all
  // input materials/ammo, deducts them, and adds the output to the
  // inventory. No-op (silently) if the recipe is unknown or the player is
  // short. Adding partial-craft / batch-craft is a future polish.
  handleCraftRequest(characterId: string, recipeId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const recipe = RECIPES[recipeId];
    if (!recipe) return;

    // Workstation gate: if the recipe requires a station, the player must be
    // on the surface and within range of a built one of that kind. Stations
    // only place on surface, so dungeon-side crafts are rejected outright.
    //
    // If every nearby station of the right kind is at queue depth, reject.
    // Otherwise pick the station with the shortest queue (active + queued)
    // so a player tap-spamming the craft button spreads load across all
    // their stations of that kind.
    let chosenStationId: string | null = null;
    if (recipe.workstation !== null) {
      if (conn.sceneId !== SURFACE_SCENE_ID) return;
      const surface = this.scenes.get(SURFACE_SCENE_ID);
      if (!surface) return;
      const nearby = surface.findBuildingsNearby(
        conn.x,
        conn.y,
        recipe.workstation,
        COMBAT.CRAFT_STATION_RANGE_PX
      );
      if (nearby.length === 0) return;
      // Also gate on the recipe's `stationTier` requirement: the
      // chosen station's benchTier must be ≥ recipe.stationTier.
      // Recipes without a stationTier set ride at tier 1 (any
      // station). Rejecting at the world layer means the bench-
      // tier check works for any future station type, not just
      // the Weapon Bench.
      const requiredTier = recipe.stationTier ?? 1;
      let bestStation: string | null = null;
      let bestQueueDepth = Infinity;
      for (const station of nearby) {
        const stationTier = station.benchTier ?? 1;
        if (stationTier < requiredTier) continue;
        let depth = 0;
        for (const job of this.activeCraftJobs.values()) {
          if (job.stationBuildingId === station.id) depth++;
        }
        if (depth < bestQueueDepth) {
          bestQueueDepth = depth;
          bestStation = station.id;
        }
      }
      if (bestStation === null) {
        // Either every station is over queue depth, or none meet
        // the tier requirement. In the tier-gate case the client
        // UI greys out the recipe, but a craft request still
        // reaches us if e.g. the bench was just demolished mid-
        // submit. Reuse the queue-full error since both surface
        // a "couldn't fit your job at any nearby bench" toast.
        this.sendDirect(conn.ws, {
          type: 'error',
          message: 'station_queue_full',
        });
        return;
      }
      if (bestQueueDepth >= MAX_QUEUE_PER_STATION) {
        this.sendDirect(conn.ws, {
          type: 'error',
          message: 'station_queue_full',
        });
        return;
      }
      chosenStationId = bestStation;
    }

    // Blueprint gate. The recipe's blueprintId must be in either the
    // per-cycle or persistent set.
    if (
      recipe.blueprintId !== null &&
      !conn.knownBlueprints.has(recipe.blueprintId) &&
      !conn.persistentBlueprints.has(recipe.blueprintId)
    ) {
      return;
    }

    // Check inputs first; only commit if everything's there.
    for (const input of recipe.inputs) {
      if (!hasRecipeInput(conn.inventory, input)) return;
    }

    const craftTimeMs = recipe.craftTimeMs ?? 0;
    const isAsync = craftTimeMs > 0 && recipe.workstation !== null;

    // Deduct inputs upfront — even queued jobs consume materials at
    // request time so a player can't game the queue with a single
    // material stack.
    for (const input of recipe.inputs) {
      consumeRecipeInput(conn.inventory, input);
    }

    if (isAsync) {
      const now = Date.now();
      const jobId = `cj${this.nextCraftJobId++}`;
      const stationKind = recipe.workstation as
        | 'workbench'
        | 'forge'
        | 'electronics_bench'
        | 'weapon_bench';
      const stationId = chosenStationId!;

      // Can we start it immediately? Yes if (a) station has a free
      // active slot and (b) power can fit the new draw.
      const slotsPerStation = buildingParallelSlots(stationKind) || 1;
      let activeAtStation = 0;
      for (const job of this.activeCraftJobs.values()) {
        if (job.stationBuildingId === stationId && job.completesAt > 0) {
          activeAtStation++;
        }
      }
      const slotFree = activeAtStation < slotsPerStation;
      const powerFits =
        this.powerDraw + COMBAT.POWER_DRAW_CRAFT_JOB <= this.powerCapacity;

      const startNow = slotFree && powerFits;
      const job: import('@dumrunner/shared').CraftJobState = {
        id: jobId,
        recipeId,
        characterId,
        stationKind,
        stationBuildingId: stationId,
        startedAt: startNow ? now : 0,
        completesAt: startNow ? now + craftTimeMs : 0,
        queueIndex: this.nextQueueIndex++,
      };
      this.activeCraftJobs.set(jobId, job);
      this.sendDirect(conn.ws, { type: 'craft_job_started', job });
      this.sendDirect(conn.ws, {
        type: 'inventory_changed',
        inventory: conn.inventory,
      });
      if (startNow) {
        this.recomputePowerState();
      }
      return;
    }

    // Instant craft (basics + any recipe without craftTimeMs).
    addRecipeOutputToInventory(conn.inventory, recipe.output);
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Run each tick. Materializes finished craft jobs into the requesting
  // player's inventory and removes them from the active map. Promotes
  // the oldest queued job at the same station whenever an active one
  // finishes (or whenever power frees up).
  private tickCraftJobs(now: number): void {
    if (this.activeCraftJobs.size === 0) return;

    // Find any active jobs whose timer elapsed.
    const finished: string[] = [];
    for (const job of this.activeCraftJobs.values()) {
      if (job.completesAt > 0 && job.completesAt <= now) {
        finished.push(job.id);
      }
    }
    let stateChanged = false;
    if (finished.length > 0) {
      stateChanged = true;
      for (const jobId of finished) {
        const job = this.activeCraftJobs.get(jobId);
        if (!job) continue;
        this.activeCraftJobs.delete(jobId);
        const conn = this.connections.get(job.characterId);
        if (!conn) continue; // owner dropped — output silently lost
        const recipe = RECIPES[job.recipeId];
        if (!recipe) continue;

        const outputSlot = recipeOutputToSlot(recipe.output);
        const surface = this.scenes.get(SURFACE_SCENE_ID);
        const deposited = surface?.depositToStationOutput(
          job.stationBuildingId,
          outputSlot
        );
        if (!deposited) {
          addRecipeOutputToInventory(conn.inventory, recipe.output);
          conn.inventoryDirty = true;
          this.sendDirect(conn.ws, {
            type: 'inventory_changed',
            inventory: conn.inventory,
          });
        }
        this.sendDirect(conn.ws, { type: 'craft_job_completed', jobId });
      }
    }

    // Promote queued jobs into active slots — both for stations whose
    // active job just completed, and for any station that was waiting
    // on power capacity to free up.
    if (this.tryPromoteQueuedJobs(now)) {
      stateChanged = true;
    }

    if (stateChanged) {
      this.recomputePowerState();
    }
  }

  // Walk every station that has at least one queued job and try to
  // start it. Returns true if any job was promoted (caller recomputes
  // power). Promotion is FIFO by queueIndex within a station; across
  // stations we walk in arbitrary order.
  private tryPromoteQueuedJobs(now: number): boolean {
    if (this.activeCraftJobs.size === 0) return false;

    // Group by station.
    const byStation = new Map<string, import('@dumrunner/shared').CraftJobState[]>();
    for (const job of this.activeCraftJobs.values()) {
      let arr = byStation.get(job.stationBuildingId);
      if (!arr) {
        arr = [];
        byStation.set(job.stationBuildingId, arr);
      }
      arr.push(job);
    }

    let promoted = false;
    for (const [stationId, jobs] of byStation) {
      // Active first, queued sorted oldest-first.
      const active = jobs.filter((j) => j.completesAt > 0);
      const queued = jobs
        .filter((j) => j.completesAt === 0)
        .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
      if (queued.length === 0) continue;

      const slotsPerStation =
        buildingParallelSlots(jobs[0].stationKind) || 1;
      let freeSlots = slotsPerStation - active.length;
      while (freeSlots > 0 && queued.length > 0) {
        // Recompute power headroom each iteration since promotions
        // mutate the active set we're using to size the next check.
        const newActiveCount =
          [...this.activeCraftJobs.values()].filter((j) => j.completesAt > 0)
            .length + 1;
        const projectedDraw =
          (this.powerDraw - active.length * COMBAT.POWER_DRAW_CRAFT_JOB) +
          newActiveCount * COMBAT.POWER_DRAW_CRAFT_JOB;
        if (projectedDraw > this.powerCapacity) break;

        const next = queued.shift()!;
        const recipe = RECIPES[next.recipeId];
        const dur = recipe?.craftTimeMs ?? 0;
        if (dur <= 0) {
          // Defensive: should never queue an instant recipe.
          this.activeCraftJobs.delete(next.id);
          continue;
        }
        next.startedAt = now;
        next.completesAt = now + dur;
        promoted = true;
        freeSlots--;
        const conn = this.connections.get(next.characterId);
        if (conn) {
          this.sendDirect(conn.ws, { type: 'craft_job_started', job: next });
        }
      }
      void stationId;
    }
    return promoted;
  }

  // Player taps "Take All" at a workstation modal. Server validates
  // proximity and drains every output slot from every station of `kind`
  // within range into the player's inventory.
  handlePickupStationOutputs(
    characterId: string,
    kind: 'workbench' | 'forge' | 'electronics_bench' | 'weapon_bench'
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (!surface) return;
    const any = surface.collectStationOutputs(
      conn.x,
      conn.y,
      kind,
      COMBAT.CRAFT_STATION_RANGE_PX,
      conn.inventory
    );
    if (!any) return;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Player tries to open a locked door. Validates: same scene, in
  // range, has at least one key. Consumes the key and removes the door
  // building so the tile becomes walkable.
  handleOpenDoor(characterId: string, buildingId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    if (!scene) return;
    const layout = scene.layout;
    if (!layout || layout.tileSize <= 0) return;
    const b = scene.getBuilding(buildingId);
    if (!b) return;
    if (b.kind !== 'door' && b.kind !== 'wall_door') return;

    const tileSize = layout.tileSize;
    const cx = (b.tileX + 0.5) * tileSize;
    const cy = (b.tileY + 0.5) * tileSize;
    // Reach: ~2 tiles from the door centre. Generous so the player
    // doesn't have to wedge into a wall corner to interact.
    if (Math.hypot(conn.x - cx, conn.y - cy) > 64) return;

    // Player-built wall_door: toggle open/close. No key consumed; the
    // building persists across cycles. Done before the locked-door
    // path so a wall_door near a key never accidentally drains keys.
    if (b.kind === 'wall_door') {
      scene.toggleWallDoor(buildingId);
      return;
    }

    // No-key isn't an error — the prompt already tells the player they
    // need a key. Silently reject so we don't spam the toast / console.
    if (countMaterial(conn.inventory, 'key') < 1) return;
    consumeMaterial(conn.inventory, 'key', 1);
    scene.openDoor(buildingId);
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // E5: open a container prop. Validates same-scene + range; flips
  // the prop's opened flag (broadcast for visual swap) and ships
  // the container's inventory privately to the opener so the modal
  // can render its contents.
  handleOpenContainer(characterId: string, propId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    if (!scene) return;
    const layout = scene.layout;
    if (!layout || layout.tileSize <= 0) return;
    const p = scene.getContainerProp(propId);
    if (!p) return;
    if (!this.containerInRange(conn, p, layout.tileSize)) return;
    scene.openContainerProp(propId);
    scene.shipContainerInventory(propId, characterId);
  }

  // Take one slot's contents from a container into the player's
  // inventory. Re-ships the container inventory after so the open
  // modal updates; pushes the player's inventory_changed too.
  handleContainerTake(
    characterId: string,
    propId: string,
    slot: number,
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    if (!scene) return;
    const layout = scene.layout;
    if (!layout || layout.tileSize <= 0) return;
    const p = scene.getContainerProp(propId);
    if (!p || !p.opened) return;
    if (!this.containerInRange(conn, p, layout.tileSize)) return;
    const result = scene.takeFromContainer(propId, slot, conn.inventory);
    if (!result.ok) return;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    scene.shipContainerInventory(propId, characterId);
  }

  // Range check for container interactions. Centre of the prop's
  // tile footprint vs player position; ~2 tiles of slack so the
  // player can interact from a comfortable standing distance.
  private containerInRange(
    conn: Connection,
    p: { x: number; y: number },
    _tileSize: number,
  ): boolean {
    const REACH = 96;
    const dx = conn.x - p.x;
    const dy = conn.y - p.y;
    return dx * dx + dy * dy <= REACH * REACH;
  }

  // Player spends artifacts at an artifact_uplink to learn a schematic.
  // Validates: player is on the surface, within range of an uplink, has
  // enough artifacts, and doesn't already know it. Consumes the artifacts
  // and adds the bp to the known set — permanent; persisted with the
  // character row on the next dirty flush.
  handlePurchaseBlueprint(characterId: string, blueprintId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const entry = BLUEPRINT_CATALOG[blueprintId];
    if (!entry) return;
    if (
      conn.knownBlueprints.has(blueprintId) ||
      conn.persistentBlueprints.has(blueprintId)
    ) {
      return;
    }
    // E1 progression-tree gate: every prerequisite blueprint must
    // already be in the player's known set (per-cycle OR persistent
    // — same `mergedBlueprints` check the client uses).
    const known = mergedBlueprints(conn);
    if (!isBlueprintAvailable(entry, new Set(known))) {
      return;
    }
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (
      !surface?.hasBuildingNearby(
        conn.x,
        conn.y,
        'artifact_uplink',
        COMBAT.CRAFT_STATION_RANGE_PX
      )
    ) {
      return;
    }
    if (countMaterial(conn.inventory, 'artifact') < entry.cost) return;

    consumeMaterial(conn.inventory, 'artifact', entry.cost);
    conn.knownBlueprints.add(blueprintId);
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    this.sendDirect(conn.ws, {
      type: 'blueprints_changed',
      knownBlueprints: mergedBlueprints(conn),
    });
  }

  // ---------- weapon bench actions ----------
  // All of these require the player to be on the surface within
  // CRAFT_STATION_RANGE_PX of a weapon_bench. Each returns silently on
  // any validation failure — the client UI gates buttons by the same
  // rules so users won't normally see a no-op.

  private isNearWeaponBench(conn: Connection): boolean {
    if (conn.sceneId !== SURFACE_SCENE_ID) return false;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    return !!surface?.hasBuildingNearby(
      conn.x,
      conn.y,
      'weapon_bench',
      COMBAT.CRAFT_STATION_RANGE_PX
    );
  }

  // Highest Weapon Bench tier in range of the player. Returns 0 if
  // no bench in range. Used by handleAssembleWeapon to gate weapon
  // tier — Mk1 bench can only assemble Mk1 weapons, etc. If multiple
  // benches are in range (player built more than one), the highest
  // tier wins.
  private nearestWeaponBenchTier(conn: Connection): number {
    if (conn.sceneId !== SURFACE_SCENE_ID) return 0;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (!surface) return 0;
    const nearby = surface.findBuildingsNearby(
      conn.x,
      conn.y,
      'weapon_bench',
      COMBAT.CRAFT_STATION_RANGE_PX
    );
    let best = 0;
    for (const b of nearby) {
      const t = b.benchTier ?? 1;
      if (t > best) best = t;
    }
    return best;
  }

  // Precision Machining Mill — separate station that hosts the
  // tier-up flow. Weapon Bench used to gate tier-up; that role moved
  // here so the bench can focus on assembly.
  private isNearPrecisionMill(conn: Connection): boolean {
    if (conn.sceneId !== SURFACE_SCENE_ID) return false;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    return !!surface?.hasBuildingNearby(
      conn.x,
      conn.y,
      'precision_mill',
      COMBAT.CRAFT_STATION_RANGE_PX
    );
  }

  // Suit Assembly Bench — Phase 2.5 sibling of the Weapon Bench.
  // Hosts the suit-attachment assembly modal; gates
  // handleAssembleSuitPart.
  private isNearSuitBench(conn: Connection): boolean {
    if (conn.sceneId !== SURFACE_SCENE_ID) return false;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    return !!surface?.hasBuildingNearby(
      conn.x,
      conn.y,
      'suit_bench',
      COMBAT.CRAFT_STATION_RANGE_PX
    );
  }

  handleAttachWeaponAffix(
    characterId: string,
    weaponInventoryIdx: number,
    pieceKind: WeaponPieceKind,
    attachmentDefId: string
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!this.isNearWeaponBench(conn)) return;
    const slot = conn.inventory[weaponInventoryIdx];
    if (!slot || slot.kind !== 'weapon') return;
    const def = ATTACHMENT_DEFS[attachmentDefId];
    if (!def || def.kind !== 'weapon_affix') return;
    if (def.pieceKind !== pieceKind) return;
    const allowedPieces = TIER_PIECE_SLOTS[slot.weapon.tier];
    if (!allowedPieces.includes(pieceKind)) return;
    if (slot.weapon.pieces[pieceKind]) return; // already filled
    if (def.family && def.family !== weaponFamilyOf(slot.weapon.weaponId)) return;
    const taken = consumeAttachment(conn.inventory, attachmentDefId);
    if (!taken) return;
    slot.weapon.pieces[pieceKind] = taken;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleDetachWeaponAffix(
    characterId: string,
    weaponInventoryIdx: number,
    pieceKind: WeaponPieceKind
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!this.isNearWeaponBench(conn)) return;
    const slot = conn.inventory[weaponInventoryIdx];
    if (!slot || slot.kind !== 'weapon') return;
    const existing = slot.weapon.pieces[pieceKind];
    if (!existing) return;
    if (!addAttachment(conn.inventory, existing)) return;
    slot.weapon.pieces[pieceKind] = null;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleAttachWeaponMod(
    characterId: string,
    weaponInventoryIdx: number,
    attachmentDefId: string
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!this.isNearWeaponBench(conn)) return;
    const slot = conn.inventory[weaponInventoryIdx];
    if (!slot || slot.kind !== 'weapon') return;
    const def = ATTACHMENT_DEFS[attachmentDefId];
    if (!def || def.kind !== 'weapon_mod') return;
    const cap = TIER_MOD_SLOTS[slot.weapon.tier];
    if (slot.weapon.mods.length >= cap) return;
    if (def.family && def.family !== weaponFamilyOf(slot.weapon.weaponId)) return;
    const taken = consumeAttachment(conn.inventory, attachmentDefId);
    if (!taken) return;
    slot.weapon.mods.push(taken);
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleDetachWeaponMod(
    characterId: string,
    weaponInventoryIdx: number,
    modIndex: number
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!this.isNearWeaponBench(conn)) return;
    const slot = conn.inventory[weaponInventoryIdx];
    if (!slot || slot.kind !== 'weapon') return;
    const mod = slot.weapon.mods[modIndex];
    if (!mod) return;
    if (!addAttachment(conn.inventory, mod)) return;
    slot.weapon.mods.splice(modIndex, 1);
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleAttachSuitAffix(
    characterId: string,
    suitSlot: SuitSlotKind,
    attachmentDefId: string
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    // Suit affixes craft at electronics_bench but attach at the equipment
    // panel — gated on being near an electronics_bench so it's clear
    // where this happens.
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (
      !surface?.hasBuildingNearby(
        conn.x,
        conn.y,
        'electronics_bench',
        COMBAT.CRAFT_STATION_RANGE_PX
      )
    ) {
      return;
    }
    const part = conn.equipment[suitSlot];
    if (!part) return;
    const def = ATTACHMENT_DEFS[attachmentDefId];
    if (!def || def.kind !== 'suit_affix') return;
    if (def.slotKind !== suitSlot) return;
    const taken = consumeAttachment(conn.inventory, attachmentDefId);
    if (!taken) return;
    if (!part.appliedAttachments) part.appliedAttachments = [];
    part.appliedAttachments.push(taken);
    conn.inventoryDirty = true;
    this.recomputePlayerStats(conn);
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleDetachSuitAffix(
    characterId: string,
    suitSlot: SuitSlotKind,
    attachmentIndex: number
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (
      !surface?.hasBuildingNearby(
        conn.x,
        conn.y,
        'electronics_bench',
        COMBAT.CRAFT_STATION_RANGE_PX
      )
    ) {
      return;
    }
    const part = conn.equipment[suitSlot];
    if (!part || !part.appliedAttachments) return;
    const inst = part.appliedAttachments[attachmentIndex];
    if (!inst) return;
    if (!addAttachment(conn.inventory, inst)) return;
    part.appliedAttachments.splice(attachmentIndex, 1);
    conn.inventoryDirty = true;
    this.recomputePlayerStats(conn);
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Tier-up: T1 → T2 → T3 → T4. Consumes a tier-scaled material cost
  // and increments the weapon's tier. Existing pieces and mods are
  // preserved; the new tier exposes additional piece slots that the
  // player can fill at a later visit.
  handleTierUpWeapon(characterId: string, weaponInventoryIdx: number): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    // Tier-up is gated on the Precision Machining Mill; the Weapon
    // Bench focuses on assembly only.
    if (!this.isNearPrecisionMill(conn)) return;
    const slot = conn.inventory[weaponInventoryIdx];
    if (!slot || slot.kind !== 'weapon') return;
    if (slot.weapon.tier >= 4) return;
    const cost = TIER_UP_COSTS[slot.weapon.tier as 1 | 2 | 3];
    if (!cost) return;
    for (const c of cost) {
      if (countMaterial(conn.inventory, c.materialId) < c.count) return;
    }
    for (const c of cost) {
      consumeMaterial(conn.inventory, c.materialId, c.count);
    }
    slot.weapon.tier = (slot.weapon.tier + 1) as WeaponTier;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Atomic weapon assembly. Player has staged a target piece+mod
  // configuration in the Weapon Bench UI; on commit, server diffs
  // against the current weapon by AttachmentInstance.id and either
  // applies the whole transaction or rejects it. Each attachment is
  // identified by its instance id (unique post-Sprint C); the client
  // sends ids the server can verify against either the live weapon
  // (kept attachments) or the player's inventory (newly attached).
  handleAssembleWeapon(
    characterId: string,
    weaponInventoryIdx: number,
    pieces: Partial<Record<WeaponPieceKind, string | null | undefined>>,
    mods: string[]
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!this.isNearWeaponBench(conn)) return;
    const slot = conn.inventory[weaponInventoryIdx];
    if (!slot || slot.kind !== 'weapon') return;
    const weapon = slot.weapon;
    const family = weaponFamilyOf(weapon.weaponId);
    if (family === 'melee') return;

    // Bench-tier gate (Phase 2.2). The player must be in range of
    // a Weapon Bench whose tier ≥ the weapon's tier. Multiple
    // benches in range pick the highest tier. The client UI greys
    // out un-assemblable weapons; this is the authoritative check.
    const benchTier = this.nearestWeaponBenchTier(conn);
    if (weapon.tier > benchTier) {
      this.sendDirect(conn.ws, {
        type: 'error',
        message: 'bench_tier_too_low',
      });
      return;
    }

    const allowedPieces = TIER_PIECE_SLOTS[weapon.tier];
    const modCap = TIER_MOD_SLOTS[weapon.tier];
    if (mods.length > modCap) return;

    const PIECE_KEYS: WeaponPieceKind[] = ['frame', 'grip', 'magazine', 'barrel'];
    // Reject any piece target that targets a slot the current tier
    // doesn't expose (e.g. trying to attach to 'barrel' on a T1).
    for (const piece of PIECE_KEYS) {
      const target = pieces[piece];
      if (target === undefined) continue;
      if (!allowedPieces.includes(piece) && target !== null) return;
    }

    // Working clones — every mutation lands here first; we copy back
    // to the live state only if every step succeeds. Slots are shallow-
    // copied so the live inventory isn't aliased mid-validation.
    const workingInv: typeof conn.inventory = conn.inventory.map((s) =>
      ({ ...s })
    );

    const pullFromInv = (instanceId: string): AttachmentInstance | null => {
      for (let i = 0; i < workingInv.length; i++) {
        const s = workingInv[i];
        if (s.kind === 'attachment' && s.instance.id === instanceId) {
          const inst = s.instance;
          workingInv[i] = { kind: 'empty' };
          return inst;
        }
      }
      return null;
    };
    const pushToInv = (instance: AttachmentInstance): boolean => {
      for (let i = 0; i < workingInv.length; i++) {
        if (workingInv[i].kind === 'empty') {
          workingInv[i] = { kind: 'attachment', instance };
          return true;
        }
      }
      return false;
    };

    const workingPieces: WeaponPieces = { ...weapon.pieces };
    for (const piece of PIECE_KEYS) {
      const target = pieces[piece];
      if (target === undefined) continue;
      const current = workingPieces[piece] ?? null;

      if (target === null) {
        if (current) {
          if (!pushToInv(current)) return;
          workingPieces[piece] = null;
        }
        continue;
      }
      // target is a string instance id.
      if (current && current.id === target) continue; // unchanged

      if (current) {
        if (!pushToInv(current)) return;
        workingPieces[piece] = null;
      }
      const inst = pullFromInv(target);
      if (!inst) return;
      const def = ATTACHMENT_DEFS[inst.defId];
      if (!def || def.kind !== 'weapon_affix') return;
      if (def.pieceKind !== piece) return;
      if (def.family !== null && def.family !== family) return;
      workingPieces[piece] = inst;
    }

    // Mods: process target ids in order. For each, prefer matching a
    // still-attached mod by id (kept); otherwise pull from inventory.
    // Anything still in the existing-mod pool at the end is detached.
    const remainingExisting: AttachmentInstance[] = [...weapon.mods];
    const workingMods: AttachmentInstance[] = [];
    for (const targetId of mods) {
      const keepIdx = remainingExisting.findIndex((m) => m.id === targetId);
      if (keepIdx >= 0) {
        workingMods.push(remainingExisting[keepIdx]);
        remainingExisting.splice(keepIdx, 1);
        continue;
      }
      const inst = pullFromInv(targetId);
      if (!inst) return;
      const def = ATTACHMENT_DEFS[inst.defId];
      if (!def || def.kind !== 'weapon_mod') return;
      if (def.family !== null && def.family !== family) return;
      workingMods.push(inst);
    }
    for (const m of remainingExisting) {
      if (!pushToInv(m)) return;
    }

    // All validation passed — commit. Mutating `slot.weapon` directly
    // is safe because the inventory slot still points at the same
    // weapon object; clients re-render off `inventory_changed`.
    for (let i = 0; i < workingInv.length; i++) {
      conn.inventory[i] = workingInv[i];
    }
    weapon.pieces = workingPieces;
    weapon.mods = workingMods;
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Atomic suit-part assembly. Mirrors handleAssembleWeapon for the
  // suit-side: target attachment list arrives by AttachmentInstance
  // id, server diffs against the live equipped part, validates
  // every newly-attached id is in inventory + every detached id has
  // somewhere to land in inventory, applies the whole transaction
  // or rejects. Recomputes suit stats on commit so the HP/shield/
  // stamina/speed bonuses surface immediately.
  handleAssembleSuitPart(
    characterId: string,
    suitSlot: SuitSlotKind,
    attachments: string[]
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!this.isNearSuitBench(conn)) return;
    const part = conn.equipment[suitSlot];
    if (!part) {
      this.sendDirect(conn.ws, {
        type: 'error',
        message: 'suit_slot_empty',
      });
      return;
    }

    // Per-tier slot cap. A Mk1 part can only host 1 attachment;
    // higher tiers expose more slots. The client UI gates this
    // too, but server is authoritative.
    const slotCap = SUIT_ATTACHMENT_SLOTS[part.tier];
    if (attachments.length > slotCap) {
      this.sendDirect(conn.ws, {
        type: 'error',
        message: 'suit_slot_cap',
      });
      return;
    }

    // Working clones — every mutation lands here first; commit
    // only if every step succeeds. Same diff-and-rollback pattern
    // as handleAssembleWeapon.
    const workingInv: typeof conn.inventory = conn.inventory.map((s) => ({
      ...s,
    }));
    const pullFromInv = (
      instanceId: string
    ): import('@dumrunner/shared').AttachmentInstance | null => {
      for (let i = 0; i < workingInv.length; i++) {
        const s = workingInv[i];
        if (s.kind === 'attachment' && s.instance.id === instanceId) {
          const inst = s.instance;
          workingInv[i] = { kind: 'empty' };
          return inst;
        }
      }
      return null;
    };
    const pushToInv = (
      instance: import('@dumrunner/shared').AttachmentInstance
    ): boolean => {
      for (let i = 0; i < workingInv.length; i++) {
        if (workingInv[i].kind === 'empty') {
          workingInv[i] = { kind: 'attachment', instance };
          return true;
        }
      }
      return false;
    };

    // Walk the diff. For each target id, prefer keeping a still-
    // attached attachment with that id; otherwise pull from
    // inventory. Anything left in remainingExisting at the end is
    // detached back into inventory.
    const remainingExisting = [...(part.appliedAttachments ?? [])];
    const workingAttachments: import('@dumrunner/shared').AttachmentInstance[] =
      [];
    for (const targetId of attachments) {
      const keepIdx = remainingExisting.findIndex((a) => a.id === targetId);
      if (keepIdx >= 0) {
        workingAttachments.push(remainingExisting[keepIdx]);
        remainingExisting.splice(keepIdx, 1);
        continue;
      }
      const inst = pullFromInv(targetId);
      if (!inst) return;
      const def = ATTACHMENT_DEFS[inst.defId];
      if (!def || def.kind !== 'suit_affix') return;
      if (def.slotKind !== suitSlot) return;
      workingAttachments.push(inst);
    }
    for (const a of remainingExisting) {
      if (!pushToInv(a)) return; // no room — reject the whole transaction
    }

    // Commit. Suit stats recompute via recomputePlayerStats so the
    // player's maxHp / maxShield / etc. update immediately; the
    // helper also broadcasts player_damaged + equipment_changed.
    for (let i = 0; i < workingInv.length; i++) {
      conn.inventory[i] = workingInv[i];
    }
    part.appliedAttachments = workingAttachments;
    conn.inventoryDirty = true;
    this.recomputePlayerStats(conn);
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    this.sendDirect(conn.ws, {
      type: 'equipment_changed',
      equipment: conn.equipment,
    });
  }

  // Apply a workstation upgrade item to a target building. The item
  // is found by id in the player's inventory; the building is found
  // by id in the current scene. Validates: building exists, player
  // in range, building.kind matches the upgrade's targetBuilding,
  // and building.benchTier === upgrade.targetTier - 1 (tiers must
  // step in order; no skipping). On success, building.benchTier
  // becomes the upgrade's targetTier and one item is consumed.
  handleUpgradeWorkstation(
    characterId: string,
    buildingId: string,
    upgradeId: string
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (!surface) return;

    const def = UPGRADES[upgradeId as keyof typeof UPGRADES];
    if (!def) return;

    const b = surface.getBuilding(buildingId);
    if (!b) return;
    if (b.kind !== def.targetBuilding) return;

    // Proximity — same range as crafting stations.
    const tileSize = surface.layout?.tileSize ?? 32;
    const cx = (b.tileX + b.width / 2) * tileSize;
    const cy = (b.tileY + b.height / 2) * tileSize;
    const dx = conn.x - cx;
    const dy = conn.y - cy;
    if (
      dx * dx + dy * dy >
      COMBAT.CRAFT_STATION_RANGE_PX * COMBAT.CRAFT_STATION_RANGE_PX
    ) {
      this.sendDirect(conn.ws, { type: 'error', message: 'upgrade_too_far' });
      return;
    }

    // Tier-step gate. Mk1 → Mk2 only; Mk2 → Mk3 only; etc. No
    // skipping — the player has to apply each successive upgrade.
    const currentTier = b.benchTier ?? 1;
    if (def.targetTier !== currentTier + 1) {
      this.sendDirect(conn.ws, {
        type: 'error',
        message: 'upgrade_wrong_tier',
      });
      return;
    }

    // Inventory check + consume.
    if (countUpgrade(conn.inventory, def.id) < 1) {
      this.sendDirect(conn.ws, {
        type: 'error',
        message: 'upgrade_not_owned',
      });
      return;
    }
    consumeUpgrade(conn.inventory, def.id, 1);

    // Apply. Re-broadcast building_placed so every client sees the
    // new benchTier; the renderer + UI key off it.
    surface.setBuildingTier(buildingId, def.targetTier);

    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Use a consumable from the given inventory slot. Currently the
  // medkit is the only kind — applies its healHp to the player's
  // SceneConnection.hp (capped at maxHp). Server broadcasts the new
  // hp + inventory_changed so the client mirrors the state.
  handleUseConsumable(characterId: string, slot: number): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (slot < 0 || slot >= conn.inventory.length) return;
    const s = conn.inventory[slot];
    if (s.kind !== 'consumable' || s.count <= 0) return;
    const def = CONSUMABLES[s.consumableId];
    if (!def) return;
    // No-op if there's nothing useful left to grant — only checked
    // when the consumable is *only* a heal. Effect-bearing kinds
    // (stim, overcharge) refresh their timer regardless.
    const hasEffects = (def.effects?.length ?? 0) > 0;
    if (def.healHp > 0 && !hasEffects && conn.hp >= conn.maxHp) return;
    const id = consumeConsumable(conn.inventory, slot);
    if (!id) return;

    // Apply each timed effect (refreshing the timer if already
    // active). Recompute happens inside applyPlayerEffect so the
    // shield/hp caps reflect the new totals before we top them off.
    const now = Date.now();
    if (def.effects) {
      for (const e of def.effects) {
        this.applyPlayerEffect(conn.characterId, {
          id: e.id,
          kind: e.kind,
          magnitude: e.magnitude,
          expiresAt: now + e.durationMs,
          label: e.label,
        });
      }
    }
    // Overcharge tops off the shield bar so the +50 isn't wasted on
    // a player who was already at full base shield. Same pattern can
    // extend to other shield_flat effects later.
    if (s.consumableId === 'overcharge_kit') {
      conn.shield = conn.maxShield;
    }

    if (def.healHp > 0) {
      conn.hp = Math.min(conn.maxHp, conn.hp + def.healHp);
    }
    if (def.healHp > 0 || s.consumableId === 'overcharge_kit') {
      conn.dirty = true;
      const scene = this.scenes.get(conn.sceneId);
      scene?.broadcast({
        type: 'player_damaged',
        characterId: conn.characterId,
        hp: conn.hp,
        maxHp: conn.maxHp,
        shield: conn.shield,
        maxShield: conn.maxShield,
      });
    }
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  // Player buys keys at an artifact uplink. Mirrors handlePurchaseBlueprint
  // — surface only, in range of an uplink, must afford `count *
  // KEY_ARTIFACT_COST` artifacts. Atomic: nothing changes if any check fails.
  handlePurchaseKey(characterId: string, count: number): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (!Number.isInteger(count) || count < 1 || count > 10) return;
    if (conn.sceneId !== SURFACE_SCENE_ID) return;
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    if (
      !surface?.hasBuildingNearby(
        conn.x,
        conn.y,
        'artifact_uplink',
        COMBAT.CRAFT_STATION_RANGE_PX
      )
    ) {
      return;
    }
    const totalCost = count * KEY_ARTIFACT_COST;
    if (countMaterial(conn.inventory, 'artifact') < totalCost) return;

    consumeMaterial(conn.inventory, 'artifact', totalCost);
    addMaterial(conn.inventory, 'key', count);
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
  }

  handleEquipRequest(
    characterId: string,
    fromInventoryIdx: number,
    suitSlot: SuitSlotKind
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (fromInventoryIdx < 0 || fromInventoryIdx >= conn.inventory.length) return;
    const slot = conn.inventory[fromInventoryIdx];
    if (slot.kind !== 'part') return;
    const part = slot.part;
    if (!isSuitPart(part.slot)) return;
    if (part.slot !== suitSlot) return;

    // If the suit slot already has a part, swap it back into the inventory
    // slot we're equipping from.
    const previous = conn.equipment[suitSlot];
    conn.equipment[suitSlot] = part;
    if (previous) {
      conn.inventory[fromInventoryIdx] = { kind: 'part', part: previous };
    } else {
      conn.inventory[fromInventoryIdx] = { kind: 'empty' };
    }
    conn.inventoryDirty = true;
    this.recomputePlayerStats(conn);
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    this.sendDirect(conn.ws, {
      type: 'equipment_changed',
      equipment: conn.equipment,
    });
  }

  handleUnequipRequest(
    characterId: string,
    suitSlot: SuitSlotKind,
    toInventoryIdx?: number
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const equipped = conn.equipment[suitSlot];
    if (!equipped) return;

    // If a target slot was requested:
    //   - empty target → place equipped part there
    //   - target holds another suit-part of the same kind → swap (the held
    //     part goes into the suit slot, ours into the inventory slot)
    //   - any other case → reject
    if (toInventoryIdx !== undefined) {
      if (toInventoryIdx < 0 || toInventoryIdx >= conn.inventory.length) return;
      const target = conn.inventory[toInventoryIdx];
      if (target.kind === 'empty') {
        conn.inventory[toInventoryIdx] = { kind: 'part', part: equipped };
        conn.equipment[suitSlot] = null;
      } else if (
        target.kind === 'part' &&
        isSuitPart(target.part.slot) &&
        target.part.slot === suitSlot
      ) {
        conn.equipment[suitSlot] = target.part;
        conn.inventory[toInventoryIdx] = { kind: 'part', part: equipped };
      } else {
        return;
      }
    } else {
      // Default: drop into first empty inventory slot.
      const i = findEmptySlot(conn.inventory);
      if (i < 0) return;
      conn.inventory[i] = { kind: 'part', part: equipped };
      conn.equipment[suitSlot] = null;
    }
    conn.inventoryDirty = true;
    this.recomputePlayerStats(conn);
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    this.sendDirect(conn.ws, {
      type: 'equipment_changed',
      equipment: conn.equipment,
    });
  }

  // Recompute the player's effective max HP / shield / stamina + movement
  // and stamina-regen modifiers from their current suit equipment. Called
  // on every equip/unequip and once at character spawn so equipment loaded
  // from the DB takes effect immediately. Broadcasts updated stats so the
  // client HUD reflects the new caps.
  private recomputePlayerStats(conn: Connection): void {
    const stats = computeSuitStats(conn.equipment);
    // Fold active timed effects in on top of suit stats. Each effect
    // kind sums independently, then merges into the suit-derived
    // value the same way an extra suit affix would.
    let effectSpeedMult = 0;
    let effectStaminaRegen = 0;
    let effectShieldFlat = 0;
    let effectHpFlat = 0;
    for (const e of conn.activeEffects) {
      if (e.kind === 'speed_mult') effectSpeedMult += e.magnitude;
      else if (e.kind === 'stamina_regen_add') effectStaminaRegen += e.magnitude;
      else if (e.kind === 'shield_flat') effectShieldFlat += e.magnitude;
      else if (e.kind === 'hp_max_flat') effectHpFlat += e.magnitude;
      // slow_pct subtracts from move speed (magnitude is positive,
      // direction inverted here so the kind is intuitive at the
      // attack-author site).
      else if (e.kind === 'slow_pct') effectSpeedMult -= e.magnitude;
      // DoT effects don't touch derived stats; they're applied per
      // tick in tickPlayerEffects directly.
    }
    // Round to integers so the HUD doesn't render 15-digit floats from
    // affix rolls. HP/shield/stamina maxes are always whole numbers in
    // every UI surface.
    conn.maxHp = Math.round(
      COMBAT.PLAYER_MAX_HP + stats.hpBonus + effectHpFlat
    );
    conn.maxShield = Math.round(
      COMBAT.PLAYER_DEFAULT_MAX_SHIELD + stats.shieldBonus + effectShieldFlat
    );
    conn.maxStamina = Math.round(COMBAT.PLAYER_MAX_STAMINA + stats.staminaMaxBonus);
    // Floor the composed multiplier so stacked slows can't drive
    // move speed to zero or negative (worst case: 0.2× base).
    conn.suitSpeedMult = Math.max(
      -0.8,
      stats.moveSpeedMult + effectSpeedMult,
    );
    conn.suitStaminaRegenBonus = stats.staminaRegenBonus + effectStaminaRegen;
    conn.suitBuildRadiusBonus = Math.floor(stats.buildRadiusBonus);
    conn.suitHeatResist = stats.heatResist;
    conn.suitColdResist = stats.coldResist;
    conn.suitRadiationResist = stats.radiationResist;
    conn.suitToxicResist = stats.toxicResist;
    // Resize the bag to match the new cargo bonus. The helper
    // refuses to shrink below the highest non-empty slot, so
    // unequipping a cargo grid is safe.
    resizeInventory(
      conn.inventory,
      INVENTORY_SIZE + Math.floor(stats.inventoryBonus)
    );
    // After resize, broadcast the new inventory shape so the client
    // re-renders the bag at the right size.
    conn.inventoryDirty = true;
    this.sendDirect(conn.ws, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
    // Clamp current values to the new caps. Unequipping a chassis doesn't
    // damage the player, but it does cap their hp at the new (lower) max.
    if (conn.hp > conn.maxHp) conn.hp = conn.maxHp;
    if (conn.shield > conn.maxShield) conn.shield = conn.maxShield;
    if (conn.stamina > conn.maxStamina) conn.stamina = conn.maxStamina;
    // Broadcast the changes — player_damaged carries hp/maxHp/shield/
    // maxShield, player_stamina carries stamina/maxStamina.
    const scene = this.scenes.get(conn.sceneId);
    scene?.broadcast({
      type: 'player_damaged',
      characterId: conn.characterId,
      hp: conn.hp,
      maxHp: conn.maxHp,
      shield: conn.shield,
      maxShield: conn.maxShield,
    });
    this.sendDirect(conn.ws, {
      type: 'player_stamina',
      stamina: conn.stamina,
      maxStamina: conn.maxStamina,
    });
  }

  // ---------- tick ----------

  private tick(): void {
    const now = Date.now();
    const dt =
      this.lastTickAt === 0
        ? COMBAT.TICK_MS / 1000
        : (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;

    this.tickHordeClock(now);
    this.tickCraftJobs(now);
    this.tickPlayerEffects(now);
    this.tickDeathmatch(now);
    void this.checkPausedFlag(now);

    for (const scene of this.scenes.values()) {
      scene.tick(dt, now);
    }

    // Throttled world_clock broadcast (1 Hz).
    if (now - this.lastClockBroadcastAt >= COMBAT.WORLD_CLOCK_INTERVAL_MS) {
      this.lastClockBroadcastAt = now;
      this.broadcastWorldClock(now);
    }
  }

  // Drives the day-clock + perihelion + horde state machine.
  // States:
  //   - normal: counting down to perihelion. When elapsed >= cycle length,
  //     fire the horde.
  //   - hordeActive: counting down to horde end. When elapsed >= horde
  //     length, end the horde and reset the cycle clock.
  // The clock is paused when zero players are connected. Wall-clock
  // anchors (cycleStartedAt, hordeEndsAt) get slid forward by the empty
  // gap so the cycle resumes from the same elapsed point when the next
  // player joins — an idle overnight server doesn't burn cycles.
  private tickHordeClock(now: number): void {
    const prev = this.lastHordeClockAt;
    this.lastHordeClockAt = now;
    if (this.connections.size === 0) {
      // Slide the cycle anchor forward so when the next player joins
      // the same amount of cycle time remains. Same trick for the
      // active horde's end timestamp.
      const dt = prev === 0 ? 0 : now - prev;
      if (dt > 0) {
        this.cycleStartedAt += dt;
        if (this.hordeActive) this.hordeEndsAt += dt;
      }
      return;
    }
    const cycleLengthMs =
      this.worldConfig.daysPerCycle * this.worldConfig.dayDurationMs;
    if (!this.hordeActive) {
      if (now - this.cycleStartedAt >= cycleLengthMs) {
        this.startHorde(now);
      }
      return;
    }
    if (now >= this.hordeEndsAt) {
      this.endHorde(now);
    }
  }

  // Recompute and broadcast the surface power state. Capacity scales
  // with deepestFloorReached when the Power Link is alive, otherwise 0.
  // Draw is the count of currently-consuming buildings (turrets in
  // alpha; Phase 4 adds active craft jobs). Powered set picks consumers
  // in deterministic id order until capacity is exhausted.
  private recomputePowerState(): void {
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    const linkAlive =
      surface?.findBuildingByKind('power_link') !== null && this.powerOnline;
    this.powerCapacity = linkAlive
      ? COMBAT.POWER_BASE_CAPACITY +
        COMBAT.POWER_PER_DEPTH * this.deepestFloorReached
      : 0;

    const consumers =
      surface?.findBuildingsByKind([
        'turret',
        'turret_smg',
        'turret_shotgun',
        'turret_rifle',
      ]) ?? [];
    let activeCraftCount = 0;
    for (const job of this.activeCraftJobs.values()) {
      if (job.completesAt > 0) activeCraftCount++;
    }
    this.powerDraw =
      consumers.length * COMBAT.POWER_DRAW_TURRET +
      activeCraftCount * COMBAT.POWER_DRAW_CRAFT_JOB;

    this.poweredBuildings.clear();
    let remaining = this.powerCapacity;
    for (const c of consumers) {
      if (remaining < COMBAT.POWER_DRAW_TURRET) break;
      this.poweredBuildings.add(c.id);
      remaining -= COMBAT.POWER_DRAW_TURRET;
    }

    this.broadcastAll({
      type: 'power_state',
      capacity: this.powerCapacity,
      draw: this.powerDraw,
      online: this.powerCapacity > 0,
      poweredBuildingIds: [...this.poweredBuildings],
    });
  }

  // Power Link destroyed mid-cycle. Cascades a heavy reset: any players
  // currently in a dungeon scene get evicted to the surface, every
  // dungeon scene drops (procgen reseeds on the next descent), the
  // deepest-floor counter resets to 1, and powered defences go silent.
  // The Link itself rebuilds at the next perihelion (endHorde).
  private handlePowerLinkDestroyed(): void {
    if (!this.powerOnline) return; // already torn down
    console.log(`[world ${this.serverId}] power link destroyed — dungeon reset`);
    this.powerOnline = false;
    this.deepestFloorReached = 1;

    // Evict any dungeon-side players to the surface entrance.
    const stragglers: string[] = [];
    for (const [characterId, conn] of this.connections) {
      if (conn.sceneId !== SURFACE_SCENE_ID) stragglers.push(characterId);
    }
    for (const characterId of stragglers) {
      this.transition(
        characterId,
        SURFACE_SCENE_ID,
        SURFACE_ENTRANCE_X,
        SURFACE_ENTRANCE_Y
      );
    }
    // Drop every dungeon scene so the next descent reseeds them fresh.
    for (const sceneId of [...this.scenes.keys()]) {
      if (sceneId === SURFACE_SCENE_ID) continue;
      this.scenes.delete(sceneId);
    }
    // Capacity is now 0 (Link gone) — broadcast so client HUD reflects.
    this.recomputePowerState();
  }

  private startHorde(now: number): void {
    this.hordeActive = true;
    this.hordeEndsAt = now + COMBAT.HORDE_DURATION_MS;
    console.log(
      `[world ${this.serverId}] perihelion! horde fired (cycle ${this.cycle})`
    );
    this.broadcastAll({
      type: 'horde_started',
      cycle: this.cycle,
      durationMs: COMBAT.HORDE_DURATION_MS,
    });
    // Tell the surface scene to start spawning waves. Dungeons keep running
    // their own enemies; the horde is a surface-only event. Threat scales
    // with the crew's frontier depth this cycle (floored by cycle index so
    // veteran worlds never regress to trivial hordes) — mirrors the power
    // capacity the crew earned by diving, so defense investment is rational
    // from session one instead of cycle six.
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    surface?.startHorde(
      this.hordeEndsAt,
      Math.max(this.deepestFloorReached, this.cycle),
    );

    // Anyone caught in a dungeon when perihelion fires gets the LINK
    // SEVERED treatment: glitch overlay, kill-in-place (corpse drops on
    // the dungeon floor with their loot), respawn at the surface.
    for (const [characterId, conn] of this.connections) {
      if (conn.sceneId === SURFACE_SCENE_ID) continue;
      this.sendDirect(conn.ws, { type: 'link_severed' });
      const scene = this.scenes.get(conn.sceneId);
      scene?.killMemberInPlace(characterId, now);
    }
  }

  private endHorde(_now: number): void {
    this.hordeActive = false;
    this.cycle += 1;
    this.cycleStartedAt = Date.now();
    console.log(
      `[world ${this.serverId}] horde ended; advancing to cycle ${this.cycle}`
    );
    this.broadcastAll({ type: 'horde_ended', newCycle: this.cycle });
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    surface?.endHorde();

    // Cycle reset:
    //   1. Anyone caught underground at perihelion gets evicted to the
    //      surface — their old floor is about to vanish.
    //   2. Drop every dungeon scene from the map. Procgen reseeds off
    //      (worldSeed, cycle, floorIndex), so the next descent cuts a
    //      brand-new layout.
    //   3. Wipe corpses + dropped loot on the surface (anyone who didn't
    //      recover their stuff before perihelion loses it).
    const stragglers: string[] = [];
    for (const [characterId, conn] of this.connections) {
      if (conn.sceneId !== SURFACE_SCENE_ID) {
        stragglers.push(characterId);
      }
    }
    for (const characterId of stragglers) {
      this.transition(
        characterId,
        SURFACE_SCENE_ID,
        SURFACE_ENTRANCE_X,
        SURFACE_ENTRANCE_Y
      );
    }
    for (const sceneId of [...this.scenes.keys()]) {
      if (sceneId === SURFACE_SCENE_ID) continue;
      this.scenes.delete(sceneId);
    }
    surface?.wipeCorpsesAndLoot();

    // Power Link rebuild + power restore. If the Link survived the horde,
    // ensurePowerLink is a no-op; if it was destroyed mid-cycle (or by
    // hordes themselves), it respawns at full HP and powered defences
    // come back online.
    if (surface) {
      surface.ensurePowerLink(
        POWER_LINK_TILE_X,
        POWER_LINK_TILE_Y,
        POWER_LINK_TILE_W,
        POWER_LINK_TILE_H
      );
    }
    this.powerOnline = true;
    this.deepestFloorReached = 1;
    this.recomputePowerState();

    // Schematics are NOT wiped at cycle reset — knowledge is permanent
    // (GDD §The Economy Law). The per-cycle wipe that used to live here
    // was an implementation artifact, never design.
  }

  private broadcastWorldClock(now: number): void {
    const cycleLengthMs =
      this.worldConfig.daysPerCycle * this.worldConfig.dayDurationMs;
    const elapsed = now - this.cycleStartedAt;
    const remaining = Math.max(0, cycleLengthMs - elapsed);
    this.broadcastAll({
      type: 'world_clock',
      cycle: this.cycle,
      secondsToPerihelion: this.hordeActive
        ? Math.max(0, Math.ceil((this.hordeEndsAt - now) / 1000))
        : Math.ceil(remaining / 1000),
      hordeActive: this.hordeActive,
    });
  }

  // Broadcast a message to every connected player on this server, regardless
  // of which scene they're in. Used for global events (clock, perihelion).
  private broadcastAll(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(data);
      }
    }
  }

  // Server-issued chat (joins, leaves, deaths, perihelion). The
  // 'system' kind lets the client render these distinctly from
  // player-typed messages.
  private systemChat(text: string): void {
    this.broadcastAll({
      type: 'chat',
      kind: 'system',
      characterId: null,
      displayName: 'system',
      text,
      ts: Date.now(),
    });
  }

  // Player-typed chat. Caller (index.ts dispatch) has already passed
  // the Zod-validated text. World rate-limits per character to keep
  // shouting bots from drowning the channel.
  handleChat(characterId: string, text: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const now = Date.now();
    const last = this.lastChatAt.get(characterId) ?? 0;
    if (now - last < 600) return; // ~1.6 messages/sec
    this.lastChatAt.set(characterId, now);
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.broadcastAll({
      type: 'chat',
      kind: 'player',
      characterId,
      displayName: conn.displayName,
      text: trimmed.slice(0, 280),
      ts: now,
    });
  }
  private lastChatAt = new Map<string, number>();

  // Owner-only pause flow. Persists state, broadcasts to every
  // connection, closes them, marks the DB row paused, and stops
  // tick/persist timers. Lobby-side join from the owner flips
  // is_paused back to false; non-owner joins are rejected.
  async handlePauseServer(characterId: string): Promise<void> {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    if (this.ownerAccountId === null || conn.accountId !== this.ownerAccountId) {
      this.sendDirect(conn.ws, { type: 'error', message: 'pause_owner_only' });
      return;
    }
    await this.pauseAndKick({ markDb: true });
  }

  // Shared core for both owner-initiated pause and the DB poll path.
  // markDb=false means the DB flag is already set (poll detected it),
  // so we just kick and exit.
  private async pauseAndKick(opts: { markDb: boolean }): Promise<void> {
    if (this.pausing) return;
    this.pausing = true;
    console.log(
      `[world ${this.serverId}] pausing — kicking ${this.connections.size} connection(s)`
    );
    if (opts.markDb) {
      const { error } = await supabase
        .from('servers')
        .update({ is_paused: true })
        .eq('id', this.serverId);
      if (error) {
        console.error(
          `[world ${this.serverId}] pause: db update failed`,
          error.message
        );
      }
    }
    // Persist everyone's character + world snapshot before kicking.
    await this.flushConnections();
    // Tell each connection it's been paused so the client can
    // route back to the lobby with a useful message; close right
    // after.
    const conns = [...this.connections.values()];
    for (const c of conns) {
      this.sendDirect(c.ws, { type: 'server_paused' });
    }
    for (const c of conns) {
      try {
        c.ws.close(4090, 'server_paused');
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    this.stopTimers();
    // Evict from the registry so the next join (post-resume) gets a
    // fresh World with timers + state hydrated from scratch. Reusing
    // this instance leaves `pausing` permanently true and never
    // restarts the tick loop, which broke the second pause.
    const { registry } = await import('./registry.js');
    registry.evict(this.serverId);
  }

  // Polls servers.is_paused so a lobby pause (owner not connected,
  // or kicked from a different surface) still kicks anyone here.
  // Apply (or refresh) a timed effect on a player. Same id refreshes
  // the timer in place rather than stacking multiple identical
  // effects — a back-to-back stim extends duration, not concurrency.
  // Triggers a stat recompute + 'player_effects' broadcast so the
  // HUD timer reflects reality.
  applyPlayerEffect(
    characterId: string,
    effect: import('@dumrunner/shared').PlayerEffect
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const idx = conn.activeEffects.findIndex((e) => e.id === effect.id);
    if (idx >= 0) {
      conn.activeEffects[idx] = effect;
    } else {
      conn.activeEffects.push(effect);
    }
    this.recomputePlayerStats(conn);
    this.sendDirect(conn.ws, {
      type: 'player_effects',
      characterId,
      effects: conn.activeEffects,
    });
  }

  // Walk every connection: apply DoT damage, drop expired effects.
  // recomputePlayerStats runs only for connections whose effect list
  // shrank or whose DoTs killed them, so we don't broadcast no-op
  // stat changes every tick. Per-tick DoT applies a fraction of the
  // dps based on tick interval — small enough that the player sees
  // smooth bar drain.
  private tickPlayerEffects(now: number): void {
    const dt = COMBAT.TICK_MS / 1000;
    for (const conn of this.connections.values()) {
      if (conn.activeEffects.length === 0) continue;
      // DoT damage. Each burn / poison effect ticks per-tick damage.
      // Expiry is checked here too — an effect past expiresAt must
      // not land one final tick of damage before the filter below
      // removes it.
      let dotTotal = 0;
      for (const e of conn.activeEffects) {
        if (e.expiresAt <= now) continue;
        if (e.kind === 'burn_dps' || e.kind === 'poison_dps') {
          dotTotal += e.magnitude * dt;
        }
      }
      if (dotTotal > 0 && conn.alive) {
        const scene = this.scenes.get(conn.sceneId);
        if (scene) {
          // Route through the scene damage path so shield-soak +
          // death detection is consistent with bullets / melee.
          // Bypasses respawn-immunity check by going through the
          // public method (Scene exposes one).
          scene.applyDamageToPlayer(conn.characterId, dotTotal, now);
        }
      }
      const before = conn.activeEffects.length;
      conn.activeEffects = conn.activeEffects.filter(
        (e) => e.expiresAt > now
      );
      if (conn.activeEffects.length < before) {
        this.recomputePlayerStats(conn);
        this.sendDirect(conn.ws, {
          type: 'player_effects',
          characterId: conn.characterId,
          effects: conn.activeEffects,
        });
      }
    }
  }

  // Deathmatch round state machine. Pure timer-driven — kill-cap
  // detection is handled inline by `handleDeathmatchKill` so a
  // winning kill triggers intermission immediately instead of
  // waiting up to a tick. This tick is for the OTHER end
  // conditions: duration timeout (round ran the clock out without
  // anyone hitting the cap) and intermission expiry (start the
  // next round).
  private tickDeathmatch(now: number): void {
    const round = this.deathmatchRound;
    if (!round) return;
    if (round.intermissionEndsAt === null) {
      // Active round — check wall-clock timeout.
      if (now - round.startedAt >= round.durationMs) {
        this.endDeathmatchRound(now, /*reason*/ 'timeout');
      }
      return;
    }
    // Intermission — start the next round when the timer elapses.
    if (now >= round.intermissionEndsAt) {
      this.beginDeathmatchRound(now);
    }
  }

  // Called from the SceneBindings.onDeathmatchKill hook on every
  // PvP kill. Checks whether the kill ends the round; if not,
  // broadcasts a score update so clients can refresh the scoreboard.
  private handleDeathmatchKill(killerCharacterId: string): void {
    const round = this.deathmatchRound;
    if (!round) return;
    if (round.intermissionEndsAt !== null) return; // shouldn't fire
    const killer = this.connections.get(killerCharacterId);
    if (!killer) return;
    if (killer.kills >= round.killsToWin) {
      this.endDeathmatchRound(Date.now(), 'cap', killerCharacterId);
      return;
    }
    this.broadcastDeathmatchScores();
  }

  // Round → intermission transition. Snapshots final scores so
  // late disconnects don't mutate the displayed scoreboard, sets
  // the intermission timer, and broadcasts the round-end event.
  // PvP gates off automatically via the `pvpEnabled` binding.
  private endDeathmatchRound(
    now: number,
    reason: 'cap' | 'timeout',
    winnerCharacterId: string | null = null,
  ): void {
    const round = this.deathmatchRound;
    if (!round) return;
    if (round.intermissionEndsAt !== null) return;
    // Pick winner by highest kills if reason was timeout (no one
    // hit the cap). Ties resolve by lowest deaths; if still tied,
    // first-by-id is fine — surfaced to the UI either way.
    let winner = winnerCharacterId;
    if (winner === null) {
      let bestKills = -1;
      let bestDeaths = Infinity;
      for (const c of this.connections.values()) {
        if (
          c.kills > bestKills ||
          (c.kills === bestKills && c.deaths < bestDeaths)
        ) {
          bestKills = c.kills;
          bestDeaths = c.deaths;
          winner = c.characterId;
        }
      }
    }
    round.winnerCharacterId = winner;
    round.intermissionEndsAt = now + DM_INTERMISSION_MS;
    round.finalScores = [...this.connections.values()].map((c) => ({
      characterId: c.characterId,
      displayName: c.displayName,
      kills: c.kills,
      deaths: c.deaths,
    }));
    round.finalScores.sort((a, b) =>
      b.kills - a.kills || a.deaths - b.deaths,
    );
    this.broadcastAll({
      type: 'dm_round_end',
      reason,
      winnerCharacterId: winner,
      intermissionEndsAt: round.intermissionEndsAt,
      scores: round.finalScores,
    });
  }

  // Intermission → fresh round. Zeroes every connection's score
  // counters, kicks any still-dead players back to a spawn (so
  // the next round doesn't start with corpses), and broadcasts
  // the round-start event with the new timer.
  private beginDeathmatchRound(now: number): void {
    const round = this.deathmatchRound;
    if (!round) return;
    for (const c of this.connections.values()) {
      c.kills = 0;
      c.deaths = 0;
    }
    round.startedAt = now;
    round.intermissionEndsAt = null;
    round.winnerCharacterId = null;
    round.finalScores = null;
    // Any players still in the dead/respawning state get yanked
    // back into the round immediately. The respawn path handles
    // pickering a fresh spawn point.
    for (const c of this.connections.values()) {
      if (!c.alive) this.respawnPlayer(c.characterId);
    }
    this.broadcastAll({
      type: 'dm_round_start',
      startedAt: round.startedAt,
      killsToWin: round.killsToWin,
      durationMs: round.durationMs,
    });
    this.broadcastDeathmatchScores();
  }

  // Push the current per-player kill/death table. Used after every
  // PvP kill that doesn't end the round, and once at round start.
  private broadcastDeathmatchScores(): void {
    const scores = [...this.connections.values()].map((c) => ({
      characterId: c.characterId,
      displayName: c.displayName,
      kills: c.kills,
      deaths: c.deaths,
    }));
    scores.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.broadcastAll({
      type: 'dm_scores',
      scores,
    });
  }

  private async checkPausedFlag(now: number): Promise<void> {
    if (this.isSandbox) return;
    if (this.pausing) return;
    if (now - this.lastPauseCheckAt < 5_000) return;
    this.lastPauseCheckAt = now;
    const { data, error } = await supabase
      .from('servers')
      .select('is_paused')
      .eq('id', this.serverId)
      .maybeSingle();
    if (error || !data) return;
    if (data.is_paused) {
      await this.pauseAndKick({ markDb: false });
    }
  }

  // Called by Scene whenever a player dies. Posts a system chat
  // line — the kill feed in every mode goes through here. The
  // `killer` arg is a characterId (or null for environmental
  // deaths); we resolve it to a display name so chat reads
  // "A was killed by B" instead of leaking the opaque id.
  notifyPlayerDied(characterId: string, killer: string | null): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const killerConn = killer ? this.connections.get(killer) : null;
    const killerName = killerConn?.displayName ?? null;
    const text = killerName
      ? `${killerName} killed ${conn.displayName}.`
      : `${conn.displayName} died.`;
    this.systemChat(text);
  }

  // ---------- helpers ----------

  private removeFromCurrentScene(conn: Connection): void {
    const scene = this.scenes.get(conn.sceneId);
    if (!scene) return;
    scene.removeMember(conn.characterId);
    scene.broadcast({ type: 'player_left', characterId: conn.characterId });
  }

  private playersInScene(sceneId: string, exceptCharacterId?: string): Player[] {
    const scene = this.scenes.get(sceneId);
    if (!scene) return [];
    const result: Player[] = [];
    for (const id of scene.members) {
      if (id === exceptCharacterId) continue;
      const conn = this.connections.get(id);
      if (!conn) continue;
      result.push(toPlayer(conn));
    }
    return result;
  }

  private requireScene(sceneId: string): Scene {
    const existing = this.scenes.get(sceneId);
    if (existing) return existing;

    if (sceneId === SURFACE_SCENE_ID) {
      const scene = new Scene(SURFACE_SCENE_ID, 'surface', this.bindings, surfaceLayout());
      this.scenes.set(sceneId, scene);
      return scene;
    }

    const floorIndex = parseDungeonScene(sceneId);
    if (floorIndex !== null) {
      return this.createDungeonScene(floorIndex);
    }

    // Unknown scene id — fall back to a bare surface-shaped scene so we don't
    // crash, but log loudly.
    console.warn(`[world ${this.serverId}] unknown sceneId ${sceneId}, creating empty surface`);
    const scene = new Scene(sceneId, 'surface', this.bindings);
    this.scenes.set(sceneId, scene);
    return scene;
  }

  private createDungeonScene(floorIndex: number): Scene {
    const sceneId = dungeonSceneId(floorIndex);
    // Resolve the floor's biome via the per-band assignment.
    // Same (worldSeed, cycle, band) inputs across the cycle, so
    // every player on the server sees the same biome layout.
    const biome = biomeForFloor(this.worldSeed, this.cycle, floorIndex);
    // Floor override: an authored scene pinned to this floor
    // index bypasses procgen entirely. Per-server takes priority
    // over global; cycle is ignored — pinned floors are stable
    // across perihelion (the dungeon's "skeleton").
    // Per-server overrides need a world identity that isn't yet
    // wired through to this class; pass null so only `global`
    // entries resolve. Wire the real server id when scene_overrides
    // gains per-server pinning (admin UI follow-up).
    const overrideSceneId = floorOverrideFor(null, floorIndex);
    let layout: SceneLayout;
    if (overrideSceneId) {
      const polyScene = getOverrideScene(overrideSceneId);
      if (polyScene) {
        layout = rasterizeSectorSceneToLayout(polyScene);
      } else {
        // Reference points at a missing/broken scene. Log and
        // fall through to procgen so the floor still loads.
        console.warn(
          `[world] floor ${floorIndex} override "${overrideSceneId}" missing from scene cache; falling back to procgen`,
        );
        layout = generateFloorLayout(
          this.worldSeed,
          this.cycle,
          floorIndex,
          biome,
        );
      }
    } else {
      layout = generateFloorLayout(
        this.worldSeed,
        this.cycle,
        floorIndex,
        biome,
      );
    }
    const meta = generateLockedRoomMeta(
      layout,
      this.worldSeed,
      this.cycle,
      floorIndex
    );
    const initialSpawns = generateInitialEnemies(
      layout,
      this.worldSeed,
      this.cycle,
      floorIndex
    );
    const initialLoot = generateInitialLoot(
      layout,
      this.worldSeed,
      this.cycle,
      floorIndex,
      meta.lockedRoomIndices
    );
    const initialProps = generateInitialProps(
      layout,
      this.worldSeed,
      this.cycle,
      floorIndex,
    );
    const scene = new Scene(
      sceneId,
      'dungeon_floor',
      this.bindings,
      layout,
      initialSpawns,
      initialLoot,
      meta.doors,
      initialProps,
    );
    // Promote the dungeon's two portal interactables (stairs_down +
    // extract_pad) into solid building cubes so they render as
    // animatable visuals via /editor/buildings. Idempotent — a
    // rehydrated scene already carrying the buildings is left
    // alone. The Interactable layer continues to handle E-press;
    // the building only owns the physical/visual presence.
    scene.ensurePortalBuildings();
    this.scenes.set(sceneId, scene);
    return scene;
  }

  private sendDirect(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendTo(characterId: string, msg: ServerMessage): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    this.sendDirect(conn.ws, msg);
  }

  // ---------- timers ----------

  private ensureTimers(): void {
    if (!this.tickTimer) {
      this.lastTickAt = Date.now();
      this.tickTimer = setInterval(() => this.tick(), COMBAT.TICK_MS);
    }
    // No persistence in sandbox mode — there's nothing to save.
    if (!this.persistTimer && !this.isSandbox) {
      this.persistTimer = setInterval(() => this.flushConnections(), 5000);
    }
  }

  private stopTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleShutdown();
    this.idleTimer = setTimeout(() => {
      console.log(`[world ${this.serverId}] idle, would shut down here.`);
      this.idleTimer = null;
    }, 60_000);
  }

  private cancelIdleShutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ---------- persistence ----------

  private async flushConnections(): Promise<void> {
    const dirty = [...this.connections.values()].filter(
      (c) => c.dirty || c.inventoryDirty
    );
    for (const c of dirty) {
      c.dirty = false;
      c.inventoryDirty = false;
    }
    // Run connection persistence and the scene snapshot in parallel. Cheap
    // either way — connections are a few rows, the scene snapshot is one
    // upsert.
    await Promise.all([
      ...dirty.map((c) => this.persistConnection(c)),
      this.flushSnapshot(),
    ]);
  }

  private async persistConnection(conn: Connection): Promise<void> {
    if (this.isSandbox) return;
    const { error } = await supabase
      .from('characters')
      .update({
        pos_x: conn.x,
        pos_y: conn.y,
        inventory: {
          schema: 4,
          slots: conn.inventory,
          equipment: conn.equipment,
          hotbarSelection: conn.hotbarSelection,
          // Learned schematics are permanent — additive optional field,
          // old schema-4 saves without it hydrate to the starter set.
          blueprints: mergedBlueprints(conn),
        },
      })
      .eq('id', conn.characterId);
    if (error) {
      console.error(
        `[world ${this.serverId}] persist failed for ${conn.characterId}:`,
        error.message
      );
    }
  }
}

// ---------- helpers ----------

function mergedBlueprints(conn: Connection): string[] {
  const merged = new Set<string>(conn.knownBlueprints);
  for (const id of conn.persistentBlueprints) merged.add(id);
  return [...merged];
}

function toPlayer(conn: Connection): Player {
  return {
    characterId: conn.characterId,
    accountId: conn.accountId,
    displayName: conn.displayName,
    x: conn.x,
    y: conn.y,
    z: conn.z,
    crouching: conn.crouching,
    hp: conn.hp,
    maxHp: conn.maxHp,
    stamina: conn.stamina,
    maxStamina: conn.maxStamina,
    shield: conn.shield,
    maxShield: conn.maxShield,
    alive: conn.alive,
  };
}

// Defensive parse — anything that doesn't match a loadable schema is dropped
// rather than crashing the world boot. v3 is accepted (v4 only added the
// optional craftJobs field) so live worlds don't lose their buildings and
// corpses on the upgrade boundary; anything older is treated as "no
// snapshot" and a fresh world is built.
function parseWorldSnapshot(raw: unknown): WorldSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { schema?: unknown; scenes?: unknown };
  if (r.schema !== WORLD_STATE_SCHEMA && r.schema !== 3) return null;
  if (!r.scenes || typeof r.scenes !== 'object') return null;
  // Trust the rest — we wrote it ourselves in flushSnapshot.
  return raw as WorldSnapshot;
}
