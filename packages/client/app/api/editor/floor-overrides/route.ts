// Floor overrides endpoint for the editor.
//
//   GET  /api/editor/floor-overrides          → FloorOverrides
//   POST /api/editor/floor-overrides  body=FloorOverrides → FloorOverrides
//
// Writes `content/floor-overrides.json`. Server picks the file
// up on the next content-watch tick (scenes area triggers
// re-init of the overrides registry).

import { NextResponse, type NextRequest } from 'next/server';
import {
  loadFloorOverrides,
  saveFloorOverrides,
} from '@dumrunner/shared/content/loader';

export async function GET(): Promise<NextResponse> {
  try {
    const data = await loadFloorOverrides();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON body' },
      { status: 400 },
    );
  }
  try {
    const saved = await saveFloorOverrides(body);
    return NextResponse.json(saved);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422 },
    );
  }
}
