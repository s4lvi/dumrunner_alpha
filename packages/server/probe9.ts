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
  const g=layout.tileGrid, ts=g.tileSize;
  const t=Buffer.from(g.tilesB64,'base64');
  const stairs=layout.interactables.find((i:any)=>i.kind==='stairs_down');
  let sridx=-1; const rooms=layout.rooms;
  for(let i=0;i<rooms.length;i++){const r=rooms[i]; if(stairs.x>=r.x&&stairs.x<r.x+r.w&&stairs.y>=r.y&&stairs.y<r.y+r.h)sridx=i;}
  const rr=rooms[sridx];
  console.log(`seed=${seed} f=${floor} stairsRegion=${sridx} rect tiles x=${rr.x/ts}..${(rr.x+rr.w)/ts} y=${rr.y/ts}..${(rr.y+rr.h)/ts}`);
  const x0=Math.floor(rr.x/ts)-2, x1=Math.ceil((rr.x+rr.w)/ts)+2;
  const y0=Math.floor(rr.y/ts)-2, y1=Math.ceil((rr.y+rr.h)/ts)+2;
  const tid=(gx:number,gy:number)=>{const lx=gx-g.originTileX,ly=gy-g.originTileY;if(lx<0||ly<0||lx>=g.width||ly>=g.height)return -9;return t[ly*g.width+lx];};
  const pass=(gx:number,gy:number)=>(scene as any).circlePassable((gx+0.5)*ts,(gy+0.5)*ts,R);
  const stx=Math.floor(stairs.x/ts), sty=Math.floor(stairs.y/ts);
  for(let gy=y0;gy<=y1;gy++){let line='';for(let gx=x0;gx<=x1;gx++){
    const id=tid(gx,gy); const p=pass(gx,gy);
    let ch = id<0?'..':(gx===stx&&gy===sty?'SS':(id===1?(p?'..':'##'):(id===2?'WW':'??')));
    line+=ch;
  } console.log(line);}
  console.log('legend: ..=floor/standable ##=floor-but-blocked WW=wallTile2 SS=stairsCube');
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1);}
main().catch(e=>{console.error(e);process.exit(1);});
