import { createHash, randomUUID } from 'node:crypto';
import { ASSET_API_VERSION, type AssetGenerateRequest } from './schemas.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function stableJson(value: Json): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
    .join(',')}}`;
}

export function makeCacheKey(request: AssetGenerateRequest): string {
  const normalized = stableJson({
    apiVersion: ASSET_API_VERSION,
    request: request as unknown as Json,
  });
  return createHash('sha256').update(normalized).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
