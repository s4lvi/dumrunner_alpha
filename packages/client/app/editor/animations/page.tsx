'use client';

// Animation manifest editor. Three-pane: sidebar of authored
// manifests, centre form for the active manifest, right pane is
// the live frame preview reusing the Phase B engine.
//
// One manifest covers a single (category, textureId) pair. The
// id slug encodes both as `${category}__${textureId}`; the
// schema's refine catches mismatched slugs at save time. The
// editor never lets the author set the slug by hand — it's
// derived from the category + textureId fields so the
// invariant always holds.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Application,
  Sprite,
  Texture,
} from 'pixi.js';
import type { z } from 'zod';
import type { AnimationCategory, AnimationDef } from '@dumrunner/shared';
import {
  ANIMATION_CATEGORIES,
  AnimationController,
  AnimationDefSchema,
  STATES_BY_CATEGORY,
} from '@dumrunner/shared';
import {
  Button,
  ConfirmButton,
  CheckboxField,
  EnumField,
  FieldRow,
  FormSection,
  NumberField,
  TextField,
} from '../_components/Form';
import { EntityList } from '../_components/EntityList';
import { useEntityEditor } from '../_components/useEntityEditor';
import { StateTextureRow } from '../_components/StateTextureRow';
import { FrameTextureRow } from '../_components/FrameTextureRow';
import {
  invalidateAnimationManifest,
  getStateFrames,
} from '@/lib/animations';

function makeBlank(id: string): AnimationDef {
  // Default to a weapon_view manifest with an idle state — easy
  // template to extend. Author picks the category + name; the
  // id slug is whatever they chose.
  return {
    id,
    name: id,
    category: 'weapon_view',
    states: {
      idle: { frames: 1, fps: 6, loop: true },
    },
  };
}

export default function AnimationEditorPage() {
  return (
    <Suspense fallback={null}>
      <AnimationEditorBody />
    </Suspense>
  );
}

