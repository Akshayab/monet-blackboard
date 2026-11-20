// Block shapes Excalidraw doesn't have natively, drawn as closed line polygons inside a w x h box. The editor pairs
// each outline with a transparent rectangle that holds the label and takes arrow bindings (see builders.ts).
type P = [number, number];

export const POLY_SHAPES = ["pill", "hexagon", "parallelogram", "database", "queue", "document", "cloud", "person"] as const;
export type PolyShape = (typeof POLY_SHAPES)[number];

export function isPolyShape(s: unknown): s is PolyShape {
  return typeof s === "string" && (POLY_SHAPES as readonly string[]).includes(s);
}

export interface Outline {
  /** Closed, filled polygons (first point repeated at the end). */
  fills: P[][];
  /** Open detail strokes drawn on top (a cylinder's lid edge). */
  details: P[][];
  /** Where the label sits: in the middle, or under the icon (person). */
  label: "middle" | "bottom";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Points along an elliptical arc from angle a0 to a1 (degrees; y grows downward, 90 = bottom). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, steps = 12): P[] {
  const out: P[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push([r2(cx + rx * Math.cos(a)), r2(cy + ry * Math.sin(a))]);
  }
  return out;
}

function close(points: P[]): P[] {
  const [first] = points;
  const last = points[points.length - 1]!;
  return first && (first[0] !== last[0] || first[1] !== last[1]) ? [...points, [first[0], first[1]]] : points;
}

export function outlineFor(shape: PolyShape, w: number, h: number): Outline {
  switch (shape) {
    case "pill": {
      const r = Math.min(h, w) / 2;
      return { fills: [close([...arc(w - r, h / 2, r, h / 2, -90, 90), ...arc(r, h / 2, r, h / 2, 90, 270)])], details: [], label: "middle" };
    }
    case "hexagon": {
      const i = Math.min(h / 2, w * 0.18);
      return {
        fills: [
          close([
            [i, 0],
            [w - i, 0],
            [w, h / 2],
            [w - i, h],
            [i, h],
            [0, h / 2],
          ]),
        ],
        details: [],
        label: "middle",
      };
    }
    case "parallelogram": {
      const skew = Math.min(30, Math.round(w * 0.14));
      return {
        fills: [
          close([
            [skew, 0],
            [w, 0],
            [w - skew, h],
            [0, h],
          ]),
        ],
        details: [],
        label: "middle",
      };
    }
    case "database": {
      // Vertical cylinder: the body with rounded top and bottom, plus the lid's front edge.
      const ry = Math.min(18, h * 0.14);
      const body: P[] = [[0, ry], [0, h - ry], ...arc(w / 2, h - ry, w / 2, ry, 180, 0), [w, ry], ...arc(w / 2, ry, w / 2, ry, 0, -180)];
      return { fills: [close(body)], details: [arc(w / 2, ry, w / 2, ry, 180, 0)], label: "middle" };
    }
    case "queue": {
      // Horizontal cylinder: the body with rounded ends, plus the right end's front edge.
      const rx = Math.min(18, w * 0.12);
      const body: P[] = [[rx, 0], [w - rx, 0], ...arc(w - rx, h / 2, rx, h / 2, -90, 90), [rx, h], ...arc(rx, h / 2, rx, h / 2, 90, 270)];
      return { fills: [close(body)], details: [arc(w - rx, h / 2, rx, h / 2, 90, 270)], label: "middle" };
    }
    case "document": {
      // A page whose bottom edge is a wave.
      const wave = Math.min(10, h * 0.1);
      const pts: P[] = [
        [0, 0],
        [w, 0],
        [w, h - wave],
      ];
      const steps = 16;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        pts.push([r2(w * (1 - t)), r2(h - wave + wave * Math.sin(2 * Math.PI * t))]);
      }
      return { fills: [close(pts)], details: [], label: "middle" };
    }
    case "cloud": {
      // An ellipse with bumps (|sin| makes rounded lobes with small notches between them).
      const cx = w / 2;
      const cy = h / 2;
      const lobes = 7;
      const pts: P[] = [];
      for (let i = 0; i < 112; i++) {
        const a = (i / 112) * Math.PI * 2;
        const bump = Math.abs(Math.sin((lobes * a) / 2));
        pts.push([r2(cx + (w / 2) * (0.84 + 0.16 * bump) * Math.cos(a)), r2(cy + (h / 2) * (0.8 + 0.2 * bump) * Math.sin(a))]);
      }
      return { fills: [close(pts)], details: [], label: "middle" };
    }
    case "person": {
      // A bust icon (head + shoulders) in the top part of the box; the label goes under it.
      const iconH = h * 0.66;
      const r = Math.min(w * 0.17, iconH * 0.22);
      const head = close(arc(w / 2, iconH * 0.3, r, r, 0, 360, 24));
      const sw = Math.min(w * 0.34, r * 2.3);
      const top = iconH * 0.3 + r + 6;
      const shoulders = close([
        [w / 2 - sw, iconH],
        [w / 2 - sw, top + sw * 0.55],
        ...arc(w / 2, top + sw * 0.55, sw, sw * 0.55, 180, 360, 16),
        [w / 2 + sw, iconH],
      ]);
      return { fills: [head, shoulders], details: [], label: "bottom" };
    }
  }
}

/** Default size for a block shape with the given label length. */
export function polySize(shape: PolyShape, textLength: number, lines: (w: number) => number): { w: number; h: number } {
  const lh = 20;
  switch (shape) {
    case "pill": {
      const w = textLength > 40 ? 260 : 210;
      return { w, h: Math.max(64, lines(w - 60) * lh + 30) };
    }
    case "hexagon": {
      const w = textLength > 40 ? 270 : 230;
      return { w, h: Math.max(96, lines(w - 90) * lh + 44) };
    }
    case "parallelogram": {
      const w = textLength > 50 ? 280 : 230;
      return { w, h: Math.max(76, lines(w - 60) * lh + 36) };
    }
    case "database":
      return { w: 170, h: Math.max(130, lines(150) * lh + 70) };
    case "queue": {
      const w = textLength > 30 ? 260 : 220;
      return { w, h: Math.max(84, lines(w - 60) * lh + 40) };
    }
    case "document": {
      const w = textLength > 50 ? 240 : 200;
      return { w, h: Math.max(100, lines(w - 24) * lh + 50) };
    }
    case "cloud": {
      const w = textLength > 40 ? 280 : 240;
      return { w, h: Math.max(140, lines(w * 0.62) * lh + 80) };
    }
    case "person":
      return { w: 140, h: 120 + Math.max(1, lines(130)) * lh };
  }
}
