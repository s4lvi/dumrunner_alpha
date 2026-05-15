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
import { convertLayoutToSectorMap } from './converter';
import {
  buildSectorGeometry,
  buildTexturedCeilingGeometry,
  buildTexturedFloorGeometry,
  buildTexturedWallGeometry,
} from './sectorGeometry';
import { createSpriteLayer, type SpriteRequest } from './spriteLayer';
import { lookupTexture } from './textureCache';
import {
  createTexturedSectorCameraUniforms,
  createTexturedSectorShader,
} from './texturedSectorShader';
import { createTexturedBuildingLayer } from './texturedBuildingLayer';
import { createFogUniforms } from './fogUniforms';
import { createLightingUniforms } from './lightingUniforms';
import {
  createLightManager,
  extractPadLightAt,
  muzzleFlashAt,
  stairsDownLightAt,
  type StaticLight,
} from './lights';
import { biomePaletteFor } from '@dumrunner/shared';
import { createTexturedSpriteLayer } from './texturedSpriteLayer';
import { getAnimationFrame, playEntityState } from '../../entityAnimations';

import type {
  GameHandle,
  GameInit,
  SceneState,
} from '../pixi';
import {
  INTERACTABLE_RADIUS,
  WEAPON_PROJECTILE_ANIM,
  WEAPON_VIEW_ANIM,
  WEAPON_FAMILY,
  biomeWallHeightTilesFor,
  buildingVisualFor,
  decodeTileGrid,
  enemyVisualFor,
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
  type Player,
  type ProjectileState,
  type PropState,
  type SceneLayout,
} from '@dumrunner/shared';
import { buildingsToMinimapList, type MinimapSnapshot } from '../minimap';

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
  // Exponential decay time constant. tau=50ms catches ~28% of
  // the remaining delta in one 16ms frame; ~3 frames to fully
  // converge without overshoot.
  const SELF_SMOOTH_TAU_MS = 50;
  let lastSelfTickAt = 0;

  // Minimap fog. seenTiles is a per-cell bitmap (1 byte/cell)
  // that the minimap painter reads to dim unexplored tiles.
  // Cached by sceneId so re-entering a scene (surface → dungeon
  // floor 2 → surface) restores prior exploration instead of
  // re-blacking the whole map. Same model as v1.
  const fogBySceneId = new Map<string, Uint8Array>();
  let seenTiles: Uint8Array | null = init.layout?.tileGrid
    ? new Uint8Array(init.layout.tileGrid.width * init.layout.tileGrid.height)
    : null;
  if (seenTiles) fogBySceneId.set(init.sceneId, seenTiles);
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
      geometry: makePlaceholderGeometry(init.self.x, init.self.y),
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
    const tex = getAnimationFrame(
      animId,
      viewModelKey(equippedWeapon),
      performance.now(),
      'idle',
    );
    if (!tex || tex.width <= 0 || tex.height <= 0) {
      viewModel.visible = false;
      return;
    }
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
    swapTexturedMeshGeometry(texturedFloorMesh, buildTexturedFloorGeometry(result.map));
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
    );
    refreshStaticLights();
  }

  // Publish a static light at every interactable. stairs_down
  // (surface portal + deeper descents) reads cool-blue; extract
  // pads read warm-green. Lights sit at eye height so walls
  // pick up the glow on top and the floor catches the same
  // wash from below.
  function refreshStaticLights(): void {
    if (!layout || layout.interactables.length === 0) {
      lights.clearStaticLights();
      return;
    }
    const next: StaticLight[] = [];
    // Eye-height equivalent (half wall, matches the camera Z
    // offset used elsewhere in this file). Interactables sit on
    // the floor so this keeps the glow centred around head
    // level rather than the floor plane.
    const lightZ = 16;
    for (const it of layout.interactables) {
      if (it.kind === 'stairs_down') {
        next.push(stairsDownLightAt(it.id, it.x, it.y, lightZ));
      } else if (it.kind === 'extract_pad') {
        next.push(extractPadLightAt(it.id, it.x, it.y, lightZ));
      }
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
      m.geometry = makePlaceholderGeometry(0, 0);
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
    bindSurfaceTexture(texturedFloorMesh, floorTex);
    bindSurfaceTexture(texturedCeilingMesh, ceilingTex);
    bindSurfaceTexture(texturedWallMesh, wallTex);
  }

  function bindSurfaceTexture(
    m: Mesh<Geometry, import('pixi.js').Shader>,
    tex: import('pixi.js').Texture | null,
  ): void {
    if (!tex) {
      m.visible = false;
      return;
    }
    // Mesh.shader is typed as Shader | null because Pixi allows
    // creating a Mesh and assigning a shader later; ours is
    // always constructed with one, but TS doesn't know that.
    if (!m.shader) return;
    m.shader.resources.uTexture = tex.source;
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
    if (e.button === 0) mouseDown = true;
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
    updateNearInteractable();
    if (canvasEl.width !== lastCanvasW || canvasEl.height !== lastCanvasH) {
      lastCanvasW = canvasEl.width;
      lastCanvasH = canvasEl.height;
      updateCrosshair();
    }
    // View-model needs a per-frame refresh — the animation
    // frame changes between ticks even when the weapon doesn't.
    updateViewModel();
    updateSkybox();
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
      camera.floorZ + 16,
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
    const active = texturedBuildings.refreshTextures((kind) => {
      const animId = buildingVisualFor(kind).animationId;
      const animTex = animId
        ? getAnimationFrame(animId, `building::${kind}`, nowAnimMs, 'idle')
        : null;
      return animTex ?? lookupTexture('building', kind);
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
    fog.uCameraPos[2] = camera.floorZ + 16;
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
      const tex = animTex ?? staticTex;
      if (tex) {
        texturedSprites.push(
          {
            textureKey: tex.uid,
            texture: tex,
            x: e.x,
            y: e.y,
            anchorZ: 0,
            height: v.size,
            aspect: textureAspect(tex),
            tint: 0xffffff,
          },
          camera,
        );
      } else {
        spriteScratch.push({
          x: e.x,
          y: e.y,
          anchorZ: 0,
          height: v.size,
          color: v.color,
        });
      }
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
      // explicit anchorZ the sprite layer wants.
      const offsetFrac = v.spriteGroundOffset ?? 0;
      const anchorZ = offsetFrac * Math.max(0, ceilingZ - h);
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
      const tex = animTex ?? staticTex;
      if (tex) {
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
      } else {
        spriteScratch.push({
          x: p.x,
          y: p.y,
          anchorZ,
          height: h,
          color: tint,
        });
      }
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
      // Wall clip: if the extrapolated position is inside a
      // non-walkable tile, the projectile has visually hit the
      // wall. Server emits the despawn but it may arrive a
      // frame or two later; suppress the visual now to avoid
      // the "stuck inside a wall" frame.
      if (tg && tiles && !isWalkableTileId(tileIdAt(tg, tiles, x, y))) {
        continue;
      }
      // Projectile centre at eye level — bottom = eyeZ -
      // height/2 — matches v1's floats=true horizon-anchored
      // billboard behaviour.
      const h = PROJECTILE_SIZE;
      const animId = resolveProjectileAnimId(pr.weaponId);
      const tex = animId
        ? getAnimationFrame(animId, `projectile::${pr.id}`, nowAnim, 'idle')
        : null;
      if (tex) {
        texturedSprites.push(
          {
            textureKey: tex.uid,
            texture: tex,
            x,
            y,
            anchorZ: eyeZ - h * 0.5,
            height: h,
            aspect: textureAspect(tex),
            tint: 0xffffff,
          },
          camera,
        );
      } else {
        spriteScratch.push({
          x,
          y,
          anchorZ: eyeZ - h * 0.5,
          height: h,
          color: pr.color ?? PROJECTILE_DEFAULT_COLOR,
        });
      }
    }
    for (const l of loot.values()) {
      // Resolve a per-loot texture by content kind. Materials
      // have `material/<materialId>` overrides; parts use the
      // tier colour as a fallback (no per-part static texture
      // today); everything else uses a generic amber pouch.
      // Same priority chain v1 uses so authored textures port
      // cleanly.
      let staticTex: import('pixi.js').Texture | null = null;
      let color = PROJECTILE_DEFAULT_COLOR;
      if (l.content.kind === 'material') {
        color = materialTint(l.content.materialId);
        staticTex = lookupTexture('material', l.content.materialId);
      } else if (l.content.kind === 'part') {
        color = TIER_COLORS_NUM[l.content.part.tier] ?? PROJECTILE_DEFAULT_COLOR;
      }
      if (staticTex) {
        texturedSprites.push(
          {
            textureKey: staticTex.uid,
            texture: staticTex,
            x: l.x,
            y: l.y,
            anchorZ: 0,
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
          anchorZ: 0,
          height: LOOT_SIZE,
          color,
        });
      }
    }
    for (const c of corpses.values()) {
      spriteScratch.push({
        x: c.x,
        y: c.y,
        anchorZ: 0,
        height: CORPSE_SIZE,
        color: CORPSE_COLOR,
      });
    }
    // Other players (multiplayer). Skip self — the camera is
    // already at our world position; rendering a sprite there
    // would just paint over the centre of our own screen.
    for (const p of players.values()) {
      if (p.characterId === init.self.characterId) continue;
      spriteScratch.push({
        x: p.x,
        y: p.y,
        anchorZ: 0,
        height: OTHER_PLAYER_HEIGHT,
        color: OTHER_PLAYER_COLOR,
      });
    }
    sprites.update(spriteScratch, camera);
    texturedSprites.endFrame();
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
  function tickSelfSmoothing(): void {
    const now = performance.now();
    const dt = lastSelfTickAt === 0 ? 16 : now - lastSelfTickAt;
    lastSelfTickAt = now;
    const dx = targetSelfX - selfX;
    const dy = targetSelfY - selfY;
    if (dx === 0 && dy === 0) return;
    const t = Math.min(1, 1 - Math.exp(-dt / SELF_SMOOTH_TAU_MS));
    selfX += dx * t;
    selfY += dy * t;
    if (Math.abs(targetSelfX - selfX) < 0.05) selfX = targetSelfX;
    if (Math.abs(targetSelfY - selfY) < 0.05) selfY = targetSelfY;
    camera.setSelfPosition(selfX, selfY, 0);
  }

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
        seenTiles[ly * tg.width + lx] = 1;
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
    init.sendInput(mx, my, sprint);

    // Hold-to-fire while a weapon is equipped. Server gates by
    // per-weapon fire interval + mag + reload, so we can pulse
    // every frame; the noise gets dropped at the boundary.
    // Mobile fire bypasses the pointer-lock gate (no pointer
    // lock exists on touch).
    const fireHeld =
      (mouseDown && pointerLocked) || mobileFireHeld;
    if (fireHeld && equippedWeapon !== null) {
      init.sendFire(cy, sy);
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

  function selfState(): Player {
    return players.get(init.self.characterId) ?? init.self;
  }

  function noop(): void {
    /* Phase 1: every entity / state method is a no-op until the
       geometry + sprite layers exist. We deliberately don't throw
       — keeping the renderer crash-free under welcome / state
       traffic means the toggle is safe to flip mid-session. */
  }

  return {
    upsertPlayer: (p: Player) => {
      players.set(p.characterId, p);
      if (p.characterId === init.self.characterId) {
        selfX = p.x;
        selfY = p.y;
        camera.setSelfPosition(p.x, p.y, 0);
      }
    },
    removePlayer: (id: string) => {
      players.delete(id);
    },
    movePlayer: (id: string, x: number, y: number) => {
      const p = players.get(id);
      if (p) {
        p.x = x;
        p.y = y;
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
          camera.setSelfPosition(x, y, 0);
        }
        targetSelfX = x;
        targetSelfY = y;
      }
    },
    setPlayerHp: noop,
    setPlayerDead: noop,
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
        // Respawn is a teleport — snap, don't lerp.
        selfX = x;
        selfY = y;
        targetSelfX = x;
        targetSelfY = y;
        camera.setSelfPosition(x, y, 0);
      }
    },
    showWeaponSwung: noop,
    upsertEnemy: (e: EnemyState) => enemies.set(e.id, e),
    removeEnemy: (id: string) => enemies.delete(id),
    setEnemyPosition: (id: string, x: number, y: number) => {
      const e = enemies.get(id);
      if (e) {
        e.x = x;
        e.y = y;
      }
    },
    setEnemyHp: noop,
    spawnProjectile: (p: ProjectileState) => {
      const nowMs = performance.now();
      projectiles.set(p.id, p);
      projectileSpawnedAt.set(p.id, nowMs);
      // Muzzle flash light at the projectile spawn point —
      // server-confirmed real shot. Visible to everyone via the
      // shared lighting model (a teammate's fire briefly lights
      // up walls around them). 60ms TTL keeps it punchy.
      lights.add(muzzleFlashAt(p.x, p.y, camera.floorZ + 16, nowMs));
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
    despawnProjectile: (id: string) => {
      projectiles.delete(id);
      projectileSpawnedAt.delete(id);
    },
    spawnLoot: (l: LootState) => loot.set(l.id, l),
    despawnLoot: (id: string) => loot.delete(id),
    spawnCorpse: (c: CorpseState) => corpses.set(c.id, c),
    removeCorpse: (id: string) => corpses.delete(id),
    spawnBuilding: (b: BuildingState) => {
      buildings.set(b.id, b);
      rebuildSectorGeometry();
    },
    removeBuilding: (id: string) => {
      buildings.delete(id);
      rebuildSectorGeometry();
    },
    setBuildingHp: noop,
    spawnProp: (p: PropState) => props.set(p.id, p),
    removeProp: (id: string) => props.delete(id),
    setPropHp: noop,
    changeProp: (p: PropState) => props.set(p.id, p),
    setBuildMode: noop,
    setBuildRadiusBonus: noop,
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
    setHordeActive: noop,
    swapScene: (state: SceneState) => {
      layout = state.layout;
      currentSceneId = state.sceneId;
      // Restore (or freshly allocate) the fog bitmap for this
      // scene. Dimensions are tied to the tileGrid; a cached
      // entry whose dimensions no longer match (cycle regen)
      // is dropped and rebuilt.
      if (layout?.tileGrid) {
        const w = layout.tileGrid.width;
        const h = layout.tileGrid.height;
        const cached = fogBySceneId.get(currentSceneId);
        if (cached && cached.length === w * h) {
          seenTiles = cached;
        } else {
          seenTiles = new Uint8Array(w * h);
          fogBySceneId.set(currentSceneId, seenTiles);
        }
      } else {
        seenTiles = null;
      }
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
      selfX = state.self.x;
      selfY = state.self.y;
      // Scene swap is a teleport — snap target to match so the
      // smoothing lerp doesn't drag from the prior scene's pos.
      targetSelfX = selfX;
      targetSelfY = selfY;
      lastSelfTickAt = 0;
      camera.setSelfPosition(selfX, selfY, 0);
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
    nearbyPlayers: () => [],
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
      init.sendFire(cy, sy);
    },
    destroy() {
      destroyed = true;
      sprites.destroy();
      texturedSprites.destroy();
      texturedBuildings.destroy();
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
