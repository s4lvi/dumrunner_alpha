// Editor sandbox runtime. One sandbox per editor connection —
// isolated single-scene, single-player environment used by the
// editor's preview pane to spawn enemies, generate floors, stamp
// rooms, and play against authored content without touching live
// game state.
//
// The sandbox is intentionally NOT a full World. It reuses the
// Scene class (so combat / AI / projectiles / hazards run the
// same code paths the live game uses) but skips all the
// persistence, perihelion, cycle, power-link, and Supabase logic.
// Connection lifecycle: editor connects → sandbox spawns →
// editor disconnects → sandbox tears down. Nothing survives.

import type { WebSocket } from 'ws';
import {
  computeSuitStats,
  emptyEquipment,
  emptyInventory,
  resizeInventory,
  INVENTORY_SIZE,
  PLAYER_BASE_STATS,
  type ClientMessage,
  type Equipment,
  type Inventory,
  type InteractableKind,
  type Player,
  type PlayerEffect,
  type ServerMessage,
} from '@dumrunner/shared';
import { COMBAT } from './combat.js';
import {
  Scene,
  type SceneBindings,
  type SceneConnection,
} from './scene.js';
import { getEnemyVisualsForWire } from './ai/templates.js';
import { getBiomesForWire } from './biomes.js';
import { getPropVisualsForWire } from './props.js';
import {
  generateFloorLayout,
  generateInitialEnemies,
  generateInitialLoot,
  generateInitialProps,
  generateLockedRoomMeta,
  generateSingleRoomFloor,
} from './procgen.js';
import { ROOMS } from './rooms.js';
import type { RoomTemplate } from '@dumrunner/shared';
import {
  buildPlaytestEquipment,
  buildPlaytestInventory,
} from './starter.js';

