// Browser helpers for the board page: open a board and wait for the realtime handshake, read the
// Excalidraw scene, convert scene <-> screen coordinates, and draw with the real tools.
//
// The scene is read from the Excalidraw component instance found through React's fiber on the
// `.excalidraw` DOM node. The hook is installed only in test browsers (addInitScript), so nothing
// new is exposed in the production app.
import { expect, type BrowserContext, type Page, type TestInfo, type WebSocket as PwWebSocket } from '@playwright/test';
import { LIVE_TIMEOUT } from './env';

export interface El {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  version: number;
  isDeleted: boolean;
  text?: string;
  strokeColor: string;
  backgroundColor: string;
  frameId: string | null;
  groupIds: string[];
  containerId?: string | null;
  points?: [number, number][];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: { id: string; type: string }[] | null;
  customData?: Record<string, unknown>;
  name?: string | null;
  link?: string | null;
}

export interface AppStateLite {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  activeTool: string;
  selectedIds: string[];
  viewModeEnabled: boolean;
  editingText: boolean;
  collaborators: { socketId: string; username?: string; pointer?: { x: number; y: number } | null }[];
}

declare global {
  interface Window {
    __monetE2E?: {
      app: () => any;
    };
  }
}

/** Installs the scene-reading hook in every page of the context. Call once per context. */
export async function installSceneHook(context: BrowserContext) {
  await context.addInitScript(() => {
    window.__monetE2E = {
      app: () => {
        const host = document.querySelector('.excalidraw') as any;
        if (!host) return null;
        const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
        let fiber = key ? host[key] : null;
        while (fiber && !(fiber.stateNode && typeof fiber.stateNode.getSceneElementsIncludingDeleted === 'function')) {
          fiber = fiber.return;
        }
        return fiber?.stateNode ?? null;
      },
    };
  });
}

/** Every element in the local scene, including deleted ones. */
export async function sceneOf(page: Page, opts: { includeDeleted?: boolean } = {}): Promise<El[]> {
  const all = await page.evaluate(() => {
    const app = window.__monetE2E?.app();
    if (!app) return [];
    return app.getSceneElementsIncludingDeleted().map((e: any) => ({
      id: e.id,
      type: e.type,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      angle: e.angle,
      version: e.version,
      isDeleted: !!e.isDeleted,
      text: e.text,
      strokeColor: e.strokeColor,
      backgroundColor: e.backgroundColor,
      frameId: e.frameId ?? null,
      groupIds: e.groupIds ?? [],
      containerId: e.containerId ?? null,
      points: e.points,
      startBinding: e.startBinding ?? null,
      endBinding: e.endBinding ?? null,
      boundElements: e.boundElements ?? null,
      customData: e.customData,
      name: e.name ?? null,
      link: e.link ?? null,
    }));
  });
  return opts.includeDeleted ? all : all.filter((e: El) => !e.isDeleted);
}

export async function appStateOf(page: Page): Promise<AppStateLite> {
  return page.evaluate(() => {
    const app = window.__monetE2E?.app();
    const s = app.state;
    const collaborators: AppStateLite['collaborators'] = [];
    for (const [socketId, c] of (s.collaborators as Map<string, any>) ?? new Map()) {
      collaborators.push({ socketId, username: c.username, pointer: c.pointer ? { x: c.pointer.x, y: c.pointer.y } : null });
    }
    return {
      scrollX: s.scrollX,
      scrollY: s.scrollY,
      zoom: s.zoom.value,
      width: s.width,
      height: s.height,
      offsetLeft: s.offsetLeft,
      offsetTop: s.offsetTop,
      activeTool: s.activeTool.type,
      selectedIds: Object.keys(s.selectedElementIds).filter((k) => s.selectedElementIds[k]),
      viewModeEnabled: !!s.viewModeEnabled,
      editingText: !!s.editingTextElement,
      collaborators,
    };
  });
}

