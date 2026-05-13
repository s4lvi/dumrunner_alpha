'use client';

// Attachment editor. Three-pane: sidebar list grouped by kind,
// centre form (identity + base effect + roll ranges), right pane
// shows a Mk1 / Mk4 / Alien preview of what a fresh instance
// would roll given the current ranges + tier scale.
//
// Attachments are the densest data shape in the editor: three
// kinds (weapon_mod / weapon_affix / suit_affix), each with a
// different `effect` shape, plus an optional `rolls` block of
// per-stat [min, max] tuples. The form keeps each effect field
// independently nullable — set a value to "include this field
// in the effect" — and the rolls block as one collapsible
// section.

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import type {
  AttachmentDefData,
  WeaponFamilyKind,
} from '@dumrunner/shared';
import {
  Button,
  EnumField,
  FieldRow,
  FormSection,
  NumberField,
  TextField,
} from '../_components/Form';
import { EntityList } from '../_components/EntityList';
import { useEntityEditor } from '../_components/useEntityEditor';

const KINDS = ['weapon_mod', 'weapon_affix', 'suit_affix'] as const;
type Kind = (typeof KINDS)[number];

const PIECE_KINDS = ['frame', 'grip', 'magazine', 'barrel'] as const;
type PieceKind = (typeof PIECE_KINDS)[number];

const SUIT_SLOT_KINDS = [
  'chassis',
  'plating',
  'life_support',
  'utility_mod',
  'cargo_grid',
] as const;
type SuitSlotKind = (typeof SUIT_SLOT_KINDS)[number];

// Mirrors shared/inventory.ts WeaponFamily. 'melee' included for
// completeness even though most attachments target ranged.
const WEAPON_FAMILIES: readonly (WeaponFamilyKind | 'any')[] = [
  'any',
  'pistol',
  'smg',
  'shotgun',
  'rifle',
  'sniper',
  'heavy',
  'energy',
  'melee',
] as const;

const IMBUE_KINDS = ['burn_dps', 'poison_dps', 'slow_pct'] as const;
type ImbueKind = (typeof IMBUE_KINDS)[number];

const KIND_LABEL: Record<Kind, string> = {
  weapon_mod: 'Weapon mod',
  weapon_affix: 'Weapon affix',
  suit_affix: 'Suit affix',
};

function makeBlank(id = 'new_attachment'): AttachmentDefData {
  return {
    kind: 'weapon_mod',
    id,
    displayName: 'New Mod',
    description: '',
    adjective: 'Custom',
    family: null,
    effect: {},
  };
}

export default function AttachmentEditorPage() {
  return (
    <Suspense fallback={null}>
      <AttachmentEditorBody />
    </Suspense>
  );
}

