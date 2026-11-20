import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { JsonTooDeepError, MAX_JSON_DEPTH, pgSafe } from "../../src/lib/pg-safe";

describe("deeply nested JSON", () => {
  const nest = (n: number) => JSON.parse("[".repeat(n) + "]".repeat(n));
  it("is refused with a 400 error instead of overflowing the stack", () => {
    expect(() => pgSafe(nest(15_000))).toThrow(JsonTooDeepError);
    expect(() => pgSafe(nest(MAX_JSON_DEPTH + 1))).toThrow(JsonTooDeepError);
    expect(new JsonTooDeepError().status).toBe(400);
  });
  it("accepts normal nesting", () => {
    expect(pgSafe(nest(MAX_JSON_DEPTH - 1))).toBeTruthy();
  });
});

describe("solo-mode host guard", () => {
  it("refuses other host names before anything reads the request", async () => {
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://localhost/test";
    delete process.env.TEAM_MODE;
    const { soloHostGuard } = await import("../../src/middlewares/security");
    const run = (host: string, path = "/api/auth/claim") => {
      let status = 0;
      let nextCalled = false;
      const res = { status: (s: number) => ((status = s), res), json: () => res, type: () => res, send: () => res };
      soloHostGuard({ headers: { host }, path } as never, res as never, () => (nextCalled = true));
      return { status, nextCalled };
    };
    expect(run("localhost:3000")).toEqual({ status: 0, nextCalled: true });
    expect(run("attacker.example")).toEqual({ status: 403, nextCalled: false });
    expect(run("attacker.example", "/")).toEqual({ status: 403, nextCalled: false });
  });
});

describe("board socket robustness (team mode, no session)", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.TEAM_MODE = "1";
    const { attachRealtime } = await import("../../src/realtime/server");
    server = http.createServer((_req, res) => res.end("ok"));
    attachRealtime(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.TEAM_MODE;
    server.close();
  });
  const alive = () => new Promise<string>((r) => http.get(`http://${base}/`, (res) => res.on("data", (d) => r(String(d)))));

  it("closes a socket that sends an oversized frame, and keeps running", async () => {
    const ws = new WebSocket(`ws://${base}/api/ws`, { headers: { origin: `http://${base}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on("open", () => ws.send("x".repeat(9 * 1024 * 1024)));
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => undefined);
    });
    expect(code).toBe(1009);
    expect(await alive()).toBe("ok");
  });

  it("closes a socket that sends invalid UTF-8, and keeps running", async () => {
    const ws = new WebSocket(`ws://${base}/api/ws`, { headers: { origin: `http://${base}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on("open", () => (ws as unknown as { _socket: net.Socket })._socket.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xc3, 0x28])));
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => undefined);
    });
    expect(code).toBe(1007);
    expect(await alive()).toBe("ok");
  });

  it("answers upgrades on other paths with 404 and closes them; a reset afterwards is harmless", async () => {
    const [host, port] = base.split(":");
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(Number(port), host!, () =>
        s.write(
          `GET /elsewhere HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
      let data = "";
      s.on("data", (d) => (data += d));
      s.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
      s.on("error", () => resolve("error"));
    });
    expect(reply).toBe("HTTP/1.1 404 Not Found");
    const s = net.connect(Number(port), host!, () => {
      s.write("GET /api/ws HTTP/1.1\r\nHost: x\r\n");
      s.resetAndDestroy();
    });
    s.on("error", () => undefined);
    await new Promise((r) => setTimeout(r, 200));
    expect(await alive()).toBe("ok");
  });
});
