// Identifies who is making each request (see lib/auth.ts for the two modes).
import type { NextFunction, Request, Response } from "express";
import { config } from "../lib/config";
import { getOwner, sessionIdFromCookieHeader, userForSession, type AuthUser } from "../lib/auth";
import { isLoopbackHost } from "./security";

declare global {
  namespace Express {
    interface User extends AuthUser {}
    interface Request {
      user?: User | undefined;
      sessionId?: string;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (!config.teamMode) {
      // Solo mode: only requests addressed to localhost are answered (this also defeats DNS rebinding), and every
      // one of them is the owner.
      if (!isLoopbackHost(req.headers.host)) {
        res.status(403).json({ error: "Monet Blackboard only answers on localhost. Set TEAM_MODE=1 to let other people in (see the README)." });
        return;
      }
      req.user = await getOwner();
      return next();
    }
    const sid = sessionIdFromCookieHeader(req.headers.cookie);
    if (sid) {
      const user = await userForSession(sid);
      if (user) {
        req.user = user;
        req.sessionId = sid;
      }
    }
  } catch (err) {
    req.log?.error({ err }, "auth middleware failed");
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Open the owner link, or a board link from the owner, to continue.", code: "unauthenticated" });
    return;
  }
  next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.kind !== "owner") {
    res.status(403).json({ error: "Only the owner can do that." });
    return;
  }
  next();
}
