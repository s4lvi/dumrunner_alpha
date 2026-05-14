'use client';

// Embedded sandbox preview. Owns a sandbox WS connection and an
// iso/FPS renderer pinned to it. Connection survives renderer
// swaps (mode toggle just destroys + rebuilds the renderer with
// the cached latest scene state); spawned enemies / regenerated
// floors persist across iso ↔ fps switches.
//
// Layout:
//   - Connection effect (mount-once): opens sandbox WS, streams
//     server messages, caches latest scene snapshot, applies
//     deltas to whatever renderer is currently mounted.
//   - Renderer effect (mode-dep): destroys old renderer, mounts
//     new one against the cached scene snapshot. WS is untouched.
//
// sendInput / sendFire callbacks read sandboxRef.current at call
// time so a renderer mounted before connection-ready still works
// once the connection arrives — they no-op until then.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { ServerMessage } from '@dumrunner/shared';
import {
  decodeTileGrid,
  isWalkableTileId,
  setAttachmentRegistry,
  setBiomePalettes,
  setBlueprintCatalog,
  setEnemyVisuals,
  setPropVisuals,
  setBuildingVisuals,
  setRecipes,
  setWeaponRegistry,
  tileIdAt,
} from '@dumrunner/shared';
import { runFpsGame } from '@/lib/game/fps';
import { runTopdownGame } from '@/lib/game/topdown';
import { runGame, type GameHandle, type SceneState } from '@/lib/game/pixi';
import {
  openSandbox,
  type SandboxConnectionStatus,
  type SandboxHandle,
} from '@/lib/sandbox';
import { getOverride } from '@/lib/textureOverrides';

// Welcome message shape — mirrors the union arm in protocol.ts.
type WelcomeMsg = Extract<ServerMessage, { type: 'welcome' }>;

export type SandboxPreviewMode = 'fps' | 'topdown';

export type SandboxPreviewHandle = {
  spawnEnemy(kind: string, x: number, y: number): void;
  // Spawn near the editor player's current position, with a
  // small random offset. Convenience for "drop one in front of
  // me" — makes the spawned enemy always visible on screen
  // regardless of where the player has wandered.
  spawnEnemyNearSelf(kind: string, range?: number): void;
  clear(scope?: 'enemies' | 'props' | 'all'): void;
  setLoadout(kind: 'creative' | 'unarmed'): void;
  regenFloor(args: {
    biome: string;
    cycle: number;
    floorIndex: number;
    worldSeed: number;
  }): void;
  stampRoom(templateId: string, biome?: string): void;
  selfPosition(): { x: number; y: number } | null;
  status(): SandboxConnectionStatus;
};

function runnerFor(mode: SandboxPreviewMode): typeof runGame {
  if (mode === 'topdown') return runTopdownGame;
  return runFpsGame;
}

export const SandboxPreview = forwardRef<
  SandboxPreviewHandle,
  {
    mode: SandboxPreviewMode;
    onStatusChange?: (s: SandboxConnectionStatus) => void;
    onError?: (e: Error) => void;
    onWelcome?: (msg: WelcomeMsg) => void;
  }
