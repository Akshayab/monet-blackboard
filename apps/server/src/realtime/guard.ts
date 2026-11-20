// WebSocket hardening: limits, per-socket message budgets, connection caps, and minimal validation of what
// clients send before it is merged into a room or relayed to other people.
import type { SceneElement, Viewport } from "@monet/board-protocol";
import { pgSafe } from "../lib/pg-safe";
import { envInt, isDevEnv, TokenBucket } from "../lib/rate-limiter";

export const WS_LIMITS = {
  /** ws closes the socket (1009) when a single message is larger than this. */
  maxMessageBytes: envInt("WS_MAX_MESSAGE_BYTES", 8 * 1024 * 1024),
  /** The same limit for sockets opened without a session (they can only say hello and be refused). */
  maxAnonMessageBytes: envInt("WS_MAX_ANON_MESSAGE_BYTES", 16 * 1024),
  maxElementsPerMessage: envInt("WS_MAX_ELEMENTS_PER_MESSAGE", 5000),
  maxElementBytes: envInt("WS_MAX_ELEMENT_BYTES", 1024 * 1024),
  /** Output queued for one socket. A reader this far behind is dropped and reconnects to a fresh snapshot. */
  maxBufferedBytes: envInt("WS_MAX_BUFFERED_BYTES", 16 * 1024 * 1024),
  /** Elements per board, including recent tombstones. New ids beyond this are refused. */
  maxRoomElements: envInt("WS_MAX_ROOM_ELEMENTS", 20_000),
  /** All messages: burst capacity and steady rate per socket. The client sends well under 60/s. */
  msgBurst: envInt("WS_MSG_BURST", 200),
  msgPerSec: envInt("WS_MSG_PER_SEC", 100),
  /** Element batches: the client flushes at most every 60 ms. */
  elementsBurst: envInt("WS_ELEMENTS_BURST", 60),
  elementsPerSec: envInt("WS_ELEMENTS_PER_SEC", 30),
  /** Dropped messages tolerated before the socket is closed. */
  maxDropsPer10s: envInt("WS_MAX_DROPS_PER_10S", 300),
  helloTimeoutMs: envInt("WS_HELLO_TIMEOUT_MS", 15_000),
  /** No client message at all (the client pings every 20 s) for this long closes the socket. */
  idleTimeoutMs: envInt("WS_IDLE_TIMEOUT_MS", 10 * 60 * 1000),
  /** How often each socket's board access is re-checked (catches revoked links, removed members, deleted boards). */
  revalidateMs: envInt("WS_REVALIDATE_MS", 60_000),
  maxSocketsPerUser: envInt("WS_MAX_SOCKETS_PER_USER", 20),
  maxSocketsPerIp: envInt("WS_MAX_SOCKETS_PER_IP", isDevEnv() ? 1000 : 60),
};

/** Close codes. The client stops retrying only on 4401/4403; others reconnect with backoff (and resync). */
export const WS_CLOSE = {
  unauthenticated: 4401,
  forbidden: 4403,
  timeout: 4408,
  rateLimited: 4429,
} as const;

export class SocketBudget {
  private all = new TokenBucket(WS_LIMITS.msgBurst, WS_LIMITS.msgPerSec);
  private elements = new TokenBucket(WS_LIMITS.elementsBurst, WS_LIMITS.elementsPerSec);
  private drops: number[] = [];
  takeMessage(): boolean {
    return this.all.take();
  }
  takeElements(): boolean {
    return this.elements.take();
  }
  /** Records a dropped message; returns true when the socket has dropped too many recently. */
  drop(): boolean {
    const now = Date.now();
    this.drops.push(now);
    while (this.drops.length && now - this.drops[0]! > 10_000) this.drops.shift();
    return this.drops.length > WS_LIMITS.maxDropsPer10s;
  }
}

// ---------- Connection caps ----------
const perIp = new Map<string, number>();
const perUser = new Map<string, number>();

