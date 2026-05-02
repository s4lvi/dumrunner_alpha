# DUM RUNNER Asset Generation Service Design

## Purpose

`packages/asset_gen` is a separate backend service for generating, cleaning,
validating, and storing game-ready bitmap assets.

The game asks for assets in domain terms:

- enemy sprite: "rat-like", Catacombs faction, purple/green palette, 64 px
- weapon sprite: rusty SMG magazine, Mk2, side-view, 64 px
- armor sprite: cyberpunk heavy plating, Alien tier, UI icon, 256 px

The service turns that request into a generated image, removes background,
normalizes size and framing, verifies usability with a vision-language model,
stores the approved output, and returns stable asset metadata.

This service must not sit in the realtime simulation path. The game server can
request missing assets, but normal gameplay should render cached assets or
fallback placeholders while generation jobs run asynchronously.

## Current Implementation Slice

The first implementation pass now exists under `packages/asset_gen/src`:

- `server.ts` exposes the HTTP API with Node's built-in server.
- `schemas.ts` owns the Zod request/response domain.
- `service.ts` owns cache lookup, job creation, and async queue processing.
- `prompt.ts` compiles game-domain requests into image prompts.
- `providers/openaiImage.ts` calls OpenAI's image generation endpoint with
  `gpt-image-1.5` by default.
- `cleanup.ts` and `verifier.ts` are explicit boundaries for the heavier
  production work: background removal, alpha validation, crop/framing, and
  VLM grading.
- `gameRequests.ts` provides request builders for enemies, parts, materials,
  and buildings using the existing shared game schemas.

This version is intentionally an API/queue skeleton. It can call the image API,
but approved production output still depends on replacing the placeholder
cleanup and heuristic verifier with real image-processing and VLM stages.

## Package Boundary

This package should own:

- HTTP API for asset generation jobs.
- Request schema and validation.
- Prompt construction from game object metadata.
- Image-generator API integration.
- Image cleanup pipeline.
- Vision-language verification.
- Asset storage and cache lookup.
- Job records and audit metadata.

This package should not own:

- Live game simulation.
- Inventory, combat, or enemy AI rules.
- Client rendering code.
- Supabase Auth user/session flows, except service-to-service auth.

## Inputs From Existing Game Schemas

Current gameplay schemas imply these asset inputs:

- `EnemyTemplate.id` maps to `EnemyState.kind`.
- `EnemyTemplate.faction` maps to biome/faction styling.
- `EnemyTemplate.visual` currently contains fallback shape/color/size.
- `CarriedPart.slot` describes weapon/suit part category.
- `CarriedPart.tier` describes material/rarity.
- `CarriedPart.weaponClass` describes class-locked weapon visuals.

Asset generation should accept these concepts directly rather than inventing
parallel names.

## API Shape

### `POST /v1/assets/generate`

Creates or retrieves an asset generation job.

If an identical normalized request already has an approved asset, return it
immediately. Otherwise create a job and return `202 Accepted`.

```jsonc
{
  "requestId": "uuid-or-client-idempotency-key",
  "assetKind": "enemy" | "weapon_part" | "suit_part" | "projectile" | "ui_icon",
  "renderTarget": "world_sprite" | "inventory_icon" | "ui_detail",
  "size": 32 | 64 | 256,
  "style": {
    "camera": "top_down" | "side_view" | "three_quarter",
    "renderStyle": "pixel_art" | "painted_sprite" | "clean_icon",
    "outline": true,
    "transparentBackground": true
  },
  "gameObject": {
    "id": "chaser_melee_rat_catacombs",
    "label": "rat-like tunnel scavenger",
    "faction": "catacombs",
    "biome": "Irradiated Catacombs",
    "tier": "Mk2",
    "slot": null,
    "weaponClass": null
  },
  "visualBrief": {
    "subject": "rat-like mutant scavenger",
    "materials": ["matted fur", "scrap cybernetics", "glowing radiation sores"],
    "colors": ["#7c3aed", "#22c55e", "#1f2937"],
    "mustInclude": ["readable silhouette", "small cybernetic spine"],
    "mustAvoid": ["text", "logo", "photoreal background", "extra creatures"]
  },
  "constraints": {
    "safeMarginPx": 4,
    "anchor": "center_bottom",
    "maxOpaqueBoundsRatio": 0.86,
    "minReadableAtPx": 32
  }
}
```

