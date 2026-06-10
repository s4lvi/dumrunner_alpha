'use client';

// Biome editor. Three-pane layout: left sidebar lists every
// authored BiomeDef, centre is the form for the selected biome,
// right is a preview pane (currently a colour-strip + summary —
// the live procgen render lands with E3.4's per-tile sprite
// support; stubbing the layout now keeps the form work decoupled).

import { Suspense, useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import type {
  BiomeDef,
  EnemyDef,
  HazardKind,
  MaterialKind,
  PropDef,
} from '@dumrunner/shared';
import {
  BiomeDefSchema,
  findSpriteFitOffenders,
  MATERIALS,
} from '@dumrunner/shared';
import { listEntities } from '@/lib/editorContentClient';
import {
  Button,
  ConfirmButton,
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
import { BiomePreview as SandboxBiomePreview } from '../_components/BiomePreview';
import { ReferencesPanel } from '../_components/ReferencesPanel';

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
    kind: 'dungeon',
    dominantHazard: 'heat',
    palette: { floor: '#1f242c', wall: '#52525b', accent: '#fde68a' },
    generation: {
      propDensity: 0.05,
      enemyDensity: 0.04,
      lootDensity: 0.5,
      hazardIntensity: 0.5,
      safeRoomChance: 0.2,
      extremeRoomChance: 0.05,
    },
    enemyRoster: [],
    propPalette: [],
    lootBias: [],
    tileSet: {
      tiles: [
        {
          id: 1,
          label: 'default_floor',
          role: 'floor',
          walkable: true,
          blocksLOS: false,
          blocksProjectiles: false,
        },
        {
          id: 2,
          label: 'default_wall',
          role: 'wall',
          walkable: false,
          blocksLOS: true,
          blocksProjectiles: true,
        },
      ],
    },
  };
}

export default function BiomeEditorPage() {
  // useEntityEditor reads useSearchParams; wrap the body in
  // Suspense so the static prerender pass doesn't bail on the
  // CSR hook.
  return (
    <Suspense fallback={null}>
      <BiomeEditorBody />
    </Suspense>
  );
}

