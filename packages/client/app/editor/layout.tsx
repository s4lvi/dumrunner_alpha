// Editor layout. Three nav layers, none overlapping:
//
//   ActivityBar (left rail, 56px)  →  which domain of work?
//   DomainNav  (top pill strip)    →  which sibling area in that domain?
//   <page>     (area's own list)   →  which entity to edit?
//
// The chrome stays a fixed size — 5 tiles + up to a handful of
// pills — no matter how many entities exist. Adding a new area
// is one entry in _components/editorNav.ts; the rail / pills /
// breadcrumb pick it up automatically.

'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { ActivityBar } from './_components/ActivityBar';
import { DomainNav } from './_components/DomainNav';

export default function EditorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <Link
          href="/editor"
          className="text-xs uppercase tracking-wider text-zinc-300 hover:text-zinc-100"
        >
          editor
        </Link>
        <span className="text-[10px] text-zinc-600 ml-auto">
          /editor — content authoring
        </span>
      </header>
      <div className="flex-1 min-h-0 flex">
        <ActivityBar />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <Suspense fallback={null}>
            <DomainNav />
          </Suspense>
          <div className="flex-1 min-h-0 min-w-0">{children}</div>
        </div>
      </div>
    </div>
  );
}
