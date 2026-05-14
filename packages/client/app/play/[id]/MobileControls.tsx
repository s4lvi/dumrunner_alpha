// Touch-input overlay for the FPS renderer. Mounted only when
// useIsTouchDevice() returns true so desktop sessions are
// untouched. Four interactive regions on top of the canvas:
//
//   - Left bottom:  virtual movement stick → forward/right vector
//                   + sprint when pushed past the threshold.
//   - Right bottom: virtual look stick → continuous yaw/pitch
//                   while held. Quick tap (short hold, no drag)
//                   fires one shot.
//   - Right edge:   action column (Reload / Interact).
//   - Top right:    inventory toggle.
//
// Pointer events are used throughout — same code handles finger
// and stylus input. Each region calls setPointerCapture on down
// so dragging off the region keeps emitting until release.

'use client';

import { useCallback, useEffect, useRef } from 'react';

// Joystick geometry. Outer ring is the visible base; the thumb
// can travel from centre out to (OUTER_RADIUS - THUMB_RADIUS) so
// it never escapes the ring. Both joysticks share the same look.
const JOY_OUTER_RADIUS = 64;
const JOY_THUMB_RADIUS = 28;
const JOY_TRAVEL = JOY_OUTER_RADIUS - JOY_THUMB_RADIUS;
const JOY_DEAD_ZONE = 0.12;

// Left-stick sprint engages when the thumb is pushed past this
// fraction of the travel range. "Push the stick hard" — saves a
// dedicated sprint control on a tight touch surface.
const JOY_SPRINT_THRESHOLD = 0.92;

// Right-stick look rate at max deflection. Expressed in pixels
// per second so the renderer can keep using its existing
// POINTER_SENSITIVITY (rad/px) without an extra knob. At 1200
// px/s × 0.0025 rad/px = 3 rad/s ≈ 170°/s — fast enough to
// 180-spin in about a second, slow enough that small corrections
// aren't twitchy. Pitch uses a lower rate so vertical look isn't
// punishingly sensitive (and pitch is already clamped at the
// renderer side).
const LOOK_RATE_PX_PER_SEC_X = 1200;
const LOOK_RATE_PX_PER_SEC_Y = 600;

// Tap detection on the look stick. A "tap" is a press + release
// that completes quickly and never moves the thumb more than a
// short distance from centre. Anything else is treated as a
// look-only drag and doesn't fire.
const TAP_MAX_DURATION_MS = 220;
const TAP_MAX_MOVE_PX = 14;

export function MobileControls({
  onMove,
  onLookDelta,
  onFire,
  onReload,
  onInteract,
  onOpenInventory,
  canInteract,
  canReload,
}: {
  onMove: (forward: number, right: number, sprint: boolean) => void;
  onLookDelta: (dx: number, dy: number) => void;
  // Single-shot fire. Triggered by a tap on the look stick (touch
  // down + release within TAP_MAX_DURATION_MS, total movement
  // < TAP_MAX_MOVE_PX). The renderer's per-weapon fire interval
  // handles redundant taps.
  onFire: () => void;
  onReload: () => void;
  onInteract: () => void;
  onOpenInventory: () => void;
  canInteract: boolean;
  canReload: boolean;
}): React.ReactElement {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 select-none"
      // Block all touch gestures the browser might intercept
      // (pinch-zoom, double-tap-zoom, swipe-back). Active regions
      // re-enable pointer events selectively.
      style={{ touchAction: 'none' }}
    >
      <MoveJoystick onMove={onMove} />
      <LookJoystick onLookDelta={onLookDelta} onFire={onFire} />
      <ActionColumn
        onReload={onReload}
        onInteract={onInteract}
        canInteract={canInteract}
        canReload={canReload}
      />
      <InventoryButton onOpenInventory={onOpenInventory} />
    </div>
  );
}

// ---------- Move joystick (left) ----------

