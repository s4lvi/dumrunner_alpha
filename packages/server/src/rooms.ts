// Server-side room template registry. Loaded from
// packages/shared/content/rooms/<id>.json at boot. Procgen picks
// templates from the per-biome pool and stamps their tile grids
// into each floor's TileGrid; anchors carry spawn directives the
// server resolves into enemies / props / loot / interactables.
//
// Empty pool → procgen falls back to its rect-based room stamping.
// Each biome migrates to the template pipeline independently.

import { loadRooms } from '@dumrunner/shared/content/loader';
import type {
  RoomEdge,
  RoomRole,
  RoomTemplate,
  TileGrid,
} from '@dumrunner/shared';

export const ROOMS: Record<string, RoomTemplate> = {};

export async function initRooms(): Promise<void> {
  const defs = await loadRooms();
  for (const k of Object.keys(ROOMS)) delete ROOMS[k];
  for (const def of defs) ROOMS[def.id] = def;
  if (defs.length === 0) {
    console.warn(
      '[rooms] no room templates authored; procgen falls back to rect rooms',
    );
  } else {
    console.log(
      `[rooms] loaded ${defs.length} templates: ${defs.map((d: RoomTemplate) => d.id).join(', ')}`,
    );
  }
}

// Filter the pool down to templates that fit the slot. A template
// "fits" when:
//   - the floor's biome id is in template.biomeAffinity
//   - the template's bounding box fits inside the slot (templates
//     can be smaller than the slot; the surplus tiles stay void
//     until corridors fill them in)
//   - the template's entrySides covers every side the slot needs
//     to connect on
//   - the role policy matches:
//       * slot role 'normal'  → only 'normal' templates
//       * slot role 'safe'    → 'safe' templates preferred; falls
//         through to 'normal' if no 'safe' authored
//       * slot role 'extreme' → 'extreme' templates preferred; falls
//         through to 'normal' if no 'extreme' authored
//       * slot role 'boss'/'vault' → strict, only that role
//     'normal' is the universal default pool — special roles
//     override it for their specific slot type when authored.
export function eligibleTemplates(
  biome: string,
  role: RoomRole,
  slotW: number,
  slotH: number,
  requiredEntries: RoomEdge[],
): RoomTemplate[] {
  // Two-pass: first collect role-specific matches, then 'normal'
  // fallbacks. Caller picks from the first non-empty pass so a
  // 'safe' slot prefers an authored 'safe' template over a generic
  // 'normal' one but still gets *something* if no 'safe' template
  // exists.
  const specific: RoomTemplate[] = [];
  const fallback: RoomTemplate[] = [];
  for (const id of Object.keys(ROOMS).sort()) {
    const t = ROOMS[id];
    if (!t.biomeAffinity.includes(biome)) continue;
    if (t.width > slotW || t.height > slotH) continue;
    let entriesOk = true;
    for (const edge of requiredEntries) {
      if (!t.entrySides.includes(edge)) {
        entriesOk = false;
        break;
      }
    }
    if (!entriesOk) continue;
    if (t.role === role) {
      specific.push(t);
    } else if (
      t.role === 'normal' &&
      (role === 'safe' || role === 'extreme')
    ) {
      fallback.push(t);
    }
  }
  return specific.length > 0 ? specific : fallback;
}

// Weighted pick from an eligible list. RNG is the procgen mulberry32
// shared across all room slots on the floor — same (worldSeed,
// cycle, floorIndex) input always produces the same selection.
export function pickTemplate(
  candidates: RoomTemplate[],
  rng: () => number,
): RoomTemplate | null {
  if (candidates.length === 0) return null;
  const total = candidates.reduce((s, t) => s + t.weight, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const t of candidates) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return candidates[candidates.length - 1];
}

// Decode a template's base64 tile array. Cached per template so
// repeated stamps don't re-allocate.
const TEMPLATE_TILES_CACHE = new Map<string, Uint8Array>();
export function templateTiles(template: RoomTemplate): Uint8Array {
  const cached = TEMPLATE_TILES_CACHE.get(template.id);
  if (cached) return cached;
  const tiles = Uint8Array.from(Buffer.from(template.tilesB64, 'base64'));
  if (tiles.length !== template.width * template.height) {
    throw new Error(
      `[rooms] template ${template.id} tile array length ${tiles.length} ≠ width*height ${template.width * template.height}`,
    );
  }
  TEMPLATE_TILES_CACHE.set(template.id, tiles);
  return tiles;
}

// Stamp a template's tile bytes into the target floor grid at the
// given origin tile coords (relative to the grid's top-left).
// Cells with id 0 in the template are treated as "transparent" and
// don't overwrite the target — lets templates omit their boundary
// rows for clean stitching against corridors.
export function stampTemplate(
  grid: TileGrid,
  gridTiles: Uint8Array,
  template: RoomTemplate,
  // Tile coords in grid-space (NOT world-space) where the template's
  // (0,0) cell lands. Caller pre-translates from world-space to
  // grid-space using grid.originTileX / originTileY.
  originGridX: number,
  originGridY: number,
): void {
  const src = templateTiles(template);
  for (let ty = 0; ty < template.height; ty++) {
    const dy = originGridY + ty;
    if (dy < 0 || dy >= grid.height) continue;
    for (let tx = 0; tx < template.width; tx++) {
      const id = src[ty * template.width + tx];
      if (id === 0) continue;
      const dx = originGridX + tx;
      if (dx < 0 || dx >= grid.width) continue;
      gridTiles[dy * grid.width + dx] = id;
    }
  }
}
