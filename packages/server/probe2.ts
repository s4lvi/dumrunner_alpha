import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene, type SceneBindings } from './src/scene.js';
const noop: any = new Proxy({}, { get: () => () => undefined });
async function main() {
  await initBiomes(); await initRooms();
  let cubeSolidOK = 0, cubeSolidBad = 0, centerNonFloor = 0;
  for (let seed = 1; seed <= 30; seed++) for (let floor = 1; floor <= 3; floor++) {
    const layout = generateFloorLayout(seed, 1, floor, 'default');
    const meta = generateLockedRoomMeta(layout, seed, 1, floor);
    const scene = new Scene(`dungeon:${floor}`, 'dungeon_floor', noop, layout, null, null, meta.doors, null);
    scene.ensurePortalBuildings();
    const ts = layout.tileGrid.tileSize;
    for (const it of layout.interactables) {
      if (it.kind !== 'stairs_down' && it.kind !== 'extract_pad') continue;
      const tx = Math.floor(it.x / ts), ty = Math.floor(it.y / ts);
      const cx = (tx + 0.5) * ts, cy = (ty + 0.5) * ts;
      const passable = (scene as any).circlePassable(cx, cy, 10);
      if (passable) cubeSolidBad++; else cubeSolidOK++;
      // tile id under the interactable center
      const tiles = (scene as any).layoutTiles;
      const grid = layout.tileGrid;
      const lx = tx - grid.originTileX, ly = ty - grid.originTileY;
      const tid = (lx>=0&&ly>=0&&lx<grid.width&&ly<grid.height) ? tiles[ly*grid.width+lx] : -1;
      if (tid === 0) { centerNonFloor++; console.log(`NON-FLOOR center seed=${seed} f=${floor} ${it.kind} tile=(${tx},${ty}) tid=${tid}`); }
    }
  }
  console.log({ cubeSolidOK, cubeSolidBad, centerNonFloor });
}
main().catch(e=>{console.error(e);process.exit(1);});
