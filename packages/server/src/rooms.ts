// Server-side room template registry. Loaded from
// packages/shared/content/rooms/<id>.json at boot. The pipeline
// reaches the actual eligibility / pick / stamp helpers via
// @dumrunner/shared/roomTemplates — this file just hosts the
// hot-reloadable registry of templates loaded from disk.

import { loadRooms } from '@dumrunner/shared/content/loader';
import type { RoomTemplate } from '@dumrunner/shared';

export const ROOMS: Record<string, RoomTemplate> = {};

export async function initRooms(): Promise<void> {
  const defs = await loadRooms();
  for (const k of Object.keys(ROOMS)) delete ROOMS[k];
  for (const def of defs) ROOMS[def.id] = def;
  if (defs.length === 0) {
    console.warn(
      '[rooms] no room templates authored; procgen falls back to rect rooms',
    );
  } else {
    console.log(
      `[rooms] loaded ${defs.length} templates: ${defs.map((d: RoomTemplate) => d.id).join(', ')}`,
    );
  }
}

// Re-export the shared helpers so any in-tree caller that imported
// them from here keeps working.
export {
  eligibleTemplates,
  pickTemplate,
  stampTemplate,
  templateTiles,
} from '@dumrunner/shared';
