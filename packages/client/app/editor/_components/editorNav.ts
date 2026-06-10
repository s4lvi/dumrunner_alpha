// Editor navigation taxonomy. Three layers:
//   - Domains: top-level modes of work (World / Entities / Items /
//     Progression / Tools). One tile per domain in the activity
//     rail; clicking a tile lands on the first area in that domain.
//   - Areas: sibling pages inside a domain (e.g. World contains
//     Biomes / Rooms / Corridors). Surfaced as a horizontal pill
//     strip above the page content.
//   - Entities: the rows inside an area — owned by each area
//     page's own EntityList. Not part of the global chrome.
//
// This split keeps the global navigation a fixed-size surface
// (5 tiles + 2-4 pills) no matter how many entities exist.

export type EditorDomain =
  | 'world'
  | 'entities'
  | 'items'
  | 'progression'
  | 'tools';

export type EditorArea = {
  href: string;
  label: string;
};

export type DomainSpec = {
  id: EditorDomain;
  label: string;
  // Single-character glyph rendered in the activity tile. Keeps
  // the rail dependency-free (no icon library). The full label
  // sits underneath in smaller type.
  glyph: string;
  areas: EditorArea[];
};

export const DOMAINS: DomainSpec[] = [
  {
    id: 'world',
    label: 'World',
    glyph: '◰',
    areas: [
      { href: '/editor/biomes', label: 'Biomes' },
      { href: '/editor/rooms', label: 'Rooms' },
      { href: '/editor/scenes-csg', label: 'Scenes' },
    ],
  },
  {
    id: 'entities',
    label: 'Entities',
    glyph: '◉',
    areas: [
      { href: '/editor/enemies', label: 'Enemies' },
      { href: '/editor/props', label: 'Props' },
      { href: '/editor/buildings', label: 'Buildings' },
    ],
  },
  {
    id: 'items',
    label: 'Items',
    glyph: '◆',
    areas: [
      { href: '/editor/weapons', label: 'Weapons' },
      { href: '/editor/recipes', label: 'Recipes' },
      { href: '/editor/attachments', label: 'Attachments' },
    ],
  },
  {
    id: 'progression',
    label: 'Progression',
    glyph: '↟',
    areas: [
      { href: '/editor/blueprints', label: 'Blueprints' },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    glyph: '⚒',
    areas: [
      { href: '/editor/textures', label: 'Textures' },
      { href: '/editor/animations', label: 'Animations' },
      { href: '/editor/sandbox-test', label: 'Sandbox' },
      { href: '/editor/sandbox-test/anim', label: 'Anim preview' },
      { href: '/editor/health', label: 'Asset health' },
    ],
  },
];

// Find the domain that owns a given pathname. Falls back to
// 'world' when the path doesn't match any known area (e.g. on
// /editor itself). Matches by URL prefix so trailing slashes /
// query strings don't break the match.
export function domainForPath(pathname: string): EditorDomain {
  for (const d of DOMAINS) {
    for (const a of d.areas) {
      if (pathname === a.href || pathname.startsWith(a.href + '/')) {
        return d.id;
      }
    }
  }
  return 'world';
}

export function domainSpec(id: EditorDomain): DomainSpec {
  const d = DOMAINS.find((x) => x.id === id);
  if (!d) throw new Error(`unknown editor domain: ${id}`);
  return d;
}
