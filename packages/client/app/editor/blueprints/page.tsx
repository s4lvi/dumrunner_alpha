'use client';

// Blueprint editor. Three-pane: sidebar list, centre form, right
// pane DAG preview. Edits write JSON to packages/shared/content/
// blueprints/<id>.json via /api/editor/content/blueprints; the
// server's content watcher reloads the runtime catalog on save,
// and connected clients pick up the fresh data on next welcome.
//
// Cross-area validation (recipe exists, prereqs resolve, DAG
// acyclic) runs server-side in the API route. The form surfaces
// the most common errors inline before save (self-prereq,
// missing recipe id) so authors get feedback without a round
// trip.

import { Suspense, useMemo, useState } from 'react';
import type { z } from 'zod';
import type { BlueprintDef, BlueprintTier, Recipe } from '@dumrunner/shared';
import { BlueprintDefSchema, RECIPES } from '@dumrunner/shared';
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

const TIERS: readonly BlueprintTier[] = [
  'common',
  'uncommon',
  'rare',
  'legendary',
] as const;

const TIER_COLOR: Record<BlueprintTier, string> = {
  common: '#52525b',
  uncommon: '#3b82f6',
  rare: '#a855f7',
  legendary: '#f59e0b',
};

const TIER_RANK: Record<BlueprintTier, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  legendary: 3,
};

function makeBlank(id = 'new_blueprint'): BlueprintDef {
  return {
    id,
    recipeId: '',
    displayName: 'New Blueprint',
    description: '',
    cost: 4,
    tier: 'common',
  };
}

// Short label for a recipe — "weapon: Sniper Rifle", "attachment:
// Foregrip", etc. Used in the recipeId picker so the author can
// pick by output rather than by raw recipe id.
function recipeLabel(r: Recipe): string {
  const out = r.output;
  switch (out.kind) {
    case 'weapon':
      return `weapon: ${out.weaponId}`;
    case 'attachment':
      return `attachment: ${out.defId}`;
    case 'placeable':
      return `placeable: ${out.buildingKind}`;
    case 'ammo':
      return `ammo: ${out.ammoId} ×${out.count}`;
    case 'consumable':
      return `consumable: ${out.consumableId}`;
    case 'material':
      return `material: ${out.materialId} ×${out.count}`;
    case 'upgrade':
      return `upgrade: ${out.upgradeId}`;
  }
}

export default function BlueprintEditorPage() {
  return (
    <Suspense fallback={null}>
      <BlueprintEditorBody />
    </Suspense>
  );
}

