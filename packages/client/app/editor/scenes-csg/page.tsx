'use client';

// CSG scene editor. Each shape is a 2D polygon with elevation
// overrides; the runtime linedef topology is derived at save
// time by `csgSceneToLinedefScene`. The editor never touches
// linedefs directly — the entire class of carve-corrupted-the-
// front-claim bugs that haunted the linedef editor doesn't exist
// here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CsgScene,
  CsgShape,
  LinedefScene,
  SceneDef,
  SectorScene,
} from '@dumrunner/shared';
import {
  csgSceneToLinedefScene,
  emptyCsgScene,
  linedefSceneToCsgScene,
  polygonSceneToLinedefScene,
  validateLinedefScene,
} from '@dumrunner/shared';
import { saveEntity } from '@/lib/editorContentClient';
import { SceneList } from '../scenes/SceneList';
import { ScenePlaytest } from '../scenes/ScenePlaytest';
import {
  SceneCanvasCsg,
  type CsgSelection,
  type CsgSnap,
  type CsgTool,
} from './SceneCanvasCsg';
import { useUndoableCsg, useUndoHotkeys } from './useUndoableCsg';

const TOOLS: Array<{
  id: CsgTool;
  label: string;
  hotkey: string;
  group: 'edit' | 'shape' | 'place';
  hint?: string;
}> = [
  { id: 'adjust', label: 'Adjust', hotkey: 'A', group: 'edit', hint: 'drag verts' },
  { id: 'insert', label: 'Insert vert', hotkey: 'V', group: 'edit', hint: 'click an edge' },
  { id: 'rect-room', label: 'Room', hotkey: 'R', group: 'shape' },
  { id: 'rect-platform', label: 'Platform', hotkey: 'P', group: 'shape', hint: 'raised floor' },
  { id: 'rect-pit', label: 'Pit', hotkey: 'Y', group: 'shape', hint: 'lowered floor' },
  { id: 'rect-vent', label: 'Vent', hotkey: 'N', group: 'shape', hint: 'low ceiling' },
  { id: 'rect-window', label: 'Window', hotkey: 'W', group: 'shape', hint: 'see-through gap' },
  { id: 'polygon', label: 'Polygon', hotkey: 'G', group: 'shape' },
  { id: 'circle', label: 'Circle', hotkey: 'C', group: 'shape' },
  { id: 'subtract', label: 'Subtract', hotkey: 'U', group: 'shape', hint: 'cut shape from shape' },
  { id: 'spawn', label: 'Spawn', hotkey: 'S', group: 'place' },
  { id: 'light', label: 'Light', hotkey: 'L', group: 'place' },
  { id: 'interactable', label: 'Interactable', hotkey: 'I', group: 'place' },
  { id: 'delete', label: 'Delete', hotkey: 'X', group: 'edit' },
];

const SNAPS: Array<{ id: CsgSnap; label: string }> = [
  { id: 'grid32', label: '32 px' },
  { id: 'grid16', label: '16 px' },
  { id: 'free', label: 'free' },
];

