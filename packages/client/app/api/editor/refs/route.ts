// Cross-reference + asset-health endpoint for the editor.
//
// Walks every authored entity (biomes / enemies / props / rooms)
// and emits two flat lists:
//
//   edges  — every (from-entity → to-entity) link found in the
//            content. Each carries a `field` path so the UI can
//            point at exactly where the reference lives.
//
//   assets — every required asset slot for the current content,
//            with a `present: boolean` flag derived from the
//            on-disk texture pipeline. Missing slots = TODO list
//            for the asset health dashboard.
//
// Computed at request time. Cheap (a few hundred entities at
// most); no caching needed for alpha.

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  loadBiomes,
  loadEnemies,
  loadProps,
  loadRooms,
} from '@dumrunner/shared/content/loader';
import type {
  BiomeDef,
  EnemyDef,
  PropDef,
  RoomTemplate,
} from '@dumrunner/shared';

type EditorArea = 'biomes' | 'enemies' | 'props' | 'rooms';

export type RefEntity = { area: EditorArea; id: string };
export type RefEdge = {
  from: RefEntity;
  to: RefEntity;
  // Dot-path-ish description of where in the source entity this
  // reference lives. Used by the UI for human-readable hints
  // ("biomes.frozen.enemyRoster[2].id → enemies.shooter_drone").
  field: string;
};

export type AssetSlot = {
  // Texture category as understood by /api/editor/textures:
  // 'enemy' | 'prop' | 'biome_floor' | 'biome_wall' | 'biome_ceiling'
  // | 'biome_skybox' | 'building' | …
  category: string;
  id: string;
  // The entity that requires this slot.
  required_by: RefEntity;
  // Why it's required ('sprite' | 'wall_variant' | 'floor' | …).
  reason: string;
  present: boolean;
};

export type RefsResponse = {
  edges: RefEdge[];
  assets: AssetSlot[];
  // Subset of `edges` whose `to` doesn't resolve to a known entity.
  // The UI flags these as broken cross-references.
  brokenEdges: RefEdge[];
};

const TEXTURES_DIR = path.join(process.cwd(), 'public', 'textures');
const ALLOWED_EXTS = ['png', 'webp', 'jpg', 'jpeg'] as const;

// Map of (category, id) -> filename — built once per request by
// scanning the textures dir. Used to resolve every asset slot's
// `present` flag without hitting the FS per slot.
async function buildTextureIndex(): Promise<Set<string>> {
  const out = new Set<string>();
  let cats: string[] = [];
  try {
    cats = await fs.readdir(TEXTURES_DIR);
  } catch {
    return out;
  }
  for (const cat of cats) {
    const catPath = path.join(TEXTURES_DIR, cat);
    let files: string[] = [];
    try {
      files = await fs.readdir(catPath);
    } catch {
      continue;
    }
    for (const f of files) {
      const dot = f.lastIndexOf('.');
      if (dot < 0) continue;
      const id = f.slice(0, dot);
      const ext = f.slice(dot + 1).toLowerCase();
      if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) continue;
      out.add(`${cat}/${id}`);
    }
  }
  return out;
}

function isPresent(
  index: Set<string>,
  category: string,
  id: string,
): boolean {
  return index.has(`${category}/${id}`);
}

function biomeEdges(b: BiomeDef): RefEdge[] {
  const out: RefEdge[] = [];
  const from: RefEntity = { area: 'biomes', id: b.id };
  b.enemyRoster.forEach((entry, i) => {
    out.push({
      from,
      to: { area: 'enemies', id: entry.id },
      field: `enemyRoster[${i}].id`,
    });
  });
  b.propPalette.forEach((entry, i) => {
    out.push({
      from,
      to: { area: 'props', id: entry.id },
      field: `propPalette[${i}].id`,
    });
  });
  return out;
}

function enemyEdges(e: EnemyDef): RefEdge[] {
  const from: RefEntity = { area: 'enemies', id: e.id };
  return e.biomeAffinity.map((biomeId, i) => ({
    from,
    to: { area: 'biomes', id: biomeId },
    field: `biomeAffinity[${i}]`,
  }));
}

function propEdges(p: PropDef): RefEdge[] {
  const from: RefEntity = { area: 'props', id: p.id };
  return p.biomeAffinity.map((biomeId, i) => ({
    from,
    to: { area: 'biomes', id: biomeId },
    field: `biomeAffinity[${i}]`,
  }));
}

