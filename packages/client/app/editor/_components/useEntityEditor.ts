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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { z } from 'zod';
import {
  listEntitiesWithMtimes,
  saveEntity,
  deleteEntity,
  type EntityMtimes,
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
  createNew: (id?: string) => boolean;
  error: string | null;
  setError: (e: string | null) => void;
  saving: boolean;
  validationError: string | null;
  canSave: boolean;
};

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

export type EntityEditorOptions<T extends { id: string }> = {
  makeBlank: (id: string) => T;
  newIdPrefix?: string;
  beforeSave?: (draft: T) => T;
  // Optional Zod schema. When provided, the draft is parsed on
  // every change and the first issue's message surfaces as
  // `validationError`; save is gated through `canSave`.
  schema?: z.ZodType<T>;
};

export function useEntityEditor<T extends { id: string }>(
  area: EditorArea,
  options: EntityEditorOptions<T>,
): EntityEditorState<T> {
  const [entries, setEntries] = useState<T[]>([]);
  const [mtimes, setMtimes] = useState<EntityMtimes>({});
  const [selectedId, setSelectedIdRaw] = useState<string | null>(null);
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Stable ref so refresh() doesn't capture a stale selectedId.
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  // Dirty = the in-flight draft differs from the saved version of
  // the selected entry. Cheap structural compare via stringify;
  // entity payloads are small.
  const selectedEntry = selectedId
    ? entries.find((e) => e.id === selectedId) ?? null
    : null;
  const dirty =
    draft !== null &&
    selectedEntry !== null &&
    JSON.stringify(draft) !== JSON.stringify(selectedEntry);

  // Guarded selection swap — confirm before discarding dirty edits.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const setSelectedId = useCallback((next: string | null) => {
    if (dirtyRef.current && next !== selectedIdRef.current) {
      if (!confirm('Discard unsaved changes?')) return;
    }
    setSelectedIdRaw(next);
  }, []);

  // Browser-level guard for tab close / refresh / navigation.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Cmd/Ctrl-S → save. Stable ref so the listener picks up the
  // latest closure (save changes on every draft mutation).
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { entries: r, mtimes: m } = await listEntitiesWithMtimes(
        area as 'biomes',
      );
      setEntries(r as unknown as T[]);
      setMtimes(m);
      const sel = selectedIdRef.current;
      if (sel && !(r as unknown as T[]).some((e) => e.id === sel)) {
        setSelectedIdRaw(null);
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
      setSelectedIdRaw(urlId);
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

  const save: () => Promise<boolean> = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setSaving(true);
    setError(null);
    try {
      const payload = options.beforeSave ? options.beforeSave(draft) : draft;
      const ifMatch = mtimes[selectedIdRef.current ?? ''];
      await saveEntity(area as 'biomes', payload as never, ifMatch);
      await refresh();
      setSelectedIdRaw(payload.id);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      // 409 surfaces from the server with a "changed on disk"
      // message. Offer a reload — accept = pull the latest version
      // into the draft (loses unsaved edits).
      if (/changed on disk/i.test(msg)) {
        if (confirm('File changed on disk. Reload (discard edits)?')) {
          await refresh();
        }
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [area, draft, mtimes, options, refresh]);
  saveRef.current = save;

  const remove = useCallback(async (): Promise<boolean> => {
    const id = selectedId;
    if (!id) return false;
    try {
      await deleteEntity(area as 'biomes', id);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, [area, refresh, selectedId]);

  const createNew = useCallback(
    (id?: string): boolean => {
      const prefix = options.newIdPrefix ?? area.replace(/s$/, '');
      const requested = (id ?? '').trim().toLowerCase();
      const finalId = requested.length > 0
        ? requested
        : `${prefix}_${Date.now().toString(36)}`;
      if (!ID_PATTERN.test(finalId)) {
        setError(`Invalid id "${finalId}" — use lowercase letters, digits, _ or -.`);
        return false;
      }
      if (entries.some((e) => e.id === finalId)) {
        setError(`"${finalId}" already exists.`);
        return false;
      }
      if (dirtyRef.current) {
        if (!confirm('Discard unsaved changes?')) return false;
      }
      const blank = options.makeBlank(finalId);
      setEntries((cur) => [...cur, blank]);
      setSelectedIdRaw(finalId);
      setError(null);
      return true;
    },
    [area, entries, options],
  );

  const validationError = useMemo<string | null>(() => {
    if (!draft || !options.schema) return null;
    const result = options.schema.safeParse(draft);
    if (result.success) return null;
    const first = result.error.issues[0];
    if (!first) return 'invalid';
    const path = first.path.join('.');
    return path ? `${path}: ${first.message}` : first.message;
  }, [draft, options.schema]);

  const canSave = !saving && !validationError && draft !== null;

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
    validationError,
    canSave,
  };
}
