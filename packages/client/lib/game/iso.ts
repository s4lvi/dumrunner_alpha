"use client";

// Isometric renderer. Same GameHandle / GameInit contract as the
// top-down (`pixi.ts`) and FPS (`fps.ts`) renderers — server is
// fully unchanged, only the camera projection differs. World coords
// stay in the same 32-pixel-tile space; this file projects them to
// a 2:1 dimetric iso view.
//
// Cuts vs top-down (intentional first-pass scope):
// - No build-mode ghost ring (player can still build, no preview).
// - No per-room floor palette — one floor color.
// - No damage-flash / swing fx particles.
// - No asset_gen sprite swap; everything renders as procedural Graphics.
// - Buildings render as simple iso boxes coloured by kind, not bespoke
//   per-kind procedural geometry. Enough to be readable; polish is
//   its own pass.
//
// Iso projection is the standard 2:1 dimetric:
//   isoX = (worldX - worldY) / 2
//   isoY = (worldX + worldY) / 4
// A 32-pixel world tile renders as a 32-wide, 16-tall iso diamond.

import {
  Application,
  Assets,
  Container,
  Graphics,
  Mesh,
  MeshGeometry,
  Sprite,
  Text,
  type Renderer,
  type Texture,
} from "pixi.js";
import {
  getOverride,
  subscribe as subscribeOverrides,
} from "../textureOverrides";
import {
  biomePaletteFor,
  enemyVisualFor,
  materialTint,
  segmentInsideWalkables,
  TIER_COLORS_NUM,
  type BuildingState,
  type CorpseState,
  type EnemyState,
  type Interactable,
  type LootState,
  type Player,
  type ProjectileState,
  type PropState,
} from "@dumrunner/shared";
import type { GameHandle, GameInit, SceneState } from "./pixi";
import { buildingsToMinimapList, type MinimapSnapshot } from "./minimap";

// Must match server: COMBAT.PLAYER_RADIUS in packages/server/src/combat.ts.
const PLAYER_RADIUS = 14;
const INTERACTABLE_RADIUS = 60;

// ---------- iso helpers ----------

// World → iso (screen-space, before camera offset).
function w2iX(wx: number, wy: number): number {
  return (wx - wy) * 0.5;
}
function w2iY(wx: number, wy: number): number {
  return (wx + wy) * 0.25;
}

// Iso → world. Inverse of w2i. Used by mouse-aim to translate the
// cursor position on the canvas back into a world coordinate.
function i2wX(ix: number, iy: number): number {
  return ix + 2 * iy;
}
function i2wY(ix: number, iy: number): number {
  return -ix + 2 * iy;
}

// Depth sort key. Entities with greater (worldX + worldY) render
// AFTER (in front of) entities with smaller — gives the standard
// iso "things in front cover things behind" effect.
function depthOf(wx: number, wy: number): number {
  return wx + wy;
}

// ---------- runIsoGame ----------

type PlayerSprite = {
  data: Player;
  container: Container;
  body: Graphics;
  hpBar: Graphics;
  shieldBar: Graphics;
  nameTag: Text;
};

type EnemySprite = {
  data: EnemyState;
  container: Container;
  body: Graphics;
  hpBar: Graphics;
};

type LootSprite = {
  data: LootState;
  container: Container;
  body: Graphics;
};

type CorpseSprite = {
  data: CorpseState;
  container: Container;
};

type BuildingSprite = {
  data: BuildingState;
  container: Container;
  body: Graphics;
  hpBar: Graphics;
};

type PropSprite = {
  data: PropState;
  container: Container;
  body: Graphics;
};

type ProjectileSprite = {
  data: ProjectileState;
  container: Container;
};

// Default iso palette. The editor's biome preview overrides
// these via init.palette so the right hues render per-biome.
const FLOOR_COLOR = 0x232830;
const WALL_TOP_COLOR = 0x52525b;
const WALL_FRONT_COLOR = 0x3f3f46;

function parseHex(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const trimmed = s.startsWith('#') ? s.slice(1) : s;
  const n = parseInt(trimmed, 16);
  return Number.isFinite(n) ? n : fallback;
}
const WALL_HEIGHT_PX = 18; // visual extrusion height for wall blocks
// Camera zoom for the iso view. Top-down renders at 1:1; iso's
// 2:1 dimetric squash makes the world feel further away by
// default, so we counter with a base zoom > 1.
const ISO_ZOOM = 1.75;
// Half a typical billboard column. Used to compensate cursor
// inverse-projection so center-mass clicks land on the enemy's
// ground anchor rather than overshooting to the north-west.
const AIM_FOOT_OFFSET_PX = 16;
// Projectile chest-height offset. Shifts bullet streaks up off
// the floor so they appear to emanate from the shooter's torso.
const PROJECTILE_HEIGHT_PX = 17;
const PLAYER_OTHER_COLOR = 0x4dd0e1;
const PLAYER_SELF_COLOR = 0xfacc15;
const CORPSE_COLOR = 0x4a1d1d;

