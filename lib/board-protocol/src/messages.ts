// Realtime protocol between the Monet Blackboard web client and the API server (WebSocket at /api/ws).
// Elements are Excalidraw element JSON. Every message has a `t` discriminator.

export type BoardRole = "owner" | "editor" | "commenter" | "viewer";

/** Excalidraw element as plain JSON. Only the fields the server reasons about are typed. */
export interface SceneElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  updated?: number;
  [key: string]: unknown;
}

export interface Collaborator {
  socketId: string;
  userId: string;
  name: string;
  color: string;
  avatarUrl?: string | null;
  role: BoardRole;
  /** True for the board AI's presence (its cursor moves where it is drawing). */
  isAI?: boolean;
}

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

/** "stopped": someone stopped the run (POST /api/boards/:id/ai/stop); what it already drew stays on the board. */
export type AiRunStatus = "thinking" | "drawing" | "done" | "error" | "stopped";

/** A rectangle in scene coordinates. */
export interface AiRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChatMessage {
  id: string;
  boardId: string;
  userId: string | null;
  userName?: string | null;
  role: "user" | "assistant";
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** The board's shared countdown timer (the stopwatch in the zoom control). Remaining time is relative to receipt. */
export interface BoardTimer {
  durationMs: number;
  remainingMs: number;
  running: boolean;
  /** Name of whoever last started, paused or reset it. */
  by?: string;
}

export const TIMER_LIMITS = { minMs: 10_000, maxMs: 3 * 60 * 60_000 } as const;
export const CURSOR_CHAT_MAX = 120;

// ---------- client -> server ----------
export type ClientMessage =
  | { t: "hello"; boardId: string; linkToken?: string | null }
  | { t: "elements"; elements: SceneElement[] }
  | { t: "pointer"; x: number; y: number; tool: "pointer" | "laser"; button: "up" | "down" }
  | { t: "viewport"; viewport: Viewport }
  | { t: "selection"; ids: string[] }
  | { t: "files"; fileIds: string[] }
  /** Start (socketId) or stop (null) following someone's viewport. The target is told who follows them. */
  | { t: "follow"; socketId: string | null }
  /** Editors only. "start" with durationMs sets a new countdown; without it, resumes a paused one. */
  | { t: "timer"; action: "start" | "pause" | "reset" | "add"; durationMs?: number }
  /** Cursor chat: a short message shown next to my cursor for everyone else ("" clears it). */
  | { t: "cursorChat"; text: string }
  | { t: "ping" };

// ---------- server -> client ----------
export type ServerMessage =
  | {
      t: "init";
      me: Collaborator;
      board: { id: string; title: string; role: BoardRole; ownerId: string };
      elements: SceneElement[];
      collaborators: Collaborator[];
      timer?: BoardTimer | null;
    }
  | {
      t: "elements";
      elements: SceneElement[];
      from: string;
      source?: "user" | "ai";
      /** On AI batches: the run and who asked for it. The requester's client records the run as one undo step. */
      aiRun?: { runId: string; userId: string };
    }
  | { t: "presence"; collaborators: Collaborator[] }
  | { t: "pointer"; socketId: string; x: number; y: number; tool: "pointer" | "laser"; button: "up" | "down" }
  | { t: "viewport"; socketId: string; viewport: Viewport }
  | { t: "selection"; socketId: string; ids: string[] }
  | { t: "files"; fileIds: string[] }
  | {
      t: "ai";
      runId: string;
      status: AiRunStatus;
      message?: string;
      userId?: string | null;
      /**
       * The area the AI is working in (scene coordinates). Sent on "thinking" as soon as it's known (an estimate
       * at first) and on every "drawing" frame (growing as content lands), so clients can outline it.
       */
      region?: AiRegion;
      /** On "stopped": the user id of whoever stopped the run. */
      stoppedBy?: string;
    }
  | { t: "chat"; message: ChatMessage }
  | { t: "board"; title?: string; role?: BoardRole }
  /** Sent to a collaborator whenever the set of sockets following their viewport changes. */
  | { t: "followers"; socketIds: string[] }
  | { t: "timer"; timer: BoardTimer | null }
  | { t: "cursorChat"; socketId: string; text: string }
  | { t: "error"; code: string; message: string }
  | { t: "pong" };

export const WS_PATH = "/api/ws";

/** Host of the internal link every live embed carries (https://embed.monet.local/<kind>). Saved boards depend on it. */
export const LIVE_EMBED_HOST = "embed.monet.local";

/** Returns true when `incoming` should replace `existing` (Excalidraw's reconciliation rule). */
export function shouldAcceptElement(existing: SceneElement | undefined, incoming: SceneElement): boolean {
  if (!existing) return true;
  if (incoming.version > existing.version) return true;
  if (incoming.version === existing.version && incoming.versionNonce < existing.versionNonce) return true;
  return false;
}
