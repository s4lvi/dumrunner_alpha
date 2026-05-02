import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetGenConfig } from './config.js';
import type { AssetJob, AssetRecord } from './schemas.js';

export interface AssetStore {
  getAssetByCacheKey(cacheKey: string): Promise<AssetRecord | null>;
  getAsset(assetId: string): Promise<AssetRecord | null>;
  getAssetPngBytes(assetId: string): Promise<Buffer | null>;
  listApprovedAssets(): Promise<AssetRecord[]>;
  putAsset(asset: AssetRecord, pngBytes: Buffer): Promise<AssetRecord>;
  getJob(jobId: string): Promise<AssetJob | null>;
  getActiveJobByCacheKey(cacheKey: string): Promise<AssetJob | null>;
  putJob(job: AssetJob): Promise<void>;
}

type StoreSnapshot = {
  assets: AssetRecord[];
  jobs: AssetJob[];
};

export class LocalAssetStore implements AssetStore {
  private readonly assetsById = new Map<string, AssetRecord>();
  private readonly assetIdsByCacheKey = new Map<string, string>();
  private readonly jobs = new Map<string, AssetJob>();
  private readonly jobIdsByCacheKey = new Map<string, string>();
  private readonly indexPath: string;
  private readonly approvedDir: string;

  private constructor(private readonly config: AssetGenConfig) {
    this.indexPath = join(config.storageDir, 'index.json');
    this.approvedDir = join(config.storageDir, 'approved');
  }

  static async create(config: AssetGenConfig): Promise<LocalAssetStore> {
    const store = new LocalAssetStore(config);
    await store.load();
    return store;
  }

  async getAssetByCacheKey(cacheKey: string): Promise<AssetRecord | null> {
    const assetId = this.assetIdsByCacheKey.get(cacheKey);
    return assetId ? this.assetsById.get(assetId) ?? null : null;
  }

  async getAsset(assetId: string): Promise<AssetRecord | null> {
    return this.assetsById.get(assetId) ?? null;
  }

  async getAssetPngBytes(assetId: string): Promise<Buffer | null> {
    const asset = this.assetsById.get(assetId);
    if (!asset) return null;
    try {
      return await readFile(join(this.approvedDir, `${asset.assetId}.png`));
    } catch {
      return null;
    }
  }

  async listApprovedAssets(): Promise<AssetRecord[]> {
    return [...this.assetsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async putAsset(asset: AssetRecord, pngBytes: Buffer): Promise<AssetRecord> {
    await mkdir(this.approvedDir, { recursive: true });
    const filename = `${asset.assetId}.png`;
    await writeFile(join(this.approvedDir, filename), pngBytes);
    const stored = {
      ...asset,
      urls: {
        ...asset.urls,
        png: `${this.config.publicBaseUrl}/assets/${filename}`,
      },
    };
    this.assetsById.set(stored.assetId, stored);
    this.assetIdsByCacheKey.set(stored.cacheKey, stored.assetId);
    await this.persist();
    return stored;
  }

  async getJob(jobId: string): Promise<AssetJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async getActiveJobByCacheKey(cacheKey: string): Promise<AssetJob | null> {
    const jobId = this.jobIdsByCacheKey.get(cacheKey);
    if (!jobId) return null;
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'approved' || job.status === 'rejected' || job.status === 'failed') {
      return null;
    }
    return job;
  }

  async putJob(job: AssetJob): Promise<void> {
    this.jobs.set(job.jobId, job);
    this.jobIdsByCacheKey.set(job.cacheKey, job.jobId);
    await this.persist();
  }

  private async load(): Promise<void> {
    await mkdir(this.approvedDir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.indexPath, 'utf8');
    } catch {
      return;
    }

    const snapshot = JSON.parse(raw) as Partial<StoreSnapshot>;
    for (const asset of snapshot.assets ?? []) {
      this.assetsById.set(asset.assetId, asset);
      this.assetIdsByCacheKey.set(asset.cacheKey, asset.assetId);
    }
    for (const job of snapshot.jobs ?? []) {
      this.jobs.set(job.jobId, job);
      this.jobIdsByCacheKey.set(job.cacheKey, job.jobId);
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.config.storageDir, { recursive: true });
    const snapshot: StoreSnapshot = {
      assets: [...this.assetsById.values()],
      jobs: [...this.jobs.values()],
    };
    const tmpPath = `${this.indexPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(tmpPath, this.indexPath);
  }
}
