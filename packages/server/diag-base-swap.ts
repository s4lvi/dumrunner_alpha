// Base-layout SWAP diagnostic (base-layouts P4). Drives the REAL
// Scene.applyBaseLayoutSwap transaction on a live surface Scene and
// asserts the keep / re-seat / refund / Power-Link-transfer invariants
// from docs/base-layouts-plan.md "Swap flow at the Power Link", plus a
// persistence round-trip (snapshot → hydrate) after a swap.
//
//   A. build a base on the STARTER (4 workstations + 2 chests + 4
//      turrets on mounts + the Power Link);
//   B. swap to the BASTION (bigger pad / caps / mounts): everything
//      kept, turrets re-seated onto new mounts, Power Link same id/hp;
//   C. over-build the bastion, then swap back to the STARTER (smaller
//      caps / footprint / fewer mounts): over-cap + excess-mount
//      buildings refunded (land in inventory / chest / ground — nothing
//      destroyed), survivors kept, Power Link preserved, refunds exact;
//   D. persistence round-trip: snapshot the post-swap surface, hydrate
//      a fresh Scene on the same layout, assert buildings survive.
import { Scene, type SceneBindings, type SceneConnection } from './src/scene.js';
import {
  initBaseLayouts,
  getBaseLayout,
  STARTER_BASE_LAYOUT_ID,
} from './src/baseLayouts.js';
import {
  emptyInventory,
  addMaterial,
  addPlaceable,
  countMaterial,
  countPlaceable,
  type BaseLayoutDef,
  type SceneLayout,
  type InventorySlot,
} from '@dumrunner/shared';

await initBaseLayouts();

const BASTION_ID = 'base_bastion_mk1';
const STARTER = getBaseLayout(STARTER_BASE_LAYOUT_ID);
const BASTION = getBaseLayout(BASTION_ID);
if (!STARTER || !BASTION) {
  console.error(
    `FAIL — need both ${STARTER_BASE_LAYOUT_ID} and ${BASTION_ID} loaded`,
  );
  process.exit(1);
}

// Power Link world centre = tile (6,-1) centre → (208, -16), exactly
// the way world.ts surfaceLayout() places it. The clearing centres on
// (LINK_X, 0).
const LINK_X = (6 + 0.5) * 32;
const LINK_Y = (-1 + 0.5) * 32;

function surfaceLayout(def: BaseLayoutDef): SceneLayout {
  return {
    worldBounds: { x: -2000, y: -2000, w: 4000, h: 4000 },
    walkables: [],
    rooms: [],
    spawn: { x: 80, y: 0 },
    interactables: [
      { id: 'power_link', kind: 'stairs_down', x: LINK_X, y: LINK_Y, label: 'Power Link' },
    ],
    tileSize: 32,
    biome: 'default',
    terrain: {
      amplitude: 64,
      frequency: 1 / 384,
      octaves: 2,
      seed: 0x5e7117ed,
      clearing: { cx: LINK_X, cy: 0, radius: def.radius, apron: def.apron, padZ: def.padZ },
    },
    baseCapacity: def.capacity,
    turretMounts: def.turretMounts.map((m) => ({ x: LINK_X + m.dx, y: 0 + m.dy })),
  };
}

let conn: SceneConnection;
function makeConn(x: number, y: number): SceneConnection {
  return {
    ws: { readyState: 3, OPEN: 1, send: () => {} } as unknown as SceneConnection['ws'],
    characterId: 'diag', displayName: 'diag', alive: true,
    hp: 100, maxHp: 100, stamina: 100, maxStamina: 100, shield: 0, maxShield: 0,
    lastDamageAt: 0, x, y,
    inputX: 0, inputY: 0, inputAt: Date.now() + 1e9,
    inputSprint: false, inputJump: false, inputCrouch: false,
    z: 0, vz: 0, crouching: false, floorZ: 0, lastZSent: 0, lastCrouchSent: false,
    inventory: emptyInventory(),
    equipment: {} as SceneConnection['equipment'],
    hotbarSelection: 0, dirty: false, inventoryDirty: false,
    lastFireAt: 0, reloadingUntil: 0, reloadingSlot: -1,
    respawnAt: null, respawnImmunityUntil: 0, activeEffects: [],
    lastStaminaSentAt: 0, lastShieldSentAt: 0, lastStaminaSent: 100,
    lastShieldSent: 0, staminaRegenAt: 0,
    suitSpeedMult: 0, suitStaminaRegenBonus: 0, suitBuildRadiusBonus: 0,
    suitHeatResist: 0, suitColdResist: 0, suitRadiationResist: 0, suitToxicResist: 0,
    kills: 0, deaths: 0,
  };
}

const bindings: SceneBindings = {
  connection: () => conn,
  send: () => {}, onInteractable: () => {}, onPlayerRespawn: () => {},
  onPlayerDied: () => {}, onPowerLinkDestroyed: () => {},
  isPowerOnline: () => true, isPowered: () => false,
  onBuildingsChanged: () => {}, dropItemsOnDeath: () => false,
  onPlayerEquipmentChanged: () => {}, applyPlayerEffect: () => {},
  pvpEnabled: () => false, isPlaytest: () => false,
};

