// One shared AI session per open board. <AiController/> (mounted once, inside the canvas overlays) runs the
// board-AI hooks and publishes the result here; the prompt bar, chat panel, and overlays read it with
// useAiSession() wherever they are mounted.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AI_SEND_EVENT, type AiSendEventDetail } from './send-event';
import { getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { MutableRefObject } from 'react';
import type { BoardContext } from '../slots';
import { useBoardAi, usePendingPrompt, type AiStatus, type BoardAi } from './use-board-ai';
import { useLiveSession, type LiveSession } from './use-live-session';
import { useFrameAiResult } from './frame-result';

export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The area the AI is working on, for the rust "Pondering… / Working…" outline. */
export interface RunOverlay {
  phase: 'pondering' | 'working';
  /** Pill text: "Pondering…", "Listening…" (live mode), or "Working…". */
  label: string;
  region: SceneRect;
  /** Where the region came from: the server's region frame, the AI's elements (+ the selection), the selection, or the viewport center. */
  source: 'server' | 'elements' | 'selection' | 'viewport';
}

export interface AiSessionState {
  ai: BoardAi | null;
  live: LiveSession | null;
  run: RunOverlay | null;
}

const EMPTY: AiSessionState = { ai: null, live: null, run: null };
let session: AiSessionState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: AiSessionState) {
  session = next;
  listeners.forEach((l) => l());
}

export function useAiSession(): AiSessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => session,
    () => session,
  );
}

const PAD = 32;

function union(a: SceneRect, b: SceneRect): SceneRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function isActive(status: AiStatus) {
  return status.kind === 'sending' || status.kind === 'thinking' || status.kind === 'drawing';
}

/** Tracks the area the current run is drawing into. */
function useRunOverlay(ctx: BoardContext, status: AiStatus, lastFocusRef: MutableRefObject<{ ids: string[]; at: number } | null>): RunOverlay | null {
  const active = isActive(status);
  const run = ctx.collab.aiRun;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [fallback, setFallback] = useState<SceneRect | null>(null);
  const [fromElements, setFromElements] = useState<SceneRect | null>(null);
  const [fromSelection, setFromSelection] = useState<SceneRect | null>(null);
  const runKey = active ? (run && (run.status === 'thinking' || run.status === 'drawing') ? run.runId : 'pending') : null;

  // A new run (or the end of one) resets the tracked area. The fallback box sits in the middle of the view.
  useEffect(() => {
    setFromElements(null);
    if (!runKey) {
      setFallback(null);
      setFromSelection(null);
      return;
    }
    const api = ctx.excalidrawAPI;
    if (!api) return;
    // A request sent from this tab with a selection: start around the selection.
    const focus = lastFocusRef.current;
    if (focus && focus.ids.length && Date.now() - focus.at < 20_000) {
      const ids = new Set(focus.ids);
      const els = api.getSceneElements().filter((e) => ids.has(e.id));
      if (els.length) {
        const [minX, minY, maxX, maxY] = getCommonBounds(els);
        if ([minX, minY, maxX, maxY].every(Number.isFinite)) {
          setFromSelection((prev) =>
            prev && runKey !== 'pending' ? prev : { x: minX - PAD, y: minY - PAD, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 },
          );
        }
      }
    } else if (runKey === 'pending') setFromSelection(null);
    setFallback((prev) => {
      if (prev && runKey !== 'pending') return prev;
      const app = api.getAppState();
      const zoom = app.zoom.value || 1;
      const vw = app.width / zoom;
      const vh = app.height / zoom;
      const w = Math.min(vw * 0.42, 720 / zoom);
      const h = Math.min(vh * 0.36, 420 / zoom);
      return { x: -app.scrollX + vw / 2 - w / 2, y: -app.scrollY + vh / 2 - h / 2 - vh * 0.06, width: w, height: h };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  // Grow the area to cover what the AI adds or changes during the run.
  useEffect(
    () =>
      ctx.collab.onRemoteElements(({ elements, source }) => {
        if (source !== 'ai' || !activeRef.current) return;
        const live = elements.filter((e) => !e.isDeleted) as unknown as ExcalidrawElement[];
        if (!live.length) return;
        const [minX, minY, maxX, maxY] = getCommonBounds(live);
        if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;
        setFromElements((prev) => {
          const x1 = Math.min(prev ? prev.x + PAD : Infinity, minX) - PAD;
          const y1 = Math.min(prev ? prev.y + PAD : Infinity, minY) - PAD;
          const x2 = Math.max(prev ? prev.x + prev.width - PAD : -Infinity, maxX) + PAD;
          const y2 = Math.max(prev ? prev.y + prev.height - PAD : -Infinity, maxY) + PAD;
          return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        });
      }),
    [ctx.collab],
  );

  if (!active) return null;
  // "Working…" once the AI is drawing, the server says so between model turns, or its first elements arrived.
  const msg = status.kind === 'thinking' || status.kind === 'drawing' ? (status.message ?? '') : '';
  const phase: RunOverlay['phase'] = status.kind === 'drawing' || /^working/i.test(msg) || fromElements ? 'working' : 'pondering';
  const label = phase === 'working' ? 'Working…' : /^listening/i.test(msg) ? 'Listening…' : 'Pondering…';
  const server = run && run.runId === runKey && run.region && run.region.width > 0 && run.region.height > 0 ? run.region : null;
  if (server) return { phase, label, region: server, source: 'server' };
  if (fromElements) return { phase, label, region: fromSelection ? union(fromElements, fromSelection) : fromElements, source: 'elements' };
  if (fromSelection) return { phase, label, region: fromSelection, source: 'selection' };
  if (fallback) return { phase, label, region: fallback, source: 'viewport' };
  return null;
}

/** Runs the board AI for this board and publishes it. Mount exactly once per board page. */
export function AiController({ ctx }: { ctx: BoardContext }) {
  const ai = useBoardAi(ctx);
  const aiBusy = ai.status.kind !== 'idle';
  const live = useLiveSession({ sendChunk: (text) => ai.send({ prompt: text, mode: 'live' }), aiBusy });
  usePendingPrompt(ctx, ai.send);
  // Comments marked "Send to AI" arrive as a window event (see send-event.ts).
  const sendRef = useRef(ai.send);
  sendRef.current = ai.send;
  useEffect(() => {
    const onSend = (e: Event) => {
      const d = (e as CustomEvent<AiSendEventDetail>).detail;
      if (!d || d.boardId !== ctx.boardId || !ctx.canEdit) return;
      void sendRef.current({ prompt: d.prompt, focusElementIds: d.focusElementIds });
    };
    window.addEventListener(AI_SEND_EVENT, onSend);
    return () => window.removeEventListener(AI_SEND_EVENT, onSend);
  }, [ctx.boardId, ctx.canEdit]);
  const run = useRunOverlay(ctx, ai.status, ai.lastFocusRef);
  useFrameAiResult(ctx);

  useLayoutEffect(() => {
    publish({ ai, live, run });
  });
  useEffect(() => () => publish(EMPTY), []);
  return null;
}
