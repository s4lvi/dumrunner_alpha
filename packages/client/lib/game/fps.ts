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

import {
  Application,
  Assets,
  Container,
  Graphics,
  Mesh,
  MeshGeometry,
  Text,
  TilingSprite,
  type Texture,
} from 'pixi.js';
import {
  getOverride,
  subscribe as subscribeOverrides,
} from '../textureOverrides';
import type {
  BuildingState,
  CorpseState,
  EnemyState,
  LootState,
  Player,
  ProjectileState,
  PropState,
  SceneLayout,
} from '@dumrunner/shared';
import {
  BUILDING_REGISTRY,
  enemyVisualFor,
  isInsideAny,
  materialTint,
  TIER_COLORS_NUM,
} from '@dumrunner/shared';
import type { GameHandle, GameInit, SceneState } from './pixi';
import { buildingsToMinimapList, type MinimapSnapshot } from './minimap';

// ---------- tuning ----------
// VERTICAL field of view. Horizontal FOV is derived per frame
// from the canvas aspect (HOR+ scaling — wider screens see more
// world side-to-side, vertical stays locked). 60° vertical at a
// 16:9 aspect = ~95° horizontal, matching the original 70°
// horizontal feel at standard widescreen.
const VERTICAL_FOV = (Math.PI / 180) * 60;
// Kept for back-compat (pitch limits + sprite-cull frustum
// reference). Equals VERTICAL_FOV but consumers should treat
// this as "the larger FOV axis" — horizontal at typical aspects.
const FOV = VERTICAL_FOV;
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
  // Baseline fog blend at distance 0 — represents ambient darkness
  // before any distance-based fog kicks in. 0 = fully lit at camera
  // (open daylight surface). 0.4 = noticeable baseline darkening
  // even up close (windowless dungeon).
  ambient: number;
};
const SURFACE_PALETTE: ScenePalette = {
  skyTop: 0x0d1733,
  skyBottom: 0xc46b3a, // dusty orange dusk
  floorTop: 0x5a2f1a, // rust band at horizon
  floorBottom: 0x1d1109, // dark soil under the camera
  fog: 0xa05530, // desaturated horizon orange
  ambient: 0,
};
const DUNGEON_PALETTE: ScenePalette = {
  skyTop: 0x000000,
  skyBottom: 0x171823,
  floorTop: 0x231f1c,
  floorBottom: 0x080808,
  fog: 0x121218,
  ambient: 0.45,
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
  const props = new Map<string, PropState>();
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
  for (const p of init.props) props.set(p.id, p);
  for (const p of init.projectiles) {
    projectiles.set(p.id, p);
    projectileSpawnedAt.set(p.id, performance.now());
  }

  let layout: SceneLayout | null = init.layout;
  let selfX = init.self.x;
  let selfY = init.self.y;
  let yaw = 0;
  // Active scene's ambient fog floor (0 = no near-camera darkening,
  // 0.45 = dungeon-dark even up close). Updated each render() from
  // the scene palette; read by applyFog and the floor/ceiling fog
  // overlay so all surfaces share the same darkness baseline.
  let activeAmbient = 0;
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
  let equippedWeapon: import('@dumrunner/shared').WeaponKind | null = null;
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
  // Textured wall columns. Sits above wallLayer (sky+floor+solid)
  // so textured strips render on top of the solid fallback for
  // columns whose hit kind has a texture override.
  // Skybox sprite (or sky gradient when no biome_skybox texture).
  // Below everything so walls / floor / ceiling overdraw it.
  const skyboxLayer = new Container();
  // Per-column floor / ceiling Meshes — same Mesh-quad-per-column
  // technique used for short-obstacle tops, just at world_height
  // 0 (floor) or WALL_HEIGHT_WORLD (ceiling). Below wallLayer so
  // walls overdraw.
  const floorLayer = new Container();
  const ceilingLayer = new Container();
  const wallTexLayer = new Container();
  // Top-surface rendering for short obstacles. Two layers:
  //   wallTopLayer — Mesh quads with proper UVs for textured
  //     top surfaces, projected from the obstacle's near + far
  //     edges. Per-frame meshes get destroy()'d on clear so
  //     MeshGeometry buffers don't leak.
  //   wallCapLayer — solid-colour seam + face fallback when no
  //     top texture is authored. Single reusable Graphics; rect
  //     calls + clear() per frame.
  // Both sit ABOVE wallTexLayer so the top surface always draws
  // on top of any front-face transparency.
  const wallTopLayer = new Container();
  const wallCapLayer = new Graphics();
  const spriteLayer = new Graphics();
  // Textured sprite columns (enemies). Same per-column z-test as
  // the flat-color sprite pass; rendered as one Mesh per visible
  // stripe so the texture's vertical column lines up with the
  // billboard's screen column.
  const spriteTexLayer = new Container();
  const hudLayer = new Graphics();

  // Texture cache for the FPS wall pass. Mirrors the iso renderer's
  // override-aware lookup (lib/textureOverrides). Cached Textures
  // persist across frames; loads are async and the wall just stays
  // in solid-fill mode until the texture resolves.
  const fpsTexCache = new Map<string, Texture>();
  const fpsTexLoading = new Set<string>();
  function getFpsOverrideTexture(
    category: string,
    id: string,
  ): Texture | null {
    const url = getOverride(category, id);
    if (!url) return null;
    const cached = fpsTexCache.get(url);
    if (cached) return cached;
    if (!fpsTexLoading.has(url)) {
      fpsTexLoading.add(url);
      void (async () => {
        try {
          const tex = (await Assets.load(url)) as Texture;
          // Floor / ceiling / material textures tile across many
          // world units per strip, so we sample with raw world/tile
          // UVs and rely on repeat-wrap. Other categories (walls,
          // sprites) clamp to [0,1] so this is a no-op for them.
          try {
            // Pixi v8 source style — wrap U and V independently for
            // robustness. The cast keeps this resilient across the
            // small API churn between v8 minors.
            const style = (tex.source as unknown as {
              style?: { addressMode?: string; update?: () => void };
            }).style;
            if (style) {
              style.addressMode = 'repeat';
              style.update?.();
            }
          } catch {
            /* address-mode set is best-effort; texture still works clamped */
          }
          fpsTexCache.set(url, tex);
        } catch {
          /* swallow */
        } finally {
          fpsTexLoading.delete(url);
        }
      })();
    }
    return null;
  }
  const unsubFpsOverrides = subscribeOverrides(() => {
    // Force a tex re-resolve next render. No work needed beyond
    // the cache check — render() reads getFpsOverrideTexture
    // every frame.
  });
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
  // Layer order, back to front:
  //   skybox      — full-region sky texture / gradient backdrop.
  //   floor/ceil  — full-width per-row floor-cast strips (constant
  //                 depth per row → exact affine UV across screen-x).
  //   wall        — sky/floor gradient fallback + untextured wall
  //                 solid fills (must be ABOVE floor/ceil so wall
  //                 columns overdraw the floor strips correctly).
  //   wallTex/    — textured walls / tops / fallback caps on top.
  //   sprite      — billboards on top of everything.
  root.addChild(skyboxLayer);
  root.addChild(floorLayer);
  root.addChild(ceilingLayer);
  root.addChild(wallLayer);
  root.addChild(wallTexLayer);
  root.addChild(wallTopLayer);
  root.addChild(wallCapLayer);
  root.addChild(spriteLayer);
  root.addChild(spriteTexLayer);
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
          weaponBenchTier: 0,
          weaponBenches: [],
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
    let weaponBenchTier = 0;
    const weaponBenches: { id: string; tier: number }[] = [];
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
        b.kind !== 'precision_mill' &&
        b.kind !== 'suit_bench' &&
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
        if (b.kind === 'weapon_bench') {
          const t = b.benchTier ?? 1;
          if (t > weaponBenchTier) weaponBenchTier = t;
          weaponBenches.push({ id: b.id, tier: t });
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
      (nearestChestId ?? '') +
      '|' +
      String(weaponBenchTier) +
      '|' +
      weaponBenches.map((b) => `${b.id}:${b.tier}`).join(',');
    if (key !== lastStationKey) {
      lastStationKey = key;
      init.onNearWorkstationsChanged({
        all: [...found],
        nearest: nearestKind,
        nearestDoorId,
        nearestChestId,
        weaponBenchTier,
        weaponBenches,
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
    // Drop last frame's textured meshes. Cheap — typical counts
    // are sub-500 quads across walls + sprites.
    // Mesh-per-column wall + sprite passes allocate fresh
    // MeshGeometry every frame. removeChildren() only detaches —
    // it doesn't release the GPU buffers — so we explicitly
    // destroy each child to keep memory flat across long
    // sessions.
    disposeChildren(wallTexLayer);
    disposeChildren(wallTopLayer);
    disposeChildren(spriteTexLayer);
    disposeChildren(floorLayer);
    disposeChildren(ceilingLayer);
    disposeChildren(skyboxLayer);
    wallCapLayer.clear();

    // Per-scene horizon palette: bright dusk on the surface, dark void in
    // a dungeon. Both gradients meet at the horizon line so walls & sprites
    // can fog into the same colour as they recede. The gradients act as a
    // FALLBACK when no biome skybox / floor / ceiling texture is uploaded —
    // skybox / floor / ceiling meshes paint over them otherwise.
    const palette = paletteForScene();
    activeAmbient = palette.ambient;
    // Surface scene (no walkables → SURFACE_PALETTE) uses a fixed
    // pseudo-biome id 'surface' for texture lookups, so the editor
    // can author overworld/base floor + skybox textures distinct
    // from any dungeon biome.
    const isSurface = !layout || layout.walkables.length === 0;
    const biomeId = isSurface ? 'surface' : (layout?.biome ?? 'default');
    const skyTex = getFpsOverrideTexture('biome_skybox', biomeId);
    const floorTex = getFpsOverrideTexture('biome_floor', biomeId);
    const ceilTex = getFpsOverrideTexture('biome_ceiling', biomeId);
    // Skip the gradient when a biome texture covers that region.
    // Sky gradient is hidden by either a skybox texture OR a ceiling
    // texture (both occupy the above-horizon area). Floor gradient
    // is hidden by a floor texture.
    const skipSkyGradient = !!skyTex || !!ceilTex;
    const skipFloorGradient = !!floorTex;
    if (horizonY > 0 && !skipSkyGradient) {
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
    if (horizonY < H && !skipFloorGradient) {
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

    // Skybox: a horizontal-panning TilingSprite covering the sky
    // region. Pans with yaw so turning rotates the world. Only
    // renders when a biome_skybox texture exists; otherwise the
    // sky gradient stays visible.
    if (skyTex && horizonY > 0) {
      const spr = new TilingSprite({
        texture: skyTex,
        width: W,
        height: horizonY,
      });
      // 360° (yaw 0 → 2π) corresponds to one full texture width
      // of horizontal pan. tilePosition wraps automatically.
      const texW = skyTex.width || W;
      spr.tilePosition.x = -(yaw / (Math.PI * 2)) * texW;
      // Stretch vertically so the texture height fits the sky
      // region; horizontal stays at native scale for tiling.
      spr.tileScale.y = horizonY / (skyTex.height || horizonY);
      skyboxLayer.addChild(spr);
    }
    const camHeight = WALL_HEIGHT_WORLD / 2;
    const floorTile = layout?.tileSize ?? 32;

    // Per-column raycast. Uses camera-plane rays (Lode-style) rather than
    // an angular sweep so wall projection is linear-in-screen-x and the
    // close-range curvature at the edges of the FOV disappears. Matches
    // the sprite pass below so they share the same camera model exactly.
    const numCols = Math.ceil(W / COLUMN_STEP_PX);
    // HOR+ scaling: vertical FOV is fixed; horizontal half-plane
    // scales with the canvas aspect ratio so wider screens see
    // more world side-to-side rather than just stretching.
    const aspect = H > 0 ? W / H : 1;
    const halfFov = VERTICAL_FOV / 2;
    const halfPlane = Math.tan(halfFov) * aspect;
    const dirX = Math.cos(yaw);
    const dirY = Math.sin(yaw);
    const planeX = -dirY * halfPlane;
    const planeY = dirX * halfPlane;
    if (zBuffer.length !== numCols) zBuffer = new Float32Array(numCols);
    zBuffer.fill(Infinity);

    // Floor + ceiling: classic Wolfenstein-style horizontal row
    // strips. Within a single screen row, depth is constant
    // (rowDist = camHeight*H / |y - horizon|), so world position
    // is exactly linear across screen-x — affine UV interpolation
    // between leftmost and rightmost rays is perspective-correct.
    // Walls drawn after on a higher layer overdraw these strips
    // per column for proper occlusion.
    if (floorTex && horizonY < H) {
      paintFloorOrCeilingStrips(
        'floor',
        W, H,
        selfX, selfY,
        dirX, dirY, planeX, planeY,
        camHeight, horizonY,
        floorTile,
        floorTex,
        floorLayer,
      );
    }
    if (ceilTex && horizonY > 0) {
      paintFloorOrCeilingStrips(
        'ceiling',
        W, H,
        selfX, selfY,
        dirX, dirY, planeX, planeY,
        camHeight, horizonY,
        floorTile,
        ceilTex,
        ceilingLayer,
      );
    }

    // Depth-based fog overlay for textured floor / ceiling. Paints
    // into wallLayer (above the meshes, below wall column fills);
    // wall columns added later in the per-column loop overdraw the
    // fog where walls exist, so fog only shows on the visible floor
    // and ceiling regions.
    if (floorTex && horizonY < H) {
      paintFloorOrCeilingFogOverlay(
        'floor', wallLayer, W, H, camHeight, horizonY, palette.fog,
      );
    }
    if (ceilTex && horizonY > 0) {
      paintFloorOrCeilingFogOverlay(
        'ceiling', wallLayer, W, H, camHeight, horizonY, palette.fog,
      );
    }

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

      const hits = castRay(selfX, selfY, ux, uy);

      // Z-buffer holds the FAREST hit (the back wall) for sprite
      // occlusion. Stays Infinity when the ray escapes — sprites
      // can render that column uncovered.
      if (hits.length > 0) {
        const zHit = hits[hits.length - 1];
        const zPerp = zHit.dist * (ux * dirX + uy * dirY);
        if (zPerp > 0.0001) zBuffer[i] = zPerp;
      }

      // Paint slices far-to-near so closer obstacles overdraw
      // the back wall. Each slice ground-anchored: short
      // obstacles sit on the floor, full walls span the canonical
      // height range around the horizon.
      for (let h = hits.length - 1; h >= 0; h--) {
        const hit = hits[h];
        const perp = hit.dist * (ux * dirX + uy * dirY);
        if (perp <= 0.0001) continue;
        const heightMult = stationHeightMultFor(hit);
        const fullWallH = (WALL_HEIGHT_WORLD * H) / perp;
        const lineH = fullWallH * heightMult;
        const groundY = horizonY + fullWallH / 2;
        const top = groundY - lineH;

        const texKind = hit.isBuilding ? hit.buildingKind ?? 'wall' : 'wall';
        const tex = getFpsOverrideTexture('building', texKind);

        // Solid-fill column ONLY when no texture exists. A
        // solid underlay shining through a texture's transparent
        // pixels reads as "gray paneling behind my barrel" —
        // wrong. With no fill, transparent texels reveal whatever
        // was painted earlier in the far-to-near pass (the back
        // wall, sky, or floor) — correct.
        if (!tex) {
          const baseColor = hit.isBuilding
            ? hit.faceNS
              ? BUILDING_WALL_COLOR_NS
              : BUILDING_WALL_COLOR_EW
            : hit.faceNS
              ? WALL_COLOR_NS
              : WALL_COLOR_EW;
          const color = applyFog(baseColor, perp, palette.fog);
          wallLayer.rect(screenX, top, COLUMN_STEP_PX, lineH).fill({ color });
        }

        if (tex) {
          const texW = tex.width || 1;
          const uvX = Math.max(0, Math.min(0.999, hit.wallU));
          const uvX2 = Math.min(1, uvX + 1 / texW);
          const positions = new Float32Array([
            screenX, top,
            screenX + COLUMN_STEP_PX, top,
            screenX + COLUMN_STEP_PX, top + lineH,
            screenX, top + lineH,
          ]);
          const uvs = new Float32Array([
            uvX, 0,
            uvX2, 0,
            uvX2, 1,
            uvX, 1,
          ]);
          const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
          const geom = new MeshGeometry({ positions, uvs, indices });
          const mesh = new Mesh({ geometry: geom, texture: tex });
          mesh.tint = applyFog(0xffffff, perp, palette.fog);
          wallTexLayer.addChild(mesh);
        }

        // Top surface for short obstacles. Floor-cast: project
        // the obstacle's near + far world edges (entry/exit
        // points along the ray) at the obstacle's top height,
        // build a textured Mesh quad between them. UVs sample
        // 'building_top' / 'prop_top' textures; falls back to
        // a flat-colour cap strip when no top texture is
        // authored.
        if (heightMult < 1.0) {
          // Far-edge perp distance and screen y. The top
          // surface stretches from near (current `top` y) to
          // far (smaller y, closer to horizon).
          const farPerp = hit.exitDist * (ux * dirX + uy * dirY);
          if (farPerp > 0.0001 && farPerp > perp) {
            const obstacleH = WALL_HEIGHT_WORLD * heightMult;
            const yFar =
              horizonY + ((WALL_HEIGHT_WORLD * 0.5 - obstacleH) * H) / farPerp;
            const yNear = top;
            // Skip degenerate strips.
            if (yNear - yFar > 0.5) {
              const topTexKind = hit.isBuilding
                ? hit.buildingKind ?? 'wall'
                : 'wall';
              const topTex = getFpsOverrideTexture(
                'building_top',
                topTexKind,
              );
              if (topTex) {
                // Subdivided per-column row strip — same fix as
                // the floor / ceiling pass. The obstacle top has
                // the same projection (depth = (camHeight - obstacleH)
                // * H / |y - horizon|), so a single quad with corner-
                // only UVs warps for any obstacle spanning more than
                // ~1 tile. Subdividing into thin rows keeps the UV
                // interpolation close to perspective-correct, and raw
                // world/tile UVs (no mod) tile cleanly because the
                // texture is loaded with addressMode = 'repeat'.
                const tile = layout?.tileSize ?? 32;
                const TOP_ROWS = 12;
                const numVerts = (TOP_ROWS + 1) * 2;
                const positions = new Float32Array(numVerts * 2);
                const uvs = new Float32Array(numVerts * 2);
                const indices = new Uint32Array(TOP_ROWS * 6);
                const dyHeight = WALL_HEIGHT_WORLD * 0.5 - obstacleH;
                for (let r = 0; r <= TOP_ROWS; r++) {
                  const y = yFar + ((yNear - yFar) * r) / TOP_ROWS;
                  // Depth at this row from the floor-cast formula
                  // mirrored above the horizon line. Clamp the
                  // denominator to a small positive so a row that
                  // grazes the horizon doesn't blow up.
                  const dy = Math.max(0.5, y - horizonY);
                  const rowPerp = (dyHeight * H) / dy;
                  // Walk the column's center ray to that depth and
                  // sample the world position. (Column is thin; one
                  // ray for both edges is fine for the horizontal
                  // axis — same shrug we make for any per-column
                  // raycast at 1-2px granularity.)
                  const along = rowPerp / Math.max(0.0001, ux * dirX + uy * dirY);
                  const wx = selfX + ux * along;
                  const wy = selfY + uy * along;
                  const u = wx / tile;
                  const v = wy / tile;
                  const base = r * 4;
                  positions[base + 0] = screenX;
                  positions[base + 1] = y;
                  positions[base + 2] = screenX + COLUMN_STEP_PX;
                  positions[base + 3] = y;
                  uvs[base + 0] = u;
                  uvs[base + 1] = v;
                  uvs[base + 2] = u;
                  uvs[base + 3] = v;
                }
                for (let r = 0; r < TOP_ROWS; r++) {
                  const a = r * 2;
                  const b = r * 2 + 1;
                  const c = (r + 1) * 2 + 1;
                  const d = (r + 1) * 2;
                  const i6 = r * 6;
                  indices[i6 + 0] = a;
                  indices[i6 + 1] = b;
                  indices[i6 + 2] = c;
                  indices[i6 + 3] = a;
                  indices[i6 + 4] = c;
                  indices[i6 + 5] = d;
                }
                const geom = new MeshGeometry({ positions, uvs, indices });
                const mesh = new Mesh({ geometry: geom, texture: topTex });
                // Single tint at mid-distance — same trade as the
                // floor / ceiling mesh. Per-row fog would need vertex
                // colors; walls fog independently so the scene still
                // reads with depth.
                const avgPerp = (perp + farPerp) * 0.5;
                mesh.tint = applyFog(0xffffff, avgPerp, palette.fog);
                wallTopLayer.addChild(mesh);
              } else {
                // Fallback: solid two-tone cap when no top texture
                // exists. Reads as a 3D top edge regardless of
                // the front-face texture's alpha.
                const seamColor = applyFog(0x0b0d10, perp, palette.fog);
                const faceColor = applyFog(0xa1a1aa, perp, palette.fog);
                wallCapLayer
                  .rect(
                    screenX,
                    yFar,
                    COLUMN_STEP_PX,
                    Math.max(0, yNear - yFar),
                  )
                  .fill({ color: faceColor });
                wallCapLayer
                  .rect(screenX, yFar, COLUMN_STEP_PX, 1)
                  .fill({ color: seamColor });
              }
            }
          }
        }

      }

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
    const aspect = H > 0 ? W / H : 1;
    const halfFov = VERTICAL_FOV / 2;
    const halfPlane = Math.tan(halfFov) * aspect;
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
    // Optional override key. When set + a matching texture exists,
    // the sprite renders as a textured billboard (per-column UV
    // strip with z-test); otherwise falls back to the flat-color
    // column path.
    texCategory?: 'enemy' | 'building';
    texId?: string;
  };
  const spritesScratch: Sprite[] = [];

  // Spritesheet for enemy textures uses the wall layer's mesh
  // approach. Reuses the same fpsTexCache as walls so a single
  // upload at /editor lights up both worlds.
  // (See getFpsOverrideTexture above.)
  // The textured-sprite quads go into a dedicated layer (drawn
  // above the solid-fill spriteLayer) so existing sprite code
  // can keep emitting solid columns underneath as a fallback.


  function drawSprites(W: number, H: number, fogColor: number, horizonY: number) {
    spritesScratch.length = 0;
    // Match the raycaster's HOR+ projection so sprites land
    // on the same screen-x as the wall slices around them.
    const aspect = H > 0 ? W / H : 1;
    const halfFov = VERTICAL_FOV / 2;
    const halfPlane = Math.tan(halfFov) * aspect;
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
      // hp=0 enemies are pending an enemy_killed cleanup that
      // can land a tick or two after enemy_damaged. Skip
      // rendering them so a V-cycle in the meantime doesn't
      // carry "dead but still on screen" sprites into FPS.
      if (e.hp <= 0) continue;
      const v = enemyVisualFor(e.kind);
      // White hit-flash for ~90ms on damage. Sprite is the same shape; just
      // tinted toward white.
      const hitAt = enemyHitAt.get(e.id) ?? 0;
      const hitT = Math.max(0, 1 - (performance.now() - hitAt) / flashWindow);
      const color =
        hitT > 0
          ? blendColor(v.color, 0xffffff, hitT * 0.85)
          : v.color;
      pushSprite(e.x, e.y, color, v.size * 2, 'enemy', e.kind);
    }
    for (const c of corpses.values()) {
      pushSprite(c.x, c.y, CORPSE_COLOR, CORPSE_SIZE);
    }
    for (const p of props.values()) {
      // hp=0 races: also defended in setPropHp, but safe-guard
      // here in case a snapshot brings a dead one in.
      if (p.hp <= 0) continue;
      pushSprite(p.x, p.y, 0x71717a, 22);
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

      // Optional texture for this sprite. If present, each visible
      // stripe gets a Mesh quad with a vertical UV slice; otherwise
      // fall back to flat-color rects.
      const tex =
        s.texCategory && s.texId
          ? getFpsOverrideTexture(s.texCategory, s.texId)
          : null;
      const texW = tex ? tex.width || 1 : 0;

      // Per-column z-test. Iterate at the column step so we match the wall
      // pass; for each visible stripe, paint either a textured quad or
      // a flat-color rect.
      const startStripe = Math.max(0, drawLeft);
      const endStripe = Math.min(W, drawRight);
      for (let stripe = startStripe; stripe < endStripe; stripe += COLUMN_STEP_PX) {
        const colIdx = Math.floor(stripe / COLUMN_STEP_PX);
        if (colIdx < 0 || colIdx >= zBuffer.length) continue;
        if (transformY >= zBuffer[colIdx]) continue;
        if (tex) {
          // u runs 0..1 across the sprite's screen footprint.
          const u = (stripe - drawLeft) / Math.max(1, spriteW);
          const uvX = Math.max(0, Math.min(0.999, u));
          const uvX2 = Math.min(1, uvX + 1 / texW);
          const positions = new Float32Array([
            stripe, drawTop,
            stripe + COLUMN_STEP_PX, drawTop,
            stripe + COLUMN_STEP_PX, drawTop + spriteH,
            stripe, drawTop + spriteH,
          ]);
          const uvs = new Float32Array([
            uvX, 0,
            uvX2, 0,
            uvX2, 1,
            uvX, 1,
          ]);
          const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
          const geom = new MeshGeometry({ positions, uvs, indices });
          spriteTexLayer.addChild(new Mesh({ geometry: geom, texture: tex }));
        } else {
          spriteLayer
            .rect(stripe, drawTop, COLUMN_STEP_PX, spriteH)
            .fill({ color: fogged });
        }
      }
    }

    function pushSprite(
      x: number,
      y: number,
      color: number,
      height: number,
      texCategory?: 'enemy' | 'building',
      texId?: string,
    ) {
      const dx = x - selfX;
      const dy = y - selfY;
      spritesScratch.push({
        x,
        y,
        color,
        height,
        distSq: dx * dx + dy * dy,
        texCategory,
        texId,
      });
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
  // World-height multiplier for a building hit. Mirrors iso's
  // half-height workstation cubes so a workbench / forge / etc
  // doesn't render as a full wall in FPS. Walls + doors + power
  // links keep their existing full-height baseline.
  function stationHeightMultFor(hit: RayHit): number {
    if (!hit.isBuilding || !hit.buildingKind) return 1.0;
    const def = BUILDING_REGISTRY[hit.buildingKind];
    if (!def) return 1.0;
    // Doors are tagged isStation in the registry but visually
    // they're full-height (you walk through them, not over them).
    // Special-case before the isStation check.
    if (hit.buildingKind === 'door') return 1.0;
    // Workstations are roughly waist-high — 1/3 of a wall reads
    // as "you can see over it" rather than "short wall".
    if (def.isStation) return 0.33;
    return 1.0;
  }

  // Destroys + removes every child of a layer. Call this on
  // per-frame mesh containers (wallTexLayer / spriteTexLayer)
  // because the meshes hold MeshGeometry buffers that leak when
  // only detached — over a few minutes of play the heap grows
  // until the tab dies.
  // Wolfenstein-style floor/ceiling cast: emit horizontal strip
  // quads spanning the full screen width. Within a single screen
  // row, depth is constant — rowDist = camHeight*H / |y - horizon|.
  // World positions at the leftmost (camNorm = -1) and rightmost
  // (camNorm = +1) rays at that depth become the strip's left/right
  // UV anchors. Linear interpolation across screen-x is exact
  // because depth doesn't vary along the row.
  //
  // Subdivides into STRIPS strips so each strip spans a small depth
  // range; affine vertical interpolation within a thin strip is
  // close to perspective-correct, and a per-strip fog tint gives
  // a smooth distance gradient. Strip boundaries share their y
  // (and therefore their depth and UVs), so adjacent strips meet
  // seamlessly.
  function paintFloorOrCeilingStrips(
    kind: 'floor' | 'ceiling',
    W: number,
    H: number,
    selfX: number,
    selfY: number,
    dirX: number,
    dirY: number,
    planeX: number,
    planeY: number,
    camHeight: number,
    horizonY: number,
    tile: number,
    tex: Texture,
    layer: Container,
  ): void {
    const yStart = kind === 'floor' ? horizonY + 1 : 0;
    const yEnd = kind === 'floor' ? H : Math.max(1, horizonY - 1);
    if (yEnd - yStart < 1) return;

    // ONE mesh per surface with rows every ROW_PX screen pixels.
    // Multi-strip rendering left visible "zig-zag" artifacts as
    // the strip boundaries slid with pitch — each strip's linear
    // UV interpolation approximated the true 1/dy depth curve,
    // and per-strip fog tint stepping added brightness seams.
    // With rows ~2px tall, the affine UV error per row collapses
    // below pixel resolution and the whole surface shares a single
    // tint, so no seams. The mesh is one draw call.
    const ROW_PX = 2;
    const ROWS = Math.max(2, Math.ceil((yEnd - yStart) / ROW_PX));
    const numVerts = (ROWS + 1) * 2;
    const positions = new Float32Array(numVerts * 2);
    const uvs = new Float32Array(numVerts * 2);
    const indices = new Uint32Array(ROWS * 6);

    for (let r = 0; r <= ROWS; r++) {
      const y = yStart + ((yEnd - yStart) * r) / ROWS;
      const dy =
        kind === 'floor'
          ? Math.max(0.5, y - horizonY)
          : Math.max(0.5, horizonY - y);
      const rowDist = (camHeight * H) / dy;
      // Leftmost / rightmost rays use unnormalized (dir ± plane)
      // because rowDist is the perp depth along dir; the world
      // step per unit perp is exactly (dir + plane*camNorm) for
      // the camera-plane projection.
      const wxL = selfX + rowDist * (dirX - planeX);
      const wyL = selfY + rowDist * (dirY - planeY);
      const wxR = selfX + rowDist * (dirX + planeX);
      const wyR = selfY + rowDist * (dirY + planeY);
      const base = r * 4;
      positions[base + 0] = 0;
      positions[base + 1] = y;
      positions[base + 2] = W;
      positions[base + 3] = y;
      // Raw world/tile UVs (no mod-tile clamp). Within a 2px row,
      // depth is nearly constant so linear UV interp is effectively
      // perspective-correct. Across rows, world coords change
      // continuously so adjacent rows tile seamlessly. Texture
      // address mode is set to 'repeat' on load so values >1 wrap.
      uvs[base + 0] = wxL / tile;
      uvs[base + 1] = wyL / tile;
      uvs[base + 2] = wxR / tile;
      uvs[base + 3] = wyR / tile;
    }
    for (let r = 0; r < ROWS; r++) {
      const a = r * 2;
      const b = r * 2 + 1;
      const c = (r + 1) * 2 + 1;
      const d = (r + 1) * 2;
      const i6 = r * 6;
      indices[i6 + 0] = a;
      indices[i6 + 1] = b;
      indices[i6 + 2] = c;
      indices[i6 + 3] = a;
      indices[i6 + 4] = c;
      indices[i6 + 5] = d;
    }
    const geom = new MeshGeometry({ positions, uvs, indices });
    const mesh = new Mesh({ geometry: geom, texture: tex });
    // Mesh stays untinted; per-depth fog is applied via a separate
    // alpha overlay (paintFloorOrCeilingFogOverlay) painted on top
    // of the mesh. That way fog varies smoothly with depth rather
    // than being a flat per-mesh tint.
    layer.addChild(mesh);
  }

  // Depth-based fog overlay for textured floor / ceiling. Paints a
  // stack of alpha-tinted fog strips on top of the mesh — alpha is
  // computed per strip from rowDist using the same applyFog t-curve
  // walls use, so the floor / ceiling fades into the same fog colour
  // walls do at any given distance. Lives in wallLayer (Graphics)
  // which sits above floor/ceiling meshes but below wall fills, so
  // wall columns naturally overdraw the fog where they exist.
  function paintFloorOrCeilingFogOverlay(
    kind: 'floor' | 'ceiling',
    g: Graphics,
    W: number,
    H: number,
    camHeight: number,
    horizonY: number,
    fogColor: number,
  ): void {
    const yStart = kind === 'floor' ? horizonY + 1 : 0;
    const yEnd = kind === 'floor' ? H : Math.max(1, horizonY - 1);
    if (yEnd - yStart < 1) return;
    // Pixel-aligned strips with no overlap. The previous version
    // used +1 height so strips overlapped by 1px to avoid hairline
    // gaps — but with alpha fills, the overlap region was composited
    // twice, doubling the darkness and producing visible "edge"
    // bands. Snapping to integer y boundaries means each pixel row
    // is owned by exactly one strip and there are no gaps either
    // (yB of strip s == yA of strip s+1 by construction).
    const STRIPS = 48;
    const range = yEnd - yStart;
    let prevY = Math.round(yStart);
    for (let s = 0; s < STRIPS; s++) {
      const yB = Math.round(yStart + (range * (s + 1)) / STRIPS);
      const yA = prevY;
      prevY = yB;
      if (yB <= yA) continue;
      const yMid = (yA + yB) * 0.5;
      const dy =
        kind === 'floor'
          ? Math.max(0.5, yMid - horizonY)
          : Math.max(0.5, horizonY - yMid);
      const rowDist = (camHeight * H) / dy;
      const distT = Math.min(1, rowDist / FOG_FULL_DIST);
      const t = Math.min(1, activeAmbient + (1 - activeAmbient) * distT);
      if (t <= 0.001) continue;
      g.rect(0, yA, W, yB - yA).fill({ color: fogColor, alpha: t });
    }
  }

  function disposeChildren(layer: Container): void {
    while (layer.children.length > 0) {
      const child = layer.children[0];
      layer.removeChildAt(0);
      try {
        // context:true releases per-frame Graphics children's
        // GraphicsContext (Pixi v8 leaves it alive by default,
        // assuming the context might be shared — for our per-hit
        // AO-bleed Graphics on wallTexLayer, it isn't, and the
        // GPU command buffers leak without this).
        // Mesh / TilingSprite / etc ignore the context flag.
        child.destroy({ children: true, context: true });
      } catch {
        /* best-effort; some children may already be torn down */
      }
    }
  }

  function applyFog(base: number, dist: number, fog: number): number {
    // Ambient is a floor on t — even at distance 0 there's some
    // baseline blend toward fog colour, simulating dungeon darkness.
    // t = ambient + (1 - ambient) * dist/FOG_FULL_DIST keeps the
    // far-distance saturation at t=1 while raising the near-camera
    // floor.
    const distT = dist > 0 ? Math.min(1, dist / FOG_FULL_DIST) : 0;
    const t = Math.min(1, activeAmbient + (1 - activeAmbient) * distT);
    if (t <= 0) return base;
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

  // wallU: fractional position along the wall face the ray hit
  // (0..1, west→east on N/S faces, north→south on E/W faces).
  // Drives the texture-column sampling for textured walls.
  // buildingKind: only set when isBuilding is true; lets the
  // texture pass pick the right per-kind override.
  type RayHit = {
    dist: number;
    // Along-ray distance at which the ray EXITS the hit tile.
    // For full-height walls it's irrelevant (ray stops there);
    // for short obstacles it defines the far edge of the top
    // surface used by the floor-cast top renderer.
    exitDist: number;
    faceNS: boolean;
    isBuilding: boolean;
    wallU: number;
    buildingKind: import('@dumrunner/shared').BuildingKind | null;
  };

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
  // Walks the ray collecting every wall / building tile in its
  // path. Stops at the first FULL-HEIGHT obstruction (walls,
  // doors and stations are short and let the ray pass; the back
  // wall behind a workstation still gets rendered). Hits come
  // back near-to-far; the render loop paints them far-to-near so
  // closer slices correctly overdraw the back wall.
  function castRay(
    ox: number,
    oy: number,
    dx: number,
    dy: number,
  ): RayHit[] {
    const out: RayHit[] = [];
    if (!layout) return out;
    const tileSize = layout.tileSize;
    if (tileSize <= 0) return out;
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
      if (dist > RAY_MAX_DIST) return out;

      // Wall classification at the tile we just stepped into.
      const cx = (mx + 0.5) * tileSize;
      const cy = (my + 0.5) * tileSize;
      const insideWalkable = !hasWalkables || isInsideAny(layout.walkables, cx, cy);
      const buildingKind = buildingKindAt(mx, my);
      const isBuilding = buildingKind !== null;
      if (!insideWalkable || isBuilding) {
        // Hit point in world coords. Texture-column sampling
        // picks the fractional offset along the wall face.
        const hitX = ox + dx * dist;
        const hitY = oy + dy * dist;
        let wallU: number;
        if (faceNS) {
          // Crossed a horizontal (N/S) face — texture spans
          // along x within the tile.
          wallU = ((hitX % tileSize) + tileSize) % tileSize;
          wallU /= tileSize;
        } else {
          wallU = ((hitY % tileSize) + tileSize) % tileSize;
          wallU /= tileSize;
        }
        // Along-ray distance at which we EXIT the tile. We just
        // entered, so sideX/sideY have been advanced past this
        // tile boundary on whichever axis we crossed; the next
        // boundary is min(current sideX, current sideY).
        const exitDist = Math.min(sideX, sideY);
        const hit: RayHit = {
          dist,
          exitDist,
          faceNS,
          isBuilding,
          wallU,
          buildingKind,
        };
        out.push(hit);
        // Stop only when we hit a full-height obstruction. Short
        // obstacles (workstations, doors) are recorded then we
        // keep walking to find the wall behind them.
        if (stationHeightMultFor(hit) >= 1.0) return out;
      }
    }
    return out;
  }


  function buildingKindAt(
    mx: number,
    my: number,
  ): import('@dumrunner/shared').BuildingKind | null {
    if (buildings.size === 0) return null;
    for (const b of buildings.values()) {
      if (
        mx >= b.tileX &&
        mx < b.tileX + b.width &&
        my >= b.tileY &&
        my < b.tileY + b.height
      ) {
        return b.kind;
      }
    }
    return null;
  }


  // ---------- GameHandle implementation ----------

  function applySceneState(state: SceneState) {
    layout = state.layout;
    players.clear();
    enemies.clear();
    loot.clear();
    corpses.clear();
    buildings.clear();
    props.clear();
    projectiles.clear();
    projectileSpawnedAt.clear();
    for (const p of [state.self, ...state.players]) players.set(p.characterId, p);
    for (const e of state.enemies) enemies.set(e.id, e);
    for (const l of state.loot) loot.set(l.id, l);
    for (const c of state.corpses) corpses.set(c.id, c);
    for (const b of state.buildings) buildings.set(b.id, b);
    for (const p of state.props) props.set(p.id, p);
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
    spawnProp(p) {
      props.set(p.id, p);
    },
    setPropHp(id, hp, maxHp) {
      const p = props.get(id);
      if (p) {
        p.hp = hp;
        p.maxHp = maxHp;
        if (hp <= 0) props.delete(id); // hide-on-zero defence
      }
    },
    removeProp(id) {
      props.delete(id);
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
    getMinimapSnapshot(): MinimapSnapshot {
      return {
        selfX,
        selfY,
        selfId: init.self.characterId,
        tileSize: layout?.tileSize ?? 32,
        walkables: layout?.walkables ?? [],
        rooms: layout?.rooms,
        roomCategories: layout?.roomCategories,
        buildings: buildingsToMinimapList(
          [...buildings.values()],
        ),
        players: [...players.values()].map((p) => ({
          characterId: p.characterId,
          x: p.x,
          y: p.y,
          // FPS doesn't apply LOS-based hiding to remote players,
          // so they're all visible on the minimap.
          visible: true,
        })),
        enemies: [...enemies.values()].map((e) => ({
          x: e.x,
          y: e.y,
          hp: e.hp,
          visible: true,
        })),
      };
    },
    getSelfPosition() {
      return { x: selfX, y: selfY };
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
        props: [...props.values()].map((p) => ({ ...p })),
        layout,
      };
    },
    destroy() {
      unsubFpsOverrides();
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

