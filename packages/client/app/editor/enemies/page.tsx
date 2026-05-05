'use client';

// Enemy editor. Three-pane layout matching the biome editor.
// Schema mirrors server's EnemyTemplate: identity + stats + a
// movement profile (stationary / chase / kite) + a list of
// attacks (melee / projectile / aoe_cone) + flee + stun + visual
// + loot.

import { useEffect, useState } from 'react';
import type {
  AoeConeEffectKind,
  AttackSpec,
  EnemyDef,
  EnemyState,
  Faction,
  MovementSpec,
  Player,
  SceneLayout,
} from '@dumrunner/shared';
import { setEnemyVisuals } from '@dumrunner/shared';
import type { GameInit } from '@/lib/game/pixi';
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
import { IsoPreview } from '../_components/IsoPreview';

const FACTIONS: readonly Faction[] = [
  'catacombs',
  'sun_bleached',
  'frozen',
  'alien_core',
  'neutral',
] as const;

const SHAPES = ['circle', 'square', 'triangle'] as const;
const MOVEMENT_KINDS = ['stationary', 'chase', 'kite'] as const;
const ATTACK_KINDS = ['melee', 'projectile', 'aoe_cone'] as const;
const EFFECT_KINDS: readonly AoeConeEffectKind[] = [
  'burn_dps',
  'poison_dps',
  'slow_pct',
] as const;

function blankMovement(kind: MovementSpec['kind']): MovementSpec {
  if (kind === 'stationary') return { kind };
  if (kind === 'chase') return { kind };
  return { kind: 'kite', minRange: 120, maxRange: 220 };
}

function blankAttack(kind: AttackSpec['kind']): AttackSpec {
  if (kind === 'melee') {
    return { kind: 'melee', range: 36, damagePerSec: 15 };
  }
  if (kind === 'projectile') {
    return {
      kind: 'projectile',
      range: 320,
      cooldownMs: 1200,
      projectileSpeed: 520,
      projectileDamage: 12,
      projectileTtlMs: 1200,
      projectileRadius: 5,
      projectileColor: '#fde047',
    };
  }
  return {
    kind: 'aoe_cone',
    range: 160,
    cooldownMs: 1500,
    arcRad: 0.7,
    effectKind: 'burn_dps',
    effectMagnitude: 8,
    effectDurationMs: 4000,
    effectLabel: 'Burning',
    coneColor: '#fb923c',
  };
}

function makeBlank(id = 'new_enemy'): EnemyDef {
  return {
    id,
    label: 'New Enemy',
    faction: 'neutral',
    biomeAffinity: [],
    stats: { hp: 50, radius: 14, moveSpeed: 100, senseRadius: 360 },
    movement: { kind: 'chase' },
    attacks: [{ kind: 'melee', range: 36, damagePerSec: 15 }],
    fleeBelowHpRatio: null,
    stunDurationOnHitMs: 200,
    visual: { shape: 'circle', color: '#a855f7', size: 14 },
    lootTable: [{ materialId: 'scrap', chance: 1.0, min: 1, max: 2 }],
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
              {e.movement.kind}
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
                  label="body radius"
                  value={draft.stats.radius}
                  min={1}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stats: { ...draft.stats, radius: v },
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
                  hint="0 disables movement"
                />
                <NumberField
                  label="sense radius"
                  value={draft.stats.senseRadius}
                  min={0}
                  step={20}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      stats: { ...draft.stats, senseRadius: v },
                    })
                  }
                />
              </div>
              <NumberField
                label="stun duration on hit (ms)"
                value={draft.stunDurationOnHitMs}
                min={0}
                step={20}
                onChange={(v) =>
                  setDraft({ ...draft, stunDurationOnHitMs: v })
                }
                hint="0 = stun-immune. Tougher enemies use lower values."
              />
              <FleeRatioField
                value={draft.fleeBelowHpRatio}
                onChange={(v) => setDraft({ ...draft, fleeBelowHpRatio: v })}
              />
            </FormSection>

            <MovementSection
              movement={draft.movement}
              onChange={(m) => setDraft({ ...draft, movement: m })}
            />

            <AttacksSection
              attacks={draft.attacks}
              onChange={(a) => setDraft({ ...draft, attacks: a })}
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

            <ListField
              label="Loot table"
              hint="each row rolls independently when the enemy dies."
              entries={draft.lootTable}
              newEntry={() => ({
                materialId: '',
                min: 1,
                max: 1,
                chance: 0.5,
              })}
              onChange={(next) => setDraft({ ...draft, lootTable: next })}
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
          </div>
        )}
      </main>

      <aside className="w-80 shrink-0 border-l border-zinc-800 p-3 overflow-y-auto flex flex-col gap-2">
        <h2 className="text-xs uppercase text-zinc-500">Preview</h2>
        {draft ? (
          <>
            <div className="h-72 shrink-0">
              <EnemyPreview draft={draft} />
            </div>
            <div className="text-[11px] text-zinc-400 space-y-0.5 font-mono">
              <div>id: {draft.id}</div>
              <div>faction: {draft.faction}</div>
              <div>movement: {draft.movement.kind}</div>
              <div>attacks: {draft.attacks.map((a) => a.kind).join(', ')}</div>
              <div>hp: {draft.stats.hp}</div>
              <div>speed: {draft.stats.moveSpeed} px/s</div>
              <div>biomes: {draft.biomeAffinity.join(', ') || '(none)'}</div>
            </div>
            <p className="text-[10px] text-zinc-600 leading-snug">
              Iso preview shows the procedural billboard at this
              enemy&apos;s shape / colour / size. Live AI sandbox
              (let it chase a dummy) lands once E3.1 wires biome
              roster spawning into the running scene.
            </p>
          </>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Select or create an enemy to preview.
          </p>
        )}
      </aside>
    </div>
  );
}

