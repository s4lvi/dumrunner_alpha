import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { loadConfig } from './config.js';
import {
  OpenAIImageGenerator,
  PlaceholderImageGenerator,
} from './providers/openaiImage.js';
import {
  AssetGenerateRequestSchema,
  AssetPrewarmRequestSchema,
} from './schemas.js';
import { AssetGenerationService } from './service.js';
import { LocalAssetStore } from './store.js';
import { HeuristicAssetVerifier } from './verifier.js';

const config = loadConfig();
const store = await LocalAssetStore.create(config);
const imageGenerator = config.openaiApiKey
  ? new OpenAIImageGenerator(config)
  : new PlaceholderImageGenerator();
const service = new AssetGenerationService({
  store,
  imageGenerator,
  verifier: new HeuristicAssetVerifier(),
  maxConcurrentJobs: config.maxConcurrentJobs,
  imageSize: config.imageSize,
  imageQuality: config.imageQuality,
  supportsTransparentBackground: supportsTransparentBackground(config.imageModel),
});

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
});

server.listen(config.port, () => {
  const provider = config.openaiApiKey ? config.imageModel : 'placeholder';
  console.log(`[asset_gen] listening on ${config.publicBaseUrl} (${provider})`);
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', config.publicBaseUrl);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    await serveAsset(url.pathname, res);
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/assets/generate') {
    const body = await readJson(req);
    const request = AssetGenerateRequestSchema.parse(body);
    const result = await service.generate(request);
    if (result.status === 'approved') {
      sendJson(res, 200, { status: 'approved', ...result.asset });
    } else {
      sendJson(res, 202, {
        status: result.job.status,
        jobId: result.job.jobId,
        assetId: null,
        pollUrl: `/v1/assets/jobs/${result.job.jobId}`,
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/assets/prewarm') {
    const body = await readJson(req);
    const request = AssetPrewarmRequestSchema.parse(body);
    const result = await service.prewarm(request);
    sendJson(res, 202, result);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/assets/index') {
    sendJson(res, 200, {
      assets: await service.listApprovedAssets(),
    });
    return;
  }

  const jobMatch = url.pathname.match(/^\/v1\/assets\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = await service.getJob(jobMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'job not found' });
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  const assetMatch = url.pathname.match(/^\/v1\/assets\/([^/]+)$/);
  if (req.method === 'GET' && assetMatch) {
    const asset = await service.getAsset(assetMatch[1]);
    if (!asset) {
      sendJson(res, 404, { error: 'asset not found' });
      return;
    }
    sendJson(res, 200, asset);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!config.serviceToken) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${config.serviceToken}`) return true;
  return req.headers['x-asset-gen-token'] === config.serviceToken;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 512_000) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveAsset(pathname: string, res: ServerResponse): Promise<void> {
  const filename = basename(pathname);
  if (!filename.endsWith('.png')) {
    sendJson(res, 404, { error: 'asset not found' });
    return;
  }
  const path = join(config.storageDir, 'approved', filename);
  try {
    await readFile(path);
  } catch {
    sendJson(res, 404, { error: 'asset not found' });
    return;
  }
  res.writeHead(200, { 'content-type': 'image/png' });
  createReadStream(path).pipe(res);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

function shutdown(): void {
  server.close(() => process.exit(0));
}

export const assetGenServer = server;

function supportsTransparentBackground(model: string): boolean {
  return model !== 'gpt-image-2' && !model.startsWith('gpt-image-2-');
}
