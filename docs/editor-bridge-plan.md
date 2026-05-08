# Editor Bridge — current → Tier 0+1

**Status:** drafted, ready to implement.

## Goal

Bridge the existing per-entity editor pages into a unified, preview-driven authoring environment that hits Tier 0 and Tier 1 of the from-scratch editor design. Reuse what works (form vocabulary, persistence layer, room paint canvas, texture pipeline). Refactor the duplicated scaffolding. Build the missing infrastructure (sandbox server mode + embedded preview).

Defer Tier 2/3 (bulk operations, changelog, lore editor, etc.) until Tier 0+1 ship.

## What survives unchanged

- `packages/client/app/editor/_components/Form.tsx` — form vocabulary (FormSection, TextField, NumberField, EnumField, ColorField, ListField, CheckboxField, SliderField). Schema-form generator builds on top of this.
- `packages/client/app/api/editor/content/[area]/route.ts` + `packages/shared/src/content/loader.ts` — JSON-CRUD persistence layer. Schema-validated, path-traversal-safe, simple.
- `packages/client/app/api/editor/textures/route.ts` — texture upload + cache-bust pipeline.
- Room editor paint canvas + anchor placement (`packages/client/app/editor/rooms/page.tsx`). Domain-specific UI that recently iterated; preserve.
- `IdPicker` cross-reference dropdown pattern (in biome editor). Generalize when extracting the shell.
- `deriveEntrySides` save-time auto-derivation. Pattern reusable for similar future computed fields.

## Refactor in place (no behavior change)

- **Extract `EntityEditorShell<T>`** — every per-entity page (`biomes`, `enemies`, `decorators`, `rooms`) re-implements the same scaffold: load list, click to select, snapshot to draft, save, delete, error display, saving spinner. ~120 LOC × 4 files of duplication. Lift into one component that accepts:
  - `area: 'biomes' | 'enemies' | 'props' | 'rooms'`
  - `schema: ZodSchema<T>`
  - `makeBlank: (id) => T`
  - `listLabel(entity): string`
  - `listSummary?(entity): string`
  - `renderForm(draft, setDraft, error): ReactNode`
  - `renderPreview?(draft): ReactNode`
  
  Each existing page collapses to ~30-50 LOC supplying schema-specific bits. Net delete: ~400 LOC.

- **Rename `decorators` → `props`.** Schema is `PropDef`, registry is `PROPS`, API area is `props`. Editor route name `decorators` is the only oddly-named element. Rename `/editor/decorators/page.tsx` → `/editor/props/page.tsx`. Update editor nav link. Keep a redirect for any cached deep-links.

- **Promote area enum to one source.** Currently `Area` type is duplicated in `editorContentClient.ts`, the API route, and `loader.ts`. Make one canonical `EDITOR_AREAS` const in shared content code; all consumers import.

- **Snapshot conflict guard.** `saveEntity` overwrites without checking file mtime. Add a `If-Match` header carrying the file's mtime when saving; API returns 409 on stale write; editor surfaces "this entity changed since you opened it; reload?" prompt.

## What to scrap

- **Multi-route navigation pattern.** The four `/editor/<area>` pages remain as direct-link entry points but cease to be the primary navigation. Replace with a unified `/editor` shell with a left-side tree.
- **Five `useState` re-fetches per page.** Each editor maintains its own `entries`, `selectedId`, `draft`, `error`, `saving` state. With shell extraction, these become one shared container per area, optionally cached via React Query / SWR.
- **The stub `IsoPreview` in biomes editor.** It fakes a mini-iso scene with hardcoded entities. Replaced by the real sandbox preview once that lands.

## What to build new

### Phase A (foundations + cleanup) — ~1 week

- `EntityEditorShell<T>` extraction + apply to all 4 entity types
- Rename `decorators` → `props`
- Single `EDITOR_AREAS` source-of-truth
- Snapshot conflict guard

### Phase B (sandbox server mode) — ~1 week

The gating dependency for every preview-driven feature. New scene kind: `sandbox:<authorId>`. Isolated, single-client. New WS messages:

```ts
type SandboxMessage =
  | { type: 'sandbox_spawn_enemy'; kind: string; x: number; y: number }
  | { type: 'sandbox_clear' }
  | { type: 'sandbox_stamp_room'; templateId: string; biome: string }
  | { type: 'sandbox_regen_floor'; biome: string; cycle: number; floorIndex: number; seed: number }
  | { type: 'sandbox_set_loadout'; loadout: 'creative' | 'pistol' | 'unarmed' };
```

