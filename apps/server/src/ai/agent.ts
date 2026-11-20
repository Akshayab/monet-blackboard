// The board AI agent loop: summarize the board, call the model with board tools until it replies, apply each
// tool call live, and report progress, the reply, and usage.
import { BOARD_LIMIT_MESSAGE, boardTitleFromPrompt } from "@monet/board-protocol";
import { aiMessagesTable, boardMembersTable, boardsTable, db, usersTable } from "@monet/db";
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { z } from "zod";
import type { AuthUser } from "../lib/auth";
import { getAiUsage, recordAiUsage } from "../lib/ai-limits";
import { logger } from "../lib/logger";
import { broadcastToBoard, collaboratorsOf, getBoardElements, getRoom, releaseRoomIfEmpty, setVirtualCollaborator } from "../realtime/rooms";
import type { AiRequestBody } from "../routes/ai";
import { postChatMessage } from "../routes/ai";
import { attachmentBlocks } from "./attachments";
import { AiNotConfiguredError, type AiContentBlockParam, type AiMessageParam, type ModelCaller, type WebSource } from "./types";
import { summarizeBoard } from "./context";
import { BLOCK_SHAPES } from "./builders";
import { BoardEditor, type ToolResult } from "./editor";
import { RunStoppedError, registerRun, throwIfStopped } from "./runs";
import type { Rect } from "./geometry";
import { systemPrompt } from "./prompt";
import { BOARD_TOOLS } from "./tools";

export const AI_COLOR = "#7048e8";
const MAX_TURNS = Number(process.env.AI_MAX_TURNS || 8);
const MAX_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 8192);
/** Stop looping once a single run has used this many tokens (input + output). */
const RUN_TOKEN_CAP = Number(process.env.AI_RUN_TOKEN_CAP || 250_000);

export interface AgentRun {
  boardId: string;
  runId: string;
  user: AuthUser;
  userName: string;
  request: z.infer<typeof AiRequestBody>;
  caller: ModelCaller;
  /** Releases the per-user concurrency slot (from reserveAi). */
  release: () => void;
  /** Stream in small chunks (default true). */
  pace?: boolean;
  /** The share link the request came with (to re-check access if sharing changes mid-run). */
  linkToken?: string | null;
}

