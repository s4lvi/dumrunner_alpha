import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  emptyEquipment,
  emptyInventory,
  addPart as invAddPart,
  rollAttachmentInstance,
  type ClientMessage,
  type Equipment,
  type Inventory,
  type ServerMessage,
  type Player,
} from '@dumrunner/shared';
import { verifyJoinToken } from '@dumrunner/shared/token';
import {
  buildPlaytestEquipment,
  buildPlaytestInventory,
  buildStarterInventory,
} from './starter.js';
import { env } from './env.js';
import { supabase } from './supabase.js';
import { registry } from './registry.js';
import { initTemplates } from './ai/templates.js';
import { initBiomes } from './biomes.js';
import { initBlueprints } from './blueprints.js';
import { initProps } from './props.js';
import { initBuildingOverrides } from './buildingOverrides.js';
import { initRooms } from './rooms.js';
import { initCorridors } from './corridors.js';
import { initWeapons } from './weapons.js';
import { initRecipes } from './recipes.js';
import { initAttachments } from './attachments.js';
import { SandboxWorld } from './sandbox.js';
import { startContentWatch } from './contentWatch.js';
import type { World } from './world.js';

// Hydrate JSON-backed content registries before accepting
// connections. Templates is hard-required (no enemies = no game,
// throws). Biomes + props are soft — empty content dir means no
// biome variety / no decorators, but the server still boots.
await initTemplates();
await initBiomes();
await initProps();
await initBuildingOverrides();
await initRooms();
await initCorridors();
await initBlueprints();
await initWeapons();
await initRecipes();
await initAttachments();

// Hot-reload content registries on file changes so editor saves
// land in the running sandbox without a server restart. Reload is
// per-area; an enemy save triggers initTemplates (which also
// refreshes shared enemy visuals) but doesn't touch biomes.
startContentWatch({
  biomes: initBiomes,
  enemies: initTemplates,
  props: initProps,
  rooms: initRooms,
  corridors: initCorridors,
  blueprints: initBlueprints,
  weapons: initWeapons,
  recipes: initRecipes,
  attachments: initAttachments,
  buildings: initBuildingOverrides,
});

// Typed dispatch map for inbound client messages. Each key is a
// ClientMessage['type']; each value handles ONLY that type (TS narrows
// `m` via the Extract<> in the value signature). Adding a new message
// type is one entry here plus the protocol schema entry. Keeps the
// route handler at the bottom of the file three lines long.
//
// 'auth' is the pre-auth handshake; sandbox_* messages are routed
// to SandboxWorld (separate code path). Everything else lands here.
type LiveGameMessageType = Exclude<
  ClientMessage['type'],
  | 'auth'
  | 'sandbox_spawn_enemy'
  | 'sandbox_clear'
  | 'sandbox_set_loadout'
  | 'sandbox_regen_floor'
  | 'sandbox_stamp_room'
>;
type ClientMessageHandlers = {
  [K in LiveGameMessageType]: (
    world: World,
    characterId: string,
    msg: Extract<ClientMessage, { type: K }>
  ) => void;
};

