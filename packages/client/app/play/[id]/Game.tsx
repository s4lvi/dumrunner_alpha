'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  countAmmo,
  countMaterial,
  emptyEquipment,
  emptyInventory,
  HOTBAR_SIZE,
  listRecipes,
  MATERIALS,
  PROTOCOL_VERSION,
  SUIT_SLOT_KINDS,
  type BuildingKind,
  type CarriedPart,
  type ClientMessage,
  type Equipment,
  type Inventory,
  type InventorySlot,
  type PartTier,
  type Recipe,
  type ServerMessage,
  type SuitSlotKind,
} from '@dumrunner/shared';
import { runGame, type GameHandle } from '@/lib/game/pixi';
import { runFpsGame } from '@/lib/game/fps';

type JoinResponse = {
  wsUrl: string;
  token: string;
  characterId: string;
  displayName: string;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'joining' }
  | { kind: 'password_required' }
  | { kind: 'connecting'; resp: JoinResponse }
  | { kind: 'connected'; resp: JoinResponse }
  | { kind: 'error'; message: string };

export function Game({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [inventory, setInventory] = useState<Inventory>(() => emptyInventory());
  const [equipment, setEquipment] = useState<Equipment>(() => emptyEquipment());
  const [hotbarSelection, setHotbarSelection] = useState(0);
  const [sceneId, setSceneId] = useState<string>('surface');
  const [showInventory, setShowInventory] = useState(false);
  const [slotMenu, setSlotMenu] = useState<{
    slot: number;
    x: number;
    y: number;
  } | null>(null);
  const [nearInteractable, setNearInteractable] = useState<{
    id: string;
    label: string;
  } | null>(null);
  // Latest interactable for the keydown handler (avoids stale closure).
  const nearInteractableRef = useRef<{ id: string; label: string } | null>(null);
  const [worldClock, setWorldClock] = useState<{
    cycle: number;
    secondsToPerihelion: number;
    hordeActive: boolean;
  } | null>(null);
  // Blueprints the server says the player can craft from. Wiped + re-granted
  // each cycle.
  const [knownBlueprints, setKnownBlueprints] = useState<Set<string>>(
    () => new Set()
  );
  // Workstation kinds the player is standing within crafting range of.
  // Updated by pixi via onNearWorkstationsChanged.
  const [nearWorkstations, setNearWorkstations] = useState<Set<BuildingKind>>(
    () => new Set()
  );
  // Holds the live ws so number-key handlers can send select_hotbar without
  // closing over render-time scope.
  const wsForHotbar = useRef<WebSocket | null>(null);

  function sendOnLiveWs(msg: ClientMessage) {
    const ws = wsForHotbar.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<GameHandle | null>(null);

  // Tracks the live ws and its tear-down. A new attempt aborts the previous one.
  const sessionRef = useRef<{
    ws: WebSocket | null;
    abort: AbortController;
    cancelled: boolean;
  } | null>(null);

  function teardown() {
    const s = sessionRef.current;
    if (s) {
      s.cancelled = true;
      s.abort.abort();
      const ws = s.ws;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        // Detach handlers so the close event doesn't flip UI state on an old session.
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      sessionRef.current = null;
    }
    if (gameRef.current) {
      gameRef.current.destroy();
      gameRef.current = null;
    }
  }

  const attemptJoin = useCallback(
    async (pw?: string) => {
      // Replace any previous in-flight or live session before starting a new one.
      teardown();

      const session = {
        ws: null as WebSocket | null,
        abort: new AbortController(),
        cancelled: false,
      };
      sessionRef.current = session;

      setStatus({ kind: 'joining' });

      try {
        const res = await fetch(`/api/servers/${serverId}/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(pw ? { password: pw } : {}),
          signal: session.abort.signal,
        });
        if (session.cancelled) return;

        if (res.status === 401) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          if (data.error === 'password_required' || data.error === 'bad_password') {
            setStatus({ kind: 'password_required' });
            return;
          }
          setStatus({ kind: 'error', message: 'Unauthorized.' });
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
            hint?: string;
            code?: string;
          };
          const parts = [
            data.error ?? `HTTP ${res.status}`,
            data.detail,
            data.hint,
            data.code ? `(code ${data.code})` : null,
          ].filter(Boolean);
          setStatus({ kind: 'error', message: parts.join(' — ') });
          return;
        }

        const resp = (await res.json()) as JoinResponse;
        if (session.cancelled) return;

        setStatus({ kind: 'connecting', resp });

        const ws = new WebSocket(resp.wsUrl);
        session.ws = ws;

        ws.onopen = () => {
          if (session.cancelled) return;
          const auth: ClientMessage = {
            type: 'auth',
            token: resp.token,
            protocolVersion: PROTOCOL_VERSION,
          };
          ws.send(JSON.stringify(auth));
        };

        ws.onmessage = (event) => {
          if (session.cancelled) return;
          let msg: ServerMessage;
          try {
            msg = JSON.parse(event.data) as ServerMessage;
          } catch {
            return;
          }
          handleServerMessage(msg, resp, session);
        };

        ws.onerror = () => {
          // 'close' will fire next with a reason.
        };

        ws.onclose = (event) => {
          if (session.cancelled) return;
          if (gameRef.current) {
            gameRef.current.destroy();
            gameRef.current = null;
          }
          setStatus({
            kind: 'error',
            message: `Disconnected${event.reason ? `: ${event.reason}` : '.'}`,
          });
        };
      } catch (err) {
        if (session.cancelled) return;
        if ((err as { name?: string }).name === 'AbortError') return;
        setStatus({ kind: 'error', message: (err as Error).message });
      }
    },
    // serverId is stable, but include it for completeness.
    [serverId]
  );

  function handleServerMessage(
    msg: ServerMessage,
    resp: JoinResponse,
    session: NonNullable<typeof sessionRef.current>
  ) {
    switch (msg.type) {
      case 'welcome': {
        setStatus({ kind: 'connected', resp });
        setInventory(msg.inventory);
        setEquipment(msg.equipment);
        setHotbarSelection(msg.hotbarSelection);
        setSceneId(msg.sceneId);
        setKnownBlueprints(new Set(msg.knownBlueprints));
        wsForHotbar.current = session.ws;
        requestAnimationFrame(() => {
          if (session.cancelled) return;
          const host = canvasHostRef.current;
          if (!host || gameRef.current) return;
          // Pick renderer. `?fps=1` in the URL spins up the raycaster for
          // the 2.5d experiment. Default stays on the top-down view. Phase 6
          // promotes this to a runtime toggle.
          const useFps =
            typeof window !== 'undefined' &&
            new URLSearchParams(window.location.search).get('fps') === '1';
          const runner = useFps ? runFpsGame : runGame;
          gameRef.current = runner(host, {
            self: msg.self,
            others: msg.players.filter((p) => p.characterId !== msg.self.characterId),
            enemies: msg.enemies,
            projectiles: msg.projectiles,
            loot: msg.loot,
            corpses: msg.corpses,
            buildings: msg.buildings,
            layout: msg.layout,
            sendInput: (moveX, moveY, sprint) => {
              const ws = session.ws;
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const m: ClientMessage = { type: 'input', moveX, moveY, sprint };
              ws.send(JSON.stringify(m));
            },
            sendFire: (dirX, dirY) => {
              const ws = session.ws;
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const m: ClientMessage = { type: 'fire', dirX, dirY };
              ws.send(JSON.stringify(m));
            },
            sendBuild: (kind, tileX, tileY) => {
              const ws = session.ws;
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const m: ClientMessage = { type: 'build_request', kind, tileX, tileY };
              ws.send(JSON.stringify(m));
            },
            sendDemolish: (buildingId) => {
              const ws = session.ws;
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const m: ClientMessage = { type: 'demolish_request', buildingId };
              ws.send(JSON.stringify(m));
            },
            onNearInteractableChanged: (near) => {
              nearInteractableRef.current = near;
              setNearInteractable(near);
            },
            onNearWorkstationsChanged: (kinds) => {
              setNearWorkstations(new Set(kinds));
            },
          });
        });
        break;
      }
      case 'player_joined':
        gameRef.current?.upsertPlayer(msg.player);
        break;
      case 'player_left':
        gameRef.current?.removePlayer(msg.characterId);
        break;
      case 'player_moved':
        gameRef.current?.movePlayer(msg.characterId, msg.x, msg.y);
        break;
      case 'player_damaged':
        gameRef.current?.setPlayerHp(
          msg.characterId,
          msg.hp,
          msg.maxHp,
          msg.shield,
          msg.maxShield
        );
        break;
      case 'player_stamina':
        gameRef.current?.setSelfStamina(msg.stamina, msg.maxStamina);
        break;
      case 'player_died':
        gameRef.current?.setPlayerDead(msg.characterId);
        break;
      case 'player_respawned':
        gameRef.current?.respawnPlayer(
          msg.characterId,
          msg.x,
          msg.y,
          msg.hp,
          msg.maxHp,
          msg.stamina,
          msg.maxStamina,
          msg.shield,
          msg.maxShield
        );
        break;
      case 'weapon_swung':
        gameRef.current?.showWeaponSwung(
          msg.characterId,
          msg.weaponId,
          msg.dirX,
          msg.dirY
        );
        break;
      case 'scene_changed':
        setSceneId(msg.sceneId);
        setEquipment(msg.equipment);
        gameRef.current?.swapScene({
          self: msg.self,
          players: msg.players.filter(
            (p) => p.characterId !== msg.self.characterId
          ),
          enemies: msg.enemies,
          projectiles: msg.projectiles,
          loot: msg.loot,
          corpses: msg.corpses,
          buildings: msg.buildings,
          layout: msg.layout,
        });
        break;
      case 'enemy_spawned':
        gameRef.current?.upsertEnemy(msg.enemy);
        break;
      case 'enemy_state':
        gameRef.current?.setEnemyPosition(msg.id, msg.x, msg.y);
        break;
      case 'enemy_damaged':
        gameRef.current?.setEnemyHp(msg.id, msg.hp, msg.maxHp);
        break;
      case 'enemy_killed':
        gameRef.current?.removeEnemy(msg.id);
        break;
      case 'projectile_spawned':
        gameRef.current?.spawnProjectile(msg.projectile);
        break;
      case 'projectile_despawned':
        gameRef.current?.despawnProjectile(msg.id);
        break;
      case 'loot_spawned':
        gameRef.current?.spawnLoot(msg.loot);
        break;
      case 'loot_despawned':
        gameRef.current?.despawnLoot(msg.id);
        break;
      case 'corpse_spawned':
        gameRef.current?.spawnCorpse(msg.corpse);
        break;
      case 'corpse_looted':
        gameRef.current?.removeCorpse(msg.id);
        break;
      case 'building_placed':
        gameRef.current?.spawnBuilding(msg.building);
        break;
      case 'building_damaged':
        gameRef.current?.setBuildingHp(msg.id, msg.hp, msg.maxHp);
        break;
      case 'building_destroyed':
        gameRef.current?.removeBuilding(msg.id);
        break;
      case 'world_clock':
        setWorldClock({
          cycle: msg.cycle,
          secondsToPerihelion: msg.secondsToPerihelion,
          hordeActive: msg.hordeActive,
        });
        break;
      case 'horde_started':
        setWorldClock({
          cycle: msg.cycle,
          secondsToPerihelion: Math.ceil(msg.durationMs / 1000),
          hordeActive: true,
        });
        break;
      case 'horde_ended':
        setWorldClock((prev) =>
          prev
            ? { ...prev, cycle: msg.newCycle, hordeActive: false }
            : prev
        );
        break;
      case 'inventory_changed':
        setInventory(msg.inventory);
        break;
      case 'equipment_changed':
        setEquipment(msg.equipment);
        break;
      case 'blueprints_changed':
        setKnownBlueprints(new Set(msg.knownBlueprints));
        break;
      case 'error':
        console.error('[server error]', msg.message);
        break;
    }
  }

  useEffect(() => {
    void attemptJoin();
    return teardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptJoin]);

  // Build mode follows the selected hotbar slot: a placeable WITH stock + the
  // surface scene turns it on, anything else turns it off.
  useEffect(() => {
    const slot = inventory[hotbarSelection];
    const kind =
      sceneId === 'surface' &&
      slot?.kind === 'placeable' &&
      slot.count > 0
        ? slot.buildingKind
        : null;
    gameRef.current?.setBuildMode(kind);
    // Equipped weapon: pistol/knife when the selected slot is a weapon, else
    // null. The renderer gates fire/swing visuals on this.
    const weapon = slot?.kind === 'weapon' ? slot.weaponId : null;
    gameRef.current?.setEquippedWeapon(weapon);
  }, [inventory, hotbarSelection, sceneId]);

  // Tab toggles the inventory overlay. Number keys 1-9 select the hotbar.
  // preventDefault stops the browser from moving focus around while playing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Tab') {
        e.preventDefault();
        setShowInventory((s) => !s);
        return;
      }
      if (e.key === 'Escape') {
        setShowInventory(false);
        return;
      }
      // E to interact with the nearest in-range interactable.
      if (e.key === 'e' || e.key === 'E') {
        const near = nearInteractableRef.current;
        if (near) {
          sendOnLiveWs({ type: 'interact', interactableId: near.id });
        }
        return;
      }
      // Hotbar selection: 1-9 maps to slots 0-8.
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= HOTBAR_SIZE) {
        const slotIdx = n - 1;
        setHotbarSelection(slotIdx);
        const ws = wsForHotbar.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const m: ClientMessage = { type: 'select_hotbar', slot: slotIdx };
          ws.send(JSON.stringify(m));
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 border-b border-[color:var(--panel-border)] bg-[color:var(--panel)]">
        <Link href="/servers" className="text-sm text-zinc-400">
          ← Servers
        </Link>
        <div className="text-sm text-zinc-400">
          server {serverId.slice(0, 8)}…
          {' • '}
          {status.kind === 'connected' && (
            <span className="text-emerald-400">connected</span>
          )}
          {status.kind === 'connecting' && <span>connecting…</span>}
          {status.kind === 'joining' && <span>joining…</span>}
          {status.kind === 'idle' && <span>idle</span>}
          {status.kind === 'password_required' && <span>password required</span>}
          {status.kind === 'error' && (
            <span className="text-red-400">error: {status.message}</span>
          )}
        </div>
      </header>

      <div className="flex-1 relative">
        <div ref={canvasHostRef} className="absolute inset-0 cursor-crosshair" />

        <Hotbar
          inventory={inventory}
          selected={hotbarSelection}
          onSwap={(from, to) => sendOnLiveWs({ type: 'inventory_swap', from, to })}
          onContextMenu={(slot, x, y) => setSlotMenu({ slot, x, y })}
        />
        {worldClock && <WorldClockHud clock={worldClock} />}
        {nearInteractable && (
          <InteractPrompt label={nearInteractable.label} />
        )}
        <ControlsHint />

        {showInventory && (
          <InventoryPanel
            inventory={inventory}
            equipment={equipment}
            selected={hotbarSelection}
            knownBlueprints={knownBlueprints}
            nearWorkstations={nearWorkstations}
            onClose={() => setShowInventory(false)}
            onSwap={(from, to) => sendOnLiveWs({ type: 'inventory_swap', from, to })}
            onSort={() => sendOnLiveWs({ type: 'inventory_sort' })}
            onContextMenu={(slot, x, y) => setSlotMenu({ slot, x, y })}
            onEquip={(fromInventoryIdx, suitSlot) =>
              sendOnLiveWs({ type: 'equip_request', fromInventoryIdx, suitSlot })
            }
            onUnequip={(suitSlot, toInventoryIdx) =>
              sendOnLiveWs({
                type: 'unequip_request',
                suitSlot,
                toInventoryIdx,
              })
            }
            onCraft={(recipeId) =>
              sendOnLiveWs({ type: 'craft_request', recipeId })
            }
          />
        )}

        {slotMenu && (
          <SlotContextMenu
            slot={inventory[slotMenu.slot]}
            x={slotMenu.x}
            y={slotMenu.y}
            onDiscardOne={() => {
              sendOnLiveWs({
                type: 'inventory_discard',
                slot: slotMenu.slot,
                all: false,
              });
              setSlotMenu(null);
            }}
            onDiscardAll={() => {
              sendOnLiveWs({
                type: 'inventory_discard',
                slot: slotMenu.slot,
                all: true,
              });
              setSlotMenu(null);
            }}
            onClose={() => setSlotMenu(null)}
          />
        )}

        {(status.kind === 'idle' ||
          status.kind === 'joining' ||
          status.kind === 'connecting') && (
          <Overlay>
            <div className="text-zinc-400">
              {status.kind === 'idle'
                ? 'Preparing…'
                : status.kind === 'joining'
                ? 'Authenticating…'
                : 'Connecting to game server…'}
            </div>
          </Overlay>
        )}

        {status.kind === 'password_required' && (
          <Overlay>
            <div className="bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded p-6 w-full max-w-sm">
              <h2 className="text-xl font-semibold mb-4">Password required</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void attemptJoin(password);
                }}
                className="space-y-3"
              >
                <input
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Server password"
                  className="w-full bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)]"
                />
                <button
                  type="submit"
                  className="w-full py-2 rounded bg-[color:var(--accent)] text-black font-semibold"
                >
                  Join
                </button>
              </form>
            </div>
          </Overlay>
        )}

        {status.kind === 'error' && (
          <Overlay>
            <div className="bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded p-6 max-w-md text-center">
              <h2 className="text-xl font-semibold mb-2">Couldn&apos;t join</h2>
              <p className="text-red-400 text-sm mb-4">{status.message}</p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => void attemptJoin()}
                  className="px-4 py-2 rounded border border-[color:var(--panel-border)] hover:bg-[color:var(--bg)]"
                >
                  Retry
                </button>
                <Link
                  href="/servers"
                  className="px-4 py-2 rounded border border-[color:var(--panel-border)] hover:bg-[color:var(--bg)]"
                >
                  Back
                </Link>
              </div>
            </div>
          </Overlay>
        )}
      </div>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
      {children}
    </div>
  );
}

function ControlsHint() {
  return (
    <div className="absolute bottom-3 right-3 text-xs text-zinc-500 select-none pointer-events-none flex flex-col items-end gap-1">
      <div>
        <Kbd>Tab</Kbd>
        <span className="ml-2">inventory</span>
      </div>
      <div>
        <Kbd>E</Kbd>
        <span className="ml-2">interact</span>
      </div>
      <div>
        <Kbd>Shift</Kbd>
        <span className="ml-2">sprint</span>
      </div>
      <div>
        <Kbd>1–9</Kbd>
        <span className="ml-2">hotbar</span>
      </div>
    </div>
  );
}

// Top-centre clock + perihelion countdown. Switches into a red "siege"
// state while the horde is active.
function WorldClockHud({
  clock,
}: {
  clock: { cycle: number; secondsToPerihelion: number; hordeActive: boolean };
}) {
  const m = Math.floor(clock.secondsToPerihelion / 60);
  const s = clock.secondsToPerihelion % 60;
  const time = `${m}:${s.toString().padStart(2, '0')}`;
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none select-none">
      <div
        className={`px-3 py-1.5 rounded-full border text-xs flex items-center gap-3 ${
          clock.hordeActive
            ? 'bg-red-950/90 border-red-500 text-red-100 animate-pulse'
            : 'bg-[color:var(--panel)]/90 border-[color:var(--panel-border)] text-zinc-200'
        }`}
      >
        <span>Cycle {clock.cycle}</span>
        <span className="opacity-60">•</span>
        {clock.hordeActive ? (
          <span className="font-semibold">PERIHELION — {time}</span>
        ) : (
          <span>perihelion in {time}</span>
        )}
      </div>
    </div>
  );
}

// Floating "Press E to …" prompt centred above the player. Anchored to the
// canvas centre because the camera follows the player.
function InteractPrompt({ label }: { label: string }) {
  return (
    <div className="absolute top-[55%] left-1/2 -translate-x-1/2 pointer-events-none select-none">
      <div className="px-3 py-1.5 rounded-full bg-[color:var(--panel)]/90 border border-[color:var(--accent)] text-sm flex items-center gap-2 shadow-lg">
        <Kbd>E</Kbd>
        <span className="text-zinc-100">{label}</span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded border border-[color:var(--panel-border)] bg-[color:var(--panel)] text-zinc-300 font-mono">
      {children}
    </kbd>
  );
}

// Bottom-of-screen hotbar (Minecraft-style). Always visible.
function Hotbar({
  inventory,
  selected,
  onSwap,
  onContextMenu,
}: {
  inventory: Inventory;
  selected: number;
  onSwap: (from: number, to: number) => void;
  onContextMenu: (slot: number, x: number, y: number) => void;
}) {
  const slots = inventory.slice(0, HOTBAR_SIZE);
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1 select-none pointer-events-auto">
      {slots.map((s, i) => (
        <SlotCell
          key={i}
          slot={s}
          index={i}
          hotkey={i + 1}
          highlighted={i === selected}
          size="hotbar"
          onSwap={onSwap}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

const SLOT_LABELS: Record<string, string> = {
  barrel: 'Barrel',
  frame: 'Frame',
  grip: 'Grip',
  magazine: 'Magazine',
  weapon_mod: 'Weapon Mod',
  chassis: 'Chassis',
  plating: 'Plating',
  life_support: 'Life-Support',
  utility_mod: 'Utility Mod',
  cargo_grid: 'Cargo Grid',
};

const TIER_HEX: Record<PartTier, string> = {
  Mk1: '#9ca3af',
  Mk2: '#22c55e',
  Mk3: '#3b82f6',
  Mk4: '#a855f7',
  Alien: '#f97316',
};

function InventoryPanel({
  inventory,
  equipment,
  selected,
  knownBlueprints,
  nearWorkstations,
  onClose,
  onSwap,
  onSort,
  onContextMenu,
  onEquip,
  onUnequip,
  onCraft,
}: {
  inventory: Inventory;
  equipment: Equipment;
  selected: number;
  knownBlueprints: Set<string>;
  nearWorkstations: Set<BuildingKind>;
  onClose: () => void;
  onSwap: (from: number, to: number) => void;
  onSort: () => void;
  onContextMenu: (slot: number, x: number, y: number) => void;
  onEquip: (fromInventoryIdx: number, suitSlot: SuitSlotKind) => void;
  onUnequip: (suitSlot: SuitSlotKind, toInventoryIdx?: number) => void;
  onCraft: (recipeId: string) => void;
}) {
  const hotbar = inventory.slice(0, HOTBAR_SIZE);
  const bag = inventory.slice(HOTBAR_SIZE);

  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded shadow-lg pointer-events-auto"
      style={{ width: 'fit-content' }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--panel-border)] gap-6">
        <h2 className="font-semibold">Inventory</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onSort}
            className="px-2 py-1 rounded text-xs border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)]"
          >
            Sort
          </button>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-sm"
            aria-label="Close inventory"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="p-3 flex gap-4">
        <CharacterPanel
          equipment={equipment}
          onEquip={onEquip}
          onUnequip={onUnequip}
        />
        <div className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
              Bag
            </div>
            <div className="grid grid-cols-9 gap-1">
              {bag.map((s, i) => {
                const idx = HOTBAR_SIZE + i;
                return (
                  <SlotCell
                    key={`b${i}`}
                    slot={s}
                    index={idx}
                    size="panel"
                    onSwap={onSwap}
                    onContextMenu={onContextMenu}
                    onArmorDrop={(suitSlot) => onUnequip(suitSlot, idx)}
                  />
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
              Hotbar
            </div>
            <div className="grid grid-cols-9 gap-1">
              {hotbar.map((s, i) => (
                <SlotCell
                  key={`h${i}`}
                  slot={s}
                  index={i}
                  hotkey={i + 1}
                  highlighted={i === selected}
                  size="panel"
                  onSwap={onSwap}
                  onContextMenu={onContextMenu}
                  onArmorDrop={(suitSlot) => onUnequip(suitSlot, i)}
                />
              ))}
            </div>
          </div>
          <div className="text-[10px] text-zinc-500 leading-snug">
            Drag to move • Right-click to discard
          </div>
          <CraftPanel
            inventory={inventory}
            knownBlueprints={knownBlueprints}
            nearWorkstations={nearWorkstations}
            onCraft={onCraft}
          />
        </div>
      </div>
    </div>
  );
}

function CraftPanel({
  inventory,
  knownBlueprints,
  nearWorkstations,
  onCraft,
}: {
  inventory: Inventory;
  knownBlueprints: Set<string>;
  nearWorkstations: Set<BuildingKind>;
  onCraft: (recipeId: string) => void;
}) {
  // Hide blueprinted recipes the player hasn't learned. Showing them adds
  // noise without giving the player any actionable info — they'll surface
  // again the moment the blueprint is granted.
  const recipes = listRecipes().filter(
    (r) => r.blueprintId === null || knownBlueprints.has(r.blueprintId)
  );
  return (
    <div className="pt-2 border-t border-[color:var(--panel-border)]">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
        Crafting
      </div>
      <ul className="space-y-1">
        {recipes.map((r) => (
          <CraftRow
            key={r.id}
            recipe={r}
            inventory={inventory}
            nearWorkstations={nearWorkstations}
            onCraft={onCraft}
          />
        ))}
      </ul>
    </div>
  );
}

const STATION_LABEL: Record<BuildingKind, string> = {
  wall: 'wall',
  turret: 'turret',
  workbench: 'Workbench',
  forge: 'Forge',
  electronics_bench: 'Electronics Bench',
};

function CraftRow({
  recipe,
  inventory,
  nearWorkstations,
  onCraft,
}: {
  recipe: Recipe;
  inventory: Inventory;
  nearWorkstations: Set<BuildingKind>;
  onCraft: (recipeId: string) => void;
}) {
  // Build a list of missing inputs so we can show the deficit explicitly.
  const missingInputs = recipe.inputs.flatMap((input) => {
    const have =
      input.kind === 'material'
        ? countMaterial(inventory, input.materialId)
        : countAmmo(inventory, input.ammoId);
    if (have >= input.count) return [];
    return [
      {
        id: input.kind === 'material' ? input.materialId : input.ammoId,
        need: input.count - have,
      },
    ];
  });

  const stationOk =
    recipe.workstation === null || nearWorkstations.has(recipe.workstation);

  const reasons: string[] = [];
  if (!stationOk && recipe.workstation) {
    reasons.push(`At ${STATION_LABEL[recipe.workstation]}`);
  }
  if (missingInputs.length > 0) {
    reasons.push(
      'Need ' + missingInputs.map((m) => `${m.need}× ${m.id}`).join(', ')
    );
  }
  const enabled = reasons.length === 0;

  const inputsLabel = recipe.inputs
    .map((i) => `${i.count} ${i.kind === 'material' ? i.materialId : i.ammoId}`)
    .join(' + ');

  const outLabel =
    recipe.output.kind === 'placeable'
      ? `${recipe.output.count} ${recipe.output.buildingKind}`
      : `${recipe.output.count} ${recipe.output.ammoId.replace(/_/g, ' ')}`;

  return (
    <li className="flex items-center justify-between gap-3 text-xs">
      <div className="flex flex-col min-w-0">
        <span className="font-semibold text-zinc-200">{recipe.name}</span>
        <span className="text-[10px] text-zinc-500 truncate">
          {inputsLabel} → {outLabel}
        </span>
        {!enabled && (
          <span className="text-[10px] text-amber-400/80 truncate">
            {reasons.join(' • ')}
          </span>
        )}
      </div>
      <button
        onClick={() => onCraft(recipe.id)}
        disabled={!enabled}
        title={enabled ? '' : reasons.join(' • ')}
        className="px-2 py-1 rounded text-[11px] border border-[color:var(--panel-border)] text-zinc-200 hover:bg-[color:var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Craft
      </button>
    </li>
  );
}

const SUIT_LABELS: Record<SuitSlotKind, string> = {
  chassis: 'Chassis',
  plating: 'Plating',
  life_support: 'Life-Support',
  utility_mod: 'Utility',
  cargo_grid: 'Cargo Grid',
};

// Character silhouette + 5 armor slots arranged around it. Each slot is a
// drop target for its matching part kind, and a drag source for unequipping.
function CharacterPanel({
  equipment,
  onEquip,
  onUnequip,
}: {
  equipment: Equipment;
  onEquip: (fromInventoryIdx: number, suitSlot: SuitSlotKind) => void;
  onUnequip: (suitSlot: SuitSlotKind, toInventoryIdx?: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 pr-3 border-r border-[color:var(--panel-border)]">
      <div className="text-xs uppercase tracking-wider text-zinc-500">Suit</div>
      <div className="relative w-32 h-44">
        <CharacterSilhouette />
        {/* Top — chassis */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2">
          <ArmorSlot
            kind="chassis"
            part={equipment.chassis}
            onDropPart={onEquip}
            onUnequip={onUnequip}
          />
        </div>
        {/* Middle — plating */}
        <div className="absolute top-[60px] left-1/2 -translate-x-1/2">
          <ArmorSlot
            kind="plating"
            part={equipment.plating}
            onDropPart={onEquip}
            onUnequip={onUnequip}
          />
        </div>
        {/* Lower — life support */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2">
          <ArmorSlot
            kind="life_support"
            part={equipment.life_support}
            onDropPart={onEquip}
            onUnequip={onUnequip}
          />
        </div>
        {/* Left — utility mod */}
        <div className="absolute top-[60px] left-0">
          <ArmorSlot
            kind="utility_mod"
            part={equipment.utility_mod}
            onDropPart={onEquip}
            onUnequip={onUnequip}
          />
        </div>
        {/* Right — cargo grid */}
        <div className="absolute top-[60px] right-0">
          <ArmorSlot
            kind="cargo_grid"
            part={equipment.cargo_grid}
            onDropPart={onEquip}
            onUnequip={onUnequip}
          />
        </div>
      </div>
      <div className="text-[10px] text-zinc-500 leading-snug w-32 text-center">
        Drag a part here to equip
      </div>
      {/* Suppress unused-var warning while SUIT_SLOT_KINDS is imported for
          potential future iteration helpers. */}
      <span className="hidden">{SUIT_SLOT_KINDS.join(',')}</span>
    </div>
  );
}

function CharacterSilhouette() {
  // Simple top-down humanoid silhouette behind the slot overlays.
  return (
    <svg
      viewBox="0 0 100 140"
      className="absolute inset-0 w-full h-full text-zinc-700"
      fill="currentColor"
    >
      <ellipse cx="50" cy="22" rx="14" ry="14" />
      <rect x="32" y="36" width="36" height="56" rx="8" />
      <rect x="38" y="92" width="10" height="36" rx="3" />
      <rect x="52" y="92" width="10" height="36" rx="3" />
      <rect x="18" y="46" width="10" height="38" rx="4" />
      <rect x="72" y="46" width="10" height="38" rx="4" />
    </svg>
  );
}

const ARMOR_DRAG_MIME = 'application/x-dumrunner-armor';

function ArmorSlot({
  kind,
  part,
  onDropPart,
  onUnequip,
}: {
  kind: SuitSlotKind;
  part: CarriedPart | null;
  onDropPart: (fromInventoryIdx: number, suitSlot: SuitSlotKind) => void;
  onUnequip: (suitSlot: SuitSlotKind, toInventoryIdx?: number) => void;
}) {
  const draggable = part !== null;
  return (
    <div
      className={`w-10 h-10 rounded border ${
        part ? 'border-[color:var(--accent)]' : 'border-[color:var(--panel-border)]'
      } bg-[color:var(--bg)] flex items-center justify-center`}
      title={SUIT_LABELS[kind]}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData(ARMOR_DRAG_MIME, kind);
              e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (!raw) return;
        const from = Number(raw);
        if (!Number.isFinite(from)) return;
        onDropPart(from, kind);
      }}
      onContextMenu={
        part
          ? (e) => {
              e.preventDefault();
              onUnequip(kind);
            }
          : undefined
      }
    >
      {part ? (
        <ItemIcon kind="part" tierColor={TIER_HEX[part.tier]} />
      ) : (
        <span className="text-[8px] text-zinc-500 leading-tight text-center px-0.5">
          {SUIT_LABELS[kind].split(' ')[0]}
        </span>
      )}
    </div>
  );
}

const DRAG_MIME = 'application/x-dumrunner-slot';

// Renders a single inventory slot. Used by both the bottom hotbar and the
// inventory-panel grid. Handles drag-out, drop-onto (inventory swap or
// armor unequip), and right-click context.
function SlotCell({
  slot,
  index,
  hotkey,
  highlighted,
  size,
  onSwap,
  onContextMenu,
  onArmorDrop,
}: {
  slot: InventorySlot;
  index: number;
  hotkey?: number;
  highlighted?: boolean;
  size: 'hotbar' | 'panel';
  onSwap?: (from: number, to: number) => void;
  onContextMenu?: (slot: number, x: number, y: number) => void;
  onArmorDrop?: (suitSlot: SuitSlotKind) => void;
}) {
  const dim = size === 'hotbar' ? 'w-12 h-12 text-xs' : 'w-14 h-14 text-[11px]';
  const border = highlighted
    ? 'border-2 border-[color:var(--accent)]'
    : 'border border-[color:var(--panel-border)]';

  const draggable = slot.kind !== 'empty' && !!onSwap;

  return (
    <div
      className={`relative rounded ${dim} ${border} bg-[color:var(--bg)] flex items-center justify-center text-center`}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData(DRAG_MIME, String(index));
              e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (
          (onSwap && types.includes(DRAG_MIME)) ||
          (onArmorDrop && types.includes(ARMOR_DRAG_MIME))
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(e) => {
        const armor = e.dataTransfer.getData(ARMOR_DRAG_MIME);
        if (armor && onArmorDrop) {
          onArmorDrop(armor as SuitSlotKind);
          return;
        }
        if (!onSwap) return;
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (!raw) return;
        const from = Number(raw);
        if (Number.isFinite(from) && from !== index) onSwap(from, index);
      }}
      onContextMenu={
        onContextMenu && slot.kind !== 'empty'
          ? (e) => {
              e.preventDefault();
              onContextMenu(index, e.clientX, e.clientY);
            }
          : undefined
      }
    >
      {hotkey !== undefined && (
        <span className="absolute top-0 left-0.5 text-[9px] text-zinc-500 leading-none pointer-events-none">
          {hotkey}
        </span>
      )}
      <SlotIcon slot={slot} />
    </div>
  );
}

// Right-click popup for a slot. Anchored to mouse position.
function SlotContextMenu({
  slot,
  x,
  y,
  onDiscardOne,
  onDiscardAll,
  onClose,
}: {
  slot: InventorySlot;
  x: number;
  y: number;
  onDiscardOne: () => void;
  onDiscardAll: () => void;
  onClose: () => void;
}) {
  const stackable = slot.kind === 'material' || slot.kind === 'ammo';
  const count = stackable ? slot.count : 1;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded shadow-lg text-xs min-w-[140px]"
        style={{ left: x, top: y }}
      >
        {stackable && count > 1 && (
          <button
            className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)]"
            onClick={onDiscardOne}
          >
            Discard 1
          </button>
        )}
        <button
          className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)] text-red-400"
          onClick={onDiscardAll}
        >
          {stackable && count > 1 ? `Discard all (${count})` : 'Discard'}
        </button>
      </div>
    </>
  );
}

function SlotIcon({ slot }: { slot: InventorySlot }) {
  if (slot.kind === 'empty') return <span className="text-zinc-700">·</span>;
  if (slot.kind === 'weapon') {
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="weapon" subkind={slot.weaponId} />
        <span className="text-zinc-300 text-[9px] capitalize">{slot.weaponId}</span>
      </div>
    );
  }
  if (slot.kind === 'placeable') {
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="placeable" subkind={slot.buildingKind} />
        <span className="text-zinc-300 text-[10px]">{slot.count}</span>
      </div>
    );
  }
  if (slot.kind === 'material') {
    const def = MATERIALS[slot.materialId];
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="material" subkind={slot.materialId} />
        <span className="text-zinc-200 text-[9px] capitalize">
          {def?.name ?? slot.materialId}
        </span>
        <span className="text-zinc-400 text-[9px]">×{slot.count}</span>
      </div>
    );
  }
  if (slot.kind === 'ammo') {
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="ammo" subkind={slot.ammoId} />
        <span className="text-zinc-300 text-[10px]">{slot.count}</span>
      </div>
    );
  }
  if (slot.kind === 'part') {
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="part" tierColor={TIER_HEX[slot.part.tier]} />
        <span
          className="text-[9px] font-semibold"
          style={{ color: TIER_HEX[slot.part.tier] }}
        >
          {slot.part.tier}
        </span>
        <span className="text-zinc-400 text-[8px] capitalize">
          {SLOT_LABELS[slot.part.slot] ?? slot.part.slot}
        </span>
      </div>
    );
  }
  return null;
}

// Inline SVG icon set. Currently designed for ~14px display, kept simple
// (paths + outlines). Will be replaced by generated sprites eventually.
function ItemIcon({
  kind,
  subkind,
  tierColor,
}: {
  kind: 'weapon' | 'placeable' | 'material' | 'ammo' | 'part';
  subkind?: string;
  tierColor?: string;
}) {
  const size = 18;
  const stroke = 1.5;
  if (kind === 'weapon' && subkind === 'pistol') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path
          d="M3 9 H14 V12 H17 V14 H14 V17 L11 17 L9 14 H6 L3 12 Z"
          fill="#cbd5e1"
          stroke="#0b0d10"
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'weapon' && subkind === 'knife') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path
          d="M4 4 L20 14 L16 18 L4 7 Z"
          fill="#e2e8f0"
          stroke="#0b0d10"
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
        <rect
          x="14"
          y="16"
          width="6"
          height="3"
          transform="rotate(40 14 16)"
          fill="#78350f"
          stroke="#0b0d10"
          strokeWidth={stroke}
        />
      </svg>
    );
  }
  if (kind === 'placeable' && subkind === 'wall') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="2" y="4" width="20" height="6" fill="#52525b" stroke="#0b0d10" strokeWidth={stroke} />
        <rect x="2" y="14" width="20" height="6" fill="#52525b" stroke="#0b0d10" strokeWidth={stroke} />
        <line x1="11" y1="4" x2="11" y2="10" stroke="#0b0d10" strokeWidth={stroke} />
        <line x1="6" y1="14" x2="6" y2="20" stroke="#0b0d10" strokeWidth={stroke} />
        <line x1="16" y1="14" x2="16" y2="20" stroke="#0b0d10" strokeWidth={stroke} />
      </svg>
    );
  }
  if (kind === 'placeable' && subkind === 'turret') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="14" width="18" height="6" fill="#27272a" stroke="#09090b" strokeWidth={stroke} />
        <circle cx="12" cy="14" r="5" fill="#3b82f6" stroke="#1e3a8a" strokeWidth={stroke} />
        <rect x="11" y="3" width="2" height="9" fill="#71717a" />
      </svg>
    );
  }
  if (kind === 'placeable' && subkind === 'workbench') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="6" width="18" height="14" fill="#92400e" stroke="#451a03" strokeWidth={stroke} />
        <rect x="5" y="10" width="14" height="3" fill="#f59e0b" />
        <line x1="6" y1="17" x2="18" y2="9" stroke="#e5e7eb" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'placeable' && subkind === 'forge') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" fill="#1c1917" stroke="#000" strokeWidth={stroke} />
        <circle cx="12" cy="12" r="6" fill="#dc2626" stroke="#7f1d1d" strokeWidth="1" />
        <circle cx="12" cy="12" r="3" fill="#fbbf24" />
      </svg>
    );
  }
  if (kind === 'placeable' && subkind === 'electronics_bench') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" fill="#064e3b" stroke="#022c22" strokeWidth={stroke} />
        <rect x="7" y="7" width="10" height="10" fill="#065f46" />
        <line x1="9" y1="9" x2="15" y2="15" stroke="#10b981" strokeWidth="1" />
        <circle cx="9" cy="9" r="1.5" fill="#fbbf24" />
        <circle cx="15" cy="15" r="1.5" fill="#fbbf24" />
      </svg>
    );
  }
  if (kind === 'material') {
    // Distinct shape + color per material. Falls through to a generic hex
    // nut if we add a material before adding its icon.
    if (subkind === 'wire') {
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="M3 16 Q 7 10, 11 16 T 19 16"
            fill="none"
            stroke="#eab308"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="3" cy="16" r="2" fill="#a16207" />
          <circle cx="21" cy="16" r="2" fill="#a16207" />
        </svg>
      );
    }
    if (subkind === 'alloy') {
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <rect x="3" y="6" width="18" height="4" fill="#94a3b8" stroke="#0b0d10" strokeWidth={stroke} />
          <rect x="3" y="11" width="18" height="4" fill="#cbd5e1" stroke="#0b0d10" strokeWidth={stroke} />
          <rect x="3" y="16" width="18" height="4" fill="#94a3b8" stroke="#0b0d10" strokeWidth={stroke} />
        </svg>
      );
    }
    if (subkind === 'circuit') {
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <rect x="5" y="5" width="14" height="14" fill="#10b981" stroke="#0b0d10" strokeWidth={stroke} />
          <rect x="2" y="8" width="3" height="2" fill="#0b0d10" />
          <rect x="2" y="14" width="3" height="2" fill="#0b0d10" />
          <rect x="19" y="8" width="3" height="2" fill="#0b0d10" />
          <rect x="19" y="14" width="3" height="2" fill="#0b0d10" />
          <circle cx="12" cy="12" r="2.5" fill="#fbbf24" />
        </svg>
      );
    }
    if (subkind === 'biotic') {
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="M6 14 Q 6 8, 12 6 Q 18 8, 18 14 Q 18 19, 12 19 Q 6 19, 6 14 Z"
            fill="#a855f7"
            stroke="#0b0d10"
            strokeWidth={stroke}
          />
          <ellipse cx="10" cy="11" rx="2" ry="1.5" fill="#0b0d10" opacity="0.35" />
        </svg>
      );
    }
    if (subkind === 'crystal') {
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <polygon
            points="12,3 20,10 16,21 8,21 4,10"
            fill="#06b6d4"
            stroke="#0b0d10"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
          <polyline
            points="12,3 12,21"
            stroke="#0b0d10"
            strokeWidth="0.5"
            opacity="0.4"
          />
          <polyline
            points="4,10 20,10"
            stroke="#0b0d10"
            strokeWidth="0.5"
            opacity="0.4"
          />
        </svg>
      );
    }
    // Default: scrap (and any unknown materials) — orange hex nut.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <polygon
          points="12,3 20,7 20,17 12,21 4,17 4,7"
          fill="#c2410c"
          stroke="#0b0d10"
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="3.5" fill="#0b0d10" />
      </svg>
    );
  }
  if (kind === 'ammo') {
    // Bullet (rounded rect with pointed tip)
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path
          d="M6 6 L14 6 L20 12 L14 18 L6 18 Z"
          fill="#fbbf24"
          stroke="#0b0d10"
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
        <rect x="3" y="6" width="3" height="12" fill="#a16207" stroke="#0b0d10" strokeWidth={stroke} />
      </svg>
    );
  }
  if (kind === 'part') {
    // Gear
    const c = tierColor ?? '#9ca3af';
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="6" fill={c} stroke="#0b0d10" strokeWidth={stroke} />
        <circle cx="12" cy="12" r="2.5" fill="#0b0d10" />
        {/* Teeth */}
        {[0, 60, 120, 180, 240, 300].map((deg) => (
          <rect
            key={deg}
            x="11"
            y="2"
            width="2"
            height="3.5"
            fill={c}
            stroke="#0b0d10"
            strokeWidth={stroke}
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
      </svg>
    );
  }
  // Fallback diamond.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <polygon points="12,4 20,12 12,20 4,12" fill="#cbd5e1" stroke="#0b0d10" strokeWidth={stroke} />
    </svg>
  );
}