function arr<T = Record<string, unknown>>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => x !== null && x !== undefined) as T[]) : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Dispatches one tool call to the editor. */
export async function executeTool(editor: BoardEditor, name: string, raw: unknown): Promise<ToolResult> {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const place = { section: str(input.section), near: str(input.near), side: str(input.side) as "right" | undefined };
  const layout = str(input.layout) as "grid" | undefined;
  const columns = typeof input.columns === "number" ? input.columns : undefined;
  switch (name) {
    case "add_sections":
      return editor.addSections({
        sections: arr(input.sections).map((s) => ({ ...s, items: arr(s.items) })) as never,
        arrangement: str(input.arrangement) as "auto" | undefined,
        connections: arr(input.connections) as never,
        near: place.near,
        side: place.side,
      });
    case "add_stickies":
      return editor.addItems({ items: arr(input.stickies) as never, defaultKind: "sticky", layout, columns, ...place });
    case "add_shapes":
      return editor.addItems({
        items: arr(input.shapes).map((s) => ({
          ...s,
          kind: (BLOCK_SHAPES as string[]).includes(String(s.shape)) || s.shape === "rectangle" ? s.shape : "rounded",
        })) as never,
        defaultKind: "rectangle",
        layout: layout ?? "row",
        columns,
        connect_in_order: input.connect_in_order === true,
        ...place,
      });
    case "add_text":
      return editor.addText({
        text: String(input.text ?? ""),
        size: str(input.size) as "body" | undefined,
        subtitle: str(input.subtitle),
        color: str(input.color),
        link: str(input.link),
        ref: str(input.ref),
        ...place,
      });
    case "add_card":
      return editor.addCard({
        title: str(input.title),
        body: String(input.body ?? ""),
        color: str(input.color),
        wide: input.wide === true,
        ref: str(input.ref),
        ...place,
      });
    case "connect":
      return editor.connect({ connections: arr(input.connections) as never });
    case "add_timeline":
      return editor.addTimeline({
        title: String(input.title ?? "Timeline"),
        ref: str(input.ref),
        lanes: arr(input.lanes) as never,
        milestones: arr(input.milestones) as never,
        near: place.near,
        side: place.side,
      });
    case "add_chart":
      return editor.addChart({
        title: String(input.title ?? "Chart"),
        kind: input.kind === "line" ? "line" : "bar",
        labels: arr<string>(input.labels).map(String),
        series: arr(input.series).map((s) => ({ name: String(s.name ?? ""), values: arr<number>(s.values), color: str(s.color) })),
        unit: str(input.unit),
        y_label: str(input.y_label),
        caption: str(input.caption),
        ref: str(input.ref),
        ...place,
      });
    case "add_table":
      return editor.addTable({
        title: str(input.title),
        columns: arr<unknown>(input.columns).map((c) => String(c ?? "")),
        rows: arr<unknown>(input.rows).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [String(r ?? "")])),
        ref: str(input.ref),
        ...place,
      });
    case "add_stat_cards":
      return editor.addStatCards({
        cards: arr(input.cards).map((c) => ({ ...c, value: String(c.value ?? ""), label: String(c.label ?? "") })) as never,
        title: str(input.title),
        ...place,
      });
    case "add_suggestions":
      return editor.addSuggestions({ suggestions: arr(input.suggestions) as never });
    case "update_elements":
      return editor.updateElements({ updates: arr(input.updates) as never });
    case "move_elements":
      return editor.moveElements({
        ids: arr<string>(input.ids).map(String),
        dx: typeof input.dx === "number" ? input.dx : undefined,
        dy: typeof input.dy === "number" ? input.dy : undefined,
        into_section: str(input.into_section),
        near: place.near,
        side: place.side,
      });
    case "delete_elements":
      return editor.deleteElements({ ids: arr<string>(input.ids).map(String), keep_section_contents: input.keep_section_contents === true });
    case "regroup":
      return editor.regroup({
        groups: arr(input.groups).map((g) => ({ ...g, name: String(g.name ?? "Group"), ids: arr<string>(g.ids).map(String) })) as never,
        arrangement: str(input.arrangement) as "auto" | undefined,
        remove_empty_sections: input.remove_empty_sections !== false,
        near: place.near,
        side: place.side,
      });
    case "arrange":
      return editor.arrange({ ids: arr<string>(input.ids).map(String), section: str(input.section), layout, columns, order: str(input.order) });
    case "cleanup_layout":
      return editor.cleanupLayout({ ids: arr<string>(input.ids).map(String), section: str(input.section) });
    case "add_illustration":
      return editor.addIllustration({ subject: String(input.subject ?? ""), style: str(input.style), size: str(input.size), ref: str(input.ref), ...place });
    case "add_live_embed":
      return editor.addLiveEmbed({
        kind: String(input.kind ?? ""),
        title: str(input.title),
        question: str(input.question),
        options: arr<unknown>(input.options).map((o) => String(o ?? "")),
        minutes: typeof input.minutes === "number" ? input.minutes : undefined,
        html: typeof input.html === "string" ? input.html : undefined,
        width: typeof input.width === "number" ? input.width : undefined,
        height: typeof input.height === "number" ? input.height : undefined,
        ref: str(input.ref),
        ...place,
      });
    default:
      return { ok: false, error: `Unknown tool ${name}.` };
  }
}

