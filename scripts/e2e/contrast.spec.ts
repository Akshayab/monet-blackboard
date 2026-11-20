// Color contrast (WCAG 2.2 AA): axe-core's color-contrast rule on the key pages and an open board, in dark and
// light mode, at desktop and phone widths. Fails on any serious or critical issue.
import AxeBuilder from '@axe-core/playwright';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './lib/fixtures';
import { claimOwner } from './lib/api';
import { installSceneHook, openBoard, snap } from './lib/board';
import { execFileSync } from 'node:child_process';
import { BASE_URL, IS_LOCAL_DEV } from './lib/env';

function psqlAvailable(): boolean {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

type Theme = 'dark' | 'light';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function themedContext(browser: Browser, theme: Theme, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: BASE_URL, viewport });
  await ctx.addInitScript((t) => localStorage.setItem('monet.theme', t), theme);
  await installSceneHook(ctx);
  return ctx;
}

/** Runs color-contrast and returns one readable line per failing node (serious or critical only). */
async function contrastIssues(page: Page, where: string): Promise<string[]> {
  await page.waitForTimeout(500);
  const r = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes.map((n) => {
        const d = (n.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string };
        return `${where}: ${n.target.join(' ')} ${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1 (needs ${d.expectedContrastRatio})`;
      }),
    );
}

async function boardWithContent(page: Page): Promise<string> {
  const res = await page.request.post('/api/boards', { data: { template: 'retrospective' } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()).board as { id: string }).id;
}

for (const theme of ['dark', 'light'] as Theme[]) {
  test.describe(`contrast in ${theme} mode`, () => {
    test(`pages before joining (no link, guest name prompt, not found) at desktop and phone width (${theme})`, async ({ browser, request }) => {
      const { mode } = await (await request.get('/api/auth/user')).json();
      // A board link for the name prompt, made by the owner in a separate context.
      const ownerCtx = await themedContext(browser, theme, DESKTOP);
      await claimOwner(ownerCtx.request);
      let shareToken: string | null = null;
      if (mode === 'team') {
        const created = await ownerCtx.request.post('/api/boards', { data: { title: 'Contrast share' } });
        const { board } = await created.json();
        await ownerCtx.request.patch(`/api/boards/${board.id}`, { data: { linkAccess: 'edit' } });
        shareToken = (await (await ownerCtx.request.get(`/api/boards/${board.id}`)).json()).board.linkToken;
      }
      await ownerCtx.close();
      const issues: string[] = [];
      for (const [name, viewport] of [
        ['desktop', DESKTOP],
        ['phone', PHONE],
      ] as const) {
        const ctx = await themedContext(browser, theme, viewport);
        const page = await ctx.newPage();
        const paths = ['/', '/no-such-page', ...(shareToken ? [`/s/${shareToken}`, '/claim#wrong-token'] : [])];
        for (const path of paths) {
          await page.goto(path);
          await page.waitForLoadState('networkidle');
          issues.push(...(await contrastIssues(page, `${name} ${path.replace(/[a-f0-9]{16,}/, '<token>')}`)));
        }
        await ctx.close();
      }
      expect(issues, issues.join('\n')).toEqual([]);
    });

    test(`library and an open board with its panels (${theme})`, async ({ browser }, testInfo) => {
      const issues: string[] = [];
      const ctx = await themedContext(browser, theme, DESKTOP);
      await claimOwner(ctx.request);
      const page = await ctx.newPage();
      const boardId = await boardWithContent(page);

      await page.goto('/');
      await page.waitForLoadState('networkidle');
      issues.push(...(await contrastIssues(page, 'library')));

      await openBoard(page, `/b/${boardId}`);
      issues.push(...(await contrastIssues(page, 'board')));
      await page.getByTestId('button-share').click();
      await expect(page.getByTestId('dialog-share')).toBeVisible();
      issues.push(...(await contrastIssues(page, 'share dialog')));
      await page.keyboard.press('Escape');
      await page.getByTestId('button-outputs-menu').click();
      issues.push(...(await contrastIssues(page, 'export menu')));
      await page.keyboard.press('Escape');
      await page.getByTestId('button-ai-open').click();
      await expect(page.getByTestId('button-ai-close')).toBeVisible();
      issues.push(...(await contrastIssues(page, 'AI panel')));
      await snap(page, testInfo, `contrast-board-${theme}`);

      // Section titles are drawn by Excalidraw as DOM labels over the canvas (axe can't see behind them).
      const frameName = page.locator('[id*="-frame-name-"]').first();
      await expect(frameName).toBeVisible();
      const expected = theme === 'dark' ? 'rgb(163, 163, 163)' : 'rgb(107, 107, 107)';
      expect(await frameName.evaluate((el) => getComputedStyle(el).color)).toBe(expected);

      // Phone width: the board chrome rearranges, so check it again.
      await page.setViewportSize(PHONE);
      await page.getByTestId('button-ai-close').click();
      await page.waitForTimeout(600);
      issues.push(...(await contrastIssues(page, 'board (phone)')));
      await ctx.close();
      expect(issues, issues.join('\n')).toEqual([]);
    });
  });
}

