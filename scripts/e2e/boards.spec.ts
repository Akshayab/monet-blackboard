// Board library: create from the Whiteboard tile, draw, rename, persistence across reloads,
// library listing, reopen, duplicate, delete.
import { test, expect } from './lib/fixtures';
import { getBoard } from './lib/api';
import { canvasPoint, drawShape, focusCanvas, openBoard, sceneOf, snap, waitForBoardReady, watchRealtime } from './lib/board';

test.describe('boards', () => {
  test('create, draw, rename, persist, reopen, duplicate, delete', async ({ page, user }, testInfo) => {
    void user; // signed in
    let boardId = '';
    let rectId = '';
    const title = `Launch plan ${Date.now().toString(36)}`;

    await test.step('create a board from the Whiteboard tile', async () => {
      await page.goto('/');
      const since = watchRealtime(page).frames.length;
      await page.getByTestId('button-new-whiteboard').click();
      await expect(page).toHaveURL(/\/b\/[^/?]+/);
      boardId = new URL(page.url()).pathname.split('/').pop()!;
      await waitForBoardReady(page, since);
      await expect(page.getByTestId('text-board-title')).toHaveText('Untitled board');
    });

    await test.step('draw a rectangle; the server has it', async () => {
      await focusCanvas(page);
      const rect = await drawShape(page, 'r', await canvasPoint(page, 0.3, 0.35), await canvasPoint(page, 0.45, 0.55));
      rectId = rect.id;
      await expect.poll(async () => (await getBoard(page.request, boardId)).elements.map((e) => e.id)).toContain(rectId);
    });

    await test.step('rename the board from its title', async () => {
      await page.getByTestId('text-board-title').click();
      await page.getByTestId('input-board-title').fill(title);
      await page.getByTestId('input-board-title').press('Enter');
      await expect(page.getByTestId('text-board-title')).toHaveText(title);
      await expect.poll(async () => (await getBoard(page.request, boardId)).board.title).toBe(title);
      await snap(page, testInfo, 'drawn-and-renamed');
    });

    await test.step('reload: the drawing and title persisted', async () => {
      await openBoard(page, `/b/${boardId}`);
      await expect.poll(async () => (await sceneOf(page)).map((e) => e.id)).toContain(rectId);
      await expect(page.getByTestId('text-board-title')).toHaveText(title);
    });

    await test.step('it appears in the library and reopens', async () => {
      await page.getByTestId('link-home').click();
      await expect(page.getByTestId(`card-board-${boardId}`)).toBeVisible();
      await expect(page.getByTestId(`text-board-title-${boardId}`)).toHaveText(title);
      await snap(page, testInfo, 'library');
      const since = watchRealtime(page).frames.length;
      await page.getByTestId(`text-board-title-${boardId}`).click();
      await expect(page).toHaveURL(new RegExp(`/b/${boardId}`));
      await waitForBoardReady(page, since);
      await expect.poll(async () => (await sceneOf(page)).map((e) => e.id)).toContain(rectId);
    });

    let copyId = '';
    await test.step('duplicate it from the library', async () => {
      await page.goto('/');
      const card = page.getByTestId(`card-board-${boardId}`);
      await card.hover();
      await page.getByTestId(`button-board-menu-${boardId}`).click();
      await page.getByTestId(`button-board-duplicate-${boardId}`).click();
      // Scope to library cards: the "duplicated" toast repeats the title.
      const copyTitle = page.locator('[data-testid^="text-board-title-"]').filter({ hasText: `${title} (copy)` });
      await expect(copyTitle).toBeVisible();
      const res = await page.request.get('/api/boards');
      const copy = (await res.json()).boards.find((b: { title: string }) => b.title === `${title} (copy)`);
      expect(copy, 'duplicate is in the library').toBeTruthy();
      copyId = copy.id;
      const snapshot = await getBoard(page.request, copyId);
      expect(snapshot.elements.map((e) => e.type)).toEqual(['rectangle']);
    });

    await test.step('rename the copy from the library menu', async () => {
      await page.getByTestId(`card-board-${copyId}`).hover();
      await page.getByTestId(`button-board-menu-${copyId}`).click();
      await page.getByTestId(`button-board-rename-${copyId}`).click();
      await page.getByTestId('input-rename').fill(`${title} v2`);
      await page.getByTestId('button-rename-save').click();
      await expect(page.getByTestId(`text-board-title-${copyId}`)).toHaveText(`${title} v2`);
    });

    await test.step('delete the original', async () => {
      await page.getByTestId(`card-board-${boardId}`).hover();
      await page.getByTestId(`button-board-menu-${boardId}`).click();
      await page.getByTestId(`button-board-delete-${boardId}`).click();
      // The library asks for confirmation in its own dialog.
      await page.getByTestId('button-confirm-delete').click();
      await expect(page.getByTestId(`card-board-${boardId}`)).toHaveCount(0);
      expect((await page.request.get(`/api/boards/${boardId}`)).status()).toBe(404);
      await page.reload();
      await expect(page.getByTestId(`card-board-${copyId}`)).toBeVisible();
      await expect(page.getByTestId(`card-board-${boardId}`)).toHaveCount(0);
      await snap(page, testInfo, 'after-delete');
    });
  });

  test('long titles and odd input get clear answers: duplicate, top-bar rename, empty updates, NUL characters, deleted boards', async ({ page, user }) => {
    void user;
    await test.step('a board with a 200-character title can be duplicated', async () => {
      const { board } = await (await page.request.post('/api/boards', { data: { title: 'L'.repeat(200) } })).json();
      const dup = await page.request.post(`/api/boards/${board.id}/duplicate`, { data: {} });
      expect(dup.status(), await dup.text()).toBe(201);
      const copy = (await dup.json()).board;
      expect([...copy.title].length).toBeLessThanOrEqual(200);
      expect(copy.title.endsWith(' (copy)')).toBe(true);
    });

    await test.step('a NUL byte in an address is a 400, not a server error', async () => {
      for (const path of ['/api/boards/%00', '/api/boards/a%00b/files', '/api/share/a%00b', '/api/boards/a%00b/sharing']) {
        expect((await page.request.get(path)).status(), path).toBe(400);
      }
    });

    await test.step('an update with nothing to change is a 400, not a server error', async () => {
      const { board } = await (await page.request.post('/api/boards', { data: { title: 'Empty update' } })).json();
      const res = await page.request.patch(`/api/boards/${board.id}`, { data: {} });
      expect(res.status(), await res.text()).toBe(400);
    });

    await test.step('titles with a NUL character (pasted text) are cleaned, not refused with a server error', async () => {
      const created = await page.request.post('/api/boards', { data: { title: 'Plan\u0000 A' } });
      expect(created.status(), await created.text()).toBe(201);
      const { board } = await created.json();
      expect(board.title).toBe('Plan A');
      const renamed = await page.request.patch(`/api/boards/${board.id}`, { data: { title: 'Plan\u0000 B' } });
      expect(renamed.status(), await renamed.text()).toBe(200);
      expect((await getBoard(page.request, board.id)).board.title).toBe('Plan B');
    });

    await test.step('deleting a board that is open says it was deleted, not that access was removed', async () => {
      const { board } = await (await page.request.post('/api/boards', { data: { title: 'Deleted while open' } })).json();
      await openBoard(page, `/b/${board.id}`);
      expect((await page.request.delete(`/api/boards/${board.id}`)).status()).toBe(200);
      await expect(page.getByTestId('text-board-error')).toHaveText('This board was deleted.');
    });

    await test.step('renaming from the board top bar stops at 200 characters and saves', async () => {
      const { board } = await (await page.request.post('/api/boards', { data: { title: 'Short title' } })).json();
      await openBoard(page, `/b/${board.id}`);
      await page.getByTestId('text-board-title').click();
      await page.getByTestId('input-board-title').fill('Very long title '.repeat(16));
      expect((await page.getByTestId('input-board-title').inputValue()).length).toBe(200);
      await page.getByTestId('input-board-title').press('Enter');
      const expected = 'Very long title '.repeat(16).slice(0, 200).trim();
      await expect.poll(async () => (await getBoard(page.request, board.id)).board.title).toBe(expected);
      await expect(page.getByTestId('text-board-title')).toHaveText(expected);
    });
  });
});
