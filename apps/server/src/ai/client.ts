// The one place that picks the model provider. Everything else uses the neutral types in ./types.
// Every call made on behalf of a person must go through lib/ai-limits.ts first.
import { aiKeyConfigured, config } from "../lib/config";
import { anthropicCaller } from "./providers/anthropic";
import { chatCompletionsCaller, openaiCaller } from "./providers/openai";
import { AiNotConfiguredError, type ModelCaller } from "./types";

export { AiNotConfiguredError };
export type { AiContentBlockParam, AiMessageParam, AiTextBlockParam, AiTool } from "./types";

export function isAiConfigured(): boolean {
  return aiKeyConfigured();
}

/** The chat model for the board AI and doc/deck generation. */
export function aiModel(): string {
  return config.ai.model;
}

const callers = new Map<string, ModelCaller>();

/** A caller for the configured provider (cached per model, so per-endpoint fallbacks are remembered). */
export function modelCaller(model = aiModel()): ModelCaller {
  if (!isAiConfigured() || !model) throw new AiNotConfiguredError();
  const key = `${config.ai.provider}:${model}`;
  let caller = callers.get(key);
  if (!caller) {
    caller = config.ai.provider === "anthropic" ? anthropicCaller(model) : config.ai.provider === "openai" ? openaiCaller(model) : chatCompletionsCaller(model);
    callers.set(key, caller);
  }
  return caller;
}

/** A short description of the configured model for logs and the settings view, e.g. "anthropic / claude-sonnet-5-5". */
export function aiDescription(): string {
  return config.ai.provider ? `${config.ai.provider} / ${config.ai.model || "(no model)"}` : "none";
}
