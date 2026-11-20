import { afterEach, describe, expect, it, vi } from "vitest";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function load(env: Record<string, string | undefined>) {
  process.env = { DATABASE_URL: "postgres://localhost/test" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import("../../src/lib/config");
}

describe("configuration", () => {
  it("picks Anthropic when only ANTHROPIC_API_KEY is set, with the default model", async () => {
    const { config, configErrors, aiKeyConfigured, DEFAULT_MODELS } = await load({ ANTHROPIC_API_KEY: "test" });
    expect(config.ai.provider).toBe("anthropic");
    expect(config.ai.model).toBe(DEFAULT_MODELS.anthropic);
    expect(aiKeyConfigured()).toBe(true);
    expect(configErrors()).toEqual([]);
  });
  it("picks OpenAI when only OPENAI_API_KEY is set, and AI_MODEL overrides the model", async () => {
    const { config } = await load({ OPENAI_API_KEY: "test", AI_MODEL: "my-model" });
    expect(config.ai.provider).toBe("openai");
    expect(config.ai.model).toBe("my-model");
  });
  it("explains what to set when no key is present", async () => {
    const { configErrors } = await load({});
    expect(configErrors().join("\n")).toMatch(/ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  });
  it("needs a base URL and a model for OpenAI-compatible endpoints", async () => {
    const missing = await load({ AI_PROVIDER: "openai-compatible" });
    expect(missing.configErrors().join("\n")).toMatch(/OPENAI_BASE_URL/);
    vi.resetModules();
    const ok = await load({ AI_PROVIDER: "openai-compatible", OPENAI_BASE_URL: "http://localhost:11434/v1", AI_MODEL: "llama3" });
    expect(ok.configErrors()).toEqual([]);
    expect(ok.aiKeyConfigured()).toBe(true);
  });
  it("defaults to solo mode on loopback, and the test model works only in development", async () => {
    const dev = await load({ AI_MOCK: "1", NODE_ENV: "development" });
    expect(dev.config.teamMode).toBe(false);
    expect(dev.config.host).toBe("127.0.0.1");
    expect(dev.config.mockAi).toBe(true);
    vi.resetModules();
    const prod = await load({ AI_MOCK: "1", NODE_ENV: "production" });
    expect(prod.config.mockAi).toBe(false);
    vi.resetModules();
    const unset = await load({ AI_MOCK: "1" });
    expect(unset.config.mockAi).toBe(false);
  });
});
