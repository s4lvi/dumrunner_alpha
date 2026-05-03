'use client';

// Lazy-loaded Discord embedded app SDK wrapper. The SDK is only
// useful when the page is hosted inside a Discord Activity iframe;
// for the regular web app it must never load (no `frame_id` query
// param means we can short-circuit).
//
// Dynamic import keeps the SDK out of the public bundle entry — only
// pages that explicitly call `getDiscordSdk()` pull it in.

import type { DiscordSDK } from '@discord/embedded-app-sdk';

let sdkPromise: Promise<DiscordSDK> | null = null;

export function isInDiscordActivity(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('frame_id')) return true;
    if (window.location.hostname.endsWith('.discordsays.com')) return true;
  } catch {
    // ignore
  }
  return false;
}

export async function getDiscordSdk(clientId: string): Promise<DiscordSDK> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const mod = await import('@discord/embedded-app-sdk');
      const sdk = new mod.DiscordSDK(clientId);
      await sdk.ready();
      return sdk;
    })();
  }
  return sdkPromise;
}