/** Scene point at the center of the visible canvas (what a person is looking at). */
export function viewportCenter(s: AppStateLite) {
  return { x: -s.scrollX + s.width / 2 / s.zoom, y: -s.scrollY + s.height / 2 / s.zoom };
}

/** Scene coordinates -> page (CSS pixel) coordinates. */
export async function toScreen(page: Page, x: number, y: number) {
  const s = await appStateOf(page);
  return { x: (x + s.scrollX) * s.zoom + s.offsetLeft, y: (y + s.scrollY) * s.zoom + s.offsetTop };
}

/** Page coordinates -> scene coordinates. */
export async function toScene(page: Page, x: number, y: number) {
  const s = await appStateOf(page);
  return { x: (x - s.offsetLeft) / s.zoom - s.scrollX, y: (y - s.offsetTop) / s.zoom - s.scrollY };
}

export interface RealtimeWatcher {
  /** Every realtime frame this page received, across reconnects (parsed JSON). */
  frames: any[];
  sockets: PwWebSocket[];
}

const watchers = new WeakMap<Page, RealtimeWatcher>();

/**
 * Records every /api/ws frame a page receives. Listeners are attached inside the `websocket` event,
 * so no frame is missed, and a reconnect (new socket) is followed too.
 */
export function watchRealtime(page: Page): RealtimeWatcher {
  let w = watchers.get(page);
  if (w) return w;
  const watcher: RealtimeWatcher = { frames: [], sockets: [] };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/api/ws')) return;
    watcher.sockets.push(ws);
    ws.on('framereceived', (f) => {
      try {
        watcher.frames.push(JSON.parse(String(f.payload)));
      } catch {
        /* ignore non-JSON frames */
      }
    });
  });
  watchers.set(page, watcher);
  w = watcher;
  return w;
}

/** Waits for a realtime `init` frame received after frame index `since`, then for the canvas. */
export async function waitForBoardReady(page: Page, since: number, timeout = 30_000): Promise<any> {
  const watcher = watchRealtime(page);
  let init: any;
  await expect
    .poll(() => (init = watcher.frames.slice(since).find((f) => f.t === 'init' || (f.t === 'error' && f.code !== 'read_only'))), {
      timeout,
      message: 'realtime init frame',
    })
    .toBeTruthy();
  expect(init.t, `realtime handshake failed: ${JSON.stringify(init)}`).toBe('init');
  await page.locator('canvas.interactive').waitFor();
  await expect.poll(() => page.evaluate(() => !!window.__monetE2E?.app()), { timeout: 10_000 }).toBe(true);
  return init;
}

export interface OpenedBoard {
  /** Raw realtime frames received by this page (parsed JSON, shared across navigations). */
  frames: any[];
  init: any;
}

/** Pages of people without a session yet: the name they type on a share link's prompt, and who to tell once joined. */
const guests = new WeakMap<Page, { name: string; onJoin: (u: { id: string; name: string; kind: 'owner' | 'guest' }) => void }>();

export function registerGuest(page: Page, name: string, onJoin: (u: { id: string; name: string; kind: 'owner' | 'guest' }) => void) {
  guests.set(page, { name, onJoin });
}

/**
 * Navigates to a board URL (`/b/:id` or `/s/:token`) and resolves once the realtime `init` arrived and the canvas is
 * interactive. On a share link, a person without a session (see newGuest) fills in the name prompt first, like a
 * real guest does.
 */
export async function openBoard(page: Page, url: string): Promise<OpenedBoard> {
  const watcher = watchRealtime(page);
  const since = watcher.frames.length;
  await page.goto(url);
  const guest = guests.get(page);
  if (guest && url.startsWith('/s/')) {
    const nameInput = page.getByTestId('input-guest-name');
    const board = page.locator('canvas.interactive');
    await expect(nameInput.or(board).first()).toBeVisible({ timeout: 30_000 });
    if (await nameInput.isVisible()) {
      await nameInput.fill(guest.name);
      await page.getByTestId('button-join-board').click();
    }
  }
  const init = await waitForBoardReady(page, since);
  if (guest) guest.onJoin({ id: init.me.userId, name: init.me.name, kind: init.board.role === 'owner' ? 'owner' : 'guest' });
  return { frames: watcher.frames, init };
}

