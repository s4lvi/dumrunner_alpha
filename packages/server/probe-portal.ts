import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene, type SceneBindings } from './src/scene.js';
import { INTERACTABLE_RADIUS } from '@dumrunner/shared';

const noopBindings: SceneBindings = {
  connection: () => undefined,
  send: () => {},
  onInteractable: () => {},
  onPlayerRespawn: () => {},
  onPlayerDied: () => {},
  onPowerLinkDestroyed: () => {},
  isPowerOnline: () => true,
  isPowered: () => false,
  onBuildingsChanged: () => {},
  dropItemsOnDeath: () => false,
  onPlayerEquipmentChanged: () => {},
  applyPlayerEffect: () => {},
  pvpEnabled: () => false,
  isPlaytest: () => false,
};

const PLAYER_RADIUS = 10;

// BFS over tile centres using the Scene's REAL movement predicate
// (cubes appended to the sector map are solid). Returns the set of
// reachable tile (tx,ty) keys from the spawn tile.
function bfsReachable(scene: Scene, layout: any): Set<string> {
  const grid = layout.tileGrid;
  const ts = grid.tileSize;
  const sweep = (x0: number, y0: number, x1: number, y1: number) =>
    (scene as any).circleSweepPassable(x0, y0, x1, y1, PLAYER_RADIUS, 0, 0, false) as boolean;
  const passable = (x: number, y: number) =>
    (scene as any).circlePassable(x, y, PLAYER_RADIUS) as boolean;
  const spawn = layout.spawn;
  const sx = Math.floor(spawn.x / ts);
  const sy = Math.floor(spawn.y / ts);
  const reached = new Set<string>();
  const start = `${sx}:${sy}`;
  const startCx = (sx + 0.5) * ts;
  const startCy = (sy + 0.5) * ts;
  if (!passable(startCx, startCy)) {
    // spawn tile itself blocked; still seed it so we can report
  }
  const queue = [[sx, sy]];
  reached.add(start);
  while (queue.length) {
    const [tx, ty] = queue.shift()!;
    const cx = (tx + 0.5) * ts;
    const cy = (ty + 0.5) * ts;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + dx, ny = ty + dy;
      const k = `${nx}:${ny}`;
      if (reached.has(k)) continue;
      const ncx = (nx + 0.5) * ts;
      const ncy = (ny + 0.5) * ts;
      if (!passable(ncx, ncy)) continue;
      if (!sweep(cx, cy, ncx, ncy)) continue;
      reached.add(k);
      queue.push([nx, ny]);
    }
  }
  return reached;
}

// Is any reached tile within INTERACTABLE_RADIUS of the interactable
// world pos AND able to stand there (circlePassable)?
function interactReachable(
  scene: Scene, layout: any, reached: Set<string>, it: any,
): boolean {
  const ts = layout.tileGrid.tileSize;
  const passable = (x: number, y: number) =>
    (scene as any).circlePassable(x, y, PLAYER_RADIUS) as boolean;
  for (const key of reached) {
    const [tx, ty] = key.split(':').map(Number);
    const cx = (tx + 0.5) * ts;
    const cy = (ty + 0.5) * ts;
    const dx = cx - it.x, dy = cy - it.y;
    if (dx * dx + dy * dy > INTERACTABLE_RADIUS * INTERACTABLE_RADIUS) continue;
    if (!passable(cx, cy)) continue;
    return true;
  }
  return false;
}

async function main() {
  await initBiomes();
  await initRooms();
  const fails: string[] = [];
  let checked = 0;
  for (let seed = 1; seed <= 30; seed++) {
    for (let floor = 1; floor <= 3; floor++) {
      const layout = generateFloorLayout(seed, 1, floor, 'default');
      const meta = generateLockedRoomMeta(layout, seed, 1, floor);
      const scene = new Scene(`dungeon:${floor}`, 'dungeon_floor', noopBindings, layout, null, null, meta.doors, null);
      scene.ensurePortalBuildings();
      checked++;
      const stairs = layout.interactables.find((i: any) => i.kind === 'stairs_down');
      const extract = layout.interactables.find((i: any) => i.kind === 'extract_pad');
      const reached = bfsReachable(scene, layout);
      if (stairs && !interactReachable(scene, layout, reached, stairs)) {
        const ts = layout.tileGrid.tileSize;
        fails.push(`seed=${seed} floor=${floor} STAIRS unreachable it=(${stairs.x},${stairs.y}) tile=(${Math.floor(stairs.x/ts)},${Math.floor(stairs.y/ts)}) reachedN=${reached.size}`);
      }
      if (extract && !interactReachable(scene, layout, reached, extract)) {
        const ts = layout.tileGrid.tileSize;
        fails.push(`seed=${seed} floor=${floor} EXTRACT unreachable it=(${extract.x},${extract.y}) tile=(${Math.floor(extract.x/ts)},${Math.floor(extract.y/ts)})`);
      }
    }
  }
  console.log(`probe: ${checked} floors, ${fails.length} failures`);
  for (const f of fails) console.log('  FAIL', f);
}
main().catch((e) => { console.error(e); process.exit(1); });