type B = { id: string; kind: string; tileX: number; tileY: number; mountIndex?: number; hp: number; output: InventorySlot[] };
const bMap = (s: Scene): Map<string, B> =>
  (s as unknown as { buildings: Map<string, B> }).buildings;
const callBuild = (s: Scene, k: string, tx: number, ty: number): void => {
  // Stand the player one tile away from the target so the
  // player-overlap check never rejects a build on the player's own
  // tile, while staying inside build range (radius 3.5 tiles).
  conn.x = (tx + 0.5) * 32 + 32;
  conn.y = (ty + 0.5) * 32;
  (s as unknown as { handleBuildRequest: (id: string, k: string, tx: number, ty: number) => void }).handleBuildRequest('diag', k, tx, ty);
};
const countKind = (s: Scene, k: string): number => {
  let n = 0;
  for (const b of bMap(s).values()) if (b.kind === k) n++;
  return n;
};
const groundSlots = (s: Scene): InventorySlot[] => {
  const out: InventorySlot[] = [];
  for (const l of (s as unknown as { loot: Map<string, { content: { kind: string; slot?: InventorySlot } }> }).loot.values()) {
    if (l.content.kind === 'slot' && l.content.slot) out.push(l.content.slot);
  }
  return out;
};
const groundPlaceable = (slots: InventorySlot[], k: string): number =>
  slots.filter((s) => s.kind === 'placeable' && (s as { buildingKind: string }).buildingKind === k)
    .reduce((n, s) => n + (s as { count: number }).count, 0);

