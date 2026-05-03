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
  ServerMessage,
  SuitSlotKind,
} from '@dumrunner/shared';
import {
  HOTBAR_SIZE,
  swapSlots,
  discardSlot,
  sortBag,
  isSuitPart,
  findEmptySlot,
  addAttachment,
  addMaterial,
  addRecipeOutputToInventory,
  ATTACHMENT_DEFS,
  BLUEPRINT_CATALOG,
  buildingParallelSlots,
  computeSuitStats,
  CONSUMABLES,
  consumeAttachment,
  consumeConsumable,
  consumeMaterial,
  consumeRecipeInput,
  countMaterial,
  hasRecipeInput,
  KEY_ARTIFACT_COST,
  recipeOutputToSlot,
  RECIPES,
  TIER_MOD_SLOTS,
  TIER_PIECE_SLOTS,
  weaponFamily as weaponFamilyOf,
  type MaterialKind,
  type WeaponPieceKind,
  type WeaponTier,
} from '@dumrunner/shared';
import { supabase } from './supabase.js';
import { COMBAT } from './combat.js';
import {
  Scene,
  type SceneBindings,
  type SceneConnection,
  type SceneSnapshot,
} from './scene.js';
import {
  generateFloorLayout,
  generateInitialEnemies,
  generateInitialLoot,
  generateLockedRoomMeta,
} from './procgen.js';
import type { SceneLayout } from '@dumrunner/shared';

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
  };
}

// Stored under world_states.state. Bump WORLD_SNAPSHOT_SCHEMA on incompatible
// shape changes; older snapshots are discarded (no incremental migration yet).
//   1 — pre-slot inventory (corpse.inventory was CarriedPart[]).
//   2 — slot-based inventory (corpse.inventory is Inventory).
//   3 — adds cycle + cycleStartedAt for the perihelion clock.
const WORLD_SNAPSHOT_SCHEMA = 3;
type WorldSnapshotV3 = {
  schema: typeof WORLD_SNAPSHOT_SCHEMA;
  scenes: Record<string, SceneSnapshot>;
  cycle: number;
  cycleStartedAt: number;
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
  // Blueprints the player has access to.
  //   - knownBlueprints: per-cycle. Wiped at perihelion / endHorde.
  //   - persistentBlueprints: legendary tier — survive perihelion. Today
  //     these are in-memory only; once an artifact-trade store grants them,
  //     we'll round-trip through the characters table.
  knownBlueprints: Set<string>;
  persistentBlueprints: Set<string>;
};

const SURFACE_SCENE_ID = 'surface';
const DUNGEON_SCENE_PREFIX = 'dungeon:';
const TRANSITION_COOLDOWN_MS = 800;
// Per-kind parallel craft job capacity. Defaults to 1; mirror what the
// scene stores. Higher tiers / upgrades raise this later.
// Per-station parallel craft job capacity comes from the BUILDING_REGISTRY.
// Reading at use-time (instead of caching here) keeps the table in shared
// as the single source of truth.

// Materials consumed when tier-upping a weapon. Index by current tier
// (e.g. TIER_UP_COSTS[1] is the cost to go from T1 → T2). T4 is the
// cap; no entry there.
const TIER_UP_COSTS: Record<number, { materialId: MaterialKind; count: number }[]> = {
  1: [
    { materialId: 'alloy', count: 6 },
    { materialId: 'circuit', count: 2 },
  ],
  2: [
    { materialId: 'alloy', count: 12 },
    { materialId: 'circuit', count: 5 },
    { materialId: 'crystal', count: 1 },
  ],
  3: [
    { materialId: 'alloy', count: 24 },
    { materialId: 'circuit', count: 10 },
    { materialId: 'crystal', count: 3 },
    { materialId: 'artifact', count: 2 },
  ],
};

