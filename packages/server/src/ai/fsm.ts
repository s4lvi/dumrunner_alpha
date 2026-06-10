import type { AttackSpec, EnemyTemplate } from './types.js';
import type { EnemyRuntime } from './runtime.js';

// View of a player as the AI sees it. Decoupled from server.Connection so
// fsm.ts has no dependency on Room internals.
export type AiPlayer = {
  characterId: string;
  x: number;
  y: number;
};

// Building target — passed in only during the horde event so enemies will
// path toward and attack player structures (Power Link first, then turrets,
// workstations, walls). Higher priority = picked first; ties resolve by
// distance.
export type AiBuildingTarget = {
  buildingId: string;
  x: number;
  y: number;
  priority: number;
};

// What the AI is currently locked onto. Discriminated so fsm.ts can branch
// movement / attack behaviour without leaking world ids into the FSM core.
export type AiTarget =
  | { kind: 'player'; characterId: string; x: number; y: number }
  | { kind: 'building'; buildingId: string; x: number; y: number };

// What the FSM emits on each tick. The Room consumes these and is responsible
// for applying damage / spawning projectiles / broadcasting state changes.
// Keeps fsm.ts pure-ish (no I/O) and easy to test.
export type AiOutcome = {
  // Continuous melee damage to apply this tick.
  meleeDamage: { targetCharacterId: string; amount: number }[];
  // Projectile fire requests resolved this tick.
  projectileFires: ProjectileFireRequest[];
  // AoE-cone status applications resolved this tick. Scene resolves
  // each by walking players and checking they're inside the cone.
  aoeConeApplications: AoeConeApplication[];
  // True if the enemy moved enough to warrant a position broadcast.
  positionDirty: boolean;
};

export type AoeConeApplication = {
  ownerEnemyId: string;
  originX: number;
  originY: number;
  // Cone-axis unit vector — points at the target at fire time.
  axisX: number;
  axisY: number;
  // Geometry / effect parameters (cloned from the AttackSpec entry).
  range: number;
  arcRad: number;
  effectKind:
    | 'burn_dps'
    | 'poison_dps'
    | 'slow_pct';
  effectMagnitude: number;
  effectDurationMs: number;
  effectLabel: string;
  coneColor: number;
};

export type ProjectileFireRequest = {
  ownerEnemyId: string;
  fromX: number;
  fromY: number;
  dirX: number;       // unit vector
  dirY: number;
  spec: Extract<AttackSpec, { kind: 'projectile' }>;
};

const POSITION_BROADCAST_EPSILON = 0.5; // px

// Active-effect aggregate that scales the enemy's effective move
// speed this tick. Slow_pct effects subtract from 1.0; cap at 0.
// DoT effects don't influence movement.
export function currentEnemySpeedMult(enemy: EnemyRuntime): number {
  let slow = 0;
  for (const e of enemy.activeEffects) {
    if (e.kind === 'slow_pct') slow += e.magnitude;
  }
  return Math.max(0, 1 - slow);
}

// Optional environment hooks the FSM consumes. Scene supplies these:
// collisionTest gates movement against walls; lineOfSight gates target
// acquisition behind walls. Both default to "always allowed" if absent.
//
// collisionTest takes a radius so the test can do a bounding-circle check
// rather than a single-point check — otherwise enemies can push into walls
// up to their own radius before being stopped.
export type AiEnvironment = {
  collisionTest?: (x: number, y: number, radius: number) => boolean;
  lineOfSight?: (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ) => boolean;
  // Tile-grid pathing fallback for when the direct chase line is
  // blocked. Returns a world-coord steering point toward the target
  // (or null when no path exists). Calls are throttled FSM-side via
  // EnemyRuntime.repathAt, so the impl can afford a bounded BFS.
  nextWaypoint?: (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ) => { x: number; y: number } | null;
};

