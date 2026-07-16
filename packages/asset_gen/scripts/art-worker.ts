// Art worker — runs one headless Claude session per art slot,
// driving the sprite-editor MCP server to draw, self-review, and
// export straight into the game's art destinations. Verification is
// the audit itself: a job only counts as done when the slot's
// audited status flips.
//
//   npm run art-worker --workspace=@dumrunner/asset_gen -- enemy:swarmer
//   ... -- --missing --limit 3     take the next N gaps from the audit
//   ... -- --model opus            editing model (default sonnet)
//   ... -- --dry-run               print job prompts, run nothing

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditArtSlots,
  buildArtSlots,
  loadArtDirection,
  loadReview,
  type ArtDirectionFile,
  type AuditedSlot,
  type ReviewFile,
} from '../src/artManifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const TEXTURES_DIR = join(REPO_ROOT, 'packages', 'client', 'public', 'textures');
const CONTENT_DIR = join(REPO_ROOT, 'packages', 'shared', 'content');
const DIRECTION_PATH = join(here, '..', 'art', 'direction.json');
const REVIEW_PATH = join(here, '..', 'art', 'review.json');
const MCP_CONFIG = join(REPO_ROOT, '.mcp.json');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const slotArgs = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
function flagValue(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const limit = Number(flagValue('--limit') ?? '3');
const model = flagValue('--model') ?? 'sonnet';
const dryRun = flags.has('--dry-run');

// Maps slot category → how the finished art hooks into the game.
type Destination =
  | { kind: 'static'; category: string }
  | {
      kind: 'animation';
      animCategory: string;
      wire: { area: 'enemies' | 'props' | 'weapons'; field: string } | null;
    };

function destinationOf(slot: AuditedSlot): Destination {
  switch (slot.category) {
    case 'enemy':
      return {
        kind: 'animation',
        animCategory: 'enemy',
        wire: { area: 'enemies', field: 'animationId' },
      };
    case 'weapon_view':
      return {
        kind: 'animation',
        animCategory: 'weapon_view',
        wire: { area: 'weapons', field: 'viewAnimationId' },
      };
    case 'projectile':
      return {
        kind: 'animation',
        animCategory: 'projectile',
        wire: { area: 'weapons', field: 'projectileAnimationId' },
      };
    case 'prop':
      // Props that already animate must be remade as animations —
      // a static override would be ignored while animationId wins.
      return slot.animationId
        ? {
            kind: 'animation',
            animCategory: 'prop',
            wire: { area: 'props', field: 'animationId' },
          }
        : { kind: 'static', category: 'prop' };
    default:
      return { kind: 'static', category: slot.category };
  }
}

const DEFAULT_STATE_FRAMES: Record<string, Record<string, number>> = {
  enemy: { idle: 2, walk: 4, attack: 3, death: 4 },
  weapon_view: { idle: 1, fire: 3, reload: 4 },
  projectile: { idle: 2 },
  prop: { idle: 2 },
};

function buildJobPrompt(
  slot: AuditedSlot,
  direction: ArtDirectionFile,
  review?: ReviewFile,
): string {
  const d = direction.slots?.[slot.key];
  const dest = destinationOf(slot);
  const spriteId = slot.key.replaceAll(':', '__');
  const lines: string[] = [];

  lines.push(
    `You are a pixel artist producing one game-ready sprite for DÛM RUNNER using the sprite-editor MCP tools. Work autonomously until the art is exported.`,
    ``,
    `## Global style`,
    `${direction.global?.style ?? '16px-tile pixel art, hard 1px outline, transparent background'}`,
    ...(direction.global?.notes ?? []).map((n) => `- ${n}`),
    ``,
    `## The sprite`,
    `- slot: ${slot.key}`,
    `- subject: ${d?.subject ?? slot.label}`,
    `- canvas: ${slot.tiles.w}x${slot.tiles.h} tiles (${slot.tiles.w * 16}x${slot.tiles.h * 16}px)`,
    `- starting palette: ${(
      d?.palette ??
      [
        ...(direction.global?.palette ?? ['#111827', '#94a3b8', '#f97316']),
        ...(slot.hints.color ? [slot.hints.color] : []),
      ]
    ).join(' ')} — you may set_palette to swap in better shades for the subject (keep a near-black for the outline)`,
  );
  for (const [k, v] of Object.entries(slot.hints)) {
    if (v) lines.push(`- ${k}: ${v}`);
  }
  if (d?.mustInclude?.length) lines.push(`- must include: ${d.mustInclude.join('; ')}`);
  if (d?.mustAvoid?.length) lines.push(`- must avoid: ${d.mustAvoid.join('; ')}`);

  lines.push(
    ``,
    `## Method`,
    `1. create_sprite id "${spriteId}".`,
    `2. Draw with set_rows / draw_rect / draw_line / stamp / flood_fill. For symmetric subjects draw the left half and mirror_x. Paint color masses first, then call outline with the near-black char LAST (overlapping limb segments by 1px so the outline doesn't sever them).`,
    `3. render and LOOK at it. Critique hard: silhouette readable? light from top-left? outline unbroken? Iterate at least 3 times — do not settle for the first draft.`,
  );

  if (dest.kind === 'animation') {
    const frames =
      d?.states ??
      Object.fromEntries(
        Object.entries(DEFAULT_STATE_FRAMES[dest.animCategory] ?? { idle: 2 }).map(
          ([s, n]) => [s, { frames: n }],
        ),
      );
    const stateList = Object.entries(frames)
      .map(([s, v]) => `${s} (${v.frames} frames)`)
      .join(', ');
    lines.push(
      `4. Animate. States and frame counts: ${stateList}. Name frames "<state>/<index>" (dense from 0). Build each state by clone_frame from the base pose, then edit the diff; use render with onionFrame to check motion. Keep the silhouette anchored (no drift except deliberate motion). Death frames may collapse/fade downward.`,
      `5. Export: export_animation with animId "${slot.id}_px", name "${slot.label} (pixel)", category "${dest.animCategory}", texturesDir "${TEXTURES_DIR}", contentDir "${CONTENT_DIR}".`,
    );
    if (dest.wire) {
      lines.push(
        `6. wire_entity with contentDir "${CONTENT_DIR}", area "${dest.wire.area}", entityId "${slot.id}", animId "${slot.id}_px", field "${dest.wire.field}".`,
      );
    }
  } else {
    lines.push(
      `4. Export: export_static with frame "idle/0", texturesDir "${TEXTURES_DIR}", category "${dest.category}", gameId "${slot.id}".`,
    );
  }

  const verdict = review?.[slot.key];
  if (verdict?.verdict === 'rejected' && verdict.note) {
    lines.push(
      ``,
      `## Reviewer feedback on the previous attempt (MUST address)`,
      verdict.note,
      `The previous sprite doc may still exist under id "${spriteId}" — load it with get_sprite and decide whether to fix it or start over.`,
    );
  }

  lines.push(
    ``,
    `When done, reply with a one-line summary. If a tool errors repeatedly, stop and report the error instead of guessing.`,
  );
  return lines.join('\n');
}

function runClaude(prompt: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '-p',
        prompt,
        '--model',
        model,
        '--mcp-config',
        MCP_CONFIG,
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__sprite-editor__*',
        '--max-turns',
        '120',
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function auditOne(key: string): Promise<AuditedSlot | null> {
  const direction = await loadArtDirection(DIRECTION_PATH);
  const slots = await buildArtSlots(direction);
  const audited = await auditArtSlots(slots, TEXTURES_DIR, direction);
  return audited.find((s) => s.key === key) ?? null;
}

async function main(): Promise<void> {
  const direction = await loadArtDirection(DIRECTION_PATH);
  const review = await loadReview(REVIEW_PATH);
  const slots = await buildArtSlots(direction);
  const audited = await auditArtSlots(slots, TEXTURES_DIR, direction);

  let jobs: AuditedSlot[];
  if (slotArgs.length > 0) {
    jobs = slotArgs.map((key) => {
      const s = audited.find((a) => a.key === key);
      if (!s) throw new Error(`unknown slot '${key}' (see art-audit)`);
      return s;
    });
  } else if (flags.has('--missing') || flags.has('--restyle')) {
    // Human verdicts trump the audit: approved never re-queues,
    // rejected re-queues even when the slot audits as covered.
    // --missing takes the gaps; --restyle takes the covered slots
    // (old-style art getting remade in the pixel style). The two
    // sets are disjoint, so both workers can run concurrently.
    const restyle = flags.has('--restyle');
    // Slots with a saved sprite doc were already produced by this
    // pipeline (new style) — restyle skips them so it only remakes
    // legacy art, even while a --missing worker runs concurrently.
    const pixelDone = new Set(
      (await readdir(join(here, '..', 'art', 'sprites')).catch(() => []))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5).replaceAll('__', ':')),
    );
    jobs = audited
      .filter((s) => {
        const v = review[s.key]?.verdict;
        if (v === 'approved') return false;
        if (v === 'rejected') return !restyle;
        if (!s.required) return false;
        if (restyle && pixelDone.has(s.key)) return false;
        const gap = s.status === 'missing' || s.status === 'partial';
        return restyle ? !gap : gap;
      })
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, limit);
  } else {
    console.error(
      'usage: art-worker <slot-key ...> | --missing | --restyle [--limit N] [--model m] [--dry-run]',
    );
    process.exit(2);
  }

  console.log(`jobs: ${jobs.map((j) => j.key).join(', ') || '(none)'}`);
  let consecutiveFailures = 0;
  for (const slot of jobs) {
    const prompt = buildJobPrompt(slot, direction, review);
    if (dryRun) {
      console.log(`\n===== ${slot.key} =====\n${prompt}`);
      continue;
    }
    console.log(`\n===== ${slot.key} (was: ${slot.status}) =====`);
    const code = await runClaude(prompt);
    const after = await auditOne(slot.key);
    // Success needs BOTH a clean session exit and a covered audit —
    // a restyle slot audits as covered even when the session died
    // before touching it (e.g. usage-limit exits).
    const okNow =
      code === 0 &&
      after !== null &&
      (after.status === 'animated' || after.status === 'static');
    console.log(
      `----- ${slot.key}: exit ${code}, audit ${slot.status} → ${after?.status ?? '?'} ${okNow ? '✓' : '✗'}`,
    );
    // Usage-limit exits fail instantly and would burn the rest of
    // the queue as no-ops — bail after 3 in a row.
    consecutiveFailures = okNow ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= 3) {
      console.error(
        'aborting: 3 consecutive failures (usage limit?) — re-run later to resume',
      );
      process.exit(1);
    }
  }
}

await main();
