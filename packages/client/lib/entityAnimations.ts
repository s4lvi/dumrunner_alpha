// Per-entity animation orchestration. Bridges the renderer
// (which knows nothing about state machines) and the shared
// AnimationController (which knows nothing about Pixi). One
// controller per entityKey; lazy-created the first time we see
// the entity. When the entity despawns the renderer calls
// `dropEntityAnim(entityKey)` to free the controller.
//
// The renderer asks `getAnimationFrame(...)` every render frame.
// Internally:
//   1. Make sure the manifest is loaded for `animationId`.
//      Falls back to null until the async fetch lands — caller's
//      static-texture fallback continues to render in the
//      meantime.
//   2. Get or create the controller for entityKey. Initial state
//      = whatever was last requested via playEntityState, or the
//      `initialState` argument on first sight.
//   3. Tick the controller.
//   4. Resolve the Texture from the spritesheet cache.
//
// Layered on top of the static texture-override path: an entity
// whose animationId is null (or whose animation isn't loaded yet)
// renders exactly as it did pre-Phase-C.

'use client';

import type { Texture } from 'pixi.js';
import {
  AnimationController,
  type AnimationDef,
} from '@dumrunner/shared';
import {
  getAnimationDef,
  getStateFrames,
  loadAnimationDef,
  subscribeAnimations,
} from './animations';

type EntitySlot = {
  animationId: string;
  // null until the manifest fetch lands (or fetch resolved to no
  // manifest). Once a manifest is found, this stays populated
  // for the lifetime of the entity.
  def: AnimationDef | null;
  controller: AnimationController | null;
  // State queued by playEntityState before the controller was
  // ready; applied on first construction.
  queuedState: string | null;
  // True when we fetched and got null — keep this so we don't
  // re-issue the same fetch every frame for un-animated entities.
  resolvedNoManifest: boolean;
};

const slots = new Map<string, EntitySlot>();

function ensureSlot(key: string, animationId: string): EntitySlot {
  const existing = slots.get(key);
  // If an entity's animationId changes under us (rare — would mean
  // the server swapped a kind's animation mid-session), drop the
  // old slot and rebuild on the next call.
  if (existing && existing.animationId === animationId) return existing;
  if (existing) slots.delete(key);
  const slot: EntitySlot = {
    animationId,
    def: null,
    controller: null,
    queuedState: null,
    resolvedNoManifest: false,
  };
  slots.set(key, slot);
  return slot;
}

function tryResolveManifest(slot: EntitySlot, initialState: string): void {
  if (slot.def || slot.resolvedNoManifest) return;
  // Synchronous fast-path: if the manifest is already cached,
  // build the controller this frame.
  const cached = getAnimationDef(slot.animationId);
  if (cached) {
    finalizeController(slot, cached, initialState);
    return;
  }
  // Kick off the async load. We don't await it here; the next
  // render frame will hit the cached value.
  void loadAnimationDef(slot.animationId).then((def) => {
    if (def) {
      finalizeController(slot, def, initialState);
    } else {
      slot.resolvedNoManifest = true;
    }
  });
}

function finalizeController(
  slot: EntitySlot,
  def: AnimationDef,
  initialState: string,
): void {
  slot.def = def;
  const startState =
    slot.queuedState && def.states[slot.queuedState]
      ? slot.queuedState
      : def.states[initialState]
        ? initialState
        : Object.keys(def.states)[0];
  if (!startState) {
    // Manifest with no states — author error. Pretend it doesn't
    // exist so the static fallback renders.
    slot.resolvedNoManifest = true;
    slot.def = null;
    return;
  }
  slot.controller = new AnimationController(def, startState);
  slot.queuedState = null;
  // Prewarm EVERY state's textures now, not on first play. Frame
  // sheets load lazily per state, so without this the first fire /
  // reload / hit of each state rendered the static placeholder for
  // a frame or two while its sheet fetched. getStateFrames kicks
  // the async load and caches; by the time the state first plays
  // the textures are resident.
  prewarmStates(slot.animationId, def);
}

