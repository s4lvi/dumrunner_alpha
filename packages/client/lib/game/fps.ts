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

import { Application, Container, Graphics, Text } from 'pixi.js';
import type {
  BuildingState,
  CorpseState,
  EnemyState,
  LootState,
  Player,
  ProjectileState,
  SceneLayout,
} from '@dumrunner/shared';
import {
  enemyVisualFor,
  isInsideAny,
  materialTint,
  TIER_COLORS_NUM,
} from '@dumrunner/shared';
import type { GameHandle, GameInit, SceneState } from './pixi';

// ---------- tuning ----------
const FOV = (Math.PI / 180) * 70; // 70deg horizontal FOV
const COLUMN_STEP_PX = 1; // 1 ray per pixel — sharpest possible.
const RAY_MAX_DIST = 1500;
const WALL_HEIGHT_WORLD = 64; // arbitrary world units. Tunes apparent wall scale.
const POINTER_SENSITIVITY = 0.0025; // rad per mouse pixel

// Wall faces: NS (north/south) shaded slightly darker than EW for depth cue.
const WALL_COLOR_EW = 0x6b6b73;
const WALL_COLOR_NS = 0x4f4f57;
// Player buildings render in their own colour so they read as "yours."
const BUILDING_WALL_COLOR_EW = 0x9a9aa3;
const BUILDING_WALL_COLOR_NS = 0x747480;

// Per-scene horizon palette. Sky fades from `skyTop` (zenith) down to
// `skyBottom` (horizon line); floor fades from `floorTop` (horizon) down
// to `floorBottom` (under the player). The horizon colour also drives the
// distance fog — walls and sprites blend toward it as they recede so the
// far cut doesn't hard-edge.
type ScenePalette = {
  skyTop: number;
  skyBottom: number;
  floorTop: number;
  floorBottom: number;
  fog: number;
};
const SURFACE_PALETTE: ScenePalette = {
  skyTop: 0x0d1733,
  skyBottom: 0xc46b3a, // dusty orange dusk
  floorTop: 0x5a2f1a, // rust band at horizon
  floorBottom: 0x1d1109, // dark soil under the camera
  fog: 0xa05530, // desaturated horizon orange
};
const DUNGEON_PALETTE: ScenePalette = {
  skyTop: 0x000000,
  skyBottom: 0x171823,
  floorTop: 0x231f1c,
  floorBottom: 0x080808,
  fog: 0x121218,
};

// Distance at which fog fully saturates. Sprites and walls past this look
// the same as the horizon and effectively vanish.
const FOG_FULL_DIST = 1100;
const SKY_GRADIENT_STEPS = 14;
const FLOOR_GRADIENT_STEPS = 10;

// Build-mode tuning.
const BUILD_RADIUS_TILES = 3;
// Distance from the camera to the build reticle along the forward vector.
// 1.5 tiles puts the ghost just past the player so they can drop a wall
// right in front of them; bumping it higher means farther but flakier
// targeting against rotation.
const BUILD_REACH_TILES = 1.5;
const BUILD_GHOST_VALID_COLOR = 0x22c55e;
const BUILD_GHOST_INVALID_COLOR = 0xef4444;

