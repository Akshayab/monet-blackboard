import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import crypto from "crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  BOARD_LIMIT_MESSAGE,
  CURSOR_CHAT_MAX,
  PRESENCE_COLORS,
  TIMER_LIMITS,
  WS_PATH,
  fitBoardLimits,
  type BoardTimer,
  type ClientMessage,
  type Collaborator,
} from "@monet/board-protocol";
import { displayNameOf, getOwner, sessionIdFromCookieHeader, userForSession, type AuthUser } from "../lib/auth";
import { config } from "../lib/config";
import { atLeast, getBoardAccess, touchMembership } from "../lib/access";
import { stopRevokedRuns } from "../ai/runs";
import { clientIp } from "../lib/client-ip";
import { logger } from "../lib/logger";
import { isAllowedOrigin, isLoopbackHost } from "../middlewares/security";
import { broadcast, broadcastPresence, collaboratorsOf, getRoom, mergeElements, peekRoom, releaseRoomIfEmpty, roomElements, send, type Room } from "./rooms";
import {
  capNewElements,
  cleanIds,
  cleanViewport,
  connections,
  isOwnCommentPin,
  plausibleVersion,
  sanitizeElements,
  SocketBudget,
  validPointer,
  WS_CLOSE,
  WS_LIMITS,
} from "./guard";

/** The room's timer as clients see it (remaining time relative to now, so clock skew doesn't matter). */
function timerView(room: Room): BoardTimer | null {
  const t = room.timer;
  if (!t) return null;
  const remainingMs = t.endsAt ? Math.max(0, t.endsAt - Date.now()) : t.remainingMs;
  return { durationMs: t.durationMs, remainingMs, running: !!t.endsAt && remainingMs > 0, by: t.by };
}

function applyTimer(room: Room, msg: Extract<ClientMessage, { t: "timer" }>, by: string): boolean {
  const now = Date.now();
  const cur = timerView(room);
  const clamp = (ms: number) => Math.min(TIMER_LIMITS.maxMs, Math.max(TIMER_LIMITS.minMs, Math.round(ms)));
  switch (msg.action) {
    case "start": {
      if (typeof msg.durationMs === "number" && Number.isFinite(msg.durationMs)) {
        const d = clamp(msg.durationMs);
        room.timer = { durationMs: d, remainingMs: d, endsAt: now + d, by };
        return true;
      }
      if (!cur || cur.running || cur.remainingMs <= 0) return false;
      room.timer = { durationMs: cur.durationMs, remainingMs: cur.remainingMs, endsAt: now + cur.remainingMs, by };
      return true;
    }
    case "pause":
      if (!cur || !cur.running) return false;
      room.timer = { durationMs: cur.durationMs, remainingMs: cur.remainingMs, endsAt: null, by };
      return true;
    case "add": {
      if (!cur) return false;
      const remaining = Math.min(TIMER_LIMITS.maxMs, cur.remainingMs + 60_000);
      const durationMs = Math.min(TIMER_LIMITS.maxMs, Math.max(cur.durationMs, remaining));
      room.timer = { durationMs, remainingMs: remaining, endsAt: cur.running ? now + remaining : null, by };
      return true;
    }
    case "reset":
      if (!room.timer) return false;
      room.timer = null;
      return true;
    default:
      return false;
  }
}

function colorFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

/** Solo mode: the owner (sid is empty). Team mode: the person behind the session cookie. */
async function authenticate(req: IncomingMessage): Promise<{ user: AuthUser; sid: string } | null> {
  if (!config.teamMode) return isLoopbackHost(req.headers.host) ? { user: await getOwner(), sid: "" } : null;
  const sid = sessionIdFromCookieHeader(req.headers.cookie);
  if (!sid) return null;
  const user = await userForSession(sid);
  return user ? { user, sid } : null;
}

/** One live socket that has joined a board. */
interface Session {
  ws: WebSocket;
  socketId: string;
  user: AuthUser;
  /** The sign-in session the socket opened with; signing out (or expiry) ends the socket at the next re-check. */
  sid: string;
  linkToken: string | null;
  room: Room;
  me: Collaborator;
  lastSeen: number;
  /** Socket id whose viewport this socket follows (follow mode), if any. */
  following: string | null;
}