### Response: cached or completed

```jsonc
{
  "status": "approved",
  "assetId": "asset_01h...",
  "cacheKey": "sha256...",
  "urls": {
    "png": "https://assets.example/dumrunner/asset_01h.png",
    "webp": "https://assets.example/dumrunner/asset_01h.webp"
  },
  "metadata": {
    "width": 64,
    "height": 64,
    "transparent": true,
    "anchor": { "x": 0.5, "y": 0.82 },
    "opaqueBounds": { "x": 9, "y": 5, "w": 47, "h": 55 },
    "averageColors": ["#6d28d9", "#22c55e", "#111827"]
  },
  "verification": {
    "score": 0.91,
    "verdict": "pass",
    "summary": "Readable rat-like mutant enemy sprite with transparent background."
  }
}
```

### Response: async job

```jsonc
{
  "status": "queued",
  "jobId": "job_01h...",
  "assetId": null,
  "pollUrl": "/v1/assets/jobs/job_01h..."
}
```

### `GET /v1/assets/jobs/:jobId`

Returns job state:

- `queued`
- `generating`
- `cleaning`
- `verifying`
- `approved`
- `rejected`
- `failed`

### `GET /v1/assets/:assetId`

Returns approved asset metadata and URLs. Raw generated attempts should not be
served to the game by default.

### `POST /v1/assets/prewarm`

Queues a batch of deterministic future asset requests. This is the preferred
game integration path: when the server boots a world, rolls a new cycle, or a
player approaches/discovers a deeper floor, it can ask for all likely enemy,
material, part, and building assets in the background.

```jsonc
{
  "requestId": "world-prewarm-01",
  "reason": "world_boot",
  "worldSeed": 12345,
  "cycle": 3,
  "floorIndices": [1, 2, 3],
  "requests": [
    {
      "assetKind": "enemy",
      "renderTarget": "world_sprite",
      "size": 64,
      "style": {
        "camera": "top_down",
        "renderStyle": "painted_sprite",
        "outline": true,
        "transparentBackground": true
      },
      "gameObject": {
        "id": "chaser_melee",
        "label": "rat-like tunnel scavenger",
        "faction": "catacombs",
        "biome": "Irradiated Catacombs"
      },
      "visualBrief": {
        "subject": "rat-like mutant scavenger",
        "materials": ["patchy fur", "rusted implants"],
        "colors": ["#7c3aed", "#22c55e", "#111827"],
        "mustInclude": ["readable top-down silhouette"],
        "mustAvoid": ["text", "background scene"]
      }
    }
  ]
}
```

## Domain-Specific Request Types

The public API can use one generic request body, but internal TypeScript should
model stricter variants.

```ts
type AssetKind =
  | 'enemy'
  | 'weapon_part'
  | 'suit_part'
  | 'projectile'
  | 'ui_icon';

type RenderTarget = 'world_sprite' | 'inventory_icon' | 'ui_detail';
type AssetSize = 32 | 64 | 256;

type EnemyAssetContext = {
  kind: 'enemy';
  templateId: string;
  faction: 'neutral' | 'sun_bleached' | 'catacombs' | 'frozen' | 'alien_core';
  movementKind?: 'stationary' | 'chase' | 'kite';
  attackKinds?: ('melee' | 'projectile')[];
  radius?: number;
};

type PartAssetContext = {
  kind: 'weapon_part' | 'suit_part';
  slot:
    | 'barrel'
    | 'frame'
    | 'grip'
    | 'magazine'
    | 'weapon_mod'
    | 'chassis'
    | 'plating'
    | 'life_support'
    | 'utility_mod'
    | 'cargo_grid';
  tier: 'Mk1' | 'Mk2' | 'Mk3' | 'Mk4' | 'Alien';
  weaponClass?: 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'heavy' | 'energy';
};
```

