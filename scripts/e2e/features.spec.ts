// Smoke checks for features added by the library, inputs, and outputs work: one-step prompt start,
// Whiteboard tile and templates, sticky tool, Export PNG, Send to, phone layout.
import path from 'node:path';
import { test, expect } from './lib/fixtures';
import { createBoard, getBoard, rectJson } from './lib/api';
import { canvasPoint, focusCanvas, openBoard, sceneOf, snap } from './lib/board';
import { REPO_ROOT } from './lib/env';

/** Loads an app source module at run time (plain functions only; keeps app files out of this package's typecheck). */
const appModule = (rel: string): Promise<any> => import(path.join(REPO_ROOT, rel));

test.describe('library and new board flows', () => {
  test('Whiteboard tile opens a blank board', async ({ page, user }, testInfo) => {
    void user;
    await page.goto('/');
    await page.getByTestId('button-new-whiteboard').click();
    await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await expect(page.locator('canvas.interactive')).toBeVisible();
    await snap(page, testInfo, 'blank-whiteboard');
  });

  test('a template opens as an editable board with sections, notes, and arrows', async ({ page, user }, testInfo) => {
    void user;
    await page.goto('/');
    await page.getByTestId('button-template-retrospective').click();
    await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}/, { timeout: 15_000 });
    const boardId = page.url().match(/\/b\/([0-9a-f-]{36})/)![1]!;
    const { elements } = await getBoard(page.request, boardId);
    const types = new Set(elements.filter((e) => !e.isDeleted).map((e) => e.type));
    expect(types.has('frame'), `template element types: ${[...types].join(', ')}`).toBe(true);
    expect(elements.length).toBeGreaterThan(5);
    await expect.poll(async () => (await sceneOf(page)).length).toBeGreaterThan(5);
    await snap(page, testInfo, 'retro-template');
  });

  test('typing a prompt on the library page starts a board with that request', async ({ page, user }, testInfo) => {
    void user;
    await page.goto('/');
    const prompt = 'Plan our product launch: beta, pricing, press, launch event';
    await page.getByTestId('input-home-prompt').fill(prompt);
    await page.getByTestId('button-home-prompt').click();
    await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}/, { timeout: 15_000 });
    // The request is handed to the board's AI panel (sent when the AI is on; kept in the composer when it isn't).
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 15_000 });
    const usage = await (await page.request.get('/api/ai/usage')).json();
    if (usage.configured && !usage.mock) {
      // With the AI on, the request is sent automatically and the AI builds the board.
      const boardId = page.url().match(/\/b\/([0-9a-f-]{36})/)![1]!;
      await expect
        .poll(async () => (await getBoard(page.request, boardId)).elements.filter((e) => !e.isDeleted).length, {
          timeout: 180_000,
          message: 'AI builds the board from the prompt',
        })
        .toBeGreaterThan(5);
      test.info().annotations.push({ type: 'note', description: 'model: real (AI configured); board built from the library prompt' });
    }
    await snap(page, testInfo, 'prompt-start');
  });

  test('a long prompt never leaves the board title cut mid-word; the AI names the board from its heading', async ({ page, user }) => {
    void user;
    await page.goto('/');
    const prompt =
      'Plan our product launch for the Orbit smart notebook: private beta in January (Priya), pricing (Sam), press kit (Lee) and the launch event in March (Ana)';
    await page.getByTestId('input-home-prompt').fill(prompt);
    await page.getByTestId('button-home-prompt').click();
    await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}/, { timeout: 15_000 });
    const boardId = page.url().match(/\/b\/([0-9a-f-]{36})/)![1]!;
    const title = async () => String((await getBoard(page.request, boardId)).board.title);
    // Before the AI answers: the prompt cut at a word boundary with an ellipsis, never "…notebook: privat".
    const first = await title();
    expect(first.endsWith('…'), first).toBe(true);
    expect(prompt.startsWith(first.slice(0, -1)), first).toBe(true);
    expect(prompt[[...first].length - 1], `cut at a word boundary: "${first}"`).toMatch(/[\s,:;.]/);
    const usage = await (await page.request.get('/api/ai/usage')).json();
    if (!usage.configured || usage.mock) return;
    // With the AI on, its own title-size heading replaces the provisional title, for everyone on the board.
    await expect.poll(title, { timeout: 180_000, message: 'board renamed from the AI heading' }).not.toBe(first);
    const renamed = await title();
    const headings = (await getBoard(page.request, boardId)).elements
      .filter((e) => e.type === 'text' && !e.isDeleted && !e.containerId && !e.frameId && Number(e.fontSize) >= 24)
      .map((e) =>
        String(e.originalText ?? e.text)
          .replace(/\s+/g, ' ')
          .trim(),
      );
    expect(
      headings.some((h) => h.startsWith(renamed.replace(/…$/, ''))),
      `${renamed} | ${headings.join(' / ')}`,
    ).toBe(true);
    await expect(page.getByTestId('text-board-title').or(page.getByText(renamed).first())).toBeVisible();
    test.info().annotations.push({ type: 'note', description: `provisional "${first}" → AI heading "${renamed}"` });
  });
});

