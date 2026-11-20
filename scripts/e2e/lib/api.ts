// REST helpers. Every helper takes an APIRequestContext; a BrowserContext's `request` shares the browser's
// cookies, so claiming the owner link or joining as a guest through it identifies the browser too.
//
// The suite runs against a server in team mode whose owner link is pinned with OWNER_LINK_TOKEN (see env.ts).
import { expect, type APIRequestContext } from '@playwright/test';
import { OWNER_TOKEN } from './env';

export interface TestUser {
  id: string;
  name: string;
  kind: 'owner' | 'guest';
}

export interface BoardInfo {
  id: string;
  title: string;
  ownerId: string;
  role: 'owner' | 'editor' | 'commenter' | 'viewer';
  linkAccess: 'none' | 'view' | 'edit';
  linkToken?: string;
}

/**
 * Becomes the owner in this context (the owner link). There is one owner per install and tests run in parallel, so
 * tests never rename the owner; read the owner's name from the returned user.
 */
export async function claimOwner(request: APIRequestContext): Promise<TestUser> {
  const res = await request.post('/api/auth/claim', { data: { token: OWNER_TOKEN } });
  expect(res.status(), `claim owner: ${await res.text()}`).toBe(200);
  const { user } = await res.json();
  return { id: user.id, name: user.displayName, kind: 'owner' };
}

/** Joins as a guest through a board's share link (what the name prompt on /s/:token does). */
export async function joinAsGuest(request: APIRequestContext, name: string, linkToken: string): Promise<TestUser> {
  const res = await request.post('/api/auth/guest', { data: { name, linkToken } });
  expect(res.status(), `join as guest: ${await res.text()}`).toBeLessThan(300);
  const { user } = await res.json();
  return { id: user.id, name: user.displayName, kind: user.kind };
}

export async function createBoard(request: APIRequestContext, title = 'E2E board', elements?: Record<string, unknown>[]): Promise<BoardInfo> {
  const res = await request.post('/api/boards', { data: { title, ...(elements ? { elements } : {}) } });
  expect(res.status(), `create board: ${await res.text()}`).toBe(201);
  return (await res.json()).board as BoardInfo;
}

export interface BoardSnapshot {
  board: BoardInfo;
  elements: SceneJson[];
}

export interface SceneJson {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  text?: string;
  strokeColor?: string;
  backgroundColor?: string;
  frameId?: string | null;
  customData?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The server's live view of a board (the realtime room, so it includes unsaved changes). */
export async function getBoard(request: APIRequestContext, boardId: string, linkToken?: string): Promise<BoardSnapshot> {
  const res = await request.get(`/api/boards/${boardId}`, { headers: linkToken ? { 'x-board-link': linkToken } : {} });
  expect(res.status(), `get board: ${await res.text()}`).toBe(200);
  return (await res.json()) as BoardSnapshot;
}

export async function setLinkAccess(request: APIRequestContext, boardId: string, linkAccess: 'none' | 'view' | 'edit'): Promise<string> {
  const res = await request.patch(`/api/boards/${boardId}`, { data: { linkAccess } });
  expect(res.status(), `set link access: ${await res.text()}`).toBe(200);
  const { board } = await getBoard(request, boardId);
  expect(board.linkToken, 'owner can read the link token').toBeTruthy();
  return board.linkToken!;
}

export async function setMemberRole(request: APIRequestContext, boardId: string, userId: string, role: 'editor' | 'commenter' | 'viewer') {
  const res = await request.patch(`/api/boards/${boardId}/members/${userId}`, { data: { role } });
  expect(res.status(), `set member role: ${await res.text()}`).toBe(200);
}

export async function listBoards(request: APIRequestContext): Promise<BoardInfo[]> {
  const res = await request.get('/api/boards');
  expect(res.status()).toBe(200);
  return (await res.json()).boards as BoardInfo[];
}

/** Minimal Excalidraw rectangle JSON for seeding boards over the API. Clients restore missing fields. */
export function rectJson(id: string, x: number, y: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 160,
    height: 100,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: '#a5d8ff',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    index: 'a0',
    ...extra,
  };
}