function roomEdges(r: RoomTemplate): RefEdge[] {
  const from: RefEntity = { area: 'rooms', id: r.id };
  const out: RefEdge[] = [];
  r.biomeAffinity.forEach((biomeId, i) => {
    out.push({
      from,
      to: { area: 'biomes', id: biomeId },
      field: `biomeAffinity[${i}]`,
    });
  });
  r.anchors.forEach((a, i) => {
    if (!a.overrideId) return;
    if (a.kind === 'enemy') {
      out.push({
        from,
        to: { area: 'enemies', id: a.overrideId },
        field: `anchors[${i}].overrideId`,
      });
    } else if (a.kind === 'prop') {
      out.push({
        from,
        to: { area: 'props', id: a.overrideId },
        field: `anchors[${i}].overrideId`,
      });
    }
  });
  return out;
}

function biomeAssetSlots(
  b: BiomeDef,
  index: Set<string>,
): AssetSlot[] {
  const slots: AssetSlot[] = [];
  const required_by: RefEntity = { area: 'biomes', id: b.id };
  for (const cat of [
    'biome_floor',
    'biome_wall',
    'biome_ceiling',
    'biome_skybox',
  ]) {
    slots.push({
      category: cat,
      id: b.id,
      required_by,
      reason: cat.replace('biome_', '') + ' (single-texture)',
      present: isPresent(index, cat, b.id),
    });
  }
  // Wall + floor variants per tileSet.
  const wallTile = b.tileSet?.tiles.find((t) => t.role === 'wall');
  const floorTile = b.tileSet?.tiles.find((t) => t.role === 'floor');
  for (const variantId of wallTile?.textureIds ?? []) {
    slots.push({
      category: 'biome_wall',
      id: variantId,
      required_by,
      reason: 'wall variant',
      present: isPresent(index, 'biome_wall', variantId),
    });
  }
  for (const variantId of floorTile?.textureIds ?? []) {
    slots.push({
      category: 'biome_floor',
      id: variantId,
      required_by,
      reason: 'floor variant',
      present: isPresent(index, 'biome_floor', variantId),
    });
  }
  return slots;
}

function enemyAssetSlots(e: EnemyDef, index: Set<string>): AssetSlot[] {
  return [
    {
      category: 'enemy',
      id: e.id,
      required_by: { area: 'enemies', id: e.id },
      reason: 'sprite',
      present: isPresent(index, 'enemy', e.id),
    },
  ];
}

function propAssetSlots(p: PropDef, index: Set<string>): AssetSlot[] {
  // Only flag a missing texture when the prop explicitly references one
  // (visual.textureId). Procedural props don't need a sprite.
  if (!p.visual.textureId) return [];
  return [
    {
      category: 'prop',
      id: p.visual.textureId,
      required_by: { area: 'props', id: p.id },
      reason: 'sprite',
      present: isPresent(index, 'prop', p.visual.textureId),
    },
  ];
}

export async function GET() {
  try {
    const [biomes, enemies, props, rooms, texIndex] = await Promise.all([
      loadBiomes(),
      loadEnemies(),
      loadProps(),
      loadRooms(),
      buildTextureIndex(),
    ]);

    const edges: RefEdge[] = [
      ...biomes.flatMap(biomeEdges),
      ...enemies.flatMap(enemyEdges),
      ...props.flatMap(propEdges),
      ...rooms.flatMap(roomEdges),
    ];

    const known: Record<EditorArea, Set<string>> = {
      biomes: new Set(biomes.map((b) => b.id)),
      enemies: new Set(enemies.map((e) => e.id)),
      props: new Set(props.map((p) => p.id)),
      rooms: new Set(rooms.map((r) => r.id)),
    };
    const brokenEdges = edges.filter(
      (e) => !known[e.to.area]?.has(e.to.id),
    );

    const assets: AssetSlot[] = [
      ...biomes.flatMap((b) => biomeAssetSlots(b, texIndex)),
      ...enemies.flatMap((e) => enemyAssetSlots(e, texIndex)),
      ...props.flatMap((p) => propAssetSlots(p, texIndex)),
    ];

    const body: RefsResponse = { edges, assets, brokenEdges };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
