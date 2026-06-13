import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
async function inspect(seed:number,floor:number){
  const layout:any=generateFloorLayout(seed,1,floor,'default');
  const dws=layout.doorways??[];
  const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
  const ts=layout.tileSize; const rooms=layout.rooms;
  let sridx=-1,spidx=-1;
  for(let i=0;i<rooms.length;i++){const r=rooms[i];
    if(stairs.x>=r.x&&stairs.x<r.x+r.w&&stairs.y>=r.y&&stairs.y<r.y+r.h)sridx=i;
    if(layout.spawn.x>=r.x&&layout.spawn.x<r.x+r.w&&layout.spawn.y>=r.y&&layout.spawn.y<r.y+r.h)spidx=i;}
  // doorway graph BFS
  const adj:number[][]=rooms.map(()=>[]);
  for(const dw of dws){adj[dw.a].push(dw.b);adj[dw.b].push(dw.a);}
  const seen=new Set([spidx]);const q=[spidx];
  while(q.length){const c=q.shift()!;for(const n of adj[c]){if(seen.has(n))continue;seen.add(n);q.push(n);}}
  console.log(`seed=${seed} f=${floor} spawnRegion=${spidx} stairsRegion=${sridx} doorwayGraphReachesStairs=${seen.has(sridx)} reachedRegions=${[...seen].sort((a,b)=>a-b)}`);
  // path from spawn to stairs in doorway graph
  const prev=new Map<number,number>();const q2=[spidx];const seen2=new Set([spidx]);
  while(q2.length){const c=q2.shift()!;if(c===sridx)break;for(const n of adj[c]){if(seen2.has(n))continue;seen2.add(n);prev.set(n,c);q2.push(n);}}
  if(seen2.has(sridx)){const path=[];let c=sridx;while(c!==undefined){path.unshift(c);c=prev.get(c)!;if(c===spidx){path.unshift(spidx);break;}}console.log('  doorway path:',path.join('->'));}
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1); await inspect(382,3);}
main().catch(e=>{console.error(e);process.exit(1);});
