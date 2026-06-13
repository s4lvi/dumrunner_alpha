import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';

const noop: any = new Proxy({}, { get: () => () => undefined });
const R = 10;

async function main() {
  await initBiomes();
  await initRooms();
  const layout: any = generateFloorLayout(354, 1, 'default');
  const meta = generateLockedRoomMeta(layout, 354, 1, 1);
  const scene = new Scene('dungeon:1', 'dungeon_floor', noop, layout, null, null, meta.doors, null);
  scene.ensurePortalBuildings();
  const ts = 32;
  // doorway 15<->26 vertical x=14, y span 17..19. corridor 26 at x>=14
  // (x 14..18), room 15 at x<14. Cross from corridor (x=16.5) to room (x=13).
  process.env.MOVE_DEBUG = '1';
  for (const ty of [17.5, 18.0, 18.5]) {
    const y = ty * ts;
    console.log(`\n--- 15<->26 cross at y=${ty}: corridor(x=16) -> room(x=13) ---`);
    const r = (scene as any).circleSweepPassable(16 * ts, y, 13 * ts, y, R, 0, 0, false);
    console.log('result=', r);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
