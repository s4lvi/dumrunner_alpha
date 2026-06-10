'use client';

import { useActionState } from 'react';
import { updateDisplayNameAction, type SettingsState } from './actions';

export function SettingsForm({ initialDisplayName }: { initialDisplayName: string }) {
  const [state, formAction, pending] = useActionState<SettingsState, FormData>(
    updateDisplayNameAction,
    { kind: 'idle' }
  );

  return (
    <form
      action={formAction}
      className="space-y-4 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-6"
    >
      <label className="block">
        <span className="block text-sm text-zinc-400 mb-1">Display name</span>
        <input
          type="text"
          name="display_name"
          defaultValue={initialDisplayName}
          minLength={2}
          maxLength={32}
          required
          className="w-full bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2 outline-none focus:border-[color:var(--accent)]"
        />
      </label>

      {state.kind === 'error' && (
        <p className="text-sm text-red-400">{state.message}</p>
      )}
      {state.kind === 'ok' && (
        <p className="text-sm text-emerald-400">{state.message}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="px-4 py-2 rounded bg-[color:var(--accent)] text-black font-semibold disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
