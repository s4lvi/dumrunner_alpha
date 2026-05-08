// Editor layout: left rail content tree + thin top label.
// Tree (ContentTree) is the canonical navigator — search across
// all entity types, click a leaf to open it. Per-area pages
// keep their own EntityList sidebar for now (redundant but
// functional); future pass deletes the per-area sidebars and
// drives selection purely through the tree's ?id link.

'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { ContentTree } from './_components/ContentTree';

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
        <Suspense
          fallback={
            <div className="w-60 shrink-0 border-r border-zinc-800 bg-zinc-950" />
          }
        >
          <ContentTree />
        </Suspense>
        <div className="flex-1 min-w-0 min-h-0">{children}</div>
      </div>
    </div>
  );
}
