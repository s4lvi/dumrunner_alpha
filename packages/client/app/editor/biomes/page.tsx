'use client';

// Biome editor. Three-pane layout: left sidebar lists every
// authored BiomeDef, centre is the form for the selected biome,
// right is a preview pane (currently a colour-strip + summary —
// the live procgen render lands with E3.4's per-tile sprite
// support; stubbing the layout now keeps the form work decoupled).

import { useEffect, useState } from 'react';
import type { BiomeDef, HazardKind } from '@dumrunner/shared';
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

const HAZARDS: readonly HazardKind[] = [
  'heat',
  'radiation',
  'cold',
  'toxic',
] as const;

function makeBlank(id = 'new_biome'): BiomeDef {
  return {
    id,
    label: 'New Biome',
    dominantHazard: 'heat',
    palette: { floor: '#1f242c', wall: '#52525b', accent: '#fde68a' },
    generation: {
      roomCountMin: 6,
      roomCountMax: 12,
      roomSizeMin: 4,
      roomSizeMax: 9,
      corridorWidth: 2,
      branching: 0.3,
      propDensity: 0.05,
      enemyDensity: 0.04,
      lootDensity: 0.5,
      hazardIntensity: 0.5,
    },
    enemyRoster: [],
    propPalette: [],
    lootBias: [],
  };
}

