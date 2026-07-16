// Sprite editor engine — the pure model behind the MCP sprite
// editor. Sprites are palette-indexed pixel grids in 16px-tile
// units; frames are stored as rows of single characters so the
// whole document is human-readable JSON and the row encoding used
// by set_rows IS the storage format.
//
// Char encoding per pixel:
//   '.'        transparent
//   '0'-'9'    palette index 0-9
//   'a'-'y'    palette index 10-34
//
// The editing LLM works these ops through MCP tools; render()
// produces a nearest-neighbor upscaled PNG it can actually look at
// (with tile-boundary guides), renderNative() produces the 1:1 PNG
// the game consumes.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

export const TILE_PX = 16;
export const MAX_TILES = 16;
export const MAX_PALETTE = 35;

export type SpriteDoc = {
  id: string;
  tilesW: number;
  tilesH: number;
  // Hex colors ('#rrggbb'). Pixel chars index into this.
  palette: string[];
  // frameName -> rows (tilesH*16 strings of tilesW*16 chars).
  frames: Record<string, string[]>;
};

export function charToIndex(ch: string): number | null {
  if (ch === '.') return null;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'a' && ch <= 'y') return ch.charCodeAt(0) - 97 + 10;
  throw new Error(`invalid pixel char '${ch}' (use . 0-9 a-y)`);
}

export function indexToChar(idx: number | null): string {
  if (idx === null) return '.';
  if (idx < 10) return String.fromCharCode(48 + idx);
  return String.fromCharCode(97 + idx - 10);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`invalid palette color '${hex}' (want #rrggbb)`);
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

export function spriteWidth(doc: SpriteDoc): number {
  return doc.tilesW * TILE_PX;
}
export function spriteHeight(doc: SpriteDoc): number {
  return doc.tilesH * TILE_PX;
}

export function createSprite(
  id: string,
  tilesW: number,
  tilesH: number,
  palette: string[],
): SpriteDoc {
  if (!/^[a-zA-Z0-9_\-:]+$/.test(id)) throw new Error(`invalid sprite id '${id}'`);
  if (
    !Number.isInteger(tilesW) || !Number.isInteger(tilesH) ||
    tilesW < 1 || tilesH < 1 || tilesW > MAX_TILES || tilesH > MAX_TILES
  ) {
    throw new Error(`tiles must be integers 1-${MAX_TILES}`);
  }
  if (palette.length < 1 || palette.length > MAX_PALETTE) {
    throw new Error(`palette needs 1-${MAX_PALETTE} colors`);
  }
  palette.forEach(parseHex);
  const w = tilesW * TILE_PX;
  const h = tilesH * TILE_PX;
  const blank = '.'.repeat(w);
  return {
    id,
    tilesW,
    tilesH,
    palette: [...palette],
    frames: { 'idle/0': Array.from({ length: h }, () => blank) },
  };
}

function frameOf(doc: SpriteDoc, frame: string): string[] {
  const f = doc.frames[frame];
  if (!f) {
    throw new Error(
      `no frame '${frame}' (have: ${Object.keys(doc.frames).join(', ')})`,
    );
  }
  return f;
}

function validateRow(doc: SpriteDoc, row: string): void {
  const w = spriteWidth(doc);
  if (row.length !== w) {
    throw new Error(`row must be exactly ${w} chars, got ${row.length}`);
  }
  for (const ch of row) {
    const idx = charToIndex(ch);
    if (idx !== null && idx >= doc.palette.length) {
      throw new Error(
        `pixel char '${ch}' indexes past palette (size ${doc.palette.length})`,
      );
    }
  }
}

export function setRows(
  doc: SpriteDoc,
  frame: string,
  y0: number,
  rows: string[],
): void {
  const f = frameOf(doc, frame);
  const h = spriteHeight(doc);
  if (y0 < 0 || y0 + rows.length > h) {
    throw new Error(`rows [${y0}, ${y0 + rows.length}) outside height ${h}`);
  }
  for (const row of rows) validateRow(doc, row);
  for (let i = 0; i < rows.length; i++) f[y0 + i] = rows[i];
}

function setPixel(
  doc: SpriteDoc,
  f: string[],
  x: number,
  y: number,
  ch: string,
): void {
  if (x < 0 || y < 0 || x >= spriteWidth(doc) || y >= spriteHeight(doc)) return;
  f[y] = f[y].slice(0, x) + ch + f[y].slice(x + 1);
}