test.describe('board tools from the new work', () => {
  test('sticky tool places an editable sticky note', async ({ page, user }, testInfo) => {
    void user;
    const board = await createBoard(page.request, 'Sticky');
    await openBoard(page, `/b/${board.id}`);
    await focusCanvas(page);
    await page.getByTestId('tool-sticky').click();
    const at = await canvasPoint(page, 0.4, 0.4);
    await page.mouse.click(at.x, at.y);
    // The new sticky opens its label editor right away.
    await page.locator('textarea.excalidraw-wysiwyg').waitFor();
    await page.keyboard.type('Ship the beta');
    await page.keyboard.press('Escape');
    await expect
      .poll(
        async () => {
          const els = (await getBoard(page.request, board.id)).elements.filter((e) => !e.isDeleted);
          const sticky = els.find((e) => (e.customData as { kind?: string } | undefined)?.kind === 'sticky');
          const label = sticky && els.find((e) => e.type === 'text' && e.containerId === sticky.id);
          return label?.text ?? null;
        },
        { message: 'sticky with its label saved on the server', timeout: 15_000 },
      )
      .toBe('Ship the beta');
    await snap(page, testInfo, 'sticky');
  });

  test('Export downloads a PNG of the board', async ({ page, user }, testInfo) => {
    void user;
    const board = await createBoard(page.request, 'Export');
    await openBoard(page, `/b/${board.id}`);
    await focusCanvas(page);
    await page.keyboard.press('r');
    const a = await canvasPoint(page, 0.3, 0.3);
    const b = await canvasPoint(page, 0.45, 0.45);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await page.getByTestId('button-outputs-menu').click();
    await page.getByTestId('menu-export-image').click();
    await expect(page.getByTestId('dialog-export-image')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('button-export-download').click()]);
    expect(download.suggestedFilename()).toMatch(/\.png$/i);
    await snap(page, testInfo, 'export-dialog');
  });

  test('Send to offers Miro, Lucid, and a draw.io file', async ({ page, user }, testInfo) => {
    void user;
    const board = await createBoard(page.request, 'Send to', [rectJson('send-rect-1', 100, 100), rectJson('send-rect-2', 400, 100)]);
    await openBoard(page, `/b/${board.id}`);
    await page.getByTestId('button-outputs-menu').click();
    await page.getByTestId('menu-send-to').hover();
    await expect(page.getByTestId('menu-send-miro')).toBeVisible();
    await expect(page.getByTestId('menu-send-lucid')).toBeVisible();
    await page.getByTestId('menu-send-drawio').click();
    await expect(page.getByTestId('dialog-send-to')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('button-download-drawio').click()]);
    expect(download.suggestedFilename()).toMatch(/\.drawio$/i);
    await snap(page, testInfo, 'send-to');
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('library and a board work on a phone-sized screen', async ({ page, user }, testInfo) => {
    void user;
    await page.goto('/');
    await expect(page.getByTestId('input-home-prompt')).toBeVisible();
    const noSideScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(noSideScroll, 'library has no sideways scrolling on a phone').toBe(true);
    await snap(page, testInfo, 'phone-library');
    const board = await createBoard(page.request, 'Phone');
    await openBoard(page, `/b/${board.id}`);
    await expect(page.locator('canvas.interactive')).toBeVisible();
    const box = await page.locator('canvas.interactive').boundingBox();
    expect(box!.width).toBeGreaterThan(300);
    await snap(page, testInfo, 'phone-board');
  });

  test('the board menu and the library menu can be tapped on a phone, even with a long title', async ({ page, user }, testInfo) => {
    void user;
    const board = await createBoard(page.request, 'A rather long board title that does not fit on a phone screen at all');
    await openBoard(page, `/b/${board.id}`);
    // The menu button used to slide under the buttons on the right of the phone top bar, so taps never reached it.
    const menu = page.getByTestId('button-board-title-menu');
    const b = (await menu.boundingBox())!;
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), {
      x: b.x + b.width / 2,
      y: b.y + b.height / 2,
    });
    expect(hit, 'nothing covers the board menu button').toBe('button-board-title-menu');
    await menu.tap();
    await page.getByTestId('menu-rename-board').tap();
    await page.getByTestId('input-board-title').fill('Phone rename');
    await page.getByTestId('input-board-title').press('Enter');
    await expect.poll(async () => (await getBoard(page.request, board.id)).board.title).toBe('Phone rename');
    await snap(page, testInfo, 'phone-board-renamed');
    // Duplicate and delete live in the library card menu, which shows without hover on touch screens.
    await page.getByTestId('button-close-board').tap();
    await page.getByTestId(`button-board-menu-${board.id}`).tap();
    await expect(page.getByTestId(`button-board-duplicate-${board.id}`)).toBeVisible();
    await expect(page.getByTestId(`button-board-delete-${board.id}`)).toBeVisible();
  });
});

