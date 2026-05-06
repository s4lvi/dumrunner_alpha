import type {
  BuildingKind,
  BuildingState,
  HazardZoneCategory,
  Rect,
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

  if (snap.walkables.length > 0) {
    // Walkables = rooms ∪ corridors. We over-paint rooms with
    // category-tinted fills below, so corridors get the baseline
    // gray everyone's used to.
    ctx.fillStyle = 'rgba(82, 82, 91, 0.45)';
    for (const r of snap.walkables) {
      const x = (r.x - snap.selfX) * scale + cx;
      const y = (r.y - snap.selfY) * scale + cy;
      ctx.fillRect(x, y, r.w * scale, r.h * scale);
    }
    // Per-room category tint (E3.3). Skips corridors entirely;
    // skips when no roomCategories are set (surface, pre-E3.3).
    if (snap.rooms && snap.roomCategories) {
      for (let i = 0; i < snap.rooms.length; i++) {
        const r = snap.rooms[i];
        const cat = snap.roomCategories[i] ?? 'hazard';
        const tint = ZONE_TINT[cat];
        if (cat === 'hazard') continue; // baseline gray already shown
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
  for (const b of snap.buildings) {
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
    const x = (p.x - snap.selfX) * scale + cx;
    const y = (p.y - snap.selfY) * scale + cy;
    ctx.fillStyle = '#34d399';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const e of snap.enemies) {
    if (!e.visible || e.hp <= 0) continue;
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
