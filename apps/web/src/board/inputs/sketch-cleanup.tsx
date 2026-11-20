// Sketch to diagram: when the selection contains freehand strokes, offer "Clean up with AI". The selection
// is exported as a PNG and sent with its element ids so the AI can redraw it as clean shapes, arrows and text.
import { useEffect, useState } from 'react';
import { exportToBlob, getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ArrowRight, Loader2, Replace, Wand2 } from 'lucide-react';
import { requestAi } from './ai';
import { readAsDataURL } from './files';
import { clampToWindow, Overlay, refocusCanvas } from './overlay';
import { sceneToClient } from './scene';
import type { SceneState } from './use-scene-state';

const PROMPTS = {
  beside:
    'Clean up this sketch: redraw it as a tidy diagram with proper shapes, arrows and text labels, keeping the same structure and wording. Put the clean version to the right of the sketch and keep the sketch.',
  replace:
    'Clean up this sketch: redraw it as a tidy diagram with proper shapes, arrows and text labels, keeping the same structure and wording. Put the clean version where the sketch is and remove the original hand-drawn strokes.',
} as const;

export type CleanupMode = keyof typeof PROMPTS;

/** Selected elements plus any text bound inside them (selection only lists containers). */
function withBoundText(api: ExcalidrawImperativeAPI, selected: readonly ExcalidrawElement[]) {
  const ids = new Set(selected.map((e) => e.id));
  const bound = api.getSceneElements().filter((e) => e.type === 'text' && 'containerId' in e && e.containerId && ids.has(e.containerId));
  return [...selected, ...bound.filter((b) => !ids.has(b.id))];
}

export function SketchCleanup(props: {
  api: ExcalidrawImperativeAPI;
  scene: SceneState;
  boardId: string;
  linkToken: string | null;
  onStarted: (run: { runId: string; x: number; y: number; label: string }) => void;
  onError: (message: string) => void;
}) {
  const { api, scene, boardId, linkToken, onStarted, onError } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectionKey = scene.selected.map((e) => e.id).join(',');
  useEffect(() => setMenuOpen(false), [selectionKey]);

  const hasSketch = scene.selected.some((e) => e.type === 'freedraw');
  if (!hasSketch || (scene.busy && !busy) || scene.app.viewModeEnabled) return null;

  const [minX, minY, maxX, maxY] = getCommonBounds(scene.selected);
  // Beside the selection's top-right corner (the AI panel's "Ask AI" button sits centered above selections).
  // If that would run past the canvas (e.g. into the AI panel), go beside the top-left corner instead.
  const topRight = sceneToClient(maxX, minY, scene.app);
  const topLeft = sceneToClient(minX, minY, scene.app);
  const menuW = 250;
  const canvasRight = scene.app.offsetLeft + scene.app.width - 12;
  const x = topRight.x + 16 + menuW <= canvasRight ? topRight.x + 16 : Math.max(scene.app.offsetLeft + 12, topLeft.x - 16 - menuW);
  const pos = clampToWindow(x, topRight.y, menuW, menuOpen ? 140 : 40);

  const run = async (mode: CleanupMode) => {
    setBusy(true);
    setMenuOpen(false);
    refocusCanvas();
    try {
      const elements = withBoundText(api, scene.selected);
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
        mimeType: 'image/png',
        maxWidthOrHeight: 1400,
        exportPadding: 24,
      });
      const snapshot = await readAsDataURL(blob);
      const width = Math.max(maxX - minX, 320);
      const height = Math.max(maxY - minY, 200);
      const viewport = mode === 'beside' ? { x: maxX + 80, y: minY, width, height } : { x: minX, y: minY, width, height };
      const { runId } = await requestAi(boardId, linkToken, {
        prompt: PROMPTS[mode],
        snapshot,
        focusElementIds: elements.map((e) => e.id),
        viewport,
      });
      onStarted({ runId, x: viewport.x, y: viewport.y, label: 'Cleaning up your sketch…' });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not send the sketch to the AI.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      <div className="fixed z-30 flex flex-col items-start gap-1" style={{ left: pos.left, top: pos.top }}>
        <button
          className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-medium text-violet-700 shadow-md hover:bg-violet-50 disabled:opacity-70"
          onClick={() => setMenuOpen((o) => !o)}
          disabled={busy}
          data-testid="button-clean-up-sketch"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          {busy ? 'Sending sketch…' : 'Clean up with AI'}
        </button>
        {menuOpen && (
          <div className="w-[250px] overflow-hidden rounded-lg border bg-white text-sm shadow-lg" role="menu" data-testid="menu-clean-up-sketch">
            <button
              role="menuitem"
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted"
              onClick={() => void run('beside')}
              data-testid="button-clean-up-beside"
            >
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block font-medium">Redraw next to it</span>
                <span className="block text-xs text-muted-foreground">Keeps your sketch</span>
              </span>
            </button>
            <button
              role="menuitem"
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted"
              onClick={() => void run('replace')}
              data-testid="button-clean-up-replace"
            >
              <Replace className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block font-medium">Replace the sketch</span>
                <span className="block text-xs text-muted-foreground">Swaps strokes for clean shapes</span>
              </span>
            </button>
          </div>
        )}
      </div>
    </Overlay>
  );
}
