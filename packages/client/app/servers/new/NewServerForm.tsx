'use client';

import { useActionState, useState } from 'react';
import { createServerAction, type CreateState } from './actions';

type SceneSummary = { id: string; name: string };

export function NewServerForm({
  defaultName = '',
  scenes,
}: {
  defaultName?: string;
  scenes: SceneSummary[];
}) {
  const [state, formAction, pending] = useActionState<CreateState, FormData>(
    createServerAction,
    null
  );
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [mode, setMode] = useState<'live' | 'deathmatch'>('live');
  const [arenaSceneId, setArenaSceneId] = useState<string>(
    scenes[0]?.id ?? ''
  );

  const isDeathmatch = mode === 'deathmatch';

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
        defaultValue={defaultName}
        placeholder="The Sunken Foundry"
      />

      <div>
        <span className="block text-sm text-zinc-400 mb-2">Game mode</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeCard
            value="live"
            current={mode}
            onSelect={setMode}
            dotClass="bg-emerald-500"
            title="Live"
          />
          <ModeCard
            value="deathmatch"
            current={mode}
            onSelect={setMode}
            dotClass="bg-red-500"
            title="Deathmatch"
          />
        </div>
        <input type="hidden" name="mode" value={mode} />
      </div>

      {isDeathmatch && (
        <div>
          <span className="block text-sm text-zinc-400 mb-1">Arena map</span>
          {scenes.length === 0 ? (
            <p className="text-sm text-amber-400">
              No authored scenes yet.{' '}
              <a
                className="underline"
                href="/editor/scenes-csg"
                target="_blank"
                rel="noreferrer"
              >
                Build one in the editor
              </a>{' '}
              first.
            </p>
          ) : (
            <select
              name="arena_scene_id"
              value={arenaSceneId}
              onChange={(e) => setArenaSceneId(e.target.value)}
              className="w-full bg-[color:var(--bg)] border border-[color:var(--panel-border)] rounded px-3 py-2"
            >
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div>
        <span className="block text-sm text-zinc-400 mb-1">Visibility</span>
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              value="public"
              checked={visibility === 'public'}
              onChange={() => setVisibility('public')}
            />
            <span>Public</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              value="private"
              checked={visibility === 'private'}
              onChange={() => setVisibility('private')}
            />
            <span>Private</span>
          </label>
        </div>
      </div>

      <Field
        label={visibility === 'private' ? 'Password (invite code)' : 'Password (optional)'}
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

      {!isDeathmatch && (
        <>
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
              <input type="checkbox" name="drop_items_on_death" defaultChecked />
              <span>Drop bag contents on death</span>
            </label>
            <label className="flex items-center gap-2 mt-2 text-sm">
              <input type="checkbox" name="is_playtest" />
              <span>Playtest server</span>
            </label>
          </div>
        </>
      )}
      {isDeathmatch && (
        <>
          <input type="hidden" name="day_duration_sec" value="300" />
          <input type="hidden" name="days_per_cycle" value="3" />
        </>
      )}

      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}

      <button
        type="submit"
        disabled={pending || (isDeathmatch && scenes.length === 0)}
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

function ModeCard({
  value,
  current,
  onSelect,
  dotClass,
  title,
}: {
  value: 'live' | 'deathmatch';
  current: 'live' | 'deathmatch';
  onSelect: (v: 'live' | 'deathmatch') => void;
  dotClass: string;
  title: string;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`text-left p-4 rounded border transition-colors ${
        selected
          ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/5'
          : 'border-[color:var(--panel-border)] hover:border-zinc-500'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
        <span className="font-semibold">{title}</span>
      </div>
    </button>
  );
}
