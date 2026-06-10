'use client';

// Weapon editor. Three-pane: sidebar list, centre form, right
// pane shows derived per-tier stats so the author can see how
// the chassis behaves at T1 vs T4 with the tier-scaling curve
// applied (logic lives in shared/weaponStats.ts).
//
// Edits write JSON to packages/shared/content/weapons/<id>.json
// via /api/editor/content/weapons; server's content watcher
// reloads the runtime registry on save, and connected clients
// pick up the fresh data on next welcome.
//
// Cross-link to /editor/blueprints lets the author wire up a
// blueprint unlock for a freshly-authored weapon — but the
// recipe still has to exist (recipes are TS-side for now; see
// the items-editor follow-up plan).

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import type {
  WeaponDef,
  WeaponFamilyKind,
  ProjectileKind,
} from '@dumrunner/shared';
import { BUILDING_REGISTRY, WeaponDefSchema } from '@dumrunner/shared';
import type { z } from 'zod';
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
import { TextureRow } from '../_components/TextureRow';
import { AnimationPicker } from '../_components/AnimationPicker';
import { useEntityEditor } from '../_components/useEntityEditor';

const FAMILIES: readonly WeaponFamilyKind[] = [
  'pistol',
  'smg',
  'shotgun',
  'rifle',
  'sniper',
  'heavy',
  'energy',
  'melee',
] as const;

const PROJECTILE_KINDS: readonly ProjectileKind[] = [
  'single',
  'pellets',
  'explosive',
] as const;

// Hardcoded short list — the runtime currently only consumes
// these ammo strings. Adding a new ammo kind requires editing
// inventory.ts's AmmoKind union; until that lands, the editor
// constrains the dropdown to the known set.
const AMMO_KINDS = [
  'pistol_basic',
  'smg_basic',
  'shotgun_shells',
  'rifle_rounds',
  'sniper_rounds',
  'heavy_slugs',
  'energy_cells',
] as const;

function intToHex(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}
function hexToInt(s: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m) return 0;
  return parseInt(m[1], 16);
}

function makeBlank(id = 'new_weapon'): WeaponDef {
  return {
    id,
    label: 'New Weapon',
    family: 'pistol',
    color: 0xfafafa,
    description: '',
    craftingStation: 'workbench',
    ranged: {
      damage: 20,
      fireIntervalMs: 400,
      projectileSpeed: 2000,
      projectileTtlMs: 800,
      projectileRadius: 4,
      pelletCount: 1,
      spreadRad: 0,
      color: 0xfafafa,
      ammoKind: 'pistol_basic',
      accuracy: 0.7,
      magazineSize: 12,
      reloadMs: 1500,
      projectile: { kind: 'single' },
    },
  };
}

export default function WeaponEditorPage() {
  return (
    <Suspense fallback={null}>
      <WeaponEditorBody />
    </Suspense>
  );
}

