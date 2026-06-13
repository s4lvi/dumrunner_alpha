import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
async function main() {
  await initBiomes(); await initRooms();
  const idCounts = new Map<number, number>();
  for (let seed = 1; seed <= 30; seed++) for (let floor = 1; floor <= 3; floor++) {
    const layout: any = generateFloorLayout(seed, 1, floor, 'default');
    const g = layout.tileGrid;
    const t = Buffer.from(g.tilesB64, 'base64');
    for (let i = 0; i < t.length; i++) idCounts.set(t[i], (idCounts.get(t[i])??0)+1);
  }
  console.log('tile id histogram:', [...idCounts.entries()].sort((a,b)=>a[0]-b[0]));
}
main().catch(e=>{console.error(e);process.exit(1);});
