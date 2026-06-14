// v2 FPS renderer entry. Mirrors the v1 `runFpsGame(host, init)`
// API (returns a `GameHandle`) so `Game.tsx`'s `runnerFor()`
// dispatch can drop us in behind the `?v2=1` toggle without
// touching downstream code.
//
// Phase 1 scope: stand up the Pixi `Application`, mount a single
// floor quad rendered through the custom sector shader, wire
// look input through the existing `applyLookDelta` contract,
// stub every other `GameHandle` method. No entities, no walls,
// no lighting yet.
//
// Anything past "render one quad with the camera responding to
// look" lives in later phases.

'use client';

import {
  Application,
  Buffer,
  BufferUsage,
  Container,
  Geometry,
  Graphics,
  Mesh,
  Sprite,
  Texture,
} from 'pixi.js';
import { biomeFallbackColors, convertLayoutToSectorMap } from './converter';
import { makeLabeledFallbackTexture } from './labeledFallback';
import {
  buildSectorGeometry,
  buildTexturedCeilingGeometry,
  buildTexturedFloorGeometry,
  buildTexturedWallGeometry,
} from './sectorGeometry';
import { createSpriteLayer, type SpriteRequest } from './spriteLayer';
import { createParticleSystem } from './particles';
import { lookupTexture } from './textureCache';
import {
  createTexturedSectorCameraUniforms,
  createTexturedSectorShader,
} from './texturedSectorShader';
import { createTexturedBuildingLayer } from './texturedBuildingLayer';
import { createGhostCubeLayer } from './ghostCube';
import { createMountSocketsLayer } from './mountSockets';
import { createFogUniforms } from './fogUniforms';
import { createLightingUniforms } from './lightingUniforms';
import {
  createLightManager,
  extractPadLightAt,
  muzzleFlashAt,
  stairsDownLightAt,
  type StaticLight,
} from './lights';
import {
  biomePaletteFor,
  sectorNoiseOffsetAt,
  terrainHeightAt,
} from '@dumrunner/shared';
import { createTexturedSpriteLayer } from './texturedSpriteLayer';
import { getAnimationFrame, playEntityState } from '../../entityAnimations';

import type { GameHandle, GameInit, SceneState } from '../types';
import {
  BUILDING_REGISTRY,
  INTERACTABLE_RADIUS,
  WEAPON_PROJECTILE_ANIM,
  WEAPON_VIEW_ANIM,
  WEAPON_FAMILY,
  biomeWallHeightTilesFor,
  buildingVisualFor,
  decodeTileGrid,
  enemyVisualFor,
  insideClearingPad,
  isTurretKind,
  isWalkableTileId,
  materialTint,
  propVisualFor,
  tileIdAt,
  TIER_COLORS_NUM,
  type BuildingState,
  type CorpseState,
  type EnemyState,
  type Interactable,
  type LootState,
  type PlaceableBuildingKind,
  type Player,
  type ProjectileState,
  type PropState,
  type SceneLayout,
} from '@dumrunner/shared';
import {
  buildingsToMinimapList,
  loadFogState,
  pruneFogStateForCycle,
  saveFogState,
  type MinimapSnapshot,
} from '../minimap';

import { Camera } from './camera';
import { createSectorShader } from './sectorShader';

