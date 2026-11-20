// A working set of edits against the live board: each touched element is cloned and version-bumped once,
// later edits in the same operation mutate that clone. Also holds the structural edit helpers (move with
// children and labels, reroute bound arrows, delete with cleanup, grow a section and push content below it).
import { bumpElement, deleteElement, measureText, wrapText, type SceneElement } from "@monet/board-protocol";
import { intersects, num, occupiedRectOf, rectOf, union, type Point, type Rect } from "./geometry";
import { obstacleRects, routeElbow } from "./elbow";

export function isBoundText(el: SceneElement, live?: Map<string, SceneElement>): boolean {
  return el.type === "text" && typeof el.containerId === "string" && !!el.containerId && (!live || live.has(el.containerId));
}

export function isFrame(el: SceneElement | undefined): boolean {
  return !!el && (el.type === "frame" || el.type === "magicframe");
}

function boundIds(el: SceneElement, type?: "text" | "arrow"): string[] {
  return ((el.boundElements as { id: string; type: string }[] | null) ?? []).filter((b) => !type || b.type === type).map((b) => b.id);
}

function centerOfEl(el: SceneElement): Point {
  return { x: num(el.x) + num(el.width) / 2, y: num(el.y) + num(el.height) / 2 };
}

function edgePoint(el: SceneElement, toward: Point, gap = 8): Point {
  const c = centerOfEl(el);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const hw = num(el.width) / 2 + gap;
  const hh = num(el.height) / 2 + gap;
  const scale = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

export class Draft {
  private changed = new Map<string, SceneElement>();
  private order: string[] = [];

  constructor(readonly live: Map<string, SceneElement>) {}

  /** Current state of an element (draft copy if touched). */
  get(id: string): SceneElement | undefined {
    return this.changed.get(id) ?? this.live.get(id);
  }

  /** Returns the draft copy of an existing element, cloning and bumping it on first touch. */
  touch(id: string): SceneElement | undefined {
    const have = this.changed.get(id);
    if (have) return have;
    const el = this.live.get(id);
    if (!el) return undefined;
    const copy = bumpElement(structuredClone(el));
    this.changed.set(id, copy);
    this.order.push(id);
    return copy;
  }

  /** Adds a brand-new element. */
  add(el: SceneElement) {
    if (!this.changed.has(el.id)) this.order.push(el.id);
    this.changed.set(el.id, el);
  }

  has(id: string) {
    return this.changed.has(id);
  }

  values(): SceneElement[] {
    return this.order.map((id) => this.changed.get(id)!).filter(Boolean);
  }

  /** All current elements (live overlaid with draft), excluding deleted ones. */
  current(): SceneElement[] {
    const out: SceneElement[] = [];
    for (const [id, el] of this.live) {
      const cur = this.changed.get(id) ?? el;
      if (!cur.isDeleted) out.push(cur);
    }
    for (const [id, el] of this.changed) if (!this.live.has(id) && !el.isDeleted) out.push(el);
    return out;
  }

  childrenOf(frameId: string): SceneElement[] {
    return this.current().filter((e) => e.frameId === frameId);
  }

  /** Decorative parts that belong to another element (customData.partOf), keyed by owner id. */
  partsIndex(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const el of this.current()) {
      const c = el.customData as Record<string, unknown> | undefined;
      // Decorative parts, heading subtitles, and the votes and comments pinned to an item move with it.
      const pinned = c?.kind === "vote" || c?.kind === "comment" ? c.targetId : undefined;
      const owner = c?.partOf ?? c?.subtitleOf ?? pinned;
      if (typeof owner === "string") out.set(owner, [...(out.get(owner) ?? []), el.id]);
    }
    return out;
  }

  /** Expands ids with bound labels, decorative parts, and (for sections) their contents. */
  expand(ids: Iterable<string>, withFrameChildren = true): Set<string> {
    const out = new Set<string>();
    const parts = this.partsIndex();
    const add = (id: string) => {
      if (out.has(id)) return;
      const el = this.get(id);
      if (!el || el.isDeleted) return;
      out.add(id);
      for (const t of boundIds(el, "text")) add(t);
      for (const p of parts.get(id) ?? []) add(p);
      if (withFrameChildren && isFrame(el)) for (const c of this.childrenOf(id)) add(c.id);
    };
    for (const id of ids) add(id);
    return out;
  }

  /** Moves a set of elements (already expanded) by dx, dy and reroutes arrows attached to them. */
  move(ids: Set<string>, dx: number, dy: number) {
    if (!dx && !dy) return;
    for (const id of ids) {
      const el = this.touch(id);
      if (!el) continue;
      el.x = num(el.x) + dx;
      el.y = num(el.y) + dy;
    }
    // Labels that were never wrapped (e.g. imported) get wrapped to their container while we're here.
    for (const id of ids) {
      const el = this.get(id);
      if (!el || el.type === "text" || el.type === "arrow" || isFrame(el)) continue;
      for (const t of boundIds(el, "text")) {
        const label = this.get(t);
        const text = String(label?.text ?? "");
        if (label && !text.includes("\n") && measureText(text, num(label.fontSize, 20)).width > num(el.width) - 20) this.layoutLabel(id);
      }
    }
    this.rerouteAround(ids);
  }

  /** Recomputes arrows bound to any of `ids` so they stay attached after a move/resize. */
  rerouteAround(ids: Set<string>) {
    const arrows = new Set<string>();
    for (const id of ids) {
      const el = this.get(id);
      if (!el) continue;
      for (const a of boundIds(el, "arrow")) arrows.add(a);
      if (el.type === "arrow") arrows.add(id);
    }
    for (const id of arrows) this.reroute(id);
  }

  reroute(arrowId: string) {
    const cur = this.get(arrowId);
    if (!cur || cur.isDeleted || cur.type !== "arrow") return;
    const sid = (cur.startBinding as { elementId?: string } | null)?.elementId;
    const eid = (cur.endBinding as { elementId?: string } | null)?.elementId;
    const s = sid ? this.get(sid) : undefined;
    const e = eid ? this.get(eid) : undefined;
    if (!s && !e) return;
    // Right-angle connectors stay right-angled (a straight reset would cut through items).
    if (cur.elbowed && s && e) {
      const a = this.touch(arrowId)!;
      const label = boundIds(a, "text")
        .map((t) => this.touch(t))
        .find(Boolean);
      routeElbow(a, label, s, e, obstacleRects(this.current(), new Set([s.id, e.id])));
      return;
    }
    const pts = (cur.points as [number, number][]) ?? [[0, 0]];
    const last = pts[pts.length - 1] ?? [0, 0];
    const absStart = { x: num(cur.x), y: num(cur.y) };
    const absEnd = { x: num(cur.x) + last[0], y: num(cur.y) + last[1] };
    const p0 = s ? edgePoint(s, e ? centerOfEl(e) : absEnd) : absStart;
    const p1 = e ? edgePoint(e, s ? centerOfEl(s) : absStart) : absEnd;
    const a = this.touch(arrowId)!;
    a.x = p0.x;
    a.y = p0.y;
    a.points = [
      [0, 0],
      [p1.x - p0.x, p1.y - p0.y],
    ];
    a.width = Math.abs(p1.x - p0.x);
    a.height = Math.abs(p1.y - p0.y);
    for (const t of boundIds(a, "text")) {
      const label = this.touch(t);
      if (!label) continue;
      label.x = (p0.x + p1.x) / 2 - num(label.width) / 2;
      label.y = (p0.y + p1.y) / 2 - num(label.height) / 2;
    }
  }

  /** Re-centers a container's bound label after the container changed size or text. */
  layoutLabel(containerId: string) {
    const c = this.get(containerId);
    if (!c) return;
    for (const t of boundIds(c, "text")) {
      const label = this.touch(t);
      if (!label) continue;
      const w = num(c.width);
      const h = num(c.height);
      const fontSize = num(label.fontSize, 20);
      const raw = String(label.originalText ?? label.text ?? "");
      const wrapped = wrapText(raw, Math.max(6, Math.floor((w - 20) / (fontSize * 0.62))));
      const m = measureText(wrapped, fontSize);
      label.text = wrapped;
      label.width = Math.min(m.width, w - 10);
      label.height = m.height;
      label.x = label.textAlign === "left" ? num(c.x) + 10 : num(c.x) + (w - num(label.width)) / 2;
      label.y = label.verticalAlign === "top" ? num(c.y) + 10 : num(c.y) + (h - m.height) / 2;
    }
  }

  /**
   * Deletes elements (expanded with labels; sections with their contents unless keepContents) plus arrows
   * attached to them, and removes dangling references from what remains.
   */
  remove(ids: Iterable<string>, keepContents = false): number {
    const set = this.expand(ids, !keepContents);
    if (keepContents) {
      for (const id of [...set]) {
        const el = this.get(id);
        if (isFrame(el)) for (const c of this.childrenOf(id)) if (!set.has(c.id)) this.touch(c.id)!.frameId = null;
      }
    }
    for (const id of [...set]) {
      const el = this.get(id);
      if (!el) continue;
      for (const a of boundIds(el, "arrow")) {
        set.add(a);
        const arrow = this.get(a);
        if (arrow) for (const t of boundIds(arrow, "text")) set.add(t);
      }
    }
    let n = 0;
    for (const id of set) {
      const el = this.get(id);
      if (!el || el.isDeleted) continue;
      if (this.changed.has(id)) {
        el.isDeleted = true;
      } else {
        this.changed.set(id, deleteElement(el));
        this.order.push(id);
      }
      if (!isBoundText(el)) n++;
    }
    // Drop references to deleted elements from survivors.
    for (const id of set) {
      const el = this.get(id);
      if (!el) continue;
      const refs: string[] = [];
      for (const k of ["startBinding", "endBinding"] as const) {
        const b = el[k] as { elementId?: string } | null;
        if (b?.elementId) refs.push(b.elementId);
      }
      if (typeof el.containerId === "string") refs.push(el.containerId);
      for (const other of refs) {
        if (set.has(other)) continue;
        const o = this.get(other);
        if (!o || !Array.isArray(o.boundElements) || !(o.boundElements as { id: string }[]).some((b) => b.id === id)) continue;
        const t = this.touch(other)!;
        t.boundElements = (t.boundElements as { id: string }[]).filter((b) => b.id !== id);
      }
    }
    return n;
  }

  /**
   * Grows a section so it contains `inner` (+ padding). Content below the section that the bigger section
   * would now cover is pushed down by the same amount.
   */
  growFrameToFit(frameId: string, inner: Rect, pad = 40) {
    const frame = this.get(frameId);
    if (!frame) return;
    const fx = num(frame.x);
    const fy = num(frame.y);
    const oldW = num(frame.width);
    const oldH = num(frame.height);
    const newW = Math.max(oldW, inner.x + inner.w + pad - fx);
    const newH = Math.max(oldH, inner.y + inner.h + pad - fy);
    if (newW === oldW && newH === oldH) return;
    const f = this.touch(frameId)!;
    f.width = newW;
    f.height = newH;
    const grown: Rect = { x: fx, y: fy, w: newW, h: newH };
    const oldBottom = fy + oldH;
    const others = this.current().filter((e) => e.id !== frameId && e.frameId !== frameId && !isBoundText(e) && !(e.frameId && this.get(String(e.frameId))));
    const below = others.filter((e) => {
      const r = occupiedRectOf(e);
      return r.y >= oldBottom - 1 && r.x < fx + newW && r.x + r.w > fx;
    });
    if (newH > oldH && below.some((e) => intersects(grown, occupiedRectOf(e), 30))) {
      const dy = newH - oldH + 40;
      this.move(this.expand(below.map((e) => e.id)), 0, dy);
    }
    // Things to the right that the wider section would cover move right.
    if (newW > oldW) {
      const right = others.filter((e) => {
        const r = occupiedRectOf(e);
        return r.x >= fx + oldW - 1 && r.y < fy + newH && r.y + r.h > fy;
      });
      if (right.some((e) => intersects(grown, occupiedRectOf(e), 30))) this.move(this.expand(right.map((e) => e.id)), newW - oldW + 40, 0);
    }
  }

  /** Bounds of a frame's current children (excluding labels). */
  childBounds(frameId: string): Rect | null {
    return union(
      this.childrenOf(frameId)
        .filter((e) => !isBoundText(e))
        .map(rectOf),
    );
  }
}