function MoveJoystick({
  onMove,
}: {
  onMove: (forward: number, right: number, sprint: boolean) => void;
}): React.ReactElement {
  // Touch state lives in refs because we don't want to re-render
  // 60×/sec from move events — only the visible thumb position
  // updates via the imperative DOM ref.
  const baseRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const touchIdRef = useRef<number | null>(null);
  const centerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const lastDispatchRef = useRef<{
    forward: number;
    right: number;
    sprint: boolean;
  }>({ forward: 0, right: 0, sprint: false });

  const updateThumb = useCallback((dx: number, dy: number): void => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;
  }, []);

  const dispatch = useCallback(
    (forward: number, right: number, sprint: boolean): void => {
      const last = lastDispatchRef.current;
      if (
        Math.abs(last.forward - forward) < 0.005 &&
        Math.abs(last.right - right) < 0.005 &&
        last.sprint === sprint
      ) {
        return;
      }
      lastDispatchRef.current = { forward, right, sprint };
      moveRef.current(forward, right, sprint);
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (touchIdRef.current !== null) return;
      const base = baseRef.current;
      if (!base) return;
      touchIdRef.current = e.pointerId;
      base.setPointerCapture(e.pointerId);
      const rect = base.getBoundingClientRect();
      centerRef.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (touchIdRef.current !== e.pointerId) return;
      const c = centerRef.current;
      let dx = e.clientX - c.x;
      let dy = e.clientY - c.y;
      const mag = Math.hypot(dx, dy);
      if (mag > JOY_TRAVEL) {
        const scale = JOY_TRAVEL / mag;
        dx *= scale;
        dy *= scale;
      }
      updateThumb(dx, dy);
      const norm = Math.min(1, mag / JOY_TRAVEL);
      if (norm < JOY_DEAD_ZONE) {
        dispatch(0, 0, false);
        return;
      }
      const forward = -dy / JOY_TRAVEL;
      const right = dx / JOY_TRAVEL;
      dispatch(
        Math.max(-1, Math.min(1, forward)),
        Math.max(-1, Math.min(1, right)),
        norm >= JOY_SPRINT_THRESHOLD,
      );
    },
    [updateThumb, dispatch],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (touchIdRef.current !== e.pointerId) return;
      touchIdRef.current = null;
      const base = baseRef.current;
      if (base?.hasPointerCapture(e.pointerId)) {
        base.releasePointerCapture(e.pointerId);
      }
      updateThumb(0, 0);
      dispatch(0, 0, false);
    },
    [updateThumb, dispatch],
  );

  return (
    <div
      ref={baseRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="pointer-events-auto absolute rounded-full bg-black/35 border border-white/15 backdrop-blur-sm"
      style={{
        width: JOY_OUTER_RADIUS * 2,
        height: JOY_OUTER_RADIUS * 2,
        left: 24,
        bottom: 24,
        touchAction: 'none',
      }}
    >
      <div
        ref={thumbRef}
        className="absolute rounded-full bg-white/40 border border-white/60"
        style={{
          width: JOY_THUMB_RADIUS * 2,
          height: JOY_THUMB_RADIUS * 2,
          left: JOY_OUTER_RADIUS - JOY_THUMB_RADIUS,
          top: JOY_OUTER_RADIUS - JOY_THUMB_RADIUS,
          willChange: 'transform',
        }}
      />
    </div>
  );
}

// ---------- Look joystick (right) ----------
//
// Mirrors the move joystick on the right side of the screen.
// Deflection drives continuous look rotation via a per-frame rAF
// loop that converts stick deflection into synthetic pointer
// deltas — keeps the renderer's existing applyLookDelta API in
// charge of POINTER_SENSITIVITY + pitch clamping.
//
// A press that completes quickly without dragging the thumb is
// interpreted as a fire tap. The "drag mode" and "tap mode" are
// resolved at release time: while the thumb is past TAP_MAX_MOVE,
// or the press has lasted past TAP_MAX_DURATION_MS, this press is
// committed to look-only and won't fire on release.

