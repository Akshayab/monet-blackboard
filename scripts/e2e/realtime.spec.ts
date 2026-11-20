// Realtime collaboration: two different signed-in people in separate browser contexts on
// the same board. Every change must reach the other person live, without a reload.
import { test, expect, newPerson, newGuest, type Person } from './lib/fixtures';
import { createBoard, getBoard, setLinkAccess } from './lib/api';
import {
  addText,
  appStateOf,
  canvasPoint,
  drag,
  drawShape,
  focusCanvas,
  openBoard,
  sceneOf,
  snap,
  toScene,
  toScreen,
  topEdgeOf,
  viewportCenter,
  waitForElement,
  type El,
  type OpenedBoard,
} from './lib/board';
import { LIVE_TIMEOUT } from './lib/env';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  const { mode } = await (await request.get('/api/auth/user')).json();
  test.skip(mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
});

test.describe('realtime: two people on one board', () => {
  let alice: Person;
  let bob: Person;
  let boardId = '';
  let aliceBoard: OpenedBoard;
  let bobBoard: OpenedBoard;
  let rect: El;
  let bobText: El;

  test.beforeAll(async ({ browser }) => {
    alice = await newPerson(browser, 'Alice', 'rt-alice');
    bob = await newGuest(browser, 'Bob');
    const board = await createBoard(alice.request, 'Realtime board');
    boardId = board.id;
    const token = await setLinkAccess(alice.request, boardId, 'edit');
    aliceBoard = await openBoard(alice.page, `/b/${boardId}`);
    // Bob joins through the share link (edit access).
    bobBoard = await openBoard(bob.page, `/s/${token}`);
    await focusCanvas(alice.page);
    await focusCanvas(bob.page);
    // Marker that disappears if Bob's page reloads: every check below must arrive live.
    await bob.page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    await alice.page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  });

  test.afterAll(async () => {
    await alice?.context.close();
    await bob?.context.close();
  });

  test.afterEach(async () => {
    expect(await bob.page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'Bob never reloaded').toBe(true);
    expect(await alice.page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'Alice never reloaded').toBe(true);
  });

  test('both people join: owner and link editor', async () => {
    expect(aliceBoard.init.board.role).toBe('owner');
    expect(bobBoard.init.board.role).toBe('editor');
    expect(bob.page.url()).toContain(`/b/${boardId}?link=`);
    await expect(bob.page.getByTestId('badge-view-only')).toHaveCount(0);
  });

  test('Alice draws a shape; Bob sees it live', async ({}, testInfo) => {
    const started = Date.now();
    rect = await drawShape(alice.page, 'r', await canvasPoint(alice.page, 0.3, 0.3), await canvasPoint(alice.page, 0.42, 0.45));
    const seen = await waitForElement(bob.page, (e) => e.id === rect.id, { message: 'rectangle reaches Bob' });
    testInfo.annotations.push({ type: 'latency', description: `Alice draw -> Bob scene: ${Date.now() - started} ms (includes drawing)` });
    expect(seen.type).toBe('rectangle');
    expect(Math.round(seen.x)).toBe(Math.round(rect.x));
    await snap(bob.page, testInfo, 'bob-sees-alice-rectangle');
  });

  test('Bob moves it, adds text, recolors; Alice sees each change live', async ({}, testInfo) => {
    await bob.page.keyboard.press('Escape');
    const local = (await sceneOf(bob.page)).find((e) => e.id === rect.id)!;
    const grab = await topEdgeOf(bob.page, local);
    await drag(bob.page, grab, { x: grab.x + 100, y: grab.y + 50 }, 10);
    await expect
      .poll(async () => Math.round(((await sceneOf(alice.page)).find((e) => e.id === rect.id)?.x ?? 0) - rect.x), { timeout: LIVE_TIMEOUT })
      .toBe(100);

    // The rectangle is still selected on Bob's side: recolor it.
    await bob.page.getByTestId('color-top-pick-#2f9e44').click();
    await expect.poll(async () => (await sceneOf(alice.page)).find((e) => e.id === rect.id)?.strokeColor, { timeout: LIVE_TIMEOUT }).toBe('#2f9e44');

    await bob.page.keyboard.press('Escape');
    bobText = await addText(bob.page, await canvasPoint(bob.page, 0.3, 0.65), 'Hello from Bob');
    await waitForElement(alice.page, (e) => e.id === bobText.id && e.text === 'Hello from Bob', { message: "Bob's text reaches Alice" });
    await snap(alice.page, testInfo, 'alice-sees-bob-edits');
  });

  test("Alice edits Bob's text; Bob sees the new words live", async () => {
    await alice.page.keyboard.press('Escape');
    const t = (await sceneOf(alice.page)).find((e) => e.id === bobText.id)!;
    const p = await toScreen(alice.page, t.x + t.width / 2, t.y + t.height / 2);
    await alice.page.mouse.dblclick(p.x, p.y);
    await alice.page.locator('textarea.excalidraw-wysiwyg').waitFor();
    await alice.page.keyboard.press('Control+a');
    await alice.page.keyboard.type('Edited by Alice');
    await alice.page.keyboard.press('Escape');
    await waitForElement(bob.page, (e) => e.id === bobText.id && e.text === 'Edited by Alice', { message: 'edited text reaches Bob' });
  });

  test("presence: each sees the other's avatar, and Bob sees Alice's cursor", async ({}, testInfo) => {
    await expect(bob.page.getByTestId(`avatar-${alice.user.id}`)).toBeVisible();
    await expect(alice.page.getByTestId(`avatar-${bob.user.id}`)).toBeVisible();
    // Excalidraw's own collaborator list also shows the other person.
    const aliceSocket = aliceBoard.init.me.socketId as string;

    const target = await canvasPoint(alice.page, 0.62, 0.4);
    for (let i = 5; i >= 0; i--) {
      await alice.page.mouse.move(target.x - i * 20, target.y - i * 10);
      await alice.page.waitForTimeout(60); // the client sends at most one pointer update per 40 ms
    }
    const expected = await toScene(alice.page, target.x, target.y);
    await expect
      .poll(
        async () => {
          const c = (await appStateOf(bob.page)).collaborators.find((x) => x.socketId === aliceSocket);
          return c?.pointer ? Math.hypot(c.pointer.x - expected.x, c.pointer.y - expected.y) : Infinity;
        },
        { timeout: LIVE_TIMEOUT, message: "Alice's cursor position on Bob's screen" },
      )
      .toBeLessThan(3);
    const label = (await appStateOf(bob.page)).collaborators.find((x) => x.socketId === aliceSocket)?.username;
    expect(label).toBe(alice.user.name);
    await snap(bob.page, testInfo, 'bob-sees-alice-cursor');
  });

  test('simultaneous drawing converges for both people and the server', async () => {
    const [a, b] = await Promise.all([
      drawShape(alice.page, 'o', await canvasPoint(alice.page, 0.55, 0.6), await canvasPoint(alice.page, 0.65, 0.72)),
      drawShape(bob.page, 'd', await canvasPoint(bob.page, 0.7, 0.6), await canvasPoint(bob.page, 0.8, 0.72)),
    ]);
    await waitForElement(alice.page, (e) => e.id === b.id, { message: "Bob's diamond reaches Alice" });
    await waitForElement(bob.page, (e) => e.id === a.id, { message: "Alice's ellipse reaches Bob" });
    const ids = async (p: Person) => (await sceneOf(p.page)).map((e) => e.id).sort();
    await expect.poll(async () => (await getBoard(alice.request, boardId)).elements.map((e) => e.id).sort()).toEqual(await ids(alice));
    expect(await ids(bob)).toEqual(await ids(alice));
  });

  test('deletes propagate both ways', async () => {
    await alice.page.keyboard.press('Escape');
    const r = (await sceneOf(alice.page)).find((e) => e.id === rect.id)!;
    const edge = await topEdgeOf(alice.page, r);
    await alice.page.mouse.click(edge.x, edge.y);
    await expect.poll(async () => (await appStateOf(alice.page)).selectedIds).toEqual([rect.id]);
    await alice.page.keyboard.press('Delete');
    await expect.poll(async () => (await sceneOf(bob.page)).map((e) => e.id), { timeout: LIVE_TIMEOUT }).not.toContain(rect.id);

    await bob.page.keyboard.press('Escape');
    const t = (await sceneOf(bob.page)).find((e) => e.id === bobText.id)!;
    const p = await toScreen(bob.page, t.x + t.width / 2, t.y + t.height / 2);
    await bob.page.mouse.click(p.x, p.y);
    await expect.poll(async () => (await appStateOf(bob.page)).selectedIds).toEqual([bobText.id]);
    await bob.page.keyboard.press('Delete');
    await expect.poll(async () => (await sceneOf(alice.page)).map((e) => e.id), { timeout: LIVE_TIMEOUT }).not.toContain(bobText.id);
    const server = (await getBoard(alice.request, boardId)).elements.map((e) => e.id);
    expect(server).not.toContain(rect.id);
    expect(server).not.toContain(bobText.id);
  });

  test("renaming the board updates the other person's title live", async () => {
    await alice.page.getByTestId('text-board-title').click();
    await alice.page.getByTestId('input-board-title').fill('Realtime board (renamed)');
    await alice.page.getByTestId('input-board-title').press('Enter');
    await expect(bob.page.getByTestId('text-board-title')).toHaveText('Realtime board (renamed)', { timeout: LIVE_TIMEOUT });
  });

  test('follow mode: Bob follows Alice; his view moves with her pan and zoom', async ({}, testInfo) => {
    await bob.page.getByTestId(`avatar-${alice.user.id}`).click();

    // Alice pans with the hand tool at a human pace, pauses, then zooms in.
    await alice.page.keyboard.press('Escape');
    await alice.page.keyboard.press('h');
    const from = await canvasPoint(alice.page, 0.5, 0.5);
    await alice.page.mouse.move(from.x, from.y);
    await alice.page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await alice.page.mouse.move(from.x - i * 40, from.y - i * 25);
      await alice.page.waitForTimeout(40);
    }
    await alice.page.mouse.up();
    await alice.page.keyboard.press('v');
    await alice.page.waitForTimeout(300);
    await alice.page.getByTestId('button-zoom-menu').click();
    await alice.page.getByTestId('menu-zoom-in').click();

    const aState = await appStateOf(alice.page);
    await expectBobOnAlicesView(aState);
    await snap(bob.page, testInfo, 'bob-following-alice');
  });

  test('follow mode: clicking the avatar again stops following', async () => {
    await bob.page.getByTestId(`avatar-${alice.user.id}`).click();
    const bobBefore = viewportCenter(await appStateOf(bob.page));
    const p = await canvasPoint(alice.page, 0.5, 0.5);
    await alice.page.mouse.move(p.x, p.y);
    await alice.page.mouse.wheel(0, 600);
    await alice.page.waitForTimeout(1000);
    const bobAfter = viewportCenter(await appStateOf(bob.page));
    expect(Math.hypot(bobAfter.x - bobBefore.x, bobAfter.y - bobBefore.y)).toBeLessThan(1);
  });

  test('a fresh load shows both people the same board', async () => {
    const aliceIds = (await sceneOf(alice.page)).map((e) => e.id).sort();
    // Open the board in a second tab for Bob (keeps the no-reload marker on his first tab).
    const tab = await bob.context.newPage();
    await openBoard(tab, `/b/${boardId}`);
    await expect.poll(async () => (await sceneOf(tab)).map((e) => e.id).sort()).toEqual(aliceIds);
    await tab.close();
  });

  // Kept last: in serial mode a failure skips the tests after it.
  test("follow mode: Bob lands on Alice's final view after quick wheel scrolling", async ({}, testInfo) => {
    testInfo.annotations.push({
      type: 'note',
      description: "Wheel scrolling fires many viewport changes within 120 ms; the follower must end on the leader's final view, not an earlier one.",
    });
    await bob.page.getByTestId(`avatar-${alice.user.id}`).click();
    const p = await canvasPoint(alice.page, 0.5, 0.5);
    await alice.page.mouse.move(p.x, p.y);
    await alice.page.waitForTimeout(300);
    for (let i = 0; i < 6; i++) await alice.page.mouse.wheel(0, 120);
    await alice.page.waitForTimeout(100);
    await expectBobOnAlicesView(await appStateOf(alice.page));
  });

  async function expectBobOnAlicesView(aState: Awaited<ReturnType<typeof appStateOf>>) {
    const aCenter = viewportCenter(aState);
    await expect
      .poll(
        async () => {
          const b = await appStateOf(bob.page);
          const c = viewportCenter(b);
          return { distance: Math.round(Math.hypot(c.x - aCenter.x, c.y - aCenter.y)) < 10, zoom: Math.abs(b.zoom - aState.zoom) < 0.005 };
        },
        { timeout: LIVE_TIMEOUT, message: "Bob's view center (within 10 scene px) and zoom match Alice's" },
      )
      .toEqual({ distance: true, zoom: true });
  }
});
