// Top-down dungeon overview for the sandbox. Different goal from
// the in-HUD minimap (lib/game/minimap.ts): that one centres on
// the player and shows a slice; this one fits the whole floor in
// frame so editor users can validate procgen output at a glance —
// walls, walkable area, interactables, every entity.
//
// Strictly a preview. No keyboard / mouse input wired in: switching
// to topdown mode parks the player (sandbox keeps them where they
// were) and lets the editor user inspect the layout. Toggle back
// to iso / fps to play. Implements the GameHandle contract so
// SandboxPreview's renderer effect can hot-swap to it without
// branching.
//
// Repaint cadence: schedule once per change via requestAnimationFrame.
// Multiple state mutations within a frame coalesce into one paint.

import type {
  BuildingState,
  CorpseState,
  EnemyState,
  Interactable,
  LootState,
  Player,
  ProjectileState,
  PropState,
  SceneLayout,
} from '@dumrunner/shared';
import {
  decodeTileGrid,
  enemyVisualFor,
  isWalkableTileId,
} from '@dumrunner/shared';
import type { GameHandle, GameInit, SceneState } from './pixi';
import {
  buildingMinimapColor,
  type MinimapSnapshot,
} from './minimap';

const BG_COLOR = '#08090d';
const FLOOR_COLOR = '#2b2d33';
const WALL_COLOR = '#0e1014';
const WALL_BORDER = '#1c1e26';
const SELF_COLOR = '#f97316'; // dûm orange
const OTHER_COLOR = '#4dd0e1';
const DEAD_COLOR = '#444444';
const PROJECTILE_COLOR = '#fafafa';
const CORPSE_COLOR = '#4a1d1d';
const EXTRACT_COLOR = '#34d399';
const STAIRS_COLOR = '#22d3ee';
const PROP_COLOR = '#71717a';

// Margin (px) reserved around the dungeon when fitting to canvas.
const FIT_MARGIN = 24;

