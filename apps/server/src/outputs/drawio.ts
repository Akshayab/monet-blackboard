// Board -> draw.io / diagrams.net (.drawio, uncompressed mxGraph XML). Shapes, stickies, text, sections
// (as containers), bound arrows (as connected edges), lines, freehand (as polylines), images, links.
import type { SceneElement } from "@monet/board-protocol";
import {
  Scene,
  absPoints,
  bindingId,
  boxOf,
  decodeDataUrl,
  escapeHtml,
  frameName,
  hexColor,
  isTransparent,
  num,
  simplify,
  str,
  textOf,
  type BoardFile,
} from "./scene";

function xmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

function htmlLabel(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function style(parts: Record<string, string | number | boolean | null | undefined>, prefix = ""): string {
  const kv = Object.entries(parts)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${k}=${v === true ? 1 : v}`);
  return prefix + kv.join(";") + ";";
}

function strokeDash(el: SceneElement) {
  const s = String(el.strokeStyle ?? "solid");
  if (s === "dashed") return { dashed: 1 };
  if (s === "dotted") return { dashed: 1, dashPattern: "1 4" };
  return {};
}

function arrowHead(h: unknown): { arrow: string; fill: number } {
  switch (h) {
    case "arrow":
      return { arrow: "open", fill: 0 };
    case "triangle":
    case "triangle_outline":
      return { arrow: "block", fill: h === "triangle" ? 1 : 0 };
    case "dot":
    case "circle":
    case "circle_outline":
      return { arrow: "oval", fill: h === "circle_outline" ? 0 : 1 };
    case "bar":
      return { arrow: "dash", fill: 0 };
    case "diamond":
    case "diamond_outline":
      return { arrow: "diamond", fill: h === "diamond" ? 1 : 0 };
    default:
      return { arrow: "none", fill: 0 };
  }
}

function fontStyle(text: SceneElement | undefined) {
  if (!text) return {};
  return {
    fontSize: Math.round(num(text.fontSize, 20)),
    fontColor: hexColor(text.strokeColor),
    fontFamily: num(text.fontFamily, 5) === 8 ? "Courier New" : num(text.fontFamily, 5) === 5 ? "Comic Sans MS" : "Helvetica",
    align: str(text.textAlign) ?? "center",
    verticalAlign: str(text.verticalAlign) === "top" ? "top" : str(text.verticalAlign) === "bottom" ? "bottom" : "middle",
  };
}

export interface DrawioResult {
  xml: string;
  counts: Record<string, number>;
  skipped: string[];
}

export function sceneToDrawio(scene: Scene, title: string, files: Map<string, BoardFile>): DrawioResult {
  const cells: string[] = [];
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const cellId = (id: string) => `monet-${id}`;
  const frames = new Map(scene.frames().map((f) => [f.id, f]));

  const parentOf = (el: SceneElement): { parent: string; dx: number; dy: number } => {
    const fid = str(el.frameId);
    const f = fid ? frames.get(fid) : undefined;
    if (!f) return { parent: "1", dx: 0, dy: 0 };
    const fb = boxOf(f);
    return { parent: cellId(f.id), dx: fb.x, dy: fb.y };
  };

  const vertex = (el: SceneElement, value: string, st: string) => {
    const b = boxOf(el);
    const p = parentOf(el);
    const geo = `<mxGeometry x="${Math.round(b.x - p.dx)}" y="${Math.round(b.y - p.dy)}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" as="geometry"/>`;
    const link = str(el.link);
    if (link) {
      cells.push(
        `<UserObject label="${xmlAttr(value)}" link="${xmlAttr(link)}" id="${cellId(el.id)}"><mxCell style="${xmlAttr(st)}" vertex="1" parent="${p.parent}">${geo}</mxCell></UserObject>`,
      );
    } else {
      cells.push(`<mxCell id="${cellId(el.id)}" value="${xmlAttr(value)}" style="${xmlAttr(st)}" vertex="1" parent="${p.parent}">${geo}</mxCell>`);
    }
  };

  const rotation = (el: SceneElement) => {
    const deg = Math.round((num(el.angle) * 180) / Math.PI);
    return deg ? deg : null;
  };

  // Frames first so children can reference them as parents.
  const ordered = [...scene.frames(), ...scene.items().filter((e) => scene.kindOf(e) !== "frame")];
  for (const el of ordered) {
    const kind = scene.kindOf(el);
    const label = scene.boundText.get(el.id);
    const fill = isTransparent(el.backgroundColor) ? "none" : hexColor(el.backgroundColor, "#ffffff");
    const common = {
      whiteSpace: "wrap",
      html: 1,
      fillColor: fill,
      strokeColor: hexColor(el.strokeColor),
      strokeWidth: num(el.strokeWidth, 1),
      opacity: num(el.opacity, 100) < 100 ? num(el.opacity, 100) : null,
      rotation: rotation(el),
      ...strokeDash(el),
    };
    switch (kind) {
      case "frame":
        vertex(
          el,
          htmlLabel(frameName(el)),
          style({
            rounded: 0,
            whiteSpace: "wrap",
            html: 1,
            container: 1,
            collapsible: 0,
            recursiveResize: 0,
            verticalAlign: "top",
            align: "left",
            spacingLeft: 8,
            spacingTop: 4,
            fontStyle: 1,
            fillColor: "none",
            strokeColor: "#adb5bd",
          }),
        );
        bump("sections");
        break;
      case "sticky":
        vertex(el, htmlLabel(label ? textOf(label) : ""), style({ ...common, rounded: 0, shadow: 1, strokeColor: "none", ...fontStyle(label) }));
        bump("stickies");
        break;
      case "rectangle":
        vertex(el, htmlLabel(label ? textOf(label) : ""), style({ ...common, rounded: el.roundness ? 1 : 0, ...fontStyle(label) }));
        bump("shapes");
        break;
      case "ellipse":
        vertex(el, htmlLabel(label ? textOf(label) : ""), style({ ...common, ...fontStyle(label) }, "ellipse;"));
        bump("shapes");
        break;
      case "diamond":
        vertex(el, htmlLabel(label ? textOf(label) : ""), style({ ...common, ...fontStyle(label) }, "rhombus;"));
        bump("shapes");
        break;
      case "text":
        vertex(
          el,
          htmlLabel(textOf(el)),
          style(
            { html: 1, whiteSpace: "wrap", fillColor: "none", strokeColor: "none", rotation: rotation(el), ...fontStyle(el), verticalAlign: "top" },
            "text;",
          ),
        );
        bump("text");
        break;
      case "image": {
        const file = files.get(str(el.fileId) ?? "");
        const decoded = file ? decodeDataUrl(file.dataURL) : null;
        if (!decoded) {
          skipped.push("image (file missing)");
          break;
        }
        // draw.io stores inline images as data:<mime>,<base64> (no ";base64" because ";" separates styles).
        vertex(
          el,
          "",
          style({ shape: "image", imageAspect: 0, aspect: "fixed", image: `data:${decoded.mimeType},${decoded.base64}`, rotation: rotation(el) }, ""),
        );
        bump("images");
        break;
      }
      case "embed": {
        const url = str(el.link) ?? "";
        vertex({ ...el, link: null }, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`, style({ ...common, rounded: 1, fillColor: "#f8f9fa" }));
        bump("links");
        break;
      }
      case "arrow":
      case "line":
      case "freedraw": {
        const pts = kind === "freedraw" ? simplify(absPoints(el), 4, 300) : absPoints(el);
        const src = kind === "arrow" ? bindingId(el.startBinding) : null;
        const dst = kind === "arrow" ? bindingId(el.endBinding) : null;
        const srcOk = src && scene.byId.has(src) && !scene.isBoundLabel(scene.byId.get(src)!);
        const dstOk = dst && scene.byId.has(dst) && !scene.isBoundLabel(scene.byId.get(dst)!);
        const start = arrowHead(kind === "arrow" ? el.startArrowhead : null);
        const end = arrowHead(kind === "arrow" ? el.endArrowhead : null);
        const st = style({
          html: 1,
          rounded: 0,
          curved: kind === "freedraw" || (kind === "arrow" && !!el.roundness && !el.elbowed) ? 1 : null,
          edgeStyle: el.elbowed ? "orthogonalEdgeStyle" : null,
          endArrow: end.arrow,
          endFill: end.fill,
          startArrow: start.arrow,
          startFill: start.fill,
          strokeColor: hexColor(el.strokeColor),
          strokeWidth: num(el.strokeWidth, kind === "freedraw" ? 2 : 1),
          ...strokeDash(el),
        });
        const mid = pts
          .slice(1, -1)
          .map(([x, y]) => `<mxPoint x="${Math.round(x)}" y="${Math.round(y)}"/>`)
          .join("");
        const first = pts[0]!;
        const last = pts[pts.length - 1]!;
        const geo =
          `<mxGeometry relative="1" as="geometry">` +
          `<mxPoint x="${Math.round(first[0])}" y="${Math.round(first[1])}" as="sourcePoint"/>` +
          `<mxPoint x="${Math.round(last[0])}" y="${Math.round(last[1])}" as="targetPoint"/>` +
          (mid ? `<Array as="points">${mid}</Array>` : "") +
          `</mxGeometry>`;
        const value = label ? htmlLabel(textOf(label)) : "";
        cells.push(
          `<mxCell id="${cellId(el.id)}" value="${xmlAttr(value)}" style="${xmlAttr(st)}" edge="1" parent="1"${srcOk ? ` source="${cellId(src!)}"` : ""}${dstOk ? ` target="${cellId(dst!)}"` : ""}>${geo}</mxCell>`,
        );
        bump(kind === "arrow" ? "arrows" : kind === "line" ? "lines" : "drawings");
        break;
      }
      default:
        skipped.push(String(el.type));
    }
  }

  const name = xmlAttr(title || "Board");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="Monet Blackboard" type="device" version="24.0.0">` +
    `<diagram id="monet-blackboard" name="${name}">` +
    `<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="1100" pageHeight="850" math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
    cells.join("") +
    `</root></mxGraphModel></diagram></mxfile>\n`;
  return { xml, counts, skipped };
}
