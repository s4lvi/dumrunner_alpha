'use client';

// Recipe editor. Three-pane: sidebar list, centre form, right
// pane sanity check (resolved references + grouped recipes that
// share the same output).
//
// Recipe shape is meatier than blueprints: discriminated inputs
// (material / ammo / weapon-as-component) and outputs (seven
// variants). The form keeps the same RowRenderer pattern as
// other list editors — each input gets a kind picker that swaps
// the rest of the row.
//
// Cross-area validation on save (in the API route) checks every
// referenced id resolves: materials, ammo, weapons, blueprints,
// attachment defs, consumables, upgrades, building kinds.

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import type { z } from 'zod';
import type { BlueprintDef, RecipeDef, WeaponDef } from '@dumrunner/shared';
import {
  ATTACHMENT_DEFS,
  BUILDING_REGISTRY,
  CONSUMABLES,
  MATERIALS,
  RecipeDefSchema,
  UPGRADES,
} from '@dumrunner/shared';
import {
  Button,
  ConfirmButton,
  EnumField,
  FieldRow,
  FormSection,
  NumberField,
  TextField,
} from '../_components/Form';
import { EntityList } from '../_components/EntityList';
import { useEntityEditor } from '../_components/useEntityEditor';
import { listEntities } from '@/lib/editorContentClient';
import { useEffect, useState } from 'react';

// Closed kind unions for the input + output discriminators. Match
// shared/crafting.ts; only fields the editor needs to render.
const INPUT_KINDS = ['material', 'ammo', 'weapon'] as const;
type InputKind = (typeof INPUT_KINDS)[number];

const OUTPUT_KINDS = [
  'placeable',
  'ammo',
  'weapon',
  'attachment',
  'consumable',
  'material',
  'upgrade',
] as const;
type OutputKind = (typeof OUTPUT_KINDS)[number];

// Same 7 ammo kinds hardcoded in the weapon editor — until ammo
// is its own JSON registry, this is the live set.
const AMMO_KINDS = [
  'pistol_basic',
  'smg_basic',
  'shotgun_shells',
  'rifle_rounds',
  'sniper_rounds',
  'heavy_slugs',
  'energy_cells',
] as const;

function makeBlank(id = 'new_recipe'): RecipeDef {
  return {
    id,
    name: 'New Recipe',
    inputs: [{ kind: 'material', materialId: 'scrap', count: 1 }],
    output: { kind: 'material', materialId: 'scrap', count: 1 },
    workstation: 'workbench',
    blueprintId: null,
  };
}

export default function RecipeEditorPage() {
  return (
    <Suspense fallback={null}>
      <RecipeEditorBody />
    </Suspense>
  );
}