// Player + corpse + projectile billboard sizes/colors live here. All
// other render constants (enemy visuals, material tint, part tier
// colors) come from @dumrunner/shared/visuals so the FPS view stays
// in sync with the top-down view.
const PLAYER_OTHER_COLOR = 0x4dd0e1;
const PLAYER_SIZE = 14;
const CORPSE_COLOR = 0x4a1d1d;
const CORPSE_SIZE = 14;
const PROJECTILE_DEFAULT_COLOR = 0xfde047;

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
  // Server only emits projectile_spawned + projectile_despawned; the client
  // extrapolates motion locally using vx/vy from spawn time. Mirrors the
  // top-down renderer's RenderedProjectile.spawnedAt.
  const projectileSpawnedAt = new Map<string, number>();

  for (const p of [init.self, ...init.others]) players.set(p.characterId, p);
  for (const e of init.enemies) enemies.set(e.id, e);
  for (const l of init.loot) loot.set(l.id, l);
  for (const c of init.corpses) corpses.set(c.id, c);
  for (const b of init.buildings) buildings.set(b.id, b);
  for (const p of init.projectiles) {
    projectiles.set(p.id, p);
    projectileSpawnedAt.set(p.id, performance.now());
  }

  let layout: SceneLayout | null = init.layout;
  let selfX = init.self.x;
  let selfY = init.self.y;
  let yaw = 0;
  // Pseudo-pitch (radians). Doom-style: doesn't rotate the actual rays —
  // just slides the horizon line up/down so you can aim at floor or
  // ceiling. Positive = looking down, negative = looking up. Clamped to
  // ±60° so the world doesn't flip.
  let pitch = 0;
  const PITCH_LIMIT = (Math.PI / 180) * 60;

  // ---------- input state ----------
  const keys = new Set<string>();
  let pointerLocked = false;
  let mouseDown = false;
  let equippedWeapon:
    | 'pistol'
    | 'smg'
    | 'shotgun'
    | 'rifle'
    | 'knife'
    | null = null;
  // Brief muzzle-flash window so the crosshair pulses on every fire frame.
  let lastFireFlashAt = 0;
  // Damage feedback: full-screen red tint on self damage, per-enemy white
  // flash on hit. Both are timestamps; renderer compares to performance.now().
  let selfLastDamageAt = 0;
  let selfLastHp = init.self.hp;
  const enemyHitAt = new Map<string, number>();
  // Build mode: kind to place, or null when not building. Pending action is
  // resolved during the next render so a click reads the latest target tile.
  let buildKind: import('@dumrunner/shared').BuildingKind | null = null;
  let buildRadiusBonus = 0;
  let pendingBuildAction: 'place' | 'demolish' | null = null;

  // ---------- lifecycle ----------
  const root = new Container();
  const wallLayer = new Graphics();
  const spriteLayer = new Graphics();
  const hudLayer = new Graphics();
  // Inline X/Y labels rendered on top of each status bar.
  const hpText = new Text({
    text: '',
    style: {
      fill: '#ffffff',
      fontSize: 11,
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 'bold',
      stroke: { color: '#000000', width: 2 },
    },
  });
  const staminaText = new Text({
    text: '',
    style: {
      fill: '#fef3c7',
      fontSize: 9,
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 'bold',
      stroke: { color: '#000000', width: 2 },
    },
  });
  const shieldText = new Text({
    text: '',
    style: {
      fill: '#cffafe',
      fontSize: 9,
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 'bold',
      stroke: { color: '#000000', width: 2 },
    },
  });
  hpText.anchor.set(0.5, 0.5);
  staminaText.anchor.set(0.5, 0.5);
  shieldText.anchor.set(0.5, 0.5);
  root.addChild(wallLayer);
  root.addChild(spriteLayer);
  root.addChild(hudLayer);
  root.addChild(hpText);
  root.addChild(staminaText);
  root.addChild(shieldText);

  // Per-column perpendicular distance to the wall hit. Indexed by column
  // (i = screenX / COLUMN_STEP_PX). Sprites z-test against this so a wall
  // in front of an enemy occludes the enemy.
  let zBuffer: Float32Array = new Float32Array(0);

  const initPromise = app
    .init({
      background: 0x000000,
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
    app.canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);
    app.canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }
  function detachInputListeners() {
    app.canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('mousemove', onMouseMove);
    app.canvas.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  }

  function onMouseDown(e: MouseEvent) {
    if (!pointerLocked) {
      app.canvas.requestPointerLock?.();
      // Don't fire on the very click that's just acquiring the lock —
      // matches the FPS-genre "click to engage, click to shoot" feel.
      return;
    }
    if (e.button === 0) {
      // In build mode, left-click = place. Otherwise it's hold-to-fire.
      if (buildKind !== null) {
        pendingBuildAction = 'place';
      } else {
        mouseDown = true;
      }
    } else if (e.button === 2 && buildKind !== null) {
      // Right-click in build mode = demolish target.
      pendingBuildAction = 'demolish';
    }
  }
  function onMouseUp(e: MouseEvent) {
    if (e.button === 0) mouseDown = false;
  }
  function onContextMenu(e: MouseEvent) {
    // Always swallow the browser menu so right-clicks in build mode are
    // exclusively a "demolish" gesture.
    e.preventDefault();
  }
  function onPointerLockChange() {
    pointerLocked = document.pointerLockElement === app.canvas;
  }
  function onMouseMove(e: MouseEvent) {
    if (!pointerLocked) return;
    yaw = (yaw + e.movementX * POINTER_SENSITIVITY) % (Math.PI * 2);
    // Y-axis: mouse-down = look-down. movementY is positive when the mouse
    // moves down on screen; in our coord system pitch>0 = looking up, so
    // we subtract. Pitch is faux (horizon shift only) so over-tilting
    // just slides the world off-screen — clamp tightly.
    pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, pitch - e.movementY * POINTER_SENSITIVITY)
    );
  }
  function isFormFocus(): boolean {
    const ae = document.activeElement;
    return (
      ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement
    );
  }
  function onKeyDown(e: KeyboardEvent) {
    if (isFormFocus()) return;
    keys.add(e.code);
  }
  function onKeyUp(e: KeyboardEvent) {
    if (isFormFocus()) return;
    keys.delete(e.code);
  }

  // Yaw-relative WASD: W/S = forward/back along facing, D/A = strafe right/
  // left. We rotate the unit input vector into world space before handing
  // it to the server, which still treats moveX/moveY as a world-space
  // direction (no protocol change).
  function tickInput() {
    const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
              - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const right = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
                - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    // y-down world coords: forward = (cos, sin); right = (-sin, cos).
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const mx = fwd * cy + right * -sy;
    const my = fwd * sy + right * cy;
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    init.sendInput(mx, my, sprint);

    // Hold-to-fire while pointer-locked + a weapon equipped. Server
    // gates by per-weapon fire interval, magazine, and reload state,
    // so we send every frame and let it drop the noise. The crosshair
    // flash is driven off projectile_spawned (see spawnProjectile
    // below) so empty-mag / reloading frames don't flash.
    if (mouseDown && pointerLocked && equippedWeapon !== null) {
      init.sendFire(cy, sy);
    }
  }

  // ---------- per-frame tick ----------
  function tick() {
    if (!ready) return;
    tickInput();
    updateNearInteractable();
    updateNearStations();
    render();
  }

  // ---------- proximity callbacks (parity with the top-down renderer) ----------

  let lastNearInteractableId: string | null = null;
  function updateNearInteractable() {
    const layout_ = layout;
    if (!layout_ || layout_.interactables.length === 0) {
      if (lastNearInteractableId !== null) {
        lastNearInteractableId = null;
        init.onNearInteractableChanged(null);
      }
      return;
    }
    const r = 60; // matches INTERACTABLE_RADIUS on the server + top-down
    const r2 = r * r;
    let bestId: string | null = null;
    let bestLabel: string | null = null;
    let bestDistSq = r2;
    for (const it of layout_.interactables) {
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
        bestId && bestLabel ? { id: bestId, label: bestLabel } : null
      );
    }
  }

  // Workstation + artifact-uplink proximity. Mirrors pixi's
  // updateNearWorkstations so the React HUD lights up the right recipes
  // / trade prompts in either view.
  const STATION_RANGE = 96;
  let lastStationKey = '';
  function updateNearStations() {
    if (!layout || layout.tileSize <= 0 || buildings.size === 0) {
      if (lastStationKey !== '') {
        lastStationKey = '';
        init.onNearWorkstationsChanged({
          all: [],
          nearest: null,
          nearestDoorId: null,
          nearestChestId: null,
        });
      }
      return;
    }
    const tileSize = layout.tileSize;
    const r2 = STATION_RANGE * STATION_RANGE;
    const found = new Set<import('@dumrunner/shared').BuildingKind>();
    let nearestKind: import('@dumrunner/shared').BuildingKind | null = null;
    let nearestDsq = Infinity;
    let nearestDoorId: string | null = null;
    let nearestDoorDsq = Infinity;
    let nearestChestId: string | null = null;
    let nearestChestDsq = Infinity;
    for (const b of buildings.values()) {
      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;
      const halfW = (b.width * tileSize) / 2;
      const halfH = (b.height * tileSize) / 2;
      const dx = Math.max(Math.abs(selfX - cx) - halfW, 0);
      const dy = Math.max(Math.abs(selfY - cy) - halfH, 0);
      const dsq = dx * dx + dy * dy;
      if (b.kind === 'door') {
        if (dsq <= r2 && dsq < nearestDoorDsq) {
          nearestDoorDsq = dsq;
          nearestDoorId = b.id;
        }
        continue;
      }
      if (
        b.kind !== 'workbench' &&
        b.kind !== 'forge' &&
        b.kind !== 'electronics_bench' &&
        b.kind !== 'weapon_bench' &&
        b.kind !== 'artifact_uplink' &&
        b.kind !== 'storage_chest'
      ) {
        continue;
      }
      if (dsq <= r2) {
        found.add(b.kind);
        if (dsq < nearestDsq) {
          nearestDsq = dsq;
          nearestKind = b.kind;
        }
        if (b.kind === 'storage_chest' && dsq < nearestChestDsq) {
          nearestChestDsq = dsq;
          nearestChestId = b.id;
        }
      }
    }
    const key =
      [...found].sort().join(',') +
      '|' +
      (nearestKind ?? '') +
      '|' +
      (nearestDoorId ?? '') +
      '|' +
      (nearestChestId ?? '');
    if (key !== lastStationKey) {
      lastStationKey = key;
      init.onNearWorkstationsChanged({
        all: [...found],
        nearest: nearestKind,
        nearestDoorId,
        nearestChestId,
      });
    }
  }

  // ---------- raycaster ----------
  function render() {
    const W = app.screen.width;
    const H = app.screen.height;
    // Pitch shifts the horizon line up/down. Walls + sprites + the sky/
    // floor gradient boundary all hang off this y-coordinate.
    const pitchPixels = (pitch * H) / FOV;
    const horizonY = Math.max(0, Math.min(H, H / 2 + pitchPixels));

    wallLayer.clear();
    spriteLayer.clear();

    // Per-scene horizon palette: bright dusk on the surface, dark void in
    // a dungeon. Both gradients meet at the horizon line so walls & sprites
    // can fog into the same colour as they recede.
    const palette = paletteForScene();
    if (horizonY > 0) {
      drawVerticalGradient(
        wallLayer,
        0,
        0,
        W,
        horizonY,
        palette.skyTop,
        palette.skyBottom,
        SKY_GRADIENT_STEPS
      );
    }
    if (horizonY < H) {
      drawVerticalGradient(
        wallLayer,
        0,
        horizonY,
        W,
        H - horizonY,
        palette.floorTop,
        palette.floorBottom,
        FLOOR_GRADIENT_STEPS
      );
    }

    // Per-column raycast. Uses camera-plane rays (Lode-style) rather than
    // an angular sweep so wall projection is linear-in-screen-x and the
    // close-range curvature at the edges of the FOV disappears. Matches
    // the sprite pass below so they share the same camera model exactly.
    const numCols = Math.ceil(W / COLUMN_STEP_PX);
    const halfFov = FOV / 2;
    const halfPlane = Math.tan(halfFov);
    const dirX = Math.cos(yaw);
    const dirY = Math.sin(yaw);
    const planeX = -dirY * halfPlane;
    const planeY = dirX * halfPlane;
    if (zBuffer.length !== numCols) zBuffer = new Float32Array(numCols);
    zBuffer.fill(Infinity);

    for (let i = 0; i < numCols; i++) {
      const screenX = i * COLUMN_STEP_PX;
      const camNorm = (2 * screenX) / W - 1;
      // rayDir = dir + plane * camNorm. Length isn't 1 (longest at edges),
      // so normalize for the fixed-step ray-march.
      const rdx = dirX + planeX * camNorm;
      const rdy = dirY + planeY * camNorm;
      const rlen = Math.hypot(rdx, rdy);
      const ux = rdx / rlen;
      const uy = rdy / rlen;

      const hit = castRay(selfX, selfY, ux, uy);
      if (!hit) continue;

      // Perp distance = projection of the hit onto the camera forward axis.
      // Removes fish-eye exactly (no cos approximation needed).
      const perp = hit.dist * (ux * dirX + uy * dirY);
      if (perp <= 0.0001) continue;
      zBuffer[i] = perp;

      const lineH = (WALL_HEIGHT_WORLD * H) / perp;
      const top = horizonY - lineH / 2;

      const baseColor = hit.isBuilding
        ? hit.faceNS
          ? BUILDING_WALL_COLOR_NS
          : BUILDING_WALL_COLOR_EW
        : hit.faceNS
          ? WALL_COLOR_NS
          : WALL_COLOR_EW;
      // Distance fog: blend the wall toward the horizon colour so the far
      // edge of vision fades out instead of clipping to a flat hue.
      const color = applyFog(baseColor, perp, palette.fog);

      wallLayer.rect(screenX, top, COLUMN_STEP_PX, lineH).fill({ color });
    }

    drawSprites(W, H, palette.fog, horizonY);
    drawBuildGhost(W, H, palette.fog, horizonY);
    drawHud(W, H);
  }

  // ---------- build mode ----------
  // Compute the tile under the camera reticle, draw a ghost billboard
  // there, and resolve any queued click. With no pitch, "the tile in
  // front of the player" is a fixed forward-distance pick — predictable
  // and matches the GDD's tile-grid placement semantics.
  function drawBuildGhost(W: number, H: number, fogColor: number, horizonY: number) {
    if (buildKind === null || !layout) {
      pendingBuildAction = null;
      return;
    }
    const tileSize = layout.tileSize;
    if (tileSize <= 0) {
      pendingBuildAction = null;
      return;
    }

    // Project a ray forward to find the target tile. Looking down
    // (pitch < a small negative threshold — pitch > 0 is up in our coord
    // system) makes the ray hit the ground at a finite distance; we use
    // trig to land the reticle wherever the player is pointing on the
    // floor. Looking level/up falls back to a fixed reach (1.5 tiles)
    // since a horizontal ray never hits the ground.
    const dirX = Math.cos(yaw);
    const dirY = Math.sin(yaw);
    const camHeight = WALL_HEIGHT_WORLD / 2;
    const maxReach = (BUILD_RADIUS_TILES + buildRadiusBonus + 0.5) * tileSize;
    let reach: number;
    if (pitch < -0.08) {
      reach = Math.min(maxReach, camHeight / Math.tan(-pitch));
    } else {
      reach = BUILD_REACH_TILES * tileSize;
    }
    const targetX = selfX + dirX * reach;
    const targetY = selfY + dirY * reach;
    const tileX = Math.floor(targetX / tileSize);
    const tileY = Math.floor(targetY / tileSize);

    // Validity: within build radius from player, no existing building on
    // that tile. Server enforces stricter rules (overlapping players, etc.)
    // — this is just a UX cue.
    const tileCenterX = (tileX + 0.5) * tileSize;
    const tileCenterY = (tileY + 0.5) * tileSize;
    const reachR = (BUILD_RADIUS_TILES + buildRadiusBonus + 0.5) * tileSize;
    const dxc = tileCenterX - selfX;
    const dyc = tileCenterY - selfY;
    const inRange = dxc * dxc + dyc * dyc <= reachR * reachR;
    let occupied = false;
    let occupiedId: string | null = null;
    for (const b of buildings.values()) {
      if (b.tileX === tileX && b.tileY === tileY) {
        occupied = true;
        occupiedId = b.id;
        break;
      }
    }
    const valid = inRange && !occupied;

    // Render the ghost as a true 3D cube: per-column ray-AABB test against
    // the target tile, drawn as a wall slice at whatever distance the ray
    // first enters the box. Z-tested against the wall depth buffer so the
    // cube clips correctly when an actual wall stands between the camera
    // and the placement target.
    const halfFov = FOV / 2;
    const halfPlane = Math.tan(halfFov);
    const planeX = -dirY * halfPlane;
    const planeY = dirX * halfPlane;
    const ax = tileX * tileSize;
    const ay = tileY * tileSize;
    const bx = ax + tileSize;
    const by = ay + tileSize;
    const baseColor = valid
      ? BUILD_GHOST_VALID_COLOR
      : BUILD_GHOST_INVALID_COLOR;
    const numCols = Math.ceil(W / COLUMN_STEP_PX);
    const eps = 1e-8;

    for (let i = 0; i < numCols; i++) {
      const screenX = i * COLUMN_STEP_PX;
      const camNorm = (2 * screenX) / W - 1;
      const rdx = dirX + planeX * camNorm;
      const rdy = dirY + planeY * camNorm;
      const rlen = Math.hypot(rdx, rdy);
      const ux = rdx / rlen;
      const uy = rdy / rlen;

      // Slab test on the tile AABB. Guard zero-axis rays with epsilon so
      // the divide doesn't yield NaN.
      const sux = Math.abs(ux) < eps ? (ux < 0 ? -eps : eps) : ux;
      const suy = Math.abs(uy) < eps ? (uy < 0 ? -eps : eps) : uy;
      const tx1 = (ax - selfX) / sux;
      const tx2 = (bx - selfX) / sux;
      const ty1 = (ay - selfY) / suy;
      const ty2 = (by - selfY) / suy;
      const tNear = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2));
      const tFar = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2));
      if (tFar < 0 || tNear > tFar) continue; // ray misses
      const t = Math.max(0, tNear);
      const perp = t * (ux * dirX + uy * dirY);
      if (perp <= 0.0001) continue; // camera inside the ghost
      if (perp >= zBuffer[i]) continue; // wall in front

      const lineH = (WALL_HEIGHT_WORLD * H) / perp;
      const top = horizonY - lineH / 2;
      const fogged = applyFog(baseColor, perp, fogColor);
      spriteLayer
        .rect(screenX, top, COLUMN_STEP_PX, lineH)
        .fill({ color: fogged, alpha: 0.45 });
    }

    // Resolve any queued click. Reads the latest tile, so the player can
    // line up a placement during the same frame the click landed.
    if (pendingBuildAction === 'place') {
      pendingBuildAction = null;
      if (valid) init.sendBuild(buildKind, tileX, tileY);
    } else if (pendingBuildAction === 'demolish') {
      pendingBuildAction = null;
      if (occupiedId && inRange) init.sendDemolish(occupiedId);
    }
  }

  // ---------- HUD overlay ----------
  function drawHud(W: number, H: number) {
    hudLayer.clear();
    const now = performance.now();

    // Damage tint: short red wash across the whole screen on self-damage,
    // fades out over 250ms. Drawn UNDER the rest of the HUD so the
    // crosshair / view model stay visible.
    const dmgT = Math.max(0, 1 - (now - selfLastDamageAt) / 250);
    if (dmgT > 0) {
      hudLayer.rect(0, 0, W, H).fill({ color: 0xb91c1c, alpha: 0.35 * dmgT });
    }

    // Show a "click to look" hint while pointer lock isn't held — easy to
    // miss otherwise, since FPS controls only kick in after the click.
    if (!pointerLocked) {
      // Dim the canvas slightly so the prompt reads.
      hudLayer.rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.35 });
    }

    // Bottom-right weapon view model is parked until we have real
    // weapon sprites — placeholder rectangles read as visual noise. The
    // crosshair already conveys aim and fire state.
    void now;
    drawSelfStatusBars(H);

    // Crosshair: white in combat, green in build mode, red flash on fire.
    const cx = Math.round(W / 2);
    const cy2 = Math.round(H / 2);
    const flashing = now - lastFireFlashAt < 80;
    const color = flashing
      ? 0xef4444
      : buildKind !== null
        ? BUILD_GHOST_VALID_COLOR
        : 0xffffff;
    const len = 7;
    hudLayer
      .moveTo(cx - len, cy2)
      .lineTo(cx + len, cy2)
      .moveTo(cx, cy2 - len)
      .lineTo(cx, cy2 + len)
      .stroke({ color, width: 2, alpha: 0.9 });
    // Center dot.
    hudLayer.circle(cx, cy2, 1.5).fill({ color, alpha: 0.9 });
  }

  // Bottom-left status stack: shield (top, only if maxShield > 0), HP
  // (main), stamina (thin). Colours and layout deliberately mirror the
  // top-down renderer so the HUD is identical between view modes.
  function drawSelfStatusBars(H: number) {
    const self = players.get(init.self.characterId);
    if (!self) return;
    const margin = 16;
    const barW = 220;
    const barH = 16;
    const stamH = 8;
    const shieldH = 8;
    const gap = 4;
    const hpY = H - margin - barH - stamH - gap;
    const stamY = hpY + barH + gap;
    const shieldY = hpY - shieldH - gap;

    // Inline X/Y labels — centred over each bar.
    hpText.text = `${Math.round(self.hp)} / ${Math.round(self.maxHp)}`;
    hpText.position.set(margin + barW / 2, hpY + barH / 2);
    staminaText.text = `${Math.round(self.stamina)} / ${Math.round(self.maxStamina)}`;
    staminaText.position.set(margin + barW / 2, stamY + stamH / 2);
    if (self.maxShield > 0) {
      shieldText.visible = true;
      shieldText.text = `${Math.round(self.shield)} / ${Math.round(self.maxShield)}`;
      shieldText.position.set(margin + barW / 2, shieldY + shieldH / 2);
    } else {
      shieldText.visible = false;
    }

    // HP — green / yellow / red gradient by ratio.
    const hpRatio = self.maxHp > 0 ? Math.max(0, self.hp / self.maxHp) : 0;
    const hpColor = hpRatio > 0.4 ? 0x22c55e : hpRatio > 0.2 ? 0xeab308 : 0xef4444;
    hudLayer
      .roundRect(margin, hpY, barW, barH, 4)
      .fill({ color: 0x1f2937 })
      .roundRect(margin, hpY, barW, barH, 4)
      .stroke({ color: 0x374151, width: 1 });
    if (hpRatio > 0) {
      hudLayer
        .roundRect(margin + 2, hpY + 2, (barW - 4) * hpRatio, barH - 4, 3)
        .fill({ color: hpColor });
    }

    // Stamina — thin yellow bar below HP.
    const stamRatio =
      self.maxStamina > 0 ? Math.max(0, self.stamina / self.maxStamina) : 0;
    hudLayer
      .roundRect(margin, stamY, barW, stamH, 3)
      .fill({ color: 0x1f2937 })
      .roundRect(margin, stamY, barW, stamH, 3)
      .stroke({ color: 0x374151, width: 1 });
    if (stamRatio > 0) {
      hudLayer
        .roundRect(margin + 2, stamY + 2, (barW - 4) * stamRatio, stamH - 4, 2)
        .fill({ color: 0xfde68a });
    }

    // Shield — cyan bar above HP, only present when the suit grants any.
    if (self.maxShield > 0) {
      const shieldRatio = Math.max(0, self.shield / self.maxShield);
      hudLayer
        .roundRect(margin, shieldY, barW, shieldH, 3)
        .fill({ color: 0x1f2937 })
        .roundRect(margin, shieldY, barW, shieldH, 3)
        .stroke({ color: 0x374151, width: 1 });
      if (shieldRatio > 0) {
        hudLayer
          .roundRect(
            margin + 2,
            shieldY + 2,
            (barW - 4) * shieldRatio,
            shieldH - 4,
            2
          )
          .fill({ color: 0x22d3ee });
      }
    }
  }

  // ---------- sprites (Phase 2) ----------
  // Camera-facing billboards using the standard Lode raycaster sprite math.
  // Each entity becomes a sprite with a world position, color, and ground-
  // anchored height. We collect all entities, sort far→near, project, and
  // per-column z-test against the wall depth buffer to handle occlusion.
  type Sprite = {
    x: number;
    y: number;
    color: number;
    // Sprite world-height in the same units as walls. Smaller things sit
    // closer to the floor; everything is anchored at the horizon (no pitch).
    height: number;
    distSq: number;
  };
  const spritesScratch: Sprite[] = [];

  function drawSprites(W: number, H: number, fogColor: number, horizonY: number) {
    spritesScratch.length = 0;
    const halfFov = FOV / 2;
    const halfPlane = Math.tan(halfFov);
    const dirX = Math.cos(yaw);
    const dirY = Math.sin(yaw);
    // Camera plane = perpendicular to dir, scaled so the screen edges
    // correspond to ±halfPlane in camera space.
    const planeX = -dirY * halfPlane;
    const planeY = dirX * halfPlane;

    // Collect every renderable entity. Self is skipped — we never see our
    // own avatar in first person.
    const selfId = init.self.characterId;
    for (const p of players.values()) {
      if (p.characterId === selfId) continue;
      if (!p.alive) continue;
      pushSprite(p.x, p.y, PLAYER_OTHER_COLOR, PLAYER_SIZE * 2);
    }
    const flashWindow = 90;
    for (const e of enemies.values()) {
      const v = enemyVisualFor(e.kind);
      // White hit-flash for ~90ms on damage. Sprite is the same shape; just
      // tinted toward white.
      const hitAt = enemyHitAt.get(e.id) ?? 0;
      const hitT = Math.max(0, 1 - (performance.now() - hitAt) / flashWindow);
      const color =
        hitT > 0
          ? blendColor(v.color, 0xffffff, hitT * 0.85)
          : v.color;
      pushSprite(e.x, e.y, color, v.size * 2);
    }
    for (const c of corpses.values()) {
      pushSprite(c.x, c.y, CORPSE_COLOR, CORPSE_SIZE);
    }
    for (const l of loot.values()) {
      let color: number;
      if (l.content.kind === 'material') {
        color = materialTint(l.content.materialId);
      } else if (l.content.kind === 'part') {
        color = TIER_COLORS_NUM[l.content.part.tier] ?? 0xffffff;
      } else {
        // Player-dropped slot — generic amber pouch sprite.
        color = 0xfbbf24;
      }
      // Loot sits on the floor — small height.
      pushSprite(l.x, l.y, color, 14);
    }
    const now = performance.now();
    for (const pr of projectiles.values()) {
      // Extrapolate from spawn time using vx/vy — server only sends spawn
      // and despawn events, never per-tick positions.
      const spawnedAt = projectileSpawnedAt.get(pr.id) ?? now;
      const elapsed = (now - spawnedAt) / 1000;
      const px = pr.x + pr.vx * elapsed;
      const py = pr.y + pr.vy * elapsed;
      pushSprite(px, py, pr.color ?? PROJECTILE_DEFAULT_COLOR, 8);
    }
    // Interactables — stairs, extract pad. Rendered as tall, distinctive
    // billboards so the player can spot them from across a room. Color by
    // kind. Pulse over time for the "interactable" cue.
    if (layout) {
      const pulse = 0.7 + 0.3 * Math.sin(now / 250);
      for (const it of layout.interactables) {
        const color =
          it.kind === 'stairs_down'
            ? blendColor(0x3b82f6, 0xffffff, 1 - pulse)
            : blendColor(0xfacc15, 0xffffff, 1 - pulse);
        pushSprite(it.x, it.y, color, 36);
      }
    }

    // Far-to-near so closer sprites paint over farther ones.
    spritesScratch.sort((a, b) => b.distSq - a.distSq);

    // Determinant for the inverse camera transform. invDet is the same for
    // every sprite this frame.
    const det = planeX * dirY - dirX * planeY;
    if (Math.abs(det) < 1e-6) return;
    const invDet = 1 / det;

    for (const s of spritesScratch) {
      const relX = s.x - selfX;
      const relY = s.y - selfY;
      // Camera-space transform: transformX is left/right offset, transformY
      // is depth (forward). Negative depth = behind us, skip.
      const transformX = invDet * (dirY * relX - dirX * relY);
      const transformY = invDet * (-planeY * relX + planeX * relY);
      // Cull anything closer than half a tile. Without this, a sprite at
      // distance ~0 (e.g. a projectile on its first frame, before
      // extrapolation has moved it forward) projects as a screen-filling
      // square.
      if (transformY < 6) continue;

      const screenCenterX = (W / 2) * (1 + transformX / transformY);
      const spriteH = Math.abs(Math.floor((s.height * H) / transformY));
      // Square-aspect billboard for now; Phase 7 may stretch by entity kind.
      const spriteW = spriteH;

      // Anchor the sprite's BOTTOM at the floor line at this distance.
      // The camera sits at half wall-height, so the floor at depth d
      // projects to halfH + (WALL_HEIGHT_WORLD/2 * H) / d — same as the
      // bottom edge of a wall at that distance. Without this, sprites
      // float at eye level instead of standing on the ground.
      const floorY =
        horizonY + (WALL_HEIGHT_WORLD * 0.5 * H) / transformY;
      const drawTop = Math.floor(floorY - spriteH);
      const drawLeft = Math.floor(screenCenterX - spriteW / 2);
      const drawRight = drawLeft + spriteW;

      // Distance fog: blend toward the horizon colour so distant sprites
      // recede instead of popping at full saturation.
      const fogged = applyFog(s.color, transformY, fogColor);

      // Per-column z-test. Iterate at the column step so we match the wall
      // pass; for each visible stripe, paint a rect.
      const startStripe = Math.max(0, drawLeft);
      const endStripe = Math.min(W, drawRight);
      for (let stripe = startStripe; stripe < endStripe; stripe += COLUMN_STEP_PX) {
        const colIdx = Math.floor(stripe / COLUMN_STEP_PX);
        if (colIdx < 0 || colIdx >= zBuffer.length) continue;
        if (transformY >= zBuffer[colIdx]) continue;
        spriteLayer
          .rect(stripe, drawTop, COLUMN_STEP_PX, spriteH)
          .fill({ color: fogged });
      }
    }

    function pushSprite(x: number, y: number, color: number, height: number) {
      const dx = x - selfX;
      const dy = y - selfY;
      spritesScratch.push({ x, y, color, height, distSq: dx * dx + dy * dy });
    }
  }

  // Pick the palette for the current scene. Surface = open sky / dusty
  // dusk; dungeon = dark void / damp floor.
  function paletteForScene(): ScenePalette {
    return layout && layout.walkables.length > 0
      ? DUNGEON_PALETTE
      : SURFACE_PALETTE;
  }

  // Paint a vertical gradient as N horizontal strips. Pixi v8's Graphics
  // doesn't have a single-call gradient fill, but stripe count of ~12-16
  // is plenty cheap and reads as a smooth fade at typical canvas sizes.
  function drawVerticalGradient(
    g: Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    topColor: number,
    bottomColor: number,
    steps: number
  ) {
    const stripH = h / steps;
    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : i / (steps - 1);
      const c = blendColor(topColor, bottomColor, t);
      // +1 on the strip height so adjacent strips overlap by 1px and we
      // don't get hairline gaps at fractional pixel boundaries.
      g.rect(x, y + i * stripH, w, stripH + 1).fill({ color: c });
    }
  }

  // Blend a base colour toward fog colour by distance / FOG_FULL_DIST.
  function applyFog(base: number, dist: number, fog: number): number {
    if (dist <= 0) return base;
    const t = Math.min(1, dist / FOG_FULL_DIST);
    return blendColor(base, fog, t);
  }

  // Lerp two RGB colours given a t in [0..1].
  function blendColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 0xff;
    const ag = (a >> 8) & 0xff;
    const ab = a & 0xff;
    const br = (b >> 16) & 0xff;
    const bg = (b >> 8) & 0xff;
    const bb = b & 0xff;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }

  type RayHit = { dist: number; faceNS: boolean; isBuilding: boolean };

  // Proper grid DDA. Walks the ray tile-by-tile and stops at the first
  // tile that's a wall. Hit distance is the perpendicular-corrected ray
  // distance to the entered tile's near edge — pixel-exact, no quantization
  // wobble, so a flat wall projects as a flat rectangle (no curvature).
  //
  // A tile is a "wall" when:
  //   - the dungeon has walkable rects and the tile centre isn't inside
  //     any of them (i.e. outside the room/corridor mask), OR
  //   - a player-placed building occupies the tile.
  // Surfaces with no walkables (open world) treat every empty tile as
  // walkable; only buildings act as walls.
  function castRay(
    ox: number,
    oy: number,
    dx: number,
    dy: number
  ): RayHit | null {
    if (!layout) return null;
    const tileSize = layout.tileSize;
    if (tileSize <= 0) return null;
    const hasWalkables = layout.walkables.length > 0;

    // Avoid divide-by-zero on a perfectly axis-aligned ray. ε keeps the
    // delta finite without measurably affecting the projection.
    const adx = Math.abs(dx) < 1e-8 ? 1e-8 : dx;
    const ady = Math.abs(dy) < 1e-8 ? 1e-8 : dy;
    const deltaX = tileSize / Math.abs(adx);
    const deltaY = tileSize / Math.abs(ady);
    const stepX = adx < 0 ? -1 : 1;
    const stepY = ady < 0 ? -1 : 1;

    let mx = Math.floor(ox / tileSize);
    let my = Math.floor(oy / tileSize);

    // Distance along the ray to the first tile boundary on each axis.
    let sideX =
      adx < 0
        ? (ox - mx * tileSize) / Math.abs(adx)
        : ((mx + 1) * tileSize - ox) / Math.abs(adx);
    let sideY =
      ady < 0
        ? (oy - my * tileSize) / Math.abs(ady)
        : ((my + 1) * tileSize - oy) / Math.abs(ady);

    const maxIters = Math.ceil((RAY_MAX_DIST / tileSize) * 2) + 2;
    let faceNS = false;
    let dist = 0;

    for (let i = 0; i < maxIters; i++) {
      if (sideX < sideY) {
        dist = sideX;
        sideX += deltaX;
        mx += stepX;
        faceNS = false; // crossed an east/west tile face
      } else {
        dist = sideY;
        sideY += deltaY;
        my += stepY;
        faceNS = true; // crossed a north/south tile face
      }
      if (dist > RAY_MAX_DIST) return null;

      // Wall classification at the tile we just stepped into.
      const cx = (mx + 0.5) * tileSize;
      const cy = (my + 0.5) * tileSize;
      const insideWalkable = !hasWalkables || isInsideAny(layout.walkables, cx, cy);
      const isBuilding = isBuildingTile(mx, my);
      if (!insideWalkable || isBuilding) {
        return { dist, faceNS, isBuilding };
      }
    }
    return null;
  }

  function isBuildingTile(mx: number, my: number): boolean {
    if (buildings.size === 0) return false;
    for (const b of buildings.values()) {
      if (
        mx >= b.tileX &&
        mx < b.tileX + b.width &&
        my >= b.tileY &&
        my < b.tileY + b.height
      ) {
        return true;
      }
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
    projectileSpawnedAt.clear();
    for (const p of [state.self, ...state.players]) players.set(p.characterId, p);
    for (const e of state.enemies) enemies.set(e.id, e);
    for (const l of state.loot) loot.set(l.id, l);
    for (const c of state.corpses) corpses.set(c.id, c);
    for (const b of state.buildings) buildings.set(b.id, b);
    for (const p of state.projectiles) {
      projectiles.set(p.id, p);
      projectileSpawnedAt.set(p.id, performance.now());
    }
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
      // Damage flash for self only.
      if (characterId === init.self.characterId && hp < selfLastHp) {
        selfLastDamageAt = performance.now();
      }
      if (characterId === init.self.characterId) selfLastHp = hp;
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
        // Respawn restores HP to maxHp; resync the damage-flash baseline
        // so an incoming setPlayerHp doesn't fire spuriously.
        selfLastHp = hp;
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
      if (!e) return;
      // Hit flash if HP went down. Server can also send full updates, so
      // gate on a real decrease.
      if (hp < e.hp) enemyHitAt.set(id, performance.now());
      e.hp = hp;
      e.maxHp = maxHp;
    },
    removeEnemy(id) {
      enemies.delete(id);
      enemyHitAt.delete(id);
    },
    spawnProjectile(p) {
      projectiles.set(p.id, p);
      projectileSpawnedAt.set(p.id, performance.now());
      // Crosshair flash mirrors the actual fire — driven off the
      // server's projectile broadcast, not the local mouse-down.
      // Cadence matches the real fire rate (per weapon + mods); empty
      // mag / reloading / no reserve produce no flash.
      if (
        p.ownerKind === 'player' &&
        p.ownerCharacterId === init.self.characterId
      ) {
        lastFireFlashAt = performance.now();
      }
    },
    despawnProjectile(id) {
      projectiles.delete(id);
      projectileSpawnedAt.delete(id);
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
    setBuildMode(kind) {
      buildKind = kind;
      // Switching out of build mode discards a queued action so a stale
      // click doesn't fire after the user just unequipped a placeable.
      if (kind === null) pendingBuildAction = null;
    },
    setBuildRadiusBonus(tiles: number) {
      buildRadiusBonus = Math.max(0, Math.floor(tiles));
    },
    setEquippedWeapon(weaponId) {
      equippedWeapon = weaponId;
      // Releasing the weapon mid-hold should stop firing.
      if (weaponId === null) mouseDown = false;
    },
    swapScene(state) {
      applySceneState(state);
    },
    paintMinimap(canvas: HTMLCanvasElement, worldRadius: number) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const scale = Math.min(w, h) / (worldRadius * 2);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(10, 12, 18, 0.85)';
      ctx.fillRect(0, 0, w, h);

      const tileSize = layout?.tileSize ?? 32;

      if (layout && layout.walkables.length > 0) {
        ctx.fillStyle = 'rgba(82, 82, 91, 0.45)';
        for (const r of layout.walkables) {
          const x = (r.x - selfX) * scale + cx;
          const y = (r.y - selfY) * scale + cy;
          ctx.fillRect(x, y, r.w * scale, r.h * scale);
        }
      } else {
        ctx.fillStyle = 'rgba(82, 82, 91, 0.18)';
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(w, h) / 2 - 2, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const b of buildings.values()) {
        const x = (b.tileX * tileSize - selfX) * scale + cx;
        const y = (b.tileY * tileSize - selfY) * scale + cy;
        const sw = Math.max(2, b.width * tileSize * scale);
        const sh = Math.max(2, b.height * tileSize * scale);
        ctx.fillStyle =
          b.kind === 'power_link'
            ? '#06b6d4'
            : b.kind === 'storage_chest'
              ? '#fbbf24'
              : b.kind === 'wall'
                ? '#71717a'
                : b.kind.startsWith('turret')
                  ? '#a78bfa'
                  : b.kind === 'door'
                    ? '#fde68a'
                    : '#22c55e';
        ctx.fillRect(x, y, sw, sh);
      }

      for (const p of players.values()) {
        if (p.characterId === init.self.characterId) continue;
        const x = (p.x - selfX) * scale + cx;
        const y = (p.y - selfY) * scale + cy;
        ctx.fillStyle = '#34d399';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const e of enemies.values()) {
        if (e.hp <= 0) continue;
        const x = (e.x - selfX) * scale + cx;
        const y = (e.y - selfY) * scale + cy;
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Self + facing arrow (FPS view has an angle, top-down doesn't).
      const facing = (yaw ?? 0);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(facing);
      ctx.fillStyle = '#fde047';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    },
    nearbyPlayers(radiusPx: number) {
      const r2 = radiusPx * radiusPx;
      const out: { characterId: string; displayName: string; dsq: number }[] = [];
      for (const p of players.values()) {
        if (p.characterId === init.self.characterId) continue;
        const dx = p.x - selfX;
        const dy = p.y - selfY;
        const dsq = dx * dx + dy * dy;
        if (dsq <= r2) {
          out.push({
            characterId: p.characterId,
            displayName: p.displayName,
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
      const self = players.get(init.self.characterId);
      const otherPlayers: Player[] = [];
      for (const p of players.values()) {
        if (p.characterId === init.self.characterId) continue;
        otherPlayers.push({ ...p });
      }
      return {
        self: self ? { ...self } : { ...init.self, x: selfX, y: selfY },
        players: otherPlayers,
        enemies: [...enemies.values()].map((e) => ({ ...e })),
        projectiles: [...projectiles.values()].map((p) => ({ ...p })),
        loot: [...loot.values()].map((l) => ({ ...l })),
        corpses: [...corpses.values()].map((c) => ({ ...c })),
        buildings: [...buildings.values()].map((b) => ({ ...b })),
        layout,
      };
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

