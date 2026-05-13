'use client';

// Vertical activity rail. One tile per editor domain (World /
// Entities / Items / Progression / Tools). Clicking a tile
// navigates to the first area in that domain — the per-area
// pill strip (DomainNav) handles sibling switching after that.
//
// The rail is intentionally fixed-size — no entity listings, no
// per-domain counts. Three levels of nav, each answering one
// question:
//   1. Which mode of work? — answered here.
//   2. Which sibling area in that mode? — DomainNav.
//   3. Which entity? — the area page's own EntityList.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOMAINS, domainForPath } from './editorNav';

export function ActivityBar() {
  const pathname = usePathname() ?? '/editor';
  const activeDomain = domainForPath(pathname);

  return (
    <nav
      aria-label="Editor activity"
      className="w-14 shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col py-2"
    >
      <Link
        href="/editor"
        className="flex flex-col items-center justify-center py-2 mb-1 text-zinc-500 hover:text-zinc-200 text-[9px] uppercase tracking-[0.1em]"
        title="Editor home"
      >
        <span className="text-base leading-none">▤</span>
      </Link>
      <div className="border-t border-zinc-800 mx-2 mb-1" />
      {DOMAINS.map((d) => {
        const active = d.id === activeDomain;
        const dest = d.areas[0]?.href ?? '/editor';
        return (
          <Link
            key={d.id}
            href={dest}
            title={d.label}
            className={`flex flex-col items-center justify-center py-2 mx-1 my-0.5 rounded
              ${
                active
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-200'
              }`}
          >
            <span className="text-lg leading-none">{d.glyph}</span>
            <span className="text-[8px] uppercase tracking-[0.08em] mt-1">
              {d.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
