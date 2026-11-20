// Floating AI UI over the canvas (mounted through BoardSlots.Children): the "Ask AI" button next to the
// selection (focuses the prompt bar), Accept / Dismiss chips under AI suggestions, and the rust outline while
// the AI works. Also hosts the shared AI session for the board, so it must stay mounted.
// Rendered into document.body in fixed coordinates so it doesn't depend on Excalidraw's internal layout.
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import type { BoardContext } from '../slots';
import { AiController } from './ai-session';
import { aiUi } from './store';
import { SuggestionChips, useSuggestionUnits } from './suggestion-review';
import { toClient, useSelection, useViewTransform } from './use-scene';
import { WorkingOverlay } from './working-overlay';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function AiCanvasOverlays({ ctx }: { ctx: BoardContext }) {
  const api = ctx.excalidrawAPI;
  const view = useViewTransform(api);
  const selection = useSelection(api);
  const units = useSuggestionUnits(api);

  let ask: React.ReactNode = null;
  if (api && view.width && ctx.canEdit && selection.count > 0 && !selection.busy && selection.bounds) {
    const [minX, minY, maxX, maxY] = selection.bounds;
    const tl = toClient(view, minX, minY);
    const br = toClient(view, maxX, maxY);
    const left = view.offsetLeft;
    const top = view.offsetTop;
    const right = left + view.width;
    const bottom = top + view.height;
    const visible = br.x > left && tl.x < right && br.y > top && tl.y < bottom;
    if (visible) {
      const w = 86;
      const x = Math.min(Math.max(br.x - w, left + 8), right - w - 8);
      // Above the selection, clear of the rotation handle; below it when there's no room on top.
      let y = tl.y - 52;
      if (y < top + 56) y = Math.min(br.y + 16, bottom - 44);
      ask = (
        <button
          className="fixed z-30 flex items-center gap-1.5 rounded-full border border-[var(--monet-active-border)] bg-[var(--monet-active-bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--monet-active-fg)] shadow-[0_4px_16px_rgba(0,0,0,0.4)] transition hover:bg-[var(--monet-active-hover-bg)] hover:text-[var(--monet-active-hover-fg)]"
          style={{ left: x, top: y }}
          onClick={() => aiUi.focusPrompt()}
          data-testid="button-ask-ai-selection"
        >
          <Sparkles className="h-3.5 w-3.5" /> Ask AI
        </button>
      );
    }
  }

  return (
    <>
      <AiController ctx={ctx} />
      {api && view.width && typeof document !== 'undefined'
        ? createPortal(
            <div className="monet-ai-overlays" onPointerDown={stop} onPointerUp={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
              <WorkingOverlay view={view} />
              <SuggestionChips api={api} units={units} view={view} canEdit={ctx.canEdit} />
              {ask}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
