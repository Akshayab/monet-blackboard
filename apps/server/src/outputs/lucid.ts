// Board -> Lucid Standard Import (.lucid = zip with document.json and images/). Optionally creates the
// document directly through Lucid's REST API when the user supplies their own Lucid API key / token.
import JSZip from "jszip";
import type { SceneElement } from "@monet/board-protocol";
import {
  Scene,
  absPoints,
  bindingId,
  boxOf,
  decodeDataUrl,
  escapeHtml,
  extForMime,
  frameName,
  hexColor,
  isTransparent,
  num,
  simplify,
  str,
  textOf,
  type BoardFile,
} from "./scene";

const LUCID_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/bmp", "image/tiff", "image/svg+xml"]);

function strokeOf(el: SceneElement, fallbackWidth = 1) {
  const s = String(el.strokeStyle ?? "solid");
  return {
    color: hexColor(el.strokeColor),
    width: Math.max(1, Math.round(num(el.strokeWidth, fallbackWidth))),
    style: s === "dashed" ? "dashed" : s === "dotted" ? "dotted" : "solid",
  };
}

function htmlText(text: string, opts: { fontSizePx?: number; align?: string; color?: string } = {}): string {
  const body = escapeHtml(text).replace(/\n/g, "<br>");
  const css: string[] = [];
  if (opts.fontSizePx) css.push(`font-size: ${Math.max(6, Math.round(opts.fontSizePx * 0.75))}pt`);
  if (opts.align) css.push(`text-align: ${opts.align}`);
  if (opts.color) css.push(`color: ${opts.color}`);
  return css.length ? `<p style="${css.join(";")}">${body}</p>` : body;
}

function endpointStyle(h: unknown): string {
  switch (h) {
    case "arrow":
      return "openArrow";
    case "triangle":
      return "arrow";
    case "triangle_outline":
      return "hollowArrow";
    case "dot":
    case "circle":
      return "closedCircle";
    case "circle_outline":
      return "openCircle";
    default:
      return "none";
  }
}

function bbox(el: SceneElement) {
  const b = boxOf(el);
  const deg = (num(el.angle) * 180) / Math.PI;
  const rotation = ((deg % 360) + 360) % 360;
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), ...(rotation ? { rotation: Math.round(rotation) } : {}) };
}

export interface LucidResult {
  zip: Buffer;
  document: Record<string, unknown>;
  counts: Record<string, number>;
  skipped: string[];
}

