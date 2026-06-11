import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';

async function main() {
  await initBiomes();
  await initRooms();
  for (const seed of [101, 202, 303]) {
    for (let floor = 1; floor <= 3; floor++) {
      const layout = generateFloorLayout(seed, 1, floor, 'default');
      const map = (layout as any).authoredSectorMap;
      if (!map) { console.log(seed, floor, 'NO MAP'); continue; }
      const secs = map.sectors;
      const plats = secs.filter((s: any) => s.floorZ > 0);
      const pits = secs.filter((s: any) => s.floorZ < 0);
      const holes = secs.filter((s: any) => s.holes && s.holes.length > 0);
      const meta = generateLockedRoomMeta(layout, seed, 1, floor);
      const ts = layout.tileSize;
      // Sanity: every door tile must touch a recorded doorway
      // portal (tile bbox within 1 tile of the portal segment).
      const dws = (layout as any).doorways ?? [];
      let misplaced = 0;
      for (const d of meta.doors) {
        const cx = (d.tileX + 0.5) * ts;
        const cy = (d.tileY + 0.5) * ts;
        const near = dws.some((dw: any) =>
          dw.axis === 'vertical'
            ? Math.abs(cx - dw.coord) <= ts && cy >= dw.lo - ts && cy <= dw.hi + ts
            : Math.abs(cy - dw.coord) <= ts && cx >= dw.lo - ts && cx <= dw.hi + ts
        );
        if (!near) misplaced++;
      }
      // Pit riser walls: every pit sector should carry perimeter
      // walls; report how many walls reference each pit and their
      // z-override bands so missing risers are visible in data.
      for (const pit of pits) {
        const ws = map.walls.filter((w: any) => w.sectorId === pit.id);
        console.log(
          `  pit s${pit.id} floorZ=${pit.floorZ} walls=${ws.length}` +
          ` bands=${ws
            .map((w: any) => `[${w.floorZOverride ?? '-'},${w.ceilingZOverride ?? '-'}]s${w.solid ? 1 : 0}`)
            .slice(0, 4)
            .join(' ')}`
        );
      }
      console.log(
        `seed=${seed} floor=${floor} sectors=${secs.length}` +
        ` plats=${plats.length} pits=${pits.length} withHoles=${holes.length}` +
        ` doorways=${dws.length} locked=${meta.lockedRoomIndices.length}` +
        ` doors=${meta.doors.length} misplaced=${misplaced}`
      );
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
