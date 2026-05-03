import { World } from './world.js';

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
      const world = new World(serverId);
      await world.hydrate();
      this.worlds.set(serverId, world);
      console.log(`[registry] booted world for server ${serverId}`);
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