const sessions = new Map<string, Session>();

/** Tells `targetSocketId` which sockets on its board currently follow its viewport. */
function notifyFollowers(room: Room, targetSocketId: string) {
  const target = room.sockets.get(targetSocketId);
  if (!target) return;
  const socketIds = [...room.sockets.keys()].filter((id) => sessions.get(id)?.following === targetSocketId);
  send(target.ws, { t: "followers", socketIds });
}
/** Sockets that haven't joined a board yet (or ever): socketId -> last message time. */
const pending = new Map<string, { ws: WebSocket; lastSeen: number }>();

function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachRealtime(server: HttpServer) {
  // Signed-in sockets may send large element batches (images). Sockets without a session can only say hello and be
  // refused, so they get a small frame limit: an oversized frame closes them instead of being read into memory.
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_LIMITS.maxMessageBytes });
  const anonWss = new WebSocketServer({ noServer: true, maxPayload: WS_LIMITS.maxAnonMessageBytes });

  server.on("upgrade", (req, socket, head) => {
    // A reset or malformed handshake on the raw socket must never reach the process as an unhandled error.
    socket.on("error", () => socket.destroy());
    const path = (req.url ?? "").split("?")[0];
    if (path !== WS_PATH) return rejectUpgrade(socket, 404, "Not Found");
    // Solo mode answers only on localhost (this also stops DNS rebinding).
    if (!config.teamMode && !isLoopbackHost(req.headers.host)) return rejectUpgrade(socket, 403, "Forbidden");
    // Cross-site WebSocket hijacking: browsers always send Origin on WebSocket handshakes.
    if (!isAllowedOrigin(req.headers.origin, req)) return rejectUpgrade(socket, 403, "Forbidden");
    const ip = clientIp(req);
    if (!connections.tryAddIp(ip)) return rejectUpgrade(socket, 429, "Too Many Requests");
    let upgraded = false;
    // A handshake that never completes (bad headers, the client hangs up) still frees its slot.
    socket.once("close", () => !upgraded && connections.removeIp(ip));
    authenticate(req)
      .catch(() => null)
      .then((auth) => {
        if (socket.destroyed) return;
        (auth ? wss : anonWss).handleUpgrade(req, socket, head, (ws) => {
          upgraded = true;
          ws.once("close", () => connections.removeIp(ip));
          onConnection(ws, auth);
        });
      });
  });

  // Keep connections alive through proxies, drop dead ones, and close idle sockets.
  const heartbeat = setInterval(() => {
    for (const ws of [...wss.clients, ...anonWss.clients]) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        ws.terminate();
        continue;
      }
      w.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const s of [...sessions.values(), ...pending.values()]) {
      if (now - s.lastSeen > WS_LIMITS.idleTimeoutMs) s.ws.close(WS_CLOSE.timeout, "idle");
    }
  }, 25_000);

  // Re-check every joined socket's access so revoked links, removed members and deleted boards take effect.
  const revalidate = setInterval(() => {
    void revalidateSessions([...sessions.values()]);
  }, WS_LIMITS.revalidateMs);

  heartbeat.unref();
  revalidate.unref();
  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(revalidate);
    anonWss.close();
  });
  return wss;
}

async function revalidateSessions(list: Session[]) {
  const byKey = new Map<string, Promise<Awaited<ReturnType<typeof getBoardAccess>>>>();
  const bySid = new Map<string, Promise<boolean | undefined>>();
  const touched = new Set<Room>();
  await Promise.all(
    list.map(async (s) => {
      if (s.ws.readyState !== 1) return;
      if (!s.sid) return checkAccess(s, byKey, touched);
      if (!bySid.has(s.sid))
        bySid.set(
          s.sid,
          userForSession(s.sid).then(
            (x) => !!x,
            () => undefined,
          ),
        );
      if ((await bySid.get(s.sid)) === false) {
        send(s.ws, { t: "error", code: "unauthenticated", message: "You left this board. Open its link again to rejoin." });
        s.ws.close(WS_CLOSE.unauthenticated, "signed out");
        return;
      }
      return checkAccess(s, byKey, touched);
    }),
  );
  for (const room of touched) broadcastPresence(room);
}