export function runTopdownGame(
  host: HTMLElement,
  init: GameInit,
): GameHandle {
  // ---------- DOM ----------
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.background = BG_COLOR;
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // ---------- entity state ----------
  const players = new Map<string, Player>();
  for (const p of init.others) players.set(p.characterId, p);
  let self: Player = { ...init.self };
  players.set(self.characterId, self);

  const enemies = new Map<string, EnemyState>();
  for (const e of init.enemies) enemies.set(e.id, e);
  const projectiles = new Map<string, ProjectileState>();
  for (const p of init.projectiles) projectiles.set(p.id, p);
  const loot = new Map<string, LootState>();
  for (const l of init.loot) loot.set(l.id, l);
  const corpses = new Map<string, CorpseState>();
  for (const c of init.corpses) corpses.set(c.id, c);
  const buildings = new Map<string, BuildingState>();
  for (const b of init.buildings) buildings.set(b.id, b);
  const props = new Map<string, PropState>();
  for (const p of init.props) props.set(p.id, p);

  let layout: SceneLayout | null = init.layout;
  let decodedTiles: Uint8Array | null = decodeForLayout(layout);

  // ---------- repaint plumbing ----------
  let destroyed = false;
  let raf = 0;
  function requestRepaint(): void {
    if (destroyed || raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (destroyed) return;
      paint();
    });
  }

  // ---------- painting ----------
  // Cached fit transform. Recomputed when the layout changes or
  // when the canvas resizes. World units → screen units: scale +
  // offset (CSS pixel space; the ctx transform handles DPR).
  // panX / panY accumulate user drag offsets so the view stays
  // where the user dragged it across repaints.
  let viewScale = 1;
  let viewOffsetX = 0;
  let viewOffsetY = 0;
  let panX = 0;
  let panY = 0;
  // CSS dimensions (canvas.width / .height are DPR-scaled and
  // not usable for layout math).
  let cssWidth = 1;
  let cssHeight = 1;

  function recomputeFit(): void {
    if (!layout) {
      viewScale = 1;
      viewOffsetX = cssWidth / 2;
      viewOffsetY = cssHeight / 2;
      return;
    }
    const wb = layout.worldBounds;
    const cw = Math.max(1, cssWidth - FIT_MARGIN * 2);
    const ch = Math.max(1, cssHeight - FIT_MARGIN * 2);
    const sx = cw / Math.max(1, wb.w);
    const sy = ch / Math.max(1, wb.h);
    viewScale = Math.min(sx, sy);
    // Centre the bounds rect inside the visible canvas.
    viewOffsetX =
      FIT_MARGIN + (cw - wb.w * viewScale) / 2 - wb.x * viewScale;
    viewOffsetY =
      FIT_MARGIN + (ch - wb.h * viewScale) / 2 - wb.y * viewScale;
  }

  function worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx * viewScale + viewOffsetX + panX,
      y: wy * viewScale + viewOffsetY + panY,
    };
  }

  function fitCanvasToHost(): void {
    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    cssWidth = w;
    cssHeight = h;
    if (canvas.width === w * dpr && canvas.height === h * dpr) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    recomputeFit();
  }

  // ---------- pan (drag) ----------
  let dragging = false;
  let dragLastX = 0;
  let dragLastY = 0;
  canvas.style.cursor = 'grab';
  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - dragLastX;
    const dy = e.clientY - dragLastY;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    panX += dx;
    panY += dy;
    requestRepaint();
  }
  function onPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
  }
  function onDoubleClick(): void {
    panX = 0;
    panY = 0;
    requestRepaint();
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);

  function paint(): void {
    if (!ctx) return;
    fitCanvasToHost();
    const w = cssWidth;
    const h = cssHeight;
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    if (!layout) return;

    // ---- floor (walkables) ----
    ctx.fillStyle = FLOOR_COLOR;
    for (const r of layout.walkables) {
      const a = worldToScreen(r.x, r.y);
      ctx.fillRect(
        a.x,
        a.y,
        Math.max(1, r.w * viewScale),
        Math.max(1, r.h * viewScale),
      );
    }

    // ---- walls (from tile grid) ----
    if (layout.tileGrid && decodedTiles) {
      const grid = layout.tileGrid;
      const tileSize = grid.tileSize;
      const cellPx = tileSize * viewScale;
      ctx.fillStyle = WALL_COLOR;
      for (let ty = 0; ty < grid.height; ty++) {
        for (let tx = 0; tx < grid.width; tx++) {
          const id = decodedTiles[ty * grid.width + tx];
          if (id === 0 || isWalkableTileId(id)) continue;
          // Wall cell. Convert to world coords.
          const wx = (grid.originTileX + tx) * tileSize;
          const wy = (grid.originTileY + ty) * tileSize;
          const a = worldToScreen(wx, wy);
          ctx.fillRect(
            a.x,
            a.y,
            Math.max(1, cellPx),
            Math.max(1, cellPx),
          );
        }
      }
      // Subtle wall outline for readability when zoomed in.
      if (cellPx > 4) {
        ctx.strokeStyle = WALL_BORDER;
        ctx.lineWidth = 1;
        for (let ty = 0; ty < grid.height; ty++) {
          for (let tx = 0; tx < grid.width; tx++) {
            const id = decodedTiles[ty * grid.width + tx];
            if (id === 0 || isWalkableTileId(id)) continue;
            const wx = (grid.originTileX + tx) * tileSize;
            const wy = (grid.originTileY + ty) * tileSize;
            const a = worldToScreen(wx, wy);
            ctx.strokeRect(a.x + 0.5, a.y + 0.5, cellPx, cellPx);
          }
        }
      }
    }

    // ---- interactables (extract pads, stairs) ----
    for (const ix of layout.interactables) {
      drawInteractable(ctx, ix);
    }

    // ---- props (decorators) ----
    ctx.fillStyle = PROP_COLOR;
    for (const p of props.values()) {
      const a = worldToScreen(p.x, p.y);
      const size = Math.max(2, 6 * Math.min(1, viewScale * 8));
      ctx.fillRect(a.x - size / 2, a.y - size / 2, size, size);
    }

    // ---- buildings ----
    for (const b of buildings.values()) {
      const tile = layout.tileSize || 32;
      const a = worldToScreen(b.tileX * tile, b.tileY * tile);
      const sw = Math.max(2, b.width * tile * viewScale);
      const sh = Math.max(2, b.height * tile * viewScale);
      ctx.fillStyle = buildingMinimapColor(b);
      ctx.fillRect(a.x, a.y, sw, sh);
    }

    // ---- corpses ----
    ctx.fillStyle = CORPSE_COLOR;
    for (const c of corpses.values()) {
      const a = worldToScreen(c.x, c.y);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- enemies ----
    for (const e of enemies.values()) {
      if (e.hp <= 0) continue;
      const visual = enemyVisualFor(e.kind);
      const a = worldToScreen(e.x, e.y);
      ctx.fillStyle = colorNumToHex(visual?.color ?? 0xef4444);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ---- projectiles ----
    ctx.fillStyle = PROJECTILE_COLOR;
    for (const p of projectiles.values()) {
      const a = worldToScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- other players ----
    for (const p of players.values()) {
      if (p.characterId === self.characterId) continue;
      const a = worldToScreen(p.x, p.y);
      ctx.fillStyle = p.alive ? OTHER_COLOR : DEAD_COLOR;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ---- self (drawn last so it's always on top) ----
    {
      const a = worldToScreen(self.x, self.y);
      ctx.fillStyle = self.alive ? SELF_COLOR : DEAD_COLOR;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ---- legend ----
    drawLegend(ctx, w, h);
  }

  function drawInteractable(
    ctx: CanvasRenderingContext2D,
    ix: Interactable,
  ): void {
    const a = worldToScreen(ix.x, ix.y);
    const r = 7;
    ctx.fillStyle =
      ix.kind === 'stairs_down' ? STAIRS_COLOR : EXTRACT_COLOR;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Glyph: ↓ for stairs, ⌂ for extract.
    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ix.kind === 'stairs_down' ? '↓' : 'E', a.x, a.y + 0.5);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawLegend(
    ctx: CanvasRenderingContext2D,
    w: number,
    _h: number,
  ): void {
    const items: { color: string; label: string }[] = [
      { color: SELF_COLOR, label: 'you' },
      { color: OTHER_COLOR, label: 'players' },
      { color: '#ef4444', label: 'enemies' },
      { color: PROP_COLOR, label: 'props' },
      { color: EXTRACT_COLOR, label: 'extract' },
      { color: STAIRS_COLOR, label: 'stairs' },
    ];
    const padX = 8;
    const padY = 8;
    const rowH = 12;
    const boxW = 96;
    const boxH = padY * 2 + items.length * rowH;
    const x0 = w - boxW - padX;
    const y0 = padY;
    ctx.fillStyle = 'rgba(10, 12, 18, 0.7)';
    ctx.fillRect(x0, y0, boxW, boxH);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, boxW - 1, boxH - 1);
    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const y = y0 + padY + i * rowH + rowH / 2;
      ctx.fillStyle = it.color;
      ctx.fillRect(x0 + 8, y - 4, 8, 8);
      ctx.fillStyle = '#d4d4d8';
      ctx.fillText(it.label, x0 + 22, y + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function decodeForLayout(l: SceneLayout | null): Uint8Array | null {
    if (!l?.tileGrid) return null;
    return decodeTileGrid(l.tileGrid);
  }

  function colorNumToHex(n: number): string {
    return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  }

  // Resize observer to refit on host size changes.
  const ro = new ResizeObserver(() => {
    fitCanvasToHost();
    recomputeFit();
    requestRepaint();
  });
  ro.observe(host);

  // Initial paint.
  fitCanvasToHost();
  recomputeFit();
  requestRepaint();

  // ---------- GameHandle methods ----------
  // Each mutator pokes the relevant Map and schedules a repaint.
  // Methods that don't surface anything in this view (weapon swing
  // animation, build ghost) are no-ops so the handle contract is
  // honoured without doing visual work the topdown can't show.
  const handle: GameHandle = {
    upsertPlayer: (p: Player) => {
      players.set(p.characterId, p);
      if (p.characterId === self.characterId) self = p;
      requestRepaint();
    },
    removePlayer: (characterId) => {
      players.delete(characterId);
      requestRepaint();
    },
    movePlayer: (characterId, x, y) => {
      const p = players.get(characterId);
      if (!p) return;
      p.x = x;
      p.y = y;
      if (characterId === self.characterId) {
        self.x = x;
        self.y = y;
      }
      requestRepaint();
    },
    setPlayerHp: (characterId, hp, maxHp, shield, maxShield) => {
      const p = players.get(characterId);
      if (!p) return;
      p.hp = hp;
      p.maxHp = maxHp;
      if (shield !== undefined) p.shield = shield;
      if (maxShield !== undefined) p.maxShield = maxShield;
      // No HP bar in topdown — but state stays accurate.
    },
    setPlayerDead: (characterId) => {
      const p = players.get(characterId);
      if (!p) return;
      p.alive = false;
      requestRepaint();
    },
    respawnPlayer: (characterId, x, y, hp, maxHp) => {
      const p = players.get(characterId);
      if (!p) return;
      p.alive = true;
      p.x = x;
      p.y = y;
      p.hp = hp;
      p.maxHp = maxHp;
      if (characterId === self.characterId) {
        self.x = x;
        self.y = y;
        self.alive = true;
      }
      requestRepaint();
    },
    showWeaponSwung: () => {
      /* no swing visual in topdown */
    },
    upsertEnemy: (e) => {
      enemies.set(e.id, e);
      requestRepaint();
    },
    setEnemyPosition: (id, x, y) => {
      const e = enemies.get(id);
      if (!e) return;
      e.x = x;
      e.y = y;
      requestRepaint();
    },
    setEnemyHp: (id, hp, maxHp) => {
      const e = enemies.get(id);
      if (!e) return;
      e.hp = hp;
      e.maxHp = maxHp;
      if (hp <= 0) requestRepaint();
    },
    removeEnemy: (id) => {
      enemies.delete(id);
      requestRepaint();
    },
    spawnProjectile: (p) => {
      projectiles.set(p.id, p);
      requestRepaint();
    },
    despawnProjectile: (id) => {
      projectiles.delete(id);
      requestRepaint();
    },
    spawnLoot: (l) => {
      loot.set(l.id, l);
    },
    despawnLoot: (id) => {
      loot.delete(id);
    },
    spawnCorpse: (c) => {
      corpses.set(c.id, c);
      requestRepaint();
    },
    removeCorpse: (id) => {
      corpses.delete(id);
      requestRepaint();
    },
    spawnBuilding: (b) => {
      buildings.set(b.id, b);
      requestRepaint();
    },
    setBuildingHp: (id, hp, maxHp) => {
      const b = buildings.get(id);
      if (!b) return;
      b.hp = hp;
      b.maxHp = maxHp;
    },
    removeBuilding: (id) => {
      buildings.delete(id);
      requestRepaint();
    },
    spawnProp: (p) => {
      props.set(p.id, p);
      requestRepaint();
    },
    setPropHp: (id, hp, maxHp) => {
      const p = props.get(id);
      if (!p) return;
      p.hp = hp;
      p.maxHp = maxHp;
    },
    removeProp: (id) => {
      props.delete(id);
      requestRepaint();
    },
    changeProp: (p) => {
      props.set(p.id, p);
      requestRepaint();
    },
    setBuildMode: () => {
      /* no build mode in topdown */
    },
    setBuildRadiusBonus: () => {
      /* unused */
    },
    setEquippedWeapon: () => {
      /* no fire input in topdown */
    },
    setHordeActive: () => {
      /* topdown has no sky */
    },
    notifyReloadStarted: () => {
      /* topdown has no view-model */
    },
    swapScene: (state: SceneState) => {
      players.clear();
      for (const p of state.players) players.set(p.characterId, p);
      self = { ...state.self };
      players.set(self.characterId, self);
      enemies.clear();
      for (const e of state.enemies) enemies.set(e.id, e);
      projectiles.clear();
      for (const p of state.projectiles) projectiles.set(p.id, p);
      loot.clear();
      for (const l of state.loot) loot.set(l.id, l);
      corpses.clear();
      for (const c of state.corpses) corpses.set(c.id, c);
      buildings.clear();
      for (const b of state.buildings) buildings.set(b.id, b);
      props.clear();
      for (const p of state.props) props.set(p.id, p);
      layout = state.layout;
      decodedTiles = decodeForLayout(layout);
      // New floor → recentre.
      panX = 0;
      panY = 0;
      recomputeFit();
      requestRepaint();
    },
    currentSceneState: (): SceneState => ({
      self,
      players: [...players.values()].filter(
        (p) => p.characterId !== self.characterId,
      ),
      enemies: [...enemies.values()],
      projectiles: [...projectiles.values()],
      loot: [...loot.values()],
      corpses: [...corpses.values()],
      buildings: [...buildings.values()],
      props: [...props.values()],
      layout,
    }),
    nearbyPlayers: () => [],
    getMinimapSnapshot: (): MinimapSnapshot => ({
      selfX: self.x,
      selfY: self.y,
      selfId: self.characterId,
      tileSize: layout?.tileSize ?? 32,
      walkables: layout?.walkables ?? [],
      rooms: layout?.rooms,
      roomCategories: layout?.roomCategories,
      buildings: [...buildings.values()].map((b) => ({
        tileX: b.tileX,
        tileY: b.tileY,
        width: b.width,
        height: b.height,
        kind: b.kind,
      })),
      players: [...players.values()].map((p) => ({
        characterId: p.characterId,
        x: p.x,
        y: p.y,
        visible: true,
      })),
      enemies: [...enemies.values()].map((e) => ({
        x: e.x,
        y: e.y,
        hp: e.hp,
        visible: true,
      })),
    }),
    getSelfPosition: () => ({ x: self.x, y: self.y }),
    destroy: () => {
      destroyed = true;
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDoubleClick);
      ro.disconnect();
      if (canvas.parentElement === host) host.removeChild(canvas);
    },
  };

  return handle;
}

