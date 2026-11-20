import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIpFrom } from "../../src/lib/client-ip";
import { MAX_NEW_VERSION, MAX_VERSION_STEP, plausibleVersion } from "../../src/realtime/guard";
import { logUrl } from "../../src/middlewares/security";
import { stripHandles } from "../../src/ai/agent";
import { CONTENT_SECURITY_POLICY } from "../../../web/csp";

describe("client address for rate limits follows TRUST_PROXY", () => {
  it("ignores X-Forwarded-For from an untrusted peer, so nobody picks their own bucket", () => {
    expect(clientIpFrom("1.1.1.1", "203.0.113.9", "loopback")).toBe("203.0.113.9");
  });
  it("uses the forwarded client behind a trusted proxy, including one on a public address", () => {
    expect(clientIpFrom("198.51.100.7", "127.0.0.1", "loopback")).toBe("198.51.100.7");
    expect(clientIpFrom("198.51.100.7", "203.0.113.9", "203.0.113.9")).toBe("198.51.100.7");
    expect(clientIpFrom("198.51.100.7, 203.0.113.9", "127.0.0.1", "loopback, 203.0.113.0/24")).toBe("198.51.100.7");
  });
  it("supports hop counts and groups IPv6 by /64", () => {
    expect(clientIpFrom("198.51.100.7, 10.0.0.2", "10.0.0.1", "1")).toBe("10.0.0.2");
    expect(clientIpFrom(undefined, "2001:db8:1:2:aaaa::1", "loopback")).toBe(clientIpFrom(undefined, "2001:db8:1:2:bbbb::9", "loopback"));
    expect(clientIpFrom(undefined, "::ffff:8.8.8.8", "loopback")).toBe("8.8.8.8");
  });
});

describe("element versions", () => {
  it("refuses a version that jumps far ahead, which would freeze the element for everyone", () => {
    expect(plausibleVersion({ version: 5 }, { version: 6 })).toBe(true);
    expect(plausibleVersion({ version: 5 }, { version: 5 + MAX_VERSION_STEP })).toBe(true);
    expect(plausibleVersion({ version: 5 }, { version: 2 ** 31 })).toBe(false);
    expect(plausibleVersion(undefined, { version: 1 })).toBe(true);
    expect(plausibleVersion(undefined, { version: MAX_NEW_VERSION + 1 })).toBe(false);
  });
});

describe("request logs", () => {
  it("never include share-link tokens or query strings", () => {
    expect(logUrl("/api/share/abc123def456")).toBe("/api/share/[token]");
    expect(logUrl("/api/boards/b1?link=secret")).toBe("/api/boards/b1");
    expect(logUrl("/api/boards/b1")).toBe("/api/boards/b1");
  });
});

describe("cleaning the AI's reply", () => {
  it("stays fast on a long adversarial reply once capped", () => {
    const evil = "(e1, ".repeat(1600);
    const t0 = performance.now();
    stripHandles(evil.slice(0, 8000));
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe("page policy", () => {
  const directive = (name: string) => CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith(name + " ")) ?? "";
  it("loads images, media and connections only from this server", () => {
    expect(directive("img-src")).toBe("img-src 'self' data: blob:");
    expect(directive("media-src")).toBe("media-src 'self' data: blob:");
    expect(directive("connect-src")).toBe("connect-src 'self'");
  });
  it("frames only the embed runner and three video sites", () => {
    expect(directive("frame-src")).toBe("frame-src 'self' https://www.youtube.com https://player.vimeo.com https://www.loom.com");
  });
});

describe("owner link rotation", () => {
  afterEach(() => {
    vi.doUnmock("@monet/db");
    vi.resetModules();
    delete process.env.OWNER_LINK_ROTATE;
  });
  it("happens once per start, even when OWNER_LINK_ROTATE stays set", async () => {
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.OWNER_LINK_ROTATE = "1";
    delete process.env.OWNER_LINK_TOKEN;
    const writes: unknown[] = [];
    const chain = (result: unknown) => {
      const c: Record<string, unknown> = {};
      for (const k of ["from", "where", "values", "onConflictDoUpdate", "returning", "set"]) c[k] = () => c;
      (c as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(result);
      return c;
    };
    vi.doMock("@monet/db", () => ({
      db: {
        select: () => chain([{ key: "owner_link_token", value: "old" }]),
        insert: () => {
          writes.push("insert");
          return chain([]);
        },
        delete: () => chain([]),
      },
      sessionsTable: {},
      settingsTable: { key: "key" },
      usersTable: {},
    }));
    const { ownerLinkToken } = await import("../../src/lib/auth");
    const first = await ownerLinkToken();
    expect(first).not.toBe("old");
    expect(await ownerLinkToken()).toBe(first);
    expect(await ownerLinkToken()).toBe(first);
    expect(writes).toHaveLength(1);
  });
});
