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
async function main() {
  await initBiomes();
  await initRooms();
  const layout: any = generateFloorLayout(354, 1, 'default');
  const meta = generateLockedRoomMeta(layout, 354, 1, 1);
  const scene = new Scene('dungeon:1', 'dungeon_floor', noop, layout, null, null, meta.doors, null);
  scene.ensurePortalBuildings();
  const map = (scene as any).sectorMap;
  const ts = 32;
  // All sectors whose bbox overlaps the room-15 region (tiles x4..14 y14..28)
  console.log('sectors overlapping room-15 bbox:');
  for (let i = 0; i < map.sectors.length; i++) {
    const s = map.sectors[i];
    const xs = s.verts.map((v: any) => v.x / ts), ys = s.verts.map((v: any) => v.y / ts);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    if (maxx < 4 || minx > 14 || maxy < 14 || miny > 28) continue;
    console.log(`  s${i} fZ=${s.floorZ} cZ=${s.ceilingZ} bk=${s.buildingKind} holes=${(s.holes || []).length} verts: ` +
      s.verts.map((v: any) => `(${v.x / ts},${v.y / ts})`).join(' '));
    if (s.holes && s.holes.length) for (const h of s.holes) console.log(`      hole: ` + h.map((v: any) => `(${v.x / ts},${v.y / ts})`).join(' '));
  }
  // coverage grid: for each tile in room-15 bbox, count covering NON-building sectors
  console.log('\ncoverage map (digit=#sectors, .=0):');
  for (let ty = 14; ty < 28; ty++) {
    let line = `y=${ty} `;
    for (let tx = 4; tx < 14; tx++) {
      let c = 0;
      for (const s of map.sectors) { if (s.buildingKind !== undefined) continue; if (pip(s.verts, (tx + 0.5) * ts, (ty + 0.5) * ts)) c++; }
      line += c === 0 ? '.' : String(c);
    }
    console.log(line);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
