// Board AI client state: the shared chat history, the AI's live status, per-user usage, and sending
// requests to POST /api/boards/:id/ai.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { exportToBlob } from '@excalidraw/excalidraw';
import type { ChatMessage } from '@monet/board-protocol';
import { api, ApiError } from '@/lib/api';
import { PENDING_PROMPT_KEY } from '@/lib/pending-prompt';
import { toast } from '@/hooks/use-toast';
import { refreshAiUsage, useAiUsage, type AiUsage } from '@/components/usage-meter';
import type { BoardContext } from '../slots';
import type { AiAttachment } from './attachments';
import { sceneViewport } from './use-scene';

export type { AiUsage };

/** The AI is switched off for everyone (kill switch) or out of global daily capacity. Not the same as "not configured". */
export interface AiPause {
  reason: 'disabled' | 'global_budget';
  message: string;
}

export function pauseMessage(reason: AiPause['reason']) {
  return reason === 'disabled' ? 'Monet AI is turned off right now.' : 'Monet AI has reached its daily capacity. Try again later.';
}

export interface AiSendInput {
  prompt: string;
  attachments?: AiAttachment[];
  focusElementIds?: string[];
  mode?: 'chat' | 'live';
}

export type AiStatus = { kind: 'idle' } | { kind: 'sending' } | { kind: 'thinking' | 'drawing'; message?: string; userId?: string | null };

export interface AiNotice {
  tone: 'error' | 'info';
  message: string;
}

/** Element types that are sketches the AI should see as a picture. */
const SKETCH_TYPES = new Set(['freedraw', 'line', 'image']);

async function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** The server marks a stopped run with status (or state) "stopped". */
export function isStoppedStatus(s: unknown) {
  return s === 'stopped';
}

