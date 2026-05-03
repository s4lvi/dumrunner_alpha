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

// Path prefix the Activity URL Mapping forwards to the game server.
// REQUIRED Developer Portal config (Activities → URL Mappings):
//   Prefix: /game-ws   →   Target: <fly-app-host>
// e.g. dumrunner-alpha-holy-pine-7754.fly.dev. The proxy strips the
// prefix on forward, so the game server still sees `/` upgrades.
export const ACTIVITY_GAME_WS_PREFIX = '/game-ws';

// Inside a Discord Activity, every external WS / fetch must go
// through Discord's proxy origin (`<APP_ID>.discordsays.com`).
// Connecting directly to the Fly host hangs because the iframe
// CSP blocks the upgrade. This rewrites a `wss://<fly-host>/...`
// URL to `wss://<APP_ID>.discordsays.com/game-ws...`. Outside the
// Activity it returns the URL unchanged.
export function rewriteGameWsUrl(originalUrl: string): string {
  if (!isInDiscordActivity()) return originalUrl;
  if (typeof window === 'undefined') return originalUrl;
  const original = new URL(originalUrl);
  const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  // Discord strips the mapping prefix on forward, so we just append
  // the original path under our prefix. `/` becomes `/game-ws`,
  // `/foo` becomes `/game-ws/foo`.
  const tail = original.pathname === '/' ? '' : original.pathname;
  return `${wsScheme}//${host}${ACTIVITY_GAME_WS_PREFIX}${tail}${original.search}`;
}
