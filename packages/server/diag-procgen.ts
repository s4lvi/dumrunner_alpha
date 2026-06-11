import { initBiomes } from './src/biomes.js';
import { initRooms } from './src/rooms.js';
import { generateFloorLayout, generateLockedRoomMeta } from './src/procgen.js';
import { Scene, type SceneBindings } from './src/scene.js';

// Minimal no-op bindings so a Scene can be constructed standalone.
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
};

// For each locked-room door tile, sweep a player-radius circle
// across the tile (perpendicular to the doorway portal) using the
// Scene's REAL movement predicate and report whether it blocks.
function checkDoorBlocking(
  scene: Scene,
  doors: Array<{ tileX: number; tileY: number }>,
  dws: Array<{ axis: string; coord: number; lo: number; hi: number }>,
  ts: number,
): { blocked: number; passable: number; detail: string[] } {
  const sweep = (x0: number, y0: number, x1: number, y1: number) =>
    // private method — invoked deliberately for the diagnostic.
    (scene as any).circleSweepPassable(x0, y0, x1, y1, 10 /* PLAYER_RADIUS */, 0, 0, false) as boolean;
  let blocked = 0;
  let passable = 0;
  const detail: string[] = [];
  for (const d of doors) {
    let cx = (d.tileX + 0.5) * ts;
    let cy = (d.tileY + 0.5) * ts;
    // Door tiles sit across a portal; the crossing direction is
    // perpendicular to the portal axis. Find the nearest doorway
    // to orient the sweep; fall back to testing both axes.
    const dw = dws.find((w) =>
      w.axis === 'vertical'
        ? Math.abs(cx - w.coord) <= ts && cy >= w.lo - ts && cy <= w.hi + ts
        : Math.abs(cy - w.coord) <= ts && cx >= w.lo - ts && cx <= w.hi + ts,
    );
    // A run-end tile can be only HALF covered by the portal (room-
    // to-room doors aren't tile-aligned). Cross at the midpoint of
    // the tile ∩ portal span — crossing at the raw tile centre
    // would hit the sealed wall segment beside the opening and
    // misreport the door as the blocker.
    if (dw) {
      const r = 10;
      if (dw.axis === 'vertical') {
        const lo = Math.max(d.tileY * ts + r, dw.lo + r);
        const hi = Math.min((d.tileY + 1) * ts - r, dw.hi - r);
        if (lo <= hi) cy = (lo + hi) / 2;
      } else {
        const lo = Math.max(d.tileX * ts + r, dw.lo + r);
        const hi = Math.min((d.tileX + 1) * ts - r, dw.hi - r);
        if (lo <= hi) cx = (lo + hi) / 2;
      }
    }
    // Step tick-by-tick like the real sim (~6wu per tick at run speed)
    // from 1.5 tiles before the door to 1.5 tiles after.
    const axes: Array<[number, number]> =
      dw?.axis === 'vertical' ? [[1, 0]] : dw ? [[0, 1]] : [[1, 0], [0, 1]];
    let crossedAny = false;
    for (const [ax, ay] of axes) {
      let px = cx - ax * ts * 1.5;
      let py = cy - ay * ts * 1.5;
      let crossed = true;
      const step = 6;
      const total = ts * 3;
      for (let s = 0; s < total; s += step) {
        const nx = px + ax * step;
        const ny = py + ay * step;
        if (!sweep(px, py, nx, ny)) {
          crossed = false;
          break;
        }
        px = nx;
        py = ny;
      }
      if (crossed) crossedAny = true;
    }
    if (crossedAny) {
      passable++;
      detail.push(
        `    LEAK door tile(${d.tileX},${d.tileY}) world(${cx},${cy}) axis=${dw?.axis ?? '??'}`,
      );
    } else {
      blocked++;
    }
  }
  return { blocked, passable, detail };
}

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
      // Construct a REAL Scene the same way world.createDungeonScene
      // does and verify each door tile blocks a player-radius sweep.
      const scene = new Scene(
        `dungeon:${floor}`,
        'dungeon_floor',
        noopBindings,
        layout,
        null,
        null,
        meta.doors,
        null,
      );
      const block = checkDoorBlocking(scene, meta.doors, dws, ts);
      // openDoor regression: opening the first door (flood-fills the
      // whole adjacent run) must make its tiles passable again — the
      // sector map has to rebuild when door buildings are removed.
      let openCheck = 'n/a';
      const doorBuildings = [...((scene as any).buildings as Map<string, any>).values()]
        .filter((b) => b.kind === 'door');
      if (doorBuildings.length > 0) {
        const first = doorBuildings[0];
        const openedTiles: Array<{ tileX: number; tileY: number }> = [];
        scene.openDoor(first.id);
        // Tiles whose buildings are now gone = the opened run.
        const remaining = new Set(
          [...((scene as any).buildings as Map<string, any>).values()]
            .filter((b) => b.kind === 'door')
            .map((b) => `${b.tileX}:${b.tileY}`),
        );
        for (const d of meta.doors) {
          if (!remaining.has(`${d.tileX}:${d.tileY}`)) openedTiles.push(d);
        }
        // The opened run is one portal (flood-fill by adjacency).
        // Portal counts as open if ANY of its tiles crosses — a
        // single tile can legitimately stay blocked by unrelated
        // geometry (e.g. an unclimbable platform riser one tile
        // inside the room) while the doorway itself is usable.
        const after = checkDoorBlocking(scene, openedTiles, dws, ts);
        openCheck = after.passable >= 1
          ? `opened ${openedTiles.length} passableTiles=${after.passable} OK`
          : `opened ${openedTiles.length} ALL STILL BLOCKED`;
      }
      console.log(
        `seed=${seed} floor=${floor} sectors=${secs.length}` +
        ` plats=${plats.length} pits=${pits.length} withHoles=${holes.length}` +
        ` doorways=${dws.length} locked=${meta.lockedRoomIndices.length}` +
        ` doors=${meta.doors.length} misplaced=${misplaced}` +
        ` doorsBlocked=${block.blocked} doorsPASSABLE=${block.passable}` +
        ` | openDoor: ${openCheck}`
      );
      for (const line of block.detail) console.log(line);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