let fail = 0;
function expect(label: string, cond: boolean, detail: string): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}: ${detail}`);
  if (!cond) fail++;
}

function placeTurretsOnMounts(scene: Scene, def: BaseLayoutDef, from: number, to: number): void {
  const mounts = def.turretMounts.map((m) => ({ x: LINK_X + m.dx, y: 0 + m.dy }));
  for (let i = from; i < to; i++) {
    const m = mounts[i];
    conn.x = m.x + Math.sign(LINK_X - m.x) * 64;
    conn.y = m.y + Math.sign(0 - m.y) * 64;
    callBuild(scene, 'turret', Math.floor(m.x / 32), Math.floor(m.y / 32));
  }
}

function main(): void {
  // ---- A. build on the STARTER ----
  const scene = new Scene('surface', 'surface', bindings, surfaceLayout(STARTER!));
  scene.addMember('diag');
  scene.ensurePowerLink(6, -1, 1, 1); // world.ts does this post-construction
  const linkBefore = scene.findBuildingByKind('power_link')!;
  const LINK_ID = linkBefore.id;
  const LINK_HP = linkBefore.hp;

  conn = makeConn(LINK_X, 0);
  const inv = conn.inventory;
  addPlaceable(inv, 'workbench', 20);
  addPlaceable(inv, 'storage_chest', 20);
  addPlaceable(inv, 'turret', 20);
  addPlaceable(inv, 'wall', 20);
  addMaterial(inv, 'alloy', 20);
  addMaterial(inv, 'circuit', 20);

  const ct = Math.round(LINK_X / 32);
  conn.x = LINK_X; conn.y = 0;
  for (let i = 0; i < STARTER!.capacity.workstations; i++) callBuild(scene, 'workbench', ct - 2 + i, 0);
  for (let i = 0; i < STARTER!.capacity.storage; i++) callBuild(scene, 'storage_chest', ct - 2 + i, 2);
  placeTurretsOnMounts(scene, STARTER!, 0, STARTER!.turretMounts.length);

  // Loot in chest #1 — exercises the chest-contents-conservation path.
  let firstChest: B | null = null;
  for (const b of bMap(scene).values()) if (b.kind === 'storage_chest') { firstChest = b; break; }
  if (firstChest) firstChest.output[0] = { kind: 'material', materialId: 'scrap', count: 9 };

  expect('A built starter base',
    countKind(scene, 'workbench') === 4 && countKind(scene, 'storage_chest') === 2 &&
    countKind(scene, 'turret') === 4 && countKind(scene, 'power_link') === 1,
    `wb=${countKind(scene, 'workbench')} chest=${countKind(scene, 'storage_chest')} turret=${countKind(scene, 'turret')}`);

  // ---- B. swap to the BASTION (bigger) — all kept, re-seated ----
  const okB = scene.applyBaseLayoutSwap(surfaceLayout(BASTION!), 'diag');
  expect('B swap to bastion kept all',
    okB && countKind(scene, 'workbench') === 4 && countKind(scene, 'storage_chest') === 2 && countKind(scene, 'turret') === 4,
    `ok=${okB} wb=${countKind(scene, 'workbench')} chest=${countKind(scene, 'storage_chest')} turret=${countKind(scene, 'turret')}`);
  const trMountsB = [...bMap(scene).values()].filter((b) => b.kind === 'turret').map((b) => b.mountIndex);
  expect('B turrets re-seated',
    new Set(trMountsB).size === 4 && trMountsB.every((m) => m !== undefined && (m as number) < BASTION!.turretMounts.length),
    `mounts=[${trMountsB.join(',')}]`);
  const linkB = scene.findBuildingByKind('power_link')!;
  expect('B power link transferred', linkB.id === LINK_ID && linkB.hp === LINK_HP,
    `id=${linkB.id}(want ${LINK_ID}) hp=${linkB.hp}(want ${LINK_HP})`);

  // Over-build the bastion (cap 6 ws / 4 storage / 8 mounts).
  conn.x = LINK_X; conn.y = 0;
  for (let i = 0; i < 2; i++) callBuild(scene, 'workbench', ct - 2 + i, -2);
  for (let i = 0; i < 2; i++) callBuild(scene, 'storage_chest', ct - 2 + i, 4);
  placeTurretsOnMounts(scene, BASTION!, 4, BASTION!.turretMounts.length);
  expect('B over-built bastion',
    countKind(scene, 'workbench') === 6 && countKind(scene, 'storage_chest') === 4 && countKind(scene, 'turret') === 8,
    `wb=${countKind(scene, 'workbench')} chest=${countKind(scene, 'storage_chest')} turret=${countKind(scene, 'turret')}`);

  const totalBefore = bMap(scene).size;
  const invWbBefore = countPlaceable(conn.inventory, 'workbench');
  const invChBefore = countPlaceable(conn.inventory, 'storage_chest');
  const invTrBefore = countPlaceable(conn.inventory, 'turret');

  // ---- C. swap BACK to the STARTER (smaller) — refund the excess ----
  const okC = scene.applyBaseLayoutSwap(surfaceLayout(STARTER!), 'diag');
  expect('C swap to starter caps survivors',
    okC && countKind(scene, 'workbench') === 4 && countKind(scene, 'storage_chest') === 2 && countKind(scene, 'turret') === 4,
    `ok=${okC} wb=${countKind(scene, 'workbench')} chest=${countKind(scene, 'storage_chest')} turret=${countKind(scene, 'turret')}`);
  const linkC = scene.findBuildingByKind('power_link')!;
  expect('C power link preserved', linkC.id === LINK_ID && linkC.hp === LINK_HP,
    `id=${linkC.id} hp=${linkC.hp}`);

  const gslots = groundSlots(scene);
  const refundedWb = countPlaceable(conn.inventory, 'workbench') - invWbBefore + groundPlaceable(gslots, 'workbench');
  const refundedCh = countPlaceable(conn.inventory, 'storage_chest') - invChBefore + groundPlaceable(gslots, 'storage_chest');
  const refundedTr = countPlaceable(conn.inventory, 'turret') - invTrBefore + groundPlaceable(gslots, 'turret');
  expect('C refunds conserved (nothing destroyed)',
    refundedWb === 2 && refundedCh === 2 && refundedTr === 4,
    `wb=${refundedWb}(want 2) chest=${refundedCh}(want 2) turret=${refundedTr}(want 4)`);
  expect('C building count', bMap(scene).size === totalBefore - 8,
    `now=${bMap(scene).size} was=${totalBefore}`);

  // Chest #1's scrap survived somewhere (kept chest, inventory, or ground).
  let chestScrap = 0;
  for (const b of bMap(scene).values()) {
    if (b.kind === 'storage_chest') for (const s of b.output) if (s.kind === 'material' && (s as { materialId: string }).materialId === 'scrap') chestScrap += (s as { count: number }).count;
  }
  const scrapInv = countMaterial(conn.inventory, 'scrap');
  const scrapGround = gslots.filter((s) => s.kind === 'material' && (s as { materialId: string }).materialId === 'scrap').reduce((n, s) => n + (s as { count: number }).count, 0);
  expect('C chest contents conserved', chestScrap + scrapInv + scrapGround === 9,
    `chest=${chestScrap} inv=${scrapInv} ground=${scrapGround} (want sum 9)`);

  // ---- D. persistence round-trip ----
  const snap = scene.snapshot();
  const fresh = new Scene('surface', 'surface', bindings, surfaceLayout(STARTER!));
  fresh.hydrate(snap);
  const dLink = fresh.findBuildingByKind('power_link');
  expect('D persistence round-trip',
    countKind(fresh, 'workbench') === 4 && countKind(fresh, 'storage_chest') === 2 &&
    countKind(fresh, 'turret') === 4 && !!dLink && dLink.id === LINK_ID,
    `wb=${countKind(fresh, 'workbench')} chest=${countKind(fresh, 'storage_chest')} turret=${countKind(fresh, 'turret')} link=${dLink?.id}`);

  console.log(fail === 0 ? 'PASS' : `FAIL (${fail})`);
  if (fail !== 0) process.exit(1);
}

main();
