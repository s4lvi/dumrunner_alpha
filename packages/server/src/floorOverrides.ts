// Server-side bootstrap for floor overrides. Reads the
// `content/floor-overrides.json` registry at boot, resolves
// every referenced scene id by loading + coercing its JSON into
// a PolygonSectorScene, and stashes both the registry and the
// pre-loaded scenes into the shared module's caches so the
// dungeon-floor creation path can do a sync lookup.

import {
  loadFloorOverrides,
  loadScenes,
} from '@dumrunner/shared/content/loader';
import {
  coerceAnySceneToPolygonScene,
  setFloorOverrides,
  setOverrideScene,
  clearOverrideScenes,
  type FloorOverrides,
} from '@dumrunner/shared';

export async function initFloorOverrides(): Promise<void> {
  let overrides: FloorOverrides;
  try {
    overrides = await loadFloorOverrides();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[floor-overrides] load failed:', e);
    overrides = {};
  }
  setFloorOverrides(overrides);
  clearOverrideScenes();

  // Pre-load every authored scene file into the cache. The
  // override registry references some of them; deathmatch worlds
  // reference others by id at boot. Doing it all here keeps the
  // dungeon-create + deathmatch-boot paths synchronous (no I/O
  // on the hot path), and authored content is small enough that
  // O(N) at startup is cheap.
  let scenes: Awaited<ReturnType<typeof loadScenes>> = [];
  try {
    scenes = await loadScenes();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[floor-overrides] loadScenes failed:', e);
  }
  let cached = 0;
  for (const raw of scenes) {
    try {
      const poly = coerceAnySceneToPolygonScene(raw);
      setOverrideScene(poly.id, poly);
      cached++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[floor-overrides] failed to coerce scene "${(raw as { id?: string }).id ?? '?'}":`,
        e,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[floor-overrides] ${cached} scene${cached === 1 ? '' : 's'} cached, ` +
      `${Object.keys(overrides.global ?? {}).length} global pin${Object.keys(overrides.global ?? {}).length === 1 ? '' : 's'}`,
  );
}
