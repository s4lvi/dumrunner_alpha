import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
async function inspect(seed:number,floor:number,reg:number){
  const layout:any=generateFloorLayout(seed,1,floor,'default');
  const map=layout.authoredSectorMap;
  const s=map.sectors[reg];
  console.log(`region/sector ${reg} verts:`, s.verts.map((v:any)=>`(${v.x/32},${v.y/32})`).join(' '));
  const ws=map.walls.filter((w:any)=>w.sectorId===reg);
  for(const w of ws){const a=s.verts[w.vertIdx],b=s.verts[(w.vertIdx+1)%s.verts.length];
    console.log(`   (${a.x/32},${a.y/32})->(${b.x/32},${b.y/32}) solid=${w.solid} back=${w.backSectorId} fZ=${w.floorZOverride} cZ=${w.ceilingZOverride}`);}
}
async function main(){await initBiomes();await initRooms();
  console.log('=== corridor 18 ==='); await inspect(354,1,18);
  console.log('=== corridor 26 ==='); await inspect(354,1,26);
}
main().catch(e=>{console.error(e);process.exit(1);});
