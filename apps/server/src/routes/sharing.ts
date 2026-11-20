// Sharing (team mode): the board's share link (off / view / edit, copy, regenerate) and the people who joined
// through it. Only the owner changes anything; everyone with access can see who is on the board.
// Every change re-checks live sockets (refreshBoardAccess) so it takes effect immediately.
import { boardMembersTable, boardsTable, db, usersTable, type BoardRole } from "@monet/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/authMiddleware";
import { getBoardAccess, leaveBoard, linkRoleOf, type BoardAccess } from "../lib/access";
import { config } from "../lib/config";
import { refreshBoardAccess } from "../realtime/server";

const router: IRouter = Router();

function linkTokenOf(req: Request): string | null {
  const v = req.query.link ?? req.headers["x-board-link"];
  return typeof v === "string" && v ? v : null;
}

async function loadAccess(req: Request, res: Response): Promise<BoardAccess | null> {
  const access = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!access) {
    res.status(404).json({ error: "Board not found, or you don't have access." });
    return null;
  }
  return access;
}

function ownerOnly(access: BoardAccess, res: Response, what: string): boolean {
  if (access.role === "owner") return true;
  res.status(403).json({ error: `Only the owner can ${what}.` });
  return false;
}

function teamOnly(res: Response): boolean {
  if (config.teamMode) return true;
  res.status(400).json({ error: "Sharing needs team mode. Restart the server with TEAM_MODE=1 (see the README).", code: "solo_mode" });
  return false;
}

router.get("/boards/:id/sharing", requireAuth, async (req: Request, res: Response) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const { board } = access;
  const linkRole = linkRoleOf(board);
  const canManage = access.role === "owner";
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, board.ownerId));
  const rows = await db
    .select({ m: boardMembersTable, u: usersTable })
    .from(boardMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, boardMembersTable.userId))
    .where(eq(boardMembersTable.boardId, board.id))
    .orderBy(boardMembersTable.createdAt);
  const members = rows
    .filter(({ m }) => m.userId !== board.ownerId && m.source !== "removed" && m.source !== "left")
    // People who joined through the link have no access while the link is off.
    .filter(({ m }) => m.source !== "link" || !!linkRole)
    .map(({ m, u }) => ({
      userId: m.userId,
      name: u.displayName,
      role: (m.source === "link" ? linkRole : m.role) as BoardRole,
      source: m.source,
      lastOpenedAt: m.lastOpenedAt,
    }));
  res.json({
    teamMode: config.teamMode,
    board: {
      id: board.id,
      title: board.title,
      linkAccess: board.linkAccess,
      // The owner always sees the link; everyone else only while it works.
      linkToken: canManage || linkRole ? board.linkToken : null,
    },
    me: { userId: req.user!.id, role: access.role, via: access.via },
    permissions: { canManage, canChangeLink: canManage && config.teamMode },
    owner: owner ? { userId: owner.id, name: owner.displayName } : null,
    members,
  });
});

const RoleBody = z.object({ role: z.enum(["editor", "commenter", "viewer"]) });

router.patch("/boards/:id/members/:userId", requireAuth, async (req: Request, res: Response) => {
  const access = await loadAccess(req, res);
  if (!access || !ownerOnly(access, res, "change roles")) return;
  const parsed = RoleBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Pick editor, commenter or viewer." });
    return;
  }
  const userId = String(req.params.userId);
  if (userId === access.board.ownerId) {
    res.status(400).json({ error: "The owner's role can't change." });
    return;
  }
  // Setting a role makes it the person's own: they keep it even if the link is turned off later, and the link can't
  // give them more.
  const [m] = await db
    .update(boardMembersTable)
    .set({ role: parsed.data.role, source: "direct" })
    .where(and(eq(boardMembersTable.boardId, access.board.id), eq(boardMembersTable.userId, userId), ne(boardMembersTable.source, "removed")))
    .returning();
  if (!m) {
    res.status(404).json({ error: "That person isn't on this board." });
    return;
  }
  await refreshBoardAccess(access.board.id, userId);
  res.json({ ok: true, role: m.role });
});

router.delete("/boards/:id/members/:userId", requireAuth, async (req: Request, res: Response) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const userId = String(req.params.userId);
  const leaving = userId === req.user!.id;
  if (!leaving && !ownerOnly(access, res, "remove people")) return;
  if (userId === access.board.ownerId) {
    res.status(400).json({ error: "The owner can't be removed." });
    return;
  }
  const where = and(eq(boardMembersTable.boardId, access.board.id), eq(boardMembersTable.userId, userId));
  if (leaving) {
    // Leaving on your own: you can come back with the link (with no more than the role the owner set).
    await leaveBoard(access.board.id, userId);
  } else {
    // Removed by the owner: keep a row that blocks the share link for this guest identity (their browser session).
    // Someone with the link can still join as a new guest; resetting the link is what keeps them out.
    const [m] = await db.update(boardMembersTable).set({ source: "removed", role: "viewer" }).where(where).returning();
    if (!m) {
      res.status(404).json({ error: "That person isn't on this board." });
      return;
    }
  }
  await refreshBoardAccess(access.board.id, userId);
  res.json({ ok: true });
});

const LinkBody = z.object({ access: z.enum(["none", "view", "edit"]) });

router.patch("/boards/:id/link", requireAuth, async (req: Request, res: Response) => {
  const access = await loadAccess(req, res);
  if (!access || !ownerOnly(access, res, "change link sharing")) return;
  const parsed = LinkBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Pick off, view, or edit." });
    return;
  }
  if (parsed.data.access !== "none" && !teamOnly(res)) return;
  const [b] = await db.update(boardsTable).set({ linkAccess: parsed.data.access }).where(eq(boardsTable.id, access.board.id)).returning();
  await refreshBoardAccess(access.board.id);
  res.json({ linkAccess: b!.linkAccess, linkToken: b!.linkToken });
});

router.post("/boards/:id/link/regenerate", requireAuth, async (req: Request, res: Response) => {
  const access = await loadAccess(req, res);
  if (!access || !ownerOnly(access, res, "reset the link")) return;
  // Everyone who joined through the old link loses access; people whose role the owner set keep it. One transaction:
  // the board row stays locked until the old link's members are gone, so a join in flight can't add one back.
  const b = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(boardsTable)
      .set({ linkToken: sql`replace(gen_random_uuid()::text, '-', '')` })
      .where(eq(boardsTable.id, access.board.id))
      .returning();
    await tx.delete(boardMembersTable).where(and(eq(boardMembersTable.boardId, access.board.id), eq(boardMembersTable.source, "link")));
    return row;
  });
  await refreshBoardAccess(access.board.id);
  res.json({ linkAccess: b!.linkAccess, linkToken: b!.linkToken });
});

export default router;
