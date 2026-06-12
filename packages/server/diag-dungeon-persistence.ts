// Dungeon-persistence diagnostic. Reproduces the "page refresh resets
// the dungeon" report against the REAL World class:
//
//   Flow A — same-process refresh:
//     join → descend → kill an enemy + pick up loot → last-player
//     disconnect (World.remove: flushSnapshot/stopTimers/idle path)
//     → rejoin → descend again. PASS = same Scene instance, enemy
//     stays dead, picked-up loot stays gone.
//
//   Flow B — process reboot (snapshot round-trip):
//     buildSnapshot() from world A → fresh World instance → replay
//     the world.hydrate() scene-restore loop (world.ts:589-603)
//     → descend. PASS = enemy stays dead, picked-up loot stays gone
//     in the recreated dungeon scene.
//
// Run from packages/server:
//   NEXT_PUBLIC_SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x \
//   JOIN_TOKEN_SECRET=x npx tsx diag-dungeon-persistence.ts
//
// Supabase calls (persistConnection / flushSnapshot upserts) fail
// against the dummy URL and log errors — expected noise; the diag
// only exercises in-memory state.
import { initTemplates } from './src/ai/templates.js';
import { initBiomes } from './src/biomes.js';
import { initBlueprints } from './src/blueprints.js';
import { initProps } from './src/props.js';
import { initBuildingOverrides } from './src/buildingOverrides.js';
import { initRooms } from './src/rooms.js';
import { initWeapons } from './src/weapons.js';
import { initRecipes } from './src/recipes.js';
import { initAttachments } from './src/attachments.js';
import { initFloorOverrides } from './src/floorOverrides.js';
import { buildStarterInventory } from './src/starter.js';
import { World } from './src/world.js';
import { emptyEquipment, type Player } from '@dumrunner/shared';
import type { WebSocket } from 'ws';

await initTemplates();
await initBiomes();
await initProps();
await initBuildingOverrides();
await initRooms();
await initBlueprints();
await initWeapons();
await initRecipes();
await initAttachments();
await initFloorOverrides();

const CID = 'diag-character';
const SEED = 1234;

function fakeWs(): WebSocket {
  return {
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close: () => {},
  } as unknown as WebSocket;
}

function mkPlayer(): Player {
  return {
    characterId: CID,
    accountId: 'diag-account',
    displayName: 'diag',
    x: 0,
    y: 0,
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
    shield: 0,
    maxShield: 0,
    alive: true,
  };
}

