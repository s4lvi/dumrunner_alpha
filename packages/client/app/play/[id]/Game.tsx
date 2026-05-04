'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  countAmmo,
  countMaterial,
  emptyEquipment,
  emptyInventory,
  AFFIX_DEFS,
  computeSuitStats,
  ATTACHMENT_DEFS,
  attachmentDisplayName,
  blueprintDisplayName,
  BUILDING_REGISTRY,
  CONSUMABLES,
  effectiveWeaponStats,
  HOTBAR_SIZE,
  partDisplayName,
  TIER_COLORS_HEX,
  WEAPON_FAMILY,
  WEAPON_TIER_LABEL,
  weaponDisplayName,
  type WeaponItem,
  KEY_ARTIFACT_COST,
  listBlueprints,
  listRecipes,
  MATERIALS,
  TIER_PIECE_SLOTS,
  TIER_MOD_SLOTS,
  type WeaponPieceKind,
  partPrimaryStat,
  PLAYER_BASE_STATS,
  PROTOCOL_VERSION,
  SUIT_SLOT_KINDS,
  type BuildingKind,
  type BuildingState,
  type CarriedPart,
  type ClientMessage,
  type CraftJobState,
  type Equipment,
  type Inventory,
  type InventorySlot,
  type Recipe,
  type ServerMessage,
  type SuitSlotKind,
} from '@dumrunner/shared';
import { runGame, type GameHandle } from '@/lib/game/pixi';
import { runFpsGame } from '@/lib/game/fps';
import { audio } from '@/lib/audio';
import { loadAssetIndex, type AssetIndex } from '@/lib/assetGen';
import { rewriteGameWsUrl } from '@/lib/discord/sdk';

type JoinResponse = {
  wsUrl: string;
  token: string;
  characterId: string;
  displayName: string;
  isOwner: boolean;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'joining' }
  | { kind: 'password_required' }
  | { kind: 'connecting'; resp: JoinResponse }
  | { kind: 'connected'; resp: JoinResponse }
  | { kind: 'error'; message: string };

type ChatEntry = {
  // Stable React key — `${ts}:${characterId|'system'}:${seq}`. Server
  // ts isn't unique on its own (rapid joins/leaves can collide).
  id: string;
  kind: 'player' | 'system';
  characterId: string | null;
  displayName: string;
  text: string;
  ts: number;
};