// Starter blueprints granted on connect / re-granted at every cycle reset.
// The artifact-trade store is the real source of new blueprints; only
// items the player should always be able to make end up here. The pistol
// is the baseline weapon every run starts with.
const STARTER_BLUEPRINTS: string[] = ['bp_pistol'];

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
  } = {
    dayDurationMs: 300_000,
    daysPerCycle: 3,
    dropItemsOnDeath: true,
  };
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

  constructor(serverId: string) {
    this.serverId = serverId;
    this.bindings = {
      connection: (id) => this.connections.get(id),
      send: (id, msg) => this.sendTo(id, msg),
      onInteractable: (id, fromSceneId, kind) =>
        this.onInteractable(id, fromSceneId, kind),
      onPlayerRespawn: (id) => this.respawnPlayerToSurface(id),
      onPowerLinkDestroyed: () => this.handlePowerLinkDestroyed(),
      isPowerOnline: () => this.powerOnline,
      isPowered: (id: string) => this.poweredBuildings.has(id),
      onBuildingsChanged: () => this.recomputePowerState(),
      dropItemsOnDeath: () => this.worldConfig.dropItemsOnDeath,
    };
    // Surface always exists so cold servers spawn enemies immediately.
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

    // Pull per-server world config + seed from the servers row.
    {
      const { data: serverRow } = await supabase
        .from('servers')
        .select('world_seed, day_duration_sec, days_per_cycle, drop_items_on_death')
        .eq('id', this.serverId)
        .maybeSingle();
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
  }

  private buildSnapshot(): WorldSnapshotV3 {
    const scenes: Record<string, SceneSnapshot> = {};
    for (const [id, scene] of this.scenes) {
      scenes[id] = scene.snapshot();
    }
    return {
      schema: WORLD_SNAPSHOT_SCHEMA,
      scenes,
      cycle: this.cycle,
      cycleStartedAt: this.cycleStartedAt,
    };
  }

  private async flushSnapshot(): Promise<void> {
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

  add(ws: WebSocket, player: Player, inventory: Inventory, equipment: Equipment): void {
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

    const sceneId = SURFACE_SCENE_ID;
    const conn: Connection = {
      ws,
      characterId: player.characterId,
      accountId: player.accountId,
      displayName: player.displayName,
      x: player.x,
      y: player.y,
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
      lastFireAt: 0,
      respawnAt: null,
      dirty: false,
      inventoryDirty: false,
      lastStaminaSentAt: 0,
      lastShieldSentAt: 0,
      lastStaminaSent: -1,
      lastShieldSent: -1,
      staminaRegenAt: 0,
      suitSpeedMult: 0,
      suitStaminaRegenBonus: 0,
      // Mild grace window so the surface stairs aren't triggered the moment
      // a returning player reconnects on top of them.
      interactCooldownUntil: Date.now() + TRANSITION_COOLDOWN_MS,
      // Alpha grant: every fresh cycle hands out the turret blueprint so
      // there's a complete crafting loop to test. Replace with the artifact
      // uplink trade store once that ships.
      knownBlueprints: new Set<string>(STARTER_BLUEPRINTS),
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
    if (conn.hp > conn.maxHp) conn.hp = conn.maxHp;
    if (conn.shield > conn.maxShield) conn.shield = conn.maxShield;
    if (conn.stamina > conn.maxStamina) conn.stamina = conn.maxStamina;

    const scene = this.requireScene(sceneId);
    scene.addMember(player.characterId);

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
      inventory,
      equipment: conn.equipment,
      hotbarSelection: conn.hotbarSelection,
      layout: scene.layout,
      knownBlueprints: mergedBlueprints(conn),
    });

    scene.broadcast(
      { type: 'player_joined', player: toPlayer(conn) },
      player.characterId
    );

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
    this.connections.delete(characterId);
    this.removeFromCurrentScene(conn);
    void this.persistConnection(conn);

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
  private respawnPlayerToSurface(characterId: string): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    conn.alive = true;
    conn.hp = conn.maxHp;
    conn.stamina = conn.maxStamina;
    conn.shield = conn.maxShield;

    // Full-loot extraction: respawning naked is the point. Inventory was
    // already cleared into a corpse on death (see Scene.killPlayer) — don't
    // refill it here.
    if (conn.sceneId === SURFACE_SCENE_ID) {
      // Already on surface (e.g. died on surface) — just teleport to the
      // entrance and broadcast a respawn event without a scene swap.
      conn.x = SURFACE_ENTRANCE_X;
      conn.y = SURFACE_ENTRANCE_Y;
      conn.dirty = true;
      const scene = this.scenes.get(SURFACE_SCENE_ID);
      scene?.broadcast({
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
    this.transition(
      characterId,
      SURFACE_SCENE_ID,
      SURFACE_ENTRANCE_X,
      SURFACE_ENTRANCE_Y
    );
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
      this.transition(
        characterId,
        SURFACE_SCENE_ID,
        SURFACE_ENTRANCE_X,
        SURFACE_ENTRANCE_Y
      );
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
    sprint: boolean
  ): void {
    const conn = this.connections.get(characterId);
    if (!conn || !conn.alive) return;
    conn.inputX = clamp(moveX, -1, 1);
    conn.inputY = clamp(moveY, -1, 1);
    conn.inputSprint = sprint;
    conn.inputAt = Date.now();
  }

  handleFire(characterId: string, dirX: number, dirY: number): void {
    const conn = this.connections.get(characterId);
    if (!conn) return;
    const scene = this.scenes.get(conn.sceneId);
    scene?.handleFire(characterId, dirX, dirY);
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
      // Each station has a parallel-slot budget. Find one with a free
      // slot; if every station of this kind nearby is saturated, reject.
      const slotsPerStation =
        buildingParallelSlots(recipe.workstation) || 1;
      for (const station of nearby) {
        let used = 0;
        for (const job of this.activeCraftJobs.values()) {
          if (job.stationBuildingId === station.id) used++;
        }
        if (used < slotsPerStation) {
          chosenStationId = station.id;
          break;
        }
      }
      if (chosenStationId === null) {
        this.sendDirect(conn.ws, {
          type: 'error',
          message: 'station_busy',
        });
        return;
      }
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

    if (isAsync) {
      // Power budget gate: a queued craft job costs 1 power for its
      // duration. Reject if it would exceed the Link's capacity.
      if (
        this.powerDraw + COMBAT.POWER_DRAW_CRAFT_JOB >
        this.powerCapacity
      ) {
        this.sendDirect(conn.ws, {
          type: 'error',
          message: 'insufficient_power',
        });
        return;
      }
    }

    // Deduct inputs.
    for (const input of recipe.inputs) {
      consumeRecipeInput(conn.inventory, input);
    }

    if (isAsync) {
      // Queue an async job. Output materializes when completesAt elapses
      // (see tickCraftJobs in the world tick loop).
      const now = Date.now();
      const jobId = `cj${this.nextCraftJobId++}`;
      const job = {
        id: jobId,
        recipeId,
        characterId,
        stationKind: recipe.workstation as
          | 'workbench'
          | 'forge'
          | 'electronics_bench'
          | 'weapon_bench',
        stationBuildingId: chosenStationId!,
        startedAt: now,
        completesAt: now + craftTimeMs,
      };
      this.activeCraftJobs.set(jobId, job);
      this.sendDirect(conn.ws, { type: 'craft_job_started', job });
      this.sendDirect(conn.ws, {
        type: 'inventory_changed',
        inventory: conn.inventory,
      });
      // Job draw counts toward capacity so subsequent power-budget
      // checks see the new total.
      this.recomputePowerState();
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
  // player's inventory and removes them from the active map.
  private tickCraftJobs(now: number): void {
    if (this.activeCraftJobs.size === 0) return;
    const finished: string[] = [];
    for (const job of this.activeCraftJobs.values()) {
      if (job.completesAt <= now) finished.push(job.id);
    }
    if (finished.length === 0) return;
    for (const jobId of finished) {
      const job = this.activeCraftJobs.get(jobId);
      if (!job) continue;
      this.activeCraftJobs.delete(jobId);
      const conn = this.connections.get(job.characterId);
      if (!conn) continue; // owner dropped — output silently lost
      const recipe = RECIPES[job.recipeId];
      if (!recipe) continue;

      // Try to deposit to the station's output buffer; fall back to
      // direct-to-inventory if the station was destroyed mid-craft or
      // its buffer is saturated. Both routes go through the shared
      // recipe-output dispatch helpers.
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
    this.recomputePowerState();
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
    if (!b || b.kind !== 'door') return;

    const tileSize = layout.tileSize;
    const cx = (b.tileX + 0.5) * tileSize;
    const cy = (b.tileY + 0.5) * tileSize;
    // Reach: ~2 tiles from the door centre. Generous so the player
    // doesn't have to wedge into a wall corner to interact.
    if (Math.hypot(conn.x - cx, conn.y - cy) > 64) return;

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

  // Player spends artifacts at an artifact_uplink to learn a blueprint.
  // Validates: player is on the surface, within range of an uplink, has
  // enough artifacts, and doesn't already know it. Consumes the artifacts
  // and adds the bp to the per-cycle known set.
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
    if (!consumeAttachment(conn.inventory, attachmentDefId, 1)) return;
    slot.weapon.pieces[pieceKind] = { id: attachmentDefId, value: def.value };
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
    if (!addAttachment(conn.inventory, existing.id, 1)) return;
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
    if (!consumeAttachment(conn.inventory, attachmentDefId, 1)) return;
    slot.weapon.mods.push({ id: attachmentDefId });
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
    if (!addAttachment(conn.inventory, mod.id, 1)) return;
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
    if (!consumeAttachment(conn.inventory, attachmentDefId, 1)) return;
    if (!part.appliedAttachments) part.appliedAttachments = [];
    part.appliedAttachments.push(attachmentDefId);
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
    const id = part.appliedAttachments[attachmentIndex];
    if (!id) return;
    if (!addAttachment(conn.inventory, id, 1)) return;
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
    if (!this.isNearWeaponBench(conn)) return;
    const slot = conn.inventory[weaponInventoryIdx];
    if (!slot || slot.kind !== 'weapon') return;
    if (slot.weapon.tier >= 4) return;
    const cost = TIER_UP_COSTS[slot.weapon.tier];
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
    // No healing if already full hp — let the player keep the medkit.
    if (def.healHp > 0 && conn.hp >= conn.maxHp) return;
    const id = consumeConsumable(conn.inventory, slot);
    if (!id) return;
    if (def.healHp > 0) {
      conn.hp = Math.min(conn.maxHp, conn.hp + def.healHp);
      conn.dirty = true;
      // The client only updates its hp readout off `player_damaged`
      // messages — without an explicit broadcast here the heal
      // happens server-side but the player sees their bar unchanged.
      // Reused message shape rather than inventing player_healed.
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

    for (const scene of this.scenes.values()) {
      scene.tick(dt, now);
    }

    // Throttled world_clock broadcast (1 Hz).
    if (now - this.lastClockBroadcastAt >= COMBAT.WORLD_CLOCK_INTERVAL_MS) {
      this.lastClockBroadcastAt = now;
      this.broadcastWorldClock(now);
    }
  }

  // Drives the day-clock + perihelion + horde state machine. Three states:
  //   - normal: counting down to perihelion. When elapsed >= cycle length,
  //     fire the horde.
  //   - hordeActive: counting down to horde end. When elapsed >= horde
  //     length, end the horde and reset the cycle clock.
  //   - (idle when no players are connected — driven by the existing idle
  //     shutdown logic; clock resumes when someone joins again.)
  private tickHordeClock(now: number): void {
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
    this.powerDraw =
      consumers.length * COMBAT.POWER_DRAW_TURRET +
      this.activeCraftJobs.size * COMBAT.POWER_DRAW_CRAFT_JOB;

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
    // their own enemies; the horde is a surface-only event.
    const surface = this.scenes.get(SURFACE_SCENE_ID);
    surface?.startHorde(this.hordeEndsAt, this.cycle);

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

    // Cycle reset: per-cycle blueprints wipe; persistent (legendary) ones
    // stay. Re-grant the alpha starter set so testing isn't dead-ended once
    // the artifact-trade store hasn't shipped yet — drop this once that does.
    for (const conn of this.connections.values()) {
      conn.knownBlueprints = new Set(STARTER_BLUEPRINTS);
      this.sendDirect(conn.ws, {
        type: 'blueprints_changed',
        knownBlueprints: mergedBlueprints(conn),
      });
    }
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
    const layout = generateFloorLayout(this.worldSeed, this.cycle, floorIndex);
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
    const scene = new Scene(
      sceneId,
      'dungeon_floor',
      this.bindings,
      layout,
      initialSpawns,
      initialLoot,
      meta.doors
    );
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
    if (!this.persistTimer) {
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

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
    hp: conn.hp,
    maxHp: conn.maxHp,
    stamina: conn.stamina,
    maxStamina: conn.maxStamina,
    shield: conn.shield,
    maxShield: conn.maxShield,
    alive: conn.alive,
  };
}

// Defensive parse — anything that doesn't match the current schema is dropped
// rather than crashing the world boot. Snapshots from older schema numbers
// silently get treated as "no snapshot" so a fresh world is built.
function parseWorldSnapshot(raw: unknown): WorldSnapshotV3 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { schema?: unknown; scenes?: unknown };
  if (r.schema !== WORLD_SNAPSHOT_SCHEMA) return null;
  if (!r.scenes || typeof r.scenes !== 'object') return null;
  // Trust the rest — we wrote it ourselves in flushSnapshot.
  return raw as WorldSnapshotV3;
}
