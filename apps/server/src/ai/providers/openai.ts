// OpenAI adapters.
//
// openaiCaller: the Responses API (current OpenAI models only support tools with reasoning there). Web lookups use
// OpenAI's built-in web_search tool. Reasoning items come back encrypted (store: false) and are sent back unchanged.
//
// chatCompletionsCaller: the Chat Completions API, for OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, LiteLLM,
// OpenRouter and similar). No server-side web search; PDFs are skipped (their text is sent when the browser
// extracted it).
import OpenAI from "openai";
import { config } from "../../lib/config";
import type { AiContentBlockParam, AiMessageParam, AiTool, ModelCaller, ModelReply, ModelRequest, WebSource } from "../types";

const PROVIDER = "openai";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  client ??= new OpenAI({ apiKey: config.ai.openaiKey || "not-needed", baseURL: config.ai.openaiBaseUrl, maxRetries: 2 });
  return client;
}

type Item = Record<string, unknown>;

function textOf(content: AiMessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

// ---------- Responses API ----------

function toInput(messages: AiMessageParam[]): Item[] {
  const input: Item[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      input.push({ role: m.role, content: m.content || "(empty)" });
      continue;
    }
    if (m.role === "assistant") {
      const own = m.content.find((b) => b.type === "provider_items" && b.provider === PROVIDER);
      if (own && own.type === "provider_items") {
        input.push(...(own.items as Item[]));
        continue;
      }
      const text = textOf(m.content);
      if (text) input.push({ role: "assistant", content: text });
      for (const b of m.content) {
        if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    // User turn: tool results become function_call_output items; everything else is one user message.
    const parts: Item[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content || "(empty)" });
      else if (b.type === "text") parts.push({ type: "input_text", text: b.text });
      else if (b.type === "image") parts.push({ type: "input_image", image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      else if (b.type === "document")
        parts.push({
          type: "input_file",
          filename: `${(b.title || "document").replace(/[^\w. -]/g, "_").slice(0, 80)}.pdf`,
          file_data: `data:application/pdf;base64,${b.source.data}`,
        });
    }
    if (parts.length) input.push({ role: "user", content: parts });
  }
  return input;
}

const toTools = (tools: AiTool[]) =>
  tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));

function sourcesOf(output: Item[]): { results: WebSource[]; cited: WebSource[]; searches: number } {
  const results: WebSource[] = [];
  const cited: WebSource[] = [];
  let searches = 0;
  const add = (list: WebSource[], url: unknown, title: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return;
    list.push({ url, title: typeof title === "string" && title.trim() ? title.trim() : new URL(url).hostname });
  };
  for (const it of output as Record<string, any>[]) {
    if (it.type === "web_search_call") {
      searches++;
      for (const s of it.action?.sources ?? []) add(results, s?.url, s?.title);
    } else if (it.type === "message") {
      for (const c of it.content ?? []) for (const a of c.annotations ?? []) if (a?.type === "url_citation") add(cited, a.url, a.title);
    }
  }
  return { results, cited, searches };
}

