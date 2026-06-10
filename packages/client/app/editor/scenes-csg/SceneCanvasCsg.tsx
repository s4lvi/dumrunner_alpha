'use client';

// CSG scene editor canvas. Renders CsgShape polygons via Pixi
// and dispatches per-tool gestures (rect, polygon, adjust,
// delete) that produce updated CsgScene snapshots. Crucially the
// canvas NEVER touches linedefs — it edits shapes. The runtime
// linedef topology is derived from these shapes at save time by
// `csgSceneToLinedefScene`.

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics } from 'pixi.js';
import type { CsgScene, CsgShape, Vec2 } from '@dumrunner/shared';
import { csgSceneToLinedefScene } from '@dumrunner/shared';

export type CsgTool =
  | 'adjust'
  | 'rect-room'
  | 'rect-platform'
  | 'rect-pit'
  | 'rect-vent'
  | 'rect-window'
  | 'polygon'
  | 'circle'
  | 'subtract'
  | 'insert'
  | 'spawn'
  | 'light'
  | 'interactable'
  | 'delete';

export type CsgSnap = 'grid32' | 'grid16' | 'free';

export type CsgSelection =
  | { kind: 'shape'; id: number }
  | { kind: 'vertex'; shapeId: number; index: number }
  | { kind: 'light'; id: string }
  | { kind: 'interactable'; id: string }
  | null;

const RECT_TOOL_DEFAULTS: Record<
  'rect-room' | 'rect-platform' | 'rect-pit' | 'rect-vent' | 'rect-window',
  { floorZ: number; ceilingZ: number; label: string }
> = {
  'rect-room': { floorZ: 0, ceilingZ: 32, label: 'room' },
  'rect-platform': { floorZ: 16, ceilingZ: 32, label: 'platform' },
  'rect-pit': { floorZ: -8, ceilingZ: 32, label: 'pit' },
  'rect-vent': { floorZ: 0, ceilingZ: 14, label: 'vent' },
  'rect-window': { floorZ: 24, ceilingZ: 32, label: 'window' },
};

const SHAPE_FILL = 0x2a3b5a;
const SHAPE_OUTLINE = 0x5a7aaa;
const SHAPE_SELECTED_OUTLINE = 0xfacc15;
const SHAPE_SUBTRACT_FILL = 0x4a1f2f;
const SHAPE_SUBTRACT_OUTLINE = 0xff6b6b;
const VERT_FILL = 0xe8efff;
const VERT_HOVER = 0xfacc15;
const RECT_PREVIEW = 0x90c4ff;
const POLYGON_PREVIEW = 0xffa45c;
const CIRCLE_PREVIEW = 0xa78bfa;
const SPAWN_COLOR = 0x10b981;
const LIGHT_COLOR = 0xfde047;
const INTERACTABLE_COLOR = 0x60a5fa;
const AI_GRID_FILL = 0x666666;
const VERTEX_HIT_RADIUS_PX = 8;
const POI_HIT_RADIUS_PX = 10;
const CIRCLE_SEGMENTS = 24;
const AI_GRID_CELL = 16;

type Props = {
  scene: CsgScene;
  onSceneChange: (s: CsgScene) => void;
  onScenePreview?: (s: CsgScene) => void;
  tool: CsgTool;
  snap: CsgSnap;
  selection: CsgSelection;
  onSelectionChange: (sel: CsgSelection) => void;
  onActionLog?: (label: string) => void;
  // Toggle the 16-px walkable-grid overlay (2D point-in-shape).
  showAiGrid?: boolean;
};

