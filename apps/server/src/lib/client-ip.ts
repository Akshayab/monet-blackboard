// Client IP resolution for rate limiting. Works for Express requests and raw WebSocket upgrade requests.
//
// Uses the same rule as Express's "trust proxy" setting (TRUST_PROXY): X-Forwarded-For hops are trusted only while
// they come from a trusted proxy, so behind a reverse proxy each person gets their own bucket and nobody can pick
// their own address by sending the header. IPv6 addresses are grouped by /64 so one host can't rotate around a limit.
import net from "net";
import type { IncomingMessage } from "http";
import proxyaddr from "proxy-addr";
import { config } from "./config";

/** Compiles a TRUST_PROXY value the way Express does: true/false, a hop count, or comma-separated names and CIDRs. */
export function compileTrust(value: string): (addr: string, i: number) => boolean {
  const v = value.trim();
  if (v === "true") return () => true;
  if (v === "false" || v === "") return () => false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_addr, i) => i < hops;
  }
  return proxyaddr.compile(
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const defaultTrust = compileTrust(config.trustProxy);

function normalize(ip: string): string {
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) return ip.slice(7);
  return ip;
}

/** Expands an IPv6 address and returns its /64 prefix, e.g. "2001:db8:1:2::/64". */
function ipv6Prefix(ip: string): string {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  const parts = [...h, ...fill, ...t].map((p) => p.toLowerCase().replace(/^0+(?=.)/, ""));
  return `${parts.slice(0, 4).join(":")}::/64`;
}

/** Picks the client address from an X-Forwarded-For value and the socket's address, under a TRUST_PROXY value. */
export function clientIpFrom(xff: string | string[] | undefined, remote: string | undefined, trust: string = config.trustProxy): string {
  const fn = trust === config.trustProxy ? defaultTrust : compileTrust(trust);
  const req = {
    headers: { "x-forwarded-for": Array.isArray(xff) ? xff.join(",") : xff },
    socket: { remoteAddress: remote },
    connection: { remoteAddress: remote },
  };
  let ip: string;
  try {
    ip = normalize(proxyaddr(req as unknown as IncomingMessage, fn) || "unknown");
  } catch {
    ip = "unknown";
  }
  return net.isIPv6(ip) ? ipv6Prefix(ip) : ip;
}

export function clientIp(req: IncomingMessage): string {
  return clientIpFrom(req.headers["x-forwarded-for"], req.socket?.remoteAddress);
}