function AttachmentEditorBody() {
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
  } = useEntityEditor<AttachmentDefData>('attachments', {
    makeBlank,
    newIdPrefix: 'att',
  });

  const sorted = useMemo(() => {
    return [...entries].sort((a, b) => {
      const k = a.kind.localeCompare(b.kind);
      if (k !== 0) return k;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [entries]);

  const localErrors = useMemo(() => {
    const errs: string[] = [];
    if (!draft) return errs;
    if (!draft.id.match(/^[a-z0-9_-]+$/)) {
      errs.push('id must be lowercase alphanumeric / underscore / hyphen');
    }
    if (!draft.adjective.trim()) {
      errs.push(
        'adjective is required — used in the weapon-name composition',
      );
    }
    return errs;
  }, [draft]);

  const blockSave = localErrors.length > 0 || saving;

  return (
    <div className="flex h-full">
      <EntityList<AttachmentDefData>
        title="Attachments"
        entries={sorted}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={createNew}
        emptyHint="No attachments yet. Click + new to create one."
        renderItem={(a) => (
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider w-16 truncate text-zinc-500">
              {a.kind === 'weapon_mod'
                ? 'mod'
                : a.kind === 'weapon_affix'
                  ? 'w-aff'
                  : 's-aff'}
            </span>
            <span className="flex-1 truncate">{a.displayName}</span>
          </div>
        )}
      />

      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 max-w-2xl">
          {draft === null ? (
            <p className="text-sm text-zinc-500">
              Select an attachment on the left, or click <kbd>+ new</kbd> to
              create one.
            </p>
          ) : (
            <>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h1 className="text-lg font-bold text-zinc-200">
                    {draft.displayName}
                  </h1>
                  <div className="text-[10px] text-zinc-500 font-mono">
                    {draft.id} · {KIND_LABEL[draft.kind]}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={save} disabled={blockSave}>
                    {saving ? 'saving…' : 'save'}
                  </Button>
                  <Button onClick={remove} variant="danger">
                    delete
                  </Button>
                </div>
              </div>

              {error && (
                <div className="mb-3 px-3 py-2 rounded bg-red-950/60 border border-red-900 text-red-200 text-xs whitespace-pre-line">
                  {error}
                </div>
              )}
              {localErrors.length > 0 && (
                <div className="mb-3 px-3 py-2 rounded bg-amber-950/40 border border-amber-900/80 text-amber-200 text-xs space-y-1">
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
                  hint="Lowercase slug. Recipes reference this id via output.defId."
                  monospace
                />
                <TextField
                  label="display name"
                  value={draft.displayName}
                  onChange={(v) => setDraft({ ...draft, displayName: v })}
                />
                <TextField
                  label="adjective"
                  value={draft.adjective}
                  onChange={(v) => setDraft({ ...draft, adjective: v })}
                  hint="Borderlands-style word the weapon picks up when this is attached. Stacks in piece-then-mod order, capped at 3."
                />
                <TextField
                  label="description"
                  value={draft.description}
                  onChange={(v) => setDraft({ ...draft, description: v })}
                />
                <EnumField<Kind>
                  label="kind"
                  value={draft.kind}
                  options={KINDS}
                  onChange={(k) => setDraft(rekind(draft, k))}
                  hint="Switching kind rebuilds the effect block — pre-existing fields incompatible with the new kind are dropped."
                />
              </FormSection>

              {(draft.kind === 'weapon_mod' || draft.kind === 'weapon_affix') && (
                <FormSection title="Weapon compatibility">
                  <FieldRow
                    label="family"
                    hint="`any` = applies to every ranged family. Otherwise gates the attachment to one family's mod / piece slots."
                  >
                    <select
                      value={draft.family ?? 'any'}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft({
                          ...draft,
                          family:
                            v === 'any' ? null : (v as WeaponFamilyKind),
                        } as AttachmentDefData);
                      }}
                      className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                    >
                      {WEAPON_FAMILIES.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </FieldRow>
                  {draft.kind === 'weapon_affix' && (
                    <EnumField<PieceKind>
                      label="piece slot"
                      value={draft.pieceKind}
                      options={PIECE_KINDS}
                      onChange={(v) =>
                        setDraft({ ...draft, pieceKind: v } as AttachmentDefData)
                      }
                    />
                  )}
                </FormSection>
              )}

              {draft.kind === 'suit_affix' && (
                <FormSection title="Suit compatibility">
                  <EnumField<SuitSlotKind>
                    label="slot"
                    value={draft.slotKind}
                    options={SUIT_SLOT_KINDS}
                    onChange={(v) =>
                      setDraft({ ...draft, slotKind: v } as AttachmentDefData)
                    }
                  />
                </FormSection>
              )}

              {(draft.kind === 'weapon_mod' || draft.kind === 'weapon_affix') && (
                <WeaponEffectFields
                  effect={draft.effect}
                  onChange={(next) =>
                    setDraft({ ...draft, effect: next } as AttachmentDefData)
                  }
                />
              )}

              {draft.kind === 'suit_affix' && (
                <SuitEffectFields
                  effect={draft.effect}
                  onChange={(next) =>
                    setDraft({ ...draft, effect: next } as AttachmentDefData)
                  }
                />
              )}

              {(draft.kind === 'weapon_affix' || draft.kind === 'suit_affix') && (
                <FormSection title="Base value">
                  <NumberField
                    label="value"
                    value={draft.value}
                    onChange={(v) =>
                      setDraft({ ...draft, value: v } as AttachmentDefData)
                    }
                    step={0.05}
                    hint="Affix base value displayed in tooltips (used alongside effect for rolling)."
                  />
                </FormSection>
              )}

              {draft.kind === 'weapon_mod' && (
                <FormSection title="Status imbue (optional)">
                  <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
                    If set, every projectile applies this status effect to
                    the target on hit. Leave blank for a vanilla stat-only
                    mod.
                  </div>
                  <FieldRow label="imbue kind">
                    <select
                      value={draft.imbue?.kind ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) {
                          const { imbue: _drop, ...rest } = draft;
                          setDraft(rest as AttachmentDefData);
                        } else {
                          setDraft({
                            ...draft,
                            imbue: {
                              kind: v as ImbueKind,
                              magnitude: draft.imbue?.magnitude ?? 8,
                              durationMs: draft.imbue?.durationMs ?? 4000,
                              label: draft.imbue?.label ?? 'Imbue',
                            },
                          } as AttachmentDefData);
                        }
                      }}
                      className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                    >
                      <option value="">(none)</option>
                      {IMBUE_KINDS.map((k) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </select>
                  </FieldRow>
                  {draft.imbue && (
                    <>
                      <NumberField
                        label="magnitude"
                        value={draft.imbue.magnitude}
                        onChange={(v) =>
                          setDraft({
                            ...draft,
                            imbue: { ...draft.imbue!, magnitude: v },
                          } as AttachmentDefData)
                        }
                        min={0}
                        step={0.5}
                        hint="DPS for burn / poison; 0..1 fraction for slow."
                      />
                      <NumberField
                        label="duration (ms)"
                        value={draft.imbue.durationMs}
                        onChange={(v) =>
                          setDraft({
                            ...draft,
                            imbue: { ...draft.imbue!, durationMs: v },
                          } as AttachmentDefData)
                        }
                        min={100}
                        step={100}
                      />
                      <TextField
                        label="status label"
                        value={draft.imbue.label}
                        onChange={(v) =>
                          setDraft({
                            ...draft,
                            imbue: { ...draft.imbue!, label: v },
                          } as AttachmentDefData)
                        }
                      />
                    </>
                  )}
                </FormSection>
              )}

              <RollRangesSection draft={draft} setDraft={setDraft} />

              <div className="mt-6 text-[11px]">
                <Link
                  href={`/editor/recipes`}
                  className="text-zinc-300 hover:text-zinc-100 underline decoration-zinc-700 hover:decoration-zinc-400"
                >
                  Set up a craft recipe for this attachment →
                </Link>
              </div>
            </>
          )}
        </div>

        <aside className="w-[320px] shrink-0 border-l border-zinc-800 overflow-y-auto">
          <div className="px-3 py-2 border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
            Roll preview
          </div>
          {draft ? <RollPreview draft={draft} /> : null}
        </aside>
      </main>
    </div>
  );
}

// Kind switch handler — rebuilds the def discriminator so the
// strict schema doesn't reject a stray field from the old kind.
function rekind(prev: AttachmentDefData, k: Kind): AttachmentDefData {
  const common = {
    id: prev.id,
    displayName: prev.displayName,
    description: prev.description,
    adjective: prev.adjective,
  };
  switch (k) {
    case 'weapon_mod':
      return {
        ...common,
        kind: 'weapon_mod',
        family: prev.kind === 'suit_affix' ? null : prev.family,
        effect: prev.kind === 'suit_affix' ? {} : prev.effect,
      };
    case 'weapon_affix':
      return {
        ...common,
        kind: 'weapon_affix',
        pieceKind:
          prev.kind === 'weapon_affix' ? prev.pieceKind : 'frame',
        family: prev.kind === 'suit_affix' ? null : prev.family,
        effect: prev.kind === 'suit_affix' ? {} : prev.effect,
        value: 'value' in prev ? prev.value : 0,
      };
    case 'suit_affix':
      return {
        ...common,
        kind: 'suit_affix',
        slotKind:
          prev.kind === 'suit_affix' ? prev.slotKind : 'plating',
        effect: prev.kind === 'suit_affix' ? prev.effect : {},
        value: 'value' in prev ? prev.value : 0,
      };
  }
}

function WeaponEffectFields({
  effect,
  onChange,
}: {
  effect: { damageMult?: number; fireIntervalMult?: number; spreadMult?: number; projectileSpeedAdd?: number };
  onChange: (next: typeof effect) => void;
}) {
  return (
    <FormSection title="Base effect (weapon)">
      <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
        Multiplicative fields: 1.0 = no change. Spread / fire-interval
        below 1 mean tighter / faster.
      </div>
      <OptionalNum
        label="damage multiplier"
        value={effect.damageMult}
        onSet={(v) => onChange(setOrDrop(effect, 'damageMult', v))}
        defaultValue={1.0}
        step={0.05}
      />
      <OptionalNum
        label="fire interval multiplier"
        value={effect.fireIntervalMult}
        onSet={(v) => onChange(setOrDrop(effect, 'fireIntervalMult', v))}
        defaultValue={1.0}
        step={0.05}
      />
      <OptionalNum
        label="spread multiplier"
        value={effect.spreadMult}
        onSet={(v) => onChange(setOrDrop(effect, 'spreadMult', v))}
        defaultValue={1.0}
        step={0.05}
      />
      <OptionalNum
        label="projectile speed (+)"
        value={effect.projectileSpeedAdd}
        onSet={(v) => onChange(setOrDrop(effect, 'projectileSpeedAdd', v))}
        defaultValue={0}
        step={50}
      />
    </FormSection>
  );
}

function SuitEffectFields({
  effect,
  onChange,
}: {
  effect: {
    hpBonus?: number;
    shieldBonus?: number;
    staminaMaxBonus?: number;
    staminaRegenBonus?: number;
    moveSpeedMult?: number;
  };
  onChange: (next: typeof effect) => void;
}) {
  return (
    <FormSection title="Base effect (suit)">
      <OptionalNum
        label="hp bonus"
        value={effect.hpBonus}
        onSet={(v) => onChange(setOrDrop(effect, 'hpBonus', v))}
        defaultValue={0}
        step={1}
      />
      <OptionalNum
        label="shield bonus"
        value={effect.shieldBonus}
        onSet={(v) => onChange(setOrDrop(effect, 'shieldBonus', v))}
        defaultValue={0}
        step={1}
      />
      <OptionalNum
        label="stamina max bonus"
        value={effect.staminaMaxBonus}
        onSet={(v) => onChange(setOrDrop(effect, 'staminaMaxBonus', v))}
        defaultValue={0}
        step={1}
      />
      <OptionalNum
        label="stamina regen bonus"
        value={effect.staminaRegenBonus}
        onSet={(v) => onChange(setOrDrop(effect, 'staminaRegenBonus', v))}
        defaultValue={0}
        step={0.5}
      />
      <OptionalNum
        label="move speed multiplier"
        value={effect.moveSpeedMult}
        onSet={(v) => onChange(setOrDrop(effect, 'moveSpeedMult', v))}
        defaultValue={1.0}
        step={0.01}
      />
    </FormSection>
  );
}

function OptionalNum({
  label,
  value,
  onSet,
  defaultValue,
  step,
}: {
  label: string;
  value: number | undefined;
  onSet: (v: number | undefined) => void;
  defaultValue: number;
  step: number;
}) {
  const active = value !== undefined;
  return (
    <FieldRow label={label}>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => onSet(e.target.checked ? defaultValue : undefined)}
          title={active ? 'remove this field' : 'add this field'}
        />
        <input
          type="number"
          disabled={!active}
          value={active ? value : ''}
          step={step}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n)) onSet(n);
          }}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm w-24 disabled:opacity-40"
        />
      </div>
    </FieldRow>
  );
}

