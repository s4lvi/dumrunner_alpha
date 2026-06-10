'use client';

// Scene list sidebar. Mirrors the other editor entity lists
// (rooms / corridors / biomes) — fetch the area from
// /api/editor/content/scenes, render one button per scene,
// highlight the selected one, plus a "+ new" action.
// Each row has a trash icon — confirm-then-delete via a modal
// (replaces the older window.confirm flow).

import { useEffect, useState } from 'react';
import type { FloorOverrides, SceneDef } from '@dumrunner/shared';
import { deleteEntity, listEntities } from '@/lib/editorContentClient';

type Props = {
  selectedId: string | null;
  onSelect: (scene: SceneDef) => void;
  onNew: () => void;
  // Called when the currently-loaded scene gets deleted, so the
  // page can drop it from the canvas + reset selection.
  onDeleted: (id: string) => void;
  // Bumps whenever the page saves — sidebar refetches so the new
  // entry appears in the list without a route reload.
  reloadKey: number;
};

export function SceneList({
  selectedId,
  onSelect,
  onNew,
  onDeleted,
  reloadKey,
}: Props) {
  const [entries, setEntries] = useState<SceneDef[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Local bump so a delete re-fetches the list without waiting
  // for the next save.
  const [localReload, setLocalReload] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<SceneDef | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<FloorOverrides>({});
  const [pinTarget, setPinTarget] = useState<SceneDef | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listEntities('scenes'),
      fetch('/api/editor/floor-overrides').then((r) => r.json()),
    ])
      .then(([rows, ov]) => {
        if (cancelled) return;
        setEntries(rows);
        setOverrides(ov && typeof ov === 'object' ? (ov as FloorOverrides) : {});
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, localReload]);

  // Reverse-map: sceneId → list of pinned floor indices (global
  // scope only — per-server pinning is post-MVP).
  const pinnedFloors = new Map<string, number[]>();
  for (const [floorStr, sceneId] of Object.entries(overrides.global ?? {})) {
    const floor = Number(floorStr);
    if (!Number.isFinite(floor)) continue;
    const list = pinnedFloors.get(sceneId) ?? [];
    list.push(floor);
    pinnedFloors.set(sceneId, list);
  }

  async function applyPin(sceneId: string, floor: number | null) {
    // Build the next overrides object — null means "unpin every
    // floor currently pinned to this scene id."
    const nextGlobal: Record<string, string> = {
      ...(overrides.global ?? {}),
    };
    if (floor === null) {
      for (const [k, v] of Object.entries(nextGlobal)) {
        if (v === sceneId) delete nextGlobal[k];
      }
    } else {
      nextGlobal[String(floor)] = sceneId;
    }
    const next: FloorOverrides = {
      ...overrides,
      global: nextGlobal,
    };
    try {
      const res = await fetch('/api/editor/floor-overrides', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const saved = (await res.json()) as FloorOverrides;
      setOverrides(saved);
      setPinTarget(null);
    } catch (e) {
      window.alert(`Pin failed: ${(e as Error).message}`);
    }
  }

  // Esc closes the confirm modal.
  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingDelete(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDelete]);

  function openDeleteModal(scene: SceneDef, e: React.MouseEvent) {
    e.stopPropagation();
    setDeleteErr(null);
    setPendingDelete(scene);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const scene = pendingDelete;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteEntity('scenes', scene.id);
      if (selectedId === scene.id) onDeleted(scene.id);
      setLocalReload((n) => n + 1);
      setPendingDelete(null);
    } catch (err) {
      setDeleteErr((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <aside className="w-56 shrink-0 border-r border-zinc-800 bg-zinc-900/40 overflow-y-auto p-2 space-y-1">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          scenes
        </span>
        <button
          onClick={onNew}
          className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-300"
        >
          + new
        </button>
      </div>
      {err && (
        <div className="text-[11px] text-red-400 px-1">{err}</div>
      )}
      {entries.length === 0 && !err && (
        <div className="text-[11px] text-zinc-600 px-1 italic">
          No scenes yet. Click "+ new" to start.
        </div>
      )}
      {entries.map((s) => {
        const isSel = selectedId === s.id;
        const pinned = pinnedFloors.get(s.id) ?? [];
        return (
          <div
            key={s.id}
            className={`group flex items-stretch rounded ${
              isSel ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
            }`}
          >
            <button
              onClick={() => onSelect(s)}
              className={`flex-1 min-w-0 text-left text-xs px-2 py-1.5 ${
                isSel ? 'text-zinc-100' : 'text-zinc-400'
              }`}
            >
              <div className="text-zinc-200 truncate flex items-center gap-1">
                {s.name}
                {pinned.length > 0 && (
                  <span
                    className="text-[10px] text-amber-300 bg-amber-900/40 border border-amber-700/60 rounded px-1 leading-tight"
                    title={`Pinned to floor${pinned.length > 1 ? 's' : ''} ${pinned.join(', ')}`}
                  >
                    📌 {pinned.join(',')}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-zinc-500 truncate">
                {s.id} · {sceneShapeOrSectorCount(s)}
              </div>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPinTarget(s);
              }}
              title={`Pin "${s.id}" to a dungeon floor`}
              className="px-2 text-zinc-600 hover:text-amber-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            >
              📌
            </button>
            <button
              onClick={(e) => openDeleteModal(s, e)}
              title={`Delete ${s.id}`}
              className="px-2 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            >
              ✕
            </button>
          </div>
        );
      })}
      {pinTarget && (
        <PinModal
          scene={pinTarget}
          currentPinned={pinnedFloors.get(pinTarget.id) ?? []}
          onCancel={() => setPinTarget(null)}
          onApply={(floor) => applyPin(pinTarget.id, floor)}
        />
      )}
      {pendingDelete && (
        <DeleteConfirmModal
          scene={pendingDelete}
          deleting={deleting}
          error={deleteErr}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </aside>
  );
}

function sceneShapeOrSectorCount(s: SceneDef): string {
  if ('kind' in s && s.kind === 'csg') {
    return `${s.shapes.length} shapes`;
  }
  const withMap = s as { map?: { sectors?: unknown[] } };
  return `${withMap.map?.sectors?.length ?? 0} sectors`;
}

function PinModal({
  scene,
  currentPinned,
  onCancel,
  onApply,
}: {
  scene: SceneDef;
  currentPinned: number[];
  onCancel: () => void;
  onApply: (floor: number | null) => void;
}) {
  const [floor, setFloor] = useState<string>(
    currentPinned[0] !== undefined ? String(currentPinned[0]) : '1',
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-5 w-[min(440px,90vw)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-zinc-100 text-sm font-medium mb-1">
          Pin scene to floor
        </div>
        <div className="text-zinc-400 text-xs mb-3">
          <span className="text-zinc-200">{scene.name}</span>
          <span className="text-zinc-500"> · {scene.id}</span>
          <div className="mt-2">
            When this dungeon floor loads, the server uses this
            authored scene instead of running procgen. Pin
            persists across perihelion (it's the dungeon's
            skeleton, not a per-cycle reroll).
          </div>
        </div>
        {currentPinned.length > 0 && (
          <div className="text-[11px] text-amber-300 mb-3">
            Currently pinned to floor{currentPinned.length > 1 ? 's' : ''}{' '}
            {currentPinned.join(', ')}.
          </div>
        )}
        <label className="block text-[10px] text-zinc-500 mb-1">
          Floor index
        </label>
        <input
          type="number"
          value={floor}
          onChange={(e) => setFloor(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs"
          autoFocus
        />
        <div className="flex items-center justify-end gap-2 mt-4">
          {currentPinned.length > 0 && (
            <button
              onClick={() => onApply(null)}
              className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 mr-auto"
            >
              Unpin all
            </button>
          )}
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const n = Number(floor);
              if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
                window.alert('Floor must be a non-negative integer.');
                return;
              }
              onApply(n);
            }}
            className="text-xs px-3 py-1.5 rounded border border-amber-700 bg-amber-900/40 text-amber-100 hover:bg-amber-900/60"
          >
            Pin
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({
  scene,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  scene: SceneDef;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-5 w-[min(440px,90vw)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-zinc-100 text-sm font-medium mb-1">
          Delete scene?
        </div>
        <div className="text-zinc-400 text-xs mb-4">
          <span className="text-zinc-200">{scene.name}</span>
          <span className="text-zinc-500"> · {scene.id}</span>
          <div className="mt-2">
            This removes the file from disk and can't be undone.
          </div>
        </div>
        {error && (
          <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded px-2 py-1 mb-3">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            autoFocus
            className="text-xs px-3 py-1.5 rounded border border-red-700 bg-red-900/40 text-red-200 hover:bg-red-900/60 disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
