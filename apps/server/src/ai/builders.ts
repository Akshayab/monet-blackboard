// Element builders for the board AI. Each builder lays out a self-contained block of ordinary Excalidraw
// elements at origin (0,0); the editor then finds free space for it and translates it into place. The model
// picks structure (what goes where, in which order); these functions compute clean positions.
//
// Look (dark canvas, DARK_PALETTE): saturated fills with no visible outline (stroke = fill), small corner
// radius, roughness 0, clean sans text (never the hand-drawn font); light headings and muted notes on the
// canvas; dark text inside fills; thin gray arrows.
import { makeArrow, makeFrame, makeLine, makeShape, makeSticky, makeText, measureText, newId, wrapText, type SceneElement } from "@monet/board-protocol";
import { FRAME_LABEL_SPACE, num, translate, type Point, type Rect } from "./geometry";
import { isPolyShape, outlineFor, polySize, type PolyShape } from "./shapes";
import {
  ARROW,
  FILLS,
  LINE,
  ROUND,
  RUST,
  SANS,
  SECTION_CYCLE,
  SERIES_COLORS,
  SUGGESTION,
  SUGGESTION_FILL,
  SUGGESTION_TEXT,
  SUGGESTION_TEXT_ON_FILL,
  RUST_TEXT,
  TABLE_HEADER,
  TABLE_TEXT,
  TEXT_COLORS,
  TEXT_MUTED,
  TEXT_ON_DARK,
  TEXT_ON_FILL,
  TEXT_SIZES,
  TEXT_SUBTLE,
  BOLDER,
  fillColor,
  strongColor,
  textOn,
  type TextSize,
} from "./style";

export interface BuildCtx {
  /** A fresh short ref for items the model didn't name. */
  nextRef: (prefix?: string) => string;
  /** customData for everything the AI creates. */
  mark: (extra?: Record<string, unknown>) => Record<string, unknown>;
}

export interface Block {
  elements: SceneElement[];
  /** Bounds at origin, including the space a frame's name needs above it. */
  rect: Rect;
  /** ref -> element ids (primary element first). */
  refs: [string, string[]][];
  /** ref -> short text, reported back to the model for items it didn't name. */
  labels: Map<string, string>;
  /** For sections: y offset (from the frame top) where items start, below the heading. */
  contentTop?: number;
}

/** Native Excalidraw shapes (rect = sharp corners; rectangle/rounded = small radius) and outline-drawn ones. */
export type BlockShape = "rect" | "rounded" | "rectangle" | "ellipse" | "diamond" | PolyShape;
export type ItemKind = BlockShape | "sticky" | "text" | "card";
export const BLOCK_SHAPES: BlockShape[] = [
  "rect",
  "rounded",
  "ellipse",
  "diamond",
  "pill",
  "hexagon",
  "parallelogram",
  "database",
  "queue",
  "document",
  "cloud",
  "person",
];
/** filled: saturated fill, dark text; outline: colored border, light text; hollow: dashed colored border. */
export type ShapeStyle = "filled" | "outline" | "hollow";
export type Layout = "grid" | "row" | "column" | "flow";

export interface ItemSpec {
  ref?: string;
  kind?: ItemKind;
  text: string;
  title?: string;
  color?: string;
  style?: ShapeStyle;
  /** Turns the item into a link (Excalidraw element.link). */
  link?: string;
}

const PAD = 40;
const GAP = 30;
const LABEL_SIZE = 16;
/** Default fill per shape kind (parallelograms are yellow travel/transition steps). */
const SHAPE_FILL: Record<string, string> = {
  rect: "blue",
  rounded: "blue",
  rectangle: "blue",
  ellipse: "green",
  diamond: "purple",
  parallelogram: "yellow",
  pill: "green",
  hexagon: "purple",
  database: "blue",
  queue: "orange",
  document: "white",
  cloud: "blue",
  person: "pink",
};

function styleFor(fill: string, style: ShapeStyle | undefined) {
  if (style === "outline") return { bg: "transparent", stroke: fill, width: 2, dash: "solid" as const, label: TEXT_ON_DARK };
  if (style === "hollow") return { bg: "transparent", stroke: fill, width: 2, dash: "dashed" as const, label: TEXT_ON_DARK };
  return { bg: fill, stroke: fill, width: 1, dash: "solid" as const, label: textOn(fill) };
}

/** A safe http(s)/mailto link, or undefined. */
export function cleanLink(link: unknown): string | undefined {
  const l = String(link ?? "").trim();
  return /^(https?:\/\/|mailto:)[^\s]{1,2000}$/i.test(l) ? l : undefined;
}

/** Characters per line that fit a box (Nunito averages about 0.59 em per character; capitals run wider). */
export function charsFor(width: number, fontSize: number) {
  return Math.max(6, Math.floor((width - 24) / (fontSize * 0.62)));
}

export function lineCount(text: string, width: number, fontSize: number) {
  return wrapText(text, charsFor(width, fontSize)).split("\n").length;
}

export function clean(text: unknown, max = 2000): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

/**
 * Bound labels keep the unwrapped text in originalText so the client re-wraps it to the real container, and
 * are positioned where Excalidraw would put them (the client refreshes their size but not their position).
 */
function withRawLabel(els: SceneElement[], raw: string): SceneElement[] {
  const shape = els.find((e) => e.type !== "text" && e.type !== "line");
  const label = els.find((e) => e.type === "text" && e.containerId === shape?.id);
  if (!shape || !label) return els;
  label.originalText = raw;
  const w = num(shape.width);
  const h = num(shape.height);
  const lw = Math.min(num(label.width), w - 10);
  const lh = num(label.height);
  label.width = lw;
  label.x = label.textAlign === "left" ? num(shape.x) + 10 : num(shape.x) + (w - lw) / 2;
  label.y =
    label.verticalAlign === "top" ? num(shape.y) + 10 : label.verticalAlign === "bottom" ? num(shape.y) + h - lh - 6 : num(shape.y) + Math.max(5, (h - lh) / 2);
  return els;
}

/** Height a sticky of the given width needs for its text. */
export function stickyHeightFor(text: string, width: number) {
  return Math.ceil(lineCount(clean(text), width, LABEL_SIZE) * 20 + 44);
}

export function itemSize(spec: ItemSpec, kind: ItemKind): { w: number; h: number } {
  const t = clean(spec.text);
  switch (kind) {
    case "sticky": {
      const w = t.length > 120 ? 240 : t.length > 70 ? 200 : 170;
      return { w, h: Math.max(Math.round(w * 0.85), stickyHeightFor(t, w)) };
    }
    case "rect":
    case "rounded":
    case "rectangle": {
      const w = t.length > 60 ? 260 : 200;
      return { w, h: Math.max(76, lineCount(t, w, LABEL_SIZE) * 20 + 36) };
    }
    case "pill":
    case "hexagon":
    case "parallelogram":
    case "database":
    case "queue":
    case "document":
    case "cloud":
    case "person":
      return polySize(kind, t.length, (w) => lineCount(t, w, LABEL_SIZE));
    case "ellipse": {
      const w = t.length > 40 ? 260 : 220;
      return { w, h: Math.max(110, lineCount(t, w * 0.7, LABEL_SIZE) * 20 + 56) };
    }
    case "diamond": {
      const w = t.length > 30 ? 280 : 240;
      return { w, h: Math.max(140, lineCount(t, w * 0.55, LABEL_SIZE) * 20 + 84) };
    }
    case "text": {
      const m = measureText(wrapText(t, 48), TEXT_SIZES.body);
      return { w: m.width, h: m.height };
    }
    case "card":
      return { w: 320, h: twoLineCardHeight(320, clean(spec.title, 200) || t, clean(spec.title, 200) ? t : "") };
  }
}

export interface ItemOpts {
  frameId?: string | null;
  groupIds?: string[];
  /** Default fill when the item has no color of its own. */
  defaultColor?: string;
}

/** Height of a two-line card (bold-ish title line(s), then a smaller body). */
export function twoLineCardHeight(w: number, title: string, body: string) {
  const th = measureText(wrapText(title, charsFor(w, 16)), 16).height;
  const bh = body ? measureText(wrapText(body, charsFor(w, 13)), 13).height + 6 : 0;
  return Math.ceil(14 + th + bh + 14);
}

/**
 * A card with a title line and a smaller body line, grouped: a filled rectangle (no outline) plus two text
 * elements. customData.aiKind = "card" so the board summary treats it as one item.
 */
