// Wolfenstein-style raycasting renderer for DÛM RUNNER.
//
// Drop-in alternative to the top-down `runGame` in pixi.ts. Implements the
// same GameHandle interface so Game.tsx can pick which one to run without
// any other changes (URL param `?fps=1` for now; user-facing toggle lands
// in Phase 6 of the FPS plan).
//
// Phase 1 scope:
//   • Pixi Application with a single Graphics layer drawn to screen-space
//     (no world container — the camera IS the screen).
//   • Pointer-lock mouse-look, yaw only (Wolf3D-style; no pitch).
//   • Per-column raycast against scene walkables + player-placed buildings.
//   • Sky + floor as flat color rects above/below the wall slices.
//   • WASD passthrough as raw world-space input. Yaw-relative input + click
//     fire land in Phase 3.
//   • All other entity render methods are stubs that just track state, so
//     the GameHandle contract is honoured but enemies/loot/sprites are
//     invisible until Phase 2.
//
// The raycaster uses a fixed-step ray-march on the tile grid rather than
// classic DDA because walkable areas are arbitrary axis-aligned rectangles
// (rooms + corridors of varying size), not a 1-bit grid map. Step is small
// enough (TILE/4) that wall hit positions look pixel-stable.

import { Application, Container, Graphics } from 'pixi.js';
import type {
  BuildingState,
  CorpseState,
  EnemyState,
  LootState,
  Player,
  ProjectileState,
  SceneLayout,
} from '@dumrunner/shared';
import { isInsideAny } from '@dumrunner/shared';
import type { GameHandle, GameInit, SceneState } from './pixi';

// ---------- tuning ----------
const FOV = (Math.PI / 180) * 70; // 70deg horizontal FOV
const COLUMN_STEP_PX = 2; // 1 ray per 2 screen pixels (downsample for perf)
const RAY_STEP_PX = 8; // ray-march step. Smaller = sharper hits, costlier.
const RAY_MAX_DIST = 1500;
const WALL_HEIGHT_WORLD = 64; // arbitrary world units. Tunes apparent wall scale.
const POINTER_SENSITIVITY = 0.0025; // rad per mouse pixel

// Sky / floor colours (placeholder — Phase 4 makes the surface horizon nicer).
const SKY_COLOR = 0x1a2332;
const FLOOR_COLOR = 0x2a2622;
// Wall faces: NS (north/south) shaded slightly darker than EW for depth cue.
const WALL_COLOR_EW = 0x6b6b73;
const WALL_COLOR_NS = 0x4f4f57;
// Player buildings render in their own colour so they read as "yours."
const BUILDING_WALL_COLOR_EW = 0x9a9aa3;
const BUILDING_WALL_COLOR_NS = 0x747480;

