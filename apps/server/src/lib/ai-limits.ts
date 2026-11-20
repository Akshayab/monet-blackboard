// AI usage limits. Every AI call made for a person goes through these checks, so a shared (team mode) server can't
// run up the owner's model bill, and a runaway loop can't either.
//
// Every AI call made for a user goes through reserveAi() -> release() in finally -> recordAiUsage().
// reserveAi() enforces, in order:
//   1. AI_DISABLED kill switch (hard off)
//   2. for guests, one shared daily pool for all guests together (AI_GUEST_POOL_DAILY_*). Making new guest
//      identities can't get around it, and it never touches the owner's own allowance.
//   3. per-person daily requests and tokens (rolling 24 hours; in-flight runs count as requests). The owner has
//      roomy limits (AI_OWNER_DAILY_*); each guest also has the smaller AI_DAILY_* limits.
//   4. per-user concurrent runs
//   5. per-board concurrent runs (board id passed in, or taken from the request URL)
//   6. per-IP hourly runs for guests (IP passed in, or taken from the request), so many guests on one network
//      can't multiply the per-person allowance.
// Budgets 1-3 come from the database, so they hold across server instances; 4-6 are per instance.
// AI_USAGE_RESET_AT (an ISO time) resets budgets 2-3 for everyone: usage recorded before it no longer counts.
import { aiUsageTable, db } from "@monet/db";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { currentRequestContext } from "./request-context";
import { envInt, isDevEnv, minutesText, RateLimiter } from "./rate-limiter";
import { OWNER_ID } from "./auth";

/** Per guest (team mode), per rolling 24 hours. */
export const DAILY_REQUEST_LIMIT = envInt("AI_DAILY_REQUEST_LIMIT", 40);
export const DAILY_TOKEN_LIMIT = envInt("AI_DAILY_TOKEN_LIMIT", 600_000);
/** Web searches + page fetches per person per rolling 24 h (the AI simply works without the web past it). */
export const DAILY_SEARCH_LIMIT = envInt("AI_DAILY_SEARCH_LIMIT", 30);
/** The owner's own limits (live meeting mode sends a request every few sentences, so these are roomy). */
export const OWNER_DAILY_REQUEST_LIMIT = envInt("AI_OWNER_DAILY_REQUEST_LIMIT", 1000);
export const OWNER_DAILY_TOKEN_LIMIT = envInt("AI_OWNER_DAILY_TOKEN_LIMIT", 5_000_000);
export const OWNER_DAILY_SEARCH_LIMIT = envInt("AI_OWNER_DAILY_SEARCH_LIMIT", 100);

function limitsFor(userId: string) {
  return userId === OWNER_ID
    ? { requests: OWNER_DAILY_REQUEST_LIMIT, tokens: OWNER_DAILY_TOKEN_LIMIT, searches: OWNER_DAILY_SEARCH_LIMIT }
    : { requests: DAILY_REQUEST_LIMIT, tokens: DAILY_TOKEN_LIMIT, searches: DAILY_SEARCH_LIMIT };
}
/** Max concurrent AI runs per guest, and for the owner (who may have several boards working at once). */
export const CONCURRENT_LIMIT = envInt("AI_CONCURRENT_LIMIT", 2);
export const OWNER_CONCURRENT_LIMIT = envInt("AI_OWNER_CONCURRENT_LIMIT", 4);
/** Max concurrent AI runs per board (all users together). */
export const BOARD_CONCURRENT_LIMIT = envInt("AI_BOARD_CONCURRENT_LIMIT", 2);
/** Max AI runs per client IP per hour (0 disables). */
// Development servers (one IP for the whole test suite) get a generous per-network limit; per-user limits are unchanged.
export const IP_HOURLY_LIMIT = envInt("AI_IP_HOURLY_LIMIT", isDevEnv() ? 1000 : 60);
/** All guests together, per rolling 24 hours (0 disables that part of the pool). The owner's allowance is separate. */
export const GUEST_POOL_DAILY_TOKEN_LIMIT = envInt("AI_GUEST_POOL_DAILY_TOKEN_LIMIT", 3_000_000);
export const GUEST_POOL_DAILY_REQUEST_LIMIT = envInt("AI_GUEST_POOL_DAILY_REQUEST_LIMIT", 300);
const WINDOW_MS = 24 * 60 * 60 * 1000;
const GLOBAL_CACHE_MS = 15_000;

