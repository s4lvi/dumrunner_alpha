// Client camera-smoothing trace for the "sink into terrain while
// walking" regression. diag-jump.ts's walk assertion proves the
// SERVER keeps conn.z glued to the terrain at every tick, so this
// script replicates the CLIENT's tickSelfSmoothing math
// (packages/client/lib/game/fps.v2/index.ts) against those exact
// server broadcasts and measures cameraZ vs the terrain under the
// camera's rendered XY.
//
// PRE-FIX model (the regression): the airborne classifier is
//   airborne = predVZ !== 0 || selfZ > floorAt(selfX, selfY) + 0.01
// where selfX/selfY are the SMOOTHED (lagging) XY. Walking uphill
// the broadcast selfZ is the floor at the server's true (ahead)
// position, so it sits ABOVE the local floor mirror at the lagging
// XY -> misclassified airborne -> gravity integrates predVZ
// downward every frame, the landing reset never fires while input
// continues (it requires selfZ <= floor(laggingXY) + 0.01), and
// predVZ !== 0 LATCHES the airborne branch across flat/downhill
// stretches. cameraZ sags toward an equilibrium of
// |predVZ| * dt / corr and snaps back to the floor when input
// stops and the lagging XY catches up.
//
// POST-FIX model: grounded/airborne comes from the server's
// per-broadcast airborne bit (PROTOCOL_VERSION 47); grounded
// frames never integrate gravity (predVZ stays 0 except for the
// optimistic local jump kick, predVZ > 0).
//
// PASS criteria:
//   - pre-fix model sags > 5 wu below terrain while walking and
//     snaps >= that much on stop (reproduces the report)
//   - post-fix model stays within 1.5 wu of the terrain for the
//     entire walk and has no stop-snap
import { COMBAT } from './src/combat.js';
import { terrainHeightAt } from '@dumrunner/shared';

const TERRAIN = {
  amplitude: 64,
  frequency: 1 / 384,
  octaves: 2,
  seed: 0x5e7117ed,
};

// Same uphill-slope finder as diag-jump.ts.
function findUphillStart(): { x: number; y: number } {
  for (let y = -1800; y < 1800; y += 64) {
    for (let x = -1800; x < 1600; x += 16) {
      const z0 = terrainHeightAt(TERRAIN, x, y);
      const z1 = terrainHeightAt(TERRAIN, x + 100, y);
      const z2 = terrainHeightAt(TERRAIN, x + 200, y);
      if (z1 - z0 > 5 && z2 - z1 > 5 && z2 - z0 < 24) {
        return { x, y };
      }
    }
  }
  throw new Error('no uphill slope found');
}

function floorAt(x: number, y: number): number {
  // Surface scene: terrain only (no platforms / authored sectors),
  // identical to the client's floorAt mirror in this scenario.
  return terrainHeightAt(TERRAIN, x, y);
}

// Constants mirrored from packages/client/lib/game/fps.v2/index.ts.
const SELF_SMOOTH_TAU_MS = 50;
const FLOOR_SMOOTH_TAU_MS = 70;
const JUMP_CORRECT_TAU_MS = 80;
const JUMP_VZ_INIT = 100;
const JUMP_GRAVITY = 200;

class ClientModel {
  selfX: number;
  selfY: number;
  targetSelfX: number;
  targetSelfY: number;
  selfZ: number;
  cameraZ: number;
  predVZ = 0;
  selfAirborne = false;

  constructor(
    x: number,
    y: number,
    z: number,
    private fixed: boolean,
  ) {
    this.selfX = x;
    this.selfY = y;
    this.targetSelfX = x;
    this.targetSelfY = y;
    this.selfZ = z;
    this.cameraZ = z;
  }

  // movePlayer for self (packages/client/lib/game/fps.v2/index.ts).
  onServerMove(x: number, y: number, z: number, airborne: boolean): void {
    this.targetSelfX = x;
    this.targetSelfY = y;
    this.selfZ = z;
    this.selfAirborne = airborne;
  }

  // tickSelfSmoothing (index.ts:1505-1572), dt in ms.
  frame(dt: number): void {
    const dx = this.targetSelfX - this.selfX;
    const dy = this.targetSelfY - this.selfY;
    const txy = Math.min(1, 1 - Math.exp(-dt / SELF_SMOOTH_TAU_MS));
    if (dx !== 0 || dy !== 0) {
      this.selfX += dx * txy;
      this.selfY += dy * txy;
      if (Math.abs(this.targetSelfX - this.selfX) < 0.05) {
        this.selfX = this.targetSelfX;
      }
      if (Math.abs(this.targetSelfY - this.selfY) < 0.05) {
        this.selfY = this.targetSelfY;
      }
    }
    const targetFloor = floorAt(this.selfX, this.selfY);
    const airborne = this.fixed
      ? this.selfAirborne || this.predVZ > 0
      : this.predVZ !== 0 || this.selfZ > targetFloor + 0.01;
    if (airborne) {
      const dts = dt / 1000;
      this.predVZ -= JUMP_GRAVITY * dts;
      if (this.predVZ < -3 * JUMP_VZ_INIT) this.predVZ = -3 * JUMP_VZ_INIT;
      this.cameraZ += this.predVZ * dts;
      const corr = Math.min(1, 1 - Math.exp(-dt / JUMP_CORRECT_TAU_MS));
      this.cameraZ += (this.selfZ - this.cameraZ) * corr;
      if (
        this.predVZ <= 0 &&
        this.cameraZ <= targetFloor &&
        this.selfZ <= targetFloor + 0.01
      ) {
        this.cameraZ = targetFloor;
        this.predVZ = 0;
      }
    } else {
      this.predVZ = 0;
      const dz = targetFloor - this.cameraZ;
      if (dz > 0) {
        this.cameraZ = targetFloor;
      } else if (dz < 0) {
        const tz = Math.min(1, 1 - Math.exp(-dt / FLOOR_SMOOTH_TAU_MS));
        this.cameraZ += dz * tz;
        if (Math.abs(targetFloor - this.cameraZ) < 0.05) {
          this.cameraZ = targetFloor;
        }
      }
    }
  }

