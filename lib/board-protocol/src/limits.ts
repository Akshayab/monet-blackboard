// Per-board size limits, enforced on AI writes (server ai/editor.ts) and on people's writes (realtime server).
import type { SceneElement } from "./messages";

export const BOARD_MAX_ELEMENTS = 800;
export const BOARD_MAX_BYTES = 2 * 1024 * 1024;

export const BOARD_LIMIT_MESSAGE = `This board is full (limit: ${BOARD_MAX_ELEMENTS} items or 2 MB). Delete some items or start a new board to add more.`;

// Element objects are replaced (never mutated) on every change, so a size computed once stays valid.
const sizes = new WeakMap<object, number>();
function bytesOf(el: SceneElement): number {
  let n = sizes.get(el);
  if (n === undefined) {
    n = JSON.stringify(el).length;
    sizes.set(el, n);
  }
  return n;
}

const liveBytes = (el: SceneElement | undefined) => (el && !el.isDeleted ? bytesOf(el) : 0);
const live = (el: SceneElement | undefined) => (el && !el.isDeleted ? 1 : 0);

/**
 * Splits incoming changes into what fits the board limits and what doesn't. The limits are BOARD_MAX_ELEMENTS live
 * elements and BOARD_MAX_BYTES of live element JSON. Additions, restores and edits that make an element bigger count
 * against them; deletions and edits that shrink or keep the size always pass (so an over-limit board can be trimmed).
 */
export function fitBoardLimits(existing: Map<string, SceneElement>, incoming: SceneElement[]): { accepted: SceneElement[]; refused: SceneElement[] } {
  const latest = new Map<string, SceneElement>();
  for (const el of incoming) latest.set(el.id, el);
  const changes = [...latest.values()].map((el) => {
    const prev = existing.get(el.id);
    return { el, bytes: liveBytes(el) - liveBytes(prev), count: live(el) - live(prev) };
  });
  if (changes.every((c) => c.bytes <= 0 && c.count <= 0)) return { accepted: incoming, refused: [] };
  let count = 0;
  let bytes = 0;
  for (const el of existing.values()) {
    count += live(el);
    bytes += liveBytes(el);
  }
  // Shrinking changes first, so a deletion in the same batch makes room for an addition.
  changes.sort((a, b) => a.bytes - b.bytes || a.count - b.count);
  const refusedIds = new Set<string>();
  for (const c of changes) {
    if ((c.bytes > 0 && bytes + c.bytes > BOARD_MAX_BYTES) || (c.count > 0 && count + c.count > BOARD_MAX_ELEMENTS)) {
      refusedIds.add(c.el.id);
      continue;
    }
    bytes += c.bytes;
    count += c.count;
  }
  if (!refusedIds.size) return { accepted: incoming, refused: [] };
  // A refused container takes its bound label with it (and vice versa) so nothing is left half-made.
  for (const el of incoming) {
    const container = typeof el.containerId === "string" ? el.containerId : null;
    if (container && refusedIds.has(container)) refusedIds.add(el.id);
  }
  return { accepted: incoming.filter((e) => !refusedIds.has(e.id)), refused: incoming.filter((e) => refusedIds.has(e.id)) };
}

const TOMBSTONE_MAX_BYTES = 1024;
const TOMBSTONE_FIELD_BYTES = 200;
const TOMBSTONE_CORE = ["id", "type", "version", "versionNonce", "isDeleted", "index", "updated"];

/**
 * A deleted element small enough to keep: deletions stay on the server for a day so they reach everyone, and only
 * the id, version and place matter for that. Large fields are dropped (text and points become empty).
 */
export function slimTombstone(el: SceneElement): SceneElement {
  if (!el.isDeleted || bytesOf(el) <= TOMBSTONE_MAX_BYTES) return el;
  let out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (TOMBSTONE_CORE.includes(k) || (JSON.stringify(v ?? null) ?? "").length <= TOMBSTONE_FIELD_BYTES) out[k] = v;
    else if (k === "text" || k === "originalText") out[k] = "";
    else if (k === "points" || k === "pressures") out[k] = [];
  }
  if (JSON.stringify(out).length > 4 * TOMBSTONE_MAX_BYTES) out = Object.fromEntries(TOMBSTONE_CORE.filter((k) => k in el).map((k) => [k, el[k]]));
  return out as SceneElement;
}