function checkChar(doc: SpriteDoc, ch: string): void {
  if (ch.length !== 1) throw new Error(`char must be 1 character`);
  const idx = charToIndex(ch);
  if (idx !== null && idx >= doc.palette.length) {
    throw new Error(`char '${ch}' indexes past palette`);
  }
}

export function drawRect(
  doc: SpriteDoc,
  frame: string,
  x: number,
  y: number,
  w: number,
  h: number,
  ch: string,
  fill: boolean,
): void {
  const f = frameOf(doc, frame);
  checkChar(doc, ch);
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (fill || yy === y || yy === y + h - 1 || xx === x || xx === x + w - 1) {
        setPixel(doc, f, xx, yy, ch);
      }
    }
  }
}

export function drawLine(
  doc: SpriteDoc,
  frame: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ch: string,
): void {
  const f = frameOf(doc, frame);
  checkChar(doc, ch);
  // Bresenham.
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    setPixel(doc, f, x, y, ch);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

export function floodFill(
  doc: SpriteDoc,
  frame: string,
  x: number,
  y: number,
  ch: string,
): void {
  const f = frameOf(doc, frame);
  checkChar(doc, ch);
  const w = spriteWidth(doc);
  const h = spriteHeight(doc);
  if (x < 0 || y < 0 || x >= w || y >= h) throw new Error('seed out of bounds');
  const target = f[y][x];
  if (target === ch) return;
  const stack: Array<[number, number]> = [[x, y]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    if (f[cy][cx] !== target) continue;
    setPixel(doc, f, cx, cy, ch);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

// Copy one half onto the other, mirrored. Most sprites are
// symmetric — draw the left half, mirror it.
export function mirrorX(
  doc: SpriteDoc,
  frame: string,
  from: 'left' | 'right',
): void {
  const f = frameOf(doc, frame);
  const w = spriteWidth(doc);
  for (let y = 0; y < f.length; y++) {
    const row = f[y].split('');
    for (let x = 0; x < Math.floor(w / 2); x++) {
      if (from === 'left') row[w - 1 - x] = row[x];
      else row[x] = row[w - 1 - x];
    }
    f[y] = row.join('');
  }
}

export function cloneFrame(doc: SpriteDoc, from: string, to: string): void {
  const f = frameOf(doc, from);
  doc.frames[to] = [...f];
}

export function deleteFrame(doc: SpriteDoc, frame: string): void {
  frameOf(doc, frame);
  if (Object.keys(doc.frames).length === 1) {
    throw new Error('cannot delete the last frame');
  }
  delete doc.frames[frame];
}

export function shiftFrame(
  doc: SpriteDoc,
  frame: string,
  dx: number,
  dy: number,
): void {
  const f = frameOf(doc, frame);
  const w = spriteWidth(doc);
  const h = spriteHeight(doc);
  const blankRow = '.'.repeat(w);
  const src = [...f];
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) {
      f[y] = blankRow;
      continue;
    }
    let row = src[sy];
    if (dx > 0) row = '.'.repeat(dx) + row.slice(0, w - dx);
    else if (dx < 0) row = row.slice(-dx) + '.'.repeat(-dx);
    f[y] = row;
  }
}

// ---- rendering ----

function rasterize(doc: SpriteDoc, frame: string): Buffer {
  const f = frameOf(doc, frame);
  const w = spriteWidth(doc);
  const h = spriteHeight(doc);
  const buf = Buffer.alloc(w * h * 4);
  const rgb = doc.palette.map(parseHex);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = charToIndex(f[y][x]);
      if (idx === null) continue;
      const c = rgb[idx];
      const o = (y * w + x) * 4;
      buf[o] = c.r;
      buf[o + 1] = c.g;
      buf[o + 2] = c.b;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

// 1:1 PNG — what the game consumes.
export async function renderNative(
  doc: SpriteDoc,
  frame: string,
): Promise<Buffer> {
  const w = spriteWidth(doc);
  const h = spriteHeight(doc);
  return sharp(rasterize(doc, frame), {
    raw: { width: w, height: h, channels: 4 },
  })
    .png()
    .toBuffer();
}

export type RenderOptions = {
  frames?: string[];
  scale?: number;
  // Overlay this frame under each rendered frame at low alpha
  // (onion skin) — for animating against a base pose.
  onionFrame?: string;
  // Draw guides at tile boundaries.
  grid?: boolean;
};

// Review render: frames side by side on a dark checker background,
// nearest-neighbor upscaled, tile guides. This is what the editing
// LLM looks at between ops.
export async function renderReview(
  doc: SpriteDoc,
  opts: RenderOptions = {},
): Promise<Buffer> {
  const frameNames = opts.frames ?? Object.keys(doc.frames);
  for (const fr of frameNames) frameOf(doc, fr);
  const w = spriteWidth(doc);
  const h = spriteHeight(doc);
  // Keep the review image comfortably under ~1400px wide.
  const scale =
    opts.scale ??
    Math.max(2, Math.min(12, Math.floor(1400 / (frameNames.length * (w + 2)))));
  const gap = 2;
  const outW = frameNames.length * (w + gap) - gap;
  const outH = h;
  const px = Buffer.alloc(outW * outH * 4);

  // Checkerboard backdrop (dark, 4px squares) so transparency reads.
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const o = (y * outW + x) * 4;
      const dark = ((x >> 2) + (y >> 2)) % 2 === 0;
      px[o] = dark ? 0x16 : 0x1e;
      px[o + 1] = dark ? 0x18 : 0x21;
      px[o + 2] = dark ? 0x1c : 0x27;
      px[o + 3] = 255;
    }
  }

  const rgb = doc.palette.map(parseHex);
  const blit = (
    frame: string,
    xOff: number,
    alpha: number,
  ): void => {
    const f = doc.frames[frame];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = charToIndex(f[y][x]);
        if (idx === null) continue;
        const c = rgb[idx];
        const o = (y * outW + xOff + x) * 4;
        px[o] = Math.round(c.r * alpha + px[o] * (1 - alpha));
        px[o + 1] = Math.round(c.g * alpha + px[o + 1] * (1 - alpha));
        px[o + 2] = Math.round(c.b * alpha + px[o + 2] * (1 - alpha));
        px[o + 3] = 255;
      }
    }
  };

  frameNames.forEach((frame, i) => {
    const xOff = i * (w + gap);
    if (opts.onionFrame && opts.onionFrame !== frame) {
      blit(opts.onionFrame, xOff, 0.35);
    }
    blit(frame, xOff, 1);
  });

  let img = sharp(px, { raw: { width: outW, height: outH, channels: 4 } })
    .resize(outW * scale, outH * scale, { kernel: 'nearest' });

  if (opts.grid !== false) {
    // Tile guides as a translucent SVG overlay.
    const lines: string[] = [];
    for (let i = 0; i < frameNames.length; i++) {
      const xOff = i * (w + gap) * scale;
      for (let tx = 0; tx <= doc.tilesW; tx++) {
        const x = xOff + tx * TILE_PX * scale;
        lines.push(
          `<line x1="${x}" y1="0" x2="${x}" y2="${outH * scale}" stroke="#f97316" stroke-opacity="0.25" stroke-width="1"/>`,
        );
      }
    }
    for (let ty = 0; ty <= doc.tilesH; ty++) {
      const y = ty * TILE_PX * scale;
      lines.push(
        `<line x1="0" y1="${y}" x2="${outW * scale}" y2="${y}" stroke="#f97316" stroke-opacity="0.25" stroke-width="1"/>`,
      );
    }
    const svg = `<svg width="${outW * scale}" height="${outH * scale}" xmlns="http://www.w3.org/2000/svg">${lines.join('')}</svg>`;
    img = img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  }

  return img.png().toBuffer();
}

// ---- persistence ----

export class SpriteStore {
  constructor(private readonly dir: string) {}

  private pathOf(id: string): string {
    return join(this.dir, `${id.replaceAll(':', '__')}.json`);
  }

  async save(doc: SpriteDoc): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathOf(doc.id), `${JSON.stringify(doc, null, 1)}\n`);
  }

  async load(id: string): Promise<SpriteDoc | null> {
    try {
      return JSON.parse(await readFile(this.pathOf(id), 'utf8')) as SpriteDoc;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5).replaceAll('__', ':'));
    } catch {
      return [];
    }
  }
}
