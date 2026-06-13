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
  const dws = layout.doorways ?? [];
  const walkSec = (x: number, y: number) => (scene as any).walkableSectorAt(x, y, 1e9) != null;
  // A doorway is "dead" if EITHER side just past the portal centre has
  // no walkable sector — the portal opens into uncovered void.
  console.log(`\n=== seed=${seed} f=${floor} ===`);
  for (const dw of dws) {
    const locked = meta.lockedRoomIndices.includes(dw.a) || meta.lockedRoomIndices.includes(dw.b);
    if (locked) continue;
    const mid = (dw.lo + dw.hi) / 2;
    let aOk: boolean, bOk: boolean;
    if (dw.axis === 'vertical') {
      aOk = walkSec(dw.coord - ts * 0.5, mid);
      bOk = walkSec(dw.coord + ts * 0.5, mid);
    } else {
      aOk = walkSec(mid, dw.coord - ts * 0.5);
      bOk = walkSec(mid, dw.coord + ts * 0.5);
    }
    if (!aOk || !bOk) {
      console.log(`  DEAD doorway ${dw.a}<->${dw.b} ${dw.axis} coord=${dw.coord / ts} span=${dw.lo / ts}..${dw.hi / ts} sideA=${aOk} sideB=${bOk}`);
    }
  }
}

async function main() {
  await initBiomes();
  await initRooms();
  await inspect(354, 1);
  await inspect(382, 3);
}
main().catch((e) => { console.error(e); process.exit(1); });
