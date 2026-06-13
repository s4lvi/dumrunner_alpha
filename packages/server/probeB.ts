import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';

const noop: any = new Proxy({}, { get: () => () => undefined });
const R = 10;

// Real-Scene flood from spawn over a fine lattice, then report which
// rooms (by rect membership) were reached, so we can see exactly where
// the spawn-component ends along the doorway path.
async function inspect(seed: number, floor: number, path: number[]) {
  const layout: any = generateFloorLayout(seed, 1, floor, 'default');
  const meta = generateLockedRoomMeta(layout, seed, 1, floor);
  const scene = new Scene(`dungeon:${floor}`, 'dungeon_floor', noop, layout, null, null, meta.doors, null);
  scene.ensurePortalBuildings();
  const ts = layout.tileSize;
  const sweep = (a: number, b: number, c: number, d: number) =>
    (scene as any).circleSweepPassable(a, b, c, d, R, 0, 0, false) as boolean;
  const pass = (x: number, y: number) => (scene as any).circlePassable(x, y, R) as boolean;
  const step = ts / 2;
  const key = (x: number, y: number) => `${Math.round(x)}:${Math.round(y)}`;
  const reached = new Set<string>();
  const sx = Math.round(layout.spawn.x / step) * step, sy = Math.round(layout.spawn.y / step) * step;
  const q: number[][] = [[sx, sy]];
  reached.add(key(sx, sy));
  const dirs = [[step, 0], [-step, 0], [0, step], [0, -step]];
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (reached.has(k)) continue;
      if (!pass(nx, ny)) continue;
      if (!sweep(x, y, nx, ny)) continue;
      reached.add(k);
      q.push([nx, ny]);
    }
  }
  const rooms = layout.rooms;
  const roomReached = (i: number): boolean => {
    const r = rooms[i];
    for (const kk of reached) {
      const [x, y] = kk.split(':').map(Number);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
    }
    return false;
  };
  console.log(`seed=${seed} f=${floor} path reach:`);
  console.log('  ' + path.map((p) => `${p}:${roomReached(p) ? 'Y' : 'N'}`).join(' '));
}

async function main() {
  await initBiomes();
  await initRooms();
  await inspect(354, 1, [0, 19, 1, 30, 2, 20, 3, 23, 12, 28, 15, 26, 16]);
  await inspect(382, 3, [0, 24, 1, 20, 2, 22, 10, 15, 12, 27, 13, 28, 14]);
}
main().catch((e) => { console.error(e); process.exit(1); });
