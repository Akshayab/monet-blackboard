// Solo mode (the default): no sign-in, everything answers only on localhost, and sharing explains how to turn on
// team mode. Run against a server started without TEAM_MODE; the specs skip themselves in team mode.
import { test, expect } from './lib/fixtures';
import { createBoard } from './lib/api';
import { openBoard, snap } from './lib/board';
import { BASE_URL } from './lib/env';

test.beforeEach(async ({ request }) => {
  const { mode } = await (await request.get('/api/auth/user')).json();
  test.skip(mode !== 'solo', 'Runs against a server in solo mode (no TEAM_MODE).');
});

test('opening the app goes straight to the library as the owner, with no sign-in', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByTestId('button-new-whiteboard')).toBeVisible();
    const me = await (await page.request.get('/api/auth/user')).json();
    expect(me).toMatchObject({ mode: 'solo', user: { id: 'owner', kind: 'owner' } });
    await page.getByTestId('button-user-menu').click();
    await expect(page.getByTestId('text-server-mode')).toHaveText('Solo mode');
    await expect(page.getByTestId('button-logout')).toHaveCount(0);
    await snap(page, testInfo, 'solo-library');
  } finally {
    await context.close();
  }
});

test('requests for any other host name are refused, for pages, the API and the board socket (DNS rebinding)', async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { host: 'attacker.example' } });
  try {
    expect((await ctx.get('/api/boards')).status()).toBe(403);
    expect((await ctx.post('/api/boards', { data: { title: 'x' } })).status()).toBe(403);
    expect((await ctx.get('/')).status()).toBe(403);
  } finally {
    await ctx.dispose();
  }
  const url = `${BASE_URL.replace(/^http/, 'ws')}/api/ws`;
  const Ctor = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
  const ws = new Ctor(url, { headers: { host: 'attacker.example', origin: 'http://attacker.example' } });
  const outcome = await new Promise<string>((resolve) => {
    ws.addEventListener('open', () => resolve('open'));
    ws.addEventListener('error', () => resolve('refused'));
    ws.addEventListener('close', () => resolve('refused'));
  });
  expect(outcome).toBe('refused');
});

test('other websites cannot change boards (cross-site requests are refused)', async ({ request }) => {
  const res = await request.post('/api/boards', { headers: { origin: 'https://evil.example' }, data: { title: 'forged' } });
  expect(res.status()).toBe(403);
  const form = await request.post('/api/boards', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: 'title=forged' });
  expect(form.status()).toBe(415);
});

test('the Share dialog explains how to turn on team mode, and links cannot be turned on', async ({ page, user }, testInfo) => {
  void user;
  const board = await createBoard(page.request, 'Solo share');
  await openBoard(page, `/b/${board.id}`);
  await page.getByTestId('button-share').click();
  await expect(page.getByTestId('text-share-solo')).toContainText('TEAM_MODE=1');
  await expect(page.getByTestId('select-link-access')).toHaveCount(0);
  await snap(page, testInfo, 'solo-share-dialog');
  const res = await page.request.patch(`/api/boards/${board.id}/link`, { data: { access: 'edit' } });
  expect(res.status()).toBe(400);
  expect((await res.json()).code).toBe('solo_mode');
  expect((await page.request.post('/api/auth/guest', { data: { name: 'x', linkToken: 'y' } })).status()).toBe(400);
});

test('fonts and the web app load from this server only (no CDN)', async ({ page, user }) => {
  void user;
  const outside: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) outside.push(r.url());
  });
  const board = await createBoard(page.request, 'Fonts');
  await openBoard(page, `/b/${board.id}`);
  await page.waitForLoadState('networkidle');
  expect(outside, outside.join('\n')).toEqual([]);
  expect((await page.request.get('/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2')).status()).toBe(200);
});
