'use client';

// Animation preview sandbox. End-to-end smoke test for Phase B:
// lists every authored AnimationDef, lets the user pick one, then
// drives an AnimationController against the loaded spritesheets
// and renders the current frame in a Pixi canvas.
//
// No game logic — this is the testbed for the engine itself.
// State picker + frame-index readout make timing bugs obvious;
// the Restart button forces a `play(state, { interrupt: true })`
// so non-looping animations (death / fire / reload) can be
// replayed without changing state.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Application,
  Sprite,
  Texture,
} from 'pixi.js';
import type { AnimationDef } from '@dumrunner/shared';
import { AnimationController } from '@dumrunner/shared';
import { listEntities } from '@/lib/editorContentClient';
import {
  loadAnimationDef,
  getStateFrames,
  subscribeAnimations,
} from '@/lib/animations';
import { Button } from '../../_components/Form';

export default function AnimationSandboxPage() {
  const [manifests, setManifests] = useState<AnimationDef[]>([]);
  const [selectedAnimId, setSelectedAnimId] = useState<string | null>(null);
  const [selectedDef, setSelectedDef] = useState<AnimationDef | null>(null);
  const [activeState, setActiveState] = useState<string>('');
  const [frameInfo, setFrameInfo] = useState<{
    state: string;
    frameIndex: number;
    finished: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refresh the manifest list. Also fires on the
  // subscribeAnimations notifier so a cache-invalidation (e.g.
  // texture re-upload) pulls fresh frames.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const list = (await listEntities('animations')) as AnimationDef[];
        if (cancelled) return;
        setManifests(list);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    }
    void refresh();
    const unsub = subscribeAnimations(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Load the selected manifest. Picking a slug fires
  // loadAnimationDef → returns the parsed AnimationDef. Default
  // state is the first authored one (manifest order is whatever
  // Object.keys returns, which is insertion order).
  useEffect(() => {
    if (!selectedAnimId) {
      setSelectedDef(null);
      setActiveState('');
      return;
    }
    let cancelled = false;
    void (async () => {
      const def = await loadAnimationDef(selectedAnimId);
      if (cancelled) return;
      setSelectedDef(def);
      const firstState = def ? Object.keys(def.states)[0] : '';
      setActiveState(firstState ?? '');
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAnimId]);

  return (
    <div className="flex h-full">
      {/* Manifest list */}
      <aside className="w-64 shrink-0 border-r border-zinc-800 bg-zinc-950 overflow-y-auto">
        <div className="px-3 py-2 border-b border-zinc-800">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">
            Animations
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">
            {manifests.length} authored
          </div>
        </div>
        {manifests.length === 0 && (
          <p className="text-xs text-zinc-500 p-3">
            No animation manifests authored yet. Drop a JSON file at{' '}
            <code className="text-zinc-300">
              packages/shared/content/animations/
            </code>{' '}
            and spritesheet PNGs at{' '}
            <code className="text-zinc-300">
              packages/client/public/textures/&lt;category&gt;/&lt;id&gt;/&lt;state&gt;.png
            </code>
            .
          </p>
        )}
        {manifests.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setSelectedAnimId(m.id)}
            className={`w-full text-left px-3 py-1.5 text-xs ${
              selectedAnimId === m.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-900/60'
            }`}
          >
            <div className="font-mono">{m.id}</div>
            <div className="text-[10px] text-zinc-600">
              {Object.keys(m.states).length} state
              {Object.keys(m.states).length === 1 ? '' : 's'}
            </div>
          </button>
        ))}
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        <header className="px-4 py-3 border-b border-zinc-800">
          <h1 className="text-sm font-bold text-zinc-200">
            Animation preview sandbox
          </h1>
          <p className="text-[10px] text-zinc-500 mt-0.5">
            Phase B engine testbed. Pick a manifest on the left, choose a
            state, watch it play. State transitions trigger the same{' '}
            <code className="text-zinc-300">AnimationController</code>{' '}
            consumers will use in Phase C.
          </p>
        </header>

        {error && (
          <div className="mx-4 mt-3 px-3 py-2 rounded bg-red-950/60 border border-red-900 text-red-200 text-xs">
            {error}
          </div>
        )}

        {selectedDef ? (
          <Player
            key={selectedDef.id}
            def={selectedDef}
            activeState={activeState}
            onStateChange={setActiveState}
            onFrame={setFrameInfo}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">
            Select a manifest from the left.
          </div>
        )}

        {frameInfo && (
          <footer className="border-t border-zinc-800 px-4 py-2 text-[10px] text-zinc-500 flex gap-4 font-mono">
            <span>state: {frameInfo.state}</span>
            <span>frame: {frameInfo.frameIndex}</span>
            <span>{frameInfo.finished ? 'finished' : 'playing'}</span>
          </footer>
        )}
      </main>
    </div>
  );
}