async function boardPeople(boardId: string): Promise<{ name: string; online: boolean }[]> {
  const [board] = await db.select({ ownerId: boardsTable.ownerId }).from(boardsTable).where(eq(boardsTable.id, boardId));
  const members = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName })
    .from(boardMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, boardMembersTable.userId))
    .where(and(eq(boardMembersTable.boardId, boardId), notInArray(boardMembersTable.source, ["removed", "left"])))
    .limit(50);
  const owner = board
    ? await db.select({ id: usersTable.id, displayName: usersTable.displayName }).from(usersTable).where(eq(usersTable.id, board.ownerId))
    : [];
  const room = await getRoom(boardId);
  const online = new Set(
    collaboratorsOf(room)
      .filter((c) => !c.isAI)
      .map((c) => c.userId),
  );
  const people = new Map<string, { name: string; online: boolean }>();
  for (const u of [...owner, ...members]) people.set(u.id, { name: u.displayName || "Someone", online: online.has(u.id) });
  return [...people.values()].slice(0, 30);
}

async function recentConversation(boardId: string, runId: string): Promise<string> {
  const rows = await db.select().from(aiMessagesTable).where(eq(aiMessagesTable.boardId, boardId)).orderBy(desc(aiMessagesTable.createdAt)).limit(12);
  const lines = rows
    .filter((r) => (r.meta as Record<string, unknown> | null)?.runId !== runId)
    .slice(0, 10)
    .reverse()
    .map((r) => `${r.role === "user" ? "User" : "You"}: ${r.content.replace(/\s+/g, " ").slice(0, 300)}`);
  return lines.length ? `## Recent conversation on this board\n${lines.join("\n")}` : "";
}

function friendlyError(err: unknown): string {
  if (err instanceof AiNotConfiguredError) return err.message;
  const status = (err as { status?: number })?.status;
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 429 || status === 529 || /overloaded|rate limit/i.test(msg)) return "The AI is busy right now. Please try again in a minute.";
  if (status === 413 || /too long|too large|context/i.test(msg))
    return "That was too much for me to read at once. Try a smaller selection or fewer attachments.";
  return "Something went wrong while I was working on the board. Please try again.";
}

function defaultReply(s: { created: number; updated: number; deleted: number }) {
  const parts: string[] = [];
  if (s.created) parts.push(`added ${s.created} item${s.created === 1 ? "" : "s"}`);
  if (s.updated) parts.push(`updated ${s.updated}`);
  if (s.deleted) parts.push(`removed ${s.deleted}`);
  return parts.length ? `Done — I ${parts.join(", ")}.` : "I didn't change the board this time.";
}

const WEB_SEARCHES = 5;
/** Longest chat reply kept from the model. */
export const MAX_REPLY_CHARS = 8000;
const WEB_FETCHES = 3;

/**
 * Board handles (e12, s3, a2, k1, b4) and refs are internal; replies sometimes cite them anyway ("the selected sticky
 * (e1)"). Removes parenthesized handle lists and "handle e3"-style mentions, leaving the words around them.
 */
