// Re-measures text on the board after it loads and whenever web fonts finish loading. Saved text sizes can be
// narrower than what the browser draws (sizes estimated on the server, or measured before a font arrived), and
// Excalidraw clips text to its element's width, so titles show up cut off mid-word. The refit is local only: it
// keeps each element's version, so nothing is sent; the corrected size is saved the next time someone edits it.
import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

type El = { id: string; type: string; isDeleted?: boolean; containerId?: string | null; width: number; height: number; x: number; y: number; text?: string };

export function refitText(api: ExcalidrawImperativeAPI): number {
  if (api.getAppState().editingTextElement) return 0;
  const all = api.getSceneElementsIncludingDeleted() as unknown as El[];
  const texts = all.filter((e) => e.type === 'text' && !e.isDeleted);
  if (!texts.length) return 0;
  const byId = new Map(all.map((e) => [e.id, e]));
  const containers = texts.map((t) => (t.containerId ? byId.get(t.containerId) : undefined)).filter((c): c is El => !!c);
  // restoreElements only refreshes text sizes when it also repairs bindings; on this partial copy that repair can
  // drop frame or binding links, so only the measured fields are taken from it.
  const copies = JSON.parse(JSON.stringify([...texts, ...containers])) as El[];
  const fresh = restoreElements(copies as never, null, { refreshDimensions: true, repairBindings: true }) as unknown as El[];
  const changed = new Map<string, El>();
  for (const f of fresh) {
    if (f.type !== 'text') continue;
    const old = byId.get(f.id);
    if (!old || f.width <= 0) continue;
    if (Math.abs(f.width - old.width) > 1 || Math.abs(f.height - old.height) > 1 || f.text !== old.text) {
      changed.set(f.id, { ...old, width: f.width, height: f.height, x: f.x, y: f.y, text: f.text });
    }
  }
  if (!changed.size) return 0;
  api.updateScene({ elements: all.map((e) => changed.get(e.id) ?? e) as never, captureUpdate: CaptureUpdateAction.NEVER });
  return changed.size;
}

/** Refits now, after the next frames, and every time the document finishes loading fonts. Returns a cleanup. */
export function watchTextFit(getApi: () => ExcalidrawImperativeAPI | null): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const api = getApi();
      if (api) refitText(api);
    }, 120);
  };
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  fonts?.addEventListener('loadingdone', run);
  void fonts?.ready.then(run);
  return () => {
    clearTimeout(t);
    fonts?.removeEventListener('loadingdone', run);
  };
}
