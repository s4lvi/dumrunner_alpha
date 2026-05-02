import sharp from 'sharp';
import type { AssetGenerateRequest, AssetMetadata } from './schemas.js';
import type { GeneratedImage } from './providers/types.js';

export type CleanedAsset = {
  bytes: Buffer;
  metadata: AssetMetadata;
};

export async function cleanImage(
  request: AssetGenerateRequest,
  generated: GeneratedImage
): Promise<CleanedAsset> {
  const source = sharp(generated.bytes, { failOn: 'none' }).rotate();
  const sourceMetadata = await source.metadata();
  const inputHadAlpha = sourceMetadata.hasAlpha === true;
  const safeMargin = request.constraints.safeMarginPx;
  const innerSize = Math.max(1, request.size - safeMargin * 2);
  const resized = await source
    .clone()
    .ensureAlpha()
    .resize({
      width: innerSize,
      height: innerSize,
      fit: 'inside',
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();
  const resizedMetadata = await sharp(resized).metadata();
  const resizedWidth = resizedMetadata.width ?? innerSize;
  const resizedHeight = resizedMetadata.height ?? innerSize;
  const top = topForAnchor(request, resizedHeight, safeMargin);
  const left = Math.floor((request.size - resizedWidth) / 2);
  const bytes = await sharp({
    create: {
      width: request.size,
      height: request.size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer();

  const pixelStats = await readPixels(bytes);
  const anchor = anchorPoint(request.constraints.anchor);

  return {
    bytes,
    metadata: {
      width: request.size,
      height: request.size,
      transparent: inputHadAlpha && pixelStats.opaqueBounds.w < request.size && pixelStats.opaqueBounds.h < request.size,
      anchor,
      opaqueBounds: pixelStats.opaqueBounds,
      averageColors: pixelStats.averageColors.length > 0
        ? pixelStats.averageColors
        : request.visualBrief.colors.slice(0, 3),
    },
  };
}

async function readPixels(bytes: Buffer): Promise<{
  opaqueBounds: AssetMetadata['opaqueBounds'];
  averageColors: string[];
}> {
  const image = sharp(bytes).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const raw = await image.raw().toBuffer();
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const alpha = raw[offset + 3];
      if (alpha <= 10) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      r += raw[offset];
      g += raw[offset + 1];
      b += raw[offset + 2];
      count++;
    }
  }

  if (count === 0) {
    return {
      opaqueBounds: { x: 0, y: 0, w: 0, h: 0 },
      averageColors: [],
    };
  }

  return {
    opaqueBounds: {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
    },
    averageColors: [toHex(Math.round(r / count), Math.round(g / count), Math.round(b / count))],
  };
}

function topForAnchor(
  request: AssetGenerateRequest,
  resizedHeight: number,
  safeMargin: number
): number {
  if (request.constraints.anchor === 'center_bottom') {
    return Math.max(0, request.size - safeMargin - resizedHeight);
  }
  if (request.constraints.anchor === 'top_left') {
    return safeMargin;
  }
  return Math.floor((request.size - resizedHeight) / 2);
}

function anchorPoint(anchor: AssetGenerateRequest['constraints']['anchor']): { x: number; y: number } {
  switch (anchor) {
    case 'center':
      return { x: 0.5, y: 0.5 };
    case 'center_bottom':
      return { x: 0.5, y: 0.82 };
    case 'top_left':
      return { x: 0, y: 0 };
  }
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
