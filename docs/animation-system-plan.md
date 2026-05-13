# Animation System — Implementation Plan

Status: scoped, not started. Sequenced *after* the recipe + attachment
editors finish (those are the queued main-line items as of 2026-05-11).

Three substantial PRs in order, none blocking the next though each
unlocks more visible work:

1. **Phase A** — bullet sprites + static FPS view-model (no engine yet).
2. **Phase B + C** — animation engine foundation + consumer integration
   (enemies, props, projectiles, FPS view-model).
3. **Phase D** — ambient looping animations on biome walls / floors / ceilings.

## Locked decisions

These came out of the scope discussion; not relitigating them mid-PR.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Fixed `fps` per state**, not per-frame durations. | Matches asset_gen output; per-frame durations bloat the editor for marginal gain at our authoring scale. |
| 2 | **Per-weapon bullet sprites, falling back to per-family default.** | Authoring stays cheap (one sprite per family is enough for most weapons); the override unlocks signature visuals (e.g. an Alien Core energy weapon's distinct projectile). |
| 3 | **Independent timing per tile variant** for ambient animations. | Each cell rolls its own time offset; flickering reads correctly. Synced-pulse can be added later as an opt-in `syncedTiming: true` flag if needed. |
| 4 | **Death animation's last frame becomes the corpse visual.** | The death anim owns the death-to-corpse transition; no separate handoff. Corpse system unchanged. |
| 5 | **No asset_gen wiring in this PR series.** | Authors drop spritesheet PNGs into the texture editor manually. asset_gen integration is a separate later pass. |
| 6 | **Speed slider is per-state in the editor only.** | No global debug knob ships in this work. If needed for debugging later, a `?animSpeed=` URL param is one-line. |

## Architecture (recap)

Three new concepts:

1. **Animation manifest** — `public/textures/<category>/<id>/anim.json` next to per-state spritesheet PNGs:
   ```jsonc
   {
     "states": {
       "idle":   { "frames": 4, "fps": 6,  "loop": true },
       "walk":   { "frames": 6, "fps": 10, "loop": true },
       "attack": { "frames": 3, "fps": 12, "loop": false, "next": "idle" },
       "hit":    { "frames": 2, "fps": 14, "loop": false, "next": "previous" },
       "death":  { "frames": 5, "fps": 8,  "loop": false, "next": null }
     }
   }
   ```
   No `anim.json` → asset stays a single static PNG (current behavior). Partial coverage allowed — unauthored states fall through to the static.

2. **AnimationController** (client-side runtime) — per-entity state machine. Owns `currentState`, `frameStartTime`, computes `frameIndex` per render frame, returns the current `Texture`. Reacts to state-change requests, hit pulses, death triggers.

3. **Closed state enums per category:**

   | Category | States |
   |---|---|
   | `enemy` | `idle`, `walk`, `attack`, `hit`, `death` |
   | `prop` | `idle`, `destroy` |
   | `weapon_view` (FPS view-model) | `idle`, `fire`, `reload` |
   | `projectile` | `idle` (single, loops) |
   | `biome_wall` / `biome_floor` / `biome_ceiling` | `idle` (single, loops) |

## Phase A — Bullet sprites + static FPS view-model

No animation engine yet. Pure texture-extension work.

- New texture category `projectile` keyed by weapon id (per-weapon override) with fallback to weapon family (`projectile/<family>` if `projectile/<id>` is absent).
- New texture category `weapon_view` keyed by weapon id — single static pose anchored bottom-centre of the FPS canvas.
- FPS renderer adds a HUD-anchored `viewModelLayer` between the wall layer and the HUD.
- Procedural projectile colored circle swapped for the sprite when one is uploaded; fallback unchanged when no override exists.
- Texture editor gains the two new category rows next to existing enemy / prop / building.

**Out of scope:** any animation. The view-model is one frame. Bullets are one frame. Idle weapon bob ships in Phase C with the engine.

## Phase B — Animation engine

The foundation. No consumer integration yet.

- `AnimationDef` Zod schema in `shared/content/types.ts`. `loadAnimation` / `saveAnimation` helpers and `'animations'` editor area in `loader.ts`.
- `AnimationController` class in shared:
  - `play(state: string)` — explicit state set.
  - `tick(now: number)` — called once per render frame, advances frame index, fires `onEnd` for non-looping states (triggers `next` or stops).
  - `frame(): { texture: Texture, frameIndex: number }` — current frame for rendering.
- Texture loader extended: when `<category>/<id>/anim.json` is present, load each `<state>.png` as a Pixi `Spritesheet`. Cache spritesheets so re-renders don't re-parse.
- Manifest reload via the existing content watcher — editor saves an anim, runtime picks it up on next frame.
- A `/editor/sandbox-test/anim` page that plays an arbitrary asset's manifest in isolation so the engine is testable before integration.

## Phase C — Consumer integration

Renderer hooks for each category. Each is independent but shares the controller class.

- **Enemy** — `enemy.state` (server's existing field: `idle`, `chase`, `attack_prep`, `flee`) maps to anim state. `enemy_damaged` triggers `hit` for ~120ms then returns to previous. `enemy_killed` triggers `death`; final frame stays as the corpse visual (no handoff to a separate corpse sprite). Misses fall back to static (`enemy/<kind>.png` continues to render).
- **Prop** — `prop_destroyed` plays `destroy` one-shot, then despawns at end of animation (slight stagger from the current immediate despawn — needs the despawn deferred by the animation duration).
- **Projectile** — looping idle on the projectile's lifetime. Falls back to procedural colored circle when no sprite is authored.
- **FPS view-model** — `fire` and `reload` events trigger one-shots; `idle` loops with a subtle movement-driven bob. Server-side reload windows already broadcast `reload_started`; client adds the visual response.

## Phase D — Ambient tile animations

Walls / floors / ceilings looping in the FPS renderer. The hardest renderer work.

- The column raycaster's per-cell texture lookup grows a per-cell `(time + cellHash) % cycleLength → frame` mapping. Each cell rolls its own time offset (decision #3) so flicker reads independently.
- Floor / ceiling strip mesh sampling re-fetches the active frame's `Texture` each render frame for each authored variant. Pixi handles the per-frame texture-handle swap cheaply.
- Performance test before merging: animated biome × N columns × 60fps is the hot path. Spritesheet texture-region swaps are O(1), so cost should be flat.

## Editor surface (threaded through every phase)

The texture editor grows a per-state upload section when the asset's category supports animation:

```
chaser_melee
  ┌─ idle    [drop sheet]  frames: 4  fps: 6   loop: ☑  speed: 1.0×
  ├─ walk    [drop sheet]  frames: 6  fps: 10  loop: ☑  speed: 1.0×
  ├─ attack  [drop sheet]  frames: 3  fps: 12  loop: ☐  next: idle
  ├─ hit     [drop sheet]  frames: 2  fps: 14  loop: ☐  next: previous
  └─ death   [drop sheet]  frames: 5  fps: 8   loop: ☐  next: (stop)
```

Partial coverage is valid — uploading just an `idle` while leaving the others as the static PNG should "just work".

## What ships first

Phase A. It's the smallest, the most contained, and lights up the FPS
view immediately (weapon held in hand + bullet sprites). Phases B + C
follow as the "real animation system" PR. Phase D last.
