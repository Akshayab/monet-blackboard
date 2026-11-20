import { describe, expect, it } from "vitest";
import { RateLimiter, TokenBucket } from "../../src/lib/rate-limiter";
import { BOARD_MAX_BYTES, BOARD_MAX_ELEMENTS, fitBoardLimits, shouldAcceptElement, slimTombstone, type SceneElement } from "@monet/board-protocol";

const el = (id: string, version = 1, versionNonce = 1, extra: Partial<SceneElement> = {}) =>
  ({ id, type: "rectangle", version, versionNonce, isDeleted: false, ...extra }) as SceneElement;

describe("rate limiter", () => {
  it("allows up to the limit in a window, then refuses with a retry time", () => {
    const l = new RateLimiter("t", 3, 60_000);
    const now = 1_000_000_000_000;
    expect([1, 2, 3].map(() => l.hit("ip", 1, now).allowed)).toEqual([true, true, true]);
    const r = l.hit("ip", 1, now);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(l.hit("other-ip", 1, now).allowed).toBe(true);
  });
  it("a limit of 0 turns the limiter off", () => {
    const l = new RateLimiter("t", 0, 60_000);
    for (let i = 0; i < 100; i++) expect(l.hit("ip").allowed).toBe(true);
  });
  it("token buckets refuse bursts above capacity", () => {
    const b = new TokenBucket(5, 0);
    expect(Array.from({ length: 6 }, () => b.take())).toEqual([true, true, true, true, true, false]);
  });
});

describe("realtime version rule", () => {
  it("higher versions win, ties go to the lower nonce, older updates are dropped", () => {
    expect(shouldAcceptElement(undefined, el("a"))).toBe(true);
    expect(shouldAcceptElement(el("a", 2), el("a", 3))).toBe(true);
    expect(shouldAcceptElement(el("a", 3), el("a", 2))).toBe(false);
    expect(shouldAcceptElement(el("a", 2, 50), el("a", 2, 10))).toBe(true);
    expect(shouldAcceptElement(el("a", 2, 10), el("a", 2, 50))).toBe(false);
  });
});

describe("board size limit", () => {
  const full = () => {
    const existing = new Map<string, SceneElement>();
    for (let i = 0; i < BOARD_MAX_ELEMENTS; i++) existing.set(`e${i}`, el(`e${i}`));
    return existing;
  };
  it("refuses new elements on a full board but still accepts edits and deletions", () => {
    const { accepted, refused } = fitBoardLimits(full(), [el("new-1"), el("e0", 2), el("e1", 2, 1, { isDeleted: true })].slice(0, 2));
    expect(refused.map((e) => e.id)).toEqual(["new-1"]);
    expect(accepted.map((e) => e.id)).toEqual(["e0"]);
    expect(fitBoardLimits(full(), [el("e1", 2, 1, { isDeleted: true })]).refused).toEqual([]);
  });
  it("a deletion in the same change frees room for a new element", () => {
    const { refused } = fitBoardLimits(full(), [el("e1", 2, 1, { isDeleted: true }), el("new-1")]);
    expect(refused).toEqual([]);
  });
  it("counts edits that make an element bigger, so existing elements can't grow a board past 2 MB", () => {
    const big = (id: string, version: number, chars: number) => el(id, version, 1, { text: "x".repeat(chars) });
    const existing = new Map([
      ["a", big("a", 1, BOARD_MAX_BYTES / 2)],
      ["b", big("b", 1, 1000)],
    ]);
    expect(fitBoardLimits(existing, [big("b", 2, BOARD_MAX_BYTES / 2)]).refused.map((e) => e.id)).toEqual(["b"]);
    expect(fitBoardLimits(existing, [big("b", 2, 2000)]).refused).toEqual([]);
    // An over-limit board can still be trimmed: shrinking edits and deletions pass.
    const over = new Map([["a", big("a", 1, BOARD_MAX_BYTES + 10)]]);
    expect(fitBoardLimits(over, [big("a", 2, 100)]).refused).toEqual([]);
    expect(fitBoardLimits(over, [el("a", 2, 1, { isDeleted: true })]).refused).toEqual([]);
    expect(fitBoardLimits(over, [big("a", 2, BOARD_MAX_BYTES + 20)]).refused.map((e) => e.id)).toEqual(["a"]);
  });
  it("deleted elements are kept small", () => {
    const dead = slimTombstone(el("t", 3, 7, { isDeleted: true, index: "a1", text: "x".repeat(100_000), points: Array(5000).fill([1, 2]) }));
    expect(JSON.stringify(dead).length).toBeLessThan(4096);
    expect(dead).toMatchObject({ id: "t", version: 3, versionNonce: 7, isDeleted: true, index: "a1", text: "", points: [] });
    const alive = el("u", 1, 1, { text: "x".repeat(100_000) });
    expect(slimTombstone(alive)).toBe(alive);
  });
});
