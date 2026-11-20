// Server-side factories for Excalidraw (0.18) element JSON. Used by the board AI and templates so that
// generated content is ordinary, fully editable Excalidraw elements. Clients run restoreElements() on
// AI-sourced elements to refresh text dimensions and repair bindings.
import { lineWidthEm } from "./text-metrics";
import { generateKeyBetween } from "fractional-indexing";
import type { SceneElement } from "./messages";
import { DARK_PALETTE, SMALL_ROUNDNESS } from "./palette";

export const PALETTE = {
  ink: "#1e1e1e",
  stickyYellow: "#fff3bf",
  stickyGreen: "#d3f9d8",
  stickyBlue: "#d0ebff",
  stickyPink: "#ffdeeb",
  stickyOrange: "#ffe8cc",
  stickyPurple: "#e5dbff",
  sectionFill: "#f8f9fa",
  accent: "#4c6ef5",
  muted: "#868e96",
  suggestion: "#7048e8",
} as const;

/** Sticky note colors (the dark canvas fills). */
export const STICKY_COLORS = [
  DARK_PALETTE.FILLS.yellow,
  DARK_PALETTE.FILLS.blue,
  DARK_PALETTE.FILLS.green,
  DARK_PALETTE.FILLS.pink,
  DARK_PALETTE.FILLS.orange,
  DARK_PALETTE.FILLS.purple,
];

/** Excalidraw font families. 5 = Excalifont (hand-drawn), 6 = Nunito, 2 = Helvetica. */
export const FONT = { handDrawn: 5, normal: 6, mono: 8 } as const;

let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + counter.toString(36)).slice(0, 21);
}