export function Game({ serverId }: { serverId: string }) {
  const router = useRouter();
  // Set when the server sends 'server_paused' so the subsequent
  // ws.onclose can route to the lobby with a friendly banner
  // instead of showing a generic disconnect error.
  const pausedRedirectRef = useRef(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [inventory, setInventory] = useState<Inventory>(() => emptyInventory());
  const [equipment, setEquipment] = useState<Equipment>(() => emptyEquipment());
  const [hotbarSelection, setHotbarSelection] = useState(0);
  const [sceneId, setSceneId] = useState<string>('surface');
  // Epoch ms when an in-progress reload completes; null = not reloading.
  // Set on reload_started for the local player; cleared on weapon_reloaded.
  const [reloadEndsAt, setReloadEndsAt] = useState<number | null>(null);
  // Chat log. Capped to a sliding window so old messages roll off; the
  // visible panel always shows the most recent few. System messages
  // (joins, leaves, deaths) and player-typed lines are stored here
  // together, distinguished by the kind field on each entry.
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const nextChatKeyRef = useRef(0);
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
  // Active timed effects on self. Server is authoritative; ticks
  // expire entries server-side and re-broadcasts. Used by the
  // ActiveEffectsHud beneath the AmmoHud.
  const [activeEffects, setActiveEffects] = useState<
    import('@dumrunner/shared').PlayerEffect[]
  >([]);
  // Minimap toggle. Defaults on; bound to 'N' so 'M' (mute) stays
  // its current binding. Persisted to localStorage so the player's
  // preference survives reloads.
  const [showMinimap, setShowMinimap] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('dr_minimap') !== '0';
  });
  const showMinimapRef = useRef(showMinimap);
  useEffect(() => {
    showMinimapRef.current = showMinimap;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('dr_minimap', showMinimap ? '1' : '0');
    }
  }, [showMinimap]);
  // Surface power state — capacity scales with deepest floor reached, draw
  // is the count of consuming buildings (turrets + Phase-4 craft jobs).
  // Powered set tells the renderer which buildings are currently online so
  // the unpowered ones can render dimmed.
  const [powerState, setPowerState] = useState<{
    capacity: number;
    draw: number;
    online: boolean;
    poweredBuildingIds: Set<string>;
  }>({
    capacity: 0,
    draw: 0,
    online: false,
    poweredBuildingIds: new Set(),
  });
  // Active async craft jobs the player owns. Server pushes craft_job_started
  // / completed deltas; we mirror them locally so the workstation modal
  // can render progress bars without polling.
  const [craftJobs, setCraftJobs] = useState<CraftJobState[]>([]);
  // Surface buildings keyed by id. Powered by the same WS messages the
  // renderer consumes; lets the workstation modal read output buffers
  // without round-tripping through the renderer.
  const [buildings, setBuildings] = useState<Map<string, BuildingState>>(
    () => new Map()
  );
  // Transient on-screen toast for server-pushed error messages.
  const [toast, setToast] = useState<{ message: string; key: number } | null>(
    null
  );
  // Triggers the LINK SEVERED full-screen glitch overlay when set. Auto-
  // clears after a short window; the regular respawn flow handles state.
  const [linkSeveredAt, setLinkSeveredAt] = useState<number | null>(null);
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
  // Ref mirror so the keydown effect (set up once) reads the live value.
  const nearWorkstationsRef = useRef<Set<BuildingKind>>(new Set());
  // Single closest station kind in range — drives the E prompt and the
  // E action so overlapping ranges don't show two prompts.
  const [nearestStation, setNearestStation] = useState<BuildingKind | null>(
    null
  );
  const nearestStationRef = useRef<BuildingKind | null>(null);
  // Nearest door building id within reach. Drives the "Open Door" prompt
  // and the E action when no other interactable / station wins.
  const [nearestDoorId, setNearestDoorId] = useState<string | null>(null);
  const nearestDoorIdRef = useRef<string | null>(null);
  // Storage chest in range, or null. Stored as id (not just kind) so
  // we can identify which specific chest the player wants to open
  // when multiple are placed near each other.
  const [nearestChestId, setNearestChestId] = useState<string | null>(null);
  const nearestChestIdRef = useRef<string | null>(null);
  // Open chest modal target. Null when not viewing any chest.
  const [chestModalId, setChestModalId] = useState<string | null>(null);
  const chestModalIdRef = useRef<string | null>(null);
  const [showTradeModal, setShowTradeModal] = useState(false);
  // Refs mirror the modal flags so the global keydown effect (set up with
  // [] deps) reads live values without needing exhaustive deps.
  const showTradeModalRef = useRef(false);
  const stationModalKindRef = useRef<BuildingKind | null>(null);
  const showInventoryRef = useRef(false);
  // Currently-open workstation modal (workbench / forge / electronics_bench),
  // or null when no station modal is mounted. Mutually exclusive with the
  // trade modal — opening one closes the other.
  const [stationModalKind, setStationModalKind] = useState<BuildingKind | null>(
    null
  );
  // Self HP / shield / stamina mirror, kept in React state so the
  // character panel can render the base + suit breakdown.
  type SelfStats = {
    hp: number;
    maxHp: number;
    shield: number;
    maxShield: number;
    stamina: number;
    maxStamina: number;
  };
  const [selfStats, setSelfStats] = useState<SelfStats>(() => ({
    hp: 100,
    maxHp: 100,
    shield: 0,
    maxShield: 0,
    stamina: 100,
    maxStamina: 100,
  }));
  const selfIdRef = useRef<string | null>(null);
  // Audio-bookkeeping refs. Compare the previous frame's snapshot
  // against the next message's payload to fire pickup/damage SFX
  // exactly once per real change.
  const prevInventoryRef = useRef<Inventory | null>(null);
  const prevSelfHpRef = useRef<number>(100);
  const lastFootstepAtRef = useRef<number>(0);
  // Renderer pick. Initialised from URL param `?fps=1` for backwards-compat;
  // the V hotkey toggles it at runtime.
  const [useFps, setUseFps] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('fps') === '1';
  });
  // Captured WS-callback bundle so the toggle handler can re-instantiate
  // the renderer without losing access to session.ws.
  const rendererCallbacksRef = useRef<{
    sendInput: (mx: number, my: number, sprint: boolean) => void;
    sendFire: (dx: number, dy: number) => void;
    sendBuild: (kind: BuildingKind, tx: number, ty: number) => void;
    sendDemolish: (id: string) => void;
    onNearInteractableChanged: (
      near: { id: string; label: string } | null
    ) => void;
    onNearWorkstationsChanged: (state: {
      all: BuildingKind[];
      nearest: BuildingKind | null;
      nearestDoorId: string | null;
      nearestChestId: string | null;
    }) => void;
  } | null>(null);
  // Holds the live ws so number-key handlers can send select_hotbar without
  // closing over render-time scope.
  const wsForHotbar = useRef<WebSocket | null>(null);
  // Inventory + hotbar refs for keypress handlers (which are bound once
  // and need the latest values at fire time).
  const inventoryRef = useRef<Inventory>(emptyInventory());
  const hotbarSelectionRef = useRef<number>(0);
  // Asset index from asset_gen. Loaded once at mount; the renderer
  // queries this via getEnemyTexture below to swap procedural shapes
  // for AI sprites when available.
  const assetIndexRef = useRef<AssetIndex | null>(null);

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

        const ws = new WebSocket(rewriteGameWsUrl(resp.wsUrl));
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
          // Pause-driven close (server_paused message arrived first,
          // OR the close came in with code 4090). Route to lobby
          // with a banner instead of a disconnect error.
          if (pausedRedirectRef.current || event.code === 4090) {
            router.replace('/servers?notice=server_paused');
            return;
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
        setBuildings(new Map(msg.buildings.map((b) => [b.id, b])));
        selfIdRef.current = msg.self.characterId;
        prevSelfHpRef.current = msg.self.hp;
        prevInventoryRef.current = msg.inventory;
        setSelfStats({
          hp: msg.self.hp,
          maxHp: msg.self.maxHp,
          shield: msg.self.shield,
          maxShield: msg.self.maxShield,
          stamina: msg.self.stamina,
          maxStamina: msg.self.maxStamina,
        });
        wsForHotbar.current = session.ws;
        // Capture the WS-bound callbacks once, in a ref. The renderer hot-
        // swap (V key) uses this same bundle to re-instantiate without
        // needing access to `session` outside the welcome closure.
        rendererCallbacksRef.current = {
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
          onNearWorkstationsChanged: ({
            all,
            nearest,
            nearestDoorId,
            nearestChestId,
          }) => {
            const set = new Set(all);
            nearWorkstationsRef.current = set;
            setNearWorkstations(set);
            nearestStationRef.current = nearest;
            setNearestStation(nearest);
            nearestDoorIdRef.current = nearestDoorId;
            setNearestDoorId(nearestDoorId);
            nearestChestIdRef.current = nearestChestId;
            setNearestChestId(nearestChestId);
          },
        };
        requestAnimationFrame(() => {
          if (session.cancelled) return;
          const host = canvasHostRef.current;
          if (!host || gameRef.current) return;
          const cb = rendererCallbacksRef.current!;
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
            getEnemyTexture: (kind) =>
              assetIndexRef.current?.getEnemyTexture(kind) ?? null,
            ...cb,
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
        // Footstep SFX for self only, throttled. Server broadcasts a
        // player_moved at every meaningful position delta; we throttle
        // playback to a step cadence (~330ms) so it feels like
        // footfalls rather than a hum.
        if (msg.characterId === selfIdRef.current) {
          const now = performance.now();
          if (now - lastFootstepAtRef.current > 330) {
            lastFootstepAtRef.current = now;
            audio.playSfx('player-footstep');
          }
        }
        break;
      case 'player_damaged':
        gameRef.current?.setPlayerHp(
          msg.characterId,
          msg.hp,
          msg.maxHp,
          msg.shield,
          msg.maxShield
        );
        if (msg.characterId === selfIdRef.current) {
          setSelfStats((s) => ({
            ...s,
            hp: msg.hp,
            maxHp: msg.maxHp,
            shield: msg.shield,
            maxShield: msg.maxShield,
          }));
          // Real damage = hp dropped from the previous frame. Avoids
          // firing on shield regen broadcasts that re-emit max stats.
          if (msg.hp < prevSelfHpRef.current) audio.playSfx('player-hit');
          prevSelfHpRef.current = msg.hp;
        }
        break;
      case 'player_stamina':
        gameRef.current?.setSelfStamina(msg.stamina, msg.maxStamina);
        setSelfStats((s) => ({
          ...s,
          stamina: msg.stamina,
          maxStamina: msg.maxStamina,
        }));
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
        if (msg.characterId === selfIdRef.current) {
          setSelfStats({
            hp: msg.hp,
            maxHp: msg.maxHp,
            shield: msg.shield,
            maxShield: msg.maxShield,
            stamina: msg.stamina,
            maxStamina: msg.maxStamina,
          });
          prevSelfHpRef.current = msg.hp;
        }
        break;
      case 'weapon_swung':
        gameRef.current?.showWeaponSwung(
          msg.characterId,
          msg.weaponId,
          msg.dirX,
          msg.dirY
        );
        break;
      case 'server_paused':
        // Owner triggered a pause. Server will close the WS right
        // after this message; the close handler reads this flag and
        // redirects to /servers with a banner instead of showing a
        // disconnect error.
        pausedRedirectRef.current = true;
        break;
      case 'chat': {
        const entry: ChatEntry = {
          kind: msg.kind,
          characterId: msg.characterId,
          displayName: msg.displayName,
          text: msg.text,
          ts: msg.ts,
          // Stable key so React doesn't reuse entries across pushes.
          id: `${msg.ts}:${msg.characterId ?? 'system'}:${nextChatKeyRef.current++}`,
        };
        setChatLog((prev) => {
          const next = [...prev, entry];
          // Keep last ~80 messages so the buffer doesn't grow forever.
          return next.length > 80 ? next.slice(next.length - 80) : next;
        });
        break;
      }
      case 'reload_started':
        if (msg.characterId === selfIdRef.current) {
          setReloadEndsAt(Date.now() + msg.durationMs);
          // Placeholder reload SFX — collect-scrap roughly evokes the
          // mechanical clank we want until a real reload sample lands.
          audio.playSfx('collect-scrap');
        }
        break;
      case 'weapon_reloaded':
        if (msg.characterId === selfIdRef.current) {
          setReloadEndsAt(null);
        }
        break;
      case 'scene_changed':
        setSceneId(msg.sceneId);
        setEquipment(msg.equipment);
        setBuildings(new Map(msg.buildings.map((b) => [b.id, b])));
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
        audio.playSfx('robot-hit');
        break;
      case 'enemy_killed':
        gameRef.current?.removeEnemy(msg.id);
        audio.playSfx('robot-destroy');
        break;
      case 'projectile_spawned':
        // Self-fired projectiles play the pistol report. Turret-fired
        // projectiles are also ownerKind 'player' but their owner is a
        // building id, not the character — those are silent for now.
        if (
          msg.projectile.ownerKind === 'player' &&
          msg.projectile.ownerCharacterId === selfIdRef.current
        ) {
          audio.playSfx('player-shoot');
        } else if (msg.projectile.ownerKind === 'enemy') {
          audio.playSfx('enemy-shoot');
        }
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
        // building_placed double-duties as "building state changed" —
        // server re-emits when output buffers shift. Replace by id.
        setBuildings((m) => {
          const next = new Map(m);
          next.set(msg.building.id, msg.building);
          return next;
        });
        break;
      case 'building_damaged':
        gameRef.current?.setBuildingHp(msg.id, msg.hp, msg.maxHp);
        setBuildings((m) => {
          const existing = m.get(msg.id);
          if (!existing) return m;
          const next = new Map(m);
          next.set(msg.id, {
            ...existing,
            hp: msg.hp,
            maxHp: msg.maxHp,
          });
          return next;
        });
        break;
      case 'building_destroyed':
        gameRef.current?.removeBuilding(msg.id);
        setBuildings((m) => {
          if (!m.has(msg.id)) return m;
          const next = new Map(m);
          next.delete(msg.id);
          return next;
        });
        break;
      case 'world_clock':
        setWorldClock({
          cycle: msg.cycle,
          secondsToPerihelion: msg.secondsToPerihelion,
          hordeActive: msg.hordeActive,
        });
        break;
      case 'power_state':
        setPowerState({
          capacity: msg.capacity,
          draw: msg.draw,
          online: msg.online,
          poweredBuildingIds: new Set(msg.poweredBuildingIds),
        });
        break;
      case 'player_effects':
        if (msg.characterId === selfIdRef.current) {
          setActiveEffects(msg.effects);
        }
        break;
      case 'craft_job_started':
        // Server emits this both when a new job is enqueued (which
        // may be queued, completesAt=0) AND when a queued job
        // promotes to active. Match by id to update in place.
        setCraftJobs((jobs) => {
          const idx = jobs.findIndex((j) => j.id === msg.job.id);
          if (idx === -1) return [...jobs, msg.job];
          const next = jobs.slice();
          next[idx] = msg.job;
          return next;
        });
        break;
      case 'craft_job_completed':
        setCraftJobs((jobs) => jobs.filter((j) => j.id !== msg.jobId));
        break;
      case 'craft_jobs_state':
        setCraftJobs(msg.jobs);
        break;
      case 'link_severed':
        setLinkSeveredAt(Date.now());
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
      case 'inventory_changed': {
        // Diff the new inventory against the previous snapshot to fire
        // pickup SFX. Pure state changes (sort, equip, swap) shouldn't
        // fire the sound, only net material increases.
        const prev = prevInventoryRef.current;
        if (prev) {
          const prevTotals = totalMaterials(prev);
          const nextTotals = totalMaterials(msg.inventory);
          if (nextTotals.artifact > prevTotals.artifact) {
            audio.playSfx('collect-core');
          } else if (nextTotals.other > prevTotals.other) {
            audio.playSfx('collect-scrap');
          }
        }
        prevInventoryRef.current = msg.inventory;
        setInventory(msg.inventory);
        break;
      }
      case 'equipment_changed':
        setEquipment(msg.equipment);
        break;
      case 'blueprints_changed':
        setKnownBlueprints(new Set(msg.knownBlueprints));
        break;
      case 'error':
        // Expected "can't do this" codes are surfaced via the toast +
        // friendlyErrorMessage; logging them as console.error makes it
        // look like a crash. Only log unknown codes for debugging.
        if (!isExpectedServerError(msg.message)) {
          console.warn('[server error]', msg.message);
        }
        setToast({
          message: friendlyErrorMessage(msg.message),
          key: Date.now(),
        });
        break;
    }
  }

  useEffect(() => {
    void attemptJoin();
    return teardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptJoin]);

  // Preload audio + arm the music once the player interacts (browser
  // autoplay policy blocks audio.play() before any user gesture).
  useEffect(() => {
    audio.preload();
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Load the asset_gen index once at mount. Stays a ref because the
  // renderer queries it lazily on first sight of each enemy kind; it
  // doesn't need to trigger re-renders.
  useEffect(() => {
    let cancelled = false;
    void loadAssetIndex(process.env.NEXT_PUBLIC_ASSET_GEN_URL).then(
      (idx) => {
        if (!cancelled) assetIndexRef.current = idx;
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Background music tracks scene id. Surface = defense theme,
  // dungeon = dungeon theme, anything else (loading) = silent.
  // Cleanup stops music on unmount so it doesn't leak into the
  // server browser / lobby pages after the player exits the match.
  useEffect(() => {
    if (sceneId === 'surface') audio.playMusic('defense');
    else if (sceneId.startsWith('dungeon:')) audio.playMusic('dungeon');
    else audio.playMusic(null);
  }, [sceneId]);
  useEffect(() => {
    return () => {
      audio.playMusic(null);
    };
  }, []);

  useEffect(() => {
    showTradeModalRef.current = showTradeModal;
    if (showTradeModal) audio.playSfx('ui-back');
  }, [showTradeModal]);
  useEffect(() => {
    stationModalKindRef.current = stationModalKind;
    if (stationModalKind !== null) audio.playSfx('ui-back');
  }, [stationModalKind]);
  useEffect(() => {
    showInventoryRef.current = showInventory;
    if (showInventory) audio.playSfx('ui-back');
  }, [showInventory]);

  // Global UI SFX. Click on any non-disabled <button> plays ui-click;
  // hover (entering a new button) plays ui-hover. Implemented as
  // delegated listeners on document so we don't need to wrap every
  // button — and so future modals get the SFX automatically.
  useEffect(() => {
    let lastHoverButton: HTMLButtonElement | null = null;
    let lastHoverAt = 0;
    function isLiveButton(el: EventTarget | null): HTMLButtonElement | null {
      if (!(el instanceof Element)) return null;
      const btn = el.closest('button');
      if (!btn) return null;
      if (btn.disabled) return null;
      return btn as HTMLButtonElement;
    }
    const onClick = (e: MouseEvent) => {
      if (isLiveButton(e.target)) audio.playSfx('ui-click');
    };
    const onPointerOver = (e: PointerEvent) => {
      const btn = isLiveButton(e.target);
      if (!btn) {
        lastHoverButton = null;
        return;
      }
      // pointerover fires for every child element under the button as
      // the cursor moves; throttle so the SFX only plays once per
      // button-entry. 50ms guard catches the worst of the jitter.
      const now = performance.now();
      if (btn === lastHoverButton && now - lastHoverAt < 50) return;
      lastHoverButton = btn;
      lastHoverAt = now;
      audio.playSfx('ui-hover');
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerover', onPointerOver, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('pointerover', onPointerOver, true);
    };
  }, []);
  useEffect(() => {
    inventoryRef.current = inventory;
  }, [inventory]);
  useEffect(() => {
    hotbarSelectionRef.current = hotbarSelection;
  }, [hotbarSelection]);

  // Toast auto-dismiss after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      setToast((cur) => (cur && cur.key === toast.key ? null : cur));
    }, 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Clear the LINK SEVERED overlay once the dramatic window has passed.
  useEffect(() => {
    if (linkSeveredAt === null) return;
    const t = setTimeout(() => setLinkSeveredAt(null), 3500);
    return () => clearTimeout(t);
  }, [linkSeveredAt]);

  // Opening any UI overlay (inventory, trade modal, …) needs to release
  // pointer lock so the cursor reappears for clicking. Closing the overlay
  // leaves it released — browsers don't allow programmatic re-lock without
  // a fresh user gesture, so the player clicks the canvas to re-engage FPS.
  useEffect(() => {
    if (!showInventory && !showTradeModal && !stationModalKind) return;
    if (typeof document === 'undefined') return;
    if (document.pointerLockElement) document.exitPointerLock?.();
  }, [showInventory, showTradeModal, stationModalKind]);

  // Hot-swap renderers when `useFps` flips. We snapshot scene state from
  // the outgoing renderer, destroy it, then instantiate the other one with
  // that state. Skips the very first run because the welcome handler is
  // responsible for the initial mount.
  //
  // CRITICAL: depend ONLY on useFps. Adding inventory / hotbarSelection /
  // sceneId here looks tempting (we read them inside) but it makes the
  // effect re-run on every inventory mutation — which destroys and rebuilds
  // the renderer mid-firefight, exits pointer lock, and dims the screen.
  // The values we read inside the closure are the React-current ones at
  // toggle time, which is what we want.
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (initialMountRef.current) {
      initialMountRef.current = false;
      return;
    }
    const current = gameRef.current;
    const cb = rendererCallbacksRef.current;
    const host = canvasHostRef.current;
    if (!current || !cb || !host) return;
    const snapshot = current.currentSceneState();
    current.destroy();
    gameRef.current = null;
    const runner = useFps ? runFpsGame : runGame;
    gameRef.current = runner(host, {
      self: snapshot.self,
      others: snapshot.players,
      enemies: snapshot.enemies,
      projectiles: snapshot.projectiles,
      loot: snapshot.loot,
      corpses: snapshot.corpses,
      buildings: snapshot.buildings,
      layout: snapshot.layout,
      getEnemyTexture: (kind) =>
        assetIndexRef.current?.getEnemyTexture(kind) ?? null,
      ...cb,
    });
    // Reapply build/weapon mode against the new renderer so the equipped
    // hotbar slot stays in sync.
    const slot = inventory[hotbarSelection];
    const kind =
      sceneId === 'surface' && slot?.kind === 'placeable' && slot.count > 0
        ? slot.buildingKind
        : null;
    gameRef.current.setBuildMode(kind);
    gameRef.current.setEquippedWeapon(
      slot?.kind === 'weapon' ? slot.weapon.weaponId : null
    );
    gameRef.current.setBuildRadiusBonus(
      Math.max(0, Math.floor(computeSuitStats(equipment).buildRadiusBonus))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useFps]);

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
    const weapon = slot?.kind === 'weapon' ? slot.weapon.weaponId : null;
    gameRef.current?.setEquippedWeapon(weapon);
  }, [inventory, hotbarSelection, sceneId]);

  // Push the player's suit-derived build-radius bonus to the renderer
  // whenever equipment changes, so the build-mode ring matches what
  // the server actually accepts. Server applies the same bonus
  // server-side using the same shared computeSuitStats.
  useEffect(() => {
    const stats = computeSuitStats(equipment);
    const bonus = Math.max(0, Math.floor(stats.buildRadiusBonus));
    gameRef.current?.setBuildRadiusBonus(bonus);
  }, [equipment]);

  // Tab toggles the inventory overlay. Number keys 1-9 select the hotbar.
  // preventDefault stops the browser from moving focus around while playing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // While the user is typing into a chat / form input, every key
      // belongs to that input. Don't trigger movement, hotbar swap,
      // build mode, etc. on top of it.
      const ae = document.activeElement;
      if (
        ae instanceof HTMLInputElement ||
        ae instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        // Tab closes any modal first; only toggles inventory when nothing
        // else is open. Avoids the "Tab opens inventory ON TOP of trade
        // modal" stack.
        if (showTradeModalRef.current) {
          setShowTradeModal(false);
          return;
        }
        if (stationModalKindRef.current !== null) {
          setStationModalKind(null);
          return;
        }
        setShowInventory((s) => !s);
        return;
      }
      if (e.key === 'Escape' && chestModalIdRef.current) {
        e.preventDefault();
        chestModalIdRef.current = null;
        setChestModalId(null);
        return;
      }
      if (e.key === 'Escape') {
        setShowInventory(false);
        setShowTradeModal(false);
        setStationModalKind(null);
        return;
      }
      // E to interact. Precedence:
      //   1. layout interactables (stairs / extract)
      //   2. nearest station — uplink opens trade modal,
      //      workbench/forge/electronics_bench opens its modal
      //   3. nearest door — sends open_door (server consumes a key)
      if (e.key === 'e' || e.key === 'E') {
        const near = nearInteractableRef.current;
        if (near) {
          sendOnLiveWs({ type: 'interact', interactableId: near.id });
          return;
        }
        const nearestKind = nearestStationRef.current;
        if (nearestKind === 'artifact_uplink') {
          setStationModalKind(null);
          setShowTradeModal(true);
          return;
        }
        if (
          nearestKind === 'workbench' ||
          nearestKind === 'forge' ||
          nearestKind === 'electronics_bench' ||
          nearestKind === 'weapon_bench'
        ) {
          setShowTradeModal(false);
          setStationModalKind(nearestKind);
          return;
        }
        if (nearestKind === 'storage_chest') {
          const chestId = nearestChestIdRef.current;
          if (chestId) {
            chestModalIdRef.current = chestId;
            setChestModalId(chestId);
          }
          return;
        }
        const doorId = nearestDoorIdRef.current;
        if (doorId) {
          sendOnLiveWs({ type: 'open_door', buildingId: doorId });
          return;
        }
        return;
      }
      // M toggles audio mute. Cheap; works any time.
      if (e.key === 'm' || e.key === 'M') {
        const muted = audio.toggleMuted();
        setToast({
          message: muted ? 'Audio muted' : 'Audio unmuted',
          key: Date.now(),
        });
        return;
      }
      // N toggles the corner minimap.
      if (e.key === 'n' || e.key === 'N') {
        setShowMinimap((v) => !v);
        return;
      }
      // V toggles between top-down and FPS renderers. Swap is hot — we
      // snapshot scene state from the old renderer and seed the new one.
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setUseFps((v) => !v);
        return;
      }
      // F triggers a consumable from the currently selected hotbar slot
      // (e.g. medkit). No-op if the slot isn't a consumable.
      if (e.key === 'f' || e.key === 'F') {
        const inv = inventoryRef.current;
        const sel = hotbarSelectionRef.current;
        const slot = inv[sel];
        if (slot && slot.kind === 'consumable' && slot.count > 0) {
          sendOnLiveWs({ type: 'use_consumable', slot: sel });
        }
        return;
      }
      // R reloads the equipped weapon. Server validates (slot is a
      // ranged weapon, mag isn't full, reserve ammo > 0).
      if (e.key === 'r' || e.key === 'R') {
        sendOnLiveWs({ type: 'reload_weapon' });
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
        <div className="flex items-center gap-3">
          {status.kind === 'connected' && status.resp.isOwner && (
            <PauseServerControl
              onPause={() => sendOnLiveWs({ type: 'pause_server' })}
            />
          )}
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
        <PowerHud state={powerState} />
        <ActiveEffectsHud effects={activeEffects} />
        {showMinimap && <Minimap gameRef={gameRef} />}
        <AmmoHud
          inventory={inventory}
          hotbarSelection={hotbarSelection}
          reloadEndsAt={reloadEndsAt}
        />
        <ChatPanel
          log={chatLog}
          onSend={(text) => sendOnLiveWs({ type: 'chat', text })}
        />
        {nearInteractable && (
          <InteractPrompt label={nearInteractable.label} />
        )}
        {!nearInteractable && nearestStation === 'artifact_uplink' && (
          <InteractPrompt label="Trade — Artifact Uplink" />
        )}
        {!nearInteractable &&
          (nearestStation === 'workbench' ||
            nearestStation === 'forge' ||
            nearestStation === 'electronics_bench') && (
            <InteractPrompt
              label={`Use — ${STATION_LABEL[nearestStation]}`}
            />
          )}
        {!nearInteractable && nearestStation === 'storage_chest' && (
          <InteractPrompt label="Open — Storage" />
        )}
        {!nearInteractable && nearestStation === null && nearestDoorId && (
          <InteractPrompt
            label={
              countMaterial(inventory, 'key') > 0
                ? 'Open Door — costs 1 key'
                : 'Locked — need a key'
            }
          />
        )}
        <ControlsHint useFps={useFps} />
        {toast && <Toast message={toast.message} keyId={toast.key} />}
        {linkSeveredAt !== null && <LinkSeveredOverlay />}

        {showInventory && (
          <InventoryPanel
            inventory={inventory}
            equipment={equipment}
            selected={hotbarSelection}
            stats={selfStats}
            knownBlueprints={knownBlueprints}
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
            nearElectronicsBench={nearWorkstations.has('electronics_bench')}
            onAttachSuitAffix={(suitSlot, defId) =>
              sendOnLiveWs({
                type: 'attach_suit_affix',
                suitSlot,
                attachmentDefId: defId,
              })
            }
            onDetachSuitAffix={(suitSlot, idx) =>
              sendOnLiveWs({
                type: 'detach_suit_affix',
                suitSlot,
                attachmentIndex: idx,
              })
            }
            onCraft={(recipeId) =>
              sendOnLiveWs({ type: 'craft_request', recipeId })
            }
          />
        )}

        {showTradeModal && (
          <TradeModal
            inventory={inventory}
            knownBlueprints={knownBlueprints}
            nearUplink={nearWorkstations.has('artifact_uplink')}
            onClose={() => setShowTradeModal(false)}
            onPurchase={(blueprintId) =>
              sendOnLiveWs({ type: 'purchase_blueprint', blueprintId })
            }
            onPurchaseKey={(count) =>
              sendOnLiveWs({ type: 'purchase_key', count })
            }
          />
        )}

        {stationModalKind && (
          <WorkstationModal
            kind={stationModalKind}
            inventory={inventory}
            knownBlueprints={knownBlueprints}
            nearWorkstations={nearWorkstations}
            craftJobs={craftJobs}
            buildings={buildings}
            onClose={() => setStationModalKind(null)}
            onCraft={(recipeId) =>
              sendOnLiveWs({ type: 'craft_request', recipeId })
            }
            onPickup={(kind) => {
              if (
                kind === 'workbench' ||
                kind === 'forge' ||
                kind === 'electronics_bench' ||
                kind === 'weapon_bench'
              ) {
                sendOnLiveWs({ type: 'pickup_station_outputs', kind });
              }
            }}
            onAttachWeaponAffix={(idx, pieceKind, defId) =>
              sendOnLiveWs({
                type: 'attach_weapon_affix',
                weaponInventoryIdx: idx,
                pieceKind,
                attachmentDefId: defId,
              })
            }
            onDetachWeaponAffix={(idx, pieceKind) =>
              sendOnLiveWs({
                type: 'detach_weapon_affix',
                weaponInventoryIdx: idx,
                pieceKind,
              })
            }
            onAttachWeaponMod={(idx, defId) =>
              sendOnLiveWs({
                type: 'attach_weapon_mod',
                weaponInventoryIdx: idx,
                attachmentDefId: defId,
              })
            }
            onDetachWeaponMod={(idx, modIndex) =>
              sendOnLiveWs({
                type: 'detach_weapon_mod',
                weaponInventoryIdx: idx,
                modIndex,
              })
            }
            onTierUpWeapon={(idx) =>
              sendOnLiveWs({ type: 'tier_up_weapon', weaponInventoryIdx: idx })
            }
          />
        )}

        {chestModalId &&
          (() => {
            const chest = buildings.get(chestModalId);
            // Auto-close if the chest stops existing (destroyed) or
            // the player walks out of range.
            if (
              !chest ||
              chest.kind !== 'storage_chest' ||
              nearestChestId !== chestModalId
            ) {
              setChestModalId(null);
              return null;
            }
            return (
              <StorageChestModal
                inventory={inventory}
                chest={chest}
                onClose={() => setChestModalId(null)}
                onMove={(fromKind, fromIdx, toKind, toIdx) =>
                  sendOnLiveWs({
                    type: 'storage_move',
                    buildingId: chestModalId,
                    fromKind,
                    fromIdx,
                    toKind,
                    toIdx,
                  })
                }
              />
            );
          })()}

        {slotMenu && (
          <SlotContextMenu
            slot={inventory[slotMenu.slot]}
            x={slotMenu.x}
            y={slotMenu.y}
            nearbyPlayers={gameRef.current?.nearbyPlayers(96) ?? []}
            nearWorkbench={nearWorkstations.has('workbench')}
            onSalvage={() => {
              sendOnLiveWs({ type: 'salvage_request', slot: slotMenu.slot });
              setSlotMenu(null);
            }}
            onUse={() => {
              sendOnLiveWs({ type: 'use_consumable', slot: slotMenu.slot });
              setSlotMenu(null);
            }}
            onDropOne={() => {
              sendOnLiveWs({
                type: 'inventory_drop',
                slot: slotMenu.slot,
                all: false,
              });
              setSlotMenu(null);
            }}
            onDropAll={() => {
              sendOnLiveWs({
                type: 'inventory_drop',
                slot: slotMenu.slot,
                all: true,
              });
              setSlotMenu(null);
            }}
            onGiveOne={(targetCharacterId) => {
              sendOnLiveWs({
                type: 'give_item',
                targetCharacterId,
                slot: slotMenu.slot,
                all: false,
              });
              setSlotMenu(null);
            }}
            onGiveAll={(targetCharacterId) => {
              sendOnLiveWs({
                type: 'give_item',
                targetCharacterId,
                slot: slotMenu.slot,
                all: true,
              });
              setSlotMenu(null);
            }}
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

function ControlsHint({ useFps }: { useFps: boolean }) {
  return (
    <div className="absolute bottom-3 right-3 text-xs text-zinc-500 select-none pointer-events-none flex flex-col items-end gap-1">
      <div>
        <Kbd>V</Kbd>
        <span className="ml-2">{useFps ? 'top-down' : 'first-person'}</span>
      </div>
      <div>
        <Kbd>Tab</Kbd>
        <span className="ml-2">inventory</span>
      </div>
      <div>
        <Kbd>E</Kbd>
        <span className="ml-2">interact</span>
      </div>
      {useFps ? (
        <div>
          <Kbd>WASD</Kbd>
          <span className="ml-2">forward / strafe</span>
        </div>
      ) : (
        <div>
          <Kbd>WASD</Kbd>
          <span className="ml-2">move</span>
        </div>
      )}
      <div>
        <Kbd>Shift</Kbd>
        <span className="ml-2">sprint</span>
      </div>
      <div>
        <Kbd>1–9</Kbd>
        <span className="ml-2">hotbar</span>
      </div>
      <div>
        <Kbd>M</Kbd>
        <span className="ml-2">mute</span>
      </div>
    </div>
  );
}

// Top-centre clock + perihelion countdown. Switches into a red "siege"
// state while the horde is active.
// Full-screen "LINK SEVERED" glitch overlay. Fires when perihelion catches
// the player in a dungeon — they're killed in place and respawn at the
// surface; this overlay sells the dramatic moment.
function LinkSeveredOverlay() {
  return (
    <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center select-none">
      <div className="absolute inset-0 bg-black/85 animate-pulse" />
      <div className="absolute inset-0 mix-blend-screen opacity-80">
        {/* Scanline / static pattern */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'repeating-linear-gradient(0deg, rgba(255,0,80,0.08) 0px, rgba(255,0,80,0.08) 2px, transparent 2px, transparent 4px)',
          }}
        />
      </div>
      <div className="relative flex flex-col items-center gap-3">
        <div
          className="text-red-500 font-bold tracking-[0.3em] text-5xl uppercase"
          style={{
            textShadow:
              '2px 0 #00ffff, -2px 0 #ff0080, 0 0 24px rgba(255, 0, 80, 0.8)',
            animation: 'link-severed-glitch 200ms steps(2) infinite',
          }}
        >
          Link Severed
        </div>
        <div className="text-zinc-300 text-sm tracking-widest uppercase">
          Returning to surface…
        </div>
      </div>
      <style jsx>{`
        @keyframes link-severed-glitch {
          0% { transform: translate(0, 0); }
          25% { transform: translate(-2px, 1px); }
          50% { transform: translate(2px, -1px); }
          75% { transform: translate(-1px, 2px); }
          100% { transform: translate(0, 0); }
        }
      `}</style>
    </div>
  );
}

// Sum every material stack into two buckets so the pickup-SFX diff
// can tell "got an artifact" apart from "got anything else."
function totalMaterials(inv: Inventory): { artifact: number; other: number } {
  let artifact = 0;
  let other = 0;
  for (const slot of inv) {
    if (slot.kind !== 'material') continue;
    if (slot.materialId === 'artifact') artifact += slot.count;
    else other += slot.count;
  }
  return { artifact, other };
}

// Map server error codes to player-facing copy. Anything not listed
// falls through to a humanised version of the raw code.
function friendlyErrorMessage(code: string): string {
  switch (code) {
    case 'station_busy':
      return 'Station is busy — wait for the current job or build another station.';
    case 'station_queue_full':
      return 'Station queue is full — wait for a job to finish or build another station.';
    case 'insufficient_power':
      return 'Not enough power. Push deeper into the dungeon to raise capacity.';
    case 'power_link_offline':
      return 'Power Link is destroyed. Wait for the next perihelion to rebuild.';
    case 'pause_owner_only':
      return 'Only the server owner can pause.';
    case 'salvage_needs_workbench':
      return 'Stand near a workbench to salvage.';
    case 'salvage_unsupported_kind':
      return 'This item can\'t be salvaged.';
    case 'salvage_no_recipe':
      return 'No salvage value — no known recipe.';
    case 'give_too_far':
      return 'Too far from the recipient.';
    case 'recipient_inventory_full':
      return 'Their bag is full.';
    default:
      return code.replace(/_/g, ' ');
  }
}

// Codes the server emits for routine "can't do this" interactions —
// covered by friendlyErrorMessage above. Anything outside this set is
// surprising and worth logging.
function isExpectedServerError(code: string): boolean {
  return (
    code === 'station_busy' ||
    code === 'station_queue_full' ||
    code === 'insufficient_power' ||
    code === 'power_link_offline' ||
    code === 'pause_owner_only' ||
    code === 'salvage_needs_workbench' ||
    code === 'salvage_unsupported_kind' ||
    code === 'salvage_no_recipe' ||
    code === 'give_too_far' ||
    code === 'recipient_inventory_full'
  );
}

// Transient on-screen toast for server-pushed errors. Shows top-right
// of the canvas; auto-dismisses via a useEffect on the host.
function Toast({ message }: { message: string; keyId: number }) {
  return (
    <div className="absolute top-3 right-3 pointer-events-none z-40 select-none animate-fade-in">
      <div className="px-3 py-2 rounded border-2 border-amber-500 bg-amber-950/95 text-amber-100 text-xs shadow-[0_4px_16px_rgba(0,0,0,0.5)] max-w-xs">
        {message}
      </div>
    </div>
  );
}

// Compact "Power N/M" overlay. Sits below the cycle clock so the player
// can read both at a glance. Goes red when capacity = 0 (Power Link
// destroyed or never alive).
// Stack of small chips above the AmmoHud showing active timed
// buffs/debuffs with their remaining seconds. Server pushes the
// authoritative list via 'player_effects'; client just displays.
// Per-effect dedup happens server-side (matching id refreshes the
// timer rather than stacking) so the chips never duplicate.
// Corner minimap. Backed by GameHandle.paintMinimap which both
// renderers (pixi top-down + fps) implement against their own
// state. Repainted at 10 Hz — stays smooth without burning CPU
// on a high-frequency repaint that the player would never notice.
function Minimap({
  gameRef,
}: {
  gameRef: React.RefObject<GameHandle | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const FRAME_MS = 120; // ~10 Hz
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      const c = canvasRef.current;
      const g = gameRef.current;
      if (!c || !g) return;
      // World radius shown around the player. 12 tiles ≈ 384px in
      // either direction is wide enough to see the surrounding base
      // without zooming out so far that detail vanishes.
      g.paintMinimap(c, 384);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameRef]);
  return (
    <div className="absolute bottom-2 right-32 pointer-events-none select-none z-30">
      <canvas
        ref={canvasRef}
        width={140}
        height={140}
        className="rounded border border-[color:var(--panel-border)] shadow-lg"
      />
      <div className="text-[9px] text-zinc-500 text-center mt-1 uppercase tracking-wider">
        N
      </div>
    </div>
  );
}

function ActiveEffectsHud({
  effects,
}: {
  effects: import('@dumrunner/shared').PlayerEffect[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (effects.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [effects.length]);
  if (effects.length === 0) return null;
  // Group effects by label so a stim's two child entries (speed +
  // stamina regen) render as one chip with the soonest-expiring
  // timer. Keeps the HUD compact without dropping detail.
  const grouped = new Map<string, { label: string; expiresAt: number }>();
  for (const e of effects) {
    const cur = grouped.get(e.label);
    if (!cur || e.expiresAt < cur.expiresAt) {
      grouped.set(e.label, { label: e.label, expiresAt: e.expiresAt });
    }
  }
  return (
    <div className="absolute top-[80px] right-3 pointer-events-none select-none flex flex-col gap-1 items-end z-30">
      {[...grouped.values()].map((g) => {
        const remaining = Math.max(0, Math.ceil((g.expiresAt - now) / 1000));
        return (
          <div
            key={g.label}
            className="px-2 py-1 rounded border border-cyan-700/60 bg-cyan-950/80 text-cyan-100 text-[10px] tabular-nums flex items-center gap-2"
          >
            <span className="uppercase tracking-wider">{g.label}</span>
            <span className="text-cyan-300">{remaining}s</span>
          </div>
        );
      })}
    </div>
  );
}

function PowerHud({
  state,
}: {
  state: {
    capacity: number;
    draw: number;
    online: boolean;
  };
}) {
  const overdrawn = state.draw > state.capacity;
  return (
    <div className="absolute top-12 left-1/2 -translate-x-1/2 pointer-events-none select-none">
      <div
        className={`px-2.5 py-1 rounded-full border text-[11px] flex items-center gap-2 ${
          !state.online
            ? 'bg-red-950/90 border-red-500 text-red-100'
            : overdrawn
              ? 'bg-amber-950/90 border-amber-500 text-amber-100'
              : 'bg-[color:var(--panel)]/90 border-[color:var(--panel-border)] text-cyan-200'
        }`}
      >
        <span className="text-zinc-400 uppercase tracking-wider text-[9px]">
          Power
        </span>
        <span className="tabular-nums">
          {state.draw}
          <span className="text-zinc-500">/</span>
          {state.capacity}
        </span>
        {!state.online && (
          <span className="text-[9px] uppercase tracking-wider">offline</span>
        )}
      </div>
    </div>
  );
}

// Magazine readout for the equipped weapon. Sits bottom-right of the
// canvas; reads `loaded / mag-size  •  reserve`. Hidden when nothing
// rangedis selected. Also shows a "RELOADING" pip while the timer is
// counting down, with progress driven directly off Date.now().
function AmmoHud({
  inventory,
  hotbarSelection,
  reloadEndsAt,
}: {
  inventory: Inventory;
  hotbarSelection: number;
  reloadEndsAt: number | null;
}) {
  const slot = inventory[hotbarSelection];
  // rAF-driven reload bar — re-render this component every frame so
  // the progress fill animates without re-rendering the entire HUD.
  const barRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reloadEndsAt === null) {
      if (barRef.current) barRef.current.style.width = '0%';
      if (labelRef.current) labelRef.current.textContent = '';
      return;
    }
    const startedAt = Date.now();
    const total = Math.max(1, reloadEndsAt - startedAt);
    let raf = 0;
    const tick = () => {
      const remaining = Math.max(0, reloadEndsAt - Date.now());
      const t = 1 - remaining / total;
      if (barRef.current) {
        barRef.current.style.width = `${(t * 100).toFixed(2)}%`;
      }
      if (labelRef.current) {
        labelRef.current.textContent = `RELOADING ${(remaining / 1000).toFixed(1)}s`;
      }
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reloadEndsAt]);

  if (!slot || slot.kind !== 'weapon') return null;
  const family = WEAPON_FAMILY[slot.weapon.weaponId];
  if (family === 'melee') return null;
  const mag = slot.weapon.magazineRemaining;
  const ammoKind = AMMO_KIND_BY_FAMILY[family];
  const reserve = ammoKind ? countAmmo(inventory, ammoKind) : 0;
  // Top-RIGHT corner. Bottom-left is owned by the HP/shield/stamina
  // bar stack (drawn in pixi.ts; shield stacks on top of HP when
  // present, taking ~60–80px of vertical room). Bottom-right is the
  // controls hint. Top-center is the world clock + power pill. The
  // top-right is empty except for transient error toasts, which only
  // briefly overlap.
  return (
    <div className="absolute top-3 right-3 pointer-events-none select-none">
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-baseline gap-2 px-3 py-1.5 rounded bg-[color:var(--panel)]/90 border border-[color:var(--panel-border)]">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400">
            {weaponDisplayName(slot.weapon)}
          </span>
          <span className="text-2xl font-bold text-zinc-100 tabular-nums leading-none">
            {mag ?? 0}
          </span>
          <span className="text-zinc-500 text-sm tabular-nums">
            / {reserve}
          </span>
        </div>
        {reloadEndsAt !== null && (
          <div className="w-44 px-2 py-1 rounded bg-[color:var(--panel)]/90 border border-amber-700">
            <div className="flex justify-between items-center">
              <span ref={labelRef} className="text-[10px] tracking-wider text-amber-200">
                RELOADING
              </span>
            </div>
            <div className="h-1 mt-1 rounded bg-black/40 overflow-hidden">
              <div ref={barRef} className="h-full bg-amber-400" style={{ width: '0%' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const AMMO_KIND_BY_FAMILY: Record<string, 'pistol_basic' | 'smg_basic' | 'shotgun_shells' | 'rifle_rounds' | null> = {
  pistol: 'pistol_basic',
  smg: 'smg_basic',
  shotgun: 'shotgun_shells',
  rifle: 'rifle_rounds',
  melee: null,
};

// Top-left chat. Always-visible message log + an input that activates
// on Enter. While the input is focused, the renderer's keydown
// listeners ignore movement keys (see isFormFocus in pixi.ts/fps.ts)
// so typing doesn't slide the character. Esc blurs without sending.
function ChatPanel({
  log,
  onSend,
}: {
  log: ChatEntry[];
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Focus chat with Enter. Blur on Esc. Mounted globally so the
  // player can pop chat from anywhere without aiming at the input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const ae = document.activeElement;
      const isInChat = ae === inputRef.current;
      if (e.key === 'Enter' && !isInChat) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === 'Escape' && isInChat) {
        inputRef.current?.blur();
        setDraft('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Auto-scroll the message list to the bottom when a new entry lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <div className="absolute top-3 left-3 pointer-events-none select-none flex flex-col gap-1 w-[320px] max-w-[40vw]">
      <div
        ref={scrollRef}
        className="flex flex-col gap-0.5 max-h-[28vh] overflow-y-auto text-xs"
      >
        {log.map((m) => (
          <div
            key={m.id}
            className={
              m.kind === 'system'
                ? 'text-zinc-500 italic'
                : 'text-zinc-100'
            }
          >
            {m.kind === 'system' ? (
              <span>— {m.text}</span>
            ) : (
              <>
                <span className="text-cyan-300">{m.displayName}:</span>{' '}
                <span>{m.text}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const text = draft.trim();
            if (text.length > 0) onSend(text);
            setDraft('');
            inputRef.current?.blur();
          }
        }}
        placeholder="Press Enter to chat…"
        maxLength={280}
        className="pointer-events-auto px-2 py-1 text-xs rounded bg-[color:var(--panel)] border border-[color:var(--panel-border)] text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-[color:var(--accent)]"
      />
    </div>
  );
}

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

// Aliased import — TIER_HEX is the legacy local name, TIER_COLORS_HEX
// is the shared single-source-of-truth. Both renderers + this file
// pull from the same table.
const TIER_HEX = TIER_COLORS_HEX;

function InventoryPanel({
  inventory,
  equipment,
  selected,
  stats,
  knownBlueprints,
  onClose,
  onSwap,
  onSort,
  onContextMenu,
  onEquip,
  onUnequip,
  nearElectronicsBench,
  onAttachSuitAffix,
  onDetachSuitAffix,
  onCraft,
}: {
  inventory: Inventory;
  equipment: Equipment;
  selected: number;
  stats: {
    hp: number;
    maxHp: number;
    shield: number;
    maxShield: number;
    stamina: number;
    maxStamina: number;
  };
  knownBlueprints: Set<string>;
  onClose: () => void;
  onSwap: (from: number, to: number) => void;
  onSort: () => void;
  onContextMenu: (slot: number, x: number, y: number) => void;
  onEquip: (fromInventoryIdx: number, suitSlot: SuitSlotKind) => void;
  onUnequip: (suitSlot: SuitSlotKind, toInventoryIdx?: number) => void;
  nearElectronicsBench: boolean;
  onAttachSuitAffix: (suitSlot: SuitSlotKind, defId: string) => void;
  onDetachSuitAffix: (suitSlot: SuitSlotKind, idx: number) => void;
  onCraft: (recipeId: string) => void;
}) {
  const hotbar = inventory.slice(0, HOTBAR_SIZE);
  const bag = inventory.slice(HOTBAR_SIZE);

  return (
    <Modal onClose={onClose} width="fit-content">
      <div className="flex items-center justify-between px-5 py-4 border-b-2 border-[color:var(--accent)]/30 bg-[color:var(--bg)]/50 gap-6">
        <h2 className="font-semibold text-base">Inventory</h2>
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
        <div className="flex flex-col gap-3">
          <CharacterPanel
            equipment={equipment}
            stats={stats}
            onEquip={onEquip}
            onUnequip={onUnequip}
          />
          <SuitAffixPanel
            equipment={equipment}
            inventory={inventory}
            nearElectronicsBench={nearElectronicsBench}
            onAttach={onAttachSuitAffix}
            onDetach={onDetachSuitAffix}
          />
        </div>
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
            onCraft={onCraft}
          />
        </div>
      </div>
    </Modal>
  );
}

// Artifact uplink trade store. Lists every blueprint in the catalog;
// blueprints already known render as "Owned" and can't be re-bought.
// Buy is gated on (a) being near an uplink — server checks it again, but
// the local check stops accidental purchases when the player wandered
// off — and (b) having enough artifacts.
function TradeModal({
  inventory,
  knownBlueprints,
  nearUplink,
  onClose,
  onPurchase,
  onPurchaseKey,
}: {
  inventory: Inventory;
  knownBlueprints: Set<string>;
  nearUplink: boolean;
  onClose: () => void;
  onPurchase: (blueprintId: string) => void;
  onPurchaseKey: (count: number) => void;
}) {
  const [tab, setTab] = useState<'blueprints' | 'keys'>('blueprints');
  const artifacts = countMaterial(inventory, 'artifact');
  const heldKeys = countMaterial(inventory, 'key');
  return (
    <Modal onClose={onClose} width="min(640px, 92vw)">
      <div className="flex items-center justify-between px-5 py-4 border-b-2 border-[color:var(--accent)]/30 bg-[color:var(--bg)]/50 gap-4">
        <h2 className="font-semibold flex items-center gap-2 text-base">
          <ItemIcon kind="material" subkind="artifact" />
          <span>Artifact Uplink</span>
        </h2>
        <div className="text-xs text-zinc-400">
          Held: <span className="text-pink-400 font-semibold">{artifacts}</span>{' '}
          artifact{artifacts === 1 ? '' : 's'}
        </div>
        <button
          onClick={onClose}
          className="px-2 py-1 rounded text-xs border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)]"
        >
          Close
        </button>
      </div>
      <div className="flex border-b border-[color:var(--panel-border)] bg-[color:var(--bg)]/30">
        {(['blueprints', 'keys'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'px-4 py-2 text-xs uppercase tracking-wider transition-colors ' +
              (tab === t
                ? 'text-zinc-100 border-b-2 border-[color:var(--accent)] -mb-px'
                : 'text-zinc-500 hover:text-zinc-300')
            }
          >
            {t}
          </button>
        ))}
      </div>
      {!nearUplink && (
        <div className="px-5 py-2 border-b border-[color:var(--panel-border)] text-amber-400/80 text-xs">
          Move closer to the uplink to trade.
        </div>
      )}
      {tab === 'blueprints' ? (
        <TradeBlueprintsList
          knownBlueprints={knownBlueprints}
          artifacts={artifacts}
          nearUplink={nearUplink}
          onPurchase={onPurchase}
        />
      ) : (
        <TradeKeysPanel
          artifacts={artifacts}
          heldKeys={heldKeys}
          nearUplink={nearUplink}
          onPurchaseKey={onPurchaseKey}
        />
      )}
    </Modal>
  );
}

function TradeBlueprintsList({
  knownBlueprints,
  artifacts,
  nearUplink,
  onPurchase,
}: {
  knownBlueprints: Set<string>;
  artifacts: number;
  nearUplink: boolean;
  onPurchase: (blueprintId: string) => void;
}) {
  const blueprints = listBlueprints();
  return (
    <ul className="divide-y divide-[color:var(--panel-border)] overflow-y-auto max-h-[60vh]">
      {blueprints.map((bp) => {
        const owned = knownBlueprints.has(bp.id);
        const canAfford = artifacts >= bp.cost;
        const enabled = nearUplink && !owned && canAfford;
        let reason = '';
        if (owned) reason = 'Owned';
        else if (!nearUplink) reason = 'Out of range';
        else if (!canAfford) reason = `Need ${bp.cost - artifacts} more`;
        return (
          <li key={bp.id} className="px-4 py-3 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-zinc-200">
                {blueprintDisplayName(bp)}
              </div>
              <div className="text-[11px] text-zinc-500">{bp.description}</div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 mt-0.5">
                {bp.tier}
              </div>
            </div>
            <div className="text-right text-xs text-pink-400 tabular-nums whitespace-nowrap">
              {bp.cost} artifact{bp.cost === 1 ? '' : 's'}
            </div>
            <button
              onClick={() => onPurchase(bp.id)}
              disabled={!enabled}
              title={enabled ? '' : reason}
              className="px-3 py-1.5 rounded text-xs border border-[color:var(--panel-border)] text-zinc-200 hover:bg-[color:var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {owned ? 'Owned' : 'Buy'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TradeKeysPanel({
  artifacts,
  heldKeys,
  nearUplink,
  onPurchaseKey,
}: {
  artifacts: number;
  heldKeys: number;
  nearUplink: boolean;
  onPurchaseKey: (count: number) => void;
}) {
  const [count, setCount] = useState(1);
  const totalCost = count * KEY_ARTIFACT_COST;
  const canAfford = artifacts >= totalCost;
  const enabled = nearUplink && canAfford && count >= 1;
  const reason = !nearUplink
    ? 'Out of range'
    : !canAfford
    ? `Need ${totalCost - artifacts} more`
    : '';
  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center gap-3">
        <ItemIcon kind="material" subkind="key" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-zinc-200">Key</div>
          <div className="text-[11px] text-zinc-500">
            Opens any locked dungeon door. {KEY_ARTIFACT_COST} artifact each.
          </div>
        </div>
        <div className="text-[11px] text-zinc-500 whitespace-nowrap">
          Held: <span className="text-yellow-300 font-semibold">{heldKeys}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 pt-2">
        <label className="text-xs text-zinc-400">Quantity</label>
        <input
          type="number"
          min={1}
          max={10}
          value={count}
          onChange={(e) => {
            const n = Math.max(
              1,
              Math.min(10, Math.floor(Number(e.target.value) || 1))
            );
            setCount(n);
          }}
          className="w-16 px-2 py-1 rounded bg-[color:var(--bg)] border border-[color:var(--panel-border)] text-sm text-zinc-100 text-right tabular-nums"
        />
        <div className="text-xs text-pink-400 tabular-nums">
          {totalCost} artifact{totalCost === 1 ? '' : 's'}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => onPurchaseKey(count)}
          disabled={!enabled}
          title={enabled ? '' : reason}
          className="px-3 py-1.5 rounded text-xs border border-[color:var(--panel-border)] text-zinc-200 hover:bg-[color:var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Buy
        </button>
      </div>
    </div>
  );
}

// Shared modal chrome: dimmed backdrop, accent border, drop shadow,
// click-outside-to-close. All overlays (inventory, trade, workstation)
// pass through this so the visual weight is consistent and the panel
// reads as foregrounded against the gameworld behind it.
function Modal({
  children,
  onClose,
  width = 'min(640px, 92vw)',
}: {
  children: React.ReactNode;
  onClose: () => void;
  width?: string;
}) {
  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center pt-6 pointer-events-auto"
      onMouseDown={(e) => {
        // Click on the backdrop (not the panel) closes the modal.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
      {/* Panel */}
      <div
        className="relative bg-[color:var(--panel)] border-2 border-[color:var(--accent)] rounded-lg shadow-[0_24px_60px_rgba(0,0,0,0.6)] overflow-hidden"
        style={{ width, maxHeight: 'calc(100vh - 64px)' }}
      >
        {children}
      </div>
    </div>
  );
}

// Per-workstation crafting modal. Opens when the player presses E within
// range of a workbench / forge / electronics_bench. Lists every recipe
// that targets THIS station + that the player has the blueprint for.
function WorkstationModal({
  kind,
  inventory,
  knownBlueprints,
  nearWorkstations,
  craftJobs,
  buildings,
  onClose,
  onCraft,
  onPickup,
  onAttachWeaponAffix,
  onDetachWeaponAffix,
  onAttachWeaponMod,
  onDetachWeaponMod,
  onTierUpWeapon,
}: {
  kind: BuildingKind;
  inventory: Inventory;
  knownBlueprints: Set<string>;
  nearWorkstations: Set<BuildingKind>;
  craftJobs: CraftJobState[];
  buildings: Map<string, BuildingState>;
  onClose: () => void;
  onCraft: (recipeId: string) => void;
  onPickup: (kind: BuildingKind) => void;
  onAttachWeaponAffix: (
    weaponIdx: number,
    pieceKind: WeaponPieceKind,
    defId: string
  ) => void;
  onDetachWeaponAffix: (
    weaponIdx: number,
    pieceKind: WeaponPieceKind
  ) => void;
  onAttachWeaponMod: (weaponIdx: number, defId: string) => void;
  onDetachWeaponMod: (weaponIdx: number, modIndex: number) => void;
  onTierUpWeapon: (weaponIdx: number) => void;
}) {
  // Jobs running at THIS station kind so the queue stays scoped.
  // Sort active first (so the timer is visible at the top), then
  // queued in FIFO order (queueIndex ascending).
  const jobsAtStation = craftJobs
    .filter((j) => j.stationKind === kind)
    .sort((a, b) => {
      const aActive = a.completesAt > 0;
      const bActive = b.completesAt > 0;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return (a.queueIndex ?? 0) - (b.queueIndex ?? 0);
    });
  // Aggregate every output slot across every nearby station of this
  // kind. Server enforces proximity at pickup, but client uses raw
  // building list since it doesn't know exactly which are in range —
  // close enough that the modal is open implies at least one is.
  const stationsOfKind: BuildingState[] = [];
  for (const b of buildings.values()) {
    if (b.kind === kind) stationsOfKind.push(b);
  }
  const aggregateOutput: InventorySlot[] = [];
  for (const b of stationsOfKind) {
    if (!b.output) continue;
    for (const slot of b.output) {
      if (slot.kind === 'empty') continue;
      // Stack-merge same-id materials/ammo/placeables for a clean readout.
      let merged = false;
      for (const existing of aggregateOutput) {
        if (
          existing.kind === 'material' &&
          slot.kind === 'material' &&
          existing.materialId === slot.materialId
        ) {
          existing.count += slot.count;
          merged = true;
          break;
        }
        if (
          existing.kind === 'ammo' &&
          slot.kind === 'ammo' &&
          existing.ammoId === slot.ammoId
        ) {
          existing.count += slot.count;
          merged = true;
          break;
        }
        if (
          existing.kind === 'placeable' &&
          slot.kind === 'placeable' &&
          existing.buildingKind === slot.buildingKind
        ) {
          existing.count += slot.count;
          merged = true;
          break;
        }
      }
      if (!merged) aggregateOutput.push({ ...slot });
    }
  }
  const hasOutput = aggregateOutput.length > 0;
  // Total parallel-slot capacity across all nearby stations of this kind
  // (1 per station for now; visible to the player as "Slots: N/M").
  const totalSlots = stationsOfKind.length;
  const usedSlots = jobsAtStation.length;
  // Progress-bar updates run inside CraftJobRow via rAF + direct DOM
  // mutation, so the modal itself never re-renders during job progress.
  // useMemo so the recipes array reference is stable while kind +
  // knownBlueprints are unchanged. Otherwise the effect below sees
  // a fresh reference every render and triggers spurious work that
  // — combined with the 250ms forceRender interval — has been known
  // to trip React update warnings.
  const recipes = useMemo(
    () =>
      listRecipes().filter(
        (r) =>
          r.workstation === kind &&
          (r.blueprintId === null || knownBlueprints.has(r.blueprintId))
      ),
    [kind, knownBlueprints]
  );
  const inRange = nearWorkstations.has(kind);
  const [selectedId, setSelectedId] = useState<string | null>(
    recipes[0]?.id ?? null
  );
  // Keep selection valid if recipes shift (rare — happens when a new
  // blueprint is unlocked while modal is open).
  useEffect(() => {
    if (selectedId && !recipes.find((r) => r.id === selectedId)) {
      setSelectedId(recipes[0]?.id ?? null);
    }
  }, [recipes, selectedId]);
  const selected = recipes.find((r) => r.id === selectedId) ?? null;

  return (
    <Modal onClose={onClose} width="min(720px, 94vw)">
      <div className="flex items-center justify-between px-5 py-4 border-b-2 border-[color:var(--accent)]/30 bg-[color:var(--bg)]/50">
        <h2 className="font-semibold flex items-center gap-2 text-base">
          <ItemIcon kind="placeable" subkind={kind} />
          <span>{STATION_LABEL[kind] ?? kind}</span>
        </h2>
        <button
          onClick={onClose}
          className="px-2 py-1 rounded text-xs border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)]"
        >
          Close
        </button>
      </div>
      {!inRange && (
        <div className="px-5 py-2 border-b border-[color:var(--panel-border)] text-amber-400/80 text-xs">
          Move closer to the {STATION_LABEL[kind] ?? kind} to craft.
        </div>
      )}

      {(jobsAtStation.length > 0 || hasOutput) && (
        <div className="px-5 py-3 border-b border-[color:var(--panel-border)] flex flex-col gap-3">
          {jobsAtStation.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                  In Progress
                </div>
                {totalSlots > 0 && (
                  <div className="text-[10px] text-zinc-500 tabular-nums">
                    Slots {usedSlots}/{totalSlots}
                  </div>
                )}
              </div>
              {jobsAtStation.map((job) => (
                <CraftJobRow key={job.id} job={job} />
              ))}
            </div>
          )}
          {hasOutput && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Output
                </div>
                <button
                  onClick={() => onPickup(kind)}
                  className="px-2 py-1 rounded text-[10px] border border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-950"
                >
                  Take All
                </button>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                {aggregateOutput.map((slot, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded bg-[color:var(--bg)] border border-[color:var(--panel-border)] text-zinc-200"
                  >
                    {outputSlotLabel(slot)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {recipes.length === 0 ? (
        <div className="px-5 py-8 text-zinc-500 text-sm text-center">
          No blueprints available for this station yet. <br />
          Buy more at the Artifact Uplink.
        </div>
      ) : (
        <div className="grid grid-cols-[200px_1fr] divide-x divide-[color:var(--panel-border)] min-h-[280px]">
          {/* Left column — recipe list */}
          <ul className="overflow-y-auto py-1 max-h-[60vh]">
            {recipes.map((r) => {
              const active = r.id === selectedId;
              return (
                <li key={r.id}>
                  <button
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full text-left px-3 py-2 text-sm border-l-2 ${
                      active
                        ? 'bg-[color:var(--bg)] border-[color:var(--accent)] text-zinc-100'
                        : 'border-transparent text-zinc-400 hover:bg-[color:var(--bg)]/60'
                    }`}
                  >
                    {r.name}
                  </button>
                </li>
              );
            })}
          </ul>
          {/* Right column — selection details */}
          <div className="p-5">
            {selected ? (
              <RecipeDetails
                recipe={selected}
                inventory={inventory}
                inRange={inRange}
                onCraft={onCraft}
              />
            ) : (
              <div className="text-zinc-500 text-sm">Select a blueprint.</div>
            )}
          </div>
        </div>
      )}

      {kind === 'weapon_bench' && (
        <WeaponBenchPanel
          inventory={inventory}
          inRange={inRange}
          onAttachWeaponAffix={onAttachWeaponAffix}
          onDetachWeaponAffix={onDetachWeaponAffix}
          onAttachWeaponMod={onAttachWeaponMod}
          onDetachWeaponMod={onDetachWeaponMod}
          onTierUpWeapon={onTierUpWeapon}
        />
      )}
    </Modal>
  );
}

// Suit-affix manager. Lives in the inventory panel under the equipment
// grid. Lists each equipped part and any crafted suit affixes attached
// to it; offers attach buttons for compatible affixes the player owns.
// Attach/detach is gated on being near an Electronics Bench since that's
// where the user 'engineers' the affix into the suit.
function SuitAffixPanel({
  equipment,
  inventory,
  nearElectronicsBench,
  onAttach,
  onDetach,
}: {
  equipment: Equipment;
  inventory: Inventory;
  nearElectronicsBench: boolean;
  onAttach: (suitSlot: SuitSlotKind, defId: string) => void;
  onDetach: (suitSlot: SuitSlotKind, idx: number) => void;
}) {
  // Each attachment instance counts as 1 of its class.
  const owned = new Map<string, number>();
  for (const s of inventory) {
    if (s.kind === 'attachment') {
      owned.set(s.instance.defId, (owned.get(s.instance.defId) ?? 0) + 1);
    }
  }
  const ownedForSlot = (slot: SuitSlotKind): string[] => {
    const out: string[] = [];
    for (const [id, count] of owned) {
      if (count <= 0) continue;
      const def = ATTACHMENT_DEFS[id];
      if (!def || def.kind !== 'suit_affix') continue;
      if (def.slotKind !== slot) continue;
      out.push(id);
    }
    return out;
  };

  // Don't render if nothing to manage AND not near a bench (avoids
  // clutter for new players who don't have suit affixes yet).
  let anyVisible = false;
  for (const slot of SUIT_SLOT_KINDS) {
    const part = equipment[slot];
    if (!part) continue;
    if ((part.appliedAttachments?.length ?? 0) > 0) anyVisible = true;
    if (ownedForSlot(slot).length > 0) anyVisible = true;
  }
  if (!anyVisible && !nearElectronicsBench) return null;

  return (
    <div className="flex flex-col gap-2 p-2 rounded border border-[color:var(--panel-border)] bg-[color:var(--bg)]/30">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        Suit Affixes
      </div>
      {!nearElectronicsBench && (
        <div className="text-[10px] text-amber-400/80">
          Visit an Electronics Bench to attach or remove.
        </div>
      )}
      {SUIT_SLOT_KINDS.map((slot) => {
        const part = equipment[slot];
        const candidates = ownedForSlot(slot);
        const applied = part?.appliedAttachments ?? [];
        if (!part) return null;
        if (applied.length === 0 && candidates.length === 0) return null;
        return (
          <div key={slot} className="flex flex-col gap-1 text-xs">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">
              {SLOT_LABELS[slot] ?? slot}
            </div>
            {applied.map((inst, i) => {
              return (
                <div
                  key={`${inst.id}-${i}`}
                  className="flex items-center justify-between px-2 py-1 rounded bg-[color:var(--bg)]/50 border border-[color:var(--panel-border)]"
                >
                  <span className="text-emerald-200">
                    {attachmentDisplayName(inst)}
                  </span>
                  <button
                    onClick={() => onDetach(slot, i)}
                    disabled={!nearElectronicsBench}
                    className="px-2 py-0.5 rounded text-[10px] border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)] disabled:opacity-40"
                  >
                    Detach
                  </button>
                </div>
              );
            })}
            {candidates.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {candidates.map((id) => {
                  const def = ATTACHMENT_DEFS[id];
                  return (
                    <button
                      key={id}
                      onClick={() => onAttach(slot, id)}
                      disabled={!nearElectronicsBench}
                      title={def?.description}
                      className="px-2 py-0.5 rounded text-[10px] border border-emerald-700 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-950 disabled:opacity-40"
                    >
                      + {attachmentDisplayName(id)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Inline manage-weapons panel that hangs off the bottom of the Weapon
// Bench's WorkstationModal. Surfaces tier-up + per-piece affix attach
// + mod attach without requiring a separate modal.
function WeaponBenchPanel({
  inventory,
  inRange,
  onAttachWeaponAffix,
  onDetachWeaponAffix,
  onAttachWeaponMod,
  onDetachWeaponMod,
  onTierUpWeapon,
}: {
  inventory: Inventory;
  inRange: boolean;
  onAttachWeaponAffix: (
    weaponIdx: number,
    pieceKind: WeaponPieceKind,
    defId: string
  ) => void;
  onDetachWeaponAffix: (
    weaponIdx: number,
    pieceKind: WeaponPieceKind
  ) => void;
  onAttachWeaponMod: (weaponIdx: number, defId: string) => void;
  onDetachWeaponMod: (weaponIdx: number, modIndex: number) => void;
  onTierUpWeapon: (weaponIdx: number) => void;
}) {
  // Pull every weapon currently in the player's inventory plus its slot
  // index — the server expects the index, not the weapon id, for
  // attach/detach.
  // useMemo so the array reference only changes when the inventory
  // actually changes — without it, every render creates a new array
  // and React's effect dependency check fires every tick.
  const weapons = useMemo(() => {
    const out: { idx: number; weapon: WeaponItem }[] = [];
    for (let i = 0; i < inventory.length; i++) {
      const s = inventory[i];
      if (s.kind === 'weapon' && s.weapon.weaponId !== 'knife') {
        out.push({ idx: i, weapon: s.weapon });
      }
    }
    return out;
  }, [inventory]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    weapons[0]?.idx ?? null
  );
  useEffect(() => {
    if (selectedIdx === null && weapons[0]) {
      setSelectedIdx(weapons[0].idx);
    } else if (
      selectedIdx !== null &&
      !weapons.find((w) => w.idx === selectedIdx)
    ) {
      setSelectedIdx(weapons[0]?.idx ?? null);
    }
  }, [weapons, selectedIdx]);

  if (weapons.length === 0) {
    return (
      <div className="px-5 py-4 border-t border-[color:var(--panel-border)] text-xs text-zinc-500">
        Craft a weapon at the Workbench first to manage it here.
      </div>
    );
  }
  const selected = weapons.find((w) => w.idx === selectedIdx) ?? null;
  return (
    <div className="px-5 py-4 border-t border-[color:var(--panel-border)] flex flex-col gap-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        Manage Weapons
      </div>
      {/* Weapon picker row */}
      <div className="flex flex-wrap gap-2">
        {weapons.map((w) => (
          <button
            key={w.idx}
            onClick={() => setSelectedIdx(w.idx)}
            className={
              'px-2 py-1 rounded text-[11px] border tabular-nums ' +
              (w.idx === selectedIdx
                ? 'border-[color:var(--accent)] text-zinc-100 bg-[color:var(--bg)]'
                : 'border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)]')
            }
          >
            {weaponDisplayName(w.weapon)}
          </button>
        ))}
      </div>
      {selected && (
        <WeaponEditor
          weapon={selected.weapon}
          weaponIdx={selected.idx}
          inventory={inventory}
          inRange={inRange}
          onAttachAffix={(piece, defId) =>
            onAttachWeaponAffix(selected.idx, piece, defId)
          }
          onDetachAffix={(piece) => onDetachWeaponAffix(selected.idx, piece)}
          onAttachMod={(defId) => onAttachWeaponMod(selected.idx, defId)}
          onDetachMod={(modIdx) => onDetachWeaponMod(selected.idx, modIdx)}
          onTierUp={() => onTierUpWeapon(selected.idx)}
        />
      )}
    </div>
  );
}

// Per-weapon editor: lists every piece slot at the current tier with its
// attached affix (if any), every mod slot, and a tier-up button.
function WeaponEditor({
  weapon,
  weaponIdx: _weaponIdx,
  inventory,
  inRange,
  onAttachAffix,
  onDetachAffix,
  onAttachMod,
  onDetachMod,
  onTierUp,
}: {
  weapon: WeaponItem;
  weaponIdx: number;
  inventory: Inventory;
  inRange: boolean;
  onAttachAffix: (pieceKind: WeaponPieceKind, defId: string) => void;
  onDetachAffix: (pieceKind: WeaponPieceKind) => void;
  onAttachMod: (defId: string) => void;
  onDetachMod: (modIdx: number) => void;
  onTierUp: () => void;
}) {
  const pieces = TIER_PIECE_SLOTS[weapon.tier];
  const modCap = TIER_MOD_SLOTS[weapon.tier];

  // Count attachments by class for the attach-buttons. Each
  // instance is unique post-Sprint C, so the modal still tracks
  // "how many do I have of this class" but attaches the first
  // matching instance server-side (consumeAttachment by defId).
  const ownedAttachments = new Map<string, number>();
  for (const s of inventory) {
    if (s.kind === 'attachment') {
      ownedAttachments.set(
        s.instance.defId,
        (ownedAttachments.get(s.instance.defId) ?? 0) + 1
      );
    }
  }
  const ownedAffixForPiece = (piece: WeaponPieceKind): string[] => {
    const out: string[] = [];
    for (const [id, count] of ownedAttachments) {
      if (count <= 0) continue;
      const def = ATTACHMENT_DEFS[id];
      if (!def || def.kind !== 'weapon_affix') continue;
      if (def.pieceKind !== piece) continue;
      out.push(id);
    }
    return out;
  };
  const ownedMods = (): string[] => {
    const out: string[] = [];
    for (const [id, count] of ownedAttachments) {
      if (count <= 0) continue;
      const def = ATTACHMENT_DEFS[id];
      if (!def || def.kind !== 'weapon_mod') continue;
      out.push(id);
    }
    return out;
  };

  // Live ghost-stats preview. When the player hovers a candidate
  // attach button, we synthesise a hypothetical WeaponItem with
  // that candidate slotted in and feed it through
  // effectiveWeaponStats. Renderer below diffs against the current
  // stats so the player sees +/- per stat before committing.
  const [hovered, setHovered] = useState<
    | { kind: 'piece'; piece: WeaponPieceKind; defId: string }
    | { kind: 'mod'; defId: string }
    | null
  >(null);

  const findFirstInstanceOfDef = (
    defId: string
  ): import('@dumrunner/shared').AttachmentInstance | null => {
    for (const s of inventory) {
      if (s.kind === 'attachment' && s.instance.defId === defId) {
        return s.instance;
      }
    }
    return null;
  };

  const previewWeapon = (() => {
    if (!hovered) return null;
    const inst = findFirstInstanceOfDef(hovered.defId);
    if (!inst) return null;
    const cloned: WeaponItem = {
      ...weapon,
      pieces: { ...weapon.pieces },
      mods: [...weapon.mods],
    };
    if (hovered.kind === 'piece') {
      cloned.pieces[hovered.piece] = inst;
    } else {
      // Mods cap at TIER_MOD_SLOTS — preview replaces the last slot
      // if at cap so the player sees what the swap looks like
      // without committing the detach yet.
      if (cloned.mods.length >= modCap) {
        cloned.mods = [...cloned.mods.slice(0, -1), inst];
      } else {
        cloned.mods.push(inst);
      }
    }
    return cloned;
  })();

  const currentStats = effectiveWeaponStats(weapon);
  const previewStats = previewWeapon
    ? effectiveWeaponStats(previewWeapon)
    : null;

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* Stats panel — live preview when hovering a candidate. */}
      {currentStats && (
        <WeaponStatsPanel
          current={currentStats}
          preview={previewStats}
        />
      )}

      {/* Pieces */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          Pieces
        </div>
        {pieces.map((piece) => {
          const attached = weapon.pieces[piece];
          const candidates = ownedAffixForPiece(piece);
          return (
            <div
              key={piece}
              className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-[color:var(--bg)]/50 border border-[color:var(--panel-border)]"
            >
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                  {piece}
                </span>
                <span className="text-zinc-200">
                  {attached ? attachmentDisplayName(attached) : '— empty —'}
                </span>
              </div>
              {attached ? (
                <button
                  onClick={() => onDetachAffix(piece)}
                  disabled={!inRange}
                  className="px-2 py-1 rounded text-[10px] border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)] disabled:opacity-40"
                >
                  Detach
                </button>
              ) : (
                <div className="flex flex-wrap gap-1 justify-end">
                  {candidates.length === 0 ? (
                    <span className="text-[10px] text-zinc-600">
                      no compatible affix
                    </span>
                  ) : (
                    candidates.map((id) => {
                      const cdef = ATTACHMENT_DEFS[id];
                      return (
                        <button
                          key={id}
                          onClick={() => onAttachAffix(piece, id)}
                          onMouseEnter={() =>
                            setHovered({ kind: 'piece', piece, defId: id })
                          }
                          onMouseLeave={() => setHovered(null)}
                          disabled={!inRange}
                          title={cdef?.description}
                          className="px-2 py-1 rounded text-[10px] border border-violet-700 bg-violet-950/30 text-violet-200 hover:bg-violet-950 disabled:opacity-40"
                        >
                          + {attachmentDisplayName(id)}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Mods */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">
            Mods
          </div>
          <div className="text-[10px] text-zinc-500 tabular-nums">
            {weapon.mods.length}/{modCap}
          </div>
        </div>
        {weapon.mods.length === 0 && modCap === 0 && (
          <div className="text-[10px] text-zinc-600 px-2">
            Tier up to unlock mod slots.
          </div>
        )}
        {weapon.mods.map((mod, i) => {
          return (
            <div
              key={i}
              className="flex items-center justify-between px-2 py-1.5 rounded bg-[color:var(--bg)]/50 border border-[color:var(--panel-border)]"
            >
              <span className="text-zinc-200">{attachmentDisplayName(mod)}</span>
              <button
                onClick={() => onDetachMod(i)}
                disabled={!inRange}
                className="px-2 py-1 rounded text-[10px] border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)] disabled:opacity-40"
              >
                Detach
              </button>
            </div>
          );
        })}
        {weapon.mods.length < modCap && (
          <div className="flex flex-wrap gap-1">
            {ownedMods().length === 0 ? (
              <span className="text-[10px] text-zinc-600 px-2">
                no mods in inventory
              </span>
            ) : (
              ownedMods().map((id) => {
                const def = ATTACHMENT_DEFS[id];
                return (
                  <button
                    key={id}
                    onClick={() => onAttachMod(id)}
                    onMouseEnter={() => setHovered({ kind: 'mod', defId: id })}
                    onMouseLeave={() => setHovered(null)}
                    disabled={!inRange}
                    title={def?.description}
                    className="px-2 py-1 rounded text-[10px] border border-blue-700 bg-blue-950/30 text-blue-200 hover:bg-blue-950 disabled:opacity-40"
                  >
                    + {attachmentDisplayName(id)}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Tier-up */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-[color:var(--panel-border)]">
        <span className="text-zinc-300">
          Current Tier{' '}
          <span className="text-zinc-100 font-semibold">
            {WEAPON_TIER_LABEL[weapon.tier] ?? `T${weapon.tier}`}
          </span>
        </span>
        <button
          onClick={onTierUp}
          disabled={!inRange || weapon.tier >= 4}
          className="px-3 py-1.5 rounded text-[11px] border border-amber-700 bg-amber-950/30 text-amber-200 hover:bg-amber-950 disabled:opacity-40"
        >
          {weapon.tier >= 4
            ? 'Max Tier'
            : `Tier Up → ${WEAPON_TIER_LABEL[(weapon.tier + 1) as 1 | 2 | 3 | 4] ?? `T${weapon.tier + 1}`}`}
        </button>
      </div>
    </div>
  );
}

// Live ghost-stats panel for the Weapon Bench assembly UI. Renders
// the weapon's current effective stats; if a `preview` is supplied
// (player is hovering a candidate attach button), draws a delta
// column showing what each stat would become. Green = improvement,
// red = regression. Decided per-stat: lower fireIntervalMs is
// better, higher damage is better, lower spreadRad is better, etc.
function WeaponStatsPanel({
  current,
  preview,
}: {
  current: import('@dumrunner/shared').EffectiveWeaponStats;
  preview: import('@dumrunner/shared').EffectiveWeaponStats | null;
}) {
  type StatRow = {
    label: string;
    cur: number;
    prv: number;
    fmt: (v: number) => string;
    // +1 → higher is better, -1 → lower is better
    direction: 1 | -1;
  };
  const rows: StatRow[] = [
    {
      label: 'Damage',
      cur: current.damage,
      prv: preview?.damage ?? current.damage,
      fmt: (v) => v.toFixed(1),
      direction: 1,
    },
    {
      label: 'Shots/sec',
      cur: current.shotsPerSecond,
      prv: preview?.shotsPerSecond ?? current.shotsPerSecond,
      fmt: (v) => v.toFixed(2),
      direction: 1,
    },
    {
      label: 'Spread',
      cur: current.spreadRad,
      prv: preview?.spreadRad ?? current.spreadRad,
      fmt: (v) => `${(v * (180 / Math.PI)).toFixed(1)}°`,
      direction: -1,
    },
    {
      label: 'Proj speed',
      cur: current.projectileSpeed,
      prv: preview?.projectileSpeed ?? current.projectileSpeed,
      fmt: (v) => Math.round(v).toString(),
      direction: 1,
    },
  ];

  return (
    <div className="flex flex-col gap-1 px-2 py-2 rounded bg-[color:var(--bg)]/60 border border-[color:var(--panel-border)]">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">
        {preview ? 'Preview ▸ change' : 'Current stats'}
      </div>
      {rows.map((r) => {
        const changed = preview && Math.abs(r.cur - r.prv) > 1e-3;
        const better = r.direction === 1 ? r.prv > r.cur : r.prv < r.cur;
        const colorCls = !changed
          ? 'text-zinc-300'
          : better
            ? 'text-emerald-300'
            : 'text-rose-300';
        return (
          <div
            key={r.label}
            className="flex items-baseline justify-between gap-2 tabular-nums"
          >
            <span className="text-zinc-500 text-[10px] uppercase tracking-wider">
              {r.label}
            </span>
            <span className="text-zinc-300">{r.fmt(r.cur)}</span>
            {changed && (
              <span className={colorCls}>→ {r.fmt(r.prv)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Two-click pause confirm. The native `confirm()` dialog is blocked
// inside Discord's Activity iframe, so we use a click → "Confirm?"
// → click flow instead.
function PauseServerControl({ onPause }: { onPause: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-amber-300">Pause? Kicks everyone.</span>
        <button
          type="button"
          onClick={() => {
            setArmed(false);
            onPause();
          }}
          className="px-3 py-1.5 rounded text-xs bg-amber-900 text-amber-100 hover:bg-amber-800"
        >
          Yes, pause
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="px-3 py-1.5 rounded text-xs border border-[color:var(--panel-border)] text-zinc-400 hover:bg-[color:var(--bg)]"
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      className="px-3 py-1.5 rounded text-xs border border-amber-900 text-amber-300 hover:bg-amber-900/20"
    >
      Pause Server
    </button>
  );
}

function StorageChestModal({
  inventory,
  chest,
  onClose,
  onMove,
}: {
  inventory: Inventory;
  chest: BuildingState;
  onClose: () => void;
  onMove: (
    fromKind: 'inventory' | 'chest',
    fromIdx: number,
    toKind: 'inventory' | 'chest',
    toIdx: number
  ) => void;
}) {
  const chestSlots = chest.output ?? [];

  // Find the best landing index on the destination side: first
  // stack-mergeable slot wins, else first empty slot, else -1.
  const findTarget = (
    src: InventorySlot,
    dst: InventorySlot[]
  ): number => {
    if (src.kind === 'empty') return -1;
    for (let i = 0; i < dst.length; i++) {
      const d = dst[i];
      if (
        (src.kind === 'material' &&
          d.kind === 'material' &&
          src.materialId === d.materialId) ||
        (src.kind === 'ammo' &&
          d.kind === 'ammo' &&
          src.ammoId === d.ammoId) ||
        (src.kind === 'placeable' &&
          d.kind === 'placeable' &&
          src.buildingKind === d.buildingKind) ||
        // Attachments are unique-instance — they never stack.
        (src.kind === 'consumable' &&
          d.kind === 'consumable' &&
          src.consumableId === d.consumableId)
      ) {
        return i;
      }
    }
    for (let i = 0; i < dst.length; i++) {
      if (dst[i].kind === 'empty') return i;
    }
    return -1;
  };

  const handleClick = (
    side: 'inventory' | 'chest',
    idx: number,
    slot: InventorySlot
  ) => {
    if (slot.kind === 'empty') return;
    const otherSide: 'inventory' | 'chest' =
      side === 'inventory' ? 'chest' : 'inventory';
    const target = findTarget(
      slot,
      otherSide === 'inventory' ? inventory : chestSlots
    );
    if (target === -1) return;
    onMove(side, idx, otherSide, target);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[720px] max-w-[95vw] bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg shadow-2xl">
        <header className="flex items-center justify-between px-5 py-3 border-b border-[color:var(--panel-border)]">
          <div>
            <h2 className="font-semibold text-zinc-100">Storage</h2>
            <p className="text-[11px] text-zinc-500">
              Click a slot to transfer to the other side.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-sm text-zinc-400 hover:text-zinc-200 px-2"
          >
            Close [Esc]
          </button>
        </header>
        <div className="grid grid-cols-2 gap-4 p-5">
          <ChestSlotGrid
            title="Your inventory"
            slots={inventory}
            onClick={(idx, slot) => handleClick('inventory', idx, slot)}
          />
          <ChestSlotGrid
            title="Chest"
            slots={chestSlots}
            onClick={(idx, slot) => handleClick('chest', idx, slot)}
          />
        </div>
      </div>
    </div>
  );
}

function ChestSlotGrid({
  title,
  slots,
  onClick,
}: {
  title: string;
  slots: InventorySlot[];
  onClick: (idx: number, slot: InventorySlot) => void;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
        {title}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {slots.map((slot, idx) => {
          const empty = slot.kind === 'empty';
          return (
            <button
              key={idx}
              type="button"
              disabled={empty}
              onClick={() => onClick(idx, slot)}
              className={
                'aspect-square rounded border text-[10px] leading-tight px-1 py-1 text-center break-words ' +
                (empty
                  ? 'bg-[color:var(--bg)] border-[color:var(--panel-border)] text-zinc-700 cursor-default'
                  : 'bg-[color:var(--bg)] border-[color:var(--panel-border)] text-zinc-200 hover:border-[color:var(--accent)]')
              }
              title={empty ? 'Empty' : outputSlotLabel(slot)}
            >
              {empty ? '' : outputSlotLabel(slot)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function outputSlotLabel(slot: InventorySlot): string {
  if (slot.kind === 'placeable') {
    const name = STATION_LABEL[slot.buildingKind] ?? slot.buildingKind;
    return `${slot.count}× ${name}`;
  }
  if (slot.kind === 'material') {
    return `${slot.count}× ${slot.materialId}`;
  }
  if (slot.kind === 'ammo') {
    return `${slot.count}× ${slot.ammoId.replace(/_/g, ' ')}`;
  }
  if (slot.kind === 'weapon') return weaponDisplayName(slot.weapon);
  if (slot.kind === 'attachment') {
    return attachmentDisplayName(slot.instance);
  }
  if (slot.kind === 'consumable') {
    const def = CONSUMABLES[slot.consumableId];
    return `${slot.count}× ${def?.name ?? slot.consumableId}`;
  }
  if (slot.kind === 'part') return partDisplayName(slot.part);
  return '?';
}

// One row in the "In Progress" queue. Progress bar + seconds counter
// update via rAF + direct DOM mutation — React never re-renders this
// row during job progress, and the parent modal stays still.
function CraftJobRow({ job }: { job: CraftJobState }) {
  const recipe = listRecipes().find((r) => r.id === job.recipeId);
  const fillRef = useRef<HTMLDivElement>(null);
  const secondsRef = useRef<HTMLSpanElement>(null);
  const isQueued = job.completesAt === 0;
  useEffect(() => {
    if (isQueued) return; // Static render for queued jobs.
    const total = job.completesAt - job.startedAt;
    let raf = 0;
    let lastSeconds = -1;
    const tick = () => {
      const remaining = Math.max(0, job.completesAt - Date.now());
      const t = total > 0 ? 1 - remaining / total : 1;
      if (fillRef.current) {
        fillRef.current.style.width = `${(t * 100).toFixed(2)}%`;
      }
      const s = Math.ceil(remaining / 1000);
      if (s !== lastSeconds && secondsRef.current) {
        secondsRef.current.textContent = `${s}s`;
        lastSeconds = s;
      }
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [job.startedAt, job.completesAt, isQueued]);

  if (isQueued) {
    return (
      <div className="flex items-center gap-3 text-xs opacity-60">
        <span className="w-32 text-zinc-300 truncate">
          {recipe?.name ?? job.recipeId}
        </span>
        <div className="flex-1 h-2 rounded bg-black/40 border border-dashed border-[color:var(--panel-border)]" />
        <span className="w-10 text-right text-zinc-500 italic">queued</span>
      </div>
    );
  }

  const initialSeconds = Math.ceil(
    Math.max(0, job.completesAt - Date.now()) / 1000
  );
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-32 text-zinc-200 truncate">
        {recipe?.name ?? job.recipeId}
      </span>
      <div className="flex-1 h-2 rounded bg-black/40 border border-[color:var(--panel-border)] overflow-hidden">
        <div ref={fillRef} className="h-full bg-cyan-400" style={{ width: '0%' }} />
      </div>
      <span
        ref={secondsRef}
        className="w-10 text-right text-zinc-500 tabular-nums"
      >
        {initialSeconds}s
      </span>
    </div>
  );
}

// Right-column recipe panel inside the workstation modal. Shows the
// recipe name, output, the full ingredient list with have/need per row,
// and a craft button that lights up only when everything is satisfied.
function RecipeDetails({
  recipe,
  inventory,
  inRange,
  onCraft,
}: {
  recipe: Recipe;
  inventory: Inventory;
  inRange: boolean;
  onCraft: (recipeId: string) => void;
}) {
  const inputRows = recipe.inputs.map((input) => {
    const id =
      input.kind === 'material'
        ? input.materialId
        : input.kind === 'ammo'
        ? input.ammoId
        : input.weaponId;
    const have =
      input.kind === 'material'
        ? countMaterial(inventory, input.materialId)
        : input.kind === 'ammo'
        ? countAmmo(inventory, input.ammoId)
        : countWeaponsInInventory(inventory, input.weaponId);
    return { id, have, need: input.count, satisfied: have >= input.count };
  });
  const allSatisfied = inputRows.every((r) => r.satisfied);
  const enabled = inRange && allSatisfied;

  const outLabel = formatRecipeOutput(recipe.output);

  return (
    <div className="flex flex-col h-full">
      <h3 className="text-base font-semibold text-zinc-100">{recipe.name}</h3>
      <div className="text-xs text-zinc-500 mt-1">→ {outLabel}</div>

      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mt-4 mb-1">
        Requirements
      </div>
      <ul className="space-y-1 text-xs">
        {inputRows.map((r) => (
          <li key={r.id} className="flex items-center justify-between">
            <span className="capitalize text-zinc-300">
              {r.id.replace(/_/g, ' ')}
            </span>
            <span
              className={
                r.satisfied
                  ? 'tabular-nums text-emerald-400'
                  : 'tabular-nums text-red-400/80'
              }
            >
              {r.have}
              <span className="text-zinc-600">/</span>
              {r.need}
            </span>
          </li>
        ))}
      </ul>

      <div className="grow" />
      <button
        onClick={() => onCraft(recipe.id)}
        disabled={!enabled}
        title={
          !inRange
            ? 'Move closer to the station'
            : !allSatisfied
              ? 'Insufficient materials'
              : ''
        }
        className="mt-4 px-3 py-2 rounded text-sm border border-[color:var(--panel-border)] text-zinc-100 hover:bg-[color:var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed self-start"
      >
        Craft
      </button>
    </div>
  );
}

// Inventory crafting section. Only lists "field" recipes — ones with no
// workstation requirement, plus a known blueprint (or no blueprint).
// Anything tied to a station opens that station's own modal instead.
function CraftPanel({
  inventory,
  knownBlueprints,
  onCraft,
}: {
  inventory: Inventory;
  knownBlueprints: Set<string>;
  onCraft: (recipeId: string) => void;
}) {
  const recipes = listRecipes().filter(
    (r) =>
      r.workstation === null &&
      (r.blueprintId === null || knownBlueprints.has(r.blueprintId))
  );
  if (recipes.length === 0) return null;
  return (
    <div className="pt-2 border-t border-[color:var(--panel-border)]">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
        Field Craft
      </div>
      <ul className="space-y-1">
        {recipes.map((r) => (
          <CraftRow
            key={r.id}
            recipe={r}
            inventory={inventory}
            // No station context — basic recipes never check it.
            nearWorkstations={EMPTY_STATION_SET}
            onCraft={onCraft}
          />
        ))}
      </ul>
    </div>
  );
}
const EMPTY_STATION_SET: Set<BuildingKind> = new Set();

function countWeaponsInInventory(inv: Inventory, weaponId: string): number {
  let n = 0;
  for (const s of inv) {
    if (s.kind === 'weapon' && s.weapon.weaponId === weaponId) n++;
  }
  return n;
}

function formatRecipeOutput(out: Recipe['output']): string {
  if (out.kind === 'placeable') {
    return `${out.count}× ${STATION_LABEL[out.buildingKind] ?? out.buildingKind}`;
  }
  if (out.kind === 'ammo') {
    return `${out.count}× ${out.ammoId.replace(/_/g, ' ')}`;
  }
  if (out.kind === 'attachment') {
    return `${out.count}× ${attachmentDisplayName(out.defId)}`;
  }
  if (out.kind === 'consumable') {
    const def = CONSUMABLES[out.consumableId];
    return `${out.count}× ${def?.name ?? out.consumableId}`;
  }
  return out.weaponId.replace(/_/g, ' ');
}

// STATION_LABEL is now derived from BUILDING_REGISTRY in shared so the
// server, client, and asset_gen prewarm all read identical labels.
const STATION_LABEL: Record<BuildingKind, string> = Object.fromEntries(
  Object.entries(BUILDING_REGISTRY).map(([k, v]) => [k, v.label])
) as Record<BuildingKind, string>;

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
  // Resolve every input into a {id, have, need, satisfied} row so the UI
  // can show "3/5 scrap" per ingredient instead of the old single
  // collapsed line.
  const inputRows = recipe.inputs.map((input) => {
    const id =
      input.kind === 'material'
        ? input.materialId
        : input.kind === 'ammo'
        ? input.ammoId
        : input.weaponId;
    const have =
      input.kind === 'material'
        ? countMaterial(inventory, input.materialId)
        : input.kind === 'ammo'
        ? countAmmo(inventory, input.ammoId)
        : countWeaponsInInventory(inventory, input.weaponId);
    return {
      id,
      have,
      need: input.count,
      satisfied: have >= input.count,
    };
  });
  const allInputsSatisfied = inputRows.every((r) => r.satisfied);

  const stationOk =
    recipe.workstation === null || nearWorkstations.has(recipe.workstation);

  const reasons: string[] = [];
  if (!stationOk && recipe.workstation) {
    reasons.push(`At ${STATION_LABEL[recipe.workstation]}`);
  }
  if (!allInputsSatisfied) reasons.push('Insufficient materials');
  const enabled = reasons.length === 0;

  const outLabel = formatRecipeOutput(recipe.output);

  return (
    <li className="flex items-start justify-between gap-3 text-xs py-1.5">
      <div className="flex flex-col min-w-0 gap-0.5">
        <span className="font-semibold text-zinc-200">{recipe.name}</span>
        <span className="text-[10px] text-zinc-500">→ {outLabel}</span>
        <div className="flex flex-wrap gap-x-3 gap-y-0 text-[10px] mt-0.5">
          {inputRows.map((r) => (
            <span
              key={r.id}
              className={
                r.satisfied
                  ? 'text-emerald-400'
                  : 'text-red-400/80'
              }
            >
              {r.have}
              <span className="text-zinc-600">/</span>
              {r.need}{' '}
              <span className="text-zinc-400 capitalize">{r.id.replace(/_/g, ' ')}</span>
            </span>
          ))}
        </div>
        {!stationOk && recipe.workstation && (
          <span className="text-[10px] text-amber-400/80">
            Needs {STATION_LABEL[recipe.workstation]}
          </span>
        )}
      </div>
      <button
        onClick={() => onCraft(recipe.id)}
        disabled={!enabled}
        title={enabled ? '' : reasons.join(' • ')}
        className="px-2 py-1 rounded text-[11px] border border-[color:var(--panel-border)] text-zinc-200 hover:bg-[color:var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
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
  stats,
  onEquip,
  onUnequip,
}: {
  equipment: Equipment;
  stats: {
    hp: number;
    maxHp: number;
    shield: number;
    maxShield: number;
    stamina: number;
    maxStamina: number;
  };
  onEquip: (fromInventoryIdx: number, suitSlot: SuitSlotKind) => void;
  onUnequip: (suitSlot: SuitSlotKind, toInventoryIdx?: number) => void;
}) {
  // Compute the suit's contribution from the equipment so we can render
  // each row as "current/max (+suit bonus)". The server has already
  // applied the bonuses to maxHp/etc. — we recompute here purely to
  // surface where the bonus came from.
  const suit = computeSuitStats(equipment);
  const baseRegen = PLAYER_BASE_STATS.staminaRegenPerSec;
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

      {/* Stats block — base + suit modifiers. Bonus is shown in green next
          to each total so the player can see where the upgrade came from. */}
      <div className="w-40 text-[10px] flex flex-col gap-0.5 pt-2 border-t border-[color:var(--panel-border)]">
        <StatLine
          label="HP"
          current={stats.hp}
          max={stats.maxHp}
          base={PLAYER_BASE_STATS.maxHp}
        />
        {stats.maxShield > 0 && (
          <StatLine
            label="Shield"
            current={stats.shield}
            max={stats.maxShield}
            base={PLAYER_BASE_STATS.maxShield}
          />
        )}
        <StatLine
          label="Stamina"
          current={stats.stamina}
          max={stats.maxStamina}
          base={PLAYER_BASE_STATS.maxStamina}
        />
        <StatRow
          label="Stamina regen"
          value={`${(baseRegen + suit.staminaRegenBonus).toFixed(1)}/s`}
          bonus={
            suit.staminaRegenBonus > 0
              ? `+${suit.staminaRegenBonus.toFixed(1)}`
              : null
          }
        />
        <StatRow
          label="Move speed"
          value={`${Math.round((1 + suit.moveSpeedMult) * 100)}%`}
          bonus={
            suit.moveSpeedMult > 0
              ? `+${Math.round(suit.moveSpeedMult * 100)}%`
              : null
          }
        />
      </div>

      {/* Suppress unused-var warning while SUIT_SLOT_KINDS is imported for
          potential future iteration helpers. */}
      <span className="hidden">{SUIT_SLOT_KINDS.join(',')}</span>
    </div>
  );
}

// Row for max-bounded stats (HP, Shield, Stamina). Renders current/max
// plus the suit-bonus delta over the base.
function StatLine({
  label,
  current,
  max,
  base,
}: {
  label: string;
  current: number;
  max: number;
  base: number;
}) {
  // Round everything for display. HP / Shield / Stamina maxes are
  // conceptually integers; affix sums are float and would otherwise
  // bleed 15 decimals.
  const rMax = Math.round(max);
  const rCurrent = Math.round(current);
  const bonus = rMax - Math.round(base);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-400">{label}</span>
      <span className="tabular-nums text-zinc-200">
        {rCurrent}/{rMax}
        {bonus > 0 && (
          <span className="text-emerald-400 ml-1">+{bonus}</span>
        )}
      </span>
    </div>
  );
}

function StatRow({
  label,
  value,
  bonus,
}: {
  label: string;
  value: string;
  bonus: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-400">{label}</span>
      <span className="tabular-nums text-zinc-200">
        {value}
        {bonus && <span className="text-emerald-400 ml-1">{bonus}</span>}
      </span>
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
// Native-title hover tooltip describing what's in the slot. Suit parts
// expand into the stat bonuses they'd grant if equipped, so the player
// can compare an Mk2 chassis on the ground vs. their Mk1 in the suit.
// Multi-line stat block for the equipped/inventory weapon. Mirrors
// what server combat actually does at fire time (effectiveWeaponStats
// applies mods + piece affixes), so the player sees real numbers — not
// the base-class baseline. Knife / melee returns a short label.
function weaponTooltip(weapon: WeaponItem): string {
  const fullName = weaponDisplayName(weapon);
  const stats = effectiveWeaponStats(weapon);
  if (!stats) return fullName;
  const lines: string[] = [fullName];
  const mag = weapon.magazineRemaining ?? stats.magazineSize;
  lines.push(`Damage:        ${stats.damage.toFixed(1)}`);
  if (stats.pelletCount > 1) {
    lines.push(
      `  ${stats.pelletCount} pellets · ${(stats.damage * stats.pelletCount).toFixed(0)} burst`
    );
  }
  lines.push(`Fire rate:     ${stats.shotsPerSecond.toFixed(2)}/s`);
  const inaccDeg = (stats.inaccuracyHalfRad * 180) / Math.PI;
  lines.push(
    `Accuracy:      ${(stats.accuracy * 100).toFixed(0)}%  (±${inaccDeg.toFixed(1)}°)`
  );
  lines.push(`Magazine:      ${mag} / ${stats.magazineSize}`);
  lines.push(`Reload:        ${(stats.reloadMs / 1000).toFixed(2)}s`);
  lines.push(`Ammo:          ${stats.ammoKind.replace(/_/g, ' ')}`);
  // Piece affixes + mods. Surface what's attached so the tooltip is
  // self-contained — no need to open the weapon bench to remember.
  const piecesAttached: string[] = [];
  for (const [piece, attachment] of Object.entries(weapon.pieces)) {
    if (!attachment) continue;
    piecesAttached.push(`${piece}: ${attachmentDisplayName(attachment)}`);
  }
  if (piecesAttached.length > 0) {
    lines.push('— Affixes —');
    for (const p of piecesAttached) lines.push(p);
  }
  if (weapon.mods.length > 0) {
    lines.push('— Mods —');
    for (const m of weapon.mods) lines.push(attachmentDisplayName(m));
  }
  return lines.join('\n');
}

// Format an attachment instance's rolled deltas as a short multi-
// line readout for tooltips. Skips zero-rolls so a freshly-migrated
// (legacy / no-rolls) instance reads as bare base stats.
function formatAttachmentRolls(
  inst: import('@dumrunner/shared').AttachmentInstance
): string {
  const lines: string[] = [];
  const r = inst.rolls as Record<string, number>;
  const fmtPct = (x: number) =>
    `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
  const fmtFlat = (x: number) =>
    `${x >= 0 ? '+' : ''}${Math.round(x)}`;
  if (r.damageMultBonus) lines.push(`damage ${fmtPct(r.damageMultBonus)}`);
  if (r.fireIntervalMultBonus)
    lines.push(`fire rate ${fmtPct(-r.fireIntervalMultBonus)}`);
  if (r.spreadMultBonus) lines.push(`spread ${fmtPct(r.spreadMultBonus)}`);
  if (r.projectileSpeedAddBonus)
    lines.push(`speed ${fmtFlat(r.projectileSpeedAddBonus)} px/s`);
  if (r.hpBonusAdd) lines.push(`max HP ${fmtFlat(r.hpBonusAdd)}`);
  if (r.shieldBonusAdd) lines.push(`max shield ${fmtFlat(r.shieldBonusAdd)}`);
  if (r.staminaMaxBonusAdd)
    lines.push(`max stamina ${fmtFlat(r.staminaMaxBonusAdd)}`);
  if (r.staminaRegenBonusAdd)
    lines.push(`stamina regen ${fmtFlat(r.staminaRegenBonusAdd)}/s`);
  if (r.moveSpeedMultBonus)
    lines.push(`move speed ${fmtPct(r.moveSpeedMultBonus)}`);
  return lines.length === 0 ? '' : `Roll: ${lines.join(', ')}`;
}

function slotTooltip(slot: InventorySlot): string | undefined {
  if (slot.kind === 'empty') return undefined;
  if (slot.kind === 'weapon') return weaponTooltip(slot.weapon);
  if (slot.kind === 'material') {
    const def = MATERIALS[slot.materialId];
    return `${def?.name ?? slot.materialId} ×${slot.count}`;
  }
  if (slot.kind === 'ammo') {
    return `${slot.ammoId.replace(/_/g, ' ')} ×${slot.count}`;
  }
  if (slot.kind === 'placeable') {
    return `${slot.buildingKind.replace(/_/g, ' ')} ×${slot.count}`;
  }
  if (slot.kind === 'consumable') {
    const def = CONSUMABLES[slot.consumableId];
    return `${def?.name ?? slot.consumableId} ×${slot.count}\n${
      def?.description ?? ''
    }`;
  }
  if (slot.kind === 'attachment') {
    const def = ATTACHMENT_DEFS[slot.instance.defId];
    const name = attachmentDisplayName(slot.instance);
    const rolls = formatAttachmentRolls(slot.instance);
    return `${name}\n${def?.description ?? ''}${rolls ? `\n${rolls}` : ''}`;
  }
  if (slot.kind === 'part') {
    const part = slot.part;
    const tag = `${partDisplayName(part)}  (${SLOT_LABELS[part.slot] ?? part.slot})`;
    const lines: string[] = [tag];
    // Primary stat — the part's slot contribution at its tier, no affixes.
    const primary = partPrimaryStat(part);
    if (primary.hpBonus) lines.push(`+${Math.round(primary.hpBonus)} max HP`);
    if (primary.shieldBonus)
      lines.push(`+${Math.round(primary.shieldBonus)} max shield`);
    if (primary.staminaMaxBonus)
      lines.push(`+${Math.round(primary.staminaMaxBonus)} max stamina`);
    if (primary.staminaRegenBonus)
      lines.push(`+${primary.staminaRegenBonus.toFixed(1)} stamina/s`);
    if (primary.moveSpeedMult)
      lines.push(`+${Math.round(primary.moveSpeedMult * 100)}% speed`);
    // Each rolled affix gets its own line: flavored name + technical label.
    if (part.affixes && part.affixes.length > 0) {
      lines.push('— Affixes —');
      for (const a of part.affixes) {
        const def = AFFIX_DEFS[a.id];
        if (def) lines.push(`${def.name}: ${def.label(a.value)}`);
      }
    }
    return lines.join('\n');
  }
  return undefined;
}

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
  const title = slotTooltip(slot);

  return (
    <div
      className={`relative rounded ${dim} ${border} bg-[color:var(--bg)] flex items-center justify-center text-center`}
      title={title}
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
  nearbyPlayers,
  nearWorkbench,
  onUse,
  onDropOne,
  onDropAll,
  onGiveOne,
  onGiveAll,
  onSalvage,
  onDiscardOne,
  onDiscardAll,
  onClose,
}: {
  slot: InventorySlot;
  x: number;
  y: number;
  nearbyPlayers: { characterId: string; displayName: string }[];
  nearWorkbench: boolean;
  onUse: () => void;
  onDropOne: () => void;
  onDropAll: () => void;
  onGiveOne: (targetCharacterId: string) => void;
  onGiveAll: (targetCharacterId: string) => void;
  onSalvage: () => void;
  onDiscardOne: () => void;
  onDiscardAll: () => void;
  onClose: () => void;
}) {
  const salvageable =
    slot.kind === 'attachment' ||
    slot.kind === 'weapon' ||
    slot.kind === 'placeable';
  const stackable =
    slot.kind === 'material' ||
    slot.kind === 'ammo' ||
    slot.kind === 'consumable' ||
    slot.kind === 'placeable';
  const count = stackable ? slot.count : 1;
  const isConsumable = slot.kind === 'consumable';
  const [giveOpen, setGiveOpen] = useState(false);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded shadow-lg text-xs min-w-[160px]"
        style={{ left: x, top: y }}
      >
        {isConsumable && (
          <button
            className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)] text-emerald-400"
            onClick={onUse}
          >
            Use
          </button>
        )}
        {stackable && count > 1 && (
          <button
            className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)]"
            onClick={onDropOne}
          >
            Drop 1
          </button>
        )}
        <button
          className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)] text-amber-300"
          onClick={onDropAll}
        >
          {stackable && count > 1 ? `Drop all (${count})` : 'Drop'}
        </button>
        {nearbyPlayers.length > 0 && (
          <button
            className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)]"
            onClick={() => setGiveOpen((v) => !v)}
          >
            Give to… {giveOpen ? '▾' : '▸'}
          </button>
        )}
        {giveOpen &&
          nearbyPlayers.map((p) => (
            <div key={p.characterId} className="border-t border-[color:var(--panel-border)]">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                {p.displayName}
              </div>
              {stackable && count > 1 && (
                <button
                  className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)]"
                  onClick={() => onGiveOne(p.characterId)}
                >
                  Give 1
                </button>
              )}
              <button
                className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)]"
                onClick={() => onGiveAll(p.characterId)}
              >
                {stackable && count > 1 ? `Give all (${count})` : 'Give'}
              </button>
            </div>
          ))}
        {salvageable && nearWorkbench && (
          <button
            className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)] text-cyan-300 border-t border-[color:var(--panel-border)]"
            onClick={onSalvage}
          >
            Salvage at workbench (~20%)
          </button>
        )}
        {stackable && count > 1 && (
          <button
            className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)] border-t border-[color:var(--panel-border)]"
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
    // Slot icon shows tier label + family ("Standard Shotgun"). The
    // adjective stack lives in the hover tooltip so we don't blow up
    // the icon width.
    const tierLabel =
      WEAPON_TIER_LABEL[slot.weapon.tier] ?? `T${slot.weapon.tier}`;
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="weapon" subkind={slot.weapon.weaponId} />
        <span className="text-zinc-300 text-[9px]">
          {tierLabel}{' '}
          <span className="capitalize">{slot.weapon.weaponId}</span>
        </span>
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
  if (slot.kind === 'attachment') {
    const def = ATTACHMENT_DEFS[slot.instance.defId];
    const tint =
      def?.kind === 'weapon_mod'
        ? 0x60a5fa
        : def?.kind === 'weapon_affix'
          ? 0xa78bfa
          : 0x34d399;
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <div
          className="w-6 h-6 rounded-sm border"
          style={{
            background: `#${tint.toString(16).padStart(6, '0')}33`,
            borderColor: `#${tint.toString(16).padStart(6, '0')}`,
          }}
        />
        <span className="text-zinc-300 text-[9px] truncate max-w-[60px]">
          {def?.displayName.split(' ')[0] ?? '?'}
        </span>
      </div>
    );
  }
  if (slot.kind === 'consumable') {
    const def = CONSUMABLES[slot.consumableId];
    const c = `#${(def?.color ?? 0xef4444).toString(16).padStart(6, '0')}`;
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <div
          className="w-6 h-6 rounded-sm border flex items-center justify-center font-bold text-[10px]"
          style={{ background: `${c}33`, borderColor: c, color: c }}
        >
          +
        </div>
        <span className="text-zinc-300 text-[9px]">×{slot.count}</span>
      </div>
    );
  }
  if (slot.kind === 'part') {
    // partDisplayName returns "{tier} {creative name}". Strip the tier
    // since we render it separately as a colour-coded badge above.
    const full = partDisplayName(slot.part);
    const compactName = full.replace(/^\S+\s+/, '');
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="part" tierColor={TIER_HEX[slot.part.tier]} />
        <span
          className="text-[9px] font-semibold"
          style={{ color: TIER_HEX[slot.part.tier] }}
        >
          {slot.part.tier}
        </span>
        <span className="text-zinc-400 text-[8px] text-center leading-[1.05] max-w-[68px] truncate">
          {compactName}
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
  if (kind === 'placeable' && subkind === 'power_link') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" fill="#0c1126" stroke="#000" strokeWidth={stroke} />
        <circle cx="12" cy="12" r="7" fill="#4338ca" />
        <circle cx="12" cy="12" r="4" fill="#06b6d4" />
        <circle cx="12" cy="12" r="2" fill="#e0f2fe" />
      </svg>
    );
  }
  if (kind === 'placeable' && subkind === 'artifact_uplink') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" fill="#1a1325" stroke="#09090b" strokeWidth={stroke} />
        <circle cx="12" cy="12" r="6" fill="#f472b6" stroke="#86195e" strokeWidth="1" />
        <circle cx="12" cy="12" r="3" fill="#fbcfe8" />
        <rect x="10" y="2" width="4" height="3" fill="#fbcfe8" />
        <rect x="10" y="19" width="4" height="3" fill="#fbcfe8" />
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
    if (subkind === 'key') {
      // Skeleton key — golden head with two prongs.
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <circle cx="7" cy="12" r="4" fill="#facc15" stroke="#0b0d10" strokeWidth={stroke} />
          <circle cx="7" cy="12" r="1.5" fill="#0b0d10" />
          <rect x="10" y="11" width="11" height="2" fill="#facc15" stroke="#0b0d10" strokeWidth={stroke} />
          <rect x="17" y="13" width="2" height="3" fill="#facc15" stroke="#0b0d10" strokeWidth={stroke} />
          <rect x="20" y="13" width="2" height="3" fill="#facc15" stroke="#0b0d10" strokeWidth={stroke} />
        </svg>
      );
    }
    if (subkind === 'artifact') {
      // Pink-magenta star — flagged as a "premium" find.
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <polygon
            points="12,2 14,9 21,10 16,15 17,22 12,18 7,22 8,15 3,10 10,9"
            fill="#f472b6"
            stroke="#0b0d10"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
          <circle cx="12" cy="13" r="2" fill="#fbcfe8" />
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
