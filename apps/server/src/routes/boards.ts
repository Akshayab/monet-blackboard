import { boardFilesTable, boardMembersTable, boardsTable, db, usersTable } from "@monet/db";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { DARK_THEME_VERSION, type SceneElement } from "@monet/board-protocol";
import { requireAuth, requireOwner } from "../middlewares/authMiddleware";
import { atLeast, getBoardAccess, leaveBoard, linkRoleOf } from "../lib/access";
import { broadcastToBoard, evictRoom, getBoardElements } from "../realtime/rooms";
import { revalidateBoardAccess } from "../realtime/server";
import { plausibleVersion, sanitizeElements } from "../realtime/guard";
import { TEMPLATE_IDS, buildTemplate } from "../templates";

const router: IRouter = Router();

function linkTokenOf(req: Request): string | null {
  const v = req.query.link ?? req.headers["x-board-link"];
  return typeof v === "string" && v ? v : null;
}

function serializeBoard(b: typeof boardsTable.$inferSelect, extra: Record<string, unknown> = {}) {
  return {
    id: b.id,
    title: b.title,
    ownerId: b.ownerId,
    linkAccess: b.linkAccess,
    thumbnail: b.thumbnail,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    ...extra,
  };
}

// Library: boards I own plus boards shared with me, most recent first.
router.get("/boards", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const owned = await db
    .select()
    .from(boardsTable)
    .where(and(eq(boardsTable.ownerId, userId), isNull(boardsTable.deletedAt)))
    .orderBy(desc(boardsTable.updatedAt));
  const sharedRows = await db
    .select({
      board: boardsTable,
      role: boardMembersTable.role,
      source: boardMembersTable.source,
      lastOpenedAt: boardMembersTable.lastOpenedAt,
    })
    .from(boardMembersTable)
    .innerJoin(boardsTable, eq(boardsTable.id, boardMembersTable.boardId))
    .where(and(eq(boardMembersTable.userId, userId), isNull(boardsTable.deletedAt)))
    .orderBy(desc(boardsTable.updatedAt));
  // People who joined through the share link see the board only while the link works, with its access.
  const shared = sharedRows.flatMap((s) => {
    if (s.source === "removed" || s.source === "left") return [];
    if (s.source !== "link") return [s];
    const role = linkRoleOf(s.board);
    return role ? [{ ...s, role }] : [];
  });
  const ownerIds = [...new Set(shared.map((s) => s.board.ownerId))];
  const owners = ownerIds.length
    ? await db.select({ id: usersTable.id, displayName: usersTable.displayName }).from(usersTable).where(inArray(usersTable.id, ownerIds))
    : [];
  const ownerName = new Map(owners.map((o) => [o.id, o.displayName || "Someone"]));
  res.json({
    boards: [
      ...owned.map((b) => serializeBoard(b, { role: "owner" })),
      ...shared
        .filter((s) => s.board.ownerId !== userId)
        .map((s) => serializeBoard(s.board, { role: s.role, ownerName: ownerName.get(s.board.ownerId), lastOpenedAt: s.lastOpenedAt })),
    ],
  });
});

const CreateBody = z.object({
  title: z.string().trim().max(200).optional(),
  elements: z.array(z.record(z.string(), z.unknown())).max(5000).optional(),
  // Start from a server-built template (see src/templates). Ignored when `elements` is given.
  template: z.enum(TEMPLATE_IDS).optional(),
});

router.post("/boards", requireAuth, requireOwner, async (req: Request, res: Response) => {
  const parsed = CreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid board." });
    return;
  }
  const fromTemplate = parsed.data.template && !parsed.data.elements ? buildTemplate(parsed.data.template) : null;
  const elements = sanitizeElements(parsed.data.elements ?? fromTemplate?.elements ?? []).elements.filter((el) => plausibleVersion(undefined, el));
  const [board] = await db
    .insert(boardsTable)
    .values({
      ownerId: req.user!.id,
      title: parsed.data.title || fromTemplate?.title || "Untitled board",
      elements: elements as SceneElement[],
      thumbnail: fromTemplate?.thumbnail ?? null,
      // Blank and template boards already use the dark palette, so the one-time upgrade for older boards skips them.
      // Elements sent by the caller (an import or a script) may be in the old palette and still get it.
      appState: parsed.data.elements ? {} : { monetTheme: DARK_THEME_VERSION },
    })
    .returning();
  res.status(201).json({ board: serializeBoard(board!, { role: "owner" }) });
});

