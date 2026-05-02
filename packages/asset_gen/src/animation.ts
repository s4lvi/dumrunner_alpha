import sharp from 'sharp';
import type {
  AnimationMetadata,
  AssetGenerateRequest,
  AssetMetadata,
  VerificationResult,
} from './schemas.js';

export type AnimationFrameInput = {
  name: string;
  bytes: Buffer;
  metadata: AssetMetadata;
};

type FrameAnalysis = {
  name: string;
  width: number;
  height: number;
  mask: Uint8Array;
  visiblePixels: number;
  centerX: number;
  centerY: number;
  averageRgb: { r: number; g: number; b: number };
};

type FrameSimilarity = {
  silhouetteIoU: number;
  paletteDistance: number;
  centerDriftPx: number;
  areaRatio: number;
};

export type AnimationSheet = {
  bytes: Buffer;
  metadata: AssetMetadata;
  animation: AnimationMetadata;
  verification: VerificationResult;
};

export async function assembleAnimationSheet(
  request: AssetGenerateRequest,
  frames: AnimationFrameInput[]
): Promise<AnimationSheet> {
  if (!request.animation) {
    throw new Error('animation request missing animation spec');
  }
  if (frames.length !== request.animation.frameCount) {
    throw new Error(`expected ${request.animation.frameCount} frames, received ${frames.length}`);
  }

  const frameWidth = request.size;
  const frameHeight = request.size;
  const bytes = await sharp({
    create: {
      width: frameWidth * frames.length,
      height: frameHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(frames.map((frame, index) => ({
      input: frame.bytes,
      left: index * frameWidth,
      top: 0,
    })))
    .png()
    .toBuffer();

  const analyses = await Promise.all(frames.map(analyzeFrame));
  const similarities = computeSimilarities(analyses);
  const verification = verifyAnimationFrames(request, frames, similarities);
  const bounds = unionBounds(frames.map((frame, index) => ({
    ...frame.metadata.opaqueBounds,
    x: frame.metadata.opaqueBounds.x + index * frameWidth,
  })));

  return {
    bytes,
    metadata: {
      width: frameWidth * frames.length,
      height: frameHeight,
      transparent: frames.every((frame) => frame.metadata.transparent),
      anchor: frames[0]?.metadata.anchor ?? { x: 0.5, y: 0.82 },
      opaqueBounds: bounds,
      averageColors: frames.flatMap((frame) => frame.metadata.averageColors).slice(0, 4),
    },
    animation: {
      action: request.animation.action,
      frameCount: frames.length,
      frameWidth,
      frameHeight,
      fps: request.animation.fps,
      directionMode: request.animation.directionMode,
      maxFrameDriftPx: request.animation.maxFrameDriftPx,
      frames: frames.map((frame, index) => ({
        name: frame.name,
        x: index * frameWidth,
        y: 0,
        w: frameWidth,
        h: frameHeight,
        anchor: frame.metadata.anchor,
        opaqueBounds: frame.metadata.opaqueBounds,
        similarity: similarities[index],
      })),
    },
    verification,
  };
}

function verifyAnimationFrames(
  request: AssetGenerateRequest,
  frames: AnimationFrameInput[],
  similarities: FrameSimilarity[]
): VerificationResult {
  const reasons: string[] = [];
  const maxDrift = request.animation?.maxFrameDriftPx ?? 3;
  const thresholds = thresholdsFor(request.animation?.action ?? 'idle');
  const first = frames[0]?.metadata.opaqueBounds;
  if (!first) {
    reasons.push('animation has no frames');
  }

  for (const [index, frame] of frames.entries()) {
    const bounds = frame.metadata.opaqueBounds;
    const similarity = similarities[index];
    if (frame.metadata.width !== request.size || frame.metadata.height !== request.size) {
      reasons.push(`${frame.name} is not ${request.size}x${request.size}`);
    }
    if (!frame.metadata.transparent) {
      reasons.push(`${frame.name} is not transparent`);
    }
    if (bounds.w === 0 || bounds.h === 0) {
      reasons.push(`${frame.name} has no visible pixels`);
    }
    if (first && drift(first, bounds) > maxDrift) {
      reasons.push(`${frame.name} drifts more than ${maxDrift}px from frame 0`);
    }
    if (similarity && similarity.silhouetteIoU < thresholds.minSilhouetteIoU) {
      reasons.push(`${frame.name} silhouette IoU ${fmt(similarity.silhouetteIoU)} below ${thresholds.minSilhouetteIoU}`);
    }
    if (similarity && similarity.paletteDistance > thresholds.maxPaletteDistance) {
      reasons.push(`${frame.name} palette distance ${fmt(similarity.paletteDistance)} above ${thresholds.maxPaletteDistance}`);
    }
    if (similarity && similarity.areaRatio < thresholds.minAreaRatio) {
      reasons.push(`${frame.name} visible area ratio ${fmt(similarity.areaRatio)} below ${thresholds.minAreaRatio}`);
    }
  }

  const minIou = Math.min(...similarities.map((entry) => entry.silhouetteIoU));
  const maxPaletteDistance = Math.max(...similarities.map((entry) => entry.paletteDistance));
  const maxCenterDrift = Math.max(...similarities.map((entry) => entry.centerDriftPx));
  const minAreaRatio = Math.min(...similarities.map((entry) => entry.areaRatio));

  if (reasons.length > 0) {
    return {
      score: 0.58,
      verdict: 'retry',
      summary: 'Animation sheet failed mechanical frame consistency checks.',
      reasons,
      metrics: {
        minSilhouetteIoU: finiteMetric(minIou),
        maxPaletteDistance: finiteMetric(maxPaletteDistance),
        maxCenterDriftPx: finiteMetric(maxCenterDrift),
        minAreaRatio: finiteMetric(minAreaRatio),
      },
    };
  }

  return {
    score: Math.min(0.92, 0.72 + minIou * 0.2),
    verdict: 'pass',
    summary: `Generated ${request.animation?.action ?? 'animation'} cycle passed baseline frame checks.`,
    reasons: [],
    metrics: {
      minSilhouetteIoU: finiteMetric(minIou),
      maxPaletteDistance: finiteMetric(maxPaletteDistance),
      maxCenterDriftPx: finiteMetric(maxCenterDrift),
      minAreaRatio: finiteMetric(minAreaRatio),
    },
  };
}

async function analyzeFrame(frame: AnimationFrameInput): Promise<FrameAnalysis> {
  const image = sharp(frame.bytes).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const raw = await image.raw().toBuffer();
  const mask = new Uint8Array(width * height);
  let visiblePixels = 0;
  let sumX = 0;
  let sumY = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rawOffset = (y * width + x) * 4;
      const alpha = raw[rawOffset + 3];
      if (alpha <= 20) continue;
      const maskOffset = y * width + x;
      mask[maskOffset] = 1;
      visiblePixels++;
      sumX += x;
      sumY += y;
      sumR += raw[rawOffset];
      sumG += raw[rawOffset + 1];
      sumB += raw[rawOffset + 2];
    }
  }

  return {
    name: frame.name,
    width,
    height,
    mask,
    visiblePixels,
    centerX: visiblePixels > 0 ? sumX / visiblePixels : width / 2,
    centerY: visiblePixels > 0 ? sumY / visiblePixels : height / 2,
    averageRgb: {
      r: visiblePixels > 0 ? sumR / visiblePixels : 0,
      g: visiblePixels > 0 ? sumG / visiblePixels : 0,
      b: visiblePixels > 0 ? sumB / visiblePixels : 0,
    },
  };
}

function computeSimilarities(analyses: FrameAnalysis[]): FrameSimilarity[] {
  const base = analyses[0];
  if (!base) return [];
  return analyses.map((analysis) => {
    const unionLength = Math.min(base.mask.length, analysis.mask.length);
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < unionLength; i++) {
      const a = base.mask[i] === 1;
      const b = analysis.mask[i] === 1;
      if (a && b) intersection++;
      if (a || b) union++;
    }
    return {
      silhouetteIoU: union > 0 ? intersection / union : 0,
      paletteDistance: colorDistance(base.averageRgb, analysis.averageRgb),
      centerDriftPx: Math.max(
        Math.abs(base.centerX - analysis.centerX),
        Math.abs(base.centerY - analysis.centerY)
      ),
      areaRatio: base.visiblePixels > 0
        ? Math.min(base.visiblePixels, analysis.visiblePixels) / Math.max(base.visiblePixels, analysis.visiblePixels)
        : 0,
    };
  });
}

