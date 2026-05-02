'use client';

import { useEffect, useState } from 'react';
import { audio } from '@/lib/audio';

// Volume slider + mute toggle. Persists to localStorage via the audio
// manager; settings survive across pages and reloads.
export function AudioSettings() {
  // Local mirror of the audio manager so the controls react instantly.
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setVolume(audio.getMasterVolume());
    setMuted(audio.isMuted());
  }, []);

  return (
    <div className="bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-6 space-y-4">
      <label className="block">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-zinc-300">Master volume</span>
          <span className="text-xs text-zinc-500 tabular-nums">
            {Math.round(volume * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            audio.setMasterVolume(v);
          }}
          className="w-full"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={muted}
          onChange={(e) => {
            setMuted(e.target.checked);
            audio.setMuted(e.target.checked);
          }}
        />
        <span>Mute all audio</span>
      </label>

      <p className="text-[11px] text-zinc-500">
        In-game shortcut: <kbd className="px-1.5 py-0.5 rounded bg-[color:var(--bg)] border border-[color:var(--panel-border)] text-[10px]">M</kbd> toggles mute.
      </p>
    </div>
  );
}
