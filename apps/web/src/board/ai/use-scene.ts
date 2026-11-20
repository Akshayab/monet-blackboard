// Hooks that derive small pieces of state from the live Excalidraw scene (selection, viewport, AI
// suggestions). They subscribe through excalidrawAPI.onChange and recompute at most once per frame.
import { useEffect, useRef, useState } from 'react';
import { getCommonBounds } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export type SceneBounds = [minX: number, minY: number, maxX: number, maxY: number];

export function useSceneDerived<T>(
  api: ExcalidrawImperativeAPI | null,
  compute: (elements: readonly ExcalidrawElement[], appState: AppState) => T,
  equals: (a: T, b: T) => boolean,
  initial: T,
): T {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(initial);
  useEffect(() => {
    if (!api) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      const next = compute(api.getSceneElements(), api.getAppState());
      if (!equals(ref.current, next)) {
        ref.current = next;
        setValue(next);
      }
    };
    const unsubscribe = api.onChange(() => {
      if (!raf) raf = requestAnimationFrame(run);
    });
    run();
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [api, compute, equals]);
  return value;
}

export interface SelectionInfo {
  /** Ids the user selected, expanded with frame children and bound text so the AI sees the whole area. */
  focusIds: string[];
  /** How many items to show in the "Asking about N items" chip (bound text is not counted separately). */
  count: number;
  /** Selection bounds in scene coordinates. */
  bounds: SceneBounds | null;
  /** True while the user is dragging, resizing, drawing, or editing text. */
  busy: boolean;
}

const EMPTY_SELECTION: SelectionInfo = { focusIds: [], count: 0, bounds: null, busy: false };

export function computeSelection(elements: readonly ExcalidrawElement[], app: AppState): SelectionInfo {
  const selected = new Set(Object.keys(app.selectedElementIds).filter((id) => app.selectedElementIds[id]));
  if (!selected.size) return EMPTY_SELECTION;
  const live = elements.filter((e) => !e.isDeleted);
  const picked = live.filter((e) => selected.has(e.id));
  if (!picked.length) return EMPTY_SELECTION;
  const ids = new Set(picked.map((e) => e.id));
  // Frames (sections) bring their children along.
  const frames = new Set(picked.filter((e) => e.type === 'frame' || e.type === 'magicframe').map((e) => e.id));
  if (frames.size) for (const e of live) if (e.frameId && frames.has(e.frameId)) ids.add(e.id);
  // Containers bring their bound text.
  for (const e of live) {
    if (e.type === 'text' && (e as { containerId?: string | null }).containerId && ids.has((e as { containerId: string }).containerId)) ids.add(e.id);
  }
  const all = live.filter((e) => ids.has(e.id));
  const count = all.filter(
    (e) => !(e.type === 'text' && (e as { containerId?: string | null }).containerId && ids.has((e as { containerId: string }).containerId)),
  ).length;
  const [minX, minY, maxX, maxY] = getCommonBounds(picked);
  const a = app as AppState & Record<string, unknown>;
  const busy = Boolean(
    a.editingTextElement ||
    a.selectionElement ||
    a.newElement ||
    a.resizingElement ||
    a.multiElement ||
    a.selectedElementsAreBeingDragged ||
    a.isResizing ||
    a.isRotating,
  );
  return { focusIds: [...ids].sort(), count, bounds: [minX, minY, maxX, maxY], busy };
}

export function selectionEquals(a: SelectionInfo, b: SelectionInfo) {
  return (
    a.count === b.count &&
    a.busy === b.busy &&
    a.focusIds.join(',') === b.focusIds.join(',') &&
    (a.bounds?.map(Math.round).join(',') ?? '') === (b.bounds?.map(Math.round).join(',') ?? '')
  );
}

export function useSelection(api: ExcalidrawImperativeAPI | null): SelectionInfo {
  return useSceneDerived(api, computeSelection, selectionEquals, EMPTY_SELECTION);
}

/** The part of the board the user is looking at, in scene coordinates. */
export function sceneViewport(api: ExcalidrawImperativeAPI | null) {
  if (!api) return undefined;
  const app = api.getAppState();
  const zoom = app.zoom.value || 1;
  return {
    x: Math.round(-app.scrollX),
    y: Math.round(-app.scrollY),
    width: Math.round(app.width / zoom),
    height: Math.round(app.height / zoom),
  };
}

export interface ViewTransform {
  scrollX: number;
  scrollY: number;
  zoom: number;
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

const EMPTY_VIEW: ViewTransform = { scrollX: 0, scrollY: 0, zoom: 1, offsetLeft: 0, offsetTop: 0, width: 0, height: 0 };

function computeView(_e: readonly ExcalidrawElement[], app: AppState): ViewTransform {
  return {
    scrollX: app.scrollX,
    scrollY: app.scrollY,
    zoom: app.zoom.value,
    offsetLeft: app.offsetLeft,
    offsetTop: app.offsetTop,
    width: app.width,
    height: app.height,
  };
}

function viewEquals(a: ViewTransform, b: ViewTransform) {
  return (
    Math.abs(a.scrollX - b.scrollX) < 0.5 &&
    Math.abs(a.scrollY - b.scrollY) < 0.5 &&
    a.zoom === b.zoom &&
    a.offsetLeft === b.offsetLeft &&
    a.offsetTop === b.offsetTop &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** Scroll/zoom state for positioning floating UI over the canvas. */
export function useViewTransform(api: ExcalidrawImperativeAPI | null): ViewTransform {
  return useSceneDerived(api, computeView, viewEquals, EMPTY_VIEW);
}

/** Scene point -> browser viewport (client) coordinates. */
export function toClient(view: ViewTransform, sceneX: number, sceneY: number) {
  return {
    x: (sceneX + view.scrollX) * view.zoom + view.offsetLeft,
    y: (sceneY + view.scrollY) * view.zoom + view.offsetTop,
  };
}
