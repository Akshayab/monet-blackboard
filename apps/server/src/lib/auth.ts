// Who is making a request.
//
// Solo mode (the default): the server listens on localhost only and every request is the owner. There is no sign-in.
// Team mode (TEAM_MODE=1): people are identified by a session cookie. The owner gets one by opening the owner link
// printed in the terminal; guests get one by entering a name on a board's share link.
import crypto from "crypto";
import { db, sessionsTable, settingsTable, usersTable, type User } from "@monet/db";
import { eq, lt } from "drizzle-orm";
import type { Request, Response } from "express";
import { config } from "./config";

export const OWNER_ID = "owner";
export const SESSION_COOKIE = "sid";
const OWNER_SESSION_TTL = 365 * 24 * 60 * 60 * 1000;
const GUEST_SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
const OWNER_TOKEN_KEY = "owner_link_token";

export interface AuthUser {
  id: string;
  displayName: string;
  kind: "owner" | "guest";
}

export function toAuthUser(u: Pick<User, "id" | "displayName" | "kind">): AuthUser {
  return { id: u.id, displayName: u.displayName, kind: u.kind === "owner" ? "owner" : "guest" };
}

export function displayNameOf(u: Pick<AuthUser, "displayName"> | null | undefined): string {
  return u?.displayName?.trim() || "Someone";
}

let ownerCache: AuthUser | null = null;

/** Creates the owner row on first start and returns it. */
export async function ensureOwner(): Promise<AuthUser> {
  await db
    .insert(usersTable)
    .values({ id: OWNER_ID, displayName: process.env.OWNER_NAME?.trim().slice(0, 80) || "Owner", kind: "owner" })
    .onConflictDoNothing();
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, OWNER_ID));
  ownerCache = toAuthUser(u!);
  return ownerCache;
}

export async function getOwner(): Promise<AuthUser> {
  return ownerCache ?? ensureOwner();
}

/** Called after the owner renames themselves. */
export function setOwnerCache(u: AuthUser) {
  if (u.id === OWNER_ID) ownerCache = u;
}

// ---------- Owner link (team mode) ----------

/**
 * The secret in the owner link. Kept in the database so the link survives restarts. OWNER_LINK_TOKEN pins it
 * (useful for automation); OWNER_LINK_ROTATE=1 makes a new one, which also signs the owner out everywhere.
 */
let currentOwnerToken: string | null = null;

export async function ownerLinkToken(): Promise<string> {
  const pinned = process.env.OWNER_LINK_TOKEN?.trim();
  if (pinned) return pinned;
  // Read (or rotate) once per start; OWNER_LINK_ROTATE left set must not make a new link on every claim.
  if (currentOwnerToken) return currentOwnerToken;
  const rotate = /^(1|true|yes)$/i.test(process.env.OWNER_LINK_ROTATE ?? "");
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, OWNER_TOKEN_KEY));
  if (row && !rotate && typeof row.value === "string") return (currentOwnerToken = row.value);
  const token = crypto.randomBytes(24).toString("base64url");
  await db
    .insert(settingsTable)
    .values({ key: OWNER_TOKEN_KEY, value: token })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: token } });
  if (rotate) await db.delete(sessionsTable).where(eq(sessionsTable.userId, OWNER_ID));
  return (currentOwnerToken = token);
}

export function ownerLinkUrl(token: string): string {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  // The token travels in the fragment, so it never reaches server or proxy logs.
  return `${base}/claim#${token}`;
}

/** Constant-time comparison for secrets. */
export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh) && a.length === b.length;
}

// ---------- Sessions (team mode) ----------

export async function createSession(userId: string): Promise<{ sid: string; ttl: number }> {
  const sid = crypto.randomBytes(32).toString("hex");
  const ttl = userId === OWNER_ID ? OWNER_SESSION_TTL : GUEST_SESSION_TTL;
  await db.insert(sessionsTable).values({ sid, userId, expire: new Date(Date.now() + ttl) });
  return { sid, ttl };
}

/** The user behind a session id, or null when it's unknown or expired. */
export async function userForSession(sid: string): Promise<AuthUser | null> {
  const [row] = await db
    .select({ expire: sessionsTable.expire, id: usersTable.id, displayName: usersTable.displayName, kind: usersTable.kind })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
    .where(eq(sessionsTable.sid, sid));
  if (!row) return null;
  if (row.expire < new Date()) {
    await deleteSession(sid);
    return null;
  }
  return toAuthUser(row);
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(sessionsTable).where(lt(sessionsTable.expire, new Date()));
}

// httpOnly: no script access. sameSite lax: not sent on cross-site POSTs, iframes or WebSocket handshakes from
// other sites. Secure whenever the request arrived over https (directly or through a trusted proxy).
function cookieOptions(req: Request) {
  return { httpOnly: true, secure: req.secure, sameSite: "lax", path: "/" } as const;
}

export function setSessionCookie(req: Request, res: Response, sid: string, ttl: number) {
  res.cookie(SESSION_COOKIE, sid, { ...cookieOptions(req), maxAge: ttl });
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

/** Parses the session id out of a raw Cookie header (Express requests and WebSocket upgrades). */
export function sessionIdFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