## Example Requests

### Rat-Like Enemy

```jsonc
{
  "assetKind": "enemy",
  "renderTarget": "world_sprite",
  "size": 64,
  "style": {
    "camera": "top_down",
    "renderStyle": "painted_sprite",
    "outline": true,
    "transparentBackground": true
  },
  "gameObject": {
    "id": "catacombs_rat_chaser",
    "label": "rat-like mutant scavenger",
    "faction": "catacombs",
    "biome": "Irradiated Catacombs"
  },
  "visualBrief": {
    "subject": "rat-like mutant scavenger enemy",
    "materials": ["patchy fur", "rusted implants"],
    "colors": ["#7c3aed", "#22c55e", "#111827"],
    "mustInclude": ["readable top-down silhouette"],
    "mustAvoid": ["realistic gore", "text", "background scene"]
  }
}
```

### Rusty SMG Part

```jsonc
{
  "assetKind": "weapon_part",
  "renderTarget": "inventory_icon",
  "size": 64,
  "style": {
    "camera": "side_view",
    "renderStyle": "clean_icon",
    "outline": true,
    "transparentBackground": true
  },
  "gameObject": {
    "id": "smg_magazine_rusty_mk2",
    "label": "rusty SMG magazine",
    "slot": "magazine",
    "weaponClass": "smg",
    "tier": "Mk2"
  },
  "visualBrief": {
    "subject": "compact rusty SMG magazine",
    "materials": ["scratched steel", "orange rust", "black polymer"],
    "colors": ["#9a3412", "#3f3f46", "#d6d3d1"],
    "mustInclude": ["clearly a detachable magazine"],
    "mustAvoid": ["full weapon", "hands", "text"]
  }
}
```

### Cyberpunk Armor

```jsonc
{
  "assetKind": "suit_part",
  "renderTarget": "ui_detail",
  "size": 256,
  "style": {
    "camera": "three_quarter",
    "renderStyle": "painted_sprite",
    "outline": false,
    "transparentBackground": true
  },
  "gameObject": {
    "id": "heavy_plating_alien_cyberpunk",
    "label": "Alien heavy armor plating",
    "slot": "plating",
    "tier": "Alien"
  },
  "visualBrief": {
    "subject": "cyberpunk heavy armor chest plating",
    "materials": ["black ceramic armor", "alien green light channels", "brushed titanium"],
    "colors": ["#0f172a", "#22c55e", "#94a3b8"],
    "mustInclude": ["single equipment piece", "hard surface armor"],
    "mustAvoid": ["full character", "helmet", "text"]
  }
}
```

## Pipeline

1. **Authenticate**
   - Only trusted game/lobby/backend callers may create jobs.
   - Use service-to-service bearer token or signed HMAC request.
   - Do not expose generation directly to public browser clients.

2. **Normalize Request**
   - Validate enum fields and allowed sizes.
   - Normalize colors to hex.
   - Strip unsupported prompt text.
   - Generate a stable `cacheKey` from normalized request fields.

3. **Cache Lookup**
   - If an approved asset exists for `cacheKey`, return it.
   - If a job is already running for `cacheKey`, return the existing job.

4. **Prompt Compile**
   - Convert structured fields into a constrained prompt.
   - Include camera angle, scale, silhouette, transparency, and exclusions.
   - Avoid style references to living artists or copyrighted franchises.
   - For OpenAI, use `gpt-image-1.5` by default because isolated sprites need
     native transparent-background support more than Image 2's broader size
     flexibility.
   - Set `ASSET_GEN_IMAGE_MODEL=gpt-image-1.5-2025-12-16` when we want
     version-locked production behavior.

