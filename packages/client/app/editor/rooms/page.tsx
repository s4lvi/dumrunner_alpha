'use client';

// Room template editor. Three-pane layout:
//   - sidebar: list of authored templates
//   - main: form (identity + metadata) + paintable tile grid
//     canvas + anchor placement
//
// Each template stores its tile grid as a row-major byte array
// encoded as base64 in JSON. The editor decodes on load, edits an
// in-memory Uint8Array, and re-encodes on save. Tile palette comes
// from the first biome in the template's biomeAffinity — the
// renderer resolves tile ids per biome at runtime, so every biome
// the template targets must have a compatible tileSet.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnchorKind,
  BiomeDef,
  RoomEdge,
  RoomRole,
  RoomTemplate,
  TileDef,
} from '@dumrunner/shared';
import {
  DEFAULT_FLOOR_TILE_ID,
  DEFAULT_WALL_TILE_ID,
  VOID_TILE_ID,
} from '@dumrunner/shared';
import { listEntities } from '@/lib/editorContentClient';
import { useEntityEditor } from '../_components/useEntityEditor';
import { EntityList } from '../_components/EntityList';
import { RoomPreview as SandboxRoomPreview } from '../_components/RoomPreview';
import { ReferencesPanel } from '../_components/ReferencesPanel';
import {
  Button,
  EnumField,
  FormSection,
  NumberField,
  TextField,
} from '../_components/Form';

const ROLES: readonly RoomRole[] = [
  'normal',
  'safe',
  'extreme',
  'boss',
  'vault',
] as const;

const ANCHOR_KINDS: readonly AnchorKind[] = [
  'enemy',
  'prop',
  'loot',
  'entry',
  'spawn',
  'extract',
  'stairs_down',
  'door',
] as const;

// Anchor-overlay colours. Picked so the kind reads at a glance
// without clashing with biome palette colours.
const ANCHOR_COLORS: Record<AnchorKind, string> = {
  spawn: '#22c55e',
  extract: '#06b6d4',
  stairs_down: '#facc15',
  enemy: '#ef4444',
  prop: '#3b82f6',
  loot: '#f59e0b',
  door: '#a16207',
  entry: '#a855f7',
};

// Target longest-axis canvas size in px. Cell size scales down so
// large templates (up to 64×64) still fit in the main pane while
// small templates render with chunky, easy-to-paint cells.
const CANVAS_TARGET_PX = 768;
const CELL_PX_MAX = 32;
const CELL_PX_MIN = 8;
function cellPxFor(width: number, height: number): number {
  const longest = Math.max(width, height);
  const fit = Math.floor(CANVAS_TARGET_PX / longest);
  return Math.max(CELL_PX_MIN, Math.min(CELL_PX_MAX, fit));
}

// Decode a base64 tile array; tolerates empty / malformed by
// returning a fresh zero-filled array of the expected length.
function decodeTiles(b64: string, expected: number): Uint8Array {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (out.length === expected) return out;
    // Length mismatch — fall through to zero-filled. Author can
    // re-paint and re-save; better than crashing on stale data.
    return new Uint8Array(expected);
  } catch {
    return new Uint8Array(expected);
  }
}

function encodeTiles(tiles: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < tiles.length; i++) bin += String.fromCharCode(tiles[i]);
  return btoa(bin);
}

// Preserve overlap when the template grid resizes.
function resizeTiles(
  src: Uint8Array,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): Uint8Array {
  const out = new Uint8Array(newW * newH);
  const w = Math.min(oldW, newW);
  const h = Math.min(oldH, newH);
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      out[ty * newW + tx] = src[ty * oldW + tx];
    }
  }
  return out;
}

function makeBlank(id = 'new_room'): RoomTemplate {
  const width = 8;
  const height = 6;
  const tiles = new Uint8Array(width * height);
  return {
    id,
    label: 'New Room',
    biomeAffinity: [],
    width,
    height,
    tilesB64: encodeTiles(tiles),
    entrySides: ['N', 'S', 'E', 'W'],
    anchors: [],
    role: 'normal',
    weight: 1,
  };
}

export default function RoomEditorPage() {
  // useEntityEditor reads useSearchParams; wrap in Suspense so
  // the static prerender pass doesn't bail on the CSR hook.
  return (
    <Suspense fallback={null}>
      <RoomEditorBody />
    </Suspense>
  );
}

