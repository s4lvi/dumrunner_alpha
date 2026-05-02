import type { EnemyState } from '@dumrunner/shared';
import type { EnemyFsmState, EnemyTemplate } from './types.js';

// Server-side runtime extension of EnemyState. Combines wire-visible fields
// with FSM bookkeeping so the AI tick can mutate state in one place.
export type EnemyRuntime = EnemyState & {
  template: EnemyTemplate;
  alive: boolean;
  spawnX: number;
  spawnY: number;
  respawnAt: number | null;

  fsm: EnemyFsmState;
  targetCharacterId: string | null;

  // Per-attack cooldown timestamps, one slot per template.attacks entry.
  // The attack at index i is ready when now >= attackReadyAt[i].
  attackReadyAt: number[];

  // Hit-stun expiry (epoch ms). While now < stunUntil the FSM skips
  // movement and attacks. Refreshed (not stacked) on each new hit.
  stunUntil: number;

  // Tracks the last broadcast position so we can skip no-op enemy_state
  // messages.
  lastBroadcastX: number;
  lastBroadcastY: number;

  // Idle-wander state. While `targetCharacterId` is null and the enemy
  // template can move, the FSM walks toward a randomly-chosen point
  // within WANDER_RADIUS of the spawn position, pauses briefly on
  // arrival, then picks a new point. A stationary template skips this.
  wanderTargetX: number;
  wanderTargetY: number;
  wanderPauseUntil: number;

  // Aggro memory — last position we saw the active player target at,
  // and the wall-clock deadline beyond which we should give up. Lets the
  // enemy keep pushing toward the last known location for a brief grace
  // window after LoS breaks, instead of immediately reverting to wander.
  lastKnownTargetX: number;
  lastKnownTargetY: number;
  lastKnownTargetExpiresAt: number;

  // Kite-strafe state for ranged drones. While inside the kite band
  // they pick a sideways drift direction (+1 or -1) and hold it for a
  // window so they don't visually freeze in place.
  strafeDirection: 1 | -1;
  strafeUntil: number;
};
