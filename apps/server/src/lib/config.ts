// Every setting the server reads, in one place. See .env.example for descriptions and defaults.

export type AiProvider = "anthropic" | "openai" | "openai-compatible";

const flag = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");
/** NODE_ENV=development or test. Unset counts as production, so `pnpm start` from source gets strict limits. */
const devEnv = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

function pickProvider(): AiProvider | null {
  const explicit = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "openai" || explicit === "openai-compatible") return explicit;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.2-sol",
  "openai-compatible": "",
};

const provider = pickProvider();

export const config = {
  port: Number(process.env.PORT || 3000),
  /** Solo mode listens on loopback only. Docker sets HOST=0.0.0.0 inside the container and publishes on 127.0.0.1. */
  host: process.env.HOST || "127.0.0.1",
  /** Team mode: other people can join boards through share links. Off by default. */
  teamMode: flag(process.env.TEAM_MODE),
  /** The address people use to reach this server in team mode (used for printed links), e.g. https://board.example.com */
  publicUrl: (process.env.PUBLIC_URL ?? "").trim().replace(/\/$/, ""),
  /** Proxies whose X-Forwarded-* headers are trusted (Express "trust proxy" syntax). */
  trustProxy: process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal",
  /** Guests in team mode can ask the AI (within their daily limits). */
  guestAi: process.env.GUEST_AI === undefined ? true : flag(process.env.GUEST_AI),
  inContainer: flag(process.env.MONET_CONTAINER),
  /** Deterministic AI for tests and development without a key (only with NODE_ENV=development or test). */
  mockAi: flag(process.env.AI_MOCK) && devEnv,
  /** Deterministic docs and decks without a model call (only with NODE_ENV=development or test). */
  outputsStub: process.env.OUTPUTS_AI_STUB === "1" && devEnv,
  ai: {
    provider,
    model: (process.env.AI_MODEL || (provider ? DEFAULT_MODELS[provider] : "")).trim(),
    /** Optional cheaper or faster model for live meeting mode. */
    liveModel: (process.env.AI_LIVE_MODEL ?? "").trim(),
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    openaiKey: process.env.OPENAI_API_KEY ?? "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
    reasoningEffort: (process.env.AI_REASONING_EFFORT ?? "low") as "low" | "medium" | "high",
    /** Server-side web search through the provider. AI_WEB_SEARCH=0 turns it off. */
    webSearch: process.env.AI_WEB_SEARCH === undefined ? true : flag(process.env.AI_WEB_SEARCH),
  },
};

/** True when a real model is configured (a key, plus a model name for OpenAI-compatible endpoints). */
export function aiKeyConfigured(): boolean {
  const { provider: p, anthropicKey, openaiKey, openaiBaseUrl, model } = config.ai;
  if (p === "anthropic") return !!anthropicKey;
  if (p === "openai") return !!openaiKey;
  if (p === "openai-compatible") return !!openaiBaseUrl && !!model;
  return false;
}

/** Problems that stop the server from starting, each with its fix. */
export function configErrors(): string[] {
  const errors: string[] = [];
  if (!process.env.DATABASE_URL) errors.push("DATABASE_URL is not set. Point it at a Postgres database (docker compose sets this for you).");
  const p = config.ai.provider;
  if (!p && !config.mockAi) {
    errors.push("No AI key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env (or AI_PROVIDER=openai-compatible with OPENAI_BASE_URL and AI_MODEL).");
  }
  if (p === "anthropic" && !config.ai.anthropicKey) errors.push("AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set.");
  if (p === "openai" && !config.ai.openaiKey) errors.push("AI_PROVIDER is openai but OPENAI_API_KEY is not set.");
  if (p === "openai-compatible" && (!config.ai.openaiBaseUrl || !config.ai.model)) {
    errors.push("AI_PROVIDER is openai-compatible: set OPENAI_BASE_URL (for example http://localhost:11434/v1 for Ollama) and AI_MODEL.");
  }
  if (!Number.isInteger(config.port) || config.port <= 0) errors.push(`PORT must be a port number (got "${process.env.PORT}").`);
  return errors;
}
