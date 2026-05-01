'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { loginAction, type LoginState } from './actions';

function LoginForm() {
  const params = useSearchParams();
  const justConfirmed = params.get('confirm') === '1';

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