/** Start of the usage window: the last 24 hours, or since AI_USAGE_RESET_AT when that is later. */
function windowStart(): Date {
  const since = Date.now() - WINDOW_MS;
  const reset = Date.parse(process.env.AI_USAGE_RESET_AT ?? "");
  return new Date(Number.isFinite(reset) ? Math.max(since, reset) : since);
}

function aiDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.AI_DISABLED ?? "");
}

const running = new Map<string, number>();
const runningByBoard = new Map<string, number>();
const ipLimiter = new RateLimiter("ai-ip", IP_HOURLY_LIMIT, 60 * 60 * 1000);

let guestPoolCache: { tokens: number; requests: number; at: number } | null = null;

/** What all guests together used in the window (everyone but the owner). Cached briefly. */
async function getGuestPoolUsed(): Promise<{ tokens: number; requests: number }> {
  if (guestPoolCache && Date.now() - guestPoolCache.at < GLOBAL_CACHE_MS) return guestPoolCache;
  const [row] = await db
    .select({
      tokens: sql<number>`coalesce(sum(${aiUsageTable.inputTokens} + ${aiUsageTable.outputTokens}), 0)::bigint`,
      requests: sql<number>`count(*)::int`,
    })
    .from(aiUsageTable)
    .where(and(gte(aiUsageTable.createdAt, windowStart()), ne(aiUsageTable.userId, OWNER_ID)));
  guestPoolCache = { tokens: Number(row?.tokens ?? 0), requests: Number(row?.requests ?? 0), at: Date.now() };
  return guestPoolCache;
}

/** True when the guests' shared pool is used up, counting guest runs in flight as requests. */
export function guestPoolFull(used: { tokens: number; requests: number }, inFlight: number): boolean {
  return (
    (GUEST_POOL_DAILY_TOKEN_LIMIT > 0 && used.tokens >= GUEST_POOL_DAILY_TOKEN_LIMIT) ||
    (GUEST_POOL_DAILY_REQUEST_LIMIT > 0 && used.requests + inFlight >= GUEST_POOL_DAILY_REQUEST_LIMIT)
  );
}

function guestRunsInFlight(): number {
  let n = 0;
  for (const [userId, count] of running) if (userId !== OWNER_ID) n += count;
  return n;
}

/**
 * Why the AI is unavailable to this person right now, or null: the kill switch (everyone), or, for guests, the
 * guests' shared daily pool. The owner's allowance never depends on what guests used.
 */
export async function getGlobalAiPause(userId?: string): Promise<{ reason: "disabled" | "global_budget"; message: string } | null> {
  if (aiDisabled()) return { reason: "disabled", message: "Monet AI is turned off right now." };
  if (userId && userId !== OWNER_ID && guestPoolFull(await getGuestPoolUsed(), guestRunsInFlight())) {
    return { reason: "global_budget", message: "Guests have used today's AI allowance on this server. Try again later." };
  }
  return null;
}

export interface AiUsageSummary {
  requestsUsed: number;
  requestLimit: number;
  tokensUsed: number;
  tokenLimit: number;
  /** Web searches + page fetches in the window, and the cap (the AI works without the web past it). */
  searchesUsed: number;
  searchLimit: number;
  resetsAt: string | null;
  /** AI runs this user has in flight right now. */
  running: number;
  concurrentLimit: number;
  /** True when the AI is off for this person (kill switch, or the guests' shared pool for a guest). */
  paused: boolean;
  pausedReason: "disabled" | "global_budget" | null;
}

