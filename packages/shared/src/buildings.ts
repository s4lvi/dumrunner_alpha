// Single source of truth for per-BuildingKind metadata. Server combat,
// horde AI, power, crafting routing, and client labels all read from
// here. Replaces the old N parallel maps (BUILDING_STATS,
// BUILDING_TARGET_PRIORITY, STATION_KINDS, STATION_PARALLEL_SLOTS,
// STATION_LABEL, prewarm BUILDING_KINDS) — adding a new kind now is one
// entry below plus the BuildingKind union in protocol.ts.

import type { BuildingKind, WorkstationKind } from './protocol';

export type BuildingDef = {
  // Display name shown in the UI ("Workbench", "Power Link"). Use
  // sentence-cased nouns; falls back to the kind id if missing.
  label: string;
  // Total hit points when freshly placed. Doors are conceptually
  // indestructible — any value over a few thousand is fine.
  maxHp: number;
  // Horde-mode targeting priority. Higher = picked first by enemy AI
  // when several targets are in range. 0 / undefined = ignored by
  // hostile pathing (e.g. the player's own placeable that doesn't
  // merit a horde swing). Power Link is the headline objective.
  hordePriority: number;
  // True for any building that can render a station modal — has an
  // output buffer, accepts pickup_station_outputs, etc. Subset of
  // station kinds that ALSO accept craft_request are workstations.
  isStation: boolean;
  // True only for kinds that recipes target via Recipe.workstation.
  // Strictly a subset of isStation — workbench/forge/electronics_bench
  // /weapon_bench. The artifact_uplink is a station (vendor) but not
  // a workstation.
  isWorkstation: boolean;
  // Per-station parallel craft job slot count. Only populated for
  // workstations. Undefined elsewhere; readers should treat as 0.
  parallelSlots?: number;
};

