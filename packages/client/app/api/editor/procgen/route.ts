// Stateless procgen endpoint. Runs the v2 pipeline with biome
// JSON + room template JSON loaded from disk and returns the
// SceneLayout. Used by the biome editor's top-down preview so it
// doesn't need a running game server to inspect procgen output.

import { NextResponse, type NextRequest } from 'next/server';
import {
  generateFloorLayoutPipeline,
  type RoomTemplate,
} from '@dumrunner/shared';
import { loadBiome, loadRooms } from '@dumrunner/shared/content/loader';

type Body = {
  biome?: string;
  worldSeed?: number;
  cycle?: number;
  floorIndex?: number;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const biome = body.biome?.trim();
  if (!biome) {
    return NextResponse.json({ error: 'biome required' }, { status: 400 });
  }
  const worldSeed = Number.isFinite(body.worldSeed) ? Number(body.worldSeed) : 0;
  const cycle = Number.isFinite(body.cycle) ? Number(body.cycle) : 0;
  const floorIndex = Number.isFinite(body.floorIndex) ? Number(body.floorIndex) : 1;

  const biomeDef = await loadBiome(biome);
  if (!biomeDef) {
    return NextResponse.json(
      { error: `unknown biome: ${biome}` },
      { status: 404 },
    );
  }

  const gen = biomeDef.generation;
  const generator: 'bsp' | 'tunneler' =
    gen?.generator === 'tunneler' ? 'tunneler' : 'bsp';

  let roomTemplates: RoomTemplate[] = [];
  try {
    roomTemplates = await loadRooms();
  } catch {
    // No room templates authored — pipeline still runs, regions
    // just don't get curated stamps.
  }

  try {
    const layout = generateFloorLayoutPipeline(
      worldSeed,
      cycle,
      floorIndex,
      biome,
      {
        generator,
        biomeConfig: {
          safeRoomChance: gen?.safeRoomChance,
          extremeRoomChance: gen?.extremeRoomChance,
        },
        roomTemplates,
      },
    );
    return NextResponse.json({ layout });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
