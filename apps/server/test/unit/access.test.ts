import { describe, expect, it } from "vitest";
import type { Board } from "@monet/db";
import { accessFromMembership, linkRoleOf } from "../../src/lib/access";
import { isOwnCommentPin, placeholderForStored, sanitizeElement } from "../../src/realtime/guard";
import { MAX_JSON_DEPTH } from "../../src/lib/pg-safe";

const board = (linkAccess: "none" | "view" | "edit") => ({ id: "b1", ownerId: "owner", linkAccess, linkToken: "tok" }) as unknown as Board;

describe("board access from a membership row", () => {
  it("a role the owner set wins over the share link, in both directions", () => {
    expect(accessFromMembership(board("edit"), "direct", "viewer")?.role).toBe("viewer");
    expect(accessFromMembership(board("view"), "direct", "editor")?.role).toBe("editor");
    expect(accessFromMembership(board("none"), "direct", "commenter")?.role).toBe("commenter");
  });
  it("people who joined through the link get the link's current level, and nothing when it's off", () => {
    expect(accessFromMembership(board("edit"), "link", "viewer")?.role).toBe("editor");
    expect(accessFromMembership(board("view"), "link", "editor")?.role).toBe("viewer");
    expect(accessFromMembership(board("none"), "link", "editor")).toBeNull();
  });
  it("someone who left keeps the role the owner set as a ceiling, and needs a working link to come back", () => {
    expect(accessFromMembership(board("edit"), "left", "viewer", true)?.role).toBe("viewer");
    expect(accessFromMembership(board("edit"), "left", "viewer", false)).toBeNull();
    expect(accessFromMembership(board("none"), "left", "editor", true)).toBeNull();
  });
  it("someone the owner removed has no access, even while the link is on", () => {
    expect(accessFromMembership(board("edit"), "removed", "viewer")).toBeNull();
    expect(accessFromMembership(board("view"), "removed", "viewer")).toBeNull();
  });
  it("maps link settings to roles", () => {
    expect([linkRoleOf(board("none")), linkRoleOf(board("view")), linkRoleOf(board("edit"))]).toEqual([null, "viewer", "editor"]);
  });
});

const pin = (extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  id: "c1",
  type: "ellipse",
  x: 10,
  y: 10,
  width: 30,
  height: 30,
  version: 1,
  versionNonce: 1,
  locked: true,
  boundElements: [{ id: "l1", type: "text" }],
  customData: { kind: "comment", authorId: "cara", authorName: "Cara", createdAt: "2026-01-01", text: "Who owns this?", ...data },
  ...extra,
});
const label = (extra: Record<string, unknown> = {}) => ({
  id: "l1",
  type: "text",
  text: "C",
  fontSize: 14,
  containerId: "c1",
  version: 1,
  versionNonce: 1,
  ...extra,
});

describe("what a commenter may add", () => {
  const none = () => undefined;
  it("their own comment pin and its one-letter label", () => {
    expect(isOwnCommentPin(pin(), "cara", none)).toBe(true);
    expect(isOwnCommentPin(label(), "cara", (id) => (id === "c1" ? pin() : undefined))).toBe(true);
  });
  it("not someone else's pin", () => {
    expect(isOwnCommentPin(pin(), "bob", none)).toBe(false);
  });
  it("not other element types that merely carry comment data", () => {
    for (const type of ["rectangle", "embeddable", "image", "frame", "freedraw", "arrow"]) expect(isOwnCommentPin(pin({ type }), "cara", none)).toBe(false);
  });
  it("not a pin that covers the board, links somewhere, or carries extra fields", () => {
    expect(isOwnCommentPin(pin({ width: 4000, height: 4000 }), "cara", none)).toBe(false);
    expect(isOwnCommentPin(pin({ link: "https://evil.example" }), "cara", none)).toBe(false);
    expect(isOwnCommentPin(pin({ fileId: "f1" }), "cara", none)).toBe(false);
    expect(isOwnCommentPin(pin({}, { generationData: { html: "<b>x</b>" } }), "cara", none)).toBe(false);
  });
  it("not a long or large label, or a label outside their own pin", () => {
    const own = (id: string) => (id === "c1" ? pin() : undefined);
    expect(isOwnCommentPin(label({ text: "A whole paragraph of text" }), "cara", own)).toBe(false);
    expect(isOwnCommentPin(label({ fontSize: 200 }), "cara", own)).toBe(false);
    expect(isOwnCommentPin(label({ containerId: "someone-elses-box" }), "cara", own)).toBe(false);
  });
});

describe("element validation", () => {
  const base = { id: "e1", version: 1, versionNonce: 1 };
  it("drops iframe and magicframe elements (their HTML would render outside the sealed embed runner)", () => {
    expect(sanitizeElement({ ...base, type: "iframe", customData: { generationData: { status: "done", html: "<img src=x>" } } })).toBeNull();
    expect(sanitizeElement({ ...base, type: "magicframe" })).toBeNull();
  });
  it("drops elements nested too deeply to store inside a board (same depth budget as the saved scene)", () => {
    const nest = (n: number) => {
      let v: unknown = 1;
      for (let i = 0; i < n; i++) v = { v };
      return v;
    };
    const base = { id: "a", type: "rectangle", version: 1, versionNonce: 1 };
    expect(sanitizeElement({ ...base, customData: nest(MAX_JSON_DEPTH - 3) })).not.toBeNull();
    expect(sanitizeElement({ ...base, customData: nest(MAX_JSON_DEPTH) })).toBeNull();
  });
  it("turns iframe elements saved before the allowlist into a plain box when a board loads", () => {
    const old = {
      id: "f",
      type: "iframe",
      version: 4,
      versionNonce: 1,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      customData: { generationData: { html: "<script>1</script>" } },
    };
    const p = placeholderForStored(old as never)!;
    expect(p).toMatchObject({ id: "f", type: "rectangle", version: 5, x: 10, y: 20, width: 300, height: 200 });
    expect(JSON.stringify(p)).not.toContain("script");
    expect(placeholderForStored({ id: "r", type: "rectangle", version: 1, versionNonce: 1 } as never)).toBeNull();
  });
  it("keeps embeddables and normal shapes", () => {
    expect(sanitizeElement({ ...base, type: "embeddable", link: "https://www.youtube.com/watch?v=x" })).not.toBeNull();
    expect(sanitizeElement({ ...base, type: "rectangle" })).not.toBeNull();
  });
  it("neutralizes script links", () => {
    expect(sanitizeElement({ ...base, type: "rectangle", link: " JaVaScRiPt:alert(1)" })?.link).toBeNull();
  });
});