export async function getAiUsage(userId: string): Promise<AiUsageSummary> {
  const since = windowStart();
  const [[row], pause] = await Promise.all([
    db
      .select({
        requests: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${aiUsageTable.inputTokens} + ${aiUsageTable.outputTokens}), 0)::int`,
        searches: sql<number>`coalesce(sum(${aiUsageTable.webSearches}), 0)::int`,
        oldest: sql<Date | null>`min(${aiUsageTable.createdAt})`,
      })
      .from(aiUsageTable)
      .where(and(eq(aiUsageTable.userId, userId), gte(aiUsageTable.createdAt, since))),
    getGlobalAiPause(userId),
  ]);
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  const limits = limitsFor(userId);
  return {
    requestsUsed: row?.requests ?? 0,
    requestLimit: limits.requests,
    tokensUsed: row?.tokens ?? 0,
    tokenLimit: limits.tokens,
    searchesUsed: row?.searches ?? 0,
    searchLimit: limits.searches,
    resetsAt: oldest ? new Date(oldest.getTime() + WINDOW_MS).toISOString() : null,
    running: running.get(userId) ?? 0,
    concurrentLimit: userId === OWNER_ID ? OWNER_CONCURRENT_LIMIT : CONCURRENT_LIMIT,
    paused: !!pause,
    pausedReason: pause?.reason ?? null,
  };
}

export type AiLimitCode = "ai_disabled" | "global_budget" | "daily_limit" | "user_concurrency" | "board_concurrency" | "ip_limit";

export class AiLimitError extends Error {
  status: number;
  code: AiLimitCode;
  usage: AiUsageSummary | null;
  retryAfterSec: number | null;
  constructor(message: string, usage: AiUsageSummary | null, code: AiLimitCode = "daily_limit", status = 429, retryAfterSec: number | null = null) {
    super(message);
    this.usage = usage;
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

function decrement(map: Map<string, number>, key: string) {
  const cur = map.get(key) ?? 1;
  if (cur <= 1) map.delete(key);
  else map.set(key, cur - 1);
}

export interface ReserveAiOptions {
  /** Board the run acts on (defaults to the board in the request URL). */
  boardId?: string | null;
  /** Client IP (defaults to the current request's IP). */
  ip?: string | null;
}

/**
 * Checks every limit and reserves concurrency slots. Call release() when the run finishes (in a finally
 * block), then recordAiUsage() with the real token counts. Throws AiLimitError (status 429, or 503 when the AI
 * is off for everyone).
 */
export async function reserveAi(userId: string, opts: ReserveAiOptions = {}): Promise<{ release: () => void; usage: AiUsageSummary }> {
  const ctx = currentRequestContext();
  const boardId = opts.boardId ?? ctx?.boardId ?? null;
  const ip = opts.ip ?? ctx?.ip ?? null;

  const usage = await getAiUsage(userId);
  if (usage.paused) {
    const pause = await getGlobalAiPause(userId);
    throw new AiLimitError(
      pause?.message ?? "Monet AI is unavailable right now.",
      usage,
      usage.pausedReason === "disabled" ? "ai_disabled" : "global_budget",
      503,
    );
  }
  const inFlight = running.get(userId) ?? 0;
  if (usage.requestsUsed + inFlight >= usage.requestLimit || usage.tokensUsed >= usage.tokenLimit) {
    throw new AiLimitError("You've reached today's AI limit. It resets within 24 hours.", usage, "daily_limit");
  }
  if (inFlight >= usage.concurrentLimit) {
    throw new AiLimitError("The AI is already working on your other requests. Try again in a moment.", usage, "user_concurrency");
  }
  if (boardId && BOARD_CONCURRENT_LIMIT > 0 && (runningByBoard.get(boardId) ?? 0) >= BOARD_CONCURRENT_LIMIT) {
    throw new AiLimitError("The AI is already working on this board. Wait for it to finish, then try again.", usage, "board_concurrency");
  }
  if (ip && userId !== OWNER_ID) {
    const r = ipLimiter.hit(ip);
    if (!r.allowed) {
      throw new AiLimitError(`Too many AI requests from your network. Try again in ${minutesText(r.retryAfterSec)}.`, usage, "ip_limit", 429, r.retryAfterSec);
    }
  }

  running.set(userId, inFlight + 1);
  if (boardId) runningByBoard.set(boardId, (runningByBoard.get(boardId) ?? 0) + 1);
  let released = false;
  return {
    usage: { ...usage, running: inFlight + 1 },
    release: () => {
      if (released) return;
      released = true;
      decrement(running, userId);
      if (boardId) decrement(runningByBoard, boardId);
    },
  };
}

export async function recordAiUsage(args: {
  userId: string;
  boardId?: string | null;
  kind: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  webSearches?: number;
  ok?: boolean;
}) {
  const inputTokens = Math.max(0, Math.round(args.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.round(args.outputTokens ?? 0));
  await db.insert(aiUsageTable).values({
    userId: args.userId,
    boardId: args.boardId ?? null,
    kind: args.kind,
    model: args.model ?? null,
    inputTokens,
    outputTokens,
    webSearches: Math.max(0, Math.round(args.webSearches ?? 0)),
    ok: args.ok ?? true,
  });
  if (guestPoolCache && args.userId !== OWNER_ID) {
    guestPoolCache.tokens += inputTokens + outputTokens;
    guestPoolCache.requests += 1;
  }
}
