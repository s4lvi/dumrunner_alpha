// Base-layout P0 spike diagnostic. Proves the terrain "leveled
// clearing" invariants on the REAL surface scene:
//   1. flat pad — terrain == padZ everywhere inside the radius
//   2. apron is gentle — terrain delta per move-step stays under
//      STEP_UP_MAX across the ramp (so the player isn't blocked /
//      ledge-falls walking on/off, and the renderer draws no cliff)
//   3. natural terrain is untouched beyond the apron
//   4. a real player walk from outside the apron onto the pad
//      traverses cleanly (no block, no airborne ledge-fall) using
//      the actual simulatePlayerMovement tick.
import { Scene, type SceneBindings, type SceneConnection } from './src/scene.js';
import { COMBAT } from './src/combat.js';
import {
  initBaseLayouts,
  getBaseLayout,
  STARTER_BASE_LAYOUT_ID,
} from './src/baseLayouts.js';
import {
  terrainHeightAt,
  insideClearingPad,
  type SceneLayout,
} from '@dumrunner/shared';

// Load the real base-layout registry so the diag's terrain clearing
// is derived from the authored starter BaseLayoutDef the exact way
// world.ts builds it — radius/apron/padZ from the layout, centred on
// the Power Link world position. Proves the data drives the geometry.
await initBaseLayouts();
const LINK_X = (6 + 0.5) * 32;
const STARTER = getBaseLayout(STARTER_BASE_LAYOUT_ID);
if (!STARTER) {
  console.error(
    `FAIL — starter base layout "${STARTER_BASE_LAYOUT_ID}" not loaded; expected content/base-layouts/${STARTER_BASE_LAYOUT_ID}.json`,
  );
  process.exit(1);
}
const TERRAIN = {
  amplitude: 64,
  frequency: 1 / 384,
  octaves: 2,
  seed: 0x5e7117ed,
  // Same construction as world.ts surfaceLayout(): shape from the
  // layout, centre on the Power Link (LINK_X, 0).
  clearing: {
    cx: LINK_X,
    cy: 0,
    radius: STARTER.radius,
    apron: STARTER.apron,
    padZ: STARTER.padZ,
  },
};

