// Reads files the user attaches to an AI request. CSV/TXT/MD/JSON are sent as text; PDFs and images as
// data URLs (large images are downscaled first so they stay within model limits).
import Papa from 'papaparse';

export interface AiAttachment {
  name: string;
  mimeType: string;
  text?: string;
  dataURL?: string;
}

export interface PendingAttachment extends AiAttachment {
  id: string;
  kind: 'csv' | 'text' | 'pdf' | 'image';
  /** Short description shown on the chip, e.g. "120 rows × 5 columns". */
  summary: string;
  /** First rows of a CSV, for the preview. */
  previewRows?: string[][];
  /** Approximate payload size in characters. */
  size: number;
}

export const ATTACH_ACCEPT =
  '.csv,.tsv,.txt,.md,.markdown,.json,.pdf,.png,.jpg,.jpeg,.gif,.webp,text/csv,text/plain,text/markdown,application/pdf,image/png,image/jpeg,image/gif,image/webp';
export const MAX_ATTACHMENTS = 10;
/** Server accepts up to 400k characters of text per attachment. */
const MAX_TEXT_CHARS = 390_000;
/** Server accepts data URLs up to 12M characters; base64 adds a third. */
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
/** Keep the whole request under the API body limit (16 MB). */
export const MAX_TOTAL_CHARS = 14_000_000;
const MAX_IMAGE_SIDE = 1568;

export class AttachmentError extends Error {}

function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function kindOf(file: File): PendingAttachment['kind'] | null {
  const ext = extOf(file.name);
  const type = file.type.toLowerCase();
  if (ext === 'csv' || ext === 'tsv' || type === 'text/csv' || type === 'text/tab-separated-values') return 'csv';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) || /^image\/(png|jpeg|gif|webp)$/.test(type)) return 'image';
  if (['txt', 'md', 'markdown', 'json'].includes(ext) || type.startsWith('text/') || type === 'application/json') return 'text';
  return null;
}

function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function downscaleImage(file: File): Promise<{ dataURL: string; mimeType: string; width: number; height: number }> {
  const original = await readAsDataURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new AttachmentError(`Couldn't read the image ${file.name}.`));
    el.src = original;
  });
  const { naturalWidth: w, naturalHeight: h } = img;
  const tooBig = Math.max(w, h) > MAX_IMAGE_SIDE || file.size > 3.5 * 1024 * 1024;
  // GIFs may be animated; keep them as-is when they're small enough.
  if (!tooBig) return { dataURL: original, mimeType: file.type || 'image/png', width: w, height: h };
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataURL: original, mimeType: file.type, width: w, height: h };
  const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  if (mimeType === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.drawImage(img, 0, 0, cw, ch);
  return { dataURL: canvas.toDataURL(mimeType, 0.85), mimeType, width: cw, height: ch };
}

let seq = 0;

export async function readAttachment(file: File): Promise<PendingAttachment> {
  const kind = kindOf(file);
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  if (!kind) throw new AttachmentError(`${file.name}: only CSV, TXT, Markdown, PDF, and image files can be attached.`);

  if (kind === 'csv' || kind === 'text') {
    let text = await file.text();
    let truncated = false;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    if (kind === 'csv') {
      const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
      const rows = parsed.data.filter((r) => Array.isArray(r));
      const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
      const dataRows = Math.max(0, rows.length - 1);
      return {
        id,
        kind,
        name: file.name,
        mimeType: file.type || 'text/csv',
        text,
        summary: `${dataRows.toLocaleString()} row${dataRows === 1 ? '' : 's'} × ${cols} column${cols === 1 ? '' : 's'}${truncated ? ' (trimmed)' : ''}`,
        previewRows: rows.slice(0, 4).map((r) => r.slice(0, 6).map((c) => String(c ?? '').slice(0, 24))),
        size: text.length,
      };
    }
    const lines = text.split('\n').length;
    return {
      id,
      kind,
      name: file.name,
      mimeType: file.type || (extOf(file.name) === 'md' ? 'text/markdown' : 'text/plain'),
      text,
      summary: `${lines.toLocaleString()} line${lines === 1 ? '' : 's'}${truncated ? ' (trimmed)' : ''}`,
      size: text.length,
    };
  }

  if (kind === 'pdf') {
    if (file.size > MAX_BINARY_BYTES)
      throw new AttachmentError(`${file.name} is ${formatBytes(file.size)}. PDFs can be up to ${formatBytes(MAX_BINARY_BYTES)}.`);
    const dataURL = await readAsDataURL(file);
    return { id, kind, name: file.name, mimeType: 'application/pdf', dataURL, summary: `PDF · ${formatBytes(file.size)}`, size: dataURL.length };
  }

  // image
  if (file.size > 25 * 1024 * 1024) throw new AttachmentError(`${file.name} is too large (${formatBytes(file.size)}).`);
  const img = await downscaleImage(file);
  if (img.dataURL.length > MAX_BINARY_BYTES * 1.4) throw new AttachmentError(`${file.name} is too large to send.`);
  return { id, kind, name: file.name, mimeType: img.mimeType, dataURL: img.dataURL, summary: `Image · ${img.width}×${img.height}`, size: img.dataURL.length };
}

export function toRequestAttachment(a: PendingAttachment): AiAttachment {
  return { name: a.name, mimeType: a.mimeType, ...(a.text !== undefined ? { text: a.text } : {}), ...(a.dataURL ? { dataURL: a.dataURL } : {}) };
}
