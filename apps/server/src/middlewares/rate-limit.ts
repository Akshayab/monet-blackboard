// HTTP rate limiters. Limits are per server instance and configurable with env vars (0 disables a limiter).
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { clientIp } from "../lib/client-ip";
import { envInt, isDevEnv, minutesText, RateLimiter, type RateLimitResult } from "../lib/rate-limiter";

// Development servers (automated test runs) get generous limits; everything else keeps strict ones.
const DEV = isDevEnv();

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const limiters = {
  /** Everything under /api, per IP. Generous: catches floods, not normal use. */
  apiPerIp: new RateLimiter("api-ip", envInt("RATE_API_PER_IP_PER_MIN", 1800), MIN),
  /** Owner-link claims and guest joins (team mode), per IP. Counted inside those routes. */
  authPerIp: new RateLimiter("auth-ip", envInt("RATE_AUTH_PER_IP_PER_MIN", DEV ? 2000 : 30), MIN),
  /** AI HTTP endpoints, per person (or IP). reserveAi() adds the real budgets. */
  aiRequests: new RateLimiter("ai-requests", envInt("RATE_AI_REQUESTS_PER_MIN", DEV ? 600 : 20), MIN),
  /** Share-link resolution, per IP (tokens are unguessable; this just stops scanning). */
  shareResolve: new RateLimiter("share-resolve", envInt("RATE_SHARE_RESOLVE_PER_IP_PER_MIN", 60), MIN),
  /** New guest identities (team mode), per IP and per share link. Rejoining with an existing guest cookie is free. */
  guestCreatePerIp: new RateLimiter("guest-ip", envInt("RATE_GUEST_JOINS_PER_IP_PER_HOUR", DEV ? 2000 : 20), HOUR),
  guestCreatePerLink: new RateLimiter("guest-link", envInt("RATE_GUEST_JOINS_PER_LINK_PER_HOUR", DEV ? 2000 : 60), HOUR),
  /** Board creation and duplication, per person. */
  boardCreate: new RateLimiter("board-create", envInt("RATE_BOARD_CREATE_PER_USER_PER_HOUR", 120), HOUR),
  /** Image uploads, per person. */
  fileUpload: new RateLimiter("file-upload", envInt("RATE_FILE_UPLOADS_PER_USER_PER_HOUR", 600), HOUR),
};

export function setRateHeaders(res: Response, r: RateLimitResult) {
  if (r.limit > 0) {
    res.setHeader("RateLimit-Limit", String(r.limit));
    res.setHeader("RateLimit-Remaining", String(r.remaining));
  }
  if (!r.allowed) res.setHeader("Retry-After", String(r.retryAfterSec));
}

export function sendRateLimited(res: Response, r: RateLimitResult, message?: string) {
  setRateHeaders(res, r);
  res.status(429).json({
    error: message ?? `Too many requests. Try again in ${minutesText(r.retryAfterSec)}.`,
    code: "rate_limited",
    retryAfter: r.retryAfterSec,
  });
}

type KeyFn = (req: Request) => string | null;

export const byIp: KeyFn = (req) => clientIp(req);
export const byUserOrIp: KeyFn = (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${clientIp(req)}`);

/** Express middleware that counts a hit against `limiter` and answers 429 when over. */
export function rateLimit(limiter: RateLimiter, key: KeyFn = byIp, message?: string | ((r: RateLimitResult) => string)): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const k = key(req);
    if (!k) return next();
    const r = limiter.hit(k);
    if (!r.allowed) {
      sendRateLimited(res, r, typeof message === "function" ? message(r) : message);
      return;
    }
    next();
  };
}

const AI_PATH = /^\/api\/(ai(\/|$)|boards\/[^/]+\/ai(\/|$))/;
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Path-based limits applied before routing, so every route is covered: all /api requests per IP, and AI
 * endpoints (POSTs) per person.
 */
export function apiRateLimits(req: Request, res: Response, next: NextFunction) {
  const path = req.path;
  if (!path.startsWith("/api/") || path === "/api/healthz") return next();
  const all = limiters.apiPerIp.hit(clientIp(req));
  if (!all.allowed) return sendRateLimited(res, all);
  if (STATE_CHANGING.has(req.method) && AI_PATH.test(path)) {
    const r = limiters.aiRequests.hit(byUserOrIp(req)!);
    if (!r.allowed) return sendRateLimited(res, r, `You're sending AI requests too quickly. Try again in ${minutesText(r.retryAfterSec)}.`);
  }
  next();
}
