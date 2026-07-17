// Art manifest — the canonical inventory of every sprite slot the
// game can consume, derived from the content registries rather than
// maintained by hand. Each slot names its destination in the live
// art system (public/textures/<category>/... static overrides, or a
// content animation manifest + frame PNGs), so anything produced
// for a slot is picked up by the game with zero wiring.
//
// Three layers:
//   1. buildArtSlots()   — derived inventory (this file). Walks
//      enemies/props/biomes/weapons content + BUILDING_KINDS +
//      MATERIALS and emits the required slot list.
//   2. art/direction.json — hand-authored art direction per slot
//      (subject, palette, states, tile size overrides) plus extra
//      slots the registries can't derive (UI icons). This is the
//      generation pipeline's job spec.
//   3. auditArtSlots()   — cross-references the slots against what
//      exists on disk and reports coverage.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILDING_KINDS, type AnimationDef } from '@dumrunner/shared';
import {
  loadAnimations,
  loadBiomes,
  loadEnemies,
  loadProps,
  loadWeapons,
} from '@dumrunner/shared/content/loader';
import { MATERIALS, type MaterialKind } from '@dumrunner/shared/inventory';

// Base sprite tile in pixels. Every slot's canvas is tiles.w×tiles.h
// of these (a 2×6 decorator = 32×96px).
export const ART_TILE_PX = 16;

// Categories mirror public/textures/<category>/ exactly.
export type ArtCategory =
  | 'enemy'
  | 'building'
  | 'building_top'
  | 'material'
  | 'prop'
  | 'prop_top'
  | 'projectile'
  | 'weapon_view'
  | 'player'
  | 'biome_floor'
  | 'biome_wall'
  | 'biome_ceiling'
  | 'biome_skybox'
  | 'ui_icon';

export type ArtSlot = {
  // Canonical key: `${category}:${id}`.
  key: string;
  category: ArtCategory;
  id: string;
  label: string;
  // Canvas size in ART_TILE_PX tiles.
  tiles: { w: number; h: number };
  // Animated slots resolve through a content animation manifest
  // (entity.animationId → content/animations/<id>.json → frame PNGs
  // under public/textures/anim/<animId>/). Static slots resolve to
  // public/textures/<category>/<id>.<ext>.
  wantsAnimation: boolean;
  // States the finished animation should cover (advisory — an
  // authored manifest with fewer states audits as 'partial').
  requiredStates: string[];
  // The animationId currently wired in content, if any.
  animationId: string | null;
  // Optional slots (e.g. building_top) don't count against coverage.
  required: boolean;
  // Prompt-relevant facts pulled from the registry entry.
  hints: Record<string, string>;
};

export type SlotStatus = 'animated' | 'static' | 'partial' | 'missing';

export type AuditedSlot = ArtSlot & {
  status: SlotStatus;
  // States present when an animation manifest is wired.
  presentStates: string[];
  // What's wrong when status is partial/missing.
  detail: string | null;
  // Whether art/direction.json has an entry for this slot.
  hasDirection: boolean;
};

export type ArtDirectionEntry = {
  subject: string;
  style?: string;
  palette?: string[];
  mustInclude?: string[];
  mustAvoid?: string[];
  tiles?: { w: number; h: number };
  states?: Record<string, { frames: number }>;
  reference?: string;
};

export type ArtDirectionFile = {
  // Whole-set style guidance prepended to every job.
  global?: { style?: string; palette?: string[]; notes?: string[] };
  slots?: Record<string, ArtDirectionEntry>;
  // Slots the registries can't derive (UI icons, one-offs). Keyed
  // by canonical slot key; must parse as `${category}:${id}`.
  extraSlots?: Record<
    string,
    { label: string; tiles?: { w: number; h: number }; required?: boolean }
  >;
};

const ENEMY_STATES = ['idle', 'walk', 'attack', 'death'];
const WEAPON_VIEW_STATES = ['idle', 'fire', 'reload'];

function slotKey(category: ArtCategory, id: string): string {
  return `${category}:${id}`;
}

function tilesFromSpriteSize(spriteSize: number | undefined): {
  w: number;
  h: number;
} {
  // spriteSize is in wall-height units (~2 tiles of world height).
  // Round up so big decorators get real pixel room; overlay can
  // override (e.g. a 2×6 tree).
  if (!spriteSize || spriteSize <= 1) return { w: 1, h: 1 };
  const t = Math.min(8, Math.ceil(spriteSize));
  return { w: t, h: t };
}

