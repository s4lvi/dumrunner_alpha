import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  emptyEquipment,
  emptyInventory,
  addPart as invAddPart,
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

      console.log(
        `[ws] ${displayName} (${characterId}) joined server ${serverId} (world size: ${world.playerCount})`
      );
      return;
    }

    // Post-auth: route by message type. Zod has already guaranteed shape +
    // finite numbers; the room handlers do their own domain clamps.
    switch (msg.type) {
      case 'input': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleInput(player.characterId, msg.moveX, msg.moveY, msg.sprint);
        break;
      }
      case 'fire': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleFire(player.characterId, msg.dirX, msg.dirY);
        break;
      }
      case 'build_request': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleBuildRequest(player.characterId, msg.kind, msg.tileX, msg.tileY);
        break;
      }
      case 'demolish_request': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleDemolishRequest(player.characterId, msg.buildingId);
        break;
      }
      case 'select_hotbar': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleSelectHotbar(player.characterId, msg.slot);
        break;
      }
      case 'inventory_swap': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleInventorySwap(player.characterId, msg.from, msg.to);
        break;
      }
      case 'inventory_discard': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleInventoryDiscard(player.characterId, msg.slot, msg.all);
        break;
      }
      case 'inventory_sort': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleInventorySort(player.characterId);
        break;
      }
      case 'equip_request': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleEquipRequest(
          player.characterId,
          msg.fromInventoryIdx,
          msg.suitSlot
        );
        break;
      }
      case 'unequip_request': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleUnequipRequest(
          player.characterId,
          msg.suitSlot,
          msg.toInventoryIdx
        );
        break;
      }
      case 'interact': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleInteract(player.characterId, msg.interactableId);
        break;
      }
      case 'craft_request': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleCraftRequest(player.characterId, msg.recipeId);
        break;
      }
      case 'purchase_blueprint': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handlePurchaseBlueprint(player.characterId, msg.blueprintId);
        break;
      }
      case 'pickup_station_outputs': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handlePickupStationOutputs(player.characterId, msg.kind);
        break;
      }
      case 'open_door': {
        const world = serverId ? registry.get(serverId) : undefined;
        world?.handleOpenDoor(player.characterId, msg.buildingId);
        break;
      }
      case 'auth':
        sendError(ws, 'already_authed');
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (player && serverId) {
      const world = registry.get(serverId);
      world?.remove(player.characterId, ws);
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
