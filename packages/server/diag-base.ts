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
  emptyInventory,
  addPlaceable,
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
    // P2: caps from the starter layout so the build-enforcement test
    // exercises the real wire path world.ts uses.
    baseCapacity: STARTER!.capacity,
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
    pvpEnabled: () => false, isPlaytest: () => false,
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

  // 5. Build enforcement (P2) — end-to-end through handleBuildRequest
  // on a fresh surface scene, player standing on the pad centre with
  // a generous placeable stock.
  const bScene = new Scene('surface', 'surface', bindings, surfaceLayout());
  bScene.addMember('diag');
  conn = makeConn(c.cx, c.cy, 0);
  conn.inventory = emptyInventory();
  addPlaceable(conn.inventory, 'workbench', 20);
  addPlaceable(conn.inventory, 'storage_chest', 20);
  addPlaceable(conn.inventory, 'wall', 20);
  const cap = STARTER!.capacity;
  const countKind = (k: string): number => {
    let n = 0;
    for (const b of (bScene as unknown as { buildings: Map<string, { kind: string }> }).buildings.values()) {
      if (b.kind === k) n++;
    }
    return n;
  };
  const build = (k: 'workbench' | 'storage_chest' | 'wall', tx: number, ty: number) =>
    (bScene as unknown as { handleBuildRequest: (id: string, k: string, tx: number, ty: number) => void }).handleBuildRequest('diag', k, tx, ty);
  // Pad-centre tile + nearby tiles, all within build range (radius 3).
  const ct = Math.round(c.cx / 32);
  // 5a. Workstation cap: try cap+3 workbenches on distinct on-pad tiles.
  for (let i = 0; i < cap.workstations + 3; i++) {
    build('workbench', ct - 3 + i, 0);
  }
  const wbCount = countKind('workbench');
  console.log(`5a. workstation cap: built=${wbCount} (limit ${cap.workstations})`);
  if (wbCount !== cap.workstations) fail++;
  // 5b. Storage cap.
  for (let i = 0; i < cap.storage + 3; i++) {
    build('storage_chest', ct - 3 + i, 2);
  }
  const stCount = countKind('storage_chest');
  console.log(`5b. storage cap: built=${stCount} (limit ${cap.storage})`);
  if (stCount !== cap.storage) fail++;
  // 5c. Walls capped: a wall cap is now enforced like workstation /
  // storage. Use a dedicated scene with a small walls cap so cap+3
  // placements fit within build reach; expect exactly `cap.walls`
  // built. (The live starter cap is 30 — far more tiles than fit in
  // one player's reach, so it gets the small-cap treatment here.)
  const WALL_CAP = 3;
  const wallLayout: SceneLayout = {
    ...surfaceLayout(),
    baseCapacity: { ...cap, walls: WALL_CAP },
  };
  const wScene = new Scene('surface', 'surface', bindings, wallLayout);
  wScene.addMember('diag');
  conn = makeConn(c.cx, c.cy, 0);
  conn.inventory = emptyInventory();
  addPlaceable(conn.inventory, 'wall', 20);
  const wallBuild = (tx: number, ty: number) =>
    (wScene as unknown as { handleBuildRequest: (id: string, k: string, tx: number, ty: number) => void }).handleBuildRequest('diag', 'wall', tx, ty);
  for (let i = 0; i < WALL_CAP + 3; i++) wallBuild(ct - 3 + i, -2);
  let wallCount = 0;
  for (const b of (wScene as unknown as { buildings: Map<string, { kind: string }> }).buildings.values()) {
    if (b.kind === 'wall') wallCount++;
  }
  console.log(`5c. walls capped: built=${wallCount} (limit ${WALL_CAP})`);
  if (wallCount !== WALL_CAP) fail++;
  // 5d. Off-pad rejected: a wall far outside the pad, but in range of
  // a player standing at the pad edge.
  const edgeTile = Math.round((c.cx + c.radius + c.apron + 64) / 32);
  conn.x = (edgeTile - 1) * 32 + 16;
  conn.y = 0;
  const wallsBefore = countKind('wall');
  build('wall', edgeTile, 0); // off-pad tile within build range
  const offPadBuilt = countKind('wall') > wallsBefore;
  console.log(`5d. off-pad build: placed=${offPadBuilt} (expect false)`);
  if (offPadBuilt) fail++;

  // 6. Turret mounts (P3) — end-to-end through handleBuildRequest on a
  // fresh surface scene whose layout carries the starter's turret
  // mounts (world coords = LINK_X + dx, 0 + dy). Player stands at the
  // pad centre with plenty of turret stock; build range (radius 3 +
  // 0.5 ≈ 112wu) reaches all four corner mounts at ±248 from a player
  // near each mount, so we move the player to each mount in turn.
  const mScene = new Scene('surface', 'surface', bindings, surfaceLayoutWithMounts());
  mScene.addMember('diag');
  conn = makeConn(c.cx, c.cy, 0);
  conn.inventory = emptyInventory();
  addPlaceable(conn.inventory, 'turret', 20);
  const mounts = STARTER!.turretMounts.map((m) => ({ x: LINK_X + m.dx, y: 0 + m.dy }));
  const turretBuildings = () =>
    [...(mScene as unknown as { buildings: Map<string, { kind: string; mountIndex?: number; id: string }> }).buildings.values()].filter(
      (b) => b.kind === 'turret',
    );
  const buildTurretNear = (wx: number, wy: number) => {
    // Stand the player ~2 tiles toward pad centre from the mount: in
    // build range (radius 3+0.5 ≈ 112wu) but NOT overlapping the mount
    // tile (the player-overlap check would otherwise reject placing a
    // building under the player's feet). Target the mount's own tile.
    const towardCentre = (a: number, centre: number) => a + Math.sign(centre - a) * 64;
    conn.x = towardCentre(wx, c.cx);
    conn.y = towardCentre(wy, c.cy);
    (mScene as unknown as { handleBuildRequest: (id: string, k: string, tx: number, ty: number) => void }).handleBuildRequest(
      'diag',
      'turret',
      Math.floor(wx / 32),
      Math.floor(wy / 32),
    );
  };

  // 6a. One turret near each mount binds to a distinct mountIndex.
  for (const m of mounts) buildTurretNear(m.x, m.y);
  const placed = turretBuildings();
  const boundIdx = new Set(placed.map((b) => b.mountIndex));
  const allBound = placed.every((b) => b.mountIndex !== undefined);
  console.log(
    `6a. turret per mount: placed=${placed.length} distinctMounts=${boundIdx.size} allBound=${allBound}` +
      ` (expect ${mounts.length}, ${mounts.length}, true)`,
  );
  if (placed.length !== mounts.length || boundIdx.size !== mounts.length || !allBound) fail++;

  // 6b. Count bounded by mounts: re-attempting on every mount (all now
  // occupied) adds nothing.
  for (const m of mounts) buildTurretNear(m.x, m.y);
  const afterRetry = turretBuildings().length;
  console.log(`6b. count bounded by mounts: total=${afterRetry} (expect ${mounts.length})`);
  if (afterRetry !== mounts.length) fail++;

  // 6c. Off-mount turret rejected: target a tile far from any mount
  // but on the pad and in range (player at pad centre, no mount near).
  conn.x = c.cx;
  conn.y = c.cy;
  const beforeOff = turretBuildings().length;
  (mScene as unknown as { handleBuildRequest: (id: string, k: string, tx: number, ty: number) => void }).handleBuildRequest(
    'diag',
    'turret',
    Math.round(c.cx / 32),
    0,
  );
  const offMountBuilt = turretBuildings().length > beforeOff;
  console.log(`6c. off-mount turret: placed=${offMountBuilt} (expect false)`);
  if (offMountBuilt) fail++;

  // 6d. Destroying a turret frees its mount: remove the turret on
  // mount 0, then a new turret near mount 0 takes the freed slot.
  const onMount0 = turretBuildings().find((b) => b.mountIndex === 0);
  if (onMount0) {
    (mScene as unknown as { buildings: Map<string, unknown> }).buildings.delete(onMount0.id);
  }
  const freedCount = turretBuildings().length;
  buildTurretNear(mounts[0].x, mounts[0].y);
  const refilled = turretBuildings();
  const refilledMount0 = refilled.some((b) => b.mountIndex === 0);
  console.log(
    `6d. destroy frees mount: afterDestroy=${freedCount} afterRebuild=${refilled.length} mount0Filled=${refilledMount0}` +
      ` (expect ${mounts.length - 1}, ${mounts.length}, true)`,
  );
  if (freedCount !== mounts.length - 1 || refilled.length !== mounts.length || !refilledMount0) fail++;

  console.log(fail === 0 ? 'PASS' : `FAIL (${fail})`);
  if (fail !== 0) process.exit(1);
}

// Surface layout variant carrying the starter's turret mounts in WORLD
// coords (same construction as world.ts surfaceLayout): offsets + the
// clearing centre (LINK_X, 0). Used by the P3 turret-mount section.
function surfaceLayoutWithMounts(): SceneLayout {
  return {
    ...surfaceLayout(),
    turretMounts: STARTER!.turretMounts.map((m) => ({ x: LINK_X + m.dx, y: 0 + m.dy })),
  };
}

main();
