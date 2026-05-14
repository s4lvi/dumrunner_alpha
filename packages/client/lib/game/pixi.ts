"use client";

import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  type Texture,
} from "pixi.js";
import { buildingsToMinimapList, type MinimapSnapshot } from './minimap';
import { subscribe as subscribeOverrides } from '../textureOverrides';
import {
  circleFits,
  decodeTileGrid,
  enemyVisualFor,
  INTERACTABLE_RADIUS,
  isInsideAny,
  isWalkableTileId,
  materialTint,
  segmentInsideWalkables,
  TIER_COLORS_NUM,
  type BuildingKind,
  type PlaceableBuildingKind,
  type BuildingState,
  type CorpseState,
  type EnemyState,
  type EnemyVisual,
  type Interactable,
  type LootState,
  type Player,
  type Rect,
  type SceneLayout,
  type ProjectileState,
  type PropState,
} from "@dumrunner/shared";

// Must match server: COMBAT.PLAYER_RADIUS in packages/server/src/combat.ts.
// Used for client-side collision so prediction matches server simulation.
const PLAYER_RADIUS = 14;

// Must match server: COMBAT.BUILD_RADIUS_TILES.
const BUILD_RADIUS_TILES = 3;


export type GameInit = {
  // Initial scene this renderer is mounted into. Used as the cache
  // key for per-scene state (e.g. minimap fog) so re-entering a
  // previously-visited scene can restore prior data instead of
  // wiping it on every transition.
  sceneId: string;
  self: Player;
  others: Player[];
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  loot: LootState[];
  corpses: CorpseState[];
  buildings: BuildingState[];
  props: PropState[];
  layout: SceneLayout | null;
  // Movement intent vector (-1..1 per axis) + sprint flag. Sent at network
  // tick rate; the server is authoritative.
  sendInput: (moveX: number, moveY: number, sprint: boolean) => void;
  sendFire: (dirX: number, dirY: number) => void;
  sendBuild: (
    kind: PlaceableBuildingKind,
    tileX: number,
    tileY: number,
  ) => void;
  sendDemolish: (buildingId: string) => void;
  // Called whenever the nearest in-range interactable changes (or becomes
  // null). The host UI renders the "Press E to …" prompt off this.
  onNearInteractableChanged: (
    near: { id: string; label: string } | null,
  ) => void;
  // Called whenever the set of workstation building kinds the player is
  // standing within crafting range of changes. `all` drives recipe
  // enable/disable; `nearest` drives the "Press E — <station>" prompt
  // and the E-key target. `nearestDoorId` is the id of the closest
  // dungeon door in range (for the open-door prompt) — null when none.
  onNearWorkstationsChanged: (state: {
    all: BuildingKind[];
    nearest: BuildingKind | null;
    nearestDoorId: string | null;
    // Kind of the nearest door (drives prompt copy: locked dungeon
    // doors say "costs 1 key", player-built wall_doors say "Open"
    // or "Close"). Null when no door in range.
    nearestDoorKind: 'door' | 'wall_door' | null;
    // For wall_doors, the open/closed state. Undefined for the
    // dungeon `door` kind (always closed when present).
    nearestDoorOpen: boolean;
    nearestChestId: string | null;
    // E5: nearest container prop in interact range, or null. Drives
    // the "Open — Container" prompt and the E-key target route.
    nearestContainerId: string | null;
    // Highest-tier weapon bench in range. 0 if no bench in range.
    // Mirrors the server's nearestWeaponBenchTier check so the
    // assembly UI can grey out weapons above this tier.
    weaponBenchTier: number;
    // Ids of every weapon bench in range, with their tiers. The
    // upgrade-apply right-click flow uses this to find a bench
    // matching the upgrade's targetTier - 1 (mk2 upgrade → Mk1
    // bench). Renderer pushes all in-range benches; the parent
    // picks one by tier when an upgrade is applied.
    weaponBenches: { id: string; tier: number }[];
  }) => void;
  // Optional asset_gen-backed sprite resolver. Renderer asks the host
  // for a PNG url keyed by enemy template id; returning null falls back
  // to the procedural shape. Stays optional so the game runs cleanly
  // without an asset_gen service.
  getEnemyTexture?: (kind: string) => string | null;
  // Optional iso/top-down palette override. Each field is a hex
  // string ("#RRGGBB"); the renderer parses to numeric. Used by
  // /editor/biomes preview to render a biome in its own colours.
  // When omitted the renderer keeps its built-in dark palette.
  palette?: {
    floor?: string;
    wallTop?: string;
    wallFront?: string;
  };
};

// Subset of state we need to apply when the player transitions between scenes
// (server message scene_changed). Same shape as the welcome scene fields.
// sceneId is included so renderers can key per-scene state (e.g. minimap fog)
// against it — re-entering a previously-visited scene restores prior data.
export type SceneState = {
  sceneId: string;
  self: Player;
  players: Player[];
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  loot: LootState[];
  corpses: CorpseState[];
  buildings: BuildingState[];
  props: PropState[];
  layout: SceneLayout | null;
};

export type GameHandle = {
  upsertPlayer(p: Player): void;
  removePlayer(characterId: string): void;
  movePlayer(characterId: string, x: number, y: number): void;
  setPlayerHp(
    characterId: string,
    hp: number,
    maxHp: number,
    shield?: number,
    maxShield?: number,
  ): void;
  setPlayerDead(characterId: string): void;
  respawnPlayer(
    characterId: string,
    x: number,
    y: number,
    hp: number,
    maxHp: number,
    stamina?: number,
    maxStamina?: number,
    shield?: number,
    maxShield?: number,
  ): void;
  showWeaponSwung(
    characterId: string,
    weaponId: string,
    dirX: number,
    dirY: number,
  ): void;
  upsertEnemy(e: EnemyState): void;
  setEnemyPosition(id: string, x: number, y: number): void;
  setEnemyHp(id: string, hp: number, maxHp: number): void;
  removeEnemy(id: string): void;
  spawnProjectile(p: ProjectileState): void;
  despawnProjectile(id: string): void;
  spawnLoot(l: LootState): void;
  despawnLoot(id: string): void;
  spawnCorpse(c: CorpseState): void;
  removeCorpse(id: string): void;
  spawnBuilding(b: BuildingState): void;
  setBuildingHp(id: string, hp: number, maxHp: number): void;
  removeBuilding(id: string): void;
  spawnProp(p: PropState): void;
  setPropHp(id: string, hp: number, maxHp: number): void;
  removeProp(id: string): void;
  // E5: prop_changed updates an existing prop's wire state
  // (typically opened/hasItems for container props). Topdown +
  // pixi renderers stub this; FPS reindexes the tile lookup.
  changeProp(p: PropState): void;
  // Pass a BuildingKind to enter build mode placing that kind, or null to
  // exit. Build mode also requires the current scene to be the surface;
  // pixi enforces that via the layout.tileSize > 0 + sceneId check.
  setBuildMode(kind: PlaceableBuildingKind | null): void;
  // Suit-derived build-radius bonus (in whole tiles) for the local
  // player. Renderer uses this when sizing the build-mode ring and
  // checking placement validity. Server applies the same bonus
  // server-side, so the ghost matches what's actually allowed.
  setBuildRadiusBonus(tiles: number): void;
  // The currently-equipped weapon (selected hotbar slot if it's a weapon),
  // or null. Pixi gates fire/swing visuals + outbound fire messages on this.
  setEquippedWeapon(weaponId: import('@dumrunner/shared').WeaponKind | null): void;
  // Animation Phase C: push reload-start into the renderer so it
  // can drive the view-model's reload animation. Fire is handled
  // locally in the FPS renderer via the projectile_spawned hook;
  // reload-start lives at the Game.tsx ws layer (we receive the
  // reload_started message there) and is forwarded through this
  // method. Other renderers no-op.
  notifyReloadStarted(durationMs: number): void;
  // Horde-active flag, driven by the world_clock subscription in Game.tsx.
  // FPS uses this to swap the surface skybox between normal and
  // perihelion variants. Other renderers can no-op.
  setHordeActive(active: boolean): void;
  swapScene(state: SceneState): void;
  // Snapshot of the renderer's current scene state. Used by the host to
  // hot-swap renderers (FPS ↔ top-down) without losing position / entities.
  currentSceneState(): SceneState;
  // Other players within `radiusPx` of the local player, sorted by
  // distance. Used by the inventory slot menu to populate a "Give
  // to…" submenu without the host needing to track positions itself.
  nearbyPlayers(radiusPx: number): {
    characterId: string;
    displayName: string;
  }[];
  // Renderer-agnostic snapshot consumed by the React Minimap
  // component (see lib/game/minimap.ts). Visibility flags reflect
  // each renderer's LOS / fog state at the time of the call.
  getMinimapSnapshot(): MinimapSnapshot;
  // Current self position. The React HazardHUD polls this to map
  // the player's tile to a HazardZoneCategory using `categoryAt`.
  // Returns null before the first scene state is hydrated.
  getSelfPosition(): { x: number; y: number } | null;
  destroy(): void;
};

// Re-export shared part-tier colors for any external pixi.ts imports.
// New code should import directly from @dumrunner/shared.
export { TIER_COLORS_NUM as TIER_COLORS } from "@dumrunner/shared";
export { TIER_COLORS_NUM };

// Room floor palette. One entry per "theme bucket"; rooms hash to a
// bucket via their xy origin so the same room always reads the same
// way. Kept dark enough to feel "alien architecture" but tuned for
// visible contrast across rooms — earlier subtler palette was hard to
// read against the neutral floor.
const ROOM_FLOOR_PALETTE: number[] = [
  0x2c2530, // dusty plum
  0x1d2c3a, // slate-blue
  0x2e2a1c, // sand-brown
  0x1e3328, // moss-green
  0x3a2126, // rust
  0x1f3536, // teal
  0x3a2d1c, // amber
  0x2a1e2e, // wine
];

function roomFloorColor(r: Rect): number {
  // Cheap deterministic mix on the room's tile-aligned origin.
  const h =
    (Math.imul(r.x | 0, 0x85ebca6b) ^ Math.imul(r.y | 0, 0xc2b2ae35)) >>> 0;
  return ROOM_FLOOR_PALETTE[h % ROOM_FLOOR_PALETTE.length];
}

// Per-material color, per-tier color, and enemy visuals all come from
// shared so the FPS view + this top-down view + the inventory UI never
// drift. The `materialTint`, `enemyVisualFor`, and `EnemyVisual` types
// come from @dumrunner/shared/visuals.
const visualFor = enemyVisualFor;

const SELF_COLOR = 0xf97316; // dûm orange
const OTHER_COLOR = 0x4dd0e1;
const DEAD_COLOR = 0x444444;
const PROJECTILE_COLOR = 0xfafafa;
const MOVE_SPEED = 140; // px/sec — must match COMBAT.PLAYER_MOVE_SPEED
const NETWORK_TICK_HZ = 20;

type RenderedPlayer = {
  data: Player;
  container: Container;
  hpFill: Graphics;
  // For remote players: linear interpolation target.
  targetX: number;
  targetY: number;
};

type RenderedEnemy = {
  data: EnemyState;
  container: Container;
  hpFill: Graphics;
  // Interpolation target for smooth motion between enemy_state broadcasts.
  targetX: number;
  targetY: number;
  // Hit-flash overlay (alpha-tweened white square / circle covering the body).
  flashOverlay: Graphics;
  flashUntil: number;
  // The procedural shape, kept around so we can hide it once the AI
  // sprite finishes async-loading (and re-show it if the load fails).
  body: Graphics;
  // Optional AI-generated sprite. Loaded async on first sight of this
  // enemy kind; texture swaps in when ready.
  sprite?: Sprite;
};

type RenderedProjectile = {
  data: ProjectileState;
  graphic: Graphics;
  // Spawn time (perf.now()) for client-side extrapolation.
  spawnedAt: number;
};

type RenderedLoot = {
  data: LootState;
  container: Container;
  // perf.now() at spawn — used for the gentle bob animation.
  spawnedAt: number;
};

type RenderedCorpse = {
  data: CorpseState;
  container: Container;
};

type RenderedBuilding = {
  data: BuildingState;
  container: Container;
  hpFill: Graphics;
};

type RenderedProp = {
  data: PropState;
  container: Container;
  flashOverlay: Graphics;
  flashUntil: number;
};

