import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';
import { INTERACTABLE_RADIUS } from '@dumrunner/shared';
const noop: any = new Proxy({}, { get: () => () => undefined });
const R=10;
async function inspect(seed:number,floor:number){
  const layout:any=generateFloorLayout(seed,1,floor,'default');
  const meta=generateLockedRoomMeta(layout,seed,1,floor);
  const scene=new Scene(`dungeon:${floor}`,'dungeon_floor',noop,layout,null,null,meta.doors,null);
  scene.ensurePortalBuildings();
  const g=layout.tileGrid, ts=g.tileSize;
  const sweep=(a:number,b:number,c:number,d:number)=>(scene as any).circleSweepPassable(a,b,c,d,R,0,0,false);
  const pass=(x:number,y:number)=>(scene as any).circlePassable(x,y,R);
  const sx=Math.floor(layout.spawn.x/ts), sy=Math.floor(layout.spawn.y/ts);
  const reached=new Set<string>(); const q=[[sx,sy]]; reached.add(`${sx}:${sy}`);
  while(q.length){const [tx,ty]=q.shift()!; const cx=(tx+0.5)*ts,cy=(ty+0.5)*ts;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=tx+dx,ny=ty+dy,k=`${nx}:${ny}`;
      if(reached.has(k))continue; const ncx=(nx+0.5)*ts,ncy=(ny+0.5)*ts;
      if(!pass(ncx,ncy))continue; if(!sweep(cx,cy,ncx,ncy))continue; reached.add(k); q.push([nx,ny]); }}
  const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
  const tx=Math.floor(stairs.x/ts), ty=Math.floor(stairs.y/ts);
  console.log(`seed=${seed} f=${floor} reachedN=${reached.size} cubeTile=(${tx},${ty})`);
  // are the in-range standable tiles reached?
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    const nx=tx+dx,ny=ty+dy; const cx=(nx+0.5)*ts,cy=(ny+0.5)*ts;
    const ddx=cx-stairs.x,ddy=cy-stairs.y; const inRange=ddx*ddx+ddy*ddy<=INTERACTABLE_RADIUS*INTERACTABLE_RADIUS;
    if(!inRange)continue;
    console.log(`  inRange tile=(${nx},${ny}) standable=${pass(cx,cy)} reached=${reached.has(`${nx}:${ny}`)} dist=${Math.hypot(ddx,ddy).toFixed(1)}`);
  }
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1); await inspect(382,3);}
main().catch(e=>{console.error(e);process.exit(1);});
