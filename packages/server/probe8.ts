import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';
const noop: any = new Proxy({}, { get: () => () => undefined });
const R=10;
// Fine BFS over half-tile lattice using the real swept predicate
// to confirm whether the player can physically reach the stairs area.
async function inspect(seed:number,floor:number){
  const layout:any=generateFloorLayout(seed,1,floor,'default');
  const meta=generateLockedRoomMeta(layout,seed,1,floor);
  const scene=new Scene(`dungeon:${floor}`,'dungeon_floor',noop,layout,null,null,meta.doors,null);
  scene.ensurePortalBuildings();
  const ts=layout.tileGrid.tileSize;
  const sweep=(a:number,b:number,c:number,d:number)=>(scene as any).circleSweepPassable(a,b,c,d,R,0,0,false);
  const pass=(x:number,y:number)=>(scene as any).circlePassable(x,y,R);
  const step=ts/2;
  const key=(x:number,y:number)=>`${Math.round(x)}:${Math.round(y)}`;
  const reached=new Set<string>();
  const start=[Math.round(layout.spawn.x/step)*step, Math.round(layout.spawn.y/step)*step];
  const q=[start]; reached.add(key(start[0],start[1]));
  const dirs=[[step,0],[-step,0],[0,step],[0,-step]];
  while(q.length){const [x,y]=q.shift()!;
    for(const [dx,dy] of dirs){const nx=x+dx,ny=y+dy,k=key(nx,ny);
      if(reached.has(k))continue; if(!pass(nx,ny))continue; if(!sweep(x,y,nx,ny))continue;
      reached.add(k); q.push([nx,ny]); }}
  const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
  // is any reached point within 40 of stairs and standable?
  let ok=false; for(const kk of reached){const [x,y]=kk.split(':').map(Number);
    const dx=x-stairs.x,dy=y-stairs.y; if(dx*dx+dy*dy<=40*40&&pass(x,y)){ok=true;break;}}
  console.log(`seed=${seed} f=${floor} FINE half-tile BFS reachStairs=${ok} reachedNodes=${reached.size}`);
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1); await inspect(382,3);}
main().catch(e=>{console.error(e);process.exit(1);});
