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

  // ---------- movement ----------
  const prevX = enemy.x;
  const prevY = enemy.y;

  if (!stunned && target && enemy.fsm === 'engaging') {
    applyMovement(enemy, target, dt, now, env);
  } else if (!stunned && target && enemy.fsm === 'fleeing') {
    applyFlee(enemy, target, dt, env);
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
  const speed = enemy.template.moveSpeed * dt;

  if (m.kind === 'chase') {
    moveWithCollision(enemy, enemy.x + ux * speed, enemy.y + uy * speed, env);
    return;
  }

  if (m.kind === 'kite') {
    if (dist < m.minRange) {
      moveWithCollision(enemy, enemy.x - ux * speed, enemy.y - uy * speed, env);
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
      const strafeSpeed = enemy.template.moveSpeed * 0.5 * dt;
      moveWithCollision(
        enemy,
        enemy.x + sx * strafeSpeed,
        enemy.y + sy * strafeSpeed,
        env
      );
    }
  }
}

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
  const speed = enemy.template.moveSpeed * WANDER_SPEED_MULT * dt;
  moveWithCollision(enemy, enemy.x + ux * speed, enemy.y + uy * speed, env);
}

function applyFlee(
  enemy: EnemyRuntime,
  target: AiTarget,
  dt: number,
  env: AiEnvironment
): void {
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return;
  const speed = enemy.template.moveSpeed * dt;
  moveWithCollision(
    enemy,
    enemy.x - (dx / dist) * speed,
    enemy.y - (dy / dist) * speed,
    env
  );
}

function runAttacks(
  enemy: EnemyRuntime,
  target: AiTarget,
  dt: number,
  now: number,
  outcome: AiOutcome
): void {
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy);

  for (let i = 0; i < enemy.template.attacks.length; i++) {
    const atk = enemy.template.attacks[i];
    if (atk.kind === 'melee') {
      if (dist <= atk.range && target.kind === 'player') {
        // Player melee — emit so scene applies HP damage. Building
        // melee already happens via Scene.tickEnemyBuildingAttacks
        // (any enemy in melee range of a wall/turret/etc. chews
        // through it regardless of declared target).
        outcome.meleeDamage.push({
          targetCharacterId: target.characterId,
          amount: atk.damagePerSec * dt,
        });
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
  };
}
