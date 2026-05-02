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
  const dimensions = readImageDimensions(generated.bytes) ?? {
    width: request.size,
    height: request.size,
  };
  const anchor = anchorPoint(request.constraints.anchor);

  return {
    bytes: generated.bytes,
    metadata: {
      width: dimensions.width,
      height: dimensions.height,
      transparent: false,
      anchor,
      opaqueBounds: {
        x: request.constraints.safeMarginPx,
        y: request.constraints.safeMarginPx,
        w: Math.max(1, request.size - request.constraints.safeMarginPx * 2),
        h: Math.max(1, request.size - request.constraints.safeMarginPx * 2),
      },
      averageColors: request.visualBrief.colors.slice(0, 3),
    },
  };
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

function readImageDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }

  return null;
}
