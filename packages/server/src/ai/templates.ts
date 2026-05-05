// Server-side enemy template registry. Backed by JSON content
// under packages/shared/content/enemies/<id>.json — authored via
// the /editor/enemies UI. The TypeScript shape (EnemyTemplate,
// in ./types) stays as the runtime form scene.ts + combat code
// already use; this file just translates EnemyDef (hex colours
// in JSON) → EnemyTemplate (numeric colours in memory).
//
// initTemplates() must run before the WS server starts accepting
// connections — index.ts awaits it at module load.

import { loadEnemies } from '@dumrunner/shared/content/loader';
import { setEnemyVisuals } from '@dumrunner/shared';
import type {
  AttackSpec as ContentAttackSpec,
  EnemyDef,
  EnemyVisual,
} from '@dumrunner/shared';
import type { AttackSpec, EnemyTemplate } from './types.js';

export const TEMPLATES: Record<string, EnemyTemplate> = {};

// Surface is the player's base — peaceful by default. Enemies only
// appear here during perihelion hordes. Adding entries to this list
// spawns ambient enemies on the surface (debug only).
export const SURFACE_SPAWNS: { templateId: string; x: number; y: number }[] = [];

function hexToNumber(hex: string): number {
  // Accept "#RRGGBB" or "RRGGBB"; the schema validates the format
  // upstream so this is just a safe parseInt.
  const stripped = hex.startsWith('#') ? hex.slice(1) : hex;
  return parseInt(stripped, 16);
}

function convertAttack(a: ContentAttackSpec): AttackSpec {
  if (a.kind === 'projectile') {
    return { ...a, projectileColor: hexToNumber(a.projectileColor) };
  }
  if (a.kind === 'aoe_cone') {
    return { ...a, coneColor: hexToNumber(a.coneColor) };
  }
  return a;
}

function defToTemplate(def: EnemyDef): EnemyTemplate {
  return {
    id: def.id,
    faction: def.faction,
    maxHp: def.stats.hp,
    radius: def.stats.radius,
    moveSpeed: def.stats.moveSpeed,
    senseRadius: def.stats.senseRadius,
    movement: def.movement,
    attacks: def.attacks.map(convertAttack),
    fleeBelowHpRatio: def.fleeBelowHpRatio,
    stunDurationOnHitMs: def.stunDurationOnHitMs,
    lootTable: def.lootTable,
    visual: {
      shape: def.visual.shape,
      color: hexToNumber(def.visual.color),
      size: def.visual.size,
    },
  };
}

export async function initTemplates(): Promise<void> {
  const defs = await loadEnemies();
  if (defs.length === 0) {
    throw new Error(
      '[templates] no enemy JSON files found in packages/shared/content/enemies — server cannot boot. Author at least one enemy via /editor/enemies.',
    );
  }
  // Drop any prior contents (e.g. on hot-reload during dev).
  for (const k of Object.keys(TEMPLATES)) delete TEMPLATES[k];
  for (const def of defs) {
    TEMPLATES[def.id] = defToTemplate(def);
  }
  // Mirror the visual subset into shared/visuals so any local
  // shared-side enemyVisualFor() callers (e.g. server-side
  // logging or future systems) see the right palette.
  const visuals: Record<string, EnemyVisual> = {};
  for (const def of defs) {
    visuals[def.id] = {
      shape: def.visual.shape,
      color: hexToNumber(def.visual.color),
      size: def.visual.size,
    };
  }
  setEnemyVisuals(visuals);
  // eslint-disable-next-line no-console
  console.log(
    `[templates] loaded ${defs.length} enemy templates from JSON: ${defs
      .map((d) => d.id)
      .join(', ')}`,
  );
}

// Snapshot of just the visual fields, for the welcome-message
// payload that ships them to the client.
export function getEnemyVisualsForWire(): Record<string, EnemyVisual> {
  const out: Record<string, EnemyVisual> = {};
  for (const id of Object.keys(TEMPLATES)) {
    out[id] = TEMPLATES[id].visual;
  }
  return out;
}
