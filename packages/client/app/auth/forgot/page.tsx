'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { forgotPasswordAction, type ForgotState } from './actions';

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState<ForgotState, FormData>(
    forgotPasswordAction,
    null
  );

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-8">
        <h1 className="text-3xl font-bold mb-6">Reset password</h1>

        {state?.sent ? (
          <p className="text-sm text-emerald-400 border border-emerald-700/40 bg-emerald-900/20 rounded px-3 py-2">
            If that email is registered, a reset link is on its way.
          </p>
        ) : (
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

            {state?.error && (
              <p className="text-sm text-red-400">{state.error}</p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full py-2.5 rounded bg-[color:var(--accent)] text-black font-semibold disabled:opacity-50"
            >
              {pending ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="mt-6 text-sm text-zinc-400">
          <Link href="/login">← Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
