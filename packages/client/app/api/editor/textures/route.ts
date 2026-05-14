// Texture editor save/load endpoint. Persists uploads to
// packages/client/public/textures/<category>/<id>.<ext> so they're
// served as static files at /textures/... and committed to the
// repo. This is the persistent store for the /editor UI; bypass
// this and there's no asset_gen yet.
//
// Categories and IDs are tightly validated to keep the on-disk
// shape stable and prevent path traversal. The file slug must
// match SAFE_ID; categories must be in ALLOWED_CATEGORIES.

import { NextResponse, type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TEXTURES_DIR = path.join(process.cwd(), 'public', 'textures');

// ---------- Manifest-backed reads (production) ----------
//
// Mirrors the content route's manifest strategy. On Vercel the
// function bundle's filesystem trace catches static files in
// public/ (manifests, individual texture PNGs), but doesn't
// reliably catch every entry written via the editor at build
// time. The prebuild script
// (packages/client/scripts/build-manifests.mjs) walks the
// textures dir at build time and writes the same shape this
// route's dev-mode GET emits. Module-level cache survives warm
// invocations.

type TextureManifest = {
  entries: {
    category: string;
    id: string;
    state?: string;
    frame?: number;
    url: string;
  }[];
};
let cachedTextureManifest: TextureManifest | null = null;
let cachedTextureManifestPromise: Promise<TextureManifest> | null = null;

async function loadTextureManifest(): Promise<TextureManifest> {
  if (cachedTextureManifest) return cachedTextureManifest;
  if (cachedTextureManifestPromise) return cachedTextureManifestPromise;
  cachedTextureManifestPromise = (async () => {
    try {
      const file = path.join(
        process.cwd(),
        'public',
        'textures-manifest.json',
      );
      const raw = await fs.readFile(file, 'utf8');
      cachedTextureManifest = JSON.parse(raw) as TextureManifest;
    } catch (e) {
      console.warn(
        '[textures api] textures-manifest.json missing — falling back to empty registry',
        e,
      );
      cachedTextureManifest = { entries: [] };
    }
    cachedTextureManifestPromise = null;
    return cachedTextureManifest;
  })();
  return cachedTextureManifestPromise;
}

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}
const ALLOWED_CATEGORIES = new Set([
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
  // Animation Phase A — projectile sprite (per weapon id, falls
  // through to weapon family) and the first-person view-model
  // sprite shown anchored bottom-centre in the FPS renderer.
  'projectile',
  'weapon_view',
  // Portal sprites — stairs_down (descend a floor) and extract_pad
  // (return to surface). Keyed by interactable kind. When absent
  // the renderer skips drawing the marker entirely so authors can
  // rely on a manually-placed prop instead.
  'interactable',
  // Library-model animations (post-refactor). All animation
  // textures — spritesheets or per-frame PNGs — live under this
  // single category, keyed by animation id rather than entity id.
  'anim',
]);
const SAFE_ID = /^[a-z0-9_-]+$/i;
const ALLOWED_EXTS = ['png', 'webp', 'jpg'] as const;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per asset — plenty for sprites

function safe(category: string, id: string): boolean {
  return ALLOWED_CATEGORIES.has(category) && SAFE_ID.test(id);
}

// Phase B/D: an asset can ship its per-state textures three
// different ways:
//   1. Legacy single PNG at <category>/<id>.<ext>
//   2. Spritesheet per state at <category>/<id>/<state>.<ext>
//   3. Per-frame PNGs at <category>/<id>/<state>/<frameIndex>.<ext>
// GET returns all three shapes; entries carry `state` / `frame`
// fields where relevant so the client cache keys them
// independently.
type TextureEntry = {
  category: string;
  id: string;
  state?: string;
  frame?: number;
  url: string;
};