export function buildTwoLineCard(
  ctx: BuildCtx,
  o: { x: number; y: number; w: number; h?: number; title: string; body?: string; fill: string; frameId?: string | null; custom?: Record<string, unknown> },
): SceneElement[] {
  const groupId = newId();
  const title = clean(o.title, 300);
  const body = clean(o.body, 1200);
  const h = Math.max(o.h ?? 0, twoLineCardHeight(o.w, title, body));
  const color = textOn(o.fill);
  const custom = ctx.mark({ ...(o.custom ?? {}), aiKind: "card" });
  const textCustom = ctx.mark({ aiKind: "card" });
  const [rect] = makeShape({
    x: o.x,
    y: o.y,
    width: o.w,
    height: h,
    backgroundColor: o.fill,
    strokeColor: o.fill,
    roughness: 0,
    roundness: ROUND,
    groupIds: [groupId],
    frameId: o.frameId ?? null,
    customData: custom,
  });
  const titleWrapped = wrapText(title, charsFor(o.w, 16));
  const t = makeText({
    x: o.x + 14,
    y: o.y + 14,
    text: titleWrapped,
    fontSize: 16,
    fontFamily: SANS,
    strokeColor: color,
    groupIds: [groupId],
    frameId: o.frameId ?? null,
    customData: { ...textCustom, cardPart: "title" },
  });
  const out = [rect!, t];
  if (body) {
    const b = makeText({
      x: o.x + 14,
      y: o.y + 14 + num(t.height) + 6,
      text: wrapText(body, charsFor(o.w, 13)),
      fontSize: 13,
      fontFamily: SANS,
      strokeColor: color,
      opacity: 80,
      groupIds: [groupId],
      frameId: o.frameId ?? null,
      customData: { ...textCustom, cardPart: "body" },
    });
    out.push(b);
  }
  return out;
}

/** Builds one item at (x, y) with the given size. The first non-text, non-line element is the primary one. */
export function buildItem(
  ctx: BuildCtx,
  spec: ItemSpec,
  kind: ItemKind,
  x: number,
  y: number,
  size: { w: number; h: number },
  opts: ItemOpts = {},
): SceneElement[] {
  const md = plainText(clean(spec.text));
  const text = md.text;
  const link = cleanLink(spec.link) ?? md.link;
  const els = buildItemInner(ctx, { ...spec, text }, kind, x, y, size, opts);
  if (link) primaryOf(els).link = link;
  return els;
}

function buildItemInner(
  ctx: BuildCtx,
  spec: ItemSpec,
  kind: ItemKind,
  x: number,
  y: number,
  size: { w: number; h: number },
  opts: ItemOpts = {},
): SceneElement[] {
  const text = spec.text;
  const custom = ctx.mark(spec.ref ? { ref: spec.ref } : {});
  const common = { x, y, width: size.w, height: size.h, frameId: opts.frameId ?? null, groupIds: opts.groupIds, customData: custom };
  switch (kind) {
    case "sticky":
      return withRawLabel(makeSticky({ ...common, text, color: fillColor(spec.color, fillColor(opts.defaultColor, FILLS.yellow)) }), text);
    case "rect":
    case "rounded":
    case "rectangle":
    case "ellipse":
    case "diamond": {
      const fill = fillColor(spec.color ?? SHAPE_FILL[kind]);
      const st = styleFor(fill, spec.style);
      const native = kind === "rect" || kind === "rounded" ? "rectangle" : kind;
      return withRawLabel(
        makeShape({
          ...common,
          customData: ctx.mark({
            ...(spec.ref ? { ref: spec.ref } : {}),
            ...(kind === "rect" || kind === "rounded" ? { shape: kind } : {}),
            ...(spec.style && spec.style !== "filled" ? { style: spec.style } : {}),
          }),
          shape: native,
          label: text,
          backgroundColor: st.bg,
          strokeColor: st.stroke,
          strokeWidth: st.width,
          strokeStyle: st.dash,
          labelColor: st.label,
          roughness: 0,
          rounded: kind !== "rect",
          roundness: kind === "rectangle" || kind === "rounded" ? ROUND : undefined,
          fontSize: LABEL_SIZE,
          fontFamily: SANS,
        }),
        text,
      );
    }
    case "pill":
    case "hexagon":
    case "parallelogram":
    case "database":
    case "queue":
    case "document":
    case "cloud":
    case "person":
      return buildPolyShape(ctx, spec, kind, x, y, size, opts);
    case "text":
      return [
        makeText({
          ...common,
          width: undefined,
          height: undefined,
          text: wrapText(text, 48),
          fontSize: TEXT_SIZES.body,
          fontFamily: SANS,
          strokeColor: spec.color ? strongColor(spec.color) : TEXT_ON_DARK,
        }),
      ];
    case "card": {
      const title = clean(spec.title, 200);
      return buildTwoLineCard(ctx, {
        x,
        y,
        w: size.w,
        h: size.h,
        title: title || text,
        body: title ? text : "",
        fill: fillColor(spec.color, FILLS.white),
        frameId: opts.frameId ?? null,
        custom: spec.ref ? { ref: spec.ref } : {},
      });
    }
  }
}

/**
 * A block shape Excalidraw doesn't have: filled closed lines (the visual, plus detail strokes such as a cylinder's
 * lid) grouped with a transparent rectangle that holds the label and takes arrow bindings. Moving, recoloring, and
 * deleting treat them as one item (the outline parts carry customData.partOf = the holder's id).
 */
function buildPolyShape(ctx: BuildCtx, spec: ItemSpec, shape: PolyShape, x: number, y: number, size: { w: number; h: number }, opts: ItemOpts): SceneElement[] {
  const text = spec.text;
  const fill = fillColor(spec.color ?? SHAPE_FILL[shape]);
  const st = styleFor(fill, spec.style);
  const outline = outlineFor(shape, size.w, size.h);
  const groupId = newId();
  const groupIds = [...(opts.groupIds ?? []), groupId];
  const [holder, label] = makeShape({
    x,
    y,
    width: size.w,
    height: size.h,
    shape: "rectangle",
    label: text,
    backgroundColor: "transparent",
    strokeColor: "transparent",
    labelColor: outline.label === "bottom" ? TEXT_ON_DARK : st.label,
    verticalAlign: outline.label === "bottom" ? "bottom" : "middle",
    rounded: false,
    roughness: 0,
    fontSize: LABEL_SIZE,
    fontFamily: SANS,
    frameId: opts.frameId ?? null,
    groupIds,
    customData: ctx.mark({ ...(spec.ref ? { ref: spec.ref } : {}), shape, ...(spec.style && spec.style !== "filled" ? { style: spec.style } : {}) }),
  });
  const part = ctx.mark({ partOf: holder!.id, aiKind: "shape-part" });
  const line = (points: [number, number][], filled: boolean, detail = false) => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const el = makeLine({
      x,
      y,
      points,
      backgroundColor: filled ? st.bg : "transparent",
      strokeColor: detail && st.bg !== "transparent" ? TEXT_ON_FILL : st.stroke,
      strokeWidth: st.width,
      strokeStyle: st.dash,
      fillStyle: "solid",
      roughness: 0,
      opacity: detail && st.bg !== "transparent" ? 35 : 100,
      groupIds,
      frameId: opts.frameId ?? null,
      customData: part,
    });
    el.width = Math.max(...xs) - Math.min(...xs);
    el.height = Math.max(...ys) - Math.min(...ys);
    return el;
  };
  const parts = [...outline.fills.map((p) => line(p, true)), ...outline.details.map((p) => line(p, false, true))];
  return withRawLabel([...parts, holder!, label!], text);
}

/**
 * Markdown-ish text to plain board text (Excalidraw text can't mix styles): bullets become "•", **bold**, _italic_,
 * and `code` lose their markers, [label](url) keeps the label and returns the first url as the element's link.
 */
export function plainText(md: string): { text: string; link?: string; bold: boolean } {
  let link: string | undefined;
  const bold = /^\s*(\*\*|__)[^*_][\s\S]*(\*\*|__)\s*$/.test(md);
  const text = md
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
          link ??= cleanLink(url);
          return label;
        })
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1"),
    )
    .join("\n");
  return { text, link, bold };
}

/** The element arrows attach to and handles point at (not a label or a decorative line). */
export function primaryOf(els: SceneElement[]): SceneElement {
  return els.find((e) => e.type !== "text" && e.type !== "line" && e.type !== "freedraw") ?? els[0]!;
}

