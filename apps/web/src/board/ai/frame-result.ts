// After your own AI request finishes, bring what it made or changed into view when part of it is off-screen or
// hidden under the prompt bar (where the reply preview also appears). The view stays put when everything is
// already visible, when you moved the view yourself during the run, or for runs other people started.
import { useEffect, useRef } from 'react';
import { CaptureUpdateAction, getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BoardContext } from '../slots';
import { aiUi } from './store';

/** Room kept above the prompt bar for the reply preview. */
const REPLY_SPACE = 124;
/** Don't zoom out further than this to fit a big result; show its top-left part instead. */
const MIN_ZOOM = { desktop: 0.25, phone: 0.12 };

interface Track {
  runId: string;
  before: Map<string, number>;
  changed: Set<string>;
  view: { scrollX: number; scrollY: number; zoom: number };
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function viewOf(api: ExcalidrawImperativeAPI) {
  const s = api.getAppState();
  return { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
}

/** Canvas margins covered by the floating board UI (zoom pill, side buttons, prompt bar and tool pill). */
export function coveredInsets(api: ExcalidrawImperativeAPI, replySpace: boolean): Insets {
  const s = api.getAppState();
  const phone = window.innerWidth < 768;
  const top0 = s.offsetTop;
  const bottom0 = s.offsetTop + s.height;
  const rectOf = (sel: string) => {
    const n = document.querySelector<HTMLElement>(sel);
    return n && n.offsetParent ? n.getBoundingClientRect() : null;
  };
  const zoom = rectOf('[data-testid="zoom-pill"]');
  // Only bars that sit over the canvas count (with the chat open, the prompt bar lives in the side panel).
  const floating = ['[data-testid="ai-prompt-bar"]', '[data-testid="tool-pill"]']
    .map(rectOf)
    .filter((r): r is DOMRect => !!r && r.height > 0 && r.left < s.offsetLeft + s.width && r.right > s.offsetLeft);
  const barTop = floating.length ? Math.min(...floating.map((r) => r.top)) : bottom0;
  const insets = {
    top: Math.max(16, (zoom ? zoom.bottom - top0 : 0) + 12),
    right: phone ? 56 : 72,
    bottom: Math.max(16, bottom0 - barTop + 12 + (replySpace ? REPLY_SPACE : 0)),
    left: phone ? 12 : 24,
  };
  // Keep a usable area on very short screens.
  const spare = s.height - insets.top - insets.bottom;
  if (spare < 160) insets.bottom = Math.max(16, insets.bottom - (160 - spare));
  return insets;
}

/** Scrolls (and if needed zooms out) so `elements` sit inside the uncovered part of the canvas. Returns whether it moved. */
export function frameElements(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[], insets: Insets): boolean {
  if (!elements.length) return false;
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return false;
  const s = api.getAppState();
  const z = s.zoom.value;
  const safeW = s.width - insets.left - insets.right;
  const safeH = s.height - insets.top - insets.bottom;
  if (safeW < 40 || safeH < 40) return false;
  const x1 = (minX + s.scrollX) * z;
  const y1 = (minY + s.scrollY) * z;
  const x2 = (maxX + s.scrollX) * z;
  const y2 = (maxY + s.scrollY) * z;
  if (x1 >= insets.left - 2 && y1 >= insets.top - 2 && x2 <= s.width - insets.right + 2 && y2 <= s.height - insets.bottom + 2) return false;

  const pad = 16;
  const bw = maxX - minX;
  const bh = maxY - minY;
  const fit = Math.min((safeW - pad * 2) / Math.max(1, bw), (safeH - pad * 2) / Math.max(1, bh));
  const floor = Math.min(window.innerWidth < 768 ? MIN_ZOOM.phone : MIN_ZOOM.desktop, z);
  // Never zoom in past the current zoom; zoom out only as far as needed (and not below the floor).
  const zoom = Math.floor(Math.min(z, Math.max(fit, floor)) * 100) / 100;
  const sw = bw * zoom;
  const sh = bh * zoom;
  const left = sw <= safeW ? insets.left + (safeW - sw) / 2 : insets.left + pad;
  const top = sh <= safeH ? insets.top + (safeH - sh) / 2 : insets.top + pad;
  const to = { scrollX: left / zoom - minX, scrollY: top / zoom - minY, zoom };
  const from = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: z };
  const set = (v: typeof to) =>
    api.updateScene({ appState: { scrollX: v.scrollX, scrollY: v.scrollY, zoom: { value: v.zoom as never } }, captureUpdate: CaptureUpdateAction.NEVER });
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    set(to);
    return true;
  }
  const t0 = performance.now();
  const ms = 380;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - t, 3);
    // Interpolate the scene point at the canvas center so the motion doesn't swing sideways while zooming.
    const zc = from.zoom + (to.zoom - from.zoom) * e;
    const cxFrom = s.width / 2 / from.zoom - from.scrollX;
    const cyFrom = s.height / 2 / from.zoom - from.scrollY;
    const cxTo = s.width / 2 / to.zoom - to.scrollX;
    const cyTo = s.height / 2 / to.zoom - to.scrollY;
    const cx = cxFrom + (cxTo - cxFrom) * e;
    const cy = cyFrom + (cyTo - cyFrom) * e;
    set(t >= 1 ? to : { scrollX: s.width / 2 / zc - cx, scrollY: s.height / 2 / zc - cy, zoom: zc });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return true;
}

