'use client';

// Texture editor. Mounts a renderer (iso/top-down/fps) against a
// hand-built demo scene (no WS, no auth, no game session) so the
// developer can drop PNG/WEBP files into local-storage-backed
// texture overrides and immediately see them rendered in-game.
// Bypasses the asset_gen pipeline entirely (see lib/textureOverrides).
//
// Asset categories supported:
//   • enemy    — keyed by EnemyKind id (chaser_melee, brute_chaser…)
//   • building — keyed by BuildingKind id (wall, forge, weapon_bench…)
//
// Adding a new category later is two lines: a new section in the
// side panel + a renderer call to getOverrideTexture('<cat>', id).
//
// Keys: WASD to walk (local physics, no server), V cycles through
// renderers (iso → top-down → FPS). The editor owns the player's
// world position itself; on each frame it advances by input × speed
// × dt and pushes the new position into the renderer via movePlayer.

import { useEffect, useRef, useState } from 'react';
import {
  BUILDING_REGISTRY,
  ENEMY_VISUALS,
  type BuildingKind,
  type BuildingState,
  type EnemyState,
  type Player,
  type SceneLayout,
} from '@dumrunner/shared';
import { runGame, type GameHandle, type GameInit } from '@/lib/game/pixi';
import { runIsoGame } from '@/lib/game/iso';
import { runFpsGame } from '@/lib/game/fps';
import {
  clearOverride,
  fileToDataUrl,
  getOverride,
  setOverride,
  subscribe as subscribeOverrides,
} from '@/lib/textureOverrides';

const ENEMY_KINDS = Object.keys(ENEMY_VISUALS);
const BUILDING_KINDS = Object.keys(BUILDING_REGISTRY) as BuildingKind[];

// World-space tile size for the demo scene. Same as the live game
// dungeons so iso scaling reads identically.
const TILE = 32;
// Walking speed (px/sec). Matches COMBAT.PLAYER_MOVE_SPEED so the
// editor's local physics feels the same as the live game.
const WALK_SPEED = 220;
const SPRINT_MULTIPLIER = 1.6;

type RendererMode = 'iso' | 'topdown' | 'fps';
const RENDERER_CYCLE: RendererMode[] = ['iso', 'topdown', 'fps'];

function runnerFor(mode: RendererMode): typeof runGame {
  return mode === 'fps' ? runFpsGame : mode === 'iso' ? runIsoGame : runGame;
}

const SELF_ID = 'editor_self';

