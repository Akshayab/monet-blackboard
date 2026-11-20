// Board AI. Runs the live AI checks only when GET /api/ai/usage reports the
// AI as configured; otherwise those tests skip with a clear reason. Access and limit checks that
// don't need a model always run.
import { execFileSync } from 'node:child_process';
import { test, expect, newPerson, newGuest, joinGuest, type Person } from './lib/fixtures';
import { createBoard, getBoard, rectJson, setLinkAccess } from './lib/api';
import { drag, openBoard, sceneOf, scrollToElements, snap, toScreen, waitForElement, type El, type OpenedBoard } from './lib/board';
import { IS_LOCAL_DEV } from './lib/env';

interface Usage {
  usage: { requestsUsed: number; requestLimit: number; tokensUsed: number; tokenLimit: number; resetsAt: string | null; running?: number };
  configured: boolean;
}

const NOT_CONFIGURED = 'The board AI is not configured on this server (no model key), so live AI checks are skipped.';

async function usageOf(p: Person): Promise<Usage> {
  const res = await p.request.get('/api/ai/usage');
  expect(res.status()).toBe(200);
  return (await res.json()) as Usage;
}

function psqlAvailable(): boolean {
  if (!process.env.DATABASE_URL) return false;
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test.describe('board AI: access and limits', () => {
  test('usage endpoint reports daily limits', async ({ browser, playwright }) => {
    const p = await newPerson(browser, 'Usage Checker', 'ai-usage');
    const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      const u = await usageOf(p);
      expect(typeof u.configured).toBe('boolean');
      expect(u.usage.requestsUsed).toBeGreaterThanOrEqual(0);
      expect(u.usage.requestLimit).toBeGreaterThan(0);
      expect(u.usage.tokenLimit).toBeGreaterThan(0);
      test.info().annotations.push({
        type: 'note',
        description: `configured=${u.configured}, limits: ${u.usage.requestLimit} requests and ${u.usage.tokenLimit} tokens per user per 24 h`,
      });
      // In team mode, callers without a session get nothing.
      const { mode } = await (await anon.get('/api/auth/user')).json();
      if (mode === 'team') expect((await anon.get('/api/ai/usage')).status()).toBe(401);
    } finally {
      await anon.dispose();
      await p.context.close();
    }
  });

  test('only editors can ask the AI to change a board', async ({ browser, playwright }) => {
    const owner = await newPerson(browser, 'Owner', 'ai-owner');
    const viewer = await newGuest(browser, 'Viewer');
    const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      test.skip((await (await anon.get('/api/auth/user')).json()).mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
      const board = await createBoard(owner.request, 'AI access');
      const token = await setLinkAccess(owner.request, board.id, 'view');
      await joinGuest(viewer, token);
      const viewerRes = await viewer.request.post(`/api/boards/${board.id}/ai`, { headers: { 'x-board-link': token }, data: { prompt: 'add a sticky' } });
      expect(viewerRes.status()).toBe(403);
      const anonRes = await anon.post(`/api/boards/${board.id}/ai`, { data: { prompt: 'add a sticky' } });
      expect(anonRes.status()).toBe(401);
      const empty = await owner.request.post(`/api/boards/${board.id}/ai`, { data: { prompt: '   ' } });
      expect(empty.status()).toBe(400);
    } finally {
      await anon.dispose();
      await owner.context.close();
      await viewer.context.close();
    }
  });

  test('a prompt with a NUL character (pasted from a PDF) is accepted, not a server error', async ({ browser }) => {
    const p = await newPerson(browser, 'Nul Tester', 'ai-nul');
    try {
      const u = await usageOf(p);
      test.skip(!u.configured, NOT_CONFIGURED);
      const board = await createBoard(p.request, 'AI nul');
      const res = await p.request.post(`/api/boards/${board.id}/ai`, { data: { prompt: 'Say hello\u0000world in the chat. Do not change the board.' } });
      expect(res.status(), await res.text()).toBe(202);
      await p.request.post(`/api/boards/${board.id}/ai/stop`, { data: {} });
      const { messages } = await (await p.request.get(`/api/boards/${board.id}/ai/messages`)).json();
      expect(messages[0].content).toBe('Say helloworld in the chat. Do not change the board.');
    } finally {
      await p.context.close();
    }
  });

  test("a guest's daily request limit returns 429 once reached", async ({ browser }) => {
    const owner = await newPerson(browser, 'Limit Owner', 'ai-limit');
    const p = await newGuest(browser, 'Limit Tester');
    try {
      const { mode } = await (await owner.request.get('/api/auth/user')).json();
      test.skip(mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
      // The cap is checked before the model is called, so this runs whether or not the AI is configured.
      test.skip(!IS_LOCAL_DEV, "Seeds the server's database; set DATABASE_URL to it and run against localhost.");
      test.skip(!psqlAvailable(), 'Needs DATABASE_URL and psql to seed usage rows for the test guest.');
      const board = await createBoard(owner.request, 'AI limit');
      const token = await setLinkAccess(owner.request, board.id, 'edit');
      await joinGuest(p, token);
      const headers = { 'x-board-link': token };
      const u = await usageOf(p);
      // Fill this fresh guest's 24 h window up to the limit, then ask once more.
      execFileSync('psql', [
        process.env.DATABASE_URL!,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `INSERT INTO ai_usage (user_id, kind, input_tokens, output_tokens, ok) SELECT '${p.user.id.replace(/'/g, "''")}', 'e2e-seed', 0, 0, true FROM generate_series(1, ${u.usage.requestLimit})`,
      ]);
      const after = await usageOf(p);
      expect(after.usage.requestsUsed).toBeGreaterThanOrEqual(after.usage.requestLimit);
      // At the cap the request is refused with 429 daily_limit and nothing reaches the board or its chat.
      const res = await p.request.post(`/api/boards/${board.id}/ai`, { headers, data: { prompt: 'Add one sticky note that says hi' } });
      const body = await res.json();
      expect(res.status(), JSON.stringify(body)).toBe(429);
      expect(body.code).toBe('daily_limit');
      expect(body.usage.requestsUsed).toBeGreaterThanOrEqual(body.usage.requestLimit);
      const chat = await owner.request.get(`/api/boards/${board.id}/ai/messages`);
      if (chat.ok()) expect(((await chat.json()).messages ?? []).length, 'no chat message after a refused request').toBe(0);
      // The owner's own allowance is separate and much larger.
      expect((await usageOf(owner)).usage.requestLimit).toBeGreaterThan(body.usage.requestLimit);
      test.info().annotations.push({
        type: 'note',
        description: `guest cap ${body.usage.requestLimit} requests/24 h; request ${body.usage.requestsUsed + 1} refused with 429 daily_limit`,
      });
    } finally {
      await owner.context.close();
      await p.context.close();
    }
  });

  test('concurrent runs above the limit return 429', async ({ browser }) => {
    const p = await newPerson(browser, 'Concurrency Tester', 'ai-conc');
    try {
      const u = await usageOf(p);
      test.skip(!u.configured, NOT_CONFIGURED);
      const board = await createBoard(p.request, 'AI concurrency');
      const prompts = ['Add a sticky: one', 'Add a sticky: two', 'Add a sticky: three', 'Add a sticky: four'];
      const statuses = await Promise.all(prompts.map(async (prompt) => (await p.request.post(`/api/boards/${board.id}/ai`, { data: { prompt } })).status()));
      test.info().annotations.push({ type: 'note', description: `statuses for 4 simultaneous requests: ${statuses.join(', ')}` });
      expect(statuses.filter((s) => s === 202).length).toBeGreaterThan(0);
      expect(statuses).toContain(429);
      // Every test acts as the same owner, so free the owner's run slots for the tests that follow.
      await p.request.post(`/api/boards/${board.id}/ai/stop`, { data: {} });
      await expect.poll(async () => (await usageOf(p)).usage.running, { timeout: 10_000 }).toBe(0);
    } finally {
      await p.context.close();
    }
  });
});

test.describe('board AI: live on a shared board', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ request }) => {
    test.skip((await (await request.get('/api/auth/user')).json()).mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
  });
  let alice: Person;
  let bob: Person;
  let boardId = '';
  let aliceBoard: OpenedBoard;
  let configured = false;

  test.beforeAll(async ({ browser }) => {
    alice = await newPerson(browser, 'Alice', 'ai-alice');
    configured = (await usageOf(alice)).configured;
    if (!configured) return;
    bob = await newGuest(browser, 'Bob');
    const board = await createBoard(alice.request, 'AI board');
    boardId = board.id;
    const token = await setLinkAccess(alice.request, boardId, 'edit');
    aliceBoard = await openBoard(alice.page, `/b/${boardId}`);
    await openBoard(bob.page, `/s/${token}`);
  });

  test.afterAll(async () => {
    await alice?.context.close();
    await bob?.context.close();
  });

  let aiEls: El[] = [];

  test('AI-created elements arrive live for both people', async ({}, testInfo) => {
    test.skip(!configured, NOT_CONFIGURED);
    test.setTimeout(240_000);
    const res = await alice.request.post(`/api/boards/${boardId}/ai`, {
      data: { prompt: 'Add three sticky notes in a row: Plan, Build, Ship. Connect them left to right with arrows.' },
    });
    expect(res.status(), await res.text()).toBe(202);
    const { runId } = await res.json();

    // Wait for the run to finish (status frames come over the socket).
    await expect
      .poll(
        () =>
          aliceBoard.frames
            .filter((f) => f.t === 'ai' && f.runId === runId)
            .map((f) => f.status)
            .pop(),
        {
          timeout: 180_000,
          intervals: [1000],
          message: 'AI run finished',
        },
      )
      .toMatch(/done|error/);
    const last = aliceBoard.frames.filter((f) => f.t === 'ai' && f.runId === runId).pop();
    expect(last.status, last.message).toBe('done');

    // The board started empty, so everything on it now came from the AI run (whether or not the
    // AI marks its elements with customData.createdBy = "ai").
    const isAi = (e: El) => !e.isDeleted;
    await expect.poll(async () => (await sceneOf(alice.page)).filter(isAi).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => (await sceneOf(bob.page)).filter(isAi).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    aiEls = (await sceneOf(alice.page)).filter(isAi);
    testInfo.annotations.push({
      type: 'note',
      description: `AI made ${aiEls.length} elements (${aiEls.filter((e) => e.customData?.createdBy === 'ai').length} marked createdBy=ai): ${[...new Set(aiEls.map((e) => e.type))].join(', ')}`,
    });
    const texts = aiEls.map((e) => e.text ?? '').join(' ');
    expect(texts).toMatch(/Plan/i);
    expect(texts).toMatch(/Ship/i);
    await scrollToElements(
      alice.page,
      aiEls.map((e) => e.id),
    );
    await scrollToElements(
      bob.page,
      aiEls.map((e) => e.id),
    );
    await snap(alice.page, testInfo, 'alice-ai-board');
    await snap(bob.page, testInfo, 'bob-ai-board');
  });

  test('people can move and edit what the AI made, and the other person sees it', async () => {
    test.skip(!configured, NOT_CONFIGURED);
    test.skip(!aiEls.length, 'Needs the AI elements from the previous test.');
    const shape = aiEls.find((e) => ['rectangle', 'ellipse', 'diamond'].includes(e.type)) ?? aiEls.find((e) => e.type === 'text')!;
    await alice.page.keyboard.press('Escape');
    const c = await toScreen(alice.page, shape.x + shape.width / 2, shape.y + shape.height / 2);
    await drag(alice.page, c, { x: c.x + 60, y: c.y + 140 }, 10);
    await expect.poll(async () => Math.round(((await sceneOf(alice.page)).find((e) => e.id === shape.id)?.y ?? 0) - shape.y)).toBeGreaterThan(80);
    await waitForElement(bob.page, (e) => e.id === shape.id && e.y - shape.y > 80, { message: 'moved AI element reaches Bob' });

    const text = aiEls.find((e) => e.type === 'text');
    if (text) {
      const cur = (await sceneOf(alice.page)).find((e) => e.id === text.id)!;
      const p = await toScreen(alice.page, cur.x + cur.width / 2, cur.y + cur.height / 2);
      await alice.page.keyboard.press('Escape');
      await alice.page.mouse.dblclick(p.x, p.y);
      await alice.page.locator('textarea.excalidraw-wysiwyg').waitFor();
      await alice.page.keyboard.press('Control+a');
      await alice.page.keyboard.type('Edited by a person');
      await alice.page.keyboard.press('Escape');
      await waitForElement(bob.page, (e) => e.id === text.id && e.text === 'Edited by a person', { message: 'edited AI text reaches Bob' });
    }
  });

  test('AI chat panel: ask from the board UI; the AI edits an existing item in place for everyone', async ({}, testInfo) => {
    test.skip(!configured, NOT_CONFIGURED);
    test.skip(!aiEls.length, 'Needs the AI elements from the first live test.');
    test.setTimeout(240_000);
    const scene = await sceneOf(alice.page);
    // Pick a label from the first run that the previous test didn't edit.
    const planLabel = scene.find((e) => e.type === 'text' && !e.isDeleted && /^\s*(ship|build)\s*$/i.test(e.text ?? ''));
    test.skip(!planLabel, 'The first run did not leave a "Build" or "Ship" label to edit.');
    const word = (planLabel!.text ?? '').trim();
    const target = `${word} v2`;
    const before = planLabel!.version;

    // Alice asks from the panel on the board page.
    if (
      await alice.page
        .getByTestId('button-ai-open')
        .isVisible()
        .catch(() => false)
    )
      await alice.page.getByTestId('button-ai-open').click();
    const input = alice.page.getByTestId('input-ai-prompt');
    await input.fill(`Change the sticky note that says ${word} so it says ${target}. Keep everything else as it is.`);
    await input.press('Enter');

    // Both people see the request and the AI's reply in their shared chat panel.
    await expect(alice.page.getByTestId('ai-messages')).toContainText(target, { timeout: 15_000 });
    await expect(bob.page.getByTestId('ai-messages')).toContainText(target, { timeout: 15_000 });

    // The same element (same id) is edited in place, and the change reaches Bob live.
    await expect
      .poll(async () => (await sceneOf(alice.page)).find((e) => e.id === planLabel!.id)?.text ?? '', {
        timeout: 180_000,
        intervals: [1000],
        message: 'AI edits the existing label',
      })
      .toContain(target);
    await waitForElement(bob.page, (e) => e.id === planLabel!.id && (e.text ?? '').includes(target), { timeout: 30_000, message: "AI's edit reaches Bob" });
    const after = (await sceneOf(alice.page)).find((e) => e.id === planLabel!.id)!;
    expect(after.version).toBeGreaterThan(before);
    const stillOne = (await sceneOf(alice.page)).filter(
      (e) => e.type === 'text' && !e.isDeleted && (e.text ?? '').toLowerCase().includes(word.toLowerCase()),
    ).length;
    testInfo.annotations.push({
      type: 'note',
      description: `AI edited element ${planLabel!.id} in place (version ${before} → ${after.version}); "${word}" labels on the board: ${stillOne}`,
    });
    await expect(alice.page.getByTestId('ai-messages').getByTestId('text-message-content').last()).not.toBeEmpty({ timeout: 60_000 });
    await snap(alice.page, testInfo, 'alice-panel-edit');
    await snap(bob.page, testInfo, 'bob-panel-edit');
  });
});