export function SceneCanvasCsg({
  scene,
  onSceneChange,
  onScenePreview,
  tool,
  snap,
  selection,
  onSelectionChange,
  onActionLog,
  showAiGrid = false,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const rootRef = useRef<Container | null>(null);
  const sceneRef = useRef(scene);
  const toolRef = useRef(tool);
  const snapRef = useRef(snap);
  const selectionRef = useRef(selection);
  const onChangeRef = useRef(onSceneChange);
  const onPreviewRef = useRef(onScenePreview);
  const onSelectionRef = useRef(onSelectionChange);
  const onLogRef = useRef(onActionLog);
  const showAiGridRef = useRef(showAiGrid);

  // Camera state (pan/zoom) stored outside React; redraws are
  // imperative so the canvas doesn't churn on selection changes.
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const rectDragRef = useRef<Vec2 | null>(null);
  const rectPreviewRef = useRef<Vec2 | null>(null);
  const polygonChainRef = useRef<Vec2[]>([]);
  const polygonCursorRef = useRef<Vec2 | null>(null);
  const dragVertRef = useRef<{ shapeId: number; index: number } | null>(null);
  const hoverVertRef = useRef<{ shapeId: number; index: number } | null>(null);
  const draggingSpawnRef = useRef(false);
  const draggingPoiRef = useRef<
    { kind: 'light' | 'interactable'; id: string } | null
  >(null);
  const SPAWN_HIT_RADIUS_PX = 12;
  // Exposed by the init closure so the React effect below can
  // request a redraw whenever the parent passes a new scene /
  // selection. Without this the canvas only re-renders when the
  // user moves the cursor (which incidentally triggers redraw
  // via the pointer-move handler).
  const redrawRef = useRef<(() => void) | null>(null);

  // Keep refs in sync with React props each render. The canvas
  // reads from refs so callbacks captured in event listeners
  // always see the latest state.
  sceneRef.current = scene;
  toolRef.current = tool;
  snapRef.current = snap;
  selectionRef.current = selection;
  onChangeRef.current = onSceneChange;
  showAiGridRef.current = showAiGrid;
  onPreviewRef.current = onScenePreview;
  onSelectionRef.current = onSelectionChange;
  onLogRef.current = onActionLog;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let app: Application | null = null;
    let cleanup: (() => void) | null = null;

    (async () => {
      app = new Application();
      await app.init({
        background: 0x0a0a0e,
        antialias: true,
        resizeTo: host,
      });
      if (cancelled) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);
      appRef.current = app;
      const root = new Container();
      rootRef.current = root;
      app.stage.addChild(root);

      // Center camera on scene bounds.
      const bbox = sceneBoundingBox(sceneRef.current);
      camRef.current.x = bbox.cx;
      camRef.current.y = bbox.cy;
      const rect = host.getBoundingClientRect();
      const fitZoom = Math.min(
        rect.width / Math.max(64, bbox.w * 1.3),
        rect.height / Math.max(64, bbox.h * 1.3),
      );
      camRef.current.zoom = Math.max(0.1, Math.min(4, fitZoom));

      const screenToWorld = (sx: number, sy: number): Vec2 => {
        const r = host.getBoundingClientRect();
        return {
          x: (sx - r.width / 2) / camRef.current.zoom + camRef.current.x,
          y: (sy - r.height / 2) / camRef.current.zoom + camRef.current.y,
        };
      };
      const snapPoint = (p: Vec2): Vec2 => {
        if (snapRef.current === 'free') return p;
        const step = snapRef.current === 'grid32' ? 32 : 16;
        return {
          x: Math.round(p.x / step) * step,
          y: Math.round(p.y / step) * step,
        };
      };

      const pickVertexAt = (sx: number, sy: number) => {
        const r = host.getBoundingClientRect();
        const px = sx;
        const py = sy;
        const cs = sceneRef.current;
        const tol = VERTEX_HIT_RADIUS_PX;
        let best: { shapeId: number; index: number; d: number } | null = null;
        for (const shape of cs.shapes) {
          for (let i = 0; i < shape.outer.length; i++) {
            const v = shape.outer[i];
            const wx = (v.x - camRef.current.x) * camRef.current.zoom + r.width / 2;
            const wy = (v.y - camRef.current.y) * camRef.current.zoom + r.height / 2;
            const dx = wx - px;
            const dy = wy - py;
            const d = Math.hypot(dx, dy);
            if (d <= tol && (!best || d < best.d)) {
              best = { shapeId: shape.id, index: i, d };
            }
          }
        }
        return best;
      };

      const pickPoiAt = (
        sx: number,
        sy: number,
        kind: 'light' | 'interactable',
      ): string | null => {
        const r = host.getBoundingClientRect();
        const cs = sceneRef.current;
        const list: Array<{ id: string; x: number; y: number }> =
          kind === 'light' ? cs.lights : cs.interactables;
        let best: { id: string; d: number } | null = null;
        for (const p of list) {
          const wx = (p.x - camRef.current.x) * camRef.current.zoom + r.width / 2;
          const wy = (p.y - camRef.current.y) * camRef.current.zoom + r.height / 2;
          const d = Math.hypot(wx - sx, wy - sy);
          if (d <= POI_HIT_RADIUS_PX && (!best || d < best.d)) {
            best = { id: p.id, d };
          }
        }
        return best?.id ?? null;
      };

      const pickShapeAt = (world: Vec2): number | null => {
        const cs = sceneRef.current;
        // Pick TOPMOST (highest zOrder) shape containing the point.
        let best: { id: number; z: number } | null = null;
        for (const shape of cs.shapes) {
          if (!pointInPoly(shape.outer, world.x, world.y)) continue;
          if (!best || shape.zOrder > best.z) {
            best = { id: shape.id, z: shape.zOrder };
          }
        }
        return best?.id ?? null;
      };

      let panning = false;
      let panLastX = 0;
      let panLastY = 0;

      const onPointerDown = (e: PointerEvent) => {
        if (e.button === 1 || (e.button === 0 && e.metaKey)) {
          panning = true;
          panLastX = e.clientX;
          panLastY = e.clientY;
          return;
        }
        if (e.button !== 0) return;
        const r = host.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const world = screenToWorld(sx, sy);
        const t = toolRef.current;

        if (t === 'adjust') {
          // Priority: spawn → light/interactable POI → vertex → shape.
          const cur = sceneRef.current;
          const wx = (cur.spawn.x - camRef.current.x) * camRef.current.zoom + r.width / 2;
          const wy = (cur.spawn.y - camRef.current.y) * camRef.current.zoom + r.height / 2;
          if (Math.hypot(wx - sx, wy - sy) <= SPAWN_HIT_RADIUS_PX) {
            draggingSpawnRef.current = true;
            return;
          }
          const lightHit = pickPoiAt(sx, sy, 'light');
          if (lightHit) {
            draggingPoiRef.current = { kind: 'light', id: lightHit };
            onSelectionRef.current({ kind: 'light', id: lightHit });
            return;
          }
          const itHit = pickPoiAt(sx, sy, 'interactable');
          if (itHit) {
            draggingPoiRef.current = { kind: 'interactable', id: itHit };
            onSelectionRef.current({ kind: 'interactable', id: itHit });
            return;
          }
          const hit = pickVertexAt(sx, sy);
          if (hit) {
            dragVertRef.current = { shapeId: hit.shapeId, index: hit.index };
            onSelectionRef.current({
              kind: 'vertex',
              shapeId: hit.shapeId,
              index: hit.index,
            });
            return;
          }
          const shapeId = pickShapeAt(world);
          onSelectionRef.current(
            shapeId !== null ? { kind: 'shape', id: shapeId } : null,
          );
          return;
        }

        if (t === 'spawn') {
          const p = snapPoint(world);
          const cur = sceneRef.current;
          onChangeRef.current({ ...cur, spawn: { x: p.x, y: p.y } });
          onLogRef.current?.(
            `spawn: placed at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`,
          );
          return;
        }

        if (t === 'delete') {
          // Priority: light → interactable → vertex → shape.
          const lightHit = pickPoiAt(sx, sy, 'light');
          if (lightHit) {
            const cur = sceneRef.current;
            onChangeRef.current({
              ...cur,
              lights: cur.lights.filter((l) => l.id !== lightHit),
            });
            onSelectionRef.current(null);
            onLogRef.current?.(`delete: light ${lightHit}`);
            return;
          }
          const itHit = pickPoiAt(sx, sy, 'interactable');
          if (itHit) {
            const cur = sceneRef.current;
            onChangeRef.current({
              ...cur,
              interactables: cur.interactables.filter((i) => i.id !== itHit),
            });
            onSelectionRef.current(null);
            onLogRef.current?.(`delete: interactable ${itHit}`);
            return;
          }
          const hit = pickVertexAt(sx, sy);
          if (hit) {
            onLogRef.current?.(`delete: vertex ${hit.index} of shape ${hit.shapeId}`);
            // Reject deletion if the shape would drop below 3 verts.
            const cur = sceneRef.current;
            const shape = cur.shapes.find((s) => s.id === hit.shapeId);
            if (!shape || shape.outer.length <= 3) return;
            const nextShapes = cur.shapes.map((s) =>
              s.id === hit.shapeId
                ? { ...s, outer: s.outer.filter((_, i) => i !== hit.index) }
                : s,
            );
            onChangeRef.current({ ...cur, shapes: nextShapes });
            onSelectionRef.current(null);
            return;
          }
          const shapeId = pickShapeAt(world);
          if (shapeId !== null) {
            onLogRef.current?.(`delete: shape ${shapeId}`);
            const cur = sceneRef.current;
            onChangeRef.current({
              ...cur,
              shapes: cur.shapes.filter((s) => s.id !== shapeId),
            });
            onSelectionRef.current(null);
          }
          return;
        }

        if (t.startsWith('rect-') || t === 'subtract' || t === 'circle') {
          rectDragRef.current = snapPoint(world);
          rectPreviewRef.current = rectDragRef.current;
          onLogRef.current?.(
            `${t}: drag start at (${rectDragRef.current.x.toFixed(0)}, ${rectDragRef.current.y.toFixed(0)})`,
          );
          return;
        }

        if (t === 'light') {
          const p = snapPoint(world);
          const cur = sceneRef.current;
          const newId = `light_${Math.random().toString(36).slice(2, 8)}`;
          const newLight: import('@dumrunner/shared').SectorLight = {
            id: newId,
            x: p.x,
            y: p.y,
            z: 20,
            radius: 200,
            colour: 0xffe8b0,
            intensity: 1,
          };
          onChangeRef.current({
            ...cur,
            lights: [...cur.lights, newLight],
          });
          onSelectionRef.current({ kind: 'light', id: newId });
          onLogRef.current?.(
            `light: placed ${newId} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`,
          );
          return;
        }

        if (t === 'interactable') {
          const p = snapPoint(world);
          const cur = sceneRef.current;
          const newId = `hotspot_${Math.random().toString(36).slice(2, 8)}`;
          const newIt: import('@dumrunner/shared').Interactable = {
            id: newId,
            kind: 'extract_pad',
            x: p.x,
            y: p.y,
            label: 'extract',
          };
          onChangeRef.current({
            ...cur,
            interactables: [...cur.interactables, newIt],
          });
          onSelectionRef.current({ kind: 'interactable', id: newId });
          onLogRef.current?.(
            `interactable: placed ${newId} (extract_pad) at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`,
          );
          return;
        }

        if (t === 'insert') {
          // Click on or near a shape edge → insert a new vertex
          // at the closest point on that edge.
          const hit = findClosestEdge(sceneRef.current, world);
          if (!hit) return;
          const cur = sceneRef.current;
          const shape = cur.shapes.find((s) => s.id === hit.shapeId);
          if (!shape) return;
          const inserted = snapPoint(hit.projection);
          const nextOuter = [
            ...shape.outer.slice(0, hit.edgeIndex + 1),
            inserted,
            ...shape.outer.slice(hit.edgeIndex + 1),
          ];
          onChangeRef.current({
            ...cur,
            shapes: cur.shapes.map((s) =>
              s.id === hit.shapeId ? { ...s, outer: nextOuter } : s,
            ),
          });
          onSelectionRef.current({
            kind: 'vertex',
            shapeId: hit.shapeId,
            index: hit.edgeIndex + 1,
          });
          onLogRef.current?.(
            `insert: vertex into shape ${hit.shapeId} at edge ${hit.edgeIndex} → (${inserted.x.toFixed(0)}, ${inserted.y.toFixed(0)})`,
          );
          return;
        }

        if (t === 'polygon') {
          const p = snapPoint(world);
          const chain = polygonChainRef.current;
          if (chain.length >= 3) {
            // Click near start vert closes the polygon.
            const start = chain[0];
            const dx = p.x - start.x;
            const dy = p.y - start.y;
            const dist = Math.hypot(dx, dy);
            const close = dist <= Math.max(8, 16 / camRef.current.zoom);
            if (close) {
              commitPolygon(chain);
              polygonChainRef.current = [];
              polygonCursorRef.current = null;
              redraw();
              return;
            }
          }
          polygonChainRef.current = [...chain, p];
          polygonCursorRef.current = p;
          onLogRef.current?.(`polygon: chain vert ${chain.length} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
          redraw();
          return;
        }
      };

      const onPointerMove = (e: PointerEvent) => {
        if (panning) {
          const dx = e.clientX - panLastX;
          const dy = e.clientY - panLastY;
          panLastX = e.clientX;
          panLastY = e.clientY;
          camRef.current.x -= dx / camRef.current.zoom;
          camRef.current.y -= dy / camRef.current.zoom;
          redraw();
          return;
        }
        const r = host.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const world = screenToWorld(sx, sy);
        const t = toolRef.current;

        if (rectDragRef.current) {
          rectPreviewRef.current = snapPoint(world);
          redraw();
          return;
        }
        if (dragVertRef.current) {
          const target = dragVertRef.current;
          const cur = sceneRef.current;
          const p = snapPoint(world);
          const nextShapes = cur.shapes.map((s) =>
            s.id === target.shapeId
              ? {
                  ...s,
                  outer: s.outer.map((v, i) =>
                    i === target.index ? { x: p.x, y: p.y } : v,
                  ),
                }
              : s,
          );
          // Preview-only update; commit on pointer-up so undo
          // collapses the drag into one entry.
          onPreviewRef.current?.({ ...cur, shapes: nextShapes });
          redraw();
          return;
        }
        if (draggingSpawnRef.current) {
          const cur = sceneRef.current;
          const p = snapPoint(world);
          onPreviewRef.current?.({ ...cur, spawn: { x: p.x, y: p.y } });
          redraw();
          return;
        }
        if (draggingPoiRef.current) {
          const target = draggingPoiRef.current;
          const cur = sceneRef.current;
          const p = snapPoint(world);
          if (target.kind === 'light') {
            onPreviewRef.current?.({
              ...cur,
              lights: cur.lights.map((l) =>
                l.id === target.id ? { ...l, x: p.x, y: p.y } : l,
              ),
            });
          } else {
            onPreviewRef.current?.({
              ...cur,
              interactables: cur.interactables.map((i) =>
                i.id === target.id ? { ...i, x: p.x, y: p.y } : i,
              ),
            });
          }
          redraw();
          return;
        }
        if (t === 'polygon' && polygonChainRef.current.length > 0) {
          polygonCursorRef.current = snapPoint(world);
          redraw();
          return;
        }
        if (t === 'adjust') {
          hoverVertRef.current = pickVertexAt(sx, sy);
          redraw();
        }
      };

      const onPointerUp = (_e: PointerEvent) => {
        if (panning) {
          panning = false;
          return;
        }
        if (rectDragRef.current && rectPreviewRef.current) {
          const a = rectDragRef.current;
          const b = rectPreviewRef.current;
          const tool = toolRef.current;
          rectDragRef.current = null;
          rectPreviewRef.current = null;
          if (
            tool.startsWith('rect-') &&
            Math.abs(b.x - a.x) >= 16 &&
            Math.abs(b.y - a.y) >= 16
          ) {
            commitRect(tool as keyof typeof RECT_TOOL_DEFAULTS, a, b);
          } else if (
            tool === 'subtract' &&
            Math.abs(b.x - a.x) >= 16 &&
            Math.abs(b.y - a.y) >= 16
          ) {
            commitSubtractRect(a, b);
          } else if (tool === 'circle') {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const r2 = Math.hypot(dx, dy);
            if (r2 >= 8) commitCircle(a, r2);
          }
          redraw();
          return;
        }
        if (dragVertRef.current) {
          const target = dragVertRef.current;
          dragVertRef.current = null;
          // Commit the in-progress preview state.
          const cur = sceneRef.current;
          onChangeRef.current(cur);
          onLogRef.current?.(`adjust: moved vertex ${target.index} of shape ${target.shapeId}`);
          redraw();
          return;
        }
        if (draggingSpawnRef.current) {
          draggingSpawnRef.current = false;
          const cur = sceneRef.current;
          onChangeRef.current(cur);
          onLogRef.current?.(
            `spawn: moved to (${cur.spawn.x.toFixed(0)}, ${cur.spawn.y.toFixed(0)})`,
          );
          redraw();
          return;
        }
        if (draggingPoiRef.current) {
          const target = draggingPoiRef.current;
          draggingPoiRef.current = null;
          onChangeRef.current(sceneRef.current);
          onLogRef.current?.(`adjust: moved ${target.kind} ${target.id}`);
          redraw();
        }
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const r = host.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const worldBefore = screenToWorld(sx, sy);
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        camRef.current.zoom = Math.max(
          0.05,
          Math.min(8, camRef.current.zoom * factor),
        );
        const worldAfter = screenToWorld(sx, sy);
        camRef.current.x += worldBefore.x - worldAfter.x;
        camRef.current.y += worldBefore.y - worldAfter.y;
        redraw();
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          rectDragRef.current = null;
          rectPreviewRef.current = null;
          polygonChainRef.current = [];
          polygonCursorRef.current = null;
          redraw();
        }
      };

      host.addEventListener('pointerdown', onPointerDown);
      host.addEventListener('pointermove', onPointerMove);
      host.addEventListener('pointerup', onPointerUp);
      host.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKey);

      cleanup = () => {
        host.removeEventListener('pointerdown', onPointerDown);
        host.removeEventListener('pointermove', onPointerMove);
        host.removeEventListener('pointerup', onPointerUp);
        host.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKey);
        if (app) {
          host.removeChild(app.canvas);
          app.destroy(true);
        }
      };

      function commitRect(
        kind: keyof typeof RECT_TOOL_DEFAULTS,
        a: Vec2,
        b: Vec2,
      ) {
        const x0 = Math.min(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const x1 = Math.max(a.x, b.x);
        const y1 = Math.max(a.y, b.y);
        const defaults = RECT_TOOL_DEFAULTS[kind];
        const cur = sceneRef.current;
        const maxZ = cur.shapes.reduce(
          (m, s) => Math.max(m, s.zOrder),
          -1,
        );
        const nextId = cur.shapes.reduce(
          (m, s) => Math.max(m, s.id),
          -1,
        ) + 1;
        const newShape: CsgShape = {
          id: nextId,
          name: defaults.label,
          outer: [
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 },
          ],
          floorZ: defaults.floorZ,
          ceilingZ: defaults.ceilingZ,
          biomeId: cur.biome,
          ambient: 1,
          zOrder: maxZ + 1,
        };
        onChangeRef.current({ ...cur, shapes: [...cur.shapes, newShape] });
        onSelectionRef.current({ kind: 'shape', id: nextId });
        onLogRef.current?.(
          `${defaults.label}: commit shape ${nextId} (floorZ=${defaults.floorZ}, ceilingZ=${defaults.ceilingZ}) (${x0.toFixed(0)},${y0.toFixed(0)})→(${x1.toFixed(0)},${y1.toFixed(0)})`,
        );
      }

      function commitPolygon(chain: Vec2[]) {
        if (chain.length < 3) return;
        const cur = sceneRef.current;
        // Ensure CCW winding (polygon-clipping is forgiving but
        // adjacent-edge orientation matters at save time).
        let signed = 0;
        for (let i = 0; i < chain.length; i++) {
          const a = chain[i];
          const b = chain[(i + 1) % chain.length];
          signed += a.x * b.y - b.x * a.y;
        }
        const ccw = signed >= 0 ? chain : [...chain].reverse();
        const maxZ = cur.shapes.reduce(
          (m, s) => Math.max(m, s.zOrder),
          -1,
        );
        const nextId = cur.shapes.reduce(
          (m, s) => Math.max(m, s.id),
          -1,
        ) + 1;
        const newShape: CsgShape = {
          id: nextId,
          name: 'polygon',
          outer: ccw.map((v) => ({ x: v.x, y: v.y })),
          floorZ: 0,
          ceilingZ: 32,
          biomeId: cur.biome,
          ambient: 1,
          zOrder: maxZ + 1,
        };
        onChangeRef.current({ ...cur, shapes: [...cur.shapes, newShape] });
        onSelectionRef.current({ kind: 'shape', id: nextId });
        onLogRef.current?.(
          `polygon: commit shape ${nextId} (${chain.length} verts)`,
        );
      }

      function commitSubtractRect(a: Vec2, b: Vec2) {
        const x0 = Math.min(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const x1 = Math.max(a.x, b.x);
        const y1 = Math.max(a.y, b.y);
        const cur = sceneRef.current;
        const maxZ = cur.shapes.reduce((m, s) => Math.max(m, s.zOrder), -1);
        const nextId = cur.shapes.reduce((m, s) => Math.max(m, s.id), -1) + 1;
        const newShape: CsgShape = {
          id: nextId,
          name: 'subtract',
          outer: [
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 },
          ],
          floorZ: 0,
          ceilingZ: 32,
          biomeId: cur.biome,
          ambient: 1,
          zOrder: maxZ + 1,
          subtractive: true,
        };
        onChangeRef.current({ ...cur, shapes: [...cur.shapes, newShape] });
        onSelectionRef.current({ kind: 'shape', id: nextId });
        onLogRef.current?.(
          `subtract: commit shape ${nextId} (${x0.toFixed(0)},${y0.toFixed(0)})→(${x1.toFixed(0)},${y1.toFixed(0)})`,
        );
      }

      function commitCircle(center: Vec2, radius: number) {
        const verts: Vec2[] = [];
        for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
          const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
          verts.push({
            x: Math.round(center.x + Math.cos(a) * radius),
            y: Math.round(center.y + Math.sin(a) * radius),
          });
        }
        const cur = sceneRef.current;
        const maxZ = cur.shapes.reduce((m, s) => Math.max(m, s.zOrder), -1);
        const nextId = cur.shapes.reduce((m, s) => Math.max(m, s.id), -1) + 1;
        const newShape: CsgShape = {
          id: nextId,
          name: 'circle',
          outer: verts,
          floorZ: 0,
          ceilingZ: 32,
          biomeId: cur.biome,
          ambient: 1,
          zOrder: maxZ + 1,
        };
        onChangeRef.current({ ...cur, shapes: [...cur.shapes, newShape] });
        onSelectionRef.current({ kind: 'shape', id: nextId });
        onLogRef.current?.(
          `circle: commit shape ${nextId} r=${radius.toFixed(0)} at (${center.x.toFixed(0)}, ${center.y.toFixed(0)})`,
        );
      }

      function redraw() {
        if (!host || !root) return;
        const r = host.getBoundingClientRect();
        root.removeChildren();
        const cam = camRef.current;

        // Center origin on canvas.
        root.x = r.width / 2;
        root.y = r.height / 2;
        root.scale.set(cam.zoom);
        root.pivot.set(cam.x, cam.y);

        const sn = sceneRef.current;
        const sel = selectionRef.current;
        const sortedShapes = [...sn.shapes].sort(
          (a, b) => a.zOrder - b.zOrder,
        );
        for (const shape of sortedShapes) {
          const g = new Graphics();
          const ring = shape.outer;
          if (ring.length >= 3) {
            const isSel = sel?.kind === 'shape' && sel.id === shape.id;
            const fillColor = shape.subtractive
              ? SHAPE_SUBTRACT_FILL
              : SHAPE_FILL;
            const outlineColor = isSel
              ? SHAPE_SELECTED_OUTLINE
              : shape.subtractive
                ? SHAPE_SUBTRACT_OUTLINE
                : SHAPE_OUTLINE;
            g.poly(ring.map((v) => ({ x: v.x, y: v.y })))
              .fill({ color: fillColor, alpha: 0.45 })
              .stroke({
                width: (isSel ? 2 : 1) / cam.zoom,
                color: outlineColor,
              });
            root.addChild(g);
          }
          // Vertices.
          for (let i = 0; i < ring.length; i++) {
            const v = ring[i];
            const isHover =
              hoverVertRef.current?.shapeId === shape.id &&
              hoverVertRef.current.index === i;
            const isSelVert =
              sel?.kind === 'vertex' &&
              sel.shapeId === shape.id &&
              sel.index === i;
            const vg = new Graphics();
            vg.circle(v.x, v.y, 4 / cam.zoom).fill({
              color: isHover || isSelVert ? VERT_HOVER : VERT_FILL,
              alpha: 0.95,
            });
            root.addChild(vg);
          }
        }

        // Spawn marker — bigger + crosshair so it reads as the
        // player drop point; draggable in adjust mode, placeable
        // by the spawn tool.
        const sg = new Graphics();
        const sr = 10 / cam.zoom;
        sg.circle(sn.spawn.x, sn.spawn.y, sr).fill({
          color: SPAWN_COLOR,
          alpha: 0.85,
        });
        sg.circle(sn.spawn.x, sn.spawn.y, sr).stroke({
          width: 2 / cam.zoom,
          color: 0xffffff,
          alpha: 0.85,
        });
        sg.moveTo(sn.spawn.x - sr * 1.5, sn.spawn.y)
          .lineTo(sn.spawn.x + sr * 1.5, sn.spawn.y)
          .stroke({ width: 1 / cam.zoom, color: 0xffffff, alpha: 0.65 });
        sg.moveTo(sn.spawn.x, sn.spawn.y - sr * 1.5)
          .lineTo(sn.spawn.x, sn.spawn.y + sr * 1.5)
          .stroke({ width: 1 / cam.zoom, color: 0xffffff, alpha: 0.65 });
        root.addChild(sg);

        // Lights.
        for (const l of sn.lights) {
          const isSel =
            sel?.kind === 'light' && sel.id === l.id;
          const lg = new Graphics();
          lg.circle(l.x, l.y, 6 / cam.zoom).fill({
            color: LIGHT_COLOR,
            alpha: 0.9,
          });
          if (isSel) {
            lg.circle(l.x, l.y, 10 / cam.zoom).stroke({
              width: 2 / cam.zoom,
              color: SHAPE_SELECTED_OUTLINE,
            });
          }
          // Faint radius ring so authors can see the falloff
          // they're configuring.
          lg.circle(l.x, l.y, l.radius).stroke({
            width: 1 / cam.zoom,
            color: LIGHT_COLOR,
            alpha: 0.18,
          });
          root.addChild(lg);
        }
        // Interactables.
        for (const it of sn.interactables) {
          const isSel =
            sel?.kind === 'interactable' && sel.id === it.id;
          const ig = new Graphics();
          ig.rect(it.x - 7 / cam.zoom, it.y - 7 / cam.zoom, 14 / cam.zoom, 14 / cam.zoom)
            .fill({ color: INTERACTABLE_COLOR, alpha: 0.85 });
          if (isSel) {
            ig.rect(it.x - 10 / cam.zoom, it.y - 10 / cam.zoom, 20 / cam.zoom, 20 / cam.zoom)
              .stroke({ width: 2 / cam.zoom, color: SHAPE_SELECTED_OUTLINE });
          }
          root.addChild(ig);
        }

        // AI walkable-grid preview overlay. Pure 2D point-in-shape
        // test — does NOT account for step-up reachability or
        // ceiling clearance (see Sprint G "Enemy pathing on raised
        // sectors" for the proper version).
        if (showAiGridRef.current) {
          const walkable = sortedShapes.filter(
            (s) => !s.subtractive && s.buildingKind === undefined,
          );
          if (walkable.length > 0) {
            let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
            for (const s of walkable) {
              for (const v of s.outer) {
                if (v.x < xMin) xMin = v.x;
                if (v.x > xMax) xMax = v.x;
                if (v.y < yMin) yMin = v.y;
                if (v.y > yMax) yMax = v.y;
              }
            }
            const cell = AI_GRID_CELL;
            const x0 = Math.floor(xMin / cell) * cell;
            const y0 = Math.floor(yMin / cell) * cell;
            const gridG = new Graphics();
            for (let cy = y0; cy <= yMax; cy += cell) {
              for (let cx = x0; cx <= xMax; cx += cell) {
                const wx = cx + cell / 2;
                const wy = cy + cell / 2;
                let inside = false;
                for (const s of walkable) {
                  if (pointInPoly(s.outer, wx, wy)) {
                    inside = true;
                    break;
                  }
                }
                if (!inside) continue;
                gridG.circle(wx, wy, cell * 0.18).fill({
                  color: AI_GRID_FILL,
                  alpha: 0.55,
                });
              }
            }
            root.addChild(gridG);
          }
        }

        // Rect preview (room/platform/pit/vent/window/subtract).
        if (rectDragRef.current && rectPreviewRef.current) {
          const a = rectDragRef.current;
          const b = rectPreviewRef.current;
          const tool = toolRef.current;
          if (tool === 'circle') {
            const cg = new Graphics();
            const rad = Math.hypot(b.x - a.x, b.y - a.y);
            cg.circle(a.x, a.y, rad).stroke({
              width: 2 / cam.zoom,
              color: CIRCLE_PREVIEW,
            });
            root.addChild(cg);
          } else {
            const x0 = Math.min(a.x, b.x);
            const y0 = Math.min(a.y, b.y);
            const w = Math.abs(b.x - a.x);
            const h = Math.abs(b.y - a.y);
            const rg = new Graphics();
            rg.rect(x0, y0, w, h).stroke({
              width: 2 / cam.zoom,
              color:
                tool === 'subtract' ? SHAPE_SUBTRACT_OUTLINE : RECT_PREVIEW,
            });
            root.addChild(rg);
          }
        }
        // Polygon chain preview.
        const chain = polygonChainRef.current;
        if (chain.length > 0) {
          const pg = new Graphics();
          for (let i = 0; i < chain.length - 1; i++) {
            pg.moveTo(chain[i].x, chain[i].y).lineTo(
              chain[i + 1].x,
              chain[i + 1].y,
            );
          }
          if (polygonCursorRef.current) {
            pg.moveTo(
              chain[chain.length - 1].x,
              chain[chain.length - 1].y,
            ).lineTo(
              polygonCursorRef.current.x,
              polygonCursorRef.current.y,
            );
          }
          pg.stroke({ width: 2 / cam.zoom, color: POLYGON_PREVIEW });
          for (const v of chain) {
            pg.circle(v.x, v.y, 4 / cam.zoom).fill(POLYGON_PREVIEW);
          }
          root.addChild(pg);
        }
      }

      redraw();
      redrawRef.current = redraw;
      // Re-render whenever React-driven inputs change.
      const ro = new ResizeObserver(redraw);
      ro.observe(host);
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // We intentionally re-init only once; subsequent updates go
    // through the refs + redraw triggered by the parent on each
    // setScene call (the page wraps onSceneChange in a callback
    // that bumps a "redraw" key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw on every parent re-render — scene / selection / tool
  // changes all funnel through here so the canvas always reflects
  // the latest React state. The redraw fn is set after init
  // completes (async); first paint runs from init itself, so
  // re-renders that arrive before that no-op safely.
  useEffect(() => {
    redrawRef.current?.();
  });

  // Validate that the current scene survives the CSG → linedef
  // pipeline. Cheap on small scenes; surfaces save-time errors
  // immediately rather than at the next save attempt.
  useEffect(() => {
    try {
      csgSceneToLinedefScene(scene);
    } catch (err) {
      console.error('[csg editor] convert failed:', err);
    }
  }, [scene]);

  return (
    <div ref={hostRef} className="absolute inset-0 cursor-crosshair" />
  );
}

function sceneBoundingBox(s: CsgScene): {
  cx: number;
  cy: number;
  w: number;
  h: number;
} {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const shape of s.shapes) {
    for (const v of shape.outer) {
      if (v.x < xMin) xMin = v.x;
      if (v.x > xMax) xMax = v.x;
      if (v.y < yMin) yMin = v.y;
      if (v.y > yMax) yMax = v.y;
    }
  }
  if (!Number.isFinite(xMin)) {
    return { cx: 128, cy: 128, w: 512, h: 512 };
  }
  return {
    cx: (xMin + xMax) / 2,
    cy: (yMin + yMax) / 2,
    w: xMax - xMin,
    h: yMax - yMin,
  };
}

// Closest-edge lookup for the insert-vertex tool. Walks every
// shape's outer ring and returns the (shapeId, edgeIndex,
// projected point) of the edge whose perpendicular distance to
// `world` is smallest, within a 12-wu tolerance.
function findClosestEdge(
  scene: CsgScene,
  world: Vec2,
): {
  shapeId: number;
  edgeIndex: number;
  projection: Vec2;
} | null {
  const TOL_SQ = 12 * 12;
  let best: {
    shapeId: number;
    edgeIndex: number;
    projection: Vec2;
    distSq: number;
  } | null = null;
  for (const shape of scene.shapes) {
    const ring = shape.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      let t = ((world.x - a.x) * dx + (world.y - a.y) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const ddx = world.x - px;
      const ddy = world.y - py;
      const distSq = ddx * ddx + ddy * ddy;
      if (distSq > TOL_SQ) continue;
      if (!best || distSq < best.distSq) {
        best = {
          shapeId: shape.id,
          edgeIndex: i,
          projection: { x: px, y: py },
          distSq,
        };
      }
    }
  }
  if (!best) return null;
  return {
    shapeId: best.shapeId,
    edgeIndex: best.edgeIndex,
    projection: best.projection,
  };
}

function pointInPoly(
  poly: Vec2[],
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}
