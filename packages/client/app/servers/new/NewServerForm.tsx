'use client';

import { useActionState, useState } from 'react';
import { createServerAction, type CreateState } from './actions';

export function NewServerForm() {
  const [state, formAction, pending] = useActionState<CreateState, FormData>(
    createServerAction,
    null
  );
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');

  return (
    <form
      action={formAction}
      className="space-y-5 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded-lg p-6"
    >
      <Field
        label="Server name"
        name="name"
        type="text"
        required
        maxLength={64}
        placeholder="The Sunken Foundry"
      />

      <div>
        <span className="block text-sm text-zinc-400 mb-1">Visibility</span>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              value="public"
              checked={visibility === 'public'}
              onChange={() => setVisibility('public')}
            />
            <span>Public — listed in browser</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              value="private"
              checked={visibility === 'private'}
              onChange={() => setVisibility('private')}
            />
            <span>Private — invite only</span>
          </label>
        </div>
      </div>

      <Field
        label={
          visibility === 'private' ? 'Password (invite code)' : 'Password (optional)'
        }
        name="password"
        type="password"
        autoComplete="new-password"
        required={visibility === 'private'}
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

      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full py-2.5 rounded bg-[color:var(--accent)] text-black font-semibold disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create and enter'}
      </button>
    </form>
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
