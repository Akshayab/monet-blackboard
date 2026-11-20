// A small SVG preview of a set of elements, used as the library thumbnail for boards created from a
// template (before anyone opens them; the board page replaces it with a real export later).
import { boundsOf, type SceneElement } from "@monet/board-protocol";

const W = 480;
const H = 360;
const PAD = 16;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fill(el: SceneElement): string {
  const bg = el.backgroundColor as string | undefined;
  return bg && bg !== "transparent" ? bg : "none";
}

export function renderThumbnailSvg(elements: SceneElement[]): string {
  const live = elements.filter((e) => !e.isDeleted);
  const b = boundsOf(live);
  const scale = Math.min((W - PAD * 2) / (b.width || 1), (H - PAD * 2) / (b.height || 1), 1);
  const ox = (W - b.width * scale) / 2 - b.minX * scale;
  const oy = (H - b.height * scale) / 2 - b.minY * scale;
  const tx = (v: number) => (v * scale + ox).toFixed(1);
  const ty = (v: number) => (v * scale + oy).toFixed(1);
  const sw = (el: SceneElement) => Math.max(0.6, ((el.strokeWidth as number) || 1) * scale).toFixed(2);
  const parts: string[] = [];
  for (const el of live) {
    const x = el.x as number;
    const y = el.y as number;
    const w = (el.width as number) || 0;
    const h = (el.height as number) || 0;
    const stroke = (el.strokeColor as string) || "#1e1e1e";
    switch (el.type) {
      case "frame":
        parts.push(
          `<rect x="${tx(x)}" y="${ty(y)}" width="${(w * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" rx="${(8 * scale).toFixed(1)}" fill="#1f1f1f" stroke="#333333" stroke-width="${Math.max(0.6, scale).toFixed(2)}"/>`,
        );
        break;
      case "rectangle":
        parts.push(
          `<rect x="${tx(x)}" y="${ty(y)}" width="${(w * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" rx="${el.roundness ? (Math.min(w, h) * 0.12 * scale).toFixed(1) : 0}" fill="${fill(el)}" stroke="${stroke}" stroke-width="${sw(el)}"/>`,
        );
        break;
      case "ellipse":
        parts.push(
          `<ellipse cx="${tx(x + w / 2)}" cy="${ty(y + h / 2)}" rx="${((w / 2) * scale).toFixed(1)}" ry="${((h / 2) * scale).toFixed(1)}" fill="${fill(el)}" stroke="${stroke}" stroke-width="${sw(el)}"/>`,
        );
        break;
      case "diamond":
        parts.push(
          `<polygon points="${tx(x + w / 2)},${ty(y)} ${tx(x + w)},${ty(y + h / 2)} ${tx(x + w / 2)},${ty(y + h)} ${tx(x)},${ty(y + h / 2)}" fill="${fill(el)}" stroke="${stroke}" stroke-width="${sw(el)}"/>`,
        );
        break;
      case "line":
      case "arrow": {
        const pts = (el.points as [number, number][]) ?? [];
        if (pts.length < 2) break;
        const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${tx(x + px)} ${ty(y + py)}`).join(" ");
        const dash = el.strokeStyle === "dashed" ? ` stroke-dasharray="${(8 * scale).toFixed(1)} ${(6 * scale).toFixed(1)}"` : "";
        parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw(el)}"${dash}/>`);
        break;
      }
      case "text": {
        const fontSize = ((el.fontSize as number) || 20) * scale;
        if (fontSize < 3) break;
        const lines = String(el.text ?? "").split("\n");
        const anchor = el.textAlign === "center" ? "middle" : el.textAlign === "right" ? "end" : "start";
        const ax = el.textAlign === "center" ? x + w / 2 : el.textAlign === "right" ? x + w : x;
        lines.forEach((line, i) => {
          parts.push(
            `<text x="${tx(ax)}" y="${ty(y + (i + 0.85) * ((el.fontSize as number) || 20) * 1.25)}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize.toFixed(1)}" fill="${stroke}" text-anchor="${anchor}">${esc(line)}</text>`,
          );
        });
        break;
      }
      default:
        break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#171717"/>${parts.join("")}</svg>`;
}

export function thumbnailDataUrl(elements: SceneElement[]): string {
  return `data:image/svg+xml;base64,${Buffer.from(renderThumbnailSvg(elements)).toString("base64")}`;
}
