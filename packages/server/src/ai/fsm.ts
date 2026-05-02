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
  // True if the enemy moved enough to warrant a position broadcast.
  positionDirty: boolean;
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
    positionDirty: false,
  };

  if (!enemy.alive) return outcome;

  const tpl = enemy.template;

  // ---------- target acquisition ----------
  // During a horde, building targets are passed in with priorities. The
  // AI picks the highest-priority building in sense range; otherwise it
  // falls back to the nearest visible player.
  const target = pickTarget(enemy, players, buildingTargets, env);
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
    applyMovement(enemy, target, dt, env);
  } else if (!stunned && target && enemy.fsm === 'fleeing') {
    applyFlee(enemy, target, dt, env);
  }
  // 'idle' = stand still for now. Future: patrol module.

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

  // Buildings come first when any are in range. They're already supplied
  // pre-filtered by world state (only the surface scene during horde
  // currently passes any), with priority encoded so a Power Link beats a
  // turret beats a wall. We deliberately ignore line-of-sight for
  // buildings — enemies can hear/sense the base from across the surface.
  let bestBuilding: AiBuildingTarget | null = null;
  let bestBuildingPriority = -Infinity;
  let bestBuildingDist = Infinity;
  for (const b of buildingTargets) {
    const dx = b.x - enemy.x;
    const dy = b.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (dist > r) continue;
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
    }
    // Inside the comfort band: hold position.
  }
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
  };
}