export function runGame(host: HTMLElement, init: GameInit): GameHandle {
  const app = new Application();
  let initialized = false;
  let destroyed = false;

  // Operations called via the GameHandle before Pixi's async init resolves are
  // queued here and flushed once initialization completes. Cheaper and more
  // predictable than a per-call microtask retry.
  const pendingOps: (() => void)[] = [];
  function ifReady(op: () => void): void {
    if (destroyed) return;
    if (initialized) op();
    else pendingOps.push(op);
  }

  const players = new Map<string, RenderedPlayer>();
  const enemies = new Map<string, RenderedEnemy>();
  const projectiles = new Map<string, RenderedProjectile>();
  const loot = new Map<string, RenderedLoot>();
  const corpses = new Map<string, RenderedCorpse>();
  const buildings = new Map<string, RenderedBuilding>();
  const props = new Map<string, RenderedProp>();

  const world = new Container();
  const layoutLayer = new Container(); // floor / walkable rects
  const buildingsLayer = new Container(); // walls, turrets, etc.
  const lootLayer = new Container();
  const interactablesLayer = new Container(); // stairs, extract pads
  const enemiesLayer = new Container();
  const playersLayer = new Container();
  const projectilesLayer = new Container();
  const fogLayer = new Container(); // light/shadow over everything
  const fxLayer = new Container(); // particles, damage numbers
  const buildGhost = new Container(); // ghost preview during build mode
  const ui = new Container(); // screen-space overlay
  const fogGraphics = new Graphics();
  fogLayer.addChild(fogGraphics);

  // Self-position. We predict optimistically from local input for instant
  // feel, while the server is authoritative — server position updates flow in
  // via player_moved and we smoothly reconcile against them. A hard snap
  // catches large divergences (likely warp/desync).
  let selfX = init.self.x;
  let selfY = init.self.y;
  let serverSelfX = init.self.x;
  let serverSelfY = init.self.y;
  let selfAlive = init.self.alive;
  // selfHp / selfShield / selfStamina were previously kept in the
  // renderer to drive the on-screen HP/Shield/Stamina bars. The
  // bars now live in React (HudOverlay in Game.tsx), so these are
  // gone — Game.tsx owns that state via player_damaged /
  // player_stamina / player_respawned message handlers.
  // Last input sent to the server. Re-sent on change or every NETWORK_TICK_HZ.
  let lastSentInputX = 0;
  let lastSentInputY = 0;
  let lastSentSprint = false;
  let lastSentAt = 0;

  const RECONCILE_LERP_PER_SEC = 8; // smoothing rate toward server position
  const RECONCILE_SNAP_THRESHOLD = 120; // px — beyond this, hard-snap to server

  // Camera shake (epoch ms).
  let shakeUntil = 0;
  let shakeMag = 0;
  const SHAKE_DURATION_MS = 180;

  // Active scene layout. Drives wall rendering and visual line-of-sight.
  // Updated on init (welcome) and on swapScene (scene_changed).
  let currentLayout: SceneLayout | null = init.layout;
  let currentSceneId: string = init.sceneId;
  // Versions used by the fog cache. Bump these whenever the underlying
  // data the fog scan reads changes.
  let layoutVersion = 0;
  let buildingsVersion = 0;

  // Generic particle list (damage numbers, death bursts, muzzle flashes).
  type Particle = {
    obj: Container;
    vx: number;
    vy: number;
    life: number; // ms
    age: number; // ms
    fadeOut: boolean;
    rise?: boolean; // damage numbers float up while fading
  };
  const particles: Particle[] = [];

  // Last-seen self HP/shield, used purely for damage-drop detection
  // (screen shake + floating damage number on hit). The actual HUD
  // bars are rendered by React via HudOverlay in Game.tsx.
  let lastSelfHp = init.self.hp;
  let lastSelfShield = init.self.shield;

  // Input state.
  const keys = new Set<string>();
  let mouseScreenX = 0;
  let mouseScreenY = 0;
  let mouseDown = false;
  // Active placeable kind, or null when build mode is off. Driven externally
  // by Game.tsx (based on the selected hotbar slot + current scene).
  let buildKind: PlaceableBuildingKind | null = null;
  let buildRadiusBonus = 0;
  // Currently equipped weapon (or null when no weapon is selected). Driven
  // externally; gates fire/swing locally so we don't show animation for
  // clicks the server will reject.
  let equippedWeapon: import('@dumrunner/shared').WeaponKind | null =
    null;
  let pendingBuildAction: "place" | "demolish" | null = null;

  // While focus is in a chat input / textarea, suppress movement key
  // capture so the player's typing doesn't drive the character.
  function isFormFocus(): boolean {
    const ae = document.activeElement;
    return ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement;
  }
  function onKeyDown(e: KeyboardEvent) {
    if (isFormFocus()) return;
    const k = e.key.toLowerCase();
    keys.add(k);
    // Build mode is now driven by the selected hotbar slot, not a key
    // toggle. Escape just stops continuous fire if any.
    if (k === "escape") mouseDown = false;
  }
  function onKeyUp(e: KeyboardEvent) {
    if (isFormFocus()) return;
    keys.delete(e.key.toLowerCase());
  }
  function onMouseMove(e: MouseEvent) {
    const rect = (app.canvas as HTMLCanvasElement).getBoundingClientRect();
    mouseScreenX = e.clientX - rect.left;
    mouseScreenY = e.clientY - rect.top;
  }
  function onMouseDown(e: MouseEvent) {
    onMouseMove(e);
    if (buildKind !== null) {
      // In build mode the canvas is for placing/demolishing only.
      if (e.button === 0) pendingBuildAction = "place";
      else if (e.button === 2) pendingBuildAction = "demolish";
      return;
    }
    if (e.button !== 0) return;
    mouseDown = true;
  }
  function onMouseUp(e: MouseEvent) {
    if (e.button !== 0) return;
    mouseDown = false;
  }
  function onContextMenu(e: MouseEvent) {
    // We use right-click for demolish in build mode; suppress the OS menu.
    e.preventDefault();
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mouseup", onMouseUp);

  void app
    .init({
      background: "#0b0d10",
      resizeTo: host,
      antialias: true,
    })
    .then(() => {
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }
      initialized = true;

      host.appendChild(app.canvas);
      const canvas = app.canvas as HTMLCanvasElement;
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.cursor = "crosshair";
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("contextmenu", onContextMenu);

      world.addChild(layoutLayer);
      world.addChild(buildingsLayer);
      world.addChild(lootLayer);
      world.addChild(interactablesLayer);
      world.addChild(enemiesLayer);
      world.addChild(playersLayer);
      world.addChild(projectilesLayer);
      world.addChild(buildGhost);
      world.addChild(fogLayer);
      world.addChild(fxLayer);
      app.stage.addChild(world);
      app.stage.addChild(ui);

      // Initial scene render.
      renderLayout(init.layout);

      addOrUpdatePlayer(init.self, true);
      for (const o of init.others) addOrUpdatePlayer(o, false);
      for (const e of init.enemies) addOrUpdateEnemy(e);
      for (const p of init.projectiles) addProjectile(p);
      for (const l of init.loot) addLoot(l);
      for (const c of init.corpses) addCorpse(c);
      for (const b of init.buildings) addBuilding(b);
      for (const p of init.props) addProp(p);

      // Drain any handle calls that arrived before init resolved.
      const queued = pendingOps.splice(0, pendingOps.length);
      for (const op of queued) op();

      centerCamera();

      app.ticker.add(({ deltaMS }) => {
        if (destroyed) return;
        tick(deltaMS / 1000);
      });
    });

  function tick(dt: number) {
    // Read raw input axes from held keys. -1..1 per axis.
    let inputX = 0;
    let inputY = 0;
    if (keys.has("w") || keys.has("arrowup")) inputY -= 1;
    if (keys.has("s") || keys.has("arrowdown")) inputY += 1;
    if (keys.has("a") || keys.has("arrowleft")) inputX -= 1;
    if (keys.has("d") || keys.has("arrowright")) inputX += 1;

    if (selfAlive) {
      // Local prediction: apply normalised input vector at the same speed the
      // server uses, then run the same wall-collision check the server runs
      // so we don't predict past walls. Server reconciliation handles any
      // small residual drift.
      if (inputX !== 0 || inputY !== 0) {
        const len = Math.hypot(inputX, inputY);
        const stepX = (inputX / len) * MOVE_SPEED * dt;
        const stepY = (inputY / len) * MOVE_SPEED * dt;
        let proposedX = selfX + stepX;
        let proposedY = selfY + stepY;

        const walls = currentLayout?.walkables;
        if (walls && walls.length > 0) {
          const fits = (x: number, y: number) =>
            circleFits(walls, x, y, PLAYER_RADIUS);
          if (!fits(proposedX, proposedY)) {
            const xOnly = fits(proposedX, selfY);
            const yOnly = fits(selfX, proposedY);
            if (xOnly) proposedY = selfY;
            else if (yOnly) proposedX = selfX;
            else {
              proposedX = selfX;
              proposedY = selfY;
            }
          }
        }
        selfX = proposedX;
        selfY = proposedY;
      }

      // Soft reconciliation toward the server's authoritative position.
      const dxs = serverSelfX - selfX;
      const dys = serverSelfY - selfY;
      const distSq = dxs * dxs + dys * dys;
      if (distSq > RECONCILE_SNAP_THRESHOLD * RECONCILE_SNAP_THRESHOLD) {
        selfX = serverSelfX;
        selfY = serverSelfY;
      } else {
        const lerp = Math.min(1, dt * RECONCILE_LERP_PER_SEC);
        selfX += dxs * lerp;
        selfY += dys * lerp;
      }

      // Firing (held button = continuous fire). Disabled in build mode
      // — clicks place/demolish buildings instead. Also gated on having
      // a weapon selected; otherwise the click is a no-op.
      //
      // We send every frame and let the server enforce per-weapon
      // timing (mag, reload, fire interval). Any client-side throttle
      // would cap weapons whose real fire rate is faster than the
      // throttle, making firing rate view-dependent. Matches fps.ts.
      //
      // The muzzle flash is NOT triggered here. It's driven off the
      // server's projectile_spawned event for the local player so the
      // visual cadence matches the actual fire rate.
      if (mouseDown && buildKind === null && equippedWeapon !== null) {
        const aim = mouseToWorld();
        const fdx = aim.x - selfX;
        const fdy = aim.y - selfY;
        if (Math.hypot(fdx, fdy) > 1) {
          init.sendFire(fdx, fdy);
        }
      }
    }

    // Build mode: position the ghost preview at the hovered tile and resolve
    // any pending click action against that tile.
    updateBuildMode();

    // Nearest in-range interactable — drives the "Press E to …" prompt.
    updateNearInteractable();

    // Workstation proximity — drives the crafting panel's enable/disable.
    updateNearWorkstations();

    // Update self render.
    const selfP = players.get(init.self.characterId);
    if (selfP) {
      selfP.data.x = selfX;
      selfP.data.y = selfY;
      selfP.container.position.set(selfX, selfY);
      selfP.container.alpha = selfAlive ? 1 : 0.35;
    }

    // Interpolate remote players and enemies toward their last broadcast
    // pos. Two important rules:
    //  - Always lerp, even when container.visible is false. Skipping hidden
    //    entities used to freeze data.x/y at a stale value, which the
    //    visibility scan then read in the next frame — keeping the entity
    //    hidden indefinitely while the server kept moving it. Coming back
    //    into LoS produced a visible rubber-band as the lerp finally
    //    caught up.
    //  - On large server-to-render deltas (>SNAP_DIST_PX) snap instead of
    //    lerping. This avoids the slow slide when the server has moved an
    //    entity far in one or two ticks (e.g. a hidden enemy aggro'd and
    //    chased the player around a corner before any frames showed it).
    const lerp = Math.min(1, dt * 12);
    const SNAP_DIST_PX = 80;
    const snapDsq = SNAP_DIST_PX * SNAP_DIST_PX;
    for (const [id, p] of players) {
      if (id === init.self.characterId) continue;
      const dx = p.targetX - p.data.x;
      const dy = p.targetY - p.data.y;
      if (dx * dx + dy * dy > snapDsq) {
        p.data.x = p.targetX;
        p.data.y = p.targetY;
      } else {
        p.data.x += dx * lerp;
        p.data.y += dy * lerp;
      }
      p.container.position.set(p.data.x, p.data.y);
    }
    for (const e of enemies.values()) {
      const dx = e.targetX - e.data.x;
      const dy = e.targetY - e.data.y;
      if (dx * dx + dy * dy > snapDsq) {
        e.data.x = e.targetX;
        e.data.y = e.targetY;
      } else {
        e.data.x += dx * lerp;
        e.data.y += dy * lerp;
      }
      e.container.position.set(e.data.x, e.data.y);
    }

    // Extrapolate projectiles client-side from spawn time.
    const now = performance.now();
    for (const p of projectiles.values()) {
      const elapsed = (now - p.spawnedAt) / 1000;
      const x = p.data.x + p.data.vx * elapsed;
      const y = p.data.y + p.data.vy * elapsed;
      p.graphic.position.set(x, y);
    }

    // Loot bob: a small vertical sine on the y so dropped parts attract the eye.
    for (const l of loot.values()) {
      const t = (now - l.spawnedAt) / 1000;
      l.container.position.y = l.data.y + Math.sin(t * 4) * 2;
      l.container.rotation = Math.sin(t * 2) * 0.2;
    }

    // Interactables pulse gently so they read as something to interact with.
    for (const it of interactables.values()) {
      const t = (now - it.spawnedAt) / 1000;
      const pulse = 1 + Math.sin(t * 2.5) * 0.08;
      it.container.scale.set(pulse, pulse);
    }

    // Visual line-of-sight: in scenes with walls, hide remote entities the
    // player can't see. Self is always visible. Surface skips this entirely.
    applyLineOfSight();

    // Fog of war / light cone — darkens everything outside the player's
    // visible region, leaving the seen tiles at full brightness. Updated
    // every frame so movement reveals new areas smoothly.
    updateFog();

    // Particles (damage numbers, bursts, flashes).
    tickParticles(dt);

    // Enemy hit-flash decay: alpha drops over the flash duration.
    for (const e of enemies.values()) {
      if (e.flashUntil <= 0) continue;
      const remaining = e.flashUntil - now;
      if (remaining <= 0) {
        e.flashOverlay.alpha = 0;
        e.flashUntil = 0;
      } else {
        e.flashOverlay.alpha = Math.min(0.7, (remaining / 120) * 0.7);
      }
    }
    // Prop hit-flash decay — same shape as enemies'.
    for (const rp of props.values()) {
      if (rp.flashUntil <= 0) continue;
      const remaining = rp.flashUntil - now;
      if (remaining <= 0) {
        rp.flashOverlay.alpha = 0;
        rp.flashUntil = 0;
      } else {
        rp.flashOverlay.alpha = Math.min(0.7, (remaining / 120) * 0.7);
      }
    }

    centerCamera();

    // Outbound input. Send on input-change immediately so key releases reach
    // the server fast; otherwise heartbeat at NETWORK_TICK_HZ. Once dead, we
    // send a single zero so the server stops the body in place.
    const minDelta = 1000 / NETWORK_TICK_HZ;
    const sx = selfAlive ? inputX : 0;
    const sy = selfAlive ? inputY : 0;
    const sprint =
      selfAlive &&
      (keys.has("shift") || keys.has("shiftleft") || keys.has("shiftright"));
    const changed =
      sx !== lastSentInputX ||
      sy !== lastSentInputY ||
      sprint !== lastSentSprint;
    if (changed || now - lastSentAt >= minDelta) {
      init.sendInput(sx, sy, sprint);
      lastSentInputX = sx;
      lastSentInputY = sy;
      lastSentSprint = sprint;
      lastSentAt = now;
    }

  }

  function mouseToWorld(): { x: number; y: number } {
    // Convert screen-space mouse to world-space using current camera.
    return {
      x: mouseScreenX - world.position.x,
      y: mouseScreenY - world.position.y,
    };
  }

  function centerCamera() {
    const w = app.renderer.width;
    const h = app.renderer.height;
    let sx = 0;
    let sy = 0;
    const now = performance.now();
    if (now < shakeUntil) {
      const remaining = (shakeUntil - now) / SHAKE_DURATION_MS;
      sx = (Math.random() - 0.5) * 2 * shakeMag * remaining;
      sy = (Math.random() - 0.5) * 2 * shakeMag * remaining;
    }
    world.position.set(
      Math.round(w / 2 - selfX + sx),
      Math.round(h / 2 - selfY + sy),
    );
  }

  // ---------- combat effects ----------

  function triggerShake(magnitude: number, durationMs = SHAKE_DURATION_MS) {
    shakeUntil = performance.now() + durationMs;
    shakeMag = Math.max(shakeMag, magnitude);
  }

  function spawnDamageNumber(
    x: number,
    y: number,
    amount: number,
    color = "#ef4444",
  ) {
    // DoT ticks land sub-1 damage per server tick (8 DPS at
    // 20Hz = 0.4/tick). Math.round'ing those produces "0" labels
    // that flicker up every 50ms — visually wrong (it IS damaging
    // the target; the HP bar drops). Skip the spawn unless the
    // accumulated amount renders as ≥ 1.
    const display = Math.round(amount);
    if (display <= 0) return;
    const text = new Text({
      text: display.toString(),
      style: {
        fill: color,
        fontSize: 14,
        fontWeight: "700",
        fontFamily: "system-ui, sans-serif",
        stroke: { color: 0x000000, width: 3 },
      },
    });
    text.anchor.set(0.5);
    // Small horizontal jitter so multiple hits don't stack on one pixel.
    const jx = (Math.random() - 0.5) * 14;
    text.position.set(x + jx, y - 16);
    fxLayer.addChild(text);
    particles.push({
      obj: text,
      vx: 0,
      vy: -28, // px/sec; floats up
      life: 700,
      age: 0,
      fadeOut: true,
      rise: true,
    });
  }

  function spawnDeathBurst(x: number, y: number, color: number) {
    const N = 10;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2;
      const speed = 80 + Math.random() * 40;
      const g = new Graphics();
      g.circle(0, 0, 3).fill({ color });
      g.position.set(x, y);
      fxLayer.addChild(g);
      particles.push({
        obj: g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 400,
        age: 0,
        fadeOut: true,
      });
    }
  }

  function spawnMuzzleFlash(x: number, y: number, dirX: number, dirY: number) {
    const g = new Graphics();
    const len = Math.hypot(dirX, dirY) || 1;
    const ux = dirX / len;
    const uy = dirY / len;
    // Small triangle pointing in the fire direction.
    const tip = 18;
    const back = 6;
    const px = x + ux * 18;
    const py = y + uy * 18;
    // Perpendicular for the back edge.
    const perpX = -uy;
    const perpY = ux;
    g.moveTo(ux * tip, uy * tip)
      .lineTo(perpX * back, perpY * back)
      .lineTo(-perpX * back, -perpY * back)
      .closePath()
      .fill({ color: 0xfde68a });
    g.position.set(px, py);
    fxLayer.addChild(g);
    particles.push({
      obj: g,
      vx: 0,
      vy: 0,
      life: 80,
      age: 0,
      fadeOut: true,
    });
  }

  function tickParticles(dt: number) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt * 1000;
      if (p.age >= p.life) {
        fxLayer.removeChild(p.obj);
        p.obj.destroy({ children: true });
        particles.splice(i, 1);
        continue;
      }
      const t = p.age / p.life;
      p.obj.position.x += p.vx * dt;
      p.obj.position.y += p.vy * dt;
      if (p.fadeOut) p.obj.alpha = 1 - t;
      if (p.rise) p.vy *= 0.96; // slight deceleration on rise
    }
  }

  function addOrUpdatePlayer(p: Player, isSelf: boolean): RenderedPlayer {
    const existing = players.get(p.characterId);
    if (existing) {
      existing.data = { ...existing.data, ...p };
      existing.targetX = p.x;
      existing.targetY = p.y;
      if (!isSelf) existing.container.position.set(p.x, p.y);
      drawPlayerHpBar(existing);
      return existing;
    }

    const container = new Container();
    container.position.set(p.x, p.y);

    const body = new Graphics();
    body
      .circle(0, 0, 14)
      .fill({ color: isSelf ? SELF_COLOR : OTHER_COLOR })
      .circle(0, 0, 14)
      .stroke({ color: 0x000000, width: 2 });
    container.addChild(body);

    const label = new Text({
      text: p.displayName,
      style: {
        fill: "#e6e8eb",
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -28);
    container.addChild(label);

    // Mini HP bar above remote players. Self's HP is shown by the
    // screen-space HudOverlay instead — a floating bar over your
    // own head is redundant.
    const hpBg = new Graphics();
    const hpFill = new Graphics();
    if (!isSelf) {
      hpBg.roundRect(-18, -22, 36, 4, 2).fill({ color: 0x1f2937 });
      container.addChild(hpBg);
      container.addChild(hpFill);
    }

    playersLayer.addChild(container);

    const rp: RenderedPlayer = {
      data: { ...p },
      container,
      hpFill,
      targetX: p.x,
      targetY: p.y,
    };
    drawPlayerHpBar(rp);
    players.set(p.characterId, rp);
    return rp;
  }

  function drawPlayerHpBar(rp: RenderedPlayer) {
    rp.hpFill.clear();
    // Hide the over-character HP bar for other players when they
    // are at full HP — the local player has their own permanent
    // HUD bar so this overlay is just visual noise otherwise.
    if (rp.data.hp >= rp.data.maxHp || rp.data.maxHp <= 0) return;
    const ratio = Math.max(0, rp.data.hp / rp.data.maxHp);
    rp.hpFill.roundRect(-17, -21, 34 * ratio, 2, 1).fill({ color: 0x22c55e });
  }

  function addOrUpdateEnemy(e: EnemyState): RenderedEnemy {
    const existing = enemies.get(e.id);
    if (existing) {
      existing.data = { ...existing.data, ...e };
      existing.targetX = e.x;
      existing.targetY = e.y;
      existing.container.position.set(e.x, e.y);
      // Hp=0 enemies are pending an enemy_killed cleanup that
      // arrives a tick later; keep them hidden so a snapshot
      // restore (e.g. V-cycle) doesn't unhide a dead sprite.
      existing.container.visible = e.hp > 0;
      drawEnemyHpBar(existing);
      return existing;
    }
    const visual = visualFor(e.kind);
    const container = new Container();
    container.position.set(e.x, e.y);

    const body = new Graphics();
    drawEnemyShape(body, visual);
    container.addChild(body);

    // White overlay sitting above the body, hidden by default; shown briefly
    // when hit (alpha tweened down by tick).
    const flashOverlay = new Graphics();
    drawEnemyShape(flashOverlay, { ...visual, color: 0xffffff });
    flashOverlay.alpha = 0;
    container.addChild(flashOverlay);

    const hpBg = new Graphics();
    const barW = visual.size * 2 + 8;
    hpBg
      .roundRect(-barW / 2, -visual.size - 12, barW, 5, 2)
      .fill({ color: 0x1f2937 });
    container.addChild(hpBg);

    const hpFill = new Graphics();
    container.addChild(hpFill);

    enemiesLayer.addChild(container);
    // First-add can land already-dead (hp=0) when restoring from a
    // snapshot; keep the sprite hidden until enemy_killed arrives.
    container.visible = e.hp > 0;

    const re: RenderedEnemy = {
      data: { ...e },
      container,
      hpFill,
      targetX: e.x,
      targetY: e.y,
      flashOverlay,
      flashUntil: 0,
      body,
    };
    drawEnemyHpBar(re);
    enemies.set(e.id, re);

    // If the host has an asset_gen-backed sprite for this enemy kind,
    // load it lazily and swap once ready. Procedural body stays
    // visible until then so the player sees something immediately.
    void resolveEnemySprite(re, e.kind);
    return re;
  }

  // Per-kind texture cache so we only ever load each PNG once. The
  // promise is cached during in-flight loads to dedupe concurrent
  // first-spawns of the same kind.
  const enemyTextureCache = new Map<string, Promise<Texture | null>>();

  // When a texture override changes (developer uploaded a sprite
  // via /editor), drop any already-resolved sprites from existing
  // enemies and re-run the resolver so they pick up the new
  // texture without a scene reload. Mirrors iso's behaviour.
  const unsubOverrides = subscribeOverrides(() => {
    for (const [, re] of enemies) {
      if (re.sprite) {
        re.container.removeChild(re.sprite);
        re.sprite.destroy();
        re.sprite = undefined;
        re.body.visible = true;
      }
      void resolveEnemySprite(re, re.data.kind);
    }
  });

  async function resolveEnemySprite(
    re: RenderedEnemy,
    kind: string,
  ): Promise<void> {
    if (!init.getEnemyTexture) return;
    const url = init.getEnemyTexture(kind);
    if (!url) return;
    let pending = enemyTextureCache.get(url);
    if (!pending) {
      pending = Assets.load(url)
        .then((tex) => (tex ? (tex as Texture) : null))
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[asset_gen] texture load failed for ${kind}`, url, err);
          return null;
        });
      enemyTextureCache.set(url, pending);
    }
    const texture = await pending;
    if (!texture) return;
    // Renderer might have torn down between async start and resolve
    // (player swapped scenes). Bail if so.
    if (re.container.destroyed) return;
    const visual = visualFor(kind);
    const sprite = new Sprite(texture);
    // The procedural shapes are sized in radius-style units; doubling
    // gives a tile-comparable footprint.
    const target = visual.size * 2.4;
    const aspect = texture.height > 0 ? texture.width / texture.height : 1;
    sprite.width = aspect >= 1 ? target : target * aspect;
    sprite.height = aspect >= 1 ? target / aspect : target;
    sprite.anchor.set(0.5, 0.5);
    // Insert below the flash overlay + hp bar so hit feedback still
    // pops on top of the sprite.
    re.container.addChildAt(sprite, 1);
    re.body.visible = false;
    re.sprite = sprite;
  }

  function drawEnemyShape(g: Graphics, v: EnemyVisual) {
    const s = v.size;
    if (v.shape === "circle") {
      g.circle(0, 0, s).fill({ color: v.color });
      g.circle(0, 0, s).stroke({ color: 0x000000, width: 2 });
      return;
    }
    if (v.shape === "square") {
      g.rect(-s, -s, s * 2, s * 2).fill({ color: v.color });
      g.rect(-s, -s, s * 2, s * 2).stroke({ color: 0x000000, width: 2 });
      return;
    }
    // triangle (pointing up)
    g.moveTo(0, -s)
      .lineTo(s, s)
      .lineTo(-s, s)
      .closePath()
      .fill({ color: v.color });
    g.moveTo(0, -s)
      .lineTo(s, s)
      .lineTo(-s, s)
      .closePath()
      .stroke({ color: 0x000000, width: 2 });
  }

  function drawEnemyHpBar(re: RenderedEnemy) {
    re.hpFill.clear();
    // Hide the bar entirely when the enemy is at full HP — visual
    // noise during peaceful moments and makes "what hit me" reads
    // cleaner during combat (any visible bar = recently damaged).
    if (re.data.hp >= re.data.maxHp || re.data.maxHp <= 0) return;
    const ratio = Math.max(0, re.data.hp / re.data.maxHp);
    const visual = visualFor(re.data.kind);
    const barW = visual.size * 2 + 8;
    re.hpFill
      .roundRect(-barW / 2 + 1, -visual.size - 11, (barW - 2) * ratio, 3, 1.5)
      .fill({ color: 0xef4444 });
  }

  function addProjectile(p: ProjectileState) {
    if (projectiles.has(p.id)) return;
    const g = new Graphics();
    const color =
      p.color ?? (p.ownerKind === "enemy" ? 0xfbbf24 : PROJECTILE_COLOR);
    drawProjectileShape(g, color, p.vx, p.vy);
    g.position.set(p.x, p.y);
    projectilesLayer.addChild(g);
    projectiles.set(p.id, {
      data: { ...p },
      graphic: g,
      spawnedAt: performance.now(),
    });
  }

  // Pure tapered streak — no head dot. At 2250 px/s the streak is the
  // bullet visually; the head was redundant. Two layered strokes
  // approximate a tapered fade.
  function drawProjectileShape(
    g: Graphics,
    color: number,
    vx: number,
    vy: number,
  ) {
    const TRAIL_LEN = 28;
    const len = Math.hypot(vx, vy) || 1;
    const ux = vx / len;
    const uy = vy / len;
    g.clear();
    g.moveTo(-ux * TRAIL_LEN, -uy * TRAIL_LEN)
      .lineTo(0, 0)
      .stroke({ color, width: 1, alpha: 0.3 });
    g.moveTo(-ux * (TRAIL_LEN * 0.55), -uy * (TRAIL_LEN * 0.55))
      .lineTo(0, 0)
      .stroke({ color, width: 2.5, alpha: 0.85 });
  }

  function addBuilding(b: BuildingState) {
    if (buildings.has(b.id)) return;
    const tileSize = currentLayout?.tileSize ?? 32;
    const w = b.width * tileSize;
    const h = b.height * tileSize;
    const px = b.tileX * tileSize;
    const py = b.tileY * tileSize;

    const container = new Container();
    container.position.set(px, py);

    const body = new Graphics();
    if (
      b.kind === "turret" ||
      b.kind === "turret_smg" ||
      b.kind === "turret_shotgun" ||
      b.kind === "turret_rifle"
    ) {
      // Turret: dark base plate with a coloured cap that varies by family
      // so the player can read the build at a glance.
      const capColor =
        b.kind === "turret_smg"
          ? 0xfde68a
          : b.kind === "turret_shotgun"
            ? 0xff8a3d
            : b.kind === "turret_rifle"
              ? 0x7dd3fc
              : 0x3b82f6;
      const ringColor =
        b.kind === "turret_smg"
          ? 0xa16207
          : b.kind === "turret_shotgun"
            ? 0x9a3412
            : b.kind === "turret_rifle"
              ? 0x0e7490
              : 0x1e3a8a;
      body.rect(0, 0, w, h).fill({ color: 0x27272a });
      body.rect(0, 0, w, h).stroke({ color: 0x09090b, width: 2 });
      body.circle(w / 2, h / 2, w * 0.32).fill({ color: capColor });
      body
        .circle(w / 2, h / 2, w * 0.32)
        .stroke({ color: ringColor, width: 1 });
      body
        .rect(w / 2 - 2, h / 2 - h * 0.4, 4, h * 0.4)
        .fill({ color: 0x71717a });
    } else if (b.kind === "workbench") {
      // Workbench: tan tabletop with crossed tools.
      body.rect(0, 0, w, h).fill({ color: 0x92400e });
      body.rect(0, 0, w, h).stroke({ color: 0x451a03, width: 2 });
      body.rect(w * 0.15, h * 0.4, w * 0.7, h * 0.18).fill({ color: 0xf59e0b });
      body
        .moveTo(w * 0.2, h * 0.7)
        .lineTo(w * 0.8, h * 0.25)
        .stroke({ color: 0xe5e7eb, width: 2 });
    } else if (b.kind === "forge") {
      // Forge: dark stone base with a glowing red core.
      body.rect(0, 0, w, h).fill({ color: 0x1c1917 });
      body.rect(0, 0, w, h).stroke({ color: 0x000000, width: 2 });
      body.circle(w / 2, h / 2, w * 0.3).fill({ color: 0xdc2626 });
      body.circle(w / 2, h / 2, w * 0.3).stroke({ color: 0x7f1d1d, width: 1 });
      body.circle(w / 2, h / 2, w * 0.15).fill({ color: 0xfbbf24 });
    } else if (b.kind === "door") {
      // Wood-tone door with a metal lock plate centred on the tile.
      // Reads as "interactable, not just another wall."
      body.rect(0, 0, w, h).fill({ color: 0x8b5e34 });
      body.rect(0, 0, w, h).stroke({ color: 0x3a2614, width: 2 });
      body
        .rect(w * 0.1, h * 0.1, w * 0.8, h * 0.8)
        .stroke({ color: 0x6b4221, width: 1 });
      body
        .rect(w * 0.4, h * 0.42, w * 0.2, h * 0.16)
        .fill({ color: 0xfacc15 })
        .stroke({ color: 0x854d0e, width: 1 });
      // Vertical wood grain.
      body
        .moveTo(w * 0.5, h * 0.1)
        .lineTo(w * 0.5, h * 0.42)
        .moveTo(w * 0.5, h * 0.58)
        .lineTo(w * 0.5, h * 0.9)
        .stroke({ color: 0x6b4221, width: 1 });
    } else if (b.kind === "power_link") {
      // Massive central pillar with a bright cyan-violet plasma core. Reads
      // as both "this is the dungeon portal" and "this is the power source"
      // — the most visually distinct building on the surface.
      body.rect(0, 0, w, h).fill({ color: 0x0c1126 });
      body.rect(0, 0, w, h).stroke({ color: 0x000000, width: 3 });
      body.circle(w / 2, h / 2, w * 0.42).fill({ color: 0x4338ca });
      body.circle(w / 2, h / 2, w * 0.28).fill({ color: 0x06b6d4 });
      body.circle(w / 2, h / 2, w * 0.14).fill({ color: 0xe0f2fe });
      // Energy spokes radiating outward.
      const cx = w / 2;
      const cy = h / 2;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x1 = cx + Math.cos(a) * w * 0.42;
        const y1 = cy + Math.sin(a) * h * 0.42;
        const x2 = cx + Math.cos(a) * w * 0.5;
        const y2 = cy + Math.sin(a) * h * 0.5;
        body
          .moveTo(x1, y1)
          .lineTo(x2, y2)
          .stroke({ color: 0x67e8f9, width: 1.5 });
      }
    } else if (b.kind === "artifact_uplink") {
      // Tall pylon with a glowing pink core — sells the "alien tech" feel.
      body.rect(0, 0, w, h).fill({ color: 0x1a1325 });
      body.rect(0, 0, w, h).stroke({ color: 0x09090b, width: 2 });
      body
        .circle(w / 2, h / 2, w * 0.32)
        .fill({ color: 0xf472b6 })
        .stroke({ color: 0x86195e, width: 2 });
      body.circle(w / 2, h / 2, w * 0.16).fill({ color: 0xfbcfe8 });
      // Antenna stripes top and bottom.
      body.rect(w * 0.4, 0, w * 0.2, h * 0.12).fill({ color: 0xfbcfe8 });
      body.rect(w * 0.4, h * 0.88, w * 0.2, h * 0.12).fill({ color: 0xfbcfe8 });
    } else if (b.kind === "weapon_bench") {
      // Gunsmith bench: dark steel surface with a stylised pistol
      // silhouette on top + a brass-tone vise at one end. Reads as
      // "you build / mod weapons here."
      body.rect(0, 0, w, h).fill({ color: 0x1f2937 });
      body.rect(0, 0, w, h).stroke({ color: 0x0b1220, width: 2 });
      // Bench top.
      body.rect(w * 0.1, h * 0.18, w * 0.8, h * 0.22).fill({ color: 0x374151 });
      // Pistol silhouette (rectangular slide + handle).
      body.rect(w * 0.22, h * 0.5, w * 0.5, h * 0.14).fill({ color: 0x9ca3af });
      body
        .rect(w * 0.34, h * 0.62, w * 0.18, h * 0.22)
        .fill({ color: 0x9ca3af });
      // Vise on the right.
      body
        .rect(w * 0.74, h * 0.52, w * 0.14, h * 0.28)
        .fill({ color: 0xb45309 })
        .stroke({ color: 0x78350f, width: 1 });
    } else if (b.kind === "suit_bench") {
      // Suit Assembly Bench: deep-blue base with a stylised suit
      // silhouette (head + chest plate) on top + a cyan plating
      // accent line. Distinct from the Weapon Bench's pistol motif
      // and the Precision Mill's spindle disc.
      body.rect(0, 0, w, h).fill({ color: 0x1e3a8a });
      body.rect(0, 0, w, h).stroke({ color: 0x0c1126, width: 2 });
      // Bench top.
      body.rect(w * 0.1, h * 0.18, w * 0.8, h * 0.22).fill({ color: 0x1e293b });
      // Suit head.
      body
        .circle(w * 0.5, h * 0.5, w * 0.08)
        .fill({ color: 0xcbd5e1 })
        .stroke({ color: 0x1e293b, width: 1 });
      // Chest plate.
      body
        .rect(w * 0.36, h * 0.6, w * 0.28, h * 0.22)
        .fill({ color: 0x94a3b8 })
        .stroke({ color: 0x1e293b, width: 1 });
      // Cyan plating accent.
      body
        .moveTo(w * 0.42, h * 0.7)
        .lineTo(w * 0.58, h * 0.7)
        .stroke({ color: 0x22d3ee, width: 1.5 });
    } else if (b.kind === "precision_mill") {
      // Precision Machining Mill: dark steel base with a stylised
      // central spindle (lathe head) and a yellow indicator light.
      // Reads as "you upgrade weapon tier here" — distinct from the
      // weapon bench's gunsmith pistol silhouette.
      body.rect(0, 0, w, h).fill({ color: 0x1e293b });
      body.rect(0, 0, w, h).stroke({ color: 0x000000, width: 2 });
      // Lower housing.
      body
        .rect(w * 0.18, h * 0.6, w * 0.64, h * 0.28)
        .fill({ color: 0x475569 })
        .stroke({ color: 0x0f172a, width: 1 });
      // Spindle disc.
      body
        .circle(w * 0.5, h * 0.42, w * 0.2)
        .fill({ color: 0x94a3b8 })
        .stroke({ color: 0x1e293b, width: 1 });
      body.circle(w * 0.5, h * 0.42, w * 0.07).fill({ color: 0xfbbf24 });
      // Spokes.
      body
        .moveTo(w * 0.5, h * 0.22)
        .lineTo(w * 0.5, h * 0.34)
        .stroke({ color: 0xcbd5e1, width: 1.5 });
      body
        .moveTo(w * 0.5, h * 0.5)
        .lineTo(w * 0.5, h * 0.62)
        .stroke({ color: 0xcbd5e1, width: 1.5 });
      body
        .moveTo(w * 0.3, h * 0.42)
        .lineTo(w * 0.42, h * 0.42)
        .stroke({ color: 0xcbd5e1, width: 1.5 });
      body
        .moveTo(w * 0.58, h * 0.42)
        .lineTo(w * 0.7, h * 0.42)
        .stroke({ color: 0xcbd5e1, width: 1.5 });
    } else if (b.kind === "electronics_bench") {
      // Electronics bench: green PCB-like surface with a yellow LED.
      body.rect(0, 0, w, h).fill({ color: 0x064e3b });
      body.rect(0, 0, w, h).stroke({ color: 0x022c22, width: 2 });
      body.rect(w * 0.2, h * 0.2, w * 0.6, h * 0.6).fill({ color: 0x065f46 });
      body.circle(w * 0.3, h * 0.3, 2).fill({ color: 0xfbbf24 });
      body.circle(w * 0.7, h * 0.7, 2).fill({ color: 0xfbbf24 });
      body
        .moveTo(w * 0.3, h * 0.3)
        .lineTo(w * 0.7, h * 0.7)
        .stroke({ color: 0x10b981, width: 1 });
    } else if (b.kind === "storage_chest") {
      // Storage: brass-banded crate with a single padlock. Reads
      // distinctly from workstations (no glowing core) at a glance.
      body.rect(0, 0, w, h).fill({ color: 0x4a3520 });
      body.rect(0, 0, w, h).stroke({ color: 0x1f1611, width: 2 });
      body.rect(0, h * 0.2, w, h * 0.08).fill({ color: 0xa16207 });
      body.rect(0, h * 0.72, w, h * 0.08).fill({ color: 0xa16207 });
      body
        .rect(w * 0.42, h * 0.4, w * 0.16, h * 0.2)
        .fill({ color: 0xfbbf24 })
        .stroke({ color: 0x713f12, width: 1 });
    } else {
      // Wall — chunky gray block with a darker border + hatch lines.
      body.rect(0, 0, w, h).fill({ color: 0x52525b });
      body.rect(0, 0, w, h).stroke({ color: 0x18181b, width: 2 });
      body
        .moveTo(0, h / 2)
        .lineTo(w, h / 2)
        .moveTo(w / 2, 0)
        .lineTo(w / 2, h / 2)
        .moveTo(0, 0)
        .stroke({ color: 0x3f3f46, width: 1 });
    }
    container.addChild(body);

    // HP bar (hidden until damaged).
    const hpFill = new Graphics();
    container.addChild(hpFill);

    buildingsLayer.addChild(container);

    const rb: RenderedBuilding = { data: { ...b }, container, hpFill };
    drawBuildingHpBar(rb);
    buildings.set(b.id, rb);
    buildingsVersion++;
  }

  function drawBuildingHpBar(rb: RenderedBuilding) {
    rb.hpFill.clear();
    if (rb.data.hp >= rb.data.maxHp) return;
    const tileSize = currentLayout?.tileSize ?? 32;
    const w = rb.data.width * tileSize;
    const ratio = Math.max(0, rb.data.hp / rb.data.maxHp);
    rb.hpFill.rect(2, -6, (w - 4) * ratio, 3).fill({ color: 0x22c55e });
  }

  // Decorator props — barrels, crates, conduits, etc. Flat
  // top-down circle with a per-kind tint pulled from the prop's
  // texture-override colour (or a generic gray if none). No HP
  // bar by design (see GDD § Props); damage feedback is hit-flash
  // + the eventual prop_destroyed removal.
  function addProp(p: PropState) {
    if (props.has(p.id)) return;
    const container = new Container();
    container.position.set(p.x, p.y);
    const body = new Graphics();
    body.circle(0, 0, 12).fill({ color: 0x71717a });
    body.circle(0, 0, 12).stroke({ color: 0x000000, width: 2 });
    container.addChild(body);
    const flashOverlay = new Graphics();
    flashOverlay.circle(0, 0, 12).fill({ color: 0xffffff });
    flashOverlay.alpha = 0;
    container.addChild(flashOverlay);
    lootLayer.addChild(container);
    props.set(p.id, {
      data: { ...p },
      container,
      flashOverlay,
      flashUntil: 0,
    });
  }

  function addCorpse(c: CorpseState) {
    if (corpses.has(c.id)) return;
    const container = new Container();
    container.position.set(c.x, c.y);

    // Player-sized circle, dimmed grey, with an X mark.
    const body = new Graphics();
    body.circle(0, 0, 14).fill({ color: 0x4b5563 });
    body.circle(0, 0, 14).stroke({ color: 0x000000, width: 2 });
    container.addChild(body);

    const cross = new Graphics();
    cross
      .moveTo(-6, -6)
      .lineTo(6, 6)
      .moveTo(6, -6)
      .lineTo(-6, 6)
      .stroke({ color: 0xef4444, width: 2 });
    container.addChild(cross);

    const label = new Text({
      text: c.ownerDisplayName,
      style: {
        fill: "#fca5a5",
        fontSize: 11,
        fontFamily: "system-ui, sans-serif",
        stroke: { color: 0x000000, width: 3 },
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -22);
    container.addChild(label);

    lootLayer.addChild(container);
    corpses.set(c.id, { data: { ...c }, container });
  }

  // Cheap label for player-dropped slot loot so a near-walker can
  // tell what's on the ground without picking it up. Mirrors the
  // outputSlotLabel formatting in Game.tsx loosely; we don't pull
  // attachment / weapon display name helpers here to keep the
  // renderer free of inventory.ts dependency.
  function droppedSlotLabel(
    s: import("@dumrunner/shared").InventorySlot,
  ): string | null {
    if (s.kind === "empty") return null;
    if (s.kind === "material") return `${s.count}× ${s.materialId}`;
    if (s.kind === "ammo") return `${s.count}× ${s.ammoId}`;
    if (s.kind === "placeable") return `${s.count}× ${s.buildingKind}`;
    if (s.kind === "attachment")
      return s.instance.defId.replace(/^(mod_|aff_)/, "");
    if (s.kind === "consumable") return `${s.count}× ${s.consumableId}`;
    if (s.kind === "weapon") return s.weapon.weaponId;
    if (s.kind === "part") return s.part.slot;
    return null;
  }

  function addLoot(l: LootState) {
    if (loot.has(l.id)) return;

    const container = new Container();
    container.position.set(l.x, l.y);
    const body = new Graphics();

    if (l.content.kind === "part") {
      // Diamond, color-graded by part tier.
      const color = TIER_COLORS_NUM[l.content.part.tier] ?? 0xffffff;
      const s = 9;
      body
        .moveTo(0, -s)
        .lineTo(s, 0)
        .lineTo(0, s)
        .lineTo(-s, 0)
        .closePath()
        .fill({ color })
        .moveTo(0, -s)
        .lineTo(s, 0)
        .lineTo(0, s)
        .lineTo(-s, 0)
        .closePath()
        .stroke({ color: 0x000000, width: 1.5 });
    } else if (l.content.kind === "material") {
      // Material pile — squarish nugget tinted by material color, count
      // shown as a small label so 1 vs 12 reads at a glance.
      const def = materialTint(l.content.materialId);
      body
        .rect(-7, -7, 14, 14)
        .fill({ color: def })
        .rect(-7, -7, 14, 14)
        .stroke({ color: 0x000000, width: 1.5 });
      container.addChild(body);
      const label = new Text({
        text: `×${l.content.count}`,
        style: {
          fill: 0xffffff,
          fontSize: 11,
          fontFamily: "system-ui, sans-serif",
          stroke: { color: 0x000000, width: 3 },
        },
      });
      label.anchor.set(0.5, 0);
      label.position.set(0, 8);
      container.addChild(label);
    } else if (l.content.kind === "slot") {
      // Player-dropped slot. We don't have per-kind sprites for every
      // possible slot variant, so render a generic amber pouch + a
      // short label so the picker can tell what they're walking onto.
      const inner = l.content.slot;
      body
        .circle(0, 0, 8)
        .fill({ color: 0xfbbf24 })
        .circle(0, 0, 8)
        .stroke({ color: 0x78350f, width: 1.5 });
      container.addChild(body);
      const lbl = droppedSlotLabel(inner);
      if (lbl) {
        const label = new Text({
          text: lbl,
          style: {
            fill: 0xffffff,
            fontSize: 10,
            fontFamily: "system-ui, sans-serif",
            stroke: { color: 0x000000, width: 3 },
          },
        });
        label.anchor.set(0.5, 0);
        label.position.set(0, 10);
        container.addChild(label);
      }
    }
    if (container.children.length === 0) container.addChild(body);

    lootLayer.addChild(container);
    loot.set(l.id, {
      data: { ...l },
      container,
      spawnedAt: performance.now(),
    });
  }

  // ---------- layout rendering ----------

  // Tracked separately from interactables map so swapScene can throw out the
  // old set cleanly.
  type RenderedInteractable = {
    data: Interactable;
    container: Container;
    spawnedAt: number;
  };
  const interactables = new Map<string, RenderedInteractable>();

  // Sample the segment at half-tile granularity and reject if any
  // sample falls inside a building footprint. Mirrors the server's
  // segmentClear so visual fog and AI LoS agree on what blocks sight.
  function segmentCrossesBuilding(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    tileSize: number,
  ): boolean {
    if (buildings.size === 0) return false;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return false;
    const stride = Math.max(4, tileSize * 0.25);
    const steps = Math.max(1, Math.ceil(len / stride));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = x1 + dx * t;
      const sy = y1 + dy * t;
      for (const rb of buildings.values()) {
        const b = rb.data;
        const px = b.tileX * tileSize;
        const py = b.tileY * tileSize;
        const pw = b.width * tileSize;
        const ph = b.height * tileSize;
        if (sx >= px && sx <= px + pw && sy >= py && sy <= py + ph) {
          return true;
        }
      }
    }
    return false;
  }

  // Fog cache: avoid the per-tile LoS scan on every frame by skipping
  // the recompute when the player hasn't changed tile, the layout
  // hasn't swapped, and no building has been added/removed/destroyed.
  // The graphics object retains the last fill so visuals are unchanged
  // until invalidated.
  let lastFogKey = "";
  function updateFog() {
    const layout = currentLayout;
    if (!layout || layout.walkables.length === 0 || layout.tileSize <= 0) {
      if (lastFogKey !== "__empty") {
        fogGraphics.clear();
        lastFogKey = "__empty";
      }
      return;
    }
    const tileSize = layout.tileSize;
    const playerTileX = Math.floor(selfX / tileSize);
    const playerTileY = Math.floor(selfY / tileSize);
    const key = `${playerTileX},${playerTileY}|${layoutVersion}|${buildingsVersion}`;
    if (key === lastFogKey) return;
    lastFogKey = key;
    fogGraphics.clear();

    const VIEW_RADIUS_TILES = 13;
    const radiusSq = VIEW_RADIUS_TILES * VIEW_RADIUS_TILES;
    const walkables = layout.walkables;

    // Walk every tile inside any walkable rect. Visible tiles (within view
    // radius AND with unobstructed LoS) get nothing drawn. Non-visible
    // walkable tiles get a translucent dark overlay — that's the "shadow"
    // outside the light cone.
    const dimmed = new Set<string>();
    for (const r of walkables) {
      const startTX = Math.floor(r.x / tileSize);
      const startTY = Math.floor(r.y / tileSize);
      const endTX = Math.floor((r.x + r.w - 1) / tileSize);
      const endTY = Math.floor((r.y + r.h - 1) / tileSize);
      for (let ty = startTY; ty <= endTY; ty++) {
        for (let tx = startTX; tx <= endTX; tx++) {
          const key = `${tx},${ty}`;
          if (dimmed.has(key)) continue;

          const dx = tx - playerTileX;
          const dy = ty - playerTileY;
          let visible = false;
          if (dx * dx + dy * dy <= radiusSq) {
            const cx = (tx + 0.5) * tileSize;
            const cy = (ty + 0.5) * tileSize;
            if (
              segmentInsideWalkables(walkables, selfX, selfY, cx, cy) &&
              !segmentCrossesBuilding(selfX, selfY, cx, cy, tileSize)
            ) {
              visible = true;
            }
          }
          if (visible) continue;
          dimmed.add(key);
          fogGraphics
            .rect(tx * tileSize, ty * tileSize, tileSize, tileSize)
            .fill({ color: 0x000000, alpha: 0.65 });
        }
      }
    }
  }

  // Workstation kinds the player is currently within crafting range of.
  // Mirrors the server's CRAFT_STATION_RANGE_PX gate (3 tiles ≈ 96px).
  // Only fires the callback when the kind set changes, so it's cheap to call
  // every frame.
  const CRAFT_STATION_RANGE_PX = 96;
  let lastWorkstationKey = "";
  function updateNearWorkstations() {
    const tileSize = currentLayout?.tileSize ?? 0;
    if (tileSize <= 0 || buildings.size === 0) {
      if (lastWorkstationKey !== "") {
        lastWorkstationKey = "";
        init.onNearWorkstationsChanged({
          all: [],
          nearest: null,
          nearestDoorId: null,
          nearestDoorKind: null,
          nearestDoorOpen: false,
          nearestChestId: null,
          nearestContainerId: null,
          weaponBenchTier: 0,
          weaponBenches: [],
        });
      }
      return;
    }
    const r2 = CRAFT_STATION_RANGE_PX * CRAFT_STATION_RANGE_PX;
    const found = new Set<BuildingKind>();
    let nearestKind: BuildingKind | null = null;
    let nearestDsq = Infinity;
    let nearestDoorId: string | null = null;
    let nearestDoorKind: 'door' | 'wall_door' | null = null;
    let nearestDoorOpen = false;
    let nearestDoorDsq = Infinity;
    let nearestChestId: string | null = null;
    let nearestChestDsq = Infinity;
    // Max weapon-bench tier among all benches in range. The server
    // takes the same max when validating assemble_weapon, so the UI
    // gating reads from the same model.
    let weaponBenchTier = 0;
    const weaponBenches: { id: string; tier: number }[] = [];
    for (const rb of buildings.values()) {
      const b = rb.data;
      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;
      const halfW = (b.width * tileSize) / 2;
      const halfH = (b.height * tileSize) / 2;
      const dx = Math.max(Math.abs(selfX - cx) - halfW, 0);
      const dy = Math.max(Math.abs(selfY - cy) - halfH, 0);
      const dsq = dx * dx + dy * dy;
      if (b.kind === "door" || b.kind === "wall_door") {
        if (dsq <= r2 && dsq < nearestDoorDsq) {
          nearestDoorDsq = dsq;
          nearestDoorId = b.id;
          nearestDoorKind = b.kind;
          nearestDoorOpen = b.kind === "wall_door" ? b.open === true : false;
        }
        continue;
      }
      if (
        b.kind !== "workbench" &&
        b.kind !== "forge" &&
        b.kind !== "electronics_bench" &&
        b.kind !== "weapon_bench" &&
        b.kind !== "precision_mill" &&
        b.kind !== "suit_bench" &&
        b.kind !== "artifact_uplink" &&
        b.kind !== "storage_chest"
      ) {
        continue;
      }
      if (dsq <= r2) {
        found.add(b.kind);
        if (dsq < nearestDsq) {
          nearestDsq = dsq;
          nearestKind = b.kind;
        }
        if (b.kind === "storage_chest" && dsq < nearestChestDsq) {
          nearestChestDsq = dsq;
          nearestChestId = b.id;
        }
        if (b.kind === "weapon_bench") {
          const t = b.benchTier ?? 1;
          if (t > weaponBenchTier) weaponBenchTier = t;
          weaponBenches.push({ id: b.id, tier: t });
        }
      }
    }
    const key =
      [...found].sort().join(",") +
      "|" +
      (nearestKind ?? "") +
      "|" +
      (nearestDoorId ?? "") +
      "|" +
      (nearestDoorKind ?? "") +
      "|" +
      (nearestDoorOpen ? "1" : "0") +
      "|" +
      (nearestChestId ?? "") +
      "|" +
      String(weaponBenchTier) +
      "|" +
      weaponBenches.map((b) => `${b.id}:${b.tier}`).join(",");
    if (key !== lastWorkstationKey) {
      lastWorkstationKey = key;
      init.onNearWorkstationsChanged({
        all: [...found],
        nearest: nearestKind,
        nearestDoorId,
        nearestDoorKind,
        nearestDoorOpen,
        nearestChestId,
        // Top-down renderer doesn't model container props yet; the
        // FPS path is what matters for E5. Surface this as null.
        nearestContainerId: null,
        weaponBenchTier,
        weaponBenches,
      });
    }
  }

  let lastNearInteractableId: string | null = null;
  function updateNearInteractable() {
    const layout = currentLayout;
    if (!layout || layout.interactables.length === 0) {
      if (lastNearInteractableId !== null) {
        lastNearInteractableId = null;
        init.onNearInteractableChanged(null);
      }
      return;
    }
    const r2 = INTERACTABLE_RADIUS * INTERACTABLE_RADIUS;
    let bestId: string | null = null;
    let bestLabel: string | null = null;
    let bestDistSq = r2;
    for (const it of layout.interactables) {
      const dx = it.x - selfX;
      const dy = it.y - selfY;
      const dsq = dx * dx + dy * dy;
      if (dsq > r2) continue;
      if (dsq < bestDistSq) {
        bestId = it.id;
        bestLabel = it.label;
        bestDistSq = dsq;
      }
    }
    if (bestId !== lastNearInteractableId) {
      lastNearInteractableId = bestId;
      init.onNearInteractableChanged(
        bestId && bestLabel ? { id: bestId, label: bestLabel } : null,
      );
    }
  }

  function updateBuildMode() {
    const tileSize = currentLayout?.tileSize ?? 0;
    if (buildKind === null || tileSize <= 0) {
      buildGhost.visible = false;
      pendingBuildAction = null;
      return;
    }

    const aim = mouseToWorld();
    const tileX = Math.floor(aim.x / tileSize);
    const tileY = Math.floor(aim.y / tileSize);

    // Distance check — same formula as the server uses.
    const tileCenterX = (tileX + 0.5) * tileSize;
    const tileCenterY = (tileY + 0.5) * tileSize;
    const reach = (BUILD_RADIUS_TILES + buildRadiusBonus + 0.5) * tileSize;
    const dxc = tileCenterX - selfX;
    const dyc = tileCenterY - selfY;
    const inRange = dxc * dxc + dyc * dyc <= reach * reach;
    const occupied = isTileOccupied(tileX, tileY);
    const valid = inRange && !occupied;

    buildGhost.removeChildren().forEach((c) => c.destroy({ children: true }));

    // Shaded ring showing the buildable radius around the player.
    const radiusBg = new Graphics();
    radiusBg
      .circle(selfX, selfY, reach)
      .fill({ color: 0x22c55e, alpha: 0.06 })
      .circle(selfX, selfY, reach)
      .stroke({ color: 0x22c55e, width: 1, alpha: 0.4 });
    buildGhost.addChild(radiusBg);

    // Tile ghost.
    const color = valid ? 0x22c55e : 0xef4444;
    const ghost = new Graphics();
    ghost
      .rect(tileX * tileSize, tileY * tileSize, tileSize, tileSize)
      .fill({ color, alpha: 0.25 })
      .rect(tileX * tileSize, tileY * tileSize, tileSize, tileSize)
      .stroke({ color, width: 2 });
    buildGhost.addChild(ghost);
    buildGhost.visible = true;

    if (pendingBuildAction === "place") {
      pendingBuildAction = null;
      if (valid && buildKind) init.sendBuild(buildKind, tileX, tileY);
    } else if (pendingBuildAction === "demolish") {
      pendingBuildAction = null;
      const target = findBuildingAtTile(tileX, tileY);
      if (target && inRange) init.sendDemolish(target.data.id);
    }
  }

  function isTileOccupied(tileX: number, tileY: number): boolean {
    for (const b of buildings.values()) {
      if (
        tileX >= b.data.tileX &&
        tileX < b.data.tileX + b.data.width &&
        tileY >= b.data.tileY &&
        tileY < b.data.tileY + b.data.height
      ) {
        return true;
      }
    }
    return false;
  }

  function findBuildingAtTile(
    tileX: number,
    tileY: number,
  ): RenderedBuilding | null {
    for (const b of buildings.values()) {
      if (
        tileX >= b.data.tileX &&
        tileX < b.data.tileX + b.data.width &&
        tileY >= b.data.tileY &&
        tileY < b.data.tileY + b.data.height
      ) {
        return b;
      }
    }
    return null;
  }

  function applyLineOfSight() {
    const walkables = currentLayout?.walkables;
    if (!walkables || walkables.length === 0) {
      // Open scene — make sure everything is visible (e.g. after returning
      // from a dungeon to surface).
      for (const p of players.values()) p.container.visible = true;
      for (const e of enemies.values()) {
        // enemy.container.visible may have been set false on death; only
        // unhide alive enemies.
        if (e.data.hp > 0) e.container.visible = true;
      }
      for (const pr of projectiles.values()) pr.graphic.visible = true;
      for (const l of loot.values()) l.container.visible = true;
      for (const c of corpses.values()) c.container.visible = true;
      for (const it of interactables.values()) it.container.visible = true;
      return;
    }

    const see = (x: number, y: number) =>
      segmentInsideWalkables(walkables, selfX, selfY, x, y);

    // Visibility uses the server-authoritative target position rather
    // than the interpolated render position — otherwise a stale
    // data.x/y (still lerping toward the real spot) would keep the
    // entity hidden after the server moved it into LoS, and you'd be
    // shot by an "invisible" enemy until the render caught up.
    for (const [id, p] of players) {
      if (id === init.self.characterId) {
        p.container.visible = true;
        continue;
      }
      p.container.visible = see(p.targetX, p.targetY);
    }
    for (const e of enemies.values()) {
      if (e.data.hp <= 0) continue; // already hidden by death handler
      e.container.visible = see(e.targetX, e.targetY);
    }
    for (const pr of projectiles.values()) {
      // Use the graphic's actual position (extrapolated) rather than spawn pos.
      pr.graphic.visible = see(pr.graphic.position.x, pr.graphic.position.y);
    }
    for (const l of loot.values()) {
      l.container.visible = see(l.data.x, l.data.y);
    }
    for (const c of corpses.values()) {
      c.container.visible = see(c.data.x, c.data.y);
    }
    for (const it of interactables.values()) {
      it.container.visible = see(it.data.x, it.data.y);
    }
  }

  function clearLayoutAndInteractables() {
    layoutLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    for (const it of interactables.values()) {
      it.container.destroy({ children: true });
    }
    interactables.clear();
    interactablesLayer.removeChildren();
  }

  function renderLayout(layout: SceneLayout | null) {
    currentLayout = layout;
    layoutVersion++;
    clearLayoutAndInteractables();

    if (!layout || layout.walkables.length === 0) {
      // Surface — open world, draw the original infinite-feeling grid.
      drawOpenGrid(layoutLayer);
    } else if (layout.tileGrid) {
      // Tile grid is the source of truth — paints per-cell floor /
      // wall, picking up template stamps that walkables[] doesn't
      // represent.
      drawDungeonFloorFromTileGrid(layoutLayer, layout);
    } else {
      drawDungeonFloor(
        layoutLayer,
        layout.walkables,
        layout.rooms,
        layout.tileSize,
      );
    }

    if (!layout) return;
    for (const it of layout.interactables) {
      addInteractable(it);
    }
  }

  function drawOpenGrid(parent: Container) {
    const grid = new Graphics();
    const SIZE = 4000;
    const STEP = 80;
    grid.rect(-SIZE, -SIZE, SIZE * 2, SIZE * 2).fill({ color: 0x14171c });
    for (let x = -SIZE; x <= SIZE; x += STEP) {
      grid.moveTo(x, -SIZE).lineTo(x, SIZE);
    }
    for (let y = -SIZE; y <= SIZE; y += STEP) {
      grid.moveTo(-SIZE, y).lineTo(SIZE, y);
    }
    grid.stroke({ color: 0x232830, width: 1 });
    parent.addChild(grid);

    const origin = new Graphics();
    origin.circle(0, 0, 6).fill({ color: 0x6b7280 });
    parent.addChild(origin);
  }

  // Tile-grid-driven dungeon paint. Per-cell: floor tiles get
  // filled with the room/corridor's palette, wall tiles get an
  // outlined cell so template-stamped pillars / cave walls / doors
  // all show up in the top-down view. Falls back to the existing
  // walkables-based path when no grid is present.
  function drawDungeonFloorFromTileGrid(
    parent: Container,
    layout: SceneLayout,
  ): void {
    if (!layout.tileGrid) return;
    const grid = layout.tileGrid;
    const tiles = decodeTileGrid(grid);
    const tileSize = grid.tileSize;
    const rooms = layout.rooms;

    // Dark void background under everything.
    const voidBg = new Graphics();
    voidBg.rect(-6000, -6000, 12000, 12000).fill({ color: 0x05070a });
    parent.addChild(voidBg);

    // Per-cell floor fill. Cells inside an authored room rect get
    // the room's tint so chambers stay visually distinct; corridor
    // cells get the neutral fill.
    const floor = new Graphics();
    for (let ly = 0; ly < grid.height; ly++) {
      for (let lx = 0; lx < grid.width; lx++) {
        const id = tiles[ly * grid.width + lx];
        if (!isWalkableTileId(id)) continue;
        const wx = (grid.originTileX + lx) * tileSize;
        const wy = (grid.originTileY + ly) * tileSize;
        const cx = wx + tileSize / 2;
        const cy = wy + tileSize / 2;
        let color = 0x1f242c;
        for (const r of rooms) {
          if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
            color = roomFloorColor(r);
            break;
          }
        }
        floor.rect(wx, wy, tileSize, tileSize).fill({ color });
      }
    }
    parent.addChild(floor);

    // Tile gridlines on floor cells — same readability cue as the
    // rect-based path.
    const gridLines = new Graphics();
    for (let ly = 0; ly < grid.height; ly++) {
      for (let lx = 0; lx < grid.width; lx++) {
        if (!isWalkableTileId(tiles[ly * grid.width + lx])) continue;
        const wx = (grid.originTileX + lx) * tileSize;
        const wy = (grid.originTileY + ly) * tileSize;
        gridLines.rect(wx, wy, tileSize, tileSize);
      }
    }
    gridLines.stroke({ color: 0x2a313b, width: 1 });
    parent.addChild(gridLines);

    // Walls — outline every cell whose tile id isn't walkable AND
    // which has at least one walkable 4-neighbour. Skips the void
    // hinterland out at the dungeon edges.
    const walls = new Graphics();
    const isWalk = (lx: number, ly: number): boolean => {
      if (lx < 0 || ly < 0 || lx >= grid.width || ly >= grid.height) return false;
      return isWalkableTileId(tiles[ly * grid.width + lx]);
    };
    for (let ly = 0; ly < grid.height; ly++) {
      for (let lx = 0; lx < grid.width; lx++) {
        if (isWalk(lx, ly)) continue;
        if (
          !isWalk(lx - 1, ly) &&
          !isWalk(lx + 1, ly) &&
          !isWalk(lx, ly - 1) &&
          !isWalk(lx, ly + 1)
        ) {
          continue;
        }
        const wx = (grid.originTileX + lx) * tileSize;
        const wy = (grid.originTileY + ly) * tileSize;
        walls.rect(wx, wy, tileSize, tileSize).fill({ color: 0x252a32 });
      }
    }
    walls.stroke({ color: 0x3b4350, width: 1 });
    parent.addChild(walls);
  }

  function drawDungeonFloor(
    parent: Container,
    walkables: Rect[],
    rooms: Rect[],
    tileSize: number,
  ) {
    // Dark void background then lit walkable rects on top. Walls are the
    // implicit gap between rects.
    const voidBg = new Graphics();
    voidBg.rect(-6000, -6000, 12000, 12000).fill({ color: 0x05070a });
    parent.addChild(voidBg);

    // Default corridor / walkable fill — neutral. Rooms paint over with
    // a tinted variant so each chamber reads differently.
    const floor = new Graphics();
    for (const r of walkables) {
      floor.rect(r.x, r.y, r.w, r.h).fill({ color: 0x1f242c });
    }
    parent.addChild(floor);

    // Per-room tinted floors. Palette is derived from the room's stable
    // identity (its xy origin) so the same dungeon colours the same way
    // across clients on the same cycle.
    if (rooms.length > 0) {
      const tinted = new Graphics();
      for (const r of rooms) {
        tinted.rect(r.x, r.y, r.w, r.h).fill({ color: roomFloorColor(r) });
      }
      parent.addChild(tinted);
    }

    // Tile gridlines inside walkables — gives the floor a visible grid sense.
    if (tileSize > 0) {
      const grid = new Graphics();
      for (const r of walkables) {
        // Vertical lines.
        for (let x = r.x; x <= r.x + r.w; x += tileSize) {
          grid.moveTo(x, r.y).lineTo(x, r.y + r.h);
        }
        // Horizontal lines.
        for (let y = r.y; y <= r.y + r.h; y += tileSize) {
          grid.moveTo(r.x, y).lineTo(r.x + r.w, y);
        }
      }
      grid.stroke({ color: 0x2a313b, width: 1 });
      parent.addChild(grid);
    }

    // Walls — only draw segments where no neighbouring walkable extends past
    // the edge. This is the actual exterior boundary of the walkable union;
    // overlaps between rooms and corridors don't double-stroke.
    if (tileSize > 0) {
      drawExteriorWalls(parent, walkables, tileSize);
    }
  }

  function drawExteriorWalls(
    parent: Container,
    walkables: Rect[],
    tileSize: number,
  ) {
    const probe = tileSize * 0.25;
    const g = new Graphics();

    for (const r of walkables) {
      // Top edge — sample one tile at a time, draw only where the tile just
      // above is not inside another walkable.
      for (let x = r.x; x < r.x + r.w; x += tileSize) {
        const cx = x + tileSize / 2;
        if (!isInsideAny(walkables, cx, r.y - probe)) {
          g.moveTo(x, r.y).lineTo(Math.min(x + tileSize, r.x + r.w), r.y);
        }
      }
      // Bottom edge.
      for (let x = r.x; x < r.x + r.w; x += tileSize) {
        const cx = x + tileSize / 2;
        const yEdge = r.y + r.h;
        if (!isInsideAny(walkables, cx, yEdge + probe)) {
          g.moveTo(x, yEdge).lineTo(Math.min(x + tileSize, r.x + r.w), yEdge);
        }
      }
      // Left edge.
      for (let y = r.y; y < r.y + r.h; y += tileSize) {
        const cy = y + tileSize / 2;
        if (!isInsideAny(walkables, r.x - probe, cy)) {
          g.moveTo(r.x, y).lineTo(r.x, Math.min(y + tileSize, r.y + r.h));
        }
      }
      // Right edge.
      for (let y = r.y; y < r.y + r.h; y += tileSize) {
        const cy = y + tileSize / 2;
        const xEdge = r.x + r.w;
        if (!isInsideAny(walkables, xEdge + probe, cy)) {
          g.moveTo(xEdge, y).lineTo(xEdge, Math.min(y + tileSize, r.y + r.h));
        }
      }
    }

    g.stroke({ color: 0x3b4350, width: 2 });
    parent.addChild(g);
  }

  function addInteractable(it: Interactable) {
    if (interactables.has(it.id)) return;

    const container = new Container();
    container.position.set(it.x, it.y);

    const ring = new Graphics();
    const tint = it.kind === "extract_pad" ? 0xf97316 : 0x60a5fa;
    ring.circle(0, 0, 22).fill({ color: tint, alpha: 0.18 });
    ring.circle(0, 0, 22).stroke({ color: tint, width: 2 });
    container.addChild(ring);

    const inner = new Graphics();
    inner.circle(0, 0, 9).fill({ color: tint });
    container.addChild(inner);

    // Symbol — a small text glyph centred.
    const glyph = new Text({
      text: it.kind === "extract_pad" ? "↑" : "↓",
      style: {
        fill: "#0b0d10",
        fontSize: 14,
        fontWeight: "900",
        fontFamily: "system-ui, sans-serif",
      },
    });
    glyph.anchor.set(0.5);
    glyph.position.set(0, 0);
    container.addChild(glyph);

    const label = new Text({
      text: it.label,
      style: {
        fill: tint === 0xf97316 ? "#fde68a" : "#bfdbfe",
        fontSize: 11,
        fontFamily: "system-ui, sans-serif",
        stroke: { color: 0x000000, width: 3 },
      },
    });
    label.anchor.set(0.5, 0);
    label.position.set(0, 28);
    container.addChild(label);

    interactablesLayer.addChild(container);
    interactables.set(it.id, {
      data: it,
      container,
      spawnedAt: performance.now(),
    });
  }

  return {
    upsertPlayer(p: Player) {
      ifReady(() =>
        addOrUpdatePlayer(p, p.characterId === init.self.characterId),
      );
    },
    removePlayer(characterId: string) {
      const p = players.get(characterId);
      if (!p) return;
      playersLayer.removeChild(p.container);
      p.container.destroy({ children: true });
      players.delete(characterId);
    },
    movePlayer(characterId: string, x: number, y: number) {
      if (characterId === init.self.characterId) {
        // Server-authoritative position for self — drives the reconciliation.
        serverSelfX = x;
        serverSelfY = y;
        return;
      }
      const p = players.get(characterId);
      if (!p) return;
      p.targetX = x;
      p.targetY = y;
    },
    setPlayerHp(
      characterId: string,
      hp: number,
      maxHp: number,
      shield?: number,
      maxShield?: number,
    ) {
      const p = players.get(characterId);
      let damageAmount = 0;
      if (p) {
        const prevTotal = p.data.hp + (p.data.shield ?? 0);
        const newTotal = hp + (shield ?? 0);
        damageAmount = Math.max(0, prevTotal - newTotal);
        p.data.hp = hp;
        p.data.maxHp = maxHp;
        if (shield !== undefined) p.data.shield = shield;
        if (maxShield !== undefined) p.data.maxShield = maxShield;
        drawPlayerHpBar(p);
      }
      if (characterId === init.self.characterId) {
        // Damage delta drives screen shake + floating damage number.
        // We track lastSelfHp/Shield internally for this; the on-
        // screen HP/Shield bars come from React (HudOverlay).
        const prevTotal = lastSelfHp + lastSelfShield;
        const newTotal = hp + (shield ?? lastSelfShield);
        const selfDamage = Math.max(0, prevTotal - newTotal);
        lastSelfHp = hp;
        if (shield !== undefined) lastSelfShield = shield;
        if (selfDamage > 0) {
          triggerShake(Math.min(14, 4 + selfDamage * 0.3));
          spawnDamageNumber(selfX, selfY - 22, selfDamage, "#fca5a5");
        }
      } else if (damageAmount > 0 && p) {
        spawnDamageNumber(p.data.x, p.data.y - 22, damageAmount, "#fca5a5");
      }
    },
    setPlayerDead(characterId: string) {
      const p = players.get(characterId);
      if (p) {
        p.data.alive = false;
        p.data.hp = 0;
        const body = p.container.getChildAt(0) as Graphics;
        body.tint = DEAD_COLOR;
        drawPlayerHpBar(p);
      }
      if (characterId === init.self.characterId) {
        selfAlive = false;
        lastSelfHp = 0;
      }
    },
    respawnPlayer(
      characterId: string,
      x: number,
      y: number,
      hp: number,
      maxHp: number,
      stamina?: number,
      maxStamina?: number,
      shield?: number,
      maxShield?: number,
    ) {
      const p = players.get(characterId);
      if (p) {
        p.data.alive = true;
        p.data.hp = hp;
        p.data.maxHp = maxHp;
        p.data.x = x;
        p.data.y = y;
        p.targetX = x;
        p.targetY = y;
        p.container.position.set(x, y);
        const body = p.container.getChildAt(0) as Graphics;
        body.tint = 0xffffff;
        drawPlayerHpBar(p);
      }
      if (characterId === init.self.characterId) {
        selfX = x;
        selfY = y;
        serverSelfX = x;
        serverSelfY = y;
        lastSelfHp = hp;
        if (shield !== undefined) lastSelfShield = shield;
        selfAlive = true;
        lastSentInputX = 0;
        lastSentInputY = 0;
        // stamina/maxStamina/maxHp/maxShield args are unused now that
        // React owns the HP/Stamina/Shield bars — kept in the
        // signature for API stability.
        void stamina;
        void maxStamina;
        void maxHp;
        void maxShield;
      }
    },
    showWeaponSwung(
      characterId: string,
      weaponId: string,
      dirX: number,
      dirY: number,
    ) {
      const p = players.get(characterId);
      if (!p) return;
      // Per-weapon reach + colour. Mirrors MELEE_STATS in shared so
      // the visual matches what the server actually swept. Unknown
      // melee kinds fall back to knife defaults.
      const profile: Record<
        string,
        { reach: number; color: number; width: number }
      > = {
        knife:        { reach: 60, color: 0xe2e8f0, width: 4 },
        sword:        { reach: 90, color: 0xfde047, width: 5 },
        hammer:       { reach: 80, color: 0xf97316, width: 7 },
        energy_blade: { reach: 80, color: 0x22d3ee, width: 5 },
      };
      const v = profile[weaponId] ?? profile.knife;
      const len = Math.hypot(dirX, dirY) || 1;
      const ux = dirX / len;
      const uy = dirY / len;
      const slash = new Graphics();
      slash
        .moveTo(p.data.x + ux * 16, p.data.y + uy * 16)
        .lineTo(p.data.x + ux * v.reach, p.data.y + uy * v.reach)
        .stroke({ color: v.color, width: v.width });
      fxLayer.addChild(slash);
      particles.push({
        obj: slash,
        vx: 0,
        vy: 0,
        life: 160,
        age: 0,
        fadeOut: true,
      });
    },
    upsertEnemy(e: EnemyState) {
      addOrUpdateEnemy(e);
    },
    setEnemyPosition(id: string, x: number, y: number) {
      const e = enemies.get(id);
      if (!e) return;
      e.targetX = x;
      e.targetY = y;
    },
    setEnemyHp(id: string, hp: number, maxHp: number) {
      const e = enemies.get(id);
      if (!e) return;
      const damage = Math.max(0, e.data.hp - hp);
      e.data.hp = hp;
      e.data.maxHp = maxHp;
      drawEnemyHpBar(e);
      if (damage > 0) {
        e.flashUntil = performance.now() + 120;
        e.flashOverlay.alpha = 0.7;
        spawnDamageNumber(
          e.data.x,
          e.data.y - visualFor(e.data.kind).size,
          damage,
        );
      }
      // Hide on hp=0 so a V-cycle that happens between
      // enemy_damaged and enemy_killed doesn't carry the dead
      // sprite into the new renderer's snapshot.
      if (hp <= 0) {
        e.container.visible = false;
      }
    },
    removeEnemy(id: string) {
      const e = enemies.get(id);
      if (!e) return;
      const v = visualFor(e.data.kind);
      spawnDeathBurst(e.data.x, e.data.y, v.color);
      e.flashUntil = 0;
      e.flashOverlay.alpha = 0;
      // Drop hp to 0 so the LoS-visibility loop doesn't unhide the
      // sprite next frame (the open-scene branch keys on `hp > 0`).
      // Without this, surface horde enemies that get despawned at
      // perihelion-end stay visible on screen until the player
      // changes scene.
      e.data.hp = 0;
      e.container.visible = false;
    },
    spawnProjectile(p: ProjectileState) {
      addProjectile(p);
      // Muzzle flash for the local player. Server-driven so the
      // cadence is the real fire rate (varies per weapon + mods +
      // affixes) and empty-mag / reloading / no-reserve correctly
      // produce no flash. Per-pellet projectiles each call this — the
      // flash overlaps cleanly so a shotgun blast still looks fine.
      if (
        p.ownerKind === "player" &&
        p.ownerCharacterId === init.self.characterId
      ) {
        spawnMuzzleFlash(p.x, p.y, p.vx, p.vy);
      }
    },
    despawnProjectile(id: string) {
      const p = projectiles.get(id);
      if (!p) return;
      projectilesLayer.removeChild(p.graphic);
      p.graphic.destroy();
      projectiles.delete(id);
    },
    spawnLoot(l: LootState) {
      ifReady(() => addLoot(l));
    },
    despawnLoot(id: string) {
      const l = loot.get(id);
      if (!l) return;
      lootLayer.removeChild(l.container);
      l.container.destroy({ children: true });
      loot.delete(id);
    },
    spawnCorpse(c: CorpseState) {
      ifReady(() => addCorpse(c));
    },
    removeCorpse(id: string) {
      const c = corpses.get(id);
      if (!c) return;
      lootLayer.removeChild(c.container);
      c.container.destroy({ children: true });
      corpses.delete(id);
    },
    spawnBuilding(b: BuildingState) {
      ifReady(() => addBuilding(b));
    },
    setBuildingHp(id: string, hp: number, maxHp: number) {
      const b = buildings.get(id);
      if (!b) return;
      b.data.hp = hp;
      b.data.maxHp = maxHp;
      drawBuildingHpBar(b);
    },
    removeBuilding(id: string) {
      const b = buildings.get(id);
      if (!b) return;
      buildingsLayer.removeChild(b.container);
      b.container.destroy({ children: true });
      buildings.delete(id);
      buildingsVersion++;
    },
    spawnProp(p: PropState) {
      ifReady(() => addProp(p));
    },
    setPropHp(id: string, hp: number, maxHp: number) {
      const rp = props.get(id);
      if (!rp) return;
      rp.data.hp = hp;
      rp.data.maxHp = maxHp;
      // Hit-flash for visual feedback. No HP bar — props are
      // intentionally bar-less per the GDD design (sustained
      // chip-off communicates the breakage).
      rp.flashUntil = performance.now() + 120;
      rp.flashOverlay.alpha = 0.7;
      // Hide-on-zero in case prop_destroyed lands a tick later;
      // matches the same defence we added for enemy sprites.
      if (hp <= 0) rp.container.visible = false;
    },
    removeProp(id: string) {
      const rp = props.get(id);
      if (!rp) return;
      lootLayer.removeChild(rp.container);
      rp.container.destroy({ children: true });
      props.delete(id);
    },
    changeProp(p: PropState) {
      // Top-down renderer treats prop_changed like a respawn —
      // simplest correct behaviour for footprint / opened state
      // updates without bespoke wiring. Cheap; container props
      // change rarely.
      ifReady(() => {
        const rp = props.get(p.id);
        if (rp) {
          lootLayer.removeChild(rp.container);
          rp.container.destroy({ children: true });
          props.delete(p.id);
        }
        addProp(p);
      });
    },
    setBuildMode(kind: PlaceableBuildingKind | null) {
      buildKind = kind;
      if (kind !== null) mouseDown = false;
    },
    setBuildRadiusBonus(tiles: number) {
      buildRadiusBonus = Math.max(0, Math.floor(tiles));
    },
    setEquippedWeapon(weaponId) {
      equippedWeapon = weaponId;
      if (weaponId === null) mouseDown = false;
    },
    setHordeActive() {
      // Top-down renderer doesn't have a sky.
    },
    notifyReloadStarted() {
      // Top-down renderer doesn't show a view-model.
    },
    swapScene(state: SceneState) {
      currentSceneId = state.sceneId;
      ifReady(() => {
        // Tear down everything that doesn't belong to the new scene.
        for (const p of players.values())
          p.container.destroy({ children: true });
        players.clear();
        playersLayer.removeChildren();

        for (const e of enemies.values())
          e.container.destroy({ children: true });
        enemies.clear();
        enemiesLayer.removeChildren();

        for (const p of projectiles.values()) p.graphic.destroy();
        projectiles.clear();
        projectilesLayer.removeChildren();

        for (const l of loot.values()) l.container.destroy({ children: true });
        loot.clear();
        for (const c of corpses.values())
          c.container.destroy({ children: true });
        corpses.clear();
        lootLayer.removeChildren();

        for (const b of buildings.values())
          b.container.destroy({ children: true });
        buildings.clear();
        buildingsLayer.removeChildren();

        for (const rp of props.values())
          rp.container.destroy({ children: true });
        props.clear();

        // FX particles outlive scene boundaries visually but get cleared so
        // residual numbers from the previous scene don't float into this one.
        for (const p of particles) p.obj.destroy({ children: true });
        particles.length = 0;
        fxLayer.removeChildren();

        renderLayout(state.layout);

        // Reset self position to whatever the server says.
        selfX = state.self.x;
        selfY = state.self.y;
        serverSelfX = state.self.x;
        serverSelfY = state.self.y;
        lastSelfHp = state.self.hp;
        lastSelfShield = state.self.shield;
        selfAlive = state.self.alive;

        // Repopulate from the new scene's state.
        addOrUpdatePlayer(state.self, true);
        for (const o of state.players) addOrUpdatePlayer(o, false);
        for (const e of state.enemies) addOrUpdateEnemy(e);
        for (const p of state.projectiles) addProjectile(p);
        for (const l of state.loot) addLoot(l);
        for (const c of state.corpses) addCorpse(c);
        for (const b of state.buildings) addBuilding(b);
        for (const p of state.props) addProp(p);
        // Build mode is surface-only; if the new scene has no grid, exit it.
        if ((state.layout?.tileSize ?? 0) <= 0) buildKind = null;
      });
    },
    getMinimapSnapshot(): MinimapSnapshot {
      return {
        selfX,
        selfY,
        selfId: init.self.characterId,
        tileSize: currentLayout?.tileSize ?? 32,
        walkables: currentLayout?.walkables ?? [],
        rooms: currentLayout?.rooms,
        roomCategories: currentLayout?.roomCategories,
        buildings: buildingsToMinimapList(
          [...buildings.values()].map((rb) => rb.data),
        ),
        players: [...players.values()].map((p) => ({
          characterId: p.data.characterId,
          x: p.data.x,
          y: p.data.y,
          visible: p.container.visible,
        })),
        enemies: [...enemies.values()].map((e) => ({
          x: e.data.x,
          y: e.data.y,
          hp: e.data.hp,
          visible: e.container.visible,
        })),
      };
    },
    getSelfPosition() {
      return { x: selfX, y: selfY };
    },
    nearbyPlayers(radiusPx: number) {
      const r2 = radiusPx * radiusPx;
      const out: { characterId: string; displayName: string; dsq: number }[] =
        [];
      for (const p of players.values()) {
        if (p.data.characterId === init.self.characterId) continue;
        const dx = p.data.x - selfX;
        const dy = p.data.y - selfY;
        const dsq = dx * dx + dy * dy;
        if (dsq <= r2) {
          out.push({
            characterId: p.data.characterId,
            displayName: p.data.displayName,
            dsq,
          });
        }
      }
      out.sort((a, b) => a.dsq - b.dsq);
      return out.map((o) => ({
        characterId: o.characterId,
        displayName: o.displayName,
      }));
    },
    currentSceneState(): SceneState {
      // Snapshot all entities for hot-swapping into the FPS renderer (or
      // back). `self` is reconstructed from the players map keyed by our
      // own characterId.
      const selfRendered = players.get(init.self.characterId);
      const self: Player = selfRendered
        ? { ...selfRendered.data }
        : { ...init.self };
      const otherPlayers: Player[] = [];
      for (const p of players.values()) {
        if (p.data.characterId === init.self.characterId) continue;
        otherPlayers.push({ ...p.data });
      }
      return {
        sceneId: currentSceneId,
        self,
        players: otherPlayers,
        enemies: [...enemies.values()].map((e) => ({ ...e.data })),
        projectiles: [...projectiles.values()].map((p) => ({ ...p.data })),
        loot: [...loot.values()].map((l) => ({ ...l.data })),
        corpses: [...corpses.values()].map((c) => ({ ...c.data })),
        buildings: [...buildings.values()].map((b) => ({ ...b.data })),
        props: [...props.values()].map((rp) => ({ ...rp.data })),
        layout: currentLayout,
      };
    },
    destroy() {
      destroyed = true;
      unsubOverrides();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mouseup", onMouseUp);
      try {
        const canvas = app.canvas as HTMLCanvasElement;
        canvas?.removeEventListener("mousemove", onMouseMove);
        canvas?.removeEventListener("mousedown", onMouseDown);
        canvas?.removeEventListener("contextmenu", onContextMenu);
        app.destroy(true, { children: true });
      } catch {
        // ignore
      }
      players.clear();
      enemies.clear();
      projectiles.clear();
      loot.clear();
      corpses.clear();
      buildings.clear();
      props.clear();
      for (const it of interactables.values())
        it.container.destroy({ children: true });
      interactables.clear();
    },
  };
}
