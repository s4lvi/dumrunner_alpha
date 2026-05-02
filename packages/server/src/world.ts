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
  addAmmo,
  addPlaceable,
  BLUEPRINT_CATALOG,
  computeSuitStats,
  consumeAmmo,
  consumeMaterial,
  countAmmo,
  countMaterial,
  RECIPES,
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
// Starter blueprints granted on connect / re-granted at every cycle reset.
// The artifact-trade store is the real source of new blueprints now;
// this list stays empty so the loop is honest. Bring entries back here
// only for testing convenience.
const STARTER_BLUEPRINTS: string[] = [];

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
  // Deepest dungeon floor any crewmate has reached this cycle. Drives the
  // surface Power Link's descent target and (Phase 3) the power capacity.
  // Resets to 1 on cycle reset OR Power Link destruction.
  private deepestFloorReached = 1;
  // Powered defences (auto-turrets) require an alive Power Link. When the
  // Link is destroyed mid-cycle this flips false; cycle reset rebuilds it.
  private powerOnline = true;
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

    // Pull world_seed from the servers row (procgen needs it).
    {
      const { data: serverRow } = await supabase
        .from('servers')
        .select('world_seed')
        .eq('id', this.serverId)
        .maybeSingle();
      const seedRaw =
        serverRow?.world_seed != null ? Number(serverRow.world_seed) : NaN;
      // Random seed if unset / invalid. Stable for the lifetime of this world.
      this.worldSeed = Number.isFinite(seedRaw)
        ? seedRaw | 0
        : Math.floor(Math.random() * 0xffffffff);
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
      // Update the depth marker if this push extends the frontier.
      if (nextFloor > this.deepestFloorReached) {
        this.deepestFloorReached = nextFloor;
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
    if (recipe.workstation !== null) {
      if (conn.sceneId !== SURFACE_SCENE_ID) return;
      const surface = this.scenes.get(SURFACE_SCENE_ID);
      if (
        !surface?.hasBuildingNearby(
          conn.x,
          conn.y,
          recipe.workstation,
          COMBAT.CRAFT_STATION_RANGE_PX
        )
      ) {
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
      if (input.kind === 'material') {
        if (countMaterial(conn.inventory, input.materialId) < input.count) return;
      } else {
        if (countAmmo(conn.inventory, input.ammoId) < input.count) return;
      }
    }
    // Deduct inputs.
    for (const input of recipe.inputs) {
      if (input.kind === 'material') {
        consumeMaterial(conn.inventory, input.materialId, input.count);
      } else {
        consumeAmmo(conn.inventory, input.ammoId, input.count);
      }
    }
    // Add output.
    const out = recipe.output;
    if (out.kind === 'placeable') {
      addPlaceable(conn.inventory, out.buildingKind, out.count);
    } else {
      addAmmo(conn.inventory, out.ammoId, out.count);
    }

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
    const cycleLengthMs = COMBAT.DAYS_PER_CYCLE * COMBAT.DAY_DURATION_MS;
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
    const cycleLengthMs = COMBAT.DAYS_PER_CYCLE * COMBAT.DAY_DURATION_MS;
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
      floorIndex
    );
    const scene = new Scene(
      sceneId,
      'dungeon_floor',
      this.bindings,
      layout,
      initialSpawns,
      initialLoot
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