function BlueprintEditorBody() {
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
  } = useEntityEditor<BlueprintDef>('blueprints', {
    makeBlank,
    newIdPrefix: 'bp',
    schema: BlueprintDefSchema as unknown as z.ZodType<BlueprintDef>,
  });

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const tr = TIER_RANK[b.tier] - TIER_RANK[a.tier];
      if (tr !== 0) return tr;
      const cr = b.cost - a.cost;
      if (cr !== 0) return cr;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [entries]);

  // For the DAG preview: build a virtual catalog that includes the
  // current draft so unsaved edits show up. Keyed off draft +
  // entries so we don't recompute on every keystroke unless the
  // shape changes.
  const draftCatalog = useMemo(() => {
    const map = new Map<string, BlueprintDef>();
    for (const e of entries) map.set(e.id, e);
    if (draft) map.set(draft.id, draft);
    return map;
  }, [entries, draft]);

  // Quick local validation surfaces — server enforces these too,
  // but inline feedback is faster than a save round-trip.
  const localErrors = useMemo(() => {
    const errs: string[] = [];
    if (!draft) return errs;
    if (!draft.id.match(/^[a-z0-9_-]+$/)) {
      errs.push('id must be lowercase alphanumeric / underscore / hyphen');
    }
    if (!draft.recipeId) {
      errs.push('recipeId is required');
    } else if (!(draft.recipeId in RECIPES)) {
      errs.push(`recipeId "${draft.recipeId}" doesn't exist in RECIPES`);
    }
    const prereqs = draft.prerequisites ?? [];
    if (prereqs.includes(draft.id)) {
      errs.push(`${draft.id} can't list itself as a prerequisite`);
    }
    for (const pre of prereqs) {
      if (pre === draft.id) continue;
      if (!entries.some((e) => e.id === pre)) {
        errs.push(`prerequisite "${pre}" doesn't exist`);
      }
    }
    // Local cycle check using the draft catalog so the author
    // sees the conflict before save.
    if (prereqs.length > 0 && findCycle(draftCatalog, draft.id)) {
      errs.push('prerequisite cycle (one of your prereqs eventually depends on this blueprint)');
    }
    return errs;
  }, [draft, entries, draftCatalog]);

  const blockSave = localErrors.length > 0 || !canSave;

  function togglePrereq(id: string): void {
    if (!draft) return;
    const cur = draft.prerequisites ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setDraft({ ...draft, prerequisites: next.length > 0 ? next : undefined });
  }

  return (
    <div className="flex h-full">
      <EntityList<BlueprintDef>
        title="Blueprints"
        entries={sortedEntries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={createNew}
        emptyHint="No blueprints yet. Click + new to create one."
        renderItem={(b) => (
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{ background: TIER_COLOR[b.tier] }}
            />
            <span className="flex-1 truncate">{b.displayName}</span>
            <span className="text-[10px] text-zinc-500">
              {b.cost} ◆
            </span>
            {b.hidden && (
              <span className="text-[9px] text-zinc-600">hidden</span>
            )}
          </div>
        )}
      />

      <main className="flex-1 flex overflow-hidden">
        {/* Centre form */}
        <div className="flex-1 overflow-y-auto p-4 max-w-2xl">
          {draft === null ? (
            <p className="text-sm text-zinc-500">
              Select a blueprint on the left, or click <kbd>+ new</kbd> to
              create one.
            </p>
          ) : (
            <>
              <div className="flex justify-between items-start mb-4">
                <h1 className="text-lg font-bold text-zinc-200">
                  {draft.displayName || draft.id}
                </h1>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={async () => {
                      const ok = await save();
                      if (ok) {
                        /* no-op; useEntityEditor handles selection */
                      }
                    }}
                    disabled={blockSave}
                  >
                    {saving ? 'saving…' : 'save'}
                  </Button>
                  <ConfirmButton onConfirm={remove} variant="danger">
                    delete
                  </ConfirmButton>
                </div>
              </div>

              {error && (
                <div className="mb-3 px-3 py-2 rounded bg-red-950/60 border border-red-900 text-red-200 text-xs">
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
                  hint="Lowercase slug. Used as filename + cross-reference key. Renaming is allowed; the save flow re-selects on the new id."
                  monospace
                />
                <TextField
                  label="display name"
                  value={draft.displayName}
                  onChange={(v) => setDraft({ ...draft, displayName: v })}
                />
                <TextField
                  label="description"
                  value={draft.description}
                  onChange={(v) => setDraft({ ...draft, description: v })}
                  hint="Shown in the uplink tooltip and any other player-facing surface."
                />
              </FormSection>

              <FormSection title="Economy">
                <NumberField
                  label="cost (artifacts)"
                  value={draft.cost}
                  onChange={(v) => setDraft({ ...draft, cost: v })}
                  min={0}
                  step={1}
                />
                <EnumField<BlueprintTier>
                  label="tier"
                  value={draft.tier}
                  options={TIERS}
                  onChange={(v) => setDraft({ ...draft, tier: v })}
                  hint="Legendary blueprints are intended to survive perihelion (the persistent set). Today the runtime path for that write is still unwired — flag the legendary tier here regardless; the fix lands separately."
                />
                <CheckboxField
                  label="hidden"
                  value={draft.hidden ?? false}
                  onChange={(v) =>
                    setDraft({ ...draft, hidden: v ? true : undefined })
                  }
                  hint="Hides from uplink shop + craft modals; lookup by id still works (legacy grants)."
                />
              </FormSection>

              <FormSection title="Unlocks">
                <FieldRow
                  label="recipeId"
                  hint="The recipe this blueprint unlocks for crafting."
                >
                  <select
                    value={draft.recipeId}
                    onChange={(e) =>
                      setDraft({ ...draft, recipeId: e.target.value })
                    }
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    <option value="">— select —</option>
                    {Object.values(RECIPES)
                      .sort((a, b) => a.id.localeCompare(b.id))
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id} — {recipeLabel(r)}
                        </option>
                      ))}
                  </select>
                </FieldRow>
              </FormSection>

              <FormSection title="Prerequisites">
                <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
                  Click a blueprint to toggle it as a prerequisite. Players
                  must own every checked entry before this one becomes
                  purchasable.
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sortedEntries
                    .filter((b) => b.id !== draft.id)
                    .map((b) => {
                      const on = (draft.prerequisites ?? []).includes(b.id);
                      return (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => togglePrereq(b.id)}
                          className={`text-[11px] px-2 py-0.5 rounded border flex items-center gap-1.5 ${
                            on
                              ? 'bg-emerald-950/60 border-emerald-700 text-emerald-200'
                              : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900/60'
                          }`}
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full inline-block"
                            style={{ background: TIER_COLOR[b.tier] }}
                          />
                          {b.displayName}
                        </button>
                      );
                    })}
                </div>
              </FormSection>

              <DependentsList
                ownId={draft.id}
                all={entries}
                onSelect={setSelectedId}
              />
            </>
          )}
        </div>

        {/* Right: DAG preview */}
        <aside className="w-[420px] shrink-0 border-l border-zinc-800 overflow-hidden flex flex-col">
          <div className="px-3 py-2 border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
            DAG preview
            <span className="ml-2 text-zinc-600 normal-case">
              (draft applied)
            </span>
          </div>
          <div className="flex-1 overflow-auto">
            <DagPreview
              catalog={draftCatalog}
              selectedId={draft?.id ?? null}
            />
          </div>
        </aside>
      </main>
    </div>
  );
}

