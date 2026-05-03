// On-demand asset_gen client. Hooks into entity-creation paths; the
// first time the live game sees an enemy template / building kind /
// material drop in this process, fires `POST /v1/assets/generate` to
// asset_gen so a sprite is queued for it. Cache keys on the asset_gen
// side dedup, so even without the per-process Set this is idempotent —
// the Set just keeps us from spamming the network.
//
// All calls are fire-and-forget. Failure to reach asset_gen never
// affects gameplay; the client falls back to procedural geometry.

import {
  buildingAssetRequest,
  enemyAssetRequest,
  materialAssetRequest,
  projectileAssetRequest,
  type AssetGenerateRequest,
} from '@dumrunner/asset_gen';
import type { BuildingKind, MaterialKind } from '@dumrunner/shared';
import { BUILDING_KINDS } from '@dumrunner/shared';
import type { EnemyTemplate } from './ai/types.js';
import { env } from './env.js';

// Re-export so callers (e.g. prewarm scripts) have a canonical list.
export { BUILDING_KINDS };

// Editorial labels per enemy template — drives the prompt's "Subject"
// line. Falls back to a snake_case → words conversion when missing.
const ENEMY_LABELS: Record<string, string> = {
  dummy_target: 'scrap target dummy',
  chaser_melee: 'rat-like tunnel scavenger',
  shooter_drone: 'frosted shooter drone',
  brute_chaser: 'sun-bleached armored brute',
  swarmer: 'swarming insectoid mutant',
  armored: 'heavy-plate armored juggernaut',
};

function labelForEnemy(templateId: string): string {
  return ENEMY_LABELS[templateId] ?? templateId.replace(/_/g, ' ').trim();
}

function numberColorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

// Per-process dedup. If we've already fired a request with this key,
// skip — asset_gen would dedup anyway, but this saves the network hop
// and keeps the asset_gen log readable.
const fired = new Set<string>();

async function postGenerate(req: AssetGenerateRequest): Promise<void> {
  if (!env.assetGenUrl) return;
  const key = req.requestId ?? `${req.assetKind}:${req.gameObject.id}`;
  if (fired.has(key)) return;
  fired.add(key);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (env.assetGenServiceToken) {
    headers.authorization = `Bearer ${env.assetGenServiceToken}`;
  }
  try {
    const response = await fetch(`${env.assetGenUrl}/v1/assets/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(
        `[asset_gen] generate ${key} rejected ${response.status}: ${text.slice(0, 160)}`
      );
      // Reset the dedup flag so a retry can happen on next entity
      // creation — could be a transient asset_gen outage.
      fired.delete(key);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[asset_gen] generate ${key} failed: ${message}`);
    fired.delete(key);
  }
}

export function ensureEnemyAsset(template: EnemyTemplate): void {
  void postGenerate(
    enemyAssetRequest({
      templateId: template.id,
      label: labelForEnemy(template.id),
      faction: template.faction,
      color: numberColorToHex(template.visual.color),
      radius: template.radius,
      movementKind: template.movement.kind,
      attackKinds: template.attacks.map((a) => a.kind),
    })
  );
  for (const attack of template.attacks) {
    if (attack.kind === 'projectile') {
      void postGenerate(
        projectileAssetRequest({
          id: `${template.id}_projectile`,
          label: `${labelForEnemy(template.id)} projectile`,
          color: numberColorToHex(attack.projectileColor ?? 0xffffff),
        })
      );
    }
  }
}

export function ensureBuildingAsset(kind: BuildingKind): void {
  void postGenerate(buildingAssetRequest(kind));
}

export function ensureMaterialAsset(materialId: MaterialKind): void {
  void postGenerate(materialAssetRequest(materialId));
}
