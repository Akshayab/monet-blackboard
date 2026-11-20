// The dark board shell: tool pill stickers and comments, live for two people, plus the top bar's
// "Show chat" and the pill's "Ask AI".
import { test, expect, newPerson, newGuest, joinGuest, type Person } from './lib/fixtures';
import { createBoard, getBoard, rectJson, setLinkAccess, setMemberRole } from './lib/api';
import { addText, canvasPoint, centerOf, focusCanvas, openBoard, sceneOf, snap } from './lib/board';
import { LIVE_TIMEOUT } from './lib/env';
import { makeText } from '@monet/board-protocol';
import { buildStatCards } from '../../apps/server/src/ai/builders';

/** True when the server has a real model (not the AI_MOCK stand-in). */
async function realModel(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  const u = await (await request.get('/api/ai/usage')).json();
  return !!u.configured && !u.mock;
}

const kindOf = (e: { customData?: unknown }) => (e.customData as { kind?: string } | undefined)?.kind;

test.beforeEach(async ({ request }) => {
  const { mode } = await (await request.get('/api/auth/user')).json();
  const twoPeople = /two people|link cards|commenter/.test(test.info().titlePath.join(' '));
  test.skip(twoPeople && mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
});

test.describe('board shell: stickers and comments, live for two people', () => {
  test.describe.configure({ mode: 'serial' });
  let alice: Person;
  let bob: Person;
  let boardId = '';

  test.beforeAll(async ({ browser }) => {
    alice = await newPerson(browser, 'Alice', 'shell');
    bob = await newGuest(browser, 'Bob');
    const board = await createBoard(alice.request, 'Shell board');
    boardId = board.id;
    const token = await setLinkAccess(alice.request, board.id, 'edit');
    await openBoard(alice.page, `/b/${board.id}`);
    await openBoard(bob.page, `/s/${token}`);
  });
  test.afterAll(async () => {
    await alice?.context.close();
    await bob?.context.close();
  });

  test('the shell renders: dark canvas, top bar, zoom pill, tool pill, prompt bar', async ({}, testInfo) => {
    const page = alice.page;
    await expect(page.getByTestId('board-topbar')).toBeVisible();
    await expect(page.getByTestId('zoom-pill')).toBeVisible();
    await expect(page.getByTestId('tool-pill')).toBeVisible();
    await expect(page.getByTestId('input-ai-prompt')).toBeVisible();
    await expect(page.getByTestId('canvas-grid')).toBeAttached();
    const bg = await page.evaluate(() => window.__monetE2E?.app()?.state.viewBackgroundColor as string);
    expect(String(bg).toLowerCase()).toBe('#171717');
    // Excalidraw's own toolbar and footer are replaced.
    await expect(page.locator('.monet-canvas .shapes-section')).toBeHidden();
    await expect(page.locator('.monet-canvas .layer-ui__wrapper__footer')).toBeHidden();
    await snap(page, testInfo, 'shell');
  });

  test('a sticker from the tool pill appears for both people', async ({}, testInfo) => {
    const page = alice.page;
    await page.getByTestId('tool-sticker').click();
    await expect(page.getByTestId('picker-stickers')).toBeVisible();
    await page.getByTestId('sticker-2').click(); // 🎉
    const at = await canvasPoint(page, 0.3, 0.3);
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await sceneOf(page)).filter((e) => kindOf(e) === 'sticker').map((e) => e.text)).toEqual(['🎉']);
    await expect.poll(async () => (await sceneOf(bob.page)).filter((e) => kindOf(e) === 'sticker').length, { timeout: LIVE_TIMEOUT }).toBe(1);
    await expect.poll(async () => (await getBoard(alice.request, boardId)).elements.filter((e) => !e.isDeleted && kindOf(e) === 'sticker').length).toBe(1);
    await snap(bob.page, testInfo, 'bob-sees-sticker');
  });

  test('a comment pin is added, read by the other person, edited and deleted', async ({}, testInfo) => {
    const page = alice.page;
    await page.getByTestId('tool-comment').click();
    const at = await canvasPoint(page, 0.55, 0.35);
    await page.mouse.click(at.x, at.y);
    await expect(page.getByTestId('popover-comment')).toBeVisible();
    await page.getByTestId('input-comment').fill('Can we move the launch to Feb 3?');
    await page.getByTestId('button-comment-save').click();
    await expect(page.getByTestId('popover-comment')).toBeHidden();
    await expect.poll(async () => (await sceneOf(page)).filter((e) => kindOf(e) === 'comment').length).toBe(1);

    // Bob sees the pin live and reads it.
    await expect(bob.page.getByTestId('comment-pin')).toHaveCount(1, { timeout: LIVE_TIMEOUT });
    await bob.page.getByTestId('comment-pin').click();
    await expect(bob.page.getByTestId('text-comment-body')).toHaveText('Can we move the launch to Feb 3?');
    await expect(bob.page.getByTestId('text-comment-author')).toHaveText(alice.user.name);
    // Bob isn't the author or owner, so he can't edit or delete it.
    await expect(bob.page.getByTestId('button-comment-delete')).toHaveCount(0);
    await snap(bob.page, testInfo, 'bob-reads-comment');
    await bob.page.getByTestId('button-comment-close').click();

    // Alice edits it; Bob sees the new text.
    await page.getByTestId('comment-pin').click();
    await page.getByTestId('button-comment-edit').click();
    await page.getByTestId('input-comment').fill('Launch moves to Feb 3.');
    await page.getByTestId('button-comment-save').click();
    await expect
      .poll(async () =>
        (await getBoard(alice.request, boardId)).elements
          .filter((e) => !e.isDeleted && kindOf(e) === 'comment')
          .map((e) => (e.customData as { text: string }).text),
      )
      .toEqual(['Launch moves to Feb 3.']);
    await bob.page.getByTestId('comment-pin').click();
    await expect(bob.page.getByTestId('text-comment-body')).toHaveText('Launch moves to Feb 3.', { timeout: LIVE_TIMEOUT });
    await bob.page.getByTestId('button-comment-close').click();

    // Alice deletes it; it disappears for Bob.
    await page.getByTestId('comment-pin').click();
    await page.getByTestId('button-comment-delete').click();
    await expect(bob.page.getByTestId('comment-pin')).toHaveCount(0, { timeout: LIVE_TIMEOUT });
  });

  test('"Show chat" opens the left chat; "Ask AI" focuses the prompt bar', async () => {
    const page = alice.page;
    await page.getByTestId('button-ai-open').click();
    await expect(page.getByTestId('panel-ai-chat')).toBeVisible();
    const box = await page.getByTestId('panel-ai-chat').boundingBox();
    expect(box?.x).toBe(0);
    await page.getByTestId('button-ai-open').click();
    await expect(page.getByTestId('panel-ai-chat')).toBeHidden();
    await page.getByTestId('button-ask-ai').click();
    await expect(page.getByTestId('input-ai-prompt')).toBeFocused();
  });

  test('the board timer in the zoom pill counts down for both people; pause, add a minute, reset', async ({}, testInfo) => {
    const a = alice.page;
    const b = bob.page;
    const secs = async (page: typeof a) => {
      const t = (await page.getByTestId('text-board-timer').textContent()) ?? '';
      const [m, s2] = t.split(':').map(Number);
      return m! * 60 + s2!;
    };
    await a.getByTestId('button-board-timer').click();
    await a.getByTestId('menu-timer-1').click();
    for (const page of [a, b]) {
      await expect(page.getByTestId('text-board-timer')).toHaveAttribute('data-running', 'true', { timeout: LIVE_TIMEOUT });
    }
    // It really counts down, on the other person's screen too.
    const first = await secs(b);
    expect(first).toBeLessThanOrEqual(60);
    await expect.poll(() => secs(b), { timeout: 5_000 }).toBeLessThan(first);
    await snap(a, testInfo, 'timer-running');

    await a.getByTestId('button-board-timer').click();
    await a.getByTestId('menu-timer-pause').click();
    await expect(b.getByTestId('text-board-timer')).toHaveAttribute('data-running', 'false', { timeout: LIVE_TIMEOUT });
    const paused = await secs(b);
    await b.waitForTimeout(1500);
    expect(await secs(b)).toBe(paused);

    // Bob (an editor via the link) adds a minute and resumes it.
    await b.getByTestId('button-board-timer').click();
    await b.getByTestId('menu-timer-add').click();
    await expect.poll(() => secs(a), { timeout: LIVE_TIMEOUT }).toBeGreaterThan(paused + 50);
    await b.getByTestId('button-board-timer').click();
    await b.getByTestId('menu-timer-resume').click();
    await expect(a.getByTestId('text-board-timer')).toHaveAttribute('data-running', 'true', { timeout: LIVE_TIMEOUT });

    // Someone who joins later sees the running timer.
    await b.reload();
    await expect(b.getByTestId('text-board-timer')).toHaveAttribute('data-running', 'true', { timeout: 15_000 });

    await a.getByTestId('button-board-timer').click();
    await a.getByTestId('menu-timer-reset').click();
    for (const page of [a, b]) await expect(page.getByTestId('text-board-timer')).toHaveCount(0, { timeout: LIVE_TIMEOUT });
  });

  test('cursor chat: "/" shows a message beside your cursor for the other person; Escape clears it', async ({}, testInfo) => {
    const a = alice.page;
    const b = bob.page;
    const at = await canvasPoint(a, 0.4, 0.5);
    await a.mouse.move(at.x, at.y);
    await focusCanvas(a);
    await a.mouse.move(at.x + 5, at.y + 5);
    await a.keyboard.press('/');
    await expect(a.getByTestId('input-cursor-chat')).toBeFocused();
    await a.keyboard.type('Soooo cool!');
    const bubble = b.locator('[data-testid^="cursor-chat-"]');
    await expect(bubble).toHaveText('Soooo cool!', { timeout: LIVE_TIMEOUT });
    await snap(b, testInfo, 'bob-sees-cursor-chat');
    await a.keyboard.press('Escape');
    await expect(a.getByTestId('input-cursor-chat')).toHaveCount(0);
    await expect(bubble).toHaveCount(0, { timeout: LIVE_TIMEOUT });
  });

  test('naming the AI in a comment (@Monet, @AI) ticks "Send to Monet AI"; other @words do not', async () => {
    const page = alice.page;
    await page.getByTestId('tool-comment').click();
    const at = await canvasPoint(page, 0.6, 0.6);
    await page.mouse.click(at.x, at.y);
    const input = page.getByTestId('input-comment');
    const send = page.getByTestId('checkbox-comment-send-to-ai');
    await expect(input).toHaveAttribute('placeholder', 'Add a comment, or @AI to ask Monet AI');
    for (const [text, ticked] of [
      ['@Monet add a sticky', true],
      ['@monet ai, group these', true],
      ['ask @AI to tidy up', true],
      ['see @monetization notes', false],
      ['@Picasso add a sticky', false],
    ] as const) {
      await input.fill(text);
      if (ticked) await expect(send, text).toBeChecked();
      else await expect(send, text).not.toBeChecked();
    }
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(input).toBeHidden();
    await page.keyboard.press('Escape');
  });

  test('a comment that mentions @AI with "Send to Monet AI" goes to the AI, which works on the board (real model)', async ({}, testInfo) => {
    test.setTimeout(180_000);
    test.skip(!(await realModel(alice.request)), 'Needs a real model key (the server runs the AI_MOCK stand-in).');
    const page = alice.page;
    const before = (await getBoard(alice.request, boardId)).elements.filter((e) => !e.isDeleted).length;
    await page.getByTestId('tool-comment').click();
    const at = await canvasPoint(page, 0.3, 0.3);
    await page.mouse.click(at.x, at.y);
    await page.getByTestId('input-comment').fill('@AI add one yellow sticky note that says "Hello from a comment"');
    await expect(page.getByTestId('checkbox-comment-send-to-ai')).toBeChecked();
    await page.getByTestId('button-comment-save').click();
    await expect.poll(async () => (await sceneOf(page)).some((e) => kindOf(e) === 'comment' && (e.customData as { sentToAi?: boolean }).sentToAi)).toBe(true);
    // The request reaches the AI (its chat shows it, without the mention) and the AI changes the board for both people.
    await expect
      .poll(
        async () => {
          const msgs = (await (await alice.request.get(`/api/boards/${boardId}/ai/messages`)).json()).messages as {
            role: string;
            content?: string;
            text?: string;
          }[];
          return msgs.some((m) => m.role === 'user' && /Hello from a comment/.test(m.content ?? m.text ?? '') && !/@AI/.test(m.content ?? m.text ?? ''));
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await getBoard(alice.request, boardId)).elements.filter(
            (e) => !e.isDeleted && /Hello from a comment/.test(String((e as { text?: string }).text ?? '').replace(/\s+/g, ' ')),
          ).length,
        { timeout: 150_000 },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await sceneOf(bob.page)).some((e) => /Hello from a comment/.test((e.text ?? '').replace(/\s+/g, ' '))), { timeout: LIVE_TIMEOUT })
      .toBe(true);
    expect((await getBoard(alice.request, boardId)).elements.filter((e) => !e.isDeleted).length).toBeGreaterThan(before + 1);
    await snap(page, testInfo, 'comment-sent-to-ai');
  });
});

