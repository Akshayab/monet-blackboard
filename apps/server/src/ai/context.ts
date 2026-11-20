// Turns the board's elements into a compact summary for the model, with short handles ("e12", "s3") that
// map back to element ids. Bound text is joined to its container, sketches (freedraw strokes) are clustered,
// charts and stat cards collapse into one entry each, and big boards are truncated sensibly.
import type { SceneElement } from "@monet/board-protocol";
import { intersects, num, rectOf, union, type Rect } from "./geometry";
import { readTable } from "./builders";
import { colorName } from "./style";

/** A section's title: the frame label, or (AI sections, whose label is empty) the title kept in customData. */
export function sectionName(f: SceneElement): string {
  const name = typeof f.name === "string" ? f.name.trim() : "";
  if (name) return name;
  const t = (f.customData as Record<string, unknown> | undefined)?.sectionTitle;
  return typeof t === "string" ? t : "";
}

export interface BoardIndex {
  /** handle or ref -> element ids (primary first). */
  handles: Map<string, string[]>;
  /** element id -> handle. */
  handleOf: Map<string, string>;
}

export interface BoardSummary {
  text: string;
  index: BoardIndex;
  focusRect: Rect | null;
  contentRect: Rect | null;
  focusHandles: string[];
  shown: number;
  total: number;
}

export interface SummaryOptions {
  focusIds?: string[];
  viewport?: Rect | null;
  people?: { name: string; online: boolean }[];
  maxItems?: number;
  maxTextChars?: number;
}

interface Entry {
  handle: string;
  ids: string[];
  rect: Rect;
  frameId: string | null;
  data: Record<string, unknown>;
  hasText: boolean;
}

function custom(el: SceneElement): Record<string, unknown> {
  return (el.customData && typeof el.customData === "object" ? el.customData : {}) as Record<string, unknown>;
}

function textOf(el: SceneElement): string {
  const t = typeof el.originalText === "string" && el.originalText ? el.originalText : el.text;
  return typeof t === "string" ? t : "";
}