function LookJoystick({
  onLookDelta,
  onFire,
}: {
  onLookDelta: (dx: number, dy: number) => void;
  onFire: () => void;
}): React.ReactElement {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const touchIdRef = useRef<number | null>(null);
  const centerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Live thumb deflection in pixels (clamped to ring). Read by
  // the rAF loop to emit per-frame look deltas; mutated by
  // pointer-move.
  const deflectionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Press-time bookkeeping for tap detection. startedAt = 0 when
  // no press is active; maxMagPx tracks the largest deflection
  // the thumb reached during this press so a "drag-and-return"
  // doesn't get misidentified as a tap.
  const pressRef = useRef<{
    startedAt: number;
    maxMagPx: number;
  }>({ startedAt: 0, maxMagPx: 0 });
  // rAF handle so we can cancel on release and on unmount.
  const rafRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number>(0);
  const onLookRef = useRef(onLookDelta);
  onLookRef.current = onLookDelta;
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;

  const updateThumb = useCallback((dx: number, dy: number): void => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;
  }, []);

  const stopLoop = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastFrameAtRef.current = 0;
  }, []);

  const tick = useCallback((nowMs: number): void => {
    if (touchIdRef.current === null) {
      rafRef.current = null;
      return;
    }
    const prev = lastFrameAtRef.current;
    const dtSec = prev === 0 ? 1 / 60 : Math.min(0.1, (nowMs - prev) / 1000);
    lastFrameAtRef.current = nowMs;
    const def = deflectionRef.current;
    // Normalize against travel range to a unit vector at max
    // deflection. Anything inside the dead zone emits no rotation
    // so a resting finger doesn't drift the view.
    const normX = def.x / JOY_TRAVEL;
    const normY = def.y / JOY_TRAVEL;
    const mag = Math.hypot(normX, normY);
    if (mag >= JOY_DEAD_ZONE) {
      const dx = normX * LOOK_RATE_PX_PER_SEC_X * dtSec;
      // y-down screen → pitch lookdown: feedforward dy directly;
      // the renderer subtracts on its side (mouse-down = look-
      // down behaviour the user already preferred).
      const dy = normY * LOOK_RATE_PX_PER_SEC_Y * dtSec;
      onLookRef.current(dx, dy);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (touchIdRef.current !== null) return;
      const base = baseRef.current;
      if (!base) return;
      touchIdRef.current = e.pointerId;
      base.setPointerCapture(e.pointerId);
      const rect = base.getBoundingClientRect();
      centerRef.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      deflectionRef.current = { x: 0, y: 0 };
      pressRef.current = { startedAt: performance.now(), maxMagPx: 0 };
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(tick);
      }
    },
    [tick],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (touchIdRef.current !== e.pointerId) return;
      const c = centerRef.current;
      let dx = e.clientX - c.x;
      let dy = e.clientY - c.y;
      const mag = Math.hypot(dx, dy);
      if (mag > JOY_TRAVEL) {
        const scale = JOY_TRAVEL / mag;
        dx *= scale;
        dy *= scale;
      }
      updateThumb(dx, dy);
      deflectionRef.current = { x: dx, y: dy };
      const press = pressRef.current;
      const visibleMag = Math.hypot(dx, dy);
      if (visibleMag > press.maxMagPx) press.maxMagPx = visibleMag;
    },
    [updateThumb],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (touchIdRef.current !== e.pointerId) return;
      const press = pressRef.current;
      const elapsed = performance.now() - press.startedAt;
      const wasTap =
        elapsed <= TAP_MAX_DURATION_MS && press.maxMagPx <= TAP_MAX_MOVE_PX;
      touchIdRef.current = null;
      const base = baseRef.current;
      if (base?.hasPointerCapture(e.pointerId)) {
        base.releasePointerCapture(e.pointerId);
      }
      updateThumb(0, 0);
      deflectionRef.current = { x: 0, y: 0 };
      pressRef.current = { startedAt: 0, maxMagPx: 0 };
      stopLoop();
      if (wasTap) onFireRef.current();
    },
    [updateThumb, stopLoop],
  );

  // Defensive cleanup. A renderer remount mid-press would
  // otherwise leak the rAF callback.
  useEffect(() => () => stopLoop(), [stopLoop]);

  return (
    <div
      ref={baseRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="pointer-events-auto absolute rounded-full bg-black/35 border border-white/15 backdrop-blur-sm"
      style={{
        width: JOY_OUTER_RADIUS * 2,
        height: JOY_OUTER_RADIUS * 2,
        right: 24,
        bottom: 24,
        touchAction: 'none',
      }}
    >
      <div
        ref={thumbRef}
        className="absolute rounded-full bg-red-400/55 border border-red-200/70"
        style={{
          width: JOY_THUMB_RADIUS * 2,
          height: JOY_THUMB_RADIUS * 2,
          left: JOY_OUTER_RADIUS - JOY_THUMB_RADIUS,
          top: JOY_OUTER_RADIUS - JOY_THUMB_RADIUS,
          willChange: 'transform',
        }}
      />
    </div>
  );
}