// Tiny square at the player spawn so the Mesh has something to
// draw between mount and the first SectorMap apply. Distinct
// magenta so any bug that leaves us in placeholder state is
// visually obvious instead of silently looking "correct".
function makePlaceholderGeometry(spawnX: number, spawnY: number): Geometry {
  const HALF = 16;
  const positions = new Float32Array([
    spawnX - HALF, spawnY - HALF, 0,
    spawnX + HALF, spawnY - HALF, 0,
    spawnX + HALF, spawnY + HALF, 0,
    spawnX - HALF, spawnY + HALF, 0,
  ]);
  const colors = new Float32Array([
    1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return new Geometry({
    attributes: {
      aPosition: {
        buffer: new Buffer({
          data: positions,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x3',
      },
      aBaseColor: {
        buffer: new Buffer({
          data: colors,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x3',
      },
    },
    indexBuffer: new Buffer({
      data: indices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
  });
}

// Placeholder for the textured sector/floor/ceiling/wall meshes.
// Pixi v8 still binds a hidden mesh's geometry on draw, so the
// attribute set has to satisfy the textured-sector shader (aPosition
// + aUV + aBrightness) even when the mesh has visible=false. A
// degenerate quad keeps the index count valid; visibility is gated
// elsewhere so nothing actually paints.
function makeTexturedPlaceholderGeometry(): Geometry {
  const positions = new Float32Array(12); // 4 verts × xyz, zeroed
  const uvs = new Float32Array(8);
  const brightness = new Float32Array(4);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return new Geometry({
    attributes: {
      aPosition: {
        buffer: new Buffer({
          data: positions,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x3',
      },
      aUV: {
        buffer: new Buffer({
          data: uvs,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32x2',
      },
      aBrightness: {
        buffer: new Buffer({
          data: brightness,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }),
        format: 'float32',
      },
    },
    indexBuffer: new Buffer({
      data: indices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
  });
}

export function runFpsV2Game(
  host: HTMLElement,
  init: GameInit,
): GameHandle {
  const app = new Application();
  let canvasEl: HTMLCanvasElement | null = null;
  let ready = false;
  let destroyed = false;

  // Camera + input state. yaw/pitch are mutated through the
  // GameHandle's applyLookDelta contract (mouse + touch joystick
  // both call into it through Game.tsx).
  const camera = new Camera();
  // Initial floor lookup happens before layout is touched — the
  // first frame's tickSelfSmoothing will overwrite this once
  // layout is in place. Seeding at 0 keeps the camera math
  // valid until then.
  camera.setSelfPosition(init.self.x, init.self.y, 0);

  // Server-authoritative target for the local player. movePlayer
  // sets this; tickSelfSmoothing lerps the camera toward it each
  // frame so between-tick network updates don't snap the view.
  // Same pattern v1 uses — without smoothing, motion looks
  // jittery because the server only sends position updates at
  // ~20 Hz while the renderer runs at 60.
  let targetSelfX = init.self.x;
  let targetSelfY = init.self.y;
  // Snap (not lerp) when the divergence is bigger than this —
  // scene transitions, teleports, respawns. 96 world units
  // ≈ 3 tiles.
  const SELF_SNAP_PX = 96;
  let lastSelfTickAt = 0;

  // Client-side movement prediction. The local player moves
  // IMMEDIATELY from input each frame (no waiting for the server
  // round-trip), then the lagged authoritative position gently
  // corrects drift. Without this, on a real-latency server the
  // camera only advances when a ~20Hz snapshot arrives — it lerps
  // to each one and stalls between, reading as smooth "hops". Must
  // mirror the server's movement math (scene.ts simulatePlayer
  // movement): normalized move vector, base 140 px/s, sprint 1.6×,
  // crouch 0.55×. Duplicated like the jump constants because COMBAT
  // is server-only.
  const PRED_MOVE_SPEED = 140;
  const PRED_SPRINT_MULT = 1.6;
  const PRED_CROUCH_MULT = 0.55;
  const PRED_PLAYER_RADIUS = 10; // mirror COMBAT.PLAYER_RADIUS
  // Predicted local move vector (normalized) + sprint/crouch state,
  // set each frame in tickInput, consumed in tickSelfSmoothing.
  let predMoveX = 0;
  let predMoveY = 0;
  let predSprint = false;
  let predCrouch = false;
  // Reconciliation: correct the predicted position toward the
  // authoritative one. Gentle when the error is small (preserve the
  // RTT-sized lead that makes input feel instant), firm when it's
  // large (snap back from a wall the client predicted through, since
  // the client doesn't run collision). Below CORRECT_SOFT_PX use the
  // slow tau, at/above CORRECT_HARD_PX use the fast tau, lerp between.
  const CORRECT_TAU_SLOW_MS = 220;
  const CORRECT_TAU_FAST_MS = 35;
  const CORRECT_SOFT_PX = 6;
  const CORRECT_HARD_PX = 40;

  // Smoothed absolute feet z the camera reads. While grounded it
  // targets the local floor mirror under the lerped XY (snap up
  // on step-up, lerp down on step-down); while airborne it runs
  // a ballistic prediction corrected toward the server's
  // broadcast absolute z. selfZ is the latest server-reported
  // absolute feet z.
  let cameraZ = 0;
  const FLOOR_SMOOTH_TAU_MS = 70;

  // Vertical movement state mirrored from the server. selfZ is
  // the server-reported target; cameraZ is the per-frame value
  // the camera actually reads. The client runs the SAME ballistic
  // integration as the server (COMBAT.GRAVITY / JUMP_VZ_INIT) so
  // the arc renders as a smooth 60 Hz parabola, with a soft
  // correction lerp toward the 20 Hz server samples so we never
  // drift from authority (head-bonks, landings).
  let selfZ = 0;
  let predVZ = 0;
  // Server-authoritative grounded/airborne bit, mirrored from the
  // player_moved broadcast. The smoothing pass keys airborne
  // classification off THIS — never off "selfZ vs the local floor
  // mirror at the smoothed XY". The smoothed XY lags the server
  // position by ~speed·tau, so on sloped terrain the broadcast z
  // sits above the lagging mirror every tick and a mirror-based
  // check misclassifies grounded walking as airborne, integrating
  // gravity into the camera (the "sink while moving, snap on
  // stop" regression).
  let selfAirborne = false;
  let selfCrouching = false;
  const JUMP_CORRECT_TAU_MS = 80;
  // Mirror of the server's jump physics (COMBAT.JUMP_VZ_INIT /
  // COMBAT.GRAVITY in packages/server/src/combat.ts) — duplicated
  // here like STEP_UP_MAX because COMBAT is a server-only module.
  // Keep in sync or the predicted arc drifts from authority.
  const JUMP_VZ_INIT = 100;
  const JUMP_GRAVITY = 200;
  // Edge-detect for the Space jump press so we send jump=true
  // only on the press frame, not while held.
  let lastSpaceDown = false;

  // Impact particles — blood bursts on flesh hits, spark bursts
  // on surface hits. Owned by the renderer (no server state);
  // fixed-pool CPU sim ticked from updateSprites, rendered as
  // tiny depth-tested billboards through the sprite layer.
  const particles = createParticleSystem();

  // Minimap fog. seenTiles is a per-cell bitmap (1 byte/cell)
  // that the minimap painter reads to dim unexplored tiles.
  // Cached by sceneId so re-entering a scene (surface → dungeon
  // floor 2 → surface) restores prior exploration instead of
  // re-blacking the whole map. Same model as v1.
  //
  // On top of the in-memory cache, fog persists to localStorage
  // per (serverId, sceneId) so a page refresh restores explored
  // state. fogStoreId gates the whole feature — sandbox / editor
  // previews don't pass a serverId and get session-only fog.
  const fogStoreId = init.serverId ?? null;
  const fogBySceneId = new Map<string, Uint8Array>();
  // Cycle each cached bitmap belongs to. null = explored (or
  // restored from a save taken) before the first world_clock of
  // the session; tagged with the live cycle once it arrives.
  const fogCycleBySceneId = new Map<string, number | null>();
  // Current world cycle, fed by setWorldCycle from the
  // world_clock / horde broadcasts. null until the first one.
  let worldCycle: number | null = null;
  // Set when revealAroundSelf uncovers a new cell; cleared on
  // save. Gates the throttled persistence writes.
  let fogDirty = false;
  let lastFogSaveAt = 0;
  const FOG_SAVE_INTERVAL_MS = 5000;

  // Allocate the seen bitmap for a scene, preferring (in order)
  // the in-memory cache, a localStorage save, and a fresh zeroed
  // array. Cache entries / saves whose dimensions no longer match
  // the live grid (cycle regen) are dropped and rebuilt.
  function fogForScene(
    sceneId: string,
    lay: SceneLayout | null,
  ): Uint8Array | null {
    const tg = lay?.tileGrid;
    if (!tg) return null;
    const cellCount = tg.width * tg.height;
    const cached = fogBySceneId.get(sceneId);
    if (cached && cached.length === cellCount) return cached;
    // Restored bitmaps keep the cycle their save recorded (which
    // may differ from worldCycle when the save predates the first
    // world_clock of this session) so setWorldCycle can invalidate
    // them once the live cycle number lands.
    let fresh: Uint8Array | null = null;
    let freshCycle: number | null = worldCycle;
    if (fogStoreId) {
      const restored = loadFogState(
        fogStoreId,
        sceneId,
        tg.width,
        tg.height,
        worldCycle,
        lay?.variantSeed,
      );
      if (restored) {
        fresh = restored.seen;
        freshCycle = restored.cycle ?? worldCycle;
      }
    }
    fresh ??= new Uint8Array(cellCount);
    fogBySceneId.set(sceneId, fresh);
    fogCycleBySceneId.set(sceneId, freshCycle);
    return fresh;
  }

  // Persist the active scene's fog. No-op without a serverId or
  // when nothing changed since the last write (unless forced —
  // scene swaps and teardown always flush).
  function saveCurrentFog(force = false): void {
    if (!fogStoreId || !seenTiles || !layout?.tileGrid) return;
    if (!fogDirty && !force) return;
    saveFogState(
      fogStoreId,
      currentSceneId,
      seenTiles,
      layout.tileGrid.width,
      layout.tileGrid.height,
      // Prefer the bitmap's own cycle tag — a restore that landed
      // before the first world_clock carries its save's cycle,
      // which must not be downgraded to null on rewrite.
      fogCycleBySceneId.get(currentSceneId) ?? worldCycle,
      layout.variantSeed,
    );
    fogDirty = false;
    lastFogSaveAt = performance.now();
  }

  // beforeunload catches the refresh / tab-close path that
  // destroy() never sees. Removed in destroy().
  function onBeforeUnload(): void {
    saveCurrentFog();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  let seenTiles: Uint8Array | null = fogForScene(init.sceneId, init.layout);
  // Reveal radius around the player, in tiles. Same default v1
  // uses; tuned so an entire small room reveals on entry without
  // exposing what's behind a corner.
  const FOG_REVEAL_RADIUS_TILES = 6;

  // Keyboard state for WASD movement. Mirrors v1's tickInput
  // pattern so the input contract with the server is unchanged.
  const keys = new Set<string>();
  // Mobile joystick override of the WASD vector — set by
  // GameHandle.setMobileMove. When active, replaces keyboard
  // input entirely (matches v1's behaviour).
  let mobileMoveForward = 0;
  let mobileMoveRight = 0;
  let mobileSprint = false;
  let mobileMoveActive = false;
  // Fire state — desktop mouse-down (gated on pointer lock) or
  // mobile setFireHeld flag. tick reads either to decide whether
  // to emit a sendFire call this frame; per-weapon cooldown is
  // server-side so spamming doesn't bypass intervals.
  let mouseDown = false;
  let mobileFireHeld = false;
  // Currently equipped weapon. setEquippedWeapon flips this;
  // gates fire so an unequipped player doesn't pulse the network
  // with sendFire calls.
  let equippedWeapon: import('@dumrunner/shared').WeaponKind | null = null;

  // Entity state. Phase 1 only needs `players` populated so the
  // camera's self position can follow the local player; later
  // phases pull from the rest.
  let layout: SceneLayout | null = init.layout;
  let currentSceneId: string = init.sceneId;
  let selfX = init.self.x;
  let selfY = init.self.y;
  const players = new Map<string, Player>();
  const enemies = new Map<string, EnemyState>();
  const projectiles = new Map<string, ProjectileState>();
  // Timestamp (performance.now()) the server's projectile_spawned
  // message landed. Used to extrapolate position via (x + vx*dt,
  // y + vy*dt) — server only sends spawn + despawn, never mid-
  // flight updates. Without this projectiles would freeze at
  // their muzzle position until the despawn TTL fires.
  const projectileSpawnedAt = new Map<string, number>();
  const loot = new Map<string, LootState>();
  const corpses = new Map<string, CorpseState>();
  const buildings = new Map<string, BuildingState>();
  const props = new Map<string, PropState>();
  for (const p of [init.self, ...init.others]) {
    players.set(p.characterId, p);
  }
  for (const e of init.enemies) enemies.set(e.id, e);
  for (const pr of init.projectiles) {
    projectiles.set(pr.id, pr);
    projectileSpawnedAt.set(pr.id, performance.now());
  }
  for (const l of init.loot) loot.set(l.id, l);
  for (const c of init.corpses) corpses.set(c.id, c);
  for (const b of init.buildings) buildings.set(b.id, b);
  for (const p of init.props) props.set(p.id, p);

  // ---- HUD / feedback state ----
  // Build mode: when non-null, the player has a placeable selected
  // and the renderer paints a translucent ghost at the target tile
  // + sends a build_request on click. Surface only — Game.tsx
  // toggles it off on dungeon transitions.
  let buildMode: PlaceableBuildingKind | null = null;
  let buildRadiusBonusTiles = 0;
  // Debounce so one click doesn't fire build_request every frame
  // while held.
  let lastBuildSentAt = 0;
  const BUILD_DEBOUNCE_MS = 200;
  // Horde mode: surface skybox tints red when true. Drives
  // `setHordeActive` from the world-clock broadcast.
  let hordeActive = false;
  // Self HP — tracks deltas across setPlayerHp calls so a hit
  // can trigger a red damage overlay. selfDead drives a dimmer,
  // longer-lasting overlay variant.
  let lastSelfHp = init.self.hp;
  let lastSelfMaxHp = init.self.maxHp;
  let lastHpDropAt = 0;
  let lastBigHpDropAt = 0;
  // Shield damage gets its own (cyan) flash so soaking a hit on
  // shields reads differently from taking it on HP.
  let lastSelfShield = init.self.shield ?? 0;
  let lastShieldDropAt = 0;
  let selfDead = false;
  // Per-entity hit-flash timestamps. The render passes (enemies,
  // building cubes, props) read these to apply a brief white tint
  // when the timestamp is recent. prevHp maps gate "did HP drop?"
  // so heal events don't trigger a flash.
  const enemyHitFlashAt = new Map<string, number>();
  const enemyPrevHp = new Map<string, number>();
  const buildingHitFlashAt = new Map<string, number>();
  const buildingPrevHp = new Map<string, number>();
  const propHitFlashAt = new Map<string, number>();
  const propPrevHp = new Map<string, number>();
  const HIT_FLASH_MS = 90;
  const DAMAGE_FLASH_MS = 240;
  for (const e of init.enemies) enemyPrevHp.set(e.id, e.hp);
  for (const b of init.buildings) buildingPrevHp.set(b.id, b.hp);
  for (const p of init.props) propPrevHp.set(p.id, p.hp);

  // Shared fog parameter group — one write per frame in tick()
  // updates every shader sampling it.
  const fog = createFogUniforms();
  fog.setRange(200, 700);
  // Shared lighting uniforms + a tiny manager that owns the
  // dynamic-light pool (muzzle flashes, explosions, attached
  // pulses). The manager runs the per-frame TTL decay and
  // writes the top-MAX_LIGHTS into the uniform group sorted by
  // camera distance.
  const lighting = createLightingUniforms();
  const lights = createLightManager(lighting);

  const shaderHandle = createSectorShader(fog);
  // Mesh + geometry start as a placeholder quad so the renderer
  // never has an empty Mesh during the first frames before
  // applySectorMap() lands real geometry. Once a layout shows up
  // we destroy this placeholder and replace it with the real
  // converted mesh.
  let geometry = makePlaceholderGeometry(init.self.x, init.self.y);
  const mesh = new Mesh({ geometry, shader: shaderHandle.shader });
  // Textured sector overlays: floor, ceiling, wall. Each carries
  // its own Geometry built from the SectorMap and a Shader bound
  // to the biome's per-surface texture. Rendered after the
  // colored sector mesh so co-planar triangles win on LEQUAL
  // depth and the colored mesh remains as a fallback wherever
  // the textured layer has no geometry yet.
  const texturedSectorCameraUniforms = createTexturedSectorCameraUniforms();
  function makeTexturedSurfaceMesh(): Mesh<Geometry, import('pixi.js').Shader> {
    const shader = createTexturedSectorShader(
      texturedSectorCameraUniforms,
      fog,
      lighting,
      Texture.EMPTY,
    );
    const m = new Mesh({
      // Textured-mesh placeholder needs aUV + aBrightness so the
      // VAO compatibility check passes when the hidden mesh is
      // bound — the colored placeholder shape only has
      // aPosition + aBaseColor and trips Pixi v8.
      geometry: makeTexturedPlaceholderGeometry(),
      shader,
    });
    m.cullable = false;
    m.eventMode = 'none';
    m.state.depthTest = true;
    m.state.depthMask = true;
    m.state.culling = false;
    // Polygon offset pushes these fragments slightly toward
    // the camera, so coplanar triangles from the colored sector
    // mesh lose the GL_LESS depth comparison and the textured
    // pass paints on top. Without this, equal-Z geometry from
    // the colored mesh wins (LESS, not LEQUAL — Pixi v8 uses
    // WebGL defaults), which is why the texture pass appeared
    // invisible at first.
    m.state.polygonOffset = -1;
    m.visible = false;
    return m;
  }
  const texturedFloorMesh = makeTexturedSurfaceMesh();
  const texturedCeilingMesh = makeTexturedSurfaceMesh();
  const texturedWallMesh = makeTexturedSurfaceMesh();
  // Per-kind building cube textures. Lives in its own container
  // so the renderer can manage Z-order independently of the
  // surface meshes. Rebuilt on every building event.
  const texturedBuildings = createTexturedBuildingLayer(fog, lighting);
  // Translucent 3D cube drawn at the targeted tile while build
  // mode is on. Driven entirely by setBuildMode + per-frame
  // updateGhostCube().
  const ghostCube = createGhostCubeLayer(fog);
  // Turret mount socket pads (base layouts P3) — flat markers on free
  // mounts so the player sees where turrets snap. Rebuilt per frame
  // from layout.turretMounts minus the mounts a turret already
  // occupies. Always rendered on the surface (not gated on build
  // mode), so the sockets read as fixed base infrastructure.
  const mountSockets = createMountSocketsLayer(fog);
  // Sprite layer (P3.1): one big mesh, rebuilt each frame from
  // the current entity state, sharing the sector shader for
  // now (untextured colored quads). Added to the stage AFTER
  // the sector mesh so depth test resolves overlaps cleanly.
  const sprites = createSpriteLayer(shaderHandle.shader);
  // Textured sprite layer (P3.2). Lives alongside the colored
  // one. Routing rule: any entity whose animation system
  // returns a Texture this frame goes here; everything else
  // falls back to the colored layer so the player still sees
  // SOMETHING for unauthored content.
  const texturedSprites = createTexturedSpriteLayer(fog, lighting);
  // FPS view-model. Rendered as a 2D Pixi Sprite anchored at
  // its bottom-centre, positioned at the bottom-centre of the
  // canvas, scaled to a fixed fraction of viewport height. Lives
  // outside the depth-tested 3D mesh stack so it never z-fights
  // against close walls.
  //
  // Texture comes from getAnimationFrame against
  // WEAPON_VIEW_ANIM[equippedWeapon] — same animation library
  // v1 reads, so a weapon authored for v1 lights up here too.
  // Fire / reload state transitions are triggered by the
  // GameHandle's spawnProjectile (self-owned) +
  // notifyReloadStarted hooks below.
  // Skybox: two Pixi Sprites in a Container, drawn behind every
  // 3D layer. Two sprites instead of one TilingSprite so we can
  // pan vertically with pitch without revealing TilingSprite's
  // vertical-tile seam (it tiles in both axes; there's no
  // horizontal-only mode). The pair handshake at the wrap
  // boundary so 360° yaw remains seamless: sprite A at offset
  // X, sprite B at X + panoramaPx — whichever covers the
  // canvas wins. Texture comes from `biome_skybox/<biomeId>`
  // if authored; otherwise the container is hidden.
  const skybox = new Container();
  const skyboxA = new Sprite(Texture.EMPTY);
  const skyboxB = new Sprite(Texture.EMPTY);
  skybox.addChild(skyboxA);
  skybox.addChild(skyboxB);
  skybox.visible = false;

  // Crosshair — a small white "+" pinned to the canvas centre.
  // Drawn last so HUD overlays on top of the 3D scene but it
  // sits below view-model (a fired bullet should obscure the
  // crosshair the same way the view-model does, e.g. on heavy
  // weapons that take up the centre).
  const crosshair = new Graphics();

  // Damage overlay — full-screen red vignette quad that pulses
  // alpha on hit. Drawn over the 3D scene but under the
  // view-model + crosshair so a low-HP screen still resolves a
  // shot's aim point.
  const damageOverlay = new Graphics();
  damageOverlay.visible = false;

  const VIEW_MODEL_SCREEN_FRACTION = 0.42;
  const viewModel = new Sprite(Texture.EMPTY);
  viewModel.anchor.set(0.5, 1);
  viewModel.visible = false;

  function viewModelKey(weaponId: string): string {
    return `view::${weaponId}`;
  }

  function updateCrosshair(): void {
    if (!canvasEl) return;
    crosshair.clear();
    const W = canvasEl.width;
    const H = canvasEl.height;
    const cx = W / 2;
    const cy = H / 2;
    // 12-pixel cross with a 4px gap in the middle so the centre
    // pixel doesn't obscure precision aiming. White at 70%
    // alpha to read against any biome floor / wall.
    const arm = 6;
    const gap = 4;
    const color = 0xffffff;
    const alpha = 0.7;
    crosshair
      .moveTo(cx - arm - gap, cy)
      .lineTo(cx - gap, cy)
      .moveTo(cx + gap, cy)
      .lineTo(cx + gap + arm, cy)
      .moveTo(cx, cy - arm - gap)
      .lineTo(cx, cy - gap)
      .moveTo(cx, cy + gap)
      .lineTo(cx, cy + gap + arm)
      .stroke({ color, alpha, width: 2 });
  }

  function updateDamageOverlay(): void {
    if (!canvasEl) return;
    const now = performance.now();
    let alpha = 0;
    let color = 0x9b0000; // red = HP / death
    // Shield flash (cyan) — shown when it's the most recent hit and
    // no HP flash is currently stronger. Computed first so the HP
    // pulse below can override both alpha and colour.
    const ageShield = now - lastShieldDropAt;
    if (!selfDead && ageShield < DAMAGE_FLASH_MS) {
      const shieldAlpha = 0.3 * (1 - ageShield / DAMAGE_FLASH_MS);
      if (shieldAlpha > alpha) {
        alpha = shieldAlpha;
        color = 0x1fb6d6; // cyan = shield
      }
    }
    if (selfDead) {
      alpha = 0.55;
      color = 0x9b0000;
    } else {
      // Recent HP-hit pulse: fades over DAMAGE_FLASH_MS. Bigger
      // chunks of HP loss (>15%) get a stronger flash. Any HP flash
      // that wins the alpha also forces the colour to red (over a
      // concurrent shield flash). Helper keeps colour + alpha in sync.
      const bumpRed = (a: number): void => {
        if (a > alpha) {
          alpha = a;
          color = 0x9b0000;
        }
      };
      const ageSmall = now - lastHpDropAt;
      if (ageSmall < DAMAGE_FLASH_MS) {
        bumpRed(0.32 * (1 - ageSmall / DAMAGE_FLASH_MS));
      }
      const ageBig = now - lastBigHpDropAt;
      if (ageBig < DAMAGE_FLASH_MS * 1.5) {
        bumpRed(0.55 * (1 - ageBig / (DAMAGE_FLASH_MS * 1.5)));
      }
      // Low-HP background tint so the player feels the danger
      // without needing to glance at the HUD bar.
      if (lastSelfMaxHp > 0) {
        const hpFrac = Math.max(0, lastSelfHp) / lastSelfMaxHp;
        if (hpFrac < 0.3) {
          bumpRed(0.14 * (1 - hpFrac / 0.3));
        }
      }
    }
    if (alpha <= 0.001) {
      damageOverlay.visible = false;
      return;
    }
    damageOverlay.visible = true;
    damageOverlay.clear();
    damageOverlay
      .rect(0, 0, canvasEl.width, canvasEl.height)
      .fill({ color, alpha });
  }

  function updateSkybox(): void {
    if (!canvasEl) return;
    const biomeId = layout?.biome ?? 'default';
    const tex = lookupTexture('biome_skybox', biomeId);
    if (!tex || tex.width <= 0 || tex.height <= 0) {
      skybox.visible = false;
      return;
    }
    if (skyboxA.texture !== tex) {
      skyboxA.texture = tex;
      skyboxB.texture = tex;
    }
    // Horde mode tints the skybox a deep red — same texture, just
    // recoloured. Avoids needing a per-biome perihelion variant.
    const skyTint = hordeActive ? 0xc04030 : 0xffffff;
    skyboxA.tint = skyTint;
    skyboxB.tint = skyTint;
    const W = canvasEl.width;
    const H = canvasEl.height;
    // Each sprite renders one full panorama. Width of one
    // panorama = 4× canvas width, so a 90° turn pans by ~one
    // canvas — close to a typical horizontal FOV. Height
    // preserves the texture's natural aspect but is forced to
    // at least 1.5× canvas height so pitch panning has room
    // to move without exposing the sprite's top / bottom edge.
    const panoramaPx = W * 4;
    const naturalH = panoramaPx * (tex.height / tex.width);
    const spriteH = Math.max(naturalH, H * 1.5);
    skyboxA.width = panoramaPx;
    skyboxA.height = spriteH;
    skyboxB.width = panoramaPx;
    skyboxB.height = spriteH;
    // Yaw → horizontal offset, modulo panorama. Two sprites
    // at offsetX and offsetX + panoramaPx guarantee the canvas
    // is always covered by at least one (since each sprite is
    // a full canvas-relevant width wide and the offset is
    // bounded to [-panoramaPx, 0]).
    const rawX = -(camera.yaw / (Math.PI * 2)) * panoramaPx;
    // JS modulo on negative numbers preserves sign; force into
    // [0, panoramaPx).
    const modX = ((rawX % panoramaPx) + panoramaPx) % panoramaPx;
    const offsetX = modX - panoramaPx; // [-panoramaPx, 0)
    skyboxA.x = offsetX;
    skyboxB.x = offsetX + panoramaPx;
    // Vertical: pitch pans within (spriteH - canvasH). At
    // pitch=0 the canvas shows the texture's middle. Pitch up
    // (camera looks up) → sprite moves down → canvas reveals
    // texture's upper portion. Bound to PITCH_LIMIT (1.2 rad)
    // so the pan never overshoots the sprite's edges.
    const verticalSlack = Math.max(0, spriteH - H);
    const baseY = -verticalSlack / 2;
    const pitchY = (camera.pitch / 1.2) * (verticalSlack / 2);
    skyboxA.y = baseY + pitchY;
    skyboxB.y = baseY + pitchY;
    skybox.visible = true;
  }

  function updateViewModel(): void {
    if (!canvasEl) return;
    if (equippedWeapon === null) {
      viewModel.visible = false;
      return;
    }
    const animId = WEAPON_VIEW_ANIM[equippedWeapon];
    const animTex = getAnimationFrame(
      animId,
      viewModelKey(equippedWeapon),
      performance.now(),
      'idle',
    );
    // Labeled fallback when the weapon's view animation isn't
    // authored — surfaces the missing asset in-game instead of
    // hiding the view-model entirely.
    const tex =
      animTex && animTex.width > 0 && animTex.height > 0
        ? animTex
        : makeLabeledFallbackTexture('weapon_view', equippedWeapon, 0x3f3f46);
    if (viewModel.texture !== tex) {
      viewModel.texture = tex;
    }
    const H = canvasEl.height;
    const targetH = H * VIEW_MODEL_SCREEN_FRACTION;
    const scale = targetH / tex.height;
    viewModel.scale.set(scale);
    viewModel.x = canvasEl.width / 2;
    viewModel.y = H;
    viewModel.visible = true;
  }
  // Mesh.cullable defaults to false, but be explicit — our 3D
  // positions land outside any 2D culling rect Pixi could
  // compute, so any bound-driven cull would skip the mesh.
  mesh.cullable = false;
  // Same reasoning for hit testing — never want a click to
  // resolve against the 3D mesh; the HUD overlay above us
  // handles all pointer events.
  mesh.eventMode = 'none';
  // 3D rendering requires a depth buffer; without it overlapping
  // triangles render in draw order and a wall behind the camera
  // can paint over a floor in front of it. Pixi's Mesh default
  // is depth-disabled (2D batched workload), so we flip it on
  // here. depthMask=true so opaque geometry writes to the depth
  // buffer; culling=false until we lock down sector winding
  // (some converted geometry may have inconsistent winding and
  // back-face culling would hide chunks of it).
  mesh.state.depthTest = true;
  mesh.state.depthMask = true;
  mesh.state.culling = false;

  // Tracks the set of building kinds with a live textured
  // shell. Updated each frame by `texturedBuildings.refreshTextures`;
  // when the set diverges from `lastTexturedBuildingKinds` we
  // rebuild the colored sector geometry skipping those kinds
  // so their fallback cube doesn't poke through the textured
  // shell's edges.
  let lastTexturedBuildingKinds = new Set<string>();

  function rebuildSectorGeometry(): void {
    if (!layout) return;
    const result = convertLayoutToSectorMap(layout, [...buildings.values()]);
    if (!result) return;
    const next = buildSectorGeometry(
      result.map,
      {
        floor: result.floorColor,
        ceiling: result.ceilingColor,
        wall: result.wallColor,
      },
      lastTexturedBuildingKinds,
    );
    // Swap the mesh's geometry. Pixi v8 lets us reassign .geometry
    // on a Mesh; the old Geometry's buffers need explicit destroy()
    // to release GPU memory otherwise scene changes leak.
    const old = mesh.geometry;
    mesh.geometry = next.geometry;
    try {
      old.destroy(true);
    } catch {
      /* best-effort */
    }
    geometry = next.geometry;
    // Textured surface overlays. Each builder returns null when
    // the SectorMap has no triangles for that surface (e.g.
    // surface scene has no walls). When null, hide the mesh;
    // the colored mesh covers everything regardless.
    swapTexturedMeshGeometry(
      texturedFloorMesh,
      buildTexturedFloorGeometry(result.map, layout?.terrain ?? null),
    );
    swapTexturedMeshGeometry(texturedCeilingMesh, buildTexturedCeilingGeometry(result.map));
    swapTexturedMeshGeometry(texturedWallMesh, buildTexturedWallGeometry(result.map));
    // Textured building cubes — per-kind batched. Ceiling
    // height matches the biome's wall height so cube tops align
    // with the room ceiling (the converter spawned cubes with
    // the same height earlier).
    const ceilingForBuildings =
      32 * biomeWallHeightTilesFor(layout?.biome ?? null);
    const tileSize = layout?.tileSize ?? 32;
    texturedBuildings.rebuild(
      [...buildings.values()],
      tileSize,
      ceilingForBuildings,
      layout?.terrain,
    );
    refreshStaticLights();
  }

  // Publish static lights. Two sources:
  //   1. Interactables — stairs_down / extract_pad get
  //      stock cool-blue / warm-green glows so portals read
  //      from across a room.
  //   2. Authored lights from the level editor — every
  //      `scene.map.lights` entry flows through to here when
  //      the layout carries an `authoredSectorMap`. Author
  //      sets colour / radius / intensity in the inspector;
  //      we just hand the values to the light manager.
  function refreshStaticLights(): void {
    if (!layout) {
      lights.clearStaticLights();
      return;
    }
    const next: StaticLight[] = [];
    const lightZ = 16;
    for (const it of layout.interactables) {
      if (it.kind === 'stairs_down') {
        next.push(stairsDownLightAt(it.id, it.x, it.y, lightZ));
      } else if (it.kind === 'extract_pad') {
        next.push(extractPadLightAt(it.id, it.x, it.y, lightZ));
      }
    }
    const authored = layout.authoredSectorMap?.lights;
    if (authored) {
      for (const a of authored) {
        next.push({
          id: a.id,
          x: a.x,
          y: a.y,
          z: a.z,
          radius: a.radius,
          r: ((a.colour >> 16) & 0xff) / 255,
          g: ((a.colour >> 8) & 0xff) / 255,
          b: (a.colour & 0xff) / 255,
          intensity: a.intensity,
        });
      }
    }
    if (next.length === 0) {
      lights.clearStaticLights();
      return;
    }
    lights.setStaticLights(next);
  }

  function swapTexturedMeshGeometry(
    m: Mesh<Geometry, import('pixi.js').Shader>,
    next: Geometry | null,
  ): void {
    const old = m.geometry;
    if (next) {
      m.geometry = next;
      // Visibility is gated by texture availability in tick();
      // here we just mark "has geometry to draw if a texture
      // shows up." A subsequent updateTexturedSectorBindings()
      // call flips visible=true.
    } else {
      // Textured-mesh placeholder needs aUV + aBrightness so
      // Pixi's VAO compatibility check doesn't trip when the
      // hidden mesh is bound during a frame's draw sweep.
      m.geometry = makeTexturedPlaceholderGeometry();
      m.visible = false;
    }
    try {
      old.destroy(true);
    } catch {
      /* best-effort */
    }
  }

  // Last-resolved texture per surface — used to detect when a
  // texture finishes loading so we know to flip the mesh on
  // (or off if the biome changes and the new biome's texture
  // hasn't loaded yet).
  function updateTexturedSectorBindings(): void {
    const biomeId = layout?.biome ?? 'default';
    const floorTex = lookupTexture('biome_floor', biomeId);
    const ceilingTex = lookupTexture('biome_ceiling', biomeId);
    const wallTex = lookupTexture('biome_wall', biomeId);
    const fallbackColors = biomeFallbackColors(biomeId);
    bindSurfaceTexture(
      texturedFloorMesh,
      floorTex,
      'biome_floor',
      biomeId,
      fallbackColors.floor,
    );
    bindSurfaceTexture(
      texturedCeilingMesh,
      ceilingTex,
      'biome_ceiling',
      biomeId,
      fallbackColors.ceiling,
    );
    bindSurfaceTexture(
      texturedWallMesh,
      wallTex,
      'biome_wall',
      biomeId,
      fallbackColors.wall,
    );
  }

  function bindSurfaceTexture(
    m: Mesh<Geometry, import('pixi.js').Shader>,
    tex: import('pixi.js').Texture | null,
    category: string,
    biomeId: string,
    fallbackColor: number,
  ): void {
    // Mesh.shader is typed as Shader | null because Pixi allows
    // creating a Mesh and assigning a shader later; ours is
    // always constructed with one, but TS doesn't know that.
    if (!m.shader) return;
    // When no biome texture is uploaded, bind a labeled fallback:
    // the colored-pass surface hue with "<category>: <biomeId>"
    // drawn on it, so a developer sees in-game which override is
    // missing. Keeps walls / floors / ceilings visible regardless
    // of asset state (critical for the editor's default biome).
    const source = tex
      ? tex.source
      : makeLabeledFallbackTexture(category, biomeId, fallbackColor).source;
    m.shader.resources.uTexture = source;
    m.visible = true;
  }
  // Convert the initial layout once the renderer is ready —
  // synchronous now since converter doesn't await anything.
  if (init.layout) {
    rebuildSectorGeometry();
  }

  // Desktop pointer-lock + mousemove. Click the canvas to lock;
  // movement deltas route through the same applyLookDelta the
  // mobile UI uses. Identical contract to v1 fps.ts so debugging
  // input parity is one-to-one.
  let pointerLocked = false;
  function onPointerLockChange(): void {
    pointerLocked =
      !!canvasEl && document.pointerLockElement === canvasEl;
  }
  function onMouseDown(e: MouseEvent): void {
    if (!pointerLocked) {
      // First click acquires pointer lock; mirrors v1's
      // click-to-engage convention so the player isn't surprised
      // by their mouse vanishing.
      canvasEl?.requestPointerLock?.();
      return;
    }
    if (e.button === 0) {
      mouseDown = true;
      // Build mode swallows the click — sendBuild instead of
      // fire. Debounced so a held click doesn't spam the server
      // (which silently drops invalid placements).
      if (buildMode !== null) {
        const now = performance.now();
        if (now - lastBuildSentAt > BUILD_DEBOUNCE_MS) {
          const target = computeBuildTarget();
          if (target && target.inRange) {
            init.sendBuild(buildMode, target.tileX, target.tileY);
            lastBuildSentAt = now;
          }
        }
      }
    }
  }
  function onMouseUp(e: MouseEvent): void {
    if (e.button === 0) mouseDown = false;
  }
  function onMouseMove(e: MouseEvent): void {
    if (!pointerLocked) return;
    camera.applyLookDelta(e.movementX, e.movementY);
  }
  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
  }
  function isFormFocus(): boolean {
    const ae = document.activeElement;
    return (
      ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement
    );
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (isFormFocus()) return;
    keys.add(e.code);
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (isFormFocus()) return;
    keys.delete(e.code);
  }
  function attachInputListeners(): void {
    if (!canvasEl) return;
    canvasEl.addEventListener('mousedown', onMouseDown);
    canvasEl.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('mouseup', onMouseUp);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }
  function detachInputListeners(): void {
    if (!canvasEl) return;
    canvasEl.removeEventListener('mousedown', onMouseDown);
    canvasEl.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  }

  const initPromise = app
    .init({
      background: 0x0a0a0c,
      antialias: false,
      resolution: 1,
      resizeTo: host,
    })
    .then(() => {
      if (destroyed) return;
      canvasEl = app.canvas;
      host.appendChild(canvasEl);
      canvasEl.style.cursor = 'crosshair';
      // Skybox at the very back. It paints first so 3D
      // geometry overdraws it; only the un-rendered void above
      // the horizon shows through.
      app.stage.addChild(skybox);
      app.stage.addChild(mesh);
      // Textured sector overlays sit between the colored sector
      // mesh and the entity sprites. Order is floor → ceiling →
      // wall so wall fragments win z-equal contests against
      // floor/ceiling on the room-corner triangles.
      app.stage.addChild(texturedFloorMesh);
      app.stage.addChild(texturedCeilingMesh);
      app.stage.addChild(texturedWallMesh);
      // Building cubes textured per-kind. Above the surface
      // layers so they paint over an underlying floor at the
      // cube's footprint.
      app.stage.addChild(texturedBuildings.container);
      app.stage.addChild(sprites.mesh);
      app.stage.addChild(texturedSprites.container);
      app.stage.addChild(mountSockets.mesh);
      app.stage.addChild(ghostCube.mesh);
      app.stage.addChild(damageOverlay);
      app.stage.addChild(crosshair);
      app.stage.addChild(viewModel);
      app.ticker.add(tick);
      attachInputListeners();
      ready = true;
    });

  // Track viewport size across frames; when it changes we
  // rebuild the view-model rect (the rect's coords depend on
  // canvas dimensions which can change on resize).
  let lastCanvasW = 0;
  let lastCanvasH = 0;
  function tick(): void {
    if (!ready || !canvasEl) return;
    tickInput();
    tickSelfSmoothing();
    revealAroundSelf();
    // Throttled fog persistence — only when exploration actually
    // uncovered new cells since the last write.
    if (fogDirty && performance.now() - lastFogSaveAt >= FOG_SAVE_INTERVAL_MS) {
      saveCurrentFog();
    }
    updateNearInteractable();
    updateNearWorkstations();
    if (canvasEl.width !== lastCanvasW || canvasEl.height !== lastCanvasH) {
      lastCanvasW = canvasEl.width;
      lastCanvasH = canvasEl.height;
      updateCrosshair();
    }
    // View-model needs a per-frame refresh — the animation
    // frame changes between ticks even when the weapon doesn't.
    updateViewModel();
    updateSkybox();
    updateDamageOverlay();
    camera.build(canvasEl.width, canvasEl.height);
    shaderHandle.uViewProj.set(camera.viewProj.m);
    shaderHandle.flush();
    // Mirror the matrix into the textured-sprite layer's
    // shared uniform group; endFrame() flushes it for all
    // batches in one go.
    texturedSprites.cameraMatrix.set(camera.viewProj.m);
    // Textured sector overlays share one uniform group across
    // floor/ceiling/wall — copy the same matrix in and flush
    // once.
    texturedSectorCameraUniforms.uViewProj.set(camera.viewProj.m);
    texturedSectorCameraUniforms.flush();
    // Same for building cubes — separate uniform group, so
    // need to sync it too.
    texturedBuildings.cameraMatrix.set(camera.viewProj.m);
    texturedBuildings.flushCamera();
    ghostCube.cameraMatrix.set(camera.viewProj.m);
    ghostCube.flushCamera();
    mountSockets.cameraMatrix.set(camera.viewProj.m);
    mountSockets.flushCamera();
    updateGhostCube();
    updateMountSockets();
    // Fog params: camera world position + biome-derived colour.
    // Single write reaches every shader via the shared
    // fogUniforms group. Fog colour is the biome's wall hue
    // dimmed — close enough to v1's perceived fog without
    // adding a dedicated palette field.
    syncFogUniforms();
    // Tick the dynamic-light pool: drop expired entries and
    // write the survivors into the shared uniform group. The
    // manager ranks by camera distance when more lights are
    // active than MAX_LIGHTS so close lights always win the
    // budget. Camera Z mirrors what syncFogUniforms uses.
    lights.tick(
      performance.now(),
      camera.selfX,
      camera.selfY,
      camera.feetZ + 16,
    );
    // Re-bind biome textures. lookupTexture is synchronous after
    // first call's async load resolves, so this re-poll picks up
    // textures the moment they land without an explicit
    // subscribe.
    updateTexturedSectorBindings();
    // Building texture resolution: animation frame (from the
    // buildings editor's authored animationId) first, static
    // `building/<kind>` texture second. v1 follows the same
    // priority chain (see fps.ts's wall-pass building texture
    // lookup) so a building authored for v1 looks identical
    // here. Animation key is kind-scoped (not per-instance) so
    // every instance of a kind animates in sync.
    const nowAnimMs = performance.now();
    // Labeled fallback for unauthored building kinds — drawn in
    // the biome wall hue the colored cube would have used, so the
    // cube reads the same but names the missing override.
    const buildingFallbackColor = biomeFallbackColors(
      layout?.biome ?? 'default',
    ).wall;
    const active = texturedBuildings.refreshTextures((kind) => {
      const animId = buildingVisualFor(kind).animationId;
      const animTex = animId
        ? getAnimationFrame(animId, `building::${kind}`, nowAnimMs, 'idle')
        : null;
      return (
        animTex ??
        lookupTexture('building', kind) ??
        makeLabeledFallbackTexture('building', kind, buildingFallbackColor)
      );
    });
    // When the live-textured kind set changes (a texture
    // finishes loading, a building of a new kind spawns, etc.),
    // rebuild the colored sector geometry so those kinds skip
    // their colored fallback. Cheap — set comparison + a
    // single rebuild on diff, not per-frame.
    if (!setEquals(active, lastTexturedBuildingKinds)) {
      lastTexturedBuildingKinds = active;
      rebuildSectorGeometry();
    }
    updateSprites();
  }

  function syncFogUniforms(): void {
    fog.uCameraPos[0] = camera.selfX;
    fog.uCameraPos[1] = camera.selfY;
    // Eye height — same as the camera matrix uses.
    fog.uCameraPos[2] = camera.feetZ + 16;
    // Tighter range inside dungeons (small enclosed corridors
    // benefit from atmospheric falloff; open surface should
    // see far). Detected by tileGrid presence — dungeons always
    // have one, surface never does.
    if (layout?.tileGrid) {
      fog.setRange(120, 420);
    } else {
      fog.setRange(300, 1500);
    }
    const palette = biomePaletteFor(layout?.biome ?? null);
    // Darkened wall colour as the fog tint. Skybox / floor would
    // also work; wall is the closest to "what's beyond this
    // wall" which is the fog's job.
    const rgb = parseFogColor(palette.wall);
    fog.uFogColor[0] = rgb[0];
    fog.uFogColor[1] = rgb[1];
    fog.uFogColor[2] = rgb[2];
    fog.flush();
  }

  function parseFogColor(hex: string | undefined): [number, number, number] {
    if (!hex) return [0.04, 0.05, 0.06];
    const clean = hex.startsWith('#') ? hex.slice(1) : hex;
    const n = parseInt(clean, 16);
    if (!Number.isFinite(n)) return [0.04, 0.05, 0.06];
    // Darken to ~35% so foggy mid-distance reads as ambient
    // gloom rather than the bright wall hue itself.
    const dim = 0.35;
    return [
      (((n >> 16) & 0xff) / 255) * dim,
      (((n >> 8) & 0xff) / 255) * dim,
      ((n & 0xff) / 255) * dim,
    ];
  }

  // Build the per-frame list of billboards. Visual constants
  // mirror v1's defaults so heights/colours feel consistent
  // until P3.2 ports the animation textures. Eye height is at
  // half a wall; projectiles centre at eye level (same trick v1
  // uses with floats=true).
  const PROJECTILE_SIZE = 8;
  const PROJECTILE_DEFAULT_COLOR = 0xfde047;
  const LOOT_SIZE = 14;
  const CORPSE_SIZE = 14;
  const CORPSE_COLOR = 0x52525b;
  const OTHER_PLAYER_COLOR = 0x60a5fa;
  const OTHER_PLAYER_HEIGHT = 22;

  const spriteScratch: SpriteRequest[] = [];
  function updateSprites(): void {
    // Matches converter.ts WALL_HEIGHT_WORLD = 32 (v1 parity).
    const ceilingZ = 32 * biomeWallHeightTilesFor(layout?.biome ?? null);
    const eyeZ = ceilingZ * 0.5;
    const nowAnim = performance.now();
    spriteScratch.length = 0;
    texturedSprites.beginFrame();
    for (const e of enemies.values()) {
      if (e.hp <= 0) continue;
      const v = enemyVisualFor(e.kind);
      // Resolve the live texture: animation frame first, static
      // `enemy/<kind>` texture override second, colored fallback
      // last. Mirrors v1's per-entity texture resolution order.
      const animTex = getAnimationFrame(
        v.animationId,
        `enemy::${e.id}`,
        nowAnim,
        'idle',
      );
      const staticTex = animTex ? null : lookupTexture('enemy', e.kind);
      // Labeled fallback when neither an animation frame nor a
      // static override exists — the old flat-color billboard in
      // the enemy's fallback hue, with "enemy: <kind>" drawn on
      // it so the missing override is identifiable in-game.
      const tex =
        animTex ??
        staticTex ??
        makeLabeledFallbackTexture('enemy', e.kind, v.color);
      const groundZ = entityFloorAt(e.x, e.y);
      // Hit flash: white tint for HIT_FLASH_MS after the server
      // reports an HP drop. setEnemyHp writes the timestamp.
      const flashAt = enemyHitFlashAt.get(e.id) ?? 0;
      const flashing = flashAt > 0 && nowAnim - flashAt < HIT_FLASH_MS;
      texturedSprites.push(
        {
          textureKey: tex.uid,
          texture: tex,
          x: e.x,
          y: e.y,
          anchorZ: groundZ,
          height: v.size,
          aspect: textureAspect(tex),
          tint: flashing ? 0xffd0d0 : 0xffffff,
        },
        camera,
      );
    }
    for (const p of props.values()) {
      // Container props render as cubes via the sector pass;
      // skip them here so they don't double-paint as
      // billboards inside their own cube.
      if (p.tileX !== undefined && p.tileY !== undefined) continue;
      const v = propVisualFor(p.kind);
      const tint = parseHexTint(v.tint) ?? 0x71717a;
      const heightFraction = v.spriteSize ?? 22 / 16;
      // Sprite size is authored as a fraction of room height
      // (matches v1's spriteSize semantics: 1.0 = one wall tall).
      const h = heightFraction * 32;
      // spriteGroundOffset is 0..1 of the room height (matches
      // v1). 0 = floor, 1 = ceiling. We translate to the
      // explicit anchorZ the sprite layer wants, then lift by
      // the terrain / platform floor at the prop's position so
      // it sits on the actual ground.
      const offsetFrac = v.spriteGroundOffset ?? 0;
      const anchorZ =
        entityFloorAt(p.x, p.y) + offsetFrac * Math.max(0, ceilingZ - h);
      // Animation frame first, static prop/<kind> texture
      // second, colored tint last. The static fallback is what
      // gives props authored before the animation system shipped
      // (or ones the author chose to leave un-animated) a real
      // sprite instead of a coloured rectangle.
      const animTex = getAnimationFrame(
        v.animationId,
        `prop::${p.id}`,
        nowAnim,
        'idle',
      );
      const staticTex = animTex ? null : lookupTexture('prop', p.kind);
      // Labeled fallback in the prop's authored tint when no
      // texture exists — names the missing `prop/<kind>` override.
      const tex =
        animTex ??
        staticTex ??
        makeLabeledFallbackTexture('prop', p.kind, tint);
      texturedSprites.push(
        {
          textureKey: tex.uid,
          texture: tex,
          x: p.x,
          y: p.y,
          anchorZ,
          height: h,
          aspect: textureAspect(tex),
          tint: 0xffffff,
        },
        camera,
      );
    }
    const nowMs = performance.now();
    const tg = layout?.tileGrid;
    const tiles = tg ? getLayoutTiles() : undefined;
    for (const pr of projectiles.values()) {
      // Extrapolate from the spawn snapshot. vx/vy are world
      // units per second. Server units match v1's; rolled
      // forward by the wall-clock delta keeps the visual in
      // step with the server's tick without per-frame net
      // updates.
      const spawnedAt = projectileSpawnedAt.get(pr.id) ?? nowMs;
      const dtSec = (nowMs - spawnedAt) / 1000;
      // Safety TTL: if the server's despawn for this projectile
      // gets dropped or is delayed past a sane window, hide
      // the visual rather than letting it drift forever. 2.5s
      // comfortably exceeds every authored projectile lifetime.
      if (dtSec > 2.5) continue;
      const x = pr.x + pr.vx * dtSec;
      const y = pr.y + pr.vy * dtSec;
      // Server-broadcast z + vz now describe the bullet's
      // vertical path. Fall back to camera eyeZ if the broadcast
      // is from a pre-Phase-7 server.
      const zBase = pr.z ?? eyeZ;
      const vzS = pr.vz ?? 0;
      const z = zBase + vzS * dtSec;
      // Wall clip: if the extrapolated position is inside a
      // non-walkable tile, the projectile has visually hit the
      // wall. Server emits the despawn but it may arrive a
      // frame or two later; suppress the visual now to avoid
      // the "stuck inside a wall" frame.
      if (tg && tiles && !isWalkableTileId(tileIdAt(tg, tiles, x, y))) {
        continue;
      }
      // Projectile centre at z — bottom = z - height/2 — so
      // pitch-aware aim renders correctly (high shots high, low
      // shots low) instead of always at the shooter's eye line.
      const h = PROJECTILE_SIZE;
      const animId = resolveProjectileAnimId(pr.weaponId);
      // Animation manifests are async — the first projectile of
      // a weaponId may render before its manifest is parsed, so
      // getAnimationFrame returns null on that first call and
      // returns the texture on subsequent calls. Without a
      // static fallback, the first shot is an untextured
      // billboard. Same lookup chain v1 uses:
      //   1. ('projectile', weaponId)         — per-weapon override
      //   2. ('projectile', WEAPON_FAMILY[id]) — family fallback
      const animTex = animId
        ? getAnimationFrame(animId, `projectile::${pr.id}`, nowAnim, 'idle')
        : null;
      let staticTex: import('pixi.js').Texture | null = null;
      if (!animTex && pr.weaponId) {
        staticTex = lookupTexture('projectile', pr.weaponId);
        if (!staticTex) {
          const family = WEAPON_FAMILY[pr.weaponId];
          if (family) staticTex = lookupTexture('projectile', family);
        }
      }
      // Labeled fallback in the projectile's wire color when no
      // animation or static override resolves — names the missing
      // `projectile/<weaponId>` override.
      const tex =
        animTex ??
        staticTex ??
        makeLabeledFallbackTexture(
          'projectile',
          pr.weaponId ?? 'unknown',
          pr.color ?? PROJECTILE_DEFAULT_COLOR,
        );
      texturedSprites.push(
        {
          textureKey: tex.uid,
          texture: tex,
          x,
          y,
          anchorZ: z - h * 0.5,
          height: h,
          aspect: textureAspect(tex),
          tint: 0xffffff,
        },
        camera,
      );
    }
    for (const l of loot.values()) {
      // Resolve a per-loot texture by content kind. Materials
      // have `material/<materialId>` overrides; parts and
      // attachment instances get labeled fallback billboards
      // (tier colour / amber — no texture category exists for
      // them); everything else uses a generic amber pouch.
      // Same priority chain v1 uses so authored textures port
      // cleanly.
      let staticTex: import('pixi.js').Texture | null = null;
      let color = PROJECTILE_DEFAULT_COLOR;
      if (l.content.kind === 'material') {
        color = materialTint(l.content.materialId);
        // Labeled fallback names the missing `material/<id>`
        // override.
        staticTex =
          lookupTexture('material', l.content.materialId) ??
          makeLabeledFallbackTexture(
            'material',
            l.content.materialId,
            color,
          );
      } else if (l.content.kind === 'part') {
        // No `part` texture category exists in the editor, so the
        // labeled fallback is the texture: tier color background,
        // slot (+ weapon class when class-locked) as the id.
        color = TIER_COLORS_NUM[l.content.part.tier] ?? PROJECTILE_DEFAULT_COLOR;
        const part = l.content.part;
        const partId = part.weaponClass
          ? `${part.slot} (${part.weaponClass})`
          : part.slot;
        staticTex = makeLabeledFallbackTexture('part', partId, color);
      } else if (
        l.content.kind === 'slot' &&
        l.content.slot.kind === 'attachment'
      ) {
        // Attachment-instance drops — same deal, no texture
        // category to upload against, so label the billboard with
        // the attachment defId in the existing amber.
        staticTex = makeLabeledFallbackTexture(
          'mod',
          l.content.slot.instance.defId,
          color,
        );
      }
      const groundZ = entityFloorAt(l.x, l.y);
      if (staticTex) {
        texturedSprites.push(
          {
            textureKey: staticTex.uid,
            texture: staticTex,
            x: l.x,
            y: l.y,
            anchorZ: groundZ,
            height: LOOT_SIZE,
            aspect: textureAspect(staticTex),
            tint: 0xffffff,
          },
          camera,
        );
      } else {
        spriteScratch.push({
          x: l.x,
          y: l.y,
          anchorZ: groundZ,
          height: LOOT_SIZE,
          color,
        });
      }
    }
    // Impact particles (blood / sparks). The system integrates
    // its own dt from `nowMs` and pushes one preallocated sprite
    // per live particle into the scratch list — same billboard
    // path as everything else, so they depth-test against walls.
    particles.update(nowMs, spriteScratch);
    // Corpse pouches — labeled billboard in the old solid grey.
    // No `corpse` texture category exists in the editor, so the
    // label is the texture rather than a missing-override hint.
    const corpseTex = makeLabeledFallbackTexture(
      'corpse',
      'pouch',
      CORPSE_COLOR,
    );
    for (const c of corpses.values()) {
      texturedSprites.push(
        {
          textureKey: corpseTex.uid,
          texture: corpseTex,
          x: c.x,
          y: c.y,
          anchorZ: entityFloorAt(c.x, c.y),
          height: CORPSE_SIZE,
          aspect: textureAspect(corpseTex),
          tint: 0xffffff,
        },
        camera,
      );
    }
    // Other players (multiplayer). Skip self — the camera is
    // already at our world position; rendering a sprite there
    // would just paint over the centre of our own screen.
    // Try the authored ('player', 'default') texture first; fall
    // back to a labeled billboard in the old solid blue naming
    // the missing `player/default` override.
    const playerTex =
      lookupTexture('player', 'default') ??
      makeLabeledFallbackTexture('player', 'default', OTHER_PLAYER_COLOR);
    for (const p of players.values()) {
      if (p.characterId === init.self.characterId) continue;
      // Broadcast absolute feet z anchors the billboard so a
      // jumping teammate visibly leaves the ground; fall back to
      // the local floor mirror when z hasn't arrived yet.
      const groundZ = p.z ?? entityFloorAt(p.x, p.y);
      texturedSprites.push(
        {
          textureKey: playerTex.uid,
          texture: playerTex,
          x: p.x,
          y: p.y,
          anchorZ: groundZ,
          height: OTHER_PLAYER_HEIGHT,
          aspect: textureAspect(playerTex),
          tint: 0xffffff,
        },
        camera,
      );
    }
    sprites.update(spriteScratch, camera);
    texturedSprites.endFrame();
  }

  // Position + colour the translucent ghost cube based on
  // current build mode + targeted tile. Green when within range,
  // red when outside (matches server's BUILD_RADIUS_TILES + suit
  // bonus). Hidden entirely when build mode is off or no surface
  // layout exists.
  function updateGhostCube(): void {
    if (buildMode === null || !layout) {
      ghostCube.setVisible(false);
      return;
    }
    const target = computeBuildTarget();
    if (!target) {
      ghostCube.setVisible(false);
      return;
    }
    const tileSize = layout.tileSize > 0 ? layout.tileSize : 32;
    const ox = target.tileX * tileSize;
    const oy = target.tileY * tileSize;
    // Cube sits on the floor at the target tile's centre. Use
    // floor at centre so a partially-on-terrain tile picks the
    // most representative height.
    const cx = ox + tileSize * 0.5;
    const cy = oy + tileSize * 0.5;
    const oz = entityFloorAt(cx, cy);
    ghostCube.setTransform(ox, oy, oz, tileSize, tileSize, tileSize);
    const color = target.inRange ? 0x55ff88 : 0xff5555;
    ghostCube.setColor(color, 0.32);
    ghostCube.setVisible(true);
  }

  // Turret mount sockets (base layouts P3). The set of occupied mount
  // indices is DERIVED from current buildings (turrets carrying a
  // mountIndex), mirroring the server. Free mounts render as flat
  // socket pads on the ground.
  function occupiedMountIndices(): Set<number> {
    const occ = new Set<number>();
    const mountCount = layout?.turretMounts?.length ?? 0;
    for (const b of buildings.values()) {
      // Guard the stored mountIndex against the live mount count —
      // a legacy/corrupt save could carry an out-of-range index that
      // would otherwise mark a non-existent mount occupied (and free
      // mounts would never render). Mirrors the server's range checks.
      if (
        b.mountIndex !== undefined &&
        b.mountIndex >= 0 &&
        b.mountIndex < mountCount &&
        isTurretKind(b.kind)
      ) {
        occ.add(b.mountIndex);
      }
    }
    return occ;
  }

  // The nearest FREE mount to a world point within `maxDist`, or null.
  // Mirrors the server's nearestFreeMount so the turret build ghost
  // snaps where the build will actually land.
  function nearestFreeMount(
    px: number,
    py: number,
    maxDist: number,
  ): { index: number; x: number; y: number } | null {
    const mounts = layout?.turretMounts;
    if (!mounts || mounts.length === 0) return null;
    const occ = occupiedMountIndices();
    let best: { index: number; x: number; y: number } | null = null;
    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < mounts.length; i++) {
      if (occ.has(i)) continue;
      const m = mounts[i];
      const dx = m.x - px;
      const dy = m.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = { index: i, x: m.x, y: m.y };
      }
    }
    return best;
  }

  // Rebuild the free-mount socket pads each frame from the layout's
  // mounts minus the occupied set. Surface only (mounts undefined
  // elsewhere ⇒ layer hidden).
  function updateMountSockets(): void {
    if (!layout) {
      mountSockets.setVisible(false);
      return;
    }
    const mounts = layout.turretMounts;
    if (!mounts || mounts.length === 0) {
      mountSockets.setVisible(false);
      return;
    }
    const occ = occupiedMountIndices();
    const free: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < mounts.length; i++) {
      if (occ.has(i)) continue;
      const m = mounts[i];
      free.push({ x: m.x, y: m.y, z: entityFloorAt(m.x, m.y) });
    }
    if (free.length === 0) {
      mountSockets.setVisible(false);
      return;
    }
    const tileSize = layout.tileSize > 0 ? layout.tileSize : 32;
    mountSockets.setMounts(free, tileSize * 0.5);
    mountSockets.setColor(0x55ddff, 0.28);
    mountSockets.setVisible(true);
  }

  // Project the camera's look direction onto the floor plane to
  // pick the target tile for build mode. If pitch is shallow
  // (looking near horizontal or up), fall back to a tile ~2 in
  // front of the player so the ghost still appears somewhere
  // sensible. inRange is the server-style radius check (3 base
  // tiles + suit bonus) measured in tiles from the player.
  function computeBuildTarget(): {
    tileX: number;
    tileY: number;
    inRange: boolean;
  } | null {
    if (!layout) return null;
    const tileSize = layout.tileSize > 0 ? layout.tileSize : 32;
    const eyeZ = camera.feetZ + camera.eyeHeightSmoothed;
    const groundZAtSelf = floorAt(selfX, selfY);
    const heightAboveFloor = eyeZ - groundZAtSelf;
    let tx: number;
    let ty: number;
    const fx = camera.fwdX;
    const fy = camera.fwdY;
    // Pitch <0 means looking down. Cast onto z = groundZAtSelf.
    if (camera.pitch < -0.05 && heightAboveFloor > 0) {
      const t = heightAboveFloor / Math.tan(-camera.pitch);
      const wx = selfX + fx * t;
      const wy = selfY + fy * t;
      tx = Math.floor(wx / tileSize);
      ty = Math.floor(wy / tileSize);
    } else {
      // Shallow / upward pitch — place 2 tiles ahead of the
      // player so the ghost still has a sensible default.
      const fallbackDist = tileSize * 2;
      tx = Math.floor((selfX + fx * fallbackDist) / tileSize);
      ty = Math.floor((selfY + fy * fallbackDist) / tileSize);
    }
    // Turret mounts (base layouts P3): turrets aren't free-placed —
    // the ghost snaps to the nearest FREE mount near the cursor tile
    // (server uses ~1.5 tiles of slack). No free mount near the
    // cursor ⇒ no valid target (ghost hidden). inRange additionally
    // requires the mount itself to sit within the player's build
    // radius, mirroring the server's range gate.
    if (buildMode !== null && isTurretKind(buildMode)) {
      const cursorCx = tx * tileSize + tileSize * 0.5;
      const cursorCy = ty * tileSize + tileSize * 0.5;
      const mount = nearestFreeMount(cursorCx, cursorCy, tileSize * 1.5);
      if (!mount) return null;
      const mtx = Math.floor(mount.x / tileSize);
      const mty = Math.floor(mount.y / tileSize);
      const mdx = mount.x - selfX;
      const mdy = mount.y - selfY;
      const reach = (3 + buildRadiusBonusTiles + 0.5) * tileSize;
      const inRange = mdx * mdx + mdy * mdy <= reach * reach;
      return { tileX: mtx, tileY: mty, inRange };
    }

    const selfTx = Math.floor(selfX / tileSize);
    const selfTy = Math.floor(selfY / tileSize);
    const dx = tx - selfTx;
    const dy = ty - selfTy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const withinRadius = dist <= 3 + buildRadiusBonusTiles;
    // Off-pad check: when the surface has a clearing, the target
    // tile centre must lie on the flat buildable pad. The server
    // rejects off-pad builds silently; this mirrors that so the
    // ghost reads red on the apron/hills. No clearing → no pad
    // constraint (behaves as before).
    let onPad = true;
    if (layout.terrain?.clearing) {
      const tileCenterX = tx * tileSize + tileSize * 0.5;
      const tileCenterY = ty * tileSize + tileSize * 0.5;
      onPad = insideClearingPad(layout.terrain, tileCenterX, tileCenterY);
    }
    const inRange = withinRadius && onPad;
    return { tileX: tx, tileY: ty, inRange };
  }

  // Texture aspect ratio (width / height). Pixi v8 Texture
  // exposes `width` and `height` as natural pixel dimensions.
  // Fallback to 1 (square) for safety against newly-loaded
  // textures whose dims haven't propagated yet.
  function textureAspect(tex: { width: number; height: number }): number {
    if (!tex.height || tex.height <= 0) return 1;
    return tex.width / tex.height;
  }

  // Projectile animation lookup with family fallback: a weapon
  // can author its own bullet sprite (per weaponId), but if
  // unauthored we fall through to the family-wide default. Same
  // priority chain v1 uses so authored weapons render
  // identically across renderers.
  function resolveProjectileAnimId(
    weaponId: string | undefined,
  ): string | undefined {
    if (!weaponId) return undefined;
    const direct = WEAPON_PROJECTILE_ANIM[weaponId];
    if (direct) return direct;
    const family = WEAPON_FAMILY[weaponId];
    if (family && WEAPON_PROJECTILE_ANIM[family]) {
      return WEAPON_PROJECTILE_ANIM[family];
    }
    return undefined;
  }

  function setEquals(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  function parseHexTint(s: string | undefined): number | null {
    if (!s) return null;
    const clean = s.startsWith('#') ? s.slice(1) : s;
    const n = parseInt(clean, 16);
    return Number.isFinite(n) ? n : null;
  }


  // Exponential lerp of the camera toward the server-reported
  // position. Smooths the ~20 Hz network ticks into a ~60 Hz
  // visual without sacrificing server authority. Mirrors v1.
  // Also smooths the camera's floor height so stepping onto /
  // off a platform reads as a quick rise / fall instead of a
  // snap.
  function tickSelfSmoothing(): void {
    const now = performance.now();
    const dt = lastSelfTickAt === 0 ? 16 : now - lastSelfTickAt;
    lastSelfTickAt = now;
    // 1. Predict: advance the local player from this frame's input
    // immediately, mirroring the server's movement math. This is what
    // makes input feel instant instead of waiting a round-trip. The
    // step is gated against the client's copy of the (carved) tile
    // grid so prediction can't walk THROUGH procgen walls — without
    // this you visibly push into walls until the server tugs you back.
    // Axis-slide mirrors the server's moveWithCollision fallback.
    const dts = dt / 1000;
    if (predMoveX !== 0 || predMoveY !== 0) {
      let speed = PRED_MOVE_SPEED;
      if (predSprint) speed *= PRED_SPRINT_MULT;
      if (predCrouch) speed *= PRED_CROUCH_MULT;
      const sx = predMoveX * speed * dts;
      const sy = predMoveY * speed * dts;
      if (predPassable(selfX + sx, selfY + sy)) {
        selfX += sx;
        selfY += sy;
      } else if (predPassable(selfX + sx, selfY)) {
        selfX += sx;
      } else if (predPassable(selfX, selfY + sy)) {
        selfY += sy;
      }
      // else fully blocked — hold position (server reconciles).
    }
    // 2. Reconcile toward the authoritative position. Error-scaled:
    // gentle when small (keep the prediction lead so motion stays
    // smooth and responsive), firm when large (pull back from a wall
    // the client predicted through — it doesn't run collision).
    const dx = targetSelfX - selfX;
    const dy = targetSelfY - selfY;
    const err = Math.hypot(dx, dy);
    if (err > 0) {
      const predicting = predMoveX !== 0 || predMoveY !== 0;
      let tau: number;
      if (!predicting) {
        // Stopped: converge fast so the prediction lead doesn't
        // glide to a halt (the "slide when I stop"). Once input
        // ends there's nothing to keep predicting, so snapping the
        // small residual in is correct and reads as a clean stop.
        tau = CORRECT_TAU_FAST_MS;
      } else {
        // Moving: gentle when the error is small (keep the lead so
        // input feels instant), firming as it grows (pull back from
        // a wall predicted through).
        const tFrac =
          err <= CORRECT_SOFT_PX
            ? 0
            : err >= CORRECT_HARD_PX
              ? 1
              : (err - CORRECT_SOFT_PX) / (CORRECT_HARD_PX - CORRECT_SOFT_PX);
        tau =
          CORRECT_TAU_SLOW_MS +
          (CORRECT_TAU_FAST_MS - CORRECT_TAU_SLOW_MS) * tFrac;
      }
      const k = Math.min(1, 1 - Math.exp(-dt / tau));
      selfX += dx * k;
      selfY += dy * k;
      if (Math.abs(targetSelfX - selfX) < 0.05) selfX = targetSelfX;
      if (Math.abs(targetSelfY - selfY) < 0.05) selfY = targetSelfY;
    }
    // Local floor mirror under the lerped XY — the grounded
    // camera target. The server broadcasts absolute z, so while
    // airborne no floor re-anchoring/compensation is needed:
    // cameraZ predicts the ballistic arc directly in absolute z
    // and corrects toward the broadcast value.
    const targetFloor = floorAt(selfX, selfY);
    // Airborne ⇔ the server says so, or a just-pressed local jump
    // is still ascending ahead of the server echo (predVZ > 0).
    // Grounded frames NEVER integrate gravity — predVZ is cleared
    // below — so camera height can't accumulate offset while
    // walking over uneven terrain.
    const airborne = selfAirborne || predVZ > 0;
    if (airborne) {
      // Ballistic jump prediction. Integrate the same gravity the
      // server uses so the arc is a smooth per-frame parabola
      // instead of 20 Hz steps, then softly correct toward the
      // latest server sample so authority always wins (head-bonk
      // caps, landings).
      const dts = dt / 1000;
      predVZ -= JUMP_GRAVITY * dts;
      // Terminal clamp: a real jump never exceeds ~|JUMP_VZ_INIT|
      // downward. If the local floor mirror ever disagrees with
      // the server (selfZ stuck above the mirrored floor), the
      // integration would otherwise run away and fight the
      // correction term with ever-growing velocity.
      if (predVZ < -3 * JUMP_VZ_INIT) predVZ = -3 * JUMP_VZ_INIT;
      cameraZ += predVZ * dts;
      const corr = Math.min(1, 1 - Math.exp(-dt / JUMP_CORRECT_TAU_MS));
      cameraZ += (selfZ - cameraZ) * corr;
      if (
        predVZ <= 0 &&
        cameraZ <= targetFloor &&
        selfZ <= targetFloor + 0.01
      ) {
        cameraZ = targetFloor;
        predVZ = 0;
      }
    } else {
      // Grounded per server authority: kill any leftover ballistic
      // velocity so the next frame can't re-enter the airborne
      // branch on stale prediction state.
      predVZ = 0;
      const dz = targetFloor - cameraZ;
      if (dz > 0) {
        // Step up — snap. Camera lerping behind the floor while the
        // player's XY is already on the upper tile puts the camera
        // below the destination floor's plane, which clips through
        // riser geometry from a downward-looking angle. Snap-up is
        // the v1 + standard-FPS feel for stair ascent and avoids
        // the clip entirely.
        cameraZ = targetFloor;
      } else if (dz < 0) {
        // Step / fall down — lerp. Snapping down would feel like a
        // teleport; the slight delay reads as gravity instead.
        const tz = Math.min(1, 1 - Math.exp(-dt / FLOOR_SMOOTH_TAU_MS));
        cameraZ += dz * tz;
        if (Math.abs(targetFloor - cameraZ) < 0.05) {
          cameraZ = targetFloor;
        }
      }
    }
    camera.setSelfPosition(selfX, selfY, cameraZ);
    camera.setCrouching(selfCrouching);
  }

  // Client-side mirror of the server's floor lookup. Terrain
  // is the baseline; tile-rect platforms + authored sectors
  // override when higher AND ≤ cap. The cap defaults to the
  // current camera feet z + STEP_UP_MAX so a brief slide past
  // an angled wall into an overhead's polygon doesn't snap the
  // camera up to the overhead's floor — same gating principle
  // as the server's stateful `conn.floorZ`. (While airborne the
  // feet z rises, which matches the server's cap = feet z.)
  function floorAt(x: number, y: number): number {
    return floorAtWithCap(x, y, cameraZ + STEP_UP_MAX_CLIENT);
  }

  // Uncapped floor resolution for anchoring OTHER entities
  // (props, enemies, loot, corpses, remote players without a
  // broadcast z). The player cap above is camera-relative — it
  // exists so the LOCAL camera doesn't snap onto an overhead
  // sector — but entity anchors must not depend on the local
  // player's height: a prop standing on a raised platform sits
  // at the platform top whether or not we've jumped. Procgen
  // never stacks walkable floors over pits/platforms today, so
  // the smallest-containing-sector / highest-platform rule
  // resolves the true standing floor from xy alone.
  function entityFloorAt(x: number, y: number): number {
    return floorAtWithCap(x, y, Infinity);
  }

  function floorAtWithCap(x: number, y: number, cap: number): number {
    let z = 0;
    const terrain = layout?.terrain;
    if (terrain) z = terrainHeightAt(terrain, x, y);
    const platforms = layout?.platforms;
    if (platforms && platforms.length > 0) {
      const tileSize = layout?.tileSize ?? 32;
      if (tileSize > 0) {
        for (const p of platforms) {
          const x0 = p.tileX * tileSize;
          const y0 = p.tileY * tileSize;
          const x1 = x0 + p.w * tileSize;
          const y1 = y0 + p.h * tileSize;
          if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
          if (p.floorZ > cap) continue;
          if (p.floorZ > z) z = p.floorZ;
        }
      }
    }
    // Authored sectors (editor playtest scenes). Pick the
    // SMALLEST containing sector by polygon area and use its
    // floor — same convention the server uses. This lets pits
    // (sub-sector with floorZ < parent) lower the camera and
    // platforms (sub-sector with floorZ > parent) raise it.
    // Cap-filtered so overheads (containing sub-sector whose
    // floor is unreachable above current+step-up) are ignored.
    const sectors = layout?.authoredSectorMap?.sectors;
    if (sectors) {
      let bestArea = Infinity;
      let bestZ: number | null = null;
      let bestSector: (typeof sectors)[number] | null = null;
      for (const s of sectors) {
        if (s.buildingKind !== undefined) continue;
        if (s.floorZ > cap) continue;
        if (!pointInPolygonClient(s.verts, x, y)) continue;
        let signed = 0;
        for (let i = 0; i < s.verts.length; i++) {
          const a = s.verts[i];
          const b = s.verts[(i + 1) % s.verts.length];
          signed += a.x * b.y - b.x * a.y;
        }
        const area = Math.abs(signed) * 0.5;
        if (area < bestArea) {
          bestArea = area;
          bestZ = s.floorZ;
          bestSector = s;
        }
      }
      if (bestZ !== null) {
        z = bestZ;
        // Per-sector noise displacement, mirroring the server's
        // floorAt. Without this the camera sits at the flat
        // baseline while the renderer draws hills under it —
        // the player visibly floats above (or sinks below) the
        // mesh by up to the noise amplitude.
        if (bestSector?.floorNoise) {
          z += sectorNoiseOffsetAt(
            bestSector.floorNoise,
            bestSector.verts,
            bestSector.holes,
            x,
            y,
          );
        }
      }
    }
    return z;
  }

  // Local ray-casting point-in-polygon. Same shape as the
  // shared helper; avoiding an import-loop into renderer code.
  function pointInPolygonClient(
    poly: ReadonlyArray<{ x: number; y: number }>,
    px: number,
    py: number,
  ): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
      const a = poly[i];
      const b = poly[j];
      const intersects =
        a.y > py !== b.y > py &&
        px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
      if (intersects) inside = !inside;
    }
    return inside;
  }
  // Camera-side step-up budget. Should track server's
  // COMBAT.STEP_UP_MAX (12 wu); duplicated here so the renderer
  // doesn't pull in the server combat constants.
  const STEP_UP_MAX_CLIENT = 12;

  // Mark every cell within FOG_REVEAL_RADIUS_TILES of the player
  // as seen. Circular footprint via dx²+dy² ≤ r² so corners of
  // a bounding square don't bleed into adjacent rooms. No LOS
  // check — Phase 4's lighting pass adds proper occlusion.
  function revealAroundSelf(): void {
    if (!seenTiles || !layout?.tileGrid) return;
    const tg = layout.tileGrid;
    const ts = tg.tileSize;
    const cx = Math.floor(selfX / ts) - tg.originTileX;
    const cy = Math.floor(selfY / ts) - tg.originTileY;
    const r = FOG_REVEAL_RADIUS_TILES;
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const lx = cx + dx;
        const ly = cy + dy;
        if (lx < 0 || ly < 0 || lx >= tg.width || ly >= tg.height) continue;
        const idx = ly * tg.width + lx;
        if (!seenTiles[idx]) {
          seenTiles[idx] = 1;
          fogDirty = true;
        }
      }
    }
  }

  // Yaw-relative movement input — keyboard WASD by default,
  // mobile joystick when active. Same world-space math as v1
  // (forward = (cos yaw, sin yaw), right = (-sin, cos)) so the
  // server's existing handler interprets the vector identically.
  function tickInput(): void {
    let fwd: number;
    let right: number;
    let sprint: boolean;
    if (mobileMoveActive) {
      fwd = mobileMoveForward;
      right = mobileMoveRight;
      sprint = mobileSprint;
    } else {
      fwd =
        (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      right =
        (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    }
    const cy = Math.cos(camera.yaw);
    const sy = Math.sin(camera.yaw);
    const mx = fwd * cy + right * -sy;
    const my = fwd * sy + right * cy;
    // Vertical inputs. Jump = Space, edge-triggered: we send
    // `jump=true` only on the frame the press is consumed, then
    // wait for the key to release before arming again. Crouch =
    // Ctrl, held.
    const spaceDown = keys.has('Space');
    const jumpEdge = spaceDown && !lastSpaceDown;
    lastSpaceDown = spaceDown;
    // Kick the local jump prediction on the press frame (grounded
    // only — the server ignores airborne jump presses). The server
    // echo confirms/corrects via the smoothing pass.
    if (jumpEdge && predVZ === 0 && !selfAirborne) {
      predVZ = JUMP_VZ_INIT;
    }
    const crouch =
      keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    init.sendInput(mx, my, sprint, jumpEdge, crouch);

    // Stash the normalized move vector for client-side prediction in
    // tickSelfSmoothing (server normalizes diagonals, so we do too).
    const mlen = Math.hypot(mx, my);
    predMoveX = mlen > 0 ? mx / mlen : 0;
    predMoveY = mlen > 0 ? my / mlen : 0;
    predSprint = sprint && mlen > 0;
    predCrouch = crouch;

    // Hold-to-fire while a weapon is equipped. Server gates by
    // per-weapon fire interval + mag + reload, so we can pulse
    // every frame; the noise gets dropped at the boundary.
    // Mobile fire bypasses the pointer-lock gate (no pointer
    // lock exists on touch).
    const fireHeld =
      (mouseDown && pointerLocked) || mobileFireHeld;
    if (fireHeld && equippedWeapon !== null) {
      // Pitch-aware aim: server reads (dirX, dirY) as horizontal,
      // dirZ as vertical, slope = dirZ / |XY|. Forward XY length
      // is 1 (cos(pitch) cancels because the server normalises
      // the XY vec independently), so tan(pitch) is the right
      // value for dirZ.
      init.sendFire(cy, sy, Math.tan(camera.pitch));
    }
  }

  // Find the nearest in-range interactable so the host's "Press
  // E to ..." prompt can render. Same INTERACTABLE_RADIUS the
  // server uses — drift here would mean the UI lies about
  // affordability. v1 ports this same check from scene.ts.
  let lastNearInteractableId: string | null = null;
  function updateNearInteractable(): void {
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
    let bestDsq = r2;
    for (const it of layout.interactables) {
      // dm_spawn is a respawn anchor for deathmatch — players don't
      // press E to use it, so it must not surface as a prompt.
      if (it.kind === 'dm_spawn') continue;
      const dx = it.x - selfX;
      const dy = it.y - selfY;
      const dsq = dx * dx + dy * dy;
      if (dsq > r2) continue;
      if (dsq < bestDsq) {
        bestId = it.id;
        bestLabel = it.label;
        bestDsq = dsq;
      }
    }
    if (bestId !== lastNearInteractableId) {
      lastNearInteractableId = bestId;
      init.onNearInteractableChanged(
        bestId && bestLabel ? { id: bestId, label: bestLabel } : null,
      );
    }
  }

  // Workstation / chest / container / door proximity. Mirrors the
  // same interaction radius the server uses for craft + open, so
  // the prompt only shows when the action is actually available.
  // v1 ran this same query off pixi.ts; v2 inherited the
  // `onNearWorkstationsChanged` callback in the GameInit contract
  // but never wired the per-frame side. Without it, walking up to
  // a built workbench / chest never surfaces a "Press E" prompt.
  let lastWorkstationKey: string = '';
  function updateNearWorkstations(): void {
    const callback = init.onNearWorkstationsChanged;
    if (!callback || !layout) return;
    const r2 = INTERACTABLE_RADIUS * INTERACTABLE_RADIUS;
    const tileSize = layout.tileSize > 0 ? layout.tileSize : 32;
    const allKinds = new Set<import('@dumrunner/shared').BuildingKind>();
    let nearest: import('@dumrunner/shared').BuildingKind | null = null;
    let nearestDsq = r2;
    let nearestDoorId: string | null = null;
    let nearestDoorKind: 'door' | 'wall_door' | null = null;
    let nearestDoorOpen = false;
    let nearestDoorDsq = r2;
    let nearestChestId: string | null = null;
    let nearestChestDsq = r2;
    const nearestContainerId: string | null = null;
    let weaponBenchTier = 0;
    const weaponBenches: { id: string; tier: number }[] = [];
    for (const b of buildings.values()) {
      // Building centre in world coords (tile-aligned, w×h tiles).
      const cx = (b.tileX + b.width / 2) * tileSize;
      const cy = (b.tileY + b.height / 2) * tileSize;
      const dx = cx - selfX;
      const dy = cy - selfY;
      const dsq = dx * dx + dy * dy;
      if (dsq > r2) continue;
      allKinds.add(b.kind);
      const def = BUILDING_REGISTRY[b.kind];
      if (def?.isStation && dsq < nearestDsq) {
        nearest = b.kind;
        nearestDsq = dsq;
      }
      if (b.kind === 'door' || b.kind === 'wall_door') {
        if (dsq < nearestDoorDsq) {
          nearestDoorDsq = dsq;
          nearestDoorId = b.id;
          nearestDoorKind = b.kind;
          nearestDoorOpen = b.open === true;
        }
      }
      if (b.kind === 'storage_chest' && dsq < nearestChestDsq) {
        nearestChestDsq = dsq;
        nearestChestId = b.id;
      }
      // There's no `magnetic_container` BuildingKind today —
      // keep the field on the callback (Game.tsx reads it) but
      // leave it null until a container kind ships.
      if (b.kind === 'weapon_bench') {
        const tier = b.benchTier ?? 0;
        weaponBenches.push({ id: b.id, tier });
        if (tier > weaponBenchTier) weaponBenchTier = tier;
      }
    }
    const all = [...allKinds];
    // Dedup change detection. Stringify the relevant state so we
    // only emit when something the consumer cares about flipped.
    const key = [
      all.join(','),
      nearest ?? '',
      nearestDoorId ?? '',
      nearestDoorKind ?? '',
      String(nearestDoorOpen),
      nearestChestId ?? '',
      nearestContainerId ?? '',
      String(weaponBenchTier),
      weaponBenches.map((b) => `${b.id}:${b.tier}`).join('|'),
    ].join('#');
    if (key === lastWorkstationKey) return;
    lastWorkstationKey = key;
    callback({
      all,
      nearest,
      nearestDoorId,
      nearestDoorKind,
      nearestDoorOpen,
      nearestChestId,
      nearestContainerId,
      weaponBenchTier,
      weaponBenches,
    });
  }

  // ---------- GameHandle implementation (mostly stubs in P1) ----------

  // Decoded tile grid is cached so the minimap snapshot doesn't
  // re-base64-decode on every read. Refreshed whenever the
  // layout changes (rebuildSectorGeometry triggers a refresh
  // because layout is reassigned there from swapScene).
  let cachedLayoutTiles: Uint8Array | null = null;
  let cachedLayoutTilesForGrid: SceneLayout['tileGrid'] | undefined;
  function getLayoutTiles(): Uint8Array | undefined {
    const tg = layout?.tileGrid;
    if (!tg) {
      cachedLayoutTilesForGrid = undefined;
      cachedLayoutTiles = null;
      return undefined;
    }
    if (cachedLayoutTilesForGrid !== tg) {
      cachedLayoutTilesForGrid = tg;
      cachedLayoutTiles = decodeTileGrid(tg);
    }
    return cachedLayoutTiles ?? undefined;
  }

  // Client passability for movement prediction. Tests the player
  // circle (centre + 4 cardinal edge points at radius) against the
  // carved tile grid. Returns true (passable) when there's no tile
  // grid — the open surface has no procgen walls, only buildings,
  // which the server reconciliation handles. Approximate vs the
  // server's swept-circle test, but enough to stop prediction from
  // walking through walls.
  function predPassable(x: number, y: number): boolean {
    const tg = layout?.tileGrid;
    const tiles = getLayoutTiles();
    if (!tg || !tiles) return true;
    if (!isWalkableTileId(tileIdAt(tg, tiles, x, y))) return false;
    const r = PRED_PLAYER_RADIUS;
    return (
      isWalkableTileId(tileIdAt(tg, tiles, x + r, y)) &&
      isWalkableTileId(tileIdAt(tg, tiles, x - r, y)) &&
      isWalkableTileId(tileIdAt(tg, tiles, x, y + r)) &&
      isWalkableTileId(tileIdAt(tg, tiles, x, y - r))
    );
  }

  function selfState(): Player {
    return players.get(init.self.characterId) ?? init.self;
  }

  return {
    upsertPlayer: (p: Player) => {
      players.set(p.characterId, p);
      if (p.characterId === init.self.characterId) {
        selfX = p.x;
        selfY = p.y;
        cameraZ = p.z ?? floorAt(p.x, p.y);
        selfZ = cameraZ;
        predVZ = 0;
        camera.setSelfPosition(p.x, p.y, cameraZ);
      }
    },
    removePlayer: (id: string) => {
      players.delete(id);
    },
    movePlayer: (
      id: string,
      x: number,
      y: number,
      z?: number,
      crouching?: boolean,
      airborne?: boolean,
    ) => {
      const p = players.get(id);
      if (p) {
        p.x = x;
        p.y = y;
        p.z = z;
        p.crouching = crouching;
      }
      if (id === init.self.characterId) {
        // Lerp toward the new server position via the smoothing
        // pass. Big jumps (scene transition, teleport, respawn)
        // snap immediately so the camera doesn't sweep across
        // the map.
        const dx = x - selfX;
        const dy = y - selfY;
        if (dx * dx + dy * dy > SELF_SNAP_PX * SELF_SNAP_PX) {
          selfX = x;
          selfY = y;
          cameraZ = z ?? floorAt(x, y);
          predVZ = 0;
          camera.setSelfPosition(x, y, cameraZ);
        }
        targetSelfX = x;
        targetSelfY = y;
        // selfZ / selfAirborne / selfCrouching are the smoothing
        // pass's targets — the actual camera value lerps toward
        // them each frame inside tickSelfSmoothing.
        selfZ = z ?? floorAt(x, y);
        selfAirborne = airborne ?? false;
        selfCrouching = crouching ?? false;
      }
    },
    isSelfAirborne: () => selfAirborne || predVZ > 0,
    setPlayerHp: (
      characterId: string,
      hp: number,
      maxHp: number,
      shield?: number,
    ) => {
      if (characterId !== init.self.characterId) return;
      const now = performance.now();
      const prev = lastSelfHp;
      if (hp < prev) {
        lastHpDropAt = now;
        const drop = prev - hp;
        // "Big" hit = more than 15% of max HP in one shot.
        if (maxHp > 0 && drop / maxHp > 0.15) {
          lastBigHpDropAt = now;
        }
      }
      // Shield drop → cyan flash (only when HP itself didn't also
      // drop this tick; an overflow hit that chews shield AND hp
      // reads as the red HP flash, the more urgent signal).
      if (shield !== undefined) {
        if (shield < lastSelfShield && hp >= prev) {
          lastShieldDropAt = now;
        }
        lastSelfShield = shield;
      }
      lastSelfHp = hp;
      lastSelfMaxHp = maxHp;
      if (hp > 0) selfDead = false;
    },
    setPlayerDead: (characterId: string) => {
      if (characterId === init.self.characterId) {
        selfDead = true;
        lastSelfHp = 0;
      }
    },
    respawnPlayer: (
      id: string,
      x: number,
      y: number,
    ) => {
      const p = players.get(id);
      if (p) {
        p.x = x;
        p.y = y;
      }
      if (id === init.self.characterId) {
        // Respawn is a teleport — snap, don't lerp, and clear
        // any in-flight vertical prediction.
        selfX = x;
        selfY = y;
        targetSelfX = x;
        targetSelfY = y;
        cameraZ = floorAt(x, y);
        selfZ = cameraZ;
        predVZ = 0;
        camera.setSelfPosition(x, y, cameraZ);
        selfDead = false;
        lastHpDropAt = 0;
        lastBigHpDropAt = 0;
      }
    },
    showWeaponSwung: (
      characterId: string,
      weaponId: string,
    ) => {
      // Only kick the local view-model — other-player swings
      // don't have a viewmodel to drive. Reuse the 'fire' state
      // since melee weapons author their swing as the same key.
      if (characterId !== init.self.characterId) return;
      if (!equippedWeapon) return;
      playEntityState(
        WEAPON_VIEW_ANIM[equippedWeapon] ??
          WEAPON_VIEW_ANIM[weaponId as import('@dumrunner/shared').WeaponKind],
        viewModelKey(equippedWeapon),
        'fire',
        { interrupt: true },
      );
    },
    upsertEnemy: (e: EnemyState) => {
      enemies.set(e.id, e);
      if (!enemyPrevHp.has(e.id)) enemyPrevHp.set(e.id, e.hp);
    },
    removeEnemy: (id: string) => {
      enemies.delete(id);
      enemyPrevHp.delete(id);
      enemyHitFlashAt.delete(id);
    },
    setEnemyPosition: (id: string, x: number, y: number) => {
      const e = enemies.get(id);
      if (e) {
        e.x = x;
        e.y = y;
      }
    },
    setEnemyHp: (id: string, hp: number) => {
      const prev = enemyPrevHp.get(id);
      const e = enemies.get(id);
      if (prev !== undefined && hp < prev) {
        const now = performance.now();
        enemyHitFlashAt.set(id, now);
        // Small blood tick at the enemy's body on ANY damage —
        // covers melee swings, which never spawn a projectile so
        // the despawnProjectile burst can't fire. Projectile hits
        // also pass here, stacking a little extra on top of the
        // contact-point burst, which reads fine. Half intensity
        // keeps it a tick, not a full splatter.
        if (e) {
          const groundZ = entityFloorAt(e.x, e.y);
          const v = enemyVisualFor(e.kind);
          particles.spawnImpact(
            'flesh',
            e.x,
            e.y,
            groundZ + v.size * 0.55,
            now,
            groundZ,
            undefined,
            undefined,
            undefined,
            0.5,
          );
        }
      }
      enemyPrevHp.set(id, hp);
      if (e) e.hp = hp;
    },
    spawnProjectile: (p: ProjectileState) => {
      const nowMs = performance.now();
      projectiles.set(p.id, p);
      projectileSpawnedAt.set(p.id, nowMs);
      // Muzzle flash light at the projectile spawn point —
      // server-confirmed real shot. Visible to everyone via the
      // shared lighting model (a teammate's fire briefly lights
      // up walls around them). 60ms TTL keeps it punchy.
      lights.add(muzzleFlashAt(p.x, p.y, camera.feetZ + 16, nowMs));
      // If this projectile is ours, kick the view-model into
      // its fire state. `interrupt: true` so a chain of shots
      // restarts the fire animation per shot rather than
      // letting the first one block until completion.
      if (
        p.ownerKind === 'player' &&
        p.ownerCharacterId === init.self.characterId &&
        equippedWeapon
      ) {
        playEntityState(
          WEAPON_VIEW_ANIM[equippedWeapon],
          viewModelKey(equippedWeapon),
          'fire',
          { interrupt: true },
        );
      }
    },
    despawnProjectile: (
      id: string,
      reason?: 'hit' | 'expired',
      x?: number,
      y?: number,
      z?: number,
      hitKind?: 'flesh' | 'surface',
    ) => {
      // Grab the velocity before deletion — it biases the
      // particle spray back toward the shooter so blood/sparks
      // read as splashing OFF the hit surface.
      const proj = projectiles.get(id);
      projectiles.delete(id);
      projectileSpawnedAt.delete(id);
      if (
        reason === 'hit' &&
        x !== undefined &&
        y !== undefined &&
        z !== undefined
      ) {
        // Burst at the contact point: blood for flesh hits,
        // sparks for walls / terrain / buildings / props. Old
        // servers don't send hitKind — default to sparks.
        particles.spawnImpact(
          hitKind ?? 'surface',
          x,
          y,
          z,
          performance.now(),
          entityFloorAt(x, y),
          proj?.vx,
          proj?.vy,
          proj ? (proj.vz ?? 0) : undefined,
        );
      }
    },
    spawnLoot: (l: LootState) => loot.set(l.id, l),
    despawnLoot: (id: string) => loot.delete(id),
    spawnCorpse: (c: CorpseState) => corpses.set(c.id, c),
    removeCorpse: (id: string) => corpses.delete(id),
    spawnBuilding: (b: BuildingState) => {
      buildings.set(b.id, b);
      buildingPrevHp.set(b.id, b.hp);
      rebuildSectorGeometry();
    },
    removeBuilding: (id: string) => {
      buildings.delete(id);
      buildingPrevHp.delete(id);
      buildingHitFlashAt.delete(id);
      rebuildSectorGeometry();
    },
    setBuildingHp: (id: string, hp: number) => {
      const prev = buildingPrevHp.get(id);
      if (prev !== undefined && hp < prev) {
        buildingHitFlashAt.set(id, performance.now());
      }
      buildingPrevHp.set(id, hp);
      const b = buildings.get(id);
      if (b) b.hp = hp;
    },
    spawnProp: (p: PropState) => {
      props.set(p.id, p);
      propPrevHp.set(p.id, p.hp);
    },
    removeProp: (id: string) => {
      props.delete(id);
      propPrevHp.delete(id);
      propHitFlashAt.delete(id);
    },
    setPropHp: (id: string, hp: number) => {
      const prev = propPrevHp.get(id);
      if (prev !== undefined && hp < prev) {
        propHitFlashAt.set(id, performance.now());
      }
      propPrevHp.set(id, hp);
      const p = props.get(id);
      if (p) p.hp = hp;
    },
    changeProp: (p: PropState) => props.set(p.id, p),
    setBuildMode: (kind: PlaceableBuildingKind | null) => {
      buildMode = kind;
    },
    setBuildRadiusBonus: (tiles: number) => {
      buildRadiusBonusTiles = Math.max(0, Math.floor(tiles));
    },
    setEquippedWeapon: (weaponId) => {
      equippedWeapon = weaponId;
      if (weaponId === null) mouseDown = false;
      updateViewModel();
    },
    notifyReloadStarted: () => {
      // Drive the view-model's reload anim. Server already gates
      // reload validity (we wouldn't get reload_started without
      // a real reload happening), so no client-side check here.
      if (!equippedWeapon) return;
      playEntityState(
        WEAPON_VIEW_ANIM[equippedWeapon],
        viewModelKey(equippedWeapon),
        'reload',
        { interrupt: true },
      );
    },
    setHordeActive: (active: boolean) => {
      hordeActive = active;
    },
    setWorldCycle: (cycle: number) => {
      if (worldCycle === cycle) return;
      worldCycle = cycle;
      // Invalidate in-memory fog explored in a previous cycle —
      // dungeon floors regenerate on the cycle bump, so old
      // exploration is meaningless. Bitmaps tagged null were
      // explored (or restored) this session before the first
      // world_clock landed; they belong to the live cycle, so
      // adopt them.
      for (const [sceneId, taggedCycle] of fogCycleBySceneId) {
        if (taggedCycle === null) {
          fogCycleBySceneId.set(sceneId, cycle);
          continue;
        }
        if (taggedCycle === cycle) continue;
        if (sceneId === currentSceneId && seenTiles) {
          // Keep the live array (the painter holds no reference,
          // but swapScene's cache does) — just re-black it.
          seenTiles.fill(0);
          fogCycleBySceneId.set(sceneId, cycle);
          fogDirty = true;
        } else {
          fogBySceneId.delete(sceneId);
          fogCycleBySceneId.delete(sceneId);
        }
      }
      // Drop persisted saves from other cycles so stale keys
      // don't accumulate in localStorage.
      if (fogStoreId) pruneFogStateForCycle(fogStoreId, cycle);
    },
    swapScene: (state: SceneState) => {
      // Flush the outgoing scene's fog before the layout pointer
      // moves — a refresh right after a stairs transition should
      // still remember the floor we just left.
      saveCurrentFog(true);
      layout = state.layout;
      currentSceneId = state.sceneId;
      // Restore (or freshly allocate) the fog bitmap for this
      // scene: in-memory cache first, then the localStorage save,
      // then a fresh zeroed array. Dimensions are tied to the
      // tileGrid; a cached entry whose dimensions no longer match
      // (cycle regen) is dropped and rebuilt.
      seenTiles = fogForScene(currentSceneId, layout);
      players.clear();
      enemies.clear();
      loot.clear();
      corpses.clear();
      buildings.clear();
      props.clear();
      for (const p of [state.self, ...state.players]) {
        players.set(p.characterId, p);
      }
      for (const e of state.enemies) enemies.set(e.id, e);
      projectiles.clear();
      projectileSpawnedAt.clear();
      const now = performance.now();
      for (const pr of state.projectiles) {
        projectiles.set(pr.id, pr);
        projectileSpawnedAt.set(pr.id, now);
      }
      for (const l of state.loot) loot.set(l.id, l);
      for (const c of state.corpses) corpses.set(c.id, c);
      for (const b of state.buildings) buildings.set(b.id, b);
      for (const p of state.props) props.set(p.id, p);
      // Reseed prev-HP maps + clear hit-flash timers so a flash
      // started in the prior scene doesn't bleed into the new one.
      enemyPrevHp.clear();
      enemyHitFlashAt.clear();
      buildingPrevHp.clear();
      buildingHitFlashAt.clear();
      propPrevHp.clear();
      propHitFlashAt.clear();
      for (const e of state.enemies) enemyPrevHp.set(e.id, e.hp);
      for (const b of state.buildings) buildingPrevHp.set(b.id, b.hp);
      for (const p of state.props) propPrevHp.set(p.id, p.hp);
      lastSelfHp = state.self.hp;
      lastSelfMaxHp = state.self.maxHp;
      lastHpDropAt = 0;
      lastBigHpDropAt = 0;
      selfDead = false;
      selfX = state.self.x;
      selfY = state.self.y;
      // Scene swap is a teleport — snap target to match so the
      // smoothing lerp doesn't drag from the prior scene's pos.
      targetSelfX = selfX;
      targetSelfY = selfY;
      lastSelfTickAt = 0;
      // Scene swap resets the vertical state too — a swap taken
      // mid-jump must not carry a stale ballistic prediction (or
      // a stale floor/z) into the new scene.
      cameraZ = state.self.z ?? floorAt(selfX, selfY);
      selfZ = cameraZ;
      predVZ = 0;
      selfCrouching = state.self.crouching ?? false;
      camera.setSelfPosition(selfX, selfY, cameraZ);
      // Rebuild sector geometry against the new layout +
      // buildings. Surface layout with no tileGrid converts to
      // an open-air sector + cubes per building.
      rebuildSectorGeometry();
    },
    currentSceneState: (): SceneState => {
      const self = players.get(init.self.characterId);
      const others: Player[] = [];
      for (const p of players.values()) {
        if (p.characterId === init.self.characterId) continue;
        others.push({ ...p });
      }
      return {
        sceneId: currentSceneId,
        self: self ? { ...self } : { ...selfState(), x: selfX, y: selfY },
        players: others,
        enemies: [...enemies.values()].map((e) => ({ ...e })),
        projectiles: [...projectiles.values()].map((p) => ({ ...p })),
        loot: [...loot.values()].map((l) => ({ ...l })),
        corpses: [...corpses.values()].map((c) => ({ ...c })),
        buildings: [...buildings.values()].map((b) => ({ ...b })),
        props: [...props.values()].map((p) => ({ ...p })),
        layout,
      };
    },
    nearbyPlayers: (radiusPx: number) => {
      const r2 = radiusPx * radiusPx;
      const out: { characterId: string; displayName: string }[] = [];
      for (const p of players.values()) {
        if (p.characterId === init.self.characterId) continue;
        const dx = p.x - selfX;
        const dy = p.y - selfY;
        if (dx * dx + dy * dy > r2) continue;
        out.push({
          characterId: p.characterId,
          displayName: p.displayName ?? p.characterId,
        });
      }
      return out;
    },
    getMinimapSnapshot: (): MinimapSnapshot => ({
      selfX,
      selfY,
      selfYaw: camera.yaw,
      selfId: init.self.characterId,
      tileSize: layout?.tileSize ?? 32,
      walkables: layout?.walkables ?? [],
      tileGrid: layout?.tileGrid,
      tiles: getLayoutTiles(),
      seen: seenTiles ?? undefined,
      rooms: layout?.rooms,
      roomCategories: layout?.roomCategories,
      buildings: buildingsToMinimapList([...buildings.values()]),
      players: [...players.values()].map((p) => ({
        characterId: p.characterId,
        x: p.x,
        y: p.y,
        // No LOS gating yet — show every player on the minimap.
        visible: true,
      })),
      enemies: [...enemies.values()].map((e) => ({
        x: e.x,
        y: e.y,
        hp: e.hp,
        visible: true,
      })),
    }),
    getSelfPosition: () => ({ x: selfX, y: selfY }),

    // Mobile input methods — wire the camera through; everything
    // else stays a no-op until later phases need it.
    applyLookDelta(dxPx, dyPx) {
      camera.applyLookDelta(dxPx, dyPx);
    },
    setMobileMove(forward, right, sprint) {
      mobileMoveForward = Math.max(-1, Math.min(1, forward));
      mobileMoveRight = Math.max(-1, Math.min(1, right));
      mobileSprint = sprint;
      mobileMoveActive =
        Math.abs(mobileMoveForward) > 0.001 ||
        Math.abs(mobileMoveRight) > 0.001;
    },
    setFireHeld(held) {
      mobileFireHeld = held;
    },
    requestFire() {
      // Single-shot fire (mobile tap-fire button). Per-weapon
      // cooldown server-side dedupes redundant taps. We send
      // immediately regardless of pointer lock — touch UI is
      // the engagement signal.
      if (equippedWeapon === null) return;
      const cy = Math.cos(camera.yaw);
      const sy = Math.sin(camera.yaw);
      // Pitch-aware aim: server reads (dirX, dirY) as horizontal,
      // dirZ as vertical, slope = dirZ / |XY|. Forward XY length
      // is 1 (cos(pitch) cancels because the server normalises
      // the XY vec independently), so tan(pitch) is the right
      // value for dirZ.
      init.sendFire(cy, sy, Math.tan(camera.pitch));
    },
    destroy() {
      destroyed = true;
      // Flush fog before teardown — covers SPA navigation away
      // from the play page (beforeunload only fires on real
      // unloads).
      saveCurrentFog();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', onBeforeUnload);
      }
      sprites.destroy();
      texturedSprites.destroy();
      texturedBuildings.destroy();
      ghostCube.destroy();
      mountSockets.destroy();
      detachInputListeners();
      if (canvasEl && document.pointerLockElement === canvasEl) {
        document.exitPointerLock?.();
      }
      if (canvasEl) app.ticker.remove(tick);
      void initPromise.then(() => {
        if (canvasEl && canvasEl.parentElement === host) {
          host.removeChild(canvasEl);
        }
        try {
          app.destroy(true, { children: true, texture: false });
        } catch {
          /* best-effort */
        }
      });
    },
  };
}

// Suppress unused-import warnings for types we only mention in
// the file to anchor the GameHandle stubs. Removing these would
// require widening the parameter types, which the GameHandle
// interface already does for us.
export type { Texture, Interactable };
