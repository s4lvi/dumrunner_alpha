// Content CRUD endpoint for the editor suite. Persists JSON
// entities under packages/shared/content/<area>/<id>.json.
//
//   GET  /api/editor/content/<area>          → { entries: T[] }
//   GET  /api/editor/content/<area>?id=<id>  → T | 404
//   POST /api/editor/content/<area>  body=T  → T (Zod-validated)
//   DELETE /api/editor/content/<area>  body={id} → {}
//
// Area is path-segmented and validated against the loader's
// known set so a malicious caller can't path-traverse via the
// area string.

import { NextResponse, type NextRequest } from 'next/server';
import {
  ATTACHMENT_DEFS,
  BUILDING_REGISTRY,
  CONSUMABLES,
  MATERIALS,
  RECIPES,
  UPGRADES,
  findSpriteFitOffenders,
  type BiomeDef,
  type BlueprintDef,
  type RecipeDef,
} from '@dumrunner/shared';
import {
  deleteEntity,
  isEditorArea,
  loadBiome,
  loadBiomes,
  loadBlueprint,
  loadBlueprints,
  loadCorridor,
  loadCorridors,
  loadEnemies,
  loadEnemy,
  loadProp,
  loadProps,
  loadAnimation,
  loadAnimations,
  loadAttachment,
  loadAttachments,
  loadBuildingOverride,
  loadBuildingOverrides,
  loadRecipe,
  loadRecipes,
  loadRoom,
  loadRooms,
  loadWeapon,
  loadWeapons,
  saveAnimation,
  saveAttachment,
  saveBiome,
  saveBlueprint,
  saveBuildingOverride,
  saveCorridor,
  saveEnemy,
  saveProp,
  saveRecipe,
  saveRoom,
  saveWeapon,
  type EditorArea,
} from '@dumrunner/shared/content/loader';

const SAFE_ID = /^[a-z0-9_-]+$/;

function asArea(area: string): EditorArea | null {
  return isEditorArea(area) ? area : null;
}

const LIST: Record<EditorArea, () => Promise<unknown[]>> = {
  biomes: loadBiomes,
  enemies: loadEnemies,
  props: loadProps,
  rooms: loadRooms,
  corridors: loadCorridors,
  blueprints: loadBlueprints,
  weapons: loadWeapons,
  recipes: loadRecipes,
  attachments: loadAttachments,
  animations: loadAnimations,
  buildings: loadBuildingOverrides,
};
const ONE: Record<EditorArea, (id: string) => Promise<unknown | null>> = {
  biomes: loadBiome,
  enemies: loadEnemy,
  props: loadProp,
  rooms: loadRoom,
  corridors: loadCorridor,
  blueprints: loadBlueprint,
  weapons: loadWeapon,
  recipes: loadRecipe,
  attachments: loadAttachment,
  animations: loadAnimation,
  buildings: loadBuildingOverride,
};
const SAVE: Record<EditorArea, (data: unknown) => Promise<unknown>> = {
  biomes: saveBiome,
  enemies: saveEnemy,
  props: saveProp,
  rooms: saveRoom,
  corridors: saveCorridor,
  blueprints: saveBlueprint,
  weapons: saveWeapon,
  recipes: saveRecipe,
  attachments: saveAttachment,
  animations: saveAnimation,
  buildings: saveBuildingOverride,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ area: string }> },
) {
  const { area: rawArea } = await ctx.params;
  const area = asArea(rawArea);
  if (!area) {
    return NextResponse.json({ error: 'unknown area' }, { status: 400 });
  }
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    if (!SAFE_ID.test(id)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }
    try {
      const entity = await ONE[area](id);
      if (!entity) {
        return NextResponse.json({ error: 'not found' }, { status: 404 });
      }
      return NextResponse.json(entity);
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message },
        { status: 500 },
      );
    }
  }
  try {
    const entries = await LIST[area]();
    return NextResponse.json({ entries });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ area: string }> },
) {
  const { area: rawArea } = await ctx.params;
  const area = asArea(rawArea);
  if (!area) {
    return NextResponse.json({ error: 'unknown area' }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  // Cross-area validation runs BEFORE the per-file Zod parse so
  // referential errors (missing recipe, dangling prereq, cycle in
  // DAG, oversized sprite) get a usable error string instead of a
  // generic schema failure.
  if (area === 'blueprints') {
    const err = await validateBlueprintSave(body as Partial<BlueprintDef>);
    if (err) {
      return NextResponse.json({ error: err }, { status: 422 });
    }
  } else if (area === 'biomes') {
    const err = await validateBiomeSave(body as BiomeDef);
    if (err) {
      return NextResponse.json({ error: err }, { status: 422 });
    }
  } else if (area === 'recipes') {
    const err = await validateRecipeSave(body as RecipeDef);
    if (err) {
      return NextResponse.json({ error: err }, { status: 422 });
    }
  }
  try {
    const saved = await SAVE[area](body);
    return NextResponse.json(saved);
  } catch (e) {
    // Zod / loader errors include enough detail to surface in the
    // editor's error toast. They're caused by bad input, not
    // server faults, so 422 (unprocessable entity) is the honest
    // status code.
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422 },
    );
  }
}