function setOrDrop<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  key: K,
  value: T[K] | undefined,
): T {
  const out = { ...obj };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out;
}

const ROLL_KEYS = [
  'damageMultBonus',
  'fireIntervalMultBonus',
  'spreadMultBonus',
  'projectileSpeedAddBonus',
  'hpBonusAdd',
  'shieldBonusAdd',
  'staminaMaxBonusAdd',
  'staminaRegenBonusAdd',
  'moveSpeedMultBonus',
] as const;

function RollRangesSection({
  draft,
  setDraft,
}: {
  draft: AttachmentDefData;
  setDraft: (next: AttachmentDefData) => void;
}) {
  const rolls = draft.rolls ?? {};
  function update(key: (typeof ROLL_KEYS)[number], v: [number, number] | undefined) {
    const next = { ...rolls };
    if (v === undefined) delete (next as Record<string, unknown>)[key];
    else (next as Record<string, [number, number]>)[key] = v;
    setDraft({
      ...draft,
      rolls: Object.keys(next).length === 0 ? undefined : next,
    } as AttachmentDefData);
  }
  return (
    <FormSection title="Roll ranges (procedural variance)">
      <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
        Each enabled row rolls a uniform [min, max] delta into the
        instance's resolved stats on craft, scaled by the part tier.
        Leave a row unchecked to skip it (the base effect applies
        directly).
      </div>
      {ROLL_KEYS.map((key) => {
        const cur = (rolls as Record<string, [number, number] | undefined>)[key];
        const enabled = cur !== undefined;
        return (
          <div key={key} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) =>
                update(key, e.target.checked ? [0, 0] : undefined)
              }
            />
            <span className="w-44 truncate text-zinc-400 font-mono text-[10px]">
              {key}
            </span>
            <input
              type="number"
              disabled={!enabled}
              value={enabled ? cur![0] : ''}
              step={0.01}
              onChange={(e) => {
                const lo = parseFloat(e.target.value);
                if (Number.isFinite(lo) && cur) update(key, [lo, cur[1]]);
              }}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 w-20 disabled:opacity-40"
              placeholder="min"
            />
            <input
              type="number"
              disabled={!enabled}
              value={enabled ? cur![1] : ''}
              step={0.01}
              onChange={(e) => {
                const hi = parseFloat(e.target.value);
                if (Number.isFinite(hi) && cur) update(key, [cur[0], hi]);
              }}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 w-20 disabled:opacity-40"
              placeholder="max"
            />
          </div>
        );
      })}
    </FormSection>
  );
}