const MESSAGE_HANDLERS: ClientMessageHandlers = {
  input: (w, c, m) => w.handleInput(c, m.moveX, m.moveY, m.sprint),
  fire: (w, c, m) => w.handleFire(c, m.dirX, m.dirY),
  build_request: (w, c, m) =>
    w.handleBuildRequest(c, m.kind, m.tileX, m.tileY),
  demolish_request: (w, c, m) => w.handleDemolishRequest(c, m.buildingId),
  select_hotbar: (w, c, m) => w.handleSelectHotbar(c, m.slot),
  inventory_swap: (w, c, m) => w.handleInventorySwap(c, m.from, m.to),
  inventory_discard: (w, c, m) => w.handleInventoryDiscard(c, m.slot, m.all),
  inventory_sort: (w, c) => w.handleInventorySort(c),
  equip_request: (w, c, m) =>
    w.handleEquipRequest(c, m.fromInventoryIdx, m.suitSlot),
  unequip_request: (w, c, m) =>
    w.handleUnequipRequest(c, m.suitSlot, m.toInventoryIdx),
  interact: (w, c, m) => w.handleInteract(c, m.interactableId),
  craft_request: (w, c, m) => w.handleCraftRequest(c, m.recipeId),
  purchase_blueprint: (w, c, m) => w.handlePurchaseBlueprint(c, m.blueprintId),
  purchase_key: (w, c, m) => w.handlePurchaseKey(c, m.count),
  pickup_station_outputs: (w, c, m) =>
    w.handlePickupStationOutputs(c, m.kind),
  open_door: (w, c, m) => w.handleOpenDoor(c, m.buildingId),
  open_container: (w, c, m) => w.handleOpenContainer(c, m.propId),
  container_take: (w, c, m) => w.handleContainerTake(c, m.propId, m.slot),
  attach_weapon_affix: (w, c, m) =>
    w.handleAttachWeaponAffix(
      c,
      m.weaponInventoryIdx,
      m.pieceKind,
      m.attachmentDefId
    ),
  detach_weapon_affix: (w, c, m) =>
    w.handleDetachWeaponAffix(c, m.weaponInventoryIdx, m.pieceKind),
  attach_weapon_mod: (w, c, m) =>
    w.handleAttachWeaponMod(c, m.weaponInventoryIdx, m.attachmentDefId),
  detach_weapon_mod: (w, c, m) =>
    w.handleDetachWeaponMod(c, m.weaponInventoryIdx, m.modIndex),
  attach_suit_affix: (w, c, m) =>
    w.handleAttachSuitAffix(c, m.suitSlot, m.attachmentDefId),
  detach_suit_affix: (w, c, m) =>
    w.handleDetachSuitAffix(c, m.suitSlot, m.attachmentIndex),
  tier_up_weapon: (w, c, m) => w.handleTierUpWeapon(c, m.weaponInventoryIdx),
  assemble_weapon: (w, c, m) =>
    w.handleAssembleWeapon(c, m.weaponInventoryIdx, m.pieces, m.mods),
  assemble_suit_part: (w, c, m) =>
    w.handleAssembleSuitPart(c, m.suitSlot, m.attachments),
  upgrade_workstation: (w, c, m) =>
    w.handleUpgradeWorkstation(c, m.buildingId, m.upgradeId),
  use_consumable: (w, c, m) => w.handleUseConsumable(c, m.slot),
  reload_weapon: (w, c) => w.handleReloadWeapon(c),
  chat: (w, c, m) => w.handleChat(c, m.text),
  pause_server: (w, c) => {
    void w.handlePauseServer(c);
  },
  storage_move: (w, c, m) =>
    w.handleStorageMove(
      c,
      m.buildingId,
      m.fromKind,
      m.fromIdx,
      m.toKind,
      m.toIdx
    ),
  inventory_drop: (w, c, m) => w.handleInventoryDrop(c, m.slot, m.all),
  salvage_request: (w, c, m) => w.handleSalvageRequest(c, m.slot),
  give_item: (w, c, m) =>
    w.handleGiveItem(c, m.targetCharacterId, m.slot, m.all),
};

const wss = new WebSocketServer({ port: env.port, host: env.host });

wss.on('listening', () => {
  const addr = wss.address();
  console.log(`[ws] DÛM RUNNER game server listening on`, addr);
});

// Heartbeat: Fly's edge proxy idles HTTP/WebSocket connections after
// ~60s of silence, dropping the connection client-side. The 20Hz tick
// loop fires server→client traffic constantly during play, but a
// player standing in a quiet menu (workstation modal, lobby pause)
// can go silent enough for the edge to close. Every 25s we ping every
// open ws; sockets that fail to pong within the next interval are
// dead and we tear them down.
type HeartbeatWS = WebSocket & { isAlive?: boolean };
const HEARTBEAT_INTERVAL_MS = 25_000;
const heartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    const c = client as HeartbeatWS;
    if (c.isAlive === false) {
      c.terminate();
      continue;
    }
    c.isAlive = false;
    try {
      c.ping();
    } catch {
      // socket is mid-close; next interval terminates it.
    }
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('error', (err) => {
  console.error('[ws] server error:', err);
});

