// Provider-neutral shapes for model calls. The agent builds conversations in this format (content blocks with
// text, images, PDFs, tool calls and tool results); each provider adapter in ./providers converts it to its own API.

export interface AiTextBlockParam {
  type: "text";
  text: string;
}

export interface AiImageBlockParam {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface AiDocumentBlockParam {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
  title?: string;
}

export interface AiToolUseBlockParam {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AiToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * A provider's own assistant-turn items (server-side web search results, reasoning, citations), kept so they can be
 * sent back exactly as the provider returned them. Only the provider that produced them reads them.
 */
export interface AiProviderItemsBlockParam {
  type: "provider_items";
  provider: string;
  items: unknown[];
}

export type AiContentBlockParam =
  AiTextBlockParam | AiImageBlockParam | AiDocumentBlockParam | AiToolUseBlockParam | AiToolResultBlockParam | AiProviderItemsBlockParam;

export interface AiMessageParam {
  role: "user" | "assistant";
  content: string | AiContentBlockParam[];
}

/** A tool the model can call, described with JSON Schema. */
export interface AiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  tools: AiTool[];
  messages: AiMessageParam[];
  maxTokens: number;
  /** Aborted when someone stops the run. */
  signal?: AbortSignal;
  /** Web lookups allowed in this call (0 or undefined = no web tools). */
  web?: { searches: number; fetches: number };
  /** Ask the model to call this tool (used for docs and decks). */
  toolChoice?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
}

export interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface WebSource {
  title: string;
  url: string;
}

export interface ModelReply {
  content: ({ type: "text"; text: string } | ToolUse)[];
  /** The assistant turn as the provider returned it; send it back as is on the next call. */
  raw?: AiContentBlockParam[];
  /** "tool_use" when the model wants tool results, "max_tokens" when it was cut off, "pause_turn" to continue. */
  stopReason: string | null;
  usage: { input: number; output: number; webSearches?: number; webFetches?: number };
  /** Pages the model saw (search results, in order) and fetched. */
  webResults?: WebSource[];
  /** Pages the model cited or fetched directly (the strongest sources). */
  webCited?: WebSource[];
}

export interface ModelCaller {
  model: string;
  /** "model" for a real provider; "dev-script" for the test-mode stand-ins. */
  kind: "model" | "dev-script";
  /** True when this caller can search the web during a call. */
  webSearch?: boolean;
  call(req: ModelRequest): Promise<ModelReply>;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("The board AI isn't configured on this server. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env and restart.");
  }
}
