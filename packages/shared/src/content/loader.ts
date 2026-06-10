// Server-side JSON content loader. Reads the per-entity files
// under packages/shared/content/<area>/<id>.json, Zod-validates
// each one, and returns typed registries. Cross-checks the
// filename slug against the entity's `id` field so a renamed
// file doesn't silently shadow a stale cross-reference.
//
// SERVER-ONLY — uses node:fs. Don't import from client code.
// Following the same pattern as ./token (also node-only and
// deliberately not re-exported from packages/shared/src/index.ts).
//
// Path resolution is anchored to this file's location via
// import.meta.url, so it works regardless of which package is
// the current working directory (server boot, Next.js API
// routes, dev shell scripts).

import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AnimationDefSchema,
  AttachmentDefSchema,
  BiomeDefSchema,
  BlueprintDefSchema,
  EnemyDefSchema,
  PropDefSchema,
  RecipeDefSchema,
  CsgSceneSchema,
  FloorOverridesSchema,
  LinedefSceneSchema,
  RoomTemplateSchema,
  SceneDefSchema,
  SectorSceneSchema,
  WeaponDefSchema,
  WorldDefSchema,
  BuildingOverrideSchema,
  type AnimationDef,
  type AttachmentDefData,
  type BiomeDef,
  type BlueprintDef,
  type BuildingOverride,
  type EnemyDef,
  type PropDef,
  type RecipeDef,
  type RoomTemplate,
  type SceneDef,
  type WeaponDef,
  type WorldDef,
} from './types';

// .../packages/shared/src/content/loader.ts → up two = packages/shared,
// then /content puts us at packages/shared/content.
const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTENT_ROOT = join(HERE, '..', '..', 'content');

// Canonical list of editor-managed content areas. Single source
// of truth — every consumer (API route, client API, deleteEntity,
// content tree) imports this instead of redeclaring the union.
export const EDITOR_AREAS = [
  'biomes',
  'enemies',
  'props',
  'rooms',
  'blueprints',
  'weapons',
  'recipes',
  'attachments',
  'animations',
  'buildings',
  'scenes',
] as const;
export type EditorArea = (typeof EDITOR_AREAS)[number];

export function isEditorArea(s: string): s is EditorArea {
  return (EDITOR_AREAS as readonly string[]).includes(s);
}

export function contentDir(area: string): string {
  return join(CONTENT_ROOT, area);
}

// Generic worker. Walks every *.json in the area directory and
// returns the Zod-validated entities. Throws (loud, fail-fast) on
// any malformed file — content is part of the build, broken JSON
// is a deploy-blocker we want to see immediately.
async function loadArea<T extends { id: string }>(
  area: string,
  // 3-arg ZodType lets schemas with .default() / .transform() be
  // accepted here — input type differs from output type once a
  // default is applied. T is the parsed output, the input shape
  // is intentionally widened.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T[]> {
  const dir = contentDir(area);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const f of files) {
    if (extname(f) !== '.json') continue;
    const slug = basename(f, '.json');
    const raw = await fs.readFile(join(dir, f), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `[content] ${area}/${f}: invalid JSON: ${(e as Error).message}`,
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `[content] ${area}/${f}: schema validation failed:\n${result.error.toString()}`,
      );
    }
    if (result.data.id !== slug) {
      throw new Error(
        `[content] ${area}/${f}: id field "${result.data.id}" doesn't match filename slug "${slug}"`,
      );
    }
    out.push(result.data);
  }
  return out;
}

export const loadBiomes = (): Promise<BiomeDef[]> =>
  loadArea('biomes', BiomeDefSchema);
export const loadEnemies = (): Promise<EnemyDef[]> =>
  loadArea('enemies', EnemyDefSchema);
export const loadProps = (): Promise<PropDef[]> =>
  loadArea('props', PropDefSchema);
export const loadRooms = (): Promise<RoomTemplate[]> =>
  loadArea('rooms', RoomTemplateSchema);
export const loadBlueprints = (): Promise<BlueprintDef[]> =>
  loadArea('blueprints', BlueprintDefSchema);
export const loadWeapons = (): Promise<WeaponDef[]> =>
  loadArea('weapons', WeaponDefSchema);
export const loadRecipes = (): Promise<RecipeDef[]> =>
  loadArea('recipes', RecipeDefSchema);
export const loadAttachments = (): Promise<AttachmentDefData[]> =>
  loadArea('attachments', AttachmentDefSchema);
export const loadAnimations = (): Promise<AnimationDef[]> =>
  loadArea('animations', AnimationDefSchema);
export const loadBuildingOverrides = (): Promise<BuildingOverride[]> =>
  loadArea('buildings', BuildingOverrideSchema);
export const loadScenes = (): Promise<SceneDef[]> =>
  loadArea('scenes', SceneDefSchema);

// Single-entity helpers. The editor's API route writes one file
// at a time; the GET endpoint may want to fetch one without
// loading the whole area.
async function loadEntity<T extends { id: string }>(
  area: string,
  id: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const file = join(contentDir(area), `${id}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return null;
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[content] ${area}/${id}.json: ${result.error.toString()}`,
    );
  }
  if (result.data.id !== id) {
    throw new Error(
      `[content] ${area}/${id}.json: id "${result.data.id}" doesn't match filename "${id}"`,
    );
  }
  return result.data;
}

export const loadBiome = (id: string) =>
  loadEntity('biomes', id, BiomeDefSchema);
export const loadEnemy = (id: string) =>
  loadEntity('enemies', id, EnemyDefSchema);
export const loadProp = (id: string) =>
  loadEntity('props', id, PropDefSchema);