5. **Image Generation**
   - Current OpenAI docs list `gpt-image-1.5` and `gpt-image-2` for
     `v1/images/generations` and `v1/images/edits`.
   - `gpt-image-1.5` is the default for alpha sprites. The provider requests
     `background: "transparent"` for models that support it.
   - `gpt-image-2` does not currently support `background: "transparent"`.
     If configured, the service falls back to `background: "auto"` and cleanup
     must produce alpha.
   - Source images should still be generated larger than the final sprite,
     usually 1024 px square.
   - Generate multiple candidates per job, usually 2-4.
   - Store raw attempts privately for debugging, not for game use.

6. **Cleanup**
   - Decode image.
   - Remove background if alpha is missing or poor.
   - Trim to opaque bounds.
   - Re-center and scale to target safe margin.
   - Pad to square canvas.
   - Resize to exact target size.
   - Quantize or sharpen if `renderStyle` is `pixel_art`.
   - Export PNG with alpha. Optionally export WebP for web delivery.
   - Production implementation should use `sharp` for resizing/metadata and a
     dedicated matting/removal step for alpha. The current code only records
     dimensions and makes this boundary explicit.

7. **Mechanical Validation**
   - Exact dimensions match requested size.
   - Alpha channel exists.
   - Opaque bounds are inside safe margins.
   - Image is not empty.
   - Opaque pixel ratio is within configured bounds.
   - No obvious text blocks if OCR is available.

8. **Vision-Language Verification**
   - Send cleaned candidate plus original structured request to a VLM.
   - Ask for strict JSON verdict:
     - subject match
     - transparent background
     - readable at target size
     - no forbidden elements
     - game usability score
   - Accept only candidates above threshold.

9. **Retry / Reject**
   - If all candidates fail, retry with corrected prompt up to `maxAttempts`.
   - If still failing, mark job rejected and return reasons.
   - Caller can fall back to procedural/vector placeholder.

10. **Store Approved Asset**
    - Write approved image to object storage.
    - Store metadata, verification result, source request, and cache key.
    - Return stable asset URL and metadata.

## Cleanup Rules

For `world_sprite`:

- Use 32 or 64 px.
- Transparent background required.
- Maintain readable silhouette.
- Anchor defaults to center-bottom for characters/enemies.
- Keep 2-4 px safe margin at 32/64 px.
- Prefer strong outline if sprite overlaps dark dungeon tiles.

For `inventory_icon`:

- Use 64 px by default.
- Side-view or three-quarter view allowed.
- Center object in frame.
- No environmental shadows unless alpha-safe and subtle.

For `ui_detail`:

- Use 256 px by default.
- Higher detail allowed.
- Must still have transparent background.
- Can be downsampled to generate inventory variants.

## Verification Contract

The VLM prompt should require machine-readable output:

```jsonc
{
  "subjectMatch": 0.0,
  "styleMatch": 0.0,
  "backgroundTransparent": true,
  "readableAtTargetSize": true,
  "forbiddenElements": [],
  "usabilityScore": 0.0,
  "verdict": "pass" | "retry" | "reject",
  "notes": "short reason"
}
```

Minimum initial pass threshold:

- `subjectMatch >= 0.75`
- `styleMatch >= 0.70`
- `backgroundTransparent == true`
- `readableAtTargetSize == true`
- `forbiddenElements.length == 0`
- `usabilityScore >= 0.80`

## Storage Model

Recommended tables or equivalent durable records:

```sql
asset_requests (
  id uuid primary key,
  cache_key text not null,
  requested_by text not null,
  normalized_request jsonb not null,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
)

asset_variants (
  id uuid primary key,
  request_id uuid not null references asset_requests(id),
  status text not null,
  size int not null,
  format text not null,
  storage_path text,
  raw_storage_path text,
  metadata jsonb not null,
  verification jsonb,
  created_at timestamptz not null
)
```

