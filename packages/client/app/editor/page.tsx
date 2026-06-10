import {
  loadAnimations,
  loadAttachments,
  loadBiomes,
  loadBlueprints,
  loadEnemies,
  loadProps,
  loadRecipes,
  loadRooms,
  loadScenes,
  loadWeapons,
} from '@dumrunner/shared/content/loader';

export const dynamic = 'force-dynamic';

type CountRow = { label: string; n: number; href: string };
type Group = { label: string; rows: CountRow[] };

export default async function EditorIndex() {
  const [
    biomes,
    rooms,
    scenes,
    enemies,
    props,
    weapons,
    recipes,
    attachments,
    blueprints,
    animations,
  ] = await Promise.all([
    loadBiomes(),
    loadRooms(),
    loadScenes(),
    loadEnemies(),
    loadProps(),
    loadWeapons(),
    loadRecipes(),
    loadAttachments(),
    loadBlueprints(),
    loadAnimations(),
  ]);

  const groups: Group[] = [
    {
      label: 'World',
      rows: [
        { label: 'biomes', n: biomes.length, href: '/editor/biomes' },
        { label: 'rooms', n: rooms.length, href: '/editor/rooms' },
        { label: 'scenes', n: scenes.length, href: '/editor/scenes-csg' },
      ],
    },
    {
      label: 'Entities',
      rows: [
        { label: 'enemies', n: enemies.length, href: '/editor/enemies' },
        { label: 'props', n: props.length, href: '/editor/props' },
      ],
    },
    {
      label: 'Items',
      rows: [
        { label: 'weapons', n: weapons.length, href: '/editor/weapons' },
        { label: 'recipes', n: recipes.length, href: '/editor/recipes' },
        {
          label: 'attachments',
          n: attachments.length,
          href: '/editor/attachments',
        },
      ],
    },
    {
      label: 'Progression',
      rows: [
        { label: 'blueprints', n: blueprints.length, href: '/editor/blueprints' },
      ],
    },
    {
      label: 'Tools',
      rows: [
        { label: 'animations', n: animations.length, href: '/editor/animations' },
      ],
    },
  ];

  return (
    <div className="h-full w-full p-8">
      <div className="max-w-2xl grid grid-cols-2 sm:grid-cols-3 gap-x-10 gap-y-6">
        {groups.map((g) => (
          <div key={g.label}>
            <h2 className="text-[10px] uppercase tracking-[0.15em] text-zinc-600 mb-2">
              {g.label}
            </h2>
            <div className="space-y-1">
              {g.rows.map((r) => (
                <a
                  key={r.label}
                  href={r.href}
                  className="flex items-baseline gap-2 font-mono text-xs hover:text-zinc-100"
                >
                  <span className="text-zinc-300 tabular-nums w-8 text-right">
                    {r.n}
                  </span>
                  <span className="text-zinc-500">{r.label}</span>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
