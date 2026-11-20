// Makes a board AI run undoable for the person who asked for it: Ctrl+Z (or the undo button) takes back the whole
// run in one step, and the undo syncs to everyone like any other edit.
//
// AI changes arrive as remote batches (applied with CaptureUpdateAction.NEVER, so they stay out of undo history, like
// other people's edits). For the requester's own runs, this records what each touched element looked like before the
// run's first change to it. When the run ends, it swaps the scene back to that "before" state without recording, then
// to the current state with recording, so the canvas's history gets exactly one entry: before -> after. Both updates
// happen in the same tick, so nothing flickers, and element versions don't change, so nothing is sent.
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

type El = OrderedExcalidrawElement;

/** Before-state per element id for one run (null: the element didn't exist before the run). */
const runs = new Map<string, Map<string, El | null>>();
const pendingCommits = new Set<ReturnType<typeof setTimeout>>();

/**
 * Call before applying a batch of the requester's own run. Records the before-state of elements the batch actually
 * changes (a batch also carries unchanged frames, labels and arrow ends for context; those are skipped so a person's
 * own edits to them during the run aren't swept into the undo step).
 */
export function noteAiBatch(api: ExcalidrawImperativeAPI, runId: string, incoming: readonly { id: string; version?: unknown }[]) {
  let before = runs.get(runId);
  if (!before) runs.set(runId, (before = new Map()));
  const local = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
  for (const el of incoming) {
    if (before.has(el.id)) continue;
    const cur = local.get(el.id);
    if (cur && typeof el.version === 'number' && el.version <= cur.version) continue;
    // A copy: the canvas mutates element objects in place while people edit them.
    before.set(el.id, cur ? (structuredClone(cur) as El) : null);
  }
}

/** Call when the run ends (done, error or stopped). Records it as one undo step once the person isn't mid-gesture. */
export function finishAiRun(api: ExcalidrawImperativeAPI, runId: string) {
  const before = runs.get(runId);
  if (!before) return;
  runs.delete(runId);
  let tries = 0;
  const attempt = () => {
    const s = api.getAppState();
    const busy = s.newElement || s.multiElement || s.resizingElement || s.editingTextElement || s.selectedElementsAreBeingDragged || s.selectionElement;
    if (busy && tries++ < 40) {
      const t = setTimeout(() => {
        pendingCommits.delete(t);
        attempt();
      }, 250);
      pendingCommits.add(t);
      return;
    }
    if (!busy) commit(api, before);
  };
  attempt();
}

/** Forget recorded runs (after a reconnect the local scene may have been replaced). */
export function resetAiUndo() {
  runs.clear();
  pendingCommits.forEach((t) => clearTimeout(t));
  pendingCommits.clear();
}

function commit(api: ExcalidrawImperativeAPI, before: Map<string, El | null>) {
  const scene = api.getSceneElementsIncludingDeleted();
  const prevScene: El[] = [];
  let changed = false;
  for (const el of scene) {
    if (!before.has(el.id)) {
      prevScene.push(el);
      continue;
    }
    const prev = before.get(el.id)!;
    if (prev === null) {
      if (!el.isDeleted) changed = true;
      continue; // made by this run: absent before it
    }
    if (prev.version !== el.version || prev.versionNonce !== el.versionNonce) changed = true;
    prevScene.push(prev);
  }
  if (!changed) return;
  // Keep fractional-index order valid so the canvas doesn't renumber (and re-version) anything.
  prevScene.sort((a, b) => ((a.index ?? '') < (b.index ?? '') ? -1 : (a.index ?? '') > (b.index ?? '') ? 1 : 0));
  api.updateScene({ elements: prevScene, captureUpdate: CaptureUpdateAction.NEVER });
  api.updateScene({ elements: scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}