export function tickEnemy(
  enemy: EnemyRuntime,
  dt: number,
  now: number,
  players: AiPlayer[],
  env: AiEnvironment = {},
  buildingTargets: AiBuildingTarget[] = []
): AiOutcome {
  const outcome: AiOutcome = {
    meleeDamage: [],
    projectileFires: [],
    aoeConeApplications: [],
    positionDirty: false,
  };

  if (!enemy.alive) return outcome;

  const tpl = enemy.template;

  // ---------- target acquisition ----------
  // During a horde, building targets are passed in with priorities. The
  // AI picks the highest-priority building in sense range; otherwise it
  // falls back to the nearest visible player. If no player is visible
  // but we lost LoS recently, push toward the last-known position for
  // a grace window — keeps enemies from looking robotic when the
  // player ducks behind a wall.
  let target = pickTarget(enemy, players, buildingTargets, env);
  if (target && target.kind === 'player') {
    enemy.lastKnownTargetX = target.x;
    enemy.lastKnownTargetY = target.y;
    enemy.lastKnownTargetExpiresAt = now + AGGRO_MEMORY_MS;
  } else if (!target && now < enemy.lastKnownTargetExpiresAt) {
    target = {
      kind: 'player',
      characterId: '',
      x: enemy.lastKnownTargetX,
      y: enemy.lastKnownTargetY,
    };
  }
  enemy.targetCharacterId =
    target && target.kind === 'player' ? target.characterId : null;

  // ---------- state transitions ----------
  if (!target) {
    enemy.fsm = 'idle';
  } else if (
    tpl.fleeBelowHpRatio !== null &&
    enemy.hp / enemy.maxHp <= tpl.fleeBelowHpRatio
  ) {
    enemy.fsm = 'fleeing';
  } else {
    enemy.fsm = 'engaging';
  }

  // ---------- hit-stun ----------
  // While stunned, the enemy holds position and doesn't fire. Stun is
  // applied externally by Scene.damageEnemy.
  const stunned = now < enemy.stunUntil;
  // A stun taken mid-windup cancels the committed swing. Without
  // this the enemy freezes through the stun and the queued hit
  // lands the instant it expires — reads as a frozen-then-sudden
  // hit with no re-telegraph. Half the cooldown as the penalty so
  // stun-locking still has a cost ceiling for the player.
  if (stunned) {
    for (let i = 0; i < enemy.attackSwingAt.length; i++) {
      if (enemy.attackSwingAt[i] <= 0) continue;
      enemy.attackSwingAt[i] = 0;
      const atk = enemy.template.attacks[i];
      const cooldownMs =
        atk && atk.kind === 'melee' ? (atk.cooldownMs ?? 1200) : 1200;
      enemy.attackReadyAt[i] = Math.max(
        enemy.attackReadyAt[i] ?? 0,
        now + cooldownMs / 2,
      );
    }
  }

  // ---------- movement ----------
  const prevX = enemy.x;
  const prevY = enemy.y;

  // Melee enemies that have already committed to a swing stop
  // moving until the swing resolves — gives the player a clear
  // "I'm about to be hit" telegraph instead of sprinting into
  // contact damage. Order matters: attack resolution runs after
  // this so the swing can still land at the end of this tick.
  const windingUp = isWindingUpMelee(enemy);
  if (!stunned && target && enemy.fsm === 'engaging' && !windingUp) {
    applyMovement(enemy, target, dt, now, env);
  } else if (!stunned && target && enemy.fsm === 'fleeing') {
    applyFlee(enemy, target, dt, now, env);
  } else if (!stunned && !target && enemy.template.moveSpeed > 0) {
    // Idle wander — the FSM has no aggro target so the enemy drifts
    // around its spawn point, pausing at each waypoint, picking a new
    // one when the pause expires. Sells "the dungeon is alive" without
    // making enemies chase you across rooms.
    applyWander(enemy, dt, now, env);
  }
  // Stationary templates (turret-style dummies) stand still.

  if (
    Math.abs(enemy.x - enemy.lastBroadcastX) > POSITION_BROADCAST_EPSILON ||
    Math.abs(enemy.y - enemy.lastBroadcastY) > POSITION_BROADCAST_EPSILON
  ) {
    outcome.positionDirty = true;
  }
  // Suppress unused-var lint: prev{X,Y} are useful when we add deltas/anti-jitter.
  void prevX;
  void prevY;

  // ---------- attacks ----------
  if (!stunned && target && enemy.fsm === 'engaging') {
    runAttacks(enemy, target, dt, now, outcome);
  }

  return outcome;
}

