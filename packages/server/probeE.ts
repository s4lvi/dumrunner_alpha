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
  // Which live sectors contain test points near the 15<->26 doorway?
  for (const [tx, ty] of [[13, 18], [12, 18], [13, 17.5], [10, 18], [8, 20]]) {
    const px = tx * ts, py = ty * ts;
    const hits: number[] = [];
    for (let i = 0; i < map.sectors.length; i++) {
      const s = map.sectors[i];
      if (s.buildingKind !== undefined) continue;
      if (pip(s.verts, px, py)) hits.push(i);
    }
    console.log(`point (${tx},${ty}) inside sectors: [${hits.join(',')}]`);
  }
  // Dump the live sector whose verts START at (7,14) — the real room 15.
  for (let i = 0; i < map.sectors.length; i++) {
    const s = map.sectors[i];
    if (s.verts[0] && s.verts[0].x / ts === 7 && s.verts[0].y / ts === 14) {
      console.log(`live room-15 is sector index ${i}: ` + s.verts.map((v: any) => `(${v.x / ts},${v.y / ts})`).join(' '));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
