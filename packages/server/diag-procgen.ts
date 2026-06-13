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
  isPlaytest: () => false,
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

// ---------------- Floor-connectivity BFS ----------------
//
// Ground-truth traversability check that does NOT trust roomGraph:
// BFS over the walkable tile grid where a step between two
// adjacent tile centres is allowed iff no ground-blocking wall of
// the authored sector map crosses the move segment. Mirrors the
// circleSweepPassable wall gates (head clearance at
// PLAYER_HEIGHT_STAND=24, step-over at STEP_UP_MAX=12).
const BFS_PLAYER_HEIGHT = 24;
const BFS_STEP_UP = 12;

type BfsWall = { ax: number; ay: number; bx: number; by: number };

function wallEndpointsOf(map: any, w: any): BfsWall | null {
  if (
    w.ax !== undefined && w.ay !== undefined &&
    w.bx !== undefined && w.by !== undefined
  ) {
    return { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by };
  }
  const s = map.sectors[w.sectorId];
  if (!s) return null;
  const a = s.verts[w.vertIdx];
  const b = s.verts[(w.vertIdx + 1) % s.verts.length];
  if (!a || !b) return null;
  return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
}

// Walls that block a ground-level walk (same gates as
// circleSweepPassable for a standing player at floorZ=0).
function collectBlockingWalls(map: any): BfsWall[] {
  const out: BfsWall[] = [];
  for (const w of map.walls) {
    const sector = map.sectors[w.sectorId];
    if (!sector) continue;
    // Open seam between sectors: passable.
    if (!w.solid && w.floorZOverride === undefined && w.ceilingZOverride === undefined) continue;
    const top = w.ceilingZOverride !== undefined ? w.ceilingZOverride : sector.ceilingZ;
    const bot = w.floorZOverride !== undefined ? w.floorZOverride : sector.floorZ;
    if (bot >= BFS_PLAYER_HEIGHT) continue; // lintel — walk under
    if (top <= BFS_STEP_UP) continue;       // low riser — step over
    const ends = wallEndpointsOf(map, w);
    if (ends) out.push(ends);
  }
  return out;
}

function segsIntersect(
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number,
): boolean {
  const d1x = p1x - p0x, d1y = p1y - p0y;
  const d2x = p3x - p2x, d2y = p3y - p2y;
  const denom = d1x * d2y - d1y * d2x;
  const EPS = 1e-9;
  if (Math.abs(denom) < EPS) {
    // Parallel — treat collinear touching as blocking only if
    // the segments overlap on a positive length.
    const cross = (p2x - p0x) * d1y - (p2y - p0y) * d1x;
    if (Math.abs(cross) > 0.5 * Math.hypot(d1x, d1y)) return false;
    const len1Sq = d1x * d1x + d1y * d1y;
    if (len1Sq === 0) return false;
    const ta = ((p2x - p0x) * d1x + (p2y - p0y) * d1y) / len1Sq;
    const tb = ((p3x - p0x) * d1x + (p3y - p0y) * d1y) / len1Sq;
    return Math.min(1, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) > 1e-6;
  }
  const t = ((p2x - p0x) * d2y - (p2y - p0y) * d2x) / denom;
  const u = ((p2x - p0x) * d1y - (p2y - p0y) * d1x) / denom;
  return t >= -1e-6 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6;
}

type FloorBfs = {
  reach: (fromX: number, fromY: number, toX: number, toY: number) => boolean;
};