export function useFrameAiResult(ctx: BoardContext) {
  const api = ctx.excalidrawAPI;
  const run = ctx.collab.aiRun;
  const me = ctx.collab.me?.userId ?? ctx.user?.id ?? null;
  const track = useRef<Track | null>(null);

  // Collect what the AI changes during my run (elements whose version went up, or that are new).
  useEffect(
    () =>
      ctx.collab.onRemoteElements(({ elements, source }) => {
        const t = track.current;
        if (source !== 'ai' || !t) return;
        for (const el of elements) {
          const v = t.before.get(el.id);
          if (v === undefined || (typeof el.version === 'number' && el.version > v)) t.changed.add(el.id);
        }
      }),
    [ctx.collab],
  );

  useEffect(() => {
    if (!api || !run) return;
    const mine = !!me && run.userId === me;
    if ((run.status === 'thinking' || run.status === 'drawing') && mine) {
      if (track.current?.runId !== run.runId) {
        track.current = {
          runId: run.runId,
          before: new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e.version])),
          changed: new Set(),
          view: viewOf(api),
        };
      }
      return;
    }
    const t = track.current;
    if (!t || t.runId !== run.runId) return;
    track.current = null;
    if (run.status !== 'done' || !t.changed.size) return;
    const timer = setTimeout(() => {
      const now = viewOf(api);
      // You moved the view while it worked: leave it where you put it.
      if (Math.abs(now.scrollX - t.view.scrollX) > 2 || Math.abs(now.scrollY - t.view.scrollY) > 2 || Math.abs(now.zoom - t.view.zoom) > 0.001) return;
      const s = api.getAppState();
      if (s.newElement || s.multiElement || s.resizingElement || s.editingTextElement || s.selectedElementsAreBeingDragged || s.selectionElement) return;
      const all = api.getSceneElements();
      const byId = new Map(all.map((e) => [e.id, e]));
      const ids = new Set<string>();
      for (const id of t.changed) {
        const el = byId.get(id);
        if (!el) continue;
        ids.add(el.type === 'text' && el.containerId && byId.has(el.containerId) ? el.containerId : el.id);
      }
      const els = [...ids].map((id) => byId.get(id)!).filter(Boolean);
      frameElements(api, els, coveredInsets(api, !aiUi.get().chatOpen));
    }, 350);
    return () => clearTimeout(timer);
  }, [api, run, me]);
}
