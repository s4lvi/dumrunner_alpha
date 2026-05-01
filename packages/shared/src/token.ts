// Short-lived signed token used for the websocket join handshake.
//
// Flow:
//   1. Authenticated client POSTs /api/servers/:id/join.
//   2. Next.js API route mints a JoinToken (signed with JOIN_TOKEN_SECRET) and
//      returns it along with the websocket URL.
//   3. Client connects to the ws URL, sends { type: 'auth', token } as first message.
//   4. Game server verifies the token using the same secret and accepts the connection.
//
// The signature is HMAC-SHA256 over the JSON-encoded payload. We use Node's built-in
// `crypto` (works in Next.js API routes and the Node ws server). The browser never
// needs to verify or mint these — it just relays the opaque token string.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type JoinTokenPayload = {
  accountId: string;
  characterId: string;
  serverId: string;
  displayName: string;
  // Unix seconds; tokens are short-lived (default 60s issuer side).
  exp: number;
};

const TOKEN_VERSION = 'v1';

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

export function signJoinToken(payload: JoinTokenPayload, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64urlEncode(
    createHmac('sha256', secret).update(`${TOKEN_VERSION}.${body}`).digest()
  );
  return `${TOKEN_VERSION}.${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: JoinTokenPayload }
  | { ok: false; reason: string };

export function verifyJoinToken(token: string, secret: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, body, sig] = parts;
  if (version !== TOKEN_VERSION) return { ok: false, reason: 'bad_version' };

  const expected = createHmac('sha256', secret)
    .update(`${version}.${body}`)
    .digest();
  const actual = b64urlDecode(sig);
  if (expected.length !== actual.length) return { ok: false, reason: 'bad_sig' };
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'bad_sig' };

  let payload: JoinTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

export const DEFAULT_TOKEN_TTL_SECONDS = 60;
