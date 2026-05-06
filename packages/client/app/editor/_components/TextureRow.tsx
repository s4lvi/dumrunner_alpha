// Shared texture-upload row. Used by the master texture editor
// (one row per content id) AND inline by the enemy / decorator
// editors so a sprite can be uploaded without leaving the form.
//
// Reads the current override via the textureOverrides subscribe
// pattern; useOverride defers the localStorage / cache read to
// useEffect so the SSR pass and the first client render agree.

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clearOverride,
  fileToDataUrl,
  getOverride,
  setOverride,
  subscribe as subscribeOverrides,
} from '@/lib/textureOverrides';

export function useOverride(category: string, id: string): string | null {
  const [val, setVal] = useState<string | null>(null);
  useEffect(() => {
    setVal(getOverride(category, id));
    return subscribeOverrides(() => setVal(getOverride(category, id)));
  }, [category, id]);
  return val;
}

export function TextureRow({
  category,
  id,
  hideLabel,
}: {
  category: string;
  id: string;
  // When true, drop the per-row id label — caller already has
  // the entity context (e.g. inline in a domain editor's form).
  hideLabel?: boolean;
}) {
  const dataUrl = useOverride(category, id);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(file: File | null) {
    if (!file) return;
    try {
      const url = await fileToDataUrl(file);
      await setOverride(category, id, url);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('texture save failed', e);
    }
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-900">
      <div className="w-10 h-10 rounded border border-zinc-800 bg-zinc-900 flex items-center justify-center overflow-hidden shrink-0">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt={id}
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <span className="text-[9px] text-zinc-600 text-center leading-tight">
            no
            <br />
            texture
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        {!hideLabel && (
          <div className="text-sm font-mono truncate">{id}</div>
        )}
        <div className="flex gap-1 mt-1">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700"
          >
            {dataUrl ? 'Replace' : 'Upload'}
          </button>
          {dataUrl && (
            <button
              type="button"
              onClick={() => {
                void clearOverride(category, id);
              }}
              className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/webp,image/jpeg"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}
