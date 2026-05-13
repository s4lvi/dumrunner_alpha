# Blueprint Editor — Implementation Plan

Status: in progress (drafted 2026-05-10)

This is PR 1 of the broader Items + Blueprint editor work outlined
in the recent design discussion. PR 1 ships the **blueprint editor
only** because it's the smallest scope, ports the smallest table
(30 entries), and unblocks designer iteration on costs / prereqs /
DAG without forcing the larger weapon-stats migration. The items
editor (PR 2) follows once this pattern is proven.

## Goal

A `/editor/blueprints` route that lets a designer:

- See every blueprint in the catalog in a sortable list.
- Edit `displayName`, `description`, `cost`, `tier`, `hidden`,
  `recipeId`, `prerequisites`.
- Visualize the resulting DAG (the same pannable view the player
  sees, fed with the draft catalog so unsaved edits show up).
- Save changes back to JSON files committed to the repo.
- See cycle errors, broken recipe references, and missing
  prerequisites surface as inline validation.

The runtime continues to enforce prerequisites / costs exactly as
today — only the **source of truth** for the catalog moves from
TypeScript to JSON.

## Architecture

Mirrors the existing E3.0 content pipeline (biomes / enemies /
props):

```
packages/shared/src/content/types.ts        # add BlueprintDefSchema
packages/shared/src/content/loader.ts       # add load/save/loadOne/'blueprints' area
packages/shared/content/blueprints/<id>.json  # 30 files (one per blueprint)
packages/shared/src/crafting.ts             # BLUEPRINT_CATALOG → mutable + setter
packages/server/src/blueprints.ts           # initBlueprints() at boot, getBlueprintsForWire()
packages/server/src/world.ts                # call initBlueprints, ship in welcome
packages/shared/src/protocol.ts             # add blueprints[] to welcome wire shape
packages/client/app/play/[id]/Game.tsx      # on welcome, setBlueprintCatalog(msg.blueprints)
packages/client/app/api/editor/content/[area]/route.ts  # wire 'blueprints' through
packages/client/app/editor/blueprints/page.tsx          # the editor itself
packages/client/app/editor/page.tsx                     # add nav tile
```

The runtime registry pattern matches biomes (`BIOMES` populated by
`setBiomePalettes`, both via server boot init and via the welcome
message). Existing consumers (`world.ts`, `Game.tsx`) keep
importing `BLUEPRINT_CATALOG`; by the time they read it, the
setter has been called.

## Data shape

`BlueprintDef` in shared/content matches `BlueprintCatalogEntry`
1:1 — same fields, Zod-validated:

```ts
{
  id: idSchema,                             // lowercase slug
  recipeId: z.string().min(1),              // recipe id this unlocks
  displayName: z.string().min(1),
  description: z.string(),
  cost: z.number().int().nonnegative(),     // artifacts
  tier: z.enum(['common','uncommon','rare','legendary']),
  hidden: z.boolean().optional(),
  prerequisites: z.array(idSchema).optional(),
}
```

Cross-reference validation happens at two layers:

- **Per-file Zod parse** — shape only. Fast.
- **Cross-area validation at the editor boundary** — runs after
  the per-file parse on save. Checks that every referenced
  `recipeId` exists in `RECIPES`, every `prerequisites` id exists
  in the loaded blueprint set, and the resulting DAG is acyclic.
  Returns a 422 on failure with a usable error string. Belongs in
  the API route POST handler.

Cycle detection: simple DFS with a recursion-stack set. Any back
edge → 422.

## UI shape

Three-pane editor following the biome / enemy pattern:

- **Left sidebar.** List of blueprints sorted by tier (legendary
  first, then rare, uncommon, common), then by cost desc, then by
  displayName. Each row shows: tier-coloured dot, displayName,
  cost in artifacts, dim "hidden" badge if applicable. Search box
  filters by id / displayName. "+ New" button at top.
