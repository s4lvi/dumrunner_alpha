'use client';

import { useActionState } from 'react';
import { resetPasswordAction, type ResetState } from './actions';

export default function ResetPasswordPage() {
  const [state, formAction, pending] = useActionState<ResetState, FormData>(
    resetPasswordAction,
    null
  );

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-8">
        <h1 className="text-3xl font-bold mb-6">Set new password</h1>

        <form action={formAction} className="space-y-4">
          <label className="block">
            <span className="block text-sm text-zinc-400 mb-1">New password</span>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="w-full bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="block text-sm text-zinc-400 mb-1">Confirm</span>
            <input
              type="password"
              name="confirm"
              autoComplete="new-password"
              required
              minLength={8}
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
            {pending ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </div>
    </main>
  );
}
