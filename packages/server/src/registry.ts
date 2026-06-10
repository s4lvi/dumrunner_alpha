import { World } from './world.js';
import { env } from './env.js';
import { supabase } from './supabase.js';
import type { WorldMode } from '@dumrunner/shared';

// In-process world registry. For the alpha, every server world runs as a
// World inside this single Node process. When we deploy multi-host, this
// becomes a real registry (servers table + spawn controller); the World
// class itself stays the same.
class Registry {
  private worlds = new Map<string, World>();
  // Holds the in-flight hydrate so concurrent joins don't double-load.
  private booting = new Map<string, Promise<World>>();

  async getOrCreate(serverId: string): Promise<World> {
    const existing = this.worlds.get(serverId);
    if (existing) return existing;

    const inFlight = this.booting.get(serverId);
    if (inFlight) return inFlight;

    const boot = (async () => {
      // Mode resolution priority:
      //   1. DM_MODE env var (dev override — every world becomes a
      //      deathmatch arena against DM_ARENA). Useful for local
      //      testing without Supabase rows.
      //   2. The `servers` row's `mode` + `arena_scene_id` columns
      //      (migration 0011).
      //   3. Default to 'live'.
      let mode: WorldMode = 'live';
      let arenaSceneId: string | null = null;
      if (env.deathmatchMode && env.deathmatchArena) {
        mode = 'deathmatch';
        arenaSceneId = env.deathmatchArena;
      } else {
        try {
          const { data: row } = await supabase
            .from('servers')
            .select('mode, arena_scene_id')
            .eq('id', serverId)
            .maybeSingle();
          if (row?.mode === 'deathmatch' && row?.arena_scene_id) {
            mode = 'deathmatch';
            arenaSceneId = row.arena_scene_id as string;
          }
        } catch (e) {
          // Older DB without the columns (migration 0011 not run).
          // Fall through to 'live' — log once per boot for clarity.
          console.warn(
            `[registry] could not read mode/arena_scene_id for ${serverId} ` +
              `(migration 0011 not applied?); defaulting to live.`,
          );
        }
      }
      const world = new World(serverId, { mode, arenaSceneId });
      await world.hydrate();
      this.worlds.set(serverId, world);
      console.log(
        `[registry] booted world for server ${serverId}` +
          (mode === 'deathmatch'
            ? ` (deathmatch, arena=${arenaSceneId})`
            : ''),
      );
      return world;
    })();
    this.booting.set(serverId, boot);
    try {
      return await boot;
    } finally {
      this.booting.delete(serverId);
    }
  }

  get(serverId: string): World | undefined {
    return this.worlds.get(serverId);
  }

  // Drop the cached World so the next getOrCreate spins up a fresh
  // hydrate. Used after a pause: the World tore down its timers +
  // cleared connections, so reusing the same instance leaves it in a
  // permanently-broken state ("pausing" stays true, timers are null).
  evict(serverId: string): void {
    if (this.worlds.delete(serverId)) {
      console.log(`[registry] evicted world for server ${serverId}`);
    }
  }
}

export const registry = new Registry();
