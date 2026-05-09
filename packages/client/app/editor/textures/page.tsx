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
  MATERIALS,
  type BuildingKind,
  type BuildingState,
  type EnemyState,
  type MaterialKind,
  type Player,
  type SceneLayout,
} from '@dumrunner/shared';
import { runGame, type GameHandle, type GameInit } from '@/lib/game/pixi';
import { runFpsGame } from '@/lib/game/fps';
import { runTopdownGame } from '@/lib/game/topdown';
import { listEntities } from '@/lib/editorContentClient';
import { TextureRow } from '../_components/TextureRow';

const BUILDING_KINDS = Object.keys(BUILDING_REGISTRY) as BuildingKind[];
const MATERIAL_KINDS = Object.keys(MATERIALS) as MaterialKind[];

// World-space tile size for the demo scene. Same as the live game
// dungeons so iso scaling reads identically.
const TILE = 32;
// Walking speed (px/sec). Matches COMBAT.PLAYER_MOVE_SPEED so the
// editor's local physics feels the same as the live game.
const WALK_SPEED = 140;
const SPRINT_MULTIPLIER = 1.6;

type RendererMode = 'topdown' | 'fps';
const RENDERER_CYCLE: RendererMode[] = ['fps', 'topdown'];

function runnerFor(mode: RendererMode): typeof runGame {
  return mode === 'fps' ? runFpsGame : runTopdownGame;
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

  const [rendererMode, setRendererMode] = useState<RendererMode>('fps');
  // Content ids load from the JSON content via API so fresh
  // authoring shows up here without a code edit. Single fetch
  // resolves all the lists in parallel.
  const [enemyIds, setEnemyIds] = useState<string[]>([]);
  const [propIds, setPropIds] = useState<string[]>([]);
  const [biomeIds, setBiomeIds] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const [enemies, props, biomes] = await Promise.all([
          listEntities('enemies'),
          listEntities('props'),
          listEntities('biomes'),
        ]);
        setEnemyIds(enemies.map((e) => e.id));
        setPropIds(props.map((p) => p.id));
        setBiomeIds(biomes.map((b) => b.id));
      } catch {
        // No content yet — leave the sections empty.
      }
    })();
  }, []);

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
      enemyKinds: enemyIds,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererMode, enemyIds]);

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
          {enemyIds.length === 0 && (
            <p className="text-[10px] text-zinc-500 px-2">
              No enemies authored yet. Add some at{' '}
              <code className="text-zinc-300">/editor/enemies</code>.
            </p>
          )}
          {enemyIds.map((id) => (
            <TextureRow key={`enemy-${id}`} category="enemy" id={id} />
          ))}
        </Section>
        <Section title="Decorators (front)">
          {propIds.length === 0 && (
            <p className="text-[10px] text-zinc-500 px-2">
              No decorators authored yet. Add some at{' '}
              <code className="text-zinc-300">/editor/props</code>.
            </p>
          )}
          {propIds.map((id) => (
            <TextureRow key={`prop-${id}`} category="prop" id={id} />
          ))}
        </Section>
        <Section title="Decorators (open)">
          <p className="text-[10px] text-zinc-500 px-2 mb-2">
            Container props (E5) swap to these textures once the
            player opens them. Front +{' '}
            <code className="text-zinc-300">prop_open_top</code> top
            both fall back to the closed variants when absent.
          </p>
          {propIds.map((id) => (
            <TextureRow key={`prop_open-${id}`} category="prop_open" id={id} />
          ))}
          {propIds.map((id) => (
            <TextureRow
              key={`prop_open_top-${id}`}
              category="prop_open_top"
              id={id}
            />
          ))}
        </Section>
        <Section title="Decorators (top)">
          {propIds.map((id) => (
            <TextureRow
              key={`prop_top-${id}`}
              category="prop_top"
              id={id}
            />
          ))}
        </Section>
        <Section title="Buildings (front)">
          {BUILDING_KINDS.map((id) => (
            <TextureRow key={`building-${id}`} category="building" id={id} />
          ))}
        </Section>
        <Section title="Buildings (top)">
          {BUILDING_KINDS.map((id) => (
            <TextureRow
              key={`building_top-${id}`}
              category="building_top"
              id={id}
            />
          ))}
        </Section>
        <Section title="Overworld / Base">
          <p className="text-[10px] text-zinc-500 px-2 mb-2">
            Surface scene (no dungeon layout). The renderer looks up
            these under the pseudo-biome id <code className="text-zinc-300">surface</code>.
          </p>
          <div className="text-[10px] text-zinc-500 px-2 mb-1">Floor</div>
          <TextureRow category="biome_floor" id="surface" hideLabel />
          <div className="text-[10px] text-zinc-500 px-2 mt-2 mb-1">
            Skybox (normal)
          </div>
          <TextureRow category="biome_skybox" id="surface" hideLabel />
          <div className="text-[10px] text-zinc-500 px-2 mt-2 mb-1">
            Skybox (perihelion / horde)
          </div>
          <p className="text-[9px] text-zinc-600 px-2 mb-1">
            Renderer swaps to this when the horde is active. Falls
            back to the normal surface skybox if absent.
          </p>
          <TextureRow
            category="biome_skybox"
            id="surface_perihelion"
            hideLabel
          />
        </Section>
        <Section title="Biomes (floor)">
          {biomeIds.length === 0 && (
            <p className="text-[10px] text-zinc-500 px-2">
              No biomes authored yet.
            </p>
          )}
          {biomeIds.map((id) => (
            <TextureRow
              key={`biome_floor-${id}`}
              category="biome_floor"
              id={id}
            />
          ))}
        </Section>
        <Section title="Biomes (ceiling)">
          {biomeIds.map((id) => (
            <TextureRow
              key={`biome_ceiling-${id}`}
              category="biome_ceiling"
              id={id}
            />
          ))}
        </Section>
        <Section title="Biomes (wall)">
          {biomeIds.map((id) => (
            <TextureRow
              key={`biome_wall-${id}`}
              category="biome_wall"
              id={id}
            />
          ))}
        </Section>
        <Section title="Biomes (skybox)">
          {biomeIds.map((id) => (
            <TextureRow
              key={`biome_skybox-${id}`}
              category="biome_skybox"
              id={id}
            />
          ))}
        </Section>
        <Section title="Players">
          <p className="text-[10px] text-zinc-500 px-2 mb-2">
            Billboard sprite shown for other players in the FPS view.
            Same shape as enemy / decorator sprites — full-height,
            clamped UVs, transparent PNG. Falls back to a flat-color
            rect if absent.
          </p>
          <TextureRow category="player" id="default" hideLabel />
        </Section>
        <Section title="Materials">
          {MATERIAL_KINDS.map((id) => (
            <TextureRow key={`material-${id}`} category="material" id={id} />
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

// ---------- demo scene ----------
// One walkable room, the self at the supplied start position
// (preserved across renderer hot-swaps), every enemy kind in a
// row above, every building kind in a row below. Callbacks are
// no-ops or capture into refs since there's no server.
function buildDemoInit({
  startX,
  startY,
  enemyKinds,
  onInput,
}: {
  startX: number;
  startY: number;
  enemyKinds: string[];
  onInput: (mx: number, my: number, sprint: boolean) => void;
}): GameInit {
  const layout: SceneLayout = {
    worldBounds: { x: -2000, y: -2000, w: 4000, h: 4000 },
    walkables: [{ x: -16 * TILE, y: -10 * TILE, w: 32 * TILE, h: 22 * TILE }],
    rooms: [{ x: -16 * TILE, y: -10 * TILE, w: 32 * TILE, h: 22 * TILE }],
    spawn: { x: 0, y: 0 },
    interactables: [],
    tileSize: TILE,
    biome: 'default',
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
  const enemies: EnemyState[] = enemyKinds.map((kind, i) => ({
    id: `editor_enemy_${i}`,
    kind,
    x: (i - (enemyKinds.length - 1) / 2) * TILE * 2,
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
    props: [],
    layout,
    sendInput: (mx, my, sprint) => onInput(mx, my, sprint),
    sendFire: () => {},
    sendBuild: () => {},
    sendDemolish: () => {},
    onNearInteractableChanged: () => {},
    onNearWorkstationsChanged: () => {},
  };
}