// ---------- Action column (right edge, above the look stick) ----------

function ActionColumn({
  onReload,
  onInteract,
  canInteract,
  canReload,
}: {
  onReload: () => void;
  onInteract: () => void;
  canInteract: boolean;
  canReload: boolean;
}): React.ReactElement {
  return (
    <div
      className="pointer-events-none absolute flex flex-col items-end gap-3"
      // Sits above the look-joystick (24 + 128 = 152 from bottom)
      // plus a small gap so a fingertip on the joystick can't
      // graze a button.
      style={{ right: 24, bottom: 168 }}
    >
      {canInteract && (
        <RoundButton
          label="E"
          sub="use"
          onClick={onInteract}
          color="bg-yellow-500/70 border-yellow-300/60"
          size={64}
        />
      )}
      {canReload && (
        <RoundButton
          label="R"
          sub="reload"
          onClick={onReload}
          color="bg-zinc-700/70 border-zinc-400/60"
          size={64}
        />
      )}
    </div>
  );
}

function RoundButton({
  label,
  sub,
  onClick,
  color,
  size,
}: {
  label: string;
  sub?: string;
  onClick: () => void;
  color: string;
  size: number;
}): React.ReactElement {
  // Tap-only buttons fire on onPointerUp instead of onClick so
  // the action lands on the same touch that hit the element — no
  // 300ms click delay, no synthesized-event ordering surprises
  // inside the Discord iframe.
  const onTap = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      e.preventDefault();
      onClick();
    },
    [onClick],
  );
  return (
    <button
      type="button"
      onPointerUp={onTap}
      className={`pointer-events-auto rounded-full border-2 text-white font-semibold shadow-lg active:brightness-125 flex flex-col items-center justify-center ${color}`}
      style={{ width: size, height: size, touchAction: 'none' }}
    >
      <span className="leading-none">{label}</span>
      {sub && (
        <span className="text-[9px] opacity-80 leading-none mt-0.5">
          {sub}
        </span>
      )}
    </button>
  );
}

// ---------- Inventory button ----------

function InventoryButton({
  onOpenInventory,
}: {
  onOpenInventory: () => void;
}): React.ReactElement {
  const onTap = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      e.preventDefault();
      onOpenInventory();
    },
    [onOpenInventory],
  );
  return (
    <button
      type="button"
      onPointerUp={onTap}
      className="pointer-events-auto absolute rounded-md bg-zinc-900/80 border border-zinc-600 text-zinc-100 text-xs px-3 py-2 shadow-lg active:bg-zinc-800/90"
      style={{
        right: 16,
        top: 16,
        touchAction: 'none',
        minWidth: 44,
        minHeight: 44,
      }}
    >
      Inventory
    </button>
  );
}

// ---------- Orientation lock (P4) ----------
//
// Best-effort landscape lock when the overlay mounts. Tied to the
// Screen Orientation API; Safari < 17 and some Discord embeds
// won't honour it and will throw — we swallow because the game is
// playable in portrait, just less comfortable. Unlock on unmount
// so other pages can flip back to portrait naturally.

export function useLandscapeOrientationLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const orientation = (
      screen as unknown as {
        orientation?: {
          lock?: (o: string) => Promise<void>;
          unlock?: () => void;
        };
      }
    ).orientation;
    if (!orientation || typeof orientation.lock !== 'function') return;
    let released = false;
    void orientation.lock('landscape').catch(() => {
      /* unsupported / not allowed — leave orientation free */
    });
    return () => {
      released = true;
      try {
        orientation.unlock?.();
      } catch {
        /* ignore */
      }
      void released;
    };
  }, [active]);
}
