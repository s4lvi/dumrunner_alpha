'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { registerAction, type RegisterState } from './actions';
import { discordEnabledClient } from '@/lib/env';
import { DiscordSignInButton } from '@/app/components/DiscordSignInButton';

export default function RegisterPage() {
  const [state, formAction, pending] = useActionState<RegisterState, FormData>(
    registerAction,
    null
  );
  const discordEnabled = discordEnabledClient();

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-8">
        <h1 className="text-3xl font-bold mb-6">Create account</h1>

        {discordEnabled && <DiscordSignInButton />}

        <form action={formAction} className="space-y-4">
          <Field label="Display name" name="display_name" type="text" autoComplete="username" required />
          <Field label="Email" name="email" type="email" autoComplete="email" required />
          <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={8} />

          {state?.error && (
            <p className="text-sm text-red-400">{state.error}</p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full py-2.5 rounded bg-[color:var(--accent)] text-black font-semibold disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-sm text-zinc-400">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
        <p className="mt-4 text-xs text-zinc-500">
          By creating an account you agree to our{' '}
          <Link href="/terms" className="underline">Terms of Service</Link> and{' '}
          <Link href="/privacy" className="underline">Privacy Policy</Link>.
        </p>
      </div>
    </main>
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