/** A text element sized to its content (headings light, notes muted). */
export function buildText(
  ctx: BuildCtx,
  text: string,
  size: TextSize,
  x: number,
  y: number,
  opts: ItemOpts & { color?: string; ref?: string; custom?: Record<string, unknown>; link?: string } = {},
) {
  const md = plainText(clean(text));
  // A fully bold line ("**Q3 goals**") becomes one size larger, since Excalidraw text has no bold.
  if (md.bold) size = BOLDER[size] ?? size;
  const fontSize = TEXT_SIZES[size];
  const maxChars = fontSize >= 40 ? 30 : fontSize >= 30 ? 40 : fontSize >= 24 ? 48 : 64;
  const link = cleanLink(opts.link) ?? md.link;
  return makeText({
    x,
    y,
    ...(link ? { link } : {}),
    text: md.text
      .split("\n")
      .map((l) => wrapText(l, maxChars))
      .join("\n"),
    fontSize,
    fontFamily: SANS,
    strokeColor: opts.color ? strongColor(opts.color) : TEXT_COLORS[size],
    frameId: opts.frameId ?? null,
    groupIds: opts.groupIds,
    customData: ctx.mark({ ...(opts.ref ? { ref: opts.ref } : {}), ...(opts.custom ?? {}) }),
  });
}

/** Positions boxes in a grid/row/column/flow. Returns top-left positions and the total size. */
export function arrangeBoxes(sizes: { w: number; h: number }[], layout: Layout, columns?: number, gap = GAP) {
  const n = sizes.length;
  if (!n) return { positions: [] as Point[], w: 0, h: 0 };
  let cols: number;
  if (layout === "row") cols = n;
  else if (layout === "column") cols = 1;
  else if (layout === "flow") cols = Math.max(1, Math.min(n, columns ?? 5));
  else cols = Math.max(1, Math.min(n, columns ?? (n <= 3 ? n : n === 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5)));
  const hGap = layout === "flow" ? 80 : gap;
  const vGap = layout === "flow" ? 70 : gap;
  const colW = Math.max(...sizes.map((s) => s.w));
  const rows = Math.ceil(n / cols);
  const rowH: number[] = [];
  for (let r = 0; r < rows; r++) rowH.push(Math.max(...sizes.slice(r * cols, r * cols + cols).map((s) => s.h)));
  const positions: Point[] = [];
  let y = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols && r * cols + c < n; c++) {
      const s = sizes[r * cols + c]!;
      const center = layout === "row" || layout === "flow";
      // Flows that wrap run back the other way on every other row ("snake"), so the arrow from the end of one
      // row to the start of the next is a short vertical link instead of a long diagonal across the board.
      const col = layout === "flow" && r % 2 === 1 ? cols - 1 - c : c;
      positions.push({ x: col * (colW + hGap) + (colW - s.w) / 2, y: y + (center ? (rowH[r]! - s.h) / 2 : 0) });
    }
    y += rowH[r]! + vGap;
  }
  return { positions, w: cols * colW + (cols - 1) * hGap, h: y - vGap };
}

export type ArrowHead = "arrow" | "circle" | "dot" | "triangle" | "bar" | "diamond" | "none";
export type ArrowRouting = "straight" | "elbow" | "curved";

function headOf(h: ArrowHead | undefined, fallback: string | null): string | null {
  if (h === undefined) return fallback;
  return h === "none" ? null : h;
}

