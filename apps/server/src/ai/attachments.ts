// Converts uploaded attachments and the region snapshot into model content blocks.
import type { AiContentBlockParam, AiTextBlockParam } from "./types";

export interface Attachment {
  name: string;
  mimeType: string;
  text?: string;
  dataURL?: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_TEXT_CHARS = 120_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;

function parseDataURL(url: string): { mime: string; data: string; base64: boolean } | null {
  const m = url.match(/^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s);
  if (!m) return null;
  const params = m[2] ?? "";
  return { mime: (m[1] || "application/octet-stream").toLowerCase(), data: m[3] ?? "", base64: /;base64/i.test(params) };
}

function truncate(text: string) {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…(truncated, ${text.length - MAX_TEXT_CHARS} more characters)` : text;
}

function textBlock(text: string): AiTextBlockParam {
  return { type: "text", text };
}

/** Builds content blocks for attachments. Returns the blocks plus notes about anything that was skipped. */
export function attachmentBlocks(attachments: Attachment[] = [], snapshot?: string): { blocks: AiContentBlockParam[]; skipped: string[] } {
  const blocks: AiContentBlockParam[] = [];
  const skipped: string[] = [];
  for (const a of attachments.slice(0, 10)) {
    const name = a.name || "attachment";
    if (a.text && a.text.trim()) {
      blocks.push(textBlock(`Attached file "${name}" (${a.mimeType || "text"}):\n${truncate(a.text)}`));
      continue;
    }
    const parsed = a.dataURL ? parseDataURL(a.dataURL) : null;
    if (!parsed) {
      skipped.push(name);
      continue;
    }
    const mime = IMAGE_TYPES.has(a.mimeType) ? a.mimeType : parsed.mime;
    const base64 = parsed.base64 ? parsed.data : Buffer.from(decodeURIComponent(parsed.data), "utf8").toString("base64");
    const bytes = Math.floor((base64.length * 3) / 4);
    if (IMAGE_TYPES.has(mime)) {
      if (bytes > MAX_IMAGE_BYTES) {
        skipped.push(`${name} (image larger than 5 MB)`);
        continue;
      }
      blocks.push(textBlock(`Attached image "${name}":`));
      blocks.push({ type: "image", source: { type: "base64", media_type: mime as "image/png", data: base64 } });
    } else if (mime === "application/pdf") {
      if (bytes > MAX_PDF_BYTES) {
        skipped.push(`${name} (PDF too large)`);
        continue;
      }
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 }, title: name.slice(0, 200) });
    } else if (mime.startsWith("text/") || /json|csv|xml|markdown|yaml/.test(mime)) {
      const text = parsed.base64 ? Buffer.from(parsed.data, "base64").toString("utf8") : decodeURIComponent(parsed.data);
      blocks.push(textBlock(`Attached file "${name}" (${mime}):\n${truncate(text)}`));
    } else {
      skipped.push(`${name} (unsupported type ${mime})`);
    }
  }
  if (snapshot) {
    const parsed = parseDataURL(snapshot);
    if (parsed && parsed.base64 && IMAGE_TYPES.has(parsed.mime) && (parsed.data.length * 3) / 4 <= MAX_IMAGE_BYTES) {
      blocks.push(textBlock("Snapshot of the selected area of the board (it may contain a hand-drawn sketch to interpret):"));
      blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mime as "image/png", data: parsed.data } });
    } else skipped.push("board snapshot");
  }
  return { blocks, skipped };
}
