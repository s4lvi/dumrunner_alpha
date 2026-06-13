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
  const g=layout.tileGrid,ts=g.tileSize;
  const sweep=(a:number,b:number,c:number,d:number)=>(scene as any).circleSweepPassable(a,b,c,d,R,0,0,false);
  const pass=(x:number,y:number)=>(scene as any).circlePassable(x,y,R);
  const sx=Math.floor(layout.spawn.x/ts), sy=Math.floor(layout.spawn.y/ts);
  const reached=new Set<string>(); const q=[[sx,sy]]; reached.add(`${sx}:${sy}`);
  while(q.length){const [tx,ty]=q.shift()!; const cx=(tx+0.5)*ts,cy=(ty+0.5)*ts;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=tx+dx,ny=ty+dy,k=`${nx}:${ny}`;
      if(reached.has(k))continue; const ncx=(nx+0.5)*ts,ncy=(ny+0.5)*ts;
      if(!pass(ncx,ncy))continue; if(!sweep(cx,cy,ncx,ncy))continue; reached.add(k); q.push([nx,ny]); }}
  // dump area around the corridor doorway at coord:512 lo768 hi896 (region18)
  const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
  // corridor 18 rect
  const c18=layout.rooms[18], c26=layout.rooms[26];
  console.log(`seed=${seed} f=${floor} corridor18 rect tiles x=${c18.x/ts}..${(c18.x+c18.w)/ts} y=${c18.y/ts}..${(c18.y+c18.h)/ts}`);
  console.log(`corridor26 rect tiles x=${c26.x/ts}..${(c26.x+c26.w)/ts} y=${c26.y/ts}..${(c26.y+c26.h)/ts}`);
  const t=Buffer.from(g.tilesB64,'base64');
  const tid=(gx:number,gy:number)=>{const lx=gx-g.originTileX,ly=gy-g.originTileY;if(lx<0||ly<0||lx>=g.width||ly>=g.height)return -9;return t[ly*g.width+lx];};
  // dump full region rows 12..18, cols 18..30 with reached marker
  for(let gy=12;gy<=20;gy++){let line='';for(let gx=18;gx<=30;gx++){
    const id=tid(gx,gy); const p=pass(gx,gy); const rch=reached.has(`${gx}:${gy}`);
    let ch = id<0?'..':(id===2?'WW':(p?(rch?'RR':'oo'):'##'));
    line+=ch;
  } console.log(`y=${gy} `+line);}
  console.log('legend RR=reachedFromSpawn oo=standable-but-unreached ##=blocked WW=wall2 ..=void');
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1);}
main().catch(e=>{console.error(e);process.exit(1);});