wss.on('connection', (ws: WebSocket) => {
  // Each connection starts unauthenticated. The first message must be {type:'auth'}
  // with a valid signed JoinToken. Anything else is a protocol violation.
  let player: Player | null = null;
  let serverId: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Editor-sandbox connections live in a parallel world (see
  // SandboxWorld). When a sandbox token authenticates, this is
  // populated and the regular live-game path is skipped.
  let sandbox: SandboxWorld | null = null;
  // Heartbeat liveness flag — flipped to false on each scheduler tick;
  // the client's pong response flips it back. See top-level
  // heartbeatTimer for the sweep.
  (ws as HeartbeatWS).isAlive = true;
  ws.on('pong', () => {
    (ws as HeartbeatWS).isAlive = true;
  });

  // Disconnect if the client doesn't auth within 5 seconds.
  const authTimer = setTimeout(() => {
    if (!player) {
      sendError(ws, 'auth_timeout');
      ws.close(4001, 'auth_timeout');
    }
  }, 5000);

  ws.on('message', async (data) => {
    // Parse JSON envelope.
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      sendError(ws, 'bad_json');
      return;
    }

    // Validate against the shared schema. Anything that doesn't match is
    // dropped — protects every downstream handler from malformed/malicious
    // input without per-handler typeof checks.
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendError(ws, 'bad_message');
      return;
    }
    const msg = parsed.data;

    if (!player) {
      // Pre-auth: only 'auth' is accepted.
      if (msg.type !== 'auth') {
        sendError(ws, 'expected_auth');
        ws.close(4002, 'expected_auth');
        return;
      }

      // Reject incompatible clients with a clear reason.
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        sendError(ws, `protocol_mismatch:${PROTOCOL_VERSION}`);
        ws.close(4005, 'protocol_mismatch');
        return;
      }

      const verified = verifyJoinToken(msg.token, env.joinTokenSecret);
      if (!verified.ok) {
        sendError(ws, `auth_${verified.reason}`);
        ws.close(4003, 'auth_failed');
        return;
      }

      const { accountId, characterId, displayName, serverId: tokenServerId } =
        verified.payload;

      // Sandbox connections never touch the live game registry.
      // The token's `sandbox` flag is the only thing that switches
      // the path; signing key + exp are verified the same way.
      if (verified.payload.sandbox) {
        clearTimeout(authTimer);
        // Reuse the auth player object so the close handler can
        // detect "we have a connected user." The fields are mostly
        // placeholders — sandbox uses its own SceneConnection.
        player = {
          characterId,
          accountId,
          displayName,
          x: 0,
          y: 0,
          hp: 100,
          maxHp: 100,
          stamina: 100,
          maxStamina: 100,
          shield: 0,
          maxShield: 0,
          alive: true,
        };
        sandbox = new SandboxWorld(ws, characterId, displayName);
        sandbox.start();
        console.log(
          `[ws] ${displayName} (${characterId}) connected to editor sandbox`,
        );
        return;
      }

      // Load the persisted character so re-joins resume where they were.
      const { data: characterRow, error } = await supabase
        .from('characters')
        .select('pos_x, pos_y, inventory')
        .eq('id', characterId)
        .single();

      if (error || !characterRow) {
        sendError(ws, 'character_not_found');
        ws.close(4004, 'character_not_found');
        return;
      }

      clearTimeout(authTimer);
      serverId = tokenServerId;
      player = {
        characterId,
        accountId,
        displayName,
        x: characterRow.pos_x ?? 0,
        y: characterRow.pos_y ?? 0,
        hp: 100,
        maxHp: 100,
        stamina: 100,
        maxStamina: 100,
        shield: 0,
        maxShield: 0,
        alive: true,
      };

      const loaded = parseInventoryJson(characterRow.inventory);
      // Reorder so the world hydrates before we pick the starter
      // loadout — that way playtest servers can hand out the bigger
      // debug bag without re-querying the row.
      const world = await registry.getOrCreate(serverId);
      // Playtest mode is treated as a sandbox: every join rebuilds
      // the debug loadout regardless of what's stored. Means tweaks
      // to buildPlaytest{Inventory,Equipment} take effect on the
      // first reconnect, which is what testers want. Persistence
      // for playtest characters lives within a single session.
      const inventory = world.isPlaytest()
        ? buildPlaytestInventory()
        : (loaded?.inventory ?? buildStarterInventory());
      const equipment = world.isPlaytest()
        ? buildPlaytestEquipment()
        : (loaded?.equipment ?? emptyEquipment());
      world.add(ws, player, inventory, equipment);
      if (loaded?.hotbarSelection !== undefined) {
        world.handleSelectHotbar(player.characterId, loaded.hotbarSelection);
      }

      // Stamp last_seen_at + start a heartbeat. The Next.js join route
      // counts characters with last_seen_at in the past 60s as
      // "occupying a slot"; without this heartbeat, a character that
      // joined an hour ago and never disconnected would appear idle.
      void touchLastSeen(characterId);
      heartbeatTimer = setInterval(
        () => touchLastSeen(characterId),
        30_000
      );

      console.log(
        `[ws] ${displayName} (${characterId}) joined server ${serverId} (world size: ${world.playerCount})`
      );
      return;
    }

    // Post-auth: route by message type. Zod has already guaranteed shape +
    // finite numbers; the room handlers do their own domain clamps.
    if (msg.type === 'auth') {
      sendError(ws, 'already_authed');
      return;
    }
    if (sandbox) {
      sandbox.handleMessage(msg);
      return;
    }
    // Sandbox-only messages on a live-game connection are silently
    // ignored — they have no meaning here.
    if (
      msg.type === 'sandbox_spawn_enemy' ||
      msg.type === 'sandbox_clear' ||
      msg.type === 'sandbox_set_loadout' ||
      msg.type === 'sandbox_regen_floor' ||
      msg.type === 'sandbox_stamp_room'
    ) {
      return;
    }
    const world = serverId ? registry.get(serverId) : undefined;
    if (!world) return;
    const handler = MESSAGE_HANDLERS[msg.type] as
      | ((w: World, cid: string, m: ClientMessage) => void)
      | undefined;
    if (handler) handler(world, player.characterId, msg);
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sandbox) {
      sandbox.destroy();
      sandbox = null;
      if (player) {
        console.log(
          `[ws] ${player.displayName} (${player.characterId}) sandbox closed`,
        );
      }
      return;
    }
    if (player && serverId) {
      const world = registry.get(serverId);
      world?.remove(player.characterId, ws);
      // Push last_seen_at back into the past so the next join route
      // call sees this seat as freed without waiting the full 60s
      // window. Best-effort; silent on failure.
      void clearLastSeen(player.characterId);
      console.log(
        `[ws] ${player.displayName} (${player.characterId}) left server ${serverId}`
      );
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] socket error:', err.message);
  });
});

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState !== ws.OPEN) return;
  const msg: ServerMessage = { type: 'error', message };
  ws.send(JSON.stringify(msg));
}

