'use client';

// Canvas-based top-down render of a SceneLayout. Fits the layout's
// worldBounds into the available canvas with a margin, then draws:
//   - region rects filled by hazard category
//   - roomGraph edges as faint connector lines between centres
//   - anchors as coloured dots (kind = colour)
// Pure presentational — pass in a layout and a size; the caller
// supplies the WS layer that produces layouts.

import { useEffect, useRef } from 'react';
import type { SceneAnchor, SceneLayout } from '@dumrunner/shared';

const CATEGORY_COLOR: Record<string, string> = {
  safe: '#22c55e',
  hazard: '#737373',
  extreme: '#a855f7',
  corridor: '#404040',
};

const ANCHOR_COLOR: Record<SceneAnchor['kind'], string> = {
  spawn: '#fde047',
  extract: '#22d3ee',
  stairs_down: '#f97316',
  enemy: '#ef4444',
  prop: '#a3a3a3',
  loot: '#fbbf24',
  door: '#60a5fa',
  entry: '#34d399',
};

export function TopdownMap({ layout }: { layout: SceneLayout | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    const cssWidth = parent?.clientWidth ?? 600;
    const cssHeight = parent?.clientHeight ?? 400;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    if (!layout) {
      ctx.fillStyle = '#52525b';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('(no layout)', cssWidth / 2, cssHeight / 2);
      return;
    }

    const wb = layout.worldBounds;
    if (!wb || wb.w <= 0 || wb.h <= 0) return;
    const margin = 16;
    const sx = (cssWidth - margin * 2) / wb.w;
    const sy = (cssHeight - margin * 2) / wb.h;
    const s = Math.min(sx, sy);
    const offX = margin + (cssWidth - margin * 2 - wb.w * s) / 2 - wb.x * s;
    const offY = margin + (cssHeight - margin * 2 - wb.h * s) / 2 - wb.y * s;

    // Bounds outline.
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    ctx.strokeRect(wb.x * s + offX, wb.y * s + offY, wb.w * s, wb.h * s);

    // Fill each sector's actual polygon — NOT its bounding rect.
    // Chamfered rooms emit octagonal polygons whose bbox spills
    // outside the true footprint; L-corridors carry a bbox that
    // includes the void inside the L. Filling by bbox produced
    // coloured zones that ran past the wall outline (the "rooms
    // extending past walls" the user flagged). Walking
    // sectorMap.sectors directly keeps fill and walls aligned.
    const sectorMap = layout.authoredSectorMap;
    const categories = layout.roomCategories ?? [];
    if (sectorMap) {
      sectorMap.sectors.forEach((sector) => {
        // Building cubes (pillars) draw with their own colour
        // pass below — skip here so they don't tint as room fill.
        if (sector.buildingKind !== undefined) return;
        // Sub-sectors (platforms, pits) — sector.id maps to region
        // index only for the leading run; everything after the
        // last region is a sub-sector emitted by assemble. Drop
        // them out of the category fill (they'd flash a category
        // colour on a platform footprint that isn't a region).
        const cat = categories[sector.id] ?? null;
        if (sector.verts.length === 0) return;
        ctx.beginPath();
        ctx.moveTo(sector.verts[0].x * s + offX, sector.verts[0].y * s + offY);
        for (let i = 1; i < sector.verts.length; i++) {
          ctx.lineTo(sector.verts[i].x * s + offX, sector.verts[i].y * s + offY);
        }
        ctx.closePath();
        ctx.fillStyle = cat
          ? CATEGORY_COLOR[cat] ?? CATEGORY_COLOR.hazard
          : CATEGORY_COLOR.hazard;
        ctx.globalAlpha = 0.35;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    } else {
      // Surface scenes have no authoredSectorMap; fall back to
      // the per-region rect fill so we still see something.
      const rooms = layout.rooms ?? [];
      rooms.forEach((r, i) => {
        const cat = categories[i] ?? 'hazard';
        ctx.fillStyle = CATEGORY_COLOR[cat] ?? CATEGORY_COLOR.hazard;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(r.x * s + offX, r.y * s + offY, r.w * s, r.h * s);
        ctx.globalAlpha = 1;
      });
    }

    // Actual SectorMap walls. Solid walls draw as visible white
    // segments; doorways are gaps where the wall is solid:false
    // (we just skip those). Without this pass the preview is just
    // coloured polygons touching each other, which reads as one
    // open hall rather than a connected set of rooms.
    if (sectorMap) {
      ctx.strokeStyle = '#e4e4e7';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      for (const wall of sectorMap.walls) {
        // Skip portals (doorways) and building cubes — only paint
        // walls that actually obstruct.
        if (wall.buildingKind !== undefined) continue;
        if (
          !wall.solid &&
          wall.floorZOverride === undefined &&
          wall.ceilingZOverride === undefined
        ) {
          continue;
        }
        const sector = sectorMap.sectors[wall.sectorId];
        if (!sector) continue;
        const a =
          wall.ax !== undefined && wall.ay !== undefined
            ? { x: wall.ax, y: wall.ay }
            : sector.verts[wall.vertIdx];
        const b =
          wall.bx !== undefined && wall.by !== undefined
            ? { x: wall.bx, y: wall.by }
            : sector.verts[(wall.vertIdx + 1) % sector.verts.length];
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x * s + offX, a.y * s + offY);
        ctx.lineTo(b.x * s + offX, b.y * s + offY);
        ctx.stroke();
      }
    }

    // Anchors.
    const anchors = layout.anchors ?? [];
    for (const a of anchors) {
      ctx.fillStyle = ANCHOR_COLOR[a.kind] ?? '#e4e4e7';
      ctx.beginPath();
      ctx.arc(a.x * s + offX, a.y * s + offY, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stats overlay.
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    const graph = layout.roomGraph ?? [];
    const edgeCount = graph.reduce((n, row) => n + row.length, 0) / 2;
    const lines = [
      `${(layout.rooms ?? []).length} regions · ${edgeCount} edges`,
      `${anchors.length} anchors`,
      `bounds ${Math.round(wb.w)}×${Math.round(wb.h)} px`,
    ];
    lines.forEach((line, i) => {
      ctx.fillText(line, 8, 14 + i * 12);
    });
  }, [layout]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
    />
  );
}
