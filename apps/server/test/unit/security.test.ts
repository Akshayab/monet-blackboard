import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "http";
import { isAllowedOrigin, isLoopbackHost } from "../../src/middlewares/security";
import { clientIpFrom } from "../../src/lib/client-ip";
import { pgSafe, pgSafeText } from "../../src/lib/pg-safe";

const req = (host: string) => ({ headers: { host } }) as unknown as IncomingMessage;

describe("solo mode host check (DNS rebinding)", () => {
  it("accepts loopback names on any port", () => {
    for (const h of ["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST"]) expect(isLoopbackHost(h)).toBe(true);
  });
  it("refuses every other name", () => {
    for (const h of [undefined, "", "attacker.example", "localhost.attacker.example", "127.0.0.1.nip.io", "192.168.1.5:3000"])
      expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("same-origin check", () => {
  it("allows requests without an Origin header and from this server's own origin", () => {
    expect(isAllowedOrigin(undefined, req("localhost:3000"))).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", req("localhost:3000"))).toBe(true);
  });
  it("refuses foreign, null and malformed origins", () => {
    expect(isAllowedOrigin("https://evil.example", req("localhost:3000"))).toBe(false);
    expect(isAllowedOrigin("null", req("localhost:3000"))).toBe(false);
    expect(isAllowedOrigin("not a url", req("localhost:3000"))).toBe(false);
    expect(isAllowedOrigin("http://localhost:4000", req("localhost:3000"))).toBe(false);
  });
});

describe("client IP for rate limits", () => {
  it("takes the first address from the right that isn't a proxy", () => {
    expect(clientIpFrom("1.2.3.4, 10.0.0.2", "127.0.0.1")).toBe("1.2.3.4");
  });
  it("ignores a spoofed left-most entry when a public hop follows it", () => {
    expect(clientIpFrom("9.9.9.9, 5.6.7.8", "10.0.0.1")).toBe("5.6.7.8");
  });
  it("uses the socket address when there is no header", () => {
    expect(clientIpFrom(undefined, "::ffff:8.8.8.8")).toBe("8.8.8.8");
  });
  it("groups IPv6 addresses by /64", () => {
    expect(clientIpFrom(undefined, "2001:db8:1:2:aaaa::1")).toBe(clientIpFrom(undefined, "2001:db8:1:2:bbbb::9"));
  });
});

describe("Postgres-safe strings", () => {
  it("strips NUL characters and replaces lone surrogates", () => {
    expect(pgSafeText("a\u0000b")).toBe("ab");
    expect(pgSafeText("x\uD83D")).toBe("x\uFFFD");
    expect(pgSafeText("ok 😀")).toBe("ok 😀");
  });
  it("cleans nested values and keeps the same reference when nothing changed", () => {
    const clean = { a: ["b", { c: "d" }] };
    expect(pgSafe(clean)).toBe(clean);
    expect(pgSafe({ "k\u0000": ["v\u0000"] })).toEqual({ k: ["v"] });
  });
});