/** Re-shapes a bound arrow as an elbow (right-angle) or curved connector between two elements. */
export function routeArrow(arrow: SceneElement, from: SceneElement, to: SceneElement, routing: ArrowRouting) {
  if (routing === "straight") return;
  const f = { x: num(from.x), y: num(from.y), w: num(from.width), h: num(from.height) };
  const t = { x: num(to.x), y: num(to.y), w: num(to.width), h: num(to.height) };
  const fc = { x: f.x + f.w / 2, y: f.y + f.h / 2 };
  const tc = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
  const horizontal = Math.abs(tc.x - fc.x) >= Math.abs(tc.y - fc.y);
  const fwd = horizontal ? tc.x >= fc.x : tc.y >= fc.y;
  let a: Point;
  let b: Point;
  let fp: [number, number];
  let tp: [number, number];
  if (horizontal) {
    a = { x: fwd ? f.x + f.w + 8 : f.x - 8, y: fc.y };
    b = { x: fwd ? t.x - 8 : t.x + t.w + 8, y: tc.y };
    fp = [fwd ? 1 : 0, 0.5];
    tp = [fwd ? 0 : 1, 0.5];
  } else {
    a = { x: fc.x, y: fwd ? f.y + f.h + 8 : f.y - 8 };
    b = { x: tc.x, y: fwd ? t.y - 8 : t.y + t.h + 8 };
    fp = [0.5, fwd ? 1 : 0];
    tp = [0.5, fwd ? 0 : 1];
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let points: [number, number][];
  if (routing === "elbow") {
    points = horizontal
      ? [
          [0, 0],
          [dx / 2, 0],
          [dx / 2, dy],
          [dx, dy],
        ]
      : [
          [0, 0],
          [0, dy / 2],
          [dx, dy / 2],
          [dx, dy],
        ];
    arrow.elbowed = true;
    arrow.roundness = null;
    arrow.fixedSegments = null;
    arrow.startIsSpecial = null;
    arrow.endIsSpecial = null;
    arrow.startBinding = { elementId: from.id, focus: 0, gap: 8, fixedPoint: fp };
    arrow.endBinding = { elementId: to.id, focus: 0, gap: 8, fixedPoint: tp };
  } else {
    const len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(120, len * 0.18);
    points = [
      [0, 0],
      [dx / 2 + (-dy / len) * bend, dy / 2 + (dx / len) * bend],
      [dx, dy],
    ];
    arrow.roundness = { type: 2 };
  }
  arrow.x = a.x;
  arrow.y = a.y;
  arrow.points = points.map(([px, py]) => [Math.round(px * 100) / 100, Math.round(py * 100) / 100]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  arrow.width = Math.max(...xs) - Math.min(...xs);
  arrow.height = Math.max(...ys) - Math.min(...ys);
}

export function arrowBetween(
  ctx: BuildCtx,
  from: SceneElement,
  to: SceneElement,
  opts: {
    label?: string;
    dashed?: boolean;
    color?: string;
    suggestion?: boolean;
    suggestionId?: string;
    startHead?: ArrowHead;
    endHead?: ArrowHead;
    routing?: ArrowRouting;
  } = {},
) {
  const frameId = from.frameId && from.frameId === to.frameId ? (from.frameId as string) : null;
  const els = makeArrow({
    x: 0,
    y: 0,
    from,
    to,
    label: opts.label ? clean(opts.label, 80) : undefined,
    strokeColor: opts.color ?? (opts.suggestion ? SUGGESTION : ARROW),
    strokeWidth: opts.suggestion ? 2 : 1,
    strokeStyle: opts.dashed || opts.suggestion ? "dashed" : "solid",
    roughness: 0,
    frameId,
    customData: ctx.mark(opts.suggestion ? { suggestion: true, ...(opts.suggestionId ? { suggestionId: opts.suggestionId } : {}) } : {}),
  });
  for (const el of els) {
    if (el.type !== "text") continue;
    el.strokeColor = opts.suggestion ? SUGGESTION_TEXT : TEXT_MUTED;
    el.fontFamily = SANS;
    el.fontSize = 14;
  }
  const arrow = els[0]!;
  arrow.startArrowhead = headOf(opts.startHead, null);
  arrow.endArrowhead = headOf(opts.endHead, "arrow");
  if (opts.routing && opts.routing !== "straight") {
    routeArrow(arrow, from, to, opts.routing);
    const label = els[1];
    if (label) {
      const pts = arrow.points as [number, number][];
      const mid = pts[Math.floor(pts.length / 2)]!;
      label.x = num(arrow.x) + mid[0] - num(label.width) / 2;
      label.y = num(arrow.y) + mid[1] - num(label.height) / 2;
    }
  }
  return els;
}

export interface ItemsResult {
  elements: SceneElement[];
  w: number;
  h: number;
  refs: [string, string[]][];
  labels: Map<string, string>;
  primaries: SceneElement[];
}

/** Builds a set of items laid out at origin. Flow layouts connect the items in order. */
export function buildItems(
  ctx: BuildCtx,
  specs: ItemSpec[],
  defaultKind: ItemKind,
  layout: Layout,
  columns: number | undefined,
  opts: ItemOpts & { connectInOrder?: boolean } = {},
): ItemsResult {
  const kinds = specs.map((s) => s.kind ?? defaultKind);
  const sizes = specs.map((s, i) => itemSize(s, kinds[i]!));
  // Uniform stickies (and uniform flow steps) read as a tidy grid.
  if (kinds.every((k) => k === "sticky") || layout === "flow") {
    const w = Math.max(...sizes.map((s) => s.w));
    const h = Math.max(...sizes.map((s) => s.h));
    sizes.forEach((s, i) => {
      if (["sticky", "rect", "rounded", "rectangle", "parallelogram", "pill", "hexagon", "document"].includes(kinds[i]!)) {
        s.w = w;
        s.h = h;
      }
    });
  }
  const { positions, w, h } = arrangeBoxes(sizes, layout, columns);
  const elements: SceneElement[] = [];
  const refs: [string, string[]][] = [];
  const labels = new Map<string, string>();
  const primaries: SceneElement[] = [];
  specs.forEach((spec, i) => {
    const ref = spec.ref || ctx.nextRef();
    if (!spec.ref) labels.set(ref, clean(spec.text, 60));
    const els = buildItem(ctx, { ...spec, ref }, kinds[i]!, positions[i]!.x, positions[i]!.y, sizes[i]!, opts);
    elements.push(...els);
    const primary = primaryOf(els);
    primaries.push(primary);
    refs.push([ref, [primary.id, ...els.filter((e) => e !== primary).map((e) => e.id)]]);
  });
  if (layout === "flow" || opts.connectInOrder) {
    for (let i = 0; i + 1 < primaries.length; i++) elements.push(...arrowBetween(ctx, primaries[i]!, primaries[i + 1]!));
  }
  return { elements, w, h, refs, labels, primaries };
}

export interface SectionSpec {
  ref?: string;
  name: string;
  note?: string;
  color?: string;
  layout?: Layout;
  columns?: number;
  item_kind?: ItemKind;
  items?: ItemSpec[];
}

/**
 * A section: a large light heading and an optional muted subtitle above its content, inside a frame that
 * groups it (the frame's name is the heading too, for exports and the board summary).
 */
export function buildSection(ctx: BuildCtx, spec: SectionSpec, index: number): Block {
  const name = clean(spec.name, 120) || "Section";
  // The big heading inside the section shows the title, so the frame's own (small, grey) label stays empty;
  // the title is kept in customData.sectionTitle for summaries, renames, and exports.
  const frame = makeFrame({ x: 0, y: 0, name: "", customData: ctx.mark({ sectionTitle: name, ...(spec.ref ? { ref: spec.ref } : {}) }) });
  const ref = spec.ref || ctx.nextRef("s");
  const elements: SceneElement[] = [frame];
  const refs: [string, string[]][] = [];
  const labels = new Map<string, string>();
  if (!spec.ref) labels.set(ref, clean(spec.name, 60));
  const heading = buildText(ctx, name, "heading", PAD, PAD - 6, { frameId: frame.id, custom: { sectionHeading: frame.id } });
  elements.push(heading);
  let cursor = PAD - 6 + num(heading.height) + 6;
  let contentW = num(heading.width);
  if (spec.note) {
    const note = buildText(ctx, spec.note, "subtitle", PAD, cursor, { frameId: frame.id, custom: { sectionSubtitle: frame.id } });
    elements.push(note);
    cursor += num(note.height);
    contentW = Math.max(contentW, num(note.width));
  }
  cursor += 24;
  const contentTop = cursor;
  const items = spec.items ?? [];
  const sectionColor = spec.color ?? SECTION_CYCLE[index % SECTION_CYCLE.length];
  if (items.length) {
    const built = buildItems(ctx, items, spec.item_kind ?? "sticky", spec.layout ?? "grid", spec.columns, {
      frameId: frame.id,
      defaultColor: sectionColor,
    });
    translate(built.elements, PAD, cursor);
    elements.push(...built.elements);
    refs.push(...built.refs);
    for (const [k, v] of built.labels) labels.set(k, v);
    cursor += built.h;
    contentW = Math.max(contentW, built.w);
  } else {
    cursor += 200;
    contentW = Math.max(contentW, 400);
  }
  frame.width = Math.max(360, contentW + PAD * 2);
  frame.height = cursor + PAD;
  refs.unshift([
    ref,
    [frame.id, heading.id, ...elements.filter((e) => e.customData && (e.customData as Record<string, unknown>).sectionSubtitle).map((e) => e.id)],
  ]);
  return {
    elements,
    rect: { x: 0, y: -FRAME_LABEL_SPACE, w: num(frame.width), h: num(frame.height) + FRAME_LABEL_SPACE },
    refs,
    labels,
    contentTop,
  };
}

/** Arranges several blocks (built at origin) relative to each other and merges them. */
export function combineBlocks(blocks: Block[], arrangement: "row" | "column" | "grid" | "auto", gap = 120): Block {
  const layout: Layout = arrangement === "auto" ? (blocks.length <= 4 ? "row" : "grid") : arrangement === "grid" ? "grid" : arrangement;
  const columns = layout === "grid" ? Math.ceil(Math.sqrt(blocks.length)) : undefined;
  const sizes = blocks.map((b) => ({ w: b.rect.w, h: b.rect.h }));
  // Keep each block's own width (don't center in a uniform column) by placing rows manually.
  const n = blocks.length;
  const cols = layout === "row" ? n : layout === "column" ? 1 : (columns ?? n);
  const elements: SceneElement[] = [];
  const refs: [string, string[]][] = [];
  const labels = new Map<string, string>();
  let y = 0;
  let maxW = 0;
  for (let r = 0; r * cols < n; r++) {
    let x = 0;
    const row = blocks.slice(r * cols, r * cols + cols);
    const rowH = Math.max(...sizes.slice(r * cols, r * cols + cols).map((s) => s.h));
    for (const b of row) {
      translate(b.elements, x - b.rect.x, y - b.rect.y);
      elements.push(...b.elements);
      refs.push(...b.refs);
      for (const [k, v] of b.labels) labels.set(k, v);
      x += b.rect.w + gap;
    }
    maxW = Math.max(maxW, x - gap);
    y += rowH + gap;
  }
  return { elements, rect: { x: 0, y: 0, w: maxW, h: y - gap }, refs, labels };
}

/** Wraps loose elements (built at origin) into a block. */
export function blockOf(elements: SceneElement[], refs: [string, string[]][] = [], labels = new Map<string, string>()): Block {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    if (el.type === "text" && el.containerId) continue;
    const x = num(el.x);
    const y = num(el.y);
    let w = num(el.width);
    let h = num(el.height);
    let ox = 0;
    let oy = 0;
    if (Array.isArray(el.points)) {
      const pts = el.points as [number, number][];
      ox = Math.min(0, ...pts.map((p) => p[0]));
      oy = Math.min(0, ...pts.map((p) => p[1]));
      w = Math.max(0, ...pts.map((p) => p[0])) - ox;
      h = Math.max(0, ...pts.map((p) => p[1])) - oy;
    }
    const top = el.type === "frame" ? y + oy - FRAME_LABEL_SPACE : y + oy;
    minX = Math.min(minX, x + ox);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, x + ox + w);
    maxY = Math.max(maxY, y + oy + h);
  }
  if (minX === Infinity) return { elements, rect: { x: 0, y: 0, w: 0, h: 0 }, refs, labels };
  return { elements, rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, refs, labels };
}

// ---------------------------------------------------------------------------------------------------------
// Timeline

export interface MilestoneSpec {
  ref?: string;
  label: string;
  date?: string;
  end_date?: string;
  owner?: string;
  lane?: string;
  color?: string;
}