export default function ScenesCsgPage() {
  const undoable = useUndoableCsg<CsgScene>(emptyCsgScene('untitled'));
  const {
    scene,
    setScene,
    setScenePreview,
    undo,
    redo,
    canUndo,
    canRedo,
    reset: resetHistory,
  } = undoable;
  useUndoHotkeys(undo, redo);
  const [tool, setTool] = useState<CsgTool>('adjust');
  const [snap, setSnap] = useState<CsgSnap>('grid32');
  const [selection, setSelection] = useState<CsgSelection>(null);
  const [playtesting, setPlaytesting] = useState(false);
  const [showAiGrid, setShowAiGrid] = useState(false);
  const [sidebarReload, setSidebarReload] = useState(0);
  const [playtestReloadTick, setPlaytestReloadTick] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const actionLogRef = useRef<string[]>([]);
  const logAction = useCallback((label: string) => {
    const ts = new Date().toISOString().split('T')[1].slice(0, 12);
    actionLogRef.current.push(`[${ts}] ${label}`);
    if (actionLogRef.current.length > 500) actionLogRef.current.shift();
  }, []);

  // Hotkeys for tools + Esc. Skips when focus is in any editable
  // surface (inputs, selects, textareas, contentEditable) and when
  // a non-Shift modifier is held (so Cmd-A / Ctrl-V don't trigger
  // tool changes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === '`') {
        setShowAiGrid((v) => !v);
        return;
      }
      const match = TOOLS.find((t) => t.hotkey.toLowerCase() === k);
      if (match) setTool(match.id);
      else if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (saveStatus !== 'saved') return;
    const t = window.setTimeout(() => setSaveStatus('idle'), 1500);
    return () => window.clearTimeout(t);
  }, [saveStatus]);

  // Ensure the spawn lies inside SOME walkable shape. If it
  // doesn't, snap it to the centroid of the largest shape — beats
  // letting the player spawn floating above the map. Returns the
  // potentially-adjusted scene + whether a snap happened.
  const spawnSafeScene = useMemo<{
    scene: CsgScene;
    snapped: boolean;
  }>(() => {
    const walkable = scene.shapes.filter(
      (s) => s.buildingKind === undefined,
    );
    if (walkable.length === 0) return { scene, snapped: false };
    const inside = walkable.some((s) =>
      pointInRing(s.outer, scene.spawn.x, scene.spawn.y),
    );
    if (inside) return { scene, snapped: false };
    let best: CsgShape | null = null;
    let bestArea = -Infinity;
    for (const s of walkable) {
      const area = Math.abs(ringSignedArea(s.outer));
      if (area > bestArea) {
        bestArea = area;
        best = s;
      }
    }
    if (!best) return { scene, snapped: false };
    let cx = 0;
    let cy = 0;
    for (const v of best.outer) {
      cx += v.x;
      cy += v.y;
    }
    cx /= best.outer.length;
    cy /= best.outer.length;
    return {
      scene: { ...scene, spawn: { x: cx, y: cy } },
      snapped: true,
    };
  }, [scene]);

  // Live validation: run the CSG → linedef pipeline on the
  // spawn-corrected scene and validate the result.
  const liveLinedef = useMemo<LinedefScene | null>(() => {
    try {
      return csgSceneToLinedefScene(spawnSafeScene.scene);
    } catch {
      return null;
    }
  }, [spawnSafeScene]);
  const liveValidation = useMemo(() => {
    if (!liveLinedef) return { errors: ['CSG conversion failed'], warnings: [] };
    const base = validateLinedefScene(liveLinedef);
    if (spawnSafeScene.snapped) {
      base.warnings = [
        'Spawn was outside every walkable shape — auto-snapped to the largest shape’s centroid. Place the spawn explicitly with the Spawn tool to pin it.',
        ...base.warnings,
      ];
    }
    return base;
  }, [liveLinedef, spawnSafeScene]);

  async function handleSave() {
    if (!scene.id || scene.id === 'untitled') {
      setSaveStatus('error');
      setSaveError(
        'Set a non-default scene id before saving (header → rename).',
      );
      return;
    }
    setSaveStatus('saving');
    setSaveError(null);
    try {
      // Persist the spawn-corrected CSG source so the saved file
      // never has a void-spawn. Editor state stays as-is — the
      // user can still drag the spawn anywhere, but saved + live
      // scenes always have a valid spawn point.
      const sanitized = JSON.parse(
        JSON.stringify(spawnSafeScene.scene),
      ) as CsgScene;
      const stamped: CsgScene = {
        ...sanitized,
        meta: {
          ...(sanitized.meta ?? {}),
          createdAt: sanitized.meta?.createdAt ?? new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        },
      };
      await saveEntity('scenes', stamped as unknown as SceneDef);
      // If we snapped the spawn, push the corrected scene back
      // into editor state so the visible marker matches what was
      // saved.
      if (spawnSafeScene.snapped) {
        setScene(spawnSafeScene.scene);
      }
      setWarnings(liveValidation.warnings);
      setEditingId(stamped.id);
      setSidebarReload((n) => n + 1);
      setPlaytestReloadTick((n) => n + 1);
      setSaveStatus('saved');
    } catch (e) {
      setSaveStatus('error');
      const msg = (e as Error).message ?? String(e);
      setSaveError(msg.split('\n')[0]);
      console.error('[csg editor] save failed:', msg);
    }
  }

  function handleNew() {
    const id = `scene_${Math.random().toString(36).slice(2, 8)}`;
    resetHistory(emptyCsgScene(id));
    setEditingId(null);
    setSelection(null);
  }

  function handlePickScene(picked: SceneDef) {
    // Branch by on-disk shape. CSG scenes load directly. Linedef
    // scenes ingest via linedefSceneToCsgScene. Polygon scenes go
    // through the polygon→linedef bridge first. Loading a scene
    // clears undo history (we don't want undo from one scene
    // bleeding into another).
    if ('kind' in picked && picked.kind === 'csg') {
      resetHistory(picked as CsgScene);
    } else {
      const withMap = picked as { map: Record<string, unknown> };
      const ldScene: LinedefScene =
        'linedefs' in withMap.map
          ? (picked as LinedefScene)
          : polygonSceneToLinedefScene(picked as SectorScene);
      resetHistory(linedefSceneToCsgScene(ldScene));
    }
    setEditingId(picked.id);
    setSelection(null);
  }

  const selectedShape = useMemo(() => {
    if (!selection) return null;
    if (selection.kind !== 'shape' && selection.kind !== 'vertex') return null;
    const id =
      selection.kind === 'shape' ? selection.id : selection.shapeId;
    return scene.shapes.find((s) => s.id === id) ?? null;
  }, [selection, scene]);
  const selectedLight = useMemo(() => {
    if (selection?.kind !== 'light') return null;
    return scene.lights.find((l) => l.id === selection.id) ?? null;
  }, [selection, scene]);
  const selectedInteractable = useMemo(() => {
    if (selection?.kind !== 'interactable') return null;
    return (
      scene.interactables.find((i) => i.id === selection.id) ?? null
    );
  }, [selection, scene]);

  const stats = useMemo(
    () => ({
      shapes: scene.shapes.length,
      verts: scene.shapes.reduce((n, s) => n + s.outer.length, 0),
    }),
    [scene],
  );

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/40 text-xs text-zinc-400">
        <div className="flex items-center gap-3">
          <span className="text-zinc-200 font-medium">{scene.name}</span>
          <span className="text-zinc-500">id: {scene.id}</span>
          <span className="text-zinc-500">biome: {scene.biome}</span>
          <span className="text-amber-400/80 text-[10px] uppercase tracking-wider">
            CSG (experimental)
          </span>
        </div>
        <div className="flex items-center gap-3 text-zinc-500">
          <span>{stats.shapes} shapes</span>
          <span>{stats.verts} verts</span>
          <button
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Ctrl/Cmd+Z)"
            className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ↶ Undo
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Ctrl/Cmd+Shift+Z)"
            className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ↷ Redo
          </button>
          <button
            onClick={() => setShowAiGrid((v) => !v)}
            title="Toggle AI walkable-grid preview (`)"
            className={`px-2 py-0.5 rounded border ${
              showAiGrid
                ? 'border-amber-700/80 bg-amber-900/30 text-amber-200'
                : 'border-zinc-700 hover:bg-zinc-800 text-zinc-300'
            }`}
          >
            AI grid {showAiGrid ? 'on' : 'off'}
          </button>
          <button
            onClick={handleSave}
            title="Save to disk"
            className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-200"
          >
            💾 Save
          </button>
          {saveStatus === 'saving' && (
            <span className="text-zinc-500">saving…</span>
          )}
          {saveStatus === 'saved' && (
            <span className="text-emerald-400">saved</span>
          )}
          {saveStatus === 'error' && (
            <span
              title={saveError ?? 'save failed'}
              className="text-red-400 max-w-xs truncate"
            >
              save failed: {saveError ?? '(check console)'}
            </span>
          )}
          {warnings.length > 0 && saveStatus !== 'error' && (
            <span
              title={warnings.join('\n')}
              className="text-amber-400 max-w-xs truncate cursor-help"
            >
              ⚠ {warnings.length}
            </span>
          )}
          <button
            onClick={() => setPlaytesting(true)}
            disabled={!liveLinedef}
            title="Drop in with a pistol + ammo"
            className="px-2 py-0.5 rounded border border-emerald-700/80 bg-emerald-900/30 hover:bg-emerald-900/50 disabled:opacity-40 text-emerald-200"
          >
            ▶ Playtest
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        <SceneList
          selectedId={editingId}
          onSelect={handlePickScene}
          onNew={handleNew}
          onDeleted={() => {
            setScene(emptyCsgScene('untitled'));
            setEditingId(null);
            setSelection(null);
          }}
          reloadKey={sidebarReload}
        />
        <ToolPalette
          tool={tool}
          setTool={setTool}
          snap={snap}
          setSnap={setSnap}
        />
        <div className="flex-1 min-w-0 relative">
          <SceneCanvasCsg
            scene={scene}
            onSceneChange={setScene}
            onScenePreview={setScenePreview}
            tool={tool}
            snap={snap}
            selection={selection}
            onSelectionChange={setSelection}
            onActionLog={logAction}
            showAiGrid={showAiGrid}
          />
        </div>
        <ShapeInspector
          shape={selectedShape}
          light={selectedLight}
          interactable={selectedInteractable}
          onShapeChange={(updated) => {
            setScene({
              ...scene,
              shapes: scene.shapes.map((s) =>
                s.id === updated.id ? updated : s,
              ),
            });
          }}
          onLightChange={(updated) => {
            setScene({
              ...scene,
              lights: scene.lights.map((l) =>
                l.id === updated.id ? updated : l,
              ),
            });
          }}
          onInteractableChange={(updated) => {
            setScene({
              ...scene,
              interactables: scene.interactables.map((i) =>
                i.id === updated.id ? updated : i,
              ),
            });
          }}
          sceneName={scene.name}
          sceneId={scene.id}
          sceneBiome={scene.biome}
          onRename={(name) => setScene({ ...scene, name })}
          onChangeId={(id) => setScene({ ...scene, id })}
          onChangeBiome={(biome) => setScene({ ...scene, biome })}
          spawn={scene.spawn}
          spawnZ={scene.spawnZ}
          onChangeSpawn={(spawn) => setScene({ ...scene, spawn })}
          onChangeSpawnZ={(spawnZ) => setScene({ ...scene, spawnZ })}
        />
      </div>
      <DiagnosticStrip
        shapes={stats.shapes}
        verts={stats.verts}
        errors={liveValidation.errors}
        warnings={liveValidation.warnings}
      />
      {playtesting && liveLinedef && (
        <ScenePlaytest
          scene={liveLinedef}
          reloadTick={playtestReloadTick}
          onClose={() => setPlaytesting(false)}
        />
      )}
    </div>
  );
}

