// Sharing by link and access control (team mode): view-only links, links turned off, the Share dialog, and roles.
import { test, expect, newPerson, newGuest, type Person } from './lib/fixtures';
import { createBoard, getBoard, rectJson, setLinkAccess, setMemberRole } from './lib/api';
import { appStateOf, canvasPoint, drag, drawShape, focusCanvas, openBoard, sceneOf, snap, topEdgeOf, waitForElement } from './lib/board';
import { LIVE_TIMEOUT } from './lib/env';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  const { mode } = await (await request.get('/api/auth/user')).json();
  test.skip(mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
});

test.describe('sharing by link', () => {
  let alice: Person;
  let bob: Person;
  let boardId = '';
  let token = '';
  const seeded = `seed-${Date.now().toString(36)}`;

  test.beforeAll(async ({ browser }) => {
    alice = await newPerson(browser, 'Alice', 'share-alice');
    bob = await newGuest(browser, 'Bob');
    const board = await createBoard(alice.request, 'Shared board', [rectJson(seeded, 200, 200)]);
    boardId = board.id;
  });

  test.afterAll(async () => {
    await alice?.context.close();
    await bob?.context.close();
  });

  test('view-only link: the second person can view but not edit', async ({}, testInfo) => {
    token = await setLinkAccess(alice.request, boardId, 'view');
    const opened = await openBoard(bob.page, `/s/${token}`);
    expect(opened.init.board.role).toBe('viewer');
    await expect(bob.page.getByTestId('badge-view-only')).toBeVisible();
    await expect.poll(async () => (await sceneOf(bob.page)).map((e) => e.id)).toEqual([seeded]);
    expect((await appStateOf(bob.page)).viewModeEnabled).toBe(true);
    await snap(bob.page, testInfo, 'bob-view-only');

    const before = (await getBoard(alice.request, boardId)).elements;

    // Try to draw, move, and delete with the mouse and keyboard.
    await focusCanvas(bob.page);
    await bob.page.keyboard.press('r');
    await drag(bob.page, await canvasPoint(bob.page, 0.5, 0.5), await canvasPoint(bob.page, 0.6, 0.6));
    const seededEl = (await sceneOf(bob.page)).find((e) => e.id === seeded)!;
    const edge = await topEdgeOf(bob.page, seededEl);
    await drag(bob.page, edge, { x: edge.x + 120, y: edge.y + 80 });
    await bob.page.mouse.click(edge.x, edge.y);
    await bob.page.keyboard.press('Delete');
    await bob.page.keyboard.press('Control+a');
    await bob.page.keyboard.press('Delete');
    await bob.page.waitForTimeout(1500);

    const after = (await getBoard(alice.request, boardId)).elements;
    expect(after.map((e) => [e.id, e.version, e.x])).toEqual(before.map((e) => [e.id, e.version, e.x]));
    expect((await sceneOf(bob.page)).map((e) => e.id)).toEqual([seeded]);

    // The REST surface refuses changes too.
    const headers = { 'x-board-link': token };
    expect((await bob.request.patch(`/api/boards/${boardId}`, { headers, data: { title: 'Hijacked' } })).status()).toBe(403);
    expect((await bob.request.patch(`/api/boards/${boardId}`, { headers, data: { linkAccess: 'edit' } })).status()).toBe(403);
    expect(
      (
        await bob.request.post(`/api/boards/${boardId}/files`, { headers, data: { fileId: 'x', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' } })
      ).status(),
    ).toBe(403);
    expect((await bob.request.post(`/api/boards/${boardId}/ai`, { headers, data: { prompt: 'add a sticky' } })).status()).toBe(403);

    // The board shows up in Bob's library as shared with him.
    const lib = (await (await bob.request.get('/api/boards')).json()).boards as { id: string; role: string }[];
    expect(lib.find((b) => b.id === boardId)?.role).toBe('viewer');
  });

  test("a view-only visitor still sees the owner's changes live", async ({}, testInfo) => {
    await openBoard(alice.page, `/b/${boardId}`);
    await focusCanvas(alice.page);
    const rect = await drawShape(alice.page, 'r', await canvasPoint(alice.page, 0.55, 0.3), await canvasPoint(alice.page, 0.65, 0.45));
    await waitForElement(bob.page, (e) => e.id === rect.id, { timeout: LIVE_TIMEOUT, message: "owner's rectangle reaches the viewer" });
    await snap(bob.page, testInfo, 'viewer-sees-owner-change');
  });

  test('link off: someone who never had access cannot open the board', async ({ browser }, testInfo) => {
    await setLinkAccess(alice.request, boardId, 'none');
    const carol = await newGuest(browser, 'Carol');
    try {
      await carol.page.goto(`/s/${token}`);
      // A dead link says so, and offers no way to join.
      await expect(carol.page.getByTestId('text-share-error')).toContainText("doesn't work anymore");
      await expect(carol.page.getByTestId('input-guest-name')).toHaveCount(0);
      expect((await carol.request.post('/api/auth/guest', { data: { name: 'Carol', linkToken: token } })).status()).toBe(404);
      expect((await carol.request.get(`/api/boards/${boardId}`, { headers: { 'x-board-link': token } })).status()).toBe(401);
      await snap(carol.page, testInfo, 'carol-no-access');
    } finally {
      await carol.context.close();
    }
  });

  test('link off: the person who opened the view link loses access too', async () => {
    const res = await bob.request.get(`/api/boards/${boardId}`);
    const role = res.status() === 200 ? (await res.json()).board.role : null;
    // Hard rule regardless of the decision above: a view link never grants editing.
    expect(role === 'editor' || role === 'owner', `Bob's role after link off: ${role}`).toBe(false);
    expect(res.status(), `Bob can still open the board after the link was turned off (role: ${role})`).toBe(404);
  });
});

test.describe('Share dialog and roles', () => {
  test('the owner turns the link on from the Share dialog, copies it, and a guest joins with that access', async ({ browser }, testInfo) => {
    const owner = await newPerson(browser, 'Olive');
    const dana = await newGuest(browser, 'Dana');
    try {
      const board = await createBoard(owner.request, 'Dialog board', [rectJson('d1', 0, 0)]);
      await openBoard(owner.page, `/b/${board.id}`);
      await owner.page.getByTestId('button-share').click();
      await expect(owner.page.getByTestId('dialog-share')).toBeVisible();
      await expect(owner.page.getByTestId('input-share-link')).toHaveCount(0);
      await owner.page.getByTestId('select-link-access').click();
      await owner.page.getByRole('option', { name: 'Anyone with the link can view' }).click();
      const link = await owner.page.getByTestId('input-share-link').inputValue();
      expect(link).toMatch(/\/s\/[a-f0-9]+$/);
      await snap(owner.page, testInfo, 'share-dialog-link-on');
      const opened = await openBoard(dana.page, new URL(link).pathname);
      expect(opened.init.board.role).toBe('viewer');
      await expect(dana.page.getByTestId('badge-view-only')).toBeVisible();
    } finally {
      await owner.context.close();
      await dana.context.close();
    }
  });

  test("the owner changes a guest's role live, a role set by the owner wins over the link, and removing someone works while the link is on", async ({
    browser,
  }) => {
    const owner = await newPerson(browser, 'Olive');
    const eli = await newGuest(browser, 'Eli');
    try {
      const board = await createBoard(owner.request, 'Roles board');
      const token = await setLinkAccess(owner.request, board.id, 'view');
      const opened = await openBoard(eli.page, `/s/${token}`);
      expect(opened.init.board.role).toBe('viewer');
      // Guests can't change sharing.
      expect((await eli.request.patch(`/api/boards/${board.id}/link`, { headers: { 'x-board-link': token }, data: { access: 'edit' } })).status()).toBe(403);
      expect(
        (await eli.request.patch(`/api/boards/${board.id}/members/${eli.user.id}`, { headers: { 'x-board-link': token }, data: { role: 'editor' } })).status(),
      ).toBe(403);

      await setMemberRole(owner.request, board.id, eli.user.id, 'editor');
      await expect(eli.page.getByTestId('badge-view-only')).toHaveCount(0, { timeout: LIVE_TIMEOUT });
      await setLinkAccess(owner.request, board.id, 'none');
      expect((await (await eli.request.get(`/api/boards/${board.id}`)).json()).board.role).toBe('editor');

      // A role the owner set wins over the link: viewer on an edit link stays viewer, even when sending the token.
      const editToken = await setLinkAccess(owner.request, board.id, 'edit');
      await setMemberRole(owner.request, board.id, eli.user.id, 'viewer');
      await expect(eli.page.getByTestId('badge-view-only')).toBeVisible({ timeout: LIVE_TIMEOUT });
      const withToken = await eli.request.get(`/api/boards/${board.id}`, { headers: { 'x-board-link': editToken } });
      expect((await withToken.json()).board.role).toBe('viewer');
      expect((await eli.request.patch(`/api/boards/${board.id}`, { headers: { 'x-board-link': editToken }, data: { title: 'x' } })).status()).toBe(403);

      // Removing someone works while the link is still on: their socket closes and the link no longer lets them in.
      const removed = await owner.request.delete(`/api/boards/${board.id}/members/${eli.user.id}`);
      expect(removed.status()).toBe(200);
      await expect(eli.page.getByTestId('text-board-error')).toBeVisible({ timeout: LIVE_TIMEOUT });
      expect((await eli.request.get(`/api/boards/${board.id}`, { headers: { 'x-board-link': editToken } })).status()).toBe(404);
      expect((await eli.request.post('/api/auth/guest', { data: { name: 'Eli', linkToken: editToken } })).status()).toBe(403);
      const people = (await (await owner.request.get(`/api/boards/${board.id}/sharing`)).json()).members as { userId: string }[];
      expect(people.some((m) => m.userId === eli.user.id)).toBe(false);
    } finally {
      await owner.context.close();
      await eli.context.close();
    }
  });
});

test.describe('resetting the link', () => {
  test('cuts off everyone who joined through the old link, but not people whose role the owner set', async ({ browser }) => {
    const owner = await newPerson(browser, 'Olive');
    const fay = await newGuest(browser, 'Fay');
    const gus = await newGuest(browser, 'Gus');
    try {
      const board = await createBoard(owner.request, 'Reset board');
      const oldToken = await setLinkAccess(owner.request, board.id, 'edit');
      await openBoard(fay.page, `/s/${oldToken}`);
      await openBoard(gus.page, `/s/${oldToken}`);
      await setMemberRole(owner.request, board.id, gus.user.id, 'commenter');
      const reset = await owner.request.post(`/api/boards/${board.id}/link/regenerate`, { data: {} });
      expect(reset.status()).toBe(200);
      const { linkToken: newToken } = await reset.json();
      expect(newToken).not.toBe(oldToken);
      await expect(fay.page.getByTestId('text-board-error')).toBeVisible({ timeout: LIVE_TIMEOUT });
      expect((await fay.request.get(`/api/boards/${board.id}`, { headers: { 'x-board-link': oldToken } })).status()).toBe(404);
      expect((await (await gus.request.get(`/api/boards/${board.id}`)).json()).board.role).toBe('commenter');
      // Fay can come back with the new link.
      expect((await fay.request.get(`/api/boards/${board.id}`, { headers: { 'x-board-link': newToken } })).status()).toBe(200);
    } finally {
      await owner.context.close();
      await fay.context.close();
      await gus.context.close();
    }
  });
});
