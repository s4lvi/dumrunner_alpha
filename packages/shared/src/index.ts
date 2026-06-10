export * from './protocol';
// `./token` deliberately NOT re-exported here — it depends on node:crypto
// and would poison the client bundle. Server-side callers import from
// '@dumrunner/shared/token' directly.
export * from './geometry';
// Sector / Wall / SectorMap + WallIndex. Authoritative scene
// model for the v2 polygon-collision phase; until that lands,
// only the client v2 renderer reads these.
export * from './sector';
// Linedef scene model (Doom WAD lineage). Refactor target for
// the polygon-per-sector model in `./sector`. Currently shipping
// alongside; phase 5 of v2-finish-plan.md retires `./sector`.
export * from './linedef';
// Pure edit-ops on LinedefMap (add/move/merge vertices, add /
// split linedefs, make sector from interior point). Used by the
// editor canvas; no Pixi imports so they're testable in isolation.
export * from './linedefOps';
// CSG-based scene authoring model. Editor stores shapes as 2D
// polygons + elevation overrides; csgSceneToLinedefScene runs at
// save time to produce the runtime LinedefScene via robust 2D
// polygon boolean operations (polygon-clipping library).
export * from './csg';
// Floor override registry — pins authored scenes to dungeon
// floor indices. Loaded at server boot, consulted before procgen.
export * from './floorOverrides';
// Procedural terrain heightmap. Pure deterministic noise; server
// + client both sample it so the simulation and renderer agree
// on where the ground is.
export * from './terrain';
// SectorScene → SceneLayout converter (rasterise authored
// scenes onto a tile grid for the runtime pipeline). Used by
// the editor's playtest path.
export * from './sceneRasterize';
export * from './inventory';
export * from './crafting';
export * from './buildings';
export * from './visuals';
// Hazard math (E3.3). Pure functions — both server tick and
// client HUD indicator import the same helpers so net DPS shown
// to the player matches what the server applies.
export * from './hazards';
export * from './itemNames';
export * from './weaponStats';
// Editor-suite content schemas (BiomeDef, EnemyDef, PropDef + their
// Zod validators). Foundation for E3.0 — every editor downstream
// imports from here.
export * from './content/types';
// Room template helpers — pure, registry-free. Used by both the
// shared procgen pipeline and the editor's procgen preview path.
export * from './roomTemplates';
// v2 procgen pipeline. Pure — callers hand in biome config +
// room template pool; both the server's procgen.ts and the
// editor's procgen preview endpoint reach the same code.
export * from './procgen';
// Animation runtime — pure state-machine controller used by the
// FPS view-model, enemy / prop / projectile sprites, and the
// biome ambient tile loop. Phase B engine; no Pixi imports so the
// server-side tooling can share it.
export * from './animation';
