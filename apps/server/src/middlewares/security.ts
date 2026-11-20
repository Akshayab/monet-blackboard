// HTTP hardening for the API: security headers, same-origin/CSRF checks, tiered JSON body limits, and a JSON
// error handler. In production this server also serves the built web app; its CSP is a <meta> tag added at build
// time (apps/web/vite.config.ts), and staticHeaders() below adds the headers a meta tag can't set.
import express, { type NextFunction, type Request, type Response } from "express";
import type { IncomingMessage } from "http";
import { logger } from "../lib/logger";
import { pgSafe } from "../lib/pg-safe";
import { config } from "../lib/config";

/** A request URL as it may appear in logs: no query string (link tokens) and no share-link token in the path. */
export function logUrl(url: string | undefined): string | undefined {
  return url?.split("?")[0]?.replace(/^(\/api\/share\/)[^/]+/, "$1[token]");
}

// ---------- Origins ----------
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when a Host header names this machine (localhost, 127.0.0.1 or ::1, any port). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().trim();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(name);
}

/**
 * Solo mode answers only requests addressed to localhost, for pages, the API and the board socket. This runs before
 * anything else reads the request, so a DNS-rebinding page can't reach body parsing or the database.
 */
export function soloHostGuard(req: Request, res: Response, next: NextFunction) {
  if (config.teamMode || isLoopbackHost(req.headers.host)) return next();
  const message = "Monet Blackboard only answers on localhost. Set TEAM_MODE=1 to let other people in (see the README).";
  if (req.path === "/api" || req.path.startsWith("/api/")) res.status(403).json({ error: message });
  else res.status(403).type("text/plain").send(message);
}

function configuredOrigins(): Set<string> {
  const out = new Set<string>();
  for (const raw of [...(process.env.ALLOWED_ORIGINS ?? "").split(","), config.publicUrl]) {
    const v = raw.trim().replace(/\/$/, "");
    if (v) out.add(v.toLowerCase());
  }
  return out;
}
const extraOrigins = configuredOrigins();

/** True when `origin` is this server's own origin (Host header), PUBLIC_URL, or listed in ALLOWED_ORIGINS. */
export function isAllowedOrigin(origin: string | undefined, req: IncomingMessage): boolean {
  if (!origin) return true;
  if (origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const normalized = `${url.protocol}//${url.host}`.toLowerCase();
  if (extraOrigins.has(normalized)) return true;
  const host = String(req.headers["x-forwarded-host"] && config.teamMode ? req.headers["x-forwarded-host"] : (req.headers.host ?? ""))
    .split(",")[0]!
    .trim()
    .toLowerCase();
  if (!host || url.host.toLowerCase() !== host) return false;
  return url.protocol === "https:" || url.protocol === "http:";
}

// ---------- Headers ----------
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", API_CSP);
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  // API responses carry private board data; never let shared caches keep them.
  res.setHeader("Cache-Control", "no-store");
  next();
}

// ---------- URL ----------
/** A NUL byte in a path or query value reaches Postgres as an id and fails the query (500). No real link has one. */
export function rejectNulInUrl(req: Request, res: Response, next: NextFunction) {
  if (/%00|\u0000/i.test(req.originalUrl)) {
    res.status(400).json({ error: "That address isn't valid.", code: "bad_url" });
    return;
  }
  next();
}

// ---------- CSRF / same-origin ----------
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hasBody(req: Request): boolean {
  const len = req.headers["content-length"];
  if (len !== undefined) return Number(len) > 0;
  return req.headers["transfer-encoding"] !== undefined;
}

/**
 * Rejects state-changing requests that a third-party page could forge:
 *  - a foreign (or "null") Origin header, or Sec-Fetch-Site: cross-site
 *  - a body that isn't JSON (forms and text/plain are the only bodies a cross-site page can send without a
 *    preflight). multipart/form-data is accepted only with a verified same-origin Origin header.
 * CORS: no Access-Control-Allow-* headers are ever sent, so browsers keep cross-origin reads blocked.
 */
export function sameOriginGuard(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS" && origin && !isAllowedOrigin(origin, req)) {
    res.status(403).json({ error: "Cross-origin requests aren't allowed.", code: "bad_origin" });
    return;
  }
  if (!STATE_CHANGING.has(req.method)) return next();
  if ((origin && !isAllowedOrigin(origin, req)) || (!origin && req.headers["sec-fetch-site"] === "cross-site")) {
    res.status(403).json({ error: "Cross-site request blocked.", code: "bad_origin" });
    return;
  }
  if (hasBody(req) && !req.is("application/json")) {
    if (req.is("multipart/form-data") && origin && isAllowedOrigin(origin, req)) return next();
    res.status(415).json({ error: "Send the request as JSON (Content-Type: application/json).", code: "unsupported_media_type" });
    return;
  }
  next();
}

// ---------- Body limits ----------
// Sign-in bodies are tiny; board and AI bodies carry images (data URLs), so they keep a large limit.
const AUTH_BODY = /^\/api\/auth\//;
const BOARD_BODY = /^\/api\/(boards|ai)(\/|$)/;
// inflate: false rejects compressed request bodies (415). Browsers never compress request bodies, and it closes
// body-parser 2.3.0's crash-on-trailing-bytes DoS (GHSA-27r3-jxmh-p828), which lives in the decompression path.
const authJson = express.json({ limit: process.env.API_MAX_BODY_AUTH || "32kb", inflate: false });
const boardJson = express.json({ limit: process.env.API_MAX_BODY_BOARD || "16mb", inflate: false });
const defaultJson = express.json({ limit: process.env.API_MAX_BODY_DEFAULT || "1mb", inflate: false });
const smallForm = express.urlencoded({ extended: false, limit: "32kb", inflate: false });

export function jsonBody(req: Request, res: Response, next: NextFunction) {
  // Only signed-in people get the large limit; every board and AI route needs a session anyway.
  const parser = AUTH_BODY.test(req.path) || !req.user ? authJson : BOARD_BODY.test(req.path) ? boardJson : defaultJson;
  parser(req, res, (err?: unknown) => {
    if (err) return next(err);
    try {
      // Make every string storable (see lib/pg-safe.ts). Throws on absurdly deep nesting.
      if (req.body !== undefined) req.body = pgSafe(req.body);
    } catch (e) {
      return next(e);
    }
    smallForm(req, res, next);
  });
}

// ---------- Errors ----------
/** Final error handler: JSON responses, no stack traces or internals in the body. */
export function jsonErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string; code?: string };
  if (e?.type === "entity.too.large") {
    res.status(413).json({ error: "That request is too large.", code: "payload_too_large" });
    return;
  }
  if (e?.type === "encoding.unsupported") {
    res.status(415).json({ error: "Compressed request bodies aren't accepted.", code: "unsupported_encoding" });
    return;
  }
  if (e?.type === "entity.parse.failed") {
    res.status(400).json({ error: "The request body isn't valid JSON.", code: "bad_json" });
    return;
  }
  if (e?.code === "too_deep") {
    res.status(400).json({ error: "The request body is nested too deeply.", code: "too_deep" });
    return;
  }
  const status = e?.status ?? e?.statusCode ?? 500;
  if (status >= 500) {
    (req.log ?? logger).error({ err }, "request failed");
    res.status(500).json({ error: "Something went wrong. Try again." });
    return;
  }
  res.status(status).json({ error: status === 429 && e?.message ? e.message : "The request couldn't be completed.", ...(e?.code ? { code: e.code } : {}) });
}

/** Headers for the web app's HTML and assets (served by this server in production). */
export function staticHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  next();
}
