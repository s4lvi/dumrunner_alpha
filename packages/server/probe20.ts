import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
function pip(verts:any[],x:number,y:number){let inside=false;for(let i=0,j=verts.length-1;i<verts.length;j=i++){const a=verts[i],b=verts[j];if(a.y>y!==b.y>y&&x<((b.x-a.x)*(y-a.y))/(b.y-a.y)+a.x)inside=!inside;}return inside;}
async function main(){await initBiomes();await initRooms();
  const layout:any=generateFloorLayout(354,1,'default');
  const map=layout.authoredSectorMap;
  const ts=32;
  // which sectors contain (8.5,14.5)?
  const px=8.5*ts, py=14.5*ts;
  console.log(`probe point (${px},${py}) = (8.5,14.5 tiles)`);
  for(let i=0;i<map.sectors.length;i++){const s=map.sectors[i];if(pip(s.verts,px,py))console.log(`  inside sector ${i} floorZ=${s.floorZ} ceilingZ=${s.ceilingZ} buildingKind=${s.buildingKind} holes=${(s.holes||[]).length}`);}
  // sector 15 holes?
  const s15=map.sectors[15];
  console.log('sector15 holes:', JSON.stringify(s15.holes));
  // y just inside top edge at various depths
  for(const tyf of [14.1,14.3,14.5,15,16]){console.log(`  pip15 at (8.5,${tyf})=`, pip(s15.verts,8.5*ts,tyf*ts));}
}
main().catch(e=>{console.error(e);process.exit(1);});
