// One-shot port: emit one JSON file per attachment class, folding
// the matching ATTACHMENT_STAT_RANGES row into a `rolls` field on
// the def. Run once with
// `npx tsx packages/shared/scripts/port-attachments.ts`.
//
// Each output file lives at
// packages/shared/content/attachments/<id>.json. Delete this
// script after the port settles.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTACHMENT_DEFS,
  ATTACHMENT_STAT_RANGES,
} from '../src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'content', 'attachments');
mkdirSync(OUT, { recursive: true });

let count = 0;
for (const def of Object.values(ATTACHMENT_DEFS)) {
  const rolls = ATTACHMENT_STAT_RANGES[def.id];
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) {
    if (v === undefined) continue;
    clean[k] = v;
  }
  if (rolls && Object.keys(rolls).length > 0) clean.rolls = rolls;
  writeFileSync(
    join(OUT, `${def.id}.json`),
    JSON.stringify(clean, null, 2) + '\n',
    'utf8',
  );
  count++;
}
console.log(`wrote ${count} attachment files to ${OUT}`);