router.get("/boards/:id", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access) {
    res.status(404).json({ error: "Board not found, or you don't have access." });
    return;
  }
  const elements = await getBoardElements(access.board.id);
  res.json({
    board: serializeBoard(access.board, {
      role: access.role,
      ...(atLeast(access.role, "owner") ? { linkToken: access.board.linkToken } : {}),
    }),
    elements: elements.filter((e) => !e.isDeleted),
  });
});

const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  linkAccess: z.enum(["none", "view", "edit"]).optional(),
  // Thumbnails render as <img> in other people's libraries: inline images only (no tracking URLs).
  thumbnail: z
    .string()
    .max(600_000)
    .regex(/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/, "Thumbnail must be an inline image.")
    .nullable()
    .optional(),
});

router.patch("/boards/:id", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access || !atLeast(access.role, "editor")) {
    res.status(403).json({ error: "You can't change this board." });
    return;
  }
  const parsed = PatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update." });
    return;
  }
  if (parsed.data.linkAccess && !atLeast(access.role, "owner")) {
    res.status(403).json({ error: "Only the owner can change link sharing." });
    return;
  }
  if (!Object.keys(parsed.data).length) {
    res.status(400).json({ error: "Nothing to update." });
    return;
  }
  const [b] = await db.update(boardsTable).set(parsed.data).where(eq(boardsTable.id, access.board.id)).returning();
  if (parsed.data.title) broadcastToBoard(access.board.id, { t: "board", title: parsed.data.title });
  // Narrowing link sharing takes effect immediately for people connected through the link.
  if (parsed.data.linkAccess && parsed.data.linkAccess !== access.board.linkAccess) void revalidateBoardAccess(access.board.id);
  res.json({ board: serializeBoard(b!, { role: access.role }) });
});

router.delete("/boards/:id", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id);
  if (!access) {
    res.status(404).json({ error: "Board not found." });
    return;
  }
  if (access.role !== "owner") {
    // Non-owners "delete" by leaving the board.
    await leaveBoard(access.board.id, req.user!.id);
    res.json({ ok: true, left: true });
    return;
  }
  await db.update(boardsTable).set({ deletedAt: new Date() }).where(eq(boardsTable.id, access.board.id));
  broadcastToBoard(access.board.id, { t: "error", code: "deleted", message: "This board was deleted." });
  await revalidateBoardAccess(access.board.id);
  evictRoom(access.board.id);
  res.json({ ok: true });
});

/** "<title> (copy)", shortened so it fits the 200-character title column (counted in characters, not UTF-16 units). */
export function copyTitle(title: string): string {
  const suffix = " (copy)";
  const chars = [...title];
  const max = 200 - suffix.length;
  return (chars.length > max ? chars.slice(0, max).join("").trimEnd() : title) + suffix;
}

router.post("/boards/:id/duplicate", requireAuth, requireOwner, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access) {
    res.status(404).json({ error: "Board not found." });
    return;
  }
  const elements = (await getBoardElements(access.board.id)).filter((e) => !e.isDeleted);
  const [copy] = await db
    .insert(boardsTable)
    .values({ ownerId: req.user!.id, title: copyTitle(access.board.title), elements, appState: { monetTheme: DARK_THEME_VERSION } })
    .returning();
  const files = await db.select().from(boardFilesTable).where(eq(boardFilesTable.boardId, access.board.id));
  if (files.length) {
    await db.insert(boardFilesTable).values(files.map((f) => ({ ...f, boardId: copy!.id, createdBy: req.user!.id })));
  }
  res.status(201).json({ board: serializeBoard(copy!, { role: "owner" }) });
});

// Resolve a share link to its board (the client then opens /b/:id?link=token).
router.get("/share/:token", async (req: Request, res: Response) => {
  const [b] = await db
    .select()
    .from(boardsTable)
    .where(and(eq(boardsTable.linkToken, String(req.params.token)), isNull(boardsTable.deletedAt)));
  if (!b || b.linkAccess === "none") {
    res.status(404).json({ error: "This link doesn't work anymore. Ask the owner for a new one." });
    return;
  }
  res.json({ boardId: b.id, linkAccess: b.linkAccess, title: b.title });
});

