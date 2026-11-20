import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  delete process.env.NODE_ENV_OVERRIDE;
});

describe("OpenAI citation markers", () => {
  it("are removed from answer text, leaving the sentence intact", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { stripCitationMarkers } = await import("../../src/ai/providers/openai");
    expect(stripCitationMarkers("A reserved seat costs ¥14,170 \uE200cite\uE202turn924302search2\uE201.")).toBe("A reserved seat costs ¥14,170.");
    expect(stripCitationMarkers("One \uE200cite\uE202turn0search0\uE202turn0search1\uE201 and two.")).toBe("One and two.");
    expect(stripCitationMarkers("stray \uE202 marker")).toBe("stray  marker");
    expect(stripCitationMarkers("No markers here.")).toBe("No markers here.");
  });

  it("are removed from tool-call arguments, so the chat reply (the reply tool's message) comes out clean", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const output = [
      { type: "web_search_call", action: { sources: [{ url: "https://example.com/fares", title: "Fares" }] } },
      {
        type: "function_call",
        call_id: "call_1",
        name: "add_text",
        arguments: JSON.stringify({ lines: ["Seat: ¥14,170 \uE200cite\uE202turn0search2\uE201"], n: 2 }),
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "reply",
        arguments: JSON.stringify({ message: "A reserved seat costs ¥14,170 \uE200cite\uE202turn0search2\uE201. Done." }),
      },
    ];
    vi.doMock("openai", () => ({
      default: class {
        responses = { create: async () => ({ status: "completed", output, usage: { input_tokens: 1, output_tokens: 1 } }) };
      },
    }));
    const { openaiCaller } = await import("../../src/ai/providers/openai");
    const res = await openaiCaller("gpt-test").call({ system: "", messages: [{ role: "user", content: "fares?" }], tools: [], maxTokens: 100 } as never);
    vi.doUnmock("openai");
    const inputs = Object.fromEntries(res.content.flatMap((b) => (b.type === "tool_use" ? [[b.name, b.input]] : [])));
    expect(inputs.reply).toEqual({ message: "A reserved seat costs ¥14,170. Done." });
    expect(inputs.add_text).toEqual({ lines: ["Seat: ¥14,170"], n: 2 });
    expect(JSON.stringify(res.content)).not.toMatch(/[\uE200-\uE202]|turn0search/);
  });
});

describe("guests' shared AI pool", () => {
  it("is full when guests together reach the token or request limit, counting runs in flight", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.AI_GUEST_POOL_DAILY_TOKEN_LIMIT = "1000";
    process.env.AI_GUEST_POOL_DAILY_REQUEST_LIMIT = "10";
    const { guestPoolFull } = await import("../../src/lib/ai-limits");
    expect(guestPoolFull({ tokens: 999, requests: 5 }, 0)).toBe(false);
    expect(guestPoolFull({ tokens: 1000, requests: 5 }, 0)).toBe(true);
    expect(guestPoolFull({ tokens: 0, requests: 9 }, 0)).toBe(false);
    expect(guestPoolFull({ tokens: 0, requests: 9 }, 1)).toBe(true);
    delete process.env.AI_GUEST_POOL_DAILY_TOKEN_LIMIT;
    delete process.env.AI_GUEST_POOL_DAILY_REQUEST_LIMIT;
  });
  it("never applies to the owner", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getGlobalAiPause } = await import("../../src/lib/ai-limits");
    // No database is reachable here: the owner's check must not even query the guests' usage.
    await expect(getGlobalAiPause("owner")).resolves.toBeNull();
  });
});

describe("strict limits by default", () => {
  const load = async (nodeEnv: string | undefined) => {
    vi.resetModules();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const k of ["RATE_AUTH_PER_IP_PER_MIN", "RATE_AI_REQUESTS_PER_MIN", "WS_MAX_SOCKETS_PER_IP", "AI_IP_HOURLY_LIMIT"]) delete process.env[k];
    process.env.DATABASE_URL = "postgres://localhost/test";
    const [{ limiters }, { WS_LIMITS }, { IP_HOURLY_LIMIT }, { config }] = await Promise.all([
      import("../../src/middlewares/rate-limit"),
      import("../../src/realtime/guard"),
      import("../../src/lib/ai-limits"),
      import("../../src/lib/config"),
    ]);
    return { auth: limiters.authPerIp.limit, ai: limiters.aiRequests.limit, sockets: WS_LIMITS.maxSocketsPerIp, aiIp: IP_HOURLY_LIMIT, config };
  };
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });
  it("applies when NODE_ENV is unset (pnpm start from source) or production", async () => {
    process.env.AI_MOCK = "1";
    process.env.OUTPUTS_AI_STUB = "1";
    for (const env of [undefined, "production", "staging"]) {
      const l = await load(env);
      expect({ auth: l.auth, ai: l.ai, sockets: l.sockets, aiIp: l.aiIp }).toEqual({ auth: 30, ai: 20, sockets: 60, aiIp: 60 });
      expect(l.config.mockAi).toBe(false);
      expect(l.config.outputsStub).toBe(false);
    }
  });
  it("relaxes only for development and test", async () => {
    process.env.AI_MOCK = "1";
    process.env.OUTPUTS_AI_STUB = "1";
    for (const env of ["development", "test"]) {
      const l = await load(env);
      expect(l.auth).toBeGreaterThan(30);
      expect(l.config.mockAi).toBe(true);
      expect(l.config.outputsStub).toBe(true);
    }
    delete process.env.AI_MOCK;
    delete process.env.OUTPUTS_AI_STUB;
  });
});