function AnimationEditorBody() {
  const {
    entries,
    selectedId,
    setSelectedId,
    draft,
    setDraft,
    save,
    remove,
    createNew,
    error,
    saving,
    validationError,
    canSave,
  } = useEntityEditor<AnimationDef>('animations', {
    makeBlank,
    newIdPrefix: 'anim',
    schema: AnimationDefSchema as unknown as z.ZodType<AnimationDef>,
  });

  const sorted = useMemo(() => {
    return [...entries].sort((a, b) => {
      const c = a.category.localeCompare(b.category);
      if (c !== 0) return c;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  // After a successful save the spritesheet client cache holds
  // a stale manifest. Drop it so the next animation lookup
  // re-fetches.
  useEffect(() => {
    if (!draft) return;
    invalidateAnimationManifest(draft.id);
  }, [draft?.id]);

  // Inline local errors before the save round-trip.
  const localErrors = useMemo(() => {
    const errs: string[] = [];
    if (!draft) return errs;
    if (!draft.id.match(/^[a-z0-9_-]+$/)) {
      errs.push('id must be lowercase alphanumeric / underscore / hyphen');
    }
    const allowed = new Set<string>(STATES_BY_CATEGORY[draft.category]);
    if (Object.keys(draft.states).length === 0) {
      errs.push('a manifest needs at least one state');
    }
    for (const [name, s] of Object.entries(draft.states)) {
      if (!allowed.has(name)) {
        errs.push(
          `state "${name}" not allowed for category "${draft.category}" — pick one of: ${[...allowed].join(', ')}`,
        );
      }
      if (s.frames < 1) errs.push(`state "${name}" frames must be ≥1`);
      if (s.fps <= 0) errs.push(`state "${name}" fps must be > 0`);
    }
    return errs;
  }, [draft]);

  const blockSave = localErrors.length > 0 || !canSave;

  function updateState(
    stateName: string,
    next: AnimationDef['states'][string],
  ): void {
    if (!draft) return;
    setDraft({ ...draft, states: { ...draft.states, [stateName]: next } });
  }
  // State renaming is no longer available in the editor — state
  // names are now drawn from STATES_BY_CATEGORY[category], not
  // free-typed. To "rename", the author removes the old state
  // and adds a new one with the same texture id (which keeps
  // the on-disk PNGs reachable).
  function removeState(stateName: string): void {
    if (!draft) return;
    const states = { ...draft.states };
    delete states[stateName];
    setDraft({ ...draft, states });
  }
  // The "+ add state" button is only useful when there are
  // un-authored states left in the category's allowed set.
  // Picks the first missing state name as the new slot.
  const missingStates = useMemo(() => {
    if (!draft) return [];
    const allowed = STATES_BY_CATEGORY[draft.category];
    return allowed.filter((s) => !draft.states[s]);
  }, [draft]);
  function addState(stateName: string): void {
    if (!draft) return;
    if (draft.states[stateName]) return;
    setDraft({
      ...draft,
      states: {
        ...draft.states,
        [stateName]: { frames: 1, fps: 6, loop: true },
      },
    });
  }

  return (
    <div className="flex h-full">
      <EntityList<AnimationDef>
        title="Animations"
        entries={sorted}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={createNew}
        emptyHint="No animations yet. Click + new to author one."
        renderItem={(a) => (
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider w-20 truncate text-zinc-500">
              {a.category}
            </span>
            <span className="flex-1 truncate">{a.name}</span>
            <span className="text-[10px] text-zinc-500">
              {Object.keys(a.states).length}
            </span>
          </div>
        )}
      />

      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 max-w-3xl">
          {draft === null ? (
            <p className="text-sm text-zinc-500">
              Select an animation on the left, or click <kbd>+ new</kbd> to
              author one.
            </p>
          ) : (
            <>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h1 className="text-lg font-bold text-zinc-200">
                    {draft.name}
                  </h1>
                  <div className="text-[10px] text-zinc-500 font-mono">
                    {draft.category} · {draft.id}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={save} disabled={blockSave}>
                    {saving ? 'saving…' : 'save'}
                  </Button>
                  <ConfirmButton onConfirm={remove} variant="danger">
                    delete
                  </ConfirmButton>
                </div>
              </div>

              {error && (
                <div className="mb-3 px-3 py-2 rounded bg-red-950/60 border border-red-900 text-red-200 text-xs whitespace-pre-line">
                  {error}
                </div>
              )}
              {(localErrors.length > 0 || validationError) && (
                <div className="mb-3 px-3 py-2 rounded bg-amber-950/40 border border-amber-900/80 text-amber-200 text-xs space-y-1">
                  {validationError && <div>• {validationError}</div>}
                  {localErrors.map((e, i) => (
                    <div key={i}>• {e}</div>
                  ))}
                </div>
              )}

              <FormSection title="Identity">
                <TextField
                  label="name"
                  value={draft.name}
                  onChange={(v) => setDraft({ ...draft, name: v })}
                  hint="Display label shown in the entity editor's animation picker (e.g. 'Pistol Classic'). The id slug is separate — renaming this doesn't move the on-disk manifest."
                />
                <EnumField<AnimationCategory>
                  label="kind"
                  value={draft.category}
                  options={ANIMATION_CATEGORIES}
                  onChange={(v) => {
                    // Switching kind invalidates state names that
                    // aren't in the new category's allowlist. Drop
                    // them eagerly so the form doesn't carry
                    // dead entries forward.
                    const allowed = new Set<string>(STATES_BY_CATEGORY[v]);
                    const states: AnimationDef['states'] = {};
                    for (const [k, val] of Object.entries(draft.states)) {
                      if (allowed.has(k)) states[k] = val;
                    }
                    setDraft({ ...draft, category: v, states });
                  }}
                  hint="Determines which state names are available. enemy → idle/walk/attack/hit/death; weapon_view → idle/fire/reload; etc."
                />
              </FormSection>

              <FormSection title="States">
                <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
                  Per-state spritesheet (or per-frame PNGs), frame
                  count, fps, loop behaviour. State names are
                  category-specific — pick from the {STATES_BY_CATEGORY[draft.category].length}{' '}
                  available below.{' '}
                  <code className="text-zinc-300">next</code> on a
                  non-looping state:{' '}
                  <code className="text-zinc-300">previous</code> returns
                  to whichever state played before this one (hit → back
                  to walking); empty = stop on the last frame (death).
                </div>
                {Object.entries(draft.states).map(([name, s]) => (
                  <StateBlock
                    key={name}
                    animationId={draft.id}
                    name={name}
                    state={s}
                    otherStateNames={Object.keys(draft.states).filter(
                      (n) => n !== name,
                    )}
                    onChange={(next) => updateState(name, next)}
                    onRemove={() => removeState(name)}
                  />
                ))}
                {missingStates.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-zinc-500">
                      Add state:
                    </span>
                    {missingStates.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => addState(s)}
                        className="text-[10px] text-zinc-400 hover:text-zinc-200 px-2 py-0.5 border border-zinc-800 rounded font-mono"
                      >
                        + {s}
                      </button>
                    ))}
                  </div>
                )}
              </FormSection>
            </>
          )}
        </div>

        <aside className="w-[360px] shrink-0 border-l border-zinc-800 overflow-y-auto">
          <div className="px-3 py-2 border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
            Live preview
          </div>
          {draft && <Preview key={draft.id} def={draft} />}
        </aside>
      </main>
    </div>
  );
}

