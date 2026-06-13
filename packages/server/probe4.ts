import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
import { Scene } from './src/scene.js';
const noop: any = new Proxy({}, { get: () => () => undefined });
async function main() {
  await initBiomes(); await initRooms();
  // For every seed/floor, find tile-id-2 (wall) and pillar(0) cells,
  // and test whether the REAL Scene collision blocks standing there.
  let id2 = 0, id2Solid = 0, id2Walkable = 0;
  let centerStairsNonFloor = 0, centerStairsNeighborAllNonFloor = 0;
  for (let seed = 1; seed <= 30; seed++) for (let floor = 1; floor <= 3; floor++) {
    const layout: any = generateFloorLayout(seed, 1, floor, 'default');
    const scene = new Scene(`dungeon:${floor}`, 'dungeon_floor', noop, layout);
    scene.ensurePortalBuildings();
    const g = layout.tileGrid;
    const t = Buffer.from(g.tilesB64, 'base64');
    const ts = g.tileSize;
    for (let ly=0; ly<g.height; ly++) for (let lx=0; lx<g.width; lx++) {
      if (t[ly*g.width+lx] !== 2) continue;
      id2++;
      const tx = lx + g.originTileX, ty = ly + g.originTileY;
      const cx = (tx+0.5)*ts, cy=(ty+0.5)*ts;
      const p = (scene as any).circlePassable(cx, cy, 10);
      if (p) id2Walkable++; else id2Solid++;
    }
    // stairs center tile id + neighbour ids (tile-grid view)
    const stairs = layout.interactables.find((i:any)=>i.kind==='stairs_down');
    if (stairs) {
      const tx = Math.floor(stairs.x/ts), ty = Math.floor(stairs.y/ts);
      const tidAt = (gx:number,gy:number)=>{const lx=gx-g.originTileX,ly=gy-g.originTileY; if(lx<0||ly<0||lx>=g.width||ly>=g.height)return 0; return t[ly*g.width+lx];};
      if (tidAt(tx,ty)!==1) { centerStairsNonFloor++; console.log(`stairs center NON-FLOOR(tile-grid) seed=${seed} f=${floor} id=${tidAt(tx,ty)}`); }
      const nbrs=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>tidAt(tx+dx,ty+dy));
      if (nbrs.every(n=>n!==1)) { centerStairsNeighborAllNonFloor++; console.log(`stairs all-nbr NON-FLOOR seed=${seed} f=${floor}`); }
    }
  }
  console.log({ id2, id2Solid, id2Walkable, centerStairsNonFloor, centerStairsNeighborAllNonFloor });
}
main().catch(e=>{console.error(e);process.exit(1);});
