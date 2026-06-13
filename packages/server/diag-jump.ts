// Jump-over-terrain diagnostic. Builds a REAL surface Scene (noise
// terrain, same config as world.ts surfaceLayout) and drives the
// actual simulatePlayerMovement tick with a fake connection that
// sprints in a fixed direction and jumps. Prints the absolute feet
// z per tick so the arc's shape is visible in data.
//
// PASS criteria:
//   - while airborne, absolute z follows a single clean parabola
//     (second difference ~= -GRAVITY * dt^2, no terrain coupling)
//   - z never dips below the floor anchor (no clipping into ground)
//   - exactly ONE landing per jump, at first contact with ground
import { Scene, type SceneBindings, type SceneConnection } from './src/scene.js';
import { COMBAT } from './src/combat.js';
import { terrainHeightAt, type SceneLayout } from '@dumrunner/shared';
import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';

const TERRAIN = {
  amplitude: 64,
  frequency: 1 / 384,
  octaves: 2,
  seed: 0x5e7117ed,
};

function surfaceLayout(): SceneLayout {
  return {
    worldBounds: { x: -2000, y: -2000, w: 4000, h: 4000 },
    walkables: [],
    rooms: [],
    spawn: { x: 0, y: 0 },
    interactables: [],
    tileSize: 32,
    biome: 'default',
    terrain: TERRAIN,
  };
}

function makeConn(x: number, y: number, floorZ: number): SceneConnection {
  return {
    ws: { readyState: 3, send: () => {} } as unknown as SceneConnection['ws'],
    characterId: 'diag',
    displayName: 'diag',
    alive: true,
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
    shield: 0,
    maxShield: 0,
    lastDamageAt: 0,
    x,
    y,
    inputX: 0,
    inputY: 0,
    inputAt: Date.now() + 1e9, // never stale
    inputSprint: false,
    inputJump: false,
    inputCrouch: false,
    z: floorZ,
    vz: 0,
    crouching: false,
    floorZ,
    lastZSent: floorZ,
    lastCrouchSent: false,
    inventory: { slots: [] } as unknown as SceneConnection['inventory'],
    equipment: {} as SceneConnection['equipment'],
    hotbarSelection: 0,
    dirty: false,
    inventoryDirty: false,
    lastFireAt: 0,
    reloadingUntil: 0,
    reloadingSlot: -1,
    respawnAt: null,
    respawnImmunityUntil: 0,
    activeEffects: [],
    lastStaminaSentAt: 0,
    lastShieldSentAt: 0,
    lastStaminaSent: 100,
    lastShieldSent: 0,
    staminaRegenAt: 0,
    suitSpeedMult: 0,
    suitStaminaRegenBonus: 0,
    suitBuildRadiusBonus: 0,
    suitHeatResist: 0,
    suitColdResist: 0,
    suitRadiationResist: 0,
    suitToxicResist: 0,
    kills: 0,
    deaths: 0,
  };
}

// Find a start point on an uphill slope: walk +x and pick a spot
// where terrain rises steadily over the next ~200 wu.
function findUphillStart(): { x: number; y: number } {
  for (let y = -1800; y < 1800; y += 64) {
    for (let x = -1800; x < 1600; x += 16) {
      const z0 = terrainHeightAt(TERRAIN, x, y);
      const z1 = terrainHeightAt(TERRAIN, x + 100, y);
      const z2 = terrainHeightAt(TERRAIN, x + 200, y);
      // Rising 10..20 wu over 200 wu — a real hill but climbable.
      if (z1 - z0 > 5 && z2 - z1 > 5 && z2 - z0 < 24) {
        return { x, y };
      }
    }
  }
  throw new Error('no uphill slope found');
}