Object storage layout:

```text
assets/
  approved/
    enemy/chaser_melee_rat/64/asset_01h.png
    weapon_part/smg_magazine_rusty_mk2/64/asset_01h.png
  raw/
    job_01h/candidate_0.png
    job_01h/candidate_1.png
```

Raw assets should be private and periodically pruned. Approved assets can be
public or served through signed URLs, depending on deployment.

## Prompt Construction

Prompt builder should be template-driven. Example enemy prompt:

```text
Create a 64x64 top-down game sprite with transparent background.
Subject: rat-like mutant scavenger enemy.
Faction/biome: Irradiated Catacombs.
Materials: patchy fur, rusted implants.
Palette: #7c3aed, #22c55e, #111827.
Composition: single centered object, readable silhouette, no scene background.
Restrictions: no text, no logo, no extra creatures, no photoreal background.
Output: isolated sprite, alpha transparent background.
```

The prompt compiler should append service-level restrictions that callers cannot
override:

- single asset only
- no text or watermark
- transparent background
- no UI frame unless requested
- no copyrighted character/franchise names
- no living artist style references

## Runtime Integration

Initial integration should be lazy but non-blocking:

1. Game server or build tooling requests asset for a template/part.
2. Asset service returns cached approved asset or queued job.
3. Game uses current procedural/vector placeholder until asset is approved.
4. Once approved, template or item metadata stores `assetId`/URL.
5. Client renders sprite from stable URL.

Do not make enemy spawn, loot generation, or combat wait on image generation.

## Failure Modes

- **Generator timeout:** mark attempt failed, retry if attempts remain.
- **Bad alpha:** run background remover, then mechanical validation.
- **Wrong subject:** VLM returns retry with notes; prompt compiler adds corrective phrase.
- **Unreadable at 32 px:** retry with simpler silhouette / stronger outline.
- **Unsafe or policy-blocked prompt:** reject request before generation.
- **Storage write failed:** keep job failed and retry storage separately.

## Security

- Endpoint is backend-only.
- Require service auth and rate limiting.
- Keep provider API keys server-side only.
- Store original prompts and provider metadata for audit.
- Sanitize free-text fields before prompt compilation.
- Do not allow arbitrary style/person/franchise references through.
- Never trust VLM verification alone for mechanical requirements; validate pixels.

## Implementation Plan

1. Scaffold `@dumrunner/asset_gen` package with TypeScript, HTTP server, and env loader.
2. Add request/response types and JSON validation.
3. Add deterministic cache key generation.
4. Add stub generator provider that returns fixture images.
5. Implement cleanup pipeline against fixture images.
6. Add VLM verifier interface with a stub verifier.
7. Add storage adapter interface.
8. Add real image generator provider.
9. Add real VLM verifier.
10. Add game-server integration using cached assets only.

## Open Questions

- Which image generator provider should be first?
- Which VLM provider should verify outputs?
- Should approved assets live in Supabase Storage, R2, or the game host?
- Should `assetId` be stored on enemy templates, item templates, or separate lookup tables?
- Should 32 px sprites be generated directly, or downsampled from 256 px masters?
- Do world sprites need directional frames later, or only single top-down icons for alpha?

## Game-Side Integration Plan

This section describes how the game packages (`client`, `server`, `shared`)
consume the output of this service. It is the contract the game promises:
the asset service runs at its own pace, the game runs at full speed
regardless, and approved assets supersede procedural placeholders without
gameplay disruption.

### Three rendering tiers, in order of fallback

The client tries each tier in order; whichever resolves first wins.

1. **Approved sprite asset** from this service.
2. **Bundled placeholder PNG** shipped with the client (a tiny set of static
   images for the most common kinds; intentionally shipped to avoid a blank
   render if the asset service is unreachable).
