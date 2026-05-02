import type { AssetGenerateRequest, AssetMetadata, VerificationResult } from './schemas.js';

export interface AssetVerifier {
  verify(input: {
    request: AssetGenerateRequest;
    metadata: AssetMetadata;
    pngBytes: Buffer;
  }): Promise<VerificationResult>;
}

export class HeuristicAssetVerifier implements AssetVerifier {
  async verify(input: {
    request: AssetGenerateRequest;
    metadata: AssetMetadata;
    pngBytes: Buffer;
  }): Promise<VerificationResult> {
    const reasons: string[] = [];
    const { request, metadata, pngBytes } = input;

    if (pngBytes.length === 0) reasons.push('empty image payload');
    if (metadata.width < request.size || metadata.height < request.size) {
      reasons.push(`generated image is smaller than requested final size ${request.size}`);
    }
    if (request.style.transparentBackground && !metadata.transparent) {
      reasons.push('transparent background still pending post-processing');
    }

    if (reasons.length > 0) {
      return {
        score: 0.55,
        verdict: 'retry',
        summary: 'Generated asset needs cleanup or model verification before game use.',
        reasons,
      };
    }

    return {
      score: 0.82,
      verdict: 'pass',
      summary: `Generated ${request.assetKind} asset passed baseline mechanical checks.`,
      reasons: [],
    };
  }
}