export async function buildArtSlots(
  direction?: ArtDirectionFile,
): Promise<ArtSlot[]> {
  const [enemies, props, biomes, weapons] = await Promise.all([
    loadEnemies(),
    loadProps(),
    loadBiomes(),
    loadWeapons(),
  ]);

  const slots: ArtSlot[] = [];
  const push = (s: Omit<ArtSlot, 'key'>) =>
    slots.push({ ...s, key: slotKey(s.category, s.id) });

  for (const e of enemies) {
    push({
      category: 'enemy',
      id: e.id,
      label: e.label,
      tiles:
        (e.stats.radius ?? 14) > 20 ? { w: 2, h: 2 } : { w: 1, h: 1 },
      wantsAnimation: true,
      requiredStates: ENEMY_STATES,
      animationId: e.animationId ?? null,
      required: true,
      hints: {
        faction: e.faction,
        color: e.visual.color,
        movement: e.movement.kind,
        attacks: e.attacks.map((a) => a.kind).join(', '),
      },
    });
  }

  for (const p of props) {
    const tiles = tilesFromSpriteSize(p.visual?.spriteSize);
    push({
      category: 'prop',
      id: p.id,
      label: p.label,
      tiles,
      wantsAnimation: false,
      requiredStates: [],
      animationId: p.animationId ?? null,
      required: true,
      hints: {
        solid: String(p.solid),
        biomes: (p.biomeAffinity ?? []).join(', '),
      },
    });
    push({
      category: 'prop_top',
      id: p.id,
      label: `${p.label} (top-down)`,
      tiles,
      wantsAnimation: false,
      requiredStates: [],
      animationId: null,
      required: false,
      hints: {},
    });
  }

  for (const kind of BUILDING_KINDS) {
    const label = kind.replaceAll('_', ' ');
    push({
      category: 'building',
      id: kind,
      label,
      tiles: { w: 2, h: 2 },
      wantsAnimation: false,
      requiredStates: [],
      animationId: null,
      required: true,
      hints: { placed: 'player-built base structure' },
    });
    push({
      category: 'building_top',
      id: kind,
      label: `${label} (top-down)`,
      tiles: { w: 2, h: 2 },
      wantsAnimation: false,
      requiredStates: [],
      animationId: null,
      required: false,
      hints: {},
    });
  }

  for (const materialId of Object.keys(MATERIALS) as MaterialKind[]) {
    const m = MATERIALS[materialId];
    push({
      category: 'material',
      id: materialId,
      label: m.name,
      tiles: { w: 1, h: 1 },
      wantsAnimation: false,
      requiredStates: [],
      animationId: null,
      required: true,
      hints: { color: `#${m.color.toString(16).padStart(6, '0')}` },
    });
  }

  for (const w of weapons) {
    // 1x1 on purpose: view-models upscale fine (nearest filtering)
    // and generation quality falls apart on larger canvases for
    // anything but simple props.
    push({
      category: 'weapon_view',
      id: w.id,
      label: `${w.id.replaceAll('_', ' ')} view-model`,
      tiles: { w: 1, h: 1 },
      wantsAnimation: true,
      requiredStates: WEAPON_VIEW_STATES,
      animationId: w.viewAnimationId ?? null,
      required: true,
      hints: { family: w.family },
    });
    if (w.family !== 'melee') {
      push({
        category: 'projectile',
        id: w.id,
        label: `${w.id.replaceAll('_', ' ')} projectile`,
        tiles: { w: 1, h: 1 },
        wantsAnimation: true,
        requiredStates: ['idle'],
        animationId: w.projectileAnimationId ?? null,
        required: false,
        hints: { family: w.family },
      });
    }
  }

  for (const b of biomes) {
    for (const cat of [
      'biome_floor',
      'biome_wall',
      'biome_ceiling',
      'biome_skybox',
    ] as const) {
      push({
        category: cat,
        id: b.id,
        label: `${b.id.replaceAll('_', ' ')} ${cat.slice('biome_'.length)}`,
        tiles: cat === 'biome_skybox' ? { w: 8, h: 4 } : { w: 2, h: 2 },
        wantsAnimation: false,
        requiredStates: [],
        animationId: null,
        required: cat !== 'biome_ceiling',
        hints: {},
      });
    }
  }

  // The renderer looks up ('player', 'default') for other-player
  // billboards — a static texture; there's no player animation
  // wiring, so the slot is satisfied by the override alone.
  push({
    category: 'player',
    id: 'default',
    label: 'player character',
    tiles: { w: 1, h: 2 },
    wantsAnimation: false,
    requiredStates: [],
    animationId: null,
    required: true,
    hints: {},
  });

  // Overlay-defined extra slots (UI icons and other one-offs).
  for (const [key, extra] of Object.entries(direction?.extraSlots ?? {})) {
    const sep = key.indexOf(':');
    if (sep <= 0) continue;
    slots.push({
      key,
      category: key.slice(0, sep) as ArtCategory,
      id: key.slice(sep + 1),
      label: extra.label,
      tiles: extra.tiles ?? { w: 1, h: 1 },
      wantsAnimation: false,
      requiredStates: [],
      animationId: null,
      required: extra.required ?? true,
      hints: {},
    });
  }

  // Apply per-slot direction overrides that change the spec itself.
  for (const s of slots) {
    const d = direction?.slots?.[s.key];
    if (d?.tiles) s.tiles = d.tiles;
    if (d?.states) s.requiredStates = Object.keys(d.states);
  }

  return slots;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const IMG_EXTS = ['png', 'webp'];

async function staticOverrideExists(
  texturesDir: string,
  category: string,
  id: string,
): Promise<boolean> {
  for (const ext of IMG_EXTS) {
    if (await exists(join(texturesDir, category, `${id}.${ext}`))) return true;
  }
  return false;
}

// A state's art exists when either its sheet PNG or a non-empty
// frames directory is present under public/textures/anim/<animId>/.
async function animStateExists(
  texturesDir: string,
  animId: string,
  state: string,
): Promise<boolean> {
  for (const ext of IMG_EXTS) {
    if (await exists(join(texturesDir, 'anim', animId, `${state}.${ext}`))) {
      return true;
    }
  }
  try {
    const entries = await readdir(join(texturesDir, 'anim', animId, state));
    return entries.some((f) => IMG_EXTS.some((ext) => f.endsWith(`.${ext}`)));
  } catch {
    return false;
  }
}

export async function auditArtSlots(
  slots: ArtSlot[],
  texturesDir: string,
  direction?: ArtDirectionFile,
): Promise<AuditedSlot[]> {
  const animations = new Map<string, AnimationDef>(
    (await loadAnimations()).map((a) => [a.id, a]),
  );

  const out: AuditedSlot[] = [];
  for (const s of slots) {
    const hasDirection = Boolean(direction?.slots?.[s.key]);
    const hasStatic = await staticOverrideExists(
      texturesDir,
      s.category,
      s.id,
    );

    let presentStates: string[] = [];
    let status: SlotStatus;
    let detail: string | null = null;

    if (s.animationId) {
      const def = animations.get(s.animationId);
      if (!def) {
        status = hasStatic ? 'static' : 'missing';
        detail = `animationId ${s.animationId} has no content manifest`;
      } else {
        const declared = Object.keys(def.states);
        for (const st of declared) {
          if (await animStateExists(texturesDir, s.animationId, st)) {
            presentStates.push(st);
          }
        }
        const missingFrames = declared.filter(
          (st) => !presentStates.includes(st),
        );
        const missingRequired = s.requiredStates.filter(
          (st) => !presentStates.includes(st),
        );
        if (presentStates.length === 0) {
          status = hasStatic ? 'static' : 'missing';
          detail = `manifest ${s.animationId} has no frame art on disk`;
        } else if (missingFrames.length > 0 || missingRequired.length > 0) {
          status = 'partial';
          const parts: string[] = [];
          if (missingFrames.length > 0) {
            parts.push(`declared states missing art: ${missingFrames.join(', ')}`);
          }
          if (missingRequired.length > 0) {
            parts.push(`required states not covered: ${missingRequired.join(', ')}`);
          }
          detail = parts.join('; ');
        } else {
          status = 'animated';
        }
      }
    } else if (hasStatic) {
      status = s.wantsAnimation ? 'partial' : 'static';
      if (s.wantsAnimation) detail = 'static override only; wants animation';
    } else {
      status = 'missing';
      detail = s.wantsAnimation
        ? 'no animation wired, no static override'
        : 'no static override';
    }

    out.push({ ...s, status, presentStates, detail, hasDirection });
  }
  return out;
}

export async function loadArtDirection(
  path: string,
): Promise<ArtDirectionFile> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ArtDirectionFile;
  } catch {
    return {};
  }
}

// ---- human review state (art/review.json) ----
//
// The audit page writes verdicts here; the worker reads them:
// approved slots are never re-queued, rejected slots re-queue even
// when their audit status looks covered, and the reviewer note is
// appended to the regenerated job's brief.

export type ReviewVerdict = {
  verdict: 'approved' | 'rejected';
  note?: string;
  at: string;
};

export type ReviewFile = Record<string, ReviewVerdict>;

export async function loadReview(path: string): Promise<ReviewFile> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ReviewFile;
  } catch {
    return {};
  }
}

export async function saveReview(
  path: string,
  review: ReviewFile,
): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(review, null, 2)}\n`);
}
