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
  TIER_UP_COSTS,
  UPGRADES,
  type AttachmentInstance,
  type WeaponPieceKind,
  partPrimaryStat,
  PLAYER_BASE_STATS,
  PROTOCOL_VERSION,
  defaultSpecialtyForPartId,
  lifeSupportResists,
  biomeHazardFor,
  categoryAt,
  effectiveHazardDps,
  resistFor,
  setBiomePalettes,
  setEnemyVisuals,
  SUIT_ATTACHMENT_SLOTS,
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
import { runIsoGame } from '@/lib/game/iso';
import { paintMinimap } from '@/lib/game/minimap';
import { getOverride } from '@/lib/textureOverrides';

type RendererMode = 'topdown' | 'iso' | 'fps';

const RENDERER_CYCLE: RendererMode[] = ['topdown', 'iso', 'fps'];

function runnerFor(mode: RendererMode): typeof runGame {
  return mode === 'fps' ? runFpsGame : mode === 'iso' ? runIsoGame : runGame;
}
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
  // Current scene's SceneLayout; lets the HazardHUD compute the
  // player's room-zone category client-side using the same
  // categoryAt helper the server's hazard tick uses. null = no
  // layout (surface fallback).
  const [currentLayout, setCurrentLayout] =
    useState<import('@dumrunner/shared').SceneLayout | null>(null);
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
  // Highest weapon-bench tier the player is currently in range of.
  // 0 if no bench in range. Drives the assembly UI's tier-cap.
  // Mirrors what the server uses in nearestWeaponBenchTier so the
  // client UI agrees with the authoritative gate.
  const [weaponBenchTier, setWeaponBenchTier] = useState<number>(0);
  // All weapon benches in range, with their tiers. Used by the
  // upgrade-apply right-click flow to find a bench whose tier
  // matches the upgrade's targetTier - 1 (mk2 upgrade → Mk1 bench).
  const [weaponBenches, setWeaponBenches] = useState<
    { id: string; tier: number }[]
  >([]);
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
  // Drives the screen-space HudOverlay's "YOU ARE DOWN" banner.
  // Toggled from player_died / player_respawned messages — owned
  // here in React so every renderer sees the same overlay logic.
  const [selfAlive, setSelfAlive] = useState<boolean>(true);
  const selfIdRef = useRef<string | null>(null);
  // Audio-bookkeeping refs. Compare the previous frame's snapshot
  // against the next message's payload to fire pickup/damage SFX
  // exactly once per real change.
  const prevInventoryRef = useRef<Inventory | null>(null);
  const prevSelfHpRef = useRef<number>(100);
  // Shield is tracked alongside HP so player-hit fires for
  // shield-only absorptions (the player has plating equipped, the
  // shot lands on shield, HP doesn't drop). Shield only decreases
  // via damage absorption — regen only goes up — so a drop is an
  // unambiguous "took damage" cue.
  const prevSelfShieldRef = useRef<number>(0);
  const lastFootstepAtRef = useRef<number>(0);
  // Per-shooter SFX throttle. A 6-pellet shotgun blast spawns 6
  // projectile_spawned events back-to-back; without throttling the
  // client plays player-shoot 6 times in ~1ms and the result is a
  // brick-saw click. Cap to one play per ~60ms per ownerCharacterId.
  const lastShootSfxAtRef = useRef<Map<string, number>>(new Map());
  // Tracks which cycle we've already played the "extract now" alert
  // for. Reset on cycle bump (horde_ended) so the next perihelion
  // fires its alert again. -1 means we haven't alerted this run.
  const perihelionAlertCycleRef = useRef<number>(-1);
  // Renderer pick. Initialised from URL params `?fps=1` / `?iso=1` for
  // backwards-compat; the V hotkey cycles topdown → iso → fps at runtime.
  const [rendererMode, setRendererMode] = useState<RendererMode>(() => {
    if (typeof window === 'undefined') return 'topdown';
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('fps') === '1') return 'fps';
    if (sp.get('iso') === '1') return 'iso';
    return 'topdown';
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
      weaponBenchTier: number;
      weaponBenches: { id: string; tier: number }[];
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
        // Hydrate the runtime enemy-visual registry from the
        // server's JSON-backed templates. Renderers read
        // enemyVisualFor() against this map; without this call
        // every kind would resolve to the dummy_target fallback.
        setEnemyVisuals(msg.enemyVisuals);
        // Same shape for biomes — renderer resolves
        // layout.biome → palette via biomePaletteFor() at scene
        // change time. Newly authored biomes light up without a
        // code change.
        setBiomePalettes(msg.biomes);
        setInventory(msg.inventory);
        setEquipment(msg.equipment);
        setHotbarSelection(msg.hotbarSelection);
        setSceneId(msg.sceneId);
        setCurrentLayout(msg.layout);
        setKnownBlueprints(new Set(msg.knownBlueprints));
        setBuildings(new Map(msg.buildings.map((b) => [b.id, b])));
        selfIdRef.current = msg.self.characterId;
        prevSelfHpRef.current = msg.self.hp;
        prevSelfShieldRef.current = msg.self.shield;
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
            weaponBenchTier,
            weaponBenches,
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
            setWeaponBenchTier(weaponBenchTier);
            setWeaponBenches(weaponBenches);
          },
        };
        requestAnimationFrame(() => {
          if (session.cancelled) return;
          const host = canvasHostRef.current;
          if (!host || gameRef.current) return;
          const cb = rendererCallbacksRef.current!;
          const runner = runnerFor(rendererMode);
          gameRef.current = runner(host, {
            self: msg.self,
            others: msg.players.filter((p) => p.characterId !== msg.self.characterId),
            enemies: msg.enemies,
            projectiles: msg.projectiles,
            loot: msg.loot,
            corpses: msg.corpses,
            buildings: msg.buildings,
            props: msg.props,
            layout: msg.layout,
            getEnemyTexture: (kind) => getOverride('enemy', kind),
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
          // Real damage = hp OR shield dropped from the previous
          // frame. Catches shield-only absorptions where HP stays at
          // max (the playtest equipment auto-equips Mk2 plating, so
          // most early-game hits land on shield). Shield only ever
          // decreases via damage absorption (regen only goes up), so
          // a drop is unambiguously a hit.
          if (
            msg.hp < prevSelfHpRef.current ||
            msg.shield < prevSelfShieldRef.current
          ) {
            audio.playSfx('player-hit');
          }
          prevSelfHpRef.current = msg.hp;
          prevSelfShieldRef.current = msg.shield;
        }
        break;
      case 'player_stamina':
        setSelfStats((s) => ({
          ...s,
          stamina: msg.stamina,
          maxStamina: msg.maxStamina,
        }));
        break;
      case 'player_died':
        gameRef.current?.setPlayerDead(msg.characterId);
        if (msg.characterId === selfIdRef.current) {
          setSelfAlive(false);
          setSelfStats((s) => ({ ...s, hp: 0 }));
        }
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
          setSelfAlive(true);
          setSelfStats({
            hp: msg.hp,
            maxHp: msg.maxHp,
            shield: msg.shield,
            maxShield: msg.maxShield,
            stamina: msg.stamina,
            maxStamina: msg.maxStamina,
          });
          prevSelfHpRef.current = msg.hp;
          prevSelfShieldRef.current = msg.shield;
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
        setCurrentLayout(msg.layout);
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
          props: msg.props,
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
      case 'projectile_spawned': {
        // Self-fired projectiles play the pistol report. Turret-fired
        // projectiles are also ownerKind 'player' but their owner is a
        // building id, not the character — those are silent for now.
        // Multi-pellet weapons (shotgun, future spread mods) emit one
        // spawn per pellet; throttle by ownerCharacterId so the report
        // is one click, not six.
        const ownerId = msg.projectile.ownerCharacterId;
        const isSelfPlayer =
          msg.projectile.ownerKind === 'player' &&
          ownerId === selfIdRef.current;
        const isEnemy = msg.projectile.ownerKind === 'enemy';
        if (isSelfPlayer || isEnemy) {
          const now = performance.now();
          const last = lastShootSfxAtRef.current.get(ownerId) ?? 0;
          if (now - last >= 60) {
            lastShootSfxAtRef.current.set(ownerId, now);
            audio.playSfx(isSelfPlayer ? 'player-shoot' : 'enemy-shoot');
          }
        }
        gameRef.current?.spawnProjectile(msg.projectile);
        break;
      }
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
      case 'prop_spawned':
        gameRef.current?.spawnProp(msg.prop);
        break;
      case 'prop_damaged':
        gameRef.current?.setPropHp(msg.id, msg.hp, msg.maxHp);
        break;
      case 'prop_destroyed':
        gameRef.current?.removeProp(msg.id);
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

  // Perihelion-imminent alert. When the player is in a dungeon and
  // the countdown crosses the 30s threshold, fire a one-shot audio
  // cue to draw their attention to the warning banner. Per-cycle
  // gated so the alert only sounds once per perihelion (not every
  // tick under 30s). Resets after the horde ends so the next cycle
  // can alert again.
  useEffect(() => {
    if (!worldClock) return;
    if (worldClock.hordeActive) {
      perihelionAlertCycleRef.current = worldClock.cycle;
      return;
    }
    const inDungeon = sceneId.startsWith('dungeon:');
    if (!inDungeon) return;
    if (worldClock.secondsToPerihelion > 30) return;
    if (perihelionAlertCycleRef.current === worldClock.cycle) return;
    perihelionAlertCycleRef.current = worldClock.cycle;
    audio.playSfx('robot-detect');
  }, [worldClock, sceneId]);

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

  // Hot-swap renderers when `rendererMode` changes. Snapshot scene state
  // from the outgoing renderer, destroy it, then instantiate the new one
  // with that state. Skips the very first run because the welcome handler
  // is responsible for the initial mount.
  //
  // CRITICAL: depend ONLY on rendererMode. Adding inventory / hotbarSelection /
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
    const runner = runnerFor(rendererMode);
    gameRef.current = runner(host, {
      self: snapshot.self,
      others: snapshot.players,
      enemies: snapshot.enemies,
      projectiles: snapshot.projectiles,
      loot: snapshot.loot,
      corpses: snapshot.corpses,
      buildings: snapshot.buildings,
      props: snapshot.props,
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
  }, [rendererMode]);

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
        // modal" stack and matches Esc behaviour for the chest modal.
        if (chestModalIdRef.current !== null) {
          chestModalIdRef.current = null;
          setChestModalId(null);
          return;
        }
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
          nearestKind === 'weapon_bench' ||
          nearestKind === 'precision_mill' ||
          nearestKind === 'suit_bench'
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
      // V cycles renderers: top-down → iso → FPS → top-down. Swap is
      // hot — we snapshot scene state from the old renderer and seed
      // the new one.
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setRendererMode((m) => {
          const i = RENDERER_CYCLE.indexOf(m);
          return RENDERER_CYCLE[(i + 1) % RENDERER_CYCLE.length];
        });
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
        {worldClock && (
          <PerihelionWarning
            clock={worldClock}
            inDungeon={sceneId.startsWith('dungeon:')}
          />
        )}
        {sceneId.startsWith('dungeon:') && currentLayout && (
          <HazardHud
            layout={currentLayout}
            sceneId={sceneId}
            equipment={equipment}
            getSelfPosition={() =>
              gameRef.current?.getSelfPosition() ?? null
            }
          />
        )}
        <PowerHud state={powerState} />
        <ActiveEffectsHud effects={activeEffects} />
        {showMinimap && <Minimap gameRef={gameRef} />}
        <HudOverlay stats={selfStats} alive={selfAlive} />
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
            nearestStation === 'electronics_bench' ||
            nearestStation === 'weapon_bench' ||
            nearestStation === 'precision_mill' ||
            nearestStation === 'suit_bench') && (
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
        <ControlsHint mode={rendererMode} />
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

        {stationModalKind === 'precision_mill' && (
          <PrecisionMillModal
            inventory={inventory}
            inRange={nearWorkstations.has('precision_mill')}
            onClose={() => setStationModalKind(null)}
            onTierUpWeapon={(idx) =>
              sendOnLiveWs({ type: 'tier_up_weapon', weaponInventoryIdx: idx })
            }
          />
        )}

        {stationModalKind === 'suit_bench' && (
          <SuitAssemblyModal
            inventory={inventory}
            equipment={equipment}
            inRange={nearWorkstations.has('suit_bench')}
            onClose={() => setStationModalKind(null)}
            onAssemble={(suitSlot, attachments) =>
              sendOnLiveWs({
                type: 'assemble_suit_part',
                suitSlot,
                attachments,
              })
            }
          />
        )}

        {stationModalKind &&
          stationModalKind !== 'precision_mill' &&
          stationModalKind !== 'suit_bench' && (
          <WorkstationModal
            kind={stationModalKind}
            inventory={inventory}
            knownBlueprints={knownBlueprints}
            nearWorkstations={nearWorkstations}
            weaponBenchTier={weaponBenchTier}
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
            onAssembleWeapon={(idx, pieces, mods) =>
              sendOnLiveWs({
                type: 'assemble_weapon',
                weaponInventoryIdx: idx,
                pieces,
                mods,
              })
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

        {slotMenu && (() => {
          const slot = inventory[slotMenu.slot];
          // Resolve the bench id to apply this upgrade to (if it's
          // an upgrade item). The matching bench is the in-range
          // weapon_bench whose current tier is targetTier - 1.
          // If no matching bench is in range, the menu hides the
          // Apply action.
          let onApplyUpgrade: (() => void) | undefined;
          if (slot && slot.kind === 'upgrade') {
            const def = UPGRADES[slot.upgradeId];
            if (def) {
              const targetTier = def.targetTier;
              const eligible = weaponBenches.find(
                (b) => b.tier === targetTier - 1
              );
              if (eligible) {
                onApplyUpgrade = () => {
                  sendOnLiveWs({
                    type: 'upgrade_workstation',
                    buildingId: eligible.id,
                    upgradeId: slot.upgradeId,
                  });
                  setSlotMenu(null);
                };
              }
            }
          }
          return (
          <SlotContextMenu
            slot={inventory[slotMenu.slot]}
            x={slotMenu.x}
            y={slotMenu.y}
            nearbyPlayers={gameRef.current?.nearbyPlayers(96) ?? []}
            nearWorkbench={nearWorkstations.has('workbench')}
            onApplyUpgrade={onApplyUpgrade}
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
          );
        })()}

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

function ControlsHint({ mode }: { mode: RendererMode }) {
  // Show what V will switch to next so the player knows what's coming.
  const nextMode =
    RENDERER_CYCLE[(RENDERER_CYCLE.indexOf(mode) + 1) % RENDERER_CYCLE.length];
  const nextLabel =
    nextMode === 'fps'
      ? 'first-person'
      : nextMode === 'iso'
        ? 'isometric'
        : 'top-down';
  return (
    <div className="absolute bottom-3 right-3 text-xs text-zinc-500 select-none pointer-events-none flex flex-col items-end gap-1">
      <div>
        <Kbd>V</Kbd>
        <span className="ml-2">{nextLabel}</span>
      </div>
      <div>
        <Kbd>Tab</Kbd>
        <span className="ml-2">inventory</span>
      </div>
      <div>
        <Kbd>E</Kbd>
        <span className="ml-2">interact</span>
      </div>
      {mode === 'fps' ? (
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
// Bottom-left HP / Shield / Stamina bars + centered "YOU ARE
// DOWN" overlay. Renderer-agnostic — driven by selfStats /
// selfAlive React state, which Game.tsx maintains from
// player_damaged / player_stamina / player_died /
// player_respawned messages. Each renderer (top-down, iso, fps)
// gets the same HUD without duplicating Pixi-side bar code.
function HudOverlay({
  stats,
  alive,
}: {
  stats: {
    hp: number;
    maxHp: number;
    shield: number;
    maxShield: number;
    stamina: number;
    maxStamina: number;
  };
  alive: boolean;
}) {
  const hpRatio = stats.maxHp > 0 ? Math.max(0, Math.min(1, stats.hp / stats.maxHp)) : 0;
  const stamRatio =
    stats.maxStamina > 0
      ? Math.max(0, Math.min(1, stats.stamina / stats.maxStamina))
      : 0;
  const showShield = stats.maxShield > 0;
  const shieldRatio = showShield
    ? Math.max(0, Math.min(1, stats.shield / stats.maxShield))
    : 0;
  // Match the pixi colors:
  //   HP fill: green > 40%, yellow 20–40%, red below
  //   Stamina: amber-100 (#fde68a)
  //   Shield: cyan-400 (#22d3ee)
  const hpColor =
    hpRatio > 0.4 ? '#22c55e' : hpRatio > 0.2 ? '#eab308' : '#ef4444';
  return (
    <>
      <div
        className="absolute bottom-4 left-4 pointer-events-none select-none z-40"
        style={{ width: 220 }}
      >
        {showShield && (
          <div className="relative mb-1">
            <div
              style={{
                height: 8,
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${shieldRatio * 100}%`,
                  background: '#22d3ee',
                }}
              />
            </div>
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#cffafe',
                textShadow: '0 0 2px #000, 0 0 2px #000',
              }}
            >
              {Math.round(stats.shield)} / {Math.round(stats.maxShield)}
            </div>
          </div>
        )}
        <div className="relative">
          <div
            style={{
              height: 16,
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${hpRatio * 100}%`,
                background: hpColor,
              }}
            />
          </div>
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#ffffff',
              textShadow: '0 0 2px #000, 0 0 2px #000',
            }}
          >
            {Math.round(stats.hp)} / {Math.round(stats.maxHp)}
          </div>
        </div>
        <div className="relative mt-1">
          <div
            style={{
              height: 8,
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${stamRatio * 100}%`,
                background: '#fde68a',
              }}
            />
          </div>
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: '#fef3c7',
              textShadow: '0 0 2px #000, 0 0 2px #000',
            }}
          >
            {Math.round(stats.stamina)} / {Math.round(stats.maxStamina)}
          </div>
        </div>
      </div>
      {!alive && (
        <div className="absolute inset-0 pointer-events-none select-none z-40 flex items-center justify-center">
          <div
            style={{
              fontSize: 28,
              fontFamily: 'system-ui, sans-serif',
              fontWeight: 700,
              color: '#ef4444',
            }}
          >
            YOU ARE DOWN — respawning…
          </div>
        </div>
      )}
    </>
  );
}

// Corner minimap. Renderer-agnostic: pulls a snapshot via
// GameHandle.getMinimapSnapshot and paints with the shared
// minimap painter (lib/game/minimap.ts). Repainted at 10 Hz.
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
      paintMinimap(c, 384, g.getMinimapSnapshot());
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

// Per-room hazard indicator. Reads the player's current room
// category by polling getSelfPosition() at 2 Hz (cheap; rooms are
// big and you don't cross them every frame). Resists come from
// the equipped life-support, so the displayed netDPS matches
// what the server tick actually deals (modulo timing jitter).
function HazardHud({
  layout,
  sceneId,
  equipment,
  getSelfPosition,
}: {
  layout: import('@dumrunner/shared').SceneLayout;
  sceneId: string;
  equipment: Equipment;
  getSelfPosition: () => { x: number; y: number } | null;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      setPos(getSelfPosition());
    }, 500);
    return () => window.clearInterval(id);
  }, [getSelfPosition]);

  const biome = useMemo(() => biomeHazardFor(layout.biome), [layout.biome]);
  if (!biome || biome.dominantHazard === 'none') return null;

  const floorIndex = sceneId.startsWith('dungeon:')
    ? Number(sceneId.slice('dungeon:'.length)) || 0
    : 0;
  if (floorIndex <= 0) return null;

  const category = pos
    ? categoryAt(layout, pos.x, pos.y)
    : 'hazard';
  const { kind, dps } = effectiveHazardDps(biome, floorIndex, category);
  if (kind === 'none' || dps <= 0) return null;

  const suit = computeSuitStats(equipment);
  const resist = resistFor(suit, kind);
  const netDps = dps * (1 - resist);

  // Color scaling on net DPS — yellow trickle, orange noticeable,
  // red dangerous, dark-red death-clock-fast.
  const tier =
    netDps < 1
      ? { bg: 'bg-yellow-950/80', border: 'border-yellow-700', text: 'text-yellow-100' }
      : netDps < 3
        ? { bg: 'bg-orange-950/85', border: 'border-orange-600', text: 'text-orange-100' }
        : netDps < 6
          ? { bg: 'bg-red-950/85', border: 'border-red-600', text: 'text-red-100' }
          : { bg: 'bg-red-950/95 animate-pulse', border: 'border-red-400', text: 'text-red-50' };

  const HAZARD_LABEL: Record<string, string> = {
    heat: 'Heat',
    cold: 'Cold',
    radiation: 'Radiation',
    toxic: 'Toxic',
  };
  const ZONE_LABEL: Record<string, string> = {
    safe: 'Safe',
    corridor: 'Corridor',
    hazard: 'Hazard',
    extreme: 'Extreme',
  };

  return (
    <div className="absolute top-12 left-1/2 -translate-x-1/2 pointer-events-none select-none">
      <div
        className={`px-3 py-1.5 rounded-full border text-xs flex items-center gap-3 ${tier.bg} ${tier.border} ${tier.text}`}
      >
        <span className="font-semibold">{HAZARD_LABEL[kind]}</span>
        <span className="opacity-60">•</span>
        <span>{ZONE_LABEL[category]}</span>
        <span className="opacity-60">•</span>
        <span>−{netDps.toFixed(1)} hp/s</span>
      </div>
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

// Perihelion countdown warning shown only to players currently in
// a dungeon scene during the lead-up to the next horde. Two tiers
// scaled by remaining seconds:
//   60s → 31s : yellow "approaching" — soft visual nudge.
//   30s →  0s : red, pulsing "EXTRACT NOW" — last-chance alarm.
// Hides while the horde is active because the existing
// LINK SEVERED full-screen overlay takes over at that point.
// Surface players don't need this — they fight, they don't extract.
function PerihelionWarning({
  clock,
  inDungeon,
}: {
  clock: { cycle: number; secondsToPerihelion: number; hordeActive: boolean };
  inDungeon: boolean;
}) {
  if (!inDungeon || clock.hordeActive) return null;
  if (clock.secondsToPerihelion > 60) return null;
  const m = Math.floor(clock.secondsToPerihelion / 60);
  const s = clock.secondsToPerihelion % 60;
  const time = `${m}:${s.toString().padStart(2, '0')}`;
  const urgent = clock.secondsToPerihelion <= 30;
  const wrap = urgent
    ? 'bg-red-950/90 border-red-500 text-red-100 animate-pulse shadow-[0_0_24px_rgba(239,68,68,0.6)]'
    : 'bg-amber-950/85 border-amber-500/70 text-amber-100';
  return (
    <div className="absolute top-14 left-1/2 -translate-x-1/2 pointer-events-none select-none">
      <div
        className={`px-4 py-2 rounded-md border-2 text-sm font-semibold flex flex-col items-center gap-0.5 ${wrap}`}
      >
        {urgent ? (
          <>
            <span className="text-base">⚠ EXTRACT NOW</span>
            <span className="text-xs opacity-90">link severs in {time}</span>
          </>
        ) : (
          <>
            <span>PERIHELION APPROACHING</span>
            <span className="text-xs opacity-90">return to surface — {time}</span>
          </>
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
  onCraft: (recipeId: string) => void;
}) {
  const hotbar = inventory.slice(0, HOTBAR_SIZE);
  const bag = inventory.slice(HOTBAR_SIZE);
  // Click-to-inspect target. null = no inspector visible (default
  // grid view). Cleared automatically when the targeted slot becomes
  // empty (e.g. after a craft/swap shuffles the bag), so the panel
  // doesn't render stale stats.
  const [inspectedIdx, setInspectedIdx] = useState<number | null>(null);
  useEffect(() => {
    if (inspectedIdx === null) return;
    if (inspectedIdx >= inventory.length) {
      setInspectedIdx(null);
      return;
    }
    if (inventory[inspectedIdx]?.kind === 'empty') {
      setInspectedIdx(null);
    }
  }, [inventory, inspectedIdx]);
  const inspectedSlot =
    inspectedIdx !== null ? inventory[inspectedIdx] : null;

  return (
    <Modal onClose={onClose} width="min(960px, 96vw)">
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
      <div className="p-3 flex flex-col md:flex-row gap-4 max-h-[calc(100vh-120px)] overflow-y-auto">
        <div className="flex flex-col gap-3">
          <CharacterPanel
            equipment={equipment}
            stats={stats}
            onEquip={onEquip}
            onUnequip={onUnequip}
          />
        </div>
        <div className="space-y-3 flex-1 min-w-0">
          <div>
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
              Bag
            </div>
            <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-9 gap-1">
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
                    onInspect={setInspectedIdx}
                    inspecting={idx === inspectedIdx}
                  />
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
              Hotbar
            </div>
            <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-9 gap-1">
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
                  onInspect={setInspectedIdx}
                  inspecting={i === inspectedIdx}
                />
              ))}
            </div>
          </div>
          <div className="text-[10px] text-zinc-500 leading-snug">
            Drag to move • Click to inspect • Right-click to discard
          </div>
          {inspectedSlot && inspectedSlot.kind !== 'empty' && (
            <InspectPanel
              slot={inspectedSlot}
              onClose={() => setInspectedIdx(null)}
            />
          )}
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

// Click-to-inspect details panel. Shows the same content the
// native title= tooltip would, but rendered as JSX so it appears
// instantly (the OS tooltip's ~1s hover delay is the slow path
// the user is escaping). Lives inside InventoryPanel just below
// the bag/hotbar grids so the player can click another slot
// without first dismissing the inspector.
function InspectPanel({
  slot,
  onClose,
}: {
  slot: InventorySlot;
  onClose: () => void;
}) {
  const header = (title: string, color?: string) => (
    <div className="flex items-center justify-between mb-1.5">
      <div className="font-semibold text-sm" style={color ? { color } : undefined}>
        {title}
      </div>
      <button
        onClick={onClose}
        className="text-[11px] text-zinc-500 hover:text-zinc-200"
        aria-label="Close inspector"
      >
        ✕
      </button>
    </div>
  );
  return (
    <div className="rounded border border-amber-500/30 bg-[color:var(--bg)]/50 p-2 text-[11px] leading-snug">
      {renderInspectBody(slot, header)}
    </div>
  );
}

function renderInspectBody(
  slot: InventorySlot,
  header: (title: string, color?: string) => React.ReactNode,
): React.ReactNode {
  if (slot.kind === 'weapon') {
    const weapon = slot.weapon;
    const stats = effectiveWeaponStats(weapon);
    const fullName = weaponDisplayName(weapon);
    const tierColor = TIER_HEX[`Mk${weapon.tier}` as keyof typeof TIER_HEX];
    const piecesAttached: string[] = [];
    for (const [piece, attachment] of Object.entries(weapon.pieces)) {
      if (!attachment) continue;
      piecesAttached.push(`${piece}: ${attachmentDisplayName(attachment)}`);
    }
    if (!stats) {
      // Melee — no ranged stat sheet; render the bare name.
      return (
        <div>
          {header(fullName, tierColor)}
          <div className="text-zinc-400">Melee weapon. Click to swing.</div>
        </div>
      );
    }
    const inaccDeg = (stats.inaccuracyHalfRad * 180) / Math.PI;
    const mag = weapon.magazineRemaining ?? stats.magazineSize;
    return (
      <div>
        {header(fullName, tierColor)}
        <StatRow label="Damage" value={stats.damage.toFixed(1)} bonus={null} />
        {stats.pelletCount > 1 && (
          <StatRow
            label="Burst"
            value={`${stats.pelletCount} pellets · ${(
              stats.damage * stats.pelletCount
            ).toFixed(0)}`}
          />
        )}
        <StatRow label="Fire rate" value={`${stats.shotsPerSecond.toFixed(2)}/s`} />
        <StatRow
          label="Accuracy"
          value={`${(stats.accuracy * 100).toFixed(0)}% (±${inaccDeg.toFixed(1)}°)`}
        />
        <StatRow label="Magazine" value={`${mag} / ${stats.magazineSize}`} />
        <StatRow label="Reload" value={`${(stats.reloadMs / 1000).toFixed(2)}s`} />
        <StatRow label="Ammo" value={stats.ammoKind.replace(/_/g, ' ')} bonus={null} />
        {piecesAttached.length > 0 && (
          <div className="mt-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">
              Affixes
            </div>
            {piecesAttached.map((p, i) => (
              <div key={i} className="text-emerald-300/90">{p}</div>
            ))}
          </div>
        )}
        {weapon.mods.length > 0 && (
          <div className="mt-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">
              Mods
            </div>
            {weapon.mods.map((m, i) => (
              <div key={i} className="text-sky-300/90">
                {attachmentDisplayName(m)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (slot.kind === 'part') {
    const part = slot.part;
    const tierColor = TIER_HEX[part.tier];
    const primary = partPrimaryStat(part);
    return (
      <div>
        {header(
          `${partDisplayName(part)}  (${SLOT_LABELS[part.slot] ?? part.slot})`,
          tierColor,
        )}
        {primary.hpBonus ? (
          <StatRow label="Max HP" value={`+${Math.round(primary.hpBonus)}`} />
        ) : null}
        {primary.shieldBonus ? (
          <StatRow
            label="Max shield"
            value={`+${Math.round(primary.shieldBonus)}`}
          />
        ) : null}
        {primary.staminaMaxBonus ? (
          <StatRow
            label="Max stamina"
            value={`+${Math.round(primary.staminaMaxBonus)}`}
          />
        ) : null}
        {primary.staminaRegenBonus ? (
          <StatRow
            label="Stamina regen"
            value={`+${primary.staminaRegenBonus.toFixed(1)}/s`}
          />
        ) : null}
        {primary.moveSpeedMult ? (
          <StatRow
            label="Move speed"
            value={`+${Math.round(primary.moveSpeedMult * 100)}%`}
          />
        ) : null}
        {part.slot === 'life_support' && (() => {
          const specialty =
            part.specialtyHazard ?? defaultSpecialtyForPartId(part.id);
          const r = lifeSupportResists(part.tier, specialty);
          const row = (
            label: string,
            value: number,
            kind: typeof specialty,
          ) => (
            <StatRow
              key={kind}
              label={specialty === kind ? `${label} (specialty)` : label}
              value={`${Math.round(value * 100)}%`}
            />
          );
          return (
            <div className="mt-1.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                Resists
              </div>
              {row('Heat', r.heatResist, 'heat')}
              {row('Cold', r.coldResist, 'cold')}
              {row('Radiation', r.radiationResist, 'radiation')}
              {row('Toxic', r.toxicResist, 'toxic')}
            </div>
          );
        })()}
        {part.affixes && part.affixes.length > 0 && (
          <div className="mt-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">
              Affixes
            </div>
            {part.affixes.map((a, i) => {
              const def = AFFIX_DEFS[a.id];
              if (!def) return null;
              return (
                <div key={i} className="text-emerald-300/90">
                  <span className="text-emerald-200">{def.name}</span>
                  <span className="text-zinc-400"> — {def.label(a.value)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
  if (slot.kind === 'attachment') {
    const def = ATTACHMENT_DEFS[slot.instance.defId];
    const name = attachmentDisplayName(slot.instance);
    const rolls = formatAttachmentRolls(slot.instance);
    return (
      <div>
        {header(name)}
        {def?.description && (
          <div className="text-zinc-400 mb-1">{def.description}</div>
        )}
        {rolls && <div className="text-emerald-300/90">{rolls}</div>}
      </div>
    );
  }
  if (slot.kind === 'consumable') {
    const def = CONSUMABLES[slot.consumableId];
    return (
      <div>
        {header(`${def?.name ?? slot.consumableId} ×${slot.count}`)}
        {def?.description && (
          <div className="text-zinc-400">{def.description}</div>
        )}
      </div>
    );
  }
  if (slot.kind === 'upgrade') {
    const def = UPGRADES[slot.upgradeId];
    return (
      <div>
        {header(`${def?.name ?? slot.upgradeId} ×${slot.count}`)}
        {def?.description && (
          <div className="text-zinc-400">{def.description}</div>
        )}
      </div>
    );
  }
  if (slot.kind === 'placeable') {
    const label =
      BUILDING_REGISTRY[slot.buildingKind]?.label ?? slot.buildingKind;
    return (
      <div>
        {header(`${label} ×${slot.count}`)}
        <div className="text-zinc-400">
          Placeable structure. Equip and click on the surface to place.
        </div>
      </div>
    );
  }
  if (slot.kind === 'material') {
    const def = MATERIALS[slot.materialId];
    return (
      <div>
        {header(`${def?.name ?? slot.materialId} ×${slot.count}`)}
        <div className="text-zinc-400">Crafting component.</div>
      </div>
    );
  }
  if (slot.kind === 'ammo') {
    return (
      <div>
        {header(`${slot.ammoId.replace(/_/g, ' ')} ×${slot.count}`)}
        <div className="text-zinc-400">Reserve ammo. Reload draws from this stack.</div>
      </div>
    );
  }
  return null;
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
      <div className="flex flex-wrap items-center justify-between px-5 py-4 border-b-2 border-[color:var(--accent)]/30 bg-[color:var(--bg)]/50 gap-2">
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
  weaponBenchTier,
  craftJobs,
  buildings,
  onClose,
  onCraft,
  onPickup,
  onAssembleWeapon,
}: {
  kind: BuildingKind;
  inventory: Inventory;
  knownBlueprints: Set<string>;
  nearWorkstations: Set<BuildingKind>;
  // Highest weapon-bench tier in range. 0 if no bench in range.
  // Drives the assembly UI's tier-cap; mirrors the server gate.
  weaponBenchTier: number;
  craftJobs: CraftJobState[];
  buildings: Map<string, BuildingState>;
  onClose: () => void;
  onCraft: (recipeId: string) => void;
  onPickup: (kind: BuildingKind) => void;
  // Atomic assembly commit. Pieces is keyed by piece kind; null = leave
  // empty after assembly; undefined = leave the slot's existing
  // attachment alone. Mods is the desired full mod array (instance ids).
  onAssembleWeapon: (
    weaponIdx: number,
    pieces: Partial<Record<WeaponPieceKind, string | null>>,
    mods: string[]
  ) => void;
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

  // Weapon Bench gets a Craft / Assemble tab split — the assembly
  // panel was previously stacked beneath the recipe list and
  // scrolled offscreen with a long catalog. Tabs make both surfaces
  // first-class. Default to Assemble if the player has any non-
  // melee weapons, else Craft (so the player has something to do
  // on first visit before they've crafted a weapon).
  const isWeaponBench = kind === 'weapon_bench';
  const hasNonMeleeWeapons = useMemo(() => {
    if (!isWeaponBench) return false;
    for (const s of inventory) {
      if (s.kind === 'weapon' && WEAPON_FAMILY[s.weapon.weaponId] !== 'melee') {
        return true;
      }
    }
    return false;
  }, [inventory, isWeaponBench]);
  const [tab, setTab] = useState<'craft' | 'assemble'>(
    hasNonMeleeWeapons ? 'assemble' : 'craft'
  );

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

      {isWeaponBench && (
        <div className="flex border-b border-[color:var(--panel-border)] bg-[color:var(--bg)]/30 px-5">
          <button
            onClick={() => setTab('craft')}
            className={
              'px-4 py-2 text-xs uppercase tracking-wider transition-colors ' +
              (tab === 'craft'
                ? 'text-zinc-100 border-b-2 border-[color:var(--accent)] -mb-px'
                : 'text-zinc-500 hover:text-zinc-300')
            }
          >
            Craft
          </button>
          <button
            onClick={() => setTab('assemble')}
            className={
              'px-4 py-2 text-xs uppercase tracking-wider transition-colors ' +
              (tab === 'assemble'
                ? 'text-zinc-100 border-b-2 border-[color:var(--accent)] -mb-px'
                : 'text-zinc-500 hover:text-zinc-300')
            }
          >
            Assemble
          </button>
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

      {(!isWeaponBench || tab === 'craft') &&
        (recipes.length === 0 ? (
        <div className="px-5 py-8 text-zinc-500 text-sm text-center">
          No blueprints available for this station yet. <br />
          Buy more at the Artifact Uplink.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] sm:divide-x divide-[color:var(--panel-border)] min-h-[280px]">
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
      ))}

      {isWeaponBench && tab === 'assemble' && (
        <WeaponAssemblyPanel
          inventory={inventory}
          inRange={inRange}
          benchTier={weaponBenchTier}
          onAssemble={onAssembleWeapon}
        />
      )}
    </Modal>
  );
}
// Weapon assembly UI. Player picks a weapon from inventory; the
// slot grid shows piece slots (frame/grip/magazine/barrel up to
// the weapon's tier) + mod slots. Clicking an empty slot opens
// an inline chooser; clicking a filled slot stages a detach. The
// Assemble button is dim until staged ≠ current; on click, fires
// a single atomic assemble_weapon to the server. Stats panel
// below renders the staged-state effective stats live.
function WeaponAssemblyPanel({
  inventory,
  inRange,
  benchTier,
  onAssemble,
}: {
  inventory: Inventory;
  inRange: boolean;
  // Cap on weapon tier the bench can assemble. 0 if not in range
  // of any bench (assembly disabled). Mirrors the server gate.
  benchTier: number;
  onAssemble: (
    weaponIdx: number,
    pieces: Partial<Record<WeaponPieceKind, string | null>>,
    mods: string[]
  ) => void;
}) {
  const weapons = useMemo(() => {
    const out: { idx: number; weapon: WeaponItem }[] = [];
    for (let i = 0; i < inventory.length; i++) {
      const s = inventory[i];
      if (s.kind === 'weapon' && WEAPON_FAMILY[s.weapon.weaponId] !== 'melee') {
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

  const selected = weapons.find((w) => w.idx === selectedIdx) ?? null;

  // Staged config — initialised from the selected weapon's current
  // pieces/mods on selection change. Edits don't touch the live
  // weapon until Assemble fires. After a successful commit, the
  // server's inventory_changed re-renders us with the new weapon
  // state; the staged instance ids match the new state's so the
  // is-modified diff goes false and the button auto-dims.
  const [staged, setStaged] = useState<{
    pieces: Partial<Record<WeaponPieceKind, AttachmentInstance | null>>;
    mods: AttachmentInstance[];
  }>({ pieces: {}, mods: [] });

  useEffect(() => {
    if (!selected) {
      setStaged({ pieces: {}, mods: [] });
      return;
    }
    setStaged({
      pieces: { ...selected.weapon.pieces },
      mods: [...selected.weapon.mods],
    });
    // Reset only on selection change — not on weapon mutation —
    // so a successful Assemble doesn't blow away ongoing edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  const [chooser, setChooser] = useState<
    | { kind: 'piece'; piece: WeaponPieceKind }
    | { kind: 'mod' }
    | null
  >(null);

  if (weapons.length === 0) {
    return (
      <div className="px-5 py-4 border-t border-[color:var(--panel-border)] text-xs text-zinc-500">
        Craft a weapon at the Workbench first to assemble it here.
      </div>
    );
  }
  if (!selected) return null;

  const family = WEAPON_FAMILY[selected.weapon.weaponId];
  const allowedPieces = TIER_PIECE_SLOTS[selected.weapon.tier];
  const modCap = TIER_MOD_SLOTS[selected.weapon.tier];

  // Pool of attachments routable into a slot. = inventory attachments
  // ∪ original weapon's pieces+mods, minus anything already staged.
  // Including the original attachments lets a player who detached
  // then changed their mind re-attach without reverting first.
  const stagedIds = new Set<string>();
  for (const p of Object.values(staged.pieces)) {
    if (p) stagedIds.add(p.id);
  }
  for (const m of staged.mods) stagedIds.add(m.id);
  const pool: AttachmentInstance[] = [];
  for (const p of Object.values(selected.weapon.pieces)) {
    if (p && !stagedIds.has(p.id)) pool.push(p);
  }
  for (const m of selected.weapon.mods) {
    if (!stagedIds.has(m.id)) pool.push(m);
  }
  for (const s of inventory) {
    if (s.kind === 'attachment' && !stagedIds.has(s.instance.id)) {
      pool.push(s.instance);
    }
  }
  const candidatesForPiece = (piece: WeaponPieceKind) =>
    pool.filter((inst) => {
      const def = ATTACHMENT_DEFS[inst.defId];
      if (!def || def.kind !== 'weapon_affix') return false;
      if (def.pieceKind !== piece) return false;
      if (def.family !== null && def.family !== family) return false;
      return true;
    });
  const candidatesForMod = () =>
    pool.filter((inst) => {
      const def = ATTACHMENT_DEFS[inst.defId];
      if (!def || def.kind !== 'weapon_mod') return false;
      if (def.family !== null && def.family !== family) return false;
      return true;
    });

  // Diff by instance id so a successful commit (which replaces the
  // live weapon refs) reads as unchanged once ids align.
  const PIECE_KEYS: WeaponPieceKind[] = ['frame', 'grip', 'magazine', 'barrel'];
  const isModified = (() => {
    for (const piece of PIECE_KEYS) {
      const cur = selected.weapon.pieces[piece]?.id ?? null;
      const stg = staged.pieces[piece]?.id ?? null;
      if (cur !== stg) return true;
    }
    if (selected.weapon.mods.length !== staged.mods.length) return true;
    for (let i = 0; i < staged.mods.length; i++) {
      if (selected.weapon.mods[i].id !== staged.mods[i].id) return true;
    }
    return false;
  })();

  // Virtual weapon for the live stats panel.
  const stagedWeapon: WeaponItem = {
    ...selected.weapon,
    pieces: staged.pieces,
    mods: staged.mods,
  };
  const stagedStats = effectiveWeaponStats(stagedWeapon);
  const currentStats = effectiveWeaponStats(selected.weapon);

  const stagePieceAttach = (
    piece: WeaponPieceKind,
    instance: AttachmentInstance
  ) => {
    setStaged((s) => ({
      pieces: { ...s.pieces, [piece]: instance },
      mods: s.mods,
    }));
    setChooser(null);
  };
  const stagePieceDetach = (piece: WeaponPieceKind) => {
    setStaged((s) => ({
      pieces: { ...s.pieces, [piece]: null },
      mods: s.mods,
    }));
  };
  const stageModAttach = (instance: AttachmentInstance) => {
    setStaged((s) => ({
      pieces: s.pieces,
      mods: [...s.mods, instance],
    }));
    setChooser(null);
  };
  const stageModDetach = (idx: number) => {
    setStaged((s) => ({
      pieces: s.pieces,
      mods: s.mods.filter((_, i) => i !== idx),
    }));
  };
  const reset = () => {
    setStaged({
      pieces: { ...selected.weapon.pieces },
      mods: [...selected.weapon.mods],
    });
    setChooser(null);
  };
  const commit = () => {
    if (!isModified || !inRange) return;
    const piecesPayload: Partial<Record<WeaponPieceKind, string | null>> = {};
    for (const piece of PIECE_KEYS) {
      const cur = selected.weapon.pieces[piece]?.id ?? null;
      const stg = staged.pieces[piece]?.id ?? null;
      if (cur !== stg) {
        piecesPayload[piece] = stg ?? null;
      }
    }
    onAssemble(selected.idx, piecesPayload, staged.mods.map((m) => m.id));
  };

  // Phase 2.2: weapons whose tier exceeds the bench's tier can be
  // shown in the picker (so the player sees what they own) but
  // can't be assembled here. Apply a Bench Upgrade to lift the cap.
  const benchTierCap = benchTier > 0 ? benchTier : 1;
  const weaponBlocked =
    selected !== null && selected.weapon.tier > benchTierCap;

  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <div className="text-[10px] tabular-nums">
          <span className="text-zinc-500">Bench tier</span>{' '}
          <span className="text-amber-300 font-semibold">
            {benchTier > 0
              ? WEAPON_TIER_LABEL[benchTier as 1 | 2 | 3 | 4] ??
                `T${benchTier}`
              : '—'}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
        {/* Weapon picker — weapons above the bench's tier are
            disabled. Player can apply a Bench Upgrade item from
            the Forge to lift the cap. */}
        <ul className="flex flex-col gap-1 max-h-[260px] overflow-y-auto pr-1">
          {weapons.map((w) => {
            const blocked = w.weapon.tier > benchTierCap;
            return (
              <li key={w.idx}>
                <button
                  onClick={() => setSelectedIdx(w.idx)}
                  title={
                    blocked
                      ? `Requires Mk${w.weapon.tier} Weapon Bench`
                      : undefined
                  }
                  className={
                    'w-full text-left px-2 py-1.5 rounded text-[11px] border ' +
                    (w.idx === selectedIdx
                      ? 'border-[color:var(--accent)] text-zinc-100 bg-[color:var(--bg)]'
                      : blocked
                        ? 'border-[color:var(--panel-border)] text-zinc-600 hover:bg-[color:var(--bg)]/40'
                        : 'border-[color:var(--panel-border)] text-zinc-400 hover:bg-[color:var(--bg)]')
                  }
                >
                  {weaponDisplayName(w.weapon)}
                  {blocked && (
                    <span className="ml-1 text-[9px] text-amber-400">
                      ⚠
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {/* Slot grid + assemble */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-4 gap-1.5">
            {(['frame', 'grip', 'magazine', 'barrel'] as const).map((piece) => {
              const enabled = allowedPieces.includes(piece);
              const attached = staged.pieces[piece] ?? null;
              const isOpen =
                chooser?.kind === 'piece' && chooser.piece === piece;
              return (
                <button
                  key={piece}
                  disabled={!enabled}
                  onClick={() => {
                    if (!enabled) return;
                    if (attached) stagePieceDetach(piece);
                    else setChooser(isOpen ? null : { kind: 'piece', piece });
                  }}
                  className={
                    'flex flex-col items-center justify-center text-[10px] rounded border h-16 px-1 ' +
                    (!enabled
                      ? 'border-[color:var(--panel-border)] bg-[color:var(--bg)]/30 text-zinc-700 cursor-not-allowed'
                      : attached
                        ? 'border-violet-500/60 bg-violet-950/20 text-violet-200 hover:bg-violet-950/40'
                        : isOpen
                          ? 'border-[color:var(--accent)] bg-[color:var(--bg)]/70 text-zinc-200'
                          : 'border-dashed border-[color:var(--panel-border)] bg-[color:var(--bg)]/30 text-zinc-500 hover:border-violet-700 hover:text-violet-300')
                  }
                >
                  <span className="uppercase tracking-wider text-[9px] text-zinc-500">
                    {piece}
                  </span>
                  <span className="leading-tight text-center">
                    {attached
                      ? attachmentDisplayName(attached)
                      : enabled
                        ? '+ attach'
                        : 'locked'}
                  </span>
                </button>
              );
            })}
          </div>
          {modCap > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Mods
                </div>
                <div className="text-[10px] text-zinc-500 tabular-nums">
                  {staged.mods.length}/{modCap}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {Array.from({ length: modCap }).map((_, i) => {
                  const m = staged.mods[i];
                  const isOpen =
                    chooser?.kind === 'mod' && i === staged.mods.length;
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        if (m) stageModDetach(i);
                        else if (i === staged.mods.length)
                          setChooser(isOpen ? null : { kind: 'mod' });
                      }}
                      disabled={!m && i !== staged.mods.length}
                      className={
                        'flex items-center justify-center text-[10px] rounded border h-12 px-1 ' +
                        (m
                          ? 'border-blue-500/60 bg-blue-950/20 text-blue-200 hover:bg-blue-950/40'
                          : i === staged.mods.length
                            ? isOpen
                              ? 'border-[color:var(--accent)] bg-[color:var(--bg)]/70 text-zinc-200'
                              : 'border-dashed border-[color:var(--panel-border)] bg-[color:var(--bg)]/30 text-zinc-500 hover:border-blue-700 hover:text-blue-300'
                            : 'border-[color:var(--panel-border)] bg-[color:var(--bg)]/20 text-zinc-700 cursor-not-allowed')
                      }
                    >
                      {m
                        ? attachmentDisplayName(m)
                        : i === staged.mods.length
                          ? '+ mod'
                          : '—'}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {chooser && (
            <div className="rounded border border-[color:var(--panel-border)] bg-[color:var(--bg)]/40 p-2 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                  {chooser.kind === 'piece'
                    ? `Available — ${chooser.piece}`
                    : 'Available mods'}
                </div>
                <button
                  onClick={() => setChooser(null)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  cancel
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {(() => {
                  const list =
                    chooser.kind === 'piece'
                      ? candidatesForPiece(chooser.piece)
                      : candidatesForMod();
                  if (list.length === 0) {
                    return (
                      <span className="text-[10px] text-zinc-600 px-1">
                        nothing compatible in inventory
                      </span>
                    );
                  }
                  return list.map((inst) => {
                    const def = ATTACHMENT_DEFS[inst.defId];
                    return (
                      <button
                        key={inst.id}
                        onClick={() =>
                          chooser.kind === 'piece'
                            ? stagePieceAttach(chooser.piece, inst)
                            : stageModAttach(inst)
                        }
                        title={def?.description}
                        className={
                          'px-2 py-1 rounded text-[10px] border ' +
                          (chooser.kind === 'piece'
                            ? 'border-violet-700 bg-violet-950/30 text-violet-200 hover:bg-violet-950'
                            : 'border-blue-700 bg-blue-950/30 text-blue-200 hover:bg-blue-950')
                        }
                      >
                        + {attachmentDisplayName(inst)}
                      </button>
                    );
                  });
                })()}
              </div>
            </div>
          )}
          {currentStats && (
            <WeaponStatsPanel
              current={currentStats}
              preview={isModified ? stagedStats : null}
            />
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] text-zinc-500">
              Tier{' '}
              {WEAPON_TIER_LABEL[selected.weapon.tier] ??
                `T${selected.weapon.tier}`}
              {weaponBlocked && (
                <span className="ml-2 text-amber-400">
                  Requires Mk{selected.weapon.tier} bench
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              {isModified && (
                <button
                  onClick={reset}
                  className="px-2 py-1 rounded text-[10px] border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)]"
                >
                  Reset
                </button>
              )}
              <button
                onClick={commit}
                disabled={!isModified || !inRange || weaponBlocked}
                title={
                  weaponBlocked
                    ? `Apply a Mk${selected.weapon.tier} Bench Upgrade to lift the cap.`
                    : undefined
                }
                className="px-3 py-1.5 rounded text-[11px] border border-emerald-700 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-950 disabled:opacity-30"
              >
                Assemble
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Precision Machining Mill — vendor-shaped station that hosts only
// the tier-up flow. Lists every non-melee weapon, surfaces the
// next-tier label and material cost from TIER_UP_COSTS, and
// disables the button when the player can't afford. Server enforces
// the same rules.
function PrecisionMillModal({
  inventory,
  inRange,
  onClose,
  onTierUpWeapon,
}: {
  inventory: Inventory;
  inRange: boolean;
  onClose: () => void;
  onTierUpWeapon: (idx: number) => void;
}) {
  const weapons = useMemo(() => {
    const out: { idx: number; weapon: WeaponItem }[] = [];
    for (let i = 0; i < inventory.length; i++) {
      const s = inventory[i];
      if (s.kind === 'weapon' && WEAPON_FAMILY[s.weapon.weaponId] !== 'melee') {
        out.push({ idx: i, weapon: s.weapon });
      }
    }
    return out;
  }, [inventory]);

  return (
    <Modal onClose={onClose} width="min(640px, 94vw)">
      <div className="flex items-center justify-between px-5 py-4 border-b-2 border-[color:var(--accent)]/30 bg-[color:var(--bg)]/50">
        <h2 className="font-semibold flex items-center gap-2 text-base">
          <ItemIcon kind="placeable" subkind="precision_mill" />
          <span>Precision Machining Mill</span>
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
          Move closer to the mill to tier up.
        </div>
      )}
      {weapons.length === 0 ? (
        <div className="px-5 py-8 text-zinc-500 text-sm text-center">
          No tier-able weapons in inventory.
        </div>
      ) : (
        <div className="px-5 py-4 flex flex-col gap-2">
          {weapons.map((w) => {
            const maxed = w.weapon.tier >= 4;
            const cost = maxed
              ? null
              : TIER_UP_COSTS[w.weapon.tier as 1 | 2 | 3];
            const canAfford =
              !!cost &&
              cost.every(
                (c) => countMaterial(inventory, c.materialId) >= c.count
              );
            const nextLabel = maxed
              ? 'Max Tier'
              : `Tier Up → ${
                  WEAPON_TIER_LABEL[(w.weapon.tier + 1) as 1 | 2 | 3 | 4] ??
                  `T${w.weapon.tier + 1}`
                }`;
            return (
              <div
                key={w.idx}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-[color:var(--panel-border)] bg-[color:var(--bg)]/40"
              >
                <div className="flex flex-col">
                  <span className="text-zinc-100 text-sm">
                    {weaponDisplayName(w.weapon)}
                  </span>
                  {!maxed && cost && (
                    <span className="text-[10px] text-zinc-500">
                      {cost
                        .map(
                          (c) =>
                            `${c.count} ${
                              MATERIALS[c.materialId]?.name ?? c.materialId
                            }`
                        )
                        .join(' · ')}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => onTierUpWeapon(w.idx)}
                  disabled={maxed || !inRange || !canAfford}
                  className="px-3 py-1.5 rounded text-[11px] border border-amber-700 bg-amber-950/30 text-amber-200 hover:bg-amber-950 disabled:opacity-30"
                >
                  {nextLabel}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// Suit Assembly Bench — Phase 2.5 sibling of the Weapon Bench
// redesign for suit parts. Picks an equipped suit slot, lists its
// attachment slots (1–4 by part tier), inline chooser for
// compatible suit_affix instances from inventory, live SuitStatsPanel
// showing current vs staged effective suit stats, and an atomic
// Assemble button that fires a single assemble_suit_part message.
function SuitAssemblyModal({
  inventory,
  equipment,
  inRange,
  onClose,
  onAssemble,
}: {
  inventory: Inventory;
  equipment: Equipment;
  inRange: boolean;
  onClose: () => void;
  onAssemble: (suitSlot: SuitSlotKind, attachments: string[]) => void;
}) {
  return (
    <Modal onClose={onClose} width="min(720px, 94vw)">
      <div className="flex items-center justify-between px-5 py-4 border-b-2 border-[color:var(--accent)]/30 bg-[color:var(--bg)]/50">
        <h2 className="font-semibold flex items-center gap-2 text-base">
          <ItemIcon kind="placeable" subkind="suit_bench" />
          <span>Suit Assembly Bench</span>
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
          Move closer to the bench to assemble.
        </div>
      )}
      <SuitAssemblyPanel
        inventory={inventory}
        equipment={equipment}
        inRange={inRange}
        onAssemble={onAssemble}
      />
    </Modal>
  );
}

function SuitAssemblyPanel({
  inventory,
  equipment,
  inRange,
  onAssemble,
}: {
  inventory: Inventory;
  equipment: Equipment;
  inRange: boolean;
  onAssemble: (suitSlot: SuitSlotKind, attachments: string[]) => void;
}) {
  const equippedSlots = useMemo(() => {
    return SUIT_SLOT_KINDS.filter((s) => equipment[s] !== null);
  }, [equipment]);

  const [selectedSlot, setSelectedSlot] = useState<SuitSlotKind | null>(
    equippedSlots[0] ?? null
  );
  useEffect(() => {
    if (selectedSlot && !equippedSlots.includes(selectedSlot)) {
      setSelectedSlot(equippedSlots[0] ?? null);
    } else if (!selectedSlot && equippedSlots.length > 0) {
      setSelectedSlot(equippedSlots[0]);
    }
  }, [equippedSlots, selectedSlot]);

  const selectedPart = selectedSlot ? equipment[selectedSlot] : null;

  // Staged attachments for the selected part. Initialised from the
  // live part's appliedAttachments on selection change; mutated as
  // the player attaches/detaches; committed via assemble_suit_part.
  const [staged, setStaged] = useState<AttachmentInstance[]>([]);
  useEffect(() => {
    if (!selectedPart) {
      setStaged([]);
      return;
    }
    setStaged([...(selectedPart.appliedAttachments ?? [])]);
    // Reset only on slot change — server commits round-trip via
    // equipment_changed which reseats the part reference; the diff-
    // by-id check below handles the auto-dim cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlot]);

  const [chooserOpen, setChooserOpen] = useState(false);

  if (equippedSlots.length === 0 || !selectedPart || !selectedSlot) {
    return (
      <div className="px-5 py-8 text-zinc-500 text-sm text-center">
        No suit parts equipped. Equip a part in the inventory panel
        first.
      </div>
    );
  }

  const slotCap = SUIT_ATTACHMENT_SLOTS[selectedPart.tier];

  // Pool of attachments routable into a slot. = inventory
  // suit-affix attachments + the part's currently-attached
  // attachments minus anything already staged.
  const stagedIds = new Set<string>();
  for (const a of staged) stagedIds.add(a.id);
  const pool: AttachmentInstance[] = [];
  for (const a of selectedPart.appliedAttachments ?? []) {
    if (!stagedIds.has(a.id)) pool.push(a);
  }
  for (const s of inventory) {
    if (s.kind === 'attachment' && !stagedIds.has(s.instance.id)) {
      pool.push(s.instance);
    }
  }
  const candidates = pool.filter((inst) => {
    const def = ATTACHMENT_DEFS[inst.defId];
    if (!def || def.kind !== 'suit_affix') return false;
    if (def.slotKind !== selectedSlot) return false;
    return true;
  });

  // Live diff against the live part by AttachmentInstance.id so a
  // successful commit (which replaces the part ref) reads as
  // unchanged once ids align.
  const isModified = (() => {
    const cur = selectedPart.appliedAttachments ?? [];
    if (cur.length !== staged.length) return true;
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].id !== staged[i].id) return true;
    }
    return false;
  })();

  // Synthesised equipment for the live SuitStatsPanel preview.
  // Apply staged attachments to a copy of the selected part; leave
  // every other slot untouched.
  const stagedEquipment: Equipment = {
    ...equipment,
    [selectedSlot]: {
      ...selectedPart,
      appliedAttachments: staged,
    },
  };
  const currentStats = computeSuitStats(equipment);
  const stagedStats = computeSuitStats(stagedEquipment);

  const stageAttach = (instance: AttachmentInstance) => {
    setStaged((s) => {
      if (s.length >= slotCap) {
        // Replace the last slot if at cap so the player sees the
        // swap without an explicit detach.
        return [...s.slice(0, -1), instance];
      }
      return [...s, instance];
    });
    setChooserOpen(false);
  };
  const stageDetach = (idx: number) => {
    setStaged((s) => s.filter((_, i) => i !== idx));
  };
  const reset = () => {
    setStaged([...(selectedPart.appliedAttachments ?? [])]);
    setChooserOpen(false);
  };
  const commit = () => {
    if (!isModified || !inRange) return;
    onAssemble(
      selectedSlot,
      staged.map((a) => a.id)
    );
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          Equipped Part
        </div>
        <div className="text-[10px] tabular-nums">
          <span className="text-zinc-500">Slots</span>{' '}
          <span className="text-amber-300 font-semibold">
            {staged.length}/{slotCap}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
        {/* Suit-slot picker — only equipped slots are pickable. */}
        <ul className="flex flex-col gap-1">
          {equippedSlots.map((slot) => {
            const part = equipment[slot]!;
            return (
              <li key={slot}>
                <button
                  onClick={() => setSelectedSlot(slot)}
                  className={
                    'w-full text-left px-2 py-1.5 rounded text-[11px] border ' +
                    (slot === selectedSlot
                      ? 'border-[color:var(--accent)] text-zinc-100 bg-[color:var(--bg)]'
                      : 'border-[color:var(--panel-border)] text-zinc-400 hover:bg-[color:var(--bg)]')
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span>{SUIT_LABELS[slot] ?? slot}</span>
                    <span
                      className="text-[9px] font-semibold tabular-nums"
                      style={{ color: TIER_HEX[part.tier] }}
                    >
                      {part.tier}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        {/* Slot grid + assemble */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: slotCap }).map((_, i) => {
              const inst = staged[i];
              const isAddSlot = !inst && i === staged.length;
              return (
                <button
                  key={i}
                  onClick={() => {
                    if (inst) stageDetach(i);
                    else if (isAddSlot) setChooserOpen((v) => !v);
                  }}
                  disabled={!inst && !isAddSlot}
                  className={
                    'flex flex-col items-center justify-center text-[10px] rounded border h-16 px-1 ' +
                    (inst
                      ? 'border-emerald-500/60 bg-emerald-950/20 text-emerald-200 hover:bg-emerald-950/40'
                      : isAddSlot
                        ? chooserOpen
                          ? 'border-[color:var(--accent)] bg-[color:var(--bg)]/70 text-zinc-200'
                          : 'border-dashed border-[color:var(--panel-border)] bg-[color:var(--bg)]/30 text-zinc-500 hover:border-emerald-700 hover:text-emerald-300'
                        : 'border-[color:var(--panel-border)] bg-[color:var(--bg)]/20 text-zinc-700 cursor-not-allowed')
                  }
                >
                  {inst ? (
                    <>
                      <span
                        className="text-[8px] font-semibold tabular-nums"
                        style={{ color: TIER_HEX[inst.tier] }}
                      >
                        {inst.tier}
                      </span>
                      <span className="leading-tight text-center">
                        {attachmentDisplayName(inst)}
                      </span>
                    </>
                  ) : isAddSlot ? (
                    <span className="leading-tight">+ attach</span>
                  ) : (
                    <span className="leading-tight">—</span>
                  )}
                </button>
              );
            })}
          </div>
          {chooserOpen && (
            <div className="rounded border border-[color:var(--panel-border)] bg-[color:var(--bg)]/40 p-2 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Available — {SUIT_LABELS[selectedSlot] ?? selectedSlot}
                </div>
                <button
                  onClick={() => setChooserOpen(false)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  cancel
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {candidates.length === 0 ? (
                  <span className="text-[10px] text-zinc-600 px-1">
                    nothing compatible in inventory — craft Hardened Plating
                    or Servomotor Tune at the Electronics Bench
                  </span>
                ) : (
                  candidates.map((inst) => {
                    const def = ATTACHMENT_DEFS[inst.defId];
                    return (
                      <button
                        key={inst.id}
                        onClick={() => stageAttach(inst)}
                        title={def?.description}
                        className="px-2 py-1 rounded text-[10px] border border-emerald-700 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-950"
                      >
                        + {attachmentDisplayName(inst)}{' '}
                        <span
                          className="text-[8px] font-semibold tabular-nums"
                          style={{ color: TIER_HEX[inst.tier] }}
                        >
                          {inst.tier}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
          <SuitStatsPanel
            current={currentStats}
            preview={isModified ? stagedStats : null}
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] text-zinc-500">
              {SUIT_LABELS[selectedSlot] ?? selectedSlot} —{' '}
              {selectedPart.tier}
            </span>
            <div className="flex items-center gap-2">
              {isModified && (
                <button
                  onClick={reset}
                  className="px-2 py-1 rounded text-[10px] border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)]"
                >
                  Reset
                </button>
              )}
              <button
                onClick={commit}
                disabled={!isModified || !inRange}
                className="px-3 py-1.5 rounded text-[11px] border border-emerald-700 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-950 disabled:opacity-30"
              >
                Assemble
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Live diff between the suit's current SuitStats and a staged
// configuration. Mirrors WeaponStatsPanel — green for an
// improvement, red for a regression. Each row shows the current
// value with the delta beside it when staged differs.
function SuitStatsPanel({
  current,
  preview,
}: {
  current: import('@dumrunner/shared').SuitStats;
  preview: import('@dumrunner/shared').SuitStats | null;
}) {
  type StatRow = {
    label: string;
    cur: number;
    prv: number;
    fmt: (v: number) => string;
  };
  const rows: StatRow[] = [
    {
      label: 'Max HP',
      cur: current.hpBonus,
      prv: preview?.hpBonus ?? current.hpBonus,
      fmt: (v) => (v === 0 ? '—' : `+${Math.round(v)}`),
    },
    {
      label: 'Max shield',
      cur: current.shieldBonus,
      prv: preview?.shieldBonus ?? current.shieldBonus,
      fmt: (v) => (v === 0 ? '—' : `+${Math.round(v)}`),
    },
    {
      label: 'Max stamina',
      cur: current.staminaMaxBonus,
      prv: preview?.staminaMaxBonus ?? current.staminaMaxBonus,
      fmt: (v) => (v === 0 ? '—' : `+${Math.round(v)}`),
    },
    {
      label: 'Stamina regen',
      cur: current.staminaRegenBonus,
      prv: preview?.staminaRegenBonus ?? current.staminaRegenBonus,
      fmt: (v) => (v === 0 ? '—' : `+${v.toFixed(1)}/s`),
    },
    {
      label: 'Move speed',
      cur: current.moveSpeedMult,
      prv: preview?.moveSpeedMult ?? current.moveSpeedMult,
      fmt: (v) => (v === 0 ? '—' : `+${Math.round(v * 100)}%`),
    },
  ];
  return (
    <div className="rounded border border-[color:var(--panel-border)] bg-[color:var(--bg)]/30 p-2 text-[11px]">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
        Suit stats {preview ? '(live preview)' : ''}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {rows.map((r) => {
          const changed = preview && Math.abs(r.prv - r.cur) > 0.0001;
          // For these stats, higher = better.
          const better = changed && r.prv > r.cur;
          const arrow = changed ? (better ? '↑' : '↓') : '';
          return (
            <div key={r.label} className="flex items-center justify-between">
              <span className="text-zinc-400">{r.label}</span>
              <span className="tabular-nums text-zinc-200">
                {r.fmt(preview ? r.prv : r.cur)}
                {changed && (
                  <span
                    className={
                      'ml-1 ' +
                      (better ? 'text-emerald-400' : 'text-red-400')
                    }
                  >
                    {arrow} {r.fmt(r.cur)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
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
          src.consumableId === d.consumableId) ||
        (src.kind === 'upgrade' &&
          d.kind === 'upgrade' &&
          src.upgradeId === d.upgradeId)
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
    <Modal onClose={onClose} width="min(720px, 95vw)">
      <div className="flex items-center justify-between px-5 py-4 border-b-2 border-[color:var(--accent)]/30 bg-[color:var(--bg)]/50">
        <div>
          <h2 className="font-semibold text-zinc-100 text-base">Storage</h2>
          <p className="text-[11px] text-zinc-500">
            Click a slot to transfer to the other side.
          </p>
        </div>
        <button
          onClick={onClose}
          className="px-2 py-1 rounded text-xs border border-[color:var(--panel-border)] text-zinc-300 hover:bg-[color:var(--bg)]"
        >
          Close [Esc]
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5 max-h-[calc(100vh-160px)] overflow-y-auto">
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
    </Modal>
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
                'aspect-square rounded border w-14 h-14 flex items-center justify-center ' +
                (empty
                  ? 'bg-[color:var(--bg)] border-[color:var(--panel-border)] cursor-default'
                  : 'bg-[color:var(--bg)] border-[color:var(--panel-border)] hover:border-[color:var(--accent)]')
              }
              title={empty ? 'Empty' : outputSlotLabel(slot)}
            >
              <SlotIcon slot={slot} />
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
  if (slot.kind === 'upgrade') {
    const def = UPGRADES[slot.upgradeId];
    return `${slot.count}× ${def?.name ?? slot.upgradeId}`;
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
  if (out.kind === 'material') {
    const def = MATERIALS[out.materialId];
    return `${out.count}× ${def?.name ?? out.materialId}`;
  }
  if (out.kind === 'upgrade') {
    const def = UPGRADES[out.upgradeId];
    return `${out.count}× ${def?.name ?? out.upgradeId}`;
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
    <div className="flex flex-col items-center gap-2 md:pr-3 md:border-r border-[color:var(--panel-border)] md:pb-0 pb-3 md:border-b-0 border-b">
      <div className="text-xs uppercase tracking-wider text-zinc-500">Suit</div>
      <div className="relative w-44 h-52">
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
      <div className="text-[10px] text-zinc-500 leading-snug w-44 text-center">
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
  bonus?: string | null;
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
  // Slot label sits under the box and always shows the slot kind
  // (Chassis / Plating / etc.) so the player can see which slot
  // is which at a glance. When a part is equipped, an inline tier
  // badge at the start of the label colour-codes the tier.
  // Right-click to unequip — the title carries the full part name
  // so hover-inspecting still works for tooltips.
  const slotLabel = SUIT_LABELS[kind];
  const titleText = part
    ? `${partDisplayName(part)} — ${slotLabel}`
    : slotLabel;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className={`w-10 h-10 rounded border ${
          part
            ? 'border-[color:var(--accent)]'
            : 'border-[color:var(--panel-border)]'
        } bg-[color:var(--bg)] flex items-center justify-center`}
        title={titleText}
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
            {slotLabel.split(' ')[0]}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 leading-none">
        {part && (
          <span
            className="text-[8px] font-semibold tabular-nums"
            style={{ color: TIER_HEX[part.tier] }}
          >
            {part.tier}
          </span>
        )}
        <span className="text-[8px] text-zinc-400">{slotLabel}</span>
      </div>
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
  if (slot.kind === 'upgrade') {
    const def = UPGRADES[slot.upgradeId];
    return `${def?.name ?? slot.upgradeId} ×${slot.count}\n${
      def?.description ?? ''
    }`;
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
    // Life-support resists. Each part has a specialty hazard; the
    // other 3 hazards roll the off-coverage value at the same tier.
    if (part.slot === 'life_support') {
      const specialty = part.specialtyHazard ?? defaultSpecialtyForPartId(part.id);
      const r = lifeSupportResists(part.tier, specialty);
      lines.push('— Resists —');
      lines.push(`Heat: ${Math.round(r.heatResist * 100)}%${specialty === 'heat' ? '  (specialty)' : ''}`);
      lines.push(`Cold: ${Math.round(r.coldResist * 100)}%${specialty === 'cold' ? '  (specialty)' : ''}`);
      lines.push(`Radiation: ${Math.round(r.radiationResist * 100)}%${specialty === 'radiation' ? '  (specialty)' : ''}`);
      lines.push(`Toxic: ${Math.round(r.toxicResist * 100)}%${specialty === 'toxic' ? '  (specialty)' : ''}`);
    }
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
  onInspect,
  inspecting,
}: {
  slot: InventorySlot;
  index: number;
  hotkey?: number;
  highlighted?: boolean;
  size: 'hotbar' | 'panel';
  onSwap?: (from: number, to: number) => void;
  onContextMenu?: (slot: number, x: number, y: number) => void;
  onArmorDrop?: (suitSlot: SuitSlotKind) => void;
  // Left-click handler for the click-to-inspect panel. Browsers
  // fire `click` only on a true press+release, not on drags, so
  // this coexists with the drag-to-swap flow without conflict.
  onInspect?: (slot: number) => void;
  // Highlights the slot the inspector is currently focused on so
  // the player can see which item the stats panel describes.
  inspecting?: boolean;
}) {
  // Cells shrink on narrow screens so a 9-wide hotbar still fits a
  // 360px-class device. Inventory-panel cells stay 56px because the
  // modal grid drops to 6 columns at the same breakpoint, so the
  // total grid width is unchanged.
  const dim =
    size === 'hotbar'
      ? 'w-10 h-10 sm:w-12 sm:h-12 text-[10px] sm:text-xs'
      : 'w-12 h-12 sm:w-14 sm:h-14 text-[10px] sm:text-[11px]';
  const border = highlighted
    ? 'border-2 border-[color:var(--accent)]'
    : inspecting
      ? 'border-2 border-amber-400/70'
      : 'border border-[color:var(--panel-border)]';

  const draggable = slot.kind !== 'empty' && !!onSwap;
  // Native title= is only used on the bottom hotbar (size === 'hotbar'),
  // where the click-to-inspect panel isn't available. Inside the
  // inventory modal (size === 'panel') the InspectPanel is the fast
  // path; the OS tooltip's ~1s hover delay would just be noise there
  // and is visibly bad inside Discord's Activity iframe.
  const title = size === 'hotbar' ? slotTooltip(slot) : undefined;

  return (
    <div
      className={`relative rounded ${dim} ${border} bg-[color:var(--bg)] flex items-center justify-center text-center ${
        onInspect && slot.kind !== 'empty' ? 'cursor-pointer' : ''
      }`}
      title={title}
      draggable={draggable}
      onClick={
        onInspect && slot.kind !== 'empty'
          ? () => onInspect(index)
          : undefined
      }
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
  onApplyUpgrade,
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
  // Set when the slot is an `upgrade` item AND there's a matching-
  // tier weapon bench in range. Undefined hides the action.
  onApplyUpgrade?: () => void;
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
        {onApplyUpgrade && (
          <button
            className="block w-full text-left px-3 py-2 hover:bg-[color:var(--bg)] text-amber-300"
            onClick={onApplyUpgrade}
          >
            Apply to Bench
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
    const label = BUILDING_REGISTRY[slot.buildingKind]?.label ?? slot.buildingKind;
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <ItemIcon kind="placeable" subkind={slot.buildingKind} />
        <span className="text-zinc-200 text-[9px] capitalize truncate max-w-[68px]">
          {label}
        </span>
        <span className="text-zinc-400 text-[9px]">×{slot.count}</span>
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
        <span className="text-zinc-200 text-[9px] truncate max-w-[68px]">
          {slot.ammoId.replace(/_/g, ' ')}
        </span>
        <span className="text-zinc-400 text-[9px]">×{slot.count}</span>
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
  if (slot.kind === 'upgrade') {
    const def = UPGRADES[slot.upgradeId];
    const c = `#${(def?.color ?? 0xfde047).toString(16).padStart(6, '0')}`;
    // Mk number from the targetTier — short label so the icon
    // reads as "Mk2 / Mk3 / Mk4" at a glance.
    const tierLabel = `Mk${def?.targetTier ?? '?'}`;
    return (
      <div className="flex flex-col items-center leading-tight gap-0.5">
        <div
          className="w-6 h-6 rounded-sm border flex items-center justify-center font-bold text-[8px]"
          style={{ background: `${c}33`, borderColor: c, color: c }}
        >
          {tierLabel}
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
  if (kind === 'placeable' && subkind === 'precision_mill') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" fill="#1e293b" stroke="#000" strokeWidth={stroke} />
        <rect x="6" y="14" width="12" height="6" fill="#475569" stroke="#0f172a" strokeWidth={stroke} />
        <circle cx="12" cy="11" r="4.5" fill="#94a3b8" stroke="#1e293b" strokeWidth="1" />
        <circle cx="12" cy="11" r="1.5" fill="#fbbf24" />
        <line x1="12" y1="6" x2="12" y2="9" stroke="#cbd5e1" strokeWidth="1.5" />
        <line x1="12" y1="13" x2="12" y2="16" stroke="#cbd5e1" strokeWidth="1.5" />
        <line x1="7" y1="11" x2="9" y2="11" stroke="#cbd5e1" strokeWidth="1.5" />
        <line x1="15" y1="11" x2="17" y2="11" stroke="#cbd5e1" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'placeable' && subkind === 'suit_bench') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" fill="#1e3a8a" stroke="#0c1126" strokeWidth={stroke} />
        {/* Suit silhouette: head, chest, arms */}
        <circle cx="12" cy="8" r="2.5" fill="#cbd5e1" stroke="#1e293b" strokeWidth="0.7" />
        <rect x="8" y="11" width="8" height="7" fill="#94a3b8" stroke="#1e293b" strokeWidth="0.7" />
        <rect x="5" y="12" width="2.5" height="5" fill="#94a3b8" stroke="#1e293b" strokeWidth="0.7" />
        <rect x="16.5" y="12" width="2.5" height="5" fill="#94a3b8" stroke="#1e293b" strokeWidth="0.7" />
        {/* Plating accent */}
        <line x1="9" y1="13" x2="15" y2="13" stroke="#22d3ee" strokeWidth="1" />
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