export function useBoardAi(ctx: BoardContext) {
  const { boardId, linkToken, collab, excalidrawAPI } = ctx;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const usageQuery = useAiUsage();
  /** Usage carried by a 429/503 response; shown until /ai/usage reports again. */
  const [usageOverride, setUsageOverride] = useState<AiUsage | null>(null);
  /** Pause reported by a 503 from POST /ai, until /ai/usage reports again. */
  const [pauseFromError, setPauseFromError] = useState<AiPause | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<AiNotice | null>(null);
  /** Run we started whose status event hasn't arrived yet. */
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const aiRunRef = useRef(collab.aiRun);
  /** Focus (selected element ids) of the last request sent from this tab, for the working outline. */
  const lastFocusRef = useRef<{ ids: string[]; at: number } | null>(null);
  aiRunRef.current = collab.aiRun;
  /** Run this tab stopped; treated as finished even before the server's "stopped" frame arrives. */
  const [stoppedRunId, setStoppedRunId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);

  const loadMessages = useCallback(async () => {
    try {
      const data = await api<{ messages: ChatMessage[] }>(`/boards/${boardId}/ai/messages`, { linkToken });
      setMessages((prev) => {
        // Keep anything that arrived over the socket while the request was in flight.
        const byId = new Map(data.messages.map((m) => [m.id, m]));
        for (const m of prev) if (!byId.has(m.id)) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
    } catch {
      /* the panel shows an empty history */
    } finally {
      setLoaded(true);
    }
  }, [boardId, linkToken]);

  // Fresh numbers from /ai/usage replace anything learned from an error response.
  useEffect(() => {
    setUsageOverride(null);
    setPauseFromError(null);
  }, [usageQuery.data]);

  const usage = usageOverride ?? usageQuery.data?.usage ?? null;
  /** Only /ai/usage decides "not configured"; a 503 from POST /ai can also mean the AI is paused. */
  const configured = usageQuery.data ? usageQuery.data.configured : null;
  const paused: AiPause | null = useMemo(() => {
    if (pauseFromError) return pauseFromError;
    if (usage?.paused) {
      const reason = usage.pausedReason === 'disabled' ? 'disabled' : 'global_budget';
      return { reason, message: pauseMessage(reason) };
    }
    return null;
  }, [pauseFromError, usage]);

  /** Refetches usage in every mounted meter and in this panel. */
  const refreshUsage = useCallback(() => refreshAiUsage(), []);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  // Refetch history after a reconnect so messages sent while offline show up.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (collab.connection === 'connected') {
      if (wasConnected.current) void loadMessages();
      wasConnected.current = true;
    }
  }, [collab.connection, loadMessages]);

  useEffect(
    () =>
      collab.onChat((m) => {
        const runId = typeof m.meta?.runId === 'string' ? m.meta.runId : null;
        setMessages((prev) => {
          if (prev.some((x) => x.id === m.id)) return prev;
          // A server message for a run replaces the local "You stopped…" placeholder for it.
          const next = runId && m.role === 'assistant' ? prev.filter((x) => !(x.meta?.localStop === true && x.meta?.runId === runId)) : prev;
          return [...next, m];
        });
        if (m.role === 'assistant' && runId) setPendingRunId((p) => (p === runId ? null : p));
      }),
    [collab],
  );

  // Track run status: clear the pending run once its events arrive, refresh usage when a run ends.
  const run = collab.aiRun;
  useEffect(() => {
    if (!run) return;
    setPendingRunId((p) => (p === run.runId ? null : p));
    if (run.status === 'done' || run.status === 'error' || isStoppedStatus(run.status)) refreshUsage();
  }, [run, refreshUsage]);

  // Don't show "thinking" forever if the status event never arrives.
  useEffect(() => {
    if (!pendingRunId) return;
    const t = setTimeout(() => setPendingRunId(null), 120_000);
    return () => clearTimeout(t);
  }, [pendingRunId]);

  messagesRef.current = messages;
  const status: AiStatus = useMemo(() => {
    if (run && run.runId !== stoppedRunId && (run.status === 'thinking' || run.status === 'drawing'))
      return { kind: run.status, message: run.message, userId: run.userId };
    if (pendingRunId && pendingRunId !== stoppedRunId) return { kind: 'thinking' };
    if (sending) return { kind: 'sending' };
    return { kind: 'idle' };
  }, [run, pendingRunId, sending, stoppedRunId]);

  // A failed run shows as a notice unless the server already posted an error message for it.
  const runError = useMemo(() => {
    if (!run || run.status !== 'error') return null;
    const posted = messages.some((m) => m.role === 'assistant' && m.meta?.runId === run.runId);
    return posted ? null : run.message || 'The AI ran into a problem.';
  }, [run, messages]);

  const snapshotFor = useCallback(
    async (ids: string[]): Promise<string | undefined> => {
      if (!excalidrawAPI || !ids.length) return undefined;
      const set = new Set(ids);
      const els = excalidrawAPI.getSceneElements().filter((e) => set.has(e.id));
      if (!els.some((e) => SKETCH_TYPES.has(e.type))) return undefined;
      try {
        const blob = await exportToBlob({
          elements: els,
          files: excalidrawAPI.getFiles(),
          appState: { exportBackground: true, viewBackgroundColor: '#ffffff' },
          maxWidthOrHeight: 1200,
          mimeType: 'image/png',
        });
        const url = await blobToDataURL(blob);
        return url.length < 7_500_000 ? url : undefined;
      } catch {
        return undefined;
      }
    },
    [excalidrawAPI],
  );

  const send = useCallback(
    async (input: AiSendInput): Promise<boolean> => {
      const prompt = input.prompt.trim();
      if (!prompt) return false;
      setSending(true);
      setNotice(null);
      try {
        const focus = input.focusElementIds?.length ? input.focusElementIds : undefined;
        lastFocusRef.current = { ids: focus ?? [], at: Date.now() };
        const snapshot = focus ? await snapshotFor(focus) : undefined;
        const res = await api<{ runId?: string }>(`/boards/${boardId}/ai`, {
          method: 'POST',
          linkToken,
          json: {
            prompt,
            ...(focus ? { focusElementIds: focus } : {}),
            viewport: sceneViewport(excalidrawAPI),
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
            ...(snapshot ? { snapshot } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
          },
        });
        const runId = res.runId;
        if (runId && aiRunRef.current?.runId !== runId) setPendingRunId(runId);
        refreshUsage();
        return true;
      } catch (err) {
        if (err instanceof ApiError) {
          if ((err.status === 429 || err.status === 503) && err.data.usage) setUsageOverride(err.data.usage as AiUsage);
          const code = typeof err.data.code === 'string' ? err.data.code : null;
          if (err.status === 503 && (code === 'ai_disabled' || code === 'global_budget')) {
            // Paused for everyone: shown as a paused state, not as an error or "not configured".
            const reason = code === 'ai_disabled' ? 'disabled' : 'global_budget';
            setPauseFromError({ reason, message: err.message || pauseMessage(reason) });
            if (!err.data.usage) refreshUsage();
            return false;
          }
          // Let /ai/usage say whether the AI is configured.
          if (err.status === 503) refreshUsage();
          setNotice({
            tone: 'error',
            message:
              err.message ||
              (err.status === 429
                ? "You've reached your AI limit for now."
                : err.status === 503
                  ? "The board AI isn't available right now."
                  : 'Something went wrong sending that.'),
          });
        } else {
          setNotice({ tone: 'error', message: "Couldn't reach the server. Check your connection and try again." });
        }
        return false;
      } finally {
        setSending(false);
      }
    },
    [boardId, excalidrawAPI, linkToken, refreshUsage, snapshotFor],
  );

  /** Stops the running AI request (POST /api/boards/:id/ai/stop). Everyone's overlay clears on the server's "stopped" frame. */
  const stop = useCallback(async () => {
    const cur = aiRunRef.current;
    const runId = cur && (cur.status === 'thinking' || cur.status === 'drawing') ? cur.runId : pendingRunId;
    setStopping(true);
    try {
      const res = await api<{ stopped?: boolean; runIds?: string[] }>(`/boards/${boardId}/ai/stop`, {
        method: 'POST',
        linkToken,
        json: runId ? { runId } : {},
      });
      const stoppedId = runId ?? res.runIds?.[0] ?? null;
      // Clear the run locally either way (if nothing was running server-side, our view was stale).
      if (stoppedId) setStoppedRunId(stoppedId);
      if (stoppedId && res.stopped !== false) {
        // If the server doesn't post its own entry for the stopped run, add a local one.
        setTimeout(() => {
          if (messagesRef.current.some((m) => m.role === 'assistant' && m.meta?.runId === stoppedId)) return;
          setMessages((prev) => [
            ...prev,
            {
              id: `local-stop-${stoppedId}`,
              boardId,
              userId: null,
              userName: null,
              role: 'assistant',
              content: '',
              meta: { runId: stoppedId, stopped: true, localStop: true, stoppedBy: ctx.collab.me?.userId ?? ctx.user?.id ?? null },
              createdAt: new Date().toISOString(),
            },
          ]);
        }, 2500);
      }
      setPendingRunId(null);
      refreshUsage();
      return true;
    } catch (err) {
      const missing = err instanceof ApiError && err.status === 404 && (!err.data.error || /cannot post|<html|<!doctype/i.test(String(err.data.error)));
      if (missing) {
        toast({ title: "Stopping isn't available yet", description: 'This server can’t stop a running AI request yet, so the AI will finish on its own.' });
      } else {
        toast({ title: "Couldn't stop Monet AI", description: err instanceof Error ? err.message : 'Try again in a moment.', variant: 'destructive' });
      }
      return false;
    } finally {
      setStopping(false);
    }
  }, [boardId, ctx.collab.me?.userId, ctx.user?.id, linkToken, pendingRunId, refreshUsage]);

  return {
    stop,
    stopping,
    messages,
    loaded,
    usage,
    configured,
    paused,
    status,
    runError,
    notice,
    setNotice,
    sending,
    send,
    refreshUsage,
    lastFocusRef,
  };
}

export type BoardAi = ReturnType<typeof useBoardAi>;

/** Key the home page uses to hand a prompt to a freshly created board (see pages/home.tsx). */

/** Sends the prompt typed on the home page once, when this board opens. */
export function usePendingPrompt(ctx: BoardContext, send: (input: AiSendInput) => Promise<boolean>) {
  const done = useRef(false);
  const ready = ctx.collab.connection === 'connected' && ctx.canEdit && !!ctx.excalidrawAPI;
  useEffect(() => {
    if (!ready || done.current) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PENDING_PROMPT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: { boardId?: string; prompt?: string } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(PENDING_PROMPT_KEY);
      return;
    }
    if (!parsed || parsed.boardId !== ctx.boardId || !parsed.prompt?.trim()) return;
    done.current = true;
    sessionStorage.removeItem(PENDING_PROMPT_KEY);
    void send({ prompt: parsed.prompt });
  }, [ready, ctx.boardId, send]);
}
