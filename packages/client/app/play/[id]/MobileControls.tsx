// Touch-input overlay for the FPS renderer. Mounted only when
// useIsTouchDevice() returns true so desktop sessions are
// untouched. Lays four interactive regions on top of the canvas:
//
//   - Left bottom: virtual joystick → movement vector + sprint
//   - Right half:  invisible look-pad → camera yaw / pitch deltas
//   - Right edge:  combat column (Fire / Reload / Interact)
//   - Top-right:   inventory toggle button
//
// Pointer events are used throughout so the same code handles
// finger and stylus input without an explicit touch fallback.
// Each interactive region uses setPointerCapture on down so a
// finger that drags off the region keeps emitting until it
// lifts — important for the look-pad where the player will sweep
// across boundaries.

'use client';

import { useCallback, useEffect, useRef } from 'react';

// Joystick geometry. Outer ring is the visible base; the thumb
// can travel from centre out to (OUTER_RADIUS - THUMB_RADIUS) so
// it never escapes the ring. Sprint engages when the thumb is
// pushed past SPRINT_THRESHOLD of the travel range — same "push
// the stick hard" pattern other mobile FPS games use, and avoids
// adding a second UI control just to sprint.
const JOY_OUTER_RADIUS = 64;
const JOY_THUMB_RADIUS = 28;
const JOY_TRAVEL = JOY_OUTER_RADIUS - JOY_THUMB_RADIUS;
const JOY_DEAD_ZONE = 0.12;
const JOY_SPRINT_THRESHOLD = 0.92;

// Pixel multiplier applied to look-pad pointer deltas before they
// hit applyLookDelta. The renderer's POINTER_SENSITIVITY is tuned
// for mouse pixels (typically 1-pixel-per-pixel under pointer
// lock); finger deltas are several pixels per visual unit of
// rotation, so we scale up here so a quick swipe feels like a
// half-turn rather than a head twitch.
const LOOK_SENSITIVITY_X = 1.0;
const LOOK_SENSITIVITY_Y = 1.0;

export function MobileControls({
  onMove,
  onLookDelta,
  onFireDown,
  onFireUp,
  onReload,
  onInteract,
  onOpenInventory,
  canInteract,
  canReload,
}: {
  onMove: (forward: number, right: number, sprint: boolean) => void;
  onLookDelta: (dx: number, dy: number) => void;
  onFireDown: () => void;
  onFireUp: () => void;
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
      // (pinch-zoom, double-tap-zoom, swipe-back). The active
      // regions re-enable pointer events selectively.
      style={{ touchAction: 'none' }}
    >
      <Joystick onMove={onMove} />
      <LookPad onLookDelta={onLookDelta} />
      <CombatColumn
        onFireDown={onFireDown}
        onFireUp={onFireUp}
        onReload={onReload}
        onInteract={onInteract}
        canInteract={canInteract}
        canReload={canReload}
      />
      <InventoryButton onOpenInventory={onOpenInventory} />
    </div>
  );
}

// ---------- Joystick ----------

function Joystick({
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
  // Latest dispatched vector — used to compare against the next
  // frame's value so we only call onMove when something actually
  // changed (cuts WS chatter when the finger sits still).
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
      // Clamp the visible thumb to the ring; clamp the dispatched
      // vector to 1.0 magnitude so the server still receives a
      // unit-circle input even when the finger is dragged past
      // the outer ring.
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
      // Joystick visual deflection → input vector. Up is forward,
      // so forward = -dy / TRAVEL (screen y grows downward).
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

// ---------- Look-pad ----------
//
// Right half of the screen (minus the combat column) is a
// transparent capture area. Each finger drag emits a delta in
// pixels that the GameHandle translates into yaw / pitch rotation
// using the same POINTER_SENSITIVITY constant the mouse path
// uses. No persistent visual — keeps the FPS view as clean as
// possible.

function LookPad({
  onLookDelta,
}: {
  onLookDelta: (dx: number, dy: number) => void;
}): React.ReactElement {
  const lastRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const deltaRef = useRef(onLookDelta);
  deltaRef.current = onLookDelta;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      // Only claim the first touch — second-touch is reserved for
      // simultaneous fire/look multi-touch on the combat column.
      if (lastRef.current !== null) return;
      lastRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const last = lastRef.current;
      if (!last || last.id !== e.pointerId) return;
      const dx = (e.clientX - last.x) * LOOK_SENSITIVITY_X;
      const dy = (e.clientY - last.y) * LOOK_SENSITIVITY_Y;
      last.x = e.clientX;
      last.y = e.clientY;
      if (dx !== 0 || dy !== 0) deltaRef.current(dx, dy);
    },
    [],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const last = lastRef.current;
      if (!last || last.id !== e.pointerId) return;
      lastRef.current = null;
      const el = e.currentTarget as HTMLDivElement;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    },
    [],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="pointer-events-auto absolute"
      style={{
        // Right ~55% of the screen, leaving room for the combat
        // column. Vertical span clears the top inventory button.
        right: 0,
        top: 56,
        bottom: 0,
        // Width is roughly half-screen with a margin so a finger
        // can rest on the right edge without hitting the combat
        // column. The buttons sit ABOVE this layer via z-index,
        // so a touch over a button still registers on the button.
        width: 'calc(60vw - 96px)',
        touchAction: 'none',
      }}
    />
  );
}

// ---------- Combat column ----------

function CombatColumn({
  onFireDown,
  onFireUp,
  onReload,
  onInteract,
  canInteract,
  canReload,
}: {
  onFireDown: () => void;
  onFireUp: () => void;
  onReload: () => void;
  onInteract: () => void;
  canInteract: boolean;
  canReload: boolean;
}): React.ReactElement {
  return (
    <div
      className="pointer-events-none absolute"
      style={{ right: 16, bottom: 16, top: 64 }}
    >
      <div className="absolute right-0 bottom-0 flex flex-col items-end gap-3">
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
        <FireButton onDown={onFireDown} onUp={onFireUp} />
      </div>
    </div>
  );
}

function FireButton({
  onDown,
  onUp,
}: {
  onDown: () => void;
  onUp: () => void;
}): React.ReactElement {
  const onDownRef = useRef(onDown);
  onDownRef.current = onDown;
  const onUpRef = useRef(onUp);
  onUpRef.current = onUp;
  const heldIdRef = useRef<number | null>(null);
  const handleDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      // Reject extra touches so a second finger landing on Fire
      // while the first is still held doesn't double-trigger on
      // release. The first finger owns the held state.
      if (heldIdRef.current !== null) return;
      heldIdRef.current = e.pointerId;
      (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
      onDownRef.current();
    },
    [],
  );
  const handleUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      if (heldIdRef.current !== e.pointerId) return;
      heldIdRef.current = null;
      const el = e.currentTarget as HTMLButtonElement;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      onUpRef.current();
    },
    [],
  );
  return (
    <button
      type="button"
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      className="pointer-events-auto rounded-full bg-red-600/70 border-2 border-red-300/60 text-white font-semibold shadow-lg active:bg-red-500/80"
      style={{
        width: 84,
        height: 84,
        touchAction: 'none',
      }}
    >
      FIRE
    </button>
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
  // Tap-only buttons use onPointerUp instead of onClick so the
  // action fires on the same touch that hit the element — no
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
      // Reference released to keep the linter quiet about an
      // assigned-but-unused local. Used as a flag in case future
      // code wants to check whether unlock has run.
      void released;
    };
  }, [active]);
}