function pickTarget(
  enemy: EnemyRuntime,
  players: AiPlayer[],
  buildingTargets: AiBuildingTarget[],
  env: AiEnvironment
): AiTarget | null {
  const r = enemy.template.senseRadius;

  // Buildings come first whenever any are passed in. The list is already
  // pre-filtered by world state (currently only the surface scene during
  // horde populates it), so its mere presence signals "this enemy is in
  // a horde — go zerg the base." We deliberately ignore both sense
  // radius AND line-of-sight here: wave-spawned enemies appear well
  // outside any reasonable sense radius from the base, and the design
  // intent is that hordes know where the alien tech is.
  let bestBuilding: AiBuildingTarget | null = null;
  let bestBuildingPriority = -Infinity;
  let bestBuildingDist = Infinity;
  for (const b of buildingTargets) {
    const dx = b.x - enemy.x;
    const dy = b.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (
      b.priority > bestBuildingPriority ||
      (b.priority === bestBuildingPriority && dist < bestBuildingDist)
    ) {
      bestBuilding = b;
      bestBuildingPriority = b.priority;
      bestBuildingDist = dist;
    }
  }
  if (bestBuilding) {
    return {
      kind: 'building',
      buildingId: bestBuilding.buildingId,
      x: bestBuilding.x,
      y: bestBuilding.y,
    };
  }

  // Otherwise fall back to nearest visible player.
  let bestPlayer: AiPlayer | null = null;
  let bestDist = r;
  for (const p of players) {
    const dx = p.x - enemy.x;
    const dy = p.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (dist > bestDist) continue;
    if (env.lineOfSight && !env.lineOfSight(enemy.x, enemy.y, p.x, p.y)) continue;
    bestPlayer = p;
    bestDist = dist;
  }
  if (bestPlayer) {
    return {
      kind: 'player',
      characterId: bestPlayer.characterId,
      x: bestPlayer.x,
      y: bestPlayer.y,
    };
  }
  return null;
}

// Try to commit (proposedX, proposedY). On wall hit, slide along the
// nearer axis. If both fail, stay put. Tests the enemy's full bounding
// circle, not just the centre, via collisionTest(x, y, radius).
function moveWithCollision(
  enemy: EnemyRuntime,
  proposedX: number,
  proposedY: number,
  env: AiEnvironment
): void {
  if (!env.collisionTest) {
    enemy.x = proposedX;
    enemy.y = proposedY;
    return;
  }
  const test = env.collisionTest;
  const r = enemy.template.radius;
  if (test(proposedX, proposedY, r)) {
    enemy.x = proposedX;
    enemy.y = proposedY;
    return;
  }
  if (test(proposedX, enemy.y, r)) {
    enemy.x = proposedX;
    return;
  }
  if (test(enemy.x, proposedY, r)) {
    enemy.y = proposedY;
    return;
  }
  // Stuck — don't move.
}

