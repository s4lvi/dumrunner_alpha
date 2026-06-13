import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';

const noop: any = new Proxy({}, { get: () => () => undefined });

// Pull the sectorMap the SCENE actually uses for collision, and the
// doorway list, and show: for each broken room<->corridor edge, the
// room polygon vs the doorway span, to confirm chamfer ate the door.
async function inspect(seed: number, floor: number, edges: [number, number][]) {
  const layout: any = generateFloorLayout(seed, 1, floor, 'default');
  const meta = generateLockedRoomMeta(layout, seed, 1, floor);
  const scene = new Scene(`dungeon:${floor}`, 'dungeon_floor', noop, layout, null, null, meta.doors, null);
  scene.ensurePortalBuildings();
  const map = (scene as any).sectorMap;
  const ts = layout.tileSize;
  const dws = layout.doorways ?? [];
  console.log(`\n=== seed=${seed} f=${floor} ===`);
  for (const [a, b] of edges) {
    const dw = dws.find((d: any) => (d.a === a && d.b === b) || (d.a === b && d.b === a));
    console.log(`edge ${a}<->${b} doorway:`, dw ? `${dw.axis} coord=${dw.coord / ts} span=${dw.lo / ts}..${dw.hi / ts}` : 'NONE');
    for (const reg of [a, b]) {
      const s = map.sectors[reg];
      if (!s) { console.log(`  sector ${reg}: MISSING`); continue; }
      console.log(`  sector ${reg} fZ=${s.floorZ} cZ=${s.ceilingZ} verts: ` +
        s.verts.map((v: any) => `(${v.x / ts},${v.y / ts})`).join(' '));
    }
  }
}

async function main() {
  await initBiomes();
  await initRooms();
  await inspect(354, 1, [[15, 26], [16, 18], [14, 18]]);
  await inspect(382, 3, [[12, 27], [15, 27]]);
}
main().catch((e) => { console.error(e); process.exit(1); });
