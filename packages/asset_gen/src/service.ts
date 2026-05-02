import { assembleAnimationSheet, type AnimationFrameInput } from './animation.js';
import { cleanImage } from './cleanup.js';
import { makeCacheKey, newId } from './hash.js';
import { compileAnimationFramePrompt, compileAssetPrompt } from './prompt.js';
import type { ImageGenerator } from './providers/types.js';
import type {
  AssetGenerateRequest,
  AssetJob,
  AssetPrewarmRequest,
  AssetRecord,
} from './schemas.js';
import type { AssetStore } from './store.js';
import type { AssetVerifier } from './verifier.js';

type GenerateResult =
  | { status: 'approved'; asset: AssetRecord }
  | { status: 'queued'; job: AssetJob };

export type PrewarmResult = {
  status: 'accepted';
  queued: number;
  cached: number;
  jobs: AssetJob[];
  assets: AssetRecord[];
};

export class AssetGenerationService {
  private readonly queue: string[] = [];
  private active = 0;

  constructor(
    private readonly deps: {
      store: AssetStore;
      imageGenerator: ImageGenerator;
      verifier: AssetVerifier;
      maxConcurrentJobs: number;
      imageSize: string;
      imageQuality: 'low' | 'medium' | 'high' | 'auto';
      supportsTransparentBackground: boolean;
    }
  ) {}