// Heartbeat: stamp characters.last_seen_at so the join route's
// active-occupancy check sees this slot as live. Best-effort —
// silent on error since a transient DB blip shouldn't kick the player.
async function touchLastSeen(characterId: string): Promise<void> {
  const { error } = await supabase
    .from('characters')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', characterId);
  if (error) {
    console.warn('[ws] touchLastSeen failed:', error.message);
  }
}

// On clean disconnect, push last_seen_at into the past so the next
// join route call frees the slot immediately rather than waiting the
// full 60s grace window.
async function clearLastSeen(characterId: string): Promise<void> {
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  await supabase
    .from('characters')
    .update({ last_seen_at: past })
    .eq('id', characterId);
}

// Inventory loader supporting the historical schema versions:
//   1 — { schema:1, starter:true, notes:string }: legacy stub from the
//       Next.js join route. Treated as "use starter loadout".
//   2 — { schema:2, parts: CarriedPart[] }: pre-slot inventory. Convert each
//       part into a 'part' slot.
//   3 — { schema:3, slots, hotbarSelection }: slot inventory pre-equipment.
//   4 — { schema:4, slots, equipment, hotbarSelection }: current.
// Anything unrecognised returns null and the caller falls back to the
// starter loadout.
// Sprint C migration: pre-Sprint C saves stored attachments as
// `{ kind: 'attachment'; defId; count }` (stackable) and weapon
// pieces/mods as plain `{ id }` references. Walk the persisted
// inventory and convert in-place so existing characters keep
// their gear after the schema flip. Each old stack of N expands
// into N separate AttachmentInstance slots, each rolled fresh
// (consistent with how new content drops/crafts behave).
function migrateLegacyAttachmentSlots(inv: Inventory): Inventory {
  // Length-preserving migration: legacy attachment stacks
  // ({kind:'attachment', defId, count:N}) need to expand into N
  // separate AttachmentInstance slots, but we can't grow the
  // inventory beyond its original size (doing so blows past the
  // slotIndex Zod cap and leaves the bag oversized after the
  // cargo-grid resize loop). Strategy:
  //   1. Walk every slot. Mutate weapon piece/mod refs in place
  //      (no length impact).
  //   2. For a legacy attachment stack of N: replace the original
  //      slot with the first new instance, queue the remaining
  //      N-1 instances for placement.
  //   3. After the walk, place queued instances into existing
  //      empty slots in order. Drop overflow rather than grow.
  // Pre-Sprint-C saves are the only callers that ever produce a
  // queue; everyone else makes the function a no-op.
  const out: Inventory = inv.map((s) => ({ ...s }));
  const queue: import('@dumrunner/shared').AttachmentInstance[] = [];

  for (let i = 0; i < out.length; i++) {
    const slot = out[i];
    const s = slot as unknown as {
      kind?: string;
      defId?: string;
      count?: number;
      instance?: unknown;
      weapon?: { pieces?: Record<string, unknown>; mods?: unknown[] };
    };
    if (s.kind === 'attachment' && s.instance === undefined && s.defId) {
      const count = Math.max(1, Number(s.count ?? 1));
      const defId = s.defId;
      out[i] = {
        kind: 'attachment',
        instance: rollAttachmentInstance(defId, 'Mk1'),
      };
      for (let j = 1; j < count; j++) {
        queue.push(rollAttachmentInstance(defId, 'Mk1'));
      }
      continue;
    }
    if (s.kind === 'weapon' && s.weapon) {
      const pieces = s.weapon.pieces ?? {};
      for (const k of Object.keys(pieces)) {
        const v = pieces[k] as unknown;
        if (v && typeof v === 'object') {
          const obj = v as { id?: string; defId?: string; rolls?: unknown };
          if (obj.id && !obj.defId) {
            (pieces as Record<string, unknown>)[k] = rollAttachmentInstance(
              obj.id,
              'Mk1'
            );
          }
        }
      }
      if (Array.isArray(s.weapon.mods)) {
        s.weapon.mods = s.weapon.mods.map((m) => {
          const obj = m as { id?: string; defId?: string };
          if (obj.id && !obj.defId) return rollAttachmentInstance(obj.id, 'Mk1');
          return m;
        });
      }
    }
  }

  // Place queued instances into existing empty slots; drop
  // overflow. Logging the loss isn't critical for the alpha —
  // this path only fires for ancient saves anyway.
  for (const inst of queue) {
    let placed = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].kind === 'empty') {
        out[i] = { kind: 'attachment', instance: inst };
        placed = true;
        break;
      }
    }
    if (!placed) break;
  }
  return out;
}