async function checkAccess(s: Session, byKey: Map<string, Promise<Awaited<ReturnType<typeof getBoardAccess>>>>, touched: Set<Room>) {
  const key = `${s.room.boardId}|${s.user.id}|${s.linkToken ?? ""}`;
  if (!byKey.has(key))
    byKey.set(
      key,
      getBoardAccess(s.room.boardId, s.user.id, s.linkToken).catch(() => undefined as never),
    );
  const access = await byKey.get(key);
  if (access === undefined) return; // lookup failed; try again next round
  if (!access) {
    send(s.ws, { t: "error", code: "forbidden", message: "Your access to this board was removed." });
    s.ws.close(WS_CLOSE.forbidden, "forbidden");
    return;
  }
  if (access.role !== s.me.role) {
    s.me.role = access.role;
    send(s.ws, { t: "board", role: access.role });
    touched.add(s.room);
  }
}

/**
 * Immediately re-checks access for live sockets on a board (all of them, or one user's) after a sharing
 * change: role changes, removals, invites, link setting changes, deletion. Each socket is checked with the
 * link token it joined with, so people who still hold an active link keep the link's access. Sockets that
 * lost access are told why and disconnected; the rest get their new role live.
 */
export async function refreshBoardAccess(boardId: string, userId?: string) {
  await Promise.all([
    revalidateSessions([...sessions.values()].filter((s) => s.room.boardId === boardId && (!userId || s.user.id === userId))),
    stopRevokedRuns(boardId, userId),
  ]);
}

/** Closes every board socket opened with this sign-in session (call after signing out). */
export function endSessionSockets(sid: string) {
  for (const s of sessions.values()) {
    if (s.sid !== sid || s.ws.readyState !== 1) continue;
    send(s.ws, { t: "error", code: "unauthenticated", message: "You left this board. Open its link again to rejoin." });
    s.ws.close(WS_CLOSE.unauthenticated, "signed out");
  }
}

/** Immediately re-checks access for everyone on a board (call after sharing changes or deletion). */
export async function revalidateBoardAccess(boardId: string) {
  await refreshBoardAccess(boardId);
}