3. **Procedural shape** drawn with PixiJS Graphics — what the alpha currently
   uses (`ENEMY_VISUALS` map for enemies, tier-coloured diamonds for loot,
   etc.). Always available, requires no network.

For the alpha, tier 3 is the production renderer. As the asset service comes
online, tier 1 takes over kind-by-kind.

### Schema additions

Two thin additions to existing types let assets flow without protocol churn.

```ts
// shared/protocol.ts — new optional fields
type EnemyState = {
  // …existing
  assetId?: string;     // when set, client fetches from asset registry
};

type CarriedPart = {
  // …existing
  assetId?: string;     // ditto for inventory icons
};
```

The server populates these from a `template_id → assetId` lookup it loads at
boot. Templates without an approved asset omit the field; client falls back.

### Client asset registry

A small singleton on the client owns the lookup:

```ts
// packages/client/lib/assets/registry.ts (sketch)
type AssetEntry = { url: string; size: number; anchor: { x: number; y: number } };

const registry = new Map<string, AssetEntry>();

// Populated at app boot from a single GET to /v1/assets/index — a flat
// listing of all currently-approved assets keyed by assetId.
async function loadIndex(): Promise<void> { … }

export function resolveAsset(assetId: string | undefined): AssetEntry | null {
  if (!assetId) return null;
  return registry.get(assetId) ?? null;
}
```

The PixiJS render layer for an entity becomes:

```ts
const entry = resolveAsset(enemy.assetId);
if (entry) {
  // Texture from URL → Sprite, anchored as specified
} else {
  // existing drawEnemyShape() procedural path
}
```

Sprites are loaded on demand via Pixi's `Assets.load(url)` and cached. A
sprite cache eviction policy keeps memory bounded (e.g. LRU, max 200
textures) — irrelevant in the alpha but worth noting for design.

### Server-side pairing

The server keeps a **template → assetId** map separate from gameplay state.
Loaded on boot from a `template_assets` lookup table (or simply a JSON file
checked into the repo while the asset service is in early days).

```sql
-- Possible table; defer to a JSON file in alpha.
template_assets (
  template_kind text not null,           -- 'enemy' | 'weapon_part' | 'suit_part'
  template_id text not null,             -- e.g. 'chaser_melee'
  size int not null,                     -- 32 / 64 / 256
  asset_id text not null,                -- the approved asset_id from the service
  primary key (template_kind, template_id, size)
);
```

When the server emits `EnemyState` / `CarriedPart` on the wire, it stamps the
`assetId` field if a row exists. Otherwise the field is absent — client
falls through to procedural.

### Build-time pre-warming

A separate node script (`packages/asset_gen/scripts/prewarm.ts`) walks every
known template and POSTs to `/v1/assets/generate` with idempotency keys.
On first run, the asset service queues jobs; subsequent runs return cached
approved assets. The script writes the resulting `assetId`s into the
template-assets lookup (CSV → SQL migration, or directly to the table).

This means most pre-existing kinds have approved assets by deployment time,
and gameplay never blocks on generation.

### Runtime asset requests

Outside of pre-warming, the game NEVER calls the asset service directly
during play. New procedural enemies (when procedural enemy generation
lands) submit jobs via the server's lobby/admin path, queued for later
pre-warming.

Three reasons:

- Generation latency is unpredictable (seconds to minutes).
- The asset service is a separate deployment with its own outage modes.
- Procedural fallback already works — there's no urgency at the tick level.

### Bundled placeholders (tier 2)

A small set of 16-32 PNGs lives in `packages/client/public/assets/placeholder/`,
keyed by kind:

```text
placeholder/
  enemy/
    chaser_melee.png
    shooter_drone.png
    brute_chaser.png
    dummy_target.png
  weapon_part/
    barrel.png   frame.png   grip.png   magazine.png   weapon_mod.png
  suit_part/
    chassis.png  plating.png life_support.png  utility_mod.png  cargo_grid.png
  projectile/
    pistol.png
```