function cut(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

const round = (v: number) => Math.round(v);

/** The largest text in a chart group (its title). */
export function chartTitle(els: SceneElement[]): string {
  const texts = els.filter((e) => e.type === "text").sort((a, b) => num(b.fontSize) - num(a.fontSize));
  return texts[0] ? textOf(texts[0]) : "";
}

export function isSticky(el: SceneElement): boolean {
  if (custom(el).kind === "sticky") return true;
  if (el.type !== "rectangle") return false;
  const bg = String(el.backgroundColor ?? "transparent");
  const w = num(el.width);
  const h = num(el.height);
  return bg !== "transparent" && w >= 100 && w <= 320 && h >= 100 && h <= 360 && Math.abs(w - h) < 80;
}

/** Union-find clustering of freedraw strokes that are near each other (one sketch = one entry). */
function clusterSketches(strokes: SceneElement[], focused: Set<string>, gap = 80): SceneElement[][] {
  const parent = strokes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const rects = strokes.map(rectOf);
  for (let i = 0; i < strokes.length; i++) {
    for (let j = i + 1; j < strokes.length; j++) {
      if ((strokes[i]!.frameId ?? null) !== (strokes[j]!.frameId ?? null)) continue;
      // A selected sketch stays its own entry, so "replace this sketch" deletes only the selected strokes.
      if (focused.has(strokes[i]!.id) !== focused.has(strokes[j]!.id)) continue;
      if (intersects(rects[i]!, rects[j]!, gap)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, SceneElement[]>();
  strokes.forEach((s, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), s]);
  });
  return [...groups.values()];
}

export function summarizeBoard(elements: SceneElement[], opts: SummaryOptions = {}): BoardSummary {
  const maxItems = opts.maxItems ?? 320;
  const maxText = opts.maxTextChars ?? 220;
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const boundText = new Map<string, string>();
  for (const el of live) {
    if (el.type === "text" && typeof el.containerId === "string" && byId.has(el.containerId)) {
      boundText.set(el.containerId, [boundText.get(el.containerId), textOf(el)].filter(Boolean).join("\n"));
    }
  }

  const frames = live.filter((e) => e.type === "frame" || e.type === "magicframe");
  const frameIds = new Set(frames.map((f) => f.id));
  const frameOf = (el: SceneElement) => (typeof el.frameId === "string" && frameIds.has(el.frameId) ? el.frameId : null);
  const readingOrder = (a: Rect, b: Rect) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x);
  frames.sort((a, b) => readingOrder(rectOf(a), rectOf(b)));
  const frameOrder = new Map(frames.map((f, i) => [f.id, i]));

  const index: BoardIndex = { handles: new Map(), handleOf: new Map() };
  const assign = (handle: string, ids: string[]) => {
    index.handles.set(handle, ids);
    for (const id of ids) if (!index.handleOf.has(id)) index.handleOf.set(id, handle);
  };

  // Sections
  const sectionEntries: Entry[] = frames.map((f, i) => {
    const handle = `s${i + 1}`;
    assign(handle, [f.id]);
    const r = rectOf(f);
    return {
      handle,
      ids: [f.id],
      rect: r,
      frameId: null,
      hasText: true,
      data: { id: handle, kind: "section", name: cut(sectionName(f), 120), x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) },
    };
  });

  // Collapsible blocks: charts, tables, and timeline axes (by aiBlock); stat cards and cards (by group).
  const blocks = new Map<string, SceneElement[]>();
  const strokes: SceneElement[] = [];
  const singles: SceneElement[] = [];
  const arrows: SceneElement[] = [];
  /** Decorative parts that belong to another element (e.g. a parallelogram's filled outline). */
  const partsOf = new Map<string, string[]>();
  const sectionExtras = new Map<string, { ids: string[]; note?: string }>();
  const subtitles = new Map<string, string>();
  /** Comment pins (customData.kind "comment") and face-sticker votes (kind "vote"), read separately. */
  const comments: SceneElement[] = [];
  const votesOn = new Map<string, { names: string[]; ids: string[] }>();
  for (const el of live) {
    if (frameIds.has(el.id)) continue;
    if (el.type === "text" && typeof el.containerId === "string" && byId.has(el.containerId)) continue;
    const c = custom(el);
    if (c.kind === "comment") {
      comments.push(el);
      continue;
    }
    if (c.kind === "vote") {
      const target = typeof c.targetId === "string" ? c.targetId : "";
      const v = votesOn.get(target) ?? { names: [], ids: [] };
      v.names.push(typeof c.userName === "string" && c.userName ? c.userName : "Someone");
      v.ids.push(el.id);
      votesOn.set(target, v);
      continue;
    }
    const headingOf = typeof c.sectionHeading === "string" ? c.sectionHeading : typeof c.sectionSubtitle === "string" ? c.sectionSubtitle : null;
    if (headingOf && frameIds.has(headingOf)) {
      const extra = sectionExtras.get(headingOf) ?? { ids: [] };
      extra.ids.push(el.id);
      if (c.sectionSubtitle) extra.note = textOf(el);
      sectionExtras.set(headingOf, extra);
      continue;
    }
    if (typeof c.partOf === "string" && byId.has(c.partOf)) {
      partsOf.set(c.partOf, [...(partsOf.get(c.partOf) ?? []), el.id]);
      continue;
    }
    if (typeof c.subtitleOf === "string" && byId.has(c.subtitleOf)) {
      partsOf.set(c.subtitleOf, [...(partsOf.get(c.subtitleOf) ?? []), el.id]);
      subtitles.set(c.subtitleOf, textOf(el));
      continue;
    }
    if (c.aiKind === "table-part" && typeof c.aiBlock === "string") {
      blocks.set(`table:${c.aiBlock}`, [...(blocks.get(`table:${c.aiBlock}`) ?? []), el]);
    } else if (c.aiKind === "card" && Array.isArray(el.groupIds) && el.groupIds.length) {
      const g = String((el.groupIds as string[])[el.groupIds.length - 1]);
      blocks.set(`card:${g}`, [...(blocks.get(`card:${g}`) ?? []), el]);
    } else if ((c.aiKind === "chart-part" || c.aiKind === "timeline-part") && typeof c.aiBlock === "string") {
      blocks.set(`${c.aiKind}:${c.aiBlock}`, [...(blocks.get(`${c.aiKind}:${c.aiBlock}`) ?? []), el]);
    } else if (c.kind === "chart" && Array.isArray(el.groupIds) && el.groupIds.length) {
      // Charts people made from CSVs on the canvas: one entry per chart group.
      const g = String((el.groupIds as string[])[0]);
      blocks.set(`chart-part:user-${g}`, [...(blocks.get(`chart-part:user-${g}`) ?? []), el]);
    } else if (c.aiKind === "illustration" && Array.isArray(el.groupIds) && el.groupIds.length) {
      const g = String((el.groupIds as string[])[el.groupIds.length - 1]);
      blocks.set(`illustration:${g}`, [...(blocks.get(`illustration:${g}`) ?? []), el]);
    } else if (c.aiKind === "stat-card" && Array.isArray(el.groupIds) && el.groupIds.length) {
      const g = String((el.groupIds as string[])[0]);
      blocks.set(`stat:${g}`, [...(blocks.get(`stat:${g}`) ?? []), el]);
    } else if (el.type === "freedraw") strokes.push(el);
    else if (el.type === "arrow") arrows.push(el);
    else singles.push(el);
  }

  for (const sec of sectionEntries) {
    const extra = sectionExtras.get(sec.ids[0]!);
    if (!extra) continue;
    sec.ids.push(...extra.ids);
    index.handles.set(sec.handle, sec.ids);
    for (const id of extra.ids) if (!index.handleOf.has(id)) index.handleOf.set(id, sec.handle);
    if (extra.note) sec.data.note = cut(extra.note, 160);
  }

  const itemEntries: { el: SceneElement | null; ids: string[]; rect: Rect; frameId: string | null; data: Record<string, unknown>; hasText: boolean }[] = [];
  for (const el of singles) {
    const r = rectOf(el);
    const c = custom(el);
    const kind =
      c.kind === "live-embed"
        ? "live_embed"
        : typeof c.shape === "string"
          ? c.shape
          : isSticky(el)
            ? "sticky"
            : el.type === "embeddable" || el.type === "iframe"
              ? "embed"
              : el.type;
    const text = el.type === "text" ? textOf(el) : (boundText.get(el.id) ?? "");
    const data: Record<string, unknown> = { kind };
    if (text) data.text = text;
    data.x = round(r.x);
    data.y = round(r.y);
    data.w = round(r.w);
    data.h = round(r.h);
    const partFill = partsOf
      .get(el.id)
      ?.map((id) => byId.get(id))
      .map((p) => (p?.backgroundColor && p.backgroundColor !== "transparent" ? p.backgroundColor : p?.strokeColor))
      .find((b) => typeof b === "string" && b !== "transparent");
    const color = el.type === "text" || el.type === "line" ? colorName(el.strokeColor) : (colorName(partFill ?? el.backgroundColor) ?? undefined);
    if (color && color !== "black" && color !== "#1e1e1e") data.color = color;
    if (el.type === "text" && num(el.fontSize) >= 26) data.size = num(el.fontSize) >= 32 ? "title" : "heading";
    if (subtitles.has(el.id)) data.subtitle = cut(subtitles.get(el.id)!, 160);
    if (el.strokeStyle === "dashed" && kind !== "text") data.dashed = 1;
    if (c.createdBy === "ai") data.ai = 1;
    if (el.locked) data.locked = 1;
    if (c.suggestion) data.suggestion = 1;
    if (c.aiKind === "timeline-item") data.timeline = 1;
    if (typeof el.link === "string" && el.link && kind !== "live_embed") data.link = cut(el.link, 120);
    if (kind === "live_embed") {
      data.embed = String(c.embedKind ?? "custom");
      if (typeof c.title === "string") data.text = cut(c.title, 120);
    }
    if (typeof c.style === "string") data.style = c.style;
    const ids = [el.id];
    const bound = (el.boundElements as { id: string; type: string }[] | null) ?? [];
    for (const b of bound) if (b.type === "text" && byId.has(b.id)) ids.push(b.id);
    ids.push(...(partsOf.get(el.id) ?? []));
    itemEntries.push({ el, ids, rect: r, frameId: frameOf(el), data, hasText: !!text });
  }
  for (const [key, els] of blocks) {
    const r = union(els.map(rectOf))!;
    const [kind] = key.split(":");
    const first = els[0]!;
    const data: Record<string, unknown> = {};
    if (els.some((e) => e.locked)) data.locked = 1;
    if (kind === "table") {
      const t = readTable(els);
      data.kind = "table";
      if (t.title) data.text = t.title;
      data.columns = t.columns.map((c) => cut(c, 40));
      data.rows = t.rows.slice(0, 25).map((row) => row.map((c) => cut(c, 60)));
      if (t.rows.length > 25) data.more_rows = t.rows.length - 25;
    } else if (kind === "card") {
      const rect = els.find((e) => e.type === "rectangle");
      const parts = els.filter((e) => e.type === "text").sort((a, b) => num(a.y) - num(b.y));
      data.kind = "card";
      data.text = parts.map(textOf).join("\n");
      const fill = colorName(rect?.backgroundColor);
      if (fill) data.color = fill;
      if (custom(rect ?? first).timeline) data.timeline = 1;
    } else if (kind === "illustration") {
      data.kind = "illustration";
      data.text = String(custom(first).illustration ?? "drawing");
    } else if (kind === "chart-part") {
      data.kind = "chart";
      data.text = String(custom(first).chart ?? chartTitle(els));
    } else if (kind === "timeline-part") {
      data.kind = "timeline_axis";
    } else {
      data.kind = "stat_card";
      data.text = els
        .filter((e) => e.type === "text")
        .sort((a, b) => num(a.y) - num(b.y))
        .map(textOf)
        .join(" · ");
    }
    Object.assign(data, { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) });
    if (custom(first).createdBy === "ai") data.ai = 1;
    // Primary element first (the card's rectangle; arrows bind to it).
    const ordered = [...els].sort((a, b) => (a.type === "rectangle" ? -1 : 0) - (b.type === "rectangle" ? -1 : 0));
    const ids = ordered.map((e) => e.id);
    for (const el of els) {
      for (const b of (el.boundElements as { id: string; type: string }[] | null) ?? []) if (b.type === "text") ids.push(b.id);
    }
    itemEntries.push({ el: null, ids, rect: r, frameId: frameOf(first), data, hasText: !!data.text });
  }
  for (const group of clusterSketches(strokes, new Set(opts.focusIds ?? []))) {
    const r = union(group.map(rectOf))!;
    itemEntries.push({
      el: null,
      ids: group.map((g) => g.id),
      rect: r,
      frameId: frameOf(group[0]!),
      data: { kind: "sketch", strokes: group.length, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) },
      hasText: false,
    });
  }
  itemEntries.sort((a, b) => {
    const fa = a.frameId ? frameOrder.get(a.frameId)! : Infinity;
    const fb = b.frameId ? frameOrder.get(b.frameId)! : Infinity;
    if (fa !== fb) return fa - fb;
    return readingOrder(a.rect, b.rect);
  });
  let e = 0;
  let k = 0;
  let b = 0;
  const items: Entry[] = itemEntries.map((it) => {
    const kind = it.data.kind;
    const handle = kind === "sketch" ? `k${++k}` : kind === "chart" || kind === "table" || kind === "timeline_axis" ? `b${++b}` : `e${++e}`;
    assign(handle, it.ids);
    return { handle, ids: it.ids, rect: it.rect, frameId: it.frameId, data: { id: handle, ...it.data }, hasText: it.hasText };
  });
  const sectionHandle = (frameId: string | null) => (frameId ? index.handleOf.get(frameId) : undefined);
  for (const it of items) {
    const s = sectionHandle(it.frameId);
    if (s) it.data.in = s;
  }

  // Votes: count per item (a vote targets the item's main element or any of its parts).
  const voteTally: { handle: string; text: string; votes: number; names: string[] }[] = [];
  for (const it of [...sectionEntries, ...items]) {
    const names: string[] = [];
    for (const id of it.ids) names.push(...(votesOn.get(id)?.names ?? []));
    if (!names.length) continue;
    it.data.votes = names.length;
    voteTally.push({ handle: it.handle, text: cut(String(it.data.text ?? it.data.name ?? ""), 80), votes: names.length, names });
  }
  voteTally.sort((a, b2) => b2.votes - a.votes);

  // Comments: one entry each (handle m1, m2…), pointing at the item they're pinned to.
  const commentEntries = comments
    .map((el) => ({ el, c: custom(el) }))
    .sort((a, b2) => String(a.c.createdAt ?? "").localeCompare(String(b2.c.createdAt ?? "")))
    .map(({ el, c }, i) => {
      const handle = `m${i + 1}`;
      assign(handle, [el.id]);
      const target = typeof c.targetId === "string" ? index.handleOf.get(c.targetId) : undefined;
      const data: Record<string, unknown> = {
        id: handle,
        kind: "comment",
        by: cut(String(c.authorName ?? "Someone"), 60),
        text: cut(String(c.text ?? ""), 400),
      };
      if (target) data.on = target;
      if (typeof c.createdAt === "string" || typeof c.createdAt === "number")
        data.at = String(new Date(c.createdAt as string).toISOString?.() ?? c.createdAt).slice(0, 16);
      if (c.resolved) data.resolved = 1;
      // Sent to the AI as its own request when it was posted (already handled then).
      if (c.sentToAi) data.sent_to_ai = 1;
      return data;
    });

  arrows.sort((a, b2) => readingOrder(rectOf(a), rectOf(b2)));
  const arrowEntries: Entry[] = arrows.map((a, i) => {
    const handle = `a${i + 1}`;
    const ids = [a.id];
    for (const bnd of (a.boundElements as { id: string; type: string }[] | null) ?? []) if (bnd.type === "text") ids.push(bnd.id);
    assign(handle, ids);
    const from = (a.startBinding as { elementId?: string } | null)?.elementId;
    const to = (a.endBinding as { elementId?: string } | null)?.elementId;
    const r = rectOf(a);
    const data: Record<string, unknown> = { id: handle, kind: "arrow" };
    data.from = from ? (index.handleOf.get(from) ?? "?") : null;
    data.to = to ? (index.handleOf.get(to) ?? "?") : null;
    if (!from || !to) Object.assign(data, { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) });
    const label = boundText.get(a.id);
    if (label) data.label = label;
    if (a.strokeStyle === "dashed") data.dashed = 1;
    if (custom(a).suggestion) data.suggestion = 1;
    const s = sectionHandle(frameOf(a));
    if (s) data.in = s;
    return { handle, ids, rect: r, frameId: frameOf(a), data, hasText: !!label };
  });

  // Focus
  const focusIdSet = new Set<string>();
  for (const id of opts.focusIds ?? []) {
    const el = byId.get(id);
    if (!el) continue;
    if (el.type === "text" && typeof el.containerId === "string" && byId.has(el.containerId)) focusIdSet.add(el.containerId);
    else focusIdSet.add(id);
  }
  const focusHandles = new Set<string>();
  for (const id of focusIdSet) {
    const h = index.handleOf.get(id);
    if (h) focusHandles.add(h);
    if (frameIds.has(id)) for (const it of [...items, ...arrowEntries]) if (it.frameId === id) focusHandles.add(it.handle);
  }
  const focusRect = union(
    [...focusHandles].flatMap((h) =>
      (index.handles.get(h) ?? [])
        .map((id) => byId.get(id))
        .filter((x): x is SceneElement => !!x)
        .map(rectOf),
    ),
  );

  // Truncation for big boards
  const total = sectionEntries.length + items.length + arrowEntries.length;
  const viewport = opts.viewport ?? null;
  const priority = (it: Entry) => (focusHandles.has(it.handle) ? 0 : 4) + (viewport && intersects(it.rect, viewport) ? 0 : 2) + (it.hasText ? 0 : 1);
  let shownItems = items;
  let shownArrows = arrowEntries;
  const budget = Math.max(40, maxItems - sectionEntries.length);
  if (items.length + arrowEntries.length > budget) {
    const ranked = [...items].sort((a, b2) => priority(a) - priority(b2));
    const keep = new Set(ranked.slice(0, Math.floor(budget * 0.8)).map((x) => x.handle));
    shownItems = items.filter((x) => keep.has(x.handle));
    const arrowBudget = budget - shownItems.length;
    shownArrows = arrowEntries.filter((a) => keep.has(String(a.data.from)) || keep.has(String(a.data.to))).slice(0, Math.max(0, arrowBudget));
  }
  for (const it of [...shownItems, ...shownArrows]) {
    const limit = focusHandles.has(it.handle) ? maxText * 4 : maxText;
    for (const key of ["text", "label"] as const) if (typeof it.data[key] === "string") it.data[key] = cut(it.data[key] as string, limit);
  }

  const contentRect = union(live.filter((x) => !(x.type === "text" && x.containerId)).map(rectOf));
  const lines: string[] = [];
  lines.push("## Board");
  if (!live.length) lines.push("The board is empty.");
  else {
    const shown = sectionEntries.length + shownItems.length + shownArrows.length;
    lines.push(`${total} entries${shown < total ? `, ${shown} shown (the rest are less relevant and omitted)` : ""}.`);
    if (contentRect) {
      lines.push(
        `Content spans x ${round(contentRect.x)}..${round(contentRect.x + contentRect.w)}, y ${round(contentRect.y)}..${round(contentRect.y + contentRect.h)}.`,
      );
    }
  }
  if (viewport) {
    lines.push(`The user is looking at x ${round(viewport.x)}..${round(viewport.x + viewport.w)}, y ${round(viewport.y)}..${round(viewport.y + viewport.h)}.`);
  }
  if (opts.people?.length) {
    lines.push(`People on this board: ${opts.people.map((p) => `${p.name}${p.online ? " (online)" : ""}`).join(", ")}.`);
  }
  if (focusHandles.size) {
    lines.push("");
    lines.push("## Focus");
    lines.push(
      `The user selected an area of the board: ${[...focusHandles].slice(0, 200).join(", ")}${focusRect ? ` (x ${round(focusRect.x)}..${round(focusRect.x + focusRect.w)}, y ${round(focusRect.y)}..${round(focusRect.y + focusRect.h)})` : ""}. Answer about and act on only this area unless asked otherwise.`,
    );
  }
  if (live.length) {
    lines.push("");
    lines.push("## Elements (one JSON object per line; `id` is a handle you can pass to tools; `in` is the section it belongs to)");
    const bySection = new Map<string, Entry[]>();
    for (const it of shownItems) {
      const key = String(it.data.in ?? "");
      bySection.set(key, [...(bySection.get(key) ?? []), it]);
    }
    for (const s of sectionEntries) {
      const children = bySection.get(s.handle) ?? [];
      lines.push(JSON.stringify({ ...s.data, items: items.filter((x) => x.frameId === s.ids[0]).length }));
      for (const c of children) lines.push(JSON.stringify(c.data));
    }
    for (const c of bySection.get("") ?? []) lines.push(JSON.stringify(c.data));
    for (const a of shownArrows) lines.push(JSON.stringify(a.data));
  }
  const open = commentEntries.filter((c) => !c.resolved);
  if (commentEntries.length) {
    lines.push("");
    lines.push(
      `## Comments (${open.length} open${commentEntries.length > open.length ? `, ${commentEntries.length - open.length} resolved` : ""}; \`on\` is the item a comment is pinned to)`,
    );
    for (const c of commentEntries.slice(0, 60)) lines.push(JSON.stringify(c));
  }
  if (voteTally.length) {
    lines.push("");
    lines.push(`## Votes (${voteTally.reduce((n, v) => n + v.votes, 0)} total, most first)`);
    for (const v of voteTally.slice(0, 40))
      lines.push(`${v.handle} "${v.text}": ${v.votes} vote${v.votes === 1 ? "" : "s"} (${[...new Set(v.names)].slice(0, 8).join(", ")})`);
  }
  return {
    text: lines.join("\n"),
    index,
    focusRect,
    contentRect,
    focusHandles: [...focusHandles],
    shown: sectionEntries.length + shownItems.length + shownArrows.length,
    total,
  };
}