Server side: new scene type that runs the same tick loop (combat, AI, hazards) but with no production coupling. New `/api/editor/sandbox/url` endpoint mints a sandbox WS URL bound to the current editor user. Authorization via the same join token mechanism as live game.

Client side: new `useSandboxConnection` hook that opens a sandbox WS, exposes a typed command interface, and produces the same `SceneState` stream the live game consumes.

### Phase C (embedded preview component) — ~3 days

`<SandboxPreview mode="iso" | "fps" />` — embeds the existing iso/FPS renderer with a sandbox WS underneath. Exposes a `useSandboxHandle()` that lets the parent issue spawn / regen / stamp commands.

Preview wrappers per domain:
- `<EnemyPreview enemy={draft}>` — spawns the edited enemy at a fixed point in a small test arena. Buttons: "spawn target dummy," "test fight" (pointer-lock + creative loadout), "reset."
- `<BiomePreview biome={draft}>` — sliders for seed/cycle/floor, regenerates, renders. Side panel lists rooms + anchors. "Walk this floor" toggles FPS pointer-lock.
- `<RoomPreview room={draft} biome="frozen">` — stamps the template into a regenerated floor of the chosen biome. FPS-walkable.

### Phase D (unified browser) — ~4 days

`/editor` becomes a tree-driven shell. Tree nodes computed from content lists. Search bar filters across all leaves. Click a leaf → opens in main pane (re-uses `EntityEditorShell` from Phase A).

Old per-entity routes redirect into the new shell (e.g., `/editor/biomes/frozen` → `/editor#biome:frozen`).

### Phase E (cross-reference + asset health) — ~5 days

- `/api/editor/refs` — full reference graph: `{ entity_id: { references: [...], referenced_by: [...] } }`. Computed at request time (or cached with file-mtime invalidation).
- Live validation on form fields: id-references show a dropdown of valid options; broken refs highlighted red.
- Right-click any entity in the tree → "find references to."
- Asset health page: lists every required asset slot (per-biome wall textures, per-enemy sprite, etc.) and shows ✓/✗ for what's uploaded.

### Phase F (Tier 1 polish) — ~3 days

- Diff view per entity (saved JSON vs current draft)
- "Find broken references" dashboard (cross-ref + asset health combined)

## Critical path

```
Phase A ─┬─→ Phase D
         │
Phase B ─┴─→ Phase C ─→ (preview features in each existing editor page)
```

A and B are independent and can run parallel. C depends on B (the preview component needs sandbox). D depends on A (the unified browser uses the extracted shell). E and F build on top.

If only one thing ships: **Phase B (sandbox)** is the highest-leverage piece because every preview-driven feature in Tier 1 routes through it. Without it, no real preview, no test fight, no procgen visualization.

If only the safest cleanup ships: **Phase A** removes ~400 LOC of duplication and unblocks Phase D's unified browser without introducing new failure modes.

## Implementation order (recommended)

1. **Phase A first** — pure refactor, finishable in one session, doesn't introduce new failure modes. Sets up the surface for everything else.
2. **Phase B in parallel** with A or directly after — sandbox server mode + WS plumbing.
3. **Phase C** — embedded preview component + per-domain wrappers.
4. **Phase D** — unified browser.
5. **Phase E + F** — validation + polish.

Total: ~4 weeks engineering for Tier 0+1, with content authoring on the existing forms continuing uninterrupted throughout.

## Risks and gotchas

- **Sandbox server tick coupling.** The server's tick loop assumes real connections in real worlds. Sandbox needs an isolated scene that runs the same code paths without polluting production state. Means a separate scene id namespace, an editor-player synthetic identity, and spawn-on-demand outside the normal procgen flow. Plan ~1 week and don't underestimate.
- **Hot-reload semantics.** Editing an enemy's HP while one is alive in a player's scene — what happens? Apply only to new spawns (safe but disorienting), apply live (clean but breaks player expectations), apply on next regen (boring but predictable). Each entity type needs a decision.
- **Procgen preview determinism.** Editor calls a server endpoint that runs `generateFloorLayout`. Both the editor preview and live game must produce identical output for identical seeds. Currently `procgen.ts` uses Node-only `Buffer.from(...)` for the tile-grid base64 encode; if a worker context has a different polyfill, output diverges silently. Audit before relying on the preview.
- **Schema-driven forms cap out.** Discriminated unions (e.g., `MovementSpec` is `chase | kite | stationary`) need conditional form rendering. Auto-form generator handles 80% of cases; the other 20% need hand-written form components. Plan for that.
- **Tree browser performance.** A unified browser listing 200+ entities with thumbnails, references, completeness indicators gets slow naively. Needs virtualized lists, lazy thumbnail loading, server-side filtering.