function ToolPalette({
  tool,
  setTool,
  snap,
  setSnap,
}: {
  tool: CsgTool;
  setTool: (t: CsgTool) => void;
  snap: CsgSnap;
  setSnap: (s: CsgSnap) => void;
}) {
  const edit = TOOLS.filter((t) => t.group === 'edit');
  const shape = TOOLS.filter((t) => t.group === 'shape');
  const place = TOOLS.filter((t) => t.group === 'place');
  return (
    <div className="flex flex-col gap-1 p-2 border-r border-zinc-800 bg-zinc-900/40 w-36 shrink-0 overflow-y-auto">
      <Section title="edit">
        {edit.map((t) => (
          <ToolBtn
            key={t.id}
            t={t}
            active={tool === t.id}
            onClick={() => setTool(t.id)}
          />
        ))}
      </Section>
      <Section title="shape">
        {shape.map((t) => (
          <ToolBtn
            key={t.id}
            t={t}
            active={tool === t.id}
            onClick={() => setTool(t.id)}
          />
        ))}
      </Section>
      <Section title="place">
        {place.map((t) => (
          <ToolBtn
            key={t.id}
            t={t}
            active={tool === t.id}
            onClick={() => setTool(t.id)}
          />
        ))}
      </Section>
      <Section title="snap">
        {SNAPS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSnap(s.id)}
            className={`text-left text-xs px-2 py-1 rounded border transition-colors ${
              snap === s.id
                ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                : 'bg-transparent border-transparent text-zinc-400 hover:bg-zinc-800/60'
            }`}
          >
            {s.label}
          </button>
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 mb-1">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1 pt-1 pb-0.5">
        {title}
      </div>
      {children}
    </div>
  );
}

