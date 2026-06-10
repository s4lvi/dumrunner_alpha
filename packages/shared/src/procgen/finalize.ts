// Pipeline finalize pass. Runs after the generator produces a
// RegionSet, before the assembler builds the SceneLayout.
//
// Pure — biome config and the room-template pool are passed in
// (no module-level registry reads). The server-side caller hands
// in BIOMES + ROOMS; the editor's procgen preview hands in the
// loaded biome JSON + loaded room templates.

import type {
  HazardZoneCategory,
  RoomRole,
  RoomTemplate,
} from '../content/types';
import type { SceneAnchor } from '../protocol';
import { eligibleTemplates, pickTemplate } from '../roomTemplates';
import type { Region, RegionSet } from './regions';

const DEFAULT_TILE_SIZE = 32;

export type RoomStamp = {
  template: RoomTemplate;
  tileX: number;
  tileY: number;
};

export type FinalizeResult = {
  roomGraph: number[][];
  anchors: SceneAnchor[];
  stamps: RoomStamp[];
};

export type FinalizeBiomeConfig = {
  safeRoomChance?: number;
  extremeRoomChance?: number;
};

function roleForCategory(
  index: number,
  spawnIndex: number,
  stairsIndex: number | null,
  category: HazardZoneCategory,
): RoomRole {
  if (index === spawnIndex) return 'safe';
  if (stairsIndex !== null && index === stairsIndex) return 'normal';
  if (category === 'extreme') return 'extreme';
  if (category === 'safe') return 'safe';
  return 'normal';
}

export function finalizeRegions(
  regionSet: RegionSet,
  biome: string,
  biomeConfig: FinalizeBiomeConfig,
  roomTemplates: ReadonlyArray<RoomTemplate>,
  rng: () => number,
  tileSize: number = DEFAULT_TILE_SIZE,
): FinalizeResult {
  const { regions, spawnRegionIndex, stairsRegionIndex } = regionSet;

  const safeChance = biomeConfig.safeRoomChance ?? 0;
  const extremeChance = biomeConfig.extremeRoomChance ?? 0;
  for (let i = 0; i < regions.length; i++) {
    // Corridors are connectors, not gameplay zones — they stay
    // at the base hazard category and never become safe/extreme.
    if (regions[i].kind === 'corridor') {
      regions[i].category = 'hazard';
      continue;
    }
    if (i === spawnRegionIndex) {
      regions[i].category = 'safe';
      continue;
    }
    if (i === stairsRegionIndex) {
      regions[i].category = 'hazard';
      continue;
    }
    const r = rng();
    if (r < safeChance) regions[i].category = 'safe';
    else if (r < safeChance + extremeChance) regions[i].category = 'extreme';
    else regions[i].category = 'hazard';
  }

  const roomGraph: number[][] = regions.map(() => [] as number[]);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (isAdjacent(regions[i], regions[j])) {
        roomGraph[i].push(j);
        roomGraph[j].push(i);
      }
    }
  }

  const anchors: SceneAnchor[] = [];
  const stamps: RoomStamp[] = [];
  const spawnRegion = regions[spawnRegionIndex];
  if (spawnRegion) {
    const c = regionCenterPixel(spawnRegion, tileSize);
    anchors.push({ kind: 'spawn', x: c.x, y: c.y });
    anchors.push({ kind: 'extract', x: c.x, y: c.y - tileSize });
  }
  if (stairsRegionIndex !== null) {
    const stairsRegion = regions[stairsRegionIndex];
    if (stairsRegion) {
      const c = regionCenterPixel(stairsRegion, tileSize);
      anchors.push({ kind: 'stairs_down', x: c.x, y: c.y });
    }
  }

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    // Corridors are connectors, not gameplay rooms — no room
    // templates, no anchors, no enemy spawns. The whole point of
    // separating them out is to let combat happen in the rooms.
    if (r.kind === 'corridor') continue;
    const role = roleForCategory(i, spawnRegionIndex, stairsRegionIndex, r.category);
    const candidates = eligibleTemplates(roomTemplates, biome, role, r.tileW, r.tileH);
    if (candidates.length === 0) continue;
    const tpl = pickTemplate(candidates, rng);
    if (!tpl) continue;
    const tileX = r.tileX + Math.floor((r.tileW - tpl.width) / 2);
    const tileY = r.tileY + Math.floor((r.tileH - tpl.height) / 2);
    stamps.push({ template: tpl, tileX, tileY });
    for (const a of tpl.anchors) {
      anchors.push({
        kind: a.kind,
        x: (tileX + a.tx + 0.5) * tileSize,
        y: (tileY + a.ty + 0.5) * tileSize,
        overrideId: a.overrideId,
      });
    }
  }

  return { roomGraph, anchors, stamps };
}

function isAdjacent(a: Region, b: Region): boolean {
  const ax2 = a.tileX + a.tileW;
  const ay2 = a.tileY + a.tileH;
  const bx2 = b.tileX + b.tileW;
  const by2 = b.tileY + b.tileH;
  if (
    (ax2 === b.tileX || bx2 === a.tileX) &&
    Math.max(a.tileY, b.tileY) < Math.min(ay2, by2)
  ) {
    return true;
  }
  if (
    (ay2 === b.tileY || by2 === a.tileY) &&
    Math.max(a.tileX, b.tileX) < Math.min(ax2, bx2)
  ) {
    return true;
  }
  return false;
}

function regionCenterPixel(
  r: Region,
  tileSize: number,
): { x: number; y: number } {
  return {
    x: (r.tileX + r.tileW / 2) * tileSize,
    y: (r.tileY + r.tileH / 2) * tileSize,
  };
}
