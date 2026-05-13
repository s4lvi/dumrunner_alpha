// Per-state spritesheet upload row. Mirrors TextureRow but
// stores the asset under <category>/<id>/<state>.<ext> via the
// state-aware override helpers.

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clearStateOverride,
  fileToDataUrl,
  getStateOverride,
  setStateOverride,
  subscribe as subscribeOverrides,
} from '@/lib/textureOverrides';

function useStateOverride(
  category: string,
  id: string,
  state: string,
): string | null {
  const [val, setVal] = useState<string | null>(null);
  useEffect(() => {
    setVal(getStateOverride(category, id, state));
    return subscribeOverrides(() =>
      setVal(getStateOverride(category, id, state)),
    );
  }, [category, id, state]);
  return val;
}

export function StateTextureRow({
  category,
  id,
  state,
  hint,
}: {
  category: string;
  id: string;
  state: string;
  /** Short caption shown next to the state name. Optional. */
  hint?: string;
}) {
  const dataUrl = useStateOverride(category, id, state);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const url = await fileToDataUrl(f);
      await setStateOverride(category, id, state, url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  async function onClear() {
    setBusy(true);
    setError(null);
    try {
      await clearStateOverride(category, id, state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="w-24 text-[11px] text-zinc-400 font-mono">{state}</div>
      <div className="w-20 h-12 bg-zinc-900 border border-zinc-800 rounded overflow-hidden flex items-center justify-center">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt={`${category}/${id}/${state}`}
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <span className="text-[9px] text-zinc-600">no sheet</span>
        )}
      </div>
      <div className="flex flex-col gap-1 text-[10px]">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp,image/jpeg"
          onChange={onPick}
          disabled={busy}
          className="text-[10px] text-zinc-400"
        />
        {dataUrl && (
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="text-[10px] text-zinc-500 hover:text-red-400 self-start"
          >
            clear
          </button>
        )}
        {error && (
          <span className="text-[10px] text-red-400">{error}</span>
        )}
      </div>
      {hint && (
        <div className="text-[10px] text-zinc-500 flex-1">{hint}</div>
      )}
    </div>
  );
}
