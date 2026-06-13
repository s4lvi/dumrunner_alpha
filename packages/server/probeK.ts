import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';

const noop: any = new Proxy({}, { get: () => () => undefined });
const R = 10;

function reachInteract(scene: Scene, layout: any, it: any): boolean {
  const ts = layout.tileSize;
  const sweep = (a: number, b: number, c: number, d: number) =>
    (scene as any).circleSweepPassable(a, b, c, d, R, 0, 0, false) as boolean;
  const pass = (x: number, y: number) => (scene as any).circlePassable(x, y, R) as boolean;
  const step = ts / 4;
  const key = (x: number, y: number) => `${Math.round(x)}:${Math.round(y)}`;
  const reached = new Set<string>();
  const sx = Math.round(layout.spawn.x / step) * step, sy = Math.round(layout.spawn.y / step) * step;
  const q: number[][] = [[sx, sy]];
  reached.add(key(sx, sy));
  const dirs = [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [step, -step], [-step, step], [-step, -step]];
  const hit = (x: number, y: number) => {
    const dx = x - it.x, dy = y - it.y;
    return dx * dx + dy * dy <= 40 * 40 && pass(x, y);
  };
  if (hit(sx, sy)) return true;
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (reached.has(k)) continue;
      if (!pass(nx, ny)) continue;
      if (!sweep(x, y, nx, ny)) continue;
      if (hit(nx, ny)) return true;
      reached.add(k);
      q.push([nx, ny]);
    }
  }
  return false;
}

async function main() {
  await initBiomes();
  await initRooms();
  const N = Number(process.argv[2] || '400');
  let checked = 0, fails = 0;
  const failList: string[] = [];
  for (let seed = 1; seed <= N; seed++) {
    for (let floor = 1; floor <= 3; floor++) {
      const layout: any = generateFloorLayout(seed, 1, floor, 'default');
      const meta = generateLockedRoomMeta(layout, seed, 1, floor);
      const scene = new Scene(`dungeon:${floor}`, 'dungeon_floor', noop, layout, null, null, meta.doors, null);
      scene.ensurePortalBuildings();
      checked++;
      const stairs = layout.interactables.find((i: any) => i.kind === 'stairs_down');
      const extract = layout.interactables.find((i: any) => i.kind === 'extract_pad');
      if (stairs && !reachInteract(scene, layout, stairs)) { fails++; failList.push(`seed=${seed} f=${floor} STAIRS`); }
      if (extract && !reachInteract(scene, layout, extract)) { fails++; failList.push(`seed=${seed} f=${floor} EXTRACT`); }
    }
  }
  console.log(`POST-FIX fine 8-dir sweep: ${checked} floors, ${fails} failures`);
  for (const f of failList) console.log('  ', f);
}
main().catch((e) => { console.error(e); process.exit(1); });