test.describe('board AI: undo', () => {
  test.beforeEach(async ({ request }) => {
    test.skip((await (await request.get('/api/auth/user')).json()).mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
  });
  test('Ctrl+Z takes back the whole AI run for everyone; redo brings it back; others have nothing to undo (real model)', async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const alice = await newPerson(browser, 'Alice', 'ai-undo');
    try {
      test.skip(!(await usageOf(alice)).configured, NOT_CONFIGURED);
      const bob = await newGuest(browser, 'Bob');
      const board = await createBoard(alice.request, 'AI undo', [rectJson('undo-box', 0, 0, { width: 200, height: 120 })]);
      const token = await setLinkAccess(alice.request, board.id, 'edit');
      const aliceBoard = await openBoard(alice.page, `/b/${board.id}`);
      await openBoard(bob.page, `/s/${token}`);
      const sig = (e?: { backgroundColor?: string; strokeColor?: string; x?: number; y?: number; width?: number }) =>
        e ? `${e.backgroundColor}|${e.strokeColor}|${Math.round(e.x ?? 0)}|${Math.round(e.y ?? 0)}|${Math.round(e.width ?? 0)}` : 'missing';
      const box = async (page: typeof alice.page) => sig((await sceneOf(page)).find((e) => e.id === 'undo-box'));
      const serverBox = async () => sig((await getBoard(alice.request, board.id)).elements.find((e) => e.id === 'undo-box') as never);
      const liveIds = async (page: typeof alice.page) => (await sceneOf(page)).map((e) => e.id).sort();
      const serverIds = async () => (await getBoard(alice.request, board.id)).elements.map((e) => e.id).sort();
      const before = await serverBox();
      const beforeIds = await serverIds();
      expect(await box(alice.page)).toBe(before);

      const res = await alice.request.post(`/api/boards/${board.id}/ai`, {
        data: {
          prompt: 'Make this box green, and add one new sticky note that says "Ship it" right next to it. Change nothing else.',
          focusElementIds: ['undo-box'],
        },
      });
      expect(res.status(), await res.text()).toBe(202);
      const { runId } = await res.json();
      await expect
        .poll(
          () =>
            aliceBoard.frames
              .filter((f) => f.t === 'ai' && f.runId === runId)
              .map((f) => f.status)
              .pop(),
          { timeout: 180_000, intervals: [1000] },
        )
        .toMatch(/done|error/);
      const after = await serverBox();
      const afterIds = await serverIds();
      expect(after, 'the AI changed the box').not.toBe(before);
      expect(afterIds.length, 'the AI added a sticky').toBeGreaterThan(beforeIds.length);
      await expect.poll(() => box(bob.page), { timeout: 10_000 }).toBe(after);

      // Bob didn't ask for it, so it isn't in his undo history.
      await expect(bob.page.locator('.excalidraw [data-testid="button-undo"]')).toBeDisabled();

      // The whole run is one undo step.
      expect(await alice.page.evaluate(() => (window as any).__monetE2E.app().history.undoStack.length)).toBe(1);
      // Ctrl+Z after clicking an empty spot of the canvas (how people give it focus).
      const canvas = await alice.page.locator('canvas.interactive').boundingBox();
      await alice.page.mouse.click(canvas!.x + canvas!.width * 0.9, canvas!.y + canvas!.height * 0.15);
      await alice.page.keyboard.press('Control+z');
      await expect.poll(() => box(alice.page), { message: 'undo on Alice' }).toBe(before);
      await expect.poll(() => liveIds(alice.page)).toEqual(beforeIds);
      await expect.poll(() => box(bob.page), { timeout: 10_000, message: 'undo reaches Bob' }).toBe(before);
      await expect.poll(() => liveIds(bob.page), { timeout: 10_000 }).toEqual(beforeIds);
      await expect.poll(serverBox, { timeout: 10_000, message: 'undo reaches the server' }).toBe(before);
      await expect.poll(serverIds, { timeout: 10_000 }).toEqual(beforeIds);
      await snap(alice.page, testInfo, 'after-undo');

      await alice.page.getByTestId('button-history-redo').click();
      await expect.poll(() => box(alice.page), { message: 'redo on Alice' }).toBe(after);
      await expect.poll(() => box(bob.page), { timeout: 10_000, message: 'redo reaches Bob' }).toBe(after);
      await expect.poll(serverIds, { timeout: 10_000, message: 'redo reaches the server' }).toEqual(afterIds);
      await bob.context.close();
    } finally {
      await alice.context.close();
    }
  });
});