function DependentsList({
  ownId,
  all,
  onSelect,
}: {
  ownId: string;
  all: BlueprintDef[];
  onSelect: (id: string) => void;
}) {
  const dependents = all.filter((b) =>
    (b.prerequisites ?? []).includes(ownId),
  );
  if (dependents.length === 0) return null;
  return (
    <FormSection title={`Dependents (${dependents.length})`}>
      <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
        Other blueprints that list this one as a prerequisite. Deleting or
        renaming this entry will break their unlock chain.
      </div>
      <div className="space-y-1">
        {dependents.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onSelect(b.id)}
            className="text-[11px] text-zinc-300 hover:text-zinc-100 block text-left"
          >
            <span
              className="w-1.5 h-1.5 rounded-full inline-block mr-1.5 align-middle"
              style={{ background: TIER_COLOR[b.tier] }}
            />
            {b.displayName}
            <span className="text-zinc-600"> ({b.id})</span>
          </button>
        ))}
      </div>
    </FormSection>
  );
}

// ---- DAG preview ----
//
// Editor-side SVG render of the prerequisite graph. Same x = tier
// depth / y = column layout the runtime view uses, but without
// player-state colouring — every node shows tier dot + cost only.
// The currently-edited blueprint glows orange. Drag-to-pan.

const NODE_W = 140;
const NODE_H = 48;
const TIER_PITCH_X = 180;
const COLUMN_PITCH_Y = 64;
const PAD = 16;