export function stripHandles(text: string): string {
  const H = "[esakbw]\\d{1,4}";
  return text
    .replace(new RegExp(`\\s*\\((?:handles?\\s+)?${H}(?:\\s*(?:,|and|&)\\s*${H})*\\)`, "g"), "")
    .replace(new RegExp(`\\b(handles?|refs?)\\s+${H}((?:\\s*(?:,|and)\\s*${H})*)`, "gi"), (_m, word: string, more: string) =>
      /s$/i.test(word) || more ? "them" : "it",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
}

/** Removes the <cite index="…"> markers the model puts around cited text in tool inputs. */
export function stripCiteTags(text: string): string {
  return text
    .replace(/<\/?cite\b[^>]*>/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mdText(s: string): string {
  return s.replace(/[[\]]/g, "").slice(0, 80);
}

/**
 * A board started from a prompt gets a provisional title cut from that prompt. When the AI draws a title-size
 * heading on it, that heading names the board better ("Orbit smart notebook: launch plan" instead of the first 60
 * characters of the request). Only the provisional title is replaced, never one a person chose.
 */
async function adoptAiTitle(boardId: string, prompt: string, createdIds: Set<string>): Promise<void> {
  if (!createdIds.size) return;
  const [board] = await db.select({ title: boardsTable.title }).from(boardsTable).where(eq(boardsTable.id, boardId));
  if (!board || board.title !== boardTitleFromPrompt(prompt)) return;
  const els = await getBoardElements(boardId);
  // The board's own heading: a large free-standing text this run drew outside any section (section headings,
  // subtitles, table and chart parts don't name the board). Largest first, then topmost.
  const heading = els
    .filter((e) => {
      if (!createdIds.has(e.id) || e.type !== "text" || e.isDeleted || e.containerId || e.frameId) return false;
      const c = (e.customData ?? {}) as Record<string, unknown>;
      if (c.sectionHeading || c.sectionSubtitle || c.subtitleOf || c.aiKind || c.cardPart) return false;
      return Number(e.fontSize) >= 24;
    })
    .sort((a, b) => Number(b.fontSize) - Number(a.fontSize) || Number(a.y) - Number(b.y))[0];
  const text = String(heading?.originalText ?? heading?.text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return;
  const title = boardTitleFromPrompt(text, 120);
  await db.update(boardsTable).set({ title }).where(eq(boardsTable.id, boardId));
  broadcastToBoard(boardId, { t: "board", title });
}

/**
 * The run's sources, deduplicated: pages linked in the reply, then pages cited or fetched, then (only if nothing
 * else) the top search results. At most 6.
 */
export function pickSources(reply: string, cited: WebSource[], results: WebSource[]): WebSource[] {
  const seen = new Map<string, WebSource>();
  const key = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  const known = new Map([...results, ...cited].map((s) => [key(s.url), s]));
  for (const m of reply.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const k = key(m[2]!);
    if (!seen.has(k)) seen.set(k, { title: known.get(k)?.title ?? m[1]!, url: m[2]! });
  }
  for (const s of cited) if (!seen.has(key(s.url))) seen.set(key(s.url), s);
  if (!seen.size) for (const s of results.slice(0, 4)) if (!seen.has(key(s.url))) seen.set(key(s.url), s);
  return [...seen.values()].slice(0, 6);
}

export async function runAgent(run: AgentRun): Promise<void> {
  const { boardId, runId, user, request, caller } = run;
  const socketId = `ai-${runId}`;
  const mode = request.mode ?? "chat";
  const { signal, finish } = registerRun(boardId, runId, user.id, run.linkToken ?? null);
  const status = (s: "thinking" | "drawing" | "done" | "error", message?: string, region?: Rect | null) => {
    if (signal.aborted && s !== "error") return;
    broadcastToBoard(boardId, {
      t: "ai",
      runId,
      status: s,
      message,
      userId: user.id,
      ...(region ? { region: { x: Math.round(region.x), y: Math.round(region.y), width: Math.round(region.w), height: Math.round(region.h) } } : {}),
    });
  };
  const usage = { input: 0, output: 0, web: 0 };
  let ok = true;
  let editor: BoardEditor | null = null;
  try {
    status("thinking", mode === "live" ? "Listening…" : "Reading the board…");
    await setVirtualCollaborator(boardId, { socketId, userId: "ai", name: "Monet AI", color: AI_COLOR, role: "editor", isAI: true }, socketId);
    const [elements, people, history] = await Promise.all([getBoardElements(boardId), boardPeople(boardId), recentConversation(boardId, runId)]);
    const viewport = request.viewport ? { x: request.viewport.x, y: request.viewport.y, w: request.viewport.width, h: request.viewport.height } : null;
    const summary = summarizeBoard(elements, { focusIds: request.focusElementIds, viewport, people });
    editor = new BoardEditor(boardId, runId, summary.index, {
      viewport,
      focusRect: summary.focusRect,
      live: mode === "live",
      pace: run.pace !== false,
      onDrawing: (m, region) => status("drawing", m, region),
      signal,
    });
    // Tell clients where the AI will most likely work, so they can outline that area while it thinks.
    const estimate = await editor.estimateRegion().catch(() => null);
    status("thinking", mode === "live" ? "Listening…" : "Pondering…", estimate);
    const start = summary.focusRect ?? viewport;
    if (start) editor.movePointer(start.x + start.w / 2, start.y + start.h / 2);

    const { blocks, skipped } = attachmentBlocks(request.attachments, request.snapshot);
    const request_ = [
      mode === "live" ? "## Live meeting transcript (latest chunk)" : "## Request",
      request.prompt,
      skipped.length ? `\n(Couldn't read: ${skipped.join(", ")}.)` : "",
    ].join("\n");
    const content: AiContentBlockParam[] = [...blocks, { type: "text", text: [history, summary.text, request_].filter(Boolean).join("\n\n") }];
    const messages: AiMessageParam[] = [{ role: "user", content }];
    // Web access: up to WEB_SEARCHES searches and WEB_FETCHES page fetches per run, within the user's daily cap.
    let webLeft = 0;
    if (caller.kind === "model" && caller.webSearch && mode !== "live") {
      const u = await getAiUsage(user.id).catch(() => null);
      webLeft = u ? Math.max(0, u.searchLimit - u.searchesUsed) : 0;
    }
    let searchesLeft = Math.min(WEB_SEARCHES, webLeft);
    let fetchesLeft = Math.min(WEB_FETCHES, webLeft);
    const webResults: WebSource[] = [];
    const webCited: WebSource[] = [];
    const system = systemPrompt({ now: new Date(), mode, web: searchesLeft > 0 });
    let reply = "";
    let lastText = "";
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      throwIfStopped(signal);
      if (turn > 0) status("thinking", "Working…", editor.region ?? estimate);
      const web =
        searchesLeft + fetchesLeft > 0 && webLeft > 0 ? { searches: Math.min(searchesLeft, webLeft), fetches: Math.min(fetchesLeft, webLeft) } : undefined;
      const res = await caller.call({ system, tools: BOARD_TOOLS, messages, maxTokens: MAX_TOKENS, signal, web });
      throwIfStopped(signal);
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      const looked = (res.usage.webSearches ?? 0) + (res.usage.webFetches ?? 0);
      if (looked) {
        usage.web += looked;
        webLeft = Math.max(0, webLeft - looked);
        searchesLeft = Math.max(0, searchesLeft - (res.usage.webSearches ?? 0));
        fetchesLeft = Math.max(0, fetchesLeft - (res.usage.webFetches ?? 0));
        status("thinking", `Searched the web (${usage.web})`, editor.region ?? estimate);
      }
      webResults.push(...(res.webResults ?? []));
      webCited.push(...(res.webCited ?? []));
      // Send the turn back exactly as returned: server tool blocks (web search/fetch) are part of it.
      messages.push({
        role: "assistant",
        content:
          res.raw ??
          res.content.map((b): AiContentBlockParam =>
            b.type === "text"
              ? { type: "text" as const, text: b.text }
              : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input as Record<string, unknown> },
          ),
      });
      const text = res.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) lastText = text;
      const uses = res.content.filter((b) => b.type === "tool_use");
      // A long server-side (web) turn can pause; continuing means calling again with the turn as is.
      if (!uses.length && res.stopReason === "pause_turn") continue;
      if (!uses.length) break;
      const results: AiContentBlockParam[] = [];
      let finished = false;
      for (const u of uses) {
        if (u.type !== "tool_use") continue;
        if (u.name === "reply") {
          reply = String((u.input as { message?: unknown })?.message ?? "").trim();
          finished = true;
          results.push({ type: "tool_result", tool_use_id: u.id, content: "Sent." });
          continue;
        }
        throwIfStopped(signal);
        try {
          const r = await executeTool(editor, u.name, u.input);
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r).slice(0, 8000), is_error: r.ok === false });
        } catch (err) {
          if (signal.aborted) throw err;
          logger.warn({ err, tool: u.name, boardId, runId }, "board AI tool failed");
          results.push({ type: "tool_result", tool_use_id: u.id, content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true });
        }
      }
      if (finished) break;
      // Over the per-run token cap: no further paid calls (the reply falls back to the last text or a summary).
      if (usage.input + usage.output > RUN_TOKEN_CAP) break;
      if (turn >= MAX_TURNS - 2) results.push({ type: "text", text: "Wrap up now: call reply with your message." });
      messages.push({ role: "user", content: results });
      if (res.stopReason !== "tool_use" && res.stopReason !== null) break;
    }
    throwIfStopped(signal);
    if (!reply) reply = lastText || defaultReply(editor.summary());
    // Chat replies are short; capping first keeps the cleanup regexes below linear in practice.
    if (reply.length > MAX_REPLY_CHARS) reply = `${reply.slice(0, MAX_REPLY_CHARS).trimEnd()}…`;
    reply = stripHandles(stripCiteTags(reply));
    if (editor.limitHit && !/limit|full/i.test(reply)) reply = `${reply}\n\n${BOARD_LIMIT_MESSAGE}`.trim();
    if (editor.lockedSkipped && !/lock/i.test(reply))
      reply =
        `${reply}\n\n${editor.lockedSkipped === 1 ? "One locked item was" : `${editor.lockedSkipped} locked items were`} left as they are. Unlock them if you want me to change them.`.trim();
    const sources = usage.web ? pickSources(reply, webCited, webResults) : [];
    if (sources.length && !/\]\(https?:\/\//.test(reply))
      reply = `${reply}\n\nSources: ${sources
        .slice(0, 4)
        .map((s) => `[${mdText(s.title)}](${s.url})`)
        .join(" · ")}`;
    const stats = editor.summary();
    if (mode !== "live")
      await adoptAiTitle(boardId, request.prompt, editor.created).catch((e) => logger.warn({ err: e, boardId }, "board title from AI heading failed"));
    status("done", reply);
    await postChatMessage(boardId, "assistant", reply, null, {
      runId,
      mode,
      model: caller.model,
      ...stats,
      ...(usage.web ? { webLookups: usage.web } : {}),
      ...(sources.length ? { sources } : {}),
      ...(editor.limitHit ? { boardFull: true } : {}),
      elementIds: [...editor.created].slice(0, 500),
    });
  } catch (err) {
    if (signal.aborted) {
      // Stopped by someone on the board: keep what was drawn, tell every client, and record it in the chat.
      const stoppedBy = signal.reason instanceof RunStoppedError ? signal.reason.stoppedBy : null;
      const stats = editor?.summary() ?? { created: 0, updated: 0, deleted: 0 };
      broadcastToBoard(boardId, { t: "ai", runId, status: "stopped", message: "Stopped.", userId: user.id, ...(stoppedBy ? { stoppedBy } : {}) });
      await postChatMessage(boardId, "assistant", "Stopped.", null, {
        runId,
        mode,
        model: caller.model,
        stopped: true,
        stoppedBy,
        ...stats,
        elementIds: editor ? [...editor.created].slice(0, 500) : [],
      }).catch((e) => logger.error({ err: e, boardId, runId }, "failed to record stopped AI run"));
    } else {
      ok = false;
      logger.error({ err, boardId, runId }, "board AI run failed");
      const msg = friendlyError(err);
      status("error", msg);
      await postChatMessage(boardId, "assistant", msg, null, { runId, error: true }).catch(() => undefined);
    }
  } finally {
    editor?.release();
    await setVirtualCollaborator(boardId, null, socketId).catch(() => undefined);
    run.release();
    await recordAiUsage({
      userId: user.id,
      boardId,
      kind: caller.kind === "dev-script" ? "board-dev-script" : mode === "live" ? "board-live" : "board-chat",
      model: caller.model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      webSearches: usage.web,
      ok,
    }).catch((err) => logger.error({ err }, "failed to record AI usage"));
    const room = await getRoom(boardId).catch(() => null);
    if (room) releaseRoomIfEmpty(room);
    finish();
  }
}
