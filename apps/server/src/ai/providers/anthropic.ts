// Anthropic Messages API adapter. Uses prompt caching for the system prompt, tools and the (large) first user
// message, and the API's server-side web tools (web_search, web_fetch) when the run allows web lookups.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../lib/config";
import type { AiContentBlockParam, AiMessageParam, ModelCaller, ModelReply, ModelRequest, WebSource } from "../types";

const PROVIDER = "anthropic";
const WEB_FETCH_BETA = "web-fetch-2025-09-10";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: config.ai.anthropicKey, baseURL: config.ai.anthropicBaseUrl });
  return client;
}

type Block = Record<string, unknown>;

/** Converts neutral messages to Anthropic's format (which the neutral format mirrors, apart from provider items). */
function toMessages(messages: AiMessageParam[], cache: boolean): Block[] {
  return messages.map((m, i) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    let blocks: Block[];
    const own = m.role === "assistant" ? m.content.find((b) => b.type === "provider_items" && b.provider === PROVIDER) : undefined;
    if (own && own.type === "provider_items") {
      blocks = own.items as Block[];
    } else {
      blocks = m.content
        .filter((b): b is Exclude<AiContentBlockParam, { type: "provider_items" }> => b.type !== "provider_items")
        .map((b) => ({ ...b }) as Block);
    }
    // Cache the first user message: the board summary and attachments are re-sent on every loop turn.
    if (cache && i === 0 && m.role === "user" && blocks.length) {
      const last = blocks[blocks.length - 1]!;
      if (last.type === "text" || last.type === "image" || last.type === "document") {
        blocks = [...blocks.slice(0, -1), { ...last, cache_control: { type: "ephemeral" } }];
      }
    }
    return { role: m.role, content: blocks };
  });
}

function sourcesOf(blocks: Block[]): { results: WebSource[]; cited: WebSource[] } {
  const results: WebSource[] = [];
  const cited: WebSource[] = [];
  const add = (list: WebSource[], url: unknown, title: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return;
    list.push({ url, title: typeof title === "string" && title.trim() ? title.trim() : new URL(url).hostname });
  };
  for (const b of blocks as Record<string, any>[]) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.type === "web_search_result") add(results, r.url, r.title);
    } else if (b.type === "web_fetch_tool_result" && b.content?.type === "web_fetch_result") {
      add(results, b.content.url, b.content.content?.title);
      add(cited, b.content.url, b.content.content?.title);
    } else if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) add(cited, c?.url, c?.title);
    }
  }
  return { results, cited };
}

export function anthropicCaller(model: string): ModelCaller {
  // Some gateways and proxies reject prompt caching, web tools or forced tool choice; each is turned off after the
  // first rejection and the call is retried without it.
  let useCache = true;
  let useWeb = config.ai.webSearch;
  let useForcedTool = true;
  return {
    model,
    kind: "model",
    webSearch: config.ai.webSearch,
    async call(req: ModelRequest): Promise<ModelReply> {
      const anthropic = getClient();
      const create = (cache: boolean, web: boolean, forced: boolean) => {
        const serverTools: Block[] = [];
        if (web && req.web) {
          if (req.web.searches > 0) serverTools.push({ type: "web_search_20250305", name: "web_search", max_uses: req.web.searches });
          if (req.web.fetches > 0) serverTools.push({ type: "web_fetch_20250910", name: "web_fetch", max_uses: req.web.fetches, citations: { enabled: true } });
        }
        const tools = req.tools.map((t, i) => (cache && i === req.tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
        const system =
          req.toolChoice && !forced ? `${req.system}\n\nRespond only by calling the ${req.toolChoice} tool exactly once, with no other text.` : req.system;
        const params: Record<string, unknown> = {
          model,
          max_tokens: req.maxTokens,
          system: cache ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
          tools: [...serverTools, ...tools],
          messages: toMessages(req.messages, cache),
          ...(req.toolChoice ? { tool_choice: forced ? { type: "tool", name: req.toolChoice } : { type: "auto" } } : {}),
        };
        const opts = { timeout: req.timeoutMs ?? 180_000, signal: req.signal };
        if (serverTools.length)
          return anthropic.beta.messages.create({ ...params, betas: [WEB_FETCH_BETA] } as never, opts) as unknown as Promise<Anthropic.Message>;
        return anthropic.messages.create(params as never, opts) as unknown as Promise<Anthropic.Message>;
      };
      let res: Anthropic.Message | null = null;
      for (let attempt = 0; attempt < 4 && !res; attempt++) {
        try {
          res = await create(useCache, useWeb, useForcedTool);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (useCache && /cache_control/i.test(msg)) useCache = false;
          else if (useWeb && req.web && /web_search|web_fetch|beta|server tool|tool type/i.test(msg)) useWeb = false;
          else if (useForcedTool && req.toolChoice && /tool_choice/i.test(msg)) useForcedTool = false;
          else throw err;
        }
      }
      if (!res) throw new Error("The AI request failed.");
      const u = res.usage as Anthropic.Usage & { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null };
      const content: ModelReply["content"] = [];
      for (const b of res.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      const blocks = res.content as unknown as Block[];
      const { results, cited } = sourcesOf(blocks);
      return {
        content,
        raw: [{ type: "provider_items", provider: PROVIDER, items: blocks }, ...content],
        stopReason: res.stop_reason,
        usage: {
          input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          output: u.output_tokens ?? 0,
          webSearches: u.server_tool_use?.web_search_requests ?? 0,
          webFetches: u.server_tool_use?.web_fetch_requests ?? 0,
        },
        webResults: results,
        webCited: cited,
      };
    },
  };
}