>(function SandboxPreview(
  { mode, onStatusChange, onError, onWelcome },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<GameHandle | null>(null);
  const sandboxRef = useRef<SandboxHandle | null>(null);
  // Latest authoritative scene state from the server. Updated on
  // welcome and scene_changed. Renderer mounts read from this so
  // a mode swap mid-session lands at the current floor + entities,
  // not the original surface.
  const sceneStateRef = useRef<{
    sceneId: string;
    self: WelcomeMsg['self'];
    players: WelcomeMsg['players'];
    enemies: WelcomeMsg['enemies'];
    projectiles: WelcomeMsg['projectiles'];
    loot: WelcomeMsg['loot'];
    corpses: WelcomeMsg['corpses'];
    buildings: WelcomeMsg['buildings'];
    props: WelcomeMsg['props'];
    layout: WelcomeMsg['layout'];
  } | null>(null);
  const [status, setStatus] = useState<SandboxConnectionStatus>('idle');
  const [welcomeReady, setWelcomeReady] = useState(false);
  // Latest mode for stable callback reads.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useImperativeHandle(
    ref,
    () => ({
      spawnEnemy: (kind, x, y) =>
        sandboxRef.current?.spawnEnemy(kind, x, y),
      spawnEnemyNearSelf: (kind, range = 160) => {
        const sb = sandboxRef.current;
        const game = gameRef.current;
        if (!sb) return;
        const self = game?.getSelfPosition() ?? { x: 0, y: 0 };
        const target = pickWalkableNear(
          sceneStateRef.current?.layout ?? null,
          self.x,
          self.y,
          range,
        );
        sb.spawnEnemy(kind, target.x, target.y);
      },
      clear: (scope) => sandboxRef.current?.clear(scope),
      setLoadout: (kind) => sandboxRef.current?.setLoadout(kind),
      regenFloor: (args) => sandboxRef.current?.regenFloor(args),
      stampRoom: (templateId, biome) =>
        sandboxRef.current?.send({
          type: 'sandbox_stamp_room',
          templateId,
          biome,
        }),
      selfPosition: () => gameRef.current?.getSelfPosition() ?? null,
      status: () => sandboxRef.current?.status() ?? 'idle',
    }),
    [],
  );

  // Connection effect — mount-once, lives across mode swaps.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const sandbox = await openSandbox({
          onStatusChange: (s) => {
            if (cancelled) return;
            setStatus(s);
            onStatusChange?.(s);
          },
          onMessage: (msg) => {
            if (cancelled) return;
            if (msg.type === 'welcome') {
              const w = msg as WelcomeMsg;
              applyWelcomeRegistries(w);
              cacheScene(w);
              onWelcome?.(w);
              setWelcomeReady(true);
              return;
            }
            applyServerMessage(msg);
          },
        });
        if (cancelled) {
          sandbox.close();
          return;
        }
        sandboxRef.current = sandbox;
      } catch (e) {
        if (cancelled) return;
        onError?.(e as Error);
      }
    })();

    function cacheScene(w: WelcomeMsg): void {
      sceneStateRef.current = {
        sceneId: w.sceneId,
        self: w.self,
        players: w.players,
        enemies: w.enemies,
        projectiles: w.projectiles,
        loot: w.loot,
        corpses: w.corpses,
        buildings: w.buildings,
        props: w.props,
        layout: w.layout,
      };
    }

    function applyServerMessage(msg: ServerMessage): void {
      const game = gameRef.current;
      // Mirror the live game's WS-to-renderer routing for the
      // message types the sandbox emits today.
      switch (msg.type) {
        case 'player_joined':
          game?.upsertPlayer(msg.player);
          break;
        case 'player_left':
          game?.removePlayer(msg.characterId);
          break;
        case 'player_moved':
          game?.movePlayer(msg.characterId, msg.x, msg.y);
          break;
        case 'player_damaged':
          game?.setPlayerHp(
            msg.characterId,
            msg.hp,
            msg.maxHp,
            msg.shield,
            msg.maxShield,
          );
          break;
        case 'player_died':
          game?.setPlayerDead(msg.characterId);
          break;
        case 'player_respawned':
          game?.respawnPlayer(
            msg.characterId,
            msg.x,
            msg.y,
            msg.hp,
            msg.maxHp,
            msg.stamina,
            msg.maxStamina,
            msg.shield,
            msg.maxShield,
          );
          break;
        case 'enemy_spawned':
          game?.upsertEnemy(msg.enemy);
          break;
        case 'enemy_state':
          game?.setEnemyPosition(msg.id, msg.x, msg.y);
          break;
        case 'enemy_damaged':
          game?.setEnemyHp(msg.id, msg.hp, msg.maxHp);
          break;
        case 'enemy_killed':
          game?.removeEnemy(msg.id);
          break;
        case 'projectile_spawned':
          game?.spawnProjectile(msg.projectile);
          break;
        case 'projectile_despawned':
          game?.despawnProjectile(msg.id);
          break;
        case 'corpse_spawned':
          game?.spawnCorpse(msg.corpse);
          break;
        case 'corpse_looted':
          game?.removeCorpse(msg.id);
          break;
        case 'scene_changed': {
          // Sandbox scene swap. Cache the new state AND apply to
          // any currently-mounted renderer so the canvas paints
          // the new floor immediately.
          const snap: SceneState = {
            sceneId: msg.sceneId,
            self: msg.self,
            players: msg.players.filter(
              (p) => p.characterId !== msg.self.characterId,
            ),
            enemies: msg.enemies,
            projectiles: msg.projectiles,
            loot: msg.loot,
            corpses: msg.corpses,
            buildings: msg.buildings,
            props: msg.props,
            layout: msg.layout,
          };
          sceneStateRef.current = {
            sceneId: msg.sceneId,
            self: msg.self,
            players: msg.players,
            enemies: msg.enemies,
            projectiles: msg.projectiles,
            loot: msg.loot,
            corpses: msg.corpses,
            buildings: msg.buildings,
            props: msg.props,
            layout: msg.layout,
          };
          game?.swapScene(snap);
          break;
        }
        case 'inventory_changed': {
          // After a creative-loadout, slot 0 holds the active
          // weapon. Tell the renderer so the held-weapon visual
          // and click-to-fire logic both light up.
          const slot0 = msg.inventory[0];
          if (slot0 && slot0.kind === 'weapon') {
            game?.setEquippedWeapon(slot0.weapon.weaponId);
          } else {
            game?.setEquippedWeapon(null);
          }
          break;
        }
        default:
          break;
      }
    }

    return () => {
      cancelled = true;
      sandboxRef.current?.close();
      sandboxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Renderer effect — depends on mode and welcomeReady. Destroys
  // the old renderer and mounts a new one against the most recent
  // scene state when either changes. Keeps the WS untouched.
  //
  // State source priority: outgoing renderer's currentSceneState()
  // (covers entities spawned mid-session, e.g. via the editor's
  // Spawn button) → cached welcome / scene_changed snapshot →
  // bail. Without the renderer-state path, hot-swapping to topdown
  // would lose every entity that wasn't in the last welcome /
  // scene_changed message.
  useEffect(() => {
    if (!welcomeReady) return;
    const host = hostRef.current;
    if (!host) return;

    // Capture live state from the outgoing renderer before
    // destroying it.
    const live = gameRef.current?.currentSceneState() ?? null;
    if (gameRef.current) {
      gameRef.current.destroy();
      gameRef.current = null;
    }

    const cached = sceneStateRef.current;
    const snap = live ?? (cached ? toSceneState(cached) : null);
    if (!snap) return;

    const runner = runnerFor(mode);
    gameRef.current = runner(host, {
      sceneId: snap.sceneId,
      self: snap.self,
      others: snap.players.filter(
        (p) => p.characterId !== snap.self.characterId,
      ),
      enemies: snap.enemies,
      projectiles: snap.projectiles,
      loot: snap.loot,
      corpses: snap.corpses,
      buildings: snap.buildings,
      props: snap.props,
      layout: snap.layout,
      getEnemyTexture: (kind) => getOverride('enemy', kind),
      sendInput: (moveX, moveY, sprint) => {
        sandboxRef.current?.input(moveX, moveY, sprint);
      },
      sendFire: (dirX, dirY) => {
        sandboxRef.current?.send({ type: 'fire', dirX, dirY });
      },
      sendBuild: () => {
        /* sandbox: build disabled */
      },
      sendDemolish: () => {
        /* sandbox: demolish disabled */
      },
      onNearInteractableChanged: () => {
        /* no interactables in sandbox */
      },
      onNearWorkstationsChanged: () => {
        /* no workstations in sandbox */
      },
    });

    return () => {
      gameRef.current?.destroy();
      gameRef.current = null;
    };
  }, [mode, welcomeReady]);

  return (
    <div className="relative w-full h-full">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="absolute top-2 left-2 text-[10px] font-mono text-zinc-400 bg-zinc-900/70 px-2 py-0.5 rounded border border-zinc-800 pointer-events-none">
        sandbox · {mode} · {status}
      </div>
    </div>
  );
});

