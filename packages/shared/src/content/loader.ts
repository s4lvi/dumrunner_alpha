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
  BiomeDefSchema,
  CorridorTemplateSchema,
  EnemyDefSchema,
  PropDefSchema,
  RoomTemplateSchema,
  WorldDefSchema,
  type BiomeDef,
  type CorridorTemplate,
  type EnemyDef,
  type PropDef,
  type RoomTemplate,
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
  'corridors',
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
  schema: z.ZodType<T>,
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
export const loadCorridors = (): Promise<CorridorTemplate[]> =>
  loadArea('corridors', CorridorTemplateSchema);

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
export const loadCorridor = (id: string) =>
  loadEntity('corridors', id, CorridorTemplateSchema);

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
export const saveCorridor = (data: unknown) =>
  saveEntity('corridors', data, CorridorTemplateSchema);

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
