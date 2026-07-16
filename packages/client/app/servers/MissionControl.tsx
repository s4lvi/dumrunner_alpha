'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { WorldStatus } from '@dumrunner/shared';
import { DeleteServerButton } from './DeleteServerButton';
import { JoinByIdForm } from './JoinByIdForm';

export type ServerRow = {
  id: string;
  name: string;
  visibility: string;
  max_slots: number;
  owner_id: string;
  created_at: string;
  has_password: boolean;
  is_paused: boolean;
  mode: 'live' | 'deathmatch' | null;
  arena_scene_id: string | null;
  player_count: number | null;
  world_status: WorldStatus | null;
  world_status_at: string | null;
};

// A heartbeat older than this is a sleeping world: the game server
// only publishes while its tick loop runs, and the loop stops when
// the last player leaves. 90s = 6 missed 15s beats of slack.
const STALE_MS = 90_000;
// Countdown threshold where CALM flips to PRE-STORM.
const PRE_STORM_S = 120;

type Phase =
  | { key: 'PAUSED' }
  | { key: 'ASLEEP'; status: WorldStatus | null }
  | { key: 'HORDE'; seconds: number; status: WorldStatus }
  | { key: 'PRE-STORM'; seconds: number; status: WorldStatus }
  | { key: 'CALM'; seconds: number; status: WorldStatus }
  | { key: 'ARENA'; live: boolean };

function phaseOf(s: ServerRow, nowMs: number): Phase {
  if (s.is_paused) return { key: 'PAUSED' };
  if (s.mode === 'deathmatch') {
    return { key: 'ARENA', live: (s.player_count ?? 0) > 0 };
  }
  const st = s.world_status;
  const at = s.world_status_at ? Date.parse(s.world_status_at) : NaN;
  if (!st || st.v !== 1 || !Number.isFinite(at) || nowMs - at > STALE_MS) {
    return { key: 'ASLEEP', status: st ?? null };
  }
  // Advance the published countdown by the heartbeat's age so the
  // clock ticks between beats.
  const age = Math.max(0, Math.floor((nowMs - at) / 1000));
  const seconds = Math.max(0, (st.secondsToPerihelion ?? 0) - age);
  if (st.hordeActive) return { key: 'HORDE', seconds, status: st };
  if (seconds <= PRE_STORM_S) return { key: 'PRE-STORM', seconds, status: st };
  return { key: 'CALM', seconds, status: st };
}

function fmtClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const PHASE_STYLE: Record<string, string> = {
  CALM: 'border-emerald-600/60 text-emerald-400',
  'PRE-STORM': 'border-amber-500/60 text-amber-300 phase-blink',
  HORDE: 'border-red-500/70 text-red-400 phase-blink',
  ASLEEP: 'border-zinc-700 text-zinc-500',
  PAUSED: 'border-amber-800/60 text-amber-500',
  ARENA: 'border-red-800/60 text-red-400',
};

function PhaseChip({ phase }: { phase: Phase }) {
  const label =
    phase.key === 'ARENA' ? (phase.live ? 'ARENA·LIVE' : 'ARENA') : phase.key;
  return (
    <span
      className={`inline-block font-mono text-[10px] tracking-[0.15em] border rounded-sm px-1.5 py-0.5 ${PHASE_STYLE[phase.key]}`}
    >
      {label}
    </span>
  );
}

function LinkBar({ status }: { status: WorldStatus }) {
  if (status.linkMaxHp == null) return null;
  const hp = status.linkHp ?? 0;
  const frac = status.linkHp === null ? 0 : Math.max(0, hp / status.linkMaxHp);
  const down = status.linkHp === null;
  const color =
    down || frac < 0.25
      ? 'bg-red-500'
      : frac < 0.6
        ? 'bg-amber-400'
        : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <span className="text-zinc-500 tracking-widest">LINK</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-sm overflow-hidden">
        <div
          className={`h-full ${color}`}
          style={{ width: `${Math.round(frac * 100)}%` }}
        />
      </div>
      <span className={down ? 'text-red-400' : 'text-zinc-400'}>
        {down ? 'SEVERED' : `${hp}/${status.linkMaxHp}`}
      </span>
    </div>
  );
}

