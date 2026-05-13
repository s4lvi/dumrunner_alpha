// Animation engine — pure state machine. Phase B foundation.
//
// One AnimationController per renderable entity. The controller
// knows nothing about Pixi or any other renderer; it tracks the
// current state, computes the frame index from the elapsed time
// in that state, and emits transitions when a non-looping state
// reaches its last frame. Callers feed it `tick(now)` once per
// render frame and consult `currentFrame()` to learn which (state,
// frameIndex) to draw — they fetch the actual texture themselves.
//
// State transition policy:
//   - play(state) sets a target state at the next tick. The
//     transition fires immediately (no blend / no easing); future
//     polish can layer that on top without changing the API.
//   - tick(now) advances `frameIndex` per the active state's fps.
//     When a non-looping state's last frame ends, `tick` honours
//     the `next` field:
//       * a state name → swap to it
//       * 'previous'   → swap to whatever played before this one
//       * null/missing → freeze on the last frame (terminal)
//   - The "previous" stack is depth-1. The hit-overlay use case
//     ("flash white briefly, then resume walking") only needs one
//     level. Anything deeper warrants a real stack — flag if we
//     hit that case.
//
// Time source: callers pass `now` in milliseconds. The controller
// stays time-source-agnostic so server-side simulations and
// browser renderers can share it.

import type { AnimationDef, AnimationState } from './content/types';

export type AnimationFrame = {
  /** Active state name (key into AnimationDef.states). */
  state: string;
  /** 0..frames-1 within the active state's sheet. */
  frameIndex: number;
  /** True when the state finished its last frame and `next` was
   *  null — the controller is now holding the final frame. */
  finished: boolean;
};

const PREVIOUS = 'previous';

export class AnimationController {
  private readonly def: AnimationDef;
  private currentState: string;
  private prevState: string | null = null;
  // Wall-clock time (ms) at which the active state began. The
  // computed frame index = floor((now - startedAt) * fps / 1000).
  // Reset on every play() / auto-transition.
  private startedAt = 0;
  private finished = false;

  constructor(def: AnimationDef, initialState: string) {
    this.def = def;
    if (!def.states[initialState]) {
      throw new Error(
        `[animation] initial state "${initialState}" not authored on ` +
          `${def.id} (states: ${Object.keys(def.states).join(', ')})`,
      );
    }
    this.currentState = initialState;
  }

  /** Manifest-bound state list. Useful for callers driving a
   *  dropdown / picker UI. */
  get states(): string[] {
    return Object.keys(this.def.states);
  }

  /** Current state name (read-only). */
  get state(): string {
    return this.currentState;
  }

  /**
   * Switch to `state` immediately. No-op if already on that state
   * (so e.g. an enemy that's already in `chase` doesn't keep
   * restarting its walk cycle on every server tick). Pass
   * `interrupt: true` to restart even when already on the target
   * state — useful for re-triggering a one-shot like `attack`.
   */
  play(state: string, opts: { interrupt?: boolean } = {}): void {
    if (!this.def.states[state]) {
      throw new Error(
        `[animation] state "${state}" not authored on ${this.def.id}`,
      );
    }
    if (state === this.currentState && !opts.interrupt) return;
    this.prevState = this.currentState;
    this.currentState = state;
    this.startedAt = 0; // sentinel — first tick after play() resets to `now`
    this.finished = false;
  }

  /**
   * Advance the active state's frame index. Auto-transitions on
   * non-loop completion. Returns the (state, frameIndex) pair
   * the caller should render.
   */
  tick(now: number): AnimationFrame {
    if (this.startedAt === 0) this.startedAt = now;
    const state = this.def.states[this.currentState];
    if (!state) {
      // Defensive — should never happen after the constructor /
      // play() guards. Return the legal-but-meaningless first frame.
      return { state: this.currentState, frameIndex: 0, finished: true };
    }
    if (this.finished) {
      return {
        state: this.currentState,
        frameIndex: state.frames - 1,
        finished: true,
      };
    }
    const elapsedSec = (now - this.startedAt) / 1000;
    const rawFrame = Math.floor(elapsedSec * state.fps);
    if (state.loop) {
      // Cycle modulo frames. Never finishes.
      const idx = ((rawFrame % state.frames) + state.frames) % state.frames;
      return { state: this.currentState, frameIndex: idx, finished: false };
    }
    if (rawFrame < state.frames) {
      return { state: this.currentState, frameIndex: rawFrame, finished: false };
    }
    // Non-looping state finished its last frame this tick. Decide
    // what plays next.
    const next = state.next;
    if (next === undefined || next === null) {
      // Terminal — freeze on the last frame.
      this.finished = true;
      return {
        state: this.currentState,
        frameIndex: state.frames - 1,
        finished: true,
      };
    }
    if (next === PREVIOUS) {
      const target = this.prevState ?? this.currentState;
      // Swap, then re-tick on the new state so the caller gets the
      // first frame this same call rather than a one-frame gap.
      this.prevState = this.currentState;
      this.currentState = target;
      this.startedAt = now;
      return this.tick(now);
    }
    if (!this.def.states[next]) {
      // Author error — gracefully hold the final frame rather than
      // throw from a hot render path.
      this.finished = true;
      return {
        state: this.currentState,
        frameIndex: state.frames - 1,
        finished: true,
      };
    }
    this.prevState = this.currentState;
    this.currentState = next;
    this.startedAt = now;
    this.finished = false;
    return this.tick(now);
  }

  /** Snapshot the current frame without advancing time. Use this
   *  when you need to read the state outside the render loop. */
  currentFrame(now: number): AnimationFrame {
    // tick() short-circuits when nothing's changed since the last
    // call, so it's a safe accessor — no double-advance risk.
    return this.tick(now);
  }
}

/** Convenience: pull a state's authored fps so a caller can show
 *  it in a tooltip without poking into AnimationDef structure. */
export function stateFps(def: AnimationDef, state: string): number | null {
  const s = def.states[state];
  return s ? s.fps : null;
}

/** Type-guard re-export for callers that only have the loader's
 *  result handy and want to narrow without re-importing the
 *  schema. */
export type { AnimationDef, AnimationState };
