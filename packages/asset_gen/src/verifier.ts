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
    if (metadata.width !== request.size || metadata.height !== request.size) {
      reasons.push(`cleaned image must be exactly ${request.size}x${request.size}`);
    }
    if (request.style.transparentBackground && !metadata.transparent) {
      reasons.push('transparent background is missing or not credible');
    }
    if (metadata.opaqueBounds.w === 0 || metadata.opaqueBounds.h === 0) {
      reasons.push('image has no visible opaque pixels');
    }
    const maxBound = Math.floor(request.size * request.constraints.maxOpaqueBoundsRatio);
    if (metadata.opaqueBounds.w > maxBound || metadata.opaqueBounds.h > maxBound) {
      reasons.push(`opaque bounds exceed max ratio ${request.constraints.maxOpaqueBoundsRatio}`);
    }
    const margin = request.constraints.safeMarginPx;
    if (
      metadata.opaqueBounds.x < margin ||
      metadata.opaqueBounds.y < margin ||
      metadata.opaqueBounds.x + metadata.opaqueBounds.w > request.size - margin ||
      metadata.opaqueBounds.y + metadata.opaqueBounds.h > request.size - margin
    ) {
      reasons.push(`opaque pixels violate ${margin}px safe margin`);
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
