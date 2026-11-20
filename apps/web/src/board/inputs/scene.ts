// Scene helpers shared by the canvas inputs: coordinate conversion and inserting new elements so they
// sync to collaborators (the collab hook sends any element whose version it hasn't seen).
import { CaptureUpdateAction, getCommonBounds, restoreElements, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { assignIndices, maxIndex, type SceneElement } from '@monet/board-protocol';
import { toDisplay } from '@/lib/theme';

/** Visible part of the canvas, in scene coordinates. */
export function visibleSceneRect(app: AppState) {
  const zoom = app.zoom.value;
  return { x: -app.scrollX, y: -app.scrollY, width: app.width / zoom, height: app.height / zoom };
}

export function viewportCenter(app: AppState) {
  const r = visibleSceneRect(app);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function clientToScene(clientX: number, clientY: number, app: AppState) {
  const { x, y } = viewportCoordsToSceneCoords({ clientX, clientY }, app);
  return { x, y };
}

/** Client (window) coordinates of a scene point, for position: fixed overlays. */
export function sceneToClient(x: number, y: number, app: AppState) {
  const zoom = app.zoom.value;
  return { x: (x + app.scrollX) * zoom + app.offsetLeft, y: (y + app.scrollY) * zoom + app.offsetTop };
}

/**
 * Top-left position for a w×h box near `center` that doesn't overlap existing elements, searching outward
 * in rings but staying inside the visible area. Falls back to centering on `center`.
 */
export function findFreeSpot(api: ExcalidrawImperativeAPI, center: { x: number; y: number }, w: number, h: number) {
  const vis = visibleSceneRect(api.getAppState());
  const margin = 24;
  const boxes = api
    .getSceneElements()
    .filter((e) => !(e.type === 'text' && 'containerId' in e && e.containerId))
    .map((e) => {
      const [x1, y1, x2, y2] = getCommonBounds([e]);
      return { x1, y1, x2, y2 };
    });
  const free = (x: number, y: number) => !boxes.some((b) => x < b.x2 + margin && x + w > b.x1 - margin && y < b.y2 + margin && y + h > b.y1 - margin);
  const inView = (x: number, y: number) => x >= vis.x && y >= vis.y && x + w <= vis.x + vis.width && y + h <= vis.y + vis.height;
  const start = { x: center.x - w / 2, y: center.y - h / 2 };
  if (free(start.x, start.y)) return { ...start, inView: true };
  const stepX = Math.max(80, w / 2);
  const stepY = Math.max(60, h / 2);
  // First look inside the visible area, then anywhere nearby (the caller scrolls to it).
  for (const requireView of [true, false]) {
    for (let ring = 1; ring <= (requireView ? 8 : 16); ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (const [dx, dy] of [
          [i, ring],
          [ring, i],
          [i, -ring],
          [-ring, i],
        ] as const) {
          const x = start.x + dx * stepX;
          const y = start.y + dy * stepY;
          if ((!requireView || inView(x, y)) && free(x, y)) return { x, y, inView: inView(x, y) };
        }
      }
    }
  }
  return { ...start, inView: true };
}

/** Text that should stay centered on (or right-aligned to) an x position once its real width is known. */
export type TextAnchors = Map<string, { x: number; align: 'center' | 'right' }>;

/**
 * Adds new elements to the scene as one undoable step and (optionally) selects them. Element JSON comes
 * from the board-protocol factories; restoreElements fills in exact text sizes and repairs bindings.
 */
export function insertElements(
  api: ExcalidrawImperativeAPI,
  elements: SceneElement[],
  opts: { select?: boolean; groupId?: string; anchors?: TextAnchors; scrollIntoView?: boolean; restore?: boolean } = {},
) {
  const existing = api.getSceneElementsIncludingDeleted();
  // Factories build elements in the stored (dark) palette; show them in this client's theme.
  elements = toDisplay(elements);
  assignIndices(elements, maxIndex(existing as unknown as SceneElement[]));
  // restore: false keeps factory JSON as is (restoreElements deletes text elements whose text is empty,
  // e.g. a new sticky's blank label that is about to be typed into).
  const base =
    opts.restore === false
      ? elements
      : (restoreElements(elements as never, null, { refreshDimensions: true, repairBindings: true }) as unknown as SceneElement[]);
  const restored = base.map((el) => {
    const anchor = opts.anchors?.get(el.id);
    if (!anchor || el.type !== 'text') return el;
    const width = el.width as number;
    return { ...el, x: anchor.align === 'center' ? anchor.x - width / 2 : anchor.x - width };
  });
  const selected = opts.select ? Object.fromEntries(restored.filter((e) => e.type !== 'text' || !e.containerId).map((e) => [e.id, true as const])) : null;
  api.updateScene({
    elements: [...existing, ...(restored as never[])],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    ...(selected
      ? {
          appState: {
            selectedElementIds: selected,
            selectedGroupIds: opts.groupId ? { [opts.groupId]: true } : {},
          } as never,
        }
      : {}),
  });
  if (opts.scrollIntoView) {
    const ids = new Set(restored.map((e) => e.id));
    api.scrollToContent(
      api.getSceneElements().filter((e) => ids.has(e.id)),
      { animate: true },
    );
  }
  return restored;
}
