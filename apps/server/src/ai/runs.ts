// In-flight board AI runs, so people can stop them. Each run gets an AbortController whose signal is threaded
// into the model call, the tool loop, and the live drawing loop; stopping keeps whatever was already placed.
import { atLeast, getBoardAccess } from "../lib/access";

/** The reason a stopped run's signal carries. */
export class RunStoppedError extends Error {
  constructor(readonly stoppedBy: string | null) {
    super("Stopped.");
    this.name = "RunStoppedError";
  }
}

interface ActiveRun {
  runId: string;
  userId: string;
  /** The share link the run was started with, to re-check the requester's access. */
  linkToken: string | null;
  controller: AbortController;
  done: Promise<void>;
}

const active = new Map<string, Map<string, ActiveRun>>();

/** Registers a run; call finish() when it has fully ended (after its final status and chat message). */
export function registerRun(boardId: string, runId: string, userId: string, linkToken: string | null = null): { signal: AbortSignal; finish: () => void } {
  const controller = new AbortController();
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const runs = active.get(boardId) ?? new Map<string, ActiveRun>();
  runs.set(runId, { runId, userId, linkToken, controller, done });
  active.set(boardId, runs);
  return {
    signal: controller.signal,
    finish: () => {
      const m = active.get(boardId);
      m?.delete(runId);
      if (m && !m.size) active.delete(boardId);
      resolve();
    },
  };
}

/** Who asked for an active run (null once it has finished). */
export function runOwner(boardId: string, runId: string): string | null {
  return active.get(boardId)?.get(runId)?.userId ?? null;
}

export function activeRunIds(boardId: string): string[] {
  return [...(active.get(boardId)?.keys() ?? [])];
}

/**
 * Stops a board's active run (or every active run when no runId is given) and waits up to `waitMs` for them to
 * wind down. Returns the run ids that were asked to stop.
 */
export async function stopRuns(boardId: string, stoppedBy: string, opts: { runId?: string; waitMs?: number } = {}): Promise<string[]> {
  const runs = [...(active.get(boardId)?.values() ?? [])].filter((r) => !opts.runId || r.runId === opts.runId);
  for (const r of runs) if (!r.controller.signal.aborted) r.controller.abort(new RunStoppedError(stoppedBy));
  const wait = opts.waitMs ?? 3000;
  if (runs.length && wait > 0) {
    await Promise.race([Promise.all(runs.map((r) => r.done)), new Promise((res) => setTimeout(res, wait))]);
  }
  return runs.map((r) => r.runId);
}

/** After a sharing change: stops runs (all, or one person's) whose requester can no longer edit the board. */
export async function stopRevokedRuns(boardId: string, userId?: string) {
  const runs = [...(active.get(boardId)?.values() ?? [])].filter((r) => !userId || r.userId === userId);
  await Promise.all(
    runs.map(async (r) => {
      const access = await getBoardAccess(boardId, r.userId, r.linkToken).catch(() => undefined);
      if (access === undefined || atLeast(access?.role, "editor") || r.controller.signal.aborted) return;
      r.controller.abort(new RunStoppedError(null));
    }),
  );
}

/** Throws the stop reason when the signal was aborted. */
export function throwIfStopped(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new RunStoppedError(null);
}

/** A sleep that ends early (and throws) when the run is stopped. */
export function sleepUnlessStopped(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
