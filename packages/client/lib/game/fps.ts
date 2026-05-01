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

// ---------- entity visuals (Phase 2) ----------
// Mirrors ENEMY_VISUALS in pixi.ts. Kept inline to avoid a coupling import.
type EnemyVisual = { color: number; size: number };
const ENEMY_VISUALS: Record<string, EnemyVisual> = {
  dummy_target: { color: 0xef4444, size: 18 },
  chaser_melee: { color: 0xa855f7, size: 16 },
  shooter_drone: { color: 0x60a5fa, size: 14 },
  brute_chaser: { color: 0xb45309, size: 26 },
};
const FALLBACK_ENEMY_VISUAL: EnemyVisual = ENEMY_VISUALS.dummy_target;
const PLAYER_OTHER_COLOR = 0x4dd0e1;
const PLAYER_SIZE = 14;
const CORPSE_COLOR = 0x4a1d1d;
const CORPSE_SIZE = 14;
const PROJECTILE_DEFAULT_COLOR = 0xfde047;
const MATERIAL_TINT: Record<string, number> = {
  scrap: 0xc2410c,
  wire: 0xeab308,
  alloy: 0x94a3b8,
  circuit: 0x10b981,
  biotic: 0xa855f7,
  crystal: 0x06b6d4,
};
const PART_TIER_COLOR: Record<string, number> = {
  Mk1: 0x9ca3af,
  Mk2: 0x22c55e,
  Mk3: 0x3b82f6,
  Mk4: 0xa855f7,
  Alien: 0xf97316,
};

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

  // ---------- input state ----------
  const keys = new Set<string>();
  let pointerLocked = false;
  let mouseDown = false;
  let equippedWeapon: 'pistol' | 'knife' | null = null;
  // Brief muzzle-flash window so the crosshair pulses on every fire frame.
  let lastFireFlashAt = 0;

  // ---------- lifecycle ----------
  const root = new Container();
  const wallLayer = new Graphics();
  const spriteLayer = new Graphics();
  const hudLayer = new Graphics();
  root.addChild(wallLayer);
  root.addChild(spriteLayer);
  root.addChild(hudLayer);

  // Per-column perpendicular distance to the wall hit. Indexed by column
  // (i = screenX / COLUMN_STEP_PX). Sprites z-test against this so a wall
  // in front of an enemy occludes the enemy.
  let zBuffer: Float32Array = new Float32Array(0);

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
      mouseDown = true;
    }
  }
  function onMouseUp(e: MouseEvent) {
    if (e.button === 0) mouseDown = false;
  }
  function onContextMenu(e: MouseEvent) {
    // Right-click is reserved for demolish in the top-down view; for now in
    // FPS we just swallow it so the browser context menu doesn't appear
    // during pointer-lock acquisition.
    e.preventDefault();
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

    // Hold-to-fire while pointer-locked + a weapon equipped. Server gates
    // by per-weapon fire interval, so it's safe to send every frame; it'll
    // ignore the dropped requests.
    if (mouseDown && pointerLocked && equippedWeapon !== null) {
      init.sendFire(cy, sy);
      lastFireFlashAt = performance.now();
    }
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
    spriteLayer.clear();

    // Sky (top half) + floor (bottom half) — flat colours for now. Phase 4
    // turns the surface into a gradient horizon.
    wallLayer.rect(0, 0, W, halfH).fill({ color: SKY_COLOR });
    wallLayer.rect(0, halfH, W, halfH).fill({ color: FLOOR_COLOR });

    // Per-column raycast.
    const numCols = Math.ceil(W / COLUMN_STEP_PX);
    const halfFov = FOV / 2;
    if (zBuffer.length !== numCols) zBuffer = new Float32Array(numCols);
    zBuffer.fill(Infinity);

    for (let i = 0; i < numCols; i++) {
      const screenX = i * COLUMN_STEP_PX;
      const camNorm = (2 * screenX) / W - 1;
      const rayAngle = yaw + camNorm * halfFov;

      const hit = castRay(selfX, selfY, rayAngle);
      if (!hit) continue;

      const perp = hit.dist * Math.cos(camNorm * halfFov);
      if (perp <= 0.0001) continue;
      zBuffer[i] = perp;

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

    drawSprites(W, H);
    drawHud(W, H);
  }

  // ---------- HUD overlay ----------
  function drawHud(W: number, H: number) {
    hudLayer.clear();

    // Show a "click to look" hint while pointer lock isn't held — easy to
    // miss otherwise, since FPS controls only kick in after the click.
    if (!pointerLocked) {
      // Dim the canvas slightly so the prompt reads.
      hudLayer.rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.35 });
    }

    // Crosshair (fades to red briefly when firing).
    const cx = Math.round(W / 2);
    const cy2 = Math.round(H / 2);
    const flashing = performance.now() - lastFireFlashAt < 80;
    const color = flashing ? 0xef4444 : 0xffffff;
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

  function drawSprites(W: number, H: number) {
    spritesScratch.length = 0;
    const halfH = H / 2;
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
    for (const e of enemies.values()) {
      const v = ENEMY_VISUALS[e.kind] ?? FALLBACK_ENEMY_VISUAL;
      pushSprite(e.x, e.y, v.color, v.size * 2);
    }
    for (const c of corpses.values()) {
      pushSprite(c.x, c.y, CORPSE_COLOR, CORPSE_SIZE);
    }
    for (const l of loot.values()) {
      const color =
        l.content.kind === 'material'
          ? (MATERIAL_TINT[l.content.materialId] ?? 0xffffff)
          : (PART_TIER_COLOR[l.content.part.tier] ?? 0xffffff);
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

      // Anchor the sprite's bottom at the horizon line so things "stand on
      // the floor." Smaller sprites (loot) appear lower automatically.
      const drawTop = halfH - spriteH;
      const drawLeft = Math.floor(screenCenterX - spriteW / 2);
      const drawRight = drawLeft + spriteW;

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
          .fill({ color: s.color });
      }
    }

    function pushSprite(x: number, y: number, color: number, height: number) {
      const dx = x - selfX;
      const dy = y - selfY;
      spritesScratch.push({ x, y, color, height, distSq: dx * dx + dy * dy });
    }
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
      projectileSpawnedAt.set(p.id, performance.now());
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
    setBuildMode() {
      // Phase 5 implements the floor-reticle ray pick.
    },
    setEquippedWeapon(weaponId) {
      equippedWeapon = weaponId;
      // Releasing the weapon mid-hold should stop firing.
      if (weaponId === null) mouseDown = false;
    },
    swapScene(state) {
      applySceneState(state);
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