export async function GET() {
  // Production: serve the prebuilt manifest. The dev-mode walk
  // below depends on a writable / readable filesystem rooted at
  // process.cwd()/public, which isn't reliably the case in a
  // Vercel function bundle.
  if (isProd()) {
    const manifest = await loadTextureManifest();
    return NextResponse.json(manifest);
  }
  await fs.mkdir(TEXTURES_DIR, { recursive: true });
  const entries: TextureEntry[] = [];
  let cats: string[] = [];
  try {
    cats = await fs.readdir(TEXTURES_DIR);
  } catch {
    return NextResponse.json({ entries });
  }
  for (const cat of cats) {
    if (!ALLOWED_CATEGORIES.has(cat)) continue;
    const catPath = path.join(TEXTURES_DIR, cat);
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(catPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let files: string[] = [];
    try {
      files = await fs.readdir(catPath);
    } catch {
      continue;
    }
    for (const f of files) {
      const childPath = path.join(catPath, f);
      let childStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        childStat = await fs.stat(childPath);
      } catch {
        continue;
      }
      if (childStat.isDirectory()) {
        // Per-state subfolder. Each file is <state>.<ext> for a
        // spritesheet, OR a deeper <state>/<frameIndex>.<ext>
        // when source = 'frames' authoring is used.
        const id = f;
        if (!SAFE_ID.test(id)) continue;
        let stateFiles: string[] = [];
        try {
          stateFiles = await fs.readdir(childPath);
        } catch {
          continue;
        }
        for (const sf of stateFiles) {
          const sfPath = path.join(childPath, sf);
          let sfStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
          try {
            sfStat = await fs.stat(sfPath);
          } catch {
            continue;
          }
          if (sfStat.isDirectory()) {
            // Per-frame folder for source='frames' authoring.
            const state = sf;
            if (!SAFE_ID.test(state)) continue;
            let frameFiles: string[] = [];
            try {
              frameFiles = await fs.readdir(sfPath);
            } catch {
              continue;
            }
            for (const ff of frameFiles) {
              const dot = ff.lastIndexOf('.');
              if (dot < 0) continue;
              const fname = ff.slice(0, dot);
              const ext = ff.slice(dot + 1).toLowerCase();
              if (!/^\d+$/.test(fname)) continue;
              const frame = parseInt(fname, 10);
              if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) continue;
              entries.push({
                category: cat,
                id,
                state,
                frame,
                url: `/textures/${cat}/${id}/${state}/${ff}`,
              });
            }
            continue;
          }
          // Spritesheet at <state>.<ext>.
          const dot = sf.lastIndexOf('.');
          if (dot < 0) continue;
          const state = sf.slice(0, dot);
          const ext = sf.slice(dot + 1).toLowerCase();
          if (!SAFE_ID.test(state)) continue;
          if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) continue;
          entries.push({
            category: cat,
            id,
            state,
            url: `/textures/${cat}/${id}/${sf}`,
          });
        }
        continue;
      }
      // Legacy single-PNG asset.
      const dot = f.lastIndexOf('.');
      if (dot < 0) continue;
      const id = f.slice(0, dot);
      const ext = f.slice(dot + 1).toLowerCase();
      if (!SAFE_ID.test(id)) continue;
      if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) continue;
      entries.push({ category: cat, id, url: `/textures/${cat}/${f}` });
    }
  }
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest) {
  if (isProd()) {
    return NextResponse.json(
      {
        error:
          'texture uploads are disabled in production. Add the file locally and redeploy.',
      },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const { category, id, dataUrl, state, frame } = body as Record<
    string,
    unknown
  >;
  if (
    typeof category !== 'string' ||
    typeof id !== 'string' ||
    typeof dataUrl !== 'string' ||
    !safe(category, id)
  ) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const stateName = typeof state === 'string' && state.length > 0 ? state : null;
  if (stateName !== null && !SAFE_ID.test(stateName)) {
    return NextResponse.json({ error: 'invalid state' }, { status: 400 });
  }
  const frameIndex =
    typeof frame === 'number' && Number.isInteger(frame) && frame >= 0
      ? frame
      : null;
  if (frameIndex !== null && stateName === null) {
    return NextResponse.json(
      { error: 'frame requires state' },
      { status: 400 },
    );
  }
  const m = /^data:image\/(png|webp|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl,
  );
  if (!m) {
    return NextResponse.json({ error: 'invalid data url' }, { status: 400 });
  }
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_BYTES) {
    return NextResponse.json({ error: 'too large' }, { status: 413 });
  }
  if (frameIndex !== null && stateName !== null) {
    // Per-frame PNG: <category>/<id>/<state>/<frameIndex>.<ext>.
    const dir = path.join(TEXTURES_DIR, category, id, stateName);
    await fs.mkdir(dir, { recursive: true });
    for (const e of ALLOWED_EXTS) {
      if (e === ext) continue;
      await fs
        .rm(path.join(dir, `${frameIndex}.${e}`), { force: true })
        .catch(() => {});
    }
    const file = path.join(dir, `${frameIndex}.${ext}`);
    await fs.writeFile(file, buf);
    return NextResponse.json({
      url: `/textures/${category}/${id}/${stateName}/${frameIndex}.${ext}?v=${Date.now()}`,
    });
  }
  if (stateName !== null) {
    // Per-state spritesheet: <category>/<id>/<state>.<ext>.
    const dir = path.join(TEXTURES_DIR, category, id);
    await fs.mkdir(dir, { recursive: true });
    for (const e of ALLOWED_EXTS) {
      if (e === ext) continue;
      await fs
        .rm(path.join(dir, `${stateName}.${e}`), { force: true })
        .catch(() => {});
    }
    const file = path.join(dir, `${stateName}.${ext}`);
    await fs.writeFile(file, buf);
    return NextResponse.json({
      url: `/textures/${category}/${id}/${stateName}.${ext}?v=${Date.now()}`,
    });
  }
  // Legacy single-PNG asset: <category>/<id>.<ext>.
  const dir = path.join(TEXTURES_DIR, category);
  await fs.mkdir(dir, { recursive: true });
  // One file per id. If a previous upload used a different
  // extension, drop it before writing so we don't end up with
  // both <id>.png and <id>.webp on disk.
  for (const e of ALLOWED_EXTS) {
    if (e === ext) continue;
    await fs.rm(path.join(dir, `${id}.${e}`), { force: true }).catch(() => {});
  }
  const file = path.join(dir, `${id}.${ext}`);
  await fs.writeFile(file, buf);
  return NextResponse.json({
    url: `/textures/${category}/${id}.${ext}?v=${Date.now()}`,
  });
}

export async function DELETE(req: NextRequest) {
  if (isProd()) {
    return NextResponse.json(
      {
        error:
          'texture deletes are disabled in production. Remove the file locally and redeploy.',
      },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const { category, id, state, frame } = body as Record<string, unknown>;
  if (typeof category !== 'string' || typeof id !== 'string' || !safe(category, id)) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const stateName = typeof state === 'string' && state.length > 0 ? state : null;
  const frameIndex =
    typeof frame === 'number' && Number.isInteger(frame) && frame >= 0
      ? frame
      : null;
  if (frameIndex !== null && stateName !== null) {
    if (!SAFE_ID.test(stateName)) {
      return NextResponse.json({ error: 'invalid state' }, { status: 400 });
    }
    const dir = path.join(TEXTURES_DIR, category, id, stateName);
    for (const e of ALLOWED_EXTS) {
      await fs
        .rm(path.join(dir, `${frameIndex}.${e}`), { force: true })
        .catch(() => {});
    }
    return NextResponse.json({});
  }
  if (stateName !== null) {
    if (!SAFE_ID.test(stateName)) {
      return NextResponse.json({ error: 'invalid state' }, { status: 400 });
    }
    const dir = path.join(TEXTURES_DIR, category, id);
    for (const e of ALLOWED_EXTS) {
      await fs
        .rm(path.join(dir, `${stateName}.${e}`), { force: true })
        .catch(() => {});
    }
    return NextResponse.json({});
  }
  const dir = path.join(TEXTURES_DIR, category);
  for (const e of ALLOWED_EXTS) {
    await fs.rm(path.join(dir, `${id}.${e}`), { force: true }).catch(() => {});
  }
  return NextResponse.json({});
}
