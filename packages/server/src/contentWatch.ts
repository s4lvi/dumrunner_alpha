// Content hot-reload. Watches the per-area JSON directories
// under packages/shared/content/* and re-runs the registry init
// helpers whenever a file changes. Lets authors save in the
// editor and see the change in the sandbox without restarting
// the dev server.
//
// Triggers on any save (editor POST, hand-edit, git pull, etc.).
// Debounced ~250 ms because most editors fire multiple fs events
// per save (write tmp + rename, etc.).
//
// Scope: refreshes the in-memory registries (BIOMES, ROOMS,
// PROPS, TEMPLATES). Already-running scenes keep their snapshot
// of templates baked in — a regen / scene_changed picks up new
// content. That's the right semantic for the sandbox; the live
// game gets fresh content on the next perihelion regen.

import { watch, type FSWatcher } from 'node:fs';
import { contentDir } from '@dumrunner/shared/content/loader';

const AREAS = [
  'biomes',
  'enemies',
  'props',
  'rooms',
  'corridors',
] as const;
const DEBOUNCE_MS = 250;

export type ContentReloader = {
  // Reload the area's registry. Implementations call the matching
  // init helper (initBiomes / initRooms / initProps / initTemplates
  // / initCorridors). Some areas (enemies) have downstream effects —
  // when an EnemyDef changes, both the shared visuals registry AND
  // the server-side AI templates need to refresh. The implementation
  // owns ordering.
  biomes(): Promise<void>;
  enemies(): Promise<void>;
  props(): Promise<void>;
  rooms(): Promise<void>;
  corridors(): Promise<void>;
};

export function startContentWatch(reloader: ContentReloader): () => void {
  const watchers: FSWatcher[] = [];
  // One debounce timer per area so a flurry of saves to one
  // area doesn't suppress reloads in other areas.
  const timers: Partial<Record<(typeof AREAS)[number], ReturnType<typeof setTimeout>>> = {};

  for (const area of AREAS) {
    let w: FSWatcher;
    try {
      w = watch(
        contentDir(area),
        { recursive: false },
        (_event, filename) => {
          if (!filename || !String(filename).endsWith('.json')) return;
          const existing = timers[area];
          if (existing) clearTimeout(existing);
          timers[area] = setTimeout(() => {
            timers[area] = undefined;
            console.log(
              `[content] ${area}/${filename} changed — reloading registry`,
            );
            void reloader[area]().catch((err: unknown) => {
              console.error(
                `[content] reload of ${area} failed:`,
                err instanceof Error ? err.message : err,
              );
            });
          }, DEBOUNCE_MS);
        },
      );
    } catch (err) {
      // Directory may not exist yet (fresh repo); fail soft.
      console.warn(
        `[content] could not watch ${area}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    watchers.push(w);
  }

  if (watchers.length > 0) {
    console.log(
      `[content] watching ${watchers.length} content dirs for hot-reload`,
    );
  }

  return () => {
    for (const t of Object.values(timers)) {
      if (t) clearTimeout(t);
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  };
}