function applyMovement(
  enemy: EnemyRuntime,
  target: AiTarget,
  dt: number,
  now: number,
  env: AiEnvironment
): void {
  const m = enemy.template.movement;
  if (m.kind === 'stationary') return;

  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return;
  const ux = dx / dist;
  const uy = dy / dist;
  const speed = enemy.template.moveSpeed * currentEnemySpeedMult(enemy) * dt;

  if (m.kind === 'chase') {
    // Hold a standoff at melee range so chasers don't walk into
    // body-contact with the player before swinging — reads as
    // "attacking from a step away" rather than clipping in. The
    // standoff is a fixed body-clearance pad (~1.5 tiles) added on
    // top of the player+enemy radii, capped just inside the
    // declared melee range so swings still land.
    const MELEE_STANDOFF_PAD = 48;
    let stop = 0;
    for (const atk of enemy.template.attacks) {
      if (atk.kind === 'melee') {
        // Stay at least MELEE_STANDOFF_PAD away, but never further
        // than 12px inside the declared attack range — otherwise
        // long-armed enemies sit out of swing.
        stop = Math.min(
          Math.max(0, atk.range - 12),
          MELEE_STANDOFF_PAD,
        );
        break;
      }
    }
    if (stop > 0 && dist <= stop) {
      enemy.waypointX = null;
      enemy.waypointY = null;
      return;
    }
    // Active waypoint from a previous blocked tick: steer toward it
    // until reached or the repath window lapses, then re-evaluate
    // the direct line.
    if (enemy.waypointX !== null && enemy.waypointY !== null) {
      const wdx = enemy.waypointX - enemy.x;
      const wdy = enemy.waypointY - enemy.y;
      const wdist = Math.hypot(wdx, wdy);
      if (wdist < WAYPOINT_REACH || now >= enemy.repathAt) {
        enemy.waypointX = null;
        enemy.waypointY = null;
      } else {
        moveWithCollision(
          enemy,
          enemy.x + (wdx / wdist) * speed,
          enemy.y + (wdy / wdist) * speed,
          env,
        );
        return;
      }
    }
    const beforeX = enemy.x;
    const beforeY = enemy.y;
    moveWithCollision(enemy, enemy.x + ux * speed, enemy.y + uy * speed, env);
    // Direct line blocked (no progress even with axis-slides) —
    // path around the obstacle on the tile grid. Throttled so a
    // wall-pinned enemy doesn't BFS every tick.
    if (
      enemy.x === beforeX &&
      enemy.y === beforeY &&
      env.nextWaypoint &&
      now >= enemy.repathAt
    ) {
      enemy.repathAt = now + REPATH_INTERVAL_MS;
      const wp = env.nextWaypoint(enemy.x, enemy.y, target.x, target.y);
      if (wp) {
        enemy.waypointX = wp.x;
        enemy.waypointY = wp.y;
      }
    }
    return;
  }

  if (m.kind === 'kite') {
    if (dist < m.minRange) {
      const beforeX = enemy.x;
      const beforeY = enemy.y;
      moveWithCollision(enemy, enemy.x - ux * speed, enemy.y - uy * speed, env);
      if (enemy.x === beforeX && enemy.y === beforeY) {
        // Cornered — back-away (and both axis slides) blocked.
        // Strafe along the wall instead of freezing in place so the
        // drone keeps fighting and eventually slips the corner.
        const sx = -uy * enemy.strafeDirection;
        const sy = ux * enemy.strafeDirection;
        moveWithCollision(
          enemy,
          enemy.x + sx * speed,
          enemy.y + sy * speed,
          env,
        );
      }
    } else if (dist > m.maxRange) {
      moveWithCollision(enemy, enemy.x + ux * speed, enemy.y + uy * speed, env);
    } else {
      // Inside the comfort band: drift sideways so drones aren't
      // visually frozen while firing. Strafe direction holds for a
      // window then re-rolls.
      if (now >= enemy.strafeUntil) {
        enemy.strafeDirection = Math.random() < 0.5 ? -1 : 1;
        enemy.strafeUntil =
          now +
          STRAFE_WINDOW_MIN_MS +
          Math.random() * (STRAFE_WINDOW_MAX_MS - STRAFE_WINDOW_MIN_MS);
      }
      // Perpendicular to (ux,uy) is (-uy, ux). Half-speed sideways.
      const sx = -uy * enemy.strafeDirection;
      const sy = ux * enemy.strafeDirection;
      const strafeSpeed = enemy.template.moveSpeed * 0.5 * currentEnemySpeedMult(enemy) * dt;
      moveWithCollision(
        enemy,
        enemy.x + sx * strafeSpeed,
        enemy.y + sy * strafeSpeed,
        env
      );
    }
  }
}

// Waypoint-steering tuning. REPATH_INTERVAL throttles per-enemy BFS
// requests AND bounds a stale waypoint's lifetime; REACH is the
// arrive radius before re-checking the direct line.
const REPATH_INTERVAL_MS = 450;
const WAYPOINT_REACH = 10;
// How far past the enemy a blocked flee aims its retreat point.
const FLEE_RETREAT_DIST = 160;

// Wander tuning. Radius from spawn the enemy can roam, distance threshold
// at which a waypoint counts as reached, idle pause range, and the speed
// scale applied to the template's normal moveSpeed during wander.
const WANDER_RADIUS = 160;
const WANDER_REACH = 6;
const WANDER_PAUSE_MIN_MS = 1500;
const WANDER_PAUSE_MAX_MS = 4000;
const WANDER_SPEED_MULT = 0.4;

// How long after losing LoS the enemy keeps pushing toward the player's
// last known position. Stops aggro from snapping off the moment the
// player ducks behind a wall — the enemy investigates briefly first.
const AGGRO_MEMORY_MS = 1500;
// Strafe window for kite drones — pick a sideways drift direction and
// hold it for this long before re-rolling.
const STRAFE_WINDOW_MIN_MS = 700;
const STRAFE_WINDOW_MAX_MS = 1600;

