// Pure helpers for working with RoomTemplate data — eligibility
// filtering, weighted picking, tile-array decode, stamping into a
// TileGrid. No registry state; callers pass in the templates they
// want to consider. Lifted out of the server-side rooms.ts so the
// shared procgen pipeline and the editor's procgen preview both
// reach the same logic.

import type { RoomRole, RoomTemplate } from './content/types';
import type { TileGrid } from './protocol';

// Filter the pool down to templates that fit the slot. A template
// "fits" when:
//   - the floor's biome id is in template.biomeAffinity
//   - the template's bounding box fits inside the slot
//   - the role policy matches:
//       * slot role 'normal'  → only 'normal' templates
//       * slot role 'safe'    → 'safe' templates preferred; falls
//         through to 'normal' if no 'safe' authored
//       * slot role 'extreme' → 'extreme' templates preferred; falls
//         through to 'normal' if no 'extreme' authored
//       * slot role 'boss'/'vault' → strict, only that role
export function eligibleTemplates(
  templates: ReadonlyArray<RoomTemplate>,
  biome: string,
  role: RoomRole,
  slotW: number,
  slotH: number,
): RoomTemplate[] {
  const specific: RoomTemplate[] = [];
  const fallback: RoomTemplate[] = [];
  for (const t of templates) {
    if (!t.biomeAffinity.includes(biome)) continue;
    if (t.width > slotW || t.height > slotH) continue;
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

// Weighted pick. Same deterministic rng as the rest of procgen.
export function pickTemplate(
  candidates: ReadonlyArray<RoomTemplate>,
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

const TEMPLATE_TILES_CACHE = new Map<string, Uint8Array>();
export function templateTiles(template: RoomTemplate): Uint8Array {
  const cached = TEMPLATE_TILES_CACHE.get(template.id);
  if (cached) return cached;
  const tiles = decodeBase64ToBytes(template.tilesB64);
  if (tiles.length !== template.width * template.height) {
    throw new Error(
      `[rooms] template ${template.id} tile array length ${tiles.length} ≠ width*height ${template.width * template.height}`,
    );
  }
  TEMPLATE_TILES_CACHE.set(template.id, tiles);
  return tiles;
}

// Stamp a template's tile bytes into the target floor grid at the
// given grid-space origin (caller pre-translates world → grid).
// Cells with id 0 in the template are treated as "transparent".
export function stampTemplate(
  grid: TileGrid,
  gridTiles: Uint8Array,
  template: RoomTemplate,
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

function decodeBase64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (globalThis as any).atob(b64) as string;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