// Surface-style ambient floor for the sandbox: an open arena
// with no walls so spawned enemies can move freely. The Scene
// constructor accepts a null layout but several systems prefer
// a layout — we ship one with empty walkables (matching the
// live game's surface scene shape).
function makeSandboxLayout(): import('@dumrunner/shared').SceneLayout {
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

function makeSandboxConnection(
  ws: WebSocket,
  characterId: string,
  displayName: string,
  inventory: Inventory,
): SceneConnection {
  return {
    ws,
    characterId,
    displayName,
    alive: true,
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
    shield: 0,
    maxShield: 0,
    lastDamageAt: 0,
    x: 0,
    y: 0,
    inputX: 0,
    inputY: 0,
    inputAt: 0,
    inputSprint: false,
    inventory,
    equipment: emptyEquipment(),
    hotbarSelection: 0,
    dirty: false,
    inventoryDirty: false,
    lastFireAt: 0,
    reloadingUntil: 0,
    respawnAt: null,
    respawnImmunityUntil: 0,
    activeEffects: [],
    lastStaminaSentAt: 0,
    lastShieldSentAt: 0,
    lastStaminaSent: 100,
    lastShieldSent: 0,
    staminaRegenAt: 0,
    suitSpeedMult: 0,
    suitStaminaRegenBonus: 0,
    suitBuildRadiusBonus: 0,
    suitHeatResist: 0,
    suitColdResist: 0,
    suitRadiationResist: 0,
    suitToxicResist: 0,
  };
}

export class SandboxWorld {
  // Scene is mutable so sandbox_regen_floor can swap it for a
  // freshly-generated dungeon layout. Bindings are recreated
  // per-scene because they capture references to the live
  // sandbox state; conn is shared across scene swaps.
  private scene: Scene;
  private readonly conn: SceneConnection;
  private bindings: SceneBindings;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly characterId: string,
    displayName: string,
  ) {
    // Order matters: conn first, THEN bindings (which close over
    // this.conn), THEN scene (which holds the bindings). Earlier
    // ordering created bindings before conn was assigned, leaving
    // bindings.connection() returning undefined for the entire
    // session — broke spawn / movement / fire silently.
    this.conn = makeSandboxConnection(
      ws,
      characterId,
      displayName,
      emptyInventory(),
    );
    this.bindings = this.makeBindings();
    this.scene = new Scene(
      `sandbox:${characterId}`,
      'surface',
      this.bindings,
      makeSandboxLayout(),
    );
    this.scene.addMember(characterId);
  }

  // ---------- lifecycle ----------

  start(): void {
    this.sendWelcome();
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.tick(), COMBAT.TICK_MS);
  }

  destroy(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.scene.removeMember(this.characterId);
  }

  // ---------- inbound message handler ----------

  handleMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case 'sandbox_spawn_enemy': {
        console.log(
          `[sandbox] spawn_enemy ${msg.kind} at (${Math.round(msg.x)}, ${Math.round(msg.y)})`,
        );
        const ok = this.scene.spawnEnemyFromTemplate(msg.kind, msg.x, msg.y);
        if (!ok) {
          console.warn(`[sandbox] unknown enemy kind: ${msg.kind}`);
          this.sendDirect({
            type: 'error',
            message: `unknown enemy kind: ${msg.kind}`,
          });
        }
        break;
      }
      case 'sandbox_clear': {
        const scope = msg.scope ?? 'all';
        if (scope === 'enemies' || scope === 'all') {
          this.scene.clearAllEnemies();
        }
        if (scope === 'props' || scope === 'all') {
          this.scene.clearAllProps();
        }
        break;
      }
      case 'sandbox_set_loadout': {
        if (msg.kind === 'creative') {
          this.applyLoadout(buildPlaytestInventory(), buildPlaytestEquipment());
        } else {
          this.applyLoadout(emptyInventory(), emptyEquipment());
        }
        break;
      }
      case 'sandbox_regen_floor': {
        this.regenFloor(
          msg.biome,
          msg.cycle,
          msg.floorIndex,
          msg.worldSeed,
        );
        break;
      }
      case 'sandbox_stamp_room': {
        this.stampRoom(msg.templateId, msg.biome);
        break;
      }
      case 'input': {
        // Wire up movement so the editor can walk around the
        // arena and shoot at spawned enemies. Position update is
        // handled inside Scene.tick (movement integration).
        this.conn.inputX = msg.moveX;
        this.conn.inputY = msg.moveY;
        this.conn.inputAt = Date.now();
        this.conn.inputSprint = msg.sprint;
        break;
      }
      case 'fire': {
        // Route to the scene's fire handler so the editor's
        // pistol actually shoots at spawned enemies.
        this.scene.handleFire(this.characterId, msg.dirX, msg.dirY);
        break;
      }
      case 'select_hotbar': {
        // Lets the editor cycle weapons via 1..9 keys after the
        // creative loadout is applied.
        this.conn.hotbarSelection = Math.max(0, Math.min(8, msg.slot));
        break;
      }
      case 'reload_weapon': {
        this.scene.handleReloadWeapon(this.characterId);
        break;
      }
      // Other live-game messages (build, craft, equip etc.) are
      // intentionally not implemented in the first sandbox slice.
      // The editor preview can issue them later as the feature
      // set grows.
      default:
        break;
    }
  }

  // ---------- private ----------

  // Replace the editor player's inventory + equipment in place,
  // recompute suit-derived stats (HP cap, shield cap, speed mult,
  // resists), and broadcast the new state to the client. Mirrors
  // the equip/unequip path in World.recomputePlayerStats but
  // self-contained because sandbox doesn't import World.
  private applyLoadout(inventory: Inventory, equipment: Equipment): void {
    const stats = computeSuitStats(equipment);
    this.conn.maxHp = PLAYER_BASE_STATS.maxHp + stats.hpBonus;
    this.conn.maxShield = PLAYER_BASE_STATS.maxShield + stats.shieldBonus;
    this.conn.maxStamina = PLAYER_BASE_STATS.maxStamina + stats.staminaMaxBonus;
    this.conn.suitSpeedMult = stats.moveSpeedMult;
    this.conn.suitStaminaRegenBonus = stats.staminaRegenBonus;
    this.conn.suitBuildRadiusBonus = Math.floor(stats.buildRadiusBonus);
    this.conn.suitHeatResist = stats.heatResist;
    this.conn.suitColdResist = stats.coldResist;
    this.conn.suitRadiationResist = stats.radiationResist;
    this.conn.suitToxicResist = stats.toxicResist;
    // Cap current pools to the new max, then top up if loadout
    // change made them larger (creative loadout = full health).
    this.conn.hp = this.conn.maxHp;
    this.conn.shield = this.conn.maxShield;
    this.conn.stamina = this.conn.maxStamina;
    // Resize the inventory to match the cargo grid; then assign
    // slots. resizeInventory grows the array if the bonus pushes
    // total slots above INVENTORY_SIZE.
    resizeInventory(
      this.conn.inventory,
      INVENTORY_SIZE + Math.floor(stats.inventoryBonus),
    );
    // Splat the loadout into the resized inventory.
    for (let i = 0; i < this.conn.inventory.length; i++) {
      this.conn.inventory[i] = inventory[i] ?? { kind: 'empty' };
    }
    this.conn.equipment = equipment;
    // Hotbar at 0 so the first slot's weapon is active immediately.
    this.conn.hotbarSelection = 0;
    this.sendDirect({
      type: 'inventory_changed',
      inventory: this.conn.inventory,
    });
    this.sendDirect({
      type: 'equipment_changed',
      equipment: this.conn.equipment,
    });
  }

  // Build an isolated single-room scene from a room template.
  // Tile grid is the template's own bytes; anchors drive initial
  // spawns; biome supplies the tileset for rendering.
  private stampRoom(templateId: string, biomeOverride?: string): void {
    const template: RoomTemplate | undefined = ROOMS[templateId];
    if (!template) {
      this.sendDirect({
        type: 'error',
        message: `unknown room template: ${templateId}`,
      });
      return;
    }
    const biome = biomeOverride ?? template.biomeAffinity[0] ?? 'default';
    const layout = generateSingleRoomFloor(template, biome, 1);
    this.scene.removeMember(this.characterId);
    this.bindings = this.makeBindings();
    // Build initial enemy / prop / loot spawns straight from the
    // template's anchors so the preview shows authored spawns
    // exactly where they were painted. Skips procgen scatter (no
    // randomness — what you see is what shipped).
    const initialSpawns: import('./procgen.js').InitialEnemySpawn[] = [];
    const initialProps: import('./procgen.js').InitialPropSpawn[] = [];
    const initialLoot: import('./procgen.js').InitialLootDrop[] = [];
    if (layout.anchors) {
      for (const a of layout.anchors) {
        if (a.kind === 'enemy') {
          initialSpawns.push({
            templateId: a.overrideId ?? 'chaser_melee',
            x: a.x,
            y: a.y,
          });
        } else if (a.kind === 'prop') {
          initialProps.push({
            kind: a.overrideId ?? 'barrel',
            x: a.x,
            y: a.y,
          });
        } else if (a.kind === 'loot') {
          initialLoot.push({
            materialId: 'scrap',
            count: 5,
            x: a.x,
            y: a.y,
          });
        }
      }
    }
    this.scene = new Scene(
      `sandbox:${this.characterId}:room:${templateId}`,
      'dungeon_floor',
      this.bindings,
      layout,
      initialSpawns,
      initialLoot,
      [],
      initialProps,
    );
    this.scene.addMember(this.characterId);
    this.conn.x = layout.spawn.x;
    this.conn.y = layout.spawn.y;
    const wireSnap = this.scene.toWireSnapshot();
    this.sendDirect({
      type: 'scene_changed',
      sceneId: this.scene.id,
      self: this.toPlayer(),
      players: [],
      enemies: wireSnap.enemies,
      projectiles: wireSnap.projectiles,
      loot: wireSnap.loot,
      corpses: wireSnap.corpses,
      buildings: wireSnap.buildings,
      props: wireSnap.props,
      equipment: this.conn.equipment,
      layout: this.scene.layout,
    });
  }

  // Swap the sandbox's scene for a freshly-generated dungeon
  // floor. Drops the existing scene's enemies/projectiles/loot,
  // builds a new dungeon_floor Scene with procgen output, and
  // sends scene_changed so the editor renderer repaints.
  private regenFloor(
    biome: string,
    cycle: number,
    floorIndex: number,
    worldSeed: number,
  ): void {
    // Tear down the old scene (just remove member; GC handles the
    // rest since we don't hold other references).
    this.scene.removeMember(this.characterId);
    const layout = generateFloorLayout(worldSeed, cycle, floorIndex, biome);
    const meta = generateLockedRoomMeta(layout, worldSeed, cycle, floorIndex);
    const initialSpawns = generateInitialEnemies(
      layout,
      worldSeed,
      cycle,
      floorIndex,
    );
    const initialLoot = generateInitialLoot(
      layout,
      worldSeed,
      cycle,
      floorIndex,
      meta.lockedRoomIndices,
    );
    const initialProps = generateInitialProps(
      layout,
      worldSeed,
      cycle,
      floorIndex,
    );
    this.bindings = this.makeBindings();
    this.scene = new Scene(
      `sandbox:${this.characterId}:${biome}:${floorIndex}`,
      'dungeon_floor',
      this.bindings,
      layout,
      initialSpawns,
      initialLoot,
      meta.doors,
      initialProps,
    );
    this.scene.addMember(this.characterId);
    // Place the editor at the layout's spawn point so they don't
    // land in a wall.
    this.conn.x = layout.spawn.x;
    this.conn.y = layout.spawn.y;

    const wireSnap = this.scene.toWireSnapshot();
    this.sendDirect({
      type: 'scene_changed',
      sceneId: this.scene.id,
      self: this.toPlayer(),
      players: [],
      enemies: wireSnap.enemies,
      projectiles: wireSnap.projectiles,
      loot: wireSnap.loot,
      corpses: wireSnap.corpses,
      buildings: wireSnap.buildings,
      props: wireSnap.props,
      equipment: this.conn.equipment,
      layout: this.scene.layout,
    });
  }

  private tick(): void {
    const now = Date.now();
    const dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    this.scene.tick(dt, now);
  }

  private sendWelcome(): void {
    const wireSnap = this.scene.toWireSnapshot();
    this.sendDirect({
      type: 'welcome',
      sceneId: this.scene.id,
      self: this.toPlayer(),
      players: [],
      enemies: wireSnap.enemies,
      projectiles: wireSnap.projectiles,
      loot: wireSnap.loot,
      corpses: wireSnap.corpses,
      buildings: wireSnap.buildings,
      props: wireSnap.props,
      inventory: this.conn.inventory,
      equipment: this.conn.equipment,
      hotbarSelection: this.conn.hotbarSelection,
      layout: this.scene.layout,
      knownBlueprints: [],
      enemyVisuals: getEnemyVisualsForWire(),
      biomes: getBiomesForWire(),
      propVisuals: getPropVisualsForWire(),
    });
  }

  private sendDirect(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private toPlayer(): Player {
    const c = this.conn;
    return {
      characterId: c.characterId,
      accountId: 'sandbox',
      displayName: c.displayName,
      x: c.x,
      y: c.y,
      hp: c.hp,
      maxHp: c.maxHp,
      stamina: c.stamina,
      maxStamina: c.maxStamina,
      shield: c.shield,
      maxShield: c.maxShield,
      alive: c.alive,
    };
  }

  // ---------- SceneBindings implementation ----------
  // Sandbox has only one connection (the editor), no cross-scene
  // transitions, no persistence, no power, no respawn. Most
  // hooks are no-ops or constants.
  private makeBindings(): SceneBindings {
    const conn = (): SceneConnection | undefined => this.conn;
    const send = (characterId: string, msg: ServerMessage): void => {
      if (characterId !== this.characterId) return;
      this.sendDirect(msg);
    };
    return {
      connection: (id: string) => (id === this.characterId ? this.conn : undefined),
      send,
      onInteractable: (
        _characterId: string,
        _fromSceneId: string,
        _kind: InteractableKind,
      ) => {
        // Sandbox has no scene transitions; ignore.
      },
      onPlayerRespawn: (_characterId: string) => {
        // Sandbox players just respawn in place at full HP.
        if (conn()) {
          this.conn.alive = true;
          this.conn.hp = this.conn.maxHp;
          this.conn.shield = this.conn.maxShield;
          this.conn.stamina = this.conn.maxStamina;
          this.conn.respawnAt = null;
          this.conn.respawnImmunityUntil = Date.now() + 2000;
          this.sendDirect({
            type: 'player_respawned',
            characterId: this.characterId,
            x: this.conn.x,
            y: this.conn.y,
            hp: this.conn.hp,
            maxHp: this.conn.maxHp,
            stamina: this.conn.stamina,
            maxStamina: this.conn.maxStamina,
            shield: this.conn.shield,
            maxShield: this.conn.maxShield,
          });
        }
      },
      onPlayerDied: (_characterId: string, _killer: string | null) => {
        // No-op; the server's player_died broadcast still fires
        // through the scene's normal path.
      },
      onPowerLinkDestroyed: () => {
        // No power link in sandbox.
      },
      isPowerOnline: () => true,
      isPowered: (_buildingId: string) => true,
      onBuildingsChanged: () => {
        // No power state to recompute.
      },
      dropItemsOnDeath: () => false,
      applyPlayerEffect: (
        _characterId: string,
        _effect: PlayerEffect,
      ) => {
        // Skip effects in sandbox.
      },
      onPlayerEquipmentChanged: (_characterId: string) => {
        // Sandbox has no equip-driven stats path.
      },
    };
  }
}