export default function BiomeEditorPage() {
  const [entries, setEntries] = useState<BiomeDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BiomeDef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Initial load + after-save refresh.
  async function refresh() {
    try {
      const r = await listEntities('biomes');
      setEntries(r);
      // Keep selection if still in list; otherwise drop draft.
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

  // When the selection changes, snapshot that biome into the draft.
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
      await saveEntity('biomes', draft);
      await refresh();
      setSelectedId(draft.id); // in case the id was renamed
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!selectedId) return;
    if (!confirm(`Delete biome "${selectedId}"?`)) return;
    try {
      await deleteEntity('biomes', selectedId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function onNew() {
    const id = `biome_${Date.now().toString(36)}`;
    const blank = makeBlank(id);
    setEntries((cur) => [...cur, blank]);
    setSelectedId(id);
  }

  return (
    <div className="flex h-full w-full">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 space-y-2">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-xs uppercase text-zinc-500">Biomes</h2>
          <Button onClick={onNew}>+ new</Button>
        </div>
        {entries.length === 0 && (
          <p className="text-[11px] text-zinc-500">
            No biomes yet. Click <span className="text-zinc-300">+ new</span> to start one.
          </p>
        )}
        {entries.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setSelectedId(b.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
              selectedId === b.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/40'
            }`}
          >
            <span
              className="w-3 h-3 rounded border border-zinc-700"
              style={{ background: b.palette.floor }}
            />
            <span className="flex-1 truncate">{b.label}</span>
            <span className="text-[9px] text-zinc-600 font-mono">
              {b.dominantHazard}
            </span>
          </button>
        ))}
      </aside>

      {/* Form */}
      <main className="flex-1 overflow-y-auto p-4 min-w-0">
        {!draft && (
          <div className="text-zinc-500 text-sm pt-12 text-center">
            Select a biome on the left, or create a new one.
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
              <EnumField
                label="dominant hazard"
                value={draft.dominantHazard}
                options={HAZARDS}
                onChange={(v) =>
                  setDraft({ ...draft, dominantHazard: v as HazardKind })
                }
              />
            </FormSection>

            <FormSection title="Palette">
              <ColorField
                label="floor"
                value={draft.palette.floor}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    palette: { ...draft.palette, floor: v },
                  })
                }
              />
              <ColorField
                label="wall"
                value={draft.palette.wall}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    palette: { ...draft.palette, wall: v },
                  })
                }
              />
              <ColorField
                label="accent"
                value={draft.palette.accent}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    palette: { ...draft.palette, accent: v },
                  })
                }
              />
            </FormSection>

            <FormSection title="Generation">
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="rooms (min)"
                  value={draft.generation.roomCountMin}
                  min={1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      generation: { ...draft.generation, roomCountMin: v },
                    })
                  }
                />
                <NumberField
                  label="rooms (max)"
                  value={draft.generation.roomCountMax}
                  min={1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      generation: { ...draft.generation, roomCountMax: v },
                    })
                  }
                />
                <NumberField
                  label="room size (min)"
                  value={draft.generation.roomSizeMin}
                  min={1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      generation: { ...draft.generation, roomSizeMin: v },
                    })
                  }
                />
                <NumberField
                  label="room size (max)"
                  value={draft.generation.roomSizeMax}
                  min={1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      generation: { ...draft.generation, roomSizeMax: v },
                    })
                  }
                />
                <NumberField
                  label="corridor width"
                  value={draft.generation.corridorWidth}
                  min={1}
                  max={4}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      generation: { ...draft.generation, corridorWidth: v },
                    })
                  }
                />
              </div>
              <SliderField
                label="branching"
                value={draft.generation.branching}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, branching: v },
                  })
                }
              />
              <SliderField
                label="prop density"
                value={draft.generation.propDensity}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, propDensity: v },
                  })
                }
              />
              <SliderField
                label="enemy density"
                value={draft.generation.enemyDensity}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, enemyDensity: v },
                  })
                }
              />
              <SliderField
                label="loot density"
                value={draft.generation.lootDensity}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, lootDensity: v },
                  })
                }
              />
              <SliderField
                label="hazard intensity"
                value={draft.generation.hazardIntensity}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, hazardIntensity: v },
                  })
                }
              />
            </FormSection>

            <ListField
              label="Enemy roster"
              hint="weighted picks. id must match an EnemyDef.id."
              entries={draft.enemyRoster}
              newEntry={() => ({ id: '', weight: 1 })}
              onChange={(next) => setDraft({ ...draft, enemyRoster: next })}
              renderRow={(entry, _i, update) => (
                <div className="grid grid-cols-[1fr_80px] gap-2">
                  <TextField
                    label="id"
                    value={entry.id}
                    monospace
                    onChange={(v) => update({ ...entry, id: v })}
                  />
                  <NumberField
                    label="weight"
                    value={entry.weight}
                    step={0.5}
                    min={0}
                    onChange={(v) => update({ ...entry, weight: v })}
                  />
                </div>
              )}
            />

            <ListField<BiomeDef['propPalette'][number]>
              label="Prop palette"
              hint="id must match a PropDef.id."
              entries={draft.propPalette}
              newEntry={() => ({ id: '', weight: 1 })}
              onChange={(next) => setDraft({ ...draft, propPalette: next })}
              renderRow={(entry, _i, update) => (
                <div className="space-y-1">
                  <div className="grid grid-cols-[1fr_80px] gap-2">
                    <TextField
                      label="id"
                      value={entry.id}
                      monospace
                      onChange={(v) => update({ ...entry, id: v })}
                    />
                    <NumberField
                      label="weight"
                      value={entry.weight}
                      step={0.5}
                      min={0}
                      onChange={(v) => update({ ...entry, weight: v })}
                    />
                  </div>
                  <div className="flex gap-3">
                    <CheckboxField
                      label="natural only"
                      value={entry.naturalOnly ?? false}
                      onChange={(v) =>
                        update({ ...entry, naturalOnly: v || undefined })
                      }
                    />
                    <CheckboxField
                      label="allow doorway"
                      value={entry.allowDoorway ?? false}
                      onChange={(v) =>
                        update({ ...entry, allowDoorway: v || undefined })
                      }
                    />
                  </div>
                </div>
              )}
            />

            <ListField
              label="Loot bias"
              hint="multiplier on a material's scatter-loot weight in this biome."
              entries={draft.lootBias}
              newEntry={() => ({ materialId: '', multiplier: 1 })}
              onChange={(next) => setDraft({ ...draft, lootBias: next })}
              renderRow={(entry, _i, update) => (
                <div className="grid grid-cols-[1fr_100px] gap-2">
                  <TextField
                    label="materialId"
                    value={entry.materialId}
                    monospace
                    onChange={(v) => update({ ...entry, materialId: v })}
                  />
                  <NumberField
                    label="multiplier"
                    value={entry.multiplier}
                    step={0.25}
                    min={0}
                    onChange={(v) => update({ ...entry, multiplier: v })}
                  />
                </div>
              )}
            />
          </div>
        )}
      </main>

      {/* Preview */}
      <aside className="w-72 shrink-0 border-l border-zinc-800 p-3 overflow-y-auto">
        <h2 className="text-xs uppercase text-zinc-500 mb-2">Preview</h2>
        {draft ? (
          <div className="space-y-3">
            <div
              className="h-24 rounded border border-zinc-700"
              style={{ background: draft.palette.floor }}
            />
            <div className="flex gap-1 h-6">
              <div
                className="flex-1 rounded border border-zinc-700"
                style={{ background: draft.palette.wall }}
                title="wall"
              />
              <div
                className="flex-1 rounded border border-zinc-700"
                style={{ background: draft.palette.accent }}
                title="accent"
              />
            </div>
            <div className="text-[11px] text-zinc-400 space-y-0.5 font-mono">
              <div>id: {draft.id}</div>
              <div>hazard: {draft.dominantHazard}</div>
              <div>
                rooms: {draft.generation.roomCountMin}–
                {draft.generation.roomCountMax}
              </div>
              <div>
                room size: {draft.generation.roomSizeMin}–
                {draft.generation.roomSizeMax}
              </div>
              <div>enemies: {draft.enemyRoster.length} kinds</div>
              <div>props: {draft.propPalette.length} kinds</div>
            </div>
            <p className="text-[10px] text-zinc-600 leading-snug">
              Live procgen preview lands with E3.4 (WFC + per-tile
              sprites). For now, save and check generated dungeons in
              the live game on the next perihelion.
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Select or create a biome to preview.
          </p>
        )}
      </aside>
    </div>
  );
}