// The doc and deck pages once had a white header in dark mode, so the board title and buttons were light gray on
// white. Seeds one ready doc and deck straight into the database, so no model call is needed.
test('doc and deck pages are readable in dark mode', async ({ browser }) => {
  test.skip(!IS_LOCAL_DEV || !process.env.DATABASE_URL, "Seeds the server's database; set DATABASE_URL to it and run against localhost.");
  test.skip(!psqlAvailable(), 'Needs psql to seed a doc and a deck.');
  const ctx = await themedContext(browser, 'dark', DESKTOP);
  const user = await claimOwner(ctx.request);
  const page = await ctx.newPage();
  const boardId = await boardWithContent(page);
  const doc = JSON.stringify({ status: 'ready', markdown: '# Launch plan\n\nBeta in January, launch on Feb 1.\n\n- Pricing page\n- Press kit' });
  const deck = JSON.stringify({
    status: 'ready',
    slides: [
      { title: 'Launch plan', bullets: ['Beta in January'], notes: 'Intro' },
      { title: 'Risks', bullets: ['Vendor delays'] },
    ],
  });
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const out = execFileSync('psql', [
    process.env.DATABASE_URL!,
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `INSERT INTO board_documents (board_id, kind, title, content, created_by) VALUES (${q(boardId)}, 'doc', 'Launch plan', ${q(doc)}::jsonb, ${q(user.id)}), (${q(boardId)}, 'deck', 'Launch plan', ${q(deck)}::jsonb, ${q(user.id)}) RETURNING kind || ' ' || id`,
  ]).toString();
  const ids = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => l.split(' ')),
  );
  const issues: string[] = [];
  // axe skips text on the header's translucent, blurred background, so measure it directly: blend the header's
  // background over the page's, then compare with the header text.
  const headerRatio = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => {
      const rgba = (c: string) => {
        const v = c.match(/[\d.]+/g)!.map(Number);
        return { r: v[0]!, g: v[1]!, b: v[2]!, a: v.length > 3 ? v[3]! : 1 };
      };
      const over = (top: ReturnType<typeof rgba>, base: ReturnType<typeof rgba>) => ({
        r: top.r * top.a + base.r * (1 - top.a),
        g: top.g * top.a + base.g * (1 - top.a),
        b: top.b * top.a + base.b * (1 - top.a),
        a: 1,
      });
      const lum = (c: ReturnType<typeof rgba>) =>
        [c.r, c.g, c.b]
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      let bg = rgba(getComputedStyle(document.body).backgroundColor);
      const layers: HTMLElement[] = [];
      for (let n: HTMLElement | null = el.parentElement; n && n !== document.body; n = n.parentElement) layers.unshift(n);
      for (const n of layers) bg = over(rgba(getComputedStyle(n).backgroundColor), bg);
      const fg = over(rgba(getComputedStyle(el).color), bg);
      const [a, b] = [lum(fg), lum(bg)];
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    });
  await page.goto(`/b/${boardId}/docs/${ids.doc}`);
  await expect(page.getByTestId('doc-content')).toBeVisible();
  issues.push(...(await contrastIssues(page, 'doc page')));
  const docHeader = await headerRatio('link-back-to-board');
  if (docHeader < 4.5) issues.push(`doc page header: board title at ${docHeader}:1 (needs 4.5)`);
  await page.goto(`/b/${boardId}/decks/${ids.deck}`);
  await expect(page.getByTestId('text-slide-counter')).toBeVisible();
  await page.getByTestId('button-toggle-notes').click();
  await expect(page.getByTestId('text-speaker-notes')).toBeVisible();
  issues.push(...(await contrastIssues(page, 'deck page')));
  for (const id of ['link-back-to-board', 'button-toggle-notes', 'button-present']) {
    const r = await headerRatio(id);
    if (r < 4.5) issues.push(`deck page header: ${id} at ${r}:1 (needs 4.5)`);
  }
  await ctx.close();
  expect(issues, issues.join('\n')).toEqual([]);
});
