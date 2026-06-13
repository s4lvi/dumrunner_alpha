import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';
const noop: any = new Proxy({}, { get: () => () => undefined });
const R=10;
async function main(){await initBiomes();await initRooms();
  const layout:any=generateFloorLayout(354,1,'default');
  const meta=generateLockedRoomMeta(layout,354,1,1);
  const scene=new Scene(`dungeon:1`,'dungeon_floor',noop,layout,null,null,meta.doors,null);
  scene.ensurePortalBuildings();
  process.env.MOVE_DEBUG='1';
  const ts=32;
  // doorway 28<->15 at y=14*32=448, x 7..11 -> cross from y=13.5 (corr28) to y=14.5 (room15)
  for(const tx of [8,9,10]){
    const x=(tx+0.5)*ts;
    console.log(`\n--- cross at x=${tx} (px ${x}) y 13->15 ---`);
    const r=(scene as any).circleSweepPassable(x, 13.5*ts, x, 14.5*ts, R, 0, 0, false);
    console.log('result=',r);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
