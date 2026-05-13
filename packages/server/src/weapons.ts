// Weapon registry boot. Reads
// packages/shared/content/weapons/<id>.json at server boot and
// pushes the loaded definitions into the shared WEAPON_STATS /
// MELEE_STATS / WEAPON_FAMILY tables via setWeaponRegistry.
// Mirrors blueprints.ts / biomes.ts.
//
// The wire shape exposed to clients is the WeaponDef list as-is —
// the client runs the same setter on welcome so both halves of
// the codebase see the same registry without a deploy cycle.

import { loadWeapons } from '@dumrunner/shared/content/loader';
import { setWeaponRegistry, type WeaponDef } from '@dumrunner/shared';

let WEAPONS: WeaponDef[] = [];

export async function initWeapons(): Promise<void> {
  const defs = await loadWeapons();
  if (defs.length === 0) {
    console.warn(
      '[weapons] no weapon JSON files found in shared/content/weapons — combat will refuse to spawn projectiles for unknown kinds',
    );
  } else {
    const ranged = defs.filter((w) => w.family !== 'melee').length;
    const melee = defs.length - ranged;
    console.log(
      `[weapons] loaded ${defs.length} weapons (${ranged} ranged, ${melee} melee)`,
    );
  }
  WEAPONS = defs;
  setWeaponRegistry(defs);
}

// Subset shipped to the client in the welcome message. The client
// calls setWeaponRegistry on receive so its WEAPON_STATS /
// MELEE_STATS / WEAPON_FAMILY tables match the server's.
export function getWeaponsForWire(): WeaponDef[] {
  return WEAPONS;
}
