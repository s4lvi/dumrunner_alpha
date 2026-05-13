// Per-frame spritesheet upload row. Mirrors StateTextureRow but
// keys against the frame index — used when an animation state's
// source = 'frames' (one PNG per frame).

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clearFrameOverride,
  fileToDataUrl,
  getFrameOverride,
  setFrameOverride,
  subscribe as subscribeOverrides,
} from '@/lib/textureOverrides';

function useFrameOverride(
  category: string,
  id: string,
  state: string,
  frame: number,
): string | null {
  const [val, setVal] = useState<string | null>(null);
  useEffect(() => {
    setVal(getFrameOverride(category, id, state, frame));
    return subscribeOverrides(() =>
      setVal(getFrameOverride(category, id, state, frame)),
    );
  }, [category, id, state, frame]);
  return val;
}

export function FrameTextureRow({
  category,
  id,
  state,
  frame,
}: {
  category: string;
  id: string;
  state: string;
  frame: number;
}) {
  const dataUrl = useFrameOverride(category, id, state, frame);
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
      await setFrameOverride(category, id, state, frame, url);
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
      await clearFrameOverride(category, id, state, frame);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="w-8 text-[10px] text-zinc-500 font-mono text-right">
        #{frame}
      </div>
      <div className="w-12 h-12 bg-zinc-900 border border-zinc-800 rounded overflow-hidden flex items-center justify-center shrink-0">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt={`${category}/${id}/${state}/${frame}`}
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <span className="text-[9px] text-zinc-600">empty</span>
        )}
      </div>
      <div className="flex-1 flex flex-col gap-0.5">
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
    </div>
  );
}