// ---------- Movement section ----------

function MovementSection({
  movement,
  onChange,
}: {
  movement: MovementSpec;
  onChange: (m: MovementSpec) => void;
}) {
  return (
    <FormSection title="Movement">
      <EnumField
        label="kind"
        value={movement.kind}
        options={MOVEMENT_KINDS}
        onChange={(k) => onChange(blankMovement(k))}
      />
      {movement.kind === 'kite' && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="min range"
            value={movement.minRange}
            min={0}
            step={10}
            onChange={(v) => onChange({ ...movement, minRange: v })}
          />
          <NumberField
            label="max range"
            value={movement.maxRange}
            min={0}
            step={10}
            onChange={(v) => onChange({ ...movement, maxRange: v })}
          />
        </div>
      )}
    </FormSection>
  );
}

// ---------- Attacks section ----------

function AttacksSection({
  attacks,
  onChange,
}: {
  attacks: AttackSpec[];
  onChange: (a: AttackSpec[]) => void;
}) {
  return (
    <ListField<AttackSpec>
      label="Attacks"
      hint="Server evaluates attacks in order each tick; melee fires first when in range, then projectiles / cones."
      entries={attacks}
      newEntry={() => blankAttack('melee')}
      onChange={onChange}
      renderRow={(attack, _i, update) => (
        <div className="space-y-1 border border-zinc-800 rounded p-2">
          <EnumField
            label="kind"
            value={attack.kind}
            options={ATTACK_KINDS}
            onChange={(k) => update(blankAttack(k as AttackSpec['kind']))}
          />
          {attack.kind === 'melee' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="range (px)"
                value={attack.range}
                min={1}
                onChange={(v) => update({ ...attack, range: v })}
              />
              <NumberField
                label="damage / sec"
                value={attack.damagePerSec}
                min={0}
                onChange={(v) => update({ ...attack, damagePerSec: v })}
                hint="continuous while target in range"
              />
            </div>
          )}
          {attack.kind === 'projectile' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="range (px)"
                  value={attack.range}
                  min={1}
                  step={10}
                  onChange={(v) => update({ ...attack, range: v })}
                />
                <NumberField
                  label="cooldown (ms)"
                  value={attack.cooldownMs}
                  min={0}
                  step={50}
                  onChange={(v) => update({ ...attack, cooldownMs: v })}
                />
                <NumberField
                  label="projectile speed"
                  value={attack.projectileSpeed}
                  min={1}
                  step={50}
                  onChange={(v) =>
                    update({ ...attack, projectileSpeed: v })
                  }
                />
                <NumberField
                  label="projectile damage"
                  value={attack.projectileDamage}
                  min={0}
                  onChange={(v) =>
                    update({ ...attack, projectileDamage: v })
                  }
                />
                <NumberField
                  label="projectile ttl (ms)"
                  value={attack.projectileTtlMs}
                  min={0}
                  step={50}
                  onChange={(v) =>
                    update({ ...attack, projectileTtlMs: v })
                  }
                />
                <NumberField
                  label="projectile radius"
                  value={attack.projectileRadius}
                  min={1}
                  onChange={(v) =>
                    update({ ...attack, projectileRadius: v })
                  }
                />
              </div>
              <ColorField
                label="projectile color"
                value={attack.projectileColor}
                onChange={(v) => update({ ...attack, projectileColor: v })}
              />
            </>
          )}
          {attack.kind === 'aoe_cone' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="range (px)"
                  value={attack.range}
                  min={1}
                  step={10}
                  onChange={(v) => update({ ...attack, range: v })}
                />
                <NumberField
                  label="cooldown (ms)"
                  value={attack.cooldownMs}
                  min={0}
                  step={50}
                  onChange={(v) => update({ ...attack, cooldownMs: v })}
                />
                <NumberField
                  label="arc (rad)"
                  value={attack.arcRad}
                  min={0.05}
                  step={0.05}
                  onChange={(v) => update({ ...attack, arcRad: v })}
                  hint="half-arc; 0.7 ≈ 80°"
                />
              </div>
              <EnumField
                label="effect kind"
                value={attack.effectKind}
                options={EFFECT_KINDS}
                onChange={(v) =>
                  update({ ...attack, effectKind: v as AoeConeEffectKind })
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="effect magnitude"
                  value={attack.effectMagnitude}
                  min={0}
                  step={0.05}
                  onChange={(v) =>
                    update({ ...attack, effectMagnitude: v })
                  }
                />
                <NumberField
                  label="effect duration (ms)"
                  value={attack.effectDurationMs}
                  min={0}
                  step={100}
                  onChange={(v) =>
                    update({ ...attack, effectDurationMs: v })
                  }
                />
              </div>
              <TextField
                label="effect label"
                value={attack.effectLabel}
                onChange={(v) => update({ ...attack, effectLabel: v })}
                hint="HUD chip text — e.g. Burning, Poisoned, Slowed"
              />
              <ColorField
                label="cone color"
                value={attack.coneColor}
                onChange={(v) => update({ ...attack, coneColor: v })}
              />
            </>
          )}
        </div>
      )}
    />
  );
}

