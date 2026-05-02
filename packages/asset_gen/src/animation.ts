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

  const verification = verifyAnimationFrames(request, frames);
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
      })),
    },
    verification,
  };
}

function verifyAnimationFrames(
  request: AssetGenerateRequest,
  frames: AnimationFrameInput[]
): VerificationResult {
  const reasons: string[] = [];
  const maxDrift = request.animation?.maxFrameDriftPx ?? 3;
  const first = frames[0]?.metadata.opaqueBounds;
  if (!first) {
    reasons.push('animation has no frames');
  }

  for (const frame of frames) {
    const bounds = frame.metadata.opaqueBounds;
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
  }

  if (reasons.length > 0) {
    return {
      score: 0.58,
      verdict: 'retry',
      summary: 'Animation sheet failed mechanical frame consistency checks.',
      reasons,
    };
  }

  return {
    score: 0.8,
    verdict: 'pass',
    summary: `Generated ${request.animation?.action ?? 'animation'} cycle passed baseline frame checks.`,
    reasons: [],
  };
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
