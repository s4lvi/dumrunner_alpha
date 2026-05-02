export type AssetGenConfig = {
  port: number;
  publicBaseUrl: string;
  storageDir: string;
  maxConcurrentJobs: number;
  openaiApiKey: string | null;
  imageModel: string;
  imageQuality: 'low' | 'medium' | 'high' | 'auto';
  imageSize: string;
  serviceToken: string | null;
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): AssetGenConfig {
  const port = intFromEnv('ASSET_GEN_PORT', 8787);
  const imageQuality = parseImageQuality(process.env.ASSET_GEN_IMAGE_QUALITY);
  return {
    port,
    publicBaseUrl: process.env.ASSET_GEN_PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    storageDir: process.env.ASSET_GEN_STORAGE_DIR ?? '.asset_gen',
    maxConcurrentJobs: Math.max(1, intFromEnv('ASSET_GEN_MAX_CONCURRENT_JOBS', 1)),
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    imageModel: process.env.ASSET_GEN_IMAGE_MODEL ?? 'gpt-image-1.5',
    imageQuality,
    imageSize: process.env.ASSET_GEN_IMAGE_SIZE ?? '1024x1024',
    serviceToken: process.env.ASSET_GEN_SERVICE_TOKEN ?? null,
  };
}

function parseImageQuality(raw: string | undefined): AssetGenConfig['imageQuality'] {
  return raw === 'medium' || raw === 'high' || raw === 'auto' ? raw : 'low';
}
