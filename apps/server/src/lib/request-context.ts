// Per-request context (client IP, board id from the URL) available to code that runs during a request,
// including background work it starts. ai-limits.ts uses it so every reserveAi() call gets per-IP and
// per-board limits without callers having to pass them.
import { AsyncLocalStorage } from "async_hooks";
import type { NextFunction, Request, Response } from "express";
import { clientIp } from "./client-ip";

export interface RequestContext {
  ip: string;
  boardId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

const BOARD_PATH = /^\/api\/boards\/([^/?#]+)/;

/** Must run after body parsing: stream callbacks from the body parser would otherwise lose the context. */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const m = BOARD_PATH.exec(req.originalUrl ?? req.url);
  const ctx: RequestContext = { ip: clientIp(req), boardId: m ? decodeURIComponent(m[1]!) : undefined, userId: req.user?.id };
  storage.run(ctx, next);
}
