// Floating UI for canvas inputs renders in a portal on <body> (outside Excalidraw's DOM, so its styles and
// native listeners don't apply). React still bubbles synthetic events through the component tree into
// Excalidraw's container handlers, so keyboard, paste and drop events stop here.
import type { ReactNode, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

export const OVERLAY_ATTR = 'data-monet-overlay';

const stop = (e: SyntheticEvent) => e.stopPropagation();
const stopDrop = (e: SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

export function Overlay({ children }: { children: ReactNode }) {
  return createPortal(
    <div
      {...{ [OVERLAY_ATTR]: '' }}
      onKeyDown={stop}
      onKeyUp={stop}
      onPaste={stop}
      onCopy={stop}
      onCut={stop}
      onDrop={stopDrop}
      onDragOver={stopDrop}
      onWheel={stop}
    >
      {children}
    </div>,
    document.body,
  );
}

/** True when an event target sits inside one of our overlays (or any other app dialog). */
export function isInOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(`[${OVERLAY_ATTR}], [role="dialog"]`);
}

export function isWritable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Gives keyboard focus back to the canvas so Excalidraw shortcuts (Escape, Delete, tools) work again. */
export function refocusCanvas() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && isInOverlay(active)) active.blur();
  document.querySelector<HTMLElement>('.excalidraw-container')?.focus({ preventScroll: true });
}

/** Keeps a floating card of the given size inside the window. */
export function clampToWindow(x: number, y: number, width: number, height: number, margin = 12) {
  return {
    left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  };
}
