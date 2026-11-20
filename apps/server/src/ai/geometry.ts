// Geometry helpers for the board AI's layout engine: element bounds, overlap tests, and free-space search.
import type { SceneElement } from "@monet/board-protocol";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Space Excalidraw draws a frame's name in, above the frame's top edge. */
export const FRAME_LABEL_SPACE = 32;

/** Axis-aligned bounds of one element (linear elements use their points). */
export function rectOf(el: SceneElement): Rect {
  const x = num(el.x);
  const y = num(el.y);
  if (Array.isArray(el.points) && (el.type === "arrow" || el.type === "line" || el.type === "freedraw")) {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const p of el.points as [number, number][]) {
      if (!Array.isArray(p)) continue;
      minX = Math.min(minX, num(p[0]));
      minY = Math.min(minY, num(p[1]));
      maxX = Math.max(maxX, num(p[0]));
      maxY = Math.max(maxY, num(p[1]));
    }
    return { x: x + minX, y: y + minY, w: maxX - minX, h: maxY - minY };
  }
  return { x, y, w: Math.max(0, num(el.width)), h: Math.max(0, num(el.height)) };
}

/** Bounds used for collision: frames also reserve the space their name is drawn in. */
export function occupiedRectOf(el: SceneElement): Rect {
  const r = rectOf(el);
  if (el.type === "frame" || el.type === "magicframe") {
    return { x: r.x, y: r.y - FRAME_LABEL_SPACE, w: r.w, h: r.h + FRAME_LABEL_SPACE };
  }
  return r;
}

export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function union(rects: Rect[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function centerOf(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function unionOfElements(elements: SceneElement[]): Rect | null {
  return union(elements.filter((e) => !e.isDeleted).map(rectOf));
}

/** Moves elements in place. Linear elements keep their relative points, so moving x/y is enough. */
export function translate(elements: SceneElement[], dx: number, dy: number) {
  if (!dx && !dy) return;
  for (const el of elements) {
    el.x = num(el.x) + dx;
    el.y = num(el.y) + dy;
  }
}

/**
 * Finds a top-left position for a box of `size` that doesn't overlap `occupied` (with `margin`), searching
 * outward from `anchor` in rings and preferring spots to the right of and below the anchor.
 */
export function findFreeSpot(size: { w: number; h: number }, occupied: Rect[], anchor: Point, margin = 60): Point {
  const fits = (x: number, y: number) => {
    const r = { x, y, w: size.w, h: size.h };
    for (const o of occupied) if (intersects(r, o, margin)) return false;
    return true;
  };
  const ax = Math.round(anchor.x);
  const ay = Math.round(anchor.y);
  if (fits(ax, ay)) return { x: ax, y: ay };
  const step = Math.max(40, Math.round(Math.min(size.w, size.h) / 5));
  const maxRing = Math.min(120, Math.ceil(5000 / step));
  // Score every candidate globally (not ring by ring) so a near spot above the board never beats a slightly
  // farther spot below or to the right of it.
  const cands: { x: number; y: number; s: number }[] = [];
  for (let i = -maxRing; i <= maxRing; i++) {
    for (let j = -maxRing; j <= maxRing; j++) {
      if (!i && !j) continue;
      const s = Math.hypot(i, j) * (1 + (i < 0 ? 1.5 : 0) + (j < 0 ? 3 : 0));
      cands.push({ x: ax + i * step, y: ay + j * step, s });
    }
  }
  cands.sort((a, b) => a.s - b.s);
  for (const c of cands) if (fits(c.x, c.y)) return { x: c.x, y: c.y };
  const all = union(occupied);
  return all ? { x: all.x + all.w + margin * 2, y: ay } : { x: ax, y: ay };
}