// The renderer reads enemy visuals + biome palettes + the
// weapon / blueprint / recipe / attachment registries from
// shared global state. Live game's welcome handler populates all
// of them; sandbox does the same so authored content (including
// animation references on weapons / enemies / props / biomes)
// renders identically here.
function applyWelcomeRegistries(msg: WelcomeMsg): void {
  if (msg.enemyVisuals) setEnemyVisuals(msg.enemyVisuals);
  if (msg.biomes) setBiomePalettes(msg.biomes);
  if (msg.propVisuals) setPropVisuals(msg.propVisuals);
  if (msg.buildingVisuals) setBuildingVisuals(msg.buildingVisuals);
  if (msg.weapons) setWeaponRegistry(msg.weapons);
  if (msg.blueprints) setBlueprintCatalog(msg.blueprints);
  if (msg.recipes) setRecipes(msg.recipes);
  if (msg.attachments) setAttachmentRegistry(msg.attachments);
}

// Re-export of the welcome msg shape so consumers can opt into a
// typed onWelcome callback without re-importing from shared.
export type { WelcomeMsg };

// Adapt the cached welcome / scene_changed snapshot (which keeps
// `players` as the full roster including self) to the SceneState
// shape the renderers expect (self separate, players = others).
function toSceneState(cached: {
  sceneId: string;
  self: WelcomeMsg['self'];
  players: WelcomeMsg['players'];
  enemies: WelcomeMsg['enemies'];
  projectiles: WelcomeMsg['projectiles'];
  loot: WelcomeMsg['loot'];
  corpses: WelcomeMsg['corpses'];
  buildings: WelcomeMsg['buildings'];
  props: WelcomeMsg['props'];
  layout: WelcomeMsg['layout'];
}): SceneState {
  return {
    sceneId: cached.sceneId,
    self: cached.self,
    players: cached.players.filter(
      (p) => p.characterId !== cached.self.characterId,
    ),
    enemies: cached.enemies,
    projectiles: cached.projectiles,
    loot: cached.loot,
    corpses: cached.corpses,
    buildings: cached.buildings,
    props: cached.props,
    layout: cached.layout,
  };
}