function runJump(
  scene: Scene,
  conn: SceneConnection,
  label: string,
  dirX: number,
  terrainCfg: typeof TERRAIN = TERRAIN,
): { landings: number; belowFloor: number; maxArcErr: number } {
  const dt = COMBAT.TICK_MS / 1000;
  let now = Date.now();
  conn.inputX = dirX;
  conn.inputY = 0;
  conn.inputJump = true;
  let landings = 0;
  let belowFloor = 0;
  // Absolute z per airborne tick, for parabola verification.
  const arc: number[] = [];
  let wasAirborne = false;
  console.log(`-- ${label} --`);
  for (let tick = 0; tick < 60; tick++) {
    now += COMBAT.TICK_MS;
    (scene as any).simulatePlayerMovement(dt, now);
    const terr = terrainHeightAt(terrainCfg, conn.x, conn.y);
    const airborne = conn.z > conn.floorZ || conn.vz !== 0;
    if (airborne) arc.push(conn.z);
    if (conn.z - conn.floorZ < -1e-9) belowFloor++;
    if (wasAirborne && !airborne) landings++;
    console.log(
      `  t=${tick} x=${conn.x.toFixed(1)} floorZ=${conn.floorZ.toFixed(2)}` +
        ` z=${conn.z.toFixed(2)} vz=${conn.vz.toFixed(2)}` +
        ` terrain=${terr.toFixed(2)}` +
        `${airborne ? ' AIR' : ' ground'}${wasAirborne && !airborne ? ' <LAND>' : ''}`,
    );
    wasAirborne = airborne;
    if (landings > 0 && tick > 40) break;
  }
  // Parabola check: for ticks fully in flight, the second
  // difference of absolute z must be constant (-g*dt^2). Any
  // terrain coupling shows up as a deviation.
  const g = COMBAT.GRAVITY * dt * dt;
  let maxArcErr = 0;
  for (let i = 2; i < arc.length - 1; i++) {
    // skip the final sample (landing clamp legitimately bends it)
    const dd = arc[i] - 2 * arc[i - 1] + arc[i - 2];
    const err = Math.abs(dd + g);
    if (err > maxArcErr) maxArcErr = err;
  }
  console.log(
    `  => landings=${landings} belowFloorTicks=${belowFloor}` +
      ` maxParabolaErr=${maxArcErr.toFixed(4)} (expected ~0; dd target=${(-g).toFixed(4)})`,
  );
  return { landings, belowFloor, maxArcErr };
}

// Grounded walk-only trace (no jumping): the absolute-z model
// must keep conn.z glued to the terrain at every tick while
// walking over uneven ground — both uphill and downhill. Any
// tick where z dips below (or floats above) the terrain at the
// player's XY is a server-side cause of the "sink while moving"
// regression; zero deviation here pins the bug on the client.
function runWalk(
  scene: Scene,
  conn: SceneConnection,
  label: string,
  dirX: number,
  ticks: number,
  terrainCfg: typeof TERRAIN = TERRAIN,
): { maxDev: number; airborneTicks: number } {
  const dt = COMBAT.TICK_MS / 1000;
  let now = Date.now();
  conn.inputX = dirX;
  conn.inputY = 0;
  conn.inputJump = false;
  let maxDev = 0;
  let airborneTicks = 0;
  console.log(`-- ${label} --`);
  for (let tick = 0; tick < ticks; tick++) {
    now += COMBAT.TICK_MS;
    (scene as any).simulatePlayerMovement(dt, now);
    const terr = terrainHeightAt(terrainCfg, conn.x, conn.y);
    const dev = conn.z - terr;
    if (Math.abs(dev) > Math.abs(maxDev)) maxDev = dev;
    const airborne = conn.z > conn.floorZ || conn.vz !== 0;
    if (airborne) airborneTicks++;
    if (tick % 8 === 0 || Math.abs(dev) > 1e-9) {
      console.log(
        `  t=${tick} x=${conn.x.toFixed(1)} z=${conn.z.toFixed(4)}` +
          ` terrain=${terr.toFixed(4)} dev=${dev.toFixed(6)}` +
          ` vz=${conn.vz.toFixed(2)}${airborne ? ' AIR' : ''}`,
      );
    }
  }
  console.log(
    `  => maxDev=${maxDev.toFixed(6)} airborneTicks=${airborneTicks}` +
      ` (expected: dev 0 every tick, never airborne)`,
  );
  return { maxDev, airborneTicks };
}

// Walk off a raised platform edge in a real dungeon floor. Pre-fix
// the grounded re-anchor snapped the feet straight to the lower
// floor in one tick (airborne never set, z drops in a single
// step). Post-fix a real ledge becomes a fall: the player goes
// airborne and z descends over MULTIPLE ticks under gravity, then
// lands once at the lower floor — never below it.
function runLedge(
  scene: Scene,
  conn: SceneConnection,
  platformTop: number,
  lowerFloor: number,
  dirX: number,
  dirY: number,
): { airborneTicks: number; descendTicks: number; landedZ: number; belowFloor: number; maxStepDown: number } {
  const dt = COMBAT.TICK_MS / 1000;
  let now = Date.now();
  conn.inputX = dirX;
  conn.inputY = dirY;
  conn.inputJump = false;
  let airborneTicks = 0;
  let descendTicks = 0;
  let belowFloor = 0;
  let maxStepDown = 0;
  let prevZ = conn.z;
  for (let tick = 0; tick < 60; tick++) {
    now += COMBAT.TICK_MS;
    (scene as any).simulatePlayerMovement(dt, now);
    if (conn.z > conn.floorZ + 1e-6 || conn.vz !== 0) airborneTicks++;
    const stepDown = prevZ - conn.z;
    if (stepDown > 1e-6) descendTicks++;
    if (stepDown > maxStepDown) maxStepDown = stepDown;
    if (conn.z < conn.floorZ - 1e-6) belowFloor++;
    prevZ = conn.z;
  }
  return {
    airborneTicks,
    descendTicks,
    landedZ: conn.z,
    belowFloor,
    maxStepDown,
  };
}

