'use client';

// Discord Activity entry point. The Developer Portal's URL Mappings
// route the iframe's `/` to this page (or set the Activity launch
// URL directly to /discord). Flow:
//
//   1. Boot the embedded SDK + ready().
//   2. authorize({scope:['identify']}) → code.
//   3. POST code to /api/auth/discord/exchange (sets Supabase session
//      cookies, returns access_token + displayName).
//   4. SDK.commands.authenticate({access_token}) so the SDK is fully
//      bound for this user.
//   5. POST instance_id to /api/discord/instance → server_id.
//   6. router.replace(`/play/${server_id}`).

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDiscordSdk } from '@/lib/discord/sdk';
import { publicEnv } from '@/lib/env';

type Phase = 'boot' | 'auth' | 'binding' | 'launching' | 'error';

export default function DiscordActivityPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('boot');
  const [status, setStatus] = useState('Connecting to Discord…');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fail = (msg: string) => {
      if (cancelled) return;
      console.error('[discord/activity]', msg);
      setErrorMsg(msg);
      setPhase('error');
    };

    (async () => {
      const clientId = publicEnv.discordClientId;
      if (!clientId) {
        fail('Discord client ID not configured.');
        return;
      }
      try {
        setPhase('boot');
        setStatus('Connecting to Discord…');
        const sdk = await getDiscordSdk(clientId);
        if (cancelled) return;

        setPhase('auth');
        setStatus('Authorising…');
        const { code } = await sdk.commands.authorize({
          client_id: clientId,
          response_type: 'code',
          state: crypto.randomUUID(),
          prompt: 'none',
          scope: ['identify'],
        });
        if (cancelled) return;

        const exchangeRes = await fetch('/api/auth/discord/exchange', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        if (!exchangeRes.ok) {
          const detail = await exchangeRes.json().catch(() => ({}));
          fail(`Sign-in failed: ${(detail as { error?: string }).error ?? exchangeRes.statusText}`);
          return;
        }
        const exchangeJson = (await exchangeRes.json()) as { accessToken: string };
        if (cancelled) return;

        await sdk.commands.authenticate({ access_token: exchangeJson.accessToken });
        if (cancelled) return;

        setPhase('binding');
        setStatus('Setting up the world…');
        const instanceId = sdk.instanceId;
        if (!instanceId) {
          fail('Discord SDK did not provide an instance id.');
          return;
        }
        const instanceRes = await fetch('/api/discord/instance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instance_id: instanceId }),
        });
        if (!instanceRes.ok) {
          const detail = await instanceRes.json().catch(() => ({}));
          fail(`World setup failed: ${(detail as { error?: string }).error ?? instanceRes.statusText}`);
          return;
        }
        const { server_id } = (await instanceRes.json()) as { server_id: string };
        if (cancelled) return;

        setPhase('launching');
        setStatus('Launching…');
        router.replace(`/play/${server_id}`);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Unexpected error.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-[color:var(--bg)] text-zinc-200 px-6">
      <div className="text-center">
        {phase === 'error' ? (
          <>
            <h1 className="text-2xl font-bold mb-2">Couldn't start the Activity</h1>
            <p className="text-zinc-400 max-w-md">{errorMsg ?? 'Unknown error.'}</p>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-zinc-700 border-t-[color:var(--accent)]" />
            <p className="text-zinc-300">{status}</p>
          </>
        )}
      </div>
    </main>
  );
}
