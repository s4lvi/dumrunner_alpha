import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout } from './src/procgen.js';
async function inspect(seed:number,floor:number,reg:number){
  const layout:any=generateFloorLayout(seed,1,floor,'default');
  const map=layout.authoredSectorMap;
  // region->sector: region index aligns with sector id 0..regions-1
  const s=map.sectors[reg];
  console.log(`seed=${seed} f=${floor} region/sector ${reg} floorZ=${s.floorZ} ceilingZ=${s.ceilingZ} verts:`);
  console.log('  ', s.verts.map((v:any)=>`(${v.x/32},${v.y/32})`).join(' '));
  // walls of this sector
  const ws=map.walls.filter((w:any)=>w.sectorId===reg);
  console.log(`  walls(${ws.length}):`);
  for(const w of ws){const a=s.verts[w.vertIdx],b=s.verts[(w.vertIdx+1)%s.verts.length];
    console.log(`    v${w.vertIdx} (${a.x/32},${a.y/32})->(${b.x/32},${b.y/32}) solid=${w.solid} back=${w.backSectorId} fZ=${w.floorZOverride} cZ=${w.ceilingZOverride}`);
  }
}
async function main(){await initBiomes();await initRooms(); await inspect(354,1,16);}
main().catch(e=>{console.error(e);process.exit(1);});