// Build a BFS context over the layout's walkable tiles. Crossings
// between adjacent tiles are pre-resolved against the blocking
// walls (cell-bucketed so the wall scan stays local).
function buildFloorBfs(
  layout: any,
  blockedTiles: Set<string>,
): FloorBfs | null {
  const grid = layout.tileGrid;
  const map = layout.authoredSectorMap;
  if (!grid || !map) return null;
  const ts = grid.tileSize;
  const tiles = Buffer.from(grid.tilesB64, 'base64');
  const W = grid.width;
  const H = grid.height;
  const walls = collectBlockingWalls(map);
  // Bucket walls by tile cell touched by their bounding box.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const x0 = Math.floor(Math.min(w.ax, w.bx) / ts) - 1;
    const x1 = Math.floor(Math.max(w.ax, w.bx) / ts) + 1;
    const y0 = Math.floor(Math.min(w.ay, w.by) / ts) - 1;
    const y1 = Math.floor(Math.max(w.ay, w.by) / ts) + 1;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = `${cx}:${cy}`;
        const list = buckets.get(k);
        if (list) list.push(i);
        else buckets.set(k, [i]);
      }
    }
  }
  const walkable = (lx: number, ly: number): boolean => {
    if (lx < 0 || ly < 0 || lx >= W || ly >= H) return false;
    if (tiles[ly * W + lx] === 0) return false;
    const tx = lx + grid.originTileX;
    const ty = ly + grid.originTileY;
    return !blockedTiles.has(`${tx}:${ty}`);
  };
  const moveAllowed = (lx0: number, ly0: number, lx1: number, ly1: number): boolean => {
    const cx0 = (lx0 + grid.originTileX + 0.5) * ts;
    const cy0 = (ly0 + grid.originTileY + 0.5) * ts;
    const cx1 = (lx1 + grid.originTileX + 0.5) * ts;
    const cy1 = (ly1 + grid.originTileY + 0.5) * ts;
    const seen = new Set<number>();
    for (const cell of [
      `${lx0 + grid.originTileX}:${ly0 + grid.originTileY}`,
      `${lx1 + grid.originTileX}:${ly1 + grid.originTileY}`,
    ]) {
      const list = buckets.get(cell);
      if (!list) continue;
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        const w = walls[i];
        if (segsIntersect(cx0, cy0, cx1, cy1, w.ax, w.ay, w.bx, w.by)) return false;
      }
    }
    return true;
  };
  return {
    reach(fromX, fromY, toX, toY) {
      const sx = Math.floor(fromX / ts) - grid.originTileX;
      const sy = Math.floor(fromY / ts) - grid.originTileY;
      const txg = Math.floor(toX / ts) - grid.originTileX;
      const tyg = Math.floor(toY / ts) - grid.originTileY;
      if (!walkable(sx, sy) || !walkable(txg, tyg)) return false;
      const visited = new Uint8Array(W * H);
      const queue: number[] = [sy * W + sx];
      visited[sy * W + sx] = 1;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const lx = cur % W;
        const ly = Math.floor(cur / W);
        if (lx === txg && ly === tyg) return true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = lx + dx;
          const ny = ly + dy;
          if (!walkable(nx, ny)) continue;
          const ni = ny * W + nx;
          if (visited[ni]) continue;
          if (!moveAllowed(lx, ly, nx, ny)) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }
      return false;
    },
  };
}

