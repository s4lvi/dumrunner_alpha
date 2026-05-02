import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetGenConfig } from './config.js';
import type { AssetJob, AssetRecord } from './schemas.js';

export interface AssetStore {
  getAssetByCacheKey(cacheKey: string): Promise<AssetRecord | null>;
  getAsset(assetId: string): Promise<AssetRecord | null>;
  putAsset(asset: AssetRecord, pngBytes: Buffer): Promise<AssetRecord>;
  getJob(jobId: string): Promise<AssetJob | null>;
  putJob(job: AssetJob): Promise<void>;
}

export class InMemoryAssetStore implements AssetStore {
  private readonly assetsById = new Map<string, AssetRecord>();
  private readonly assetIdsByCacheKey = new Map<string, string>();
  private readonly jobs = new Map<string, AssetJob>();

  constructor(private readonly config: AssetGenConfig) {}

  async getAssetByCacheKey(cacheKey: string): Promise<AssetRecord | null> {
    const assetId = this.assetIdsByCacheKey.get(cacheKey);
    return assetId ? this.assetsById.get(assetId) ?? null : null;
  }

  async getAsset(assetId: string): Promise<AssetRecord | null> {
    return this.assetsById.get(assetId) ?? null;
  }

  async putAsset(asset: AssetRecord, pngBytes: Buffer): Promise<AssetRecord> {
    await mkdir(this.config.storageDir, { recursive: true });
    const filename = `${asset.assetId}.png`;
    await writeFile(join(this.config.storageDir, filename), pngBytes);
    const stored = {
      ...asset,
      urls: {
        ...asset.urls,
        png: `${this.config.publicBaseUrl}/assets/${filename}`,
      },
    };
    this.assetsById.set(stored.assetId, stored);
    this.assetIdsByCacheKey.set(stored.cacheKey, stored.assetId);
    return stored;
  }

  async getJob(jobId: string): Promise<AssetJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async putJob(job: AssetJob): Promise<void> {
    this.jobs.set(job.jobId, job);
  }
}