function BiomeEditorBody() {
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
  } = useEntityEditor<BiomeDef>('biomes', {
    makeBlank,
    newIdPrefix: 'biome',
    schema: BiomeDefSchema as unknown as z.ZodType<BiomeDef>,
  });
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
  // Keep the full defs around so the FPS-fit warning can read
  // each entry's sprite size — id-only would mean re-fetching.
  const [enemyDefs, setEnemyDefs] = useState<EnemyDef[]>([]);
  const [propDefs, setPropDefs] = useState<PropDef[]>([]);
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
        setEnemyDefs(enemies);
        setPropDefs(props);
      } catch {
        // No content yet — dropdowns fall back to text entry.
      }
    })();
  }, []);

  // Sprite-fit warning: any enemy/prop in this biome's roster
  // whose render-height exceeds wallHeightTiles will clip the
  // ceiling. Server-side save rejects the same condition.
  const spriteFitOffenders = useMemo(() => {
    if (!draft) return [];
    const enemyMap = new Map(enemyDefs.map((e) => [e.id, e]));
    const propMap = new Map(propDefs.map((p) => [p.id, p]));
    return findSpriteFitOffenders(draft, enemyMap, propMap);
  }, [draft, enemyDefs, propDefs]);
  const onSave = save;
  const onDelete = remove;
  const onNew = createNew;

  return (
    <div className="flex h-full w-full">
      <EntityList<BiomeDef>
        title="Biomes"
        entries={entries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={onNew}
        emptyHint="No biomes yet. Click + new to start one."
        renderItem={(b) => (
          <div className="flex items-center gap-2">
            <span
              className="w-3 h-3 rounded border border-zinc-700"
              style={{ background: b.palette.floor }}
            />
            <span className="flex-1 truncate">{b.label}</span>
            <span className="text-[9px] text-zinc-600 font-mono">
              {b.dominantHazard}
            </span>
          </div>
        )}
      />

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
            <div className="ml-auto flex items-center gap-2">
              {validationError && (
                <span
                  title={validationError}
                  className="text-[10px] text-red-300 font-mono max-w-[20rem] truncate"
                >
                  {validationError}
                </span>
              )}
              <ConfirmButton variant="danger" onConfirm={onDelete}>
                Delete
              </ConfirmButton>
              <Button
                variant="primary"
                disabled={!canSave || spriteFitOffenders.length > 0}
                onClick={onSave}
              >
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
                label="kind"
                value={draft.kind ?? 'dungeon'}
                options={['dungeon', 'overworld'] as const}
                onChange={(v) =>
                  setDraft({ ...draft, kind: v as BiomeDef['kind'] })
                }
                hint="overworld = surface / base biome (one used at a time)"
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

            {(draft.kind ?? 'dungeon') === 'overworld' && (
              <FormSection title="Overworld">
                <p className="text-[10px] text-zinc-500 mb-2">
                  Drives the surface scene. Floor + skybox textures
                  authored under{' '}
                  <code className="text-zinc-300">/editor/textures</code>
                  {' '}keyed by this biome's id. Scattered props pulled
                  from <code className="text-zinc-300">propPalette</code>{' '}
                  below.
                </p>
                <SliderField
                  label="prop density"
                  value={draft.overworld?.propDensity ?? 1}
                  min={0}
                  max={5}
                  step={0.1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      overworld: {
                        ...(draft.overworld ?? { propDensity: 1 }),
                        propDensity: v,
                      },
                    })
                  }
                  hint="props per 100 surface tiles"
                />
              </FormSection>
            )}

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
                tiles in FPS view. Wall texture paints every dungeon
                wall in this biome. Skybox replaces the sky gradient
                above the horizon (no tiling needed; pans with yaw).
                Saved under{' '}
                <code className="text-zinc-300">biome_floor</code> /{' '}
                <code className="text-zinc-300">biome_ceiling</code> /{' '}
                <code className="text-zinc-300">biome_wall</code> /{' '}
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
                  Wall
                </div>
                <TextureRow
                  category="biome_wall"
                  id={draft.id}
                  hideLabel
                />
              </div>
              <WallVariantList
                draft={draft}
                onChange={setDraft}
              />
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

            <FormSection title="FPS Geometry">
              <SliderField
                label="wall height (tiles)"
                value={draft.wallHeightTiles ?? 1}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    wallHeightTiles: v === 1 ? undefined : v,
                  })
                }
                min={1}
                max={4}
                step={0.05}
                hint="FPS-only. 1.0 = square room (floor — going lower would clip standard sprites). > 1 opens up tall rooms (Sun-Bleached plazas, Alien Core resonant chambers). Camera height stays half a tile regardless — only the ceiling rises."
              />
              {spriteFitOffenders.length > 0 && (
                <div className="mt-2 px-3 py-2 rounded bg-amber-950/40 border border-amber-900/80 text-amber-200 text-xs space-y-1">
                  <div className="font-medium">
                    {spriteFitOffenders.length} roster entr
                    {spriteFitOffenders.length === 1 ? 'y' : 'ies'} won't fit under
                    this ceiling ({(draft.wallHeightTiles ?? 1).toFixed(2)} tiles):
                  </div>
                  {spriteFitOffenders.map((o) => (
                    <div key={`${o.kind}:${o.id}`}>
                      • {o.kind} <code className="text-amber-100">{o.id}</code> is{' '}
                      {o.spriteTiles.toFixed(2)} tiles tall
                    </div>
                  ))}
                  <div className="text-amber-300/80 pt-1">
                    Save will be rejected until you raise the wall height or
                    remove these entries from this biome's roster / palette.
                  </div>
                </div>
              )}
            </FormSection>

            <FormSection title="Ambient animations">
              <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
                Looping animations for each FPS surface. Each cell
                rolls its own phase offset, so authored sheets read
                as organic flicker rather than synchronised pulse.
              </div>
              <AnimationPicker
                label="wall"
                category="biome_wall"
                value={draft.wallAnimationId}
                onChange={(v) => setDraft({ ...draft, wallAnimationId: v })}
              />
              <AnimationPicker
                label="floor"
                category="biome_floor"
                value={draft.floorAnimationId}
                onChange={(v) => setDraft({ ...draft, floorAnimationId: v })}
              />
              <AnimationPicker
                label="ceiling"
                category="biome_ceiling"
                value={draft.ceilingAnimationId}
                onChange={(v) => setDraft({ ...draft, ceilingAnimationId: v })}
              />
            </FormSection>

            {(draft.kind ?? 'dungeon') === 'dungeon' && (
            <FormSection title="Generation">
              <SliderField
                label="prop density"
                value={draft.generation.propDensity}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, propDensity: v },
                  })
                }
                hint="fraction of walkable tiles that get a prop. typical 0.04..0.08; up to 1.0 for clutter biomes."
              />
              <SliderField
                label="enemy density"
                value={draft.generation.enemyDensity}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, enemyDensity: v },
                  })
                }
                hint="fraction of walkable tiles that roll an enemy. typical 0.03..0.06; up to 1.0 for swarm biomes."
              />
              <SliderField
                label="loot density"
                value={draft.generation.lootDensity}
                min={0}
                max={1}
                step={0.01}
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
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, hazardIntensity: v },
                  })
                }
              />
              <SliderField
                label="safe-room chance"
                value={draft.generation.safeRoomChance ?? 0}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, safeRoomChance: v },
                  })
                }
              />
              <SliderField
                label="extreme-room chance"
                value={draft.generation.extremeRoomChance ?? 0}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    generation: { ...draft.generation, extremeRoomChance: v },
                  })
                }
              />
            </FormSection>
            )}

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

            <FormSection title="References">
              <ReferencesPanel area="biomes" id={draft.id} />
            </FormSection>
              </div>
            )}
          </main>
        )}

        {/* Preview tab — full-pane sandbox arena rendering this
            biome's procgen output */}
        {tab === 'preview' && draft && (
          <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
            <div className="flex-1 min-h-0">
              <SandboxBiomePreview biomeId={draft.id} />
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Wall texture variants. Each entry is an id; the renderer hashes
// per-cell to pick which one to use. Single id behaves like the
// Phase 1 single-texture upload. Adds default ids derived from
// biome id so the author can upload images right away.
function WallVariantList({
  draft,
  onChange,
}: {
  draft: BiomeDef;
  onChange: (next: BiomeDef) => void;
}) {
  const wallIdx = draft.tileSet?.tiles.findIndex((t) => t.role === 'wall') ?? -1;
  if (!draft.tileSet || wallIdx < 0) return null;
  const variants = draft.tileSet.tiles[wallIdx].textureIds ?? [];

  function setVariants(next: string[]): void {
    if (!draft.tileSet) return;
    const tiles = draft.tileSet.tiles.slice();
    tiles[wallIdx] = { ...tiles[wallIdx], textureIds: next };
    onChange({ ...draft, tileSet: { ...draft.tileSet, tiles } });
  }

  function nextDefaultId(): string {
    const base = `${draft.id}_wall`;
    let n = variants.length + 1;
    while (variants.includes(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-zinc-500 px-2">
        Wall variants — extra textures distributed across cells.
        Single texture above is the fallback.
      </div>
      {variants.map((variantId, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1 space-y-1">
            <input
              type="text"
              value={variantId}
              onChange={(e) => {
                const copy = variants.slice();
                copy[i] = e.target.value;
                setVariants(copy);
              }}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono"
            />
            <TextureRow category="biome_wall" id={variantId} hideLabel />
          </div>
          <button
            type="button"
            onClick={() => {
              const copy = variants.slice();
              copy.splice(i, 1);
              setVariants(copy);
            }}
            className="text-[10px] text-zinc-500 hover:text-red-400 pt-1"
            title="remove"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setVariants([...variants, nextDefaultId()])}
        className="text-[10px] text-zinc-400 hover:text-zinc-200 px-2 py-0.5 border border-zinc-800 rounded"
      >
        + add variant
      </button>
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

