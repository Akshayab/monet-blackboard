// In-memory board rooms: the authoritative element map for each open board, the sockets on it, and
// debounced persistence to Postgres. Other modules (the board AI, templates) change a board through
// applyServerChanges() so every connected client sees the change live.
import { boardsTable, db } from "@monet/db";
import { eq } from "drizzle-orm";
import {
  DARK_THEME_VERSION,
  darkenElements,
  shouldAcceptElement,
  slimTombstone,
  type Collaborator,
  type SceneElement,
  type ServerMessage,
} from "@monet/board-protocol";
import type { WebSocket } from "ws";
import { thumbnailDataUrl } from "../templates/thumbnail";
import { logger } from "../lib/logger";
import { pgSafe } from "../lib/pg-safe";
import { placeholderForStored, WS_LIMITS } from "./guard";

export interface RoomSocket {
  ws: WebSocket;
  collaborator: Collaborator;
}

export interface Room {
  boardId: string;
  elements: Map<string, SceneElement>;
  sockets: Map<string, RoomSocket>;
  /** Virtual collaborators (the board AI) shown in presence. */
  virtual: Map<string, Collaborator>;
  dirty: boolean;
  saveTimer: NodeJS.Timeout | null;
  /** The latest save in the room's queue (saves run one at a time). */
  saving: Promise<void>;
  loaded: Promise<void>;
  sceneVersion: number;
  /** Shared countdown (in memory only; a server restart clears it). endsAt is set while running. */
  timer: { durationMs: number; remainingMs: number; endsAt: number | null; by?: string } | null;
}

const rooms = new Map<string, Room>();
const SAVE_DEBOUNCE_MS = 1500;
const SAVE_RETRY_MS = 10_000;
/** Set at shutdown: rooms take no more changes (clients resend them after reconnecting to the next server). */
let closing = false;

/**
 * Boards created before the dark redesign used the light palette (black text, pastel fills), which is unreadable
 * on the dark canvas. The first time such a board is opened, recolor it once with darkenElements, bump the changed
 * elements' versions so every client takes them, and record appState.monetTheme so it never runs again.
 */
async function upgradeToDarkTheme(boardId: string, room: Room, elements: SceneElement[], appState: Record<string, unknown>) {
  if (appState.monetTheme === DARK_THEME_VERSION) return;
  try {
    const changed = darkenElements(elements);
    const now = Date.now();
    for (const el of elements) {
      if (!changed.has(el.id)) continue;
      el.version = ((el.version as number) ?? 1) + 1;
      el.versionNonce = Math.floor(Math.random() * 2 ** 31);
      el.updated = now;
    }
    if (changed.size) room.sceneVersion += 1;
    await db
      .update(boardsTable)
      .set({
        // The library preview is re-rendered too, so it matches the recolored board right away.
        ...(changed.size
          ? { elements: elements as unknown as object, sceneVersion: room.sceneVersion, thumbnail: thumbnailDataUrl(elements.filter((e) => !e.isDeleted)) }
          : {}),
        appState: { ...appState, monetTheme: DARK_THEME_VERSION },
      })
      .where(eq(boardsTable.id, boardId));
    if (changed.size) logger.info({ boardId, changed: changed.size }, "board recolored for the dark theme");
  } catch (err) {
    logger.warn({ err, boardId }, "dark theme upgrade failed; board left as is");
  }
}

function loadRoom(boardId: string): Room {
  const room: Room = {
    boardId,
    elements: new Map(),
    sockets: new Map(),
    virtual: new Map(),
    dirty: false,
    saveTimer: null,
    saving: Promise.resolve(),
    loaded: Promise.resolve(),
    sceneVersion: 0,
    timer: null,
  };
  room.loaded = (async () => {
    const [b] = await db
      .select({ elements: boardsTable.elements, sceneVersion: boardsTable.sceneVersion, appState: boardsTable.appState })
      .from(boardsTable)
      .where(eq(boardsTable.id, boardId));
    const loaded = ((b?.elements as SceneElement[] | undefined) ?? []).map((el) => placeholderForStored(el) ?? el);
    for (const el of loaded) room.elements.set(el.id, el);
    room.sceneVersion = b?.sceneVersion ?? 0;
    if (loaded.some((el, i) => el !== (b!.elements as SceneElement[])[i])) scheduleSave(room);
    if (b) await upgradeToDarkTheme(boardId, room, loaded, (b.appState as Record<string, unknown> | null) ?? {});
  })();
  // A failed load (database blip) must not stay cached, or the board can't be opened again until a restart.
  room.loaded.catch(() => {
    if (rooms.get(boardId) === room) rooms.delete(boardId);
  });
  rooms.set(boardId, room);
  return room;
}