function ToolBtn({
  t,
  active,
  onClick,
}: {
  t: { id: CsgTool; label: string; hotkey: string; hint?: string };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={t.hint ? `${t.label} — ${t.hint}` : t.label}
      className={`text-left text-xs px-2 py-1.5 rounded border transition-colors ${
        active
          ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
          : 'bg-transparent border-transparent text-zinc-400 hover:bg-zinc-800/60'
      }`}
    >
      <div className="flex items-center justify-between">
        <span>{t.label}</span>
        <span className="text-[10px] text-zinc-500">{t.hotkey}</span>
      </div>
    </button>
  );
}

type Light = import('@dumrunner/shared').SectorLight;
type InteractableT = import('@dumrunner/shared').Interactable;

function ShapeInspector({
  shape,
  light,
  interactable,
  onShapeChange,
  onLightChange,
  onInteractableChange,
  sceneName,
  sceneId,
  sceneBiome,
  onRename,
  onChangeId,
  onChangeBiome,
  spawn,
  spawnZ,
  onChangeSpawn,
  onChangeSpawnZ,
}: {
  shape: CsgShape | null;
  light: Light | null;
  interactable: InteractableT | null;
  onShapeChange: (s: CsgShape) => void;
  onLightChange: (l: Light) => void;
  onInteractableChange: (i: InteractableT) => void;
  sceneName: string;
  sceneId: string;
  sceneBiome: string;
  onRename: (n: string) => void;
  onChangeId: (id: string) => void;
  onChangeBiome: (b: string) => void;
  spawn: { x: number; y: number };
  spawnZ: number | undefined;
  onChangeSpawn: (s: { x: number; y: number }) => void;
  onChangeSpawnZ: (z: number | undefined) => void;
}) {
  return (
    <aside className="w-64 shrink-0 border-l border-zinc-800 bg-zinc-900/40 overflow-y-auto p-3 text-xs text-zinc-300 space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
          Scene
        </div>
        <label className="block text-[10px] text-zinc-500 mt-1">id</label>
        <input
          value={sceneId}
          onChange={(e) => onChangeId(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
        />
        <label className="block text-[10px] text-zinc-500 mt-1">name</label>
        <input
          value={sceneName}
          onChange={(e) => onRename(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
        />
        <label className="block text-[10px] text-zinc-500 mt-1">biome</label>
        <input
          value={sceneBiome}
          onChange={(e) => onChangeBiome(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
        />
        <label className="block text-[10px] text-zinc-500 mt-1">
          spawn x · y · z (drop height — leave empty to auto-pick lowest floor)
        </label>
        <div className="flex gap-1">
          <input
            type="number"
            value={spawn.x}
            onChange={(e) =>
              onChangeSpawn({ ...spawn, x: Number(e.target.value) })
            }
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
          />
          <input
            type="number"
            value={spawn.y}
            onChange={(e) =>
              onChangeSpawn({ ...spawn, y: Number(e.target.value) })
            }
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
          />
          <input
            type="number"
            placeholder="auto"
            value={spawnZ ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              onChangeSpawnZ(v === '' ? undefined : Number(v));
            }}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
          />
        </div>
      </div>
      {light ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            Light {light.id}
          </div>
          <Field label="x · y · z">
            <div className="flex gap-1">
              <input
                type="number"
                value={light.x}
                onChange={(e) =>
                  onLightChange({ ...light, x: Number(e.target.value) })
                }
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
              />
              <input
                type="number"
                value={light.y}
                onChange={(e) =>
                  onLightChange({ ...light, y: Number(e.target.value) })
                }
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
              />
              <input
                type="number"
                value={light.z}
                onChange={(e) =>
                  onLightChange({ ...light, z: Number(e.target.value) })
                }
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
              />
            </div>
          </Field>
          <Field label="radius">
            <input
              type="number"
              value={light.radius}
              onChange={(e) =>
                onLightChange({ ...light, radius: Number(e.target.value) })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
          <Field label="intensity">
            <input
              type="number"
              step="0.1"
              value={light.intensity}
              onChange={(e) =>
                onLightChange({
                  ...light,
                  intensity: Number(e.target.value),
                })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
          <Field label="colour (0xRRGGBB)">
            <input
              value={`#${light.colour.toString(16).padStart(6, '0')}`}
              onChange={(e) => {
                const hex = e.target.value.replace(/^#/, '');
                const n = parseInt(hex, 16);
                if (Number.isFinite(n))
                  onLightChange({ ...light, colour: n });
              }}
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
        </div>
      ) : interactable ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            Hotspot {interactable.id}
          </div>
          <Field label="kind">
            <select
              value={interactable.kind}
              onChange={(e) =>
                onInteractableChange({
                  ...interactable,
                  kind: e.target.value as InteractableT['kind'],
                })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            >
              <option value="extract_pad">extract_pad</option>
              <option value="stairs_down">stairs_down</option>
              <option value="dm_spawn">dm_spawn (deathmatch)</option>
            </select>
          </Field>
          <Field label="label">
            <input
              value={interactable.label}
              onChange={(e) =>
                onInteractableChange({
                  ...interactable,
                  label: e.target.value,
                })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
          <Field label="x · y">
            <div className="flex gap-1">
              <input
                type="number"
                value={interactable.x}
                onChange={(e) =>
                  onInteractableChange({
                    ...interactable,
                    x: Number(e.target.value),
                  })
                }
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
              />
              <input
                type="number"
                value={interactable.y}
                onChange={(e) =>
                  onInteractableChange({
                    ...interactable,
                    y: Number(e.target.value),
                  })
                }
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
              />
            </div>
          </Field>
        </div>
      ) : shape ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            {shape.subtractive ? 'Subtract shape' : 'Shape'} {shape.id}
            {shape.name ? ` — ${shape.name}` : ''}
          </div>
          {!shape.subtractive && (
            <>
              <Field label="floorZ">
                <input
                  type="number"
                  value={shape.floorZ}
                  onChange={(e) =>
                    onShapeChange({ ...shape, floorZ: Number(e.target.value) })
                  }
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
                />
              </Field>
              <Field label="ceilingZ">
                <input
                  type="number"
                  value={shape.ceilingZ}
                  onChange={(e) =>
                    onShapeChange({ ...shape, ceilingZ: Number(e.target.value) })
                  }
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
                />
              </Field>
              <Field label="biomeId">
                <input
                  value={shape.biomeId}
                  onChange={(e) =>
                    onShapeChange({ ...shape, biomeId: e.target.value })
                  }
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
                />
              </Field>
              <Field label="ambient">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="4"
                  value={shape.ambient ?? 1}
                  onChange={(e) =>
                    onShapeChange({ ...shape, ambient: Number(e.target.value) })
                  }
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
                />
              </Field>
            </>
          )}
          <Field label="zOrder">
            <input
              type="number"
              value={shape.zOrder}
              onChange={(e) =>
                onShapeChange({ ...shape, zOrder: Number(e.target.value) })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
          {!shape.subtractive && (
            <>
              <NoiseSection
                label="Floor noise"
                value={shape.floorNoise}
                onChange={(next) =>
                  onShapeChange({ ...shape, floorNoise: next })
                }
              />
              <NoiseSection
                label="Ceiling noise"
                value={shape.ceilingNoise}
                onChange={(next) =>
                  onShapeChange({ ...shape, ceilingNoise: next })
                }
              />
            </>
          )}
          <div className="text-[10px] text-zinc-500 mt-2">
            {shape.outer.length} verts · drag in Adjust to reshape ·
            {shape.subtractive
              ? ' subtractive: removes area from lower-z shapes, emits no sector.'
              : ' higher zOrder wins in overlap regions.'}
          </div>
        </div>
      ) : (
        <div className="text-zinc-500 italic text-[11px]">
          Select a shape, light, or hotspot to edit its properties.
        </div>
      )}
    </aside>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1">
      <label className="block text-[10px] text-zinc-500">{label}</label>
      {children}
    </div>
  );
}

type NoiseCfg = import('@dumrunner/shared').TerrainConfig;

function NoiseSection({
  label,
  value,
  onChange,
}: {
  label: string;
  value: NoiseCfg | undefined;
  onChange: (next: NoiseCfg | undefined) => void;
}) {
  const enabled = !!value;
  return (
    <div className="mt-3 border-t border-zinc-800 pt-2">
      <label className="flex items-center gap-2 text-[11px] text-zinc-300 mb-1">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            if (e.target.checked) {
              onChange({
                // Conservative starter amplitude — floor + ceiling
                // noise both at 3wu still leaves ~26wu standing
                // room in a default 32-ceiling room, above the
                // 24wu player stand height. Crank higher only if
                // your room has more vertical headroom to spare,
                // or you'll get stuck against the implicit
                // head-clearance check on the server.
                amplitude: 3,
                frequency: 1 / 128,
                octaves: 2,
                seed: Math.floor(Math.random() * 0x7fffffff),
              });
            } else {
              onChange(undefined);
            }
          }}
        />
        <span>{label}</span>
      </label>
      {enabled && value && (
        <div className="pl-5 space-y-1">
          <Field label="amplitude (wu peak-to-trough)">
            <input
              type="number"
              step="0.5"
              value={value.amplitude}
              onChange={(e) =>
                onChange({ ...value, amplitude: Number(e.target.value) })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
          <Field label="frequency (1/wu — bigger = tighter hills)">
            <input
              type="number"
              step="0.001"
              value={value.frequency}
              onChange={(e) =>
                onChange({ ...value, frequency: Number(e.target.value) })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
          <Field label="octaves (1–6)">
            <input
              type="number"
              min="1"
              max="6"
              step="1"
              value={value.octaves}
              onChange={(e) =>
                onChange({
                  ...value,
                  octaves: Math.max(1, Math.min(6, Number(e.target.value) | 0)),
                })
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
            />
          </Field>
          <Field label="seed">
            <div className="flex gap-1">
              <input
                type="number"
                value={value.seed}
                onChange={(e) =>
                  onChange({ ...value, seed: Number(e.target.value) | 0 })
                }
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1"
              />
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...value,
                    seed: Math.floor(Math.random() * 0x7fffffff),
                  })
                }
                title="Randomise seed"
                className="text-[11px] px-2 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              >
                🎲
              </button>
            </div>
          </Field>
          <div className="text-[10px] text-zinc-500">
            Falls off to 0 at the polygon perimeter (≈48wu fade) so
            portals stay flush with neighbouring rooms. Floor +
            ceiling combined amplitude must leave at least 24wu
            of headroom or the player can&apos;t walk in.
          </div>
        </div>
      )}
    </div>
  );
}

function pointInRing(
  ring: Array<{ x: number; y: number }>,
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function ringSignedArea(
  ring: Array<{ x: number; y: number }>,
): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s * 0.5;
}

function DiagnosticStrip({
  shapes,
  verts,
  errors,
  warnings,
}: {
  shapes: number;
  verts: number;
  errors: string[];
  warnings: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const issueCount = errors.length + warnings.length;
  const status =
    errors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok';
  const dotColor =
    status === 'error'
      ? 'bg-red-500'
      : status === 'warn'
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  const headline =
    issueCount === 0
      ? 'clean'
      : errors.length > 0
        ? errors[0]
        : warnings[0];
  const canExpand = issueCount > 0;
  return (
    <div className="border-t border-zinc-800 bg-zinc-950/70 text-[11px] text-zinc-400 select-none">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-3 px-3 py-1.5 text-left ${
          canExpand ? 'hover:bg-zinc-900/60 cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className="text-zinc-500">
          {shapes} shapes · {verts} verts
        </span>
        <span
          className={`flex-1 min-w-0 truncate ${
            status === 'error'
              ? 'text-red-300'
              : status === 'warn'
                ? 'text-amber-300'
                : 'text-zinc-500'
          }`}
        >
          {issueCount > 0
            ? `${issueCount} issue${issueCount > 1 ? 's' : ''}: ${headline}`
            : 'no issues'}
        </span>
        {canExpand && (
          <span className="text-zinc-600">{expanded ? '▾' : '▸'}</span>
        )}
      </button>
      {expanded && canExpand && (
        <ul className="px-3 pb-2 space-y-0.5 max-h-48 overflow-y-auto">
          {errors.map((e, i) => (
            <li key={`e${i}`} className="text-red-300 font-mono text-[10px]">
              {e}
            </li>
          ))}
          {warnings.map((w, i) => (
            <li key={`w${i}`} className="text-amber-300 font-mono text-[10px]">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
