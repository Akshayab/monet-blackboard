import { boardMembersTable, boardsTable, db, type Board, type BoardRole, type MemberSource } from "@monet/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { secretEquals } from "./auth";

export { secretEquals };

const RANK: Record<BoardRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

export function atLeast(role: BoardRole | null | undefined, needed: BoardRole): boolean {
  return !!role && RANK[role] >= RANK[needed];
}

export interface BoardAccess {
  board: Board;
  role: BoardRole;
  /** Where the role comes from: ownership, an explicit membership, or the share link. */
  via: "owner" | "member" | "link";
}

/** The role anyone holding the share link gets (null when link sharing is off). */
export function linkRoleOf(board: Pick<Board, "linkAccess">): BoardRole | null {
  if (board.linkAccess === "edit") return "editor";
  if (board.linkAccess === "view") return "viewer";
  return null;
}

/**
 * Resolves what `userId` may do on a board. A membership row decides when there is one:
 *  - the owner gets "owner";
 *  - `source = 'direct'`: the role the owner set, even when the share link would give more;
 *  - `source = 'link'`: the link's *current* level, so turning the link off revokes it;
 *  - `source = 'removed'`: nothing, even with a working link;
 *  - `source = 'left'` (left a board where the owner had set their role): that role again, but only with a working link.
 * Without a row, a valid share link token gives the link's level. Returns null when there is no access (or the
 * board is deleted).
 */
export async function getBoardAccess(boardId: string, userId: string | null | undefined, linkToken?: string | null): Promise<BoardAccess | null> {
  const [board] = await db
    .select()
    .from(boardsTable)
    .where(and(eq(boardsTable.id, boardId), isNull(boardsTable.deletedAt)));
  if (!board) return null;
  if (userId && board.ownerId === userId) return { board, role: "owner", via: "owner" };
  const linkRole = linkRoleOf(board);
  const linkWorks = !!(linkToken && linkRole && secretEquals(linkToken, board.linkToken));
  if (userId) {
    const [m] = await db
      .select()
      .from(boardMembersTable)
      .where(and(eq(boardMembersTable.boardId, boardId), eq(boardMembersTable.userId, userId)));
    if (m) return accessFromMembership(board, m.source, m.role, linkWorks);
  }
  if (linkWorks) return { board, role: linkRole!, via: "link" };
  return null;
}

/** The access a membership row gives (see getBoardAccess). Exported for tests. */
export function accessFromMembership(board: Board, source: MemberSource, role: BoardRole, linkWorks = false): BoardAccess | null {
  if (source === "removed") return null;
  if (source === "left") return linkWorks && linkRoleOf(board) ? { board, role, via: "member" } : null;
  if (source === "link") {
    const linkRole = linkRoleOf(board);
    return linkRole ? { board, role: linkRole, via: "link" } : null;
  }
  return { board, role, via: "member" };
}

/** True when the owner removed this guest from the board (the share link no longer lets this identity in). */
export async function isRemoved(boardId: string, userId: string): Promise<boolean> {
  const [m] = await db
    .select({ source: boardMembersTable.source })
    .from(boardMembersTable)
    .where(and(eq(boardMembersTable.boardId, boardId), eq(boardMembersTable.userId, userId)));
  return m?.source === "removed";
}

/**
 * Records that a guest opened a board. Link visitors become `source = 'link'` members so the board shows in their
 * library; their access keeps following the link setting. Someone who left comes back with their earlier role.
 * Existing memberships only get lastOpenedAt.
 *
 * The row is written only while `linkToken` is still the board's link, checked in the same statement under a share
 * lock on the board row. Resetting the link takes the row lock first, so a join can't land after a reset.
 * Returns false when the link no longer works (or the owner removed this person), so a link join must be refused.
 */
export async function touchMembership(boardId: string, userId: string, role: BoardRole, linkToken: string | null): Promise<boolean> {
  if (role === "owner") return true;
  if (linkToken) {
    const r = await db.execute(sql`
      INSERT INTO board_members (board_id, user_id, role, source, last_opened_at)
      SELECT ${boardId}::varchar, ${userId}::varchar, ${role}::varchar, 'link', now()
      FROM (SELECT id FROM boards WHERE id = ${boardId} AND link_token = ${linkToken} AND deleted_at IS NULL FOR SHARE) b
      ON CONFLICT (board_id, user_id) DO UPDATE SET
        last_opened_at = now(),
        role = CASE WHEN board_members.source = 'link' THEN excluded.role ELSE board_members.role END,
        source = CASE WHEN board_members.source = 'left' THEN 'direct' ELSE board_members.source END
      WHERE board_members.source <> 'removed'
      RETURNING 1`);
    if (r.rowCount) return true;
  }
  await db
    .update(boardMembersTable)
    .set({ lastOpenedAt: new Date() })
    .where(and(eq(boardMembersTable.boardId, boardId), eq(boardMembersTable.userId, userId)));
  return false;
}

/**
 * Leaving a board on your own. A link member's row goes (the link brings them back); an owner-set role stays as a
 * ceiling (`source = 'left'`), so leaving and rejoining through an edit link can't undo a downgrade.
 */
export async function leaveBoard(boardId: string, userId: string) {
  const mine = and(eq(boardMembersTable.boardId, boardId), eq(boardMembersTable.userId, userId));
  await db.delete(boardMembersTable).where(and(mine, eq(boardMembersTable.source, "link")));
  await db
    .update(boardMembersTable)
    .set({ source: "left" })
    .where(and(mine, eq(boardMembersTable.source, "direct")));
}