// Tier-by-tier roll preview — same TIER_ROLL_SCALE the runtime
// uses (Mk1=0.5, Mk4=1.0, Alien=1.2). Shows the mid-of-range delta
// at each tier so the author sees the practical effect.
const TIER_ROLL_SCALE: Record<string, number> = {
  Mk1: 0.5,
  Mk2: 0.7,
  Mk3: 0.85,
  Mk4: 1.0,
  Alien: 1.2,
};

function RollPreview({ draft }: { draft: AttachmentDefData }) {
  const rolls = draft.rolls ?? {};
  const entries = Object.entries(rolls) as [string, [number, number]][];
  return (
    <div className="p-3 text-[11px] text-zinc-300 space-y-3">
      <p className="text-[10px] text-zinc-500">
        Mid-of-range delta per tier. Roll variance applies on top of
        the base effect.
      </p>
      {entries.length === 0 ? (
        <p className="text-[10px] text-zinc-500">
          No roll ranges set — fresh instances roll the base effect
          exactly.
        </p>
      ) : (
        <table className="w-full text-left">
          <thead className="text-[9px] text-zinc-500 uppercase">
            <tr>
              <th>Stat</th>
              {Object.keys(TIER_ROLL_SCALE).map((t) => (
                <th key={t} className="text-right">{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, [lo, hi]]) => {
              const mid = (lo + hi) / 2;
              return (
                <tr key={key} className="border-t border-zinc-900">
                  <td className="py-1 font-mono text-[10px]">{key}</td>
                  {Object.values(TIER_ROLL_SCALE).map((s, i) => (
                    <td key={i} className="py-1 text-right font-mono">
                      {(mid * s).toFixed(2)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
