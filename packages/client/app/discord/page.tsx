'use client';

// Discord Activity entry point.
//
// Flow:
//   1. Boot SDK + ready().
//   2. authorize({scope:['identify']}) → code.
//   3. POST code to /api/auth/discord/exchange (Supabase session +
//      Discord access token).
//   4. SDK.commands.authenticate({access_token}).
//   5. GET /api/discord/instance?instance_id=X to learn whether this
//      call already has a server.
//   6. Render setup form:
//        - first user: server settings + display name
//        - joiner:     display name only (read-only room summary)
//   7. POST → server_id → router.replace(/play/<id>).

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDiscordSdk } from '@/lib/discord/sdk';
import { publicEnv } from '@/lib/env';

type ExistingServerSummary = {
  name: string;
  max_slots: number;
  world_seed: number | null;
  day_duration_sec: number | null;
  days_per_cycle: number | null;
  drop_items_on_death: boolean | null;
  is_owner: boolean;
};

type Phase =
  | { kind: 'boot'; status: string }
  | { kind: 'setup'; instanceId: string; existing: ExistingServerSummary | null;
      defaultDisplayName: string }
  | { kind: 'launching'; status: string }
  | { kind: 'error'; message: string };

export default function DiscordActivityPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({
    kind: 'boot',
    status: 'Connecting to Discord…',
  });

  useEffect(() => {
    let cancelled = false;
    const fail = (msg: string) => {
      if (cancelled) return;
      console.error('[discord/activity]', msg);
      setPhase({ kind: 'error', message: msg });
    };
    const setStatus = (status: string) => {
      if (cancelled) return;
      setPhase((prev) =>
        prev.kind === 'boot' ? { ...prev, status } : prev
      );
    };

    // Surface enough context that DevTools alone is sufficient to
    // diagnose a stalled Activity launch. Logged once on mount.
    console.log('[discord/activity] boot', {
      hostname: window.location.hostname,
      search: window.location.search,
      hasFrameId: new URLSearchParams(window.location.search).has('frame_id'),
      clientIdConfigured: Boolean(publicEnv.discordClientId),
    });

    (async () => {
      const clientId = publicEnv.discordClientId;
      if (!clientId) {
        fail('Discord client ID not configured.');
        return;
      }
      // If the URL has no `frame_id`, the SDK constructor will throw
      // immediately with a confusing error. Detect and surface a
      // clearer message — most common cause is hitting /discord in a
      // browser instead of through the Activity.
      const hasFrameId = new URLSearchParams(window.location.search).has(
        'frame_id'
      );
      if (!hasFrameId) {
        fail(
          'No Discord Activity context. This page is meant to load inside a Discord call. ' +
            'If you reached it in a browser, the deploy is alive — return to Discord and launch the Activity from there.'
        );
        return;
      }
      try {
        setStatus('Connecting to Discord…');
        const sdk = await getDiscordSdk(clientId);
        if (cancelled) return;

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
        const exchangeJson = (await exchangeRes.json()) as {
          accessToken: string;
          displayName: string;
        };
        if (cancelled) return;

        await sdk.commands.authenticate({ access_token: exchangeJson.accessToken });
        if (cancelled) return;

        setStatus('Looking up the room…');
        const instanceId = sdk.instanceId;
        if (!instanceId) {
          fail('Discord SDK did not provide an instance id.');
          return;
        }
        const lookup = await fetch(
          `/api/discord/instance?instance_id=${encodeURIComponent(instanceId)}`,
          { method: 'GET', cache: 'no-store' }
        );
        if (!lookup.ok) {
          const detail = await lookup.json().catch(() => ({}));
          fail(`Lookup failed: ${(detail as { error?: string }).error ?? lookup.statusText}`);
          return;
        }
        const lookupJson = (await lookup.json()) as {
          server_id: string | null;
          server: ExistingServerSummary | null;
          display_name: string | null;
        };
        if (cancelled) return;

        setPhase({
          kind: 'setup',
          instanceId,
          existing: lookupJson.server,
          defaultDisplayName:
            lookupJson.display_name ?? exchangeJson.displayName ?? '',
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Unexpected error.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === 'error') {
    return (
      <Centered>
        <h1 className="text-2xl font-bold mb-2">Couldn&apos;t start the Activity</h1>
        <p className="text-zinc-400 max-w-md">{phase.message}</p>
      </Centered>
    );
  }

  if (phase.kind === 'launching') {
    return (
      <Centered>
        <Spinner />
        <p className="text-zinc-300 mt-4">{phase.status}</p>
      </Centered>
    );
  }

  if (phase.kind === 'boot') {
    return (
      <Centered>
        <Spinner />
        <p className="text-zinc-300 mt-4">{phase.status}</p>
      </Centered>
    );
  }

  // phase.kind === 'setup'
  return (
    <SetupForm
      instanceId={phase.instanceId}
      existing={phase.existing}
      defaultDisplayName={phase.defaultDisplayName}
      onSubmitting={(status) => setPhase({ kind: 'launching', status })}
      onError={(msg) => setPhase({ kind: 'error', message: msg })}
      onSuccess={(serverId) => {
        router.replace(`/play/${serverId}`);
      }}
    />
  );
}

function SetupForm({
  instanceId,
  existing,
  defaultDisplayName,
  onSubmitting,
  onError,
  onSuccess,
}: {
  instanceId: string;
  existing: ExistingServerSummary | null;
  defaultDisplayName: string;
  onSubmitting: (status: string) => void;
  onError: (message: string) => void;
  onSuccess: (serverId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const isFirstUser = existing === null;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setFormError(null);

    const fd = new FormData(e.currentTarget);
    const displayName = String(fd.get('display_name') ?? '').trim();
    if (displayName.length < 2 || displayName.length > 32) {
      setFormError('Display name must be 2–32 characters.');
      return;
    }

    const payload: Record<string, unknown> = {
      instance_id: instanceId,
      display_name: displayName,
    };

    if (isFirstUser) {
      const name = String(fd.get('name') ?? '').trim();
      const max_slots = Number(fd.get('max_slots') ?? 8);
      const day_duration_sec = Number(fd.get('day_duration_sec') ?? 300);
      const days_per_cycle = Number(fd.get('days_per_cycle') ?? 3);
      const seedRaw = String(fd.get('world_seed') ?? '').trim();
      const drop_items_on_death =
        String(fd.get('drop_items_on_death') ?? 'on') === 'on';

      if (name.length < 1 || name.length > 64) {
        setFormError('Server name must be 1–64 characters.');
        return;
      }
      if (!Number.isInteger(max_slots) || max_slots < 5 || max_slots > 10) {
        setFormError('Max slots must be 5–10.');
        return;
      }
      if (
        !Number.isInteger(day_duration_sec) ||
        day_duration_sec < 30 ||
        day_duration_sec > 3600
      ) {
        setFormError('Day length must be 30–3600 seconds.');
        return;
      }
      if (
        !Number.isInteger(days_per_cycle) ||
        days_per_cycle < 1 ||
        days_per_cycle > 7
      ) {
        setFormError('Days per perihelion must be 1–7.');
        return;
      }
      let world_seed: number | null = null;
      if (seedRaw.length > 0) {
        const n = Number(seedRaw);
        if (!Number.isFinite(n)) {
          setFormError('World seed must be a number.');
          return;
        }
        world_seed = Math.trunc(n);
      }
      payload.server = {
        name,
        max_slots,
        world_seed,
        day_duration_sec,
        days_per_cycle,
        drop_items_on_death,
      };
    }

    setPending(true);
    onSubmitting(isFirstUser ? 'Creating the world…' : 'Joining…');
    try {
      const res = await fetch('/api/discord/instance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const code = (detail as { error?: string }).error ?? res.statusText;
        setPending(false);
        onError(`Setup failed: ${code}`);
        return;
      }
      const json = (await res.json()) as { server_id: string };
      onSuccess(json.server_id);
    } catch (err) {
      setPending(false);
      onError(err instanceof Error ? err.message : 'Unexpected error.');
    }
  };

  return (
    <main className="min-h-screen px-6 py-10 flex items-start sm:items-center justify-center bg-[color:var(--bg)] text-zinc-200">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-5 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-6"
      >
        <header>
          <h1 className="text-2xl font-bold">
            {isFirstUser ? 'Set up the world' : 'Join the world'}
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            {isFirstUser
              ? 'You’re the first one in this call. Configure the world, then enter.'
              : `Joining ${existing?.name ?? 'this room'}.`}
          </p>
        </header>

        <Field
          label="Display name"
          name="display_name"
          type="text"
          minLength={2}
          maxLength={32}
          defaultValue={defaultDisplayName}
          required
          autoComplete="off"
        />

        {isFirstUser ? (
          <>
            <Field
              label="Server name"
              name="name"
              type="text"
              required
              maxLength={64}
              defaultValue={
                defaultDisplayName ? `${defaultDisplayName}'s server` : ''
              }
              placeholder="The Sunken Foundry"
            />
            <Field
              label="Max player slots (5–10)"
              name="max_slots"
              type="number"
              min={5}
              max={10}
              defaultValue={8}
              required
            />
            <Field
              label="World seed (optional)"
              name="world_seed"
              type="number"
              placeholder="Leave blank for random"
            />
            <div className="pt-2 border-t border-[color:var(--panel-border)]">
              <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
                World tuning
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Day length (sec)"
                  name="day_duration_sec"
                  type="number"
                  min={30}
                  max={3600}
                  defaultValue={300}
                  required
                />
                <Field
                  label="Days per perihelion"
                  name="days_per_cycle"
                  type="number"
                  min={1}
                  max={7}
                  defaultValue={3}
                  required
                />
              </div>
              <label className="flex items-center gap-2 mt-3 text-sm">
                <input type="checkbox" name="drop_items_on_death" defaultChecked />
                <span>Drop bag contents on death</span>
              </label>
            </div>
          </>
        ) : (
          <RoomSummary existing={existing!} />
        )}

        {formError && <p className="text-sm text-red-400">{formError}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full py-2.5 rounded bg-[color:var(--accent)] text-black font-semibold disabled:opacity-50"
        >
          {pending
            ? isFirstUser
              ? 'Creating…'
              : 'Joining…'
            : isFirstUser
              ? 'Create and enter'
              : 'Enter'}
        </button>
      </form>
    </main>
  );
}

function RoomSummary({ existing }: { existing: ExistingServerSummary }) {
  const items: Array<[string, string]> = [
    ['Name', existing.name],
    ['Max slots', String(existing.max_slots)],
  ];
  if (existing.day_duration_sec) {
    items.push(['Day length', `${existing.day_duration_sec}s`]);
  }
  if (existing.days_per_cycle) {
    items.push(['Days / perihelion', String(existing.days_per_cycle)]);
  }
  if (existing.drop_items_on_death !== null) {
    items.push([
      'Drop on death',
      existing.drop_items_on_death ? 'on' : 'off',
    ]);
  }
  return (
    <div className="text-sm bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-3 space-y-1">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <span className="text-zinc-500">{k}</span>
          <span className="text-zinc-300">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  ...rest
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="block text-sm text-zinc-400 mb-1">{label}</span>
      <input
        {...rest}
        className="w-full bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)]"
      />
    </label>
  );
}

function Spinner() {
  return (
    <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-zinc-700 border-t-[color:var(--accent)]" />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[color:var(--bg)] text-zinc-200 px-6">
      <div className="text-center">{children}</div>
    </main>
  );
}