test.describe('older boards', () => {
  test('a board made with the old light palette is recolored once for the dark canvas', async ({ page, user }) => {
    void user;
    // Old defaults: black free text, a pastel sticky with black text, a black-outlined box, a light grey line.
    const els = [
      {
        ...rectJson('t1', 0, 0),
        type: 'text',
        width: 200,
        height: 25,
        text: 'Old heading',
        originalText: 'Old heading',
        fontSize: 20,
        fontFamily: 5,
        textAlign: 'left',
        verticalAlign: 'top',
        lineHeight: 1.25,
        autoResize: true,
        containerId: null,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
      },
      rectJson('s1', 0, 60, {
        width: 180,
        height: 180,
        backgroundColor: '#fff3bf',
        strokeColor: '#1e1e1e',
        boundElements: [{ id: 's1-t', type: 'text' }],
        customData: { kind: 'sticky' },
      }),
      {
        ...rectJson('s1-t', 10, 138),
        type: 'text',
        width: 160,
        height: 24,
        text: 'Pastel note',
        originalText: 'Pastel note',
        containerId: 's1',
        fontSize: 18,
        fontFamily: 5,
        textAlign: 'center',
        verticalAlign: 'middle',
        lineHeight: 1.25,
        autoResize: true,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
      },
      rectJson('r1', 260, 60, { width: 160, height: 100, backgroundColor: 'transparent', strokeColor: '#1e1e1e' }),
    ];
    const board = await createBoard(page.request, 'Old light board', els);
    await openBoard(page, `/b/${board.id}`);
    const byId = async () => new Map((await getBoard(page.request, board.id)).elements.map((e) => [e.id, e]));
    await expect.poll(async () => (await byId()).get('t1')?.strokeColor).toBe('#f5f5f5');
    const m = await byId();
    expect(m.get('s1')?.backgroundColor).toBe('#f5d90a');
    expect(m.get('s1-t')?.strokeColor).toBe('#1a1a1a');
    expect(m.get('r1')?.strokeColor).toBe('#e5e5e5');
    expect(m.get('t1')?.fontFamily).toBe(6);
    // The open page shows the recolored elements too.
    await expect.poll(async () => (await sceneOf(page)).find((e) => e.id === 't1')?.strokeColor).toBe('#f5f5f5');
    // The library preview is re-rendered from the recolored board (a dark SVG), not left in the old light look.
    const thumb = (await (await page.request.get('/api/boards')).json()).boards.find((b: { id: string }) => b.id === board.id)?.thumbnail as string;
    expect(thumb?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(thumb.split(',')[1]!, 'base64').toString('utf8');
    expect(svg).toContain('#171717');
    expect(svg).toContain('#f5d90a');
    // It runs once: a person's later choice of black text is left alone.
    const v = m.get('t1')?.version as number;
    await page.reload();
    await openBoard(page, `/b/${board.id}`);
    expect((await byId()).get('t1')?.version).toBe(v);
  });
});

test.describe('light and dark mode', () => {
  test('light mode swaps theme colors locally; the board stays stored in the dark palette', async ({ page, user }, testInfo) => {
    void user;
    const els = [
      {
        ...rectJson('h', 0, 0),
        type: 'text',
        width: 400,
        height: 45,
        text: 'Heading',
        originalText: 'Heading',
        fontSize: 36,
        fontFamily: 6,
        textAlign: 'left',
        verticalAlign: 'top',
        lineHeight: 1.25,
        autoResize: true,
        containerId: null,
        strokeColor: '#f5f5f5',
        backgroundColor: 'transparent',
      },
      rectJson('card', 0, 80, { width: 200, height: 90, backgroundColor: '#262626', strokeColor: '#262626' }),
      rectJson('pink', 260, 80, { width: 200, height: 90, backgroundColor: '#e8579f', strokeColor: '#e8579f' }),
    ];
    const board = await createBoard(page.request, 'Theme board', els);
    await openBoard(page, `/b/${board.id}`);
    const local = async (id: string) => (await sceneOf(page)).find((e) => e.id === id);
    expect((await local('h'))?.strokeColor).toBe('#f5f5f5');
    expect(await page.evaluate(() => window.__monetE2E?.app()?.state.viewBackgroundColor)).toBe('#171717');

    await page.getByTestId('button-theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/monet-light/);
    await expect.poll(async () => (await local('h'))?.strokeColor).toBe('#1e1e1e');
    expect((await local('card'))?.backgroundColor).toBe('#f1f3f5');
    expect((await local('pink'))?.backgroundColor).toBe('#e8579f');
    expect(await page.evaluate(() => window.__monetE2E?.app()?.state.viewBackgroundColor)).toBe('#ffffff');
    await snap(page, testInfo, 'light-board');

    // Something drawn in light mode is stored in the dark palette.
    await focusCanvas(page);
    const t = await addText(page, await canvasPoint(page, 0.5, 0.6), 'Typed in light mode');
    expect(t.strokeColor).toBe('#1e1e1e');
    await expect.poll(async () => (await getBoard(page.request, board.id)).elements.find((e) => e.id === t.id)?.strokeColor).toBe('#f5f5f5');
    const server = new Map((await getBoard(page.request, board.id)).elements.map((e) => [e.id, e]));
    expect(server.get('h')?.strokeColor).toBe('#f5f5f5');
    expect(server.get('card')?.backgroundColor).toBe('#262626');

    // The choice sticks across pages and reloads, and switching back restores the dark look.
    await page.reload();
    await openBoard(page, `/b/${board.id}`);
    await expect(page.locator('html')).toHaveClass(/monet-light/);
    await expect.poll(async () => (await local('h'))?.strokeColor).toBe('#1e1e1e');
    await page.getByTestId('button-theme-toggle').click();
    await expect.poll(async () => (await local('h'))?.strokeColor).toBe('#f5f5f5');
    await expect.poll(async () => (await local(t.id))?.strokeColor).toBe('#f5f5f5');
  });

  test('the library thumbnail is saved in the dark palette and recolored in light mode', async ({ page, user }) => {
    void user;
    const els = [rectJson('card', 0, 0, { width: 200, height: 90, backgroundColor: '#262626', strokeColor: '#262626' })];
    const board = await createBoard(page.request, 'Thumb board', els);
    await openBoard(page, `/b/${board.id}`);
    await focusCanvas(page);
    await addText(page, await canvasPoint(page, 0.5, 0.6), 'Fresh thumbnail');
    const thumb = async () =>
      (await (await page.request.get('/api/boards')).json()).boards.find((b: { id: string }) => b.id === board.id)?.thumbnail as string | null;
    await expect.poll(async () => (await thumb())?.slice(0, 26) ?? '', { timeout: 20_000 }).toBe('data:image/svg+xml;base64,');
    const svg = Buffer.from((await thumb())!.split(',')[1]!, 'base64').toString('utf8');
    expect(svg).toContain('#171717');
    expect(svg).toContain('#262626');

    await page.getByTestId('link-home').click();
    await page.getByTestId('button-theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/monet-light/);
    const src = await page.locator(`a[href="/b/${board.id}"] img`).first().getAttribute('src');
    expect(src?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const light = decodeURIComponent(src!.split(',').slice(1).join(','));
    expect(light).toContain('#f1f3f5');
    expect(light).not.toContain('#171717');
  });
});

test.describe('link cards', () => {
  test('link another board from the Export menu; the card syncs live and opens that board', async ({ browser }, testInfo) => {
    const alice = await newPerson(browser, 'Alice', 'links');
    const bob = await newGuest(browser, 'Bob');
    try {
      const other = await createBoard(alice.request, 'Hiring plan');
      const board = await createBoard(alice.request, 'Launch board', [rectJson('a', 0, 0)]);
      const token = await setLinkAccess(alice.request, board.id, 'edit');
      await openBoard(alice.page, `/b/${board.id}`);
      await openBoard(bob.page, `/s/${token}`);

      await alice.page.getByTestId('button-outputs-menu').click();
      await alice.page.getByTestId('menu-link-board').click();
      await expect(alice.page.getByTestId('dialog-link-board')).toBeVisible();
      await alice.page.getByTestId(`button-link-board-${other.id}`).click();

      const card = async (page: typeof alice.page) =>
        (await sceneOf(page)).find((e) => kindOf(e) === 'link-card' && !e.isDeleted) as
          { id: string; link?: string; customData?: { target: string; targetId: string; url: string; title: string } } | undefined;
      await expect.poll(async () => (await card(alice.page))?.link).toBe(`/b/${other.id}`);
      const c = (await card(alice.page))!;
      expect(c.customData).toMatchObject({ target: 'board', targetId: other.id, url: `/b/${other.id}`, title: 'Hiring plan' });
      const label = (await sceneOf(alice.page)).find((e) => e.type === 'text' && (e as { containerId?: string }).containerId === c.id) as
        { text?: string } | undefined;
      expect(label?.text).toContain('Hiring plan');
      // The other person sees it live, and it's saved.
      await expect.poll(async () => (await card(bob.page))?.link, { timeout: LIVE_TIMEOUT }).toBe(`/b/${other.id}`);
      await expect.poll(async () => (await getBoard(alice.request, board.id)).elements.some((e) => kindOf(e) === 'link-card')).toBe(true);
      await snap(alice.page, testInfo, 'link-card');

      // Opening the link goes to the other board (Excalidraw's link button calls onLinkOpen → new tab).
      const [popup] = await Promise.all([alice.context.waitForEvent('page'), alice.page.evaluate((link) => window.open(link, '_blank'), c.link!)]);
      await popup.waitForLoadState();
      await expect(popup).toHaveURL(new RegExp(`/b/${other.id}`));

      // Linking the same board again doesn't add a second card.
      await alice.page.getByTestId('button-outputs-menu').click();
      await alice.page.getByTestId('menu-link-board').click();
      await alice.page.getByTestId(`button-link-board-${other.id}`).click();
      await alice.page.waitForTimeout(500);
      expect((await sceneOf(alice.page)).filter((e) => kindOf(e) === 'link-card' && !e.isDeleted)).toHaveLength(1);
    } finally {
      await alice.context.close();
      await bob.context.close();
    }
  });

  test('a doc the AI writes from the board lands on it as a link card; Docs & decks can add it too (real model)', async ({ page, user }, testInfo) => {
    void user;
    test.setTimeout(200_000);
    const { ai } = await (await page.request.get('/api/outputs/config')).json();
    test.skip(!ai, 'Needs a model key, or OUTPUTS_AI_STUB=1 for deterministic docs.');
    const els = [
      rectJson('s1', 0, 0, { backgroundColor: '#5fd35f' }),
      {
        ...rectJson('t1', 0, 200),
        type: 'text',
        width: 300,
        height: 25,
        text: 'Goal: ship the beta in January',
        originalText: 'Goal: ship the beta in January',
        fontSize: 20,
        fontFamily: 6,
        textAlign: 'left',
        verticalAlign: 'top',
        lineHeight: 1.25,
        autoResize: true,
        containerId: null,
      },
    ];
    const board = await createBoard(page.request, 'Doc card board', els);
    await openBoard(page, `/b/${board.id}`);
    await page.getByTestId('button-outputs-menu').click();
    await page.getByTestId('menu-turn-into-doc').click();
    await page.getByTestId('button-generate-submit').click();
    await expect(page.getByTestId('button-open-generated')).toBeVisible({ timeout: 150_000 });

    const docCards = async () => (await sceneOf(page)).filter((e) => kindOf(e) === 'link-card' && (e.customData as { target?: string }).target === 'doc');
    await expect.poll(async () => (await docCards()).length, { timeout: 10_000 }).toBe(1);
    const c = (await docCards())[0]!;
    const data = c.customData as { targetId: string; url: string };
    expect(c.link).toBe(`/b/${board.id}/docs/${data.targetId}`);
    expect(data.url).toBe(c.link);
    await page.keyboard.press('Escape');
    await snap(page, testInfo, 'doc-link-card');

    // The link opens the doc viewer.
    const doc = await page.context().newPage();
    await doc.goto(c.link!);
    await expect(doc).toHaveURL(new RegExp(`/docs/${data.targetId}`));
    await doc.close();

    // Docs & decks offers "add to board"; for a doc that already has a card it doesn't add a second one.
    await page.getByTestId('button-outputs-menu').click();
    await page.getByTestId('menu-documents').click();
    await page.getByTestId(`button-link-document-${data.targetId}`).click();
    await page.waitForTimeout(500);
    expect(await docCards()).toHaveLength(1);
    await expect.poll(async () => (await getBoard(page.request, board.id)).elements.filter((e) => kindOf(e) === 'link-card').length).toBe(1);
  });
});

test.describe('commenter role', () => {
  test('a commenter can add and edit their own comments but not change the board', async ({ browser }, testInfo) => {
    const owner = await newPerson(browser, 'Olive', 'cmt');
    const cara = await newGuest(browser, 'Cara');
    try {
      const board = await createBoard(owner.request, 'Review board', [rectJson('r1', 0, 0, { backgroundColor: '#5b9cf0' })]);
      // Cara joins through the view link, then the owner makes her a commenter.
      const token = await setLinkAccess(owner.request, board.id, 'view');
      await joinGuest(cara, token);
      await setMemberRole(owner.request, board.id, cara.user.id, 'commenter');
      await openBoard(owner.page, `/b/${board.id}`);
      await openBoard(cara.page, `/b/${board.id}`);
      await expect(cara.page.getByTestId('badge-view-only')).toHaveText(/Can comment/);
      // Only the hand/select tools plus Comment; no drawing tools.
      await expect(cara.page.getByTestId('tool-text')).toHaveCount(0);
      await expect(cara.page.getByTestId('tool-comment')).toBeVisible();

      // She places a comment on the blue box; the owner sees it live, pinned to that box.
      await cara.page.getByTestId('tool-comment').click();
      const r1 = (await sceneOf(cara.page)).find((e) => e.id === 'r1')!;
      const c = await centerOf(cara.page, r1);
      await cara.page.mouse.click(c.x, c.y);
      await cara.page.getByTestId('input-comment').fill('Can this box say who owns it?');
      await cara.page.getByTestId('button-comment-save').click();
      await expect(owner.page.getByTestId('comment-pin')).toHaveCount(1, { timeout: LIVE_TIMEOUT });
      const saved = (await getBoard(owner.request, board.id)).elements.find((e) => kindOf(e) === 'comment' && !e.isDeleted);
      expect(saved?.customData).toMatchObject({ authorName: 'Cara', targetId: 'r1', text: 'Can this box say who owns it?' });
      await snap(cara.page, testInfo, 'commenter-comment');

      // She can edit her own comment.
      await cara.page.getByTestId('comment-pin').click();
      await cara.page.getByTestId('button-comment-edit').click();
      await cara.page.getByTestId('input-comment').fill('Who owns this box?');
      await cara.page.getByTestId('button-comment-save').click();
      await expect
        .poll(
          async () =>
            ((await getBoard(owner.request, board.id)).elements.find((e) => kindOf(e) === 'comment' && !e.isDeleted)?.customData as { text?: string })?.text,
        )
        .toBe('Who owns this box?');

      // Anything else she changes (forced through the scene) is refused by the server and never reaches the owner.
      await cara.page.evaluate(() => {
        const app = window.__monetE2E?.app();
        const els = app
          .getSceneElementsIncludingDeleted()
          .map((e: any) => (e.id === 'r1' ? { ...e, x: e.x + 300, version: e.version + 5, versionNonce: e.versionNonce + 1 } : e));
        app.updateScene({ elements: els });
      });
      await owner.page.waitForTimeout(1500);
      expect((await getBoard(owner.request, board.id)).elements.find((e) => e.id === 'r1')?.x).toBe(0);
      expect((await sceneOf(owner.page)).find((e) => e.id === 'r1')?.x).toBe(0);

      // The owner can change her role from the Share dialog's member list.
      await owner.page.getByTestId('button-share').click();
      await expect(owner.page.getByTestId(`row-member-${cara.user.id}`)).toContainText('Can comment');
    } finally {
      await owner.context.close();
      await cara.context.close();
    }
  });
});

test.describe('board chrome fixes', () => {
  test('the sticky color picker sits above the prompt bar instead of covering it', async ({ page, user }) => {
    void user;
    const board = await createBoard(page.request, 'Picker board');
    await openBoard(page, `/b/${board.id}`);
    await page.getByTestId('tool-sticky').click();
    const at = await canvasPoint(page, 0.5, 0.4);
    await page.mouse.click(at.x, at.y);
    await page.locator('textarea.excalidraw-wysiwyg').waitFor();
    await page.keyboard.type('Pick me');
    await page.keyboard.press('Escape');
    const palette = page.getByTestId('palette-sticky-colors');
    await expect(palette).toBeVisible();
    const pb = (await palette.boundingBox())!;
    const ib = (await page.getByTestId('input-ai-prompt').boundingBox())!;
    expect(pb.y + pb.height).toBeLessThanOrEqual(ib.y - 4);
    // The prompt bar takes a click while the sticky is selected.
    await page.getByTestId('input-ai-prompt').click();
    await expect(page.getByTestId('input-ai-prompt')).toBeFocused();
  });

  test("a selected live embed doesn't show its internal link for editing", async ({ page, user }) => {
    void user;
    const board = await createBoard(page.request, 'Embed link board');
    await openBoard(page, `/b/${board.id}`);
    await page.getByTestId('button-embed-open').click();
    await page.getByTestId('tab-embed-live').click();
    await page.getByTestId('button-live-kind-poll').click();
    await page.getByTestId('input-poll-question').fill('Lunch?');
    await page.getByTestId('input-poll-options').fill('Tacos\nPho');
    await page.getByTestId('button-embed-insert-live').click();
    await expect.poll(async () => (await sceneOf(page)).some((e) => e.type === 'embeddable')).toBe(true);
    const poll = (await sceneOf(page)).find((e) => e.type === 'embeddable')!;
    await page.evaluate((id) => window.__monetE2E?.app().updateScene({ appState: { selectedElementIds: { [id]: true } } }), poll.id);
    await expect(page.locator('.monet-canvas')).toHaveClass(/monet-live-embed-selected/);
    await expect(page.locator('.excalidraw-hyperlinkContainer')).toBeHidden();
    await expect(page.getByText('embed.monet.local')).toHaveCount(0);
  });
});

test.describe('text is never cut off', () => {
  const clipped = (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
      await document.fonts.ready;
      const app = window.__monetE2E?.app();
      const fam: Record<number, string> = { 5: 'Excalifont', 6: 'Nunito', 8: 'Comic Shanns' };
      const c = document.createElement('canvas').getContext('2d')!;
      return app
        .getSceneElements()
        .filter((e: any) => e.type === 'text' && !e.containerId && !e.isDeleted)
        .map((e: any) => {
          c.font = `${e.fontSize}px ${fam[e.fontFamily] ?? 'Nunito'}`;
          const need = Math.max(
            ...String(e.text)
              .split('\n')
              .map((l: string) => c.measureText(l).width),
          );
          return { text: String(e.text), width: e.width, need };
        })
        .filter((t: any) => t.need > t.width + 1);
    });

  test('a board saved with too-narrow text sizes opens with every title fully visible (owner screenshot)', async ({ page, user }) => {
    void user;
    // Widths as the old server estimate saved them (0.55 em per character): too narrow for Nunito capitals.
    const t = (id: string, y: number, text: string, fontSize: number) => ({
      ...rectJson(id, 0, y),
      type: 'text',
      text,
      originalText: text,
      fontSize,
      fontFamily: 6,
      textAlign: 'left',
      verticalAlign: 'top',
      lineHeight: 1.25,
      autoResize: true,
      containerId: null,
      strokeColor: '#f5f5f5',
      backgroundColor: 'transparent',
      width: Math.ceil(text.length * fontSize * 0.55 * 0.8),
      height: Math.ceil(fontSize * 1.25),
    });
    const board = await createBoard(page.request, 'Clipped titles', [
      t('t1', 0, 'NVDA Game Plan: Hedge Fund Playbook', 34),
      t('t2', 60, 'Framework around Q3 FY27 earnings (Nov 17, after close)', 18),
      t('t3', 120, '1. Thesis & Setup', 28),
      t('t4', 170, 'Why we care', 18),
    ]);
    await openBoard(page, `/b/${board.id}`);
    await expect.poll(() => clipped(page), { timeout: 10_000 }).toEqual([]);
  });

  test('a long trend line on a stat card wraps inside the card instead of running past it', async ({ page, user }) => {
    void user;
    const board = await createBoard(page.request, 'Stat trend');
    await openBoard(page, `/b/${board.id}`);
    let n = 0;
    const ctx = { nextRef: () => `k${++n}`, mark: (extra = {}) => ({ createdBy: 'ai', ...extra }) };
    const block = buildStatCards(ctx, [
      { value: '$162.85', label: 'Last close', delta: '-32% from Oct 6 high; 6 straight down weeks into the print', trend: 'down' },
      { value: '74.0%', label: 'Gross margin guide', delta: '+0.4pp vs last quarter', trend: 'up' },
      {
        value: '±8.3–9.1%',
        label: 'Implied move',
        delta: 'Options imply the largest post-earnings swing since the May print, with skew rich on the put side and front-week vol bid',
      },
    ] as never);
    const cards = block.elements.filter((e: any) => e.type === 'rectangle');
    const deltas = block.elements.filter((e: any) => e.type === 'text' && e.fontSize === 13);
    expect(deltas.length).toBe(3);
    const result = await page.evaluate(
      async ({ cards, deltas }: any) => {
        await document.fonts.load('13px "Nunito"', '▲▼—–±·');
        const c = document.createElement('canvas').getContext('2d')!;
        c.font = '13px "Nunito"';
        return deltas.map((t: any) => {
          const card = cards.find((r: any) => (t.groupIds ?? []).some((g: string) => (r.groupIds ?? []).includes(g)));
          const lines = String(t.text).split('\n');
          const right = t.x + Math.max(...lines.map((l: string) => c.measureText(l).width));
          return { lines, overflow: right - (card.x + card.width - 8), bottomGap: card.y + card.height - (t.y + t.height) };
        });
      },
      { cards, deltas },
    );
    for (const r of result) {
      expect(r.overflow, r.lines.join(' / ')).toBeLessThanOrEqual(0);
      expect(r.bottomGap, r.lines.join(' / ')).toBeGreaterThanOrEqual(8);
      expect(r.lines.length).toBeLessThanOrEqual(2);
    }
    // The first trend keeps whole words ("weeks", not "we"); the very long one ends with an ellipsis at a word.
    expect(result[0].lines.join(' ')).toContain('weeks');
    expect(result[2].lines.at(-1)).toMatch(/\S…$/);
  });

  test('the server measures text at least as wide as the browser draws it', async ({ page, user }) => {
    void user;
    const board = await createBoard(page.request, 'Text widths');
    await openBoard(page, `/b/${board.id}`);
    // makeText is what the AI, templates and the server use to size text before any browser sees it.
    const samples = [
      'NVDA Game Plan: Hedge Fund Playbook',
      'WWW MMM QQQ — WAVE',
      '1. Thesis & Setup',
      'Why we care',
      'Framework around Q3 FY27 earnings (Nov 17, after close) · close Nov 13',
      '+11.5%  35%  100%',
      'Tokyo → Kyoto Shinkansen',
      'Brand™ © 2027 ✓ Straße',
    ];
    const els = [];
    for (const fontFamily of [5, 6, 8])
      for (const fontSize of [14, 18, 28, 34, 44]) for (const text of samples) els.push(makeText({ x: 0, y: 0, text, fontSize, fontFamily }));
    const tooNarrow = await page.evaluate(async (els: any[]) => {
      const fam: Record<number, string> = { 5: 'Excalifont', 6: 'Nunito', 8: 'Comic Shanns' };
      // Excalidraw splits fonts by Unicode range; load the subsets each sample needs, or the canvas measures with a
      // fallback font.
      for (const e of els) await document.fonts.load(`${e.fontSize}px "${fam[e.fontFamily]}"`, e.text);
      const c = document.createElement('canvas').getContext('2d')!;
      return els
        .filter((e) => {
          c.font = `${e.fontSize}px "${fam[e.fontFamily]}"`;
          return c.measureText(e.text).width > e.width;
        })
        .map((e) => `${e.fontFamily}/${e.fontSize}: ${e.text}`);
    }, els);
    expect(tooNarrow).toEqual([]);
  });
});