function DagPreview({
  catalog,
  selectedId,
}: {
  catalog: Map<string, BlueprintDef>;
  selectedId: string | null;
}) {
  const layout = useMemo(() => {
    const tiers = computeTiers(catalog);
    const visible = [...catalog.values()].filter((b) => !b.hidden);
    const byTier = new Map<number, BlueprintDef[]>();
    for (const bp of visible) {
      const t = tiers.get(bp.id) ?? 0;
      const list = byTier.get(t) ?? [];
      list.push(bp);
      byTier.set(t, list);
    }
    for (const list of byTier.values()) {
      list.sort(
        (a, b) =>
          a.cost - b.cost || a.displayName.localeCompare(b.displayName),
      );
    }
    const positions = new Map<string, { x: number; y: number }>();
    let maxTier = 0;
    let maxCol = 0;
    for (const [tier, list] of byTier) {
      if (tier > maxTier) maxTier = tier;
      list.forEach((bp, i) => {
        positions.set(bp.id, {
          x: PAD + tier * TIER_PITCH_X,
          y: PAD + i * COLUMN_PITCH_Y,
        });
        if (i > maxCol) maxCol = i;
      });
    }
    return {
      positions,
      visible,
      width: PAD * 2 + (maxTier + 1) * TIER_PITCH_X,
      height: PAD * 2 + (maxCol + 1) * COLUMN_PITCH_Y,
    };
  }, [catalog]);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{
    sx: number;
    sy: number;
    px: number;
    py: number;
  } | null>(null);

  return (
    <div
      className="relative w-full h-full overflow-hidden cursor-grab active:cursor-grabbing select-none"
      onMouseDown={(e) =>
        setDrag({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y })
      }
      onMouseMove={(e) => {
        if (!drag) return;
        setPan({
          x: drag.px + (e.clientX - drag.sx),
          y: drag.py + (e.clientY - drag.sy),
        });
      }}
      onMouseUp={() => setDrag(null)}
      onMouseLeave={() => setDrag(null)}
      onDoubleClick={() => setPan({ x: 0, y: 0 })}
    >
      <svg
        width={layout.width}
        height={layout.height}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px)`,
          display: 'block',
        }}
      >
        {layout.visible.map((bp) => {
          const to = layout.positions.get(bp.id);
          if (!to) return null;
          return (bp.prerequisites ?? []).map((preId) => {
            const from = layout.positions.get(preId);
            if (!from) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const midX = (x1 + x2) / 2;
            const path = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
            const touchesSelected =
              bp.id === selectedId || preId === selectedId;
            return (
              <path
                key={`${preId}->${bp.id}`}
                d={path}
                stroke={touchesSelected ? '#f59e0b' : '#3f3f46'}
                strokeWidth={1.5}
                fill="none"
                opacity={touchesSelected ? 0.9 : 0.5}
              />
            );
          });
        })}
        {layout.visible.map((bp) => {
          const pos = layout.positions.get(bp.id);
          if (!pos) return null;
          const isSelected = bp.id === selectedId;
          return (
            <g
              key={bp.id}
              transform={`translate(${pos.x}, ${pos.y})`}
            >
              <title>{`${bp.id} · ${bp.cost} artifacts · ${bp.tier}`}</title>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={5}
                fill={isSelected ? '#7c2d12' : '#1f1f23'}
                stroke={isSelected ? '#f59e0b' : TIER_COLOR[bp.tier]}
                strokeWidth={isSelected ? 2 : 1}
              />
              <text
                x={NODE_W / 2}
                y={20}
                textAnchor="middle"
                fill="#e4e4e7"
                fontSize={11}
                fontWeight={600}
                pointerEvents="none"
              >
                {bp.displayName.length > 20
                  ? bp.displayName.slice(0, 19) + '…'
                  : bp.displayName}
              </text>
              <text
                x={NODE_W / 2}
                y={36}
                textAnchor="middle"
                fill="#a1a1aa"
                fontSize={9}
                pointerEvents="none"
              >
                {bp.cost} artifact{bp.cost === 1 ? '' : 's'} · {bp.tier}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Topological depth-from-root, recursive memo. Mirrors the
// runtime computeBlueprintTiers in Game.tsx — duplicated rather
// than imported because pulling Game.tsx into the editor would
// drag the whole runtime in.
function computeTiers(
  catalog: Map<string, BlueprintDef>,
): Map<string, number> {
  const tiers = new Map<string, number>();
  function tierOf(id: string): number {
    const cached = tiers.get(id);
    if (cached !== undefined) return cached;
    const bp = catalog.get(id);
    if (!bp || !bp.prerequisites || bp.prerequisites.length === 0) {
      tiers.set(id, 0);
      return 0;
    }
    // Guard against cycles in the draft state — if we recurse
    // into a node already being computed, stop and return 0 to
    // avoid stack overflow. The save-time validator will catch
    // the real error.
    tiers.set(id, 0);
    let max = 0;
    for (const pre of bp.prerequisites) {
      const t = tierOf(pre);
      if (t + 1 > max) max = t + 1;
    }
    tiers.set(id, max);
    return max;
  }
  for (const id of catalog.keys()) tierOf(id);
  return tiers;
}

// DFS cycle check, returns the offending path on hit. Editor-local
// — the API route runs its own check on save with the same
// semantics.
function findCycle(
  catalog: Map<string, BlueprintDef>,
  start: string,
): string[] | null {
  const visiting = new Set<string>();
  const stack: string[] = [];
  function visit(id: string): string[] | null {
    if (visiting.has(id)) {
      const i = stack.indexOf(id);
      const slice = i >= 0 ? stack.slice(i) : stack.slice();
      slice.push(id);
      return slice;
    }
    const entry = catalog.get(id);
    if (!entry) return null;
    visiting.add(id);
    stack.push(id);
    for (const pre of entry.prerequisites ?? []) {
      const found = visit(pre);
      if (found) return found;
    }
    visiting.delete(id);
    stack.pop();
    return null;
  }
  return visit(start);
}
