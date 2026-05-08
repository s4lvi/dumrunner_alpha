'use client';

// Corridor template editor. Same three-pane layout as the prop
// and enemy editors. Schema is small — id/label/biomeAffinity,
// width, weight, style. The procgen consults these per edge
// when stamping connectors between rooms; biomes with no
// templates fall back to the default 2-tile rect strip.
//
// `tilesB64` / `patternLength` (decorative tile patterns) are
// reserved for a future slice and intentionally not exposed in
// the form yet — they require a paint surface that doesn't
// exist. Authors who want to experiment can hand-edit the JSON.

import { Suspense, useEffect, useState } from 'react';
import type { CorridorStyle, CorridorTemplate } from '@dumrunner/shared';
import { listEntities } from '@/lib/editorContentClient';
import {
  Button,
  EnumField,
  FormSection,
  NumberField,
  TextField,
} from '../_components/Form';
import { useEntityEditor } from '../_components/useEntityEditor';
import { EntityList } from '../_components/EntityList';
import { ReferencesPanel } from '../_components/ReferencesPanel';

const STYLES: readonly CorridorStyle[] = ['door', 'open', 'tunnel', 'organic'];

function makeBlank(id = 'new_corridor'): CorridorTemplate {
  return {
    id,
    label: 'New Corridor',
    biomeAffinity: [],
    width: 2,
    weight: 1,
    style: 'open',
  };
}

export default function CorridorEditorPage() {
  // useEntityEditor reads useSearchParams; wrap the body in
  // Suspense so the static prerender pass doesn't bail on the
  // CSR hook.
  return (
    <Suspense fallback={null}>
      <CorridorEditorBody />
    </Suspense>
  );
}

function CorridorEditorBody() {
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
  } = useEntityEditor<CorridorTemplate>('corridors', {
    makeBlank,
    newIdPrefix: 'corridor',
  });

  return (
    <div className="flex h-full w-full">
      <EntityList<CorridorTemplate>
        title="Corridors"
        entries={entries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={createNew}
        emptyHint="No corridor templates yet. Click + new."
        renderItem={(c) => (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-zinc-500 w-6">
              w{c.width}
            </span>
            <span className="flex-1 truncate">{c.label}</span>
            <span className="text-[9px] text-zinc-600 font-mono">
              {c.style}
            </span>
          </div>
        )}
      />

      <main className="flex-1 overflow-y-auto p-4 min-w-0">
        {!draft && (
          <div className="text-zinc-500 text-sm pt-12 text-center">
            Select a corridor on the left, or create a new one.
          </div>
        )}
        {draft && (
          <div className="max-w-2xl">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-lg font-bold">{draft.label}</h1>
              <div className="flex gap-2">
                <Button variant="danger" onClick={remove}>
                  Delete
                </Button>
                <Button variant="primary" disabled={saving} onClick={save}>
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

            <FormSection title="Shape">
              <NumberField
                label="width (tiles)"
                value={draft.width}
                min={1}
                max={6}
                step={1}
                onChange={(v) => setDraft({ ...draft, width: v })}
                hint="perpendicular to the corridor's length. 2 is the legacy default; 3-4 reads as walkway, 5-6 as wide hall."
              />
              <NumberField
                label="weight"
                value={draft.weight}
                min={0.01}
                step={0.5}
                onChange={(v) => setDraft({ ...draft, weight: v })}
                hint="selection weight among biome-affinity matches. 1 = baseline."
              />
              <EnumField<CorridorStyle>
                label="style"
                value={draft.style}
                options={STYLES}
                onChange={(s) => setDraft({ ...draft, style: s })}
              />
            </FormSection>
          </div>
        )}
      </main>

      <aside className="w-72 shrink-0 border-l border-zinc-800 p-3 overflow-y-auto">
        <h2 className="text-xs uppercase text-zinc-500 mb-2">Preview</h2>
        {draft ? (
          <div className="space-y-3">
            <CorridorStripPreview width={draft.width} />
            <div className="text-[11px] text-zinc-400 space-y-0.5 font-mono">
              <div>id: {draft.id}</div>
              <div>width: {draft.width} tiles</div>
              <div>weight: {draft.weight}</div>
              <div>style: {draft.style}</div>
              <div>biomes: {draft.biomeAffinity.join(', ') || '(none)'}</div>
            </div>
            <div className="border-t border-zinc-800 mt-2 pt-2">
              <ReferencesPanel area="corridors" id={draft.id} />
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Select or create a corridor to preview.
          </p>
        )}
      </aside>
    </div>
  );
}

// Schematic top-down strip. Cell size scales so width=1 still
// reads as a corridor (not a single dot) and width=6 doesn't
// blow past the panel.
function CorridorStripPreview({ width }: { width: number }) {
  const length = 12;
  const cell = Math.max(8, Math.min(18, Math.floor(220 / length)));
  return (
    <div
      className="rounded border border-zinc-700 p-2 flex items-center justify-center"
      style={{ background: '#0b0d10' }}
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${length}, ${cell}px)`,
          gridTemplateRows: `repeat(${width}, ${cell}px)`,
          gap: 1,
        }}
      >
        {Array.from({ length: width * length }, (_, i) => (
          <div
            key={i}
            style={{
              width: cell,
              height: cell,
              background: '#3f3f46',
              border: '1px solid #18181b',
            }}
          />
        ))}
      </div>
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
