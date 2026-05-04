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
  ProjectileOwnerKind,
  ProjectileState,
  SceneLayout,
  ServerMessage,
  WeaponFamily,
} from '@dumrunner/shared';
import {
  addAmmo,
  addAttachment,
  addConsumable,
  addInventorySlotToInventory,
  addMaterial,
  addPart,
  addPlaceable,
  addWeapon,
  buildingHordePriority,
  buildingMaxHp,
  computeWeaponEffect,
  consumeAmmo,
  consumePlaceable,
  countAmmo,
  isStationKind,
  swapSlotsBetween,
  weaponFamily,
} from '@dumrunner/shared';
import {
  COMBAT,
  MAX_INACCURACY_RAD,
  TURRET_VARIANTS,
  WEAPON_STATS,
} from './combat.js';
import { TEMPLATES, SURFACE_SPAWNS } from './ai/templates.js';
import {
  instantiateEnemy,
  tickEnemy,
  type AiPlayer,
  type AiBuildingTarget,
} from './ai/fsm.js';
import type { EnemyRuntime } from './ai/runtime.js';
import { rollDropsForKill, killTierBiasFromHp } from './loot.js';
import {
  ensureBuildingAsset,
  ensureEnemyAsset,
  ensureMaterialAsset,
} from './assetGenClient.js';
import { isInsideAny, segmentInsideWalkables } from '@dumrunner/shared';
import {
  type InitialDoor,
  type InitialEnemySpawn,
  type InitialLootDrop,
} from './procgen.js';
import type { AiEnvironment } from './ai/fsm.js';

// 60 covers diagonal approaches to a 1×1 wall-tile building (e.g. the
// Power Link): a player can't enter the tile so they stand at most
// PLAYER_RADIUS + tileSize/2 ≈ 30px away on each axis; sqrt(2)·30 ≈ 42
// at the corner, plus a safety margin so first-frame collision jitter
// doesn't cause a missed interaction.
const INTERACTABLE_RADIUS = 60;

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
  respawnAt: number | null;
  // Damage immunity window after respawn so a player doesn't get
  // re-killed by enemies clustered around the spawn point. Set in
  // World.respawnPlayerToSurface; checked in applyDamage.
  respawnImmunityUntil: number;
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
}

type ProjectileRuntime = ProjectileState & {
  expiresAt: number;
  damage: number;
  radius: number;
};

