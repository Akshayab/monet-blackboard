// In-memory sliding-window rate limiter (two weighted fixed windows). Per server instance: with several
// instances the effective limit is multiplied, which is acceptable for abuse protection. Limits that must hold
// across instances (AI budgets) are enforced from the database in ai-limits.ts.

/**
 * Generous limits and test helpers apply only when NODE_ENV is "development" or "test". Anything else, including an
 * unset NODE_ENV (`pnpm start` from source), gets the strict limits.
 */
export const isDevEnv = (): boolean => process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the caller should retry (only meaningful when not allowed). */
  retryAfterSec: number;
}

export class RateLimiter {
  private current = new Map<string, number>();
  private previous = new Map<string, number>();
  private windowStart = 0;

  /** limit <= 0 disables the limiter. */
  constructor(
    readonly name: string,
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  private rotate(now: number) {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    if (start === this.windowStart) return;
    this.previous = start - this.windowStart === this.windowMs ? this.current : new Map();
    this.current = new Map();
    this.windowStart = start;
  }

  /** Weighted count over the last windowMs. */
  count(key: string, now = Date.now()): number {
    this.rotate(now);
    const elapsed = (now - this.windowStart) / this.windowMs;
    return (this.previous.get(key) ?? 0) * (1 - elapsed) + (this.current.get(key) ?? 0);
  }

  private result(key: string, allowed: boolean, now: number, extra = 0): RateLimitResult {
    const used = this.count(key, now) + extra;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, Math.floor(this.limit - used)),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((this.windowStart + this.windowMs - now) / 1000)),
    };
  }

  /** Checks without counting. */
  peek(key: string, cost = 1, now = Date.now()): RateLimitResult {
    if (this.limit <= 0) return { allowed: true, limit: 0, remaining: Infinity, retryAfterSec: 0 };
    return this.result(key, this.count(key, now) + cost <= this.limit, now);
  }

  /** Counts one hit if it fits under the limit. */
  hit(key: string, cost = 1, now = Date.now()): RateLimitResult {
    if (this.limit <= 0) return { allowed: true, limit: 0, remaining: Infinity, retryAfterSec: 0 };
    const allowed = this.count(key, now) + cost <= this.limit;
    if (allowed) this.current.set(key, (this.current.get(key) ?? 0) + cost);
    return this.result(key, allowed, now);
  }

  /** Counts a hit even when over the limit (for failure counters). */
  add(key: string, cost = 1, now = Date.now()) {
    this.rotate(now);
    this.current.set(key, (this.current.get(key) ?? 0) + cost);
  }

  reset(key: string) {
    this.current.delete(key);
    this.previous.delete(key);
  }
}

/** Token bucket for per-connection message rates. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export function minutesText(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} seconds`;
  return `${Math.ceil(sec / 60)} minutes`;
}