export async function sceneToLucid(scene: Scene, title: string, files: Map<string, BoardFile>): Promise<LucidResult> {
  const shapes: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const zip = new JSZip();
  const shapeIds = new Set<string>();
  let z = 0;

  const ordered = [...scene.frames(), ...scene.items().filter((e) => scene.kindOf(e) !== "frame")];
  // Pass 1: shapes (so lines can reference them).
  for (const el of ordered) {
    const kind = scene.kindOf(el);
    const label = scene.boundText.get(el.id);
    const labelText = label ? textOf(label) : "";
    const fill = isTransparent(el.backgroundColor) ? "#ffffff00" : hexColor(el.backgroundColor, "#ffffff");
    const id = `s-${el.id}`;
    const opacity = num(el.opacity, 100) < 100 ? { opacity: Math.round(num(el.opacity, 100)) } : {};
    switch (kind) {
      case "frame":
        shapes.push({
          id,
          type: "roundedRectangleContainer",
          boundingBox: bbox({ ...el, angle: 0 }),
          style: { fill: { type: "color", color: "#ffffff00" }, stroke: { color: "#adb5bd", width: 1, style: "solid" } },
          containerTitle: { text: frameName(el) },
          magnetize: true,
          zIndex: z++,
        });
        bump("sections");
        break;
      case "sticky":
        shapes.push({
          id,
          type: "stickyNote",
          boundingBox: bbox(el),
          style: { fill: { type: "color", color: fill } },
          text: htmlText(labelText),
          zIndex: z++,
          ...opacity,
        });
        bump("stickies");
        break;
      case "rectangle":
      case "ellipse":
      case "diamond":
        shapes.push({
          id,
          type: kind === "rectangle" ? "rectangle" : kind === "ellipse" ? "circle" : "diamond",
          boundingBox: bbox(el),
          style: {
            fill: { type: "color", color: fill },
            stroke: strokeOf(el),
            ...(kind === "rectangle" && el.roundness ? { rounding: 16 } : {}),
          },
          ...(labelText ? { text: htmlText(labelText, { fontSizePx: num(label?.fontSize, 20), color: hexColor(label?.strokeColor) }) } : {}),
          zIndex: z++,
          ...opacity,
        });
        bump("shapes");
        break;
      case "text": {
        const t = textOf(el);
        if (!t) break;
        shapes.push({
          id,
          type: "text",
          boundingBox: bbox(el),
          text: htmlText(t, { fontSizePx: num(el.fontSize, 20), align: str(el.textAlign) ?? "left", color: hexColor(el.strokeColor) }),
          zIndex: z++,
          ...opacity,
        });
        bump("text");
        break;
      }
      case "image": {
        const file = files.get(str(el.fileId) ?? "");
        const decoded = file ? decodeDataUrl(file.dataURL) : null;
        if (!decoded) {
          skipped.push("image (file missing)");
          break;
        }
        if (!LUCID_IMAGE_MIMES.has(decoded.mimeType)) {
          skipped.push(`image (${decoded.mimeType} isn't supported by Lucid)`);
          break;
        }
        const name = `${str(el.fileId)}.${extForMime(decoded.mimeType)}`;
        zip.file(`images/${name}`, decoded.bytes);
        shapes.push({
          id,
          type: "image",
          boundingBox: bbox(el),
          stroke: { color: "#ffffff", width: 0, style: "solid" },
          image: { ref: name, imageScale: "stretch" },
          zIndex: z++,
        });
        bump("images");
        break;
      }
      case "embed": {
        const url = str(el.link) ?? "";
        shapes.push({
          id,
          type: "rectangle",
          boundingBox: bbox(el),
          style: { fill: { type: "color", color: "#f8f9fa" }, stroke: strokeOf(el) },
          text: htmlText(url),
          zIndex: z++,
        });
        bump("links");
        break;
      }
      case "freedraw": {
        const pts = simplify(absPoints(el), 4, 300);
        const ox = num(el.x);
        const oy = num(el.y);
        shapes.push({
          id,
          type: "freehandDrawing",
          style: { width: Math.max(1, Math.round(num(el.strokeWidth, 2))), color: hexColor(el.strokeColor) },
          offset: { x: Math.round(ox), y: Math.round(oy) },
          points: pts.map(([x, y]) => ({ x: Math.round(x - ox), y: Math.round(y - oy) })),
          zIndex: z++,
        });
        bump("drawings");
        break;
      }
      case "arrow":
      case "line":
        continue;
      default:
        skipped.push(String(el.type));
        continue;
    }
    shapeIds.add(el.id);
  }

  // Pass 2: arrows and lines.
  for (const el of ordered) {
    const kind = scene.kindOf(el);
    if (kind !== "arrow" && kind !== "line") continue;
    const pts = absPoints(el);
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const src = kind === "arrow" ? bindingId(el.startBinding) : null;
    const dst = kind === "arrow" ? bindingId(el.endBinding) : null;
    const ep = (bound: string | null, p: [number, number], head: unknown) =>
      bound && shapeIds.has(bound)
        ? { type: "shapeEndpoint", style: endpointStyle(head), shapeId: `s-${bound}` }
        : { type: "positionEndpoint", style: endpointStyle(head), position: { x: Math.round(p[0]), y: Math.round(p[1]) } };
    const curved = kind === "arrow" && !!el.roundness && !el.elbowed && pts.length > 2;
    const lineType = el.elbowed ? "elbow" : curved ? "curved" : "straight";
    const label = scene.labelOf(el);
    lines.push({
      id: `l-${el.id}`,
      lineType,
      endpoint1: ep(src, first, kind === "arrow" ? el.startArrowhead : null),
      endpoint2: ep(dst, last, kind === "arrow" ? el.endArrowhead : null),
      stroke: strokeOf(el, 2),
      ...(lineType === "straight" && pts.length > 2 ? { joints: pts.slice(1, -1).map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) })) } : {}),
      ...(label ? { text: [{ text: escapeHtml(label), position: 0.5, side: "middle" }] } : {}),
      zIndex: z++,
    });
    bump(kind === "arrow" ? "arrows" : "lines");
  }

  const document = {
    version: 1,
    pages: [{ id: "page1", title: (title || "Board").slice(0, 100), shapes, lines }],
    documentSettings: { units: "px" },
  };
  zip.file("document.json", JSON.stringify(document));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { zip: buf, document, counts, skipped };
}

export const LUCID_API_BASE = () => process.env.LUCID_API_BASE || "https://api.lucid.co";

export class ExternalApiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Creates a Lucidspark document from the import file with the user's own Lucid API key or OAuth token. */
export async function createLucidDocument(args: { token: string; zip: Buffer; title: string; product: "lucidspark" | "lucidchart" }) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(args.zip)], { type: "x-application/vnd.lucid.standardImport" }), "board.lucid");
  form.append("type", "x-application/vnd.lucid.standardImport");
  form.append("product", args.product);
  form.append("title", args.title.slice(0, 200));
  const res = await fetch(`${LUCID_API_BASE()}/v1/documents/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.token}`, "Lucid-Api-Version": "1", Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error */
  }
  if (res.status === 401 || res.status === 403) {
    throw new ExternalApiError("Lucid rejected the key. It needs the DocumentEdit permission (or a token with document.content access).", 400);
  }
  if (!res.ok) {
    const msg = (data.message as string) || (data.error as string) || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new ExternalApiError(`Lucid couldn't import the board: ${msg}`);
  }
  return {
    documentId: str(data.documentId),
    editUrl: str(data.editUrl),
    viewUrl: str(data.viewUrl),
  };
}