type LootRuntime = LootState & {
  expiresAt: number;
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

function emptyOutputBuffer(): import('@dumrunner/shared').InventorySlot[] {
  return Array.from({ length: STATION_OUTPUT_SLOTS }, () => ({ kind: 'empty' as const }));
}

function emptyChestBuffer(): import('@dumrunner/shared').InventorySlot[] {
  return Array.from({ length: STORAGE_CHEST_SLOTS }, () => ({
    kind: 'empty' as const,
  }));
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
  // Tracks turret ids we've already logged as "no power" so the log
  // line fires once per power-state transition rather than every
  // tick. Cleared per-id when the turret comes back online.
  private unpoweredLogged = new Set<string>();
  private nextEnemyId = 0;
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

  constructor(
    id: string,
    kind: SceneKind,
    bindings: SceneBindings,
    layout: SceneLayout | null = null,
    initialSpawns: InitialEnemySpawn[] | null = null,
    initialLoot: InitialLootDrop[] | null = null,
    initialDoors: InitialDoor[] | null = null
  ) {
    this.id = id;
    this.kind = kind;
    this.bindings = bindings;
    this.layout = layout;

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
    }
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
        // Storage chests persist contents across sessions; station
        // output buffers reset (the assumption is that whoever was
        // crafting picked up before the world idle-shut-down).
        const restoredOutput =
          saved.kind === 'storage_chest' &&
          Array.isArray(saved.output) &&
          saved.output.length > 0
            ? saved.output
            : emptyBufferForKind(saved.kind);
        this.buildings.set(saved.id, {
          ...saved,
          lastFireAt: 0,
          output: restoredOutput,
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
  }

  // ---------- wire snapshot for welcome / scene_changed ----------

  toWireSnapshot(): {
    enemies: EnemyState[];
    projectiles: ProjectileState[];
    loot: LootState[];
    corpses: CorpseState[];
    buildings: BuildingState[];
  } {
    return {
      enemies: [...this.enemies.values()].filter((e) => e.alive).map(toEnemyState),
      projectiles: [...this.projectiles.values()].map(toProjectileState),
      loot: [...this.loot.values()].map(toLootState),
      corpses: [...this.corpses.values()].map(toCorpseState),
      buildings: [...this.buildings.values()].map(toBuildingState),
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
    };
    this.buildings.set(id, building);
    this.broadcast({ type: 'building_placed', building: toBuildingState(building) });
    this.bindings.onBuildingsChanged();
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
    this.bindings.onBuildingsChanged();

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

  handleFire(characterId: string, dirX: number, dirY: number): void {
    const conn = this.bindings.connection(characterId);
    if (!conn || !conn.alive) return;

    // What's in the selected hotbar slot? Only weapons fire.
    const slot = conn.inventory[conn.hotbarSelection];
    if (!slot || slot.kind !== 'weapon') return;

    const len = Math.hypot(dirX, dirY);
    if (!Number.isFinite(len) || len < 0.001) return;
    const nx = dirX / len;
    const ny = dirY / len;

    const family = weaponFamily(slot.weapon.weaponId);
    if (family === 'melee') {
      this.swingKnife(conn, nx, ny);
    } else {
      this.fireRanged(conn, nx, ny, family);
    }
  }

  private fireRanged(
    conn: SceneConnection,
    nx: number,
    ny: number,
    family: Exclude<WeaponFamily, 'melee'>
  ): void {
    const slot = conn.inventory[conn.hotbarSelection];
    if (!slot || slot.kind !== 'weapon') return;
    const stats = WEAPON_STATS[family];
    // Mods + piece affixes on the weapon scale the base WEAPON_STATS.
    // computeWeaponEffect returns a fully-defaulted multiplier set so
    // the math below stays branch-free.
    const eff = computeWeaponEffect(slot.weapon);
    const fireInterval = stats.fireIntervalMs * eff.fireIntervalMult;
    const damage = stats.damage * eff.damageMult;
    const projectileSpeed = stats.projectileSpeed + eff.projectileSpeedAdd;
    const spreadRad = stats.spreadRad * eff.spreadMult;
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
    const family = weaponFamily(slot.weapon.weaponId);
    if (family === 'melee') return;
    const stats = WEAPON_STATS[family];
    const now = Date.now();
    if (now < conn.reloadingUntil) return; // already reloading
    const mag = slot.weapon.magazineRemaining ?? stats.magazineSize;
    if (mag >= stats.magazineSize) return; // already full
    if (countAmmo(conn.inventory, stats.ammoKind) <= 0) return;

    conn.reloadingUntil = now + stats.reloadMs;
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
      // Reload just finished — refill the equipped weapon's mag from
      // reserve. If the player swapped slots mid-reload, no-op.
      const completedAt = conn.reloadingUntil;
      conn.reloadingUntil = 0;
      const slot = conn.inventory[conn.hotbarSelection];
      if (!slot || slot.kind !== 'weapon') continue;
      const family = weaponFamily(slot.weapon.weaponId);
      if (family === 'melee') continue;
      const stats = WEAPON_STATS[family];
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
        magazineRemaining: slot.weapon.magazineRemaining,
      });
      void completedAt; // reserved for future reload telemetry
    }
  }

  private swingKnife(conn: SceneConnection, nx: number, ny: number): void {
    const now = Date.now();
    if (now - conn.lastFireAt < COMBAT.KNIFE_SWING_INTERVAL_MS) return;
    conn.lastFireAt = now;

    // Half-arc threshold via dot product. Anything in front of the player
    // and within KNIFE_RANGE takes damage.
    const halfArcRad = (COMBAT.KNIFE_ARC_DEG / 2) * (Math.PI / 180);
    const cosThreshold = Math.cos(halfArcRad);
    const reachSq = COMBAT.KNIFE_RANGE * COMBAT.KNIFE_RANGE;

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
      this.damageEnemy(enemy, COMBAT.KNIFE_DAMAGE, now);
    }

    this.broadcast({
      type: 'weapon_swung',
      characterId: conn.characterId,
      weaponId: 'knife',
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
    this.respawnDeadEntities(now);
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
  startHorde(endsAt: number, cycle: number): void {
    if (this.kind !== 'surface') return;
    this.hordeActive = true;
    this.hordeEndsAt = endsAt;
    this.hordeCycle = cycle;
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
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;

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

      if (!moving) continue;

      const baseSpeed = COMBAT.PLAYER_MOVE_SPEED * (1 + conn.suitSpeedMult);
      const speed = sprintActive
        ? baseSpeed * COMBAT.SPRINT_SPEED_MULTIPLIER
        : baseSpeed;

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

      // Wall collision: scene walkables (dungeon floors) OR player-placed
      // buildings (surface bases) act as blockers.
      if (this.hasCollisionGeometry()) {
        const fits = (x: number, y: number) =>
          this.circlePassable(x, y, COMBAT.PLAYER_RADIUS);
        if (!fits(proposedX, proposedY)) {
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

      if (proposedX === conn.x && proposedY === conn.y) continue;

      conn.x = proposedX;
      conn.y = proposedY;
      conn.dirty = true;

      this.broadcast({
        type: 'player_moved',
        characterId: conn.characterId,
        x: proposedX,
        y: proposedY,
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
      // addAttachment stacks if the same defId already exists, else takes
      // a free slot. Returns false only when the bag is completely full.
      return addAttachment(inv, s.defId, s.count);
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
      this.bindings.onBuildingsChanged();
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
      const stepX = p.vx * dt;
      const stepY = p.vy * dt;
      const newX = fromX + stepX;
      const newY = fromY + stepY;

      if (now >= p.expiresAt) {
        this.projectiles.delete(id);
        this.broadcast({ type: 'projectile_despawned', id, reason: 'expired' });
        continue;
      }

      let hit = false;
      let earliestT = 1;
      let hitAction: (() => void) | null = null;

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
            hitAction = () => this.damageEnemy(enemy, p.damage, now);
          }
        }
        // Buildings block player bullets too — doors and the player's
        // own walls should stop a round, not pass through it. Doors are
        // intentionally unbreakable so we just consume the projectile
        // without applying damage.
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
              const target = b;
              hitAction =
                target.kind === 'door'
                  ? () => {
                      /* doors absorb the round without taking damage */
                    }
                  : () => this.damageBuilding(target, p.damage, now);
            }
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
          if (t !== null && t < earliestT) {
            earliestT = t;
            hitAction = () => {
              this.applyDamage(conn, p.damage, now);
              if (conn.hp <= 0) this.killPlayer(conn, now);
            };
          }
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
              hitAction = () => this.damageBuilding(b, p.damage, now);
            }
          }
        }
      }

      if (hitAction) {
        // Land the projectile at the contact point so the despawn
        // visual is at the actual hit location.
        p.x = fromX + stepX * earliestT;
        p.y = fromY + stepY * earliestT;
        hitAction();
        this.projectiles.delete(id);
        this.broadcast({ type: 'projectile_despawned', id, reason: 'hit' });
        hit = true;
      }
      if (hit) continue;

      // No hit — commit the full step.
      p.x = newX;
      p.y = newY;
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
  spawnDroppedSlot(
    x: number,
    y: number,
    slot: import('@dumrunner/shared').InventorySlot
  ): void {
    if (slot.kind === 'empty') return;
    const id = `ld${nextLootCounter()}`;
    const lr: LootRuntime = {
      id,
      content: { kind: 'slot', slot },
      x: x + (Math.random() - 0.5) * 16,
      y: y + (Math.random() - 0.5) * 16,
      expiresAt: Date.now() + COMBAT.LOOT_TTL_MS,
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

  private killPlayer(conn: SceneConnection, now: number): void {
    conn.alive = false;
    conn.respawnAt = now + COMBAT.PLAYER_RESPAWN_MS;
    this.broadcast({
      type: 'player_died',
      characterId: conn.characterId,
    });
    // Server-wide system chat line. Killer attribution would need
    // damage source plumbing through projectile/melee paths — leave
    // null for now and let the chat just say "X died".
    this.bindings.onPlayerDied(conn.characterId, null);

    // Drop the player's bag contents to a corpse at the death position.
    // EQUIPPED gear (chassis / plating / life-support / utility / cargo
    // grid) intentionally stays on the player — it's "what you're
    // wearing." Only loose inventory + ammo + materials goes to the
    // corpse. The corpse persists in this scene until perihelion or
    // until someone picks it up.
    //
    // Per-server world rule `dropItemsOnDeath` lets the owner switch off
    // full-loot — when false, the bag stays with the player too.
    const dropItems = this.bindings.dropItemsOnDeath();
    const hasAny = dropItems && conn.inventory.some((s) => s.kind !== 'empty');
    if (hasAny) {
      const corpseId = `c${this.nextCorpseId++}`;
      const corpse: CorpseRuntime = {
        id: corpseId,
        ownerCharacterId: conn.characterId,
        ownerDisplayName: conn.displayName,
        x: conn.x,
        y: conn.y,
        // Deep-copy the slots — the player's array is about to be reset.
        inventory: conn.inventory.map((s) => ({ ...s })),
      };
      this.corpses.set(corpseId, corpse);
      this.broadcast({ type: 'corpse_spawned', corpse: toCorpseState(corpse) });
    }
    // Only wipe the bag if items actually dropped. With dropItemsOnDeath
    // off, the player keeps everything across the death/respawn.
    if (dropItems) {
      for (let i = 0; i < conn.inventory.length; i++) {
        conn.inventory[i] = { kind: 'empty' };
      }
      conn.inventoryDirty = true;
      this.bindings.send(conn.characterId, {
        type: 'inventory_changed',
        inventory: conn.inventory,
      });
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

  // Single-point passability: inside walkables (if any) AND not inside any
  // building footprint.
  private pointPassable(x: number, y: number): boolean {
    const walkables = this.layout?.walkables ?? [];
    if (walkables.length > 0 && !isInsideAny(walkables, x, y)) return false;
    if (this.isPointInAnyBuilding(x, y)) return false;
    return true;
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

  // Segment passability for LoS: stays inside walkables AND doesn't pass
  // through any building tile. Sampled at the same step as
  // segmentInsideWalkables.
  private segmentClear(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): boolean {
    const walkables = this.layout?.walkables ?? [];
    if (walkables.length > 0 && !segmentInsideWalkables(walkables, x1, y1, x2, y2)) {
      return false;
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

  private isPointInAnyBuilding(x: number, y: number): boolean {
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return false;
    for (const b of this.buildings.values()) {
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
    this.bindings.onBuildingsChanged();
    return building;
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
    return true;
  }

  // Look up a building by id (for World callbacks that need to inspect
  // the live state, e.g. checking whether the Power Link is still alive).
  getBuilding(id: string): BuildingState | null {
    const b = this.buildings.get(id);
    return b ? { ...b } : null;
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
  }): void {
    const id = `p${this.nextProjectileId++}`;
    const proj: ProjectileRuntime = {
      id,
      ownerCharacterId: args.ownerId,
      ownerKind: args.ownerKind,
      x: args.fromX,
      y: args.fromY,
      vx: args.dirX * args.speed,
      vy: args.dirY * args.speed,
      color: args.color,
      expiresAt: Date.now() + args.ttlMs,
      damage: args.damage,
      radius: args.radius,
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
  // Per-server world rule: true = bag drops as a corpse on death (full-
  // loot mode), false = bag stays with the player on respawn. Equipped
  // suit gear stays in either case.
  dropItemsOnDeath(): boolean;
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

function toBuildingState(b: BuildingRuntime): BuildingState {
  // Output is only sent on the wire when it has any non-empty slot —
  // saves bytes for non-station buildings and stations with empty
  // buffers. Client treats undefined as "no output to render."
  const hasOutput = b.output.some((s) => s.kind !== 'empty');
  return {
    id: b.id,
    kind: b.kind,
    tileX: b.tileX,
    tileY: b.tileY,
    width: b.width,
    height: b.height,
    hp: b.hp,
    maxHp: b.maxHp,
    ...(hasOutput ? { output: b.output.map((s) => ({ ...s })) } : {}),
  };
}

function toProjectileState(p: ProjectileRuntime): ProjectileState {
  return {
    id: p.id,
    ownerCharacterId: p.ownerCharacterId,
    ownerKind: p.ownerKind,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    color: p.color,
  };
}
