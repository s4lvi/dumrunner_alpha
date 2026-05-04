// Enemy schema. The intent is mix-and-match: an EnemyTemplate composes a
// movement profile, zero or more attacks, and faction/visual identity. This is
// the same shape we'll feed a procedural generator later — for the alpha we
// hand-author a handful of templates that span the schema.

export type EnemyFaction =
  | 'neutral'
  | 'sun_bleached'
  | 'catacombs'
  | 'frozen'
  | 'alien_core';

export type EnemyVisual = {
  shape: 'square' | 'circle' | 'triangle';
  color: number;       // 0xRRGGBB
  size: number;        // half-extent in world units
};

// How an enemy moves while it has a target (or while idle, depending on FSM).
// For the alpha, "stationary", "chase", and "kite" cover the design space.
export type MovementProfile =
  | { kind: 'stationary' }
  | { kind: 'chase' }
  | {
      kind: 'kite';
      // Maintains distance roughly within [minRange, maxRange]. Below min we
      // back away; above max we close in; in the comfort band we hold position.
      minRange: number;
      maxRange: number;
    };

export type AttackSpec =
  | {
      kind: 'melee';
      range: number;            // contact range from enemy centre
      damagePerSec: number;     // applied while target is in range (continuous)
    }
  | {
      kind: 'projectile';
      range: number;            // max distance at which the enemy will fire
      cooldownMs: number;       // per-attack cooldown
      projectileSpeed: number;
      projectileDamage: number;
      projectileTtlMs: number;
      projectileRadius: number;
      projectileColor: number;  // 0xRRGGBB; client uses ownerKind+kind for variation
    }
  | {
      // Cone AoE — when in range, applies a status effect to every
      // player whose angle to the enemy lies within `arcRad` and
      // distance ≤ `range`. Used by flamethrower / chem-spitter
      // archetypes; the effect itself (kind, magnitude, duration)
      // is delivered via PlayerEffect, so adding new flavours
      // (cryo, acid, …) is data-only.
      kind: 'aoe_cone';
      range: number;
      cooldownMs: number;
      arcRad: number;
      effectKind:
        | 'burn_dps'
        | 'poison_dps'
        | 'slow_pct';
      effectMagnitude: number;
      effectDurationMs: number;
      effectLabel: string;
      // Display tint for client telegraph visuals.
      coneColor: number;
    };

export type EnemyTemplate = {
  // Stable id used as EnemyState.kind on the wire — the client uses it to
  // pick a visual.
  id: string;
  faction: EnemyFaction;

  maxHp: number;
  radius: number;
  moveSpeed: number;             // px/sec; 0 disables movement
  senseRadius: number;           // detect any live player within this radius

  // What the enemy does when it has a target.
  movement: MovementProfile;

  // List of attacks. Each is independently rate-gated. Attacks are evaluated
  // in order; a melee always tries first if in range, then projectiles.
  attacks: AttackSpec[];

  // If non-null, transitions to 'fleeing' when hp / maxHp drops below this.
  fleeBelowHpRatio: number | null;

  // Hit-stun duration in ms applied each time the enemy takes damage.
  // Tougher enemies set this lower (or 0 to be stun-immune). Stuns don't
  // stack; a fresh hit refreshes the timer to now + this value.
  stunDurationOnHitMs: number;

  // What this enemy drops on death (in addition to the part-roll system).
  // Empty array = no scavenge components.
  lootTable: LootDrop[];

  visual: EnemyVisual;
};

// Per-enemy FSM state.
export type EnemyFsmState = 'idle' | 'engaging' | 'fleeing' | 'dead';

// Loot table entry. Each row is rolled independently when the enemy dies;
// the part-drop system runs in addition (so kills can drop both parts and
// materials). Add new component drops as new rows.
export type LootDrop = {
  // Material id matching MaterialKind in shared/inventory.ts.
  materialId: string;
  // Probability (0..1) the row triggers.
  chance: number;
  // Inclusive count range when it does.
  min: number;
  max: number;
};
