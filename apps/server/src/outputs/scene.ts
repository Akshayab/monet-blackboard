// Shared helpers for turning a board's Excalidraw elements into other formats (AI outlines, draw.io,
// Lucid, Miro, Excalidraw files). Works on plain element JSON from the realtime room.
import { boardFilesTable, db } from "@monet/db";
import { and, eq, inArray } from "drizzle-orm";
import { STICKY_COLORS, type SceneElement } from "@monet/board-protocol";

export interface BoardFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export type ItemKind = "sticky" | "rectangle" | "ellipse" | "diamond" | "text" | "frame" | "arrow" | "line" | "freedraw" | "image" | "embed" | "other";

const STICKY_SET = new Set(STICKY_COLORS.map((c) => c.toLowerCase()));

export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** A normalized view over the live (non-deleted) elements of a board. */
export class Scene {
  readonly elements: SceneElement[];
  readonly byId: Map<string, SceneElement>;
  /** Container id -> bound text element. */
  readonly boundText: Map<string, SceneElement>;

  constructor(elements: SceneElement[]) {
    this.elements = elements
      .filter((e) => e && !e.isDeleted)
      .sort((a, b) => {
        const ia = a.index ?? "";
        const ib = b.index ?? "";
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
    this.byId = new Map(this.elements.map((e) => [e.id, e]));
    this.boundText = new Map();
    for (const el of this.elements) {
      const cid = str(el.containerId);
      if (el.type === "text" && cid && this.byId.has(cid)) this.boundText.set(cid, el);
    }
  }

  /** Restricts the scene to a selection, pulling in bound labels, frame children, and arrow endpoints' labels. */
  subset(ids: string[] | null | undefined): Scene {
    if (!ids || ids.length === 0) return this;
    const keep = new Set<string>();
    const add = (id: string) => {
      if (keep.has(id) || !this.byId.has(id)) return;
      keep.add(id);
      const el = this.byId.get(id)!;
      const label = this.boundText.get(id);
      if (label) keep.add(label.id);
      const cid = str(el.containerId);
      if (el.type === "text" && cid) add(cid);
      if (el.type === "frame" || el.type === "magicframe") {
        for (const child of this.elements) if (child.frameId === id) add(child.id);
      }
    };
    for (const id of ids) add(id);
    return new Scene(this.elements.filter((e) => keep.has(e.id)));
  }

  /** True when the element is a label living inside another element (rendered as part of it). */
  isBoundLabel(el: SceneElement): boolean {
    const cid = str(el.containerId);
    return el.type === "text" && !!cid && this.byId.has(cid);
  }

  labelOf(el: SceneElement): string {
    const t = this.boundText.get(el.id);
    return t ? textOf(t) : "";
  }

  kindOf(el: SceneElement): ItemKind {
    switch (el.type) {
      case "rectangle": {
        const custom = el.customData as Record<string, unknown> | undefined;
        if (custom?.kind === "sticky") return "sticky";
        const bg = String(el.backgroundColor ?? "").toLowerCase();
        if (STICKY_SET.has(bg) && this.boundText.has(el.id) && num(el.roughness, 1) === 0) return "sticky";
        return "rectangle";
      }
      case "ellipse":
      case "diamond":
      case "text":
      case "arrow":
      case "line":
      case "freedraw":
      case "image":
        return el.type;
      case "frame":
      case "magicframe":
        return "frame";
      case "embeddable":
      case "iframe":
        return "embed";
      default:
        return "other";
    }
  }

  /** Elements outside any frame, plus frames, in z-order. */
  frames(): SceneElement[] {
    return this.elements.filter((e) => this.kindOf(e) === "frame");
  }

  childrenOf(frameId: string): SceneElement[] {
    return this.elements.filter((e) => e.frameId === frameId && !this.isBoundLabel(e));
  }

  /** Top-level items (not bound labels). */
  items(): SceneElement[] {
    return this.elements.filter((e) => !this.isBoundLabel(e));
  }

  fileIds(): string[] {
    return [
      ...new Set(
        this.elements
          .filter((e) => e.type === "image")
          .map((e) => str(e.fileId))
          .filter((x): x is string => !!x),
      ),
    ];
  }
}

export function textOf(el: SceneElement): string {
  return String(el.originalText ?? el.text ?? "").trim();
}

export function frameName(el: SceneElement): string {
  const title = (el.customData as Record<string, unknown> | undefined)?.sectionTitle;
  return (str(el.name) ?? "").trim() || (typeof title === "string" ? title.trim() : "") || "Section";
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boxOf(el: SceneElement): Box {
  return { x: num(el.x), y: num(el.y), w: Math.max(1, Math.abs(num(el.width))), h: Math.max(1, Math.abs(num(el.height))) };
}

/** Absolute points of a linear element (arrow/line/freedraw). */
export function absPoints(el: SceneElement): [number, number][] {
  const pts = Array.isArray(el.points) ? (el.points as unknown[]) : [];
  const x = num(el.x);
  const y = num(el.y);
  const out: [number, number][] = [];
  for (const p of pts) {
    if (Array.isArray(p) && p.length >= 2) out.push([x + num(p[0]), y + num(p[1])]);
  }
  if (out.length === 0) out.push([x, y], [x + num(el.width), y + num(el.height)]);
  return out;
}

export function bindingId(v: unknown): string | null {
  if (v && typeof v === "object" && "elementId" in v) return str((v as { elementId: unknown }).elementId);
  return null;
}

/** Drops points closer than `minDist` to the previous kept point (keeps the last point). */
export function simplify(points: [number, number][], minDist = 6, maxPoints = 200): [number, number][] {
  if (points.length <= 2) return points;
  let out: [number, number][] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = out[out.length - 1]!;
    const [x, y] = points[i]!;
    if (Math.hypot(x - px, y - py) >= minDist) out.push([x, y]);
  }
  out.push(points[points.length - 1]!);
  if (out.length > maxPoints) {
    const step = Math.ceil(out.length / maxPoints);
    out = out.filter((_, i) => i % step === 0 || i === out.length - 1);
  }
  return out;
}

export function isTransparent(color: unknown): boolean {
  const c = String(color ?? "")
    .trim()
    .toLowerCase();
  return !c || c === "transparent" || c === "none" || /^#[0-9a-f]{6}00$/.test(c) || /^#[0-9a-f]{3}0$/.test(c);
}

/** Normalizes a CSS color to #rrggbb (falls back for named/unknown colors). */
export function hexColor(color: unknown, fallback = "#1e1e1e"): string {
  const c = String(color ?? "")
    .trim()
    .toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{8}$/.test(c)) return c.slice(0, 7);
  if (/^#[0-9a-f]{3}$/.test(c))
    return (
      "#" +
      c
        .slice(1)
        .split("")
        .map((ch) => ch + ch)
        .join("")
    );
  const named: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#e03131", blue: "#1971c2", green: "#2f9e44" };
  return named[c] ?? fallback;
}

/** A friendly name for common board colors (used in AI outlines). */
export function colorName(color: unknown): string | null {
  const c = hexColor(color, "");
  if (!c) return null;
  const map: Record<string, string> = {
    "#fff3bf": "yellow",
    "#ffec99": "yellow",
    "#d3f9d8": "green",
    "#b2f2bb": "green",
    "#d0ebff": "blue",
    "#a5d8ff": "blue",
    "#ffdeeb": "pink",
    "#ffc9c9": "red",
    "#ffe8cc": "orange",
    "#ffd8a8": "orange",
    "#e5dbff": "purple",
    "#d0bfff": "purple",
    "#f8f9fa": "gray",
    "#e9ecef": "gray",
    "#ffffff": "white",
  };
  return map[c] ?? c;
}

export async function loadBoardFiles(boardId: string, fileIds: string[]): Promise<Map<string, BoardFile>> {
  const out = new Map<string, BoardFile>();
  if (fileIds.length === 0) return out;
  const ids = [...new Set(fileIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select()
      .from(boardFilesTable)
      .where(and(eq(boardFilesTable.boardId, boardId), inArray(boardFilesTable.fileId, ids.slice(i, i + 500))));
    for (const r of rows) out.set(r.fileId, { id: r.fileId, mimeType: r.mimeType, dataURL: r.dataUrl, created: r.createdAt.getTime() });
  }
  return out;
}

/** Splits a data URL into mime type and raw bytes. */
export function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer; base64: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mimeType = m[1]!;
  if (m[2]) return { mimeType, bytes: Buffer.from(m[3]!, "base64"), base64: m[3]! };
  const bytes = Buffer.from(decodeURIComponent(m[3]!), "utf8");
  return { mimeType, bytes, base64: bytes.toString("base64") };
}

export function extForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  return map[mime] ?? "bin";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Safe file name stem from a title. */
export function fileStem(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return s || "board";
}