// Layout and readability regressions found by walking through the main flows.
test.describe('layout fixes', () => {
  test('right-angle connectors go around boxes instead of through them', async () => {
    const { routeElbow, obstacleRects } = await appModule('apps/server/src/ai/elbow.ts');
    const { Draft } = await appModule('apps/server/src/ai/draft.ts');
    // The support-escalation flowchart the real model drew in the sweep, where five elbow arrows crossed boxes.
    const boxes: [string, string, number, number, number, number][] = [
      ['arrives', 'ellipse', 50, 154, 220, 110],
      ['triage', 'rectangle', 340, 228, 200, 96],
      ['decide', 'diamond', 610, 228, 240, 140],
      ['eng', 'rectangle', 920, 228, 200, 96],
      ['kb', 'rectangle', 1190, 228, 200, 116],
      ['solved', 'diamond', 40, 364, 240, 144],
      ['escalate', 'rectangle', 350, 398, 200, 96],
      ['close', 'rectangle', 620, 398, 200, 76],
      ['survey', 'ellipse', 890, 398, 220, 110],
    ];
    const elbows: [string, string][] = [
      ['decide', 'kb'],
      ['eng', 'solved'],
      ['kb', 'solved'],
      ['solved', 'escalate'],
      ['solved', 'close'],
    ];
    const els: any[] = boxes.map(([id, type, x, y, width, height]) => ({ id, type, x, y, width, height, version: 1, versionNonce: 1, boundElements: [] }));
    for (const [a, b] of elbows) {
      const arrow = {
        id: `${a}>${b}`,
        type: 'arrow',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        points: [
          [0, 0],
          [1, 1],
        ],
        version: 1,
        versionNonce: 1,
        startBinding: { elementId: a },
        endBinding: { elementId: b },
        elbowed: true,
      };
      els.push(arrow);
      for (const id of [a, b]) els.find((e) => e.id === id).boundElements.push({ id: arrow.id, type: 'arrow' });
    }
    const crossings = (list: any[]) => {
      const out: string[] = [];
      for (const a of list.filter((e) => e.type === 'arrow')) {
        const pts = a.points.map((p: number[]) => ({ x: a.x + p[0], y: a.y + p[1] }));
        for (let i = 0; i + 1 < pts.length; i++) {
          const p = pts[i],
            q = pts[i + 1];
          expect(Math.abs(p.x - q.x) < 0.6 || Math.abs(p.y - q.y) < 0.6, `${a.id} segment ${i} is right-angled`).toBe(true);
          for (const o of list.filter((e) => e.type !== 'arrow' && e.id !== a.startBinding.elementId && e.id !== a.endBinding.elementId)) {
            const r = { x: o.x + 2, y: o.y + 2, w: o.width - 4, h: o.height - 4 };
            const hit =
              Math.abs(p.y - q.y) < 0.6
                ? p.y > r.y && p.y < r.y + r.h && Math.max(p.x, q.x) > r.x && Math.min(p.x, q.x) < r.x + r.w
                : p.x > r.x && p.x < r.x + r.w && Math.max(p.y, q.y) > r.y && Math.min(p.y, q.y) < r.y + r.h;
            if (hit) out.push(`${a.id} crosses ${o.id}`);
          }
        }
      }
      return out;
    };
    const byId = new Map(els.map((e) => [e.id, e]));
    for (const a of els.filter((e) => e.type === 'arrow')) {
      const s = byId.get(a.startBinding.elementId),
        t = byId.get(a.endBinding.elementId);
      routeElbow(a, undefined, s, t, obstacleRects(els, new Set([s.id, t.id])));
      expect(a.startBinding.fixedPoint).toBeTruthy();
    }
    expect(crossings(els)).toEqual([]);
    // Moving a box (what "clean up the layout" and regrouping do) keeps its connectors right-angled and clear.
    const draft = new Draft(new Map(els.map((e) => [e.id, structuredClone(e)])));
    draft.move(new Set(['kb']), -260, 300);
    expect(crossings(draft.current())).toEqual([]);

    // A straight arrow walled off by a column of cards (no single bend gets around) gets a clear right-angle path.
    const wall: any[] = [0, 1, 2, 3, 4].map((i) => ({ id: `w${i}`, type: 'rectangle', x: 300, y: -260 + i * 150, width: 160, height: 130 }));
    const a = { id: 'a', type: 'rectangle', x: 0, y: 40, width: 160, height: 100 };
    const b = { id: 'b', type: 'rectangle', x: 640, y: 60, width: 160, height: 100 };
    const arrow: any = {
      id: 'a>b',
      type: 'arrow',
      x: 168,
      y: 90,
      width: 464,
      height: 0,
      points: [
        [0, 0],
        [464, 0],
      ],
      startBinding: { elementId: 'a' },
      endBinding: { elementId: 'b' },
    };
    expect(crossings([...wall, a, b, arrow]).length).toBeGreaterThan(0);
    expect(routeElbow(arrow, undefined, a, b, obstacleRects(wall, new Set()), { onlyIfClear: true })).toBe(true);
    expect(arrow.elbowed).toBe(true);
    expect(crossings([...wall, a, b, arrow])).toEqual([]);
    // When nothing clear exists, onlyIfClear leaves the arrow alone.
    const boxed = {
      ...arrow,
      points: [
        [0, 0],
        [464, 20],
      ],
      elbowed: false,
    };
    const cage = [
      { id: 'c', type: 'rectangle', x: -400, y: -400, width: 1600, height: 380 },
      { id: 'd', type: 'rectangle', x: -400, y: 180, width: 1600, height: 380 },
      { id: 'e', type: 'rectangle', x: 380, y: -20, width: 40, height: 200 },
    ];
    expect(routeElbow(boxed, undefined, a, b, obstacleRects(cage, new Set()), { onlyIfClear: true })).toBe(false);
    expect(boxed.elbowed).toBe(false);
  });

  test('after the AI finishes your request, what it made is brought into view', async ({ page, user }, testInfo) => {
    const board = await createBoard(page.request, 'Framing', [
      rectJson('seed1', 0, 0, { backgroundColor: '#5b9cf0' }),
      rectJson('seed2', 220, 0, { backgroundColor: '#5b9cf0' }),
    ]);
    let toPage: ((m: string) => void) | null = null;
    let me = '';
    // Stand in for the server's AI messages so the check doesn't depend on what a model draws.
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        try {
          const j = JSON.parse(String(m));
          if (j.t === 'init') me = j.me.userId;
        } catch {
          /* not JSON */
        }
        ws.send(m);
      });
      toPage = (m) => ws.send(m);
    });
    await page.goto(`/b/${board.id}`);
    await page.locator('canvas.interactive').waitFor();
    await expect.poll(() => me).not.toBe('');
    await expect.poll(() => page.evaluate(() => !!window.__monetE2E?.app())).toBe(true);
    await page.waitForTimeout(1000);
    const view = () =>
      page.evaluate(() => {
        const s = window.__monetE2E!.app().state;
        return { x: Math.round(s.scrollX), y: Math.round(s.scrollY), z: s.zoom.value };
      });
    const aiRun = async (runId: string, userId: string, els: Record<string, unknown>[]) => {
      toPage!(JSON.stringify({ t: 'ai', runId, status: 'thinking', userId }));
      await page.waitForTimeout(150);
      toPage!(JSON.stringify({ t: 'elements', elements: els, from: `ai-${runId}`, source: 'ai', aiRun: { runId, userId } }));
      await page.waitForTimeout(150);
      toPage!(JSON.stringify({ t: 'ai', runId, status: 'done', userId }));
      await page.waitForTimeout(1200);
    };
    const far = (id: string, x: number, y: number) =>
      rectJson(id, x, y, { width: 220, height: 140, backgroundColor: '#f59e42', customData: { createdBy: 'ai' } });
    const inView = (ids: string[]) =>
      page.evaluate((ids) => {
        const app = window.__monetE2E!.app();
        const s = app.state;
        const bar = document.querySelector('[data-testid="ai-prompt-bar"]')!.getBoundingClientRect();
        return app
          .getSceneElements()
          .filter((e: any) => ids.includes(e.id))
          .every((e: any) => {
            const x = (e.x + s.scrollX) * s.zoom.value + s.offsetLeft;
            const y = (e.y + s.scrollY) * s.zoom.value + s.offsetTop;
            return x >= s.offsetLeft && y >= s.offsetTop && x + e.width * s.zoom.value <= s.offsetLeft + s.width && y + e.height * s.zoom.value <= bar.top;
          });
      }, ids);

    // Someone else's run off-screen: my view stays where it is.
    const v0 = await view();
    await aiRun('run-other', 'someone-else', [far('o1', -5000, -3000)]);
    expect(await view()).toEqual(v0);

    // My run lands off-screen: it's brought into view, clear of the prompt bar.
    await aiRun('run-mine', me, [far('n1', 3000, 2200), far('n2', 3260, 2200), far('n3', 3000, 2400)]);
    expect((await sceneOf(page)).filter((e) => ['n1', 'n2', 'n3'].includes(e.id))).toHaveLength(3);
    await expect.poll(() => inView(['n1', 'n2', 'n3']), { timeout: 3000 }).toBe(true);
    expect(await view()).not.toEqual(v0);
    await snap(page, testInfo, 'ai-result-framed');

    // My run that's already fully visible: the view doesn't jump.
    const v1 = await view();
    const s = await page.evaluate(() => window.__monetE2E!.app().state);
    await aiRun('run-near', me, [far('n4', -s.scrollX + 60, -s.scrollY + 60)]);
    expect(await view()).toEqual(v1);
  });

  test('changing link access in the Share dialog shows no extra toast, and one Escape closes it', async ({ page, user }) => {
    void user;
    test.skip((await (await page.request.get('/api/auth/user')).json()).mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
    const board = await createBoard(page.request, 'Share escape');
    await openBoard(page, `/b/${board.id}`);
    await page.getByTestId('button-share').click();
    await expect(page.getByTestId('dialog-share')).toBeVisible();
    await page.getByTestId('select-link-access').click();
    await page.getByRole('option', { name: 'Anyone with the link can edit' }).click();
    await expect(page.getByTestId('input-share-link')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('[data-radix-toast-viewport] li')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-share')).toBeHidden();
  });
});

