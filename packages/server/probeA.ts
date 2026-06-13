import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';

const noop: any = new Proxy({}, { get: () => () => undefined });
const R = 10;

async function inspect(seed: number, floor: number) {
  const layout: any = generateFloorLayout(seed, 1, floor, 'default');
  const meta = generateLockedRoomMeta(layout, seed, 1, floor);
  const scene = new Scene(`dungeon:${floor}`, 'dungeon_floor', noop, layout, null, null, meta.doors, null);
  scene.ensurePortalBuildings();
  const ts = layout.tileSize;
  const pass = (x: number, y: number) => (scene as any).circlePassable(x, y, R) as boolean;
  const dws = layout.doorways ?? [];

  // For each doorway, sample MANY crossing lines spanning the open
  // portal span (lo..hi) and test if ANY crosses with the real
  // swept-circle predicate. This is robust to offset corridors.
  const sweep = (a: number, b: number, c: number, d: number) =>
    (scene as any).circleSweepPassable(a, b, c, d, R, 0, 0, false) as boolean;
  const doorwayPassable = (dw: any): boolean => {
    const samples = 9;
    for (let k = 0; k <= samples; k++) {
      const t = dw.lo + ((dw.hi - dw.lo) * k) / samples;
      if (dw.axis === 'vertical') {
        const x = dw.coord, y = t;
        if (pass(x - ts, y) && pass(x + ts, y) && sweep(x - ts, y, x + ts, y)) return true;
      } else {
        const y = dw.coord, x = t;
        if (pass(x, y - ts) && pass(x, y + ts) && sweep(x, y - ts, x, y + ts)) return true;
      }
    }
    return false;
  };

  // Doorway-graph adjacency, but only via PHYSICALLY passable doorways.
  const rooms = layout.rooms;
  const stairs = layout.interactables.find((i: any) => i.kind === 'stairs_down');
  let sridx = -1, spidx = -1;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (stairs.x >= r.x && stairs.x < r.x + r.w && stairs.y >= r.y && stairs.y < r.y + r.h) sridx = i;
    if (layout.spawn.x >= r.x && layout.spawn.x < r.x + r.w && layout.spawn.y >= r.y && layout.spawn.y < r.y + r.h) spidx = i;
  }
  const sealed: string[] = [];
  for (const dw of dws) {
    if (!doorwayPassable(dw)) {
      const locked = meta.lockedRoomIndices.includes(dw.a) || meta.lockedRoomIndices.includes(dw.b);
      sealed.push(`${dw.a}<->${dw.b}${locked ? ' (locked)' : ''}`);
    }
  }
  console.log(`seed=${seed} f=${floor} spawn=${spidx} stairs=${sridx}`);
  console.log('  physically SEALED doorways:', sealed.join(', '));
}

async function main() {
  await initBiomes();
  await initRooms();
  await inspect(354, 1);
  await inspect(382, 3);
}
main().catch((e) => { console.error(e); process.exit(1); });