export const loadRoom = (id: string) =>
  loadEntity('rooms', id, RoomTemplateSchema);
export const loadBlueprint = (id: string) =>
  loadEntity('blueprints', id, BlueprintDefSchema);
export const loadWeapon = (id: string) =>
  loadEntity('weapons', id, WeaponDefSchema);
export const loadRecipe = (id: string) =>
  loadEntity('recipes', id, RecipeDefSchema);
export const loadAttachment = (id: string) =>
  loadEntity('attachments', id, AttachmentDefSchema);
export const loadAnimation = (id: string) =>
  loadEntity('animations', id, AnimationDefSchema);
export const loadBuildingOverride = (id: string) =>
  loadEntity('buildings', id, BuildingOverrideSchema);
export const loadScene = (id: string) =>
  loadEntity('scenes', id, SceneDefSchema);

// Save validates BEFORE writing — a malformed payload from the
// editor's POST handler can never make it onto disk. The schema
// also enforces id-as-slug via the strict() string id, so the
// filename reflects the entity id with no escaping.
async function saveEntity<T extends { id: string }>(
  area: string,
  data: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `[content] save validation failed (${area}):\n${result.error.toString()}`,
    );
  }
  const dir = contentDir(area);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${result.data.id}.json`);
  await fs.writeFile(file, JSON.stringify(result.data, null, 2) + '\n', 'utf8');
  return result.data;
}

export const saveBiome = (data: unknown) =>
  saveEntity('biomes', data, BiomeDefSchema);
export const saveEnemy = (data: unknown) =>
  saveEntity('enemies', data, EnemyDefSchema);
export const saveProp = (data: unknown) =>
  saveEntity('props', data, PropDefSchema);
export const saveRoom = (data: unknown) =>
  saveEntity('rooms', data, RoomTemplateSchema);
export const saveBlueprint = (data: unknown) =>
  saveEntity('blueprints', data, BlueprintDefSchema);
export const saveWeapon = (data: unknown) =>
  saveEntity('weapons', data, WeaponDefSchema);
export const saveRecipe = (data: unknown) =>
  saveEntity('recipes', data, RecipeDefSchema);
export const saveAttachment = (data: unknown) =>
  saveEntity('attachments', data, AttachmentDefSchema);
export const saveAnimation = (data: unknown) =>
  saveEntity('animations', data, AnimationDefSchema);
export const saveBuildingOverride = (data: unknown) =>
  saveEntity('buildings', data, BuildingOverrideSchema);
// Shape-discriminate before validating so the Zod error (if any)
// comes from ONE schema, not the union of three — half the noise
// when something does fail.
export const saveScene = async (data: unknown): Promise<SceneDef> => {
  const obj =
    !!data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : null;
  const looksCsg = obj?.kind === 'csg';
  const looksLinedef =
    !!obj &&
    'map' in obj &&
    !!obj.map &&
    Array.isArray((obj.map as Record<string, unknown>).linedefs);
  const schema = (
    looksCsg
      ? CsgSceneSchema
      : looksLinedef
        ? LinedefSceneSchema
        : SectorSceneSchema
  ) as unknown as z.ZodType<SceneDef>;
  return saveEntity('scenes', data, schema);
};

// World config — single file, not file-per-entity. Read at
// boot; absent / malformed = empty config (no overrides).
const WORLD_FILE = join(CONTENT_ROOT, 'world.json');

export async function loadWorld(): Promise<WorldDef> {
  let raw: string;
  try {
    raw = await fs.readFile(WORLD_FILE, 'utf8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { bandBiomes: {} };
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  const result = WorldDefSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[content] world.json: ${result.error.toString()}`,
    );
  }
  return result.data;
}

// Floor overrides — single JSON file that pins authored scene
// ids to dungeon floor indices. Loaded at server boot, queried
// before procgen for every floor.
const FLOOR_OVERRIDES_FILE = join(CONTENT_ROOT, 'floor-overrides.json');

export async function loadFloorOverrides(): Promise<
  import('./types').FloorOverrides
> {
  let raw: string;
  try {
    raw = await fs.readFile(FLOOR_OVERRIDES_FILE, 'utf8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return {};
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  const result = FloorOverridesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[content] floor-overrides.json: ${result.error.toString()}`,
    );
  }
  return result.data;
}

export async function saveFloorOverrides(
  data: unknown,
): Promise<import('./types').FloorOverrides> {
  const result = FloorOverridesSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `[content] floor-overrides save validation failed:\n${result.error.toString()}`,
    );
  }
  await fs.mkdir(CONTENT_ROOT, { recursive: true });
  await fs.writeFile(
    FLOOR_OVERRIDES_FILE,
    JSON.stringify(result.data, null, 2) + '\n',
    'utf8',
  );
  return result.data;
}

export async function saveWorld(data: unknown): Promise<WorldDef> {
  const result = WorldDefSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `[content] world save validation failed:\n${result.error.toString()}`,
    );
  }
  await fs.mkdir(CONTENT_ROOT, { recursive: true });
  await fs.writeFile(
    WORLD_FILE,
    JSON.stringify(result.data, null, 2) + '\n',
    'utf8',
  );
  return result.data;
}

export async function deleteEntity(
  area: EditorArea,
  id: string,
): Promise<void> {
  // Slug guard: the API route also validates, but defending here
  // means accidental ../ in args to this module's callers can't
  // escape the content dir.
  if (!/^[a-z0-9_-]+$/.test(id)) {
    throw new Error(`[content] invalid id: ${id}`);
  }
  const file = join(contentDir(area), `${id}.json`);
  try {
    await fs.unlink(file);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') throw e;
  }
}
