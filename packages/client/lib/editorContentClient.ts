// Thin client for the /api/editor/content/<area> route. Wraps
// fetch with typed helpers so editor pages don't repeat the
// boilerplate. All errors surface as thrown Error objects with
// the API's message string — caller is expected to catch and
// toast.

'use client';

import type {
  AnimationDef,
  AttachmentDefData,
  BiomeDef,
  BlueprintDef,
  CorridorTemplate,
  EnemyDef,
  PropDef,
  RecipeDef,
  RoomTemplate,
  WeaponDef,
} from '@dumrunner/shared';
import type { EditorArea } from '@dumrunner/shared/content/loader';

// One row per EditorArea — extending the union in loader.ts adds
// a type-error here that pins the new schema. Any new editor
// area gets caught at compile time.
type Schema = {
  biomes: BiomeDef;
  enemies: EnemyDef;
  props: PropDef;
  rooms: RoomTemplate;
  corridors: CorridorTemplate;
  blueprints: BlueprintDef;
  weapons: WeaponDef;
  recipes: RecipeDef;
  attachments: AttachmentDefData;
  animations: AnimationDef;
};
type Area = EditorArea;

const BASE = '/api/editor/content';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    const e = await safeError(r);
    throw new Error(e);
  }
  return (await r.json()) as T;
}

async function safeError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string };
    return j.error ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}

export async function listEntities<A extends Area>(
  area: A,
): Promise<Schema[A][]> {
  const { entries } = await getJson<{ entries: Schema[A][] }>(
    `${BASE}/${area}`,
  );
  return entries;
}

export async function saveEntity<A extends Area>(
  area: A,
  data: Schema[A],
): Promise<Schema[A]> {
  const r = await fetch(`${BASE}/${area}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await safeError(r));
  return (await r.json()) as Schema[A];
}

export async function deleteEntity(area: Area, id: string): Promise<void> {
  const r = await fetch(`${BASE}/${area}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error(await safeError(r));
}
