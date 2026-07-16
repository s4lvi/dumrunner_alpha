// Art coverage audit. Walks the derived art manifest, checks the
// live art destinations (public/textures overrides + animation
// frame dirs), and prints coverage per category plus the gap list.
//
//   npm run art-audit --workspace=@dumrunner/asset_gen
//   ... -- --json        machine-readable full dump (worker queue input)
//   ... -- --all         include optional + covered slots in the listing

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditArtSlots,
  buildArtSlots,
  loadArtDirection,
  type AuditedSlot,
} from '../src/artManifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const TEXTURES_DIR = join(REPO_ROOT, 'packages', 'client', 'public', 'textures');
const DIRECTION_PATH = join(here, '..', 'art', 'direction.json');

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const showAll = args.has('--all');

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  const direction = await loadArtDirection(DIRECTION_PATH);
  const slots = await buildArtSlots(direction);
  const audited = await auditArtSlots(slots, TEXTURES_DIR, direction);

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: null, slots: audited }, null, 2));
    return;
  }

  const byCategory = new Map<string, AuditedSlot[]>();
  for (const s of audited) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  console.log('ART COVERAGE');
  console.log('='.repeat(64));
  let reqTotal = 0;
  let reqCovered = 0;
  for (const [category, list] of [...byCategory.entries()].sort()) {
    const required = list.filter((s) => s.required);
    const covered = required.filter(
      (s) => s.status === 'animated' || s.status === 'static',
    );
    reqTotal += required.length;
    reqCovered += covered.length;
    const optional = list.length - required.length;
    console.log(
      `${pad(category, 16)} ${covered.length}/${required.length} covered` +
        (optional > 0 ? `  (+${optional} optional)` : ''),
    );
  }
  console.log('-'.repeat(64));
  console.log(`${pad('TOTAL', 16)} ${reqCovered}/${reqTotal} required slots covered`);

  const gaps = audited.filter((s) =>
    showAll ? true : s.required && s.status !== 'animated' && s.status !== 'static',
  );
  if (gaps.length > 0) {
    console.log('');
    console.log(showAll ? 'ALL SLOTS' : 'GAPS (required only)');
    console.log('='.repeat(64));
    for (const s of gaps.sort((a, b) => a.key.localeCompare(b.key))) {
      const dir = s.hasDirection ? 'direction ✓' : 'direction —';
      console.log(
        `${pad(s.status.toUpperCase(), 8)} ${pad(s.key, 36)} ` +
          `${s.tiles.w}x${s.tiles.h}  ${dir}` +
          (s.detail ? `\n         ${s.detail}` : ''),
      );
    }
  }
}

await main();
