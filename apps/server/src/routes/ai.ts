// Board AI routes. The agent itself lives in src/ai/ (owned by the AI workstream). This file is the HTTP
// surface: chat history, starting a run, and per-user usage.
import { aiMessagesTable, db, usersTable } from "@monet/db";
import { desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import type { ChatMessage } from "@monet/board-protocol";
import { requireAuth } from "../middlewares/authMiddleware";
import { atLeast, getBoardAccess } from "../lib/access";
import { broadcastToBoard } from "../realtime/rooms";
import { displayNameOf } from "../lib/auth";
import { config } from "../lib/config";
import { pgSafe } from "../lib/pg-safe";

const router: IRouter = Router();

function linkTokenOf(req: Request): string | null {
  const v = req.query.link ?? req.headers["x-board-link"];
  return typeof v === "string" && v ? v : null;
}

export async function toChatMessages(rows: (typeof aiMessagesTable.$inferSelect)[]): Promise<ChatMessage[]> {
  const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const users = ids.length ? await db.select().from(usersTable).where(inArray(usersTable.id, ids)) : [];
  const names = new Map(users.map((u) => [u.id, u.displayName || "Someone"]));
  return rows.map((r) => ({
    id: r.id,
    boardId: r.boardId,
    userId: r.userId,
    userName: r.userId ? (names.get(r.userId) ?? null) : null,
    role: r.role,
    content: r.content,
    meta: (r.meta as Record<string, unknown>) ?? {},
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Stores a chat message and broadcasts it to everyone on the board. */
export async function postChatMessage(
  boardId: string,
  role: "user" | "assistant",
  content: string,
  userId: string | null,
  meta: Record<string, unknown> = {},
): Promise<ChatMessage> {
  const [row] = await db
    .insert(aiMessagesTable)
    .values({ boardId, role, content: pgSafe(content), userId, meta: pgSafe(meta) })
    .returning();
  const [msg] = await toChatMessages([row!]);
  broadcastToBoard(boardId, { t: "chat", message: msg! });
  return msg!;
}

router.get("/ai/usage", requireAuth, async (req: Request, res: Response) => {
  const { getAiUsage } = await import("../lib/ai-limits");
  const { isAiConfigured } = await import("../ai/client");
  const { isMockAi } = await import("../ai/mock");
  res.json({ usage: await getAiUsage(req.user!.id), configured: isAiConfigured() || isMockAi(), mock: isMockAi() });
});

router.get("/boards/:id/ai/messages", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access) {
    res.status(404).json({ error: "Board not found." });
    return;
  }
  // The newest 500, oldest first.
  const rows = await db.select().from(aiMessagesTable).where(eq(aiMessagesTable.boardId, access.board.id)).orderBy(desc(aiMessagesTable.createdAt)).limit(500);
  res.json({ messages: await toChatMessages(rows.reverse()) });
});

export const AiRequestBody = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  /** Element ids the user selected / dragged across ("focus on one area"). */
  focusElementIds: z.array(z.string()).max(2000).optional(),
  /** Where the user is looking, so new content lands in view. */
  viewport: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().max(300),
        mimeType: z.string().max(200),
        /** Plain text (CSV, TXT, extracted PDF text) or a data URL (images, PDFs). */
        text: z.string().max(400_000).optional(),
        dataURL: z.string().max(12_000_000).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** A PNG of the focused region (for sketches). */
  snapshot: z.string().max(8_000_000).optional(),
  mode: z.enum(["chat", "live"]).optional(),
});

router.post("/boards/:id/ai", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access || !atLeast(access.role, "editor")) {
    res.status(403).json({ error: "You need edit access to ask the AI to change this board." });
    return;
  }
  if (req.user!.kind === "guest" && !config.guestAi) {
    res.status(403).json({ error: "The owner has turned the AI off for guests on this server.", code: "guest_ai_off" });
    return;
  }
  const parsed = AiRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
    return;
  }
  // Lazy import so the server still boots if the AI module has a problem.
  const { startAiRun } = await import("../ai/run");
  const result = await startAiRun({
    boardId: access.board.id,
    user: req.user!,
    userName: displayNameOf(req.user!),
    request: parsed.data,
    linkToken: linkTokenOf(req),
  });
  if ("error" in result) {
    res.status(result.status).json({ error: result.error, ...(result.extra ?? {}) });
    return;
  }
  res.status(202).json(result);
});

const StopBody = z.object({ runId: z.string().max(64).optional() }).optional();

/**
 * Stops the board's active AI run (or the given runId). Any editor of the board may stop it. Elements the AI already
 * placed stay. Responds once the run has wound down (at most ~3 s): { stopped: true, runIds } or { stopped: false }.
 */
router.post("/boards/:id/ai/stop", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access || !atLeast(access.role, "editor")) {
    res.status(403).json({ error: "You need edit access to stop the AI on this board." });
    return;
  }
  const parsed = StopBody.safeParse(req.body && Object.keys(req.body).length ? req.body : undefined);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
    return;
  }
  const { stopRuns } = await import("../ai/runs");
  const runIds = await stopRuns(access.board.id, req.user!.id, { runId: parsed.data?.runId });
  res.json(runIds.length ? { stopped: true, runIds } : { stopped: false });
});

export default router;
