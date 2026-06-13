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
  const sweep=(a:number,b:number,c:number,d:number)=>(scene as any).circleSweepPassable(a,b,c,d,R,0,0,false);
  const pass=(x:number,y:number)=>(scene as any).circlePassable(x,y,R);
  const dws=layout.doorways??[];
  // For each doorway, test crossing at its midpoint perpendicular.
  function doorwayPassable(dw:any){
    const mid = (dw.lo+dw.hi)/2;
    if(dw.axis==='vertical'){const x=dw.coord; const y=mid;
      // cross horizontally
      return pass(x-ts,y)&&pass(x+ts,y)&&sweep(x-ts,y,x+ts,y);}
    else {const y=dw.coord; const x=mid;
      return pass(x,y-ts)&&pass(x,y+ts)&&sweep(x,y-ts,x,y+ts);}
  }
  console.log(`=== seed=${seed} f=${floor} ===`);
  for(const dw of dws){
    const p=doorwayPassable(dw);
    if(!p) console.log(`  SEALED doorway a=${dw.a} b=${dw.b} ${dw.axis} coord=${dw.coord/ts} lo=${dw.lo/ts} hi=${dw.hi/ts} aCorr=${dw.aIsCorridor} bCorr=${dw.bIsCorridor}`);
  }
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1); await inspect(382,3);}
main().catch(e=>{console.error(e);process.exit(1);});
