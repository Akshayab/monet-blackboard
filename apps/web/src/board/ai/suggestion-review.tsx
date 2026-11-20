// Review UI for AI suggestions: a list in the AI panel and floating Accept / Dismiss chips on the canvas.
import { Check, Lightbulb, X } from 'lucide-react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { cn } from '@/lib/utils';
import { acceptSuggestions, dismissSuggestions, findSuggestionUnits, scrollToUnit, suggestionUnitsEqual, type SuggestionUnit } from './suggestions';
import { toClient, useSceneDerived, type ViewTransform } from './use-scene';

const NO_UNITS: SuggestionUnit[] = [];
const computeUnits = (els: readonly ExcalidrawElement[]) => (els.length ? findSuggestionUnits(els) : NO_UNITS);

export function useSuggestionUnits(api: ExcalidrawImperativeAPI | null): SuggestionUnit[] {
  return useSceneDerived(api, computeUnits, suggestionUnitsEqual, NO_UNITS);
}

export function SuggestionList({ api, units, canEdit }: { api: ExcalidrawImperativeAPI | null; units: SuggestionUnit[]; canEdit: boolean }) {
  if (!units.length || !api) return null;
  return (
    <div className="rounded-xl border border-[var(--monet-border)] bg-[var(--monet-surface)] p-2.5 font-sans" data-testid="ai-suggestions">
      <div className="flex items-center gap-2">
        <Lightbulb className="h-3.5 w-3.5 text-[var(--monet-suggest)]" />
        <span className="flex-1 text-xs font-semibold text-[var(--monet-text-strong)]" data-testid="text-suggestion-count">
          {units.length} suggestion{units.length === 1 ? '' : 's'} to review
        </span>
        {canEdit && units.length > 1 && (
          <>
            <button
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--monet-success)] hover:bg-[var(--monet-surface-2)]"
              onClick={() => acceptSuggestions(api, units)}
              data-testid="button-accept-all-suggestions"
            >
              Accept all
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--monet-text-faint)] hover:bg-[var(--monet-surface-2)]"
              onClick={() => dismissSuggestions(api, units)}
              data-testid="button-dismiss-all-suggestions"
            >
              Dismiss all
            </button>
          </>
        )}
      </div>
      <ul className="mt-1.5 max-h-44 space-y-1 overflow-y-auto">
        {units.map((u) => (
          <li
            key={u.key}
            className="group flex items-start gap-1.5 rounded-lg bg-[var(--monet-surface-2)] px-2 py-1.5 text-xs text-[var(--monet-text)]"
            data-testid="item-suggestion"
          >
            <button className="min-w-0 flex-1 text-left" onClick={() => scrollToUnit(api, u)} title="Show on the board">
              <span className="block truncate font-medium">{u.label}</span>
              {u.reason && <span className="block truncate text-[11px] text-[var(--monet-text-muted)]">{u.reason}</span>}
            </button>
            {canEdit && (
              <span className="flex shrink-0 gap-0.5">
                <button
                  className="grid h-6 w-6 place-items-center rounded text-[var(--monet-success)] hover:bg-[var(--monet-surface-3)]"
                  onClick={() => acceptSuggestions(api, [u])}
                  aria-label="Accept suggestion"
                  data-testid="button-accept-suggestion"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  className="grid h-6 w-6 place-items-center rounded text-[var(--monet-text-muted)] hover:bg-[var(--monet-surface-3)] hover:text-[var(--monet-text-strong)]"
                  onClick={() => dismissSuggestions(api, [u])}
                  aria-label="Dismiss suggestion"
                  data-testid="button-dismiss-suggestion"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Floating chips under each suggestion on the canvas. Rendered in fixed (client) coordinates. */
export function SuggestionChips({
  api,
  units,
  view,
  canEdit,
}: {
  api: ExcalidrawImperativeAPI;
  units: SuggestionUnit[];
  view: ViewTransform;
  canEdit: boolean;
}) {
  if (!units.length || view.zoom < 0.25) return null;
  const left = view.offsetLeft;
  const top = view.offsetTop;
  const right = left + view.width;
  const bottom = top + view.height;
  return (
    <>
      {units.slice(0, 40).map((u) => {
        const p = toClient(view, u.bounds[0], u.bounds[3]);
        const pr = toClient(view, u.bounds[2], u.bounds[3]);
        const y = p.y + 6;
        // Hide when the suggestion is off screen; otherwise keep the chip inside the canvas area.
        if (pr.x < left || p.x > right - 40 || y < top + 50 || y > bottom - 32) return null;
        const chipWidth = canEdit ? 176 : 92;
        const x = Math.max(left + 4, Math.min(p.x, right - chipWidth - 4));
        return (
          <div
            key={u.key}
            className={cn(
              'fixed z-30 flex items-center gap-0.5 rounded-full border border-[var(--monet-border-2)] bg-[var(--monet-surface)] py-0.5 pl-2 pr-0.5 text-[11px] font-medium text-[var(--monet-suggest)] shadow-[0_4px_16px_rgba(0,0,0,0.4)]',
            )}
            style={{ left: x, top: y }}
            data-testid="chip-suggestion"
            title={u.reason ?? 'Suggested by the AI'}
          >
            <Lightbulb className="h-3 w-3" />
            <span className="mr-1">Suggestion</span>
            {canEdit && (
              <>
                <button
                  className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[var(--monet-success)] hover:bg-[var(--monet-hover)]"
                  onClick={() => acceptSuggestions(api, [u])}
                  data-testid="chip-accept-suggestion"
                >
                  <Check className="h-3 w-3" /> Accept
                </button>
                <button
                  className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[var(--monet-text-faint)] hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)]"
                  onClick={() => dismissSuggestions(api, [u])}
                  data-testid="chip-dismiss-suggestion"
                >
                  <X className="h-3 w-3" /> Dismiss
                </button>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
