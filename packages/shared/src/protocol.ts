// Wire protocol between the browser client and the websocket game server.
// Both sides must agree on these types.
//
// Client → Server messages are validated at runtime via Zod (see schemas at
// the bottom of this file). Server → Client messages stay TypeScript-only;
// the client trusts the server.

import { z } from 'zod';
import type { Equipment, Inventory, MaterialKind } from './inventory';

// ---------- Parts (loot / inventory) ----------
// Subset of the GDD part ontology — enough to flow loot from kill to inventory.
// Stats and affix details land here once crafting/equipping comes online.

export type PartSlot =
  | 'barrel'
  | 'frame'
  | 'grip'
  | 'magazine'
  | 'weapon_mod'
  | 'chassis'
  | 'plating'
  | 'life_support'
  | 'utility_mod'
  | 'cargo_grid';

export type PartTier = 'Mk1' | 'Mk2' | 'Mk3' | 'Mk4' | 'Alien';

export type WeaponClass =
  | 'pistol'
  | 'smg'
  | 'rifle'
  | 'shotgun'
  | 'sniper'
  | 'heavy'
  | 'energy';

// One rolled affix on a CarriedPart. `id` matches an entry in AFFIX_DEFS;
// `value` is the rolled magnitude (already tier-scaled). Display text
// comes from AFFIX_DEFS[id].label(value).
export type Affix = {
  id: string;
  value: number;
};

export type CarriedPart = {
  id: string;
  slot: PartSlot;
  tier: PartTier;
  // Class-locked weapon parts (barrel/frame/grip/magazine) carry a class.
  // Universal slots (weapon_mod, all suit slots) leave this null.
  weaponClass: WeaponClass | null;
  // Number of randomly rolled affix slots. Mirrors affixes.length for
  // legacy parts that pre-date the real-rolls system.
  affixCount: number;
  // Real rolled affixes. Optional so DB-loaded inventories from before
  // affix rolling shipped don't fail to deserialize; treated as [] when
  // missing.
  affixes?: Affix[];
};

// Loot on the ground. Discriminated by `content.kind`:
//   - 'part'     : a CarriedPart (legacy enemy-drop behaviour).
//   - 'material' : a stack of a MaterialKind (new: scavenged components).
// New variants slot in here; the client renders by `content.kind`.
export type LootContent =
  | { kind: 'part'; part: CarriedPart }
  | { kind: 'material'; materialId: MaterialKind; count: number };

export type LootState = {
  id: string;
  content: LootContent;
  x: number;
  y: number;
};

// A corpse is what's left when a player dies in a scene. Holds the full
// inventory the player was carrying. Anyone can recover it (including the
// owner) via proximity pickup; the corpse despawns when looted, or at
// perihelion (cycle reset) if untouched.
export type CorpseState = {
  id: string;
  ownerCharacterId: string;
  ownerDisplayName: string;
  x: number;
  y: number;
  // Snapshot of the player's slot-based inventory at time of death. Looter
  // gets all non-empty slots transferred into their own inventory.
  inventory: Inventory;
};

// Static layout for a scene. Surface scenes have no layout (open world,
// camera follows player). Dungeon floor scenes ship a list of walkable
// rectangles (rooms + corridors); anything outside those AABBs is wall.
//
// Players can only stand inside walkable rects — the server enforces this
// via collision; the client uses the same data to render the floor.
export type Rect = { x: number; y: number; w: number; h: number };

export type InteractableKind = 'stairs_down' | 'extract_pad';

export type Interactable = {
  id: string;
  kind: InteractableKind;
  x: number;
  y: number;
  // Visible label shown when the player is in range.
  label: string;
};

// ---------- Buildings (player-placed structures) ----------
// Defenses (wall, turret), crafting stations (workbench, forge,
// electronics_bench), and — later — storage / artifact uplink. All share the
// BuildingState shape and tile placement model.
export type BuildingKind =
  | 'wall'
  | 'turret'
  | 'workbench'
  | 'forge'
  | 'electronics_bench'
  | 'artifact_uplink'
  | 'power_link';

// Subset of BuildingKind that acts as a crafting workstation. Recipes can
// require the player to be in range of one of these to craft.
export type WorkstationKind = 'workbench' | 'forge' | 'electronics_bench';
export const WORKSTATION_KINDS: WorkstationKind[] = [
  'workbench',
  'forge',
  'electronics_bench',
];
export function isWorkstationKind(k: BuildingKind): k is WorkstationKind {
  return k === 'workbench' || k === 'forge' || k === 'electronics_bench';
}

