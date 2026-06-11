// Jump-over-terrain diagnostic. Builds a REAL surface Scene (noise
// terrain, same config as world.ts surfaceLayout) and drives the
// actual simulatePlayerMovement tick with a fake connection that
// sprints in a fixed direction and jumps. Prints absolute z
// (floorZ + jumpZ) per tick so the arc's shape is visible in data.
//
// PASS criteria:
//   - while airborne, absolute z follows a single clean parabola
//     (second difference ~= -GRAVITY * dt^2, no terrain coupling)
//   - jumpZ never goes negative
//   - exactly ONE landing per jump, at first contact with ground
import { Scene, type SceneBindings, type SceneConnection } from './src/scene.js';
import { COMBAT } from './src/combat.js';
import { terrainHeightAt, type SceneLayout } from '@dumrunner/shared';

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
    jumpZ: 0,
    jumpVZ: 0,
    crouching: false,
    floorZ,
    lastLandedAt: 0,
    lastJumpZSent: 0,
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
): { landings: number; negJumpZ: number; maxArcErr: number } {
  const dt = COMBAT.TICK_MS / 1000;
  let now = Date.now();
  conn.inputX = dirX;
  conn.inputY = 0;
  conn.inputJump = true;
  let landings = 0;
  let negJumpZ = 0;
  // Absolute z per airborne tick, for parabola verification.
  const arc: number[] = [];
  let wasAirborne = false;
  console.log(`-- ${label} --`);
  for (let tick = 0; tick < 60; tick++) {
    now += COMBAT.TICK_MS;
    (scene as any).simulatePlayerMovement(dt, now);
    const terr = terrainHeightAt(terrainCfg, conn.x, conn.y);
    const absZ = conn.floorZ + conn.jumpZ;
    const airborne = conn.jumpZ > 0 || conn.jumpVZ !== 0;
    if (airborne) arc.push(absZ);
    if (conn.jumpZ < -1e-9) negJumpZ++;
    if (wasAirborne && !airborne) landings++;
    console.log(
      `  t=${tick} x=${conn.x.toFixed(1)} floorZ=${conn.floorZ.toFixed(2)}` +
        ` jumpZ=${conn.jumpZ.toFixed(2)} vz=${conn.jumpVZ.toFixed(2)}` +
        ` absZ=${absZ.toFixed(2)} terrain=${terr.toFixed(2)}` +
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
    `  => landings=${landings} negJumpZTicks=${negJumpZ}` +
      ` maxParabolaErr=${maxArcErr.toFixed(4)} (expected ~0; dd target=${(-g).toFixed(4)})`,
  );
  return { landings, negJumpZ, maxArcErr };
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
  // clear. The old compensation drove jumpZ negative here (phantom
  // mid-air landing); the fix must land exactly once, at first
  // contact with the rising ground, with jumpZ never < 0.
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
  let steep = { landings: 1, negJumpZ: 0, maxArcErr: 0 };
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

  const pass =
    up.landings === 1 &&
    down.landings === 1 &&
    steep.landings === 1 &&
    up.negJumpZ === 0 &&
    down.negJumpZ === 0 &&
    steep.negJumpZ === 0 &&
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
