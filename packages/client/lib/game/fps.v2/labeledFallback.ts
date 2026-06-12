// Labeled fallback textures for the v2 renderer.
//
// Wherever the renderer would previously fall back to a flat
// colored fill / cube because no texture override exists for a
// (category, id) pair, it now renders a canvas-generated texture:
// the original fallback color as the background with the pair
// drawn on it (e.g. "enemy: chaser_melee") so a developer can see
// in-game exactly which texture is missing and what to upload in
// /editor/textures.
//
// Textures are generated lazily on first miss and cached forever
// (keyed `${category}:${id}:${color}`), so the per-frame cost
// after the first call is a Map lookup. The canvas is 128×128 —
// power-of-two so WebGL1 REPEAT addressing works for tiled
// surfaces (biome floors/walls/ceilings, building cube faces).

import { Texture } from 'pixi.js';

const SIZE = 128;

const cache = new Map<string, Texture>();

// Relative luminance (ITU-R BT.601) — picks dark text on light
// backgrounds and light text on dark ones.
function luminance(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function cssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

// Greedy word-wrap of the label into lines that fit maxWidth at
// the ctx's current font. Splits on '_', '-', and whitespace
// first; falls back to per-character breaking for long unbroken
// runs so nothing overflows the tile edge.
function wrapLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/(?<=[_\-\s])/);
  const lines: string[] = [];
  let line = '';
  const pushFitted = (word: string): void => {
    // Per-character fallback for a single word wider than the
    // tile (rare — very long ids).
    let chunk = '';
    for (const ch of word) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk.length > 0) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    line = chunk;
  };
  for (const word of words) {
    const candidate = line + word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else if (line.length > 0) {
      lines.push(line);
      if (ctx.measureText(word).width <= maxWidth) {
        line = word;
      } else {
        pushFitted(word);
      }
    } else {
      pushFitted(word);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

// Build (or fetch from cache) a labeled fallback texture for a
// missing (category, id) override. `color` is the 0xrrggbb fill
// the renderer would otherwise have used as a flat tint.
export function makeLabeledFallbackTexture(
  category: string,
  id: string,
  color: number,
): Texture {
  const key = `${category}:${id}:${color}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  // getContext can only fail in exotic environments (headless
  // without canvas support); fall back to a plain white texture
  // so callers never get null.
  if (!ctx) {
    cache.set(key, Texture.WHITE);
    return Texture.WHITE;
  }

  // Background = the original fallback color.
  ctx.fillStyle = cssColor(color);
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Text + border contrast via luminance.
  const light = luminance(color) > 140;
  const fg = light ? '#111111' : '#f5f5f5';

  // Subtle border so tiled faces read as faces (cube edges,
  // floor tile seams) instead of one smeared color field.
  ctx.strokeStyle = fg;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, SIZE - 3, SIZE - 3);
  ctx.globalAlpha = 1;

  // Label: "<category>: <id>", word-wrapped; font shrinks until
  // every line fits both axes.
  const label = `${category}: ${id}`;
  const maxWidth = SIZE - 14;
  const maxHeight = SIZE - 14;
  let fontSize = 22;
  let lines: string[] = [label];
  for (; fontSize >= 9; fontSize -= 1) {
    ctx.font = `bold ${fontSize}px monospace`;
    lines = wrapLabel(ctx, label, maxWidth);
    const lineHeight = fontSize * 1.2;
    const fitsH = lines.length * lineHeight <= maxHeight;
    const fitsW = lines.every((l) => ctx.measureText(l).width <= maxWidth);
    if (fitsH && fitsW) break;
  }
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineHeight = fontSize * 1.2;
  const startY = SIZE / 2 - ((lines.length - 1) * lineHeight) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], SIZE / 2, startY + i * lineHeight, maxWidth);
  }

  const tex = Texture.from(canvas);
  // REPEAT so tiled surfaces (biome floor/wall/ceiling, building
  // cube faces) wrap; linear filtering keeps the text legible
  // when minified at distance.
  try {
    const style = (tex.source as unknown as {
      style?: {
        addressMode?: string;
        scaleMode?: string;
        update?: () => void;
      };
    }).style;
    if (style) {
      style.addressMode = 'repeat';
      style.scaleMode = 'linear';
      style.update?.();
    }
  } catch {
    /* best-effort */
  }
  cache.set(key, tex);
  return tex;
}
