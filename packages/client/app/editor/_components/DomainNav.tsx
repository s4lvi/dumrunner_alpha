'use client';

// Horizontal pill strip for sibling areas in the active domain.
// Sits between the global header and the page content; lets the
// author swap between Biomes / Rooms / Corridors without leaving
// the World domain. Hidden when a domain has only one area
// (e.g. Progression today has just Blueprints) — no point
// rendering a strip with a single pill.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { domainForPath, domainSpec } from './editorNav';

export function DomainNav() {
  const pathname = usePathname() ?? '/editor';
  const domain = domainSpec(domainForPath(pathname));
  if (domain.areas.length <= 1) return null;

  return (
    <nav
      aria-label={`${domain.label} areas`}
      className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800 bg-zinc-950/80 shrink-0"
    >
      <span className="text-[9px] uppercase tracking-[0.1em] text-zinc-600 mr-2">
        {domain.label}
      </span>
      {domain.areas.map((a) => {
        const active =
          pathname === a.href || pathname.startsWith(a.href + '/');
        return (
          <Link
            key={a.href}
            href={a.href}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors
              ${
                active
                  ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
              }`}
          >
            {a.label}
          </Link>
        );
      })}
    </nav>
  );
}
