// Executes the board AI's tool calls: builds elements, finds clean free space for them, applies them live
// (in small chunks, with the AI's cursor moving where it draws), and edits existing elements in place.
import {
  BOARD_LIMIT_MESSAGE,
  DARK_PALETTE,
  fitBoardLimits,
  makeEmbed,
  makeText,
  measureText,
  wrapText,
  type SceneElement,
  LIVE_EMBED_HOST,
} from "@monet/board-protocol";
import { ILLUSTRATION_SUBJECTS, PEOPLE_REFUSAL, buildIllustration, resolveSubject } from "./illustrations";
import { broadcastToBoard, getBoardElements } from "../realtime/rooms";
import { applyAiChanges } from "./apply";
import {
  arrangeBoxes,
  arrowBetween,
  blockOf,
  buildChart,
  buildItems,
  buildSection,
  buildStatCards,
  buildSuggestion,
  buildTable,
  buildText,
  buildTimeline,
  charsFor,
  clean,
  combineBlocks,
  itemSize,
  readTable,
  stickyHeightFor,
  stickySize,
  twoLineCardHeight,
  type ArrowHead,
  type Block,
  type BuildCtx,
  type ChartSpec,
  type ItemKind,
  type ItemSpec,
  type Layout,
  type SectionSpec,
  type StatCardSpec,
  type TableSpec,
  type TimelineSpec,
} from "./builders";
import { isSticky, type BoardIndex } from "./context";
import { Draft, isBoundText, isFrame } from "./draft";
import { obstacleRects, routeElbow } from "./elbow";
import { FRAME_LABEL_SPACE, centerOf, contains, findFreeSpot, num, occupiedRectOf, rectOf, translate, union, type Point, type Rect } from "./geometry";
import { sleepUnlessStopped, throwIfStopped } from "./runs";
import { SANS, TEXT_MUTED, TEXT_SIZES, fillColor, strongColor, textOn, type TextSize } from "./style";

export type Side = "right" | "below" | "left" | "above" | "over";

export class BoardLimitError extends Error {
  constructor() {
    super(BOARD_LIMIT_MESSAGE);
    this.name = "BoardLimitError";
  }
}
export type ToolResult = Record<string, unknown>;

interface Unit {
  /** The element arrows and recolors target (a card's rectangle, a sticky). */
  lead: SceneElement;
  ids: string[];
  rect: Rect;
}

/** Comment pins and vote stickers: they follow their item and are never laid out themselves. */
function isPin(el: SceneElement): boolean {
  const k = (el.customData as Record<string, unknown> | undefined)?.kind;
  return k === "comment" || k === "vote";
}

type EmbedKind = "poll" | "timer" | "calculator" | "prototype" | "custom";
const EMBED_KINDS: EmbedKind[] = ["poll", "timer", "calculator", "prototype", "custom"];
const EMBED_SIZES: Record<EmbedKind, { w: number; h: number }> = {
  poll: { w: 360, h: 300 },
  timer: { w: 280, h: 200 },
  calculator: { w: 300, h: 400 },
  prototype: { w: 480, h: 360 },
  custom: { w: 480, h: 360 },
};
const EMBED_TITLES: Record<EmbedKind, string> = { poll: "Poll", timer: "Timer", calculator: "Calculator", prototype: "Prototype", custom: "Live embed" };
const EMBED_HTML_MAX = 16_000;
/** Anything that would reach the network from a sealed embed. */
const EMBED_NETWORK =
  /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|importScripts|<\s*(iframe|object|embed|frame)\b|<\s*(script|img|link|source|video|audio)\b[^>]*\b(src|href)\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\/|@import/i;

/** A section's heading or subtitle text (it stays with the section when content moves). */
function isSectionLabel(el: SceneElement | undefined): boolean {
  const c = (el?.customData ?? {}) as Record<string, unknown>;
  return typeof c.sectionHeading === "string" || typeof c.sectionSubtitle === "string";
}

interface Placement {
  section?: string;
  near?: string;
  side?: Side;
}

/** Areas each in-flight run has claimed on a board, so concurrent runs don't draw on top of each other. */
const reservations = new Map<string, Map<string, Rect[]>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EditorOptions {
  viewport: Rect | null;
  focusRect: Rect | null;
  live: boolean;
  /** Stream changes in small chunks with short pauses (off for tests). */
  pace: boolean;
  /** Called before each batch is drawn, with the area this run is working in (scene coordinates). */
  onDrawing: (message: string, region: Rect | null) => void;
  /** Aborted when someone stops the run: drawing stops after the current chunk (placed elements stay). */
  signal?: AbortSignal;
}