These are produced *once*, manually if necessary, and committed. They give
the alpha a recognisable look immediately without the asset service running.
The procedural shape stays as the absolute-last-resort fallback.

### Migration order

This is the order to roll out without breaking anything:

1. Ship the `assetId` field on `EnemyState` / `CarriedPart` as optional (no
   server populates it yet).
2. Build the client registry stub (no entries; always falls through to
   procedural).
3. Stand up the asset service and pre-warm a small set of enemy + part
   sprites.
4. Deploy `template_assets` lookup with those rows.
5. Server stamps `assetId` on the wire for templates that have one.
6. Client fetches and caches sprites; renders them when present.
7. Iterate: extend pre-warming to cover the rest of the kinds.

At every step, gameplay continues with whatever tier is currently available.

### What lives where

- `packages/asset_gen` — service, pipeline, pre-warm script. Owns generation.
- `packages/shared` — `assetId` fields on wire types only. No URLs, no
  metadata. The client registry holds those.
- `packages/server` — template→assetId lookup; stamps wire messages.
- `packages/client` — asset registry, sprite loader/cache, fallback chain.

This keeps the asset service off the realtime path, keeps the wire protocol
small, and keeps the client free to choose its rendering strategy per
sprite.

## Latency, Rate Limits, and Predictive Generation

Generation is slow (seconds to minutes per asset), expensive, and rate-
limited by upstream providers. The renderer cannot block on it. The plan
therefore must answer: *given that the first runner who needs an asset
sometimes waits, how do we ensure that wait happens off the critical path?*

### Realistic time budget

Round numbers we should design against, not measure to:

- Single-asset round trip (image-gen + cleanup + VLM verify): **~10–60 s**.
- Provider rate limit (image generation): on the order of **dozens of
  generations per minute, total**, across the whole service.
- Pre-warm runs at build time can take many minutes; that's fine, no player
  is waiting.
- Runtime requests must therefore favour cache hits or accept long ETAs.

The renderer never sees these latencies because every kind of request always
has a usable fallback (procedural shape) ready to draw at frame zero.

### Determinism is the cost lever

Two facts make most caches hot most of the time:

- **Floor layouts are deterministic** in `(worldSeed, cycle, floorIndex)`.
  Two clients on the same server, same cycle, same floor see the **same**
  layout — and therefore need the **same** sprites.
- **Templates are stable across cycles.** Enemy archetypes, weapon parts,
  and suit parts identify the asset request, not floor instance state. A
  `chaser_melee` enemy needs the same sprite on every floor it appears on.

So the working set of distinct asset requests across a server's lifetime is
small — bounded roughly by `templates × tiers × biomes × renderTargets`, not
by player-hours. After the first dive on a fresh world, almost everything is
cached. After build-time pre-warming covers the common kinds, the first
dive is mostly cached too.

### Prefetch policy: stay one scene ahead

The expensive moment is when a player encounters a kind for the first time
in a fresh world. Strategy: start that work *before* the player arrives.

```text
Player on surface  →  prefetch dungeon:1 enemy templates
Player on floor N  →  prefetch dungeon:N+1 enemy templates
Player picks up loot tier T for slot S  →  prefetch slot S for adjacent tiers
```

Concretely, two prefetch hooks on the server:

1. **On scene entry.** When `World.transition()` lands a player in scene B,
   submit asset requests for the *next* predictable scene from B (the
   stairs-down target). Always fire-and-forget. If the request is already
   queued or approved, the asset service short-circuits.

2. **On loot drop.** When the server rolls a part drop, submit an asset
   request for that exact `(slot, tier, weaponClass?)`. By the time the
   player walks over to pick it up — or opens their inventory to look at
   it — the icon is usually cached.

