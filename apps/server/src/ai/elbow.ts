// Right-angle (elbow) connectors that go around items instead of through them. The canvas draws an AI-made
// elbow arrow exactly as its points say (it only re-routes one when a person moves a box it's attached to),
// so the path has to be clear when the server makes it.
import type { SceneElement } from "@monet/board-protocol";
import { num, rectOf, type Point, type Rect } from "./geometry";

type Side = "left" | "right" | "top" | "bottom";

const SIDES: Side[] = ["right", "left", "bottom", "top"];
const GAP = 8;
const STUB = 24;
const CLEARANCE = 10;
const FIXED: Record<Side, [number, number]> = { left: [0, 0.5], right: [1, 0.5], top: [0.5, 0], bottom: [0.5, 1] };
const DIR: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

/** Boxes a connector must not cross: everything except sections, lines, labels inside shapes, and `exclude`. */
export function obstacleRects(elements: Iterable<SceneElement>, exclude: Set<string>): Rect[] {
  const out: Rect[] = [];
  for (const el of elements) {
    if (el.isDeleted || exclude.has(el.id)) continue;
    if (el.type === "frame" || el.type === "magicframe" || el.type === "arrow" || el.type === "line" || el.type === "freedraw") continue;
    if (el.type === "text" && el.containerId) continue;
    out.push(rectOf(el));
  }
  return out;
}

function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

function sidePoint(r: Rect, side: Side): Point {
  switch (side) {
    case "left":
      return { x: r.x - GAP, y: r.y + r.h / 2 };
    case "right":
      return { x: r.x + r.w + GAP, y: r.y + r.h / 2 };
    case "top":
      return { x: r.x + r.w / 2, y: r.y - GAP };
    default:
      return { x: r.x + r.w / 2, y: r.y + r.h + GAP };
  }
}

/** Does an axis-aligned segment pass through the inside of a box (touching its edge is fine)? */
function crosses(p: Point, q: Point, r: Rect): boolean {
  if (p.y === q.y) {
    if (p.y <= r.y || p.y >= r.y + r.h) return false;
    return Math.max(p.x, q.x) > r.x && Math.min(p.x, q.x) < r.x + r.w;
  }
  if (p.x <= r.x || p.x >= r.x + r.w) return false;
  return Math.max(p.y, q.y) > r.y && Math.min(p.y, q.y) < r.y + r.h;
}

function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const prev = out[out.length - 2];
    if (
      prev &&
      last &&
      ((Math.abs(prev.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(prev.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))
    )
      out.pop();
    out.push(p);
  }
  return out;
}

/** The candidate lanes closest to `to` (dense boards have hundreds; the nearest ones give the short paths). */
function nearest(values: Set<number>, to: number, n = 40): number[] {
  return [...values].sort((a, b) => Math.abs(a - to) - Math.abs(b - to)).slice(0, n);
}

function score(pts: Point[], boxes: Rect[]): { hits: number; cost: number } {
  let hits = 0;
  let len = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    len += Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    for (const b of boxes) if (crosses(p, q, b)) hits++;
  }
  return { hits, cost: hits * 100_000 + len + (pts.length - 2) * 30 };
}

/**
 * Re-shapes a bound arrow as a right-angle connector from a side of `from` to a side of `to`, picking the
 * shortest path with the fewest bends that crosses no other item. Moves its label onto the longest segment.
 * With `onlyIfClear`, leaves the arrow untouched unless a path that crosses nothing exists. Returns whether the
 * arrow now crosses nothing.
 */
export function routeElbow(
  arrow: SceneElement,
  label: SceneElement | undefined,
  from: SceneElement,
  to: SceneElement,
  obstacles: Rect[],
  opts: { onlyIfClear?: boolean } = {},
): boolean {
  const f = rectOf(from);
  const t = rectOf(to);
  const minX = Math.min(f.x, t.x) - 450;
  const maxX = Math.max(f.x + f.w, t.x + t.w) + 450;
  const minY = Math.min(f.y, t.y) - 450;
  const maxY = Math.max(f.y + f.h, t.y + t.h) + 450;
  const near = obstacles.filter((o) => o.x < maxX && o.x + o.w > minX && o.y < maxY && o.y + o.h > minY).map((o) => grow(o, CLEARANCE));
  // The ends' own boxes count too, so a path can't double back through them.
  const boxes = [...near, grow(f, GAP - 2), grow(t, GAP - 2)];
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const b of boxes) {
    xs.add(b.x - 12);
    xs.add(b.x + b.w + 12);
    ys.add(b.y - 12);
    ys.add(b.y + b.h + 12);
  }

  let best: { pts: Point[]; side: [Side, Side]; cost: number; hits: number } | null = null;
  for (const sf of SIDES) {
    for (const st of SIDES) {
      const a = sidePoint(f, sf);
      const b = sidePoint(t, st);
      const a1 = { x: a.x + DIR[sf].x * STUB, y: a.y + DIR[sf].y * STUB };
      const b1 = { x: b.x + DIR[st].x * STUB, y: b.y + DIR[st].y * STUB };
      const middles: Point[][] = [[{ x: b1.x, y: a1.y }], [{ x: a1.x, y: b1.y }]];
      const cx = (a1.x + b1.x) / 2;
      const cy = (a1.y + b1.y) / 2;
      for (const mx of [cx, ...nearest(xs, cx)])
        middles.push([
          { x: mx, y: a1.y },
          { x: mx, y: b1.y },
        ]);
      for (const my of [cy, ...nearest(ys, cy)])
        middles.push([
          { x: a1.x, y: my },
          { x: b1.x, y: my },
        ]);
      for (const mid of middles) {
        const pts = simplify([a, a1, ...mid, b1, b]);
        const s = score(pts, boxes);
        if (!best || s.cost < best.cost) best = { pts, side: [sf, st], cost: s.cost, hits: s.hits };
      }
    }
  }
  if (!best) return false;
  if (opts.onlyIfClear && best.hits > 0) return false;

  const [a] = best.pts;
  arrow.x = a!.x;
  arrow.y = a!.y;
  arrow.points = best.pts.map((p) => [Math.round((p.x - a!.x) * 100) / 100, Math.round((p.y - a!.y) * 100) / 100]);
  const px = (arrow.points as [number, number][]).map((p) => p[0]);
  const py = (arrow.points as [number, number][]).map((p) => p[1]);
  arrow.width = Math.max(...px) - Math.min(...px);
  arrow.height = Math.max(...py) - Math.min(...py);
  arrow.elbowed = true;
  arrow.roundness = null;
  arrow.fixedSegments = null;
  arrow.startIsSpecial = null;
  arrow.endIsSpecial = null;
  arrow.startBinding = { elementId: from.id, focus: 0, gap: GAP, fixedPoint: FIXED[best.side[0]] };
  arrow.endBinding = { elementId: to.id, focus: 0, gap: GAP, fixedPoint: FIXED[best.side[1]] };

  if (label) {
    let seg = 1;
    let longest = -1;
    for (let i = 0; i + 1 < best.pts.length; i++) {
      const l = Math.abs(best.pts[i + 1]!.x - best.pts[i]!.x) + Math.abs(best.pts[i + 1]!.y - best.pts[i]!.y);
      if (l > longest) {
        longest = l;
        seg = i;
      }
    }
    const p = best.pts[seg]!;
    const q = best.pts[seg + 1]!;
    label.x = (p.x + q.x) / 2 - num(label.width) / 2;
    label.y = (p.y + q.y) / 2 - num(label.height) / 2;
  }
  return best.hits === 0;
}
