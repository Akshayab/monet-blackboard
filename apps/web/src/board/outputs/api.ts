// Client helpers for the outputs API (docs, decks, exports, Send to).
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { api, ApiError } from '@/lib/api';

export type DocKind = 'doc' | 'deck';
export type DocStatus = 'generating' | 'ready' | 'error';

export interface Slide {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface BoardDocument {
  id: string;
  boardId: string;
  kind: DocKind;
  title: string;
  status: DocStatus;
  error: string | null;
  preset: string | null;
  scope: 'board' | 'selection';
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  url: string;
  content?: { markdown?: string; slides?: Slide[] };
}

export interface OutputsConfig {
  ai: boolean;
  stub: boolean;
  paused: boolean;
  pauseCode: 'ai_disabled' | 'global_budget' | null;
  pauseMessage: string | null;
  usage: { requestsUsed: number; requestLimit: number; tokensUsed: number; tokenLimit: number; resetsAt: string | null };
  docPresets: { id: string; label: string }[];
  deckPresets: { id: string; label: string }[];
}

export type ExportFormat = 'drawio' | 'lucid' | 'excalidraw';

/** Appends the share-link token to an app or API path when the board was opened through a link. */
export function withLink(path: string, linkToken: string | null): string {
  if (!linkToken) return path;
  return `${path}${path.includes('?') ? '&' : '?'}link=${encodeURIComponent(linkToken)}`;
}

/** App path (respecting the Vite base) for a doc or deck viewer. */
export function appPath(path: string): string {
  return `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`;
}

export function downloadUrl(doc: Pick<BoardDocument, 'boardId' | 'id'>, format: string, linkToken: string | null) {
  return withLink(`/api/boards/${doc.boardId}/documents/${doc.id}/download?format=${format}`, linkToken);
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** POSTs to an export endpoint and saves the returned file. */
export async function downloadExport(boardId: string, format: ExportFormat, opts: { elementIds?: string[]; linkToken: string | null; background?: string }) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.linkToken) headers.set('x-board-link', opts.linkToken);
  const res = await fetch(`/api/boards/${boardId}/export/${format}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ elementIds: opts.elementIds, background: opts.background }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string }).error || `Export failed (${res.status})`);
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `board.${format}`;
  saveBlob(await res.blob(), filename);
  let counts: Record<string, number> | null = null;
  try {
    counts = JSON.parse(res.headers.get('x-export-counts') ?? 'null');
  } catch {
    counts = null;
  }
  return { filename, counts };
}

export function listDocuments(boardId: string, linkToken: string | null) {
  return api<{ documents: BoardDocument[] }>(`/boards/${boardId}/documents`, { linkToken });
}

export function getDocument(boardId: string, docId: string, linkToken: string | null) {
  return api<{ document: BoardDocument; board: { id: string; title: string; role: string } }>(`/boards/${boardId}/documents/${docId}`, { linkToken });
}

export function createDocument(
  boardId: string,
  body: { kind: DocKind; preset?: string; instructions?: string; elementIds?: string[] },
  linkToken: string | null,
) {
  return api<{ document: BoardDocument }>(`/boards/${boardId}/documents`, { method: 'POST', json: body, linkToken });
}

export function deleteDocument(boardId: string, docId: string, linkToken: string | null) {
  return api(`/boards/${boardId}/documents/${docId}`, { method: 'DELETE', linkToken });
}

export function getOutputsConfig() {
  return api<OutputsConfig>('/outputs/config');
}

/**
 * The selected elements, expanded the way the server does it: bound labels, containers of selected
 * labels, and everything inside selected frames.
 */
export function selectedElements(excalidrawAPI: ExcalidrawImperativeAPI | null): NonDeletedExcalidrawElement[] {
  if (!excalidrawAPI) return [];
  const all = excalidrawAPI.getSceneElements();
  const selected = excalidrawAPI.getAppState().selectedElementIds ?? {};
  const ids = new Set(Object.keys(selected).filter((k) => selected[k]));
  if (ids.size === 0) return [];
  for (const el of all) {
    if (!ids.has(el.id)) continue;
    if (el.type === 'text' && el.containerId) ids.add(el.containerId);
  }
  const frames = new Set(all.filter((e) => ids.has(e.id) && (e.type === 'frame' || e.type === 'magicframe')).map((e) => e.id));
  for (const el of all) {
    if (el.frameId && frames.has(el.frameId)) ids.add(el.id);
  }
  for (const el of all) {
    if (el.type === 'text' && el.containerId && ids.has(el.containerId)) ids.add(el.id);
  }
  return all.filter((e) => ids.has(e.id));
}

/** The AI is off for everyone: the kill switch (ai_disabled) or the global daily budget (global_budget). */
export function isAiPausedError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 503 && ['ai_disabled', 'global_budget'].includes(String(err.data.code ?? ''));
}

export function errorMessage(err: unknown, fallback = 'Something went wrong.') {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}