// Private-member access. Deliberate — the diag drives the real World
// API (add / remove / onInteractable) and only reaches inside to
// observe state and skip the WS/Supabase layers.
/* eslint-disable @typescript-eslint/no-explicit-any */
function priv(o: unknown): any {
  return o as any;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function join(world: World, ws: WebSocket): void {
  world.add(ws, mkPlayer(), buildStarterInventory(), emptyEquipment());
  // Stop the 50ms tick loop — the diag drives transitions directly and
  // a live tick would let enemies wander/attack between assertions.
  priv(world).stopTimers();
}

function descend(world: World): string {
  const conn = priv(world).connections.get(CID);
  conn.interactCooldownUntil = 0;
  priv(world).onInteractable(CID, 'surface', 'stairs_down');
  return conn.sceneId as string;
}

// ---------- world A: play a bit ----------

const worldA = new World('diag-refresh-world');
priv(worldA).worldSeed = SEED;
priv(worldA).hydrated = true; // never touch world_states

const ws1 = fakeWs();
join(worldA, ws1);
check('A: joined on surface', priv(worldA).connections.get(CID)?.sceneId === 'surface');

const sceneIdA = descend(worldA);
check('A: descended to dungeon:1', sceneIdA === 'dungeon:1', `sceneId=${sceneIdA}`);

const dungeonA = priv(worldA).scenes.get('dungeon:1');
const enemiesA: Map<string, any> = priv(dungeonA).enemies;
const lootA: Map<string, any> = priv(dungeonA).loot;
const aliveBefore = [...enemiesA.values()].filter((e) => e.alive).length;
const target = [...enemiesA.values()].find((e) => e.alive);
check('A: dungeon has live enemies', !!target, `alive=${aliveBefore}`);
if (!target) process.exit(1);

// Kill via the real combat path (scene.ts damageEnemy → enemy_killed).
priv(dungeonA).damageEnemy(target, target.hp, Date.now());
check('A: enemy killed', target.alive === false && target.hp === 0, `id=${target.id}`);

// Simulate a loot pickup: remove one initial floor-scatter loot entry.
const pickedLootId = [...lootA.keys()][0] ?? null;
if (pickedLootId) lootA.delete(pickedLootId);
check('A: loot picked up', pickedLootId !== null, `id=${pickedLootId}`);

// ---------- Flow A: page refresh (disconnect + rejoin, same process) ----------

worldA.remove(CID, ws1); // last player out: flushSnapshot + stopTimers + idle
check('A: world empty after disconnect', priv(worldA).connections.size === 0);

const ws2 = fakeWs();
join(worldA, ws2);
const sceneIdA2 = descend(worldA);
const dungeonA2 = priv(worldA).scenes.get('dungeon:1');

check('FLOW A: rejoin descends to same floor', sceneIdA2 === 'dungeon:1', `sceneId=${sceneIdA2}`);
check('FLOW A: dungeon Scene instance reused (not regenerated)', dungeonA2 === dungeonA);
const targetAfter = priv(dungeonA2).enemies.get(target.id);
check(
  'FLOW A: killed enemy stays dead across refresh',
  targetAfter != null && targetAfter.alive === false,
  `id=${target.id} alive=${targetAfter?.alive}`
);
check(
  'FLOW A: picked-up loot stays gone across refresh',
  pickedLootId !== null && !priv(dungeonA2).loot.has(pickedLootId),
  `id=${pickedLootId}`
);

// ---------- Flow B: process reboot via snapshot round-trip ----------

const snap = priv(worldA).buildSnapshot();
check('B: snapshot includes dungeon:1', !!snap.scenes['dungeon:1']);

const worldB = new World('diag-refresh-world');
priv(worldB).worldSeed = SEED;
priv(worldB).hydrated = true;
priv(worldB).cycle = snap.cycle;
priv(worldB).cycleStartedAt = snap.cycleStartedAt;
// Replays the scene-restore loop from World.hydrate (world.ts:589-603)
// without the Supabase fetch.
for (const [sceneId, sceneSnap] of Object.entries(snap.scenes) as Array<[string, any]>) {
  let scene = priv(worldB).scenes.get(sceneId);
  if (!scene) {
    const m = /^dungeon:(\d+)$/.exec(sceneId);
    if (!m) continue;
    scene = priv(worldB).createDungeonScene(Number(m[1]));
  }
  scene.hydrate(sceneSnap);
}

const ws3 = fakeWs();
join(worldB, ws3);
const sceneIdB = descend(worldB);
const dungeonB = priv(worldB).scenes.get('dungeon:1');
check('FLOW B: reboot descends to dungeon:1', sceneIdB === 'dungeon:1', `sceneId=${sceneIdB}`);
const targetB = priv(dungeonB).enemies.get(target.id);
check(
  'FLOW B: killed enemy stays dead across reboot+hydrate',
  targetB != null && targetB.alive === false,
  `id=${target.id} alive=${targetB?.alive}`
);
check(
  'FLOW B: picked-up loot stays gone across reboot+hydrate',
  pickedLootId !== null && !priv(dungeonB).loot.has(pickedLootId),
  `id=${pickedLootId}`
);

// ---------- Flow C: refresh after an offline gap, REAL tick loop ----------
//
// Design (world.ts tickHordeClock comment): "The clock is paused when
// zero players are connected... an idle overnight server doesn't burn
// cycles." So a disconnect gap must NOT advance the perihelion clock,
// and a rejoin after a gap must NOT fire the horde / reset the dungeon.
// Simulates: player leaves with ~5 min elapsed in the cycle, comes back
// 20 minutes later (cycle length is 15 min by default).

worldB.remove(CID, ws3);
priv(worldB).cancelIdleShutdown();
worldA.remove(CID, ws2); // player leaves → flushSnapshot/stopTimers/idle path
priv(worldA).cancelIdleShutdown();

const GAP_MS = 20 * 60_000;
const PLAYED_MS = 5 * 60_000;
// Rewind the anchors as if the disconnect happened GAP_MS ago with
// PLAYED_MS of cycle time already elapsed.
priv(worldA).cycleStartedAt = Date.now() - GAP_MS - PLAYED_MS;
if (priv(worldA).emptySinceAt !== undefined && priv(worldA).emptySinceAt !== null) {
  priv(worldA).emptySinceAt = Date.now() - GAP_MS;
}
priv(worldA).lastHordeClockAt = Date.now() - GAP_MS;

const ws4 = fakeWs();
worldA.add(ws4, mkPlayer(), buildStarterInventory(), emptyEquipment());
// Let the REAL 50ms tick loop run a few times (tickHordeClock included).
await new Promise((r) => setTimeout(r, 300));
priv(worldA).stopTimers();

const hordeFired = priv(worldA).hordeActive as boolean;
const dungeonC = priv(worldA).scenes.get('dungeon:1');
const targetC = dungeonC ? priv(dungeonC).enemies.get(target.id) : undefined;
check(
  'FLOW C: rejoin after offline gap does NOT fire perihelion',
  hordeFired === false,
  `hordeActive=${hordeFired}`
);
check(
  'FLOW C: dungeon scene survives rejoin-after-gap',
  dungeonC === dungeonA,
  dungeonC === dungeonA ? '' : 'scene dropped/recreated'
);
check(
  'FLOW C: killed enemy still dead after rejoin-after-gap',
  targetC != null && targetC.alive === false,
  `alive=${targetC?.alive}`
);
// Cycle elapsed should be ~PLAYED_MS, not PLAYED_MS+GAP_MS.
const elapsedC = Date.now() - (priv(worldA).cycleStartedAt as number);
check(
  'FLOW C: offline gap excluded from cycle clock',
  elapsedC < PLAYED_MS + 60_000,
  `elapsed=${Math.round(elapsedC / 1000)}s (played ~${PLAYED_MS / 1000}s, gap ${GAP_MS / 1000}s)`
);

// ---------- Flow D: legitimate resets still wipe the dungeon ----------
//
// The fix must not soften the designed resets: endHorde (cycle reset)
// and Power-Link destruction still drop every dungeon scene.

priv(worldA).endHorde(Date.now());
const dungeonD = priv(worldA).scenes.get('dungeon:1');
check(
  'FLOW D: cycle reset (endHorde) still drops dungeon scenes',
  dungeonD === undefined,
  dungeonD === undefined ? '' : 'dungeon:1 survived endHorde'
);
const sceneIdD = descend(worldA);
const dungeonD2 = priv(worldA).scenes.get('dungeon:1');
const targetD = dungeonD2 ? priv(dungeonD2).enemies.values().next().value : undefined;
check(
  'FLOW D: post-reset descent generates a genuinely fresh floor',
  sceneIdD === 'dungeon:1' && dungeonD2 !== dungeonA && targetD?.alive === true,
  `sceneId=${sceneIdD} freshScene=${dungeonD2 !== dungeonA} firstEnemyAlive=${targetD?.alive}`
);

// ---------- cleanup ----------
worldA.remove(CID, ws4);
priv(worldA).cancelIdleShutdown();
priv(worldA).stopTimers();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
// Pending supabase rejections from remove() log asynchronously; exit now.
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 250);