test.describe('layout fixes on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('zoomed out, section names stay inside their own sections instead of piling up', async ({ page, user }, testInfo) => {
    void user;
    const res = await page.request.post('/api/boards', { data: { template: 'retrospective' } });
    const boardId = ((await res.json()).board as { id: string }).id;
    await openBoard(page, `/b/${boardId}`);
    await page.waitForTimeout(1200);
    const names = await page.evaluate(() => {
      const app = window.__monetE2E!.app();
      const z = app.state.zoom.value;
      const frames = new Map<string, number>(
        app
          .getSceneElements()
          .filter((e: any) => e.type === 'frame')
          .map((e: any) => [e.id, e.width * z] as [string, number]),
      );
      return Array.from(document.querySelectorAll<HTMLElement>('[id*="-frame-name-"]'))
        .filter((n) => getComputedStyle(n).visibility !== 'hidden')
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { text: n.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, max: frames.get(n.id.split('-frame-name-')[1]!) ?? 0 };
        });
    });
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.right - n.left, `"${n.text}" fits its section`).toBeLessThanOrEqual(n.max + 1);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i]!,
          b = names[j]!;
        const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        expect(overlap, `"${a.text}" and "${b.text}" overlap`).toBe(false);
      }
    // The phone tool pill fits without the "Ask AI" button (the prompt bar sits right above it).
    await expect(page.getByTestId('button-ask-ai')).toBeHidden();
    expect(await page.getByTestId('tool-pill').evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await snap(page, testInfo, 'phone-section-names');
  });
});