export default function EditorPage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameHandle | null>(null);
  // Local self position, advanced by the physics RAF. Persists
  // across renderer hot-swaps so V-cycling doesn't teleport.
  const selfPosRef = useRef({ x: 0, y: 0 });
  // Latest movement intent. Captured by the demo init's sendInput
  // callback (renderer pushes input here as if to a real server).
  const inputRef = useRef({ mx: 0, my: 0, sprint: false });

  const [rendererMode, setRendererMode] = useState<RendererMode>('iso');

  // V cycles through renderers. Listening at window level so the
  // canvas not having focus doesn't swallow the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setRendererMode((m) => {
          const i = RENDERER_CYCLE.indexOf(m);
          return RENDERER_CYCLE[(i + 1) % RENDERER_CYCLE.length];
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Mount the active renderer with the demo scene. Re-runs when
  // rendererMode flips; previous instance is destroyed first.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const init = buildDemoInit({
      startX: selfPosRef.current.x,
      startY: selfPosRef.current.y,
      onInput: (mx, my, sprint) => {
        inputRef.current = { mx, my, sprint };
      },
    });
    const runner = runnerFor(rendererMode);
    gameRef.current = runner(host, init);
    return () => {
      gameRef.current?.destroy();
      gameRef.current = null;
    };
  }, [rendererMode]);

  // Local physics: advance selfPos by intent × speed × dt and push
  // into the renderer via movePlayer. The renderer handles its own
  // camera-follow off selfX/selfY when movePlayer fires for self.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { mx, my, sprint } = inputRef.current;
      if (mx !== 0 || my !== 0) {
        const len = Math.hypot(mx, my) || 1;
        const speed = sprint ? WALK_SPEED * SPRINT_MULTIPLIER : WALK_SPEED;
        selfPosRef.current.x += (mx / len) * speed * dt;
        selfPosRef.current.y += (my / len) * speed * dt;
        gameRef.current?.movePlayer(
          SELF_ID,
          selfPosRef.current.x,
          selfPosRef.current.y,
        );
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex h-full w-full bg-zinc-950 text-zinc-100">
      <aside className="w-80 shrink-0 border-r border-zinc-800 overflow-y-auto p-4 space-y-6">
        <header>
          <h1 className="text-lg font-bold">Texture Editor</h1>
          <p className="text-xs text-zinc-400 mt-1">
            Upload PNG/WEBP to verify in the demo scene. Saved to{' '}
            <code className="text-zinc-300">public/textures/</code> in
            the repo — commit to share / persist.
          </p>
          <p className="text-[10px] text-zinc-500 mt-2">
            Active: <span className="text-zinc-300">{rendererMode}</span>
            <span className="text-zinc-600"> · V to cycle</span>
          </p>
        </header>
        <Section title="Enemies">
          {ENEMY_KINDS.map((id) => (
            <TextureRow key={`enemy-${id}`} category="enemy" id={id} />
          ))}
        </Section>
        <Section title="Buildings">
          {BUILDING_KINDS.map((id) => (
            <TextureRow key={`building-${id}`} category="building" id={id} />
          ))}
        </Section>
      </aside>
      <main className="flex-1 relative overflow-hidden">
        <div ref={hostRef} className="absolute inset-0" />
        <div className="absolute top-2 left-1/2 -translate-x-1/2 text-xs text-zinc-400 bg-zinc-900/70 px-3 py-1 rounded border border-zinc-800 pointer-events-none select-none">
          {rendererMode} · WASD walk · V cycles renderers
        </div>
      </main>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
        {title}
      </h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

// Reads the current override after mount to avoid a hydration
// mismatch: localStorage isn't available during SSR, so reading
// it inside render returns null on the server but the real value
// on the client's first render — React flags the diff. Deferring
// to useEffect makes both passes start at null, then re-render
// with the value once we're on the client.
function useOverride(category: string, id: string): string | null {
  const [val, setVal] = useState<string | null>(null);
  useEffect(() => {
    setVal(getOverride(category, id));
    return subscribeOverrides(() => setVal(getOverride(category, id)));
  }, [category, id]);
  return val;
}

function TextureRow({ category, id }: { category: string; id: string }) {
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
        <div className="text-sm font-mono truncate">{id}</div>
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

// ---------- demo scene ----------
// One walkable room, the self at the supplied start position
// (preserved across renderer hot-swaps), every enemy kind in a
// row above, every building kind in a row below. Callbacks are
// no-ops or capture into refs since there's no server.
function buildDemoInit({
  startX,
  startY,
  onInput,
}: {
  startX: number;
  startY: number;
  onInput: (mx: number, my: number, sprint: boolean) => void;
}): GameInit {
  const layout: SceneLayout = {
    worldBounds: { x: -2000, y: -2000, w: 4000, h: 4000 },
    walkables: [{ x: -16 * TILE, y: -10 * TILE, w: 32 * TILE, h: 22 * TILE }],
    rooms: [{ x: -16 * TILE, y: -10 * TILE, w: 32 * TILE, h: 22 * TILE }],
    spawn: { x: 0, y: 0 },
    interactables: [],
    tileSize: TILE,
  };
  const self: Player = {
    characterId: SELF_ID,
    accountId: 'editor',
    displayName: 'editor',
    x: startX,
    y: startY,
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
    shield: 0,
    maxShield: 0,
    alive: true,
  };
  const enemies: EnemyState[] = ENEMY_KINDS.map((kind, i) => ({
    id: `editor_enemy_${i}`,
    kind,
    x: (i - (ENEMY_KINDS.length - 1) / 2) * TILE * 2,
    y: -6 * TILE,
    hp: 30,
    maxHp: 30,
  }));
  const buildings: BuildingState[] = BUILDING_KINDS.map((kind, i) => ({
    id: `editor_building_${i}`,
    kind,
    tileX: Math.round((i - (BUILDING_KINDS.length - 1) / 2) * 2),
    tileY: 5,
    width: 1,
    height: 1,
    hp: 100,
    maxHp: 100,
  }));

  return {
    self,
    others: [],
    enemies,
    projectiles: [],
    loot: [],
    corpses: [],
    buildings,
    layout,
    sendInput: (mx, my, sprint) => onInput(mx, my, sprint),
    sendFire: () => {},
    sendBuild: () => {},
    sendDemolish: () => {},
    onNearInteractableChanged: () => {},
    onNearWorkstationsChanged: () => {},
  };
}
