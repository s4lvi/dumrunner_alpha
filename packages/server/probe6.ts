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
  const tx=Math.floor(stairs.x/ts), ty=Math.floor(stairs.y/ts);
  const tid=(gx:number,gy:number)=>{const lx=gx-g.originTileX,ly=gy-g.originTileY;if(lx<0||ly<0||lx>=g.width||ly>=g.height)return -9;return t[ly*g.width+lx];};
  const pass=(gx:number,gy:number)=>(scene as any).circlePassable((gx+0.5)*ts,(gy+0.5)*ts,R);
  console.log(`\n=== seed=${seed} f=${floor} stairs it=(${stairs.x},${stairs.y}) tile=(${tx},${ty}) ===`);
  // which region is stairs in
  const rooms=layout.rooms;
  let sridx=-1;
  for(let i=0;i<rooms.length;i++){const r=rooms[i]; if(stairs.x>=r.x&&stairs.x<=r.x+r.w&&stairs.y>=r.y&&stairs.y<=r.y+r.h){sridx=i;}}
  console.log('stairs region rect index', sridx, rooms[sridx]);
  // print 7x7 grid of tile ids + passability around stairs
  for(let dy=-3;dy<=3;dy++){let line='';for(let dx=-3;dx<=3;dx++){
    const id=tid(tx+dx,ty+dy); const p=pass(tx+dx,ty+dy);
    const c = (dx===0&&dy===0)?'[':' ';
    const e = (dx===0&&dy===0)?']':' ';
    line+=`${c}${id>=0?id:'.'}${p?'o':'x'}${e}`;
  } console.log(line);}
  console.log('(format: tileId then o=standable x=blocked; center=stairs cube tile)');
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1); await inspect(382,3);}
main().catch(e=>{console.error(e);process.exit(1);});
