// Buildings editor. Lists every BuildingKind from the hardcoded
// BUILDING_REGISTRY and lets the author bind each one to a
// library animation. The structural metadata (HP, station flags,
// horde priority) stays in code because it shapes server
// behaviour; this page only touches presentation overrides.
//
// Saving is per-row — picking an animation POSTs a single
// BuildingOverride JSON to /api/editor/content/buildings/<kind>.
// Selecting "(none)" deletes the override file so the kind
// resolves to its plain texture again.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BUILDING_REGISTRY,
  type BuildingKind,
  type BuildingOverride,
} from '@dumrunner/shared';
import {
  deleteEntity,
  listEntities,
  saveEntity,
} from '@/lib/editorContentClient';
import { AnimationPicker } from '../_components/AnimationPicker';

export default function BuildingsEditorPage() {
  // Map of kind → currently-saved animationId. Populated on mount,
  // mutated optimistically on save so the dropdown reflects the
  // pending value without waiting for a re-fetch.
  const [overrides, setOverrides] = useState<
    Record<string, string | undefined>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = (await listEntities(
          'buildings',
        )) as BuildingOverride[];
        if (cancelled) return;
        const next: Record<string, string | undefined> = {};
        for (const e of entries) next[e.id] = e.animationId;
        setOverrides(next);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sort kinds by display label so the list is scannable. Falls
  // back to the raw kind id when label is the kind itself
  // (some pre-Phase-2 entries weren't given a friendly label).
  const rows = useMemo(() => {
    const out: { kind: BuildingKind; label: string }[] = [];
    for (const k of Object.keys(BUILDING_REGISTRY) as BuildingKind[]) {
      out.push({ kind: k, label: BUILDING_REGISTRY[k].label });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, []);

  const onPick = useCallback(
    async (kind: BuildingKind, animationId: string | undefined) => {
      setPending((p) => ({ ...p, [kind]: true }));
      setError(null);
      // Optimistic — keep the UI responsive; revert on save error.
      const prev = overrides[kind];
      setOverrides((o) => ({ ...o, [kind]: animationId }));
      try {
        if (!animationId) {
          // Clearing the picker deletes the override file. Absent
          // file = no override = no animation, which is the
          // cleanest representation on disk.
          await deleteEntity('buildings', kind);
        } else {
          await saveEntity('buildings', { id: kind, animationId });
        }
      } catch (e) {
        setOverrides((o) => ({ ...o, [kind]: prev }));
        setError((e as Error).message);
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[kind];
          return next;
        });
      }
    },
    [overrides],
  );

  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-zinc-100">Buildings</h2>
        <p className="text-[11px] text-zinc-500 mt-1 leading-snug max-w-xl">
          Bind a library animation to each BuildingKind. The renderer
          drives every face of every instance off the current frame
          when an animation is set, falling back to the static{' '}
          <code className="text-zinc-300">building/&lt;kind&gt;</code>{' '}
          texture otherwise. Structural metadata (HP, station flags,
          horde priority) lives in code at{' '}
          <code className="text-zinc-300">
            packages/shared/src/buildings.ts
          </code>
          .
        </p>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded border border-red-900 bg-red-950/50 text-xs text-red-300 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <div className="space-y-1.5 max-w-xl">
          {rows.map((r) => (
            <div
              key={r.kind}
              className="flex items-center gap-3 px-3 py-2 rounded border border-zinc-800 bg-zinc-900/40"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-zinc-200 truncate">
                  {r.label}
                </div>
                <div className="text-[10px] text-zinc-500 truncate">
                  {r.kind}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <AnimationPicker
                  label=""
                  category="prop"
                  value={overrides[r.kind]}
                  onChange={(v) => void onPick(r.kind, v)}
                  hint={
                    pending[r.kind]
                      ? 'Saving…'
                      : 'Animation library (prop category — idle / destroy states).'
                  }
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
