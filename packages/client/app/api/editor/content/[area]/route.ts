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
  deleteEntity,
  loadBiome,
  loadBiomes,
  loadEnemies,
  loadEnemy,
  loadProp,
  loadProps,
  saveBiome,
  saveEnemy,
  saveProp,
} from '@dumrunner/shared/content/loader';

type Area = 'biomes' | 'enemies' | 'props';

const ALLOWED_AREAS = new Set<Area>(['biomes', 'enemies', 'props']);
const SAFE_ID = /^[a-z0-9_-]+$/;

function asArea(area: string): Area | null {
  return (ALLOWED_AREAS as Set<string>).has(area) ? (area as Area) : null;
}

const LIST: Record<Area, () => Promise<unknown[]>> = {
  biomes: loadBiomes,
  enemies: loadEnemies,
  props: loadProps,
};
const ONE: Record<Area, (id: string) => Promise<unknown | null>> = {
  biomes: loadBiome,
  enemies: loadEnemy,
  props: loadProp,
};
const SAVE: Record<Area, (data: unknown) => Promise<unknown>> = {
  biomes: saveBiome,
  enemies: saveEnemy,
  props: saveProp,
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