export function runIsoGame(host: HTMLElement, init: GameInit): GameHandle {
  // Palette resolution priority (highest first):
  //   1. init.palette — explicit override (editor preview).
  //   2. biomePaletteFor(layout.biome) — live game.
  //   3. Built-in FLOOR_COLOR / WALL_*_COLOR constants.
  // Re-resolved on every layout change (rebuildLayout call) so
  // a scene transition into a different biome picks up the new
  // hues without re-mounting the renderer.
  let floorColor = FLOOR_COLOR;
  let wallTopColor = WALL_TOP_COLOR;
  let wallFrontColor = WALL_FRONT_COLOR;
  function resolvePalette(biomeId: string | null | undefined): void {
    if (init.palette) {
      floorColor = parseHex(init.palette.floor, FLOOR_COLOR);
      wallTopColor = parseHex(init.palette.wallTop, WALL_TOP_COLOR);
      wallFrontColor = parseHex(init.palette.wallFront, WALL_FRONT_COLOR);
      return;
    }
    const palette = biomePaletteFor(biomeId);
    floorColor = parseHex(palette.floor, FLOOR_COLOR);
    // Both wall faces use the biome's single wall hue; the
    // renderer shades the front face slightly darker on its own
    // (existing side-face hardcode kept for now).
    wallTopColor = parseHex(palette.wall, WALL_TOP_COLOR);
    wallFrontColor = parseHex(palette.wall, WALL_FRONT_COLOR);
  }
  resolvePalette(init.layout?.biome ?? null);

  // ---------- Pixi app ----------
  // Pixi v8: init() is async + creates the renderer + (by default)
  // auto-starts the ticker. We track the init promise so destroy
  // can await it before tearing down — destroying mid-init makes
  // the auto-render fire against a null renderer ("Cannot read
  // properties of null (reading 'render')"), the crash that hits
  // when /editor remounts the preview between selections.
  const app = new Application();
  let appReady = false;
  let destroyed = false;
  const initPromise = app.init({
    background: 0x0b0d10,
    resizeTo: host,
    antialias: true,
  });
  void initPromise.then(() => {
    if (destroyed) {
      // Caller already asked us to tear down. Don't wire up a
      // canvas / renderer that's about to be destroyed.
      teardownPixi();
      return;
    }
    appReady = true;
    host.appendChild(app.canvas);
    setupRenderer();
  });

  function teardownPixi() {
    try {
      app.ticker?.remove(tick);
    } catch {
      /* ticker may already be gone */
    }
    try {
      // Detach the canvas from the host before destroying so
      // pixi doesn't trip on ResizeObserver disconnect ordering.
      const canvas = app.canvas as HTMLCanvasElement | undefined;
      if (canvas?.parentElement === host) host.removeChild(canvas);
    } catch {
      /* canvas may not have been attached if init was in flight */
    }
    try {
      app.destroy({ removeView: true }, { children: true });
    } catch {
      /* best-effort */
    }
  }

  // ---------- layers ----------
  // worldLayer holds everything that lives in iso world-space (so
  // camera translation moves the whole world together). hudLayer is
  // for screen-space overlays that never iso-project.
  const worldLayer = new Container();
  const floorLayer = new Container();
  const entityLayer = new Container();
  const fxLayer = new Container();
  const fogLayer = new Container();
  const hudLayer = new Container();
  worldLayer.addChild(floorLayer);
  // Fog sits between the floor and entities so walls / players /
  // enemies in front of a dimmed tile aren't covered by the
  // shadow rectangle. (Entities outside line-of-sight are already
  // hidden by applyLineOfSight.)
  worldLayer.addChild(fogLayer);
  worldLayer.addChild(entityLayer);
  worldLayer.addChild(fxLayer);
  worldLayer.scale.set(ISO_ZOOM);
  // Walls live alongside entities so a player can pass behind a wall
  // (back-to-front depth sort). They go into entityLayer with their
  // own depth-sorted z-index.
  const wallSprites: Container[] = [];
  // Fog overlay: dimmed iso diamonds painted over walkable tiles
  // outside the player's visible cone. Rebuilt on player-tile change.
  let fogTileKey = "";

  // ---------- state ----------
  const players = new Map<string, PlayerSprite>();
  const enemies = new Map<string, EnemySprite>();
  const loot = new Map<string, LootSprite>();
  const corpses = new Map<string, CorpseSprite>();
  const buildings = new Map<string, BuildingSprite>();
  const props = new Map<string, PropSprite>();
  const projectiles = new Map<string, ProjectileSprite>();

  let currentLayout = init.layout;
  let selfX = init.self.x;
  let selfY = init.self.y;
  let selfId = init.self.characterId;
  let equippedWeapon: import("@dumrunner/shared").WeaponKind | null = null;
  let buildModeKind: import("@dumrunner/shared").BuildingKind | null = null;
  let buildRadiusBonus = 0;
  void buildModeKind;
  void buildRadiusBonus;
  // Self alive state — used internally on swapScene/respawn for
  // sprite alpha. The HP/Stamina/Shield bars + dead overlay are
  // owned by React (HudOverlay in Game.tsx).
  let selfAlive = init.self.alive;
  void selfAlive;

  // Mouse position on canvas, used by fire to compute aim vector.
  let mouseScreenX = 0;
  let mouseScreenY = 0;

  // Movement input — sent to server as a unit-clamped vector.
  // Identical to pixi.ts's input layer.
  const keys = new Set<string>();
  let lastSentMx = 0,
    lastSentMy = 0,
    lastSentSprint = false;
  let lastSentInputAt = 0;
  const INPUT_HEARTBEAT_MS = 50; // 20Hz, matches NETWORK_TICK_HZ in pixi.ts

  function computeIsoInput(): { mx: number; my: number; sprint: boolean } {
    let sx = 0,
      sy = 0;
    if (keys.has("w") || keys.has("arrowup")) sy -= 1;
    if (keys.has("s") || keys.has("arrowdown")) sy += 1;
    if (keys.has("a") || keys.has("arrowleft")) sx -= 1;
    if (keys.has("d") || keys.has("arrowright")) sx += 1;
    // The iso projection rotates the world ~45° clockwise on screen,
    // so without compensation pressing W (screen-up) sends the player
    // up-and-right in world space. Rotate the input vector by -45°
    // so screen directions match player intent. We don't apply the
    // 2:1 vertical squash because that would make N/S movement
    // slower than E/W; we just want the rotation.
    const rot = -Math.PI / 4;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    let mx = sx * c - sy * s;
    let my = sx * s + sy * c;
    const len = Math.hypot(mx, my);
    if (len > 0.0001) {
      mx /= len;
      my /= len;
    }
    return { mx, my, sprint: keys.has("shift") };
  }

  function sendInputMaybe() {
    const { mx, my, sprint } = computeIsoInput();
    if (mx !== lastSentMx || my !== lastSentMy || sprint !== lastSentSprint) {
      lastSentMx = mx;
      lastSentMy = my;
      lastSentSprint = sprint;
      lastSentInputAt = performance.now();
      init.sendInput(mx, my, sprint);
    }
  }

  // Heartbeat: re-send the current input every INPUT_HEARTBEAT_MS so
  // the server's PLAYER_INPUT_TTL_MS (200ms) doesn't snap input
  // back to zero mid-hold. Without this, holding W moves the player
  // for ~200ms then stops until you release+re-press the key.
  function heartbeatInput() {
    const now = performance.now();
    if (now - lastSentInputAt < INPUT_HEARTBEAT_MS) return;
    lastSentInputAt = now;
    init.sendInput(lastSentMx, lastSentMy, lastSentSprint);
  }

  // ---------- input wiring ----------
  function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    keys.add(e.key.toLowerCase());
    sendInputMaybe();
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.key.toLowerCase());
    sendInputMaybe();
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  let mouseDown = false;
  function onPointerMove(e: PointerEvent) {
    const rect = (app.canvas as HTMLCanvasElement).getBoundingClientRect();
    mouseScreenX = e.clientX - rect.left;
    mouseScreenY = e.clientY - rect.top;
  }
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    onPointerMove(e); // ensure latest cursor pos
    mouseDown = true;
    fireOrBuild();
  }
  function onPointerUp(e: PointerEvent) {
    if (e.button !== 0) return;
    mouseDown = false;
  }
  function onWindowBlur() {
    // Tab-out / window-switch should release a held trigger so the
    // player doesn't return to find their gun has been firing.
    mouseDown = false;
    keys.clear();
    sendInputMaybe();
  }
  function fireOrBuild() {
    // Inverse-project the cursor screen position back to a world
    // coordinate, then compute the aim vector from the player.
    //
    // Foot-offset compensation: billboards (players, enemies) are
    // drawn upward from their ground anchor, so clicking an
    // enemy's center mass naively unprojects to a world point
    // north-west of the enemy's actual ground position. Pushing
    // the cursor's screen-Y down by ~half a billboard height
    // before unprojecting shifts the aim point onto the enemy's
    // feet — the standard iso-shooter aim-fix.
    // Cursor → iso-world: undo translation, then divide by zoom.
    // Foot offset is in screen pixels (post-zoom), so apply it
    // before the divide.
    const ix = (mouseScreenX - worldLayer.x) / ISO_ZOOM;
    const iy =
      (mouseScreenY - worldLayer.y + AIM_FOOT_OFFSET_PX) / ISO_ZOOM;
    const targetX = i2wX(ix, iy);
    const targetY = i2wY(ix, iy);
    if (buildModeKind !== null && currentLayout?.tileSize) {
      const tile = currentLayout.tileSize;
      const tx = Math.floor(targetX / tile);
      const ty = Math.floor(targetY / tile);
      init.sendBuild(buildModeKind, tx, ty);
      return;
    }
    if (!equippedWeapon) return;
    const dx = targetX - selfX;
    const dy = targetY - selfY;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    init.sendFire(dx / len, dy / len);
  }

  // ---------- helpers: position a container at iso(world) ----------
  function placeAtWorld(c: Container, wx: number, wy: number): void {
    c.x = w2iX(wx, wy);
    c.y = w2iY(wx, wy);
    c.zIndex = depthOf(wx, wy);
  }

  // ---------- floor + walls ----------
  // Both render once on layout change, since the layout is static for
  // the scene's lifetime.
  function rebuildLayout(): void {
    floorLayer.removeChildren();
    clearWalls();
    if (!currentLayout) return;
    // Resolve the biome palette before any drawing — scene_changed
    // can land us in a different biome and the wall / floor
    // colours need to follow.
    resolvePalette(currentLayout.biome ?? null);
    const tile = currentLayout.tileSize || 32;
    if (tile <= 0) return;
    if (currentLayout.walkables.length === 0) {
      // Surface — no dungeon floor to paint.
      return;
    }
    // Dark void backdrop so the dungeon reads as carved out of black.
    const voidBg = new Graphics();
    voidBg.rect(-12000, -12000, 24000, 24000).fill({ color: 0x05070a });
    floorLayer.addChild(voidBg);
    // Walkables → iso diamonds. No stroke — strokes from overlapping
    // rects show through as visible seams. The exterior wall pass
    // below provides the visual boundary instead.
    for (const r of currentLayout.walkables) {
      const g = new Graphics();
      const ax = r.x;
      const ay = r.y;
      const bx = r.x + r.w;
      const by = r.y + r.h;
      g.poly([
        w2iX(ax, ay),
        w2iY(ax, ay),
        w2iX(bx, ay),
        w2iY(bx, ay),
        w2iX(bx, by),
        w2iY(bx, by),
        w2iX(ax, by),
        w2iY(ax, by),
      ]);
      g.fill({ color: floorColor });
      floorLayer.addChild(g);
    }
    // Interactables — render as small markers on the floor.
    if (currentLayout.interactables) {
      for (const ix of currentLayout.interactables) {
        const marker = drawInteractable(ix);
        floorLayer.addChild(marker);
      }
    }
    // Build the exterior wall ring as iso cubes.
    rebuildWalls();
  }

  function clearWalls(): void {
    for (const w of wallSprites) {
      entityLayer.removeChild(w);
      w.destroy({ children: true });
    }
    wallSprites.length = 0;
  }

  // Tile-based exterior walls. For every non-walkable tile that
  // has a walkable 4-neighbour, drop an iso wall cube. This gives
  // the dungeon a contiguous wall ring without double-stroking
  // seams between overlapping walkable rects. Walls go into the
  // entity layer so they depth-sort with players + enemies.
  function rebuildWalls(): void {
    if (!currentLayout) return;
    const tile = currentLayout.tileSize;
    if (tile <= 0) return;
    const walkables = currentLayout.walkables;
    if (walkables.length === 0) return;
    const walkSet = new Set<string>();
    let minTX = Infinity,
      minTY = Infinity,
      maxTX = -Infinity,
      maxTY = -Infinity;
    for (const r of walkables) {
      const sx = Math.floor(r.x / tile);
      const sy = Math.floor(r.y / tile);
      const ex = Math.floor((r.x + r.w - 1) / tile);
      const ey = Math.floor((r.y + r.h - 1) / tile);
      for (let ty = sy; ty <= ey; ty++) {
        for (let tx = sx; tx <= ex; tx++) {
          walkSet.add(`${tx},${ty}`);
        }
      }
      if (sx < minTX) minTX = sx;
      if (sy < minTY) minTY = sy;
      if (ex > maxTX) maxTX = ex;
      if (ey > maxTY) maxTY = ey;
    }
    // Two-pass: first stamp out which tiles are walls, then build
    // sprites with face-occlusion flags computed from neighbour
    // walls. The iso camera looks from the NE, so the visible side
    // faces are EAST (between tile and tile+1 along x) and SOUTH
    // (between tile and tile+1 along y). When the neighbouring
    // tile in those directions is also a wall, the face is hidden
    // by that wall — skip drawing it.
    const wallSet = new Set<string>();
    for (let ty = minTY - 1; ty <= maxTY + 1; ty++) {
      for (let tx = minTX - 1; tx <= maxTX + 1; tx++) {
        if (walkSet.has(`${tx},${ty}`)) continue;
        const adj =
          walkSet.has(`${tx - 1},${ty}`) ||
          walkSet.has(`${tx + 1},${ty}`) ||
          walkSet.has(`${tx},${ty - 1}`) ||
          walkSet.has(`${tx},${ty + 1}`);
        if (!adj) continue;
        wallSet.add(`${tx},${ty}`);
      }
    }
    for (const k of wallSet) {
      const [txStr, tyStr] = k.split(",");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      const showEast = !wallSet.has(`${tx + 1},${ty}`);
      const showSouth = !wallSet.has(`${tx},${ty + 1}`);
      const sprite = makeWallTileSprite(tx, ty, tile, {
        showEast,
        showSouth,
      });
      wallSprites.push(sprite);
      entityLayer.addChild(sprite);
    }
  }

  function makeWallTileSprite(
    tx: number,
    ty: number,
    tileSize: number,
    faces: { showEast: boolean; showSouth: boolean } = {
      showEast: true,
      showSouth: true,
    },
  ): Container {
    const c = new Container();
    const g = new Graphics();
    const halfW = tileSize / 2;
    const halfH = tileSize / 2;
    const top = [
      w2iX(-halfW, -halfH),
      w2iY(-halfW, -halfH),
      w2iX(halfW, -halfH),
      w2iY(halfW, -halfH),
      w2iX(halfW, halfH),
      w2iY(halfW, halfH),
      w2iX(-halfW, halfH),
      w2iY(-halfW, halfH),
    ];
    const h = WALL_HEIGHT_PX;
    // East face (between iso(NE) and iso(SE) — right side of the
    // cube). Only drawn when the eastern neighbour isn't a wall;
    // otherwise it's pinned against the next wall and invisible.
    if (faces.showEast) {
      g.poly([
        top[2],
        top[3],
        top[4],
        top[5],
        top[4],
        top[5] - h,
        top[2],
        top[3] - h,
      ]);
      g.fill({ color: wallFrontColor });
      g.stroke({ color: 0x0b0d10, width: 1 });
    }
    // South face (between iso(SE) and iso(SW) — bottom of the
    // cube). Same culling rule for the southern neighbour.
    if (faces.showSouth) {
      g.poly([
        top[4],
        top[5],
        top[6],
        top[7],
        top[6],
        top[7] - h,
        top[4],
        top[5] - h,
      ]);
      g.fill({ color: 0x2c2e35 });
      g.stroke({ color: 0x0b0d10, width: 1 });
    }
    // Top face — always shown (cubes are 1 tile tall, nothing
    // above to occlude the top).
    g.poly([
      top[0],
      top[1] - h,
      top[2],
      top[3] - h,
      top[4],
      top[5] - h,
      top[6],
      top[7] - h,
    ]);
    g.fill({ color: wallTopColor });
    g.stroke({ color: 0x0b0d10, width: 1 });
    c.addChild(g);
    // Texture override: UV-map the uploaded image onto the visible
    // cube faces. Same culling — only meshes for non-occluded
    // sides.
    const tex = getOverrideTexture("building", "wall");
    if (tex) {
      g.visible = false;
      addTexturedCubeFaces(c, top, h, tex, faces);
    }
    const cx = (tx + 0.5) * tileSize;
    const cy = (ty + 0.5) * tileSize;
    c.x = w2iX(cx, cy);
    c.y = w2iY(cx, cy);
    c.zIndex = depthOf(cx, cy);
    return c;
  }

  function drawInteractable(ix: Interactable): Graphics {
    const g = new Graphics();
    g.x = w2iX(ix.x, ix.y);
    g.y = w2iY(ix.x, ix.y);
    g.circle(0, 0, INTERACTABLE_RADIUS * 0.5);
    g.fill({ color: 0x22d3ee, alpha: 0.18 });
    g.stroke({ color: 0x06b6d4, width: 2 });
    g.circle(0, 0, 6);
    g.fill({ color: 0x06b6d4 });
    return g;
  }

  // ---------- player sprites ----------
  function makePlayerSprite(p: Player): PlayerSprite {
    const container = new Container();
    const body = new Graphics();
    drawPlayerBody(body, p.characterId === selfId);
    container.addChild(body);
    // HP/shield bars + name tag sit above the billboard column.
    // Column height = PLAYER_RADIUS * 2.4 ≈ 33.6, so anchor bars
    // ~PLAYER_RADIUS * 2.6 above ground.
    const colTop = -(PLAYER_RADIUS * 2.4) - 4;
    const hpBar = new Graphics();
    hpBar.y = colTop;
    const shieldBar = new Graphics();
    shieldBar.y = colTop + 4;
    // Self's HP/Shield is shown by the screen-space HudOverlay,
    // so we skip the floating bars above the local player's
    // billboard. Remote players still show them so you can read
    // teammates' state at a glance.
    const isSelf = p.characterId === selfId;
    if (!isSelf) {
      container.addChild(hpBar);
      container.addChild(shieldBar);
    }
    // Name tag.
    const nameTag = new Text({
      text: p.displayName,
      style: { fontSize: 11, fill: 0xe6e8eb },
    });
    nameTag.anchor.set(0.5, 1);
    nameTag.y = colTop - 4;
    container.addChild(nameTag);
    placeAtWorld(container, p.x, p.y);
    paintHpBar(hpBar, p.hp, p.maxHp);
    paintShieldBar(shieldBar, p.shield, p.maxShield);
    return { data: { ...p }, container, body, hpBar, shieldBar, nameTag };
  }

  function drawPlayerBody(g: Graphics, isSelf: boolean): void {
    g.clear();
    const color = isSelf ? PLAYER_SELF_COLOR : PLAYER_OTHER_COLOR;
    // Billboard: ground shadow + upright sprite stand-in. The
    // sprite always faces the camera (no iso projection on the
    // body itself), only the anchor is iso-projected via the
    // container position.
    g.ellipse(0, 0, PLAYER_RADIUS, PLAYER_RADIUS * 0.5);
    g.fill({ color: 0x000000, alpha: 0.35 });
    const w = PLAYER_RADIUS * 1.4;
    const h = PLAYER_RADIUS * 2.4;
    // Body column (rounded rect).
    g.roundRect(-w / 2, -h, w, h - 2, 4);
    g.fill({ color });
    g.stroke({ color: 0x0b0d10, width: 1 });
    // Head dot (slightly lighter / on top).
    g.circle(0, -h + 4, w * 0.35);
    g.fill({ color: 0xfafafa, alpha: 0.85 });
    g.stroke({ color: 0x0b0d10, width: 1 });
  }

  function paintHpBar(g: Graphics, hp: number, maxHp: number): void {
    g.clear();
    const w = 28;
    const h = 3;
    g.rect(-w / 2, 0, w, h);
    g.fill({ color: 0x1c1c22 });
    if (maxHp > 0) {
      const frac = Math.max(0, Math.min(1, hp / maxHp));
      g.rect(-w / 2, 0, w * frac, h);
      g.fill({ color: 0xef4444 });
    }
  }

  function paintShieldBar(
    g: Graphics,
    shield: number,
    maxShield: number
  ): void {
    g.clear();
    if (maxShield <= 0) return;
    const w = 28;
    const h = 2;
    g.rect(-w / 2, 0, w, h);
    g.fill({ color: 0x1c1c22 });
    const frac = Math.max(0, Math.min(1, shield / maxShield));
    g.rect(-w / 2, 0, w * frac, h);
    g.fill({ color: 0x60a5fa });
  }

  // ---------- texture overrides (manual /editor uploads) ----------
  // Cache loaded Texture objects by data-URL so we don't re-decode
  // every frame. Pixi's Assets.load is async; while a texture is
  // loading we render the procedural fallback, then a one-shot
  // refresh swaps in the textured sprite once the load resolves.
  const texCache = new Map<string, Texture>();
  const texLoading = new Set<string>();
  function getOverrideTexture(category: string, id: string): Texture | null {
    const url = getOverride(category, id);
    if (!url) return null;
    const cached = texCache.get(url);
    if (cached) return cached;
    if (!texLoading.has(url)) {
      texLoading.add(url);
      void (async () => {
        try {
          const tex = (await Assets.load(url)) as Texture;
          texCache.set(url, tex);
          rebuildOverrideAffected();
        } catch {
          // Bad data URL or decode error — clear the loading flag
          // so a later upload can retry.
        } finally {
          texLoading.delete(url);
        }
      })();
    }
    return null;
  }
  // Re-build entities that consult overrides. Cheap — only invoked
  // when an override changes or a texture finishes loading.
  function rebuildOverrideAffected(): void {
    for (const [, sprite] of enemies) {
      sprite.body.removeChildren();
      drawEnemyBody(sprite.body, sprite.data.kind);
      applyEnemyTexture(sprite);
    }
    for (const [, sprite] of buildings) {
      sprite.body.removeChildren();
      drawBuildingBody(sprite.body, sprite.data);
      applyBuildingTexture(sprite);
    }
    for (const [, sprite] of props) {
      // Wipe extra children added by a previous applyPropTexture
      // run; the body Graphics itself stays in place.
      while (sprite.container.children.length > 1) {
        const child = sprite.container.children[1];
        sprite.container.removeChild(child);
      }
      sprite.body.visible = true;
      drawPropBody(sprite.body);
      applyPropTexture(sprite);
    }
    rebuildWalls();
  }
  // Subscribe once. The unsubscribe is fired in destroy().
  const unsubOverrides = subscribeOverrides(rebuildOverrideAffected);

  // Build a UV-mapped Mesh quad. Vertex order is NW, NE, SE, SW
  // (clockwise from top-left); UVs map the texture's (0,0) corner
  // to NW, (1,0) to NE, (1,1) to SE, (0,1) to SW.
  function makeQuadMesh(
    nwX: number,
    nwY: number,
    neX: number,
    neY: number,
    seX: number,
    seY: number,
    swX: number,
    swY: number,
    tex: Texture,
  ): Mesh {
    const geom = new MeshGeometry({
      positions: new Float32Array([nwX, nwY, neX, neY, seX, seY, swX, swY]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    return new Mesh({ geometry: geom, texture: tex });
  }

  // Adds UV-mapped face meshes to a cube container. `top` is the
  // iso-projected ground footprint (NW, NE, SE, SW corners of the
  // floor diamond). `h` is the extrusion height in screen px.
  // `faces` controls which side faces to emit (top is always on);
  // honours the same neighbour-occlusion culling used for the
  // procedural fallback.
  function addTexturedCubeFaces(
    c: Container,
    top: number[],
    h: number,
    tex: Texture,
    faces: { showEast: boolean; showSouth: boolean } = {
      showEast: true,
      showSouth: true,
    },
  ): void {
    // Top face (raised by h). Iso-projected diamond.
    c.addChild(
      makeQuadMesh(
        top[0], top[1] - h, // NW
        top[2], top[3] - h, // NE
        top[4], top[5] - h, // SE
        top[6], top[7] - h, // SW
        tex,
      ),
    );
    if (faces.showEast) {
      // East face: from ground NE/SE up to top NE/SE.
      c.addChild(
        makeQuadMesh(
          top[2], top[3] - h, // top-NE
          top[2], top[3],     // ground-NE
          top[4], top[5],     // ground-SE
          top[4], top[5] - h, // top-SE
          tex,
        ),
      );
    }
    if (faces.showSouth) {
      // South face: from ground SE/SW up to top SE/SW.
      c.addChild(
        makeQuadMesh(
          top[4], top[5] - h, // top-SE
          top[4], top[5],     // ground-SE
          top[6], top[7],     // ground-SW
          top[6], top[7] - h, // top-SW
          tex,
        ),
      );
    }
  }

  function applyPropTexture(sprite: PropSprite): void {
    const tex = getOverrideTexture('prop', sprite.data.kind);
    if (!tex) return;
    sprite.body.visible = false;
    // Sprite size matches the procedural billboard (roughly 24px
    // wide); height scales with the texture's aspect.
    const target = 28;
    const s = new Sprite(tex);
    s.anchor.set(0.5, 1);
    const aspect =
      tex.width > 0 && tex.height > 0 ? tex.width / tex.height : 1;
    s.height = target;
    s.width = target * aspect;
    sprite.container.addChild(s);
  }

  function applyEnemyTexture(sprite: EnemySprite): void {
    const tex = getOverrideTexture("enemy", sprite.data.kind);
    if (!tex) return;
    // Hide the procedural body; render the texture as a billboard
    // sized roughly to the enemy's visual scale (height ≈ size*3).
    sprite.body.visible = false;
    const v = enemyVisualFor(sprite.data.kind);
    const target = v.size * 3;
    const s = new Sprite(tex);
    s.anchor.set(0.5, 1); // bottom-centre at the ground
    const aspect =
      tex.width > 0 && tex.height > 0 ? tex.width / tex.height : 1;
    s.height = target;
    s.width = target * aspect;
    sprite.container.addChild(s);
  }

  function applyBuildingTexture(sprite: BuildingSprite): void {
    const tex = getOverrideTexture("building", sprite.data.kind);
    if (!tex) return;
    sprite.body.visible = false;
    const tile = currentLayout?.tileSize ?? 32;
    const w = sprite.data.width * tile;
    const hH = sprite.data.height * tile;
    const halfW = w / 2;
    const halfH = hH / 2;
    // Same per-kind footprint shrink + height as drawBuildingBody
    // so textured + procedural cubes are interchangeable visually.
    const isStation = isStationKind(sprite.data.kind);
    const shrink = isStation ? 0.8 : 1.0;
    const sw = halfW * shrink;
    const sh = halfH * shrink;
    const top = [
      w2iX(-sw, -sh),
      w2iY(-sw, -sh),
      w2iX(sw, -sh),
      w2iY(sw, -sh),
      w2iX(sw, sh),
      w2iY(sw, sh),
      w2iX(-sw, sh),
      w2iY(-sw, sh),
    ];
    const bodyHeight =
      sprite.data.kind === "wall"
        ? WALL_HEIGHT_PX
        : sprite.data.kind === "door"
          ? Math.round(WALL_HEIGHT_PX * 0.35)
          : isStation
            ? Math.round(WALL_HEIGHT_PX * 0.5)
            : Math.round(WALL_HEIGHT_PX * 0.75);
    addTexturedCubeFaces(sprite.container, top, bodyHeight, tex);
  }

  // ---------- enemy sprites ----------
  function makeEnemySprite(e: EnemyState): EnemySprite {
    const container = new Container();
    const body = new Graphics();
    drawEnemyBody(body, e.kind);
    container.addChild(body);
    const hpBar = new Graphics();
    const v = enemyVisualFor(e.kind);
    hpBar.y = -(v.size * 2.4) - 6;
    container.addChild(hpBar);
    placeAtWorld(container, e.x, e.y);
    paintHpBar(hpBar, e.hp, e.maxHp);
    const sprite = { data: { ...e }, container, body, hpBar };
    applyEnemyTexture(sprite);
    return sprite;
  }

  function drawEnemyBody(g: Graphics, kind: string): void {
    g.clear();
    const v = enemyVisualFor(kind);
    // Shadow.
    g.ellipse(0, 0, v.size, v.size * 0.5);
    g.fill({ color: 0x000000, alpha: 0.35 });
    // Billboard silhouette — vertical, faces the camera. Shape
    // is preserved per template so triangle/square/circle still
    // read distinctly until real sprites land.
    const colH = v.size * 2.4;
    const colW = v.size * 1.4;
    if (v.shape === "triangle") {
      g.poly([0, -colH, -colW, 0, colW, 0]);
    } else if (v.shape === "square") {
      g.rect(-colW, -colH, colW * 2, colH);
    } else {
      g.roundRect(-colW, -colH, colW * 2, colH, colW * 0.5);
    }
    g.fill({ color: v.color });
    g.stroke({ color: 0x0b0d10, width: 1 });
  }

  // ---------- loot sprites ----------
  function makeLootSprite(l: LootState): LootSprite {
    const container = new Container();
    const body = new Graphics();
    drawLootBody(body, l);
    container.addChild(body);
    placeAtWorld(container, l.x, l.y);
    return { data: l, container, body };
  }
  function drawLootBody(g: Graphics, l: LootState): void {
    g.clear();
    // Ground shadow.
    g.ellipse(0, 0, 7, 3.5);
    g.fill({ color: 0x000000, alpha: 0.3 });
    // Upright billboard token, hovering slightly above the floor.
    const yBase = -4;
    if (l.content.kind === "material") {
      g.circle(0, yBase - 5, 5);
      g.fill({ color: materialTint(l.content.materialId) });
      g.stroke({ color: 0x0b0d10, width: 1 });
    } else if (l.content.kind === "part") {
      g.poly([0, yBase - 12, 6, yBase - 5, 0, yBase + 1, -6, yBase - 5]);
      g.fill({ color: TIER_COLORS_NUM[l.content.part.tier] ?? 0x9ca3af });
      g.stroke({ color: 0x0b0d10, width: 1 });
    } else {
      g.rect(-5, yBase - 11, 10, 11);
      g.fill({ color: 0x94a3b8 });
      g.stroke({ color: 0x0b0d10, width: 1 });
    }
  }

  // ---------- corpse sprites ----------
  function makeCorpseSprite(c: CorpseState): CorpseSprite {
    const container = new Container();
    const g = new Graphics();
    g.ellipse(0, 0, 14, 7);
    g.fill({ color: CORPSE_COLOR });
    g.stroke({ color: 0x0b0d10, width: 1 });
    container.addChild(g);
    placeAtWorld(container, c.x, c.y);
    return { data: c, container };
  }

  // ---------- prop sprites ----------
  // Decorator props (barrels, crates, conduits, etc) — billboard
  // sprites in iso (no per-prop renderer-side AI / hp bar). The
  // visual is a simple upright shape with a ground shadow until
  // textures land via the editor's `prop` upload category.
  function makePropSprite(p: PropState): PropSprite {
    const container = new Container();
    const body = new Graphics();
    drawPropBody(body);
    container.addChild(body);
    placeAtWorld(container, p.x, p.y);
    const sprite: PropSprite = { data: { ...p }, container, body };
    applyPropTexture(sprite);
    return sprite;
  }

  function drawPropBody(g: Graphics): void {
    g.clear();
    // Ground shadow.
    g.ellipse(0, 0, 14, 7);
    g.fill({ color: 0x000000, alpha: 0.35 });
    // Upright crate-ish silhouette so it reads as "stuff" in
    // the world. Per-kind visuals + texture overrides land
    // alongside biome content authoring.
    g.roundRect(-12, -22, 24, 22, 3);
    g.fill({ color: 0x71717a });
    g.stroke({ color: 0x0b0d10, width: 1 });
  }

  // ---------- building sprites ----------
  function makeBuildingSprite(b: BuildingState): BuildingSprite {
    const container = new Container();
    const body = new Graphics();
    drawBuildingBody(body, b);
    container.addChild(body);
    const hpBar = new Graphics();
    hpBar.y = -34;
    container.addChild(hpBar);
    paintHpBar(hpBar, b.hp, b.maxHp);
    const tile = currentLayout?.tileSize || 32;
    const wx = (b.tileX + b.width / 2) * tile;
    const wy = (b.tileY + b.height / 2) * tile;
    placeAtWorld(container, wx, wy);
    const sprite = { data: { ...b }, container, body, hpBar };
    applyBuildingTexture(sprite);
    return sprite;
  }

  function drawBuildingBody(g: Graphics, b: BuildingState): void {
    g.clear();
    const tile = currentLayout?.tileSize || 32;
    const w = b.width * tile;
    const h = b.height * tile;
    // Stations (workbenches, forge, etc.) get a slightly smaller
    // footprint so they read as objects placed on a tile rather
    // than filling it. Walls/doors keep their full footprint.
    const isStation = isStationKind(b.kind);
    const shrink = isStation ? 0.8 : 1.0;
    const halfW = (w / 2) * shrink;
    const halfH = (h / 2) * shrink;
    // Top-face corners in iso:
    const top = [
      w2iX(-halfW, -halfH),
      w2iY(-halfW, -halfH),
      w2iX(halfW, -halfH),
      w2iY(halfW, -halfH),
      w2iX(halfW, halfH),
      w2iY(halfW, halfH),
      w2iX(-halfW, halfH),
      w2iY(-halfW, halfH),
    ];
    const bodyHeight =
      b.kind === "wall"
        ? WALL_HEIGHT_PX
        : b.kind === "door"
          ? Math.round(WALL_HEIGHT_PX * 0.35)
          : isStation
            ? Math.round(WALL_HEIGHT_PX * 0.5)
            : Math.round(WALL_HEIGHT_PX * 0.75);
    const palette = buildingPalette(b);
    // Front face (south-east edge — the two tile edges visible to
    // a camera looking iso-from-the-northeast).
    g.poly([
      top[2],
      top[3],
      top[4],
      top[5],
      top[4],
      top[5] - bodyHeight,
      top[2],
      top[3] - bodyHeight,
    ]);
    g.fill({ color: palette.front });
    g.stroke({ color: 0x0b0d10, width: 1 });
    g.poly([
      top[4],
      top[5],
      top[6],
      top[7],
      top[6],
      top[7] - bodyHeight,
      top[4],
      top[5] - bodyHeight,
    ]);
    g.fill({ color: palette.side });
    g.stroke({ color: 0x0b0d10, width: 1 });
    // Top face — drawn last so depth-wise it's on top of the
    // extruded faces.
    g.poly([
      top[0],
      top[1] - bodyHeight,
      top[2],
      top[3] - bodyHeight,
      top[4],
      top[5] - bodyHeight,
      top[6],
      top[7] - bodyHeight,
    ]);
    g.fill({ color: palette.top });
    g.stroke({ color: 0x0b0d10, width: 1 });
  }

  function isStationKind(kind: string): boolean {
    return (
      kind === "workbench" ||
      kind === "forge" ||
      kind === "electronics_bench" ||
      kind === "weapon_bench" ||
      kind === "precision_mill" ||
      kind === "suit_bench" ||
      kind === "artifact_uplink" ||
      kind === "storage_chest"
    );
  }

  function buildingPalette(b: BuildingState): {
    top: number;
    front: number;
    side: number;
  } {
    if (b.kind === "wall") {
      return { top: wallTopColor, front: wallFrontColor, side: 0x2c2e35 };
    }
    if (b.kind === "power_link") {
      return { top: 0x06b6d4, front: 0x0e7490, side: 0x155e75 };
    }
    if (b.kind === "storage_chest") {
      return { top: 0xa16207, front: 0x78350f, side: 0x4a3520 };
    }
    if (b.kind.startsWith("turret")) {
      return { top: 0x3b82f6, front: 0x1e3a8a, side: 0x172554 };
    }
    if (b.kind === "door") {
      return { top: 0xfde68a, front: 0xfbbf24, side: 0xa16207 };
    }
    // Per-station palette so each bench is visually distinct
    // until icon textures replace the flat fills.
    if (b.kind === "workbench") {
      return { top: 0x71717a, front: 0x52525b, side: 0x3f3f46 };
    }
    if (b.kind === "forge") {
      return { top: 0xea580c, front: 0x9a3412, side: 0x7c2d12 };
    }
    if (b.kind === "electronics_bench") {
      return { top: 0x10b981, front: 0x047857, side: 0x064e3b };
    }
    if (b.kind === "weapon_bench") {
      return { top: 0xdc2626, front: 0x991b1b, side: 0x7f1d1d };
    }
    if (b.kind === "precision_mill") {
      return { top: 0x8b5cf6, front: 0x6d28d9, side: 0x4c1d95 };
    }
    if (b.kind === "suit_bench") {
      return { top: 0xec4899, front: 0xbe185d, side: 0x831843 };
    }
    if (b.kind === "artifact_uplink") {
      return { top: 0xf59e0b, front: 0xb45309, side: 0x78350f };
    }
    return { top: 0x52525b, front: 0x3f3f46, side: 0x27272a };
  }

  // ---------- projectile sprites ----------
  // Tapered streak — same visual as pixi.ts. The trail is drawn
  // along the projectile's velocity direction, projected into iso
  // space so the streak reads parallel to its actual travel.
  function makeProjectileSprite(p: ProjectileState): ProjectileSprite {
    const container = new Container();
    const g = new Graphics();
    const color =
      p.color ?? (p.ownerKind === "enemy" ? 0xfbbf24 : 0xfafafa);
    drawIsoProjectileStreak(g, color, p.vx, p.vy);
    // Lift the streak to chest height. The projectile's world
    // anchor is at the shooter's feet (matching server collision),
    // but the visual should emanate from the billboard's torso so
    // it doesn't look like bullets are scraping the floor.
    g.y = -PROJECTILE_HEIGHT_PX;
    container.addChild(g);
    placeAtWorld(container, p.x, p.y);
    return { data: { ...p }, container };
  }

  function drawIsoProjectileStreak(
    g: Graphics,
    color: number,
    vx: number,
    vy: number
  ) {
    const TRAIL_LEN = 28;
    const len = Math.hypot(vx, vy) || 1;
    const ux = vx / len;
    const uy = vy / len;
    // Project the unit-velocity vector into iso so the streak
    // visually points opposite the direction of travel on screen.
    const ix = w2iX(ux, uy);
    const iy = w2iY(ux, uy);
    g.clear();
    g.moveTo(-ix * TRAIL_LEN, -iy * TRAIL_LEN)
      .lineTo(0, 0)
      .stroke({ color, width: 1, alpha: 0.3 });
    g.moveTo(-ix * (TRAIL_LEN * 0.55), -iy * (TRAIL_LEN * 0.55))
      .lineTo(0, 0)
      .stroke({ color, width: 2.5, alpha: 0.85 });
  }

  // ---------- per-frame tick: update positions + camera ----------
  function tick(): void {
    if (!appReady) return;
    // Project + camera-follow self. With a zoomed worldLayer, the
    // iso anchor scales too — multiply by ISO_ZOOM so the player
    // ends up at screen-centre after the scale is applied.
    const isoSelfX = w2iX(selfX, selfY);
    const isoSelfY = w2iY(selfX, selfY);
    worldLayer.x = -isoSelfX * ISO_ZOOM + app.renderer.width / 2;
    worldLayer.y = -isoSelfY * ISO_ZOOM + app.renderer.height / 2;

    // Move projectiles forward (server position is sparse; we
    // smooth via vx/vy).
    const dt = app.ticker.deltaMS / 1000;
    for (const p of projectiles.values()) {
      p.data.x += p.data.vx * dt;
      p.data.y += p.data.vy * dt;
      placeAtWorld(p.container, p.data.x, p.data.y);
    }

    // Hold-to-fire: send every frame while mouse is down + a weapon
    // is equipped + not in build mode. Server enforces per-weapon
    // fire timing so view doesn't affect rate. Mirrors fps.ts /
    // pixi.ts behaviour.
    if (mouseDown && buildModeKind === null && equippedWeapon !== null) {
      fireOrBuild();
    }

    // Movement-input heartbeat. Server expires input after 200ms;
    // without a heartbeat the player only travels ~200ms per
    // keypress and stops until they release+re-press the key.
    heartbeatInput();

    // Visual line-of-sight: hide remote entities the player can't
    // see through walls. Mirrors pixi.ts. Without this, you can see
    // (and aim at) enemies behind walls — though server-side
    // collision still stops the bullet, the mismatched perception
    // reads as broken.
    applyLineOfSight();

    // Fog of war / light cone: dim walkable tiles outside the
    // player's view. Cheap — only repaints on player-tile change.
    updateFog();

    // Re-sort entityLayer so depth ordering follows current
    // positions (entities move every frame).
    entityLayer.sortChildren();
  }

  function updateFog(): void {
    const layout = currentLayout;
    if (!layout || layout.walkables.length === 0 || layout.tileSize <= 0) {
      if (fogTileKey !== "__empty") {
        fogLayer.removeChildren();
        fogTileKey = "__empty";
      }
      return;
    }
    const tileSize = layout.tileSize;
    const playerTileX = Math.floor(selfX / tileSize);
    const playerTileY = Math.floor(selfY / tileSize);
    const key = `${playerTileX},${playerTileY}`;
    if (key === fogTileKey) return;
    fogTileKey = key;
    fogLayer.removeChildren();

    const VIEW_RADIUS_TILES = 13;
    const radiusSq = VIEW_RADIUS_TILES * VIEW_RADIUS_TILES;
    const walkables = layout.walkables;
    const halfW = tileSize / 2;
    const halfH = tileSize / 2;
    // One Graphics for all dimmed tiles; cheaper than per-tile.
    const g = new Graphics();
    const seen = new Set<string>();
    for (const r of walkables) {
      const startTX = Math.floor(r.x / tileSize);
      const startTY = Math.floor(r.y / tileSize);
      const endTX = Math.floor((r.x + r.w - 1) / tileSize);
      const endTY = Math.floor((r.y + r.h - 1) / tileSize);
      for (let ty = startTY; ty <= endTY; ty++) {
        for (let tx = startTX; tx <= endTX; tx++) {
          const tk = `${tx},${ty}`;
          if (seen.has(tk)) continue;
          seen.add(tk);
          const dx = tx - playerTileX;
          const dy = ty - playerTileY;
          let visible = false;
          if (dx * dx + dy * dy <= radiusSq) {
            const cx = (tx + 0.5) * tileSize;
            const cy = (ty + 0.5) * tileSize;
            if (segmentInsideWalkables(walkables, selfX, selfY, cx, cy)) {
              visible = true;
            }
          }
          if (visible) continue;
          // Paint an iso diamond over this tile.
          const cx = (tx + 0.5) * tileSize;
          const cy = (ty + 0.5) * tileSize;
          const ox = w2iX(cx, cy);
          const oy = w2iY(cx, cy);
          g.poly([
            ox + w2iX(-halfW, -halfH),
            oy + w2iY(-halfW, -halfH),
            ox + w2iX(halfW, -halfH),
            oy + w2iY(halfW, -halfH),
            ox + w2iX(halfW, halfH),
            oy + w2iY(halfW, halfH),
            ox + w2iX(-halfW, halfH),
            oy + w2iY(-halfW, halfH),
          ]);
        }
      }
    }
    g.fill({ color: 0x000000, alpha: 0.65 });
    fogLayer.addChild(g);
  }

  function applyLineOfSight(): void {
    const walkables = currentLayout?.walkables;
    if (!walkables || walkables.length === 0) {
      // Open scene (surface) — everything visible.
      for (const p of players.values()) p.container.visible = true;
      for (const e of enemies.values()) {
        if (e.data.hp > 0) e.container.visible = true;
      }
      for (const pr of projectiles.values()) pr.container.visible = true;
      for (const l of loot.values()) l.container.visible = true;
      for (const c of corpses.values()) c.container.visible = true;
      return;
    }
    const see = (x: number, y: number) =>
      segmentInsideWalkables(walkables, selfX, selfY, x, y);
    for (const [id, p] of players) {
      if (id === selfId) {
        p.container.visible = true;
        continue;
      }
      p.container.visible = see(p.data.x, p.data.y);
    }
    for (const e of enemies.values()) {
      if (e.data.hp <= 0) continue;
      e.container.visible = see(e.data.x, e.data.y);
    }
    for (const pr of projectiles.values()) {
      pr.container.visible = see(pr.data.x, pr.data.y);
    }
    for (const l of loot.values()) {
      l.container.visible = see(l.data.x, l.data.y);
    }
    for (const c of corpses.values()) {
      c.container.visible = see(c.data.x, c.data.y);
    }
  }

  // ---------- setup after init resolves ----------
  function setupRenderer(): void {
    app.stage.addChild(worldLayer);
    app.stage.addChild(hudLayer);
    entityLayer.sortableChildren = true;

    const canvas = app.canvas as HTMLCanvasElement;
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    // Pointer-up is bound to window (not canvas) so the trigger
    // releases reliably even if the cursor leaves the canvas while
    // held. Otherwise mouseDown sticks at true and tick() spams
    // sendFire forever — every weapon turns into a machine gun.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onWindowBlur);
    // Disable browser image-drag on the canvas so click+drag-to-fire
    // doesn't try to drag the canvas itself.
    canvas.addEventListener("dragstart", (e) => e.preventDefault());

    rebuildLayout();

    // Initial entities from init.
    for (const p of [init.self, ...init.others]) {
      const sprite = makePlayerSprite(p);
      entityLayer.addChild(sprite.container);
      players.set(p.characterId, sprite);
    }
    for (const e of init.enemies) {
      const sprite = makeEnemySprite(e);
      entityLayer.addChild(sprite.container);
      enemies.set(e.id, sprite);
    }
    for (const l of init.loot) {
      const sprite = makeLootSprite(l);
      entityLayer.addChild(sprite.container);
      loot.set(l.id, sprite);
    }
    for (const c of init.corpses) {
      const sprite = makeCorpseSprite(c);
      entityLayer.addChild(sprite.container);
      corpses.set(c.id, sprite);
    }
    for (const b of init.buildings) {
      const sprite = makeBuildingSprite(b);
      entityLayer.addChild(sprite.container);
      buildings.set(b.id, sprite);
    }
    for (const p of init.props) {
      const sprite = makePropSprite(p);
      entityLayer.addChild(sprite.container);
      props.set(p.id, sprite);
    }
    for (const pr of init.projectiles) {
      const sprite = makeProjectileSprite(pr);
      entityLayer.addChild(sprite.container);
      projectiles.set(pr.id, sprite);
    }

    // Tick.
    app.ticker.add(tick);

    // Surface workstation/door proximity callbacks. Reuses the
    // same proximity model as pixi.ts but on iso-positioned
    // entities (proximity is in world space, so the math doesn't
    // change). Fires every 250ms — cheap.
    setInterval(updateNearWorkstations, 250);
    setTimeout(updateNearWorkstations, 50);
    setInterval(updateNearInteractable, 250);
    setTimeout(updateNearInteractable, 50);
  }

  // ---------- proximity callbacks ----------
  // Kept identical in shape + math to pixi.ts so the host React
  // tree's E-prompt + workstation modal logic doesn't change.
  let lastWorkstationKey = "";
  function updateNearWorkstations(): void {
    const tileSize = currentLayout?.tileSize ?? 0;
    if (tileSize <= 0 || buildings.size === 0) {
      if (lastWorkstationKey !== "") {
        lastWorkstationKey = "";
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
    const r = 96;
    const r2 = r * r;
    const found = new Set<import("@dumrunner/shared").BuildingKind>();
    let nearestKind:
      | import("@dumrunner/shared").BuildingKind
      | null = null;
    let nearestDsq = Infinity;
    let nearestDoorId: string | null = null;
    let nearestDoorDsq = Infinity;
    let nearestChestId: string | null = null;
    let nearestChestDsq = Infinity;
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
      if (b.kind === "door") {
        if (dsq <= r2 && dsq < nearestDoorDsq) {
          nearestDoorDsq = dsq;
          nearestDoorId = b.id;
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
        nearestChestId,
        weaponBenchTier,
        weaponBenches,
      });
    }
  }

  let lastNearInteractableId: string | null = null;
  function updateNearInteractable(): void {
    if (!currentLayout?.interactables) {
      if (lastNearInteractableId !== null) {
        lastNearInteractableId = null;
        init.onNearInteractableChanged(null);
      }
      return;
    }
    let nearest: Interactable | null = null;
    let nearestDsq = INTERACTABLE_RADIUS * INTERACTABLE_RADIUS;
    for (const ix of currentLayout.interactables) {
      const dx = ix.x - selfX;
      const dy = ix.y - selfY;
      const dsq = dx * dx + dy * dy;
      if (dsq <= nearestDsq) {
        nearestDsq = dsq;
        nearest = ix;
      }
    }
    const id = nearest?.id ?? null;
    if (id !== lastNearInteractableId) {
      lastNearInteractableId = id;
      init.onNearInteractableChanged(
        nearest ? { id: nearest.id, label: nearest.label } : null
      );
    }
  }

  // ---------- GameHandle implementations ----------

  const handle: GameHandle = {
    upsertPlayer(p) {
      const existing = players.get(p.characterId);
      if (existing) {
        existing.data = { ...p };
        placeAtWorld(existing.container, p.x, p.y);
        return;
      }
      const sprite = makePlayerSprite(p);
      entityLayer.addChild(sprite.container);
      players.set(p.characterId, sprite);
    },
    removePlayer(id) {
      const s = players.get(id);
      if (!s) return;
      entityLayer.removeChild(s.container);
      players.delete(id);
    },
    movePlayer(id, x, y) {
      if (id === selfId) {
        selfX = x;
        selfY = y;
      }
      const s = players.get(id);
      if (!s) return;
      s.data.x = x;
      s.data.y = y;
      placeAtWorld(s.container, x, y);
    },
    setPlayerHp(id, hp, maxHp, shield, maxShield) {
      const s = players.get(id);
      if (s) {
        s.data.hp = hp;
        s.data.maxHp = maxHp;
        paintHpBar(s.hpBar, hp, maxHp);
        if (shield !== undefined && maxShield !== undefined) {
          s.data.shield = shield;
          s.data.maxShield = maxShield;
          paintShieldBar(s.shieldBar, shield, maxShield);
        }
      }
      // Self HP/Shield bars are owned by React (HudOverlay).
    },
    setPlayerDead(id) {
      const s = players.get(id);
      if (s) {
        s.body.alpha = 0.3;
        s.hpBar.alpha = 0.3;
        s.shieldBar.alpha = 0.3;
      }
      if (id === selfId) selfAlive = false;
    },
    respawnPlayer(id, x, y, hp, maxHp, stamina, maxStamina, shield, maxShield) {
      const s = players.get(id);
      if (s) {
        s.data.x = x;
        s.data.y = y;
        s.data.hp = hp;
        s.data.maxHp = maxHp;
        placeAtWorld(s.container, x, y);
        s.body.alpha = 1;
        s.hpBar.alpha = 1;
        s.shieldBar.alpha = 1;
        paintHpBar(s.hpBar, hp, maxHp);
        if (shield !== undefined && maxShield !== undefined) {
          s.data.shield = shield;
          s.data.maxShield = maxShield;
          paintShieldBar(s.shieldBar, shield, maxShield);
        }
      }
      if (id === selfId) {
        selfX = x;
        selfY = y;
        selfAlive = true;
      }
      void stamina;
      void maxStamina;
    },
    showWeaponSwung() {
      // First-pass iso renderer skips swing fx; the audio cue + the
      // damage event are still sufficient for combat readability.
    },
    upsertEnemy(e) {
      const existing = enemies.get(e.id);
      if (existing) {
        existing.data = { ...e };
        placeAtWorld(existing.container, e.x, e.y);
        return;
      }
      const sprite = makeEnemySprite(e);
      entityLayer.addChild(sprite.container);
      enemies.set(e.id, sprite);
    },
    setEnemyPosition(id, x, y) {
      const s = enemies.get(id);
      if (!s) return;
      s.data.x = x;
      s.data.y = y;
      placeAtWorld(s.container, x, y);
    },
    setEnemyHp(id, hp, maxHp) {
      const s = enemies.get(id);
      if (!s) return;
      s.data.hp = hp;
      s.data.maxHp = maxHp;
      paintHpBar(s.hpBar, hp, maxHp);
      // Hide the moment hp hits 0, even though the canonical
      // enemy_killed message comes through a tick later. Without
      // this, a V-cycle (or scene snapshot) between hp=0 and the
      // kill broadcast carries a "dead but still visible" sprite
      // into the new renderer.
      if (hp <= 0) {
        s.container.visible = false;
      }
    },
    removeEnemy(id) {
      const s = enemies.get(id);
      if (!s) return;
      entityLayer.removeChild(s.container);
      enemies.delete(id);
    },
    spawnProjectile(p) {
      const sprite = makeProjectileSprite(p);
      entityLayer.addChild(sprite.container);
      projectiles.set(p.id, sprite);
    },
    despawnProjectile(id) {
      const s = projectiles.get(id);
      if (!s) return;
      entityLayer.removeChild(s.container);
      projectiles.delete(id);
    },
    spawnLoot(l) {
      const sprite = makeLootSprite(l);
      entityLayer.addChild(sprite.container);
      loot.set(l.id, sprite);
    },
    despawnLoot(id) {
      const s = loot.get(id);
      if (!s) return;
      entityLayer.removeChild(s.container);
      loot.delete(id);
    },
    spawnCorpse(c) {
      const sprite = makeCorpseSprite(c);
      entityLayer.addChild(sprite.container);
      corpses.set(c.id, sprite);
    },
    removeCorpse(id) {
      const s = corpses.get(id);
      if (!s) return;
      entityLayer.removeChild(s.container);
      corpses.delete(id);
    },
    spawnBuilding(b) {
      const existing = buildings.get(b.id);
      if (existing) {
        // Re-emit (e.g. building_placed dual-duties as state-changed).
        // Replace the sprite to pick up benchTier/output changes.
        entityLayer.removeChild(existing.container);
        buildings.delete(b.id);
      }
      const sprite = makeBuildingSprite(b);
      entityLayer.addChild(sprite.container);
      buildings.set(b.id, sprite);
    },
    setBuildingHp(id, hp, maxHp) {
      const s = buildings.get(id);
      if (!s) return;
      s.data.hp = hp;
      s.data.maxHp = maxHp;
      paintHpBar(s.hpBar, hp, maxHp);
    },
    removeBuilding(id) {
      const s = buildings.get(id);
      if (!s) return;
      entityLayer.removeChild(s.container);
      buildings.delete(id);
    },
    spawnProp(p) {
      if (props.has(p.id)) return;
      const sprite = makePropSprite(p);
      entityLayer.addChild(sprite.container);
      props.set(p.id, sprite);
    },
    setPropHp(id, hp, maxHp) {
      const s = props.get(id);
      if (!s) return;
      s.data.hp = hp;
      s.data.maxHp = maxHp;
      // Hide-on-zero (defence against the prop_destroyed broadcast
      // landing a tick after prop_damaged during a renderer swap).
      if (hp <= 0) s.container.visible = false;
    },
    removeProp(id) {
      const s = props.get(id);
      if (!s) return;
      entityLayer.removeChild(s.container);
      props.delete(id);
    },
    setBuildMode(kind) {
      buildModeKind = kind;
      // Drop hold-to-fire when entering build mode so a held trigger
      // doesn't carry over once the player switches to a placeable.
      if (kind !== null) mouseDown = false;
    },
    setBuildRadiusBonus(tiles) {
      buildRadiusBonus = tiles;
    },
    setEquippedWeapon(weaponId) {
      equippedWeapon = weaponId;
      if (weaponId === null) mouseDown = false;
    },
    swapScene(state) {
      // Drop everything, paint fresh from the new state.
      currentLayout = state.layout;
      selfX = state.self.x;
      selfY = state.self.y;
      selfId = state.self.characterId;
      selfAlive = state.self.alive;
      for (const s of players.values()) entityLayer.removeChild(s.container);
      players.clear();
      for (const s of enemies.values()) entityLayer.removeChild(s.container);
      enemies.clear();
      for (const s of loot.values()) entityLayer.removeChild(s.container);
      loot.clear();
      for (const s of corpses.values()) entityLayer.removeChild(s.container);
      corpses.clear();
      for (const s of buildings.values()) entityLayer.removeChild(s.container);
      buildings.clear();
      for (const s of props.values()) entityLayer.removeChild(s.container);
      props.clear();
      for (const s of projectiles.values())
        entityLayer.removeChild(s.container);
      projectiles.clear();
      rebuildLayout();
      // Invalidate fog so the new layout's tiles get dimmed on
      // the next tick (player tile-key alone won't trigger a
      // repaint when the layout changed underneath it).
      fogTileKey = "";
      fogLayer.removeChildren();
      // Re-add from the new scene state.
      const selfSprite = makePlayerSprite(state.self);
      entityLayer.addChild(selfSprite.container);
      players.set(state.self.characterId, selfSprite);
      for (const p of state.players) {
        const sprite = makePlayerSprite(p);
        entityLayer.addChild(sprite.container);
        players.set(p.characterId, sprite);
      }
      for (const e of state.enemies) {
        const sprite = makeEnemySprite(e);
        entityLayer.addChild(sprite.container);
        enemies.set(e.id, sprite);
      }
      for (const l of state.loot) {
        const sprite = makeLootSprite(l);
        entityLayer.addChild(sprite.container);
        loot.set(l.id, sprite);
      }
      for (const c of state.corpses) {
        const sprite = makeCorpseSprite(c);
        entityLayer.addChild(sprite.container);
        corpses.set(c.id, sprite);
      }
      for (const b of state.buildings) {
        const sprite = makeBuildingSprite(b);
        entityLayer.addChild(sprite.container);
        buildings.set(b.id, sprite);
      }
      for (const p of state.props) {
        const sprite = makePropSprite(p);
        entityLayer.addChild(sprite.container);
        props.set(p.id, sprite);
      }
      for (const pr of state.projectiles) {
        const sprite = makeProjectileSprite(pr);
        entityLayer.addChild(sprite.container);
        projectiles.set(pr.id, sprite);
      }
    },
    currentSceneState(): SceneState {
      const self =
        players.get(selfId)?.data ??
        ({
          characterId: selfId,
          accountId: "",
          displayName: "",
          x: selfX,
          y: selfY,
          hp: 0,
          maxHp: 0,
          stamina: 0,
          maxStamina: 0,
          shield: 0,
          maxShield: 0,
          alive: true,
        } as Player);
      return {
        self,
        players: [...players.values()]
          .filter((p) => p.data.characterId !== selfId)
          .map((p) => p.data),
        enemies: [...enemies.values()].map((e) => e.data),
        projectiles: [...projectiles.values()].map((p) => p.data),
        loot: [...loot.values()].map((l) => l.data),
        corpses: [...corpses.values()].map((c) => c.data),
        buildings: [...buildings.values()].map((b) => b.data),
        props: [...props.values()].map((p) => p.data),
        layout: currentLayout,
      };
    },
    nearbyPlayers(radiusPx) {
      const r2 = radiusPx * radiusPx;
      const out: { characterId: string; displayName: string; dsq: number }[] =
        [];
      for (const p of players.values()) {
        if (p.data.characterId === selfId) continue;
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
      return out.map(({ characterId, displayName }) => ({
        characterId,
        displayName,
      }));
    },
    getMinimapSnapshot(): MinimapSnapshot {
      return {
        selfX,
        selfY,
        selfId,
        tileSize: currentLayout?.tileSize ?? 32,
        walkables: currentLayout?.walkables ?? [],
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
    destroy() {
      // Mark as destroyed FIRST so the init.then() callback above
      // sees it and skips rendererSetup. Without this flag, mounting
      // and unmounting before init resolves (React strict-mode
      // double-mount, /editor preview remount) causes ticker→render
      // to fire against a null renderer.
      destroyed = true;
      unsubOverrides();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      const canvas = app.canvas as HTMLCanvasElement | undefined;
      if (canvas) {
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerdown", onPointerDown);
      }
      if (!appReady) {
        // Init still in flight. Wait it out — destroying a
        // half-initialised pixi Application makes the auto-
        // render fire against a null renderer. The init.then()
        // above sees `destroyed` and calls teardownPixi() once
        // the renderer is alive enough to dispose cleanly.
        return;
      }
      teardownPixi();
    },
  };

  return handle;
}

// Light reference so the import-bot keeps Renderer in the analysed
// dep graph; we don't directly construct one but Pixi's types
// surface it via app.renderer.
void (null as unknown as Renderer);