// One-off canvas + controller bound to a manifest. Re-mounts on
// def change via parent's `key`, which destroys the prior Pixi
// app cleanly.
function Player({
  def,
  activeState,
  onStateChange,
  onFrame,
}: {
  def: AnimationDef;
  activeState: string;
  onStateChange: (s: string) => void;
  onFrame: (f: { state: string; frameIndex: number; finished: boolean }) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const spriteRef = useRef<Sprite | null>(null);
  const controllerRef = useRef<AnimationController | null>(null);

  // (Re)build the controller when the active state changes. Use
  // interrupt: true so picking the same state again replays it —
  // makes one-shots like 'death' easy to re-trigger.
  useEffect(() => {
    if (!controllerRef.current) {
      controllerRef.current = new AnimationController(def, activeState);
    } else {
      controllerRef.current.play(activeState, { interrupt: true });
    }
  }, [def, activeState]);

  // Pixi app lifecycle. One canvas per Player mount.
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    const app = new Application();
    void (async () => {
      await app.init({
        background: '#0a0a0a',
        resizeTo: container,
        antialias: false,
      });
      if (cancelled) {
        app.destroy(true);
        return;
      }
      container.appendChild(app.canvas);
      const sprite = new Sprite();
      sprite.anchor.set(0.5);
      sprite.x = app.screen.width / 2;
      sprite.y = app.screen.height / 2;
      app.stage.addChild(sprite);
      spriteRef.current = sprite;
      appRef.current = app;
      // Resize sprite centring when the canvas resizes — Pixi
      // doesn't auto-reposition children.
      app.renderer.on('resize', (w: number, h: number) => {
        sprite.x = w / 2;
        sprite.y = h / 2;
      });
      app.ticker.add(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;
        const now = performance.now();
        const frame = ctrl.tick(now);
        const stateDef = def.states[frame.state];
        if (!stateDef) return;
        const frames = getStateFrames(
          def.id,
          frame.state,
          stateDef.frames,
          stateDef.source ?? 'sheet',
        );
        const tex = frames[frame.frameIndex];
        if (tex && sprite.texture !== tex) {
          sprite.texture = tex;
          // Scale to fit 60% of the smaller canvas dimension —
          // keeps small sprites legible without warping aspect.
          const w = app.screen.width;
          const h = app.screen.height;
          const target = Math.min(w, h) * 0.6;
          const texW = tex.width || 1;
          const texH = tex.height || 1;
          const scale = target / Math.max(texW, texH);
          sprite.scale.set(scale);
        } else if (!tex) {
          sprite.texture = Texture.EMPTY;
        }
        onFrame(frame);
      });
    })();
    return () => {
      cancelled = true;
      const a = appRef.current;
      if (a) {
        try {
          a.destroy(true);
        } catch {
          /* swallow */
        }
        appRef.current = null;
      }
      spriteRef.current = null;
      controllerRef.current = null;
    };
    // def change forces a remount (parent passes key={def.id}).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replay only the currently-active state. Useful for one-shots.
  const replay = useMemo(
    () => () => {
      controllerRef.current?.play(activeState, { interrupt: true });
    },
    [activeState],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3">
        <label className="text-[10px] uppercase tracking-wider text-zinc-500">
          State
        </label>
        <select
          value={activeState}
          onChange={(e) => onStateChange(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs"
        >
          {Object.keys(def.states).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Button onClick={replay}>replay</Button>
        <div className="text-[10px] text-zinc-500 ml-auto font-mono">
          {def.category} / {def.name}
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