function inc(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function dec(map: Map<string, number>, key: string) {
  const n = (map.get(key) ?? 1) - 1;
  if (n <= 0) map.delete(key);
  else map.set(key, n);
}

export const connections = {
  tryAddIp(ip: string): boolean {
    if (WS_LIMITS.maxSocketsPerIp > 0 && (perIp.get(ip) ?? 0) >= WS_LIMITS.maxSocketsPerIp) return false;
    inc(perIp, ip);
    return true;
  },
  removeIp(ip: string) {
    dec(perIp, ip);
  },
  tryAddUser(userId: string): boolean {
    if (WS_LIMITS.maxSocketsPerUser > 0 && (perUser.get(userId) ?? 0) >= WS_LIMITS.maxSocketsPerUser) return false;
    inc(perUser, userId);
    return true;
  },
  removeUser(userId: string) {
    dec(perUser, userId);
  },
};

// ---------- Validation ----------
// Not "iframe" or "magicframe": Excalidraw renders an iframe element's customData.generationData.html as srcdoc,
// outside the sealed live-embed runner. Live embeds use "embeddable" and the runner page.
const ELEMENT_TYPES = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame", "embeddable"]);

const MAX_VERSION = 2 ** 31;

/**
 * Boards saved before the type allowlist can still hold iframe or magicframe elements. They load as a plain dashed
 * box (same place and size, no HTML), with a bumped version so clients replace their copy. Null when allowed.
 */
export function placeholderForStored(el: SceneElement): SceneElement | null {
  if (typeof el.type === "string" && ELEMENT_TYPES.has(el.type)) return null;
  const { customData: _customData, ...rest } = el as Record<string, unknown>;
  return {
    ...rest,
    type: "rectangle",
    strokeStyle: "dashed",
    link: null,
    version: (typeof el.version === "number" ? el.version : 1) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  } as unknown as SceneElement;
}

/** Neutralizes script-capable link schemes (javascript:, data:, vbscript:, file:). */
export function safeLink(link: unknown): string | null | undefined {
  if (link === undefined || link === null) return link as null | undefined;
  if (typeof link !== "string") return null;
  if (link.length > 4096) return null;
  // Browsers ignore whitespace and control characters inside the scheme.
  const compact = link.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
  if (/^(javascript|data|vbscript|file):/.test(compact)) return null;
  return link;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Minimal shape check for one client element. Returns the (possibly link-sanitized) element, or null to drop it.
 * Deliberately lenient about Excalidraw's many optional fields; strict about what the server and other clients
 * rely on (id, version, versionNonce, type) and about size.
 */
export function sanitizeElement(raw: unknown): SceneElement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const el = raw as Record<string, unknown>;
  if (typeof el.id !== "string" || el.id.length < 1 || el.id.length > 128) return null;
  if (!isFiniteNumber(el.version) || el.version < 0 || el.version > MAX_VERSION) return null;
  if (!isFiniteNumber(el.versionNonce)) return null;
  if (typeof el.type !== "string" || !ELEMENT_TYPES.has(el.type)) return null;
  if (el.isDeleted !== undefined && typeof el.isDeleted !== "boolean") return null;
  if (el.index !== undefined && el.index !== null && (typeof el.index !== "string" || el.index.length > 200)) return null;
  let size: number;
  try {
    size = JSON.stringify(el).length;
  } catch {
    return null;
  }
  if (size > WS_LIMITS.maxElementBytes) return null;
  // Depth 1: stored boards keep elements inside an array, so an element must fit the same budget there.
  let clean: Record<string, unknown>;
  try {
    clean = pgSafe(el, 1);
  } catch {
    return null;
  }
  if ("link" in clean) {
    const link = safeLink(clean.link);
    if (link !== clean.link) return { ...(clean as SceneElement), link };
  }
  return clean as SceneElement;
}

// ---------- Commenters ----------
/** Largest comment pin a commenter may place (the app draws 30 px pins). */
const PIN_MAX = 48;
const PIN_FIELDS = new Set([
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "roundness",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
  "index",
  "customData",
]);
const PIN_LABEL_FIELDS = new Set([
  ...PIN_FIELDS,
  "text",
  "originalText",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "containerId",
  "lineHeight",
  "autoResize",
  "baseline",
]);
const COMMENT_DATA_FIELDS = new Set(["kind", "authorId", "authorName", "createdAt", "editedAt", "text", "targetId", "sentToAi"]);

/**
 * True when `el` is a comment pin by `authorId` (a small ellipse whose customData is a comment), or the one-letter
 * label inside one. Commenters may add, edit and delete only these. `containerOf` finds the pin a label sits in.
 */
export function isOwnCommentPin(el: unknown, authorId: string, containerOf: (id: string) => unknown): boolean {
  if (!el || typeof el !== "object" || Array.isArray(el)) return false;
  const e = el as Record<string, unknown>;
  if (e.type === "ellipse") {
    if (!Object.keys(e).every((k) => PIN_FIELDS.has(k))) return false;
    const cd = e.customData as Record<string, unknown> | undefined;
    if (!cd || typeof cd !== "object" || cd.kind !== "comment" || cd.authorId !== authorId) return false;
    if (!Object.keys(cd).every((k) => COMMENT_DATA_FIELDS.has(k)) || (typeof cd.text === "string" && cd.text.length > 5000)) return false;
    if (e.link !== undefined && e.link !== null) return false;
    const size = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= PIN_MAX;
    if (!size(e.width) || !size(e.height)) return false;
    const bound = e.boundElements;
    return (
      bound === undefined || bound === null || (Array.isArray(bound) && bound.length <= 1 && bound.every((b) => (b as { type?: unknown })?.type === "text"))
    );
  }
  if (e.type === "text") {
    if (!Object.keys(e).every((k) => PIN_LABEL_FIELDS.has(k))) return false;
    if (typeof e.containerId !== "string" || (e.customData !== undefined && e.customData !== null)) return false;
    if (typeof e.text === "string" && e.text.length > 4) return false;
    if (typeof e.fontSize === "number" && e.fontSize > 20) return false;
    if (e.link !== undefined && e.link !== null) return false;
    return isOwnCommentPin(containerOf(e.containerId), authorId, () => null);
  }
  return false;
}

/** How far one change may raise an element's version, and the highest version a new element may start at. */
export const MAX_VERSION_STEP = 10_000;
export const MAX_NEW_VERSION = 1_000_000;

/**
 * False for a version far above what the board has (a new element starting near the top, or a huge jump), which
 * would leave no room for later edits and freeze the element for everyone.
 */
export function plausibleVersion(existing: { version?: unknown } | undefined, incoming: { version: number }): boolean {
  if (!existing) return incoming.version <= MAX_NEW_VERSION;
  const current = typeof existing.version === "number" ? existing.version : 0;
  return incoming.version <= current + MAX_VERSION_STEP;
}

export function sanitizeElements(raw: unknown[]): { elements: SceneElement[]; rejected: number } {
  const elements: SceneElement[] = [];
  let rejected = 0;
  for (const r of raw) {
    const el = sanitizeElement(r);
    if (el) elements.push(el);
    else rejected++;
  }
  return { elements, rejected };
}

/** Drops elements that would add new ids past the room cap (updates to existing elements always pass). */
export function capNewElements(existing: Map<string, unknown>, incoming: SceneElement[]): { elements: SceneElement[]; refused: number } {
  let room = WS_LIMITS.maxRoomElements - existing.size;
  const out: SceneElement[] = [];
  let refused = 0;
  for (const el of incoming) {
    if (existing.has(el.id)) out.push(el);
    else if (room > 0) {
      out.push(el);
      room--;
    } else refused++;
  }
  return { elements: out, refused };
}

export function validPointer(msg: { x?: unknown; y?: unknown; tool?: unknown; button?: unknown }) {
  return isFiniteNumber(msg.x) && isFiniteNumber(msg.y) && (msg.tool === "pointer" || msg.tool === "laser") && (msg.button === "up" || msg.button === "down");
}

export function cleanViewport(v: unknown): Viewport | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const keys = ["scrollX", "scrollY", "zoom", "width", "height"] as const;
  if (!keys.every((k) => isFiniteNumber(o[k]))) return null;
  return { scrollX: o.scrollX as number, scrollY: o.scrollY as number, zoom: o.zoom as number, width: o.width as number, height: o.height as number };
}

export function cleanIds(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, max);
}
