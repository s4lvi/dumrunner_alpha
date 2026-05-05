'use client';

// Enemy editor. Three-pane layout matching the biome editor.
// AI section switches its parameter form on the discriminated
// `kind` so each template only shows its own fields.

import { useEffect, useState } from 'react';
import type {
  AiSpec,
  EnemyDef,
  Faction,
  ProjectileSpec,
} from '@dumrunner/shared';
import {
  listEntities,
  saveEntity,
  deleteEntity,
} from '@/lib/editorContentClient';
import {
  Button,
  ColorField,
  EnumField,
  FormSection,
  ListField,
  NumberField,
  SliderField,
  TextField,
} from '../_components/Form';

const FACTIONS: readonly Faction[] = [
  'catacombs',
  'sun_bleached',
  'frozen',
  'alien_core',
  'neutral',
] as const;

const SHAPES = ['circle', 'square', 'triangle'] as const;

const AI_KINDS = [
  'chaser_melee',
  'ranged_pulser',
  'swarmer',
  'brute',
  'sniper',
] as const;
type AiKind = (typeof AI_KINDS)[number];

function blankProjectile(): ProjectileSpec {
  return { speed: 600, damage: 8, ttlMs: 1200, radius: 4, color: '#fde047' };
}

function blankAi(kind: AiKind): AiSpec {
  switch (kind) {
    case 'chaser_melee':
      return { kind, attackInterval: 800, meleeRange: 36 };
    case 'ranged_pulser':
      return {
        kind,
        attackInterval: 1200,
        preferredRange: { min: 120, max: 240 },
        projectile: blankProjectile(),
      };
    case 'swarmer':
      return { kind, aggression: 0.8, chaseStickiness: 0.5 };
    case 'brute':
      return { kind, chargeWindupMs: 600, chargeDamage: 30, chargeRange: 80 };
    case 'sniper':
      return {
        kind,
        attackInterval: 2200,
        retreatBelowHpRatio: 0.3,
        projectile: blankProjectile(),
      };
  }
}

function makeBlank(id = 'new_enemy'): EnemyDef {
  return {
    id,
    label: 'New Enemy',
    faction: 'neutral',
    biomeAffinity: [],
    stats: {
      hp: 30,
      contactDamage: 4,
      moveSpeed: 80,
      aggroRadius: 360,
      deaggroRadius: 600,
      bodyRadius: 14,
    },
    ai: blankAi('chaser_melee'),
    visual: { shape: 'circle', color: '#a855f7', size: 14 },
    loot: {},
  };
}