function makeConn(x: number, y: number, floorZ: number): SceneConnection {
  return {
    ws: { readyState: 3, send: () => {} } as unknown as SceneConnection['ws'],
    characterId: 'diag',
    displayName: 'diag',
    alive: true,
    hp: 100, maxHp: 100, stamina: 100, maxStamina: 100, shield: 0, maxShield: 0,
    lastDamageAt: 0,
    x, y,
    inputX: 0, inputY: 0, inputAt: Date.now() + 1e9,
    inputSprint: false, inputJump: false, inputCrouch: false,
    z: floorZ, vz: 0, crouching: false, floorZ,
    lastZSent: floorZ, lastCrouchSent: false,
    inventory: { slots: [] } as unknown as SceneConnection['inventory'],
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

function surfaceLayout(): SceneLayout {
  return {
    worldBounds: { x: -2000, y: -2000, w: 4000, h: 4000 },
    walkables: [],
    rooms: [],
    spawn: { x: 80, y: 0 },
    interactables: [],
    tileSize: 32,
    biome: 'default',
    terrain: TERRAIN,
  };
}

function main(): void {
  const c = TERRAIN.clearing;
  let fail = 0;

  // 1. Flat pad: sample a grid strictly inside the radius (stop a
  // hair short of the rim so cos/sin rounding can't push a sample
  // off the <= boundary — that's a float artifact, not a terrain
  // defect; the maxDev check covers the rim).
  let maxPadDev = 0;
  let padMembership = true;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
    for (let r = 0; r <= c.radius; r += 16) {
      const x = c.cx + Math.cos(a) * r;
      const y = c.cy + Math.sin(a) * r;
      const z = terrainHeightAt(TERRAIN, x, y);
      maxPadDev = Math.max(maxPadDev, Math.abs(z - c.padZ));
      if (r <= c.radius - 1 && !insideClearingPad(TERRAIN, x, y)) {
        padMembership = false;
      }
    }
  }
  console.log(`1. flat pad: maxDev=${maxPadDev.toFixed(4)} membership=${padMembership} (expect 0, true)`);
  if (maxPadDev > 1e-6 || !padMembership) fail++;

  // 2. Apron step budget: radial sweep through the apron at the
  // move-step distance (~7wu/tick at run speed), worst case over
  // many directions. Must stay <= STEP_UP_MAX.
  const STEP = 7;
  let maxStep = 0;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 64) {
    let prev = terrainHeightAt(TERRAIN, c.cx + Math.cos(a) * c.radius, c.cy + Math.sin(a) * c.radius);
    for (let r = c.radius; r <= c.radius + c.apron + 64; r += STEP) {
      const x = c.cx + Math.cos(a) * r;
      const y = c.cy + Math.sin(a) * r;
      const z = terrainHeightAt(TERRAIN, x, y);
      maxStep = Math.max(maxStep, Math.abs(z - prev));
      prev = z;
    }
  }
  console.log(`2. apron step: max=${maxStep.toFixed(3)}wu/step (limit STEP_UP_MAX=${COMBAT.STEP_UP_MAX})`);
  if (maxStep > COMBAT.STEP_UP_MAX) fail++;

  // 3. Natural terrain beyond apron is untouched (nonzero somewhere).
  let beyondVariation = 0;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
    const r = c.radius + c.apron + 200;
    const z = terrainHeightAt(TERRAIN, c.cx + Math.cos(a) * r, c.cy + Math.sin(a) * r);
    beyondVariation = Math.max(beyondVariation, Math.abs(z));
  }
  console.log(`3. natural terrain beyond apron: maxAbs=${beyondVariation.toFixed(1)}wu (expect > 0)`);
  if (beyondVariation < 1) fail++;

  // 4. Real player walk from outside the apron straight onto the pad.
  const bindings: SceneBindings = {
    connection: () => conn,
    send: () => {}, onInteractable: () => {}, onPlayerRespawn: () => {},
    onPlayerDied: () => {}, onPowerLinkDestroyed: () => {},
    isPowerOnline: () => true, isPowered: () => false,
    onBuildingsChanged: () => {}, dropItemsOnDeath: () => false,
    onPlayerEquipmentChanged: () => {}, applyPlayerEffect: () => {},
    pvpEnabled: () => false,
  };
  const scene = new Scene('surface', 'surface', bindings, surfaceLayout());
  scene.addMember('diag');
  // Start well outside the apron, east of centre, walk west (-x)
  // toward the pad.
  const startX = c.cx + c.radius + c.apron + 150;
  let conn = makeConn(startX, c.cy, terrainHeightAt(TERRAIN, startX, c.cy));
  conn.inputX = -1;
  const dt = COMBAT.TICK_MS / 1000;
  let now = Date.now();
  let blockedTicks = 0;
  let airborneTicks = 0;
  let prevX = conn.x;
  for (let tick = 0; tick < 80; tick++) {
    now += COMBAT.TICK_MS;
    (scene as unknown as { simulatePlayerMovement: (d: number, n: number) => void }).simulatePlayerMovement(dt, now);
    if (Math.abs(conn.x - prevX) < 0.5) blockedTicks++;
    if (conn.z > conn.floorZ + 1e-6 || conn.vz !== 0) airborneTicks++;
    prevX = conn.x;
    if (insideClearingPad(TERRAIN, conn.x, conn.y) && Math.abs(conn.x - c.cx) < 32) break;
  }
  const reachedPad = insideClearingPad(TERRAIN, conn.x, conn.y);
  console.log(
    `4. player walk onto pad: reached=${reachedPad} blockedTicks=${blockedTicks}` +
      ` airborneTicks=${airborneTicks} finalZ=${conn.z.toFixed(2)} (expect reached, ~0 blocked, 0 airborne)`,
  );
  if (!reachedPad || airborneTicks > 0 || blockedTicks > 3) fail++;

  console.log(fail === 0 ? 'PASS' : `FAIL (${fail})`);
  if (fail !== 0) process.exit(1);
}

main();