/**
 * OpenAI's web search writes inline citation markers into the text, wrapped in private-use characters
 * (U+E200 "cite" U+E202 "turn0search2" U+E201). The sources come from the annotations, so drop the markers.
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(/[ \t]*\uE200[^\uE201]*\uE201/g, "").replace(/[\uE200-\uE202]/g, "");
}

// Tool-call arguments (the reply tool's message, text written to the board) carry the same markers.
function stripCitationMarkersDeep(value: unknown): unknown {
  if (typeof value === "string") return stripCitationMarkers(value);
  if (Array.isArray(value)) return value.map(stripCitationMarkersDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripCitationMarkersDeep(v)]));
  return value;
}

export function openaiCaller(model: string): ModelCaller {
  let useForcedTool = true;
  let useReasoning = true;
  let useWeb = config.ai.webSearch;
  return {
    model,
    kind: "model",
    webSearch: config.ai.webSearch,
    async call(req: ModelRequest): Promise<ModelReply> {
      const openai = getClient();
      const create = () => {
        const tools: Item[] = toTools(req.tools);
        const web = useWeb && req.web && req.web.searches > 0;
        if (web) tools.unshift({ type: "web_search" });
        const instructions =
          req.toolChoice && !useForcedTool
            ? `${req.system}\n\nRespond only by calling the ${req.toolChoice} tool exactly once, with no other text.`
            : req.system;
        const params: Item = {
          model,
          instructions,
          input: toInput(req.messages),
          tools,
          store: false,
          max_output_tokens: req.maxTokens,
          ...(useReasoning
            ? { reasoning: { effort: config.ai.reasoningEffort }, include: ["reasoning.encrypted_content", ...(web ? ["web_search_call.action.sources"] : [])] }
            : {}),
          ...(web ? { max_tool_calls: Math.max(1, req.web!.searches + req.tools.length * 4) } : {}),
          ...(req.toolChoice && useForcedTool ? { tool_choice: { type: "function", name: req.toolChoice } } : {}),
        };
        return openai.responses.create(params as never, { timeout: req.timeoutMs ?? 180_000, signal: req.signal }) as unknown as Promise<Item>;
      };
      let res: Item | null = null;
      for (let attempt = 0; attempt < 4 && !res; attempt++) {
        try {
          res = await create();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (useForcedTool && req.toolChoice && /tool_choice/i.test(msg)) useForcedTool = false;
          else if (useReasoning && /reasoning|encrypted_content|include/i.test(msg)) useReasoning = false;
          else if (useWeb && req.web && /web_search|max_tool_calls|tool type/i.test(msg)) useWeb = false;
          else throw err;
        }
      }
      if (!res) throw new Error("The AI request failed.");
      if (res.status === "failed") throw new Error((res.error as { message?: string } | null)?.message ?? "The AI request failed.");
      const output = (res.output as Item[] | undefined) ?? [];
      const content: ModelReply["content"] = [];
      for (const it of output as Record<string, any>[]) {
        if (it.type === "message") {
          const text = stripCitationMarkers(
            (it.content ?? []).map((c: Record<string, unknown>) => (c.type === "output_text" ? String(c.text ?? "") : "")).join(""),
          );
          if (text.trim()) content.push({ type: "text", text });
        } else if (it.type === "function_call") {
          let input: unknown = {};
          try {
            input = stripCitationMarkersDeep(JSON.parse(it.arguments || "{}"));
          } catch {
            input = { _invalid_json: String(it.arguments ?? "").slice(0, 2000) };
          }
          content.push({ type: "tool_use", id: String(it.call_id), name: String(it.name), input });
        }
      }
      const { results, cited, searches } = sourcesOf(output);
      const usage = (res.usage as { input_tokens?: number; output_tokens?: number } | undefined) ?? {};
      const incomplete = res.status === "incomplete";
      const hasTools = content.some((b) => b.type === "tool_use");
      return {
        content,
        raw: [{ type: "provider_items", provider: PROVIDER, items: output }, ...content],
        stopReason: hasTools ? "tool_use" : incomplete ? "max_tokens" : "end_turn",
        usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, webSearches: searches, webFetches: 0 },
        webResults: results,
        webCited: cited,
      };
    },
  };
}

// ---------- Chat Completions (OpenAI-compatible endpoints) ----------

function toChatMessages(system: string, messages: AiMessageParam[]): Item[] {
  const out: Item[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = m.content.filter((b): b is Exclude<AiContentBlockParam, { type: "provider_items" }> => b.type !== "provider_items");
      const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => (b.type === "tool_use" ? { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } } : null));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const parts: Item[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content || "(empty)" });
      else if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      else if (b.type === "document")
        parts.push({ type: "text", text: `(A PDF named "${b.title ?? "document"}" was attached, but this model can't read PDFs.)` });
    }
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

export function chatCompletionsCaller(model: string): ModelCaller {
  let useForcedTool = true;
  let useImages = true;
  // Local servers (Ollama, vLLM, LM Studio) take max_tokens; OpenAI's newer models only take max_completion_tokens.
  let tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens";
  return {
    model,
    kind: "model",
    webSearch: false,
    async call(req: ModelRequest): Promise<ModelReply> {
      const openai = getClient();
      const create = () => {
        let messages = toChatMessages(
          req.toolChoice && !useForcedTool
            ? `${req.system}\n\nRespond only by calling the ${req.toolChoice} tool exactly once, with no other text.`
            : req.system,
          req.messages,
        );
        if (!useImages) {
          messages = messages.map((m) =>
            Array.isArray(m.content)
              ? {
                  ...m,
                  content: (m.content as Item[]).map((p) =>
                    p.type === "image_url" ? { type: "text", text: "(An image was attached, but this model can't see images.)" } : p,
                  ),
                }
              : m,
          );
        }
        const params: Item = {
          model,
          messages,
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
          [tokenParam]: req.maxTokens,
          ...(req.toolChoice && useForcedTool ? { tool_choice: { type: "function", function: { name: req.toolChoice } } } : {}),
        };
        return openai.chat.completions.create(params as never, { timeout: req.timeoutMs ?? 300_000, signal: req.signal }) as unknown as Promise<Item>;
      };
      let res: Item | null = null;
      for (let attempt = 0; attempt < 4 && !res; attempt++) {
        try {
          res = await create();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (tokenParam === "max_tokens" && /max_completion_tokens/i.test(msg)) tokenParam = "max_completion_tokens";
          else if (useForcedTool && req.toolChoice && /tool_choice/i.test(msg)) useForcedTool = false;
          else if (useImages && /image/i.test(msg)) useImages = false;
          else throw err;
        }
      }
      if (!res) throw new Error("The AI request failed.");
      const choice = ((res.choices as Record<string, any>[] | undefined) ?? [])[0];
      const msg = choice?.message ?? {};
      const content: ModelReply["content"] = [];
      if (typeof msg.content === "string" && msg.content.trim()) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          input = { _invalid_json: String(tc.function?.arguments ?? "").slice(0, 2000) };
        }
        content.push({ type: "tool_use", id: String(tc.id || `call_${content.length}`), name: String(tc.function?.name ?? ""), input });
      }
      const usage = (res.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined) ?? {};
      const hasTools = content.some((b) => b.type === "tool_use");
      return {
        content,
        raw: content,
        stopReason: hasTools ? "tool_use" : choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
        usage: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 },
      };
    },
  };
}
