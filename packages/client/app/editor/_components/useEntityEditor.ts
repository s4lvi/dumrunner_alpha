'use client';

// Shared state plumbing for every per-entity editor page (biomes,
// enemies, props, rooms). Lifts the duplicated useState +
// useEffect + save/delete/refresh boilerplate out of each page so
// adding a new entity type is just `useEntityEditor('thing', ...)`
// + a layout. Each page keeps full control of its own layout —
// some have right-side panels, some have edit/preview tabs, some
// don't — so the hook deliberately doesn't render anything.
//
// The "draft" model: the user's in-flight edits live in `draft`,
// which is a structuredClone of the selected entry. Saving writes
// `draft` back through the content API and refreshes the list.
// Renaming the id is handled — after a save we re-select the
// (possibly-renamed) draft.id.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  listEntities,
  saveEntity,
  deleteEntity,
} from '@/lib/editorContentClient';
import type { EditorArea } from '@dumrunner/shared/content/loader';

export type EntityEditorState<T extends { id: string }> = {
  entries: T[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  draft: T | null;
  setDraft: (next: T | null) => void;
  refresh: () => Promise<void>;
  save: () => Promise<boolean>;
  remove: () => Promise<boolean>;
  createNew: () => void;
  error: string | null;
  setError: (e: string | null) => void;
  saving: boolean;
};

export type EntityEditorOptions<T extends { id: string }> = {
  // Called when the user clicks "+ new". Returns a fresh entity
  // with a unique-ish id seeded from the area name + a timestamp
  // suffix; pages can override the seed by passing makeBlank that
  // takes their own id.
  makeBlank: (id: string) => T;
  // Override the auto-generated new entity id prefix. Defaults to
  // the area name (e.g. 'biome_<ts>' or 'enemy_<ts>').
  newIdPrefix?: string;
  // Hook called BEFORE save so pages can inject computed fields
  // (e.g. rooms editor derives entrySides from anchor positions).
  // Returning the input unchanged is the no-op.
  beforeSave?: (draft: T) => T;
};

export function useEntityEditor<T extends { id: string }>(
  area: EditorArea,
  options: EntityEditorOptions<T>,
): EntityEditorState<T> {
  const [entries, setEntries] = useState<T[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Stable ref so refresh() doesn't capture a stale selectedId
  // (the closure runs against the value at refresh-time, not at
  // hook-invocation-time).
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const refresh = useCallback(async () => {
    try {
      const r = (await listEntities(area as 'biomes')) as unknown as T[];
      setEntries(r);
      const sel = selectedIdRef.current;
      if (sel && !r.some((e) => e.id === sel)) {
        setSelectedId(null);
        setDraft(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [area]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // URL ?id sync — when the editor's tree links to
  // /editor/<area>?id=<id>, that id wins as the selection. Updates
  // when the query changes (e.g. tree click) or on initial mount.
  const searchParams = useSearchParams();
  const urlId = searchParams.get('id');
  useEffect(() => {
    if (urlId && urlId !== selectedIdRef.current) {
      setSelectedId(urlId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlId]);

  // Snapshot the selected entry into the draft on selection swap.
  useEffect(() => {
    if (selectedId === null) {
      setDraft(null);
      return;
    }
    const found = entries.find((e) => e.id === selectedId);
    if (found) setDraft(structuredClone(found));
  }, [selectedId, entries]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setSaving(true);
    setError(null);
    try {
      const payload = options.beforeSave ? options.beforeSave(draft) : draft;
      // The content client is typed per-area; areas other than
      // 'biomes' work the same way at runtime so we cast through
      // unknown for the generic call.
      await saveEntity(area as 'biomes', payload as never);
      await refresh();
      // After a save the entry's id may have been renamed via
      // form edit — re-select on the (possibly new) id so the
      // form stays open on the just-saved entity.
      setSelectedId(payload.id);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [area, draft, options, refresh]);

  const remove = useCallback(async (): Promise<boolean> => {
    const id = selectedId;
    if (!id) return false;
    if (!confirm(`Delete ${area.replace(/s$/, '')} "${id}"?`)) return false;
    try {
      await deleteEntity(area as 'biomes', id);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, [area, refresh, selectedId]);

  const createNew = useCallback(() => {
    const prefix = options.newIdPrefix ?? area.replace(/s$/, '');
    const id = `${prefix}_${Date.now().toString(36)}`;
    const blank = options.makeBlank(id);
    setEntries((cur) => [...cur, blank]);
    setSelectedId(id);
  }, [area, options]);

  return {
    entries,
    selectedId,
    setSelectedId,
    draft,
    setDraft,
    refresh,
    save,
    remove,
    createNew,
    error,
    setError,
    saving,
  };
}
