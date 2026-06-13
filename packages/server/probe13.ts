import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
// Re-implement the diag's buildFloorBfs reach exactly enough to test 354/382.
const BFS_PLAYER_HEIGHT=24, BFS_STEP_UP=12;
function wallEndpointsOf(map:any,w:any){ if(w.ax!==undefined)return{ax:w.ax,ay:w.ay,bx:w.bx,by:w.by};
  const s=map.sectors[w.sectorId]; if(!s)return null; const a=s.verts[w.vertIdx]; const b=s.verts[(w.vertIdx+1)%s.verts.length];
  if(!a||!b)return null; return{ax:a.x,ay:a.y,bx:b.x,by:b.y};}
function collectBlockingWalls(map:any){const out:any[]=[];for(const w of map.walls){const sector=map.sectors[w.sectorId];if(!sector)continue;
  if(!w.solid&&w.floorZOverride===undefined&&w.ceilingZOverride===undefined)continue;
  const top=w.ceilingZOverride!==undefined?w.ceilingZOverride:sector.ceilingZ;
  const bot=w.floorZOverride!==undefined?w.floorZOverride:sector.floorZ;
  if(bot>=BFS_PLAYER_HEIGHT)continue; if(top<=BFS_STEP_UP)continue;
  const e=wallEndpointsOf(map,w); if(e)out.push(e);} return out;}
function segsIntersect(p0x:number,p0y:number,p1x:number,p1y:number,p2x:number,p2y:number,p3x:number,p3y:number){
  const d1x=p1x-p0x,d1y=p1y-p0y,d2x=p3x-p2x,d2y=p3y-p2y;const denom=d1x*d2y-d1y*d2x;const EPS=1e-9;
  if(Math.abs(denom)<EPS){const cross=(p2x-p0x)*d1y-(p2y-p0y)*d1x;if(Math.abs(cross)>0.5*Math.hypot(d1x,d1y))return false;
    const l=d1x*d1x+d1y*d1y;if(l===0)return false;const ta=((p2x-p0x)*d1x+(p2y-p0y)*d1y)/l;const tb=((p3x-p0x)*d1x+(p3y-p0y)*d1y)/l;
    return Math.min(1,Math.max(ta,tb))-Math.max(0,Math.min(ta,tb))>1e-6;}
  const t=((p2x-p0x)*d2y-(p2y-p0y)*d2x)/denom;const u=((p2x-p0x)*d1y-(p2y-p0y)*d1x)/denom;
  return t>=-1e-6&&t<=1+1e-6&&u>=-1e-6&&u<=1+1e-6;}
function reach(layout:any,fx:number,fy:number,tx:number,ty:number){
  const grid=layout.tileGrid,map=layout.authoredSectorMap;const ts=grid.tileSize;
  const tiles=Buffer.from(grid.tilesB64,'base64');const W=grid.width,H=grid.height;
  const walls=collectBlockingWalls(map);
  const walkable=(lx:number,ly:number)=>{if(lx<0||ly<0||lx>=W||ly>=H)return false;return tiles[ly*W+lx]!==0;};
  const moveAllowed=(x0:number,y0:number,x1:number,y1:number)=>{const cx0=(x0+grid.originTileX+0.5)*ts,cy0=(y0+grid.originTileY+0.5)*ts,cx1=(x1+grid.originTileX+0.5)*ts,cy1=(y1+grid.originTileY+0.5)*ts;
    for(const w of walls)if(segsIntersect(cx0,cy0,cx1,cy1,w.ax,w.ay,w.bx,w.by))return false;return true;};
  const sx=Math.floor(fx/ts)-grid.originTileX,sy=Math.floor(fy/ts)-grid.originTileY,gx=Math.floor(tx/ts)-grid.originTileX,gy=Math.floor(ty/ts)-grid.originTileY;
  if(!walkable(sx,sy)||!walkable(gx,gy))return false;
  const vis=new Uint8Array(W*H);const q=[sy*W+sx];vis[sy*W+sx]=1;
  while(q.length){const cur=q.shift()!;const lx=cur%W,ly=Math.floor(cur/W);if(lx===gx&&ly===gy)return true;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=lx+dx,ny=ly+dy;if(!walkable(nx,ny))continue;const ni=ny*W+nx;if(vis[ni])continue;if(!moveAllowed(lx,ly,nx,ny))continue;vis[ni]=1;q.push(ni);}}
  return false;}
async function main(){await initBiomes();await initRooms();
  for(const [seed,floor] of [[354,1],[382,3]] as const){
    const layout:any=generateFloorLayout(seed,1,floor,'default');
    const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
    const extract=layout.interactables.find((i:any)=>i.kind==='extract_pad');
    console.log(`seed=${seed} f=${floor} DIAG-BFS spawn->stairs=${reach(layout,layout.spawn.x,layout.spawn.y,stairs.x,stairs.y)} spawn->extract=${reach(layout,layout.spawn.x,layout.spawn.y,extract.x,extract.y)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