  // How far the camera sits BELOW the terrain at its rendered XY.
  // Positive = sunk into the ground.
  sag(): number {
    return floorAt(this.selfX, this.selfY) - this.cameraZ;
  }
}

function main(): void {
  const start = findUphillStart();
  const z0 = floorAt(start.x, start.y);
  console.log(
    `slope start at (${start.x}, ${start.y}) z=${z0.toFixed(2)}; ` +
      `walking +x at ${COMBAT.PLAYER_MOVE_SPEED} wu/s, ` +
      `server tick ${COMBAT.TICK_MS}ms, client frame 16.67ms`,
  );

  const pre = new ClientModel(start.x, start.y, z0, false);
  const post = new ClientModel(start.x, start.y, z0, true);

  // Server ground truth: grounded walk, z glued to terrain every
  // tick (verified by diag-jump.ts's walk assertion).
  let sx = start.x;
  const sy = start.y;
  const tickDt = COMBAT.TICK_MS / 1000;
  const frameMs = 1000 / 60;
  const WALK_TICKS = 60; // 3 s of walking
  const STOP_TICKS = 20; // 1 s standing still

  let preMaxSagWalk = 0;
  let postMaxAbsSagWalk = 0;
  console.log(
    '  ms     serverX  selfX(pre) selfZ    terr@cam  camPre    sagPre  predVZ   camPost  sagPost',
  );
  let ms = 0;
  for (let tick = 0; tick < WALK_TICKS + STOP_TICKS; tick++) {
    const walking = tick < WALK_TICKS;
    if (walking) {
      sx += COMBAT.PLAYER_MOVE_SPEED * tickDt;
      const sz = floorAt(sx, sy);
      // Grounded broadcast: airborne bit false.
      pre.onServerMove(sx, sy, sz, false);
      post.onServerMove(sx, sy, sz, false);
    }
    // 3 client frames per 50 ms server tick.
    for (let f = 0; f < 3; f++) {
      pre.frame(frameMs);
      post.frame(frameMs);
      ms += frameMs;
    }
    if (walking) {
      if (pre.sag() > preMaxSagWalk) preMaxSagWalk = pre.sag();
      if (Math.abs(post.sag()) > postMaxAbsSagWalk) {
        postMaxAbsSagWalk = Math.abs(post.sag());
      }
    }
    if (tick % 4 === 0 || tick === WALK_TICKS - 1 || tick === WALK_TICKS) {
      console.log(
        `  ${ms.toFixed(0).padStart(5)}` +
          `  ${sx.toFixed(1).padStart(8)}` +
          `  ${pre.selfX.toFixed(1).padStart(9)}` +
          `  ${pre.selfZ.toFixed(2).padStart(7)}` +
          `  ${floorAt(pre.selfX, pre.selfY).toFixed(2).padStart(8)}` +
          `  ${pre.cameraZ.toFixed(2).padStart(8)}` +
          `  ${pre.sag().toFixed(2).padStart(6)}` +
          `  ${pre.predVZ.toFixed(1).padStart(7)}` +
          `  ${post.cameraZ.toFixed(2).padStart(7)}` +
          `  ${post.sag().toFixed(2).padStart(7)}` +
          `${tick === WALK_TICKS ? '  <- input stopped' : ''}`,
      );
    }
  }
  // Stop-snap size: sag at last walking sample minus sag after
  // the standstill settles.
  const preSagEnd = pre.sag();
  const postSagEnd = post.sag();
  console.log(
    `  => pre-fix:  max sag while walking = ${preMaxSagWalk.toFixed(2)} wu, ` +
      `settled sag after stop = ${preSagEnd.toFixed(2)} wu ` +
      `(snap-back of ~${preMaxSagWalk.toFixed(1)} wu on stop)`,
  );
  console.log(
    `  => post-fix: max |sag| while walking = ${postMaxAbsSagWalk.toFixed(2)} wu, ` +
      `settled sag after stop = ${postSagEnd.toFixed(2)} wu`,
  );

  const pass =
    preMaxSagWalk > 5 && // regression reproduced
    Math.abs(preSagEnd) < 0.1 && // ...and it snaps correct on stop
    postMaxAbsSagWalk < 1.5 && // fix: camera hugs terrain while moving
    Math.abs(postSagEnd) < 0.1;
  console.log(pass ? 'PASS' : 'FAIL');
  if (!pass) process.exit(1);
}

main();
