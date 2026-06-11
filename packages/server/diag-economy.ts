import { initBlueprints } from './src/blueprints.js';
import { initRecipes } from './src/recipes.js';
import { initAttachments } from './src/attachments.js';
import { rollAttachmentDropForKill } from './src/loot.js';

async function main() {
  await initAttachments();
  await initRecipes();
  await initBlueprints();
  let drops = 0;
  const byTier: Record<string, number> = {};
  for (let i = 0; i < 20000; i++) {
    const a = rollAttachmentDropForKill(1);
    if (a) {
      drops++;
      byTier[a.tier] = (byTier[a.tier] ?? 0) + 1;
    }
  }
  console.log(
    'attachment drop rate:',
    ((drops / 20000) * 100).toFixed(1) + '%',
    JSON.stringify(byTier)
  );
}
main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