function onConnection(ws: WebSocket, auth: { user: AuthUser; sid: string } | null) {
  const w = ws as WebSocket & { isAlive?: boolean };
  w.isAlive = true;
  ws.on("pong", () => (w.isAlive = true));
  // Oversized, malformed or invalid-UTF-8 frames make ws emit "error"; without a listener that would end the process.
  ws.on("error", () => ws.terminate());

  const socketId = crypto.randomBytes(8).toString("hex");
  const budget = new SocketBudget();
  let session: Session | null = null;
  let helloState: "waiting" | "joining" | "joined" = "waiting";
  let countedUser: string | null = null;
  pending.set(socketId, { ws, lastSeen: Date.now() });

  const helloTimer = setTimeout(() => {
    if (helloState !== "joined") ws.close(WS_CLOSE.timeout, "hello timeout");
  }, WS_LIMITS.helloTimeoutMs);
  helloTimer.unref();

  const dropped = (why: string) => {
    if (budget.drop()) {
      logger.warn({ socketId, why }, "closing noisy websocket");
      ws.close(WS_CLOSE.rateLimited, "rate limited");
    }
  };

  // Cheap checks run as each message arrives; handling then runs one message at a time, in arrival order,
  // so nothing overtakes a hello that is still waiting on auth or the room load.
  let queue: Promise<void> = Promise.resolve();
  ws.on("message", (raw: RawData, isBinary: boolean) => {
    const now = Date.now();
    if (session) session.lastSeen = now;
    const p = pending.get(socketId);
    if (p) p.lastSeen = now;
    if (isBinary) return dropped("binary");
    if (!budget.takeMessage()) return dropped("rate");
    queue = queue.then(() => handleMessage(raw)).catch((err) => logger.error({ err }, "realtime message failed"));
  });

  const handleMessage = async (raw: RawData) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return dropped("bad json");
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") return dropped("bad message");
    try {
      if (msg.t === "ping") return send(ws, { t: "pong" });

      if (msg.t === "hello") {
        if (helloState !== "waiting") return; // one board per socket
        helloState = "joining";
        const user = auth?.user ?? null;
        if (ws.readyState !== 1) return;
        if (!auth || !user) {
          send(ws, { t: "error", code: "unauthenticated", message: "Open the board's link to join it." });
          ws.close(WS_CLOSE.unauthenticated, "unauthenticated");
          return;
        }
        if (!connections.tryAddUser(user.id)) {
          send(ws, { t: "error", code: "rate_limited", message: "You have too many boards open. Close a few tabs and try again." });
          ws.close(WS_CLOSE.rateLimited, "too many sockets");
          return;
        }
        countedUser = user.id;
        const boardId = typeof msg.boardId === "string" && msg.boardId.length <= 64 ? msg.boardId : null;
        const linkToken = typeof msg.linkToken === "string" && msg.linkToken.length <= 128 ? msg.linkToken : null;
        const access = boardId ? await getBoardAccess(boardId, user.id, linkToken) : null;
        if (!access) {
          send(ws, { t: "error", code: "forbidden", message: "You don't have access to this board." });
          ws.close(WS_CLOSE.forbidden, "forbidden");
          return;
        }
        if (ws.readyState !== 1) return;
        // Recorded atomically against the current link. If the link was reset meanwhile, the old token records
        // nothing: check again without it (a membership of their own still counts).
        const recorded = await touchMembership(access.board.id, user.id, access.role, linkToken);
        if (!recorded && linkToken && !(await getBoardAccess(access.board.id, user.id, null))) {
          send(ws, { t: "error", code: "forbidden", message: "You don't have access to this board." });
          ws.close(WS_CLOSE.forbidden, "forbidden");
          return;
        }
        const room = await getRoom(access.board.id);
        // The socket may have closed while we were loading; don't leave a ghost room behind.
        if (ws.readyState !== 1) {
          releaseRoomIfEmpty(room);
          return;
        }
        const me: Collaborator = {
          socketId,
          userId: user.id,
          name: displayNameOf(user),
          color: colorFor(user.id),
          role: access.role,
        };
        if (ws.readyState !== 1) return;
        session = { ws, socketId, user, sid: auth.sid, linkToken, room, me, lastSeen: Date.now(), following: null };
        sessions.set(socketId, session);
        pending.delete(socketId);
        helloState = "joined";
        clearTimeout(helloTimer);
        room.sockets.set(socketId, { ws, collaborator: me });
        send(ws, {
          t: "init",
          me,
          board: { id: access.board.id, title: access.board.title, role: access.role, ownerId: access.board.ownerId },
          elements: roomElements(room),
          collaborators: collaboratorsOf(room),
          timer: timerView(room),
        });
        broadcastPresence(room);
        return;
      }

      if (!session) return;
      const { room, me } = session;

      switch (msg.t) {
        case "elements": {
          if (!atLeast(me.role, "commenter")) {
            send(ws, { t: "error", code: "read_only", message: "You can view this board but not edit it." });
            return;
          }
          if (!Array.isArray(msg.elements)) return dropped("elements not array");
          if (me.role === "commenter") {
            // Commenters may only add, edit and delete their own comment pins (small ellipses with comment data) and
            // the pins' one-letter labels. Anything else, including changes to other people's elements, is refused.
            const batch = new Map(msg.elements.map((el) => [(el as { id?: string }).id, el]));
            const containerOf = (id: string) => batch.get(id) ?? room.elements.get(id);
            const allowed = msg.elements.filter((el) => {
              const id = (el as { id?: unknown }).id;
              const existing = typeof id === "string" ? room.elements.get(id) : undefined;
              if (existing && !isOwnCommentPin(existing, me.userId, (cid) => room.elements.get(cid))) return false;
              return isOwnCommentPin(el, me.userId, containerOf);
            });
            if (allowed.length < msg.elements.length) {
              send(ws, { t: "error", code: "read_only", message: "You can comment on this board but not edit it." });
            }
            msg.elements = allowed as typeof msg.elements;
            if (!allowed.length) return;
          }
          if (!budget.takeElements()) {
            // Closing (instead of silently dropping) makes the client reconnect and resend unsynced changes.
            send(ws, { t: "error", code: "rate_limited", message: "Too many changes too quickly. Reconnecting…" });
            ws.close(WS_CLOSE.rateLimited, "elements rate limited");
            return;
          }
          if (msg.elements.length > WS_LIMITS.maxElementsPerMessage) {
            send(ws, {
              t: "error",
              code: "too_many_elements",
              message: `That change has too many elements (max ${WS_LIMITS.maxElementsPerMessage} at once).`,
            });
            return;
          }
          const { elements: sanitized, rejected } = sanitizeElements(msg.elements);
          const valid = sanitized.filter((el) => plausibleVersion(room.elements.get(el.id), el));
          const { elements: capped, refused } = capNewElements(room.elements, valid);
          // Per-board limits (800 live elements / 2 MB): edits and deletes pass, new elements past the limit don't.
          const { accepted: elements, refused: overLimit } = fitBoardLimits(room.elements, capped);
          if (refused || overLimit.length) {
            send(ws, { t: "error", code: "board_full", message: BOARD_LIMIT_MESSAGE });
          }
          if (rejected) logger.debug({ socketId, rejected }, "dropped invalid elements");
          const accepted = mergeElements(room, elements);
          if (accepted.length) broadcast(room, { t: "elements", elements: accepted, from: socketId, source: "user" }, socketId);
          return;
        }
        case "pointer":
          if (!validPointer(msg)) return dropped("bad pointer");
          broadcast(room, { t: "pointer", socketId, x: msg.x, y: msg.y, tool: msg.tool, button: msg.button }, socketId);
          return;
        case "viewport": {
          const viewport = cleanViewport(msg.viewport);
          if (!viewport) return dropped("bad viewport");
          broadcast(room, { t: "viewport", socketId, viewport }, socketId);
          return;
        }
        case "selection":
          broadcast(room, { t: "selection", socketId, ids: cleanIds(msg.ids, 500) }, socketId);
          return;
        case "files":
          if (!atLeast(me.role, "editor")) return;
          broadcast(room, { t: "files", fileIds: cleanIds(msg.fileIds, 100) }, socketId);
          return;
        case "follow": {
          const prev = session.following;
          const next = typeof msg.socketId === "string" && msg.socketId.length <= 64 && msg.socketId !== socketId ? msg.socketId : null;
          session.following = next;
          if (prev && prev !== next) notifyFollowers(room, prev);
          if (next) notifyFollowers(room, next);
          return;
        }
        case "cursorChat": {
          if (typeof msg.text !== "string") return dropped("bad cursor chat");
          const text = msg.text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, CURSOR_CHAT_MAX);
          broadcast(room, { t: "cursorChat", socketId, text }, socketId);
          return;
        }
        case "timer": {
          if (!atLeast(me.role, "editor")) {
            send(ws, { t: "error", code: "read_only", message: "You can view this board but not edit it." });
            return;
          }
          if (!["start", "pause", "reset", "add"].includes(msg.action)) return dropped("bad timer action");
          if (applyTimer(room, msg, me.name)) broadcast(room, { t: "timer", timer: timerView(room) });
          return;
        }
        default:
          return dropped("unknown type");
      }
    } catch (err) {
      logger.error({ err }, "realtime message failed");
    }
  };

  ws.on("close", () => {
    clearTimeout(helloTimer);
    pending.delete(socketId);
    sessions.delete(socketId);
    if (countedUser) connections.removeUser(countedUser);
    if (session) {
      session.room.sockets.delete(socketId);
      if (session.following) notifyFollowers(session.room, session.following);
      broadcastPresence(session.room);
      releaseRoomIfEmpty(session.room);
    }
  });
}

/** Updates the role of a user's live sockets on a board (after a sharing change). */
export async function refreshRoleForUser(boardId: string, userId: string, role: Collaborator["role"] | null) {
  const room = peekRoom(boardId);
  if (!room) return;
  for (const s of room.sockets.values()) {
    if (s.collaborator.userId !== userId) continue;
    if (!role) {
      send(s.ws, { t: "error", code: "forbidden", message: "Your access to this board was removed." });
      s.ws.close(WS_CLOSE.forbidden, "forbidden");
    } else {
      s.collaborator.role = role;
      send(s.ws, { t: "board", role });
    }
  }
  broadcastPresence(room);
}
