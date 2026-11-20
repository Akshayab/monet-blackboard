// Identity routes. Solo mode has no sign-in: every request is the owner, so only GET/PATCH /auth/user matter.
// Team mode adds:
//   POST /auth/claim   the owner link's token -> an owner session in this browser
//   POST /auth/guest   a name + an active share link -> a guest session (no account, no password)
//   POST /auth/logout  ends this browser's session
import crypto from "crypto";
import { boardsTable, db, usersTable } from "@monet/db";
import { and, eq, isNull } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  OWNER_ID,
  clearSessionCookie,
  createSession,
  deleteSession,
  ownerLinkToken,
  secretEquals,
  setOwnerCache,
  setSessionCookie,
  toAuthUser,
} from "../lib/auth";
import { isRemoved, linkRoleOf, touchMembership } from "../lib/access";
import { config } from "../lib/config";
import { aiDescription, isAiConfigured } from "../ai/client";
import { isMockAi } from "../ai/mock";
import { limiters, sendRateLimited } from "../middlewares/rate-limit";
import { clientIp } from "../lib/client-ip";
import { endSessionSockets } from "../realtime/server";

const router: IRouter = Router();

const Name = z
  .string()
  .trim()
  .max(80)
  .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim())
  .pipe(z.string().min(1, "Enter a name."));

router.get("/auth/user", (req: Request, res: Response) => {
  res.json({
    user: req.user ?? null,
    mode: config.teamMode ? "team" : "solo",
    ai: { configured: isAiConfigured() || isMockAi(), model: req.user?.kind === "owner" ? aiDescription() : null },
    guestAi: config.guestAi,
  });
});

router.patch("/auth/user", async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Open a board link to continue.", code: "unauthenticated" });
    return;
  }
  const parsed = z.object({ name: Name }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a name (up to 80 characters)." });
    return;
  }
  const [u] = await db.update(usersTable).set({ displayName: parsed.data.name }).where(eq(usersTable.id, req.user.id)).returning();
  const user = toAuthUser(u!);
  setOwnerCache(user);
  res.json({ user });
});

/** One failed guess per attempt, per IP: the owner token is 192 random bits, this just stops noisy scanning. */
function claimLimited(req: Request, res: Response): boolean {
  const r = limiters.authPerIp.hit(clientIp(req));
  if (r.allowed) return false;
  sendRateLimited(res, r, "Too many attempts. Try again in a few minutes.");
  return true;
}

router.post("/auth/claim", async (req: Request, res: Response) => {
  if (!config.teamMode) {
    res.json({ user: req.user });
    return;
  }
  if (claimLimited(req, res)) return;
  const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(req.body ?? {});
  if (!parsed.success || !secretEquals(parsed.data.token, await ownerLinkToken())) {
    res.status(403).json({ error: "That owner link isn't valid. Copy it again from the server's terminal output." });
    return;
  }
  const previous = req.sessionId;
  if (previous) await deleteSession(previous);
  const { sid, ttl } = await createSession(OWNER_ID);
  setSessionCookie(req, res, sid, ttl);
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, OWNER_ID));
  res.json({ user: toAuthUser(u!) });
  if (previous) endSessionSockets(previous);
});

router.post("/auth/guest", async (req: Request, res: Response) => {
  if (!config.teamMode) {
    res.status(400).json({ error: "Guests can only join when the server runs in team mode." });
    return;
  }
  if (claimLimited(req, res)) return;
  const parsed = z.object({ name: Name, linkToken: z.string().min(1).max(128) }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Enter a name." });
    return;
  }
  // Only people holding a working share link can become guests.
  const [board] = await db
    .select()
    .from(boardsTable)
    .where(and(eq(boardsTable.linkToken, parsed.data.linkToken), isNull(boardsTable.deletedAt)));
  const linkRole = board ? linkRoleOf(board) : null;
  if (!board || !linkRole) {
    res.status(404).json({ error: "This link doesn't work anymore. Ask the owner for a new one." });
    return;
  }
  // Already a guest in this browser: just update the name (unless the owner removed them from this board).
  if (req.user?.kind === "guest") {
    if (await isRemoved(board.id, req.user.id)) {
      res.status(403).json({ error: "The owner removed you from this board.", code: "removed" });
      return;
    }
    const [u] = await db.update(usersTable).set({ displayName: parsed.data.name }).where(eq(usersTable.id, req.user.id)).returning();
    if (!(await touchMembership(board.id, u!.id, linkRole, parsed.data.linkToken))) {
      res.status(404).json({ error: "This link doesn't work anymore. Ask the owner for a new one." });
      return;
    }
    res.json({ user: toAuthUser(u!), boardId: board.id });
    return;
  }
  if (req.user?.kind === "owner") {
    res.json({ user: req.user, boardId: board.id });
    return;
  }
  // New guest identities are capped per IP and per link, so nobody can mint guests to multiply AI allowances.
  for (const [limiter, key] of [
    [limiters.guestCreatePerIp, clientIp(req)],
    [limiters.guestCreatePerLink, board.id],
  ] as const) {
    const r = limiter.hit(key);
    if (!r.allowed) {
      sendRateLimited(res, r, "Too many people joined through this link or network recently. Try again later.");
      return;
    }
  }
  const id = `guest_${crypto.randomBytes(12).toString("hex")}`;
  const [u] = await db.insert(usersTable).values({ id, displayName: parsed.data.name, kind: "guest" }).returning();
  // Joining through the link puts the guest on the board's people list right away.
  await touchMembership(board.id, id, linkRole, parsed.data.linkToken);
  const { sid, ttl } = await createSession(id);
  setSessionCookie(req, res, sid, ttl);
  res.status(201).json({ user: toAuthUser(u!), boardId: board.id });
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  if (!config.teamMode) {
    res.json({ ok: true });
    return;
  }
  const sid = req.sessionId;
  if (sid) await deleteSession(sid);
  clearSessionCookie(req, res);
  res.json({ ok: true });
  if (sid) endSessionSockets(sid);
});

export default router;
