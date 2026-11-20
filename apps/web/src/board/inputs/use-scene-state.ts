// Subscribes to the Excalidraw scene so overlays can follow scroll, zoom and selection. Updates at most
// once per animation frame, and only when something an overlay depends on changed.
import { useEffect, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

export interface SceneState {
  app: AppState;
  selected: ExcalidrawElement[];
  /** True while the user is drawing, dragging, resizing or typing (overlays should get out of the way). */
  busy: boolean;
}

export function useSceneState(api: ExcalidrawImperativeAPI | null): SceneState | null {
  const [state, setState] = useState<SceneState | null>(null);
  useEffect(() => {
    if (!api) return;
    let raf = 0;
    let lastKey = '';
    const update = () => {
      raf = 0;
      const app = api.getAppState();
      const ids = app.selectedElementIds;
      const selected = api.getSceneElements().filter((e) => ids[e.id]);
      const busy = !!(
        app.newElement ||
        app.selectionElement ||
        app.editingTextElement ||
        app.selectedElementsAreBeingDragged ||
        app.isResizing ||
        app.isRotating ||
        app.cursorButton === 'down'
      );
      const key = [
        app.scrollX,
        app.scrollY,
        app.zoom.value,
        app.width,
        app.height,
        app.offsetLeft,
        app.offsetTop,
        app.theme,
        app.viewModeEnabled,
        `${app.activeTool.type}:${app.activeTool.customType ?? ''}`,
        app.openDialog?.name ?? '',
        busy,
        selected.map((e) => `${e.id}:${e.version}`).join(','),
      ].join('|');
      if (key === lastKey) return;
      lastKey = key;
      setState({ app, selected, busy });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const offChange = api.onChange(schedule);
    const offScroll = api.onScrollChange(schedule);
    const onResize = () => schedule();
    window.addEventListener('resize', onResize);
    schedule();
    return () => {
      offChange();
      offScroll();
      window.removeEventListener('resize', onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [api]);
  return state;
}
