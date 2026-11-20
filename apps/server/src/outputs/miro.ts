// Board -> a new Miro board through the Miro REST API v2, using an access token the user supplies.
// The token is used for this request only; it is never stored or logged.
import type { SceneElement } from "@monet/board-protocol";
import { Scene, bindingId, boxOf, decodeDataUrl, escapeHtml, extForMime, frameName, hexColor, isTransparent, num, str, textOf, type BoardFile } from "./scene";
import { ExternalApiError } from "./lucid";

export const MIRO_API_BASE = () => process.env.MIRO_API_BASE || "https://api.miro.com";
const MAX_ITEMS = 1000;
const CONCURRENCY = 4;

const MIRO_STICKY_COLORS: [string, string][] = [
  ["gray", "#f5f6f8"],
  ["light_yellow", "#fff9b1"],
  ["yellow", "#f5d128"],
  ["orange", "#ff9d48"],
  ["light_green", "#d5f692"],
  ["green", "#c9df56"],
  ["dark_green", "#93d275"],
  ["cyan", "#67c6c0"],
  ["light_pink", "#ffcee0"],
  ["pink", "#ea94bb"],
  ["violet", "#c6a2d2"],
  ["red", "#f0939d"],
  ["light_blue", "#a6ccf5"],
  ["blue", "#6cd8fa"],
  ["dark_blue", "#9ea9ff"],
  ["black", "#000000"],
];

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Miro sticky notes only accept named colors; pick the closest one. */
export function nearestStickyColor(color: unknown): string {
  const target = rgb(hexColor(color, "#fff3bf"));
  let best = "light_yellow";
  let bestD = Infinity;
  for (const [name, hex] of MIRO_STICKY_COLORS) {
    const c = rgb(hex);
    const d = (c[0] - target[0]) ** 2 + (c[1] - target[1]) ** 2 + (c[2] - target[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

function html(text: string): string {
  return text
    .split("\n")
    .map((l) => `<p>${escapeHtml(l) || "&nbsp;"}</p>`)
    .join("");
}

function borderStyle(el: SceneElement) {
  const s = String(el.strokeStyle ?? "solid");
  return s === "dashed" ? "dashed" : s === "dotted" ? "dotted" : "normal";
}

function cap(h: unknown): string {
  switch (h) {
    case "arrow":
      return "stealth";
    case "triangle":
      return "filled_triangle";
    case "triangle_outline":
      return "triangle";
    case "dot":
    case "circle":
      return "filled_oval";
    case "circle_outline":
      return "oval";
    case "diamond":
      return "filled_diamond";
    case "diamond_outline":
      return "diamond";
    default:
      return "none";
  }
}

export interface MiroRequest {
  path: string;
  body?: Record<string, unknown>;
  form?: FormData;
}

export interface MiroResult {
  boardId: string;
  boardUrl: string;
  counts: Record<string, number>;
  skipped: Record<string, number>;
  failed: number;
}

class MiroClient {
  constructor(private token: string) {}

  async post(req: MiroRequest): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${MIRO_API_BASE()}${req.path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(req.form ? {} : { "Content-Type": "application/json" }),
        },
        body: req.form ?? JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 4) {
        const wait = Math.min(10_000, Number(res.headers.get("retry-after") || 0) * 1000 || 500 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* ignore */
      }
      if (res.status === 401) throw new ExternalApiError("Miro rejected the access token. Check that it's current and copied in full.", 400);
      if (res.status === 403) throw new ExternalApiError("The Miro token doesn't allow creating boards. It needs the boards:write scope.", 400);
      if (!res.ok) {
        const msg = (data.message as string) || text.slice(0, 200) || `HTTP ${res.status}`;
        const err = new ExternalApiError(`Miro: ${msg}`, res.status >= 500 ? 502 : 400);
        throw err;
      }
      return data;
    }
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        await fn(item);
      }
    }),
  );
}