export const BUILDING_REGISTRY: Record<BuildingKind, BuildingDef> = {
  wall: {
    label: 'wall',
    maxHp: 200,
    hordePriority: 10,
    isStation: false,
    isWorkstation: false,
  },
  // Reinforced wall tiers. Same horde priority as the basic wall —
  // enemies path/swing the same way, the player just has more time
  // before the perimeter falls. HP roughly doubles per tier so the
  // upgrade is felt without trivializing perihelion. Materials and
  // station gates are in crafting.ts.
  wall_mk2: {
    label: 'Reinforced Wall',
    maxHp: 400,
    hordePriority: 10,
    isStation: false,
    isWorkstation: false,
  },
  wall_mk3: {
    label: 'Composite Wall',
    maxHp: 800,
    hordePriority: 10,
    isStation: false,
    isWorkstation: false,
  },
  wall_mk4: {
    label: 'Reactive Wall',
    maxHp: 1600,
    hordePriority: 10,
    isStation: false,
    isWorkstation: false,
  },
  turret: {
    label: 'turret',
    maxHp: 120,
    hordePriority: 50,
    isStation: false,
    isWorkstation: false,
  },
  turret_smg: {
    label: 'SMG turret',
    maxHp: 120,
    hordePriority: 50,
    isStation: false,
    isWorkstation: false,
  },
  turret_shotgun: {
    label: 'shotgun turret',
    maxHp: 140,
    hordePriority: 50,
    isStation: false,
    isWorkstation: false,
  },
  turret_rifle: {
    label: 'rifle turret',
    maxHp: 120,
    hordePriority: 50,
    isStation: false,
    isWorkstation: false,
  },
  workbench: {
    label: 'Workbench',
    maxHp: 150,
    hordePriority: 25,
    isStation: true,
    isWorkstation: true,
    parallelSlots: 1,
  },
  forge: {
    label: 'Forge',
    maxHp: 220,
    hordePriority: 25,
    isStation: true,
    isWorkstation: true,
    parallelSlots: 1,
  },
  electronics_bench: {
    label: 'Electronics Bench',
    maxHp: 130,
    hordePriority: 25,
    isStation: true,
    isWorkstation: true,
    parallelSlots: 1,
  },
  weapon_bench: {
    label: 'Weapon Bench',
    maxHp: 160,
    hordePriority: 25,
    isStation: true,
    isWorkstation: true,
    parallelSlots: 1,
  },
  // Precision Machining Mill — vendor-shaped station (modal opens on
  // E, but it accepts no recipes). Hosts the tier-up flow that used
  // to live on the Weapon Bench. Hand-crafted at the Workbench so a
  // brand-new player can stand up the assembly + tier-up pair as
  // soon as they have the alloy/circuit budget.
  precision_mill: {
    label: 'Precision Machining Mill',
    maxHp: 180,
    hordePriority: 25,
    isStation: true,
    isWorkstation: false,
  },
  // Suit Assembly Bench — vendor-shaped sibling of the Weapon
  // Bench, but for suit parts. Hosts the assembly modal that
  // attaches/detaches suit_affix instances to equipped suit parts.
  // No recipes target it; attachments are crafted at the
  // Electronics Bench.
  suit_bench: {
    label: 'Suit Assembly Bench',
    maxHp: 160,
    hordePriority: 25,
    isStation: true,
    isWorkstation: false,
  },
  artifact_uplink: {
    label: 'Artifact Uplink',
    maxHp: 200,
    hordePriority: 25,
    // Vendor: opens a modal (so it's a station from the UX side) but
    // takes no recipes — not a crafting workstation.
    isStation: true,
    isWorkstation: false,
  },
  power_link: {
    label: 'Power Link',
    maxHp: 800,
    hordePriority: 100,
    isStation: false,
    isWorkstation: false,
  },
  // Doors are conceptually indestructible — only opened, not broken.
  // Server skips enemy melee damage on this kind. HP is high so any
  // accidental hit (e.g. a stray projectile path) doesn't kill it.
  door: {
    label: 'Door',
    maxHp: 9999,
    hordePriority: 0,
    isStation: false,
    isWorkstation: false,
  },
  // Player-built openable door for surface bases. Distinct from
  // the dungeon `door` (which is a key-gated locked-room fixture
  // and gets *destroyed* when opened). wall_door persists across
  // open/close cycles, blocks movement + projectiles only when
  // closed, and shares the wall's horde priority so enemies will
  // chew through it once they reach it. Lower HP than wall so
  // it's a real defensive trade-off vs a solid wall.
  wall_door: {
    label: 'Door',
    maxHp: 100,
    hordePriority: 12,
    isStation: false,
    isWorkstation: false,
  },
  // Persistent shared inventory bucket. Contents survive perihelion
  // and process restarts via the world snapshot. UX-side it opens a
  // modal (counts as a station for hover/interact purposes) but
  // hosts no recipes.
  storage_chest: {
    label: 'Storage',
    maxHp: 250,
    hordePriority: 20,
    isStation: true,
    isWorkstation: false,
  },
};

// Convenient ordered list of every kind, e.g. for prewarm callers
// that want to enumerate.
export const BUILDING_KINDS: BuildingKind[] = Object.keys(
  BUILDING_REGISTRY
) as BuildingKind[];

export function buildingDef(kind: BuildingKind): BuildingDef {
  return BUILDING_REGISTRY[kind];
}

export function buildingLabel(kind: BuildingKind): string {
  return BUILDING_REGISTRY[kind]?.label ?? kind;
}

export function isStationKind(kind: BuildingKind): boolean {
  return BUILDING_REGISTRY[kind]?.isStation ?? false;
}

export function isWorkstationKindStrict(
  kind: BuildingKind
): kind is WorkstationKind {
  return BUILDING_REGISTRY[kind]?.isWorkstation ?? false;
}

export function buildingMaxHp(kind: BuildingKind): number {
  return BUILDING_REGISTRY[kind]?.maxHp ?? 100;
}

export function buildingHordePriority(kind: BuildingKind): number {
  return BUILDING_REGISTRY[kind]?.hordePriority ?? 0;
}

export function buildingParallelSlots(kind: BuildingKind): number {
  return BUILDING_REGISTRY[kind]?.parallelSlots ?? 0;
}