  async generate(request: AssetGenerateRequest): Promise<GenerateResult> {
    const cacheKey = makeCacheKey(request);
    const cached = await this.deps.store.getAssetByCacheKey(cacheKey);
    if (cached) return { status: 'approved', asset: cached };

    const activeJob = await this.deps.store.getActiveJobByCacheKey(cacheKey);
    if (activeJob) return { status: 'queued', job: activeJob };

    const now = new Date().toISOString();
    const job: AssetJob = {
      jobId: newId('job'),
      status: 'queued',
      cacheKey,
      request,
      assetId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.putJob(job);
    this.queue.push(job.jobId);
    this.pump();
    return { status: 'queued', job };
  }

  async prewarm(request: AssetPrewarmRequest): Promise<PrewarmResult> {
    const jobs: AssetJob[] = [];
    const assets: AssetRecord[] = [];
    for (const assetRequest of request.requests) {
      const result = await this.generate(assetRequest);
      if (result.status === 'approved') {
        assets.push(result.asset);
      } else {
        jobs.push(result.job);
      }
    }
    return {
      status: 'accepted',
      queued: jobs.length,
      cached: assets.length,
      jobs,
      assets,
    };
  }

  getJob(jobId: string): Promise<AssetJob | null> {
    return this.deps.store.getJob(jobId);
  }

  getAsset(assetId: string): Promise<AssetRecord | null> {
    return this.deps.store.getAsset(assetId);
  }

  listApprovedAssets(): Promise<AssetRecord[]> {
    return this.deps.store.listApprovedAssets();
  }

  private pump(): void {
    while (
      this.active < this.deps.maxConcurrentJobs &&
      this.queue.length > 0
    ) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      this.active++;
      void this.runJob(jobId).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = await this.deps.store.getJob(jobId);
    if (!job) return;

    try {
      if (job.request.assetKind === 'enemy_animation') {
        await this.runAnimationJob(job);
        return;
      }

      await this.updateJob(job, { status: 'generating' });
      const prompt = compileAssetPrompt(job.request);
      const generated = await this.deps.imageGenerator.generate({
        prompt,
        size: this.deps.imageSize,
        quality: this.deps.imageQuality,
        background: this.imageBackground(job.request),
      });

      await this.updateJob(job, { status: 'cleaning' });
      const cleaned = await cleanImage(job.request, generated);

      await this.updateJob(job, { status: 'verifying' });
      const verification = await this.deps.verifier.verify({
        request: job.request,
        metadata: cleaned.metadata,
        pngBytes: cleaned.bytes,
      });

      if (verification.verdict !== 'pass') {
        await this.updateJob(job, {
          status: 'rejected',
          error: verification.reasons.join('; ') || verification.summary,
        });
        return;
      }

      const now = new Date().toISOString();
      const asset: AssetRecord = {
        assetId: newId('asset'),
        cacheKey: job.cacheKey,
        request: job.request,
        urls: { png: '' },
        metadata: cleaned.metadata,
        verification,
        createdAt: now,
      };
      const stored = await this.deps.store.putAsset(asset, cleaned.bytes);
      await this.updateJob(job, {
        status: 'approved',
        assetId: stored.assetId,
        error: null,
      });
    } catch (error) {
      await this.updateJob(job, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runAnimationJob(job: AssetJob): Promise<void> {
    if (!job.request.animation) {
      await this.updateJob(job, {
        status: 'failed',
        error: 'animation request missing animation spec',
      });
      return;
    }
    if (job.request.animation.baseAssetId) {
      const baseExists = await this.deps.store.getAssetPngBytes(job.request.animation.baseAssetId);
      if (!baseExists) {
        await this.updateJob(job, {
          status: 'failed',
          error: `baseAssetId ${job.request.animation.baseAssetId} was not found in local store`,
        });
        return;
      }
    }

    try {
      const baseAsset = job.request.animation.baseAssetId
        ? await this.deps.store.getAssetPngBytes(job.request.animation.baseAssetId)
        : null;
      const frames: AnimationFrameInput[] = [];
      for (let frameIndex = 0; frameIndex < job.request.animation.frameCount; frameIndex++) {
        await this.updateJob(job, { status: 'generating' });
        const prompt = compileAnimationFramePrompt(job.request, frameIndex);
        const generated = baseAsset
          ? await this.deps.imageGenerator.edit({
              prompt,
              size: this.deps.imageSize,
              quality: this.deps.imageQuality,
              background: this.imageBackground(job.request),
              inputFidelity: 'high',
              referenceImages: [{
                filename: `${job.request.animation.baseAssetId}.png`,
                mimeType: 'image/png',
                bytes: baseAsset,
              }],
            })
          : await this.deps.imageGenerator.generate({
              prompt,
              size: this.deps.imageSize,
              quality: this.deps.imageQuality,
              background: this.imageBackground(job.request),
            });

        await this.updateJob(job, { status: 'cleaning' });
        const cleaned = await cleanImage(job.request, generated);

        await this.updateJob(job, { status: 'verifying' });
        const verification = await this.deps.verifier.verify({
          request: job.request,
          metadata: cleaned.metadata,
          pngBytes: cleaned.bytes,
        });
        if (verification.verdict !== 'pass') {
          await this.updateJob(job, {
            status: 'rejected',
            error: `${frameName(job.request.animation.action, frameIndex)}: ${verification.reasons.join('; ') || verification.summary}`,
          });
          return;
        }

        frames.push({
          name: frameName(job.request.animation.action, frameIndex),
          bytes: cleaned.bytes,
          metadata: cleaned.metadata,
        });
      }

      const sheet = await assembleAnimationSheet(job.request, frames);
      if (sheet.verification.verdict !== 'pass') {
        await this.updateJob(job, {
          status: 'rejected',
          error: sheet.verification.reasons.join('; ') || sheet.verification.summary,
        });
        return;
      }

      const now = new Date().toISOString();
      const asset: AssetRecord = {
        assetId: newId('asset'),
        cacheKey: job.cacheKey,
        request: job.request,
        urls: { png: '' },
        metadata: sheet.metadata,
        animation: sheet.animation,
        verification: sheet.verification,
        createdAt: now,
      };
      const stored = await this.deps.store.putAsset(asset, sheet.bytes);
      await this.updateJob(job, {
        status: 'approved',
        assetId: stored.assetId,
        error: null,
      });
    } catch (error) {
      await this.updateJob(job, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private imageBackground(request: AssetGenerateRequest): 'transparent' | 'opaque' | 'auto' {
    if (!request.style.transparentBackground) return 'auto';
    return this.deps.supportsTransparentBackground ? 'transparent' : 'auto';
  }

  private async updateJob(
    job: AssetJob,
    patch: Partial<Pick<AssetJob, 'status' | 'assetId' | 'error'>>
  ): Promise<void> {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.deps.store.putJob(job);
  }
}

function frameName(action: string, frameIndex: number): string {
  return `${action}_${frameIndex}`;
}