// Sprint C migration for equipment.appliedAttachments. Was string[]
// of defIds; now AttachmentInstance[]. Mutates the equipment in
// place — reads it through `unknown` so the new type doesn't fight
// the migration.
function migrateLegacyEquipmentAttachments(equipment: Equipment): void {
  for (const slotKey of Object.keys(equipment) as Array<keyof Equipment>) {
    const part = equipment[slotKey];
    if (!part) continue;
    const arr = part.appliedAttachments as unknown;
    if (!Array.isArray(arr)) continue;
    const out: unknown[] = [];
    for (const entry of arr) {
      if (typeof entry === 'string') {
        out.push(rollAttachmentInstance(entry, 'Mk1'));
      } else {
        out.push(entry);
      }
    }
    part.appliedAttachments = out as typeof part.appliedAttachments;
  }
}

function parseInventoryJson(
  raw: unknown
): {
  inventory: Inventory;
  hotbarSelection: number;
  equipment?: Equipment;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    schema?: unknown;
    slots?: unknown;
    parts?: unknown;
    equipment?: unknown;
    hotbarSelection?: unknown;
  };
  if (obj.schema === 4) {
    if (!Array.isArray(obj.slots)) return null;
    const sel = typeof obj.hotbarSelection === 'number' ? obj.hotbarSelection : 0;
    const equipment =
      obj.equipment && typeof obj.equipment === 'object'
        ? (obj.equipment as Equipment)
        : undefined;
    const inventory = migrateLegacyAttachmentSlots(obj.slots as Inventory);
    if (equipment) migrateLegacyEquipmentAttachments(equipment);
    return { inventory, hotbarSelection: sel, equipment };
  }
  if (obj.schema === 3) {
    if (!Array.isArray(obj.slots)) return null;
    const sel = typeof obj.hotbarSelection === 'number' ? obj.hotbarSelection : 0;
    return { inventory: obj.slots as Inventory, hotbarSelection: sel };
  }
  if (obj.schema === 2) {
    if (!Array.isArray(obj.parts)) return null;
    const inv = emptyInventory();
    for (const p of obj.parts as Array<unknown>) {
      invAddPart(inv, p as never);
    }
    return { inventory: inv, hotbarSelection: 0 };
  }
  return null;
}
