import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';
import { INTERACTABLE_RADIUS } from '@dumrunner/shared';
const noop: any = new Proxy({}, { get: () => () => undefined });
const R = 10;
function probe(scene: Scene, layout: any) {
  const g = layout.tileGrid, ts = g.tileSize;
  const sweep=(a:number,b:number,c:number,d:number)=>(scene as any).circleSweepPassable(a,b,c,d,R,0,0,false);
  const pass=(x:number,y:number)=>(scene as any).circlePassable(x,y,R);
  const sx=Math.floor(layout.spawn.x/ts), sy=Math.floor(layout.spawn.y/ts);
  const reached=new Set<string>(); const q=[[sx,sy]]; reached.add(`${sx}:${sy}`);
  while(q.length){const [tx,ty]=q.shift()!; const cx=(tx+0.5)*ts,cy=(ty+0.5)*ts;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=tx+dx,ny=ty+dy,k=`${nx}:${ny}`;
      if(reached.has(k))continue; const ncx=(nx+0.5)*ts,ncy=(ny+0.5)*ts;
      if(!pass(ncx,ncy))continue; if(!sweep(cx,cy,ncx,ncy))continue; reached.add(k); q.push([nx,ny]); }}
  const ir=(it:any)=>{for(const key of reached){const [tx,ty]=key.split(':').map(Number);
    const cx=(tx+0.5)*ts,cy=(ty+0.5)*ts; const dx=cx-it.x,dy=cy-it.y;
    if(dx*dx+dy*dy>INTERACTABLE_RADIUS*INTERACTABLE_RADIUS)continue; if(!pass(cx,cy))continue; return true;} return false;};
  return ir;
}
async function main(){
  await initBiomes(); await initRooms();
  let checked=0; const fails:string[]=[];
  for(let seed=1;seed<=400;seed++)for(let floor=1;floor<=3;floor++){
    const layout:any=generateFloorLayout(seed,1,floor,'default');
    const meta=generateLockedRoomMeta(layout,seed,1,floor);
    const scene=new Scene(`dungeon:${floor}`,'dungeon_floor',noop,layout,null,null,meta.doors,null);
    scene.ensurePortalBuildings(); checked++;
    const ir=probe(scene,layout);
    const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
    const extract=layout.interactables.find((i:any)=>i.kind==='extract_pad');
    if(stairs&&!ir(stairs))fails.push(`seed=${seed} f=${floor} STAIRS`);
    if(extract&&!ir(extract))fails.push(`seed=${seed} f=${floor} EXTRACT`);
  }
  console.log(`checked=${checked} fails=${fails.length}`);
  for(const f of fails)console.log('  ',f);
}
main().catch(e=>{console.error(e);process.exit(1);});
