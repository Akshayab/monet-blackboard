// File helpers for things dropped or pasted on the canvas: classify, read, and downscale images.

export type DroppedKind = 'image' | 'csv' | 'pdf' | 'text' | 'video' | 'spreadsheet' | 'other';

/** Raster images we re-encode ourselves when they're too big for Excalidraw's own pipeline. */
const DOWNSCALABLE = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/avif']);
const IMAGE_TYPES = new Set([...DOWNSCALABLE, 'image/gif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);
const TEXT_EXT = /\.(txt|md|markdown|json|log|rtf|html?|xml|ya?ml)$/i;

/** Above this size, images are downscaled before insertion (Excalidraw rejects files over 4 MB). */
export const LARGE_IMAGE_BYTES = 2 * 1024 * 1024;
/** Largest PDF the AI request accepts (the data URL is capped at 12M characters). */
export const MAX_PDF_BYTES = 8 * 1024 * 1024;
/** Text attachments are capped at 400k characters by the AI request. */
export const MAX_TEXT_CHARS = 400_000;

export function classifyFile(file: File): DroppedKind {
  const type = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  if (IMAGE_TYPES.has(type) || /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/.test(name)) return 'image';
  if (type === 'text/csv' || type === 'application/csv' || type === 'text/tab-separated-values' || /\.(csv|tsv)$/.test(name)) {
    return 'csv';
  }
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/.test(name)) return 'video';
  if (/\.(xlsx|xls|numbers|ods)$/.test(name) || type.includes('spreadsheetml') || type === 'application/vnd.ms-excel') {
    return 'spreadsheet';
  }
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXT.test(name)) return 'text';
  return 'other';
}

/** Image files Excalidraw can't handle on its own because they're too big. */
export function needsDownscale(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  return DOWNSCALABLE.has(type) && file.size > LARGE_IMAGE_BYTES;
}

export function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

export async function readText(file: File): Promise<{ text: string; truncated: boolean }> {
  const text = await file.text();
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

/** Mime type to send for a text-like attachment (browsers often leave CSV types empty). */
export function textMimeType(file: File, kind: DroppedKind): string {
  if (file.type) return file.type;
  if (kind === 'csv') return file.name.toLowerCase().endsWith('.tsv') ? 'text/tab-separated-values' : 'text/csv';
  if (file.name.toLowerCase().endsWith('.json')) return 'application/json';
  if (/\.(md|markdown)$/i.test(file.name)) return 'text/markdown';
  return 'text/plain';
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export interface PreparedImage {
  dataURL: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Downscales a large image so it fits within `maxDim` pixels and stays under `maxBytes`. Prefers WebP
 * (keeps transparency); falls back to JPEG on a white background where WebP encoding isn't available.
 */
export async function downscaleImage(file: File, maxDim = 1600, maxBytes = 3 * 1024 * 1024): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    let dim = maxDim;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, dim / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not process the image.');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.86, 0.75, 0.62]) {
        let blob = await canvasToBlob(canvas, 'image/webp', quality);
        if (!blob || blob.type !== 'image/webp') {
          // No WebP encoder (older Safari): flatten onto white and use JPEG.
          const flat = document.createElement('canvas');
          flat.width = width;
          flat.height = height;
          const fctx = flat.getContext('2d')!;
          fctx.fillStyle = '#ffffff';
          fctx.fillRect(0, 0, width, height);
          fctx.drawImage(canvas, 0, 0);
          blob = await canvasToBlob(flat, 'image/jpeg', quality);
        }
        if (blob && blob.size <= maxBytes) {
          return { dataURL: await readAsDataURL(blob), mimeType: blob.type, width, height };
        }
      }
      dim = Math.round(dim * 0.7);
    }
    throw new Error('This image is too large to add, even after shrinking it.');
  } finally {
    bitmap.close();
  }
}

/** SHA-1 of the data URL, the same kind of content id Excalidraw uses for files. */
export async function fileIdFor(dataURL: string): Promise<string> {
  const bytes = new TextEncoder().encode(dataURL);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
