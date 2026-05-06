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
const ALLOWED_CATEGORIES = new Set([
  'enemy',
  'building',
  'prop',
  'material',
]);
const SAFE_ID = /^[a-z0-9_-]+$/i;
const ALLOWED_EXTS = ['png', 'webp', 'jpg'] as const;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per asset — plenty for sprites

function safe(category: string, id: string): boolean {
  return ALLOWED_CATEGORIES.has(category) && SAFE_ID.test(id);
}

export async function GET() {
  await fs.mkdir(TEXTURES_DIR, { recursive: true });
  const entries: { category: string; id: string; url: string }[] = [];
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
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const { category, id, dataUrl } = body as Record<string, unknown>;
  if (
    typeof category !== 'string' ||
    typeof id !== 'string' ||
    typeof dataUrl !== 'string' ||
    !safe(category, id)
  ) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
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
  // Cache-buster query so the browser swaps in the new image
  // even when replacing the same path immediately.
  return NextResponse.json({
    url: `/textures/${category}/${id}.${ext}?v=${Date.now()}`,
  });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const { category, id } = body as Record<string, unknown>;
  if (typeof category !== 'string' || typeof id !== 'string' || !safe(category, id)) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const dir = path.join(TEXTURES_DIR, category);
  for (const e of ALLOWED_EXTS) {
    await fs.rm(path.join(dir, `${id}.${e}`), { force: true }).catch(() => {});
  }
  return NextResponse.json({});
}
