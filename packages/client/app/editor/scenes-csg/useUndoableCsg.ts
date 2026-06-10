'use client';

// Undo/redo for the CSG scene editor. The history stack stores
// committed snapshots (immutable CsgScene values). `setScene`
// pushes onto the stack and clears any forward history;
// `setScenePreview` updates the current entry in-place without
// pushing — used during drags so the move-vert gesture collapses
// to one undo entry on pointer-up. `undo`/`redo` move the cursor
// through the stack.
//
// Hotkeys: Cmd/Ctrl-Z = undo, Cmd/Ctrl-Shift-Z = redo. Wired
// separately by the consuming page so input fields can't trigger
// them.

import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_HISTORY = 200;

export function useUndoableCsg<T>(initial: T): {
  scene: T;
  setScene: (next: T) => void;
  setScenePreview: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: (next: T) => void;
} {
  // history[cursor] is the current state. push() truncates
  // history to cursor+1 then appends. undo decrements cursor;
  // redo increments. preview() replaces history[cursor] in
  // place without changing the cursor.
  const [history, setHistory] = useState<T[]>([initial]);
  const [cursor, setCursor] = useState(0);

  const setScene = useCallback(
    (next: T) => {
      setHistory((h) => {
        const trimmed = h.slice(0, cursor + 1);
        const out = [...trimmed, next];
        if (out.length > MAX_HISTORY) {
          out.splice(0, out.length - MAX_HISTORY);
        }
        return out;
      });
      setCursor((c) =>
        Math.min(MAX_HISTORY - 1, c + 1),
      );
    },
    [cursor],
  );

  const setScenePreview = useCallback((next: T) => {
    setHistory((h) => {
      const out = h.slice();
      out[out.length === 0 ? 0 : out.length - 1] = next;
      return out;
    });
  }, []);

  const undo = useCallback(() => {
    setCursor((c) => Math.max(0, c - 1));
  }, []);
  const redo = useCallback(() => {
    setCursor((c) => Math.min(history.length - 1, c + 1));
  }, [history.length]);

  const reset = useCallback((next: T) => {
    setHistory([next]);
    setCursor(0);
  }, []);

  return {
    scene: history[cursor] ?? initial,
    setScene,
    setScenePreview,
    undo,
    redo,
    canUndo: cursor > 0,
    canRedo: cursor < history.length - 1,
    reset,
  };
}

export function useUndoHotkeys(
  undo: () => void,
  redo: () => void,
): void {
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  undoRef.current = undo;
  redoRef.current = redo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redoRef.current();
      else undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
