// Zoom pill at the top right of the board (a small rounded pill with undo/redo and the zoom level).
// Undo and redo click Excalidraw's own (hidden) history buttons so its history logic stays the single source;
// zoom keeps the viewport center fixed.
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ChevronDown, Redo2, Undo2 } from 'lucide-react';
import { ShellMenu, ShellMenuItem, ShellMenuSeparator } from './shell-menu';
import { useSceneState } from '@/board/inputs/use-scene-state';
import { refocusCanvas } from '@/board/inputs/overlay';
import type { LocalTimer } from '@/board/use-collab';
import { BoardTimerButton } from './board-timer';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

export function setZoom(api: ExcalidrawImperativeAPI, next: number) {
  const app = api.getAppState();
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  const cx = app.width / 2;
  const cy = app.height / 2;
  // Scene point under the viewport center stays put.
  const sx = cx / app.zoom.value - app.scrollX;
  const sy = cy / app.zoom.value - app.scrollY;
  api.updateScene({
    appState: { zoom: { value: z as never }, scrollX: cx / z - sx, scrollY: cy / z - sy },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

export function zoomIn(api: ExcalidrawImperativeAPI) {
  setZoom(api, Math.round((api.getAppState().zoom.value + 0.1) * 10) / 10);
}
export function zoomOut(api: ExcalidrawImperativeAPI) {
  setZoom(api, Math.round((api.getAppState().zoom.value - 0.1) * 10) / 10);
}
export function zoomToFit(api: ExcalidrawImperativeAPI) {
  const els = api.getSceneElements();
  if (els.length) api.scrollToContent(els, { fitToContent: true, animate: true });
  else setZoom(api, 1);
}

/** Runs Excalidraw's own undo/redo (its history buttons stay in the DOM while hidden). */
export function history(kind: 'undo' | 'redo') {
  const btn = document.querySelector<HTMLButtonElement>(`.excalidraw [data-testid="button-${kind}"]`);
  if (btn) {
    btn.click();
    return;
  }
  // Phones: Excalidraw renders no footer, so send the shortcut instead.
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', shiftKey: kind === 'redo', bubbles: true, cancelable: true, ...mod }));
}

const pillBtn =
  'grid h-7 w-7 place-items-center rounded-md text-[var(--monet-text-faint)] transition hover:bg-[var(--monet-surface-3)] hover:text-[var(--monet-text-strong)] disabled:opacity-40 disabled:hover:bg-transparent';

export function ZoomPill({
  api,
  canEdit,
  timer = null,
  onTimer,
}: {
  api: ExcalidrawImperativeAPI | null;
  canEdit: boolean;
  timer?: LocalTimer | null;
  onTimer?: (action: 'start' | 'pause' | 'reset' | 'add', durationMs?: number) => void;
}) {
  const scene = useSceneState(api);
  if (!api || !scene) return null;
  const pct = Math.round(scene.app.zoom.value * 100);
  const run = (fn: () => void) => () => {
    fn();
    refocusCanvas();
    setTimeout(refocusCanvas, 0);
  };
  return (
    <div
      className="monet-zoom-pill pointer-events-auto absolute right-3 top-3 z-30 flex items-center gap-0.5 rounded-xl border border-[var(--monet-border)] bg-[var(--monet-surface)] p-1 shadow-[0_4px_16px_rgba(0,0,0,0.35)]"
      data-testid="zoom-pill"
    >
      {canEdit && (
        <>
          <button
            type="button"
            className={pillBtn}
            onClick={run(() => history('undo'))}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            data-testid="button-history-undo"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={pillBtn}
            onClick={run(() => history('redo'))}
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            data-testid="button-history-redo"
          >
            <Redo2 className="h-4 w-4" />
          </button>
          <span className="mx-0.5 h-4 w-px bg-[var(--monet-border-2)]" />
        </>
      )}
      {onTimer && <BoardTimerButton timer={timer} canEdit={canEdit} onTimer={onTimer} />}
      <ShellMenu
        trigger={({ toggle }) => (
          <button
            type="button"
            onClick={toggle}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[13px] tabular-nums text-[var(--monet-text)] transition hover:bg-[var(--monet-surface-3)] hover:text-[var(--monet-text-strong)]"
            aria-label={`Zoom ${pct}%`}
            aria-haspopup="menu"
            data-testid="button-zoom-menu"
          >
            {pct}%
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          </button>
        )}
      >
        {(close) => (
          <>
            <ShellMenuItem
              onSelect={() => {
                zoomIn(api);
                close();
              }}
              shortcut="Ctrl +"
              testId="menu-zoom-in"
            >
              Zoom in
            </ShellMenuItem>
            <ShellMenuItem
              onSelect={() => {
                zoomOut(api);
                close();
              }}
              shortcut="Ctrl −"
              testId="menu-zoom-out"
            >
              Zoom out
            </ShellMenuItem>
            <ShellMenuSeparator />
            <ShellMenuItem
              onSelect={() => {
                zoomToFit(api);
                close();
              }}
              shortcut="⇧ 1"
              testId="menu-zoom-fit"
            >
              Zoom to fit
            </ShellMenuItem>
            <ShellMenuItem
              onSelect={() => {
                setZoom(api, 1);
                close();
              }}
              shortcut="100%"
              testId="menu-zoom-100"
            >
              Reset zoom
            </ShellMenuItem>
          </>
        )}
      </ShellMenu>
    </div>
  );
}