function RecipeEditorBody() {
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
  } = useEntityEditor<RecipeDef>('recipes', {
    makeBlank,
    newIdPrefix: 'recipe',
    schema: RecipeDefSchema as unknown as z.ZodType<RecipeDef>,
  });

  // Cross-reference id pickers. Weapons + blueprints come from
  // their own JSON content; everything else is a closed runtime
  // registry that we read directly.
  const [weaponIds, setWeaponIds] = useState<string[]>([]);
  const [blueprintIds, setBlueprintIds] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [weapons, blueprints] = await Promise.all([
          listEntities('weapons') as Promise<WeaponDef[]>,
          listEntities('blueprints') as Promise<BlueprintDef[]>,
        ]);
        if (cancelled) return;
        setWeaponIds(weapons.map((w) => w.id).sort());
        setBlueprintIds(blueprints.map((b) => b.id).sort());
      } catch {
        /* fall back to free text if listing fails */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const materialIds = useMemo(
    () => (Object.keys(MATERIALS) as string[]).sort(),
    [],
  );
  const buildingIds = useMemo(
    () => Object.keys(BUILDING_REGISTRY).sort(),
    [],
  );
  const consumableIds = useMemo(() => Object.keys(CONSUMABLES).sort(), []);
  const upgradeIds = useMemo(() => Object.keys(UPGRADES).sort(), []);
  const attachmentIds = useMemo(
    () => Object.keys(ATTACHMENT_DEFS).sort(),
    [],
  );
  // Workstations are the building kinds with isWorkstation: true,
  // plus the "(none)" option for hand-craftable basics.
  const workstationIds = useMemo(() => {
    const out: string[] = [];
    for (const [k, def] of Object.entries(BUILDING_REGISTRY)) {
      if (def.isWorkstation) out.push(k);
    }
    return out.sort();
  }, []);

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const ws = (a.workstation ?? '').localeCompare(b.workstation ?? '');
      if (ws !== 0) return ws;
      const ok = a.output.kind.localeCompare(b.output.kind);
      if (ok !== 0) return ok;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  const localErrors = useMemo(() => {
    const errs: string[] = [];
    if (!draft) return errs;
    if (!draft.id.match(/^[a-z0-9_-]+$/)) {
      errs.push('id must be lowercase alphanumeric / underscore / hyphen');
    }
    if (draft.inputs.length === 0) {
      errs.push('a recipe needs at least one input');
    }
    if (
      draft.blueprintId !== null &&
      blueprintIds.length > 0 &&
      !blueprintIds.includes(draft.blueprintId)
    ) {
      errs.push(`blueprint "${draft.blueprintId}" doesn't exist`);
    }
    return errs;
  }, [draft, blueprintIds]);

  const blockSave = localErrors.length > 0 || !canSave;

  return (
    <div className="flex h-full">
      <EntityList<RecipeDef>
        title="Recipes"
        entries={sortedEntries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={createNew}
        emptyHint="No recipes yet. Click + new to create one."
        renderItem={(r) => (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider w-12 truncate">
              {r.workstation ?? 'hand'}
            </span>
            <span className="flex-1 truncate">{r.name}</span>
            <span className="text-[9px] text-zinc-500">{r.output.kind}</span>
          </div>
        )}
      />

      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 max-w-2xl">
          {draft === null ? (
            <p className="text-sm text-zinc-500">
              Select a recipe on the left, or click <kbd>+ new</kbd> to
              create one.
            </p>
          ) : (
            <>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h1 className="text-lg font-bold text-zinc-200">{draft.name}</h1>
                  <div className="text-[10px] text-zinc-500 font-mono">
                    {draft.id}
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
                  label="id"
                  value={draft.id}
                  onChange={(v) => setDraft({ ...draft, id: v })}
                  hint="Lowercase slug. Used as filename + the recipeId blueprints reference."
                  monospace
                />
                <TextField
                  label="name"
                  value={draft.name}
                  onChange={(v) => setDraft({ ...draft, name: v })}
                  hint="Player-facing — shown in the craft modal."
                />
              </FormSection>

              <FormSection title="Crafting">
                <FieldRow
                  label="workstation"
                  hint="Empty = hand-craftable from inventory anywhere. Specialised stations gate higher-tier outputs."
                >
                  <select
                    value={draft.workstation ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        workstation: e.target.value || null,
                      })
                    }
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    <option value="">(none / hand-craftable)</option>
                    {workstationIds.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </FieldRow>
                <FieldRow
                  label="blueprintId"
                  hint="Empty = always known. Otherwise the player must have purchased the named blueprint."
                >
                  <select
                    value={draft.blueprintId ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        blueprintId: e.target.value || null,
                      })
                    }
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    <option value="">(none / always known)</option>
                    {blueprintIds.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </FieldRow>
                <NumberField
                  label="craft time (ms)"
                  value={draft.craftTimeMs ?? 0}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      craftTimeMs: v === 0 ? undefined : v,
                    })
                  }
                  min={0}
                  step={500}
                  hint="0 = instant (used for hand-craftable basics). Station recipes set this for the 'queue and go scavenge' flow."
                />
                <NumberField
                  label="station tier required"
                  value={draft.stationTier ?? 1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stationTier: v === 1 ? undefined : v,
                    })
                  }
                  min={1}
                  max={4}
                  step={1}
                  hint="Bench-tier gate. 1 = no gate (default). Higher = needs an upgraded station."
                />
              </FormSection>

              <FormSection title="Inputs">
                <div className="space-y-2">
                  {draft.inputs.map((input, i) => (
                    <InputRow
                      key={i}
                      input={input}
                      materialIds={materialIds}
                      ammoIds={[...AMMO_KINDS]}
                      weaponIds={weaponIds}
                      onChange={(next) => {
                        const inputs = draft.inputs.slice();
                        inputs[i] = next;
                        setDraft({ ...draft, inputs });
                      }}
                      onRemove={() => {
                        const inputs = draft.inputs.slice();
                        inputs.splice(i, 1);
                        setDraft({ ...draft, inputs });
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className="text-[10px] text-zinc-400 hover:text-zinc-200 px-2 py-0.5 border border-zinc-800 rounded"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        inputs: [
                          ...draft.inputs,
                          { kind: 'material', materialId: 'scrap', count: 1 },
                        ],
                      })
                    }
                  >
                    + add input
                  </button>
                </div>
              </FormSection>

              <FormSection title="Output">
                <OutputBlock
                  output={draft.output}
                  materialIds={materialIds}
                  ammoIds={[...AMMO_KINDS]}
                  weaponIds={weaponIds}
                  buildingIds={buildingIds}
                  consumableIds={consumableIds}
                  upgradeIds={upgradeIds}
                  attachmentIds={attachmentIds}
                  onChange={(next) => setDraft({ ...draft, output: next })}
                />
              </FormSection>

              <div className="mt-6 text-[11px]">
                <Link
                  href={`/editor/blueprints?id=${encodeURIComponent('bp_' + draft.id)}`}
                  className="text-zinc-300 hover:text-zinc-100 underline decoration-zinc-700 hover:decoration-zinc-400"
                >
                  Manage blueprint that unlocks this recipe →
                </Link>
              </div>
            </>
          )}
        </div>

        {/* Right pane: at-a-glance summary so the author sees the
            recipe's shape before saving. */}
        <aside className="w-[320px] shrink-0 border-l border-zinc-800 overflow-y-auto">
          <div className="px-3 py-2 border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
            Summary
          </div>
          {draft ? <RecipeSummary recipe={draft} /> : null}
        </aside>
      </main>
    </div>
  );
}

