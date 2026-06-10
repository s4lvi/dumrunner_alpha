'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { loginAction, type LoginState } from './actions';
import { discordEnabledClient } from '@/lib/env';
import { DiscordSignInButton } from '@/app/components/DiscordSignInButton';

const DISCORD_ERROR_MESSAGES: Record<string, string> = {
  state_mismatch: 'Discord sign-in expired or was tampered with. Try again.',
  exchange_failed: "Discord didn't accept the auth code. Try again.",
  provision_failed: 'Could not provision your Discord account. Try again or contact support.',
  sign_in_failed: 'Discord sign-in succeeded but session creation failed.',
};

function LoginForm() {
  const params = useSearchParams();
  const justConfirmed = params.get('confirm') === '1';
  const justReset = params.get('reset') === '1';
  const discordError = params.get('discord_error');
  const discordEnabled = discordEnabledClient();

  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    loginAction,
    null
  );

  return (
    <div className="w-full max-w-md bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-8">
      <h1 className="text-3xl font-bold mb-6">Sign in</h1>

      {justConfirmed && (
        <div className="mb-4 text-sm text-emerald-400 border border-emerald-700/40 bg-emerald-900/20 rounded px-3 py-2">
          Account created. If your project requires email confirmation, check your inbox before signing in.
        </div>
      )}

      {justReset && (
        <div className="mb-4 text-sm text-emerald-400 border border-emerald-700/40 bg-emerald-900/20 rounded px-3 py-2">
          Password updated. Sign in with the new one.
        </div>
      )}

      {discordError && (
        <div className="mb-4 text-sm text-red-400 border border-red-700/40 bg-red-900/20 rounded px-3 py-2">
          {DISCORD_ERROR_MESSAGES[discordError] ?? 'Discord sign-in failed.'}
        </div>
      )}

      {discordEnabled && <DiscordSignInButton />}

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

      <div className="mt-6 flex justify-between text-sm text-zinc-400">
        <Link href="/register" className="hover:text-zinc-200">
          Create an account
        </Link>
        <Link href="/auth/forgot" className="hover:text-zinc-200">
          Forgot password?
        </Link>
      </div>
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