// Pick a walkable position within `range` px of (cx, cy). Samples
// 16 angles outward from the player; for each, scans from min to
// max radius looking for a walkable tile. Returns the first hit;
// falls back to a random ring offset when no tile grid is present
// (surface scenes) or no walkable cell is found in range.
function pickWalkableNear(
  layout: WelcomeMsg['layout'],
  cx: number,
  cy: number,
  range: number,
): { x: number; y: number } {
  const minR = 60;
  // No tile grid → just use a random ring (sandbox surface).
  if (!layout?.tileGrid) {
    const angle = Math.random() * Math.PI * 2;
    const r = minR + Math.random() * Math.max(0, range - minR);
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  }
  const grid = layout.tileGrid;
  const tiles = decodeTileGrid(grid);
  const samples = 16;
  // Random angle offset so consecutive spawns don't always pick
  // the same direction.
  const angleStart = Math.random() * Math.PI * 2;
  const radiusStep = 12;
  for (let i = 0; i < samples; i++) {
    const angle = angleStart + (i / samples) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let r = minR; r <= range; r += radiusStep) {
      const x = cx + dx * r;
      const y = cy + dy * r;
      const id = tileIdAt(grid, tiles, x, y);
      if (isWalkableTileId(id)) {
        return { x, y };
      }
    }
  }
  // No walkable cell found; drop on the player so spawn at least
  // succeeds visibly even if it ends up clipping.
  return { x: cx, y: cy };
}
