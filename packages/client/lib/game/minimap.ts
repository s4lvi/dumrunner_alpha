import {
  isWalkableTileId,
  type BuildingKind,
  type BuildingState,
  type HazardZoneCategory,
  type Rect,
  type TileGrid,
} from '@dumrunner/shared';

// Renderer-agnostic minimap snapshot. Each renderer assembles
// one of these from its current world state; the React Minimap
// component paints it. Visibility flags come from the renderer
// because LOS / fog state is renderer-internal.
export type MinimapSnapshot = {
  selfX: number;
  selfY: number;
  // Player heading in radians (0 = +X, π/2 = +Y). Optional —
  // top-down 2D renderers without a facing direction can omit it
  // and the minimap will skip drawing the heading line.
  selfYaw?: number;
  selfId: string;
  tileSize: number;
  walkables: Rect[];
  // Per-cell rendering source. When present, the painter walks the
  // grid and draws a rect per walkable+seen cell — corridors carved
  // by the tunneler show up faithfully. Falls back to walkables[]
  // rects when omitted (legacy / non-grid layouts).
  tileGrid?: TileGrid;
  // Decoded tile ids parallel to tileGrid (row-major, len = w*h).
  tiles?: Uint8Array;
  // Per-cell seen bitmap (len = w*h). Nonzero = revealed. The
  // minimap hides unseen cells; if omitted, every walkable cell
  // is treated as seen.
  seen?: Uint8Array;
  // Per-room hazard zone category (parallel to layout.rooms; the
  // first N entries of walkables are the rooms). Optional so the
  // surface scene's empty layout can omit it. When present, the
  // minimap tints rooms by category — green for safe, red for
  // extreme — so players can see where the breather pockets are.
  rooms?: Rect[];
  roomCategories?: HazardZoneCategory[];
  buildings: ReadonlyArray<{
    tileX: number;
    tileY: number;
    width: number;
    height: number;
    kind: BuildingKind;
  }>;
  players: ReadonlyArray<{
    characterId: string;
    x: number;
    y: number;
    visible: boolean;
  }>;
  enemies: ReadonlyArray<{
    x: number;
    y: number;
    hp: number;
    visible: boolean;
  }>;
};

// ---- Fog persistence -------------------------------------------------
// Explored-tile (fog-of-war) state survives a client refresh by
// living in localStorage, one key per (serverId, sceneId). The
// payload is a bit-packed copy of the renderer's seen[] bitmap
// (1 bit/cell, base64) plus enough metadata to invalidate stale
// saves: grid dimensions, the world cycle the save belongs to,
// and the layout's variantSeed (which the server derives from
// (worldSeed, cycle, floorIndex), so a regenerated floor never
// matches a stale save even before the cycle number is known).

const FOG_KEY_PREFIX = 'dr:fog:';

function fogKey(serverId: string, sceneId: string): string {
  return `${FOG_KEY_PREFIX}${serverId}:${sceneId}`;
}

type StoredFog = {
  // World cycle the save was taken in. null when the save landed
  // before the first world_clock broadcast of the session.
  cycle: number | null;
  w: number;
  h: number;
  // layout.variantSeed at save time; undefined when the layout
  // didn't carry one.
  seed?: number;
  // Bit-packed seen[] (8 cells/byte, row-major), base64.
  bits: string;
};

// Pack the 1-byte-per-cell seen bitmap into 1 bit per cell and
// base64 it. ~40k cells → ~6.7 KB of text, well under quota.
function packSeenBits(seen: Uint8Array): string {
  const packed = new Uint8Array(Math.ceil(seen.length / 8));
  for (let i = 0; i < seen.length; i++) {
    if (seen[i]) packed[i >> 3] |= 1 << (i & 7);
  }
  // Chunked fromCharCode — a single spread overflows the arg
  // limit on large grids.
  let bin = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < packed.length; i += CHUNK) {
    bin += String.fromCharCode(...packed.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function unpackSeenBits(bits: string, cellCount: number): Uint8Array | null {
  let bin: string;
  try {
    bin = atob(bits);
  } catch {
    return null;
  }
  if (bin.length !== Math.ceil(cellCount / 8)) return null;
  const seen = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    if (bin.charCodeAt(i >> 3) & (1 << (i & 7))) seen[i] = 1;
  }
  return seen;
}

// Persist the current seen[] bitmap. Best-effort — storage may be
// unavailable (SSR, private mode quota) and fog is a nicety, not
// game state.
export function saveFogState(
  serverId: string,
  sceneId: string,
  seen: Uint8Array,
  w: number,
  h: number,
  cycle: number | null,
  variantSeed?: number,
): void {
  if (typeof window === 'undefined') return;
  if (seen.length !== w * h) return;
  const rec: StoredFog = {
    cycle,
    w,
    h,
    seed: variantSeed,
    bits: packSeenBits(seen),
  };
  try {
    window.localStorage.setItem(fogKey(serverId, sceneId), JSON.stringify(rec));
  } catch {
    /* quota / disabled storage — skip */
  }
}

// Restore a previously-saved bitmap. Returns null (and drops the
// stale key) when dimensions, cycle, or variantSeed disagree with
// the live layout. A null `cycle` on either side skips the cycle
// check — the seed check still catches regenerated floors. The
// record's stored cycle rides along so the caller can re-check
// once the live cycle number arrives.
export function loadFogState(
  serverId: string,
  sceneId: string,
  w: number,
  h: number,
  cycle: number | null,
  variantSeed?: number,
): { seen: Uint8Array; cycle: number | null } | null {
  if (typeof window === 'undefined') return null;
  const key = fogKey(serverId, sceneId);
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let rec: StoredFog | null = null;
  try {
    rec = JSON.parse(raw) as StoredFog;
  } catch {
    rec = null;
  }
  const drop = (): null => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return null;
  };
  if (!rec || typeof rec.bits !== 'string') return drop();
  if (rec.w !== w || rec.h !== h) return drop();
  if (rec.cycle !== null && cycle !== null && rec.cycle !== cycle) {
    return drop();
  }
  if (
    rec.seed !== undefined &&
    variantSeed !== undefined &&
    rec.seed !== variantSeed
  ) {
    return drop();
  }
  const seen = unpackSeenBits(rec.bits, w * h);
  if (!seen) return drop();
  return { seen, cycle: rec.cycle ?? null };
}