function StateBlock({
  animationId,
  name,
  state,
  otherStateNames,
  onChange,
  onRemove,
}: {
  animationId: string;
  name: string;
  state: AnimationDef['states'][string];
  otherStateNames: string[];
  onChange: (next: AnimationDef['states'][string]) => void;
  onRemove: () => void;
}) {
  return (
    <div className="border border-zinc-800 rounded p-2 mb-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-mono text-zinc-200 px-2 py-1 bg-zinc-900 border border-zinc-700 rounded">
          {name}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] text-zinc-500 hover:text-red-400 ml-auto"
        >
          remove
        </button>
      </div>
      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <NumberField
            label="frames"
            value={state.frames}
            onChange={(v) => onChange({ ...state, frames: Math.max(1, Math.floor(v)) })}
            min={1}
            step={1}
          />
          <NumberField
            label="fps (speed)"
            value={state.fps}
            onChange={(v) => onChange({ ...state, fps: Math.max(0.01, v) })}
            min={0.25}
            max={60}
            step={0.5}
            hint="Effective playback rate. The on-disk value is exactly what runs — no separate base × multiplier."
          />
          <CheckboxField
            label="loop"
            value={state.loop}
            onChange={(v) => onChange({ ...state, loop: v })}
          />
          {!state.loop && (
            <FieldRow
              label="next state"
              hint="What plays when this finishes. `previous` returns to the state that played before this one."
            >
              <select
                value={state.next ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    const { next: _drop, ...rest } = state;
                    onChange(rest);
                  } else {
                    onChange({ ...state, next: v });
                  }
                }}
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
              >
                <option value="">(stop on last frame)</option>
                <option value="previous">previous</option>
                {otherStateNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </FieldRow>
          )}
        </div>
        <div className="flex-1 space-y-1">
          <FieldRow
            label="source"
            hint="Sheet = one PNG sliced horizontally into `frames` cells. Frames = one PNG per frame (drop them in below). Switch any time; the renderer reloads from the chosen path."
          >
            <select
              value={state.source ?? 'sheet'}
              onChange={(e) => {
                const v = e.target.value as 'sheet' | 'frames';
                if (v === 'sheet') {
                  const { source: _drop, ...rest } = state;
                  onChange(rest);
                } else {
                  onChange({ ...state, source: v });
                }
              }}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs"
            >
              <option value="sheet">sheet (one PNG)</option>
              <option value="frames">frames (one PNG per frame)</option>
            </select>
          </FieldRow>
          {(state.source ?? 'sheet') === 'sheet' ? (
            <StateTextureRow
              category="anim"
              id={animationId}
              state={name}
              hint={`${state.frames} frame${state.frames === 1 ? '' : 's'} wide`}
            />
          ) : (
            <div className="border border-zinc-800 rounded p-2 space-y-1">
              <div className="text-[10px] text-zinc-500 mb-1">
                One PNG per frame. Missing slots render as empty.
              </div>
              {Array.from({ length: state.frames }, (_, i) => (
                <FrameTextureRow
                  key={i}
                  category="anim"
                  id={animationId}
                  state={name}
                  frame={i}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Live preview: shells out to AnimationController + the
// spritesheet cache the same way the sandbox page does.
function Preview({ def }: { def: AnimationDef }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateNames = Object.keys(def.states);
  const [activeState, setActiveState] = useState<string>(stateNames[0] ?? '');
  useEffect(() => {
    if (!stateNames.includes(activeState) && stateNames[0]) {
      setActiveState(stateNames[0]);
    }
  }, [stateNames, activeState]);
  useEffect(() => {
    if (!containerRef.current || !activeState) return;
    let cancelled = false;
    const container = containerRef.current;
    const app = new Application();
    let sprite: Sprite | null = null;
    let controller: AnimationController | null = null;
    void (async () => {
      await app.init({
        background: '#0a0a0a',
        resizeTo: container,
        antialias: false,
      });
      if (cancelled) {
        app.destroy(true);
        return;
      }
      container.appendChild(app.canvas);
      sprite = new Sprite();
      sprite.anchor.set(0.5);
      sprite.x = app.screen.width / 2;
      sprite.y = app.screen.height / 2;
      app.stage.addChild(sprite);
      controller = new AnimationController(def, activeState);
      app.ticker.add(() => {
        if (!controller || !sprite) return;
        const now = performance.now();
        const frame = controller.tick(now);
        const sd = def.states[frame.state];
        if (!sd) return;
        const frames = getStateFrames(
          def.id,
          frame.state,
          sd.frames,
          sd.source ?? 'sheet',
        );
        const tex = frames[frame.frameIndex];
        if (tex && sprite.texture !== tex) {
          sprite.texture = tex;
          const target = Math.min(app.screen.width, app.screen.height) * 0.6;
          const scale = target / Math.max(tex.width || 1, tex.height || 1);
          sprite.scale.set(scale);
        } else if (!tex) {
          sprite.texture = Texture.EMPTY;
        }
      });
    })();
    return () => {
      cancelled = true;
      try {
        app.destroy(true);
      } catch {
        /* swallow */
      }
    };
  }, [def, activeState]);
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-wider text-zinc-500">
          State
        </label>
        <select
          value={activeState}
          onChange={(e) => setActiveState(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs"
        >
          {stateNames.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