// Melee defaults when the template doesn't pin them. Cooldown is
// the gap between hits the player feels (was 0 — every server
// tick at ~50ms). Windup is the telegraph window during which
// the enemy stands still committing to the swing.
const MELEE_DEFAULT_COOLDOWN_MS = 1200;
const MELEE_DEFAULT_WINDUP_MS = 350;

// True iff any melee attack is currently in its windup state.
// Movement halts during windup so the enemy reads as "I'm about
// to swing" rather than "I'm sprinting into you."
function isWindingUpMelee(enemy: EnemyRuntime): boolean {
  for (let i = 0; i < enemy.attackSwingAt.length; i++) {
    if (enemy.attackSwingAt[i] > 0) return true;
  }
  return false;
}

function applyWander(
  enemy: EnemyRuntime,
  dt: number,
  now: number,
  env: AiEnvironment
): void {
  // Pause window: stand still until it expires.
  if (now < enemy.wanderPauseUntil) return;

  const dx = enemy.wanderTargetX - enemy.x;
  const dy = enemy.wanderTargetY - enemy.y;
  const dist = Math.hypot(dx, dy);

  if (dist < WANDER_REACH) {
    // Arrived. Pick a new waypoint within the spawn-room radius and
    // set a pause before we head out again.
    const angle = Math.random() * Math.PI * 2;
    const r = 24 + Math.random() * (WANDER_RADIUS - 24);
    enemy.wanderTargetX = enemy.spawnX + Math.cos(angle) * r;
    enemy.wanderTargetY = enemy.spawnY + Math.sin(angle) * r;
    enemy.wanderPauseUntil =
      now +
      WANDER_PAUSE_MIN_MS +
      Math.random() * (WANDER_PAUSE_MAX_MS - WANDER_PAUSE_MIN_MS);
    return;
  }

  // Walk slowly toward the current waypoint, respecting collision so
  // wanderers can't push through walls.
  const ux = dx / dist;
  const uy = dy / dist;
  const speed = enemy.template.moveSpeed * WANDER_SPEED_MULT * currentEnemySpeedMult(enemy) * dt;
  moveWithCollision(enemy, enemy.x + ux * speed, enemy.y + uy * speed, env);
}

function applyFlee(
  enemy: EnemyRuntime,
  target: AiTarget,
  dt: number,
  now: number,
  env: AiEnvironment
): void {
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return;
  const speed = enemy.template.moveSpeed * currentEnemySpeedMult(enemy) * dt;
  // Active retreat waypoint from a previous blocked tick.
  if (enemy.waypointX !== null && enemy.waypointY !== null) {
    const wdx = enemy.waypointX - enemy.x;
    const wdy = enemy.waypointY - enemy.y;
    const wdist = Math.hypot(wdx, wdy);
    if (wdist < WAYPOINT_REACH || now >= enemy.repathAt) {
      enemy.waypointX = null;
      enemy.waypointY = null;
    } else {
      moveWithCollision(
        enemy,
        enemy.x + (wdx / wdist) * speed,
        enemy.y + (wdy / wdist) * speed,
        env,
      );
      return;
    }
  }
  const beforeX = enemy.x;
  const beforeY = enemy.y;
  moveWithCollision(
    enemy,
    enemy.x - (dx / dist) * speed,
    enemy.y - (dy / dist) * speed,
    env
  );
  // Retreat line blocked — path toward a fallback point behind the
  // enemy instead of grinding into the wall. The BFS returns its
  // closest-approach node when the exact point is unreachable, so
  // a cornered enemy still backs into the best available pocket.
  if (
    enemy.x === beforeX &&
    enemy.y === beforeY &&
    env.nextWaypoint &&
    now >= enemy.repathAt
  ) {
    enemy.repathAt = now + REPATH_INTERVAL_MS;
    const retreatX = enemy.x - (dx / dist) * FLEE_RETREAT_DIST;
    const retreatY = enemy.y - (dy / dist) * FLEE_RETREAT_DIST;
    const wp = env.nextWaypoint(enemy.x, enemy.y, retreatX, retreatY);
    if (wp) {
      enemy.waypointX = wp.x;
      enemy.waypointY = wp.y;
    }
  }
}

