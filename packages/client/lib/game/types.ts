// Public types every renderer host implements / consumes. Extracted
// from the retired pixi.ts. Pure types — no Pixi imports, no runtime
// state.

import type {
  BuildingKind,
  BuildingState,
  CorpseState,
  EnemyState,
  LootState,
  PlaceableBuildingKind,
  Player,
  ProjectileState,
  PropState,
  SceneLayout,
  WeaponKind,
} from '@dumrunner/shared';
import type { MinimapSnapshot } from './minimap';

export type GameInit = {
  // Initial scene this renderer is mounted into. Used as the cache
  // key for per-scene state (e.g. minimap fog) so re-entering a
  // previously-visited scene can restore prior data instead of
  // wiping it on every transition.
  sceneId: string;
  // Live-game server id — namespaces persisted per-client state
  // (minimap fog) so saves from different servers don't collide.
  // Absent (sandbox / editor previews) disables persistence.
  serverId?: string;
  self: Player;
  others: Player[];
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  loot: LootState[];
  corpses: CorpseState[];
  buildings: BuildingState[];
  props: PropState[];
  layout: SceneLayout | null;
  sendInput: (
    moveX: number,
    moveY: number,
    sprint: boolean,
    jump?: boolean,
    crouch?: boolean,
  ) => void;
  sendFire: (dirX: number, dirY: number, dirZ?: number) => void;
  sendBuild: (
    kind: PlaceableBuildingKind,
    tileX: number,
    tileY: number,
  ) => void;
  sendDemolish: (buildingId: string) => void;
  onNearInteractableChanged: (
    near: { id: string; label: string } | null,
  ) => void;
  onNearWorkstationsChanged: (state: {
    all: BuildingKind[];
    nearest: BuildingKind | null;
    nearestDoorId: string | null;
    nearestDoorKind: 'door' | 'wall_door' | null;
    nearestDoorOpen: boolean;
    nearestChestId: string | null;
    nearestContainerId: string | null;
    weaponBenchTier: number;
    weaponBenches: { id: string; tier: number }[];
  }) => void;
  getEnemyTexture?: (kind: string) => string | null;
  palette?: {
    floor?: string;
    wallTop?: string;
    wallFront?: string;
  };
};

export type SceneState = {
  sceneId: string;
  self: Player;
  players: Player[];
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  loot: LootState[];
  corpses: CorpseState[];
  buildings: BuildingState[];
  props: PropState[];
  layout: SceneLayout | null;
};

export type GameHandle = {
  upsertPlayer(p: Player): void;
  removePlayer(characterId: string): void;
  movePlayer(
    characterId: string,
    x: number,
    y: number,
    z?: number,
    crouching?: boolean,
    // Server-authoritative grounded/airborne bit from the
    // player_moved broadcast. Absent ⇒ grounded.
    airborne?: boolean,
  ): void;
  // True while the local player is mid-jump / falling. Consumers
  // (footstep SFX gating) treat absence of data as grounded.
  isSelfAirborne(): boolean;
  // Mirror of the local player's stamina — gates client-side sprint
  // prediction so an empty tank doesn't predict 1.6× speed the
  // server won't grant (which reads as rubber-banding while
  // shift-held on empty).
  setSelfStamina(stamina: number): void;
  setPlayerHp(
    characterId: string,
    hp: number,
    maxHp: number,
    shield?: number,
    maxShield?: number,
  ): void;
  setPlayerDead(characterId: string): void;
  respawnPlayer(
    characterId: string,
    x: number,
    y: number,
    hp: number,
    maxHp: number,
    stamina?: number,
    maxStamina?: number,
    shield?: number,
    maxShield?: number,
  ): void;
  showWeaponSwung(
    characterId: string,
    weaponId: string,
    dirX: number,
    dirY: number,
  ): void;
  upsertEnemy(e: EnemyState): void;
  setEnemyPosition(id: string, x: number, y: number): void;
  setEnemyHp(id: string, hp: number, maxHp: number): void;
  removeEnemy(id: string): void;
  spawnProjectile(p: ProjectileState): void;
  despawnProjectile(
    id: string,
    reason?: 'hit' | 'expired',
    x?: number,
    y?: number,
    z?: number,
    // Server-classified impact surface — 'flesh' sprays blood,
    // 'surface' sprays sparks. Absent on 'expired' despawns and
    // from pre-48 servers; renderer falls back to sparks.
    hitKind?: 'flesh' | 'surface',
  ): void;
  spawnLoot(l: LootState): void;
  despawnLoot(id: string): void;
  spawnCorpse(c: CorpseState): void;
  removeCorpse(id: string): void;
  spawnBuilding(b: BuildingState): void;
  setBuildingHp(id: string, hp: number, maxHp: number): void;
  removeBuilding(id: string): void;
  spawnProp(p: PropState): void;
  setPropHp(id: string, hp: number, maxHp: number): void;
  removeProp(id: string): void;
  changeProp(p: PropState): void;
  setBuildMode(kind: PlaceableBuildingKind | null): void;
  setBuildRadiusBonus(tiles: number): void;
  setEquippedWeapon(weaponId: WeaponKind | null): void;
  notifyReloadStarted(durationMs: number): void;
  // Server-confirmed damage on an enemy by the local player —
  // drives the crosshair hitmarker (kill=true adds the red X).
  showHitConfirm(kill: boolean): void;
  // World position the local player was just damaged from — drives
  // the directional damage arc around the crosshair.
  showDamageFrom(x: number, y: number): void;
  // Human-readable label for a live loot entry (call BEFORE
  // despawning it) — feeds the pickup toast feed.
  describeLoot(id: string): string | null;
  setHordeActive(active: boolean): void;
  // Current world cycle from the world_clock / horde broadcasts.
  // The renderer uses it to tag persisted minimap fog and to
  // invalidate fog explored in a previous cycle (dungeon floors
  // regenerate on the cycle bump).
  setWorldCycle(cycle: number): void;
  swapScene(state: SceneState): void;
  currentSceneState(): SceneState;
  nearbyPlayers(radiusPx: number): {
    characterId: string;
    displayName: string;
  }[];
  getMinimapSnapshot(): MinimapSnapshot;
  getSelfPosition(): { x: number; y: number } | null;
  applyLookDelta(dxPx: number, dyPx: number): void;
  setMobileMove(forward: number, right: number, sprint: boolean): void;
  setFireHeld(held: boolean): void;
  requestFire(): void;
  destroy(): void;
};

// Renderer factory signature. fps.v2's runFpsV2Game matches this.
export type RunGame = (host: HTMLElement, init: GameInit) => GameHandle;
