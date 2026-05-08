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