function runAttacks(
  enemy: EnemyRuntime,
  target: AiTarget,
  _dt: number,
  now: number,
  outcome: AiOutcome
): void {
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy);

  for (let i = 0; i < enemy.template.attacks.length; i++) {
    const atk = enemy.template.attacks[i];
    if (atk.kind === 'melee') {
      if (target.kind !== 'player') continue;
      // Building-only melee still ticks through
      // Scene.tickEnemyBuildingAttacks (continuous chew). The FSM
      // owns PLAYER melee only — and player melee runs in
      // discrete swings: ready → in-range → windup → resolve.
      const cooldownMs = atk.cooldownMs ?? MELEE_DEFAULT_COOLDOWN_MS;
      const windupMs = atk.windupMs ?? MELEE_DEFAULT_WINDUP_MS;
      if (enemy.attackSwingAt[i] > 0) {
        // Swing in flight. Resolve when the windup elapses; the
        // hit only lands if the player is still inside `range`.
        // Whiffing out of melee range during windup is the
        // intended dodge mechanic.
        if (now >= enemy.attackSwingAt[i]) {
          if (dist <= atk.range) {
            const damagePerHit =
              atk.damagePerSec * (cooldownMs / 1000);
            outcome.meleeDamage.push({
              targetCharacterId: target.characterId,
              amount: damagePerHit,
            });
          }
          enemy.attackSwingAt[i] = 0;
          enemy.attackReadyAt[i] = now + cooldownMs;
        }
        continue;
      }
      // Not winding up — start a swing when in range + cooldown
      // expired.
      if (dist <= atk.range && now >= enemy.attackReadyAt[i]) {
        enemy.attackSwingAt[i] = now + windupMs;
      }
    } else if (atk.kind === 'projectile') {
      if (dist > atk.range) continue;
      if (now < (enemy.attackReadyAt[i] ?? 0)) continue;
      enemy.attackReadyAt[i] = now + atk.cooldownMs;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) continue;
      outcome.projectileFires.push({
        ownerEnemyId: enemy.id,
        fromX: enemy.x,
        fromY: enemy.y,
        dirX: dx / len,
        dirY: dy / len,
        spec: atk,
      });
    } else if (atk.kind === 'aoe_cone') {
      if (dist > atk.range) continue;
      if (now < (enemy.attackReadyAt[i] ?? 0)) continue;
      enemy.attackReadyAt[i] = now + atk.cooldownMs;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) continue;
      outcome.aoeConeApplications.push({
        ownerEnemyId: enemy.id,
        originX: enemy.x,
        originY: enemy.y,
        axisX: dx / len,
        axisY: dy / len,
        range: atk.range,
        arcRad: atk.arcRad,
        effectKind: atk.effectKind,
        effectMagnitude: atk.effectMagnitude,
        effectDurationMs: atk.effectDurationMs,
        effectLabel: atk.effectLabel,
        coneColor: atk.coneColor,
      });
    }
  }
}

// Convenience: spin up an EnemyRuntime from a template at a given position.
// Lives here so room.ts and templates.ts only deal with template data.
export function instantiateEnemy(
  id: string,
  template: EnemyTemplate,
  x: number,
  y: number
): EnemyRuntime {
  return {
    id,
    kind: template.id,
    x,
    y,
    hp: template.maxHp,
    maxHp: template.maxHp,
    template,
    alive: true,
    spawnX: x,
    spawnY: y,
    respawnAt: null,
    fsm: 'idle',
    targetCharacterId: null,
    attackReadyAt: template.attacks.map(() => 0),
    attackSwingAt: template.attacks.map(() => 0),
    stunUntil: 0,
    lastBroadcastX: x,
    lastBroadcastY: y,
    // Wander seed: start at the spawn position, with no pause —
    // tickEnemy picks a fresh waypoint on the first idle frame.
    wanderTargetX: x,
    wanderTargetY: y,
    wanderPauseUntil: 0,
    lastKnownTargetX: 0,
    lastKnownTargetY: 0,
    lastKnownTargetExpiresAt: 0,
    strafeDirection: 1,
    strafeUntil: 0,
    waypointX: null,
    waypointY: null,
    repathAt: 0,
    activeEffects: [],
  };
}
