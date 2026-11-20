// Small fetch helpers for the Monet Blackboard API. All routes live under /api on the same origin.

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown; linkToken?: string | null } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  if (init.linkToken) headers.set('x-board-link', init.linkToken);
  const res = await fetch(`/api${path}`, { ...init, headers, body, credentials: 'include' });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    throw new ApiError(res.status, (data.error as string) || `Request failed (${res.status})`, data);
  }
  return data as T;
}

export interface AuthUser {
  id: string;
  displayName: string;
  kind: 'owner' | 'guest';
}

export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface BoardSummary {
  id: string;
  title: string;
  ownerId: string;
  ownerName?: string;
  role: BoardRole;
  linkAccess: 'none' | 'view' | 'edit';
  linkToken?: string;
  thumbnail: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string | null;
}

export function userName(u: Pick<AuthUser, 'displayName'> | null | undefined) {
  return u?.displayName?.trim() || 'Someone';
}
