// Geometry helpers for the SceneLayout shape. Server and client both consume
// these — server for movement collision and AI line-of-sight, client for
// visual line-of-sight against the same wall data.

import type { Rect } from './protocol';

export function isInsideAny(rects: Rect[], x: number, y: number): boolean {
  for (const r of rects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

// Bounding-circle fit: true iff a circle of `radius` at (x, y) lies entirely
// inside the walkable union. Samples 16 points around the circle (every
// 22.5°); worst-case "peek" between samples is < 0.5 × cos(11.25°) ≈ sub-px
// at common entity radii.
const COLLISION_SAMPLES = 16;
const COLLISION_UNITS: ReadonlyArray<{ ux: number; uy: number }> = (() => {
  const out: { ux: number; uy: number }[] = [];
  for (let i = 0; i < COLLISION_SAMPLES; i++) {
    const a = (i / COLLISION_SAMPLES) * Math.PI * 2;
    out.push({ ux: Math.cos(a), uy: Math.sin(a) });
  }
  return out;
})();

export function circleFits(
  rects: Rect[],
  x: number,
  y: number,
  radius: number
): boolean {
  for (const u of COLLISION_UNITS) {
    if (!isInsideAny(rects, x + u.ux * radius, y + u.uy * radius)) return false;
  }
  return true;
}

const LOS_SAMPLE_STEP_PX = 16;

// Returns true iff a segment from (x1,y1) to (x2,y2) stays entirely inside
// the union of walkable rects. Implementation samples points along the
// segment at fixed intervals.
export function segmentInsideWalkables(
  rects: Rect[],
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  if (rects.length === 0) return true;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) return isInsideAny(rects, x1, y1);

  const steps = Math.max(1, Math.ceil(length / LOS_SAMPLE_STEP_PX));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sx = x1 + dx * t;
    const sy = y1 + dy * t;
    if (!isInsideAny(rects, sx, sy)) return false;
  }
  return true;
}
