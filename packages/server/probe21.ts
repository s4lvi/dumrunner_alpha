import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
function pip(verts:any[],x:number,y:number){let inside=false;for(let i=0,j=verts.length-1;i<verts.length;j=i++){const a=verts[i],b=verts[j];if(a.y>y!==b.y>y&&x<((b.x-a.x)*(y-a.y))/(b.y-a.y)+a.x)inside=!inside;}return inside;}
async function main(){await initBiomes();await initRooms();
  const layout:any=generateFloorLayout(354,1,'default');
  const map=layout.authoredSectorMap;
  const s15=map.sectors[15];
  // signed area
  let area=0; const v=s15.verts;
  for(let i=0;i<v.length;i++){const a=v[i],b=v[(i+1)%v.length];area+=a.x*b.y-b.x*a.y;}
  console.log('sector15 signed area=',area/2, 'nverts=',v.length);
  console.log('verts:', v.map((p:any)=>`(${p.x/32},${p.y/32})`).join(' '));
  // grid scan of pip across the room
  for(let ty=13;ty<=29;ty++){let line=`y=${ty} `;for(let tx=3;tx<=15;tx++){line+=pip(v,(tx+0.5)*32,(ty+0.5)*32)?'#':'.';}console.log(line);}
}
main().catch(e=>{console.error(e);process.exit(1);});