function colorDistance(
  a: FrameAnalysis['averageRgb'],
  b: FrameAnalysis['averageRgb']
): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function thresholdsFor(action: string): {
  minSilhouetteIoU: number;
  maxPaletteDistance: number;
  minAreaRatio: number;
} {
  switch (action) {
    case 'idle':
      return { minSilhouetteIoU: 0.38, maxPaletteDistance: 55, minAreaRatio: 0.75 };
    case 'walk':
      return { minSilhouetteIoU: 0.24, maxPaletteDistance: 70, minAreaRatio: 0.62 };
    case 'attack':
      return { minSilhouetteIoU: 0.18, maxPaletteDistance: 80, minAreaRatio: 0.5 };
    case 'death':
      return { minSilhouetteIoU: 0.12, maxPaletteDistance: 90, minAreaRatio: 0.35 };
    default:
      return { minSilhouetteIoU: 0.22, maxPaletteDistance: 75, minAreaRatio: 0.55 };
  }
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function fmt(value: number): string {
  return finiteMetric(value).toString();
}

function drift(
  a: AssetMetadata['opaqueBounds'],
  b: AssetMetadata['opaqueBounds']
): number {
  const centerAx = a.x + a.w / 2;
  const centerAy = a.y + a.h / 2;
  const centerBx = b.x + b.w / 2;
  const centerBy = b.y + b.h / 2;
  return Math.max(Math.abs(centerAx - centerBx), Math.abs(centerAy - centerBy));
}

function unionBounds(bounds: AssetMetadata['opaqueBounds'][]): AssetMetadata['opaqueBounds'] {
  const visible = bounds.filter((bound) => bound.w > 0 && bound.h > 0);
  if (visible.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...visible.map((bound) => bound.x));
  const minY = Math.min(...visible.map((bound) => bound.y));
  const maxX = Math.max(...visible.map((bound) => bound.x + bound.w));
  const maxY = Math.max(...visible.map((bound) => bound.y + bound.h));
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}
