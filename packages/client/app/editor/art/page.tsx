'use client';

// Art audit board — every sprite slot the game wants, its coverage
// status, a pixel-perfect preview, and approve/reject controls that
// feed the art worker's queue (rejects re-generate with the note).

import { useCallback, useEffect, useMemo, useState } from 'react';

type Review = { verdict: 'approved' | 'rejected'; note?: string; at: string };

type Slot = {
  key: string;
  category: string;
  id: string;
  label: string;
  tiles: { w: number; h: number };
  wantsAnimation: boolean;
  requiredStates: string[];
  animationId: string | null;
  required: boolean;
  status: 'animated' | 'static' | 'partial' | 'missing';
  presentStates: string[];
  detail: string | null;
  hasDirection: boolean;
  review: Review | null;
};

const STATUS_STYLE: Record<Slot['status'], string> = {
  animated: 'border-emerald-600/60 text-emerald-400',
  static: 'border-sky-600/60 text-sky-400',
  partial: 'border-amber-500/60 text-amber-300',
  missing: 'border-red-500/60 text-red-400',
};

function previewCandidates(s: Slot): string[] {
  const out: string[] = [];
  if (s.animationId) {
    for (const st of ['idle', ...s.presentStates]) {
      out.push(`/textures/anim/${s.animationId}/${st}/0.png`);
      out.push(`/textures/anim/${s.animationId}/${st}.png`);
    }
  }
  out.push(`/textures/${s.category}/${s.id}.png`);
  out.push(`/textures/${s.category}/${s.id}.webp`);
  return [...new Set(out)];
}

function Preview({ slot }: { slot: Slot }) {
  const candidates = useMemo(() => previewCandidates(slot), [slot]);
  const [i, setI] = useState(0);
  if (i >= candidates.length) {
    return (
      <div className="w-16 h-16 flex items-center justify-center text-zinc-700 font-mono text-[10px] border border-dashed border-zinc-800 rounded">
        no art
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={candidates[i]}
      alt={slot.key}
      onError={() => setI((v) => v + 1)}
      className="w-16 h-16 object-contain bg-[#16181c] border border-zinc-800 rounded"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

export default function ArtAuditPage() {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'gaps' | 'all'>('gaps');

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/editor/art-audit');
      const j = (await r.json()) as { slots?: Slot[]; error?: string };
      if (!r.ok || !j.slots) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSlots(j.slots);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function setVerdict(
    key: string,
    verdict: 'approved' | 'rejected' | 'clear',
  ) {
    let note: string | undefined;
    if (verdict === 'rejected') {
      note = window.prompt('What should change?') ?? undefined;
      if (note === undefined) return;
    }
    const r = await fetch('/api/editor/art-audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, verdict, note }),
    });
    if (r.ok) void reload();
  }

  const visible = (slots ?? []).filter((s) =>
    filter === 'all'
      ? true
      : (s.required && s.status !== 'animated' && s.status !== 'static') ||
        s.review !== null ||
        s.status === 'animated' ||
        s.status === 'static',
  );
  const byCategory = new Map<string, Slot[]>();
  for (const s of visible) {
    const l = byCategory.get(s.category) ?? [];
    l.push(s);
    byCategory.set(s.category, l);
  }
  const covered = (slots ?? []).filter(
    (s) => s.required && (s.status === 'animated' || s.status === 'static'),
  ).length;
  const requiredTotal = (slots ?? []).filter((s) => s.required).length;

  return (
    <main className="min-h-screen px-6 py-8 max-w-6xl mx-auto">
      <header className="mb-6 flex items-baseline gap-4 flex-wrap">
        <h1 className="font-mono font-bold tracking-[0.25em] text-xl">
          ART AUDIT
        </h1>
        {slots && (
          <span className="font-mono text-xs text-zinc-500">
            {covered}/{requiredTotal} required covered
          </span>
        )}
        <div className="ml-auto flex gap-2 font-mono text-xs">
          {(['gaps', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-sm border ${
                filter === f
                  ? 'border-[color:var(--accent)] text-[color:var(--accent)]'
                  : 'border-zinc-700 text-zinc-500'
              }`}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {!slots && !error && <p className="text-zinc-500 text-sm">Loading…</p>}

      {[...byCategory.entries()].sort().map(([category, list]) => (
        <section key={category} className="mb-8">
          <h2 className="font-mono text-xs tracking-[0.25em] text-zinc-400 mb-3">
            {category.toUpperCase()}{' '}
            <span className="text-zinc-600">[{list.length}]</span>
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((s) => (
              <div
                key={s.key}
                className="flex gap-3 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded p-3"
              >
                <Preview slot={s} />
                <div className="min-w-0 flex-1 flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm truncate">{s.id}</span>
                    <span
                      className={`font-mono text-[9px] tracking-widest border rounded-sm px-1 py-0.5 ${STATUS_STYLE[s.status]}`}
                    >
                      {s.status.toUpperCase()}
                    </span>
                    {!s.required && (
                      <span className="font-mono text-[9px] text-zinc-600">
                        OPT
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-500">
                    {s.tiles.w}x{s.tiles.h}
                    {s.wantsAnimation &&
                      ` · states ${s.presentStates.length}/${s.requiredStates.length}`}
                    {s.hasDirection && ' · brief ✓'}
                  </div>
                  {s.detail && (
                    <div className="text-[11px] text-zinc-500 truncate" title={s.detail}>
                      {s.detail}
                    </div>
                  )}
                  {s.review && (
                    <div
                      className={`text-[11px] truncate ${
                        s.review.verdict === 'approved'
                          ? 'text-emerald-400'
                          : 'text-red-400'
                      }`}
                      title={s.review.note}
                    >
                      {s.review.verdict}
                      {s.review.note ? ` — ${s.review.note}` : ''}
                    </div>
                  )}
                  <div className="mt-auto flex gap-2 pt-1 font-mono text-[10px]">
                    <button
                      onClick={() => void setVerdict(s.key, 'approved')}
                      className="px-2 py-0.5 rounded-sm border border-emerald-800 text-emerald-400 hover:bg-emerald-900/20"
                    >
                      APPROVE
                    </button>
                    <button
                      onClick={() => void setVerdict(s.key, 'rejected')}
                      className="px-2 py-0.5 rounded-sm border border-red-900 text-red-400 hover:bg-red-900/20"
                    >
                      REJECT
                    </button>
                    {s.review && (
                      <button
                        onClick={() => void setVerdict(s.key, 'clear')}
                        className="px-2 py-0.5 rounded-sm border border-zinc-700 text-zinc-500 hover:bg-zinc-800"
                      >
                        CLEAR
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
