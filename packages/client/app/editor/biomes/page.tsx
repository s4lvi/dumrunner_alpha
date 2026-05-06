'use client';

// Biome editor. Three-pane layout: left sidebar lists every
// authored BiomeDef, centre is the form for the selected biome,
// right is a preview pane (currently a colour-strip + summary —
// the live procgen render lands with E3.4's per-tile sprite
// support; stubbing the layout now keeps the form work decoupled).

import { useEffect, useState } from 'react';
import type {
  BiomeDef,
  HazardKind,
  MaterialKind,
  Player,
  SceneLayout,
} from '@dumrunner/shared';
import { MATERIALS } from '@dumrunner/shared';
import type { GameInit } from '@/lib/game/pixi';
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
import { IsoPreview } from '../_components/IsoPreview';
import { TextureRow } from '../_components/TextureRow';

const HAZARDS: readonly HazardKind[] = [
  'none',
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
  // Tab toggle: 'edit' shows the form, 'preview' shows the
  // full-pane iso scene rendered with this biome's settings.
  // Sidebar stays mounted in both so biome switches are quick.
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  // Cross-reference id pickers for the enemy roster / prop
  // palette / loot bias dropdowns. Loaded from the JSON content
  // so newly authored entities show up without a code edit.
  // Materials come from the shared registry (no editor for those
  // yet).
  const [enemyOptions, setEnemyOptions] = useState<string[]>([]);
  const [propOptions, setPropOptions] = useState<string[]>([]);
  const materialOptions = Object.keys(MATERIALS) as MaterialKind[];
  useEffect(() => {
    void (async () => {
      try {
        const [enemies, props] = await Promise.all([
          listEntities('enemies'),
          listEntities('props'),
        ]);
        setEnemyOptions(enemies.map((e) => e.id).sort());
        setPropOptions(props.map((p) => p.id).sort());
      } catch {
        // No content yet — dropdowns fall back to text entry.
      }
    })();
  }, []);
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

      {/* Main column: tab strip + active tab content */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-1 px-3 py-1 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
          <button
            type="button"
            onClick={() => setTab('edit')}
            className={`text-xs px-2 py-1 rounded ${
              tab === 'edit'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/50'
            }`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setTab('preview')}
            disabled={!draft}
            className={`text-xs px-2 py-1 rounded ${
              tab === 'preview'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/50'
            } ${!draft ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Preview
          </button>
          {draft && (
            <div className="ml-auto flex gap-2">
              <Button variant="danger" onClick={onDelete}>
                Delete
              </Button>
              <Button variant="primary" disabled={saving} onClick={onSave}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}
        </div>

        {/* Edit tab — the form */}
        {tab === 'edit' && (
          <main className="flex-1 overflow-y-auto p-4 min-w-0">
            {!draft && (
              <div className="text-zinc-500 text-sm pt-12 text-center">
                Select a biome on the left, or create a new one.
              </div>
            )}
            {draft && (
              <div className="max-w-2xl">
                <h1 className="text-lg font-bold mb-4">{draft.label}</h1>
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

            <FormSection title="Textures">
              <p className="text-[10px] text-zinc-500">
                Optional. Floor + ceiling textures tile across walkable
                tiles in FPS view. Skybox replaces the sky gradient
                above the horizon (no tiling needed; pans with yaw).
                Saved under{' '}
                <code className="text-zinc-300">biome_floor</code> /{' '}
                <code className="text-zinc-300">biome_ceiling</code> /{' '}
                <code className="text-zinc-300">biome_skybox</code>,
                id <code className="text-zinc-300">{draft.id}</code>.
              </p>
              <div>
                <div className="text-[10px] text-zinc-500 px-2 mb-1">
                  Floor
                </div>
                <TextureRow
                  category="biome_floor"
                  id={draft.id}
                  hideLabel
                />
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 px-2 mb-1">
                  Ceiling
                </div>
                <TextureRow
                  category="biome_ceiling"
                  id={draft.id}
                  hideLabel
                />
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 px-2 mb-1">
                  Skybox
                </div>
                <TextureRow
                  category="biome_skybox"
                  id={draft.id}
                  hideLabel
                />
              </div>
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
              hint="weighted picks; pulls from authored enemies."
              entries={draft.enemyRoster}
              newEntry={() => ({
                id: enemyOptions[0] ?? '',
                weight: 1,
              })}
              onChange={(next) => setDraft({ ...draft, enemyRoster: next })}
              renderRow={(entry, _i, update) => (
                <div className="grid grid-cols-[1fr_80px] gap-2">
                  <IdPicker
                    label="enemy"
                    value={entry.id}
                    options={enemyOptions}
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
              hint="weighted picks; pulls from authored decorators."
              entries={draft.propPalette}
              newEntry={() => ({
                id: propOptions[0] ?? '',
                weight: 1,
              })}
              onChange={(next) => setDraft({ ...draft, propPalette: next })}
              renderRow={(entry, _i, update) => (
                <div className="space-y-1">
                  <div className="grid grid-cols-[1fr_80px] gap-2">
                    <IdPicker
                      label="prop"
                      value={entry.id}
                      options={propOptions}
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
              newEntry={() => ({
                materialId: materialOptions[0] ?? '',
                multiplier: 1,
              })}
              onChange={(next) => setDraft({ ...draft, lootBias: next })}
              renderRow={(entry, _i, update) => (
                <div className="grid grid-cols-[1fr_100px] gap-2">
                  <IdPicker
                    label="material"
                    value={entry.materialId}
                    options={materialOptions}
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
        )}

        {/* Preview tab — full-pane iso scene + summary footer */}
        {tab === 'preview' && draft && (
          <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
            <div className="flex-1 min-h-0">
              <BiomePreview draft={draft} />
            </div>
            <div className="flex items-center gap-2 shrink-0 text-[11px] text-zinc-400 font-mono">
              <div className="flex gap-0.5">
                <span
                  className="inline-block w-4 h-4 rounded border border-zinc-700"
                  style={{ background: draft.palette.floor }}
                  title="floor"
                />
                <span
                  className="inline-block w-4 h-4 rounded border border-zinc-700"
                  style={{ background: draft.palette.wall }}
                  title="wall"
                />
                <span
                  className="inline-block w-4 h-4 rounded border border-zinc-700"
                  style={{ background: draft.palette.accent }}
                  title="accent"
                />
              </div>
              <span>{draft.id}</span>
              <span>· hazard: {draft.dominantHazard}</span>
              <span>
                · rooms {draft.generation.roomCountMin}–
                {draft.generation.roomCountMax}
              </span>
              <span>
                · room size {draft.generation.roomSizeMin}–
                {draft.generation.roomSizeMax}
              </span>
              <span className="ml-auto text-zinc-600">
                Procedural geometry from authored params lands with E3.4.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Cross-reference picker. Native <select> with the supplied
// options + a sentinel "(unset)" entry. Falls back to a freeform
// text input when no options are authored yet so the dev can
// still scaffold a biome before the referenced entities exist.
function IdPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  if (options.length === 0) {
    return (
      <label className="flex flex-col gap-0.5 text-xs">
        <span className="text-zinc-300">{label}</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
          placeholder="no options yet — type id"
        />
      </label>
    );
  }
  // Show the current value even if it's not in the options list
  // (e.g. referencing a deleted entity). Marks it as missing so
  // the dev sees the broken reference.
  const missing = value && !options.includes(value);
  return (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-zinc-300">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-zinc-900 border rounded px-2 py-1 text-sm font-mono ${
          missing ? 'border-red-700 text-red-300' : 'border-zinc-700'
        }`}
      >
        {missing && <option value={value}>{value} (missing)</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------- Iso preview ----------
//
// Tiny demo dungeon — a single walkable room with the player at
// centre — rendered in iso with the biome's palette. Re-mounts
// whenever the relevant biome bits change (palette, room size).

const PREVIEW_TILE = 32;
const PREVIEW_SELF_ID = 'biome_preview_self';

function BiomePreview({ draft }: { draft: BiomeDef }) {
  const buildInit = (): GameInit => {
    // Use the room-size-max as the demo room dimensions so the
    // preview reflects "big room" feel for biomes that author one.
    const tilesW = Math.max(6, Math.min(12, draft.generation.roomSizeMax));
    const tilesH = tilesW;
    const halfW = (tilesW * PREVIEW_TILE) / 2;
    const halfH = (tilesH * PREVIEW_TILE) / 2;
    const layout: SceneLayout = {
      worldBounds: { x: -1000, y: -1000, w: 2000, h: 2000 },
      walkables: [
        { x: -halfW, y: -halfH, w: tilesW * PREVIEW_TILE, h: tilesH * PREVIEW_TILE },
      ],
      rooms: [
        { x: -halfW, y: -halfH, w: tilesW * PREVIEW_TILE, h: tilesH * PREVIEW_TILE },
      ],
      spawn: { x: 0, y: 0 },
      interactables: [],
      tileSize: PREVIEW_TILE,
      // The editor passes init.palette explicitly, so this id
      // is just a label — the renderer's palette resolver
      // short-circuits before reading it.
      biome: draft.id,
    };
    const self: Player = {
      characterId: PREVIEW_SELF_ID,
      accountId: 'editor',
      displayName: 'self',
      x: 0,
      y: 0,
      hp: 100,
      maxHp: 100,
      stamina: 100,
      maxStamina: 100,
      shield: 0,
      maxShield: 0,
      alive: true,
    };
    return {
      self,
      others: [],
      enemies: [],
      projectiles: [],
      loot: [],
      corpses: [],
      buildings: [],
      props: [],
      layout,
      sendInput: () => {},
      sendFire: () => {},
      sendBuild: () => {},
      sendDemolish: () => {},
      onNearInteractableChanged: () => {},
      onNearWorkstationsChanged: () => {},
      palette: {
        floor: draft.palette.floor,
        // Iso uses two wall tones (top + front). Use the biome's
        // single wall colour for both — the renderer will tweak
        // shade per face for depth. Accent isn't used yet; saved
        // for future per-tile tile-textures.
        wallTop: draft.palette.wall,
        wallFront: draft.palette.wall,
      },
    };
  };
  // Cheap signature: anything that affects geometry or palette.
  const signature = `${draft.id}|${draft.palette.floor}|${draft.palette.wall}|${draft.palette.accent}|${draft.generation.roomSizeMax}`;
  return <IsoPreview buildInit={buildInit} signature={signature} />;
}
