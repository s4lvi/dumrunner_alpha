'use client';

// Decorator (prop) editor. Same three-pane layout as the biome
// and enemy editors. PropDef has fewer knobs than EnemyDef but
// the same conditional-form shape: onDestroy switches on whether
// the explode params and/or loot table are required.

import { useEffect, useState } from 'react';
import type { PropDef } from '@dumrunner/shared';
import {
  listEntities,
  saveEntity,
  deleteEntity,
} from '@/lib/editorContentClient';
import {
  Button,
  CheckboxField,
  ColorField,
  EnumField,
  FormSection,
  ListField,
  NumberField,
  SliderField,
  TextField,
} from '../_components/Form';
import { TextureRow } from '../_components/TextureRow';

const DESTROY_KINDS = ['nothing', 'drop_loot', 'explode'] as const;

function makeBlank(id = 'new_prop'): PropDef {
  return {
    id,
    label: 'New Prop',
    biomeAffinity: [],
    hp: 40,
    solid: true,
    onDestroy: 'nothing',
    visual: {},
  };
}

export default function DecoratorEditorPage() {
  const [entries, setEntries] = useState<PropDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PropDef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const r = await listEntities('props');
      setEntries(r);
      if (selectedId && !r.some((b) => b.id === selectedId)) {
        setSelectedId(null);
        setDraft(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selectedId === null) {
      setDraft(null);
      return;
    }
    const found = entries.find((b) => b.id === selectedId);
    if (found) setDraft(structuredClone(found));
  }, [selectedId, entries]);

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await saveEntity('props', draft);
      await refresh();
      setSelectedId(draft.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function onDelete() {
    if (!selectedId) return;
    if (!confirm(`Delete prop "${selectedId}"?`)) return;
    try {
      await deleteEntity('props', selectedId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function onNew() {
    const id = `prop_${Date.now().toString(36)}`;
    const blank = makeBlank(id);
    setEntries((cur) => [...cur, blank]);
    setSelectedId(id);
  }

  function setOnDestroy(kind: PropDef['onDestroy']) {
    if (!draft) return;
    const next: PropDef = { ...draft, onDestroy: kind };
    if (kind === 'explode' && !next.explode) {
      next.explode = { radius: 96, damage: 60 };
    }
    if (kind !== 'explode') delete next.explode;
    if (kind === 'drop_loot' && (!next.loot || next.loot.length === 0)) {
      next.loot = [{ materialId: '', min: 1, max: 1, chance: 0.5 }];
    }
    if (kind === 'nothing') delete next.loot;
    setDraft(next);
  }

  return (
    <div className="flex h-full w-full">
      <aside className="w-60 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 space-y-2">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-xs uppercase text-zinc-500">Decorators</h2>
          <Button onClick={onNew}>+ new</Button>
        </div>
        {entries.length === 0 && (
          <p className="text-[11px] text-zinc-500">
            No props yet. Click <span className="text-zinc-300">+ new</span>.
          </p>
        )}
        {entries.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelectedId(p.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
              selectedId === p.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/40'
            }`}
          >
            <span
              className="w-3 h-3 rounded border border-zinc-700"
              style={{ background: p.visual.tint ?? '#52525b' }}
            />
            <span className="flex-1 truncate">{p.label}</span>
            <span className="text-[9px] text-zinc-600 font-mono">
              {p.onDestroy === 'explode' ? '💥' : p.solid ? '■' : '·'}
            </span>
          </button>
        ))}
      </aside>

      <main className="flex-1 overflow-y-auto p-4 min-w-0">
        {!draft && (
          <div className="text-zinc-500 text-sm pt-12 text-center">
            Select a prop on the left, or create a new one.
          </div>
        )}
        {draft && (
          <div className="max-w-2xl">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-lg font-bold">{draft.label}</h1>
              <div className="flex gap-2">
                <Button variant="danger" onClick={onDelete}>
                  Delete
                </Button>
                <Button variant="primary" disabled={saving} onClick={onSave}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
            {error && (
              <pre className="bg-red-950/50 border border-red-900 text-red-200 text-[11px] font-mono p-2 rounded mb-3 whitespace-pre-wrap">
                {error}
              </pre>
            )}

            <FormSection title="Identity">
              <TextField
                label="id"
                value={draft.id}
                monospace
                onChange={(v) => setDraft({ ...draft, id: v })}
                hint="lowercase slug — also the JSON filename"
              />
              <TextField
                label="label"
                value={draft.label}
                onChange={(v) => setDraft({ ...draft, label: v })}
              />
              <BiomeAffinityField
                value={draft.biomeAffinity}
                onChange={(v) => setDraft({ ...draft, biomeAffinity: v })}
              />
            </FormSection>

            <FormSection title="Behavior">
              <NumberField
                label="hp"
                value={draft.hp}
                min={1}
                onChange={(v) => setDraft({ ...draft, hp: v })}
                hint="grass = 5, barrel = 40, crate = 60, rock = 150, pillar = 99999 (effectively indestructible)"
              />
              <CheckboxField
                label="solid"
                value={draft.solid}
                onChange={(v) => setDraft({ ...draft, solid: v })}
                hint="blocks player movement + projectiles"
              />
              <EnumField
                label="on destroy"
                value={draft.onDestroy}
                options={DESTROY_KINDS}
                onChange={(k) => setOnDestroy(k)}
              />
              {draft.onDestroy === 'explode' && draft.explode && (
                <div className="border border-zinc-800 rounded p-2 space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                    explode params
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField
                      label="radius (px)"
                      value={draft.explode.radius}
                      min={1}
                      step={8}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          explode: { ...draft.explode!, radius: v },
                        })
                      }
                    />
                    <NumberField
                      label="damage"
                      value={draft.explode.damage}
                      min={0}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          explode: { ...draft.explode!, damage: v },
                        })
                      }
                    />
                  </div>
                </div>
              )}
            </FormSection>

            {draft.onDestroy === 'drop_loot' && (
              <ListField
                label="Loot table"
                hint="onDestroy=drop_loot requires at least one entry."
                entries={draft.loot ?? []}
                newEntry={() => ({
                  materialId: '',
                  min: 1,
                  max: 1,
                  chance: 0.5,
                })}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    loot: next.length > 0 ? next : draft.loot,
                  })
                }
                renderRow={(entry, _i, update) => (
                  <div className="grid grid-cols-[1fr_60px_60px_70px] gap-2">
                    <TextField
                      label="materialId"
                      value={entry.materialId}
                      monospace
                      onChange={(v) => update({ ...entry, materialId: v })}
                    />
                    <NumberField
                      label="min"
                      value={entry.min}
                      min={0}
                      onChange={(v) => update({ ...entry, min: v })}
                    />
                    <NumberField
                      label="max"
                      value={entry.max}
                      min={0}
                      onChange={(v) => update({ ...entry, max: v })}
                    />
                    <SliderField
                      label="chance"
                      value={entry.chance}
                      onChange={(v) => update({ ...entry, chance: v })}
                    />
                  </div>
                )}
              />
            )}

            <FormSection title="Visual">
              <p className="text-[10px] text-zinc-500">
                Upload a billboard sprite (front face) and an
                optional top-surface texture below. Front saves
                under category <code className="text-zinc-300">prop</code>;
                top saves under{' '}
                <code className="text-zinc-300">prop_top</code>, id{' '}
                <code className="text-zinc-300">{draft.id}</code>.
                The tint is the procedural fallback when no sprite
                is uploaded.
              </p>
              <div>
                <div className="text-[10px] text-zinc-500 px-2 mb-1">
                  Front
                </div>
                <TextureRow category="prop" id={draft.id} hideLabel />
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 px-2 mb-1">
                  Top
                </div>
                <TextureRow category="prop_top" id={draft.id} hideLabel />
              </div>
              <ColorField
                label="tint (fallback)"
                value={draft.visual.tint ?? '#52525b'}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    visual: { ...draft.visual, tint: v },
                  })
                }
              />
              <TextField
                label="textureId"
                value={draft.visual.textureId ?? ''}
                monospace
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    visual: {
                      ...draft.visual,
                      textureId: v.trim() || undefined,
                    },
                  })
                }
                hint="optional — defaults to the prop's id."
              />
            </FormSection>
          </div>
        )}
      </main>

      <aside className="w-72 shrink-0 border-l border-zinc-800 p-3 overflow-y-auto">
        <h2 className="text-xs uppercase text-zinc-500 mb-2">Preview</h2>
        {draft ? (
          <div className="space-y-3">
            <div
              className="h-32 rounded border border-zinc-700 flex items-center justify-center"
              style={{ background: '#0b0d10' }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  background: draft.visual.tint ?? '#52525b',
                  border: '1px solid #000',
                  borderRadius: 4,
                  opacity: draft.solid ? 1 : 0.6,
                }}
              />
            </div>
            <div className="text-[11px] text-zinc-400 space-y-0.5 font-mono">
              <div>id: {draft.id}</div>
              <div>hp: {draft.hp}</div>
              <div>solid: {draft.solid ? 'yes' : 'no'}</div>
              <div>onDestroy: {draft.onDestroy}</div>
              {draft.explode && (
                <div>
                  explode: r={draft.explode.radius}, d=
                  {draft.explode.damage}
                </div>
              )}
              {draft.loot && draft.loot.length > 0 && (
                <div>loot rows: {draft.loot.length}</div>
              )}
              <div>biomes: {draft.biomeAffinity.join(', ') || '(none)'}</div>
            </div>
            <p className="text-[10px] text-zinc-600 leading-snug">
              Live "shoot to verify" sandbox lands once the prop
              system is wired up in E3.2. Until then, save and
              verify in the live game once a biome ships.
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Select or create a prop to preview.
          </p>
        )}
      </aside>
    </div>
  );
}

// Reused from enemy editor. Inline copy to avoid making a
// separate component module before either editor needs other
// shared widgets — small, focused, no premature abstraction.
function BiomeAffinityField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [biomeIds, setBiomeIds] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const r = await listEntities('biomes');
        setBiomeIds(r.map((b) => b.id));
      } catch {
        // No biomes yet — manual entry path stays usable.
      }
    })();
  }, []);
  return (
    <div className="space-y-1">
      <div className="text-xs text-zinc-300">biome affinity</div>
      {biomeIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {biomeIds.map((id) => {
            const on = value.includes(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() =>
                  onChange(
                    on ? value.filter((v) => v !== id) : [...value, id],
                  )
                }
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                  on
                    ? 'bg-emerald-900 border-emerald-700 text-emerald-100'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-400'
                }`}
              >
                {id}
              </button>
            );
          })}
        </div>
      )}
      <input
        type="text"
        placeholder="add biome id manually (comma-separated)"
        defaultValue=""
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return;
          const ids = raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          onChange([...new Set([...value, ...ids])]);
          e.target.value = '';
        }}
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono w-full"
      />
      <div className="text-[10px] text-zinc-500">
        {value.length} selected{value.length > 0 && ': ' + value.join(', ')}
      </div>
    </div>
  );
}
