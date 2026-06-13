import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';
const noop: any = new Proxy({}, { get: () => () => undefined });
const R=10;
async function inspect(seed:number,floor:number){
  const layout:any=generateFloorLayout(seed,1,floor,'default');
  const meta=generateLockedRoomMeta(layout,seed,1,floor);
  const scene=new Scene(`dungeon:${floor}`,'dungeon_floor',noop,layout,null,null,meta.doors,null);
  scene.ensurePortalBuildings();
  const ts=layout.tileSize;
  const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
  let sridx=-1; const rooms=layout.rooms;
  for(let i=0;i<rooms.length;i++){const r=rooms[i]; if(stairs.x>=r.x&&stairs.x<r.x+r.w&&stairs.y>=r.y&&stairs.y<r.y+r.h)sridx=i;}
  const dws=layout.doorways??[];
  console.log(`seed=${seed} f=${floor} stairsRegion=${sridx}`);
  console.log('doorways touching stairs region:');
  for(const dw of dws){ if(dw.a===sridx||dw.b===sridx){
    console.log('  ', JSON.stringify(dw));
  }}
  console.log('roomGraph[stairsRegion]=', layout.roomGraph?.[sridx]);
  // locked?
  console.log('lockedRoomIndices=', meta.lockedRoomIndices, 'doors=', meta.doors.length);
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1); console.log('---'); await inspect(382,3);}
main().catch(e=>{console.error(e);process.exit(1);});
