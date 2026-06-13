import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene } from './src/scene.js';
const noop: any = new Proxy({}, { get: () => () => undefined });
const R=10;
// Replicate the EXISTING diag tile-grid BFS (id===0 only blocked, no cubes)
// and compare to real-Scene BFS.
async function inspect(seed:number,floor:number){
  const layout:any=generateFloorLayout(seed,1,floor,'default');
  const meta=generateLockedRoomMeta(layout,seed,1,floor);
  const scene=new Scene(`dungeon:${floor}`,'dungeon_floor',noop,layout,null,null,meta.doors,null);
  scene.ensurePortalBuildings();
  const g=layout.tileGrid,ts=g.tileSize;
  const t=Buffer.from(g.tilesB64,'base64');
  const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
  // Existing diag uses: walkable iff tiles!==0; move allowed iff no
  // authored blocking wall crosses. It does NOT include cube walls and
  // does NOT treat id-2 as blocked. Approximate with real wall index but
  // WITHOUT cubes by NOT calling ensurePortalBuildings — rebuild a fresh scene.
  const sceneNoCube=new Scene(`dungeon:${floor}`,'dungeon_floor',noop,layout,null,null,meta.doors,null);
  // sceneNoCube has no portal buildings (we didn't call ensurePortalBuildings)
  const sweepNC=(a:number,b:number,c:number,d:number)=>(sceneNoCube as any).circleSweepPassable(a,b,c,d,R,0,0,false);
  // tile-grid BFS: walkable = id!==0
  const walkable=(gx:number,gy:number)=>{const lx=gx-g.originTileX,ly=gy-g.originTileY;if(lx<0||ly<0||lx>=g.width||ly>=g.height)return false;return t[ly*g.width+lx]!==0;};
  const sx=Math.floor(layout.spawn.x/ts),sy=Math.floor(layout.spawn.y/ts);
  const reached=new Set<string>(); const q=[[sx,sy]]; reached.add(`${sx}:${sy}`);
  while(q.length){const [tx,ty]=q.shift()!;const cx=(tx+0.5)*ts,cy=(ty+0.5)*ts;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=tx+dx,ny=ty+dy,k=`${nx}:${ny}`;
      if(reached.has(k))continue; if(!walkable(nx,ny))continue;
      const ncx=(nx+0.5)*ts,ncy=(ny+0.5)*ts; if(!sweepNC(cx,cy,ncx,ncy))continue;
      reached.add(k); q.push([nx,ny]); }}
  const stx=Math.floor(stairs.x/ts),sty=Math.floor(stairs.y/ts);
  console.log(`seed=${seed} f=${floor} EXISTING-diag-style reachStairsTile(id!==0,noCube)=${reached.has(`${stx}:${sty}`)} reachedN=${reached.size}`);
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1); await inspect(382,3);}
main().catch(e=>{console.error(e);process.exit(1);});