// Countdown / cycle line for a live-world phase.
function PhaseLine({ phase }: { phase: Phase }) {
  if (phase.key === 'HORDE') {
    return (
      <span className="text-red-400">
        HORDE · ENDS {fmtClock(phase.seconds)}
      </span>
    );
  }
  if (phase.key === 'PRE-STORM' || phase.key === 'CALM') {
    return (
      <span className={phase.key === 'PRE-STORM' ? 'text-amber-300' : 'text-zinc-400'}>
        PERIHELION T-{fmtClock(phase.seconds)}
      </span>
    );
  }
  if (phase.key === 'ASLEEP') {
    return <span className="text-zinc-600">CLOCK FROZEN</span>;
  }
  return null;
}

function crewOf(s: ServerRow): number {
  // Prefer the heartbeat's count when fresh-ish; fall back to the
  // characters-derived view count.
  return s.world_status?.players ?? s.player_count ?? 0;
}

export function MissionControl({
  servers,
  currentUserId,
  notice,
}: {
  servers: ServerRow[];
  currentUserId: string;
  notice: string | null;
}) {
  // Tick once a second so countdowns run between heartbeats. `now`
  // is null until mounted — SSR renders the static frame and the
  // clocks appear on hydration, avoiding a server/client mismatch.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [dossierId, setDossierId] = useState<string | null>(null);
  useEffect(() => {
    if (!dossierId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDossierId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dossierId]);

  const mine = useMemo(
    () => servers.filter((s) => s.owner_id === currentUserId),
    [servers, currentUserId],
  );
  const openColonies = useMemo(
    () =>
      servers.filter(
        (s) =>
          s.owner_id !== currentUserId &&
          s.visibility === 'public' &&
          s.mode !== 'deathmatch',
      ),
    [servers, currentUserId],
  );
  const arenas = useMemo(
    () =>
      servers.filter(
        (s) => s.visibility === 'public' && s.mode === 'deathmatch',
      ),
    [servers],
  );

  const dossier = dossierId
    ? servers.find((s) => s.id === dossierId) ?? null
    : null;

  return (
    <main className="min-h-screen px-4 sm:px-6 py-8 max-w-6xl mx-auto">
      {notice && (
        <div className="mb-6 text-sm text-amber-300 border border-amber-700/40 bg-amber-900/20 rounded px-4 py-3">
          {notice}
        </div>
      )}

      <header className="mb-8 scanlines border border-[color:var(--panel-border)] rounded bg-[color:var(--panel)] px-5 py-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="font-mono font-bold tracking-[0.3em] text-lg text-zinc-100">
            MISSION CONTROL
          </h1>
          <p className="font-mono text-[11px] text-zinc-500 tracking-widest mt-1">
            DÛM ORBITAL RELAY<span className="cursor-blink">▮</span>
          </p>
        </div>
        <Link
          href="/servers/new"
          className="shrink-0 font-mono text-sm tracking-widest px-4 py-2 rounded-sm bg-[color:var(--accent)] text-black font-bold hover:brightness-110"
        >
          FOUND COLONY
        </Link>
      </header>

      <SectionHeader label="YOUR DEPLOYMENTS" count={mine.length} />
      {mine.length === 0 ? (
        <p className="text-sm text-zinc-500 mb-10">
          No colonies under your command.{' '}
          <Link href="/servers/new" className="underline">
            Found one.
          </Link>
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mb-10">
          {mine.map((s) => (
            <DeploymentCard
              key={s.id}
              server={s}
              now={now}
              onDossier={() => setDossierId(s.id)}
            />
          ))}
        </div>
      )}

      <SectionHeader label="OPEN COLONIES" count={openColonies.length} />
      {openColonies.length === 0 ? (
        <p className="text-sm text-zinc-500 mb-10">No open colonies on the relay.</p>
      ) : (
        <div className="mb-10 border border-[color:var(--panel-border)] rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono text-[10px] tracking-[0.2em] text-zinc-500 border-b border-[color:var(--panel-border)] bg-[color:var(--panel)]">
                <th className="text-left px-3 py-2">STATUS</th>
                <th className="text-left px-3 py-2">COLONY</th>
                <th className="text-left px-3 py-2">CREW</th>
                <th className="text-left px-3 py-2 hidden sm:table-cell">CYCLE</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">CLOCK</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">FRONTIER</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {openColonies.map((s) => (
                <ColonyRow
                  key={s.id}
                  server={s}
                  now={now}
                  onDossier={() => setDossierId(s.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {arenas.length > 0 && (
        <>
          <SectionHeader label="DEATHMATCH ARENAS" count={arenas.length} />
          <ul className="space-y-2 mb-10">
            {arenas.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded px-4 py-3"
              >
                <PhaseChip phase={{ key: 'ARENA', live: (s.player_count ?? 0) > 0 }} />
                <span className="font-semibold truncate">{s.name}</span>
                <span className="font-mono text-xs text-zinc-500">
                  {s.arena_scene_id}
                </span>
                <span className="ml-auto font-mono text-xs text-zinc-400">
                  {s.player_count ?? 0}/{s.max_slots}
                </span>
                <JoinLink server={s} isOwner={s.owner_id === currentUserId} />
              </li>
            ))}
          </ul>
        </>
      )}

      <section className="pt-8 border-t border-[color:var(--panel-border)] max-w-md">
        <SectionHeader label="JOIN BY CODE" count={null} />
        <JoinByIdForm />
      </section>

      {dossier && (
        <Dossier
          server={dossier}
          now={now}
          isOwner={dossier.owner_id === currentUserId}
          onClose={() => setDossierId(null)}
        />
      )}
    </main>
  );
}

function SectionHeader({ label, count }: { label: string; count: number | null }) {
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <h2 className="font-mono text-xs tracking-[0.25em] text-zinc-400">
        {label}
      </h2>
      {count !== null && (
        <span className="font-mono text-[10px] text-zinc-600">[{count}]</span>
      )}
      <div className="flex-1 border-t border-dashed border-[color:var(--panel-border)]" />
    </div>
  );
}

function JoinLink({ server, isOwner }: { server: ServerRow; isOwner: boolean }) {
  if (server.is_paused && !isOwner) {
    return (
      <span className="px-3 py-1.5 rounded-sm border border-[color:var(--panel-border)] text-zinc-600 font-mono text-xs tracking-widest">
        PAUSED
      </span>
    );
  }
  return (
    <Link
      href={`/play/${server.id}`}
      className="px-3 py-1.5 rounded-sm border border-[color:var(--accent)]/50 text-[color:var(--accent)] hover:bg-[color:var(--accent)] hover:text-black font-mono text-xs tracking-widest transition-colors"
    >
      {server.is_paused && isOwner ? 'RESUME' : 'DROP IN'}
    </Link>
  );
}

function DeploymentCard({
  server,
  now,
  onDossier,
}: {
  server: ServerRow;
  now: number | null;
  onDossier: () => void;
}) {
  const phase = phaseOf(server, now ?? 0);
  const st = server.world_status;
  return (
    <div className="scanlines bg-[color:var(--panel)] border border-[color:var(--panel-border)] rounded p-4 flex flex-col gap-3 hover:border-[color:var(--accent)]/40 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <button
          onClick={onDossier}
          className="font-semibold text-left truncate hover:text-[color:var(--accent)]"
        >
          {server.name}
        </button>
        <PhaseChip phase={phase} />
      </div>
      <div className="font-mono text-[11px] text-zinc-500 flex items-center gap-2 flex-wrap">
        <span>{server.id.slice(0, 8)}</span>
        <span>·</span>
        <span>{server.visibility}</span>
        {server.has_password && (
          <>
            <span>·</span>
            <span>locked</span>
          </>
        )}
        {st?.cycle !== undefined && (
          <>
            <span>·</span>
            <span>cycle {st.cycle}</span>
          </>
        )}
      </div>
      {now !== null && phase.key !== 'PAUSED' && phase.key !== 'ARENA' && (
        <div className="font-mono text-xs">
          <PhaseLine phase={phase} />
        </div>
      )}
      {st && phase.key !== 'ASLEEP' && phase.key !== 'PAUSED' && (
        <LinkBar status={st} />
      )}
      <div className="font-mono text-[11px] text-zinc-400 flex items-center gap-3">
        <span>
          CREW {crewOf(server)}/{server.max_slots}
        </span>
        {st?.deepestFloor !== undefined && <span>FRONTIER F{st.deepestFloor}</span>}
      </div>
      <div className="mt-auto flex items-center gap-2 pt-1">
        <JoinLink server={server} isOwner />
        <div className="ml-auto">
          <DeleteServerButton serverId={server.id} />
        </div>
      </div>
    </div>
  );
}

function ColonyRow({
  server,
  now,
  onDossier,
}: {
  server: ServerRow;
  now: number | null;
  onDossier: () => void;
}) {
  const phase = phaseOf(server, now ?? 0);
  const st = server.world_status;
  return (
    <tr
      onClick={onDossier}
      className="border-b border-[color:var(--panel-border)] last:border-b-0 hover:bg-[color:var(--panel)] cursor-pointer"
    >
      <td className="px-3 py-2.5">
        <PhaseChip phase={phase} />
      </td>
      <td className="px-3 py-2.5">
        <div className="font-semibold flex items-center gap-2">
          <span className="truncate max-w-[16rem]">{server.name}</span>
          {server.has_password && (
            <span className="font-mono text-[10px] text-zinc-500">🔒</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-zinc-400">
        {crewOf(server)}/{server.max_slots}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-zinc-400 hidden sm:table-cell">
        {st?.cycle ?? '—'}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs hidden md:table-cell">
        {now !== null ? <PhaseLine phase={phase} /> : '—'}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-zinc-400 hidden md:table-cell">
        {st?.deepestFloor !== undefined ? `F${st.deepestFloor}` : '—'}
      </td>
      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
        <JoinLink server={server} isOwner={false} />
      </td>
    </tr>
  );
}

function Dossier({
  server,
  now,
  isOwner,
  onClose,
}: {
  server: ServerRow;
  now: number | null;
  isOwner: boolean;
  onClose: () => void;
}) {
  const phase = phaseOf(server, now ?? 0);
  const st = server.world_status;
  const founded = new Date(server.created_at).toLocaleDateString();
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="dossier-in absolute right-0 top-0 h-full w-full max-w-sm bg-[color:var(--panel)] border-l border-[color:var(--panel-border)] scanlines p-5 overflow-y-auto flex flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.25em] text-zinc-500 mb-1">
              COLONY DOSSIER
            </div>
            <h2 className="text-xl font-bold leading-tight">{server.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="font-mono text-zinc-500 hover:text-zinc-200 px-2 py-1"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2">
          <PhaseChip phase={phase} />
          {now !== null && (
            <span className="font-mono text-xs">
              <PhaseLine phase={phase} />
            </span>
          )}
        </div>

        {st && phase.key !== 'ASLEEP' && phase.key !== 'PAUSED' && (
          <LinkBar status={st} />
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 font-mono text-xs">
          <DossierStat label="CREW" value={`${crewOf(server)}/${server.max_slots}`} />
          <DossierStat label="CYCLE" value={st?.cycle !== undefined ? String(st.cycle) : '—'} />
          <DossierStat
            label="FRONTIER"
            value={st?.deepestFloor !== undefined ? `FLOOR ${st.deepestFloor}` : '—'}
          />
          <DossierStat label="FOUNDED" value={founded} />
          <DossierStat label="ACCESS" value={server.has_password ? 'LOCKED' : 'OPEN'} />
          <DossierStat label="VISIBILITY" value={server.visibility.toUpperCase()} />
        </dl>

        <div className="font-mono text-[11px] text-zinc-500 break-all">
          <span className="tracking-[0.2em] text-zinc-600">ID </span>
          {server.id}
        </div>

        <div className="mt-auto pt-4 border-t border-[color:var(--panel-border)] flex items-center gap-2">
          <JoinLink server={server} isOwner={isOwner} />
          {isOwner && <DeleteServerButton serverId={server.id} />}
        </div>
      </aside>
    </div>
  );
}

function DossierStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-[0.2em] text-zinc-600">{label}</dt>
      <dd className="text-zinc-300 mt-0.5">{value}</dd>
    </div>
  );
}