- **Centre form.** Sections:
  - **Identity:** id (read-only after create), displayName,
    description (textarea).
  - **Economy:** cost (number), tier (enum dropdown), hidden
    (checkbox).
  - **Unlocks:** recipeId — dropdown of every recipe id, with
    output kind/name shown ("weapon: Sniper Rifle", "attachment:
    Foregrip", "placeable: Rifle Turret"). Disabled options for
    recipes already targeted by another blueprint (one-to-one is
    the convention; surface as warning, not block).
  - **Prerequisites:** chip-input multi-select of other
    blueprint ids. Adding one that creates a cycle shows inline
    error and disables Save. Each chip shows the prereq's
    displayName + tier dot.
- **Right pane (preview).** Tabs:
  - **DAG.** The same `TradeBlueprintsList` SVG component the
    runtime uses, fed with the **draft** catalog so unsaved
    edits render. Currently-selected node highlighted. Edges
    being added preview as dashed orange.
  - **References.** "Blueprints that depend on this one" — flat
    list of dependents so a designer can see the impact before
    deleting.

Save fires `POST /api/editor/content/blueprints`. On 422, error
toast shows the validation message. On success, the entry is
re-fetched and the sidebar refreshes.

## Migration / port

One-time script `packages/shared/scripts/port-blueprints.ts`
that reads the existing `BLUEPRINT_CATALOG` from `crafting.ts` and
emits 30 JSON files under `packages/shared/content/blueprints/`.

After the port:

- `BLUEPRINT_CATALOG` becomes `let BLUEPRINT_CATALOG: Record<...> = {}`
  (mutable, initially empty).
- New `setBlueprintCatalog(entries)` exported from
  `shared/crafting.ts` populates the record. Mirrors
  `setBiomePalettes` / `setEnemyVisuals`.
- New `packages/server/src/blueprints.ts` calls `loadBlueprints()`
  + `setBlueprintCatalog()` at boot, and exports
  `getBlueprintsForWire()` (just `Object.values(BLUEPRINT_CATALOG)`
  — no transform needed because the wire and registry shapes are
  identical).
- `world.ts` calls `initBlueprints()` in its boot path and adds
  `blueprints: getBlueprintsForWire()` to the `welcome` message.
- `protocol.ts` `welcome` schema gains a `blueprints` field.
- `Game.tsx` welcome handler calls `setBlueprintCatalog(msg.blueprints)`
  before any UI runs.
- The TS catalog data lives on disk only — no static fallback. If
  the JSON files are missing on a fresh checkout, server boot
  fails loud (the loader's existing pattern: throw on bad JSON,
  return empty array on missing dir; we'll log a warning if the
  set is empty).

## Hot-reload (in this PR)

Minimum: server reads JSON only at boot. To pick up edits the
designer must restart the dev server. Acceptable for PR 1 because
the iteration loop is "edit → save → restart" which is ~3
seconds.

Out of scope for PR 1: a `/dev/reload-blueprints` WS message that
re-reads JSON and broadcasts a new `blueprints_changed` to every
connected client without a restart. Tracked as a follow-up; nice
to have, not blocking.

## Out of scope (PR 2 and beyond)

- Items editor (weapon stats, ammo, attachments, etc.).
- Recipe editor — the blueprint editor's `recipeId` picker reads
  the existing `RECIPES` table; recipes themselves stay TS for
  now.
- Live hot-reload via dev WS.
- Persistent (legendary) blueprint write path — the
  dead-`persistentBlueprints` bug found in the prior review is a
  separate fix and doesn't belong in this PR.
- DAG canvas-edit (drag-to-add-edges). Form-only with multi-select
  is enough for now.

## Validation summary

| Layer | Rule | Failure mode |
|---|---|---|
| Per-file Zod | shape, types, id slug | server boot throws / API 422 |
| Cross-area save | recipeId ∈ RECIPES | API 422 |
| Cross-area save | every prereq ∈ blueprints | API 422 |
| Cross-area save | DAG acyclic | API 422 |
| ID uniqueness | filename = id field | loader's existing slug check |
| Editor UX | unsaved-cycle warning | inline form error, save disabled |

## Risk surface

- **Welcome message size.** 30 entries × ~200 bytes each = ~6KB.
  Already inside the existing welcome envelope; not a problem at
  this scale.
- **`BLUEPRINT_CATALOG` is `{}` until init.** Any module that
  reads at import time (rather than at function-call time) will
  see empty. Audit before merge: only `world.ts` and `Game.tsx`
  reference it, and both read on use, not on import.
- **`docs/blueprint-editor-plan.md` ↔ reality drift.** This doc
  describes a snapshot. Once PR 1 ships, mark sections shipped or
  delete them; don't let it fossilize.

## Sequencing

1. Plan doc (this file). ✅
2. `BlueprintDefSchema` + loader entries.
3. Port script + 30 JSON files.
4. `BLUEPRINT_CATALOG` → mutable, add setter.
5. `server/src/blueprints.ts` + boot wiring + welcome.
6. Client welcome handler.
7. Generic API route — wire `'blueprints'` through.
8. `/editor/blueprints/page.tsx`.
9. Smoke test: load editor, edit a blueprint, restart, see change in-game.
