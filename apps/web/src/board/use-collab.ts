// Realtime collaboration for a board: keeps the Excalidraw scene in sync with the server room over a
// WebSocket, shows collaborator cursors/selection, relays viewports for follow mode, and syncs image files.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, reconcileElements, restoreElements } from '@excalidraw/excalidraw';
import { toDisplay, toStored } from '@/lib/theme';
import type { AppState, BinaryFileData, BinaryFiles, Collaborator as XCollaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  WS_PATH,
  shouldAcceptElement,
  type AiRunStatus,
  type BoardRole,
  type BoardTimer,
  type ChatMessage,
  type ClientMessage,
  type Collaborator,
  type SceneElement,
  type ServerMessage,
  type Viewport,
} from '@monet/board-protocol';
import { api } from '@/lib/api';
import { finishAiRun, noteAiBatch, resetAiUndo } from './ai-undo';
import { refitText, watchTextFit } from './text-refit';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface AiRunState {
  runId: string;
  status: AiRunStatus;
  message?: string;
  userId?: string | null;
  /** Scene area the AI is drawing into, when the server sends one (used for the "working" outline). */
  region?: { x: number; y: number; width: number; height: number } | null;
}

export interface CollabState {
  connection: ConnectionState;
  me: Collaborator | null;
  collaborators: Collaborator[];
  role: BoardRole | null;
  title: string;
  error: { code: string; message: string } | null;
  aiRun: AiRunState | null;
  following: string | null;
  /** Socket ids of people currently following my viewport. */
  followers: string[];
  /** The board's shared countdown. endsAt is local time while running (computed on receipt, so no clock skew). */
  timer: LocalTimer | null;
  /** Cursor chat messages from other people, by socket id (removed when they clear it or leave). */
  cursorChats: Record<string, { text: string; at: number }>;
}

export interface LocalTimer {
  durationMs: number;
  remainingMs: number;
  running: boolean;
  endsAt: number | null;
  by?: string;
}

function toLocalTimer(t: BoardTimer | null | undefined): LocalTimer | null {
  if (!t) return null;
  return { ...t, endsAt: t.running ? Date.now() + t.remainingMs : null };
}

type Listener<T> = (v: T) => void;

export interface CollabApi extends CollabState {
  /** Pass to <Excalidraw onChange>. */
  onChange: (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => void;
  /** Pass to <Excalidraw onPointerUpdate>. */
  onPointerUpdate: (payload: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' }; button: 'down' | 'up' }) => void;
  follow: (socketId: string | null) => void;
  /** Subscribe to chat messages pushed by the server. Returns an unsubscribe function. */
  onChat: (fn: Listener<ChatMessage>) => () => void;
  /** Subscribe to element batches applied from the server (source = 'ai' for AI changes). */
  onRemoteElements: (fn: Listener<{ elements: SceneElement[]; source: 'user' | 'ai' }>) => () => void;
  sendViewport: () => void;
  /** Start (with a duration: a new countdown; without: resume), pause, add a minute, or reset the board timer. */
  sendTimer: (action: 'start' | 'pause' | 'reset' | 'add', durationMs?: number) => void;
  /** Shows (or with "" clears) a short message next to my cursor for everyone else. */
  sendCursorChat: (text: string) => void;
  /** A collaborator's last cursor position in scene coordinates. */
  pointerOf: (socketId: string) => { x: number; y: number } | null;
  /** Connects again after the server ended the connection (e.g. the session was replaced by a new sign-in). */
  reconnect: () => void;
}

const COLLAB_THROTTLE_MS = 60;
/** How long to wait for the server's init after sending hello before reconnecting. */
const INIT_TIMEOUT_MS = 8000;

function toXCollaborator(c: Collaborator, extra: Partial<XCollaborator> = {}): XCollaborator {
  return {
    id: c.userId,
    socketId: c.socketId as SocketId,
    username: c.isAI ? `${c.name} ✦` : c.name,
    avatarUrl: c.avatarUrl ?? undefined,
    color: { background: c.color, stroke: c.color },
    ...extra,
  };
}

export function useCollab(opts: {
  boardId: string;
  linkToken: string | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  initialTitle?: string;
}): CollabApi {
  const { boardId, linkToken, excalidrawAPI } = opts;
  const [state, setState] = useState<CollabState>({
    connection: 'connecting',
    me: null,
    collaborators: [],
    role: null,
    title: opts.initialTitle ?? '',
    error: null,
    aiRun: null,
    following: null,
    followers: [],
    timer: null,
    cursorChats: {},
  });

  const wsRef = useRef<WebSocket | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(excalidrawAPI);
  apiRef.current = excalidrawAPI;
  const meRef = useRef<Collaborator | null>(null);
  const roleRef = useRef<BoardRole | null>(null);
  /** Last version we sent or received for each element id. */
  const syncedVersions = useRef(new Map<string, number>());
  const pendingSend = useRef<NodeJS.Timeout | null>(null);
  const initialized = useRef(false);
  const xCollaborators = useRef(new Map<SocketId, XCollaborator>());
  const presence = useRef(new Map<string, Collaborator>());
  const followingRef = useRef<string | null>(null);
  const uploadedFiles = useRef(new Set<string>());
  const fetchingFiles = useRef(new Set<string>());
  const chatListeners = useRef(new Set<Listener<ChatMessage>>());
  const remoteListeners = useRef(new Set<Listener<{ elements: SceneElement[]; source: 'user' | 'ai' }>>());
  const lastPointerSent = useRef(0);
  const lastViewportSent = useRef(0);
  const trailingViewport = useRef<NodeJS.Timeout | null>(null);
  const followersRef = useRef<string[]>([]);
  const queuedBeforeInit = useRef<ServerMessage[]>([]);
  const [connectNonce, setConnectNonce] = useState(0);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const pushCollaborators = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    api.updateScene({ collaborators: new Map(xCollaborators.current), captureUpdate: CaptureUpdateAction.NEVER });
  }, []);