function InputRow({
  input,
  materialIds,
  ammoIds,
  weaponIds,
  onChange,
  onRemove,
}: {
  input: RecipeDef['inputs'][number];
  materialIds: string[];
  ammoIds: string[];
  weaponIds: string[];
  onChange: (next: RecipeDef['inputs'][number]) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-end gap-2 text-xs">
      <select
        value={input.kind}
        onChange={(e) => {
          const k = e.target.value as InputKind;
          if (k === 'material') {
            onChange({ kind: 'material', materialId: materialIds[0] ?? 'scrap', count: 1 });
          } else if (k === 'ammo') {
            onChange({ kind: 'ammo', ammoId: ammoIds[0] ?? 'pistol_basic', count: 1 });
          } else {
            onChange({ kind: 'weapon', weaponId: weaponIds[0] ?? 'pistol', count: 1 });
          }
        }}
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
      >
        {INPUT_KINDS.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      {input.kind === 'material' && (
        <IdSelect
          value={input.materialId}
          options={materialIds}
          onChange={(v) => onChange({ ...input, materialId: v })}
        />
      )}
      {input.kind === 'ammo' && (
        <IdSelect
          value={input.ammoId}
          options={ammoIds}
          onChange={(v) => onChange({ ...input, ammoId: v })}
        />
      )}
      {input.kind === 'weapon' && (
        <IdSelect
          value={input.weaponId}
          options={weaponIds}
          onChange={(v) => onChange({ ...input, weaponId: v })}
        />
      )}
      <input
        type="number"
        value={input.count}
        min={1}
        step={1}
        onChange={(e) =>
          onChange({ ...input, count: Math.max(1, parseInt(e.target.value, 10) || 1) })
        }
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 w-16"
      />
      <button
        type="button"
        onClick={onRemove}
        className="text-zinc-500 hover:text-red-400 pb-1"
        title="remove input"
      >
        ×
      </button>
    </div>
  );
}

function OutputBlock({
  output,
  materialIds,
  ammoIds,
  weaponIds,
  buildingIds,
  consumableIds,
  upgradeIds,
  attachmentIds,
  onChange,
}: {
  output: RecipeDef['output'];
  materialIds: string[];
  ammoIds: string[];
  weaponIds: string[];
  buildingIds: string[];
  consumableIds: string[];
  upgradeIds: string[];
  attachmentIds: string[];
  onChange: (next: RecipeDef['output']) => void;
}) {
  function switchKind(k: OutputKind) {
    switch (k) {
      case 'placeable':
        onChange({ kind: 'placeable', buildingKind: buildingIds[0] ?? 'wall', count: 1 });
        return;
      case 'ammo':
        onChange({ kind: 'ammo', ammoId: ammoIds[0] ?? 'pistol_basic', count: 1 });
        return;
      case 'weapon':
        onChange({ kind: 'weapon', weaponId: weaponIds[0] ?? 'pistol' });
        return;
      case 'attachment':
        onChange({ kind: 'attachment', defId: attachmentIds[0] ?? '', count: 1 });
        return;
      case 'consumable':
        onChange({ kind: 'consumable', consumableId: consumableIds[0] ?? '', count: 1 });
        return;
      case 'material':
        onChange({ kind: 'material', materialId: materialIds[0] ?? 'scrap', count: 1 });
        return;
      case 'upgrade':
        onChange({ kind: 'upgrade', upgradeId: upgradeIds[0] ?? '', count: 1 });
        return;
    }
  }
  return (
    <div className="space-y-2">
      <EnumField<OutputKind>
        label="kind"
        value={output.kind}
        options={OUTPUT_KINDS}
        onChange={switchKind}
      />
      {output.kind === 'material' && (
        <>
          <IdPickerRow
            label="material"
            value={output.materialId}
            options={materialIds}
            onChange={(v) => onChange({ ...output, materialId: v })}
          />
          <CountRow
            value={output.count}
            onChange={(v) => onChange({ ...output, count: v })}
          />
        </>
      )}
      {output.kind === 'ammo' && (
        <>
          <IdPickerRow
            label="ammo"
            value={output.ammoId}
            options={ammoIds}
            onChange={(v) => onChange({ ...output, ammoId: v })}
          />
          <CountRow
            value={output.count}
            onChange={(v) => onChange({ ...output, count: v })}
          />
        </>
      )}
      {output.kind === 'weapon' && (
        <IdPickerRow
          label="weapon"
          value={output.weaponId}
          options={weaponIds}
          onChange={(v) => onChange({ ...output, weaponId: v })}
        />
      )}
      {output.kind === 'placeable' && (
        <>
          <IdPickerRow
            label="building"
            value={output.buildingKind}
            options={buildingIds}
            onChange={(v) => onChange({ ...output, buildingKind: v })}
          />
          <CountRow
            value={output.count}
            onChange={(v) => onChange({ ...output, count: v })}
          />
        </>
      )}
      {output.kind === 'attachment' && (
        <>
          <IdPickerRow
            label="attachment def"
            value={output.defId}
            options={attachmentIds}
            onChange={(v) => onChange({ ...output, defId: v })}
          />
          <CountRow
            value={output.count}
            onChange={(v) => onChange({ ...output, count: v })}
          />
        </>
      )}
      {output.kind === 'consumable' && (
        <>
          <IdPickerRow
            label="consumable"
            value={output.consumableId}
            options={consumableIds}
            onChange={(v) => onChange({ ...output, consumableId: v })}
          />
          <CountRow
            value={output.count}
            onChange={(v) => onChange({ ...output, count: v })}
          />
        </>
      )}
      {output.kind === 'upgrade' && (
        <>
          <IdPickerRow
            label="upgrade"
            value={output.upgradeId}
            options={upgradeIds}
            onChange={(v) => onChange({ ...output, upgradeId: v })}
          />
          <CountRow
            value={output.count}
            onChange={(v) => onChange({ ...output, count: v })}
          />
        </>
      )}
    </div>
  );
}

function IdSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 flex-1"
    >
      {!options.includes(value) && (
        <option value={value} className="text-amber-300">
          {value} (unresolved)
        </option>
      )}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function IdPickerRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <FieldRow label={label}>
      <IdSelect value={value} options={options} onChange={onChange} />
    </FieldRow>
  );
}

function CountRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <NumberField
      label="count"
      value={value}
      onChange={(v) => onChange(Math.max(1, Math.floor(v)))}
      min={1}
      step={1}
    />
  );
}

function RecipeSummary({ recipe }: { recipe: RecipeDef }) {
  return (
    <div className="p-3 text-[11px] text-zinc-300 space-y-3">
      <section>
        <div className="text-[10px] uppercase text-zinc-500 mb-1">Inputs</div>
        {recipe.inputs.map((i, idx) => (
          <div key={idx} className="font-mono text-[11px]">
            ×{i.count}{' '}
            {i.kind === 'material'
              ? i.materialId
              : i.kind === 'ammo'
                ? i.ammoId
                : i.kind === 'part'
                  ? `${i.weaponClass ? `${i.weaponClass} ` : ''}${i.slot}`
                  : i.weaponId}
            <span className="text-zinc-600"> ({i.kind})</span>
          </div>
        ))}
      </section>
      <section>
        <div className="text-[10px] uppercase text-zinc-500 mb-1">Output</div>
        <div className="font-mono text-[11px]">
          {summarizeOutput(recipe.output)}
        </div>
      </section>
      <section>
        <div className="text-[10px] uppercase text-zinc-500 mb-1">Gating</div>
        <div className="text-[11px]">
          station: <span className="font-mono">{recipe.workstation ?? '(hand)'}</span>
        </div>
        <div className="text-[11px]">
          blueprint: <span className="font-mono">{recipe.blueprintId ?? '(none)'}</span>
        </div>
        <div className="text-[11px]">
          time: <span className="font-mono">{((recipe.craftTimeMs ?? 0) / 1000).toFixed(1)}s</span>
        </div>
        <div className="text-[11px]">
          station tier: <span className="font-mono">≥{recipe.stationTier ?? 1}</span>
        </div>
      </section>
    </div>
  );
}

function summarizeOutput(out: RecipeDef['output']): string {
  switch (out.kind) {
    case 'placeable':
      return `×${out.count} ${out.buildingKind} (placeable)`;
    case 'ammo':
      return `×${out.count} ${out.ammoId} (ammo)`;
    case 'weapon':
      return `${out.weaponId} (weapon)`;
    case 'attachment':
      return `×${out.count} ${out.defId} (attachment)`;
    case 'consumable':
      return `×${out.count} ${out.consumableId} (consumable)`;
    case 'material':
      return `×${out.count} ${out.materialId} (material)`;
    case 'upgrade':
      return `×${out.count} ${out.upgradeId} (upgrade)`;
  }
}
