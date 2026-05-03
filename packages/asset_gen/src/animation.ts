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

// Cut a horizontal multi-frame sheet into N raw PNG buffers. The caller
// passes each buffer through cleanImage so the existing per-frame
// pipeline (resize-to-fit, anchor, opaqueBounds, transparency check)
// does the per-frame normalisation.
//
// Strategy:
//   1. Find the vertical content band (rows that have any opaque pixel)
//      — the model often pads the top/bottom with empty space, so we
//      crop to the actual subject row before slicing horizontally.
//   2. Within the content band, divide width by frameCount and extract
//      equal columns. cleanImage's inside-fit + centre-anchor absorbs
//      minor placement variance per frame.
export async function sliceSheetIntoFrames(
  sheetBytes: Buffer,
  frameCount: number
): Promise<{ slices: Buffer[] } | { error: string }> {
  const probe = sharp(sheetBytes, { failOn: 'none' }).ensureAlpha();
  const meta = await probe.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return { error: 'sheet has zero size' };
  if (frameCount < 1) return { error: 'frameCount must be >= 1' };

  const raw = await probe.raw().toBuffer();
  const rowOpaque = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (raw[rowOffset + x * 4 + 3] > 20) {
        rowOpaque[y] = 1;
        break;
      }
    }
  }

  let top = 0;
  while (top < height && rowOpaque[top] === 0) top++;
  let bottom = height - 1;
  while (bottom > top && rowOpaque[bottom] === 0) bottom--;
  if (top >= bottom) {
    return { error: 'sheet has no opaque content' };
  }
  const bandTop = top;
  const bandHeight = bottom - top + 1;

  // Equal-width slicing across the FULL width (the model is told to
  // fill the canvas, so there shouldn't be large blank borders left or
  // right; if there are, cleanImage's centre-fit will recover anyway).
  // Per-frame minimum-content sanity check: if a slice has fewer than
  // ~30 opaque pixels the model probably collapsed to a single subject
  // — bail and let the retry loop try again with a corrective prompt.
  const sliceWidth = Math.floor(width / frameCount);
  if (sliceWidth <= 0) return { error: 'slice width is zero' };
  const slices: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    const left = i * sliceWidth;
    const w = i === frameCount - 1 ? width - left : sliceWidth;
    // Step 1: hard column extraction.
    const rawSlice = await sharp(sheetBytes, { failOn: 'none' })
      .ensureAlpha()
      .extract({ left, top: bandTop, width: w, height: bandHeight })
      .png()
      .toBuffer();

    // Step 2: trim transparent edges so the slice is exactly the
    // character's bounding box. Without this, cleanImage's "fit:inside"
    // resize keeps the transparent gutters, and characters drift
    // horizontally between frames depending on where the model placed
    // them in their cell. Trimming first → cleanImage's centre-anchor
    // produces a consistent anchor across frames.
    let trimmed: Buffer;
    try {
      trimmed = await sharp(rawSlice, { failOn: 'none' })
        .trim({ threshold: 8 })
        .png()
        .toBuffer();
    } catch {
      // .trim() throws on a fully-transparent image; treat as empty slice.
      return {
        error: `frame ${i + 1} of ${frameCount} has no opaque content after trim`,
      };
    }

    // Sanity: if the trimmed image is tiny, model likely produced a
    // single subject instead of a strip.
    const trimmedMeta = await sharp(trimmed).metadata();
    const tw = trimmedMeta.width ?? 0;
    const th = trimmedMeta.height ?? 0;
    if (tw < 8 || th < 8) {
      return {
        error: `frame ${i + 1} of ${frameCount} trimmed to ${tw}x${th} — model likely produced a single subject instead of a strip`,
      };
    }
    slices.push(trimmed);
  }
  return { slices };
}