// Validates a draft BiomeDef against the live enemy + prop
// content. Today's rule: no roster / palette entry whose sprite
// is taller than the biome's wallHeightTiles — sprites that
// don't fit through the ceiling clip the renderer.
// Per-file Zod shape validation still runs after this in
// saveBiome.
async function validateBiomeSave(draft: BiomeDef): Promise<string | null> {
  // Need the actual enemy + prop defs to read sprite sizes.
  // Lazy-loaded here so non-biome saves pay nothing.
  const [enemies, props] = await Promise.all([loadEnemies(), loadProps()]);
  const enemyMap = new Map(enemies.map((e) => [e.id, e]));
  const propMap = new Map(props.map((p) => [p.id, p]));
  const offenders = findSpriteFitOffenders(draft, enemyMap, propMap);
  if (offenders.length === 0) return null;
  const wallH = draft.wallHeightTiles ?? 1;
  const lines = offenders.map(
    (o) =>
      `  - ${o.kind} "${o.id}" is ${o.spriteTiles.toFixed(2)} tiles tall`,
  );
  return (
    `wall height (${wallH.toFixed(2)} tiles) too short for the following ` +
    `roster entries:\n${lines.join('\n')}\n` +
    'raise wallHeightTiles or remove these entries from the biome.'
  );
}

// Closed-set ammo kinds used by the runtime AmmoKind union.
// Lives in inventory.ts and isn't exported as a runtime value —
// duplicated here on purpose. If the AmmoKind union gains an
// entry this list needs updating.
const AMMO_KINDS = new Set([
  'pistol_basic',
  'smg_basic',
  'shotgun_shells',
  'rifle_rounds',
  'sniper_rounds',
  'heavy_slugs',
  'energy_cells',
]);

// Cross-area validation for a draft RecipeDef. Per-file Zod has
// already enforced shape; this layer checks that every id the
// recipe references resolves against the live registries.
async function validateRecipeSave(draft: RecipeDef): Promise<string | null> {
  const errs: string[] = [];
  // Workstation. Empty (hand-craftable) is fine; otherwise must
  // be a known building marked as a workstation.
  if (draft.workstation !== null) {
    const reg = BUILDING_REGISTRY[draft.workstation as keyof typeof BUILDING_REGISTRY];
    if (!reg) {
      errs.push(`workstation "${draft.workstation}" isn't a known BuildingKind`);
    } else if (!reg.isWorkstation) {
      errs.push(`building "${draft.workstation}" exists but isn't flagged isWorkstation`);
    }
  }
  // Blueprint. Same gate the blueprint editor uses — must resolve
  // when set. Loaded lazily to avoid taking the hit on every save.
  if (draft.blueprintId !== null) {
    const blueprints = await loadBlueprints();
    if (!blueprints.some((b) => b.id === draft.blueprintId)) {
      errs.push(`blueprintId "${draft.blueprintId}" doesn't exist`);
    }
  }
  // Validate every input + output id by kind.
  for (let i = 0; i < draft.inputs.length; i++) {
    const inp = draft.inputs[i];
    const msg = await validateRefByKind(inp, `inputs[${i}]`);
    if (msg) errs.push(msg);
  }
  const outMsg = await validateRefByKind(draft.output, 'output');
  if (outMsg) errs.push(outMsg);
  return errs.length === 0 ? null : errs.join('\n');
}