/** The room for a board if someone has it open (never loads one). */
export function peekRoom(boardId: string): Room | undefined {
  return rooms.get(boardId);
}

export async function getRoom(boardId: string): Promise<Room> {
  const room = rooms.get(boardId) ?? loadRoom(boardId);
  await room.loaded;
  return room;
}

/** Live elements in z-order (fractional index), including tombstones so deletes propagate. */
export function roomElements(room: Room): SceneElement[] {
  return [...room.elements.values()].sort((a, b) => {
    const ia = a.index ?? "";
    const ib = b.index ?? "";
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

export function collaboratorsOf(room: Room): Collaborator[] {
  return [...[...room.sockets.values()].map((s) => s.collaborator), ...room.virtual.values()];
}

// A reader that can't keep up is dropped rather than buffered without limit; it reconnects to a fresh snapshot.
function sendData(ws: WebSocket, data: string) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount + data.length > WS_LIMITS.maxBufferedBytes) {
    ws.terminate();
    return;
  }
  ws.send(data);
}

export function send(ws: WebSocket, msg: ServerMessage) {
  sendData(ws, JSON.stringify(msg));
}

export function broadcast(room: Room, msg: ServerMessage, exceptSocketId?: string) {
  const data = JSON.stringify(msg);
  for (const [id, s] of room.sockets) {
    if (id !== exceptSocketId) sendData(s.ws, data);
  }
}

export function broadcastPresence(room: Room) {
  broadcast(room, { t: "presence", collaborators: collaboratorsOf(room) });
}

function scheduleSave(room: Room) {
  room.dirty = true;
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    void saveRoom(room);
  }, SAVE_DEBOUNCE_MS);
}

/** Saves the room if it has unsaved changes, after any save already running. Never rejects. */
export function saveRoom(room: Room): Promise<void> {
  room.saving = room.saving.then(() => writeRoom(room));
  return room.saving;
}

async function writeRoom(room: Room) {
  if (!room.dirty) return;
  room.dirty = false;
  try {
    // Drop tombstones older than a day so the scene does not grow forever.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    // pgSafe: one NUL or half-emoji in any element (pasted text, AI text cut mid-emoji) would fail the whole save.
    const elements = pgSafe(roomElements(room).filter((e) => !(e.isDeleted && (e.updated ?? 0) < cutoff)));
    await db
      .update(boardsTable)
      .set({ elements, sceneVersion: room.sceneVersion + 1, updatedAt: new Date() })
      .where(eq(boardsTable.id, room.boardId));
    room.sceneVersion += 1;
  } catch (err) {
    room.dirty = true;
    logger.error({ err, boardId: room.boardId }, "failed to save board; retrying");
    if (!room.saveTimer && !closing && rooms.get(room.boardId) === room) {
      room.saveTimer = setTimeout(() => {
        room.saveTimer = null;
        void saveRoom(room);
      }, SAVE_RETRY_MS);
    }
  }
}

/** Merges elements into the room using Excalidraw's version rule. Returns the accepted elements. */
export function mergeElements(room: Room, incoming: SceneElement[]): SceneElement[] {
  const accepted: SceneElement[] = [];
  if (closing) return accepted;
  for (const el of incoming) {
    if (!el || typeof el.id !== "string" || typeof el.version !== "number") continue;
    if (shouldAcceptElement(room.elements.get(el.id), el)) {
      const kept = slimTombstone(el);
      room.elements.set(el.id, kept);
      accepted.push(kept);
    }
  }
  if (accepted.length) scheduleSave(room);
  return accepted;
}

const BINDING_CONTEXT_LIMIT = 3000;

