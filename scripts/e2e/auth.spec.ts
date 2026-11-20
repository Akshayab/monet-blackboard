// Team mode identity: the owner link, guests joining through a share link with just a name, leaving, renaming,
// and what someone without a link sees. (Solo mode, where there is no sign-in at all, is solo.spec.ts.)
import { test, expect, newPerson, newGuest } from './lib/fixtures';
import { createBoard, getBoard, setLinkAccess } from './lib/api';
import { canvasPoint, drawShape, focusCanvas, openBoard, snap, watchRealtime } from './lib/board';
import { BASE_URL, OWNER_TOKEN } from './lib/env';

test.beforeEach(async ({ request }) => {
  const { mode } = await (await request.get('/api/auth/user')).json();
  test.skip(mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
});

test.describe('owner link', () => {
  test('without a link you only see how to get one; a wrong owner link is refused; the right one opens the library', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await expect(page.getByTestId('text-needs-link')).toBeVisible();
      expect((await page.request.get('/api/boards')).status()).toBe(401);
      expect((await page.request.post('/api/boards', { data: { title: 'x' } })).status()).toBe(401);
      await snap(page, testInfo, 'needs-link');

      await page.goto('/claim#not-the-token');
      await expect(page.getByTestId('text-claim-error')).toBeVisible();
      expect((await page.request.get('/api/boards')).status()).toBe(401);

      await page.goto(`/claim#${OWNER_TOKEN}`);
      await expect(page.getByTestId('button-new-whiteboard')).toBeVisible();
      // The token is dropped from the address bar once used.
      expect(page.url()).not.toContain(OWNER_TOKEN);
      await page.getByTestId('button-user-menu').click();
      await expect(page.getByTestId('text-server-mode')).toHaveText('Owner · team mode');
      await snap(page, testInfo, 'owner-library');
    } finally {
      await context.close();
    }
  });
});

test.describe('guests', () => {
  test('a guest joins from a share link with only a name, edits live, and sees the board in their library', async ({ browser }, testInfo) => {
    const owner = await newPerson(browser, 'Owner');
    const sam = await newGuest(browser, 'Sam Guest');
    try {
      const board = await createBoard(owner.request, 'Guest board');
      const token = await setLinkAccess(owner.request, board.id, 'edit');
      await openBoard(owner.page, `/b/${board.id}`);

      await sam.page.goto(`/s/${token}`);
      await expect(sam.page.getByRole('heading', { name: 'Guest board' })).toBeVisible();
      await expect(sam.page.getByTestId('button-join-board')).toBeDisabled();
      await snap(sam.page, testInfo, 'guest-name-prompt');
      const opened = await openBoard(sam.page, `/s/${token}`);
      expect(opened.init.board.role).toBe('editor');
      expect(opened.init.me.name).toBe('Sam Guest');
      expect(sam.user.id).toMatch(/^guest_/);

      await focusCanvas(sam.page);
      const rect = await drawShape(sam.page, 'r', await canvasPoint(sam.page, 0.4, 0.4), await canvasPoint(sam.page, 0.5, 0.55));
      await expect.poll(async () => (await getBoard(owner.request, board.id)).elements.map((e) => e.id)).toContain(rect.id);

      // The guest's library lists the board; guests can't create boards of their own.
      await sam.page.goto('/');
      await expect(sam.page.getByTestId(`card-board-${board.id}`)).toBeVisible();
      await expect(sam.page.getByTestId('button-new-whiteboard')).toHaveCount(0);
      expect((await sam.request.post('/api/boards', { data: { title: 'Mine' } })).status()).toBe(403);
      expect((await sam.request.post(`/api/boards/${board.id}/duplicate`, { data: {} })).status()).toBe(403);
      await snap(sam.page, testInfo, 'guest-library');

      // The owner sees Sam in the Share dialog.
      await openBoard(owner.page, `/b/${board.id}`);
      await owner.page.getByTestId('button-share').click();
      await expect(owner.page.getByTestId(`row-member-${sam.user.id}`)).toContainText('Sam Guest');
    } finally {
      await owner.context.close();
      await sam.context.close();
    }
  });

  test('a guest can change their name; leaving in another tab ends the open board', async ({ browser }) => {
    const owner = await newPerson(browser, 'Owner');
    const lee = await newGuest(browser, 'Lee');
    try {
      const board = await createBoard(owner.request, 'Leave board');
      const token = await setLinkAccess(owner.request, board.id, 'edit');
      await openBoard(lee.page, `/s/${token}`);
      const renamed = await lee.request.patch('/api/auth/user', { data: { name: 'Lee Park' } });
      expect((await renamed.json()).user.displayName).toBe('Lee Park');
      expect((await lee.request.patch('/api/auth/user', { data: { name: '   ' } })).status()).toBe(400);

      const frames = watchRealtime(lee.page).frames;
      const before = frames.length;
      await lee.request.post('/api/auth/logout');
      await expect.poll(() => frames.slice(before).some((f) => f.t === 'error' && f.code === 'unauthenticated'), { timeout: 10_000 }).toBe(true);
      await expect(lee.page.getByTestId('text-needs-link')).toBeVisible({ timeout: 10_000 });
      expect((await lee.request.get(`/api/boards/${board.id}`)).status()).toBe(401);
    } finally {
      await owner.context.close();
      await lee.context.close();
    }
  });

  test('a link that was turned off or reset shows a clear message, and nobody can join through it', async ({ browser }) => {
    const owner = await newPerson(browser, 'Owner');
    const kim = await newGuest(browser, 'Kim');
    try {
      const board = await createBoard(owner.request, 'Closed board');
      const token = await setLinkAccess(owner.request, board.id, 'view');
      await setLinkAccess(owner.request, board.id, 'none');
      await kim.page.goto(`/s/${token}`);
      await expect(kim.page.getByTestId('text-share-error')).toContainText("doesn't work anymore");
      expect((await kim.request.post('/api/auth/guest', { data: { name: 'Kim', linkToken: token } })).status()).toBe(404);

      const fresh = await setLinkAccess(owner.request, board.id, 'edit');
      expect(fresh).toBe(token);
      const reset = await owner.request.post(`/api/boards/${board.id}/link/regenerate`, { data: {} });
      expect(reset.status()).toBe(200);
      expect((await kim.request.post('/api/auth/guest', { data: { name: 'Kim', linkToken: token } })).status()).toBe(404);
      expect((await kim.request.post('/api/auth/guest', { data: { name: 'Kim', linkToken: (await reset.json()).linkToken } })).status()).toBe(201);
    } finally {
      await owner.context.close();
      await kim.context.close();
    }
  });
});

test.describe('brand', () => {
  test('pages show the Monet Blackboard name and logo', async ({ page, user }) => {
    void user;
    await page.goto('/');
    await expect(page).toHaveTitle(/^Monet Blackboard/);
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', 'Monet Blackboard');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
    expect((await page.request.get('/favicon.svg')).status()).toBe(200);
    await expect(page.locator('header').first()).toContainText('Monet Blackboard');
  });
});