  const fetchMissingFiles = useCallback(
    async (ids?: string[]) => {
      const api = apiRef.current;
      if (!api) return;
      const have = api.getFiles();
      let wanted = ids;
      if (!wanted) {
        wanted = api
          .getSceneElements()
          .filter((e) => e.type === 'image' && (e as { fileId?: string }).fileId)
          .map((e) => (e as unknown as { fileId: string }).fileId);
      }
      wanted = [...new Set(wanted)].filter((id) => !have[id] && !fetchingFiles.current.has(id));
      if (!wanted.length) return;
      wanted.forEach((id) => fetchingFiles.current.add(id));
      try {
        // The server answers at most 200 ids per request.
        for (let i = 0; i < wanted.length; i += 100) {
          const data = await api_get_files(boardId, wanted.slice(i, i + 100), linkToken);
          if (data.length) {
            data.forEach((f) => uploadedFiles.current.add(f.id));
            api.addFiles(data as unknown as BinaryFileData[]);
          }
        }
      } finally {
        wanted.forEach((id) => fetchingFiles.current.delete(id));
      }
    },
    [boardId, linkToken],
  );

  const applyRemoteElements = useCallback(
    (remote: SceneElement[], source: 'user' | 'ai') => {
      const api = apiRef.current;
      if (!api) return;
      // AI-generated elements carry estimated text sizes; restore refreshes them and repairs bindings.
      const local = api.getSceneElementsIncludingDeleted();
      // Light mode shows theme-dependent colors swapped (boards are stored in the dark palette).
      const shown = toDisplay(remote);
      const incoming =
        source === 'ai' ? (restoreElements(shown as never, local, { refreshDimensions: true, repairBindings: true }) as unknown as SceneElement[]) : shown;
      for (const el of incoming) syncedVersions.current.set(el.id, el.version);
      const reconciled = reconcileElements(local, incoming as never, api.getAppState());
      api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
      // Make sure the versions we just applied are not echoed back.
      for (const el of api.getSceneElementsIncludingDeleted()) {
        const v = syncedVersions.current.get(el.id);
        if (v === undefined || el.version > v) {
          if (incoming.some((i) => i.id === el.id)) syncedVersions.current.set(el.id, el.version);
        }
      }
      remoteListeners.current.forEach((fn) => fn({ elements: incoming, source }));
      if (incoming.some((e) => e.type === 'image')) void fetchMissingFiles();
    },
    [fetchMissingFiles],
  );

