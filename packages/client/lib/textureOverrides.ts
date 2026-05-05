// Manual texture overrides — persistent in the repo.
//
// Storage: packages/client/public/textures/<category>/<id>.<ext>,
// served as static files at /textures/<category>/<id>.<ext>.
// Reads/writes go through /api/editor/textures.
//
// In-memory cache holds the disk URL for each (category, id). It's
// hydrated once at first read by GETting the API. Subsequent
// renderer / editor lookups are synchronous against the cache, so
// callers don't need to await. setOverride/clearOverride are
// async (network round trip) but the editor's UI is fine
// dispatching them fire-and-forget.

'use client';

const cache = new Map<string, string>();
let cacheLoaded = false;
let cacheLoading: Promise<void> | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

function k(category: string, id: string): string {
  return `${category}::${id}`;
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  if (cacheLoading) return cacheLoading;
  cacheLoading = (async () => {
    try {
      const r = await fetch('/api/editor/textures');
      if (!r.ok) return;
      const payload = (await r.json()) as {
        entries?: { category: string; id: string; url: string }[];
      };
      for (const e of payload.entries ?? []) {
        cache.set(k(e.category, e.id), e.url);
      }
    } catch {
      // No server / offline — leave cache empty. Renderers fall
      // back to procedural geometry.
    } finally {
      cacheLoaded = true;
      cacheLoading = null;
      notify();
    }
  })();
  return cacheLoading;
}

// Synchronous read against the in-memory cache. First call kicks
// off the async load; the result lands when the subscribe()
// notification fires after the fetch resolves.
export function getOverride(category: string, id: string): string | null {
  if (!cacheLoaded && !cacheLoading) {
    if (typeof window !== 'undefined') void loadCache();
  }
  return cache.get(k(category, id)) ?? null;
}

// POSTs the data URL to the API; the API decodes and writes the
// file under public/textures. On success, updates the cache to
// the new HTTP URL and notifies subscribers.
export async function setOverride(
  category: string,
  id: string,
  dataUrl: string,
): Promise<void> {
  const r = await fetch('/api/editor/textures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category, id, dataUrl }),
  });
  if (!r.ok) {
    throw new Error(`save failed: ${r.status}`);
  }
  const payload = (await r.json()) as { url?: string };
  if (typeof payload.url !== 'string') {
    throw new Error('save response missing url');
  }
  cache.set(k(category, id), payload.url);
  notify();
}

export async function clearOverride(
  category: string,
  id: string,
): Promise<void> {
  await fetch('/api/editor/textures', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category, id }),
  });
  cache.delete(k(category, id));
  notify();
}

export function listOverrides(): { category: string; id: string }[] {
  return [...cache.keys()].map((entry) => {
    const sep = entry.indexOf('::');
    return { category: entry.slice(0, sep), id: entry.slice(sep + 2) };
  });
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* swallow */
    }
  }
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