export function runFpsGame(host: HTMLElement, init: GameInit): GameHandle {
  const app = new Application();
  let ready = false;

  // ---------- entity state (mirrors what pixi.ts tracks) ----------
  const players = new Map<string, Player>();
  const enemies = new Map<string, EnemyState>();
  const loot = new Map<string, LootState>();
  const corpses = new Map<string, CorpseState>();
  const buildings = new Map<string, BuildingState>();
  const projectiles = new Map<string, ProjectileState>();

  for (const p of [init.self, ...init.others]) players.set(p.characterId, p);
  for (const e of init.enemies) enemies.set(e.id, e);
  for (const l of init.loot) loot.set(l.id, l);
  for (const c of init.corpses) corpses.set(c.id, c);
  for (const b of init.buildings) buildings.set(b.id, b);
  for (const p of init.projectiles) projectiles.set(p.id, p);

  let layout: SceneLayout | null = init.layout;
  let selfX = init.self.x;
  let selfY = init.self.y;
  let yaw = 0;

  // ---------- input state ----------
  const keys = new Set<string>();
  let pointerLocked = false;

  // ---------- lifecycle ----------
  const root = new Container();
  const wallLayer = new Graphics();
  root.addChild(wallLayer);

  const initPromise = app
    .init({
      background: SKY_COLOR,
      antialias: false,
      resolution: 1,
      resizeTo: host,
    })
    .then(() => {
      host.appendChild(app.canvas);
      app.stage.addChild(root);
      app.canvas.style.cursor = 'crosshair';
      app.ticker.add(tick);
      attachInputListeners();
      ready = true;
    });

  // ---------- input wiring ----------
  function attachInputListeners() {
    app.canvas.addEventListener('click', onCanvasClick);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }
  function detachInputListeners() {
    app.canvas.removeEventListener('click', onCanvasClick);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  }

  function onCanvasClick() {
    if (!pointerLocked) {
      app.canvas.requestPointerLock?.();
    }
  }
  function onPointerLockChange() {
    pointerLocked = document.pointerLockElement === app.canvas;
  }
  function onMouseMove(e: MouseEvent) {
    if (!pointerLocked) return;
    yaw = (yaw + e.movementX * POINTER_SENSITIVITY) % (Math.PI * 2);
  }
  function onKeyDown(e: KeyboardEvent) {
    keys.add(e.code);
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.code);
  }

  // Walk the keyboard state, emit `input` at the same cadence as pixi.ts
  // (every frame; the wire layer dedupes). Phase 1 sends raw world-space
  // input so the player can walk around to verify the raycaster from
  // multiple angles. Phase 3 rotates this by yaw so WASD becomes
  // forward/strafe relative to facing.
  function tickInput() {
    let mx = 0;
    let my = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    init.sendInput(mx, my, sprint);
  }

  // ---------- per-frame tick ----------
  function tick() {
    if (!ready) return;
    tickInput();
    render();
  }

  // ---------- raycaster ----------
  function render() {
    const W = app.screen.width;
    const H = app.screen.height;
    const halfH = H / 2;

    wallLayer.clear();

    // Sky (top half) + floor (bottom half) — flat colours for now. Phase 4
    // turns the surface into a gradient horizon.
    wallLayer.rect(0, 0, W, halfH).fill({ color: SKY_COLOR });
    wallLayer.rect(0, halfH, W, halfH).fill({ color: FLOOR_COLOR });

    // Per-column raycast.
    const numCols = Math.ceil(W / COLUMN_STEP_PX);
    const halfFov = FOV / 2;
    for (let i = 0; i < numCols; i++) {
      const screenX = i * COLUMN_STEP_PX;
      // -1..1 across the screen.
      const camNorm = (2 * screenX) / W - 1;
      // Linear FOV mapping (slight fish-eye but acceptable; correct via
      // perpendicular distance below).
      const rayAngle = yaw + camNorm * halfFov;

      const hit = castRay(selfX, selfY, rayAngle);
      if (!hit) continue;

      // Fish-eye correction: project distance onto camera forward vector so
      // walls at the edges don't bow.
      const perp = hit.dist * Math.cos(camNorm * halfFov);
      if (perp <= 0.0001) continue;

      const lineH = (WALL_HEIGHT_WORLD * H) / perp;
      const top = halfH - lineH / 2;

      const color = hit.isBuilding
        ? hit.faceNS
          ? BUILDING_WALL_COLOR_NS
          : BUILDING_WALL_COLOR_EW
        : hit.faceNS
          ? WALL_COLOR_NS
          : WALL_COLOR_EW;

      wallLayer.rect(screenX, top, COLUMN_STEP_PX, lineH).fill({ color });
    }
  }

  type RayHit = { dist: number; faceNS: boolean; isBuilding: boolean };

  function castRay(ox: number, oy: number, angle: number): RayHit | null {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    if (!layout) return null;
    const walkables = layout.walkables;
    const tileSize = layout.tileSize;

    // Trace forward in fixed steps. We track sign of (newX - oldX) and
    // (newY - oldY) to decide which face we crossed at the hit — used for
    // the NS/EW shading cue.
    let x = ox;
    let y = oy;
    let prevX = x;
    let prevY = y;
    const maxSteps = Math.ceil(RAY_MAX_DIST / RAY_STEP_PX);
    for (let s = 0; s < maxSteps; s++) {
      prevX = x;
      prevY = y;
      x += dx * RAY_STEP_PX;
      y += dy * RAY_STEP_PX;

      // Wall hit: outside ALL walkables, OR inside a building footprint.
      const insideWalkable =
        walkables.length === 0 ? true : isInsideAny(walkables, x, y);
      const blockedByBuilding = isInsideAnyBuilding(x, y, tileSize);

      if (!insideWalkable || blockedByBuilding) {
        const dist = Math.hypot(x - ox, y - oy);
        // Cheap face heuristic: which axis crossed a tile boundary between
        // prev and current step.
        const tprev = Math.floor(prevX / Math.max(1, tileSize));
        const tcur = Math.floor(x / Math.max(1, tileSize));
        const tprevY = Math.floor(prevY / Math.max(1, tileSize));
        const tcurY = Math.floor(y / Math.max(1, tileSize));
        const xCrossed = tprev !== tcur;
        const yCrossed = tprevY !== tcurY;
        const faceNS = yCrossed && !xCrossed;
        return { dist, faceNS, isBuilding: blockedByBuilding };
      }
    }
    return null;
  }

  function isInsideAnyBuilding(x: number, y: number, tileSize: number): boolean {
    if (buildings.size === 0 || tileSize <= 0) return false;
    for (const b of buildings.values()) {
      const px = b.tileX * tileSize;
      const py = b.tileY * tileSize;
      const pw = b.width * tileSize;
      const ph = b.height * tileSize;
      if (x >= px && x <= px + pw && y >= py && y <= py + ph) return true;
    }
    return false;
  }

  // ---------- GameHandle implementation ----------

  function applySceneState(state: SceneState) {
    layout = state.layout;
    players.clear();
    enemies.clear();
    loot.clear();
    corpses.clear();
    buildings.clear();
    projectiles.clear();
    for (const p of [state.self, ...state.players]) players.set(p.characterId, p);
    for (const e of state.enemies) enemies.set(e.id, e);
    for (const l of state.loot) loot.set(l.id, l);
    for (const c of state.corpses) corpses.set(c.id, c);
    for (const b of state.buildings) buildings.set(b.id, b);
    for (const p of state.projectiles) projectiles.set(p.id, p);
    selfX = state.self.x;
    selfY = state.self.y;
  }

  return {
    upsertPlayer(p) {
      players.set(p.characterId, p);
      if (p.characterId === init.self.characterId) {
        selfX = p.x;
        selfY = p.y;
      }
    },
    removePlayer(characterId) {
      players.delete(characterId);
    },
    movePlayer(characterId, x, y) {
      if (characterId === init.self.characterId) {
        selfX = x;
        selfY = y;
      }
      const p = players.get(characterId);
      if (p) {
        p.x = x;
        p.y = y;
      }
    },
    setPlayerHp(characterId, hp, maxHp, shield, maxShield) {
      const p = players.get(characterId);
      if (!p) return;
      p.hp = hp;
      p.maxHp = maxHp;
      if (shield !== undefined) p.shield = shield;
      if (maxShield !== undefined) p.maxShield = maxShield;
    },
    setSelfStamina() {
      // No HUD in the FPS view yet — the React HUD overlay handles it.
    },
    setPlayerDead(characterId) {
      const p = players.get(characterId);
      if (p) p.alive = false;
    },
    respawnPlayer(characterId, x, y, hp, maxHp, stamina, maxStamina, shield, maxShield) {
      const p = players.get(characterId);
      if (!p) return;
      p.x = x;
      p.y = y;
      p.hp = hp;
      p.maxHp = maxHp;
      p.alive = true;
      if (stamina !== undefined) p.stamina = stamina;
      if (maxStamina !== undefined) p.maxStamina = maxStamina;
      if (shield !== undefined) p.shield = shield;
      if (maxShield !== undefined) p.maxShield = maxShield;
      if (characterId === init.self.characterId) {
        selfX = x;
        selfY = y;
      }
    },
    showWeaponSwung() {
      // Phase 3 will overlay a swing arc / muzzle flash.
    },
    upsertEnemy(e) {
      enemies.set(e.id, e);
    },
    setEnemyPosition(id, x, y) {
      const e = enemies.get(id);
      if (e) {
        e.x = x;
        e.y = y;
      }
    },
    setEnemyHp(id, hp, maxHp) {
      const e = enemies.get(id);
      if (e) {
        e.hp = hp;
        e.maxHp = maxHp;
      }
    },
    removeEnemy(id) {
      enemies.delete(id);
    },
    spawnProjectile(p) {
      projectiles.set(p.id, p);
    },
    despawnProjectile(id) {
      projectiles.delete(id);
    },
    spawnLoot(l) {
      loot.set(l.id, l);
    },
    despawnLoot(id) {
      loot.delete(id);
    },
    spawnCorpse(c) {
      corpses.set(c.id, c);
    },
    removeCorpse(id) {
      corpses.delete(id);
    },
    spawnBuilding(b) {
      buildings.set(b.id, b);
    },
    setBuildingHp(id, hp, maxHp) {
      const b = buildings.get(id);
      if (b) {
        b.hp = hp;
        b.maxHp = maxHp;
      }
    },
    removeBuilding(id) {
      buildings.delete(id);
    },
    setBuildMode() {
      // Phase 5 implements the floor-reticle ray pick.
    },
    setEquippedWeapon() {
      // Phase 3 gates fire/swing on this.
    },
    swapScene(state) {
      applySceneState(state);
    },
    destroy() {
      detachInputListeners();
      if (document.pointerLockElement === app.canvas) {
        document.exitPointerLock?.();
      }
      app.ticker.remove(tick);
      void initPromise.then(() => {
        if (app.canvas.parentElement === host) host.removeChild(app.canvas);
        app.destroy(true, { children: true });
      });
    },
  };
}