export type BuildingState = {
  id: string;
  kind: BuildingKind;
  // Tile coordinates. Pixel position = tile * sceneLayout.tileSize.
  // Buildings always occupy whole tiles.
  tileX: number;
  tileY: number;
  // Footprint in tiles. 1×1 for walls; multi-tile structures will use larger.
  width: number;
  height: number;
  hp: number;
  maxHp: number;
};

export type SceneLayout = {
  worldBounds: Rect;
  // Walkables = rooms ∪ corridors. Player position must lie inside ≥ 1.
  walkables: Rect[];
  // Just the rooms (subset of walkables). Used for placing enemies / props
  // that should sit in a room rather than a corridor.
  rooms: Rect[];
  // Where new arrivals spawn. Used for transition target positioning.
  spawn: { x: number; y: number };
  // Stairs / extract pads as named entities the client can render and the
  // server can detect proximity against.
  interactables: Interactable[];
  // Pixel size of one grid tile. Walkable rect dimensions are integer
  // multiples of this. Surface ships 0 (open scene, no grid).
  tileSize: number;
};

export type Player = {
  characterId: string;
  accountId: string;
  displayName: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  shield: number;
  maxShield: number;
  alive: boolean;
};

// Enemy `kind` is the template id from the server-side template library.
// The client uses it to pick a visual; new templates can be added without a
// protocol bump.
export type EnemyKind = string;

export type EnemyState = {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
};

export type ProjectileOwnerKind = 'player' | 'enemy';

export type ProjectileState = {
  id: string;
  ownerCharacterId: string;       // characterId for player-owned, enemy id for enemy-owned
  ownerKind: ProjectileOwnerKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // Optional client-render hint (RGB int). Hardcoded white if omitted.
  color?: number;
};

// ---------- Client → Server ----------
//
// Schemas are the source of truth. ClientMessage is derived from the
// discriminated union below so adding a new message type only requires
// editing one place.

const finiteNumber = z.number().finite();

export const AuthMsgSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1).max(4096),
  protocolVersion: z.number().int(),
});

// Input intent. Replaces absolute-position 'move' messages: client now sends
// its desired movement vector (-1..1 per axis) and the server runs the actual
// simulation. Server clamps + normalises.
export const InputMsgSchema = z.object({
  type: z.literal('input'),
  moveX: finiteNumber,
  moveY: finiteNumber,
  sprint: z.boolean(),
});

export const FireMsgSchema = z.object({
  type: z.literal('fire'),
  dirX: finiteNumber,
  dirY: finiteNumber,
});

const BuildingKindSchema = z.enum([
  'wall',
  'turret',
  'workbench',
  'forge',
  'electronics_bench',
  'artifact_uplink',
  'power_link',
]);

export const BuildRequestMsgSchema = z.object({
  type: z.literal('build_request'),
  kind: BuildingKindSchema,
  tileX: z.number().int(),
  tileY: z.number().int(),
});

export const DemolishRequestMsgSchema = z.object({
  type: z.literal('demolish_request'),
  buildingId: z.string().min(1).max(64),
});

export const SelectHotbarMsgSchema = z.object({
  type: z.literal('select_hotbar'),
  slot: z.number().int().min(0).max(8),
});

const slotIndex = z.number().int().min(0).max(35);

export const InventorySwapMsgSchema = z.object({
  type: z.literal('inventory_swap'),
  from: slotIndex,
  to: slotIndex,
});

export const InventoryDiscardMsgSchema = z.object({
  type: z.literal('inventory_discard'),
  slot: slotIndex,
  all: z.boolean(),
});

export const InventorySortMsgSchema = z.object({
  type: z.literal('inventory_sort'),
});

const SuitSlotSchema = z.enum([
  'chassis',
  'plating',
  'life_support',
  'utility_mod',
  'cargo_grid',
]);

export const EquipRequestMsgSchema = z.object({
  type: z.literal('equip_request'),
  fromInventoryIdx: slotIndex,
  suitSlot: SuitSlotSchema,
});

export const UnequipRequestMsgSchema = z.object({
  type: z.literal('unequip_request'),
  suitSlot: SuitSlotSchema,
  toInventoryIdx: slotIndex.optional(),
});

export const InteractMsgSchema = z.object({
  type: z.literal('interact'),
  interactableId: z.string().min(1).max(64),
});

export const CraftRequestMsgSchema = z.object({
  type: z.literal('craft_request'),
  recipeId: z.string().min(1).max(64),
});

