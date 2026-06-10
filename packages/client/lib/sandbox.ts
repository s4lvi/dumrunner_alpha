// Sandbox WebSocket connection helper for the editor. Wraps the
// boilerplate of fetching a sandbox URL+token from
// /api/editor/sandbox/url, opening a WS, doing the auth
// handshake, and exposing typed commands. Server messages stream
// out via an onMessage callback for the consumer to render.
//
// Same wire protocol as the live game; the only difference is
// the auth token's `sandbox: true` flag flips the server into
// SandboxWorld mode.
//
// Lifecycle: open() resolves once the WS is authed. close() tears
// it down. The handle exposes only the messages the sandbox
// supports today (spawn, clear, input). More commands land here
// as Phase B grows.

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@dumrunner/shared';

export type SandboxConnectionStatus =
  | 'idle'
  | 'fetching_token'
  | 'connecting'
  | 'connected'
  | 'closed'
  | 'error';

export type SandboxHandle = {
  status(): SandboxConnectionStatus;
  spawnEnemy(kind: string, x: number, y: number): void;
  clear(scope?: 'enemies' | 'props' | 'all'): void;
  setLoadout(kind: 'creative' | 'unarmed'): void;
  regenFloor(args: {
    biome: string;
    cycle: number;
    floorIndex: number;
    worldSeed: number;
  }): void;
  // Replace the sandbox scene with a hand-authored SectorScene
  // (the editor's playtest path). Server rasterises onto a tile
  // grid and rebuilds the scene around it.
  loadAuthoredScene(scene: unknown): void;
  // Raw WS send. Live-game input / fire messages go straight
  // through this — no typed shim per message kind. Every field
  // added to the protocol is one diff away from working in the
  // sandbox; no parallel typed wrapper to drift.
  send(msg: ClientMessage): void;
  close(): void;
};

export type SandboxOpenOptions = {
  onMessage: (msg: ServerMessage) => void;
  onStatusChange?: (status: SandboxConnectionStatus) => void;
  onError?: (err: Error) => void;
};

// Opens a sandbox connection. Resolves when the auth handshake is
// accepted (the server sends a 'welcome' on success). Rejects on
// fetch failure, WS connect failure, or auth rejection.
export async function openSandbox(
  options: SandboxOpenOptions,
): Promise<SandboxHandle> {
  let status: SandboxConnectionStatus = 'idle';
  const setStatus = (s: SandboxConnectionStatus): void => {
    status = s;
    options.onStatusChange?.(s);
  };

  setStatus('fetching_token');
  const tokenResp = await fetch('/api/editor/sandbox/url', { method: 'POST' });
  if (!tokenResp.ok) {
    setStatus('error');
    throw new Error(`sandbox_token_fetch_${tokenResp.status}`);
  }
  const { wsUrl, token } = (await tokenResp.json()) as {
    wsUrl: string;
    token: string;
  };

  setStatus('connecting');
  const ws = new WebSocket(wsUrl);
  let welcomed = false;

  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      ws.send(
        JSON.stringify({
          type: 'auth',
          token,
          protocolVersion: PROTOCOL_VERSION,
        } as ClientMessage),
      );
    };
    const onMessage = (ev: MessageEvent): void => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (!welcomed) {
        if (msg.type === 'welcome') {
          welcomed = true;
          setStatus('connected');
          // Hand off subsequent messages to the caller.
          ws.onmessage = (e) => {
            try {
              const m = JSON.parse(e.data) as ServerMessage;
              options.onMessage(m);
            } catch {
              // ignore malformed
            }
          };
          options.onMessage(msg);
          resolve();
          return;
        }
        if (msg.type === 'error') {
          setStatus('error');
          reject(new Error(msg.message));
          ws.close();
          return;
        }
      }
      // Pre-welcome messages other than welcome / error are ignored;
      // they shouldn't happen with the current server.
    };
    const onError = (): void => {
      setStatus('error');
      reject(new Error('sandbox_ws_error'));
    };
    const onClose = (): void => {
      setStatus('closed');
      if (!welcomed) reject(new Error('sandbox_closed_before_welcome'));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });

  const send = (msg: ClientMessage): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  return {
    status: () => status,
    spawnEnemy: (kind, x, y) => {
      send({ type: 'sandbox_spawn_enemy', kind, x, y });
    },
    clear: (scope) => {
      send({ type: 'sandbox_clear', scope });
    },
    setLoadout: (kind) => {
      send({ type: 'sandbox_set_loadout', kind });
    },
    regenFloor: ({ biome, cycle, floorIndex, worldSeed }) => {
      send({
        type: 'sandbox_regen_floor',
        biome,
        cycle,
        floorIndex,
        worldSeed,
      });
    },
    loadAuthoredScene: (scene) => {
      send({ type: 'sandbox_load_authored_scene', scene });
    },
    send,
    close: () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      setStatus('closed');
      options.onError?.(new Error('sandbox_closed'));
    },
  };
}