function WeaponEditorBody() {
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
  } = useEntityEditor<WeaponDef>('weapons', {
    makeBlank,
    newIdPrefix: 'weapon',
    schema: WeaponDefSchema as unknown as z.ZodType<WeaponDef>,
  });

  const sortedEntries = useMemo(
    () =>
      [...entries].sort((a, b) => {
        // Melee sinks to the bottom; within a family, alphabetical.
        const am = a.family === 'melee' ? 1 : 0;
        const bm = b.family === 'melee' ? 1 : 0;
        if (am !== bm) return am - bm;
        const fc = a.family.localeCompare(b.family);
        if (fc !== 0) return fc;
        return a.label.localeCompare(b.label);
      }),
    [entries],
  );

  // Workstation options come from BUILDING_REGISTRY's
  // isWorkstation flag — the runtime authoritative source.
  const workstationOptions = useMemo(() => {
    const opts: string[] = [''];
    for (const [kind, def] of Object.entries(BUILDING_REGISTRY)) {
      if (def.isWorkstation) opts.push(kind);
    }
    return opts;
  }, []);

  const localErrors = useMemo(() => {
    const errs: string[] = [];
    if (!draft) return errs;
    if (!draft.id.match(/^[a-z0-9_-]+$/)) {
      errs.push('id must be lowercase alphanumeric / underscore / hyphen');
    }
    const isMelee = draft.family === 'melee';
    if (isMelee && !draft.melee) {
      errs.push('melee weapons require a `melee` stat block');
    }
    if (!isMelee && !draft.ranged) {
      errs.push('ranged weapons require a `ranged` stat block');
    }
    if (isMelee && draft.ranged) {
      errs.push('can\'t set both ranged and melee — clear the ranged block');
    }
    if (!isMelee && draft.melee) {
      errs.push('can\'t set both ranged and melee — clear the melee block');
    }
    if (
      !isMelee &&
      draft.ranged?.projectile?.kind === 'explosive' &&
      (draft.ranged.projectile.explosionRadius === undefined ||
        draft.ranged.projectile.explosionDamage === undefined)
    ) {
      errs.push('explosive projectiles need explosionRadius + explosionDamage');
    }
    if (
      !isMelee &&
      draft.ranged?.projectile?.kind === 'explosive'
    ) {
      errs.push(
        'note: explosive runtime support is pending — server falls back to single-shot until it lands',
      );
    }
    return errs;
  }, [draft]);

  const blockSave =
    localErrors.some((e) => !e.startsWith('note:')) || !canSave;

  return (
    <div className="flex h-full">
      <EntityList<WeaponDef>
        title="Weapons"
        entries={sortedEntries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={createNew}
        emptyHint="No weapons yet. Click + new to create one."
        renderItem={(w) => (
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-sm inline-block"
              style={{ background: intToHex(w.color) }}
            />
            <span className="flex-1 truncate">{w.label}</span>
            <span className="text-[10px] text-zinc-500">{w.family}</span>
          </div>
        )}
      />

      <main className="flex-1 flex overflow-hidden">
        {/* Centre form */}
        <div className="flex-1 overflow-y-auto p-4 max-w-2xl">
          {draft === null ? (
            <p className="text-sm text-zinc-500">
              Select a weapon on the left, or click <kbd>+ new</kbd> to
              create one.
            </p>
          ) : (
            <>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h1 className="text-lg font-bold text-zinc-200">
                    {draft.label || draft.id}
                  </h1>
                  <div className="text-[10px] text-zinc-500 font-mono">
                    {draft.id} · {draft.family}
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
                  hint="Lowercase slug. Renaming is allowed."
                  monospace
                />
                <TextField
                  label="label"
                  value={draft.label}
                  onChange={(v) => setDraft({ ...draft, label: v })}
                />
                <EnumField<WeaponFamilyKind>
                  label="family"
                  value={draft.family}
                  options={FAMILIES}
                  onChange={(v) => {
                    // Switching family rebuilds the matching stat
                    // block — the schema's refine rejects having
                    // both, and the form should reflect that.
                    if (v === 'melee') {
                      setDraft({
                        ...draft,
                        family: v,
                        ranged: undefined,
                        melee: draft.melee ?? {
                          damage: 50,
                          swingIntervalMs: 400,
                          range: 70,
                          arcRad: 0.8,
                          color: draft.color,
                        },
                      });
                    } else {
                      setDraft({
                        ...draft,
                        family: v,
                        melee: undefined,
                        ranged: draft.ranged ?? {
                          damage: 20,
                          fireIntervalMs: 400,
                          projectileSpeed: 2000,
                          projectileTtlMs: 800,
                          projectileRadius: 4,
                          pelletCount: 1,
                          spreadRad: 0,
                          color: draft.color,
                          ammoKind: 'pistol_basic',
                          accuracy: 0.7,
                          magazineSize: 12,
                          reloadMs: 1500,
                          projectile: { kind: 'single' },
                        },
                      });
                    }
                  }}
                  hint="Ranged families share ammo + mod compatibility with their respective turret variants. Melee uses a swing arc instead of projectiles."
                />
                <TextField
                  label="description"
                  value={draft.description ?? ''}
                  onChange={(v) =>
                    setDraft({ ...draft, description: v || undefined })
                  }
                  hint="Designer notes / future tooltip. Optional."
                />
                <FieldRow label="color (hex)">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={intToHex(draft.color)}
                      onChange={(e) =>
                        setDraft({ ...draft, color: hexToInt(e.target.value) })
                      }
                      className="w-8 h-7 bg-transparent border border-zinc-700 rounded"
                    />
                    <input
                      type="text"
                      value={intToHex(draft.color)}
                      onChange={(e) =>
                        setDraft({ ...draft, color: hexToInt(e.target.value) })
                      }
                      className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono w-24"
                    />
                  </div>
                </FieldRow>
              </FormSection>

              <FormSection title="Visuals">
                <div className="text-[10px] text-zinc-500 -mt-1 mb-2">
                  Static fallback PNGs are below; pick a library
                  animation in the section after to make the FPS
                  renderer drive the frame instead.
                </div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  First-person view (weapon_view/{draft.id})
                </div>
                <TextureRow
                  category="weapon_view"
                  id={draft.id}
                  hideLabel
                />
                {draft.family !== 'melee' && (
                  <>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 mt-3 mb-1">
                      Projectile (projectile/{draft.id})
                    </div>
                    <TextureRow
                      category="projectile"
                      id={draft.id}
                      hideLabel
                    />
                    <div className="text-[10px] text-zinc-500 mt-2">
                      Family fallback lives at{' '}
                      <code className="text-zinc-300">
                        projectile/{draft.family}
                      </code>{' '}
                      — upload there to cover every weapon in this
                      family with one sprite. Per-weapon override
                      above wins when both exist.
                    </div>
                  </>
                )}
              </FormSection>

              <FormSection title="Animations">
                <AnimationPicker
                  label="first-person view"
                  category="weapon_view"
                  value={draft.viewAnimationId}
                  onChange={(v) => setDraft({ ...draft, viewAnimationId: v })}
                />
                {draft.family !== 'melee' && (
                  <AnimationPicker
                    label="projectile"
                    category="projectile"
                    value={draft.projectileAnimationId}
                    onChange={(v) =>
                      setDraft({ ...draft, projectileAnimationId: v })
                    }
                    hint="Per-weapon bullet animation. Empty falls through to the family default (set this on the family's representative weapon to share)."
                  />
                )}
              </FormSection>

              <FormSection title="Crafting">
                <FieldRow
                  label="crafting station"
                  hint="Workbench is the default for hand-craft / starter recipes; specialised benches gate higher-tier outputs."
                >
                  <select
                    value={draft.craftingStation ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        craftingStation: e.target.value || undefined,
                      })
                    }
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    {workstationOptions.map((opt) => (
                      <option key={opt || '(none)'} value={opt}>
                        {opt || '(none / hand-craftable)'}
                      </option>
                    ))}
                  </select>
                </FieldRow>
                <div className="text-[10px] text-zinc-500">
                  Recipes are still TS-side; this field stores the
                  designer intent for now. The runtime crafting station
                  comes from the linked recipe in `RECIPES`.
                </div>
                <BlueprintLink weaponId={draft.id} />
              </FormSection>

              {draft.family !== 'melee' && draft.ranged && (
                <RangedFields
                  ranged={draft.ranged}
                  onChange={(next) => setDraft({ ...draft, ranged: next })}
                />
              )}

              {draft.family === 'melee' && draft.melee && (
                <MeleeFields
                  melee={draft.melee}
                  onChange={(next) => setDraft({ ...draft, melee: next })}
                />
              )}
            </>
          )}
        </div>

        {/* Right: per-tier scaling preview */}
        <aside className="w-[360px] shrink-0 border-l border-zinc-800 overflow-y-auto">
          <div className="px-3 py-2 border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
            Per-tier preview
          </div>
          {draft && draft.family !== 'melee' && draft.ranged ? (
            <TierTable ranged={draft.ranged} />
          ) : draft && draft.family === 'melee' && draft.melee ? (
            <MeleePreview melee={draft.melee} />
          ) : (
            <p className="px-3 py-3 text-xs text-zinc-500">
              Select a weapon to see how its stats scale across tiers.
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}

function BlueprintLink({ weaponId }: { weaponId: string }) {
  return (
    <div className="mt-2 text-[11px]">
      <Link
        href={`/editor/blueprints?id=${encodeURIComponent('bp_' + weaponId)}`}
        className="text-zinc-300 hover:text-zinc-100 underline decoration-zinc-700 hover:decoration-zinc-400"
      >
        Wire up a blueprint for this weapon →
      </Link>
      <div className="text-[10px] text-zinc-600 mt-0.5">
        Opens /editor/blueprints. If `bp_{weaponId}` doesn't exist yet,
        create it with that id and set recipeId to the matching recipe.
      </div>
    </div>
  );
}

function RangedFields({
  ranged,
  onChange,
}: {
  ranged: NonNullable<WeaponDef['ranged']>;
  onChange: (next: NonNullable<WeaponDef['ranged']>) => void;
}) {
  function patch<K extends keyof NonNullable<WeaponDef['ranged']>>(
    key: K,
    value: NonNullable<WeaponDef['ranged']>[K],
  ) {
    onChange({ ...ranged, [key]: value });
  }
  return (
    <>
      <FormSection title="Combat stats">
        <NumberField
          label="damage"
          value={ranged.damage}
          onChange={(v) => patch('damage', v)}
          min={0}
          step={1}
        />
        <NumberField
          label="fire interval (ms)"
          value={ranged.fireIntervalMs}
          onChange={(v) => patch('fireIntervalMs', v)}
          min={1}
          step={10}
          hint={`≈ ${(1000 / Math.max(1, ranged.fireIntervalMs)).toFixed(2)} shots/s`}
        />
        <NumberField
          label="magazine size"
          value={ranged.magazineSize}
          onChange={(v) => patch('magazineSize', v)}
          min={1}
          step={1}
        />
        <NumberField
          label="reload (ms)"
          value={ranged.reloadMs}
          onChange={(v) => patch('reloadMs', v)}
          min={0}
          step={50}
        />
        <NumberField
          label="accuracy (0..1)"
          value={ranged.accuracy}
          onChange={(v) => patch('accuracy', v)}
          min={0}
          max={1}
          step={0.01}
          hint="1.0 holds the aim ray dead-centre; 0.0 spreads to the full inaccuracy half-cone."
        />
      </FormSection>

      <FormSection title="Projectile">
        <EnumField<ProjectileKind>
          label="kind"
          value={ranged.projectile?.kind ?? 'single'}
          options={PROJECTILE_KINDS}
          onChange={(v) =>
            patch('projectile', { ...(ranged.projectile ?? {}), kind: v })
          }
          hint="single = one round per trigger; pellets = shotgun-style spread; explosive = on-impact AoE (runtime support pending)."
        />
        <NumberField
          label="speed (px/s)"
          value={ranged.projectileSpeed}
          onChange={(v) => patch('projectileSpeed', v)}
          min={1}
          step={50}
        />
        <NumberField
          label="ttl (ms)"
          value={ranged.projectileTtlMs}
          onChange={(v) => patch('projectileTtlMs', v)}
          min={50}
          step={50}
        />
        <NumberField
          label="radius (px)"
          value={ranged.projectileRadius}
          onChange={(v) => patch('projectileRadius', v)}
          min={1}
          step={1}
        />
        {(ranged.projectile?.kind ?? 'single') === 'pellets' && (
          <>
            <NumberField
              label="pellet count"
              value={ranged.pelletCount}
              onChange={(v) => patch('pelletCount', v)}
              min={2}
              step={1}
            />
            <NumberField
              label="spread (rad)"
              value={ranged.spreadRad}
              onChange={(v) => patch('spreadRad', v)}
              min={0}
              step={0.01}
              hint={`≈ ${((ranged.spreadRad * 180) / Math.PI).toFixed(1)}°`}
            />
          </>
        )}
        {ranged.projectile?.kind === 'explosive' && (
          <>
            <NumberField
              label="explosion radius (px)"
              value={ranged.projectile.explosionRadius ?? 60}
              onChange={(v) =>
                patch('projectile', {
                  kind: 'explosive',
                  explosionRadius: v,
                  explosionDamage: ranged.projectile?.explosionDamage,
                })
              }
              min={1}
              step={1}
            />
            <NumberField
              label="explosion damage"
              value={ranged.projectile.explosionDamage ?? 40}
              onChange={(v) =>
                patch('projectile', {
                  kind: 'explosive',
                  explosionRadius: ranged.projectile?.explosionRadius,
                  explosionDamage: v,
                })
              }
              min={0}
              step={1}
              hint="Applied to enemies within the radius on impact. Stacks with the direct hit on the primary target."
            />
          </>
        )}
      </FormSection>

      <FormSection title="Ammo">
        <FieldRow
          label="ammo kind"
          hint="The reserve-ammo bucket this weapon draws from. Adding a new ammo kind requires a code change in inventory.ts's AmmoKind union; the editor exposes the current set."
        >
          <select
            value={ranged.ammoKind}
            onChange={(e) => patch('ammoKind', e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            {AMMO_KINDS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </FieldRow>
      </FormSection>
    </>
  );
}

function MeleeFields({
  melee,
  onChange,
}: {
  melee: NonNullable<WeaponDef['melee']>;
  onChange: (next: NonNullable<WeaponDef['melee']>) => void;
}) {
  function patch<K extends keyof NonNullable<WeaponDef['melee']>>(
    key: K,
    value: NonNullable<WeaponDef['melee']>[K],
  ) {
    onChange({ ...melee, [key]: value });
  }
  return (
    <FormSection title="Melee stats">
      <NumberField
        label="damage"
        value={melee.damage}
        onChange={(v) => patch('damage', v)}
        min={1}
        step={1}
      />
      <NumberField
        label="swing interval (ms)"
        value={melee.swingIntervalMs}
        onChange={(v) => patch('swingIntervalMs', v)}
        min={50}
        step={10}
        hint={`≈ ${(1000 / Math.max(1, melee.swingIntervalMs)).toFixed(2)} swings/s`}
      />
      <NumberField
        label="range (px)"
        value={melee.range}
        onChange={(v) => patch('range', v)}
        min={20}
        step={5}
      />
      <NumberField
        label="arc (rad)"
        value={melee.arcRad}
        onChange={(v) => patch('arcRad', v)}
        min={0.1}
        max={Math.PI}
        step={0.05}
        hint={`≈ ${((melee.arcRad * 180) / Math.PI).toFixed(0)}° half-cone`}
      />
    </FormSection>
  );
}

// Per-tier scaling preview. Mirrors the math in
// shared/weaponStats.ts:effectiveWeaponStats — duplicated here
// because the source function takes a WeaponItem (runtime
// instance) rather than a raw stat sheet, and the editor's draft
// state is the latter.
function TierTable({
  ranged,
}: {
  ranged: NonNullable<WeaponDef['ranged']>;
}) {
  const rows = [1, 2, 3, 4].map((tier) => {
    const step = tier - 1;
    const damage = ranged.damage * (1 + 0.15 * step);
    const fireIntervalMs = ranged.fireIntervalMs * (1 - 0.05 * step);
    const magazineSize = ranged.magazineSize + step * 2;
    const accuracy = Math.min(1, ranged.accuracy + step * 0.02);
    const projectileSpeed = ranged.projectileSpeed * (1 + 0.05 * step);
    const spreadRad = ranged.spreadRad * (1 - 0.05 * step);
    const shotsPerSecond = 1000 / Math.max(1, fireIntervalMs);
    return {
      tier,
      damage,
      shotsPerSecond,
      dps: damage * shotsPerSecond * ranged.pelletCount,
      magazineSize,
      accuracy,
      projectileSpeed,
      spreadRad,
    };
  });
  return (
    <div className="p-3 text-[11px] text-zinc-300 space-y-3">
      <p className="text-[10px] text-zinc-500">
        Base stats × per-tier multiplier (no attachments, no
        affixes). DPS counts pellet multiplier for shotgun-style
        weapons.
      </p>
      <table className="w-full text-left">
        <thead className="text-[10px] text-zinc-500 uppercase">
          <tr>
            <th className="pb-1">Tier</th>
            <th className="pb-1 text-right">Dmg</th>
            <th className="pb-1 text-right">RoF</th>
            <th className="pb-1 text-right">DPS</th>
            <th className="pb-1 text-right">Mag</th>
            <th className="pb-1 text-right">Acc</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tier} className="border-t border-zinc-900">
              <td className="py-1 font-mono">T{r.tier}</td>
              <td className="py-1 text-right">{r.damage.toFixed(0)}</td>
              <td className="py-1 text-right">
                {r.shotsPerSecond.toFixed(2)}
              </td>
              <td className="py-1 text-right text-emerald-300">
                {r.dps.toFixed(0)}
              </td>
              <td className="py-1 text-right">{r.magazineSize}</td>
              <td className="py-1 text-right">
                {(r.accuracy * 100).toFixed(0)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[10px] text-zinc-500 leading-relaxed">
        Projectile: {ranged.projectile?.kind ?? 'single'} ·{' '}
        {ranged.projectileSpeed} px/s · ttl {ranged.projectileTtlMs} ms
        {ranged.pelletCount > 1 && ` · ${ranged.pelletCount} pellets`}
      </div>
    </div>
  );
}

function MeleePreview({
  melee,
}: {
  melee: NonNullable<WeaponDef['melee']>;
}) {
  const dps = melee.damage / (melee.swingIntervalMs / 1000);
  return (
    <div className="p-3 text-[11px] text-zinc-300 space-y-2">
      <p className="text-[10px] text-zinc-500">
        Melee weapons don't carry per-tier scaling yet — the tier-up
        system is ranged-only. Numbers shown are the single base
        configuration.
      </p>
      <dl className="grid grid-cols-2 gap-y-1">
        <dt className="text-zinc-500">damage</dt>
        <dd>{melee.damage}</dd>
        <dt className="text-zinc-500">swings/s</dt>
        <dd>{(1000 / Math.max(1, melee.swingIntervalMs)).toFixed(2)}</dd>
        <dt className="text-zinc-500">DPS</dt>
        <dd className="text-emerald-300">{dps.toFixed(0)}</dd>
        <dt className="text-zinc-500">range</dt>
        <dd>{melee.range} px</dd>
        <dt className="text-zinc-500">arc</dt>
        <dd>{((melee.arcRad * 180) / Math.PI).toFixed(0)}° half-cone</dd>
      </dl>
    </div>
  );
}
