// Fast protocol checks with no browser: the owner link and a guest join over REST, plus raw WebSocket clients on /api/ws, exercising
// the realtime contract in lib/board-protocol/src/messages.ts (hello/init, element broadcast, version
// rule, tombstones, presence, pointers, read-only, persistence, board deletion).
// Run alone with `pnpm --filter @monet/scripts run e2e:api`.
import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { claimOwner, createBoard, getBoard, joinAsGuest, setLinkAccess, type TestUser } from './lib/api';
import { BASE_URL } from './lib/env';

test.describe.configure({ mode: 'serial' });

type Msg = { t: string; [k: string]: any };

/** A raw realtime client. Uses the same `sid` cookie as the browser. */
class WsClient {
  messages: Msg[] = [];
  closed: Promise<{ code: number; reason: string }>;
  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
    ws.addEventListener('message', (e) => {
      try {
        this.messages.push(JSON.parse(String(e.data)));
      } catch {
        /* ignore */
      }
    });
  }

  static async open(cookie: string | null): Promise<WsClient> {
    const url = `${BASE_URL.replace(/^http/, 'ws')}/api/ws`;
    // Node's WebSocket (undici) accepts extra headers; the browser sends the cookie automatically.
    const Ctor = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
    const ws = new Ctor(url, { headers: cookie ? { cookie } : {} });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket failed to open')), { once: true });
    });
    return new WsClient(ws);
  }

  send(msg: Msg) {
    this.ws.send(JSON.stringify(msg));
  }

  mark() {
    return this.messages.length;
  }

  async waitFor(pred: (m: Msg) => boolean, opts: { since?: number; timeout?: number; what?: string } = {}): Promise<Msg> {
    const deadline = Date.now() + (opts.timeout ?? 5_000);
    for (;;) {
      const found = this.messages.slice(opts.since ?? 0).find(pred);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${opts.what ?? 'message'}; got: ${JSON.stringify(this.messages.slice(opts.since ?? 0).map((m) => m.t))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async expectNone(pred: (m: Msg) => boolean, since: number, ms = 800) {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.messages.slice(since).filter(pred), 'unexpected messages').toEqual([]);
  }

  /** Sends hello and waits for init (or an error). */
  async hello(boardId: string, linkToken?: string | null): Promise<Msg> {
    const since = this.mark();
    this.send({ t: 'hello', boardId, linkToken: linkToken ?? null });
    return this.waitFor((m) => m.t === 'init' || m.t === 'error', { since, what: 'init' });
  }

  close() {
    this.ws.close();
  }
}

function rect(id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) {
  return { id, type: 'rectangle', x: 100, y: 100, width: 120, height: 80, version, versionNonce, isDeleted: false, index: 'a0', updated: Date.now(), ...extra };
}

/** The owner (claims the owner link), or a guest who joins through `linkToken`. */
async function person(name: string, linkToken?: string) {
  const request = await pwRequest.newContext({ baseURL: BASE_URL });
  const user = linkToken ? await joinAsGuest(request, name, linkToken) : await claimOwner(request);
  const sid = (await request.storageState()).cookies.find((c) => c.name === 'sid');
  expect(sid, 'session cookie').toBeTruthy();
  return { request, user, cookie: `sid=${sid!.value}` };
}

test.describe('realtime protocol (two WebSocket clients, no browser)', () => {
  let alice: { request: APIRequestContext; user: TestUser; cookie: string };
  let bob: { request: APIRequestContext; user: TestUser; cookie: string };
  let carol: { request: APIRequestContext; user: TestUser; cookie: string };
  let boardId = '';
  let token = '';
  let a: WsClient;
  let b: WsClient;
  const id = `ws-${Date.now().toString(36)}`;

  test.beforeAll(async ({ request }) => {
    const { mode } = await (await request.get('/api/auth/user')).json();
    test.skip(mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
    alice = await person('Alice');
    boardId = (await createBoard(alice.request, 'Protocol board')).id;
    token = await setLinkAccess(alice.request, boardId, 'edit');
    bob = await person('Bob', token);
    // Carol joined another board's link, so she is a guest with no access to this one.
    const other = (await createBoard(alice.request, 'Carol only')).id;
    carol = await person('Carol', await setLinkAccess(alice.request, other, 'view'));
  });

  test.afterAll(async () => {
    a?.close();
    b?.close();
    await Promise.all([alice?.request.dispose(), bob?.request.dispose(), carol?.request.dispose()]);
  });

  test('a socket without a session is refused (4401)', async () => {
    const anon = await WsClient.open(null);
    const res = await anon.hello(boardId);
    expect(res).toMatchObject({ t: 'error', code: 'unauthenticated' });
    expect((await anon.closed).code).toBe(4401);
  });

  test('a signed-in user without access is refused (4403)', async () => {
    const c = await WsClient.open(carol.cookie);
    const res = await c.hello(boardId);
    expect(res).toMatchObject({ t: 'error', code: 'forbidden' });
    expect((await c.closed).code).toBe(4403);
  });

  test('owner and link editor join; presence lists both', async () => {
    a = await WsClient.open(alice.cookie);
    const initA = await a.hello(boardId);
    expect(initA).toMatchObject({ t: 'init', board: { id: boardId, role: 'owner' } });
    b = await WsClient.open(bob.cookie);
    const since = a.mark();
    const initB = await b.hello(boardId, token);
    expect(initB).toMatchObject({ t: 'init', board: { role: 'editor' } });
    expect(initB.collaborators.map((c: Msg) => c.userId).sort()).toEqual([alice.user.id, bob.user.id].sort());
    const presence = await a.waitFor((m) => m.t === 'presence' && m.collaborators.length === 2, { since, what: 'presence' });
    expect(presence.collaborators.find((c: Msg) => c.userId === bob.user.id)?.role).toBe('editor');
  });

  test('an element change reaches the other client and is not echoed back', async () => {
    const sinceA = a.mark();
    const sinceB = b.mark();
    const started = Date.now();
    a.send({ t: 'elements', elements: [rect(id, 1, 500)] });
    const got = await b.waitFor((m) => m.t === 'elements' && m.elements.some((e: Msg) => e.id === id), { since: sinceB, what: 'elements on B' });
    test.info().annotations.push({ type: 'latency', description: `A -> server -> B: ${Date.now() - started} ms` });
    expect(got.source).toBe('user');
    await a.expectNone((m) => m.t === 'elements', sinceA);

    const sinceA2 = a.mark();
    b.send({ t: 'elements', elements: [rect(id, 2, 400, { x: 300 })] });
    const back = await a.waitFor((m) => m.t === 'elements', { since: sinceA2, what: 'elements on A' });
    expect(back.elements[0]).toMatchObject({ id, version: 2, x: 300 });
    await expect.poll(async () => (await getBoard(alice.request, boardId)).elements.find((e) => e.id === id)?.x).toBe(300);
  });

  test('version rule: stale updates are dropped, ties go to the lower versionNonce', async () => {
    const sinceB = b.mark();
    a.send({ t: 'elements', elements: [rect(id, 1, 1, { x: -999 })] }); // older version
    await b.expectNone((m) => m.t === 'elements', sinceB);
    expect((await getBoard(alice.request, boardId)).elements.find((e) => e.id === id)?.x).toBe(300);

    a.send({ t: 'elements', elements: [rect(id, 3, 100, { x: 111 })] });
    await b.waitFor((m) => m.t === 'elements' && m.elements[0].x === 111, { since: sinceB, what: 'v3 nonce 100' });
    const sinceA = a.mark();
    b.send({ t: 'elements', elements: [rect(id, 3, 50, { x: 222 })] }); // same version, lower nonce wins
    await a.waitFor((m) => m.t === 'elements' && m.elements[0].x === 222, { since: sinceA, what: 'v3 nonce 50' });
    const sinceB2 = b.mark();
    a.send({ t: 'elements', elements: [rect(id, 3, 75, { x: 333 })] }); // same version, higher nonce loses
    await b.expectNone((m) => m.t === 'elements', sinceB2);
    const server = (await getBoard(alice.request, boardId)).elements.find((e) => e.id === id)!;
    expect([server.version, server.versionNonce, server.x]).toEqual([3, 50, 222]);
  });

  test("pointers, viewports, and selections are relayed with the sender's socket id", async () => {
    const meA = a.messages.find((m) => m.t === 'init')!.me.socketId;
    const sinceB = b.mark();
    a.send({ t: 'pointer', x: 12, y: 34, tool: 'pointer', button: 'up' });
    a.send({ t: 'viewport', viewport: { scrollX: -50, scrollY: 20, zoom: 1.5, width: 1200, height: 800 } });
    a.send({ t: 'selection', ids: [id] });
    expect(await b.waitFor((m) => m.t === 'pointer', { since: sinceB })).toMatchObject({ socketId: meA, x: 12, y: 34 });
    expect(await b.waitFor((m) => m.t === 'viewport', { since: sinceB })).toMatchObject({ socketId: meA, viewport: { zoom: 1.5 } });
    expect(await b.waitFor((m) => m.t === 'selection', { since: sinceB })).toMatchObject({ socketId: meA, ids: [id] });
  });

  test('deletes propagate, and late joiners get the tombstone', async () => {
    const sinceB = b.mark();
    a.send({ t: 'elements', elements: [rect(id, 4, 10, { x: 222, isDeleted: true })] });
    const del = await b.waitFor((m) => m.t === 'elements' && m.elements[0].isDeleted === true, { since: sinceB, what: 'delete' });
    expect(del.elements[0].id).toBe(id);
    expect((await getBoard(alice.request, boardId)).elements.map((e) => e.id)).not.toContain(id);
    const late = await WsClient.open(bob.cookie);
    const init = await late.hello(boardId, token);
    expect(init.elements.find((e: Msg) => e.id === id)?.isDeleted).toBe(true);
    late.close();
  });

  test('view-only clients receive changes but cannot send them', async () => {
    await setLinkAccess(alice.request, boardId, 'view');
    const c = await WsClient.open(carol.cookie);
    const init = await c.hello(boardId, token);
    expect(init).toMatchObject({ t: 'init', board: { role: 'viewer' } });

    const sinceA = a.mark();
    const sinceC = c.mark();
    c.send({ t: 'elements', elements: [rect(`${id}-viewer`, 1, 1)] });
    expect(await c.waitFor((m) => m.t === 'error', { since: sinceC })).toMatchObject({ code: 'read_only' });
    await a.expectNone((m) => m.t === 'elements', sinceA);
    expect((await getBoard(alice.request, boardId)).elements.map((e) => e.id)).not.toContain(`${id}-viewer`);

    a.send({ t: 'elements', elements: [rect(`${id}-2`, 1, 1)] });
    await c.waitFor((m) => m.t === 'elements' && m.elements[0].id === `${id}-2`, { since: sinceC, what: 'owner change on viewer' });
    c.close();
  });

  test('changes persist after everyone leaves', async () => {
    a.close();
    b.close();
    await Promise.all([a.closed, b.closed]);
    // The room saves when its last socket leaves; read it back through a fresh client.
    await expect
      .poll(
        async () => {
          const fresh = await WsClient.open(alice.cookie);
          const init = await fresh.hello(boardId);
          fresh.close();
          return init.elements.map((e: Msg) => `${e.id}:${e.version}:${e.isDeleted ? 'deleted' : 'live'}`).sort();
        },
        { timeout: 10_000 },
      )
      .toEqual([`${id}-2:1:live`, `${id}:4:deleted`].sort());
    expect((await getBoard(alice.request, boardId)).elements.map((e) => e.id)).toEqual([`${id}-2`]);
  });

  test('text with a NUL character or half an emoji is cleaned and the board still saves', async () => {
    const board = await createBoard(alice.request, 'Odd characters');
    const c = await WsClient.open(alice.cookie);
    await c.hello(board.id);
    // Baseline after the room loaded (its first load may touch the row); only a successful save moves it again.
    const createdAt = ((await getBoard(alice.request, board.id)).board as unknown as { updatedAt: string }).updatedAt;
    // Text pasted from PDFs can carry NULs; cutting a string mid-emoji leaves a lone surrogate. Postgres refuses both,
    // which used to fail every later save of the board.
    c.send({
      t: 'elements',
      elements: [
        rect(`${id}-nul`, 1, 1, { type: 'text', text: 'pasted\u0000text', originalText: 'pasted\u0000text', index: 'a1' }),
        rect(`${id}-half`, 1, 1, { type: 'text', text: 'half \ud83d', originalText: 'half \ud83d', index: 'a2' }),
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    c.close();
    await c.closed;
    await expect
      .poll(
        async () => {
          const snap = await getBoard(alice.request, board.id);
          const saved = (snap.board as unknown as { updatedAt: string }).updatedAt !== createdAt;
          return { saved, texts: snap.elements.map((e) => (e as { text?: string }).text).sort() };
        },
        { timeout: 10_000 },
      )
      .toEqual({ saved: true, texts: ['half \ufffd', 'pastedtext'] });
  });

  test('deleting the board tells connected clients', async () => {
    const c = await WsClient.open(alice.cookie);
    await c.hello(boardId);
    const since = c.mark();
    expect((await alice.request.delete(`/api/boards/${boardId}`)).status()).toBe(200);
    expect(await c.waitFor((m) => m.t === 'error', { since })).toMatchObject({ code: 'deleted' });
    expect((await alice.request.get(`/api/boards/${boardId}`)).status()).toBe(404);
    c.close();
  });
});
