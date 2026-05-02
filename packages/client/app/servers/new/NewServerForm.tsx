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

      <div className="pt-2 border-t border-[color:var(--panel-border)]">
        <h3 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">
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
          <input
            type="checkbox"
            name="drop_items_on_death"
            defaultChecked
          />
          <span>Drop bag contents on death (full-loot mode)</span>
        </label>
        <p className="text-[11px] text-zinc-500 mt-1">
          Off = items stay with you on respawn. Equipped suit gear always
          stays regardless.
        </p>
      </div>

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
