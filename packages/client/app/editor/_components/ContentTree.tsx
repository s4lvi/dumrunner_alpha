'use client';

// Unified left-rail tree of every editor-managed entity. Lets
// the author jump between an enemy, the biome that uses it, and
// the room it spawns in without going through area-specific nav.
//
// Tree fetches all four content areas (biomes / enemies / props
// / rooms) once on mount + on a manual refresh. Each leaf links
// to /editor/<area>?id=<id> — pages read the ?id and select the
// entity automatically (see useEntityEditor's url sync).
//
// Search filters every leaf by id + label (case-insensitive).
// Empty search shows the full tree. Refresh is exposed via a
// callback so a save in another pane can keep the tree honest.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type {
  BiomeDef,
  CorridorTemplate,
  EnemyDef,
  PropDef,
  RoomTemplate,
} from '@dumrunner/shared';
import { listEntities } from '@/lib/editorContentClient';

type Lists = {
  biomes: BiomeDef[];
  enemies: EnemyDef[];
  props: PropDef[];
  rooms: RoomTemplate[];
  corridors: CorridorTemplate[];
};

const EMPTY_LISTS: Lists = {
  biomes: [],
  enemies: [],
  props: [],
  rooms: [],
  corridors: [],
};

export function ContentTree() {
  const [lists, setLists] = useState<Lists>(EMPTY_LISTS);
  const [search, setSearch] = useState('');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    biomes: true,
    rooms: true,
    corridors: true,
    enemies: true,
    props: true,
  });
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentId = searchParams.get('id');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [biomes, enemies, props, rooms, corridors] = await Promise.all([
          listEntities('biomes'),
          listEntities('enemies'),
          listEntities('props'),
          listEntities('rooms'),
          listEntities('corridors'),
        ]);
        if (cancelled) return;
        setLists({ biomes, enemies, props, rooms, corridors });
      } catch {
        // Silent — tree just stays empty if fetch fails. The
        // explicit /editor/<area> pages still work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const matches = useMemo(() => {
    function ok(id: string, label: string): boolean {
      if (!q) return true;
      return id.toLowerCase().includes(q) || label.toLowerCase().includes(q);
    }
    return {
      biomes: lists.biomes.filter((b) => ok(b.id, b.label)),
      enemies: lists.enemies.filter((e) => ok(e.id, e.label)),
      props: lists.props.filter((p) => ok(p.id, p.label)),
      rooms: lists.rooms.filter((r) => ok(r.id, r.label)),
      corridors: lists.corridors.filter((c) => ok(c.id, c.label)),
    };
  }, [lists, q]);

  function isActive(area: string, id: string): boolean {
    return pathname === `/editor/${area}` && currentId === id;
  }
  function isAreaActive(area: string): boolean {
    return pathname === `/editor/${area}`;
  }

  function toggleSection(key: string): void {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div className="flex flex-col h-full w-60 shrink-0 border-r border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="px-2 py-2 border-b border-zinc-800 shrink-0">
        <input
          type="text"
          placeholder="search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1 space-y-2 text-sm">
        <Section
          area="biomes"
          label="Biomes"
          open={openSections.biomes ?? true}
          onToggle={() => toggleSection('biomes')}
          items={matches.biomes}
          renderItem={(b) => (
            <span
              className="w-3 h-3 rounded border border-zinc-700 inline-block mr-1.5 align-middle"
              style={{ background: b.palette.floor }}
            />
          )}
          isActive={(b) => isActive('biomes', b.id)}
          isAreaActive={isAreaActive('biomes')}
          totalCount={lists.biomes.length}
        />
        <Section
          area="rooms"
          label="Rooms"
          open={openSections.rooms ?? true}
          onToggle={() => toggleSection('rooms')}
          items={matches.rooms}
          renderItem={(r) => (
            <span className="text-[9px] text-zinc-600 font-mono mr-1.5">
              {r.width}×{r.height}
            </span>
          )}
          isActive={(r) => isActive('rooms', r.id)}
          isAreaActive={isAreaActive('rooms')}
          totalCount={lists.rooms.length}
        />
        <Section
          area="corridors"
          label="Corridors"
          open={openSections.corridors ?? true}
          onToggle={() => toggleSection('corridors')}
          items={matches.corridors}
          renderItem={(c) => (
            <span className="text-[9px] text-zinc-600 font-mono mr-1.5">
              w{c.width}
            </span>
          )}
          isActive={(c) => isActive('corridors', c.id)}
          isAreaActive={isAreaActive('corridors')}
          totalCount={lists.corridors.length}
        />
        <Section
          area="enemies"
          label="Enemies"
          open={openSections.enemies ?? true}
          onToggle={() => toggleSection('enemies')}
          items={matches.enemies}
          renderItem={(e) => (
            <span
              className="w-3 h-3 rounded-full border border-zinc-700 inline-block mr-1.5 align-middle"
              style={{ background: e.visual.color }}
            />
          )}
          isActive={(e) => isActive('enemies', e.id)}
          isAreaActive={isAreaActive('enemies')}
          totalCount={lists.enemies.length}
        />
        <Section
          area="props"
          label="Props"
          open={openSections.props ?? true}
          onToggle={() => toggleSection('props')}
          items={matches.props}
          renderItem={(p) => (
            <span
              className="w-3 h-3 rounded border border-zinc-700 inline-block mr-1.5 align-middle"
              style={{ background: p.visual.tint ?? '#52525b' }}
            />
          )}
          isActive={(p) => isActive('props', p.id)}
          isAreaActive={isAreaActive('props')}
          totalCount={lists.props.length}
        />
        <div className="pt-2 border-t border-zinc-800 mt-2">
          <Link
            href="/editor/textures"
            className={`block px-2 py-1 rounded text-xs ${
              isAreaActive('textures')
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/40'
            }`}
          >
            Textures
          </Link>
          <Link
            href="/editor/sandbox-test"
            className={`block px-2 py-1 rounded text-xs ${
              isAreaActive('sandbox-test')
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/40'
            }`}
          >
            Sandbox
          </Link>
          <Link
            href="/editor/health"
            className={`block px-2 py-1 rounded text-xs ${
              isAreaActive('health')
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/40'
            }`}
          >
            Asset health
          </Link>
        </div>
      </div>
    </div>
  );
}

function Section<T extends { id: string; label: string }>({
  area,
  label,
  open,
  onToggle,
  items,
  renderItem,
  isActive,
  isAreaActive,
  totalCount,
}: {
  area: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  isActive: (item: T) => boolean;
  isAreaActive: boolean;
  totalCount: number;
}) {
  return (
    <div>
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className="text-zinc-500 text-[10px] w-4 text-center hover:text-zinc-300"
        >
          {open ? '▾' : '▸'}
        </button>
        <Link
          href={`/editor/${area}`}
          className={`flex-1 text-[10px] uppercase tracking-wider px-1 py-0.5 rounded ${
            isAreaActive
              ? 'text-zinc-100 bg-zinc-800/60'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {label}{' '}
          <span className="text-zinc-600 lowercase">({totalCount})</span>
        </Link>
      </div>
      {open && (
        <div className="ml-4">
          {items.length === 0 && (
            <div className="text-[10px] text-zinc-600 px-2 py-0.5">empty</div>
          )}
          {items.map((item) => (
            <Link
              key={item.id}
              href={`/editor/${area}?id=${encodeURIComponent(item.id)}`}
              className={`block px-2 py-0.5 rounded text-xs truncate ${
                isActive(item)
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/40'
              }`}
              title={item.id}
            >
              {renderItem(item)}
              <span className="align-middle">{item.label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
