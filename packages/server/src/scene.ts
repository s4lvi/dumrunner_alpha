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
} from '@dumrunner/shared';
import {
  addAmmo,
  addMaterial,
  addPart,
  addPlaceable,
  addWeapon,
  consumeAmmo,
  consumePlaceable,
} from '@dumrunner/shared';
import { COMBAT } from './combat.js';
import { TEMPLATES, SURFACE_SPAWNS } from './ai/templates.js';
import {
  instantiateEnemy,
  tickEnemy,
  type AiPlayer,
} from './ai/fsm.js';
import type { EnemyRuntime } from './ai/runtime.js';
import { rollDropsForKill, killTierBiasFromHp } from './loot.js';
import { isInsideAny, segmentInsideWalkables } from '@dumrunner/shared';
import {
  type InitialEnemySpawn,
  type InitialLootDrop,
} from './procgen.js';
import type { AiEnvironment } from './ai/fsm.js';

const INTERACTABLE_RADIUS = 36;

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
  respawnAt: number | null;
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
};

const CORPSE_PICKUP_RADIUS = COMBAT.LOOT_PICKUP_RADIUS;

// HP per building kind. Material cost lives in the crafting recipes — by
// the time a player places a wall they already crafted (and consumed
// scrap for) the wall item.
const BUILDING_STATS: Record<BuildingKind, { maxHp: number }> = {
  wall: { maxHp: 200 },
  turret: { maxHp: 120 },
  workbench: { maxHp: 150 },
  forge: { maxHp: 220 },
  electronics_bench: { maxHp: 130 },
  artifact_uplink: { maxHp: 200 },
};

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
    initialLoot: InitialLootDrop[] | null = null
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
        this.buildings.set(saved.id, { ...saved, lastFireAt: 0 });
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
      (COMBAT.BUILD_RADIUS_TILES + 0.5) * tileSize;
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

    const stats = BUILDING_STATS[kind];

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
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      lastFireAt: 0,
    };
    this.buildings.set(id, building);
    this.broadcast({ type: 'building_placed', building: toBuildingState(building) });
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

    if (slot.weaponId === 'pistol') {
      this.firePistol(conn, nx, ny);
    } else if (slot.weaponId === 'knife') {
      this.swingKnife(conn, nx, ny);
    }
  }

  private firePistol(conn: SceneConnection, nx: number, ny: number): void {
    const now = Date.now();
    if (now - conn.lastFireAt < COMBAT.PISTOL_FIRE_INTERVAL_MS) return;

    // Ammo gate. No ammo, no shot.
    const ok = consumeAmmo(conn.inventory, 'pistol_basic', 1);
    if (!ok) return;
    conn.inventoryDirty = true;
    this.bindings.send(conn.characterId, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });

    conn.lastFireAt = now;
    this.spawnProjectile({
      ownerKind: 'player',
      ownerId: conn.characterId,
      fromX: conn.x,
      fromY: conn.y,
      dirX: nx,
      dirY: ny,
      speed: COMBAT.PISTOL_PROJECTILE_SPEED,
      damage: COMBAT.PISTOL_DAMAGE,
      ttlMs: COMBAT.PISTOL_PROJECTILE_TTL_MS,
      radius: COMBAT.PISTOL_PROJECTILE_RADIUS,
      color: 0xfafafa,
    });
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
    for (const b of this.buildings.values()) {
      if (b.kind !== 'turret') continue;
      if (now - b.lastFireAt < COMBAT.TURRET_FIRE_INTERVAL_MS) continue;

      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;

      let target: EnemyRuntime | null = null;
      let bestDist: number = COMBAT.TURRET_RANGE;
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
      this.spawnProjectile({
        ownerKind: 'player',
        ownerId: b.id,
        fromX: cx,
        fromY: cy,
        dirX: dx / len,
        dirY: dy / len,
        speed: COMBAT.TURRET_PROJECTILE_SPEED,
        damage: COMBAT.TURRET_DAMAGE,
        ttlMs: COMBAT.TURRET_PROJECTILE_TTL_MS,
        radius: COMBAT.TURRET_PROJECTILE_RADIUS,
        color: COMBAT.TURRET_PROJECTILE_COLOR,
      });
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
            addWeapon(closest.inventory, slot.weaponId);
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

    for (const enemy of this.enemies.values()) {
      if (!enemy.alive) continue;
      const outcome = tickEnemy(enemy, dt, now, livePlayers, env);

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
    const tileSize = this.layout?.tileSize ?? 0;
    if (tileSize <= 0) return false;
    for (const b of this.buildings.values()) {
      if (b.kind !== kind) continue;
      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;
      const halfW = (b.width * tileSize) / 2;
      const halfH = (b.height * tileSize) / 2;
      const dx = Math.max(Math.abs(px - cx) - halfW, 0);
      const dy = Math.max(Math.abs(py - cy) - halfH, 0);
      if (dx * dx + dy * dy <= rangePx * rangePx) return true;
    }
    return false;
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
      this.buildings.delete(b.id);
      this.broadcast({ type: 'building_destroyed', id: b.id });
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
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (now >= p.expiresAt) {
        this.projectiles.delete(id);
        this.broadcast({ type: 'projectile_despawned', id, reason: 'expired' });
        continue;
      }

      if (p.ownerKind === 'player') {
        let hit = false;
        for (const enemy of this.enemies.values()) {
          if (!enemy.alive) continue;
          const dx = p.x - enemy.x;
          const dy = p.y - enemy.y;
          const reach = enemy.template.radius + p.radius;
          if (dx * dx + dy * dy <= reach * reach) {
            this.damageEnemy(enemy, p.damage, now);
            this.projectiles.delete(id);
            this.broadcast({ type: 'projectile_despawned', id, reason: 'hit' });
            hit = true;
            break;
          }
        }
        if (hit) continue;
      } else {
        let hit = false;
        for (const memberId of this.members) {
          const conn = this.bindings.connection(memberId);
          if (!conn || !conn.alive) continue;
          const dx = p.x - conn.x;
          const dy = p.y - conn.y;
          const reach = COMBAT.PLAYER_RADIUS + p.radius;
          if (dx * dx + dy * dy <= reach * reach) {
            this.applyDamage(conn, p.damage, now);
            if (conn.hp <= 0) {
              this.killPlayer(conn, now);
            }
            this.projectiles.delete(id);
            this.broadcast({ type: 'projectile_despawned', id, reason: 'hit' });
            hit = true;
            break;
          }
        }
        if (hit) continue;
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

    // Material drops from the enemy's loot table — independent rolls per row.
    for (const row of enemy.template.lootTable) {
      if (Math.random() > row.chance) continue;
      const count =
        row.min + Math.floor(Math.random() * (row.max - row.min + 1));
      if (count <= 0) continue;
      const id = `lm${nextLootCounter()}`;
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

  private killPlayer(conn: SceneConnection, now: number): void {
    conn.alive = false;
    conn.respawnAt = now + COMBAT.PLAYER_RESPAWN_MS;
    this.broadcast({
      type: 'player_died',
      characterId: conn.characterId,
    });

    // Drop everything the player was carrying as a corpse at the death
    // position. The corpse persists in this scene until perihelion or until
    // someone picks it up.
    const hasAny = conn.inventory.some((s) => s.kind !== 'empty');
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
    // Reset to empty slots (preserves array length / identity).
    for (let i = 0; i < conn.inventory.length; i++) {
      conn.inventory[i] = { kind: 'empty' };
    }
    conn.inventoryDirty = true;
    this.bindings.send(conn.characterId, {
      type: 'inventory_changed',
      inventory: conn.inventory,
    });
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
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len / 16));
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

  private populateSurface(): void {
    for (const spawn of SURFACE_SPAWNS) {
      const tpl = TEMPLATES[spawn.templateId];
      if (!tpl) {
        console.warn(`[scene ${this.id}] unknown template ${spawn.templateId}`);
        continue;
      }
      const id = `e${this.nextEnemyId++}`;
      this.enemies.set(id, instantiateEnemy(id, tpl, spawn.x, spawn.y));
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
}

// ---------- helpers ----------

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
  return {
    id: b.id,
    kind: b.kind,
    tileX: b.tileX,
    tileY: b.tileY,
    width: b.width,
    height: b.height,
    hp: b.hp,
    maxHp: b.maxHp,
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