// ---------- Binary files (images) ----------
// Board files are images rendered by the canvas. Only inline image data URLs are accepted.
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif|x-icon|vnd\.microsoft\.icon)$/;
const FileBody = z
  .object({
    fileId: z.string().min(1).max(100),
    mimeType: z.string().min(1).max(100).regex(IMAGE_MIME, "Only images can be added to a board."),
    dataURL: z.string().min(1).max(15_000_000),
  })
  .refine((f) => f.dataURL.startsWith(`data:${f.mimeType};`) || f.dataURL.startsWith(`data:${f.mimeType},`), {
    message: "The file data doesn't match its type.",
  });
const BOARD_FILES_MAX_BYTES = Number(process.env.BOARD_FILES_MAX_BYTES || 200 * 1024 * 1024);

router.post("/boards/:id/files", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access || !atLeast(access.role, "editor")) {
    res.status(403).json({ error: "You can't add files to this board." });
    return;
  }
  const parsed = FileBody.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({
      error: issue?.path[0] === "dataURL" && issue.code === "too_big" ? "Invalid file (max 10 MB)." : (issue?.message ?? "Invalid file (max 10 MB)."),
    });
    return;
  }
  const { fileId, mimeType, dataURL } = parsed.data;
  // One upload per board at a time (transaction-scoped lock), so concurrent uploads can't share the same headroom.
  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`board-files:${access.board.id}`}))`);
    const [{ total } = { total: 0 }] = await tx
      .select({ total: sql<number>`coalesce(sum(${boardFilesTable.sizeBytes}), 0)::bigint` })
      .from(boardFilesTable)
      .where(eq(boardFilesTable.boardId, access.board.id));
    if (Number(total) + dataURL.length > BOARD_FILES_MAX_BYTES) return false;
    await tx
      .insert(boardFilesTable)
      .values({ boardId: access.board.id, fileId, mimeType, dataUrl: dataURL, sizeBytes: dataURL.length, createdBy: req.user!.id })
      .onConflictDoNothing();
    return true;
  });
  if (!stored) {
    res.status(413).json({ error: "This board has reached its storage limit for images.", code: "board_storage_full" });
    return;
  }
  broadcastToBoard(access.board.id, { t: "files", fileIds: [fileId] });
  res.status(201).json({ ok: true });
});

const MAX_FILES_PER_REQUEST = 200;

router.get("/boards/:id/files", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access) {
    res.status(404).json({ error: "Board not found." });
    return;
  }
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : null;
  if (ids && ids.length > MAX_FILES_PER_REQUEST) {
    res.status(400).json({ error: `Ask for at most ${MAX_FILES_PER_REQUEST} files at a time.` });
    return;
  }
  const rows = await db
    .select()
    .from(boardFilesTable)
    .where(
      ids?.length ? and(eq(boardFilesTable.boardId, access.board.id), inArray(boardFilesTable.fileId, ids)) : eq(boardFilesTable.boardId, access.board.id),
    );
  res.json({
    files: rows.map((r) => ({ id: r.fileId, mimeType: r.mimeType, dataURL: r.dataUrl, created: r.createdAt.getTime() })),
  });
});

// Who is on a board (owner + people who joined), for the library cards.
router.get("/boards/:id/members", requireAuth, async (req: Request, res: Response) => {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access) {
    res.status(404).json({ error: "Board not found." });
    return;
  }
  const rows = await db
    .select({ userId: boardMembersTable.userId, role: boardMembersTable.role, displayName: usersTable.displayName })
    .from(boardMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, boardMembersTable.userId))
    .where(and(eq(boardMembersTable.boardId, access.board.id), notInArray(boardMembersTable.source, ["removed", "left"])));
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, access.board.ownerId));
  res.json({
    owner: owner ? { userId: owner.id, name: owner.displayName } : null,
    members: rows.map((r) => ({ userId: r.userId, role: r.role, name: r.displayName || "Someone" })),
  });
});

export default router;
