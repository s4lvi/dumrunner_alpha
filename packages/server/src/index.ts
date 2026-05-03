import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  emptyEquipment,
  emptyInventory,
  addPart as invAddPart,
  type ClientMessage,
  type Equipment,
  type Inventory,
  type ServerMessage,
  type Player,
} from '@dumrunner/shared';
import { verifyJoinToken } from '@dumrunner/shared/token';
import { buildStarterInventory } from './starter.js';
import { env } from './env.js';
import { supabase } from './supabase.js';
import { registry } from './registry.js';
import type { World } from './world.js';

// Typed dispatch map for inbound client messages. Each key is a
// ClientMessage['type']; each value handles ONLY that type (TS narrows
// `m` via the Extract<> in the value signature). Adding a new message
// type is one entry here plus the protocol schema entry. Keeps the
// route handler at the bottom of the file three lines long.
type ClientMessageHandlers = {
  [K in Exclude<ClientMessage['type'], 'auth'>]: (
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
  use_consumable: (w, c, m) => w.handleUseConsumable(c, m.slot),
};

const wss = new WebSocketServer({ port: env.port, host: env.host });

wss.on('listening', () => {
  const addr = wss.address();
  console.log(`[ws] DÛM RUNNER game server listening on`, addr);
});

wss.on('error', (err) => {
  console.error('[ws] server error:', err);
});

wss.on('connection', (ws: WebSocket) => {
  // Each connection starts unauthenticated. The first message must be {type:'auth'}
  // with a valid signed JoinToken. Anything else is a protocol violation.
  let player: Player | null = null;
  let serverId: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
      const inventory = loaded?.inventory ?? buildStarterInventory();
      const equipment = loaded?.equipment ?? emptyEquipment();
      const world = await registry.getOrCreate(serverId);
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
    return { inventory: obj.slots as Inventory, hotbarSelection: sel, equipment };
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
