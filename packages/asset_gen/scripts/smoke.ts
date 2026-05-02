import type { AssetGenerateRequest } from '../src/schemas.js';

const base = process.env.ASSET_GEN_PUBLIC_BASE_URL ?? 'http://localhost:8787';
const token = process.env.ASSET_GEN_SERVICE_TOKEN;
const headers = {
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const requests: AssetGenerateRequest[] = [
  {
    assetKind: 'enemy',
    renderTarget: 'world_sprite',
    size: 64,
    style: {
      camera: 'top_down',
      renderStyle: 'painted_sprite',
      outline: true,
      transparentBackground: true,
    },
    gameObject: {
      id: 'chaser_melee',
      label: 'rat-like tunnel scavenger',
      faction: 'catacombs',
    },
    visualBrief: {
      subject: 'rat-like mutant scavenger',
      materials: ['patchy fur', 'rusted scrap implants'],
      colors: ['#a855f7', '#22c55e', '#111827'],
      mustInclude: ['readable top-down silhouette', 'single enemy sprite'],
      mustAvoid: ['text', 'background scene', 'multiple creatures'],
    },
    constraints: {
      safeMarginPx: 4,
      anchor: 'center_bottom',
      maxOpaqueBoundsRatio: 0.86,
      minReadableAtPx: 32,
    },
  },
  {
    assetKind: 'material',
    renderTarget: 'inventory_icon',
    size: 64,
    style: {
      camera: 'three_quarter',
      renderStyle: 'clean_icon',
      outline: true,
      transparentBackground: true,
    },
    gameObject: {
      id: 'scrap',
      label: 'Scrap',
      materialId: 'scrap',
    },
    visualBrief: {
      subject: 'small stack of rusty scrap metal',
      materials: ['rusty metal', 'bolted plate fragments'],
      colors: ['#c2410c', '#94a3b8', '#111827'],
      mustInclude: ['small stackable pickup icon'],
      mustAvoid: ['text', 'coin', 'large crate'],
    },
    constraints: {
      safeMarginPx: 5,
      anchor: 'center',
      maxOpaqueBoundsRatio: 0.82,
      minReadableAtPx: 32,
    },
  },
];

type GenerateResponse =
  | { status: 'approved'; assetId: string; urls?: unknown; metadata?: unknown; verification?: unknown }
  | { status: string; jobId: string; assetId: null; pollUrl: string };

type JobResponse = {
  status: string;
  assetId: string | null;
  error: string | null;
};

async function main(): Promise<void> {
  const results: unknown[] = [];
  for (const request of requests) {
    results.push(await runOne(request));
  }
  console.log(JSON.stringify(results, null, 2));
}

async function runOne(request: AssetGenerateRequest): Promise<unknown> {
  const created = await jsonFetch<GenerateResponse>('/v1/assets/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  console.log(`[submit] ${request.assetKind}:${request.gameObject.id} -> ${created.status}`);
  if (created.status === 'approved') return summarize(created);

  let job: JobResponse = {
    status: created.status,
    assetId: null,
    error: null,
  };
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    job = await jsonFetch<JobResponse>(`/v1/assets/jobs/${created.jobId}`, { headers });
    console.log(`[poll] ${request.assetKind}:${request.gameObject.id} -> ${job.status}`);
    if (job.status === 'approved' || job.status === 'rejected' || job.status === 'failed') {
      break;
    }
  }

  if (job.status !== 'approved' || !job.assetId) {
    return {
      kind: request.assetKind,
      id: request.gameObject.id,
      status: job.status,
      error: job.error,
    };
  }

  const asset = await jsonFetch<GenerateResponse>(`/v1/assets/${job.assetId}`, { headers });
  return summarize(asset);
}

function summarize(asset: GenerateResponse): unknown {
  return {
    status: asset.status,
    assetId: asset.assetId,
    urls: asset.urls,
    metadata: asset.metadata,
    verification: asset.verification,
  };
}

async function jsonFetch<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`);
  }
  return body as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
