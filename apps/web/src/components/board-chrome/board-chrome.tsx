import { useEffect } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ShortcutsOverlay } from '@/components/shortcuts/shortcuts-dialog';
import './board-chrome.css';

/**
 * While a board is open, stop the browser from zooming the page itself (pinch and double-tap belong to the
 * canvas, and iOS would otherwise zoom into small inputs like the title field). Other pages keep normal
 * page zoom for accessibility.
 */
function useBoardViewport() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const previous = meta.content;
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
    return () => {
      meta.content = previous;
    };
  }, []);
}

/** Canvas width at which the title fits beside the centered Excalidraw toolbar. */
const WIDE_CANVAS = 1100;

/**
 * The canvas is narrower than the window when the AI side panel is open, and Excalidraw centers its toolbar on
 * the canvas. Expose the real canvas width to board-chrome.css (--monet-canvas-w, data-monet-layout) so the title bar
 * is placed against the canvas, not the window.
 */
function useCanvasLayout() {
  useEffect(() => {
    const canvas = document.querySelector<HTMLElement>('.monet-canvas');
    if (!canvas) return;
    const apply = (width: number) => {
      canvas.style.setProperty('--monet-canvas-w', `${Math.round(width)}px`);
      canvas.dataset.monetLayout = width >= WIDE_CANVAS ? 'wide' : 'narrow';
    };
    apply(canvas.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => apply(entries[0]!.contentRect.width));
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      canvas.style.removeProperty('--monet-canvas-w');
      delete canvas.dataset.monetLayout;
    };
  }, []);
}

/** Below this on-screen width a section name would only show "…", so it's hidden until you zoom in. */
const MIN_NAME_WIDTH = 44;

/**
 * Excalidraw caps a section name's width at the section's width in scene units, so when you zoom out the names
 * run past their sections and pile on top of each other (a zoomed-out board, or any board on a phone). Cap them
 * at the section's on-screen width instead, so long names end in "…" inside their own section.
 */
function useSectionNameWidths(api: ExcalidrawImperativeAPI | null) {
  useEffect(() => {
    if (!api) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const zoom = api.getAppState().zoom.value;
      const width = new Map<string, number>();
      for (const el of api.getSceneElements()) if (el.type === 'frame' || el.type === 'magicframe') width.set(el.id, el.width * zoom);
      for (const node of document.querySelectorAll<HTMLElement>('.excalidraw [id*="-frame-name-"]')) {
        const w = width.get(node.id.slice(node.id.indexOf('-frame-name-') + '-frame-name-'.length));
        if (w === undefined || node.querySelector('input')) continue;
        node.style.maxWidth = `${Math.max(0, Math.floor(w))}px`;
        node.style.visibility = w < MIN_NAME_WIDTH ? 'hidden' : '';
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const offChange = api.onChange(schedule);
    const offScroll = api.onScrollChange(schedule);
    schedule();
    return () => {
      offChange();
      offScroll();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [api]);
}

/** Monet Blackboard UI that lives around the canvas: viewport handling, layout styles, and the "?" shortcuts overlay. */
export function BoardChrome({ excalidrawAPI }: { excalidrawAPI: ExcalidrawImperativeAPI | null }) {
  useBoardViewport();
  useCanvasLayout();
  useSectionNameWidths(excalidrawAPI);
  return <ShortcutsOverlay excalidrawAPI={excalidrawAPI} />;
}
