// v2 procgen entry. Composes generators into a SceneLayout whose
// authoritative geometry is the polygon SectorMap produced by the
// linedef round-trip; a rasterised tile grid rides along so the
// legacy spawn-snap and AI-grid code paths keep working.
//
// Pure — callers pass in biome generator selection, biome category
// weights, and the room template pool. The server's procgen.ts
// reads BIOMES + ROOMS to build the opts; the editor's procgen
// preview endpoint loads the biome JSON + room JSONs to build them.

import type { RoomTemplate } from '../content/types';
import type { SceneLayout } from '../protocol';
import { assembleSceneLayout } from './assemble';
import { decorateRegions } from './decorate';
import { finalizeRegions, type FinalizeBiomeConfig } from './finalize';
import { generateBspRegions } from './generators/bsp';
import { generateTunnelerRegions } from './generators/tunneler';
import { insetAndCorridorize } from './insetAndCorridorize';

export type PipelineOpts = {
  generator: 'bsp' | 'tunneler';
  biomeConfig: FinalizeBiomeConfig;
  roomTemplates: ReadonlyArray<RoomTemplate>;
};

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFloorLayoutPipeline(
  worldSeed: number,
  cycle: number,
  floorIndex: number,
  biome: string,
  opts: PipelineOpts,
): SceneLayout {
  const genRng = mulberry32(
    ((worldSeed * 0x7feb352d) ^
      (cycle * 0x846ca68b) ^
      (floorIndex * 0xc2b2ae35)) >>> 0,
  );
  const finalizeRng = mulberry32(
    ((worldSeed * 0x9e3779b1) ^
      (cycle * 0x85ebca77) ^
      (floorIndex * 0xc2b2ae3d)) >>> 0,
  );

  const regionSet =
    opts.generator === 'tunneler'
      ? generateTunnelerRegions(genRng)
      : generateBspRegions(genRng);
  // BSP-only post-process: shrink each leaf into an inset room
  // and carve corridor rects through the void. Tunneler already
  // produces rooms-and-corridors as distinct rects so we skip.
  if (opts.generator !== 'tunneler') {
    insetAndCorridorize(regionSet, genRng);
  }
  // Decoration: pillar grids in large rooms, chamfered corners
  // on some rooms. Runs after the topology pass so it sees the
  // final inset room shapes.
  decorateRegions(regionSet, finalizeRng);
  const { roomGraph, anchors, stamps } = finalizeRegions(
    regionSet,
    biome,
    opts.biomeConfig,
    opts.roomTemplates,
    finalizeRng,
  );
  return assembleSceneLayout(regionSet, {
    biome,
    floorIndex,
    roomGraph,
    anchors,
    stamps,
  });
}
