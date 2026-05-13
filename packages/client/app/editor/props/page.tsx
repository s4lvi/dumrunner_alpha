'use client';

// Prop editor. Same three-pane layout as the biome and enemy
// editors. PropDef has fewer knobs than EnemyDef but the same
// conditional-form shape: onDestroy switches on whether the
// explode params and/or loot table are required.

import { Suspense, useEffect, useState } from 'react';
import type { PropDef } from '@dumrunner/shared';
import { listEntities } from '@/lib/editorContentClient';
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
import { AnimationPicker } from '../_components/AnimationPicker';
import { useEntityEditor } from '../_components/useEntityEditor';
import { EntityList } from '../_components/EntityList';
import { ReferencesPanel } from '../_components/ReferencesPanel';

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

export default function PropEditorPage() {
  // useEntityEditor reads useSearchParams; wrap in Suspense so
  // the static prerender pass doesn't bail on the CSR hook.
  return (
    <Suspense fallback={null}>
      <PropEditorBody />
    </Suspense>
  );
}

function PropEditorBody() {
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
  } = useEntityEditor<PropDef>('props', { makeBlank, newIdPrefix: 'prop' });
  const onSave = save;
  const onDelete = remove;
  const onNew = createNew;

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
      <EntityList<PropDef>
        title="Decorators"
        entries={entries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={onNew}
        emptyHint="No props yet. Click + new."
        renderItem={(p) => (
          <div className="flex items-center gap-2">
            <span
              className="w-3 h-3 rounded border border-zinc-700"
              style={{ background: p.visual.tint ?? '#52525b' }}
            />
            <span className="flex-1 truncate">{p.label}</span>
            <span className="text-[9px] text-zinc-600 font-mono">
              {p.onDestroy === 'explode' ? '💥' : p.solid ? '■' : '·'}
            </span>
          </div>
        )}
      />

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

            <FormSection title="Container">
              <p className="text-[10px] text-zinc-500 mb-2">
                Make this prop a tile-snapped, openable cube the
                player can E-interact to loot. Renders as a raycast
                cube using <code className="text-zinc-300">prop</code>{' '}
                (sides) +{' '}
                <code className="text-zinc-300">prop_top</code>;
                opened state swaps to{' '}
                <code className="text-zinc-300">prop_open</code> /{' '}
                <code className="text-zinc-300">prop_open_top</code>.
              </p>
              <CheckboxField
                label="container"
                value={draft.container !== undefined}
                onChange={(v) => {
                  if (v && !draft.container) {
                    setDraft({
                      ...draft,
                      container: {
                        tileWidth: 1,
                        tileDepth: 1,
                        heightMult: 0.5,
                        rollCount: 3,
                        lootTable: [
                          { materialId: '', min: 1, max: 1, chance: 0.5 },
                        ],
                      },
                    });
                  } else if (!v && draft.container) {
                    const { container: _drop, ...rest } = draft;
                    setDraft(rest as PropDef);
                  }
                }}
              />
              {draft.container && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <NumberField
                      label="tile width"
                      value={draft.container.tileWidth}
                      min={1}
                      max={8}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          container: { ...draft.container!, tileWidth: v },
                        })
                      }
                    />
                    <NumberField
                      label="tile depth"
                      value={draft.container.tileDepth}
                      min={1}
                      max={8}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          container: { ...draft.container!, tileDepth: v },
                        })
                      }
                    />
                    <SliderField
                      label="height"
                      value={draft.container.heightMult}
                      min={0.1}
                      max={1}
                      step={0.05}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          container: { ...draft.container!, heightMult: v },
                        })
                      }
                    />
                  </div>
                  <NumberField
                    label="roll count"
                    value={draft.container.rollCount}
                    min={0}
                    max={32}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        container: { ...draft.container!, rollCount: v },
                      })
                    }
                    hint="passes through the loot table at spawn"
                  />
                  <ListField
                    label="container loot table"
                    hint="weighted material drops rolled into the container's inventory at scene spawn."
                    entries={draft.container.lootTable}
                    newEntry={() => ({
                      materialId: '',
                      min: 1,
                      max: 1,
                      chance: 0.5,
                    })}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        container: { ...draft.container!, lootTable: next },
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
                </>
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
              <SliderField
                label="sprite size"
                value={draft.visual.spriteSize ?? 1}
                min={0.2}
                max={4}
                step={0.05}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    visual: { ...draft.visual, spriteSize: v },
                  })
                }
                hint="FPS billboard scale in wall-heights. 1 = matches a tile; 0.5 = half-tall (debris); 2 = double (pillar)."
              />
              <SliderField
                label="ground offset"
                value={draft.visual.spriteGroundOffset ?? 0}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    visual: { ...draft.visual, spriteGroundOffset: v },
                  })
                }
                hint="0 = sits on the floor; 1 = hangs from the ceiling. Useful for floating debris / banners / lamps."
              />
            </FormSection>

            <FormSection title="Animation">
              <AnimationPicker
                label="animation"
                category="prop"
                value={draft.animationId}
                onChange={(v) => setDraft({ ...draft, animationId: v })}
                hint="Drives this prop's idle + destroy states in the FPS renderer."
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
            <div className="border-t border-zinc-800 mt-2 pt-2">
              <ReferencesPanel area="props" id={draft.id} />
            </div>
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