export const PurchaseBlueprintMsgSchema = z.object({
  type: z.literal('purchase_blueprint'),
  blueprintId: z.string().min(1).max(64),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  AuthMsgSchema,
  InputMsgSchema,
  FireMsgSchema,
  BuildRequestMsgSchema,
  DemolishRequestMsgSchema,
  SelectHotbarMsgSchema,
  InventorySwapMsgSchema,
  InventoryDiscardMsgSchema,
  InventorySortMsgSchema,
  EquipRequestMsgSchema,
  UnequipRequestMsgSchema,
  InteractMsgSchema,
  CraftRequestMsgSchema,
  PurchaseBlueprintMsgSchema,
]);


export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- Server → Client ----------
export type ServerMessage =
  | {
      type: 'welcome';
      sceneId: string;
      self: Player;
      players: Player[];
      enemies: EnemyState[];
      projectiles: ProjectileState[];
      loot: LootState[];
      corpses: CorpseState[];
      buildings: BuildingState[];
      inventory: Inventory;
      equipment: Equipment;
      hotbarSelection: number;
      layout: SceneLayout | null;
      // Blueprint ids the player currently has access to (per-cycle +
      // persistent, merged). Used by the client to enable/disable recipes.
      knownBlueprints: string[];
    }
  | {
      // Sent when the player transitions between scenes (stairs, extract pad,
      // death respawn). Contains the full state of the new scene; client
      // drops anything from the previous scene and resyncs. Equipment is
      // preserved across scene transitions so we re-include it.
      type: 'scene_changed';
      sceneId: string;
      self: Player;
      players: Player[];
      enemies: EnemyState[];
      projectiles: ProjectileState[];
      loot: LootState[];
      corpses: CorpseState[];
      buildings: BuildingState[];
      equipment: Equipment;
      layout: SceneLayout | null;
    }
  | { type: 'player_joined'; player: Player }
  | { type: 'player_left'; characterId: string }
  | { type: 'player_moved'; characterId: string; x: number; y: number }
  | { type: 'player_damaged'; characterId: string; hp: number; maxHp: number; shield: number; maxShield: number }
  | { type: 'player_stamina'; stamina: number; maxStamina: number }
  | { type: 'player_died'; characterId: string }
  | { type: 'player_respawned'; characterId: string; x: number; y: number; hp: number; maxHp: number; stamina: number; maxStamina: number; shield: number; maxShield: number }
  | { type: 'enemy_spawned'; enemy: EnemyState }
  | { type: 'enemy_state'; id: string; x: number; y: number }
  | { type: 'enemy_damaged'; id: string; hp: number; maxHp: number }
  | { type: 'enemy_killed'; id: string }
  | { type: 'projectile_spawned'; projectile: ProjectileState }
  | { type: 'projectile_despawned'; id: string; reason: 'hit' | 'expired' }
  | { type: 'loot_spawned'; loot: LootState }
  | { type: 'loot_despawned'; id: string; reason: 'picked_up' | 'expired' }
  | { type: 'corpse_spawned'; corpse: CorpseState }
  | { type: 'corpse_looted'; id: string; byCharacterId: string }
  | { type: 'building_placed'; building: BuildingState }
  | { type: 'building_damaged'; id: string; hp: number; maxHp: number }
  | { type: 'building_destroyed'; id: string }
  | {
      // Periodic world-clock broadcast. cycle = current cycle index
      // (1-based). secondsToPerihelion = real seconds until the next horde
      // fires; 0 while the horde is active. hordeActive lets the client
      // switch the HUD into "siege mode".
      type: 'world_clock';
      cycle: number;
      secondsToPerihelion: number;
      hordeActive: boolean;
    }
  | {
      // Sent at the moment perihelion fires. Client can play a stinger /
      // colour shift / camera shake.
      type: 'horde_started';
      cycle: number;
      durationMs: number;
    }
  | {
      // Sent when the horde ends (timer expired or last enemy died).
      // Cycle has already been incremented server-side by this point.
      type: 'horde_ended';
      newCycle: number;
    }
  | {
      // Melee weapon swing event — broadcast to all in the scene so they
      // can render the slash. Server has already applied damage.
      type: 'weapon_swung';
      characterId: string;
      weaponId: 'knife';
      dirX: number;
      dirY: number;
    }
  | { type: 'inventory_changed'; inventory: Inventory }
  | { type: 'equipment_changed'; equipment: Equipment }
  | { type: 'hotbar_selection'; slot: number }
  | {
      // Full snapshot of the player's currently-known blueprints (per-cycle
      // + persistent, merged). Sent on grant, on cycle-reset wipe, and any
      // time the set changes. Client replaces its local Set wholesale.
      type: 'blueprints_changed';
      knownBlueprints: string[];
    }
  | { type: 'error'; message: string };

// Bump on any wire-incompatible change. The auth handshake includes this
// number; servers reject mismatched clients with a clear error.
export const PROTOCOL_VERSION = 20;