// Per-kind id resolution. Materials / consumables / upgrades /
// buildings are closed runtime registries on this server; ammo
// is a hardcoded set; weapons come from the JSON content.
async function validateRefByKind(
  ref:
    | { kind: 'material'; materialId: string }
    | { kind: 'ammo'; ammoId: string }
    | { kind: 'weapon'; weaponId: string }
    | { kind: 'placeable'; buildingKind: string }
    | { kind: 'attachment'; defId: string }
    | { kind: 'consumable'; consumableId: string }
    | { kind: 'upgrade'; upgradeId: string },
  fieldPath: string,
): Promise<string | null> {
  switch (ref.kind) {
    case 'material':
      if (!(ref.materialId in MATERIALS)) {
        return `${fieldPath}: material "${ref.materialId}" doesn't exist`;
      }
      return null;
    case 'ammo':
      if (!AMMO_KINDS.has(ref.ammoId)) {
        return `${fieldPath}: ammo "${ref.ammoId}" isn't a known AmmoKind`;
      }
      return null;
    case 'weapon': {
      const weapons = await loadWeapons();
      if (!weapons.some((w) => w.id === ref.weaponId)) {
        return `${fieldPath}: weapon "${ref.weaponId}" doesn't exist`;
      }
      return null;
    }
    case 'placeable':
      if (!(ref.buildingKind in BUILDING_REGISTRY)) {
        return `${fieldPath}: buildingKind "${ref.buildingKind}" doesn't exist`;
      }
      return null;
    case 'attachment':
      if (!(ref.defId in ATTACHMENT_DEFS)) {
        return `${fieldPath}: attachment def "${ref.defId}" doesn't exist`;
      }
      return null;
    case 'consumable':
      if (!(ref.consumableId in CONSUMABLES)) {
        return `${fieldPath}: consumable "${ref.consumableId}" doesn't exist`;
      }
      return null;
    case 'upgrade':
      if (!(ref.upgradeId in UPGRADES)) {
        return `${fieldPath}: upgrade "${ref.upgradeId}" doesn't exist`;
      }
      return null;
  }
}

// Validates a draft BlueprintDef against the rest of the catalog
// + the live RECIPES table. Returns null on success, a
// human-readable error string on failure. Per-file Zod shape
// validation still runs after this in saveBlueprint — this layer
// only catches the cross-cutting rules.
async function validateBlueprintSave(
  draft: Partial<BlueprintDef>,
): Promise<string | null> {
  if (typeof draft.id !== 'string' || !SAFE_ID.test(draft.id)) {
    return 'invalid or missing id';
  }
  if (typeof draft.recipeId !== 'string' || draft.recipeId.length === 0) {
    return 'recipeId is required';
  }
  if (!(draft.recipeId in RECIPES)) {
    return `recipeId "${draft.recipeId}" doesn't exist in RECIPES`;
  }
  // Prerequisites must reference existing blueprints. Self-reference
  // is rejected as a degenerate cycle.
  const prereqs = Array.isArray(draft.prerequisites)
    ? draft.prerequisites
    : [];
  if (prereqs.includes(draft.id)) {
    return `${draft.id} cannot list itself as a prerequisite`;
  }
  if (prereqs.length > 0) {
    const existing = await loadBlueprints();
    const others = new Map(existing.map((b) => [b.id, b]));
    // Allow prereqs that already exist on disk; the draft entry
    // itself may be new (not yet saved).
    for (const pre of prereqs) {
      if (pre !== draft.id && !others.has(pre)) {
        return `prerequisite "${pre}" doesn't exist`;
      }
    }
    // Cycle check: simulate the catalog with the draft applied,
    // then DFS for back-edges.
    const simulated = new Map(others);
    simulated.set(draft.id, {
      id: draft.id,
      recipeId: draft.recipeId,
      displayName: draft.displayName ?? draft.id,
      description: draft.description ?? '',
      cost: draft.cost ?? 0,
      tier: draft.tier ?? 'common',
      prerequisites: prereqs,
    });
    const cycle = findBlueprintCycle(simulated, draft.id);
    if (cycle) {
      return `prerequisite cycle: ${cycle.join(' → ')}`;
    }
  }
  return null;
}

// DFS from the start node, return the first cycle's path or null.
// Uses a recursion-stack set so back-edges are detected on the
// way down rather than after a full sweep.
function findBlueprintCycle(
  catalog: Map<string, BlueprintDef>,
  start: string,
): string[] | null {
  const visiting = new Set<string>();
  const stack: string[] = [];
  function visit(id: string): string[] | null {
    if (visiting.has(id)) {
      // Trim stack to the back-edge target so the returned path
      // reads as a clean cycle (start of cycle → … → start).
      const i = stack.indexOf(id);
      const slice = i >= 0 ? stack.slice(i) : stack.slice();
      slice.push(id);
      return slice;
    }
    const entry = catalog.get(id);
    if (!entry) return null;
    visiting.add(id);
    stack.push(id);
    for (const pre of entry.prerequisites ?? []) {
      const found = visit(pre);
      if (found) return found;
    }
    visiting.delete(id);
    stack.pop();
    return null;
  }
  return visit(start);
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ area: string }> },
) {
  const { area: rawArea } = await ctx.params;
  const area = asArea(rawArea);
  if (!area) {
    return NextResponse.json({ error: 'unknown area' }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const { id } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  try {
    await deleteEntity(area, id);
    return NextResponse.json({});
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
