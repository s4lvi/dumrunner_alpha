// Editor landing. The tree on the left is the canonical
// navigator — this page just shows a short hint about how to
// use it so new authors aren't dropped onto a blank canvas.

export default function EditorIndex() {
  return (
    <div className="flex items-center justify-center h-full w-full p-12 text-zinc-500">
      <div className="max-w-md text-sm space-y-3">
        <h1 className="text-lg font-bold text-zinc-300">Content editor</h1>
        <p>
          Pick an entity from the tree on the left to edit it, or
          click an area header to open its full page (with the
          area-specific sidebar + form).
        </p>
        <ul className="text-[12px] text-zinc-400 list-disc pl-5 space-y-1">
          <li>
            <span className="text-zinc-300">
              Biomes / Rooms / Enemies / Props / Blueprints / Weapons
            </span>
            {' '}— authored content stored as JSON under
            {' '}<code className="text-zinc-300">packages/shared/content/</code>.
            The sidebar groups these by layer (World / Entities /
            Items / Progression) so it stays scannable as more
            areas land.
          </li>
          <li>
            <span className="text-zinc-300">Textures</span> — image uploads
            served from <code className="text-zinc-300">/textures/&lt;cat&gt;/&lt;id&gt;</code>.
          </li>
          <li>
            <span className="text-zinc-300">Sandbox</span> — isolated arena
            for spawning enemies / regenerating floors / stamping
            rooms outside any live world.
          </li>
        </ul>
        <p className="text-[11px] text-zinc-600">
          Search the tree to filter every entity by id or label.
        </p>
      </div>
    </div>
  );
}