export default function EnemyEditorPage() {
  const [entries, setEntries] = useState<EnemyDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EnemyDef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const r = await listEntities('enemies');
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
      await saveEntity('enemies', draft);
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
    if (!confirm(`Delete enemy "${selectedId}"?`)) return;
    try {
      await deleteEntity('enemies', selectedId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function onNew() {
    const id = `enemy_${Date.now().toString(36)}`;
    const blank = makeBlank(id);
    setEntries((cur) => [...cur, blank]);
    setSelectedId(id);
  }

  return (
    <div className="flex h-full w-full">
      <aside className="w-60 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 space-y-2">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-xs uppercase text-zinc-500">Enemies</h2>
          <Button onClick={onNew}>+ new</Button>
        </div>
        {entries.length === 0 && (
          <p className="text-[11px] text-zinc-500">
            No enemies yet. Click <span className="text-zinc-300">+ new</span>.
          </p>
        )}
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => setSelectedId(e.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
              selectedId === e.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/40'
            }`}
          >
            <span
              className="w-3 h-3 rounded-full border border-zinc-700"
              style={{ background: e.visual.color }}
            />
            <span className="flex-1 truncate">{e.label}</span>
            <span className="text-[9px] text-zinc-600 font-mono">
              {e.ai.kind.split('_')[0]}
            </span>
          </button>
        ))}
      </aside>

      <main className="flex-1 overflow-y-auto p-4 min-w-0">
        {!draft && (
          <div className="text-zinc-500 text-sm pt-12 text-center">
            Select an enemy on the left, or create a new one.
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
                label="faction"
                value={draft.faction}
                options={FACTIONS}
                onChange={(v) => setDraft({ ...draft, faction: v as Faction })}
              />
              <BiomeAffinityField
                value={draft.biomeAffinity}
                onChange={(v) => setDraft({ ...draft, biomeAffinity: v })}
              />
            </FormSection>

            <FormSection title="Stats">
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="hp"
                  value={draft.stats.hp}
                  min={1}
                  onChange={(v) =>
                    setDraft({ ...draft, stats: { ...draft.stats, hp: v } })
                  }
                />
                <NumberField
                  label="contact damage"
                  value={draft.stats.contactDamage}
                  min={0}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stats: { ...draft.stats, contactDamage: v },
                    })
                  }
                />
                <NumberField
                  label="move speed (px/s)"
                  value={draft.stats.moveSpeed}
                  min={0}
                  step={5}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stats: { ...draft.stats, moveSpeed: v },
                    })
                  }
                />
                <NumberField
                  label="body radius"
                  value={draft.stats.bodyRadius}
                  min={1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stats: { ...draft.stats, bodyRadius: v },
                    })
                  }
                />
                <NumberField
                  label="aggro radius"
                  value={draft.stats.aggroRadius}
                  min={0}
                  step={10}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stats: { ...draft.stats, aggroRadius: v },
                    })
                  }
                />
                <NumberField
                  label="deaggro radius"
                  value={draft.stats.deaggroRadius}
                  min={0}
                  step={10}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stats: { ...draft.stats, deaggroRadius: v },
                    })
                  }
                />
              </div>
            </FormSection>

            <AiSection
              ai={draft.ai}
              onChange={(ai) => setDraft({ ...draft, ai })}
            />

            <FormSection title="Visual (procedural fallback)">
              <EnumField
                label="shape"
                value={draft.visual.shape}
                options={SHAPES}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    visual: { ...draft.visual, shape: v },
                  })
                }
              />
              <ColorField
                label="color"
                value={draft.visual.color}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    visual: { ...draft.visual, color: v },
                  })
                }
              />
              <NumberField
                label="size"
                value={draft.visual.size}
                min={4}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    visual: { ...draft.visual, size: v },
                  })
                }
              />
              <p className="text-[10px] text-zinc-500">
                Procedural shape is the fallback. Upload a sprite at{' '}
                <code className="text-zinc-300">/editor/textures</code> under
                category <code className="text-zinc-300">enemy</code>, id{' '}
                <code className="text-zinc-300">{draft.id}</code> for a
                proper billboard.
              </p>
            </FormSection>

            <FormSection title="Loot">
              <NumberField
                label="part drop chance"
                value={draft.loot.partDropChance ?? 0}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    loot: { ...draft.loot, partDropChance: v || undefined },
                  })
                }
              />
              <NumberField
                label="blueprint drop chance"
                value={draft.loot.blueprintDropChance ?? 0}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    loot: {
                      ...draft.loot,
                      blueprintDropChance: v || undefined,
                    },
                  })
                }
              />
              <ListField
                label="material drops"
                hint="weighted; each row rolls independently."
                entries={draft.loot.materialDrops ?? []}
                newEntry={() => ({
                  materialId: '',
                  min: 1,
                  max: 1,
                  chance: 0.5,
                })}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    loot: {
                      ...draft.loot,
                      materialDrops: next.length > 0 ? next : undefined,
                    },
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
              <ProcShape
                shape={draft.visual.shape}
                color={draft.visual.color}
                size={Math.min(48, draft.visual.size * 2.5)}
              />
            </div>
            <div className="text-[11px] text-zinc-400 space-y-0.5 font-mono">
              <div>id: {draft.id}</div>
              <div>faction: {draft.faction}</div>
              <div>ai: {draft.ai.kind}</div>
              <div>hp: {draft.stats.hp}</div>
              <div>damage: {draft.stats.contactDamage}</div>
              <div>speed: {draft.stats.moveSpeed} px/s</div>
              <div>biomes: {draft.biomeAffinity.join(', ') || '(none)'}</div>
            </div>
            <p className="text-[10px] text-zinc-600 leading-snug">
              Live AI sandbox (Spawn / fire-at-dummy) lands once
              the server consumes EnemyDef JSON in E3.1. Until
              then, save and verify in the live game.
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Select or create an enemy to preview.
          </p>
        )}
      </aside>
    </div>
  );
}

// ---------- AI section: switches param form on discriminated `kind` ----------

function AiSection({
  ai,
  onChange,
}: {
  ai: AiSpec;
  onChange: (ai: AiSpec) => void;
}) {
  return (
    <FormSection title="AI">
      <EnumField
        label="behavior"
        value={ai.kind}
        options={AI_KINDS}
        onChange={(k) => onChange(blankAi(k))}
      />
      {ai.kind === 'chaser_melee' && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="attack interval (ms)"
            value={ai.attackInterval}
            step={50}
            min={0}
            onChange={(v) => onChange({ ...ai, attackInterval: v })}
          />
          <NumberField
            label="melee range (px)"
            value={ai.meleeRange}
            min={0}
            onChange={(v) => onChange({ ...ai, meleeRange: v })}
          />
        </div>
      )}
      {ai.kind === 'ranged_pulser' && (
        <>
          <NumberField
            label="attack interval (ms)"
            value={ai.attackInterval}
            step={50}
            min={0}
            onChange={(v) => onChange({ ...ai, attackInterval: v })}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="preferred range min"
              value={ai.preferredRange.min}
              min={0}
              step={10}
              onChange={(v) =>
                onChange({
                  ...ai,
                  preferredRange: { ...ai.preferredRange, min: v },
                })
              }
            />
            <NumberField
              label="preferred range max"
              value={ai.preferredRange.max}
              min={0}
              step={10}
              onChange={(v) =>
                onChange({
                  ...ai,
                  preferredRange: { ...ai.preferredRange, max: v },
                })
              }
            />
          </div>
          <ProjectileSubform
            spec={ai.projectile}
            onChange={(p) => onChange({ ...ai, projectile: p })}
          />
        </>
      )}
      {ai.kind === 'swarmer' && (
        <>
          <SliderField
            label="aggression"
            value={ai.aggression}
            onChange={(v) => onChange({ ...ai, aggression: v })}
          />
          <SliderField
            label="chase stickiness"
            value={ai.chaseStickiness}
            onChange={(v) => onChange({ ...ai, chaseStickiness: v })}
          />
        </>
      )}
      {ai.kind === 'brute' && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="charge windup (ms)"
            value={ai.chargeWindupMs}
            min={0}
            step={50}
            onChange={(v) => onChange({ ...ai, chargeWindupMs: v })}
          />
          <NumberField
            label="charge damage"
            value={ai.chargeDamage}
            min={0}
            onChange={(v) => onChange({ ...ai, chargeDamage: v })}
          />
          <NumberField
            label="charge range"
            value={ai.chargeRange}
            min={0}
            step={10}
            onChange={(v) => onChange({ ...ai, chargeRange: v })}
          />
        </div>
      )}
      {ai.kind === 'sniper' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="attack interval (ms)"
              value={ai.attackInterval}
              min={0}
              step={50}
              onChange={(v) => onChange({ ...ai, attackInterval: v })}
            />
            <SliderField
              label="retreat below HP ratio"
              value={ai.retreatBelowHpRatio}
              onChange={(v) => onChange({ ...ai, retreatBelowHpRatio: v })}
            />
          </div>
          <ProjectileSubform
            spec={ai.projectile}
            onChange={(p) => onChange({ ...ai, projectile: p })}
          />
        </>
      )}
    </FormSection>
  );
}

function ProjectileSubform({
  spec,
  onChange,
}: {
  spec: ProjectileSpec;
  onChange: (next: ProjectileSpec) => void;
}) {
  return (
    <div className="border border-zinc-800 rounded p-2 space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        projectile
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="speed (px/s)"
          value={spec.speed}
          min={0}
          step={50}
          onChange={(v) => onChange({ ...spec, speed: v })}
        />
        <NumberField
          label="damage"
          value={spec.damage}
          min={0}
          onChange={(v) => onChange({ ...spec, damage: v })}
        />
        <NumberField
          label="ttl (ms)"
          value={spec.ttlMs}
          min={0}
          step={50}
          onChange={(v) => onChange({ ...spec, ttlMs: v })}
        />
        <NumberField
          label="radius (px)"
          value={spec.radius}
          min={1}
          onChange={(v) => onChange({ ...spec, radius: v })}
        />
      </div>
      <ColorField
        label="color"
        value={spec.color}
        onChange={(v) => onChange({ ...spec, color: v })}
      />
    </div>
  );
}

// ---------- biome affinity multi-select (loaded from API) ----------

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
        // No biomes yet — just show the manual entry input.
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
                  onChange(on ? value.filter((v) => v !== id) : [...value, id])
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

function ProcShape({
  shape,
  color,
  size,
}: {
  shape: 'circle' | 'square' | 'triangle';
  color: string;
  size: number;
}) {
  if (shape === 'circle') {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          border: '1px solid #000',
        }}
      />
    );
  }
  if (shape === 'square') {
    return (
      <div
        style={{
          width: size,
          height: size,
          background: color,
          border: '1px solid #000',
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 0,
        height: 0,
        borderLeft: `${size / 2}px solid transparent`,
        borderRight: `${size / 2}px solid transparent`,
        borderBottom: `${size}px solid ${color}`,
      }}
    />
  );
}
