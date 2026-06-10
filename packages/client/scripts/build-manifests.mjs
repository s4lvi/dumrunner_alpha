#!/usr/bin/env node
// Prebuild step. Vercel runs this before `next build` so the
// deployed serverless functions can serve the editor's GET
// endpoints without doing a `fs.readdir` on packages/shared/content/
// (which the @vercel/nft tracer can't follow because the path is
// constructed from import.meta.url after Next inlines the shared
// package via transpilePackages).
//
// We emit two static manifests into public/, where Vercel's CDN
// will serve them and the file tracer always picks them up:
//
//   public/content-manifest.json   — every authored JSON entity,
//                                    keyed by area. Inlined so the
//                                    API route just slices it.
//   public/textures-manifest.json  — same shape as the existing
//                                    /api/editor/textures GET
//                                    response. Lets the textureOverrides
//                                    cache hydrate identically in
//                                    dev (filesystem walk) and prod
//                                    (manifest read).
//
// Both files are .gitignored — regenerated on every build. Dev
// mode (`next dev`) doesn't read them; it walks the live disk so
// in-app edits show up without a rebuild.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.join(HERE, '..');
const PUBLIC_DIR = path.join(CLIENT_ROOT, 'public');
const REPO_ROOT = path.join(CLIENT_ROOT, '..', '..');
const CONTENT_ROOT = path.join(REPO_ROOT, 'packages', 'shared', 'content');
const TEXTURES_ROOT = path.join(PUBLIC_DIR, 'textures');

// Keep this list in sync with EDITOR_AREAS in packages/shared/src/content/loader.ts.
// Drift is detected at runtime by the [area] route's `isEditorArea` check —
// adding a new area here without updating the loader is harmless; the route
// will still reject unknown area strings.
const CONTENT_AREAS = [
  'biomes',
  'enemies',
  'props',
  'rooms',
  'corridors',
  'blueprints',
  'weapons',
  'recipes',
  'attachments',
  'animations',
  'buildings',
  'scenes',
];

// Mirror of ALLOWED_CATEGORIES in app/api/editor/textures/route.ts.
const TEXTURE_CATEGORIES = new Set([
  'enemy',
  'building',
  'building_top',
  'prop',
  'prop_top',
  'prop_open',
  'prop_open_top',
  'material',
  'biome_floor',
  'biome_ceiling',
  'biome_skybox',
  'biome_wall',
  'player',
  'projectile',
  'weapon_view',
  'anim',
  'interactable',
]);
const ALLOWED_EXTS = new Set(['png', 'webp', 'jpg']);
const SAFE_ID = /^[a-z0-9_-]+$/i;

async function readContentArea(area) {
  const dir = path.join(CONTENT_ROOT, area);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    // Missing area dir is fine — empty array. Fresh repos may not
    // have authored every area yet.
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      out.push(JSON.parse(raw));
    } catch (e) {
      // A malformed JSON file should fail the build — content is part
      // of the build, broken JSON is a code-level error.
      console.error(`[manifests] failed to parse ${area}/${f}:`, e.message);
      throw e;
    }
  }
  return out;
}

async function buildContentManifest() {
  const manifest = {};
  for (const area of CONTENT_AREAS) {
    manifest[area] = await readContentArea(area);
  }
  return manifest;
}

// Texture walker mirrors the structure the live route emits at
// app/api/editor/textures/route.ts:64. Three shapes:
//
//   <category>/<id>.<ext>                       — legacy single PNG
//   <category>/<id>/<state>.<ext>               — per-state sheet
//   <category>/<id>/<state>/<frameIdx>.<ext>    — per-frame PNG
//
// Mirroring is intentional — the API route's GET response and the
// manifest must have identical entry shapes so the client's
// textureOverrides cache hydrates the same way from either source.
async function buildTextureManifest() {
  const entries = [];
  let cats;
  try {
    cats = await fs.readdir(TEXTURES_ROOT);
  } catch {
    return { entries };
  }
  for (const cat of cats) {
    if (!TEXTURE_CATEGORIES.has(cat)) continue;
    const catPath = path.join(TEXTURES_ROOT, cat);
    const catStat = await fs.stat(catPath).catch(() => null);
    if (!catStat || !catStat.isDirectory()) continue;
    const files = await fs.readdir(catPath).catch(() => []);
    for (const f of files) {
      const childPath = path.join(catPath, f);
      const childStat = await fs.stat(childPath).catch(() => null);
      if (!childStat) continue;
      if (childStat.isDirectory()) {
        const id = f;
        if (!SAFE_ID.test(id)) continue;
        const stateFiles = await fs.readdir(childPath).catch(() => []);
        for (const sf of stateFiles) {
          const sfPath = path.join(childPath, sf);
          const sfStat = await fs.stat(sfPath).catch(() => null);
          if (!sfStat) continue;
          if (sfStat.isDirectory()) {
            const state = sf;
            if (!SAFE_ID.test(state)) continue;
            const frameFiles = await fs.readdir(sfPath).catch(() => []);
            for (const ff of frameFiles) {
              const dot = ff.lastIndexOf('.');
              if (dot < 0) continue;
              const fname = ff.slice(0, dot);
              const ext = ff.slice(dot + 1).toLowerCase();
              if (!/^\d+$/.test(fname)) continue;
              if (!ALLOWED_EXTS.has(ext)) continue;
              entries.push({
                category: cat,
                id,
                state,
                frame: parseInt(fname, 10),
                url: `/textures/${cat}/${id}/${state}/${ff}`,
              });
            }
            continue;
          }
          const dot = sf.lastIndexOf('.');
          if (dot < 0) continue;
          const state = sf.slice(0, dot);
          const ext = sf.slice(dot + 1).toLowerCase();
          if (!SAFE_ID.test(state)) continue;
          if (!ALLOWED_EXTS.has(ext)) continue;
          entries.push({
            category: cat,
            id,
            state,
            url: `/textures/${cat}/${id}/${sf}`,
          });
        }
        continue;
      }
      const dot = f.lastIndexOf('.');
      if (dot < 0) continue;
      const id = f.slice(0, dot);
      const ext = f.slice(dot + 1).toLowerCase();
      if (!SAFE_ID.test(id)) continue;
      if (!ALLOWED_EXTS.has(ext)) continue;
      entries.push({ category: cat, id, url: `/textures/${cat}/${f}` });
    }
  }
  return { entries };
}

async function main() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  const [content, textures] = await Promise.all([
    buildContentManifest(),
    buildTextureManifest(),
  ]);
  await fs.writeFile(
    path.join(PUBLIC_DIR, 'content-manifest.json'),
    JSON.stringify(content),
  );
  await fs.writeFile(
    path.join(PUBLIC_DIR, 'textures-manifest.json'),
    JSON.stringify(textures),
  );
  const contentCount = Object.values(content).reduce(
    (n, arr) => n + arr.length,
    0,
  );
  console.log(
    `[manifests] wrote ${contentCount} content entries, ${textures.entries.length} texture entries`,
  );
}

await main();