// ---------- Misc ----------

function FleeRatioField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
        <input
          type="checkbox"
          checked={value !== null}
          onChange={(e) => onChange(e.target.checked ? 0.3 : null)}
          className="accent-zinc-500"
        />
        <span>flees below HP ratio</span>
      </label>
      {value !== null && (
        <div className="flex items-center gap-2 pl-6">
          <input
            type="range"
            value={value}
            min={0}
            max={1}
            step={0.05}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1"
          />
          <span className="font-mono text-[10px] text-zinc-400 w-10 text-right">
            {value.toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}

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
        // No biomes yet — manual entry stays usable.
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

// ---------- Iso preview ----------
//
// Mounts the iso renderer with a small demo scene: a single
// walkable room, the local "self" at centre, and one of the
// draft enemy positioned in front. Updates whenever the
// visual / shape / colour / size change so iteration is live.
//
// Trick: the iso renderer reads enemy visuals from a runtime
// map (shared/visuals.ts ENEMY_VISUALS) populated at session
// welcome. The editor has no welcome message, so we manually
// poke the draft into setEnemyVisuals before mounting.

const PREVIEW_TILE = 32;
const PREVIEW_SELF_ID = 'enemy_preview_self';
const PREVIEW_ENEMY_ID = 'enemy_preview_target';

function EnemyPreview({ draft }: { draft: EnemyDef }) {
  const buildInit = (): GameInit => {
    // Push the draft visual into the runtime map so the iso
    // renderer's enemyVisualFor() lookup picks the right shape /
    // colour / size when it draws the billboard.
    const colorNum = parseHex(draft.visual.color);
    setEnemyVisuals({
      [draft.id]: {
        shape: draft.visual.shape,
        color: colorNum,
        size: draft.visual.size,
      },
    });
    const tiles = 12;
    const half = (tiles * PREVIEW_TILE) / 2;
    const layout: SceneLayout = {
      worldBounds: { x: -1000, y: -1000, w: 2000, h: 2000 },
      walkables: [{ x: -half, y: -half, w: tiles * PREVIEW_TILE, h: tiles * PREVIEW_TILE }],
      rooms: [{ x: -half, y: -half, w: tiles * PREVIEW_TILE, h: tiles * PREVIEW_TILE }],
      spawn: { x: 0, y: 0 },
      interactables: [],
      tileSize: PREVIEW_TILE,
      biome: 'default',
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
    const enemy: EnemyState = {
      id: PREVIEW_ENEMY_ID,
      kind: draft.id,
      x: 0,
      y: -PREVIEW_TILE * 3, // ~3 tiles north of the player
      hp: draft.stats.hp,
      maxHp: draft.stats.hp,
    };
    return {
      self,
      others: [],
      enemies: [enemy],
      projectiles: [],
      loot: [],
      corpses: [],
      buildings: [],
      layout,
      sendInput: () => {},
      sendFire: () => {},
      sendBuild: () => {},
      sendDemolish: () => {},
      onNearInteractableChanged: () => {},
      onNearWorkstationsChanged: () => {},
    };
  };
  // Anything that affects the rendered enemy → remount.
  const signature = `${draft.id}|${draft.visual.shape}|${draft.visual.color}|${draft.visual.size}|${draft.stats.hp}`;
  return <IsoPreview buildInit={buildInit} signature={signature} />;
}

function parseHex(s: string): number {
  const trimmed = s.startsWith('#') ? s.slice(1) : s;
  const n = parseInt(trimmed, 16);
  return Number.isFinite(n) ? n : 0xa855f7;
}