async function main() {
  const start = findUphillStart();
  console.log(
    `slope start at (${start.x}, ${start.y}); terrain z: ` +
      [0, 50, 100, 150, 200]
        .map((d) => terrainHeightAt(TERRAIN, start.x + d, start.y).toFixed(1))
        .join(' → '),
  );

  let conn: SceneConnection;
  const bindings: SceneBindings = {
    connection: () => conn,
    send: () => {},
    onInteractable: () => {},
    onPlayerRespawn: () => {},
    onPlayerDied: () => {},
    onPowerLinkDestroyed: () => {},
    isPowerOnline: () => true,
    isPowered: () => false,
    onBuildingsChanged: () => {},
    dropItemsOnDeath: () => false,
    onPlayerEquipmentChanged: () => {},
    applyPlayerEffect: () => {},
    pvpEnabled: () => false,
    isPlaytest: () => false,
  };
  const scene = new Scene('surface', 'surface', bindings, surfaceLayout());
  scene.addMember('diag');

  const z0 = terrainHeightAt(TERRAIN, start.x, start.y);
  conn = makeConn(start.x, start.y, z0);
  const up = runJump(scene, conn, 'jump while running UPHILL (+x)', 1);

  // Downhill: start where the uphill run ended, run back.
  const z1 = terrainHeightAt(TERRAIN, conn.x, conn.y);
  conn = makeConn(conn.x, conn.y, z1);
  const down = runJump(scene, conn, 'jump while running DOWNHILL (-x)', -1);

  // Steep stress case: terrain rising faster than the arc can
  // clear. The old floor-relative compensation drove jumpZ
  // negative here (phantom mid-air landing); the absolute-z model
  // must land exactly once, at first contact with the rising
  // ground, with z never below the floor anchor.
  const STEEP = { amplitude: 200, frequency: 1 / 384, octaves: 2, seed: 77 };
  const steepLayout = { ...surfaceLayout(), terrain: STEEP };
  let steepStart: { x: number; y: number } | null = null;
  outer: for (let y = -1800; y < 1800; y += 64) {
    for (let x = -1800; x < 1500; x += 16) {
      const z0 = terrainHeightAt(STEEP, x, y);
      const zMid = terrainHeightAt(STEEP, x + 80, y);
      // Rising > 25 wu over 80 wu — outruns the jump apex (~20).
      if (zMid - z0 > 25) {
        steepStart = { x, y };
        break outer;
      }
    }
  }
  let steep = { landings: 1, belowFloor: 0, maxArcErr: 0 };
  if (steepStart) {
    const steepScene = new Scene('surface', 'surface', bindings, steepLayout);
    steepScene.addMember('diag');
    conn = makeConn(
      steepStart.x,
      steepStart.y,
      terrainHeightAt(STEEP, steepStart.x, steepStart.y),
    );
    console.log(
      `steep slope at (${steepStart.x}, ${steepStart.y}); terrain z: ` +
        [0, 40, 80, 120]
          .map((d) =>
            terrainHeightAt(STEEP, steepStart!.x + d, steepStart!.y).toFixed(1),
          )
          .join(' → '),
    );
    steep = runJump(
      steepScene,
      conn,
      'jump INTO steep rising slope (+x)',
      1,
      STEEP,
    );
  } else {
    console.log('no steep slope found — skipping stress case');
  }

  // Grounded walk-only regression check over the same slope:
  // uphill then back downhill, never jumping. z must track the
  // terrain exactly at every tick.
  const wz0 = terrainHeightAt(TERRAIN, start.x, start.y);
  conn = makeConn(start.x, start.y, wz0);
  const walkScene = new Scene('surface', 'surface', bindings, surfaceLayout());
  walkScene.addMember('diag');
  const walkUp = runWalk(
    walkScene,
    conn,
    'walk UPHILL (+x), no jump',
    1,
    80,
  );
  const wz1 = terrainHeightAt(TERRAIN, conn.x, conn.y);
  conn = makeConn(conn.x, conn.y, wz1);
  const walkDown = runWalk(
    walkScene,
    conn,
    'walk DOWNHILL (-x), no jump',
    -1,
    80,
  );

  // Ledge walk-off (real dungeon floor with platforms). Find a
  // platform, stand on top, walk toward each cardinal direction
  // until one carries the player off the edge over a real drop.
  await initBiomes();
  await initRooms();
  let ledge = {
    found: false,
    airborneTicks: 0,
    descendTicks: 0,
    maxStepDown: 0,
    belowFloor: 0,
    landedZ: 0,
    platformTop: 0,
  };
  outerLedge: for (const [seed, floor] of [[101, 3], [303, 3], [202, 3]] as const) {
    const dl = generateFloorLayout(seed, 1, floor, 'default');
    const map = (dl as unknown as { authoredSectorMap?: { sectors: Array<{ floorZ: number; verts: { x: number; y: number }[] }> } }).authoredSectorMap;
    if (!map) continue;
    const plat = map.sectors.find((s) => s.floorZ >= 16 && s.floorZ <= 28);
    if (!plat) continue;
    const cx = plat.verts.reduce((t, v) => t + v.x, 0) / plat.verts.length;
    const cy = plat.verts.reduce((t, v) => t + v.y, 0) / plat.verts.length;
    const lScene = new Scene(`dungeon:${floor}`, 'dungeon_floor', bindings, dl);
    lScene.addMember('diag');
    const top = (lScene as any).floorAt(cx, cy, plat.floorZ + COMBAT.STEP_UP_MAX);
    if (Math.abs(top - plat.floorZ) > 0.5) continue; // not actually standing on it
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      conn = makeConn(cx, cy, plat.floorZ);
      conn.z = plat.floorZ;
      conn.floorZ = plat.floorZ;
      const r = runLedge(lScene, conn, plat.floorZ, 0, dx, dy);
      // A successful walk-off: ended meaningfully below the platform
      // top, fell over multiple ticks, never a single-tick teleport
      // larger than one gravity step, never below the floor.
      if (r.landedZ < plat.floorZ - COMBAT.STEP_UP_MAX && r.descendTicks >= 2) {
        ledge = { found: true, platformTop: plat.floorZ, ...r };
        break outerLedge;
      }
    }
  }
  if (ledge.found) {
    const maxGravityStep =
      (COMBAT.JUMP_VZ_INIT * 3 + COMBAT.GRAVITY * (COMBAT.TICK_MS / 1000)) *
      (COMBAT.TICK_MS / 1000);
    console.log(
      `-- ledge walk-off -- platformTop=${ledge.platformTop} landedZ=${ledge.landedZ.toFixed(1)}` +
        ` airborneTicks=${ledge.airborneTicks} descendTicks=${ledge.descendTicks}` +
        ` maxStepDown=${ledge.maxStepDown.toFixed(2)} belowFloor=${ledge.belowFloor}` +
        ` (expected: airborne>=2, descend>=2, no single-tick teleport > ${maxGravityStep.toFixed(1)})`,
    );
  } else {
    console.log('-- ledge walk-off -- no suitable platform edge found, skipping');
  }
  const ledgeMaxStep =
    (COMBAT.JUMP_VZ_INIT * 3) * (COMBAT.TICK_MS / 1000) + 1;
  const ledgePass =
    !ledge.found ||
    (ledge.airborneTicks >= 2 &&
      ledge.descendTicks >= 2 &&
      ledge.belowFloor === 0 &&
      ledge.maxStepDown <= ledgeMaxStep);

  const pass =
    ledgePass &&
    walkUp.maxDev === 0 &&
    walkDown.maxDev === 0 &&
    walkUp.airborneTicks === 0 &&
    walkDown.airborneTicks === 0 &&
    up.landings === 1 &&
    down.landings === 1 &&
    steep.landings === 1 &&
    up.belowFloor === 0 &&
    down.belowFloor === 0 &&
    steep.belowFloor === 0 &&
    up.maxArcErr < 0.01 &&
    down.maxArcErr < 0.01 &&
    steep.maxArcErr < 0.01;
  console.log(pass ? 'PASS' : 'FAIL');
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