// Sweep ~30 seeds x 3 floors asserting:
//  - doors OPEN: spawn reaches stairs_down AND extract_pad
//  - doors CLOSED (locked-room door tiles impassable): spawn
//    still reaches stairs (locked rooms are optional content)
//  - stairs / extract rooms are never locked
function connectivitySweep(): string[] {
  const failures: string[] = [];
  let checked = 0;
  const ceilCounts = new Map<number, number>();
  const corridorCeilCounts = new Map<number, number>();
  let headroomViolations = 0;
  for (let seed = 1; seed <= 30; seed++) {
    for (let floor = 1; floor <= 3; floor++) {
      const layout = generateFloorLayout(seed, 1, floor, 'default');
      const meta = generateLockedRoomMeta(layout, seed, 1, floor);
      checked++;
      const stairs = layout.interactables.find((i: any) => i.kind === 'stairs_down');
      const extract = layout.interactables.find((i: any) => i.kind === 'extract_pad');
      if (!stairs || !extract) {
        failures.push(`seed=${seed} floor=${floor}: missing ${!stairs ? 'stairs' : 'extract'}`);
        continue;
      }
      // Locked-room placement sanity: stairs / extract rooms
      // never locked.
      const roomIndexAt = (x: number, y: number): number => {
        for (let i = 0; i < layout.rooms.length; i++) {
          const r = layout.rooms[i];
          if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
        }
        return -1;
      };
      const stairsRoom = roomIndexAt(stairs.x, stairs.y);
      const extractRoom = roomIndexAt(extract.x, extract.y);
      for (const idx of meta.lockedRoomIndices) {
        if (idx === stairsRoom) failures.push(`seed=${seed} floor=${floor}: stairs room ${idx} LOCKED`);
        if (idx === extractRoom) failures.push(`seed=${seed} floor=${floor}: extract room ${idx} LOCKED`);
      }
      // Ceiling stats + headroom invariants. Corridor region
      // indices come from the doorway corridor flags.
      const map = (layout as any).authoredSectorMap;
      const dwsAll = (layout as any).doorways ?? [];
      const corridorIdx = new Set<number>();
      for (const dw of dwsAll) {
        if (dw.aIsCorridor) corridorIdx.add(dw.a);
        if (dw.bIsCorridor) corridorIdx.add(dw.b);
      }
      if (map) {
        const ROOM_CEILS = new Set([48, 64, 80, 96]);
        const CORRIDOR_CEILS = new Set([40, 48]);
        const inPoly = (verts: any[], x: number, y: number): boolean => {
          let inside = false;
          for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
            const a = verts[i], b = verts[j];
            if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
              inside = !inside;
            }
          }
          return inside;
        };
        for (const s of map.sectors) {
          if (s.buildingKind !== undefined) continue;
          if (s.ceilingZ <= s.floorZ) continue;
          if (s.floorZ === 0) {
            // Room / corridor sector. Region-indexed sector ids
            // 0..regions-1 align with layout.rooms.
            const isCorridor = corridorIdx.has(s.id);
            const tallyMap = isCorridor ? corridorCeilCounts : ceilCounts;
            tallyMap.set(s.ceilingZ, (tallyMap.get(s.ceilingZ) ?? 0) + 1);
            // Flagged corridors must be in the corridor set; a
            // sector without doorway flags could be either kind
            // (a corridor whose doorways all failed has no flag),
            // so accept the union there.
            const allowed = isCorridor
              ? CORRIDOR_CEILS.has(s.ceilingZ)
              : ROOM_CEILS.has(s.ceilingZ) || CORRIDOR_CEILS.has(s.ceilingZ);
            if (!allowed) {
              failures.push(
                `seed=${seed} floor=${floor}: sector ${s.id} unexpected ceilingZ ${s.ceilingZ}`,
              );
            }
            continue;
          }
          // Vertical sub-sector (pit / platform). Jump headroom:
          // >= 40 between its floor (platform top) and ceiling.
          if (s.floorZ > 0 && s.ceilingZ - s.floorZ < 40) {
            headroomViolations++;
            failures.push(
              `seed=${seed} floor=${floor}: platform sector ${s.id} headroom ${s.ceilingZ - s.floorZ} < 40`,
            );
          }
          // Pits / platforms keep the PARENT room's ceiling.
          let cx = 0, cy = 0;
          for (const v of s.verts) { cx += v.x; cy += v.y; }
          cx /= s.verts.length; cy /= s.verts.length;
          let parent: any = null;
          let parentArea = Infinity;
          for (const p of map.sectors) {
            if (p.id === s.id || p.buildingKind !== undefined) continue;
            if (p.floorZ !== 0 || p.ceilingZ <= p.floorZ) continue;
            if (!inPoly(p.verts, cx, cy)) continue;
            let area = 0;
            for (let i = 0; i < p.verts.length; i++) {
              const a = p.verts[i], b = p.verts[(i + 1) % p.verts.length];
              area += a.x * b.y - b.x * a.y;
            }
            area = Math.abs(area) / 2;
            if (area < parentArea) { parentArea = area; parent = p; }
          }
          if (parent && parent.ceilingZ !== s.ceilingZ) {
            failures.push(
              `seed=${seed} floor=${floor}: sub-sector ${s.id} ceil ${s.ceilingZ} != parent ${parent.id} ceil ${parent.ceilingZ}`,
            );
          }
        }
      }
      // Doors-open BFS.
      const openBfs = buildFloorBfs(layout, new Set());
      if (!openBfs) {
        failures.push(`seed=${seed} floor=${floor}: no tileGrid/sectorMap`);
        continue;
      }
      if (!openBfs.reach(layout.spawn.x, layout.spawn.y, stairs.x, stairs.y)) {
        failures.push(`seed=${seed} floor=${floor}: OPEN spawn !-> stairs`);
      }
      if (!openBfs.reach(layout.spawn.x, layout.spawn.y, extract.x, extract.y)) {
        failures.push(`seed=${seed} floor=${floor}: OPEN spawn !-> extract`);
      }
      // Doors-closed BFS: every locked-room door tile blocked.
      const doorTiles = new Set<string>();
      for (const d of meta.doors) doorTiles.add(`${d.tileX}:${d.tileY}`);
      const closedBfs = buildFloorBfs(layout, doorTiles);
      if (closedBfs && !closedBfs.reach(layout.spawn.x, layout.spawn.y, stairs.x, stairs.y)) {
        failures.push(`seed=${seed} floor=${floor}: CLOSED spawn !-> stairs (locked doors gate progression)`);
      }
    }
  }
  console.log(`\nconnectivity sweep: ${checked} floors checked, ${failures.length} failures`);
  const fmt = (m: Map<number, number>) =>
    [...m.entries()].sort((a, b) => a[0] - b[0]).map(([z, n]) => `${z}:${n}`).join(' ') || 'none';
  console.log(`room-sector ceiling distribution (floorZ=0 sectors): ${fmt(ceilCounts)}`);
  console.log(`corridor ceiling distribution: ${fmt(corridorCeilCounts)}`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  return failures;
}

async function main() {
  await initBiomes();
  await initRooms();
  connectivitySweep();
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
