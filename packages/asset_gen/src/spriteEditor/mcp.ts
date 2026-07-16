// MCP stdio server for the sprite editor. An editing LLM (worker
// agent or an interactive Claude Code session) drives the engine
// through these tools; render returns a PNG image content block so
// the model can look at what it made and iterate.
//
// Run: npm run sprite-mcp --workspace=@dumrunner/asset_gen
// Sprites persist as JSON under packages/asset_gen/art/sprites/.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  cloneFrame,
  createSprite,
  deleteFrame,
  drawLine,
  drawRect,
  floodFill,
  mirrorX,
  outline,
  renderNative,
  renderReview,
  setRows,
  shiftFrame,
  stamp,
  SpriteStore,
  spriteHeight,
  spriteWidth,
  type SpriteDoc,
} from './engine.js';
import {
  exportAnimation,
  exportStatic,
  wireEntityAnimation,
} from './exportToGame.js';
import { ANIMATION_CATEGORIES } from '@dumrunner/shared';

const HEX = z.string().regex(/^#[0-9a-f]{6}$/i);

export function buildSpriteEditorServer(spritesDir: string): McpServer {
  const store = new SpriteStore(spritesDir);
  // Working set; loaded lazily from the store.
  const open = new Map<string, SpriteDoc>();

  async function doc(id: string): Promise<SpriteDoc> {
    const cached = open.get(id);
    if (cached) return cached;
    const loaded = await store.load(id);
    if (!loaded) throw new Error(`no sprite '${id}' — create_sprite first`);
    open.set(id, loaded);
    return loaded;
  }

  async function persist(d: SpriteDoc): Promise<void> {
    open.set(d.id, d);
    await store.save(d);
  }

  function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  const server = new McpServer({ name: 'sprite-editor', version: '1.0.0' });

  server.tool(
    'create_sprite',
    'Create a new palette-indexed pixel sprite. Canvas is tilesW×tilesH tiles of 16px. Palette max 35 colors; pixels reference it by char: "." transparent, "0"-"9" idx 0-9, "a"-"y" idx 10-34. Starts with one blank frame "idle/0". Frame names are "<state>/<index>".',
    {
      id: z.string(),
      tilesW: z.number().int().min(1).max(16),
      tilesH: z.number().int().min(1).max(16),
      palette: z.array(HEX).min(1).max(35),
    },
    async ({ id, tilesW, tilesH, palette }) => {
      const d = createSprite(id, tilesW, tilesH, palette);
      await persist(d);
      return ok(
        `created '${id}' ${spriteWidth(d)}x${spriteHeight(d)}px ` +
          `(${tilesW}x${tilesH} tiles), palette ${palette.length} colors, frame idle/0`,
      );
    },
  );

  server.tool(
    'get_sprite',
    'Inspect a sprite: dimensions, palette, frame list, and optionally the raw rows of one frame.',
    { id: z.string(), frame: z.string().optional() },
    async ({ id, frame }) => {
      const d = await doc(id);
      const lines = [
        `id: ${d.id}  ${spriteWidth(d)}x${spriteHeight(d)}px (${d.tilesW}x${d.tilesH} tiles)`,
        `palette: ${d.palette.map((c, i) => `${i < 10 ? i : String.fromCharCode(97 + i - 10)}=${c}`).join(' ')}`,
        `frames: ${Object.keys(d.frames).join(', ')}`,
      ];
      if (frame) {
        const f = d.frames[frame];
        if (!f) throw new Error(`no frame '${frame}'`);
        lines.push('', ...f);
      }
      return ok(lines.join('\n'));
    },
  );

  server.tool(
    'list_sprites',
    'List sprite ids saved in the sprite store.',
    {},
    async () => ok((await store.list()).join('\n') || '(none)'),
  );

  server.tool(
    'set_palette',
    'Replace the palette (indexes already used by pixels must stay in range).',
    { id: z.string(), palette: z.array(HEX).min(1).max(35) },
    async ({ id, palette }) => {
      const d = await doc(id);
      let maxUsed = -1;
      for (const rows of Object.values(d.frames)) {
        for (const row of rows) {
          for (const ch of row) {
            if (ch === '.') continue;
            const idx = ch >= 'a' ? ch.charCodeAt(0) - 87 : ch.charCodeAt(0) - 48;
            if (idx > maxUsed) maxUsed = idx;
          }
        }
      }
      if (maxUsed >= palette.length) {
        throw new Error(
          `pixels use palette index ${maxUsed}; new palette has ${palette.length}`,
        );
      }
      d.palette = [...palette];
      await persist(d);
      return ok(`palette replaced (${palette.length} colors)`);
    },
  );

  server.tool(
    'set_rows',
    'Write whole pixel rows. rows[i] replaces row y0+i and must be exactly the sprite width in chars.',
    {
      id: z.string(),
      frame: z.string(),
      y0: z.number().int().min(0),
      rows: z.array(z.string()).min(1),
    },
    async ({ id, frame, y0, rows }) => {
      const d = await doc(id);
      setRows(d, frame, y0, rows);
      await persist(d);
      return ok(`wrote rows ${y0}-${y0 + rows.length - 1} of ${frame}`);
    },
  );

  server.tool(
    'draw_rect',
    'Draw a rectangle (outline or filled) with a palette char.',
    {
      id: z.string(),
      frame: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().min(1),
      h: z.number().int().min(1),
      char: z.string().length(1),
      fill: z.boolean().default(false),
    },
    async ({ id, frame, x, y, w, h, char, fill }) => {
      const d = await doc(id);
      drawRect(d, frame, x, y, w, h, char, fill);
      await persist(d);
      return ok(`rect ${w}x${h} at (${x},${y}) on ${frame}`);
    },
  );

  server.tool(
    'draw_line',
    'Draw a 1px line (Bresenham) with a palette char.',
    {
      id: z.string(),
      frame: z.string(),
      x0: z.number().int(),
      y0: z.number().int(),
      x1: z.number().int(),
      y1: z.number().int(),
      char: z.string().length(1),
    },
    async ({ id, frame, x0, y0, x1, y1, char }) => {
      const d = await doc(id);
      drawLine(d, frame, x0, y0, x1, y1, char);
      await persist(d);
      return ok(`line (${x0},${y0})→(${x1},${y1}) on ${frame}`);
    },
  );

  server.tool(
    'flood_fill',
    'Flood-fill the region containing (x,y) with a palette char.',
    {
      id: z.string(),
      frame: z.string(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      char: z.string().length(1),
    },
    async ({ id, frame, x, y, char }) => {
      const d = await doc(id);
      floodFill(d, frame, x, y, char);
      await persist(d);
      return ok(`filled from (${x},${y}) on ${frame}`);
    },
  );

  server.tool(
    'mirror_x',
    'Mirror one half of the frame onto the other. Draw half a symmetric sprite, then mirror.',
    {
      id: z.string(),
      frame: z.string(),
      from: z.enum(['left', 'right']).default('left'),
    },
    async ({ id, frame, from }) => {
      const d = await doc(id);
      mirrorX(d, frame, from);
      await persist(d);
      return ok(`mirrored ${from} half of ${frame}`);
    },
  );

  server.tool(
    'clone_frame',
    'Copy a frame to a new name (e.g. idle/0 → walk/0), then edit the diff.',
    { id: z.string(), from: z.string(), to: z.string() },
    async ({ id, from, to }) => {
      const d = await doc(id);
      cloneFrame(d, from, to);
      await persist(d);
      return ok(`cloned ${from} → ${to}`);
    },
  );

  server.tool(
    'delete_frame',
    'Delete a frame.',
    { id: z.string(), frame: z.string() },
    async ({ id, frame }) => {
      const d = await doc(id);
      deleteFrame(d, frame);
      await persist(d);
      return ok(`deleted ${frame}`);
    },
  );

  server.tool(
    'shift_frame',
    'Shift all pixels of a frame by (dx,dy); vacated pixels become transparent.',
    {
      id: z.string(),
      frame: z.string(),
      dx: z.number().int(),
      dy: z.number().int(),
    },
    async ({ id, frame, dx, dy }) => {
      const d = await doc(id);
      shiftFrame(d, frame, dx, dy);
      await persist(d);
      return ok(`shifted ${frame} by (${dx},${dy})`);
    },
  );

  server.tool(
    'stamp',
    'Blit a block of rows at (x,y). Space skips a pixel (nothing painted), "." paints transparency, palette chars paint color. For placing small props (tools, bolts) without merging rows by hand.',
    {
      id: z.string(),
      frame: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      rows: z.array(z.string()).min(1),
    },
    async ({ id, frame, x, y, rows }) => {
      const d = await doc(id);
      stamp(d, frame, x, y, rows);
      await persist(d);
      return ok(`stamped ${rows.length} rows at (${x},${y}) on ${frame}`);
    },
  );

  server.tool(
    'outline',
    'Dilate a 1px outline: every transparent pixel touching (8-adjacent) an opaque pixel becomes the given char. Paint fill masses first, outline last. Note: limbs that only touch diagonally get visually severed by the outline — overlap segments by 1px.',
    { id: z.string(), frame: z.string(), char: z.string().length(1) },
    async ({ id, frame, char }) => {
      const d = await doc(id);
      outline(d, frame, char);
      await persist(d);
      return ok(`outlined ${frame} with '${char}'`);
    },
  );

  server.tool(
    'export_static',
    'Export one frame as the static texture override the game consumes: <texturesDir>/<category>/<gameId>.png.',
    {
      id: z.string(),
      frame: z.string(),
      texturesDir: z.string(),
      category: z.string(),
      gameId: z.string(),
    },
    async ({ id, frame, texturesDir, category, gameId }) => {
      const d = await doc(id);
      const path = await exportStatic(d, frame, texturesDir, category, gameId);
      return ok(`wrote ${path}`);
    },
  );

  server.tool(
    'export_animation',
    'Export every frame into the game animation pipeline: frame PNGs at <texturesDir>/anim/<animId>/<state>/<i>.png plus a validated content manifest at <contentDir>/animations/<animId>.json. Frames must be named <state>/<index> with dense indexes; state names are gated per category (enemy: idle/walk/attack/hit/death, prop: idle/destroy, weapon_view: idle/fire/reload, projectile/biome_*: idle). Wire the entity with wire_entity afterwards.',
    {
      id: z.string(),
      animId: z.string().regex(/^[a-z0-9_-]+$/),
      name: z.string(),
      category: z.enum(ANIMATION_CATEGORIES),
      texturesDir: z.string(),
      contentDir: z.string(),
      fps: z.record(z.string(), z.number().positive().max(120)).optional(),
      loop: z.record(z.string(), z.boolean()).optional(),
    },
    async ({ id, animId, name, category, texturesDir, contentDir, fps, loop }) => {
      const d = await doc(id);
      const res = await exportAnimation(d, {
        texturesDir,
        contentDir,
        animId,
        name,
        category,
        fps,
        loop,
      });
      return ok(
        `wrote ${res.manifestPath}\nstates: ` +
          Object.entries(res.states)
            .map(([s, n]) => `${s}(${n})`)
            .join(' '),
      );
    },
  );

  server.tool(
    'wire_entity',
    "Point an entity content JSON at the exported animation. enemies/props use field animationId (default); weapons use viewAnimationId or projectileAnimationId.",
    {
      contentDir: z.string(),
      area: z.enum(['enemies', 'props', 'weapons']),
      entityId: z.string(),
      animId: z.string(),
      field: z
        .enum(['animationId', 'viewAnimationId', 'projectileAnimationId'])
        .default('animationId'),
    },
    async ({ contentDir, area, entityId, animId, field }) => {
      const path = await wireEntityAnimation(
        contentDir,
        area,
        entityId,
        animId,
        field,
      );
      return ok(`wired ${area}/${entityId}.${field} → ${animId} (${path})`);
    },
  );

  server.tool(
    'render',
    'Render frames side by side as an upscaled PNG image (checker backdrop, tile guides) so you can inspect your work. Use onionFrame to ghost a base pose under each frame while animating.',
    {
      id: z.string(),
      frames: z.array(z.string()).optional(),
      scale: z.number().int().min(1).max(24).optional(),
      onionFrame: z.string().optional(),
      grid: z.boolean().optional(),
    },
    async ({ id, frames, scale, onionFrame, grid }) => {
      const d = await doc(id);
      const png = await renderReview(d, { frames, scale, onionFrame, grid });
      return {
        content: [
          {
            type: 'image' as const,
            data: png.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      };
    },
  );

  server.tool(
    'export_png',
    'Write a frame as a 1:1 PNG to an absolute path (creates directories). This is the game-consumable output.',
    { id: z.string(), frame: z.string(), path: z.string() },
    async ({ id, frame, path }) => {
      const d = await doc(id);
      const png = await renderNative(d, frame);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, png);
      return ok(`wrote ${spriteWidth(d)}x${spriteHeight(d)} PNG → ${path}`);
    },
  );

  server.tool(
    'import_reference',
    'Load an existing PNG from disk and return it as an image, for style reference before/while drawing.',
    { path: z.string() },
    async ({ path }) => {
      const bytes = await readFile(path);
      return {
        content: [
          {
            type: 'image' as const,
            data: bytes.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      };
    },
  );

  return server;
}

export async function startSpriteEditorMcp(spritesDir: string): Promise<void> {
  const server = buildSpriteEditorServer(spritesDir);
  await server.connect(new StdioServerTransport());
}