  const applyFollowViewport = useCallback((vp: Viewport) => {
    const api = apiRef.current;
    if (!api) return;
    const app = api.getAppState();
    const cx = -vp.scrollX + vp.width / 2 / vp.zoom;
    const cy = -vp.scrollY + vp.height / 2 / vp.zoom;
    const zoom = vp.zoom;
    api.updateScene({
      appState: {
        scrollX: -(cx - app.width / 2 / zoom),
        scrollY: -(cy - app.height / 2 / zoom),
        zoom: { value: zoom as never },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  /** Keeps a scene point in view (used to follow the AI, which has a cursor but no viewport). */
  const ensureVisible = useCallback((x: number, y: number) => {
    const api = apiRef.current;
    if (!api) return;
    const app = api.getAppState();
    const zoom = app.zoom.value;
    const left = -app.scrollX;
    const top = -app.scrollY;
    const w = app.width / zoom;
    const h = app.height / zoom;
    const marginX = w * 0.18;
    const marginY = h * 0.18;
    if (x > left + marginX && x < left + w - marginX && y > top + marginY && y < top + h - marginY) return;
    api.updateScene({
      appState: { scrollX: -(x - w / 2), scrollY: -(y - h / 2) },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  /** Starts/stops following and keeps Excalidraw's own follow state (unfollow on pan/click) in sync. */
  const setFollowing = useCallback(
    (socketId: string | null) => {
      if (followingRef.current === socketId) return;
      followingRef.current = socketId;
      setState((s) => ({ ...s, following: socketId }));
      send({ t: 'follow', socketId });
      const api = apiRef.current;
      if (!api) return;
      const target = socketId ? presence.current.get(socketId) : null;
      const current = api.getAppState().userToFollow?.socketId ?? null;
      if (current !== (target ? socketId : null)) {
        api.updateScene({
          appState: { userToFollow: target ? { socketId: socketId as SocketId, username: target.name } : null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      // The AI has no viewport: jump to its cursor if we know where it is.
      const pointer = socketId ? xCollaborators.current.get(socketId as SocketId)?.pointer : undefined;
      if (target?.isAI && pointer) ensureVisible(pointer.x, pointer.y);
    },
    [ensureVisible, send],
  );

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      const api = apiRef.current;
      if (msg.t !== 'init' && !initialized.current && msg.t !== 'error') {
        queuedBeforeInit.current.push(msg);
        return;
      }
      switch (msg.t) {
        case 'init': {
          meRef.current = msg.me;
          roleRef.current = msg.board.role;
          syncedVersions.current.clear();
          for (const el of msg.elements) syncedVersions.current.set(el.id, el.version);
          if (api) {
            const local = api.getSceneElementsIncludingDeleted();
            const restored = restoreElements(toDisplay(msg.elements) as never, null, { refreshDimensions: false, repairBindings: true });
            // On reconnect, keep local edits made while offline (they win when newer).
            const reconciled = local.length ? reconcileElements(local, restored as never, api.getAppState()) : restored;
            api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
            // Saved text sizes can be narrower than this browser draws them; fit them so nothing shows cut off.
            setTimeout(() => apiRef.current && refitText(apiRef.current), 0);
            if (!initialized.current && msg.elements.some((e) => !e.isDeleted)) {
              setTimeout(() => api.scrollToContent(undefined, { fitToContent: true, animate: false }), 50);
            }
            // Push any offline edits up: every local element that wins over the server's copy under the shared
            // version-and-nonce rule (a same-version edit with the lower nonce wins too).
            const server = new Map(msg.elements.map((e) => [e.id, e]));
            const offline = (api.getSceneElementsIncludingDeleted() as unknown as SceneElement[]).filter((e) => {
              const s = server.get(e.id);
              return !s || shouldAcceptElement(s, e);
            });
            if (offline.length && msg.board.role !== 'viewer') {
              offline.forEach((e) => syncedVersions.current.set(e.id, e.version));
              send({ t: 'elements', elements: toStored(offline) });
            }
          }
          initialized.current = true;
          presence.current = new Map(msg.collaborators.map((c) => [c.socketId, c]));
          xCollaborators.current = new Map(
            msg.collaborators.filter((c) => c.socketId !== msg.me.socketId).map((c) => [c.socketId as SocketId, toXCollaborator(c)]),
          );
          pushCollaborators();
          setState((s) => ({
            ...s,
            connection: 'connected',
            me: msg.me,
            role: msg.board.role,
            title: msg.board.title,
            collaborators: msg.collaborators,
            error: null,
            timer: toLocalTimer(msg.timer),
          }));
          void fetchMissingFiles();
          if (followingRef.current) {
            if (presence.current.has(followingRef.current)) send({ t: 'follow', socketId: followingRef.current });
            else setFollowing(null);
          }
          const queued = queuedBeforeInit.current;
          queuedBeforeInit.current = [];
          queued.forEach((m) => handleMessage(m));
          return;
        }
        case 'elements':
          // My own AI run: remember what it changes so Ctrl+Z can take the whole run back (see ai-undo.ts).
          if (api && msg.source === 'ai' && msg.aiRun && msg.aiRun.userId === meRef.current?.userId) noteAiBatch(api, msg.aiRun.runId, msg.elements);
          applyRemoteElements(msg.elements, msg.source ?? 'user');
          // Following the AI: keep what it just drew in view.
          if (msg.source === 'ai' && followingRef.current && presence.current.get(followingRef.current)?.isAI) {
            const live = msg.elements.filter((e) => !e.isDeleted && typeof e.x === 'number' && typeof e.y === 'number');
            const last = live[live.length - 1];
            if (last) ensureVisible((last.x as number) + ((last.width as number) || 0) / 2, (last.y as number) + ((last.height as number) || 0) / 2);
          }
          return;
        case 'presence': {
          const next = new Map<SocketId, XCollaborator>();
          presence.current = new Map(msg.collaborators.map((c) => [c.socketId, c]));
          for (const c of msg.collaborators) {
            if (c.socketId === meRef.current?.socketId) continue;
            const prev = xCollaborators.current.get(c.socketId as SocketId);
            next.set(
              c.socketId as SocketId,
              toXCollaborator(c, { pointer: prev?.pointer, button: prev?.button, selectedElementIds: prev?.selectedElementIds }),
            );
          }
          xCollaborators.current = next;
          pushCollaborators();
          if (followingRef.current && !presence.current.has(followingRef.current)) setFollowing(null);
          setState((s) => {
            const here = new Set(msg.collaborators.map((c) => c.socketId));
            const chats = Object.fromEntries(Object.entries(s.cursorChats).filter(([id]) => here.has(id)));
            return { ...s, collaborators: msg.collaborators, cursorChats: chats };
          });
          return;
        }
        case 'pointer': {
          const prev = xCollaborators.current.get(msg.socketId as SocketId);
          const c = presence.current.get(msg.socketId);
          if (!c && !prev) return;
          xCollaborators.current.set(msg.socketId as SocketId, {
            ...(prev ?? toXCollaborator(c!)),
            pointer: { x: msg.x, y: msg.y, tool: msg.tool },
            button: msg.button,
          });
          pushCollaborators();
          if (followingRef.current === msg.socketId && c?.isAI) ensureVisible(msg.x, msg.y);
          return;
        }
        case 'selection': {
          const prev = xCollaborators.current.get(msg.socketId as SocketId);
          if (!prev) return;
          xCollaborators.current.set(msg.socketId as SocketId, {
            ...prev,
            selectedElementIds: Object.fromEntries(msg.ids.map((id) => [id, true])) as never,
          });
          pushCollaborators();
          return;
        }
        case 'viewport':
          if (followingRef.current === msg.socketId) applyFollowViewport(msg.viewport);
          return;
        case 'files':
          void fetchMissingFiles(msg.fileIds);
          return;
        case 'ai': {
          const status = (msg.status ?? (msg as { state?: AiRunStatus }).state) as AiRunStatus;
          if (api && (status === 'done' || status === 'error' || status === 'stopped')) finishAiRun(api, msg.runId);
          setState((s) => ({
            ...s,
            aiRun: {
              runId: msg.runId,
              // "stopped" may arrive as status or as state.
              status: (msg.status ?? (msg as { state?: AiRunStatus }).state) as AiRunStatus,
              message: msg.message,
              userId: msg.userId,
              region: (msg as { region?: AiRunState['region'] }).region ?? null,
            },
          }));
          return;
        }
        case 'chat':
          chatListeners.current.forEach((fn) => fn(msg.message));
          return;
        case 'board':
          if (msg.role) roleRef.current = msg.role;
          setState((s) => ({ ...s, title: msg.title ?? s.title, role: msg.role ?? s.role }));
          return;
        case 'error':
          // "This board was deleted." is followed by the access re-check's "access removed"; keep the clearer one.
          setState((s) => (s.error?.code === 'deleted' ? s : { ...s, error: { code: msg.code, message: msg.message } }));
          return;
        case 'timer':
          setState((s) => ({ ...s, timer: toLocalTimer(msg.timer) }));
          return;
        case 'cursorChat':
          setState((s) => {
            const next = { ...s.cursorChats };
            if (msg.text.trim()) next[msg.socketId] = { text: msg.text, at: Date.now() };
            else delete next[msg.socketId];
            return { ...s, cursorChats: next };
          });
          return;
        case 'followers': {
          const gained = msg.socketIds.some((id) => !followersRef.current.includes(id));
          followersRef.current = msg.socketIds;
          setState((s) => ({ ...s, followers: msg.socketIds }));
          // Someone just started following: send where I am right away instead of waiting for a scroll.
          if (gained) {
            const app = apiRef.current?.getAppState();
            if (app)
              send({ t: 'viewport', viewport: { scrollX: app.scrollX, scrollY: app.scrollY, zoom: app.zoom.value, width: app.width, height: app.height } });
          }
          return;
        }
        case 'pong':
          return;
      }
    },
    [applyFollowViewport, applyRemoteElements, ensureVisible, fetchMissingFiles, pushCollaborators, send, setFollowing],
  );

  // Excalidraw ends follow mode itself when you pan, zoom, or click the canvas (and when you follow from
  // its user list); mirror that into our state and tell the server.
  useEffect(() => {
    if (!excalidrawAPI) return;
    return excalidrawAPI.onUserFollow((p) => {
      const id = p.userToFollow.socketId as string;
      if (p.action === 'FOLLOW' && followingRef.current !== id) setFollowing(id);
      if (p.action === 'UNFOLLOW' && followingRef.current === id) setFollowing(null);
    });
  }, [excalidrawAPI, setFollowing]);

  // Text measured before a web font (or one of its character subsets) arrived is too narrow once it renders.
  useEffect(() => {
    if (!excalidrawAPI) return;
    return watchTextFit(() => apiRef.current);
  }, [excalidrawAPI]);

  // Connect (and reconnect with backoff) once the Excalidraw API is ready.
  useEffect(() => {
    if (!excalidrawAPI) return;
    let stopped = false;
    let attempt = 0;
    let retryTimer: NodeJS.Timeout | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let initTimer: NodeJS.Timeout | null = null;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}${WS_PATH}`);
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'hello', boardId, linkToken } satisfies ClientMessage));
        pingTimer = setInterval(() => send({ t: 'ping' }), 20_000);
        // If the server never answers hello, don't hang on "connecting": drop this socket and retry.
        initTimer = setTimeout(() => {
          initTimer = null;
          if (wsRef.current === ws) ws.close(4000, 'init timeout');
        }, INIT_TIMEOUT_MS);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as ServerMessage;
          if (msg.t === 'init') {
            attempt = 0;
            if (initTimer) clearTimeout(initTimer);
            initTimer = null;
          }
          handleMessage(msg);
        } catch (err) {
          console.error('bad realtime message', err);
        }
      };
      ws.onclose = (ev) => {
        if (pingTimer) clearInterval(pingTimer);
        if (initTimer) clearTimeout(initTimer);
        initTimer = null;
        wsRef.current = null;
        if (stopped) return;
        if (ev.code === 4401 || ev.code === 4403) {
          setState((s) => ({ ...s, connection: 'closed' }));
          return;
        }
        setState((s) => ({ ...s, connection: 'reconnecting' }));
        attempt += 1;
        retryTimer = setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (initTimer) clearTimeout(initTimer);
      wsRef.current?.close();
      wsRef.current = null;
      initialized.current = false;
      resetAiUndo();
    };
  }, [boardId, linkToken, excalidrawAPI, handleMessage, send, connectNonce]);

  const flushElements = useCallback(() => {
    pendingSend.current = null;
    const api = apiRef.current;
    if (!api || !initialized.current || roleRef.current === 'viewer') return;
    const changed: SceneElement[] = [];
    for (const el of api.getSceneElementsIncludingDeleted()) {
      const v = syncedVersions.current.get(el.id);
      if (v === undefined || el.version > v) {
        changed.push(el as unknown as SceneElement);
        syncedVersions.current.set(el.id, el.version);
      }
    }
    if (changed.length) send({ t: 'elements', elements: toStored(changed) });
  }, [send]);

  const lastSelection = useRef('');
  const onChange = useCallback(
    (_elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      if (!initialized.current) return;
      if (!pendingSend.current) pendingSend.current = setTimeout(flushElements, COLLAB_THROTTLE_MS);
      // Selection (so others see what you're working on).
      const sel = Object.keys(appState.selectedElementIds).sort().join(',');
      if (sel !== lastSelection.current) {
        lastSelection.current = sel;
        send({ t: 'selection', ids: sel ? sel.split(',') : [] });
      }
      // Upload new image files.
      if (roleRef.current !== 'viewer') {
        for (const f of Object.values(files)) {
          if (uploadedFiles.current.has(f.id)) continue;
          uploadedFiles.current.add(f.id);
          void api(`/boards/${boardId}/files`, {
            method: 'POST',
            json: { fileId: f.id, mimeType: f.mimeType, dataURL: f.dataURL },
            linkToken,
          }).catch(() => uploadedFiles.current.delete(f.id));
        }
      }
      // Viewport for followers (throttled, with a trailing send so followers land where you stopped).
      const now = Date.now();
      const sendVp = () => {
        trailingViewport.current = null;
        lastViewportSent.current = Date.now();
        const app = apiRef.current?.getAppState() ?? appState;
        send({
          t: 'viewport',
          viewport: { scrollX: app.scrollX, scrollY: app.scrollY, zoom: app.zoom.value, width: app.width, height: app.height },
        });
      };
      if (now - lastViewportSent.current > 120) sendVp();
      else if (!trailingViewport.current) trailingViewport.current = setTimeout(sendVp, 140);
    },
    [boardId, flushElements, linkToken, send],
  );

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' }; button: 'down' | 'up' }) => {
      const now = Date.now();
      if (now - lastPointerSent.current < 40) return;
      lastPointerSent.current = now;
      send({ t: 'pointer', x: payload.pointer.x, y: payload.pointer.y, tool: payload.pointer.tool, button: payload.button });
    },
    [send],
  );

  const sendViewport = useCallback(() => {
    const app = apiRef.current?.getAppState();
    if (!app) return;
    send({ t: 'viewport', viewport: { scrollX: app.scrollX, scrollY: app.scrollY, zoom: app.zoom.value, width: app.width, height: app.height } });
  }, [send]);

  const follow = useCallback((socketId: string | null) => setFollowing(socketId), [setFollowing]);

  const onChat = useCallback((fn: Listener<ChatMessage>) => {
    chatListeners.current.add(fn);
    return () => chatListeners.current.delete(fn);
  }, []);

  const onRemoteElements = useCallback((fn: Listener<{ elements: SceneElement[]; source: 'user' | 'ai' }>) => {
    remoteListeners.current.add(fn);
    return () => remoteListeners.current.delete(fn);
  }, []);

  const sendTimer = useCallback(
    (action: 'start' | 'pause' | 'reset' | 'add', durationMs?: number) => send({ t: 'timer', action, ...(durationMs ? { durationMs } : {}) }),
    [send],
  );

  const sendCursorChat = useCallback((text: string) => send({ t: 'cursorChat', text }), [send]);
  const pointerOf = useCallback((socketId: string) => {
    const p = xCollaborators.current.get(socketId as SocketId)?.pointer;
    return p ? { x: p.x, y: p.y } : null;
  }, []);

  const reconnect = useCallback(() => setConnectNonce((n) => n + 1), []);

  return { ...state, onChange, onPointerUpdate, follow, onChat, onRemoteElements, sendViewport, sendTimer, sendCursorChat, pointerOf, reconnect };
}

async function api_get_files(boardId: string, ids: string[], linkToken: string | null) {
  const data = await api<{ files: { id: string; mimeType: string; dataURL: string; created: number }[] }>(
    `/boards/${boardId}/files?ids=${encodeURIComponent(ids.join(','))}`,
    { linkToken },
  );
  return data.files;
}
