'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { loginAction, type LoginState } from './actions';
import { discordEnabledClient } from '@/lib/env';

const DISCORD_ERROR_MESSAGES: Record<string, string> = {
  state_mismatch: 'Discord sign-in expired or was tampered with. Try again.',
  exchange_failed: "Discord didn't accept the auth code. Try again.",
  provision_failed: 'Could not provision your Discord account. Try again or contact support.',
  sign_in_failed: 'Discord sign-in succeeded but session creation failed.',
};

function LoginForm() {
  const params = useSearchParams();
  const justConfirmed = params.get('confirm') === '1';
  const discordError = params.get('discord_error');
  const discordEnabled = discordEnabledClient();

  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    loginAction,
    null
  );

  return (
    <div className="w-full max-w-md bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-8">
      <h1 className="text-3xl font-bold mb-1">Sign in</h1>
      <p className="text-zinc-400 text-sm mb-6">Welcome back, runner.</p>

      {justConfirmed && (
        <div className="mb-4 text-sm text-emerald-400 border border-emerald-700/40 bg-emerald-900/20 rounded px-3 py-2">
          Account created. If your project requires email confirmation, check your inbox before signing in.
        </div>
      )}

      {discordError && (
        <div className="mb-4 text-sm text-red-400 border border-red-700/40 bg-red-900/20 rounded px-3 py-2">
          {DISCORD_ERROR_MESSAGES[discordError] ?? 'Discord sign-in failed.'}
        </div>
      )}

      {discordEnabled && (
        <>
          <a
            href="/api/auth/discord/start"
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded bg-[#5865F2] text-white font-semibold hover:bg-[#4752c4] transition-colors"
          >
            <svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor" aria-hidden="true">
              <path d="M60.1 4.9A58.6 58.6 0 0 0 45.6.5a.2.2 0 0 0-.2.1 40.6 40.6 0 0 0-1.8 3.7 54.1 54.1 0 0 0-16.3 0A37.3 37.3 0 0 0 25.4.6a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.7 5a.2.2 0 0 0-.1.1C1.6 18.7-.9 32 .3 45.2c0 .1.1.1.2.2a59 59 0 0 0 17.8 9 .2.2 0 0 0 .3-.1c1.4-1.9 2.6-3.9 3.7-6 0-.1 0-.2-.1-.3a39 39 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.8a.2.2 0 0 1 .2 0 42.2 42.2 0 0 0 35.7 0 .2.2 0 0 1 .2 0l1.1.8a.2.2 0 0 1 0 .4 36.6 36.6 0 0 1-5.5 2.6.2.2 0 0 0-.1.3c1.1 2.1 2.3 4.1 3.7 6 0 .1.2.2.3.1a58.8 58.8 0 0 0 17.8-9c.1 0 .2-.1.2-.2 1.5-15.3-2.4-28.4-10.4-40.2a.2.2 0 0 0-.1-.1ZM23.7 37.2c-3.5 0-6.4-3.2-6.4-7.1 0-4 2.8-7.2 6.4-7.2 3.6 0 6.5 3.2 6.4 7.2 0 4-2.8 7.1-6.4 7.1Zm23.6 0c-3.5 0-6.4-3.2-6.4-7.1 0-4 2.8-7.2 6.4-7.2 3.6 0 6.5 3.2 6.4 7.2 0 4-2.8 7.1-6.4 7.1Z"/>
            </svg>
            Continue with Discord
          </a>
          <div className="my-4 flex items-center gap-3 text-xs text-zinc-500">
            <div className="flex-1 h-px bg-[color:var(--panel-border)]" />
            or
            <div className="flex-1 h-px bg-[color:var(--panel-border)]" />
          </div>
        </>
      )}

      <form action={formAction} className="space-y-4">
        <label className="block">
          <span className="block text-sm text-zinc-400 mb-1">Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            className="w-full bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)]"
          />
        </label>
        <label className="block">
          <span className="block text-sm text-zinc-400 mb-1">Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            className="w-full bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)]"
          />
        </label>

        {state?.error && (
          <p className="text-sm text-red-400">{state.error}</p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full py-2.5 rounded bg-[color:var(--accent)] text-black font-semibold disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-sm text-zinc-400">
        New here? <Link href="/register">Create an account</Link>
      </p>
      <p className="mt-4 text-xs text-zinc-500">
        By signing in you agree to our{' '}
        <Link href="/terms" className="underline">Terms of Service</Link> and{' '}
        <Link href="/privacy" className="underline">Privacy Policy</Link>.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
