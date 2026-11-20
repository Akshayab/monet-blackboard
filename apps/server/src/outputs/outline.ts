// Turns a board into a compact text outline the AI can read: sections (frames) with their items in
// reading order, loose items, and the connections between items.
import type { SceneElement } from "@monet/board-protocol";
import { Scene, bindingId, boxOf, colorName, frameName, str, textOf } from "./scene";

const MAX_CHARS = 90_000;

function clip(s: string, n = 600): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Reading order: rows (by y, bucketed), then left to right. */
function readingOrder(items: SceneElement[]): SceneElement[] {
  return [...items].sort((a, b) => {
    const ba = boxOf(a);
    const bb = boxOf(b);
    const ra = Math.round(ba.y / 120);
    const rb = Math.round(bb.y / 120);
    return ra !== rb ? ra - rb : ba.x - bb.x;
  });
}

export function describeItem(scene: Scene, el: SceneElement): string | null {
  const kind = scene.kindOf(el);
  const b = boxOf(el);
  const at = `@${Math.round(b.x / 10) * 10},${Math.round(b.y / 10) * 10}`;
  const link = str(el.link);
  const linkPart = link ? ` (link: ${link})` : "";
  switch (kind) {
    case "sticky": {
      const color = colorName(el.backgroundColor);
      return `- [sticky${color ? ", " + color : ""}] "${clip(scene.labelOf(el))}" ${at}${linkPart}`;
    }
    case "rectangle":
    case "ellipse":
    case "diamond": {
      const label = scene.labelOf(el);
      const color = el.backgroundColor && el.backgroundColor !== "transparent" ? colorName(el.backgroundColor) : null;
      if (!label && !link) return `- [${kind}${color ? ", " + color : ""}] (empty) ${at}`;
      return `- [${kind}${color ? ", " + color : ""}] "${clip(label)}" ${at}${linkPart}`;
    }
    case "text": {
      const t = textOf(el);
      if (!t) return null;
      const size = Number(el.fontSize ?? 20);
      const role = size >= 32 ? "heading" : size >= 24 ? "subheading" : "text";
      return `- [${role}] "${clip(t, 1500)}" ${at}${linkPart}`;
    }
    case "image":
      return `- [image] ${at}${linkPart}`;
    case "embed":
      return `- [embedded page] ${link ?? ""} ${at}`;
    case "freedraw":
      return null;
    case "arrow":
    case "line": {
      // Unconnected arrows with labels still carry meaning.
      const label = scene.labelOf(el);
      if (bindingId(el.startBinding) || bindingId(el.endBinding)) return null;
      return label ? `- [${kind} label] "${clip(label)}" ${at}` : null;
    }
    default:
      return null;
  }
}

function nameFor(scene: Scene, id: string | null): string | null {
  if (!id) return null;
  const el = scene.byId.get(id);
  if (!el) return null;
  const kind = scene.kindOf(el);
  if (kind === "frame") return `section "${frameName(el)}"`;
  if (kind === "text") return `"${clip(textOf(el), 80)}"`;
  const label = scene.labelOf(el);
  return label ? `"${clip(label, 80)}"` : `(unlabeled ${kind})`;
}

export interface OutlineResult {
  text: string;
  counts: { items: number; sections: number; connections: number; truncated: boolean };
}

export function boardOutline(title: string, scene: Scene, opts: { selection?: boolean } = {}): OutlineResult {
  const lines: string[] = [];
  lines.push(`Board title: "${title}"`);
  if (opts.selection) lines.push("(Only the part of the board the user selected.)");
  lines.push("Coordinates: @x,y with x to the right and y downward. Items close together usually belong together.");
  lines.push("");

  const frames = readingOrder(scene.frames());
  const inFrame = new Set<string>();
  let items = 0;

  for (const f of frames) {
    lines.push(`## Section "${frameName(f)}" ${`@${Math.round(boxOf(f).x)},${Math.round(boxOf(f).y)}`}`);
    const children = readingOrder(scene.childrenOf(f.id));
    let any = false;
    for (const c of children) {
      inFrame.add(c.id);
      const d = describeItem(scene, c);
      if (d) {
        lines.push(d);
        items++;
        any = true;
      }
    }
    if (!any) lines.push("- (empty section)");
    lines.push("");
  }

  const loose = readingOrder(scene.items().filter((e) => !inFrame.has(e.id) && scene.kindOf(e) !== "frame"));
  const looseLines = loose.map((e) => describeItem(scene, e)).filter((x): x is string => !!x);
  if (looseLines.length) {
    lines.push(frames.length ? "## Items outside any section" : "## Items");
    lines.push(...looseLines);
    items += looseLines.length;
    lines.push("");
  }

  const freehand = scene.elements.filter((e) => e.type === "freedraw").length;
  if (freehand) lines.push(`(${freehand} freehand drawing${freehand === 1 ? "" : "s"} not described.)`, "");

  const connections: string[] = [];
  for (const el of scene.elements) {
    if (el.type !== "arrow" && el.type !== "line") continue;
    const from = nameFor(scene, bindingId(el.startBinding));
    const to = nameFor(scene, bindingId(el.endBinding));
    if (!from && !to) continue;
    const label = scene.labelOf(el);
    const twoWay = el.startArrowhead && el.endArrowhead;
    connections.push(`- ${from ?? "(loose end)"} ${twoWay ? "<->" : "->"} ${to ?? "(loose end)"}${label ? ` (label: "${clip(label, 120)}")` : ""}`);
  }
  if (connections.length) {
    lines.push("## Connections (arrows)");
    lines.push(...connections);
    lines.push("");
  }

  let text = lines.join("\n");
  let truncated = false;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + "\n…(board outline truncated)";
    truncated = true;
  }
  return { text, counts: { items, sections: frames.length, connections: connections.length, truncated } };
}
