import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';

const noop: any = new Proxy({}, { get: () => () => undefined });
function pip(verts: any[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const a = verts[i], b = verts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// count covering sectors EXCLUDING points inside any hole
function covers(map: any, px: number, py: number) {
  let c = 0;
  for (const s of map.sectors) {
    if (s.buildingKind !== undefined) continue;
    if (!pip(s.verts, px, py)) continue;
    let inHole = false;
    for (const h of (s.holes || [])) if (pip(h, px, py)) inHole = true;
    if (!inHole) c++;
  }
  return c;
}
async function main() {
  await initBiomes();
  await initRooms();
  const layout: any = generateFloorLayout(354, 1, 'default');
  const meta = generateLockedRoomMeta(layout, 354, 1, 1);
  const raw = layout.authoredSectorMap;
  const scene = new Scene('dungeon:1', 'dungeon_floor', noop, layout, null, null, meta.doors, null);
  scene.ensurePortalBuildings();
  const live = (scene as any).sectorMap;
  const ts = 32;
  console.log('RAW authoredSectorMap coverage (room-15 bbox x4..14 y14..28):');
  for (let ty = 14; ty < 28; ty++) {
    let line = `y=${ty} `;
    for (let tx = 4; tx < 14; tx++) line += String(covers(raw, (tx + 0.5) * ts, (ty + 0.5) * ts)) || '.';
    console.log(line);
  }
  console.log('\nrooms[15] rect:', layout.rooms[15], 'in tiles x', layout.rooms[15].x / ts, layout.rooms[15].y / ts);
}
main().catch((e) => { console.error(e); process.exit(1); });