/** A page point inside the canvas, as fractions of the canvas box (keeps clear of panels). */
export async function canvasPoint(page: Page, fx: number, fy: number) {
  const box = await page.locator('canvas.interactive').boundingBox();
  if (!box) throw new Error('canvas not found');
  // Map fractions onto open canvas: skip the shape-properties panel Excalidraw shows on the left while a tool
  // or selection is active (about 220px wide), so drags never start on it.
  const left = 240;
  return { x: Math.round(box.x + left + (box.width - left) * fx), y: Math.round(box.y + box.height * fy) };
}

/** Gives the canvas keyboard focus by clicking an empty spot (Excalidraw handles keys only when focused). */
export async function focusCanvas(page: Page) {
  const p = await canvasPoint(page, 0.93, 0.78);
  await page.mouse.click(p.x, p.y);
}

export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** Picks a tool with its keyboard shortcut (r, o, d, a, t, p, f, h, v ...) and drags out a shape. */
export async function drawWithKey(page: Page, key: string, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.keyboard.press(key);
  await drag(page, from, to);
}

/** Draws a shape and returns the new element (the one that wasn't in the scene before). */
export async function drawShape(page: Page, key: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<El> {
  const before = new Set((await sceneOf(page, { includeDeleted: true })).map((e) => e.id));
  await drawWithKey(page, key, from, to);
  let created: El | undefined;
  await expect
    .poll(
      async () => {
        created = (await sceneOf(page)).find((e) => !before.has(e.id));
        return !!created;
      },
      { message: `shape drawn with "${key}"` },
    )
    .toBe(true);
  return created!;
}

/** Creates a text element by clicking with the text tool and typing. */
export async function addText(page: Page, at: { x: number; y: number }, text: string): Promise<El> {
  const before = new Set((await sceneOf(page, { includeDeleted: true })).map((e) => e.id));
  await page.keyboard.press('t');
  await page.mouse.click(at.x, at.y);
  await page.locator('textarea.excalidraw-wysiwyg').waitFor();
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  let created: El | undefined;
  await expect
    .poll(async () => {
      created = (await sceneOf(page)).find((e) => !before.has(e.id) && e.type === 'text' && e.text === text);
      return !!created;
    })
    .toBe(true);
  return created!;
}

/** Page point on the top edge of an element (clicking the stroke selects even unfilled shapes). */
export async function topEdgeOf(page: Page, el: { x: number; y: number; width: number }) {
  return toScreen(page, el.x + el.width / 2, el.y);
}

export async function centerOf(page: Page, el: { x: number; y: number; width: number; height: number }) {
  return toScreen(page, el.x + el.width / 2, el.y + el.height / 2);
}

/** Waits until the element is present (or absent) in a page's local scene. */
export async function waitForElement(page: Page, predicate: (e: El) => boolean, opts: { timeout?: number; message?: string } = {}): Promise<El> {
  let found: El | undefined;
  await expect
    .poll(
      async () => {
        found = (await sceneOf(page)).find(predicate);
        return !!found;
      },
      { timeout: opts.timeout ?? LIVE_TIMEOUT, message: opts.message },
    )
    .toBe(true);
  return found!;
}

/**
 * Attaches a JPEG screenshot to the report (small enough to commit). Attached by path so the JSON
 * report stays small; the HTML report copies the image into its own folder.
 */
export async function snap(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.jpg`);
  await page.screenshot({ type: 'jpeg', quality: 60, path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/jpeg' });
  return file;
}

/** Scrolls so the given scene elements are in view (test-only viewport change). */
export async function scrollToElements(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    const app = window.__monetE2E?.app();
    const els = app.getSceneElements().filter((e: any) => ids.includes(e.id));
    app.scrollToContent(els, { fitToContent: true, animate: false });
  }, ids);
  await page.waitForTimeout(200);
}