function segmentHitsRect(p: Point, q: Point, r: Rect): boolean {
  const inside = (pt: Point) => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
  if (inside(p) || inside(q)) return true;
  // Liang-Barsky clipping of the segment against the rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const edges: [number, number][] = [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ];
  for (const [pp, qq] of edges) {
    if (pp === 0) {
      if (qq < 0) return false;
      continue;
    }
    const t = qq / pp;
    if (pp < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 < t1;
}

function edgeToward(el: SceneElement, toward: Point, gap = 8): Point {
  const c = { x: num(el.x) + num(el.width) / 2, y: num(el.y) + num(el.height) / 2 };
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const scale = Math.min((num(el.width) / 2 + gap) / Math.abs(dx || 1e-9), (num(el.height) / 2 + gap) / Math.abs(dy || 1e-9));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/**
 * Bends a bound arrow around items it would otherwise cross: tries a single bend point offset to either side
 * of the straight line, farther out each time. Leaves the arrow straight when nothing is in the way.
 */
export function routeAround(arrow: SceneElement, label: SceneElement | undefined, from: SceneElement, to: SceneElement, obstacles: Rect[]) {
  const shrink = (r: Rect): Rect => ({ x: r.x + 4, y: r.y + 4, w: Math.max(0, r.w - 8), h: Math.max(0, r.h - 8) });
  const obs = obstacles.map(shrink);
  const clear = (pts: Point[]) => {
    for (let i = 0; i + 1 < pts.length; i++) for (const o of obs) if (segmentHitsRect(pts[i]!, pts[i + 1]!, o)) return false;
    return true;
  };
  const cf = { x: num(from.x) + num(from.width) / 2, y: num(from.y) + num(from.height) / 2 };
  const ct = { x: num(to.x) + num(to.width) / 2, y: num(to.y) + num(to.height) / 2 };
  const start = { x: num(arrow.x), y: num(arrow.y) };
  const pts = arrow.points as [number, number][];
  const last = pts[pts.length - 1]!;
  if (clear([start, { x: start.x + last[0], y: start.y + last[1] }])) return;
  const len = Math.hypot(ct.x - cf.x, ct.y - cf.y) || 1;
  const px = -(ct.y - cf.y) / len;
  const py = (ct.x - cf.x) / len;
  const mid0 = { x: (cf.x + ct.x) / 2, y: (cf.y + ct.y) / 2 };
  for (let k = 1; k <= 12; k++) {
    for (const sign of [1, -1]) {
      const mid = { x: mid0.x + px * k * 45 * sign, y: mid0.y + py * k * 45 * sign };
      const a = edgeToward(from, mid);
      const b = edgeToward(to, mid);
      if (!clear([a, mid, b])) continue;
      arrow.x = a.x;
      arrow.y = a.y;
      arrow.points = [
        [0, 0],
        [mid.x - a.x, mid.y - a.y],
        [b.x - a.x, b.y - a.y],
      ];
      const xs = [0, mid.x - a.x, b.x - a.x];
      const ys = [0, mid.y - a.y, b.y - a.y];
      arrow.width = Math.max(...xs) - Math.min(...xs);
      arrow.height = Math.max(...ys) - Math.min(...ys);
      if (label) {
        label.x = mid.x - num(label.width) / 2;
        label.y = mid.y - num(label.height) / 2;
      }
      return;
    }
  }
  // No single bend gets around (a dense grid of cards): use a right-angle path when one crosses nothing.
  routeElbow(arrow, label, from, to, obstacles, { onlyIfClear: true });
}

/** Does the arrow's path (its points, for a curve the control polyline) run through any of the boxes? */
function crossesItems(arrow: SceneElement, obstacles: Rect[]): boolean {
  const pts = ((arrow.points as [number, number][]) ?? []).map((p) => ({ x: num(arrow.x) + p[0], y: num(arrow.y) + p[1] }));
  const obs = obstacles.map((r) => ({ x: r.x + 4, y: r.y + 4, w: Math.max(0, r.w - 8), h: Math.max(0, r.h - 8) }));
  for (let i = 0; i + 1 < pts.length; i++) for (const o of obs) if (segmentHitsRect(pts[i]!, pts[i + 1]!, o)) return true;
  return false;
}

function normText(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export class BoardEditor {
  readonly created = new Set<string>();
  readonly updated = new Set<string>();
  readonly deleted = new Set<string>();
  readonly ctx: BuildCtx;
  private seq = 0;
  private lastPlaced: Rect | null = null;
  private pointer: Point | null = null;
  /** The area this run reserved or changed so far (for the client's working outline). */
  region: Rect | null = null;
  /** Set when a change was refused because the board is at its size limit. */
  limitHit = false;
  /** Changes to locked items the run tried and skipped (people lock things so nothing moves them). */
  lockedSkipped = 0;

  constructor(
    readonly boardId: string,
    readonly runId: string,
    readonly index: BoardIndex,
    readonly opts: EditorOptions,
  ) {
    this.ctx = {
      nextRef: (prefix = "n") => this.nextRef(prefix),
      mark: (extra = {}) => ({ createdBy: "ai", aiRun: runId, ...extra }),
    };
  }

  get socketId() {
    return `ai-${this.runId}`;
  }

  nextRef(prefix = "n"): string {
    let r: string;
    do r = `${prefix}${++this.seq}`;
    while (this.index.handles.has(r));
    return r;
  }

  /** Registers model-chosen refs for new elements. Returns ref renames when a ref was already taken. */
  private register(refs: [string, string[]][]): Record<string, string> {
    const renamed: Record<string, string> = {};
    for (const [ref, ids] of refs) {
      let r = ref;
      if (this.index.handles.has(r)) {
        let i = 2;
        while (this.index.handles.has(`${ref}_${i}`)) i++;
        r = `${ref}_${i}`;
        renamed[ref] = r;
      }
      this.index.handles.set(r, ids);
      for (const id of ids) if (!this.index.handleOf.has(id)) this.index.handleOf.set(id, r);
    }
    return renamed;
  }

  private async liveMap(): Promise<Map<string, SceneElement>> {
    const els = await getBoardElements(this.boardId);
    return new Map(els.filter((e) => !e.isDeleted).map((e) => [e.id, e]));
  }

  /** Element ids for a handle/ref (or a raw element id). */
  resolve(handle: unknown, live: Map<string, SceneElement>): string[] {
    if (typeof handle !== "string" || !handle) return [];
    const h = handle.trim();
    const ids = this.index.handles.get(h) ?? (live.has(h) ? [h] : []);
    return ids.filter((id) => live.has(id));
  }

  /** The main element behind a handle (a shape rather than its label). */
  primary(handle: unknown, live: Map<string, SceneElement>): SceneElement | undefined {
    const ids = this.resolve(handle, live);
    const els = ids.map((id) => live.get(id)!);
    return els.find((e) => !isBoundText(e, live)) ?? els[0];
  }

  private sectionFrame(handle: string | undefined, live: Map<string, SceneElement>): SceneElement | undefined {
    if (!handle) return undefined;
    const el = this.primary(handle, live);
    if (isFrame(el)) return el;
    if (el && typeof el.frameId === "string") return live.get(el.frameId);
    return undefined;
  }

  private addRegion(r: Rect | null) {
    if (!r) return;
    this.region = union([...(this.region ? [this.region] : []), r]);
  }

  /**
   * Where this run will most likely draw, before the model has decided anything: the focused area (padded),
   * or a free spot near the viewport / existing content sized for a typical answer.
   */
  async estimateRegion(): Promise<Rect> {
    if (this.opts.focusRect) {
      const f = this.opts.focusRect;
      return { x: f.x - 40, y: f.y - 40, w: f.w + 80, h: f.h + 80 };
    }
    const live = await this.liveMap();
    const size = { w: 960, h: 560 };
    const spot = findFreeSpot(size, this.occupied(live.values()), this.defaultAnchor(live));
    return { x: spot.x, y: spot.y, ...size };
  }

  private reserve(rect: Rect) {
    this.addRegion(rect);
    const board = reservations.get(this.boardId) ?? new Map<string, Rect[]>();
    board.set(this.runId, [...(board.get(this.runId) ?? []), rect]);
    reservations.set(this.boardId, board);
  }

  release() {
    const board = reservations.get(this.boardId);
    board?.delete(this.runId);
    if (board && !board.size) reservations.delete(this.boardId);
  }

  private occupied(elements: Iterable<SceneElement>, exclude: Set<string> = new Set()): Rect[] {
    const out: Rect[] = [];
    for (const el of elements) {
      if (el.isDeleted || exclude.has(el.id)) continue;
      if (el.type === "text" && el.containerId) continue;
      out.push(occupiedRectOf(el));
    }
    for (const [run, rects] of reservations.get(this.boardId) ?? []) if (run !== this.runId) out.push(...rects);
    return out;
  }

  /** Items arrows should avoid crossing (not sections, lines, arrows, or labels). */
  private obstacles(elements: Iterable<SceneElement>, exclude: Set<string>): Rect[] {
    const out: Rect[] = [];
    for (const el of elements) {
      if (el.isDeleted || exclude.has(el.id) || isFrame(el)) continue;
      if (el.type === "arrow" || el.type === "line" || el.type === "freedraw") continue;
      if (el.type === "text" && el.containerId) continue;
      out.push(rectOf(el));
    }
    return out;
  }

  private rectOfHandle(handle: string, live: Map<string, SceneElement>): Rect | null {
    return union(
      this.resolve(handle, live)
        .map((id) => live.get(id)!)
        .filter((e) => !isBoundText(e, live))
        .map(occupiedRectOf),
    );
  }

  private defaultAnchor(live: Map<string, SceneElement>): Point {
    if (this.lastPlaced) return { x: this.lastPlaced.x, y: this.lastPlaced.y + this.lastPlaced.h + 100 };
    if (this.opts.focusRect) return { x: this.opts.focusRect.x + this.opts.focusRect.w + 120, y: this.opts.focusRect.y };
    // The viewport's top-left is the anchor (the canvas sends the drop point there for file drops).
    if (this.opts.viewport) return { x: this.opts.viewport.x + 40, y: this.opts.viewport.y + 40 };
    const content = union([...live.values()].filter((e) => !(e.type === "text" && e.containerId)).map(occupiedRectOf));
    return content ? { x: content.x + content.w + 160, y: content.y } : { x: 0, y: 0 };
  }

  private anchorFor(size: { w: number; h: number }, place: Placement, live: Map<string, SceneElement>): Point {
    const target = place.near ? this.rectOfHandle(place.near, live) : null;
    if (!target) return this.defaultAnchor(live);
    const gap = 100;
    switch (place.side ?? "right") {
      case "over":
        return { x: target.x, y: target.y };
      case "below":
        return { x: target.x, y: target.y + target.h + gap };
      case "left":
        return { x: target.x - size.w - gap, y: target.y };
      case "above":
        return { x: target.x, y: target.y - size.h - gap };
      default:
        return { x: target.x + target.w + gap, y: target.y };
    }
  }

  movePointer(x: number, y: number) {
    this.pointer = { x, y };
    broadcastToBoard(this.boardId, { t: "pointer", socketId: this.socketId, x, y, tool: "pointer", button: "up" });
  }

  /** Applies elements live, a few at a time, moving the AI's cursor to each chunk. */
  async commit(elements: SceneElement[], label: string) {
    if (!elements.length) return;
    throwIfStopped(this.opts.signal);
    // Locked items (and their labels) are off limits: skip any change to them, including moves and deletes.
    {
      const live = await this.liveMap();
      const locked = (id: string): boolean => {
        const e = live.get(id);
        if (!e) return false;
        if (e.locked) return true;
        return e.type === "text" && !!e.containerId && !!live.get(e.containerId as string)?.locked;
      };
      const kept = elements.filter((e) => !locked(e.id));
      if (kept.length < elements.length) {
        this.lockedSkipped += elements.filter((e) => locked(e.id) && !(e.type === "text" && e.containerId)).length;
        elements = kept;
        if (!elements.length) return;
      }
    }
    // Board limits (800 live elements / 2 MB): refuse the whole change rather than leave half a block.
    const all = await getBoardElements(this.boardId);
    if (fitBoardLimits(new Map(all.map((e) => [e.id, e])), elements).refused.length) {
      this.limitHit = true;
      throw new BoardLimitError();
    }
    this.addRegion(union(elements.filter((e) => !e.isDeleted && !(e.type === "text" && e.containerId)).map(occupiedRectOf)));
    this.opts.onDrawing(label, this.region);
    const before = await this.liveMap();
    // Units: an element plus its bound labels (which directly follow it).
    const units: SceneElement[][] = [];
    for (const el of elements) {
      const prev = units[units.length - 1];
      if (prev && el.type === "text" && el.containerId && prev.some((p) => p.id === el.containerId)) prev.push(el);
      else units.push([el]);
    }
    const chunk = this.opts.pace ? Math.max(3, Math.ceil(units.length / 14)) : units.length;
    for (let i = 0; i < units.length; i += chunk) {
      if (i > 0) throwIfStopped(this.opts.signal);
      const part = units.slice(i, i + chunk).flat();
      const visible = part.filter((e) => !e.isDeleted && !(e.type === "text" && e.containerId));
      const r = union(visible.map(rectOf));
      if (r) this.movePointer(r.x + r.w / 2, r.y + r.h / 2);
      const accepted = await applyAiChanges(this.boardId, part, this.runId);
      for (const el of accepted) {
        if (isBoundText(el)) continue;
        if (el.isDeleted) {
          this.deleted.add(el.id);
          this.created.delete(el.id);
        } else if (before.has(el.id) || this.created.has(el.id)) {
          if (!this.created.has(el.id)) this.updated.add(el.id);
        } else this.created.add(el.id);
      }
      if (this.opts.pace && i + chunk < units.length) await sleepUnlessStopped(70, this.opts.signal);
    }
  }

  /** Puts a block (built at origin) into free space, or into a section, and applies it. */
  private async place(block: Block, place: Placement, label: string): Promise<{ renamed: Record<string, string>; rect: Rect }> {
    const live = await this.liveMap();
    const frame = this.sectionFrame(place.section, live);
    const hasFrame = block.elements.some((e) => isFrame(e));
    if (frame && !hasFrame) {
      const draft = new Draft(live);
      const pad = 40;
      const kids = draft.childBounds(frame.id);
      const x = num(frame.x) + pad;
      const y = kids ? kids.y + kids.h + 40 : num(frame.y) + pad;
      translate(block.elements, x - block.rect.x, y - block.rect.y);
      for (const el of block.elements) {
        if (!el.frameId) el.frameId = frame.id;
        draft.add(el);
      }
      const rect = { x, y, w: block.rect.w, h: block.rect.h };
      draft.growFrameToFit(frame.id, rect, pad);
      this.reserve(rect);
      this.polishArrows(draft);
      const frameEdits = draft.values().filter((e) => !block.elements.includes(e));
      await this.commit([...frameEdits, ...block.elements], label);
      return { renamed: this.register(block.refs), rect };
    }
    const anchorPlace = frame && hasFrame ? { near: place.section, side: "below" as Side } : place;
    const size = { w: block.rect.w, h: block.rect.h };
    // "over" draws where the target is (it's about to be replaced), so the target doesn't count as occupied.
    const replacing = anchorPlace.side === "over" && anchorPlace.near ? new Set(this.resolve(anchorPlace.near, live)) : new Set<string>();
    const spot = findFreeSpot(size, this.occupied(live.values(), replacing), this.anchorFor(size, anchorPlace, live));
    translate(block.elements, spot.x - block.rect.x, spot.y - block.rect.y);
    const rect = { x: spot.x, y: spot.y, ...size };
    this.reserve(rect);
    this.lastPlaced = rect;
    await this.commit(block.elements, label);
    return { renamed: this.register(block.refs), rect };
  }

  private refsResult(block: Block, renamed: Record<string, string>) {
    const out: Record<string, unknown> = {};
    const auto = [...block.labels].map(([ref, text]) => ({ ref: renamed[ref] ?? ref, text }));
    if (auto.length) out.new_refs = auto.slice(0, 80);
    if (Object.keys(renamed).length) out.renamed_refs = renamed;
    return out;
  }

  // ------------------------------------------------------------------------------------------------------
  // Creation tools

  async addItems(
    input: {
      items: ItemSpec[];
      defaultKind: ItemKind;
      layout?: Layout;
      columns?: number;
      connect_in_order?: boolean;
    } & Placement,
  ): Promise<ToolResult> {
    let items = (input.items ?? []).filter((s) => s && clean(s.text)).slice(0, 120);
    let skipped = 0;
    if (this.opts.live && items.length) {
      const live = await this.liveMap();
      const existing = new Set<string>();
      for (const el of live.values()) {
        const t = el.type === "text" ? String(el.originalText ?? el.text ?? "") : "";
        if (t) existing.add(normText(t));
      }
      const before = items.length;
      items = items.filter((s) => !existing.has(normText(s.text)));
      skipped = before - items.length;
    }
    if (!items.length) return { ok: true, added: 0, skipped_duplicates: skipped };
    const live = await this.liveMap();
    const frame = this.sectionFrame(input.section, live);
    const built = buildItems(this.ctx, items, input.defaultKind, input.layout ?? (input.defaultKind === "sticky" ? "grid" : "row"), input.columns, {
      connectInOrder: input.connect_in_order,
      defaultColor: frame ? this.sectionColor(frame, live) : undefined,
    });
    const block = blockOf(built.elements, built.refs, built.labels);
    const kind = input.defaultKind === "sticky" ? "stickies" : input.defaultKind === "text" ? "text" : "shapes";
    const { renamed } = await this.place(block, input, `Adding ${items.length} ${items.length === 1 ? kind.replace(/ies$/, "y").replace(/s$/, "") : kind}`);
    return { ok: true, added: items.length, ...(skipped ? { skipped_duplicates: skipped } : {}), ...this.refsResult(block, renamed) };
  }

  /** The sticky color already used in a section (so added notes match). */
  private sectionColor(frame: SceneElement, live: Map<string, SceneElement>): string | undefined {
    for (const el of live.values()) if (el.frameId === frame.id && isSticky(el)) return String(el.backgroundColor);
    return undefined;
  }

  async addText(input: { text: string; size?: TextSize; subtitle?: string; color?: string; link?: string; ref?: string } & Placement): Promise<ToolResult> {
    const size: TextSize = input.size && input.size in TEXT_SIZES ? input.size : "normal";
    const ref = input.ref || this.nextRef("t");
    const el = buildText(this.ctx, input.text, size, 0, 0, { color: input.color, link: input.link, ref });
    const els = [el];
    // A heading with a lighter subtitle line under it (separate texts, so each stays editable).
    if (input.subtitle && clean(input.subtitle) && TEXT_SIZES[size] >= 24) {
      els.push(buildText(this.ctx, input.subtitle, "subtitle", 2, num(el.y) + num(el.height) + 8, { custom: { subtitleOf: el.id } }));
    }
    const block = blockOf(els, [[ref, els.map((e) => e.id)]], input.ref ? new Map() : new Map([[ref, clean(input.text, 60)]]));
    const { renamed } = await this.place(block, input, "Adding text");
    return { ok: true, ...this.refsResult(block, renamed), ref: renamed[ref] ?? ref };
  }

  async addCard(input: { title?: string; body: string; color?: string; ref?: string; wide?: boolean } & Placement): Promise<ToolResult> {
    const ref = input.ref || this.nextRef("n");
    const spec: ItemSpec = { ref, kind: "card", text: input.body, title: input.title, color: input.color };
    const size = itemSize(spec, "card");
    if (input.wide) {
      size.w = 520;
      size.h = Math.max(110, Math.ceil(size.h * 0.7));
    }
    const built = buildItems(this.ctx, [spec], "card", "row", 1);
    const shape = built.elements[0]!;
    shape.width = size.w;
    shape.height = size.h;
    const block = blockOf(built.elements, built.refs, input.ref ? new Map() : new Map([[ref, clean(input.title || input.body, 60)]]));
    const draftLike = new Draft(new Map());
    for (const el of block.elements) draftLike.add(el);
    draftLike.layoutLabel(shape.id);
    const { renamed } = await this.place(blockOf(draftLike.values(), block.refs, block.labels), input, "Adding a card");
    return { ok: true, ref: renamed[ref] ?? ref };
  }

  async addSections(
    input: {
      sections: SectionSpec[];
      arrangement?: "row" | "column" | "grid" | "auto";
      connections?: ConnectionSpec[];
    } & Placement,
  ): Promise<ToolResult> {
    const specs = (input.sections ?? []).filter((s) => s && (s.name || s.items?.length)).slice(0, 16);
    if (!specs.length) return { ok: false, error: "No sections given." };
    const live = await this.liveMap();
    const existingFrames = [...live.values()].filter(isFrame).length;
    const blocks = specs.map((s, i) => buildSection(this.ctx, s, existingFrames + i));
    const block = combineBlocks(blocks, input.arrangement ?? "auto");
    const items = specs.reduce((n, s) => n + (s.items?.length ?? 0), 0);
    const { renamed } = await this.place(block, { near: input.near, side: input.side }, `Laying out ${specs.length} section${specs.length === 1 ? "" : "s"}`);
    const out: ToolResult = { ok: true, sections: specs.length, items, ...this.refsResult(block, renamed) };
    if (input.connections?.length) Object.assign(out, await this.connect({ connections: input.connections }));
    return out;
  }

  async addTimeline(input: TimelineSpec & Placement): Promise<ToolResult> {
    if (!input.milestones?.length) return { ok: false, error: "A timeline needs milestones." };
    const block = buildTimeline(this.ctx, input);
    const { renamed } = await this.place(block, { near: input.near, side: input.side }, `Drawing a timeline with ${input.milestones.length} milestones`);
    return { ok: true, milestones: input.milestones.length, ...this.refsResult(block, renamed) };
  }

  async addChart(input: ChartSpec & Placement): Promise<ToolResult> {
    if (!input.labels?.length || !input.series?.length) return { ok: false, error: "A chart needs labels and at least one series." };
    const block = buildChart(this.ctx, input);
    const { renamed } = await this.place(block, input, `Drawing a ${input.kind === "line" ? "line" : "bar"} chart`);
    return { ok: true, ...this.refsResult(block, renamed) };
  }

  async addStatCards(input: { cards: StatCardSpec[]; title?: string } & Placement): Promise<ToolResult> {
    if (!input.cards?.length) return { ok: false, error: "No cards given." };
    const block = buildStatCards(this.ctx, input.cards, { title: input.title });
    const { renamed } = await this.place(block, input, `Adding ${input.cards.length} stat card${input.cards.length === 1 ? "" : "s"}`);
    return { ok: true, cards: input.cards.length, ...this.refsResult(block, renamed) };
  }

  async addTable(input: TableSpec & Placement): Promise<ToolResult> {
    if (!input.columns?.length && !input.rows?.length) return { ok: false, error: "A table needs columns or rows." };
    const block = buildTable(this.ctx, input);
    const rows = Math.min(40, input.rows?.length ?? 0);
    const { renamed } = await this.place(block, input, `Adding a table with ${rows} row${rows === 1 ? "" : "s"}`);
    return { ok: true, rows, ...this.refsResult(block, renamed) };
  }

  async connect(input: { connections: ConnectionSpec[] }): Promise<ToolResult> {
    const live = await this.liveMap();
    const draft = new Draft(live);
    const existing = new Set<string>();
    for (const el of live.values()) {
      if (el.type !== "arrow") continue;
      const s = (el.startBinding as { elementId?: string } | null)?.elementId;
      const e = (el.endBinding as { elementId?: string } | null)?.elementId;
      if (s && e) existing.add(`${s}>${e}`);
    }
    const missing: string[] = [];
    const arrows: SceneElement[] = [];
    let made = 0;
    for (const c of (input.connections ?? []).slice(0, 150)) {
      const from = this.primary(c.from, live);
      const to = this.primary(c.to, live);
      if (!from || !to || from.id === to.id) {
        if (!from) missing.push(String(c.from));
        if (!to) missing.push(String(c.to));
        continue;
      }
      if (existing.has(`${from.id}>${to.id}`)) continue;
      existing.add(`${from.id}>${to.id}`);
      const f = draft.touch(from.id)!;
      const t = draft.touch(to.id)!;
      const routing = c.routing === "elbow" || c.routing === "curved" ? c.routing : "straight";
      const els = arrowBetween(this.ctx, f, t, {
        label: c.label,
        dashed: c.dashed,
        color: c.color ? strongColor(c.color) : undefined,
        startHead: ARROW_HEADS.includes(c.start_head as ArrowHead) ? (c.start_head as ArrowHead) : undefined,
        endHead: ARROW_HEADS.includes(c.end_head as ArrowHead) ? (c.end_head as ArrowHead) : undefined,
        routing,
      });
      if (routing === "straight") routeAround(els[0]!, els[1], f, t, this.obstacles(draft.current(), new Set([from.id, to.id])));
      else if (routing === "elbow") routeElbow(els[0]!, els[1], f, t, obstacleRects([...draft.current(), ...arrows], new Set([from.id, to.id])));
      else {
        // A curve that sweeps through cards reads as broken: use a clear right-angle path instead when there is one.
        const obs = this.obstacles(draft.current(), new Set([from.id, to.id]));
        if (crossesItems(els[0]!, obs)) routeElbow(els[0]!, els[1], f, t, obs, { onlyIfClear: true });
      }
      arrows.push(...els);
      made++;
    }
    for (const a of arrows) draft.add(a);
    if (made) await this.commit([...arrows, ...draft.values().filter((e) => !arrows.includes(e))], `Connecting ${made} idea${made === 1 ? "" : "s"}`);
    return { ok: true, connected: made, ...(missing.length ? { not_found: [...new Set(missing)] } : {}) };
  }

  async addSuggestions(input: { suggestions: { text: string; between?: string[]; near?: string; ref?: string; reason?: string }[] }): Promise<ToolResult> {
    const list = (input.suggestions ?? []).filter((s) => s && clean(s.text)).slice(0, 24);
    if (!list.length) return { ok: false, error: "No suggestions given." };
    const live = await this.liveMap();
    const draft = new Draft(live);
    const created: SceneElement[] = [];
    const refs: [string, string[]][] = [];
    const labels = new Map<string, string>();
    const perPair = new Map<string, number>();
    let looseAnchor: Point | null = null;
    for (const s of list) {
      const ref = s.ref || this.nextRef("g");
      if (!s.ref) labels.set(ref, clean(s.text, 60));
      const size = stickySize(clean(s.text, 300));
      const a = s.between?.[0] ? this.primary(s.between[0], live) : undefined;
      const b = s.between?.[1] ? this.primary(s.between[1], live) : undefined;
      const near = !a && s.near ? this.primary(s.near, live) : undefined;
      let anchor: Point;
      let frameId: string | null = null;
      if (a && b) {
        const ca = centerOf(rectOf(draft.get(a.id)!));
        const cb = centerOf(rectOf(draft.get(b.id)!));
        const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
        let px = -(cb.y - ca.y) / len;
        let py = (cb.x - ca.x) / len;
        if (py < 0 || (py === 0 && px < 0)) {
          px = -px;
          py = -py;
        }
        const key = `${a.id}>${b.id}`;
        const k = perPair.get(key) ?? 0;
        perPair.set(key, k + 1);
        const off = Math.max(size.w, size.h) / 2 + 70 + k * (Math.max(size.w, size.h) + 30);
        anchor = { x: (ca.x + cb.x) / 2 + px * off - size.w / 2, y: (ca.y + cb.y) / 2 + py * off - size.h / 2 };
        if (a.frameId && a.frameId === b.frameId) frameId = String(a.frameId);
      } else if (near) {
        const r = rectOf(near);
        anchor = { x: r.x + r.w + 60, y: r.y };
        if (near.frameId) frameId = String(near.frameId);
      } else {
        if (!looseAnchor) looseAnchor = this.defaultAnchor(live);
        anchor = { ...looseAnchor };
        looseAnchor.x += size.w + 30;
      }
      // Inside a section, place among its contents (not around the whole section) and grow it if needed.
      const exclude = new Set<string>(frameId ? [frameId] : []);
      const spot = findFreeSpot(size, this.occupied(draft.current(), exclude), anchor, 30);
      const rect = { x: spot.x, y: spot.y, w: size.w, h: size.h };
      const frame = frameId ? draft.get(frameId) : undefined;
      const inFrame =
        frame && contains({ x: num(frame.x) - size.w / 2, y: num(frame.y) - size.h / 2, w: num(frame.width) + size.w, h: num(frame.height) + size.h }, rect);
      const suggestionId = `${this.runId}-${ref}`;
      const els = buildSuggestion(this.ctx, s.text, spot.x, spot.y, ref, inFrame ? frameId : null, { suggestionId, reason: s.reason });
      for (const el of els) draft.add(el);
      created.push(...els);
      if (inFrame && frameId) draft.growFrameToFit(frameId, rect);
      this.reserve(rect);
      refs.push([ref, els.map((e) => e.id)]);
      const sticky = draft.get(els[0]!.id)!;
      if (a && b) {
        for (const [from, to] of [
          [draft.touch(a.id)!, sticky],
          [sticky, draft.touch(b.id)!],
        ] as const) {
          const els = arrowBetween(this.ctx, from, to, { suggestion: true, suggestionId });
          routeAround(els[0]!, els[1], from, to, this.obstacles(draft.current(), new Set([from.id, to.id])));
          for (const el of els) {
            draft.add(el);
            created.push(el);
          }
        }
      } else if (near) {
        for (const el of arrowBetween(this.ctx, draft.touch(near.id)!, sticky, { suggestion: true, suggestionId })) {
          draft.add(el);
          created.push(el);
        }
      }
    }
    const values = draft.values();
    const edits = values.filter((e) => !created.includes(e));
    await this.commit(
      [...edits.filter(isFrame), ...created, ...edits.filter((e) => !isFrame(e))],
      `Suggesting ${list.length} missing step${list.length === 1 ? "" : "s"}`,
    );
    const renamed = this.register(refs);
    return { ok: true, suggestions: list.length, ...this.refsResult(blockOf([], refs, labels), renamed) };
  }

  // ------------------------------------------------------------------------------------------------------
  // Editing tools

  async updateElements(input: { updates: UpdateSpec[] }): Promise<ToolResult> {
    const live = await this.liveMap();
    const draft = new Draft(live);
    const missing: string[] = [];
    const touchedFrames = new Set<string>();
    let changed = 0;
    for (const u of (input.updates ?? []).slice(0, 300)) {
      const el = this.primary(u.id, live);
      if (!el) {
        missing.push(String(u.id));
        continue;
      }
      const c = (el.customData ?? {}) as Record<string, unknown>;
      const groupEls = this.resolve(u.id, live).map((id) => live.get(id)!);
      if (c.aiKind === "table-part") {
        // Tables update as one item: merge the changes and rebuild in place.
        const current = readTable(groupEls);
        const next: TableSpec = {
          title: typeof u.table?.title === "string" ? u.table.title : typeof u.text === "string" ? u.text : current.title,
          columns: Array.isArray(u.table?.columns) ? u.table.columns.map(String) : current.columns,
          rows: Array.isArray(u.table?.rows) ? u.table.rows.map((r) => (Array.isArray(r) ? r.map(String) : [String(r)])) : current.rows,
        };
        const r = union(groupEls.map(rectOf))!;
        const frameId = (groupEls.find((e) => e.frameId)?.frameId as string | undefined) ?? null;
        const block = buildTable(this.ctx, next, { frameId, groupId: String(c.aiBlock) });
        translate(block.elements, r.x - block.rect.x, r.y - block.rect.y);
        draft.remove(groupEls.map((e) => e.id));
        for (const e of block.elements) draft.add(e);
        const ids = block.elements.map((e) => e.id);
        this.index.handles.set(String(u.id), ids);
        for (const id of ids) this.index.handleOf.set(id, String(u.id));
        if (frameId) {
          draft.growFrameToFit(frameId, { x: r.x, y: r.y, w: block.rect.w, h: block.rect.h });
          touchedFrames.add(frameId);
        }
        changed++;
        continue;
      }
      if (c.aiKind === "card" && groupEls.some((e) => e.type === "text")) {
        // Two-line cards: first line is the title, the rest the body; color recolors the card.
        const rect = groupEls.find((e) => e.type === "rectangle") ?? el;
        const texts = groupEls.filter((e) => e.type === "text").sort((a, b) => num(a.y) - num(b.y));
        const w = num(rect.width);
        if (typeof u.text === "string") {
          const [title = "", ...rest] = clean(u.text, 2000).split("\n");
          const body = rest.join(" ").trim();
          const t = draft.touch(texts[0]!.id)!;
          t.text = t.originalText = wrapText(title, charsFor(w, 16));
          const tm = measureText(String(t.text), 16);
          t.width = tm.width;
          t.height = tm.height;
          if (texts[1]) {
            const b = draft.touch(texts[1].id)!;
            b.text = b.originalText = wrapText(body, charsFor(w, 13));
            const bm = measureText(String(b.text), 13);
            b.width = bm.width;
            b.height = bm.height;
            b.y = num(t.y) + tm.height + 6;
          }
          const box = draft.touch(rect.id)!;
          box.height = Math.max(num(rect.height), twoLineCardHeight(w, title, texts[1] ? body : ""));
          if (rect.frameId) touchedFrames.add(String(rect.frameId));
        }
        if (typeof u.color === "string" && u.color) {
          const fill = fillColor(u.color);
          const box = draft.touch(rect.id)!;
          box.backgroundColor = box.strokeColor = fill;
          for (const t of texts) draft.touch(t.id)!.strokeColor = textOn(fill);
        }
        changed++;
        continue;
      }
      const isChart = groupEls.length > 2 && (c.aiKind === "chart-part" || c.kind === "chart");
      if (isChart) {
        // Charts: text renames the title, color recolors the bars/points.
        if (typeof u.text === "string") {
          const title = groupEls.filter((e) => e.type === "text").sort((a, b) => num(b.fontSize) - num(a.fontSize))[0];
          if (title) {
            const d = draft.touch(title.id)!;
            d.text = d.originalText = clean(u.text, 200);
            const m = measureText(String(d.text), num(d.fontSize, 24));
            d.width = m.width;
            d.height = m.height;
          }
        }
        if (typeof u.color === "string" && u.color) {
          for (const e of groupEls) {
            if ((e.type === "rectangle" || e.type === "ellipse") && String(e.backgroundColor ?? "transparent") !== "transparent" && num(e.width) < 200) {
              const d = draft.touch(e.id)!;
              d.backgroundColor = d.strokeColor = strongColor(u.color);
            } else if (e.type === "line" && num(e.strokeWidth) >= 3) draft.touch(e.id)!.strokeColor = strongColor(u.color);
          }
        }
        changed++;
        continue;
      }
      if (typeof u.text === "string") {
        const text = clean(u.text, 4000);
        if (isFrame(el)) {
          const f = draft.touch(el.id)!;
          const fc = (f.customData ?? {}) as Record<string, unknown>;
          // AI sections show their title as a heading inside (empty frame label); others use the frame label.
          if (typeof fc.sectionTitle === "string") f.customData = { ...fc, sectionTitle: clean(text, 120) };
          else f.name = clean(text, 120);
          // The section's big heading follows its name.
          for (const h of draft.current()) {
            if ((h.customData as Record<string, unknown> | undefined)?.sectionHeading !== el.id) continue;
            const d = draft.touch(h.id)!;
            d.text = d.originalText = clean(text, 120);
            const m = measureText(String(d.text), num(d.fontSize, 28));
            d.width = m.width;
            d.height = m.height;
          }
        } else if (c.aiKind === "stat-card") {
          const parts = text.split(/\s*·\s*|\n/);
          const texts = this.resolve(u.id, live)
            .map((id) => draft.get(id)!)
            .filter((e) => e.type === "text")
            .sort((p, q) => num(p.y) - num(q.y));
          texts.forEach((t, i) => {
            if (parts[i] === undefined) return;
            const d = draft.touch(t.id)!;
            d.text = d.originalText = parts[i];
            const m = measureText(parts[i]!, num(d.fontSize, 16));
            d.width = m.width;
            d.height = m.height;
          });
        } else if (el.type === "text") {
          const d = draft.touch(el.id)!;
          d.text = d.originalText = text;
          const m = measureText(text, num(d.fontSize, 20));
          d.width = m.width;
          d.height = m.height;
        } else if (["rectangle", "ellipse", "diamond", "arrow"].includes(el.type)) {
          const labelId = ((el.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === "text" && live.has(b.id))?.id;
          if (labelId) {
            const d = draft.touch(labelId)!;
            d.originalText = text;
            d.text = text;
          } else {
            const container = draft.touch(el.id)!;
            const label = makeText({
              x: num(el.x) + 10,
              y: num(el.y) + 10,
              text,
              fontSize: el.type === "arrow" ? 14 : 16,
              fontFamily: SANS,
              strokeColor: el.type === "arrow" ? TEXT_MUTED : textOn(String(el.backgroundColor ?? "transparent")),
              textAlign: "center",
              verticalAlign: "middle",
              containerId: el.id,
              frameId: (el.frameId as string | null) ?? null,
              customData: this.ctx.mark(),
            });
            container.boundElements = [...((container.boundElements as { id: string; type: string }[] | null) ?? []), { id: label.id, type: "text" }];
            draft.add(label);
          }
          if (el.type !== "arrow") {
            if (isSticky(el)) {
              const s = draft.touch(el.id)!;
              s.height = Math.max(num(el.height), stickyHeightFor(text, num(el.width)));
              if (el.frameId) touchedFrames.add(String(el.frameId));
            }
            draft.layoutLabel(el.id);
            draft.rerouteAround(new Set([el.id]));
          } else draft.reroute(el.id);
        }
      }
      if (typeof u.color === "string" && u.color) {
        const parts = draft.partsIndex().get(el.id) ?? [];
        if (c.shape === "parallelogram" || parts.length) {
          // The visible fill lives on the decorative part; the label follows for contrast.
          const fill = fillColor(u.color);
          for (const p of parts) {
            const d = draft.touch(p)!;
            d.backgroundColor = d.strokeColor = fill;
          }
          for (const b of (el.boundElements as { id: string; type: string }[] | null) ?? [])
            if (b.type === "text" && live.has(b.id)) draft.touch(b.id)!.strokeColor = textOn(fill);
        } else {
          const d = draft.touch(el.id)!;
          if (el.type === "text" || el.type === "arrow" || el.type === "line" || el.type === "freedraw") d.strokeColor = strongColor(u.color);
          else if (!isFrame(el)) {
            if (String(el.backgroundColor ?? "transparent") === "transparent" && !isSticky(el)) d.strokeColor = strongColor(u.color);
            else {
              const fill = fillColor(u.color);
              // Filled shapes have no visible outline (stroke = fill) on the dark canvas; keep it that way.
              if (String(el.strokeColor).toLowerCase() === String(el.backgroundColor).toLowerCase()) d.strokeColor = fill;
              d.backgroundColor = fill;
              for (const b of (el.boundElements as { id: string; type: string }[] | null) ?? [])
                if (b.type === "text" && live.has(b.id)) draft.touch(b.id)!.strokeColor = textOn(fill);
            }
          }
        }
      }
      if (u.shape && ["rectangle", "ellipse", "diamond"].includes(u.shape) && ["rectangle", "ellipse", "diamond"].includes(el.type)) {
        const d = draft.touch(el.id)!;
        d.type = u.shape;
        d.roundness = u.shape === "ellipse" ? null : { type: 3 };
        draft.layoutLabel(el.id);
      }
      if (typeof u.width === "number" || typeof u.height === "number") {
        const d = draft.touch(el.id)!;
        if (typeof u.width === "number" && u.width > 10) d.width = Math.min(u.width, 4000);
        if (typeof u.height === "number" && u.height > 10) d.height = Math.min(u.height, 4000);
        draft.layoutLabel(el.id);
        draft.rerouteAround(new Set([el.id]));
        if (el.frameId) touchedFrames.add(String(el.frameId));
      }
      changed++;
    }
    for (const f of touchedFrames) this.repairOverlaps(draft, f);
    this.polishArrows(draft);
    const values = draft.values();
    if (values.length) {
      const r = union(values.filter((e) => !isBoundText(e)).map(rectOf));
      if (r) this.movePointer(r.x + r.w / 2, r.y + r.h / 2);
      await this.commit(values, `Updating ${changed} element${changed === 1 ? "" : "s"}`);
    }
    return { ok: true, updated: changed, ...(missing.length ? { not_found: missing } : {}) };
  }

  async moveElements(input: { ids: string[]; dx?: number; dy?: number; into_section?: string } & Placement): Promise<ToolResult> {
    const live = await this.liveMap();
    const draft = new Draft(live);
    const top = new Set<string>();
    for (const h of input.ids ?? []) for (const id of this.resolve(h, live)) if (!isBoundText(live.get(id)!, live)) top.add(id);
    if (!top.size) return { ok: false, error: "None of those elements exist." };
    const set = draft.expand(top);
    const r = union(
      [...set]
        .map((id) => live.get(id)!)
        .filter((e) => !isBoundText(e, live))
        .map(occupiedRectOf),
    )!;
    let dx = 0;
    let dy = 0;
    const frame = this.sectionFrame(input.into_section, live);
    if (frame && !top.has(frame.id)) {
      const kids = draft.childBounds(frame.id);
      const tx = num(frame.x) + 40;
      const ty = kids ? kids.y + kids.h + 40 : num(frame.y) + 40;
      dx = tx - r.x;
      dy = ty - r.y;
      draft.move(set, dx, dy);
      for (const id of top) if (!isFrame(live.get(id))) draft.touch(id)!.frameId = frame.id;
      for (const id of set) if (isBoundText(live.get(id)!, live)) draft.touch(id)!.frameId = frame.id;
      draft.growFrameToFit(frame.id, { x: tx, y: ty, w: r.w, h: r.h });
    } else if (input.near) {
      const size = { w: r.w, h: r.h };
      const spot = findFreeSpot(size, this.occupied(live.values(), set), this.anchorFor(size, input, live));
      dx = spot.x - r.x;
      dy = spot.y - r.y;
      draft.move(set, dx, dy);
    } else {
      dx = num(input.dx);
      dy = num(input.dy);
      draft.move(set, dx, dy);
    }
    // Items moved out of their section leave it (Excalidraw clips children to their frame).
    for (const id of top) {
      const el = draft.get(id)!;
      if (isFrame(el) || !el.frameId || top.has(String(el.frameId))) continue;
      const f = draft.get(String(el.frameId));
      if (f && !contains(rectOf(f), rectOf(el))) {
        draft.touch(id)!.frameId = null;
        for (const t of ((el.boundElements as { id: string; type: string }[] | null) ?? []).filter((b) => b.type === "text")) {
          const d = draft.touch(t.id);
          if (d) d.frameId = null;
        }
      }
    }
    this.polishArrows(draft);
    await this.commit(draft.values(), `Moving ${top.size} element${top.size === 1 ? "" : "s"}`);
    return { ok: true, moved: top.size };
  }

  async deleteElements(input: { ids: string[]; keep_section_contents?: boolean }): Promise<ToolResult> {
    const live = await this.liveMap();
    const draft = new Draft(live);
    const ids = (input.ids ?? []).flatMap((h) => this.resolve(h, live));
    if (!ids.length) return { ok: false, error: "None of those elements exist." };
    const n = draft.remove(ids, !!input.keep_section_contents);
    await this.commit(draft.values(), `Removing ${n} element${n === 1 ? "" : "s"}`);
    return { ok: true, deleted: n };
  }

  /** Moves existing items into themed sections (new or existing), laid out as tidy grids. */
  // ------------------------------------------------------------------------------------------------------
  // Illustrations, live embeds, layout cleanup

  async addIllustration(input: { subject: string; style?: string; size?: string; ref?: string } & Placement): Promise<ToolResult> {
    const name = resolveSubject(String(input.subject ?? ""));
    if (name === "people") return { ok: false, refused: true, error: PEOPLE_REFUSAL };
    if (!name) {
      return {
        ok: false,
        error: `I don't have a drawing for "${clean(input.subject, 60)}". Available: ${ILLUSTRATION_SUBJECTS.join(", ")}. Pick the closest one, or use a shape block instead.`,
      };
    }
    const style = input.style === "clean" ? "clean" : "marker";
    const size = input.size === "small" || input.size === "large" ? input.size : "medium";
    const ref = input.ref || this.nextRef("i");
    const els = buildIllustration(this.ctx, name, 0, 0, { style, size, ref })!;
    const block = blockOf(els, [[ref, els.map((e) => e.id)]], input.ref ? new Map() : new Map([[ref, `${name} illustration`]]));
    const { renamed } = await this.place(block, input, `Drawing a ${name}`);
    return { ok: true, drew: name, style, ref: renamed[ref] ?? ref };
  }

  async addLiveEmbed(
    input: {
      kind: string;
      title?: string;
      question?: string;
      options?: string[];
      minutes?: number;
      html?: string;
      width?: number;
      height?: number;
      ref?: string;
    } & Placement,
  ): Promise<ToolResult> {
    const kind = String(input.kind ?? "").toLowerCase() as EmbedKind;
    if (!EMBED_KINDS.includes(kind)) return { ok: false, error: "kind must be poll, timer, calculator, prototype, or custom." };
    let config: Record<string, unknown> = {};
    let html = "";
    if (kind === "poll") {
      const question = clean(input.question, 200);
      const options = (Array.isArray(input.options) ? input.options : [])
        .map((o) => clean(o, 80))
        .filter(Boolean)
        .slice(0, 8);
      if (!question || options.length < 2) return { ok: false, error: "A poll needs a question and 2-8 options." };
      config = { question, options };
    } else if (kind === "timer") {
      config = { minutes: Math.min(180, Math.max(1, Math.round(Number(input.minutes) || 5))) };
    } else if (kind === "prototype" || kind === "custom") {
      html = String(input.html ?? "");
      if (!html.trim()) return { ok: false, error: "prototype and custom embeds need html: one self-contained page (inline CSS and JS)." };
      if (html.length > EMBED_HTML_MAX) return { ok: false, error: `The html is ${html.length} characters; the limit is ${EMBED_HTML_MAX}. Make it smaller.` };
      if (EMBED_NETWORK.test(html)) {
        return {
          ok: false,
          error: "The html must be self-contained: no network requests (fetch, XHR, WebSocket), external scripts, styles, images, fonts, or iframes.",
        };
      }
    }
    const base = EMBED_SIZES[kind];
    const width = Math.min(1200, Math.max(200, Math.round(Number(input.width) || base.w)));
    const height = Math.min(1000, Math.max(140, Math.round(Number(input.height) || base.h)));
    const title = clean(input.title, 80) || (kind === "poll" ? String(config.question).slice(0, 80) : EMBED_TITLES[kind]);
    const ref = input.ref || this.nextRef("w");
    const el = makeEmbed({
      x: 0,
      y: 0,
      width,
      height,
      url: `https://${LIVE_EMBED_HOST}/${kind}`,
      strokeColor: DARK_PALETTE.LINE,
      backgroundColor: "transparent",
      roughness: 0,
      customData: this.ctx.mark({ ref, kind: "live-embed", embedKind: kind, title, html, state: {}, config }),
    });
    const block = blockOf([el], [[ref, [el.id]]], input.ref ? new Map() : new Map([[ref, title]]));
    const { renamed } = await this.place(block, input, `Adding a live ${kind}`);
    return { ok: true, embed: kind, title, ref: renamed[ref] ?? ref };
  }

  /**
   * Tidies a layout without recreating anything, worst problems first: overlapping items, then ragged rows and
   * columns (small misalignments), then uneven gaps. Scope: given handles, a section's contents, or the whole board
   * (top-level items and sections as units).
   */
  async cleanupLayout(input: { section?: string; ids?: string[] }): Promise<ToolResult> {
    const live = await this.liveMap();
    const draft = new Draft(live);
    const frame = this.sectionFrame(input.section, live);
    const taken = new Set<string>();
    const frameUnits = new Set<Unit>();
    let units: Unit[];
    if (input.ids?.length)
      units = this.unitsOf(
        input.ids.flatMap((h) => this.resolve(h, live).map((id) => live.get(id)!)),
        live,
        taken,
      );
    else if (frame) units = this.unitsOf(draft.childrenOf(frame.id), live, taken);
    else {
      const top = [...live.values()].filter((e) => !(typeof e.frameId === "string" && live.has(e.frameId)));
      units = this.unitsOf(
        top.filter((e) => !isFrame(e)),
        live,
        taken,
      );
      for (const f of top.filter(isFrame)) {
        const u: Unit = { lead: f, ids: [f.id], rect: occupiedRectOf(f) };
        units.push(u);
        frameUnits.add(u);
      }
    }
    units = units.filter((u) => !isPin(u.lead));
    if (units.length < 2) return { ok: true, moved: 0, note: "Nothing to tidy." };

    const r: Rect[] = units.map((u) => ({ ...u.rect }));
    const others = this.occupied([]);
    const ov = (a: Rect, b: Rect) =>
      Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const clashes = (k: number, cand: Rect, skip: Set<number> = new Set()) => r.some((o, m) => m !== k && !skip.has(m) && ov(cand, o) > 0);

    // 1. Overlaps, largest overlap first: move the smaller item of the pair to the nearest free spot.
    let overlaps = 0;
    for (let guard = 0; guard < units.length * 3; guard++) {
      let worst: { i: number; j: number; a: number } | null = null;
      for (let i = 0; i < r.length; i++) {
        for (let j = i + 1; j < r.length; j++) {
          const a = ov(r[i]!, r[j]!);
          if (a > 16 && (!worst || a > worst.a)) worst = { i, j, a };
        }
      }
      if (!worst) break;
      const k = r[worst.i]!.w * r[worst.i]!.h <= r[worst.j]!.w * r[worst.j]!.h ? worst.i : worst.j;
      const spot = findFreeSpot({ w: r[k]!.w, h: r[k]!.h }, [...r.filter((_, m) => m !== k), ...others], { x: r[k]!.x, y: r[k]!.y }, 30);
      r[k] = { ...r[k]!, x: spot.x, y: spot.y };
      overlaps++;
    }

    // Rows / columns: items whose ranges overlap by at least half of the smaller one.
    const groupBy = (axis: "x" | "y") => {
      const lo = (q: Rect) => (axis === "y" ? q.y : q.x);
      const len = (q: Rect) => (axis === "y" ? q.h : q.w);
      const order = r.map((_, i) => i).sort((a, b) => lo(r[a]!) - lo(r[b]!));
      const groups: number[][] = [];
      for (const i of order) {
        const g = groups.find((grp) => {
          const f = r[grp[0]!]!;
          const shared = Math.min(lo(f) + len(f), lo(r[i]!) + len(r[i]!)) - Math.max(lo(f), lo(r[i]!));
          return shared >= 0.5 * Math.min(len(f), len(r[i]!));
        });
        if (g) g.push(i);
        else groups.push([i]);
      }
      return groups.filter((g) => g.length >= 2);
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

    // 2. Ragged rows and columns: snap small misalignments (up to 48px) to the median edge.
    const align = (axis: "x" | "y") => {
      let n = 0;
      for (const g of groupBy(axis === "y" ? "y" : "x")) {
        const edges = g.map((i) => (axis === "y" ? r[i]!.y : r[i]!.x));
        const spread = Math.max(...edges) - Math.min(...edges);
        if (spread <= 2 || spread > 48) continue;
        const target = median(edges);
        let movedAny = false;
        for (const i of g) {
          const cand = axis === "y" ? { ...r[i]!, y: target } : { ...r[i]!, x: target };
          if ((axis === "y" ? r[i]!.y : r[i]!.x) === target || clashes(i, cand)) continue;
          r[i] = cand;
          movedAny = true;
        }
        if (movedAny) n++;
      }
      return n;
    };
    const rows = align("y");
    const columns = align("x");

    // 3. Uneven gaps within rows (horizontal) and columns (vertical): even them out to the median gap.
    const evenGaps = (axis: "x" | "y") => {
      let n = 0;
      for (const g of groupBy(axis === "x" ? "y" : "x")) {
        if (g.length < 3) continue;
        const pos = (i: number) => (axis === "x" ? r[i]!.x : r[i]!.y);
        const len = (i: number) => (axis === "x" ? r[i]!.w : r[i]!.h);
        const sorted = [...g].sort((a, b) => pos(a) - pos(b));
        const gaps = sorted.slice(1).map((i, k) => pos(i) - (pos(sorted[k]!) + len(sorted[k]!)));
        if (gaps.some((v) => v < 0 || v > 320) || Math.max(...gaps) - Math.min(...gaps) <= 12) continue;
        const target = Math.round(median(gaps));
        const before = sorted.map((i) => ({ ...r[i]! }));
        let cursor = pos(sorted[0]!) + len(sorted[0]!);
        let ok = true;
        const skip = new Set(sorted);
        for (const i of sorted.slice(1)) {
          const cand = axis === "x" ? { ...r[i]!, x: cursor + target } : { ...r[i]!, y: cursor + target };
          if (clashes(i, cand, skip)) {
            ok = false;
            break;
          }
          r[i] = cand;
          cursor = pos(i) + len(i);
        }
        if (!ok) sorted.forEach((i, k) => (r[i] = before[k]!));
        else n++;
      }
      return n;
    };
    const rowGaps = evenGaps("x");
    const colGaps = evenGaps("y");

    let moved = 0;
    units.forEach((u, i) => {
      const dx = Math.round(r[i]!.x - u.rect.x);
      const dy = Math.round(r[i]!.y - u.rect.y);
      if (!dx && !dy) return;
      draft.move(frameUnits.has(u) ? draft.expand([u.lead.id]) : draft.expand(u.ids, false), dx, dy);
      moved++;
    });
    if (!moved) return { ok: true, moved: 0, note: "The layout was already tidy." };
    if (frame) draft.growFrameToFit(frame.id, union(r)!, 40);
    this.polishArrows(draft);
    await this.commit(draft.values(), "Cleaning up the layout");
    return { ok: true, moved, overlaps_fixed: overlaps, rows_aligned: rows, columns_aligned: columns, gaps_evened: rowGaps + colGaps };
  }

  /**
   * Movable units from elements: an element with its bound labels and decorative parts, or a whole group
   * (cards, tables, charts, stat cards, people's own groups). Section headings/subtitles stay with their section.
   */
  private unitsOf(els: Iterable<SceneElement>, live: Map<string, SceneElement>, taken: Set<string>): Unit[] {
    const out: Unit[] = [];
    const byKey = new Map<string, Unit>();
    for (const el of els) {
      if (taken.has(el.id) || isBoundText(el, live) || el.type === "arrow" || isFrame(el) || isSectionLabel(el) || isPin(el)) continue;
      const c = (el.customData ?? {}) as Record<string, unknown>;
      if (typeof c.partOf === "string" && live.has(c.partOf)) continue;
      if (typeof c.subtitleOf === "string" && live.has(c.subtitleOf)) continue;
      taken.add(el.id);
      const groups = Array.isArray(el.groupIds) ? (el.groupIds as string[]) : [];
      const key = groups.length ? `g:${groups[groups.length - 1]}` : `e:${el.id}`;
      const r = occupiedRectOf(el);
      const u = byKey.get(key);
      if (u) {
        u.ids.push(el.id);
        u.rect = union([u.rect, r])!;
        if (el.type === "rectangle" && u.lead.type !== "rectangle") u.lead = el;
      } else {
        const nu: Unit = { lead: el, ids: [el.id], rect: r };
        byKey.set(key, nu);
        out.push(nu);
      }
    }
    return out;
  }

  /** Top of a section's content area (below its heading and subtitle). */
  private contentTopOf(frame: SceneElement, draft: Draft): number {
    const labels = draft.childrenOf(frame.id).filter(isSectionLabel);
    const r = union(labels.map(rectOf));
    return r ? r.y + r.h + 24 : num(frame.y) + 40;
  }

  async regroup(
    input: {
      groups: { name: string; ids: string[]; color?: string; section?: string; note?: string }[];
      remove_empty_sections?: boolean;
      arrangement?: "row" | "column" | "grid" | "auto";
    } & Placement,
  ): Promise<ToolResult> {
    const live = await this.liveMap();
    const draft = new Draft(live);
    const taken = new Set<string>();
    const groups = (input.groups ?? [])
      .filter((g) => g && g.ids?.length)
      .slice(0, 16)
      .map((g) => {
        const els: SceneElement[] = [];
        for (const h of g.ids) {
          for (const id of this.resolve(h, live)) {
            const el = live.get(id)!;
            if (isFrame(el)) els.push(...draft.childrenOf(id));
            else els.push(el);
          }
        }
        return { ...g, items: this.unitsOf(els, live, taken) };
      })
      .filter((g) => g.items.length);
    if (!groups.length) return { ok: false, error: "None of those elements exist." };

    const moved = draft.expand([...taken], false);
    const oldFrames = new Set([...taken].map((id) => live.get(id)!.frameId).filter((f): f is string => typeof f === "string" && live.has(f)));
    const removeEmpty = input.remove_empty_sections !== false;
    const emptied = [...oldFrames].filter((f) => draft.childrenOf(f).every((c) => moved.has(c.id) || c.type === "arrow" || isSectionLabel(c)));
    const targetFrames = new Set(groups.map((g) => this.sectionFrame(g.section, live)?.id).filter((x): x is string => !!x));

    const pad = 40;
    const newBlocks: { group: (typeof groups)[number]; block: Block; frame: SceneElement; positions: Point[]; offsetY: number }[] = [];
    const intoExisting: { group: (typeof groups)[number]; frame: SceneElement }[] = [];
    groups.forEach((g, gi) => {
      const existing = this.sectionFrame(g.section, live);
      if (existing) {
        intoExisting.push({ group: g, frame: existing });
        return;
      }
      const sizes = g.items.map((u) => ({ w: u.rect.w, h: u.rect.h }));
      const { positions, w, h } = arrangeBoxes(sizes, "grid", undefined, 30);
      const ref = this.nextRef("s");
      const section = buildSection(this.ctx, { ref, name: g.name, note: g.note, items: [] }, gi);
      const frame = section.elements[0]!;
      const labelsW = Math.max(0, ...section.elements.filter(isSectionLabel).map((e) => num(e.width)));
      const offsetY = section.contentTop ?? pad;
      frame.width = Math.max(360, w + pad * 2, labelsW + pad * 2);
      frame.height = offsetY + h + pad;
      section.rect = { x: 0, y: -FRAME_LABEL_SPACE, w: num(frame.width), h: num(frame.height) + FRAME_LABEL_SPACE };
      newBlocks.push({ group: g, block: section, frame, positions, offsetY });
    });

    let placedRect: Rect | null = null;
    if (newBlocks.length) {
      const combined = combineBlocks(
        newBlocks.map((b) => b.block),
        input.arrangement ?? "auto",
      );
      const exclude = new Set<string>([...moved, ...(removeEmpty ? emptied.filter((f) => !targetFrames.has(f)) : [])]);
      const original = union(groups.flatMap((g) => g.items.map((u) => u.rect)))!;
      const size = { w: combined.rect.w, h: combined.rect.h };
      const anchor = input.near ? this.anchorFor(size, input, live) : { x: original.x, y: original.y };
      const spot = findFreeSpot(size, this.occupied(live.values(), exclude), anchor);
      translate(combined.elements, spot.x - combined.rect.x, spot.y - combined.rect.y);
      placedRect = { x: spot.x, y: spot.y, ...size };
      this.reserve(placedRect);
      for (const nb of newBlocks) {
        for (const el of nb.block.elements) draft.add(el);
        nb.group.items.forEach((u, i) => {
          const tx = num(nb.frame.x) + pad + nb.positions[i]!.x;
          const ty = num(nb.frame.y) + nb.offsetY + nb.positions[i]!.y;
          const set = draft.expand(u.ids, false);
          draft.move(set, tx - u.rect.x, ty - u.rect.y);
          for (const id of set) draft.touch(id)!.frameId = nb.frame.id;
        });
        this.register(nb.block.refs);
      }
    }
    for (const { group, frame } of intoExisting) {
      const kids = draft.childrenOf(frame.id).filter((c) => !moved.has(c.id) && !isBoundText(c, live) && !isSectionLabel(c));
      const kb = union(kids.map(rectOf));
      const sizes = group.items.map((u) => ({ w: u.rect.w, h: u.rect.h }));
      const { positions, w, h } = arrangeBoxes(sizes, "grid", undefined, 30);
      const ox = num(frame.x) + pad;
      const oy = kb ? kb.y + kb.h + 40 : this.contentTopOf(frame, draft);
      group.items.forEach((u, i) => {
        const set = draft.expand(u.ids, false);
        draft.move(set, ox + positions[i]!.x - u.rect.x, oy + positions[i]!.y - u.rect.y);
        for (const id of set) draft.touch(id)!.frameId = frame.id;
      });
      draft.growFrameToFit(frame.id, { x: ox, y: oy, w, h });
    }
    // Recolor stickies and cards to their group's color (saturated fill, matching stroke).
    for (const g of groups) {
      if (!g.color) continue;
      const fill = fillColor(g.color);
      for (const u of g.items) {
        const kind = (u.lead.customData as Record<string, unknown> | undefined)?.aiKind;
        if (!isSticky(u.lead) && kind !== "card") continue;
        const el = draft.touch(u.lead.id)!;
        el.backgroundColor = fill;
        el.strokeColor = fill;
      }
    }
    let removed = 0;
    if (removeEmpty) {
      const toRemove = emptied.filter((f) => !targetFrames.has(f));
      for (const f of toRemove) draft.remove([f], true);
      removed = toRemove.length;
    }
    this.polishArrows(draft);
    // Stream group by group: each new section with its items, then everything else.
    const values = draft.values();
    const sent = new Set<string>();
    for (const nb of newBlocks) {
      const part = values.filter((e) => e.id === nb.frame.id || e.frameId === nb.frame.id || nb.block.elements.includes(e));
      part.forEach((e) => sent.add(e.id));
      await this.commit(part, `Grouping "${clean(nb.group.name, 40)}"`);
    }
    const rest = values.filter((e) => !sent.has(e.id));
    if (rest.length) await this.commit(rest, "Tidying up");
    return {
      ok: true,
      groups: groups.length,
      moved: taken.size,
      ...(removed ? { removed_empty_sections: removed } : {}),
      new_sections: newBlocks.map((nb) => ({ ref: nb.block.refs[0]![0], name: nb.group.name })),
    };
  }

  /** Re-lays out existing items in place (grid/row/column/flow). */
  async arrange(input: { ids?: string[]; section?: string; layout?: Layout; columns?: number; order?: string }): Promise<ToolResult> {
    const live = await this.liveMap();
    const draft = new Draft(live);
    const frame = this.sectionFrame(input.section, live);
    let items: Unit[];
    const seen = new Set<string>();
    if (input.ids?.length) {
      items = this.unitsOf(
        input.ids.flatMap((h) => this.resolve(h, live).map((id) => live.get(id)!)),
        live,
        seen,
      );
    } else if (frame) {
      items = this.unitsOf(draft.childrenOf(frame.id), live, seen).sort((a, b) =>
        Math.abs(a.rect.y - b.rect.y) > 40 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x,
      );
    } else return { ok: false, error: "Give ids or a section to arrange." };
    if (!items.length) return { ok: false, error: "Nothing to arrange." };
    let tally: { ref: string; votes: number }[] | undefined;
    if (input.order === "votes") {
      // Most-voted first (ties keep their current order).
      const votes = new Map<string, number>();
      for (const el of live.values()) {
        const c = (el.customData ?? {}) as Record<string, unknown>;
        if (c.kind === "vote" && typeof c.targetId === "string") votes.set(c.targetId, (votes.get(c.targetId) ?? 0) + 1);
      }
      const count = (u: Unit) => u.ids.reduce((n, id) => n + (votes.get(id) ?? 0), 0);
      items = items
        .map((u, i) => ({ u, i, n: count(u) }))
        .sort((a, b) => b.n - a.n || a.i - b.i)
        .map((x) => x.u);
      tally = items.map((u) => ({ ref: this.index.handleOf.get(u.lead.id) ?? u.lead.id, votes: count(u) }));
    }
    const layout = input.layout ?? "grid";
    const sizes = items.map((u) => ({ w: u.rect.w, h: u.rect.h }));
    const { positions, w, h } = arrangeBoxes(sizes, layout, input.columns, layout === "flow" ? 90 : 30);
    let ox: number;
    let oy: number;
    const top = frame ? this.contentTopOf(frame, draft) : 0;
    if (frame) {
      ox = num(frame.x) + 40;
      oy = top;
    } else {
      const r = union(items.map((u) => u.rect))!;
      const all = draft.expand(
        items.flatMap((u) => u.ids),
        false,
      );
      const spot = findFreeSpot({ w, h }, this.occupied(live.values(), all), { x: r.x, y: r.y });
      ox = spot.x;
      oy = spot.y;
    }
    items.forEach((u, i) => {
      const set = draft.expand(u.ids, false);
      draft.move(set, ox + positions[i]!.x - u.rect.x, oy + positions[i]!.y - u.rect.y);
    });
    if (frame) {
      const f = draft.touch(frame.id)!;
      const oldH = num(frame.height);
      f.width = Math.max(360, w + 80);
      f.height = Math.max(200, top - num(frame.y) + h + 40);
      if (num(f.height) > oldH || num(f.width) > num(frame.width)) {
        const nw = num(f.width);
        const nh = num(f.height);
        f.width = num(frame.width);
        f.height = oldH;
        draft.growFrameToFit(frame.id, { x: num(frame.x), y: num(frame.y), w: nw - 40, h: nh - 40 });
      }
    }
    this.polishArrows(draft);
    await this.commit(draft.values(), `Arranging ${items.length} element${items.length === 1 ? "" : "s"}`);
    return { ok: true, arranged: items.length, ...(tally ? { by_votes: tally.slice(0, 40) } : {}) };
  }

  /** Re-bends arrows touched by an edit (moves reset them to straight lines) so they avoid crossing items. */
  private polishArrows(draft: Draft) {
    const current = draft.current();
    for (const el of draft.values()) {
      if (el.type !== "arrow" || el.isDeleted) continue;
      const s = draft.get(String((el.startBinding as { elementId?: string } | null)?.elementId ?? ""));
      const e = draft.get(String((el.endBinding as { elementId?: string } | null)?.elementId ?? ""));
      if (!s || !e || s.isDeleted || e.isDeleted) continue;
      const labelId = ((el.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === "text")?.id;
      const label = labelId ? draft.touch(labelId) : undefined;
      if (el.elbowed) routeElbow(el, label, s, e, obstacleRects(current, new Set([s.id, e.id])));
      else routeAround(el, label, s, e, this.obstacles(current, new Set([s.id, e.id])));
    }
  }

  /** If items in a section now overlap (e.g. a note grew), re-flow them as a grid in reading order. */
  private repairOverlaps(draft: Draft, frameId: string) {
    const frame = draft.get(frameId);
    if (!frame) return;
    const kids = draft.childrenOf(frameId).filter((e) => !isBoundText(e) && e.type !== "arrow" && e.type !== "line" && e.type !== "freedraw");
    const rects = kids.map(rectOf);
    let overlap = false;
    for (let i = 0; i < rects.length && !overlap; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        if (a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2 && a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2) {
          overlap = true;
          break;
        }
      }
    }
    if (!overlap) return;
    const order = kids.map((el, i) => ({ el, r: rects[i]! })).sort((a, b) => (Math.abs(a.r.y - b.r.y) > 40 ? a.r.y - b.r.y : a.r.x - b.r.x));
    const top = Math.min(...order.map((o) => o.r.y));
    const columns = Math.max(1, order.filter((o) => o.r.y - top < 40).length);
    const { positions, w, h } = arrangeBoxes(
      order.map((o) => ({ w: o.r.w, h: o.r.h })),
      "grid",
      columns,
      30,
    );
    const ox = Math.min(...order.map((o) => o.r.x));
    order.forEach((o, i) => draft.move(draft.expand([o.el.id], false), ox + positions[i]!.x - o.r.x, top + positions[i]!.y - o.r.y));
    draft.growFrameToFit(frameId, { x: ox, y: top, w, h });
  }

  summary() {
    return { created: this.created.size, updated: this.updated.size, deleted: this.deleted.size };
  }

  lastPointer() {
    return this.pointer;
  }
}

export interface ConnectionSpec {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  color?: string;
  start_head?: string;
  end_head?: string;
  routing?: string;
}

const ARROW_HEADS: ArrowHead[] = ["arrow", "circle", "dot", "triangle", "bar", "diamond", "none"];

export interface UpdateSpec {
  id: string;
  text?: string;
  /** Tables only: new title/columns/rows (omitted parts stay as they are). */
  table?: { title?: string; columns?: string[]; rows?: string[][] };
  color?: string;
  shape?: "rectangle" | "ellipse" | "diamond";
  width?: number;
  height?: number;
}