function bindingRefsOf(el: SceneElement): string[] {
  const out: string[] = [];
  if (typeof el.frameId === "string" && el.frameId) out.push(el.frameId);
  if (el.type === "text" && typeof el.containerId === "string" && el.containerId) out.push(el.containerId);
  if (Array.isArray(el.boundElements)) {
    for (const b of el.boundElements as { id?: unknown }[]) if (b && typeof b.id === "string") out.push(b.id);
  }
  for (const key of ["startBinding", "endBinding"] as const) {
    const b = el[key] as { elementId?: unknown } | null | undefined;
    if (b && typeof b.elementId === "string") out.push(b.elementId);
  }
  return out;
}

/**
 * The changed elements plus everything they (transitively) reference: frames, label containers and labels,
 * arrow endpoints. Clients restore server batches with repairBindings, which only looks inside the batch, so
 * without this context a label would unbind, a child would drop out of its section, or an arrow would detach.
 */
export function withBindingContext(room: Room, changed: SceneElement[]): SceneElement[] {
  const batch = new Map<string, SceneElement>(changed.map((e) => [e.id, e]));
  const queue = [...changed];
  while (queue.length && batch.size < BINDING_CONTEXT_LIMIT) {
    const el = queue.pop()!;
    for (const id of bindingRefsOf(el)) {
      if (batch.has(id)) continue;
      const ref = room.elements.get(id);
      if (!ref) continue;
      batch.set(id, ref);
      queue.push(ref);
    }
  }
  // Sorted by z-index so clients keep the server's fractional indices.
  return [...batch.values()]
    .map((e) => room.elements.get(e.id) ?? e)
    .sort((a, b) => {
      const ia = a.index ?? "";
      const ib = b.index ?? "";
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
}

/**
 * Applies server-originated changes (AI, templates, imports) and broadcasts them to everyone on the board,
 * together with the unchanged elements they reference (see withBindingContext).
 * Elements must already carry bumped versions (use bumpElement/makeX from board-protocol).
 */
export async function applyServerChanges(
  boardId: string,
  elements: SceneElement[],
  source: "ai" | "user" = "ai",
  aiRun?: { runId: string; userId: string },
): Promise<SceneElement[]> {
  const room = await getRoom(boardId);
  const accepted = mergeElements(room, elements);
  if (accepted.length) {
    broadcast(room, { t: "elements", elements: withBindingContext(room, accepted), from: "server", source, ...(aiRun ? { aiRun } : {}) });
  }
  return accepted;
}

/** Sends any message to everyone on a board (no-op when nobody has it open). */
export function broadcastToBoard(boardId: string, msg: ServerMessage) {
  const room = rooms.get(boardId);
  if (room) broadcast(room, msg);
}

/** Adds or removes a virtual collaborator (e.g. the board AI's presence). */
export async function setVirtualCollaborator(boardId: string, c: Collaborator | null, socketId: string) {
  const room = await getRoom(boardId);
  if (c) room.virtual.set(socketId, c);
  else room.virtual.delete(socketId);
  broadcastPresence(room);
}

/** Current element snapshot for a board (loads it if no one has it open). */
export async function getBoardElements(boardId: string): Promise<SceneElement[]> {
  const room = await getRoom(boardId);
  return roomElements(room);
}

export function releaseRoomIfEmpty(room: Room) {
  if (room.sockets.size > 0 || room.virtual.size > 0) return;
  void saveRoom(room).finally(() => {
    if (room.sockets.size === 0 && room.virtual.size === 0 && !room.dirty) rooms.delete(room.boardId);
  });
}

/** Forget a cached room (e.g. after the board is deleted or its scene replaced over HTTP). */
export function evictRoom(boardId: string) {
  const room = rooms.get(boardId);
  if (room?.saveTimer) clearTimeout(room.saveTimer);
  rooms.delete(boardId);
}

/** At shutdown: stop taking changes, then wait for running saves and save whatever is still unsaved. */
export async function flushAllRooms() {
  closing = true;
  for (const r of rooms.values()) {
    if (r.saveTimer) clearTimeout(r.saveTimer);
    r.saveTimer = null;
  }
  await Promise.all([...rooms.values()].map((r) => saveRoom(r)));
}