function RoomEditorBody() {
  // Decoded tile array — kept in sync with draft.tilesB64. Lives
  // outside useEntityEditor because it's a per-render mutable
  // working buffer (the canvas paints into it directly), not a
  // schema field. Encoded back into draft.tilesB64 at save time
  // via the hook's beforeSave hook.
  const [tiles, setTiles] = useState<Uint8Array>(new Uint8Array(0));
  // Current paintbrush tile id and click mode.
  const [paintTileId, setPaintTileId] = useState<number>(DEFAULT_FLOOR_TILE_ID);
  const [tool, setTool] = useState<'paint' | 'anchor'>('paint');
  const [anchorKind, setAnchorKind] = useState<AnchorKind>('enemy');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  // Biome list for the affinity picker + palette resolution.
  const [biomes, setBiomes] = useState<BiomeDef[]>([]);
  // Stable ref so beforeSave reads the latest tiles without
  // forcing a fresh useCallback every render.
  const tilesRef = useRef<Uint8Array>(tiles);
  tilesRef.current = tiles;
  const {
    entries,
    selectedId,
    setSelectedId,
    draft,
    setDraft,
    save,
    remove,
    createNew,
    error,
    saving,
  } = useEntityEditor<RoomTemplate>('rooms', {
    makeBlank,
    newIdPrefix: 'room',
    beforeSave: (d) => ({
      ...d,
      tilesB64: encodeTiles(tilesRef.current),
      entrySides: deriveEntrySides({ ...d, tilesB64: '' }),
    }),
  });

  useEffect(() => {
    void (async () => {
      try {
        const r = await listEntities('biomes');
        setBiomes(r);
      } catch {
        // Editor still works without biomes — palette falls back
        // to a neutral default.
      }
    })();
  }, []);

  // Sync the tile buffer when the selected entry changes. The
  // hook handles draft snapshotting; we just mirror the tiles.
  useEffect(() => {
    if (selectedId === null) {
      setTiles(new Uint8Array(0));
      return;
    }
    const found = entries.find((t) => t.id === selectedId);
    if (found) {
      setTiles(decodeTiles(found.tilesB64, found.width * found.height));
    }
  }, [selectedId, entries]);

  // Resolve the palette used to colour-render the tile grid. Pick
  // the first biome in biomeAffinity that we've loaded; fall back
  // to neutral greys when affinity is empty or all entries are
  // absent.
  const palette = useMemo(() => {
    if (!draft) return null;
    for (const id of draft.biomeAffinity) {
      const b = biomes.find((x) => x.id === id);
      if (b) return b;
    }
    return null;
  }, [draft, biomes]);

  // Per-tile-id colour for the canvas. Reads the biome's tileSet
  // for role-based colouring, falls back to floor/wall palette
  // colours, then to neutral greys for any unrecognised id.
  const tileColor = useMemo(() => {
    return (id: number): string => {
      if (id === VOID_TILE_ID) return '';
      const def = palette?.tileSet?.tiles.find((t: TileDef) => t.id === id);
      if (def) {
        if (def.role === 'floor') return palette?.palette.floor ?? '#1f242c';
        if (def.role === 'wall') return palette?.palette.wall ?? '#52525b';
        return palette?.palette.accent ?? '#94a3b8';
      }
      // Default-id fallback so a new biome (no tileSet) still renders.
      if (id === DEFAULT_FLOOR_TILE_ID) {
        return palette?.palette.floor ?? '#1f242c';
      }
      if (id === DEFAULT_WALL_TILE_ID) {
        return palette?.palette.wall ?? '#52525b';
      }
      return '#3f3f46';
    };
  }, [palette]);

  const onNew = createNew;
  const onSave = save;
  const onDelete = remove;

  function onResize(newW: number, newH: number): void {
    if (!draft) return;
    const w = Math.max(3, Math.min(32, Math.floor(newW)));
    const h = Math.max(3, Math.min(32, Math.floor(newH)));
    const nextTiles = resizeTiles(tiles, draft.width, draft.height, w, h);
    setTiles(nextTiles);
    // Drop anchors that fall outside the new bounds.
    const anchors = draft.anchors.filter((a) => a.tx < w && a.ty < h);
    setDraft({ ...draft, width: w, height: h, anchors });
  }

  function paintAt(tx: number, ty: number): void {
    if (!draft) return;
    if (tx < 0 || ty < 0 || tx >= draft.width || ty >= draft.height) return;
    const idx = ty * draft.width + tx;
    if (tiles[idx] === paintTileId) return;
    const next = new Uint8Array(tiles);
    next[idx] = paintTileId;
    setTiles(next);
  }

  function placeAnchor(tx: number, ty: number): void {
    if (!draft) return;
    if (tx < 0 || ty < 0 || tx >= draft.width || ty >= draft.height) return;
    // Click on existing anchor of any kind at this cell → remove it.
    const existing = draft.anchors.findIndex(
      (a) => a.tx === tx && a.ty === ty,
    );
    if (existing >= 0) {
      const next = draft.anchors.slice();
      next.splice(existing, 1);
      setDraft({ ...draft, anchors: next });
      return;
    }
    setDraft({
      ...draft,
      anchors: [...draft.anchors, { kind: anchorKind, tx, ty }],
    });
  }

  return (
    <div className="flex h-full w-full">
      <EntityList<RoomTemplate>
        title="Rooms"
        entries={entries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={onNew}
        emptyHint="No rooms yet. Click + new to start one."
        renderItem={(r) => (
          <>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate">{r.label}</span>
              <span className="text-[9px] text-zinc-600 font-mono">
                {r.role}
              </span>
            </div>
            <div className="text-[10px] text-zinc-500 font-mono">
              {r.width}×{r.height} · {r.biomeAffinity.join(', ') || '(no biome)'}
            </div>
          </>
        )}
      />

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-1 px-3 py-1 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
          <button
            type="button"
            onClick={() => setTab('edit')}
            className={`text-xs px-2 py-1 rounded ${
              tab === 'edit'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/50'
            }`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setTab('preview')}
            disabled={!draft}
            className={`text-xs px-2 py-1 rounded ${
              tab === 'preview'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/50'
            } ${!draft ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Preview
          </button>
          {draft && (
            <div className="ml-auto flex gap-2">
              <Button variant="danger" onClick={onDelete}>
                Delete
              </Button>
              <Button variant="primary" disabled={saving} onClick={onSave}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}
        </div>
        {tab === 'preview' && draft && (
          <div className="flex-1 min-h-0">
            <SandboxRoomPreview
              templateId={draft.id}
              biomeAffinity={draft.biomeAffinity}
            />
          </div>
        )}
        {tab === 'edit' && (
        <main className="flex-1 overflow-y-auto p-4 min-w-0">
          {!draft && (
            <div className="text-zinc-500 text-sm pt-12 text-center">
              Select a room on the left, or create a new one.
            </div>
          )}
          {draft && (
            <div className="max-w-3xl space-y-3">
              <h1 className="text-lg font-bold">{draft.label}</h1>
              {error && (
                <pre className="bg-red-950/50 border border-red-900 text-red-200 text-[11px] font-mono p-2 rounded whitespace-pre-wrap">
                  {error}
                </pre>
              )}

              <FormSection title="Identity">
                <TextField
                  label="id"
                  value={draft.id}
                  monospace
                  onChange={(v) => setDraft({ ...draft, id: v })}
                  hint="lowercase slug — also the JSON filename"
                />
                <TextField
                  label="label"
                  value={draft.label}
                  onChange={(v) => setDraft({ ...draft, label: v })}
                />
              </FormSection>

              <FormSection title="Pool placement">
                <EnumField
                  label="role"
                  value={draft.role}
                  options={ROLES}
                  onChange={(v) =>
                    setDraft({ ...draft, role: v as RoomRole })
                  }
                  hint="entrance picks safe; stairs picks normal; locked rooms pick vault"
                />
                <NumberField
                  label="weight"
                  value={draft.weight}
                  step={0.5}
                  min={0}
                  onChange={(v) => setDraft({ ...draft, weight: v })}
                />
                <BiomeAffinityField
                  draft={draft}
                  biomes={biomes}
                  onChange={(next) =>
                    setDraft({ ...draft, biomeAffinity: next })
                  }
                />
              </FormSection>

              <FormSection title="Grid size">
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="width"
                    value={draft.width}
                    min={3}
                    max={32}
                    onChange={(v) => onResize(v, draft.height)}
                  />
                  <NumberField
                    label="height"
                    value={draft.height}
                    min={3}
                    max={32}
                    onChange={(v) => onResize(draft.width, v)}
                  />
                </div>
              </FormSection>

              <FormSection title="Tools">
                <div className="flex gap-2">
                  <ToolButton
                    active={tool === 'paint'}
                    onClick={() => setTool('paint')}
                    label="Paint tiles"
                  />
                  <ToolButton
                    active={tool === 'anchor'}
                    onClick={() => setTool('anchor')}
                    label="Place anchors"
                  />
                </div>
                {tool === 'paint' && (
                  <div className="flex gap-2 flex-wrap items-center">
                    <span className="text-[10px] text-zinc-500">brush:</span>
                    <PaintSwatch
                      label="void"
                      color="transparent"
                      active={paintTileId === VOID_TILE_ID}
                      onClick={() => setPaintTileId(VOID_TILE_ID)}
                    />
                    <PaintSwatch
                      label="floor"
                      color={tileColor(DEFAULT_FLOOR_TILE_ID)}
                      active={paintTileId === DEFAULT_FLOOR_TILE_ID}
                      onClick={() => setPaintTileId(DEFAULT_FLOOR_TILE_ID)}
                    />
                    <PaintSwatch
                      label="wall"
                      color={tileColor(DEFAULT_WALL_TILE_ID)}
                      active={paintTileId === DEFAULT_WALL_TILE_ID}
                      onClick={() => setPaintTileId(DEFAULT_WALL_TILE_ID)}
                    />
                  </div>
                )}
                {tool === 'anchor' && (
                  <div className="flex gap-2 flex-wrap items-center">
                    <span className="text-[10px] text-zinc-500">kind:</span>
                    {ANCHOR_KINDS.map((k) => (
                      <PaintSwatch
                        key={k}
                        label={k}
                        color={ANCHOR_COLORS[k]}
                        active={anchorKind === k}
                        onClick={() => setAnchorKind(k)}
                      />
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-zinc-500">
                  {tool === 'paint'
                    ? 'click + drag to paint cells with the selected tile'
                    : 'click a cell to drop an anchor; click the same cell again to remove it'}
                </p>
              </FormSection>

              <FormSection title="Grid">
                <TileGridCanvas
                  draft={draft}
                  tiles={tiles}
                  tool={tool}
                  tileColor={tileColor}
                  onPaint={paintAt}
                  onPlaceAnchor={placeAnchor}
                />
              </FormSection>

              <FormSection title="Anchors">
                <p className="text-[10px] text-zinc-500">
                  Procgen reads these to drive enemy / prop / loot spawns
                  on stamped rooms. Tile coords are template-relative.
                </p>
                {draft.anchors.length === 0 && (
                  <p className="text-[11px] text-zinc-500">
                    No anchors. Switch to the anchor tool above to drop some.
                  </p>
                )}
                {draft.anchors.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[11px] font-mono"
                  >
                    <span
                      className="w-3 h-3 rounded-full inline-block"
                      style={{ background: ANCHOR_COLORS[a.kind] }}
                    />
                    <span className="w-20 text-zinc-300">{a.kind}</span>
                    <span className="text-zinc-500">
                      ({a.tx}, {a.ty})
                    </span>
                    <input
                      type="text"
                      value={a.overrideId ?? ''}
                      placeholder="overrideId (optional)"
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        const next = draft.anchors.slice();
                        next[i] = { ...a, overrideId: v || undefined };
                        setDraft({ ...draft, anchors: next });
                      }}
                      className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = draft.anchors.slice();
                        next.splice(i, 1);
                        setDraft({ ...draft, anchors: next });
                      }}
                      className="text-zinc-500 hover:text-red-400"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </FormSection>

              <FormSection title="References">
                <ReferencesPanel area="rooms" id={draft.id} />
              </FormSection>
            </div>
          )}
        </main>
        )}
      </div>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1 rounded border ${
        active
          ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
          : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800/50'
      }`}
    >
      {label}
    </button>
  );
}

function PaintSwatch({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  const transparent = color === 'transparent';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border ${
        active
          ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
          : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800/50'
      }`}
    >
      <span
        className={`w-3 h-3 rounded border border-zinc-700 ${
          transparent ? 'bg-zinc-950' : ''
        }`}
        style={transparent ? undefined : { background: color }}
      />
      <span>{label}</span>
    </button>
  );
}

// Painted tile grid + anchor overlay. Listens for mousedown +
// mousemove-while-down to paint a stroke; clicks while the anchor
// tool is active drop / remove anchors.
function TileGridCanvas({
  draft,
  tiles,
  tool,
  tileColor,
  onPaint,
  onPlaceAnchor,
}: {
  draft: RoomTemplate;
  tiles: Uint8Array;
  tool: 'paint' | 'anchor';
  tileColor: (id: number) => string;
  onPaint: (tx: number, ty: number) => void;
  onPlaceAnchor: (tx: number, ty: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef(false);
  const w = draft.width;
  const h = draft.height;
  const cellPx = cellPxFor(w, h);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    c.width = w * cellPx;
    c.height = h * cellPx;
    // Background — checkerboard so void cells read as empty.
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const checker = (tx + ty) % 2 === 0 ? '#0c0d10' : '#101216';
        ctx.fillStyle = checker;
        ctx.fillRect(tx * cellPx, ty * cellPx, cellPx, cellPx);
      }
    }
    // Tiles.
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const id = tiles[ty * w + tx];
        const color = tileColor(id);
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(tx * cellPx, ty * cellPx, cellPx, cellPx);
      }
    }
    // Grid lines.
    ctx.strokeStyle = '#1f1f24';
    ctx.lineWidth = 1;
    for (let i = 0; i <= w; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cellPx + 0.5, 0);
      ctx.lineTo(i * cellPx + 0.5, h * cellPx);
      ctx.stroke();
    }
    for (let i = 0; i <= h; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * cellPx + 0.5);
      ctx.lineTo(w * cellPx, i * cellPx + 0.5);
      ctx.stroke();
    }
    // Anchors — small circle in the cell centre.
    for (const a of draft.anchors) {
      ctx.fillStyle = ANCHOR_COLORS[a.kind];
      ctx.beginPath();
      ctx.arc(
        (a.tx + 0.5) * cellPx,
        (a.ty + 0.5) * cellPx,
        cellPx * 0.32,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.strokeStyle = '#0a0a0a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [draft, tiles, tileColor, w, h, cellPx]);

  function cellFromEvent(
    e: React.MouseEvent<HTMLCanvasElement>,
  ): { tx: number; ty: number } | null {
    const c = canvasRef.current;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      tx: Math.floor((x / rect.width) * w),
      ty: Math.floor((y / rect.height) * h),
    };
  }

  return (
    <canvas
      ref={canvasRef}
      className="border border-zinc-800 rounded select-none"
      style={{ imageRendering: 'pixelated', cursor: 'crosshair' }}
      onMouseDown={(e) => {
        const cell = cellFromEvent(e);
        if (!cell) return;
        if (tool === 'paint') {
          dragging.current = true;
          onPaint(cell.tx, cell.ty);
        } else {
          onPlaceAnchor(cell.tx, cell.ty);
        }
      }}
      onMouseMove={(e) => {
        if (!dragging.current || tool !== 'paint') return;
        const cell = cellFromEvent(e);
        if (cell) onPaint(cell.tx, cell.ty);
      }}
      onMouseUp={() => {
        dragging.current = false;
      }}
      onMouseLeave={() => {
        dragging.current = false;
      }}
    />
  );
}

function BiomeAffinityField({
  draft,
  biomes,
  onChange,
}: {
  draft: RoomTemplate;
  biomes: BiomeDef[];
  onChange: (next: string[]) => void;
}) {
  const all = biomes.map((b) => b.id).sort();
  function toggle(id: string): void {
    const cur = new Set(draft.biomeAffinity);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    onChange(Array.from(cur).sort());
  }
  return (
    <div>
      <label className="text-xs text-zinc-300 block mb-1">biome affinity</label>
      {all.length === 0 && (
        <p className="text-[11px] text-zinc-500">
          No biomes authored — add some first.
        </p>
      )}
      <div className="flex gap-2 flex-wrap">
        {all.map((id) => {
          const active = draft.biomeAffinity.includes(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              className={`text-[10px] px-2 py-0.5 rounded border ${
                active
                  ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                  : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800/50'
              }`}
            >
              {id}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Auto-derive the entrySides flags from the template's entry
// anchors at save time. Author drops 'entry' anchors on the
// canvas; whichever sides they sit on become eligible. When no
// entry anchors are placed, default to all four sides so a
// template missing the metadata is still usable everywhere.
function deriveEntrySides(draft: RoomTemplate): RoomEdge[] {
  const sides = new Set<RoomEdge>();
  for (const a of draft.anchors) {
    if (a.kind !== 'entry') continue;
    if (a.tx === 0) sides.add('W');
    if (a.tx === draft.width - 1) sides.add('E');
    if (a.ty === 0) sides.add('N');
    if (a.ty === draft.height - 1) sides.add('S');
  }
  if (sides.size === 0) return ['N', 'S', 'E', 'W'];
  return Array.from(sides);
}