export interface TimelineSpec {
  ref?: string;
  title: string;
  lanes?: { name: string; color?: string }[];
  milestones: MilestoneSpec[];
}

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses the date formats people write on plans. Returns UTC ms or null. */
export function parseDate(input: string | undefined, now = Date.now()): number | null {
  if (!input) return null;
  const t = input.trim().toLowerCase();
  if (!t) return null;
  const refYear = new Date(now).getUTCFullYear();
  const today = Date.UTC(refYear, new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  let m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return Date.UTC(+m[1]!, +m[2]! - 1, m[3] ? +m[3] : 1);
  m = t.match(/\bq([1-4])\b/);
  if (m) {
    const ym = t.match(/\b(\d{4})\b|'(\d{2})\b/);
    const year = ym ? (ym[1] ? +ym[1] : 2000 + +ym[2]!) : refYear;
    return Date.UTC(year, (+m[1]! - 1) * 3, 1);
  }
  m = t.match(/^(?:week|wk|w)\s*(\d{1,2})\b/);
  if (m) return today + (+m[1]! - 1) * 7 * DAY;
  m = t.match(/^day\s*(\d{1,3})\b/);
  if (m) return today + (+m[1]! - 1) * DAY;
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : refYear;
    return Date.UTC(y, +m[1]! - 1, +m[2]!);
  }
  const mi = MONTHS.findIndex((mm) => new RegExp(`\\b${mm}`).test(t));
  if (mi >= 0) {
    let day = 1;
    let year: number | null = null;
    for (const n of t.match(/\d+/g) ?? []) {
      if (n.length === 4) year = +n;
      else if (+n >= 1 && +n <= 31) day = +n;
    }
    const t0 = Date.UTC(year ?? refYear, mi, day);
    // Plans look forward: a month/day without a year that's well in the past means next year.
    return year === null && t0 < today - 60 * DAY ? Date.UTC(refYear + 1, mi, day) : t0;
  }
  const p = Date.parse(input);
  return Number.isNaN(p) ? null : p;
}

function fmtDay(ms: number) {
  const d = new Date(ms);
  return `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

type TickUnit = "week" | "month" | "quarter";

function ticksFor(min: number, max: number): { unit: TickUnit; ticks: number[] } {
  const span = max - min;
  const unit: TickUnit = span <= 70 * DAY ? "week" : span <= 20 * 31 * DAY ? "month" : "quarter";
  const ticks: number[] = [];
  const d = new Date(min);
  if (unit === "week") {
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    t += ((8 - new Date(t).getUTCDay()) % 7) * DAY; // next Monday
    for (; t <= max; t += 7 * DAY) ticks.push(t);
  } else {
    const stepMonths = unit === "month" ? 1 : 3;
    let y = d.getUTCFullYear();
    let mo = unit === "month" ? d.getUTCMonth() + 1 : Math.floor(d.getUTCMonth() / 3) * 3 + 3;
    for (;;) {
      if (mo >= 12) {
        y += Math.floor(mo / 12);
        mo %= 12;
      }
      const t = Date.UTC(y, mo, 1);
      if (t > max) break;
      ticks.push(t);
      mo += stepMonths;
    }
  }
  return { unit, ticks };
}

/** Start of the month or quarter that contains `ms` (null for weeks, whose ticks already name each date). */
function periodStart(ms: number, unit: TickUnit): number | null {
  const d = new Date(ms);
  if (unit === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (unit === "quarter") return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
  return null;
}

function tickLabel(ms: number, unit: TickUnit, first: boolean) {
  const d = new Date(ms);
  if (unit === "week") return fmtDay(ms);
  if (unit === "month") return d.getUTCMonth() === 0 || first ? `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : MONTH_LABELS[d.getUTCMonth()]!;
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

/** A timeline section: date axis with ticks, swimlanes (by lane or owner), and milestone cards. */
export function buildTimeline(ctx: BuildCtx, spec: TimelineSpec, now = Date.now()): Block {
  const ms = spec.milestones.slice(0, 80).map((m) => ({ ...m, label: clean(m.label, 200) }));
  const frame = makeFrame({ x: 0, y: 0, name: clean(spec.title, 120) || "Timeline", customData: ctx.mark(spec.ref ? { ref: spec.ref } : {}) });
  const ref = spec.ref || ctx.nextRef("s");
  const part = ctx.mark({ aiKind: "timeline-part", aiBlock: frame.id });
  const elements: SceneElement[] = [frame];
  const refs: [string, string[]][] = [];
  const labels = new Map<string, string>();
  if (!spec.ref) labels.set(ref, clean(spec.title, 60));

  // Dates
  const t0 = ms.map((m) => parseDate(m.date, now));
  const t1 = ms.map((m) => parseDate(m.end_date, now));
  const datedCount = t0.filter((t) => t !== null).length;
  const timeMode = datedCount >= Math.max(2, Math.ceil(ms.length * 0.6));
  if (timeMode) {
    // Fill undated milestones from their neighbours so they keep their place in order.
    for (let i = 0; i < t0.length; i++) {
      if (t0[i] !== null) continue;
      const prev =
        t0
          .slice(0, i)
          .reverse()
          .find((t) => t !== null) ?? null;
      const next = t0.slice(i + 1).find((t) => t !== null) ?? null;
      t0[i] = prev !== null && next !== null ? (prev + next) / 2 : (prev ?? next ?? now);
    }
  }

  // Lanes: explicit, else by owner when most milestones have one.
  let laneNames = (spec.lanes ?? []).map((l) => clean(l.name, 60)).filter(Boolean);
  const laneColors = new Map((spec.lanes ?? []).map((l) => [clean(l.name, 60).toLowerCase(), l.color]));
  const owners = [...new Set(ms.map((m) => clean(m.owner, 60)).filter(Boolean))];
  const byOwner = !laneNames.length && owners.length >= 2 && ms.filter((m) => m.owner).length >= ms.length * 0.6;
  if (byOwner) laneNames = owners;
  if (!laneNames.length) laneNames = [""];
  const laneIndex = (m: MilestoneSpec) => {
    const key = clean(byOwner ? m.owner : m.lane, 60);
    if (!key) return byOwner ? -1 : 0;
    const i = laneNames.findIndex((n) => n.toLowerCase() === key.toLowerCase());
    if (i >= 0) return i;
    laneNames.push(key);
    return laneNames.length - 1;
  };
  const laneOf = ms.map(laneIndex);
  if (laneOf.includes(-1)) {
    laneNames.push("Unassigned");
    for (let i = 0; i < laneOf.length; i++) if (laneOf[i] === -1) laneOf[i] = laneNames.length - 1;
  }
  const named = laneNames.length > 1 || laneNames[0] !== "";
  const LW = named ? 180 : 0;
  const CW = 200;
  const left0 = PAD + LW;
  const axisY = PAD + 44;

  let min = 0;
  let max = 0;
  let PW: number;
  let xOf: (i: number) => { left: number; width: number; anchor: number };
  if (timeMode) {
    const starts = t0 as number[];
    const ends = starts.map((s, i) => Math.max(s, t1[i] ?? s));
    min = Math.min(...starts);
    max = Math.max(...ends);
    const span = Math.max(max - min, 14 * DAY);
    min -= span * 0.05;
    max = min + span * 1.1;
    PW = Math.min(3600, Math.max(900, ms.length * 230));
    const px = PW / (max - min);
    const xt = (t: number) => left0 + CW / 2 + (t - min) * px;
    xOf = (i) => {
      const a = xt(starts[i]!);
      if (t1[i] !== null && t1[i]! > starts[i]!) {
        const w = Math.max(CW, xt(t1[i]!) - a);
        return { left: a, width: w, anchor: a };
      }
      return { left: Math.max(left0, a - CW / 2), width: CW, anchor: a };
    };
  } else {
    PW = ms.length * (CW + 40);
    xOf = (i) => {
      const left = left0 + i * (CW + 40);
      return { left, width: CW, anchor: left + CW / 2 };
    };
  }

  // Two-line cards (title, then owner · date) with greedy track stacking per lane.
  const cardMeta = ms.map((m, i) => {
    const when = m.date
      ? (timeMode && t0[i] !== null ? fmtDay(t0[i]!) : clean(m.date, 40)) +
        (m.end_date ? ` – ${timeMode && t1[i] !== null ? fmtDay(t1[i]!) : clean(m.end_date, 40)}` : "")
      : "";
    return [byOwner ? "" : clean(m.owner, 60), when].filter(Boolean).join(" · ");
  });
  const geom = ms.map((_, i) => xOf(i));
  const cardH = ms.map((m, i) => Math.max(60, twoLineCardHeight(geom[i]!.width, m.label, cardMeta[i]!)));
  let y = axisY + 36;
  const laneTops: number[] = [];
  const cardPos: Point[] = new Array(ms.length);
  const laneElements: SceneElement[] = [];
  for (let li = 0; li < laneNames.length; li++) {
    const members = ms
      .map((_, i) => i)
      .filter((i) => laneOf[i] === li)
      .sort((a, b) => geom[a]!.left - geom[b]!.left);
    const h = members.length ? Math.max(...members.map((i) => cardH[i]!)) : 60;
    const trackEnds: number[] = [];
    for (const i of members) {
      let track = trackEnds.findIndex((end) => end + 20 <= geom[i]!.left);
      if (track < 0) {
        track = trackEnds.length;
        trackEnds.push(0);
      }
      trackEnds[track] = geom[i]!.left + geom[i]!.width;
      cardPos[i] = { x: geom[i]!.left, y: y + 12 + track * (h + 16) };
    }
    const laneH = Math.max(1, trackEnds.length) * (h + 16) + 24;
    laneTops.push(y);
    if (named) {
      const label = makeText({
        x: PAD,
        y: y + laneH / 2 - 12,
        text: wrapText(laneNames[li]!, 16),
        fontSize: 16,
        fontFamily: SANS,
        strokeColor: TEXT_ON_DARK,
        frameId: frame.id,
        customData: part,
      });
      laneElements.push(label);
    }
    y += laneH;
  }
  const bottom = y;
  const rightmost = Math.max(left0 + PW + CW, ...geom.map((g) => g.left + g.width + PAD));
  const totalW = rightmost + PAD;
  if (named) {
    for (let li = 1; li < laneTops.length; li++) {
      laneElements.push(
        makeLine({
          x: PAD,
          y: laneTops[li]!,
          points: [
            [0, 0],
            [totalW - PAD * 2, 0],
          ],
          strokeColor: LINE,
          roughness: 0,
          frameId: frame.id,
          customData: part,
        }),
      );
    }
  }

  // Axis, ticks, gridlines, today marker.
  const axisEnd = totalW - PAD;
  const guides: SceneElement[] = [];
  const axis: SceneElement[] = [
    makeLine({
      x: left0,
      y: axisY,
      points: [
        [0, 0],
        [axisEnd - left0, 0],
      ],
      strokeColor: ARROW,
      strokeWidth: 1,
      roughness: 0,
      frameId: frame.id,
      customData: part,
    }),
  ];
  if (timeMode) {
    const px = PW / (max - min);
    const xt = (t: number) => left0 + CW / 2 + (t - min) * px;
    const { unit, ticks } = ticksFor(min, max);
    const step = Math.max(1, Math.ceil(ticks.length / 24));
    // Ticks mark where each month (or quarter) begins, so the first one can fall after the earliest milestone.
    // Label the period the axis starts in at its left end, so a bar starting on Jan 11 isn't under "Feb".
    const start = periodStart(min, unit);
    const startText = start === null ? null : tickLabel(start, unit, true);
    const startW = startText ? measureText(startText, 14).width : 0;
    const showStart = !!startText && (ticks.length === 0 || xt(ticks[0]!) - left0 >= startW + 24);
    if (showStart) {
      axis.push(
        makeText({
          x: left0,
          y: axisY - 30,
          text: startText!,
          fontSize: 13,
          fontFamily: SANS,
          strokeColor: TEXT_MUTED,
          frameId: frame.id,
          customData: part,
        }),
      );
    }
    ticks.forEach((t, k) => {
      if (k % step !== 0) return;
      const x = xt(t);
      if (x > axisEnd) return;
      guides.push(
        makeLine({
          x,
          y: axisY,
          points: [
            [0, 0],
            [0, bottom - axisY],
          ],
          strokeColor: LINE,
          strokeStyle: "dotted",
          roughness: 0,
          frameId: frame.id,
          customData: part,
        }),
      );
      axis.push(
        makeLine({
          x,
          y: axisY - 5,
          points: [
            [0, 0],
            [0, 10],
          ],
          strokeColor: ARROW,
          strokeWidth: 1,
          roughness: 0,
          frameId: frame.id,
          customData: part,
        }),
      );
      const text = tickLabel(t, unit, k === 0 && !showStart);
      const w = measureText(text, 14).width;
      axis.push(
        makeText({
          x: x - w / 2,
          y: axisY - 30,
          text,
          fontSize: 13,
          fontFamily: SANS,
          strokeColor: TEXT_MUTED,
          textAlign: "center",
          frameId: frame.id,
          customData: part,
        }),
      );
    });
    if (now > min && now < max) {
      const x = xt(now);
      guides.push(
        makeLine({
          x,
          y: axisY - 10,
          points: [
            [0, 0],
            [0, bottom - axisY + 10],
          ],
          strokeColor: RUST,
          strokeStyle: "dashed",
          strokeWidth: 1,
          roughness: 0,
          frameId: frame.id,
          customData: part,
        }),
      );
      axis.push(
        makeText({ x: x + 6, y: axisY + 6, text: "Today", fontSize: 13, fontFamily: SANS, strokeColor: RUST_TEXT, frameId: frame.id, customData: part }),
      );
    }
  }
  const dots: SceneElement[] = [];
  const cards: SceneElement[] = [];
  ms.forEach((m, i) => {
    const lane = laneOf[i]!;
    const fallback = laneColors.get((laneNames[lane] ?? "").toLowerCase()) ?? (named ? SECTION_CYCLE[lane % SECTION_CYCLE.length] : SECTION_CYCLE[i % 3]);
    const fill = fillColor(m.color, fillColor(fallback));
    dots.push(
      ...makeShape({
        shape: "ellipse",
        x: geom[i]!.anchor - 6,
        y: axisY - 6,
        width: 12,
        height: 12,
        backgroundColor: fill,
        strokeColor: fill,
        roughness: 0,
        frameId: frame.id,
        customData: part,
      }),
    );
    const r = m.ref || ctx.nextRef();
    if (!m.ref) labels.set(r, m.label.slice(0, 60));
    const els = buildTwoLineCard(ctx, {
      x: cardPos[i]!.x,
      y: cardPos[i]!.y,
      w: geom[i]!.width,
      h: cardH[i]!,
      title: m.label,
      body: cardMeta[i]!,
      fill,
      frameId: frame.id,
      custom: { ref: r, timeline: true, date: m.date ?? null, owner: m.owner ?? null },
    });
    cards.push(...els);
    refs.push([r, els.map((e) => e.id)]);
  });
  elements.push(...guides, ...laneElements, ...axis, ...dots, ...cards);
  frame.width = totalW;
  frame.height = bottom + PAD;
  refs.unshift([ref, [frame.id]]);
  return { elements, rect: { x: 0, y: -FRAME_LABEL_SPACE, w: totalW, h: num(frame.height) + FRAME_LABEL_SPACE }, refs, labels };
}

// ---------------------------------------------------------------------------------------------------------
// Charts (editable: rectangles, lines, and text grouped together)

export interface ChartSpec {
  ref?: string;
  title: string;
  kind?: "bar" | "line";
  labels: string[];
  series: { name: string; values: number[]; color?: string }[];
  unit?: string;
  y_label?: string;
  caption?: string;
}

export function niceTicks(lo: number, hi: number, count = 5) {
  if (hi === lo) hi = lo + 1;
  const rough = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

export function fmtNumber(v: number): string {
  const a = Math.abs(v);
  const trim = (s: string) => s.replace(/\.0$/, "");
  if (a >= 1e9) return trim((v / 1e9).toFixed(1)) + "B";
  if (a >= 1e6) return trim((v / 1e6).toFixed(1)) + "M";
  if (a >= 1e4) return trim((v / 1e3).toFixed(1)) + "k";
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return String(Math.round(v * 100) / 100);
}

function textAt(
  cx: number,
  y: number,
  text: string,
  fontSize: number,
  color: string,
  extra: { frameId?: string | null; groupIds: string[]; customData: Record<string, unknown>; align?: "center" | "left" | "right" },
) {
  const w = measureText(text, fontSize).width;
  const x = extra.align === "left" ? cx : extra.align === "right" ? cx - w : cx - w / 2;
  return makeText({
    x,
    y,
    text,
    fontSize,
    fontFamily: SANS,
    strokeColor: color,
    textAlign: extra.align ?? "center",
    frameId: extra.frameId ?? null,
    groupIds: extra.groupIds,
    customData: extra.customData,
  });
}

export function buildChart(ctx: BuildCtx, spec: ChartSpec, opts: { frameId?: string | null } = {}): Block {
  const labelsIn = spec.labels.slice(0, 40).map((l) => clean(l, 40));
  const n = labelsIn.length;
  const series = spec.series.slice(0, 6).map((s, i) => ({
    name: clean(s.name, 40),
    color: s.color ? strongColor(s.color, SERIES_COLORS[i % SERIES_COLORS.length]) : SERIES_COLORS[i % SERIES_COLORS.length]!,
    values: labelsIn.map((_, k) => {
      const v = Number(s.values[k]);
      return Number.isFinite(v) ? v : 0;
    }),
  }));
  const s = Math.max(1, series.length);
  const kind = spec.kind === "line" ? "line" : "bar";
  const groupId = newId();
  const ref = spec.ref || ctx.nextRef("c");
  const custom = ctx.mark({ aiKind: "chart-part", aiBlock: groupId, chart: clean(spec.title, 80) });
  const extra = { frameId: opts.frameId ?? null, groupIds: [groupId], customData: custom };
  const unit = clean(spec.unit, 12);
  const LM = spec.y_label ? 96 : 72;
  const titleH = 44;
  const legendH = s > 1 ? 30 : 0;
  const TOP = titleH + legendH + 16;
  const PH = 300;
  const barW = s === 1 ? 48 : Math.max(16, Math.floor(84 / s));
  const groupGap = 32;
  const groupW = kind === "bar" ? s * barW + groupGap : 90;
  const PW = Math.max(360, n * groupW);
  const all = series.flatMap((x) => x.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 5);
  const yOf = (v: number) => TOP + PH - ((v - ticks.lo) / (ticks.hi - ticks.lo)) * PH;
  const els: SceneElement[] = [];

  els.push(makeText({ x: 0, y: 0, text: clean(spec.title, 120), fontSize: 22, fontFamily: SANS, strokeColor: TEXT_ON_DARK, ...extra }));
  if (s > 1) {
    let lx = LM;
    for (const se of series) {
      els.push(
        ...makeShape({ x: lx, y: titleH + 4, width: 14, height: 14, backgroundColor: se.color, strokeColor: se.color, roughness: 0, rounded: false, ...extra }),
      );
      const t = textAt(lx + 20, titleH, se.name, 13, TEXT_MUTED, { ...extra, align: "left" });
      els.push(t);
      lx += 20 + num(t.width) + 24;
    }
  }
  for (let v = ticks.lo; v <= ticks.hi + ticks.step / 2; v += ticks.step) {
    const y = yOf(v);
    els.push(
      makeLine({
        x: LM,
        y,
        points: [
          [0, 0],
          [PW, 0],
        ],
        strokeColor: LINE,
        roughness: 0,
        ...extra,
      }),
    );
    els.push(textAt(LM - 10, y - 9, fmtNumber(Math.round(v * 1e6) / 1e6) + unit, 13, TEXT_MUTED, { ...extra, align: "right" }));
  }
  els.push(
    makeLine({
      x: LM,
      y: TOP,
      points: [
        [0, 0],
        [0, PH],
      ],
      strokeColor: LINE,
      roughness: 0,
      ...extra,
    }),
  );
  els.push(
    makeLine({
      x: LM,
      y: yOf(0),
      points: [
        [0, 0],
        [PW, 0],
      ],
      strokeColor: ARROW,
      strokeWidth: 1,
      roughness: 0,
      ...extra,
    }),
  );
  if (spec.y_label) {
    const yl = clean(spec.y_label, 40);
    const m = measureText(yl, 14);
    els.push(
      makeText({
        x: 18 - m.width / 2,
        y: TOP + PH / 2 - m.height / 2,
        text: yl,
        fontSize: 13,
        fontFamily: SANS,
        strokeColor: TEXT_MUTED,
        angle: -Math.PI / 2,
        ...extra,
      }),
    );
  }

  const slot = PW / Math.max(1, n);
  const showValues = kind === "bar" ? n * s <= 30 : n <= 14 && s <= 2;
  if (kind === "bar") {
    labelsIn.forEach((_, i) => {
      const gx = LM + i * slot + (slot - s * barW) / 2;
      series.forEach((se, j) => {
        const v = se.values[i]!;
        const top = yOf(Math.max(v, 0));
        const bottom = yOf(Math.min(v, 0));
        els.push(
          ...makeShape({
            x: gx + j * barW + 2,
            y: top,
            width: barW - 4,
            height: Math.max(1, bottom - top),
            backgroundColor: se.color,
            strokeColor: se.color,
            roughness: 0,
            rounded: false,
            ...extra,
          }),
        );
        if (showValues) {
          els.push(textAt(gx + j * barW + barW / 2, v >= 0 ? top - 19 : bottom + 4, fmtNumber(v) + unit, 12, TABLE_HEADER, extra));
        }
      });
    });
  } else {
    series.forEach((se) => {
      const pts = se.values.map((v, i) => ({ x: LM + (i + 0.5) * slot, y: yOf(v) }));
      if (pts.length > 1) {
        els.push(
          makeLine({
            x: pts[0]!.x,
            y: pts[0]!.y,
            points: pts.map((p) => [p.x - pts[0]!.x, p.y - pts[0]!.y] as [number, number]),
            strokeColor: se.color,
            strokeWidth: 3,
            roughness: 0,
            ...extra,
          }),
        );
      }
      pts.forEach((p, i) => {
        els.push(
          ...makeShape({
            shape: "ellipse",
            x: p.x - 6,
            y: p.y - 6,
            width: 12,
            height: 12,
            backgroundColor: se.color,
            strokeColor: se.color,
            roughness: 0,
            ...extra,
          }),
        );
        if (showValues) els.push(textAt(p.x, p.y - 25, fmtNumber(se.values[i]!) + unit, 12, TABLE_HEADER, extra));
      });
    });
  }
  let labelBottom = TOP + PH;
  labelsIn.forEach((l, i) => {
    const t = textAt(LM + (i + 0.5) * slot, TOP + PH + 10, wrapText(l, Math.max(6, Math.floor(slot / 8))), 13, TEXT_MUTED, extra);
    els.push(t);
    labelBottom = Math.max(labelBottom, TOP + PH + 10 + num(t.height));
  });
  if (spec.caption) {
    els.push(
      makeText({ x: LM, y: labelBottom + 14, text: wrapText(clean(spec.caption, 300), 70), fontSize: 13, fontFamily: SANS, strokeColor: TEXT_MUTED, ...extra }),
    );
  }
  const labels = new Map<string, string>();
  if (!spec.ref) labels.set(ref, clean(spec.title, 60));
  return blockOf(els, [[ref, els.map((e) => e.id)]], labels);
}

// ---------------------------------------------------------------------------------------------------------
// Stat cards

export interface StatCardSpec {
  ref?: string;
  value: string;
  label: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
  color?: string;
}

export function buildStatCards(ctx: BuildCtx, cards: StatCardSpec[], opts: { frameId?: string | null; title?: string } = {}): Block {
  const W = 230;
  const gap = 24;
  const perRow = Math.min(4, Math.max(1, cards.length));
  const els: SceneElement[] = [];
  const refs: [string, string[]][] = [];
  const labels = new Map<string, string>();
  let top = 0;
  if (opts.title) {
    const t = makeText({
      x: 0,
      y: 0,
      text: clean(opts.title, 120),
      fontSize: 22,
      fontFamily: SANS,
      strokeColor: TEXT_ON_DARK,
      frameId: opts.frameId ?? null,
      customData: ctx.mark(),
    });
    els.push(t);
    top = num(t.height) + 16;
  }
  // The trend line wraps inside the card (at most 2 lines, cut at a word with "…" past that), never past its edge.
  const deltaLines = (c: StatCardSpec) => {
    const raw = clean(c.delta, 200).replace(/\s+/g, " ");
    if (!raw) return [] as string[];
    const trend = c.trend ?? (/^[-−]/.test(raw) ? "down" : /^\+/.test(raw) ? "up" : "flat");
    const arrow = trend === "up" ? "▲ " : trend === "down" ? "▼ " : "";
    const lines = wrapText(arrow + raw, charsFor(W - 8, 13)).split("\n");
    if (lines.length <= 2) return lines;
    const second = lines[1]!;
    const room = charsFor(W - 8, 13) - 1;
    const cut = second.length > room ? second.slice(0, room).replace(/\s+\S*$/, "") : second;
    return [lines[0]!, `${cut.replace(/[\s,;:.·–—-]+$/, "")}…`];
  };
  const specs = cards.slice(0, 12).map((c) => ({ ...c, value: clean(c.value, 24), label: clean(c.label, 120), deltaText: deltaLines(c) }));
  const heights = specs.map((c) => 70 + lineCount(c.label, W - 8, 14) * 18 + (c.deltaText.length ? 8 + c.deltaText.length * 17 : 0) + 16);
  for (let r = 0; r * perRow < specs.length; r++) {
    const row = specs.slice(r * perRow, r * perRow + perRow);
    const H = Math.max(...heights.slice(r * perRow, r * perRow + perRow));
    row.forEach((c, k) => {
      const x = k * (W + gap);
      const y = top;
      const groupId = newId();
      const ref = c.ref || ctx.nextRef("k");
      if (!c.ref) labels.set(ref, `${c.value} ${c.label}`.slice(0, 60));
      // White cards by default (or a saturated fill when a color is given), no outline, dark text.
      const fill = c.color ? fillColor(c.color, FILLS.white) : FILLS.white!;
      const custom = ctx.mark({ ref, aiKind: "stat-card" });
      const common = { frameId: opts.frameId ?? null, groupIds: [groupId], customData: custom };
      const [box] = makeShape({
        x,
        y,
        width: W,
        height: H,
        backgroundColor: fill,
        strokeColor: fill,
        strokeWidth: 1,
        roughness: 0,
        roundness: ROUND,
        ...common,
      });
      let fontSize = 32;
      while (fontSize > 20 && measureText(c.value, fontSize).width > W - 32) fontSize -= 2;
      const value = makeText({ x: x + 16, y: y + 14, text: c.value, fontSize, fontFamily: SANS, strokeColor: TEXT_ON_FILL, ...common });
      const label = makeText({
        x: x + 16,
        y: y + 64,
        text: wrapText(c.label, charsFor(W - 8, 14)),
        fontSize: 14,
        fontFamily: SANS,
        strokeColor: TEXT_ON_FILL,
        opacity: 80,
        ...common,
      });
      const group = [box!, value, label];
      if (c.deltaText.length) {
        const first = c.deltaText[0]!;
        const trend = first.startsWith("▲") ? "up" : first.startsWith("▼") ? "down" : "flat";
        const color = fill === FILLS.white ? (trend === "up" ? "#2b8a3e" : trend === "down" ? "#c92a2a" : "#6b6b6b") : TEXT_ON_FILL;
        const text = c.deltaText.join("\n");
        const h = measureText(text, 13, 1.25, SANS).height;
        group.push(makeText({ x: x + 16, y: y + H - 16 - h, text, fontSize: 13, fontFamily: SANS, strokeColor: color, ...common }));
      }
      els.push(...group);
      refs.push([ref, group.map((e) => e.id)]);
    });
    top += H + gap;
  }
  return blockOf(els, refs, labels);
}

// ---------------------------------------------------------------------------------------------------------
// Suggestions ("find the gaps")

/**
 * A suggestion sticky. customData follows the web client's review conventions: `suggestion: true`,
 * `suggestionId` (the sticky, its label, and its dashed arrows are reviewed as one unit), an optional
 * `suggestionReason`, and `acceptStyle` (accepting turns it into a normal yellow sticky).
 */
export function buildSuggestion(
  ctx: BuildCtx,
  text: string,
  x: number,
  y: number,
  ref: string,
  frameId: string | null = null,
  extra: { suggestionId: string; reason?: string },
): SceneElement[] {
  const body = clean(text, 300);
  const size = itemSize({ text: body }, "sticky");
  const els = withRawLabel(
    makeSticky({
      x,
      y,
      width: size.w,
      height: size.h,
      text: body,
      color: SUGGESTION_FILL,
      strokeColor: SUGGESTION,
      labelColor: SUGGESTION_TEXT_ON_FILL,
      strokeStyle: "dashed",
      frameId,
      customData: ctx.mark({
        ref,
        suggestion: true,
        suggestionId: extra.suggestionId,
        ...(extra.reason ? { suggestionReason: clean(extra.reason, 200) } : {}),
      }),
    }),
    body,
  );
  els[0]!.strokeWidth = 2;
  els[0]!.customData = {
    ...(els[0]!.customData as Record<string, unknown>),
    acceptStyle: { strokeStyle: "solid", strokeColor: FILLS.yellow, strokeWidth: 1, backgroundColor: FILLS.yellow },
  };
  return els;
}

export function stickySize(text: string) {
  return itemSize({ text }, "sticky");
}

// ---------------------------------------------------------------------------------------------------------
// Tables (header + rows of text on the dark canvas, thin separators, no cell fills, grouped as one item)

export interface TableSpec {
  ref?: string;
  title?: string;
  columns: string[];
  rows: string[][];
}

const TABLE_MAX_COLS = 8;
const TABLE_MAX_ROWS = 40;

/** Cleans a table spec to sane bounds (also used when reading a table back from the board). */
export function normalizeTable(spec: TableSpec): TableSpec {
  const columns = (spec.columns ?? []).slice(0, TABLE_MAX_COLS).map((c) => clean(c, 80));
  const width = Math.max(columns.length, ...(spec.rows ?? []).map((r) => (Array.isArray(r) ? r.length : 0)), 1);
  const n = Math.min(TABLE_MAX_COLS, width);
  while (columns.length < n) columns.push("");
  const rows = (spec.rows ?? []).slice(0, TABLE_MAX_ROWS).map((r) => {
    const row = (Array.isArray(r) ? r : [r]).slice(0, n).map((c) => clean(c, 160));
    while (row.length < n) row.push("");
    return row;
  });
  return { ref: spec.ref, title: clean(spec.title, 120) || undefined, columns, rows };
}

/**
 * A table: optional title, a header row (bold-looking light text), body rows in muted text, thin separator
 * lines, no fills. Every part shares one group and customData { aiKind: "table-part", aiBlock }, and each cell
 * text records its position (customData.cell = [row, col]; header row = -1) so the table can be read back and
 * rebuilt in place.
 */
export function buildTable(ctx: BuildCtx, input: TableSpec, opts: { frameId?: string | null; groupId?: string } = {}): Block {
  const spec = normalizeTable(input);
  const groupId = opts.groupId ?? newId();
  const ref = spec.ref || ctx.nextRef("b");
  const part = (extra: Record<string, unknown> = {}) =>
    ctx.mark({ aiKind: "table-part", aiBlock: groupId, ...(spec.title ? { table: spec.title } : {}), ...extra });
  const common = { frameId: opts.frameId ?? null, groupIds: [groupId], fontFamily: SANS };
  const HEAD = 15;
  const BODY = 14;
  const padX = 14;
  const padY = 9;
  const n = spec.columns.length;
  // Column widths from content (single-line width), clamped; long cells wrap.
  const colW = spec.columns.map((h, c) => {
    const widest = Math.max(measureText(h, HEAD).width, ...spec.rows.map((r) => measureText(r[c] ?? "", BODY).width));
    return Math.min(300, Math.max(90, widest + padX * 2));
  });
  const colX: number[] = [];
  let acc = 0;
  for (const w of colW) {
    colX.push(acc);
    acc += w;
  }
  const totalW = acc;
  const els: SceneElement[] = [];
  let y = 0;
  if (spec.title) {
    const t = makeText({ x: 0, y: 0, text: spec.title, fontSize: 20, strokeColor: TEXT_ON_DARK, ...common, customData: part({ tableTitle: true }) });
    els.push(t);
    y = num(t.height) + 14;
  }
  const rowsAll = [spec.columns, ...spec.rows];
  rowsAll.forEach((row, r) => {
    const header = r === 0;
    const fs = header ? HEAD : BODY;
    const wrapped = row.map((cell, c) => wrapText(cell, Math.max(4, Math.floor((colW[c]! - padX * 2) / (fs * 0.62)))));
    const lines = Math.max(1, ...wrapped.map((w) => (w ? w.split("\n").length : 1)));
    const rowH = Math.ceil(lines * fs * 1.25 + padY * 2);
    wrapped.forEach((text, c) => {
      if (!text) return;
      els.push(
        makeText({
          x: colX[c]! + padX,
          y: y + padY,
          text,
          fontSize: fs,
          strokeColor: header ? TABLE_HEADER : TABLE_TEXT,
          ...common,
          customData: part({ cell: [r - 1, c] }),
        }),
      );
    });
    y += rowH;
    // Separator under every row (a slightly stronger one under the header).
    els.push(
      makeLine({
        x: 0,
        y,
        points: [
          [0, 0],
          [totalW, 0],
        ],
        strokeColor: header ? "#4a4a4a" : LINE,
        strokeWidth: 1,
        roughness: 0,
        frameId: opts.frameId ?? null,
        groupIds: [groupId],
        customData: part(),
      }),
    );
  });
  void n;
  const labels = new Map<string, string>();
  if (!spec.ref) labels.set(ref, spec.title || spec.columns.join(" | ").slice(0, 60));
  return blockOf(els, [[ref, els.map((e) => e.id)]], labels);
}

/** Reads a table's title, header, and rows back from its elements (by customData.cell). */
export function readTable(els: SceneElement[]): TableSpec {
  let title: string | undefined;
  const cells = new Map<string, string>();
  let maxRow = -1;
  let maxCol = -1;
  for (const e of els) {
    if (e.isDeleted || e.type !== "text") continue;
    const c = (e.customData ?? {}) as Record<string, unknown>;
    const text = String(e.originalText ?? e.text ?? "").replace(/\n/g, " ");
    if (c.tableTitle) title = text;
    const cell = c.cell as [number, number] | undefined;
    if (!Array.isArray(cell)) continue;
    cells.set(`${cell[0]}:${cell[1]}`, text);
    maxRow = Math.max(maxRow, cell[0]);
    maxCol = Math.max(maxCol, cell[1]);
  }
  const columns = Array.from({ length: maxCol + 1 }, (_, c) => cells.get(`-1:${c}`) ?? "");
  const rows = Array.from({ length: maxRow + 1 }, (_, r) => Array.from({ length: maxCol + 1 }, (_, c) => cells.get(`${r}:${c}`) ?? ""));
  return { title, columns, rows };
}