function rand(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export interface BaseOpts {
  id?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch" | "zigzag";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: number;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  angle?: number;
  locked?: boolean;
  link?: string | null;
  customData?: Record<string, unknown>;
}

function base(type: string, o: BaseOpts): SceneElement {
  return {
    id: o.id ?? newId(),
    type,
    x: o.x,
    y: o.y,
    width: o.width ?? 0,
    height: o.height ?? 0,
    angle: o.angle ?? 0,
    strokeColor: o.strokeColor ?? PALETTE.ink,
    backgroundColor: o.backgroundColor ?? "transparent",
    fillStyle: o.fillStyle ?? "solid",
    strokeWidth: o.strokeWidth ?? 1,
    strokeStyle: o.strokeStyle ?? "solid",
    roughness: o.roughness ?? 1,
    opacity: o.opacity ?? 100,
    groupIds: o.groupIds ?? [],
    frameId: o.frameId ?? null,
    index: null,
    roundness: null,
    seed: rand(),
    version: 1,
    versionNonce: rand(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: o.link ?? null,
    locked: o.locked ?? false,
    ...(o.customData ? { customData: o.customData } : {}),
  };
}

/**
 * Text size from the fonts' real character widths (text-metrics.ts), with a small margin. Saved widths must not be
 * narrower than what browsers draw: Excalidraw clips text to its element's width.
 */
export function measureText(text: string, fontSize: number, lineHeight = 1.25, fontFamily: number = FONT.normal) {
  const lines = text.split("\n");
  // Browsers that hint small text round each character to whole pixels. In the fixed-width font every character
  // rounds the same way, so the error adds up along the line; allow half a pixel per character for it.
  const hinting = (line: string) => (fontFamily === FONT.mono ? 0.5 * [...line].length : 0);
  const px = Math.max(0.5 * fontSize, ...lines.map((l) => lineWidthEm(l, fontFamily) * fontSize + hinting(l)));
  return { width: Math.ceil(px * 1.03) + 2, height: Math.ceil(lines.length * fontSize * lineHeight) };
}

/** Greedy word wrap to a max character count per line. */
export function wrapText(text: string, maxChars: number): string {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + " " + word).trim().length > maxChars && line) {
        out.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface TextOpts extends BaseOpts {
  text: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  containerId?: string | null;
}

export function makeText(o: TextOpts): SceneElement {
  const fontSize = o.fontSize ?? 20;
  const dims = measureText(o.text, fontSize, 1.25, o.fontFamily ?? FONT.handDrawn);
  return {
    ...base("text", { ...o, width: o.width ?? dims.width, height: o.height ?? dims.height }),
    text: o.text,
    originalText: o.text,
    fontSize,
    fontFamily: o.fontFamily ?? FONT.handDrawn,
    textAlign: o.textAlign ?? "left",
    verticalAlign: o.verticalAlign ?? "top",
    containerId: o.containerId ?? null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

export type ShapeType = "rectangle" | "ellipse" | "diamond";

export interface ShapeOpts extends BaseOpts {
  shape?: ShapeType;
  label?: string;
  /** Label text color (defaults to strokeColor). */
  labelColor?: string;
  /** Explicit roundness (defaults to Excalidraw's adaptive radius unless rounded is false). */
  roundness?: { type: number; value?: number } | null;
  fontSize?: number;
  fontFamily?: number;
  rounded?: boolean;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
}

/** A shape, optionally with a bound (container) label. Returns [shape, label?]. */
export function makeShape(o: ShapeOpts): SceneElement[] {
  const shape = base(o.shape ?? "rectangle", {
    ...o,
    width: o.width ?? 200,
    height: o.height ?? 100,
  });
  if (o.rounded !== false && (o.shape ?? "rectangle") !== "ellipse") shape.roundness = o.roundness !== undefined ? o.roundness : { type: 3 };
  if (!o.label) return [shape];
  const fontSize = o.fontSize ?? 20;
  const w = shape.width as number;
  const h = shape.height as number;
  const wrapped = wrapText(o.label, Math.max(8, Math.floor((w - 20) / (fontSize * 0.62))));
  const dims = measureText(wrapped, fontSize);
  const lw = Math.min(dims.width, w - 10);
  // Center the label in its container: clients don't re-measure text when a scene is first loaded.
  const lx = o.textAlign === "left" ? o.x + 10 : o.x + (w - lw) / 2;
  const ly = o.verticalAlign === "top" ? o.y + 10 : o.verticalAlign === "bottom" ? o.y + h - dims.height - 10 : o.y + (h - dims.height) / 2;
  const label = makeText({
    text: wrapped,
    x: lx,
    y: ly,
    width: lw,
    height: dims.height,
    fontSize,
    fontFamily: o.fontFamily,
    textAlign: o.textAlign ?? "center",
    verticalAlign: o.verticalAlign ?? "middle",
    containerId: shape.id,
    groupIds: o.groupIds,
    frameId: o.frameId,
    strokeColor: o.labelColor ?? o.strokeColor,
    customData: o.customData,
  });
  shape.boundElements = [{ id: label.id, type: "text" }];
  return [shape, label];
}

export interface StickyOpts extends BaseOpts {
  text: string;
  color?: string;
  size?: number;
  /** Label color when it should differ from both the outline and the default dark text. */
  labelColor?: string;
}

/**
 * A sticky note in the dark-canvas style: a saturated fill with no visible outline (stroke = fill), a small
 * corner radius, and a dark sans-serif label.
 */
export function makeSticky(o: StickyOpts): SceneElement[] {
  const size = o.size ?? 180;
  const fill = o.color ?? DARK_PALETTE.FILLS.yellow;
  return makeShape({
    ...o,
    width: o.width ?? size,
    height: o.height ?? size,
    backgroundColor: fill,
    strokeColor: o.strokeColor ?? fill,
    strokeWidth: 1,
    roughness: 0,
    roundness: SMALL_ROUNDNESS,
    label: o.text,
    labelColor: o.labelColor ?? (o.strokeColor && o.strokeColor !== fill ? o.strokeColor : DARK_PALETTE.TEXT_ON_FILL),
    fontSize: 16,
    fontFamily: FONT.normal,
    customData: { kind: "sticky", ...(o.customData ?? {}) },
  });
}

export interface FrameOpts extends BaseOpts {
  name: string;
}

/** A section (Excalidraw frame). Children set frameId to the frame's id. */
export function makeFrame(o: FrameOpts): SceneElement {
  return {
    ...base("frame", { ...o, width: o.width ?? 600, height: o.height ?? 400, roughness: 0 }),
    name: o.name,
  };
}

export interface ArrowOpts extends BaseOpts {
  from?: SceneElement;
  to?: SceneElement;
  points?: [number, number][];
  label?: string;
  endArrowhead?: "arrow" | "triangle" | "dot" | "bar" | null;
  startArrowhead?: "arrow" | "triangle" | "dot" | "bar" | null;
}

function center(el: SceneElement) {
  return {
    x: (el.x as number) + (el.width as number) / 2,
    y: (el.y as number) + (el.height as number) / 2,
  };
}

/** Point where the segment from the element's center toward (tx,ty) leaves its bounding box, plus a gap. */
function edgePoint(el: SceneElement, tx: number, ty: number, gap = 8) {
  const c = center(el);
  const dx = tx - c.x;
  const dy = ty - c.y;
  const hw = (el.width as number) / 2 + gap;
  const hh = (el.height as number) / 2 + gap;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

function addBound(el: SceneElement, id: string, type: "arrow" | "text") {
  const list = (el.boundElements as { id: string; type: string }[] | null) ?? [];
  if (!list.some((b) => b.id === id)) list.push({ id, type });
  el.boundElements = list;
  el.version = (el.version as number) + 1;
}

/**
 * An arrow. When `from`/`to` are given, the arrow is bound to them (it stays attached when they move).
 * Mutates `from`/`to` to register the binding; include them in the same batch of changes.
 */
export function makeArrow(o: ArrowOpts): SceneElement[] {
  let start = { x: o.x, y: o.y };
  let end = { x: o.x + (o.width ?? 150), y: o.y + (o.height ?? 0) };
  if (o.from && o.to) {
    const ct = center(o.to);
    const cf = center(o.from);
    start = edgePoint(o.from, ct.x, ct.y);
    end = edgePoint(o.to, cf.x, cf.y);
  }
  const points: [number, number][] = o.points ?? [
    [0, 0],
    [end.x - start.x, end.y - start.y],
  ];
  const arrow: SceneElement = {
    ...base("arrow", {
      ...o,
      x: start.x,
      y: start.y,
      width: Math.abs(points[points.length - 1]![0]),
      height: Math.abs(points[points.length - 1]![1]),
      strokeWidth: o.strokeWidth ?? 2,
    }),
    roundness: { type: 2 },
    points,
    lastCommittedPoint: null,
    startBinding: o.from ? { elementId: o.from.id, focus: 0, gap: 8 } : null,
    endBinding: o.to ? { elementId: o.to.id, focus: 0, gap: 8 } : null,
    startArrowhead: o.startArrowhead ?? null,
    endArrowhead: o.endArrowhead === undefined ? "arrow" : o.endArrowhead,
    elbowed: false,
  };
  if (o.from) addBound(o.from, arrow.id, "arrow");
  if (o.to) addBound(o.to, arrow.id, "arrow");
  const out = [arrow];
  if (o.label) {
    const mid = { x: start.x + points[points.length - 1]![0] / 2, y: start.y + points[points.length - 1]![1] / 2 };
    const label = makeText({
      text: o.label,
      x: mid.x - 40,
      y: mid.y - 12,
      fontSize: 16,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: arrow.id,
      frameId: o.frameId,
      customData: o.customData,
    });
    arrow.boundElements = [{ id: label.id, type: "text" }];
    out.push(label);
  }
  return out;
}

export interface LineOpts extends BaseOpts {
  points: [number, number][];
}

export function makeLine(o: LineOpts): SceneElement {
  const last = o.points[o.points.length - 1] ?? [0, 0];
  return {
    ...base("line", { ...o, width: Math.abs(last[0]), height: Math.abs(last[1]) }),
    points: o.points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };
}

export interface ImageOpts extends BaseOpts {
  fileId: string;
}

export function makeImage(o: ImageOpts): SceneElement {
  return {
    ...base("image", { ...o, width: o.width ?? 400, height: o.height ?? 300 }),
    fileId: o.fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
  };
}

export interface EmbedOpts extends BaseOpts {
  url: string;
}

/** An embedded web page or video (YouTube, Vimeo, etc.). */
export function makeEmbed(o: EmbedOpts): SceneElement {
  return {
    ...base("embeddable", { ...o, width: o.width ?? 560, height: o.height ?? 315, link: o.url }),
    roundness: { type: 3 },
  };
}

/** Returns a copy of `el` marked as changed (version bump), with `patch` applied. */
export function bumpElement(el: SceneElement, patch: Record<string, unknown> = {}): SceneElement {
  return {
    ...el,
    ...patch,
    version: (el.version ?? 0) + 1,
    versionNonce: rand(),
    updated: Date.now(),
  };
}

/** Marks an element deleted (tombstone), the way Excalidraw deletes. */
export function deleteElement(el: SceneElement): SceneElement {
  return bumpElement(el, { isDeleted: true });
}

/**
 * Assigns fractional `index` keys to new elements so they sort after `afterIndex` (the current highest
 * index on the board). Mutates and returns `elements`.
 */
export function assignIndices(elements: SceneElement[], afterIndex: string | null): SceneElement[] {
  let prev = afterIndex;
  for (const el of elements) {
    try {
      const key = generateKeyBetween(prev, null);
      el.index = key;
      prev = key;
    } catch {
      el.index = null;
    }
  }
  return elements;
}

/** Highest valid fractional index among live elements (or null when the board is empty). */
export function maxIndex(elements: Iterable<SceneElement>): string | null {
  let best: string | null = null;
  for (const el of elements) {
    const idx = el.index;
    if (typeof idx === "string" && idx && (best === null || idx > best)) best = idx;
  }
  return best;
}

/** Axis-aligned bounds of a set of elements. */
export function boundsOf(elements: SceneElement[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    if (el.isDeleted) continue;
    const x = el.x as number;
    const y = el.y as number;
    const w = (el.width as number) || 0;
    const h = (el.height as number) || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Title for a board started from a prompt: the prompt's first line, cut at a word boundary with "…" when it's long
 * (never mid-word). The server recognizes this exact title as provisional and replaces it with the AI's own heading.
 */
export function boardTitleFromPrompt(prompt: string, max = 60): string {
  const line = (prompt.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  const chars = [...line];
  if (!line) return "Untitled board";
  if (chars.length <= max) return line;
  const head = chars.slice(0, max - 1).join("");
  const cut = head.replace(/[\s,;:.!?·–—-]+\S*$/, "");
  return `${(cut.length >= max * 0.5 ? cut : head).replace(/[\s,;:.!?·–—-]+$/, "")}…`;
}
