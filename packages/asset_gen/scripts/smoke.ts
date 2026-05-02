import type { AssetGenerateRequest } from '../src/schemas.js';

const base = process.env.ASSET_GEN_PUBLIC_BASE_URL ?? 'http://localhost:8787';
const token = process.env.ASSET_GEN_SERVICE_TOKEN;
const mode = process.argv.includes('--animation') ? 'animation' : 'static';
const animationAction = readOption('action') ?? 'idle';
const animationFrames = readFrameCount(animationAction, readOption('frames'));
const headers = {
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const baseEnemyRequest: AssetGenerateRequest = {
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
};

const staticRequests: AssetGenerateRequest[] = [
  baseEnemyRequest,
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

function animationRequest(baseAssetId: string): AssetGenerateRequest {
  return {
    ...baseEnemyRequest,
    requestId: `smoke:enemy_animation:chaser_melee_${animationAction}_${animationFrames}:${baseAssetId}`,
    assetKind: 'enemy_animation',
    gameObject: {
      id: `chaser_melee_${animationAction}`,
      label: 'rat-like tunnel scavenger',
      faction: 'catacombs',
    },
    visualBrief: {
      ...baseEnemyRequest.visualBrief,
      mustInclude: ['readable top-down silhouette', 'same creature identity across frames'],
      mustAvoid: ['text', 'background scene', 'multiple creatures', 'sprite sheet'],
    },
    animation: {
      baseAssetId,
      action: animationAction,
      frameCount: animationFrames,
      directionMode: 'omnidirectional',
      fps: animationAction === 'idle' ? 4 : 8,
      maxFrameDriftPx: animationAction === 'death' ? 8 : 5,
    },
  };
}

type GenerateResponse =
  | {
      status: 'approved';
      assetId: string;
      urls?: unknown;
      metadata?: unknown;
      family?: unknown;
      animation?: unknown;
      verification?: unknown;
    }
  | { status: string; jobId: string; assetId: null; pollUrl: string };

type JobResponse = {
  status: string;
  assetId: string | null;
  error: string | null;
};

async function main(): Promise<void> {
  const results: unknown[] = [];
  if (mode === 'animation') {
    const baseAsset = await runOne(baseEnemyRequest);
    const baseAssetId = assetIdFromResult(baseAsset);
    if (!baseAssetId) throw new Error('base enemy asset did not return an assetId');
    results.push(baseAsset);
    results.push(await runOne(animationRequest(baseAssetId)));
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const requests = staticRequests;
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
    family: asset.family,
    animation: asset.animation,
    metadata: asset.metadata,
    verification: asset.verification,
  };
}

function assetIdFromResult(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const maybe = result as { assetId?: unknown };
  return typeof maybe.assetId === 'string' ? maybe.assetId : null;
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

function readOption(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function readFrameCount(
  action: string,
  raw: string | null
): 2 | 3 | 4 {
  if (raw === '2' || raw === '3' || raw === '4') return Number(raw) as 2 | 3 | 4;
  if (action === 'walk') return 4;
  if (action === 'attack') return 3;
  return 2;
}

await main();