// Drop every saved fog key for this server whose recorded cycle
// differs from the current one. Called when the cycle number first
// arrives / bumps so old-cycle exploration doesn't accumulate.
export function pruneFogStateForCycle(serverId: string, cycle: number): void {
  if (typeof window === 'undefined') return;
  const prefix = `${FOG_KEY_PREFIX}${serverId}:`;
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      try {
        const rec = JSON.parse(
          window.localStorage.getItem(key) ?? 'null',
        ) as StoredFog | null;
        if (!rec || (rec.cycle !== null && rec.cycle !== cycle)) {
          stale.push(key);
        }
      } catch {
        stale.push(key);
      }
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

// Per-zone tint used on the minimap. Subtle; the room outline
// (default fillStyle) reads through where alpha is low.
const ZONE_TINT: Record<HazardZoneCategory, string> = {
  safe: 'rgba(34, 197, 94, 0.35)',     // green
  corridor: 'rgba(82, 82, 91, 0.45)',  // matches the default
  hazard: 'rgba(82, 82, 91, 0.45)',    // default look
  extreme: 'rgba(239, 68, 68, 0.40)',  // red
};

export function buildingMinimapColor(b: { kind: BuildingKind }): string {
  return b.kind === 'power_link'
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
}

// Paints the minimap into the given canvas using a renderer-supplied
// snapshot. Same look as the previous in-renderer paintMinimap
// implementations, lifted here so each renderer doesn't carry its
// own copy.
export function paintMinimap(
  canvas: HTMLCanvasElement,
  worldRadius: number,
  snap: MinimapSnapshot,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w, h) / (worldRadius * 6);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(10, 12, 18, 0.85)';
  ctx.fillRect(0, 0, w, h);

  // Per-cell painter takes priority — corridors carved into the
  // tile grid show up at full fidelity. Fog of war respects the
  // seen[] bitmap; without it every walkable cell is drawn.
  if (snap.tileGrid && snap.tiles) {
    const tg = snap.tileGrid;
    const ts = tg.tileSize;
    const ox = tg.originTileX * ts;
    const oy = tg.originTileY * ts;
    const sx = ts * scale;
    const sy = ts * scale;
    const tiles = snap.tiles;
    const seen = snap.seen;
    ctx.fillStyle = 'rgba(82, 82, 91, 0.55)';
    for (let cyIdx = 0; cyIdx < tg.height; cyIdx++) {
      for (let cxIdx = 0; cxIdx < tg.width; cxIdx++) {
        const i = cyIdx * tg.width + cxIdx;
        if (seen && !seen[i]) continue;
        if (!isWalkableTileId(tiles[i])) continue;
        const x = (ox + cxIdx * ts - snap.selfX) * scale + cx;
        const y = (oy + cyIdx * ts - snap.selfY) * scale + cy;
        ctx.fillRect(x, y, sx + 0.5, sy + 0.5);
      }
    }
    // Room category tint over the cell paint. Only seen rooms get
    // tinted (cell paint already gates on seen, so this is purely
    // additive and stays within the revealed area).
    if (snap.rooms && snap.roomCategories) {
      for (let i = 0; i < snap.rooms.length; i++) {
        const r = snap.rooms[i];
        const cat = snap.roomCategories[i] ?? 'hazard';
        if (cat === 'hazard' || cat === 'corridor') continue;
        ctx.fillStyle = ZONE_TINT[cat];
        const x = (r.x - snap.selfX) * scale + cx;
        const y = (r.y - snap.selfY) * scale + cy;
        ctx.fillRect(x, y, r.w * scale, r.h * scale);
      }
    }
  } else if (snap.walkables.length > 0) {
    ctx.fillStyle = 'rgba(82, 82, 91, 0.45)';
    for (const r of snap.walkables) {
      const x = (r.x - snap.selfX) * scale + cx;
      const y = (r.y - snap.selfY) * scale + cy;
      ctx.fillRect(x, y, r.w * scale, r.h * scale);
    }
    if (snap.rooms && snap.roomCategories) {
      for (let i = 0; i < snap.rooms.length; i++) {
        const r = snap.rooms[i];
        const cat = snap.roomCategories[i] ?? 'hazard';
        const tint = ZONE_TINT[cat];
        if (cat === 'hazard') continue;
        ctx.fillStyle = tint;
        const x = (r.x - snap.selfX) * scale + cx;
        const y = (r.y - snap.selfY) * scale + cy;
        ctx.fillRect(x, y, r.w * scale, r.h * scale);
      }
    }
  } else {
    ctx.fillStyle = 'rgba(82, 82, 91, 0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(w, h) / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
  }

  const tileSize = snap.tileSize || 32;
  // Fog test: returns true when the cell containing (worldX, worldY)
  // has been revealed. Without seen[]/tileGrid, every cell counts as
  // seen (legacy behaviour for the surface scene).
  const isSeenWorld = (worldX: number, worldY: number): boolean => {
    if (!snap.tileGrid || !snap.seen) return true;
    const tg = snap.tileGrid;
    const cellX = Math.floor(worldX / tg.tileSize) - tg.originTileX;
    const cellY = Math.floor(worldY / tg.tileSize) - tg.originTileY;
    if (cellX < 0 || cellY < 0 || cellX >= tg.width || cellY >= tg.height) {
      return false;
    }
    return snap.seen[cellY * tg.width + cellX] !== 0;
  };
  for (const b of snap.buildings) {
    // Building footprint touches the grid; treat any seen cell in
    // its rect as "seen". Player-built structures appear on the
    // minimap only after the player has stood near them.
    let anySeen = false;
    if (snap.tileGrid && snap.seen) {
      const tg = snap.tileGrid;
      outer: for (let dy = 0; dy < b.height; dy++) {
        for (let dx = 0; dx < b.width; dx++) {
          const cx2 = b.tileX + dx - tg.originTileX;
          const cy2 = b.tileY + dy - tg.originTileY;
          if (cx2 < 0 || cy2 < 0 || cx2 >= tg.width || cy2 >= tg.height) {
            continue;
          }
          if (snap.seen[cy2 * tg.width + cx2] !== 0) {
            anySeen = true;
            break outer;
          }
        }
      }
    } else {
      anySeen = true;
    }
    if (!anySeen) continue;
    const x = (b.tileX * tileSize - snap.selfX) * scale + cx;
    const y = (b.tileY * tileSize - snap.selfY) * scale + cy;
    const sw = Math.max(2, b.width * tileSize * scale);
    const sh = Math.max(2, b.height * tileSize * scale);
    ctx.fillStyle = buildingMinimapColor(b);
    ctx.fillRect(x, y, sw, sh);
  }

  for (const p of snap.players) {
    if (p.characterId === snap.selfId) continue;
    if (!p.visible) continue;
    if (!isSeenWorld(p.x, p.y)) continue;
    const x = (p.x - snap.selfX) * scale + cx;
    const y = (p.y - snap.selfY) * scale + cy;
    ctx.fillStyle = '#34d399';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const e of snap.enemies) {
    if (!e.visible || e.hp <= 0) continue;
    if (!isSeenWorld(e.x, e.y)) continue;
    const x = (e.x - snap.selfX) * scale + cx;
    const y = (e.y - snap.selfY) * scale + cy;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#fde047';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Heading line — points the way the player is facing. Drawn
  // after the blob so it sits on top. Length is fixed in pixels
  // (not world units) so it stays legible at every zoom level.
  if (typeof snap.selfYaw === 'number') {
    const HEADING_LEN_PX = 9;
    const hx = cx + Math.cos(snap.selfYaw) * HEADING_LEN_PX;
    const hy = cy + Math.sin(snap.selfYaw) * HEADING_LEN_PX;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

// Buildings' minimap-relevant fields. Each renderer uses this to
// stay narrowly typed without re-importing BuildingState.
export function buildingsToMinimapList(
  buildings: ReadonlyArray<BuildingState>,
): MinimapSnapshot['buildings'] {
  return buildings.map((b) => ({
    tileX: b.tileX,
    tileY: b.tileY,
    width: b.width,
    height: b.height,
    kind: b.kind,
  }));
}