type FrameAnalysis = {
  name: string;
  width: number;
  height: number;
  mask: Uint8Array;
  visiblePixels: number;
  centerX: number;
  centerY: number;
  averageRgb: { r: number; g: number; b: number };
  stdRgb: { r: number; g: number; b: number };
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

  const normalizedFrames = await normalizeFramePalette(frames);
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
    .composite(normalizedFrames.map((frame, index) => ({
      input: frame.bytes,
      left: index * frameWidth,
      top: 0,
    })))
    .png()
    .toBuffer();

  const analyses = await Promise.all(normalizedFrames.map(analyzeFrame));
  const similarities = computeSimilarities(analyses);
  const verification = verifyAnimationFrames(request, normalizedFrames, similarities);
  const bounds = unionBounds(normalizedFrames.map((frame, index) => ({
    ...frame.metadata.opaqueBounds,
    x: frame.metadata.opaqueBounds.x + index * frameWidth,
  })));

  return {
    bytes,
    metadata: {
      width: frameWidth * frames.length,
      height: frameHeight,
      transparent: normalizedFrames.every((frame) => frame.metadata.transparent),
      anchor: normalizedFrames[0]?.metadata.anchor ?? { x: 0.5, y: 0.82 },
      opaqueBounds: bounds,
      averageColors: normalizedFrames.flatMap((frame) => frame.metadata.averageColors).slice(0, 4),
    },
    animation: {
      action: request.animation.action,
      frameCount: normalizedFrames.length,
      frameWidth,
      frameHeight,
      fps: request.animation.fps,
      directionMode: request.animation.directionMode,
      maxFrameDriftPx: request.animation.maxFrameDriftPx,
      frames: normalizedFrames.map((frame, index) => ({
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

async function normalizeFramePalette(frames: AnimationFrameInput[]): Promise<AnimationFrameInput[]> {
  const base = frames[0];
  if (!base) return frames;
  const baseStats = await imageColorStats(base.bytes);
  return Promise.all(frames.map(async (frame, index) => {
    if (index === 0) return frame;
    const stats = await imageColorStats(frame.bytes);
    const adjustedBytes = await matchVisiblePixelsToPalette(frame.bytes, stats, baseStats);
    return {
      ...frame,
      bytes: adjustedBytes,
      metadata: {
        ...frame.metadata,
        averageColors: base.metadata.averageColors,
      },
    };
  }));
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
  return imageColorStats(frame.bytes, frame.name);
}

async function imageColorStats(bytes: Buffer, name = 'frame'): Promise<FrameAnalysis> {
  const image = sharp(bytes).ensureAlpha();
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
  let sumR2 = 0;
  let sumG2 = 0;
  let sumB2 = 0;

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
      sumR2 += raw[rawOffset] * raw[rawOffset];
      sumG2 += raw[rawOffset + 1] * raw[rawOffset + 1];
      sumB2 += raw[rawOffset + 2] * raw[rawOffset + 2];
    }
  }

  const averageRgb = {
    r: visiblePixels > 0 ? sumR / visiblePixels : 0,
    g: visiblePixels > 0 ? sumG / visiblePixels : 0,
    b: visiblePixels > 0 ? sumB / visiblePixels : 0,
  };

  return {
    name,
    width,
    height,
    mask,
    visiblePixels,
    centerX: visiblePixels > 0 ? sumX / visiblePixels : width / 2,
    centerY: visiblePixels > 0 ? sumY / visiblePixels : height / 2,
    averageRgb,
    stdRgb: {
      r: visiblePixels > 0 ? stdFromMoments(sumR2, averageRgb.r, visiblePixels) : 0,
      g: visiblePixels > 0 ? stdFromMoments(sumG2, averageRgb.g, visiblePixels) : 0,
      b: visiblePixels > 0 ? stdFromMoments(sumB2, averageRgb.b, visiblePixels) : 0,
    },
  };
}

async function matchVisiblePixelsToPalette(
  bytes: Buffer,
  source: FrameAnalysis,
  target: FrameAnalysis
): Promise<Buffer> {
  if (source.visiblePixels === 0 || target.visiblePixels === 0) return bytes;

  const image = sharp(bytes).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const raw = await image.raw().toBuffer();
  const strength = 0.92;
  const rScale = channelScale(source.stdRgb.r, target.stdRgb.r);
  const gScale = channelScale(source.stdRgb.g, target.stdRgb.g);
  const bScale = channelScale(source.stdRgb.b, target.stdRgb.b);

  for (let offset = 0; offset < raw.length; offset += 4) {
    const alpha = raw[offset + 3];
    if (alpha <= 20) continue;
    raw[offset] = transferChannel(raw[offset], source.averageRgb.r, target.averageRgb.r, rScale, strength);
    raw[offset + 1] = transferChannel(raw[offset + 1], source.averageRgb.g, target.averageRgb.g, gScale, strength);
    raw[offset + 2] = transferChannel(raw[offset + 2], source.averageRgb.b, target.averageRgb.b, bScale, strength);
  }

  return sharp(raw, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
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
      return { minSilhouetteIoU: 0.38, maxPaletteDistance: 30, minAreaRatio: 0.75 };
    case 'walk':
      return { minSilhouetteIoU: 0.24, maxPaletteDistance: 35, minAreaRatio: 0.62 };
    case 'attack':
      return { minSilhouetteIoU: 0.18, maxPaletteDistance: 45, minAreaRatio: 0.5 };
    case 'death':
      return { minSilhouetteIoU: 0.12, maxPaletteDistance: 55, minAreaRatio: 0.35 };
    default:
      return { minSilhouetteIoU: 0.22, maxPaletteDistance: 40, minAreaRatio: 0.55 };
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

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function channelScale(sourceStd: number, targetStd: number): number {
  if (sourceStd < 1 || targetStd < 1) return 1;
  return Math.max(0.6, Math.min(1.6, targetStd / sourceStd));
}

function transferChannel(
  value: number,
  sourceMean: number,
  targetMean: number,
  scale: number,
  strength: number
): number {
  const matched = (value - sourceMean) * scale + targetMean;
  return clampByte(value + (matched - value) * strength);
}

function stdFromMoments(sumSq: number, mean: number, count: number): number {
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean));
}
