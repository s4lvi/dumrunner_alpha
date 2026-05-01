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
};