export async function sendToMiro(args: { token: string; scene: Scene; title: string; files: Map<string, BoardFile>; sourceUrl?: string }): Promise<MiroResult> {
  const { scene } = args;
  const client = new MiroClient(args.token);
  const counts: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  let failed = 0;
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

  const board = await client.post({
    path: "/v2/boards",
    body: {
      name: (args.title || "Monet Blackboard board").slice(0, 60),
      description: `Sent from Monet Blackboard${args.sourceUrl ? `: ${args.sourceUrl}` : ""}`.slice(0, 300),
    },
  });
  const boardId = str(board.id);
  if (!boardId) throw new ExternalApiError("Miro didn't return a board id.");
  const boardUrl = str(board.viewLink) ?? `https://miro.com/app/board/${encodeURIComponent(boardId)}/`;
  const base = `/v2/boards/${encodeURIComponent(boardId)}`;
  const miroIds = new Map<string, string>();

  // Frames first; their children are positioned relative to the frame's top-left corner.
  const frames = scene.frames();
  const frameBoxes = new Map(frames.map((f) => [f.id, boxOf(f)]));
  await pool(frames, CONCURRENCY, async (f) => {
    const b = boxOf(f);
    try {
      const r = await client.post({
        path: `${base}/frames`,
        body: {
          data: { title: frameName(f).slice(0, 200), format: "custom", type: "freeform" },
          style: { fillColor: "#ffffff" },
          position: { x: b.x + b.w / 2, y: b.y + b.h / 2, origin: "center" },
          geometry: { width: Math.max(100, b.w), height: Math.max(100, b.h) },
        },
      });
      if (str(r.id)) miroIds.set(f.id, str(r.id)!);
      bump(counts, "sections");
    } catch (err) {
      if (err instanceof ExternalApiError && err.status === 400 && /token|scope/.test(err.message)) throw err;
      failed++;
    }
  });

  const placement = (el: SceneElement) => {
    const b = boxOf(el);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const fid = str(el.frameId);
    const parentId = fid ? miroIds.get(fid) : undefined;
    const fb = fid ? frameBoxes.get(fid) : undefined;
    if (parentId && fb) {
      return { position: { x: cx - fb.x, y: cy - fb.y, origin: "center" }, parent: { id: parentId } };
    }
    return { position: { x: cx, y: cy, origin: "center" } };
  };

  const items = scene.items().filter((e) => scene.kindOf(e) !== "frame");
  const toCreate: { el: SceneElement; req: MiroRequest; kind: string }[] = [];
  for (const el of items) {
    const kind = scene.kindOf(el);
    const b = boxOf(el);
    const label = scene.boundText.get(el.id);
    const labelText = label ? textOf(label) : "";
    const deg = Math.round((num(el.angle) * 180) / Math.PI);
    const rotation = deg ? { rotation: deg } : {};
    switch (kind) {
      case "sticky":
        toCreate.push({
          el,
          kind: "stickies",
          req: {
            path: `${base}/sticky_notes`,
            body: {
              data: { content: html(labelText), shape: b.w / b.h > 1.3 ? "rectangle" : "square" },
              style: { fillColor: nearestStickyColor(el.backgroundColor), textAlign: "center", textAlignVertical: "middle" },
              geometry: { width: Math.max(50, b.w) },
              ...placement(el),
            },
          },
        });
        break;
      case "rectangle":
      case "ellipse":
      case "diamond": {
        const shape = kind === "ellipse" ? "circle" : kind === "diamond" ? "rhombus" : el.roundness ? "round_rectangle" : "rectangle";
        toCreate.push({
          el,
          kind: "shapes",
          req: {
            path: `${base}/shapes`,
            body: {
              data: { shape, content: labelText ? html(labelText) : "" },
              style: {
                ...(isTransparent(el.backgroundColor) ? {} : { fillColor: hexColor(el.backgroundColor, "#ffffff"), fillOpacity: "1.0" }),
                borderColor: hexColor(el.strokeColor),
                borderWidth: String(Math.min(24, Math.max(1, num(el.strokeWidth, 2)))),
                borderStyle: borderStyle(el),
                color: hexColor(label?.strokeColor),
                fontSize: String(Math.max(10, Math.round(num(label?.fontSize, 20)))),
                textAlign: str(label?.textAlign) ?? "center",
                textAlignVertical: str(label?.verticalAlign) === "top" ? "top" : str(label?.verticalAlign) === "bottom" ? "bottom" : "middle",
              },
              geometry: { width: Math.max(8, b.w), height: Math.max(8, b.h), ...rotation },
              ...placement(el),
            },
          },
        });
        break;
      }
      case "text": {
        const t = textOf(el);
        if (!t) break;
        toCreate.push({
          el,
          kind: "text",
          req: {
            path: `${base}/texts`,
            body: {
              data: { content: html(t) },
              style: {
                color: hexColor(el.strokeColor),
                fontSize: String(Math.max(10, Math.round(num(el.fontSize, 20)))),
                textAlign: str(el.textAlign) ?? "left",
              },
              geometry: { width: Math.max(20, b.w + 8), ...rotation },
              ...placement(el),
            },
          },
        });
        break;
      }
      case "embed": {
        const url = str(el.link) ?? "";
        if (!/^https?:\/\//i.test(url)) {
          bump(skipped, "embeds without a link");
          break;
        }
        toCreate.push({
          el,
          kind: "links",
          req: {
            path: `${base}/texts`,
            body: {
              data: { content: `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` },
              style: { fontSize: "16", textAlign: "left" },
              geometry: { width: Math.max(120, b.w) },
              ...placement(el),
            },
          },
        });
        break;
      }
      case "image": {
        const file = args.files.get(str(el.fileId) ?? "");
        const decoded = file ? decodeDataUrl(file.dataURL) : null;
        if (!decoded) {
          bump(skipped, "images with missing files");
          break;
        }
        if (decoded.bytes.length > 6 * 1024 * 1024) {
          bump(skipped, "images over 6 MB");
          break;
        }
        const form = new FormData();
        form.append(
          "data",
          new Blob([JSON.stringify({ title: "image", geometry: { width: Math.max(10, b.w), ...rotation }, ...placement(el) })], { type: "application/json" }),
        );
        form.append("resource", new Blob([new Uint8Array(decoded.bytes)], { type: decoded.mimeType }), `image.${extForMime(decoded.mimeType)}`);
        toCreate.push({ el, kind: "images", req: { path: `${base}/images`, form } });
        break;
      }
      case "freedraw":
        bump(skipped, "freehand drawings");
        break;
      case "arrow":
      case "line":
        break;
      default:
        bump(skipped, `other (${el.type})`);
    }
  }

  if (toCreate.length > MAX_ITEMS) {
    skipped[`items beyond the first ${MAX_ITEMS}`] = toCreate.length - MAX_ITEMS;
    toCreate.length = MAX_ITEMS;
  }

  await pool(toCreate, CONCURRENCY, async ({ el, req, kind }) => {
    try {
      const r = await client.post(req);
      if (str(r.id)) miroIds.set(el.id, str(r.id)!);
      bump(counts, kind);
    } catch (err) {
      if (err instanceof ExternalApiError && err.status === 400 && /token|scope/.test(err.message)) throw err;
      failed++;
    }
  });

  // Connectors: Miro's API only supports connectors between two items.
  const connectors: MiroRequest[] = [];
  for (const el of scene.elements) {
    if (el.type !== "arrow" && el.type !== "line") continue;
    const src = el.type === "arrow" ? bindingId(el.startBinding) : null;
    const dst = el.type === "arrow" ? bindingId(el.endBinding) : null;
    const a = src ? miroIds.get(src) : undefined;
    const b = dst ? miroIds.get(dst) : undefined;
    if (!a || !b) {
      bump(skipped, el.type === "arrow" ? "arrows not connected at both ends" : "lines");
      continue;
    }
    const label = scene.labelOf(el);
    connectors.push({
      path: `${base}/connectors`,
      body: {
        startItem: { id: a, snapTo: "auto" },
        endItem: { id: b, snapTo: "auto" },
        shape: el.elbowed ? "elbowed" : el.roundness ? "curved" : "straight",
        style: {
          strokeColor: hexColor(el.strokeColor),
          strokeWidth: String(Math.max(1, Math.min(24, num(el.strokeWidth, 2)))),
          strokeStyle: borderStyle(el),
          startStrokeCap: cap(el.startArrowhead),
          endStrokeCap: cap(el.endArrowhead),
        },
        ...(label ? { captions: [{ content: escapeHtml(label).slice(0, 200) }] } : {}),
      },
    });
  }
  await pool(connectors, CONCURRENCY, async (req) => {
    try {
      await client.post(req);
      bump(counts, "connectors");
    } catch (err) {
      if (err instanceof ExternalApiError && err.status === 400 && /token|scope/.test(err.message)) throw err;
      failed++;
    }
  });

  return { boardId, boardUrl, counts, skipped, failed };
}
