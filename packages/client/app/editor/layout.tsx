// Top-nav layout shared by every /editor sub-route (textures,
// biomes, enemies, decorators, future ones). Renders the nav
// strip; each sub-route fills in its own main content. Keeps
// per-page imports light — no need to re-render the nav.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: { href: string; label: string }[] = [
  { href: '/editor/textures', label: 'Textures' },
  { href: '/editor/biomes', label: 'Biomes' },
  { href: '/editor/enemies', label: 'Enemies' },
  { href: '/editor/decorators', label: 'Decorators' },
];

export default function EditorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs uppercase tracking-wider text-zinc-500 mr-3">
          editor
        </span>
        {TABS.map((t) => {
          const active = pathname?.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`text-xs px-2 py-1 rounded ${
                active
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