These hooks are submitted via `POST /v1/assets/generate` with the
deterministic `cacheKey` derived from the request shape. The asset service
deduplicates concurrent requests for the same key — only one job runs even
if both hooks fire for the same template.

### Concurrency and back-pressure

The asset service maintains its own queue and respects upstream rate
limits. The game side does not retry on its own; it submits and forgets.

Game-side throttle to be polite to the service:

- **Per-server prefetch budget**: at most N concurrent in-flight requests
  per `serverId`. Stops a busy world from drowning the queue.
- **Coalescing window**: dedupe in-flight requests with the same cacheKey
  client-side too (multiple loot drops of the same slot/tier in the same
  second produce one network call).
- **Cooldown**: after a recent prefetch failure, back off submitting new
  prefetches for that scene for a minute.

The asset service's response always tells us which it is: `approved`,
`queued`, or `rejected`. The game just records the outcome and moves on.

### Client flow during the wait

The client never blocks on asset generation. The fallback chain runs every
frame:

1. **Frame 1, asset cold:** procedural shape draws. Game looks like the
   alpha does today.
2. **Frame K, asset arrives:** registry update fires; next render swaps the
   sprite in. No reload, no hitch.

For especially long waits (e.g. a brand-new alien-tier part dropped in a
world before pre-warming caught up), the procedural shape continues to
render indefinitely. The game is still fully playable. There is no
"loading…" UI on entities — that would create artificial blocking pressure
on the asset service.

### Build-time pre-warming as the foundation

The runtime prefetch is a safety net. The base load is carried by
build-time pre-warming, which produces approved assets for every known
kind before deployment.

`packages/asset_gen/scripts/prewarm.ts` walks:

- All enemy templates (`packages/server/src/ai/templates.ts`).
- All `(slot, tier, weaponClass?)` combinations.
- A standard projectile and UI-icon set.

It submits each through the public asset service API with a stable
idempotency key. The script is incremental — re-running covers only newly-
added kinds. CI runs it before deploy; cold-start asset misses approach
zero in production.

### What the server actually does at scene entry

Practical sequence when a player takes the stairs down:

```text
1. handleInteractable → World.transition(player, dungeon:N+1, spawnX, spawnY)
2. Scene N+1 created (or hydrated)
3. enqueueScenePrefetch(N+1) — fires asset requests for templates in N+1
4. enqueueScenePrefetch(N+2) — looks ahead one more floor
5. welcome / scene_changed sent to player with optional assetIds (any that
   were already approved at step 2 are stamped on the wire; the rest will
   stream in via a future "asset_ready" message — see below)
```

Step 4 is the key insight: by the time the player has fought through floor
N+1, floor N+2 already has its assets in flight. Most of the time the
player never notices.

### Optional: live asset_ready notifications

For the case where an asset becomes available *while the player is in a
scene that uses it*, two options:

1. **Polling (simple):** client periodically polls `/v1/assets/index` for
   any new entries since last fetch. Cheap, predictable.
2. **Push (later):** asset service emits `asset_ready { assetId }` over a
   secondary websocket the client subscribes to. Less round trip, more
   moving parts.

For the alpha: polling every ~10 s is plenty. The asset_ready push is a
post-alpha optimisation.

### Cost model in plain English

- **First runner on a fresh world:** sees procedural shapes for ~30 s while
  the asset service catches up; then sprites swap in.
- **Every runner after that:** sees sprites immediately for any kind that
  was generated by an earlier session.
- **After pre-warming runs:** even the first runner sees sprites for all
  pre-warmed kinds (currently planned to cover enemies, all `(slot, tier)`
  combinations, and projectiles).
- **Generation budget:** dominated by build-time pre-warming. Runtime
  prefetch is a small constant per scene transition.

This shape is what makes the asset service deployable on a bounded budget:
you pay for generation once per `(template, size, style)` combination, not
once per scene-visit.