function prewarmStates(animationId: string, def: AnimationDef): void {
  for (const [stateName, st] of Object.entries(def.states)) {
    getStateFrames(animationId, stateName, st.frames, st.source ?? 'sheet');
  }
}

/**
 * Fire-and-forget full prewarm of an animation: manifest + every
 * state's frame textures. Call at boot for animations you know
 * will play (weapon view-models, projectiles) so even their FIRST
 * use renders real frames instead of the placeholder.
 *
 * Prewarmed ids are registered and re-attempted whenever the
 * animation/override caches notify — a boot-time call can land
 * before the texture-override manifest does, in which case the
 * state URLs resolve empty and the initial attempt no-ops.
 */
const prewarmRegistry = new Map<string, AnimationDef>();
let prewarmRetryHooked = false;

export function prewarmAnimation(
  animationId: string | null | undefined,
): void {
  if (!animationId) return;
  if (!prewarmRetryHooked && typeof window !== 'undefined') {
    prewarmRetryHooked = true;
    subscribeAnimations(() => {
      // getStateFrames self-dedupes (cache + pending map), so
      // re-running registered prewarms on every notification is a
      // handful of map lookups.
      for (const [id, def] of prewarmRegistry) prewarmStates(id, def);
    });
  }
  void loadAnimationDef(animationId).then((def) => {
    if (def) {
      prewarmRegistry.set(animationId, def);
      prewarmStates(animationId, def);
    }
  });
}

/**
 * Resolve the Texture to render this frame for an animated
 * entity. Returns null when no manifest is authored / loaded yet,
 * or when animationId is null/undefined — caller should render
 * its existing static fallback in either case.
 */
export function getAnimationFrame(
  animationId: string | null | undefined,
  entityKey: string,
  now: number,
  initialState: string = 'idle',
): Texture | null {
  if (!animationId) return null;
  const slot = ensureSlot(entityKey, animationId);
  if (slot.resolvedNoManifest) return null;
  if (!slot.controller) {
    tryResolveManifest(slot, initialState);
    if (!slot.controller) return null;
  }
  const frame = slot.controller.tick(now);
  const stateDef = slot.def!.states[frame.state];
  if (!stateDef) return null;
  const frames = getStateFrames(
    animationId,
    frame.state,
    stateDef.frames,
    stateDef.source ?? 'sheet',
  );
  return frames[frame.frameIndex] ?? null;
}

/**
 * Request a state transition for an entity. If the controller
 * isn't built yet (manifest still loading), the request is
 * queued and applied on construction.
 *
 * `interrupt: true` replays the state when already on it — used
 * for one-shots like fire / hit so a repeat trigger restarts the
 * animation rather than no-op'ing.
 */
export function playEntityState(
  animationId: string | null | undefined,
  entityKey: string,
  state: string,
  opts: { interrupt?: boolean } = {},
): void {
  if (!animationId) return;
  const slot = ensureSlot(entityKey, animationId);
  if (slot.resolvedNoManifest) return;
  if (slot.controller) {
    if (!slot.def!.states[state]) return; // unauthored state — silently ignore
    slot.controller.play(state, opts);
  } else {
    slot.queuedState = state;
    tryResolveManifest(slot, state);
  }
}

/**
 * Snapshot the controller's current state (for telemetry / UI).
 * Returns null when no controller exists.
 */
export function currentEntityState(entityKey: string): string | null {
  const slot = slots.get(entityKey);
  return slot?.controller?.state ?? null;
}

/**
 * Drop the controller + slot for an entity. Call on despawn so
 * we don't leak slots across cycles. Safe to call when no slot
 * exists.
 */
export function dropEntityAnim(entityKey: string): void {
  slots.delete(entityKey);
}

/**
 * Drop everything. Use on scene change / hard reset.
 */
export function clearAllEntityAnims(): void {
  slots.clear();
}
