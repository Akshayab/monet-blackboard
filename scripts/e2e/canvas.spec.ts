// Core canvas tools, driven with real mouse and keyboard input. Assertions read the local
// Excalidraw scene and the server's copy of the board (GET /api/boards/:id), plus screenshots.
import type { Page } from '@playwright/test';
import { test, expect } from './lib/fixtures';
import { createBoard, getBoard } from './lib/api';
import { addText, appStateOf, canvasPoint, drag, drawShape, focusCanvas, openBoard, sceneOf, snap, toScreen, topEdgeOf, type El } from './lib/board';

async function freshBoard(page: Page, title: string) {
  const board = await createBoard(page.request, title);
  await openBoard(page, `/b/${board.id}`);
  await focusCanvas(page);
  return board;
}

async function serverElements(page: Page, boardId: string) {
  return (await getBoard(page.request, boardId)).elements;
}

async function el(page: Page, id: string): Promise<El> {
  const found = (await sceneOf(page, { includeDeleted: true })).find((e) => e.id === id);
  if (!found) throw new Error(`element ${id} not in scene`);
  return found;
}

test.describe('canvas', () => {
  test.beforeEach(async ({ user }) => {
    void user; // every canvas test runs signed in as a fresh user
  });

  test('infinite canvas: zoom in/out and pan', async ({ page }, testInfo) => {
    await freshBoard(page, 'Pan and zoom');
    const s0 = await appStateOf(page);
    expect(s0.zoom).toBe(1);

    await test.step('zoom buttons', async () => {
      // Zoom pill at the top right: "100% ⌄" opens zoom in / out / fit / reset.
      const zoomMenu = async (item: string) => {
        await page.getByTestId('button-zoom-menu').click();
        await page.getByTestId(item).click();
      };
      await zoomMenu('menu-zoom-in');
      await zoomMenu('menu-zoom-in');
      await expect.poll(async () => (await appStateOf(page)).zoom).toBeGreaterThan(1.1);
      await expect(page.getByTestId('button-zoom-menu')).toHaveText(/120%/);
      await zoomMenu('menu-zoom-out');
      await zoomMenu('menu-zoom-100');
      await expect.poll(async () => (await appStateOf(page)).zoom).toBe(1);
    });

    await test.step('pan with the hand tool', async () => {
      const before = await appStateOf(page);
      await page.keyboard.press('h');
      await drag(page, await canvasPoint(page, 0.35, 0.4), await canvasPoint(page, 0.6, 0.5));
      const after = await appStateOf(page);
      expect(after.scrollX - before.scrollX).toBeGreaterThan(150);
      expect(after.scrollY - before.scrollY).toBeGreaterThan(60);
      await page.keyboard.press('v');
    });

    await test.step('pan with the mouse wheel, far from the origin', async () => {
      const before = await appStateOf(page);
      const p = await canvasPoint(page, 0.5, 0.5);
      await page.mouse.move(p.x, p.y);
      for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400);
      await expect.poll(async () => before.scrollY - (await appStateOf(page)).scrollY).toBeGreaterThan(3000);
    });

    await test.step('draw out there: the canvas keeps going', async () => {
      const rect = await drawShape(page, 'r', await canvasPoint(page, 0.4, 0.4), await canvasPoint(page, 0.5, 0.5));
      expect(rect.y).toBeGreaterThan(3000);
      await snap(page, testInfo, 'far-away-rectangle');
    });

    await test.step('ctrl+wheel zooms around the pointer', async () => {
      const before = await appStateOf(page);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -200);
      await page.keyboard.up('Control');
      await expect.poll(async () => (await appStateOf(page)).zoom).not.toBe(before.zoom);
    });
  });

  test('rectangle, ellipse, and diamond', async ({ page }, testInfo) => {
    const board = await freshBoard(page, 'Shapes');
    await page.getByTestId('tool-rectangle').click();
    const before = new Set((await sceneOf(page)).map((e) => e.id));
    await drag(page, await canvasPoint(page, 0.15, 0.3), await canvasPoint(page, 0.27, 0.45));
    await expect.poll(async () => (await sceneOf(page)).filter((e) => !before.has(e.id)).map((e) => e.type)).toEqual(['rectangle']);
    const ellipse = await drawShape(page, 'o', await canvasPoint(page, 0.35, 0.3), await canvasPoint(page, 0.47, 0.45));
    const diamond = await drawShape(page, 'd', await canvasPoint(page, 0.55, 0.3), await canvasPoint(page, 0.67, 0.45));
    expect(ellipse.type).toBe('ellipse');
    expect(diamond.type).toBe('diamond');
    expect(ellipse.width).toBeGreaterThan(100);
    await expect.poll(async () => (await serverElements(page, board.id)).map((e) => e.type).sort()).toEqual(['diamond', 'ellipse', 'rectangle']);
    await snap(page, testInfo, 'shapes');
  });

  test('arrow bound between two shapes stays attached when a shape moves', async ({ page }, testInfo) => {
    const board = await freshBoard(page, 'Arrows');
    const a = await drawShape(page, 'r', await canvasPoint(page, 0.15, 0.3), await canvasPoint(page, 0.27, 0.45));
    const b = await drawShape(page, 'r', await canvasPoint(page, 0.55, 0.3), await canvasPoint(page, 0.67, 0.45));
    const start = await toScreen(page, a.x + a.width - 12, a.y + a.height / 2);
    const end = await toScreen(page, b.x + 12, b.y + b.height / 2);
    const arrow = await drawShape(page, 'a', start, end);
    expect(arrow.type).toBe('arrow');
    await expect.poll(async () => (await el(page, arrow.id)).startBinding?.elementId).toBe(a.id);
    await expect.poll(async () => (await el(page, arrow.id)).endBinding?.elementId).toBe(b.id);
    await snap(page, testInfo, 'arrow-bound');

    // Move B down by dragging its top edge.
    await page.keyboard.press('Escape');
    const grab = await topEdgeOf(page, b);
    await drag(page, grab, { x: grab.x, y: grab.y + 180 }, 12);
    await expect.poll(async () => (await el(page, b.id)).y - b.y).toBeGreaterThan(150);

    const movedB = await el(page, b.id);
    const after = await el(page, arrow.id);
    const last = after.points![after.points!.length - 1]!;
    const endX = after.x + last[0];
    const endY = after.y + last[1];
    const margin = 20;
    expect(after.endBinding?.elementId).toBe(b.id);
    expect(after.startBinding?.elementId).toBe(a.id);
    expect(endX).toBeGreaterThan(movedB.x - margin);
    expect(endX).toBeLessThan(movedB.x + movedB.width + margin);
    expect(endY).toBeGreaterThan(movedB.y - margin);
    expect(endY).toBeLessThan(movedB.y + movedB.height + margin);
    await snap(page, testInfo, 'arrow-follows-shape');

    // The server has the re-routed arrow too.
    await expect
      .poll(async () => {
        const srv = (await serverElements(page, board.id)).find((e) => e.id === arrow.id)!;
        const pts = srv.points as [number, number][];
        return Math.abs(srv.y + pts[pts.length - 1]![1] - endY) < 2;
      })
      .toBe(true);
  });

  test('text, freehand, and a section (frame) containing shapes', async ({ page }, testInfo) => {
    const board = await freshBoard(page, 'Text, pen, frames');

    const text = await addText(page, await canvasPoint(page, 0.25, 0.2), 'Brainstorm');
    expect(text.text).toBe('Brainstorm');

    await page.keyboard.press('p');
    const before = new Set((await sceneOf(page)).map((e) => e.id));
    const p0 = await canvasPoint(page, 0.25, 0.55);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(p0.x + i * 15, p0.y + Math.sin(i / 2) * 40, { steps: 2 });
    await page.mouse.up();
    let pen: El | undefined;
    await expect.poll(async () => (pen = (await sceneOf(page)).find((e) => !before.has(e.id)))?.type).toBe('freedraw');
    expect(pen!.points!.length).toBeGreaterThan(5);
    await page.keyboard.press('Escape');
    await page.keyboard.press('v');

    const r = await drawShape(page, 'r', await canvasPoint(page, 0.52, 0.35), await canvasPoint(page, 0.6, 0.48));
    const o = await drawShape(page, 'o', await canvasPoint(page, 0.64, 0.35), await canvasPoint(page, 0.72, 0.48));
    const frame = await drawShape(page, 'f', await canvasPoint(page, 0.48, 0.25), await canvasPoint(page, 0.78, 0.6));
    expect(frame.type).toBe('frame');
    await expect.poll(async () => (await el(page, r.id)).frameId).toBe(frame.id);
    await expect.poll(async () => (await el(page, o.id)).frameId).toBe(frame.id);
    await snap(page, testInfo, 'frame-with-children');

    // Moving the section moves what's inside it.
    await page.keyboard.press('Escape');
    const grab = await topEdgeOf(page, frame);
    await drag(page, grab, { x: grab.x - 150, y: grab.y + 60 }, 12);
    await expect.poll(async () => Math.round((await el(page, frame.id)).x - frame.x)).toBeLessThan(-100);
    const dx = (await el(page, frame.id)).x - frame.x;
    expect(Math.abs((await el(page, r.id)).x - r.x - dx)).toBeLessThan(2);
    expect(Math.abs((await el(page, o.id)).x - o.x - dx)).toBeLessThan(2);

    await expect
      .poll(async () => (await serverElements(page, board.id)).map((e) => e.type).sort())
      .toEqual(['ellipse', 'frame', 'freedraw', 'rectangle', 'text']);
    const srv = await serverElements(page, board.id);
    expect(srv.find((e) => e.id === r.id)?.frameId).toBe(frame.id);
  });

  test('select, multi-select, move, resize, duplicate, delete', async ({ page }, testInfo) => {
    const board = await freshBoard(page, 'Selection');
    const r1 = await drawShape(page, 'r', await canvasPoint(page, 0.2, 0.3), await canvasPoint(page, 0.3, 0.45));
    const r2 = await drawShape(page, 'r', await canvasPoint(page, 0.4, 0.3), await canvasPoint(page, 0.5, 0.45));
    await page.keyboard.press('Escape');

    await test.step('click selects, shift+click adds', async () => {
      const e1 = await topEdgeOf(page, r1);
      await page.mouse.click(e1.x, e1.y);
      await expect.poll(async () => (await appStateOf(page)).selectedIds).toEqual([r1.id]);
      const e2 = await topEdgeOf(page, r2);
      await page.keyboard.down('Shift');
      await page.mouse.click(e2.x, e2.y);
      await page.keyboard.up('Shift');
      await expect.poll(async () => (await appStateOf(page)).selectedIds.sort()).toEqual([r1.id, r2.id].sort());
    });

    await test.step('drag moves the whole selection', async () => {
      const e1 = await topEdgeOf(page, r1);
      await drag(page, e1, { x: e1.x + 80, y: e1.y + 60 }, 10);
      await expect.poll(async () => Math.round((await el(page, r1.id)).x - r1.x)).toBe(80);
      expect(Math.round((await el(page, r2.id)).x - r2.x)).toBe(80);
      expect(Math.round((await el(page, r2.id)).y - r2.y)).toBe(60);
    });

    await test.step('box-select from empty canvas', async () => {
      await page.keyboard.press('Escape');
      await drag(page, await canvasPoint(page, 0.15, 0.25), await canvasPoint(page, 0.62, 0.62));
      await expect.poll(async () => (await appStateOf(page)).selectedIds.sort()).toEqual([r1.id, r2.id].sort());
    });

    await test.step('resize with the corner handle', async () => {
      await page.keyboard.press('Escape');
      const cur = await el(page, r1.id);
      const e1 = await topEdgeOf(page, cur);
      await page.mouse.click(e1.x, e1.y);
      await expect.poll(async () => (await appStateOf(page)).selectedIds).toEqual([r1.id]);
      const corner = await toScreen(page, cur.x + cur.width, cur.y + cur.height);
      await drag(page, { x: corner.x + 4, y: corner.y + 4 }, { x: corner.x + 64, y: corner.y + 44 }, 10);
      await expect.poll(async () => Math.round((await el(page, r1.id)).width - cur.width)).toBeGreaterThan(40);
      expect((await el(page, r1.id)).height).toBeGreaterThan(cur.height + 20);
    });

    let dupId = '';
    await test.step('ctrl+d duplicates', async () => {
      await page.keyboard.press('Control+d');
      await expect.poll(async () => (await sceneOf(page)).filter((e) => e.type === 'rectangle').length).toBe(3);
      dupId = (await appStateOf(page)).selectedIds[0]!;
      expect([r1.id, r2.id]).not.toContain(dupId);
      await expect.poll(async () => (await serverElements(page, board.id)).length).toBe(3);
      await snap(page, testInfo, 'after-duplicate');
    });

    await test.step('delete removes it locally and on the server', async () => {
      await page.keyboard.press('Delete');
      await expect.poll(async () => (await sceneOf(page)).map((e) => e.id)).not.toContain(dupId);
      await expect.poll(async () => (await serverElements(page, board.id)).map((e) => e.id).sort()).toEqual([r1.id, r2.id].sort());
    });

    await test.step('anyone can rearrange: ctrl+a, delete clears the board', async () => {
      await page.keyboard.press('Control+a');
      await expect.poll(async () => (await appStateOf(page)).selectedIds.length).toBe(2);
      await page.keyboard.press('Delete');
      await expect.poll(async () => (await serverElements(page, board.id)).length).toBe(0);
    });
  });

  test('edit text and colors directly', async ({ page }, testInfo) => {
    const board = await freshBoard(page, 'Edit text and colors');
    const text = await addText(page, await canvasPoint(page, 0.2, 0.25), 'First draft');

    await test.step('double-click a text to edit it', async () => {
      await page.keyboard.press('Escape');
      const p = await toScreen(page, text.x + text.width / 2, text.y + text.height / 2);
      await page.mouse.dblclick(p.x, p.y);
      await page.locator('textarea.excalidraw-wysiwyg').waitFor();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Final copy');
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await el(page, text.id)).text).toBe('Final copy');
      await expect.poll(async () => (await serverElements(page, board.id)).find((e) => e.id === text.id)?.text).toBe('Final copy');
    });

    await test.step('text color', async () => {
      // Escape after editing leaves the text selected.
      await expect.poll(async () => (await appStateOf(page)).selectedIds).toEqual([text.id]);
      await page.getByTestId('color-top-pick-#e03131').click();
      await expect.poll(async () => (await el(page, text.id)).strokeColor).toBe('#e03131');
    });

    await test.step('shape stroke and fill colors', async () => {
      await page.keyboard.press('Escape');
      const rect = await drawShape(page, 'r', await canvasPoint(page, 0.4, 0.3), await canvasPoint(page, 0.55, 0.5));
      await page.getByTestId('color-top-pick-#1971c2').click();
      await page.getByTestId('color-top-pick-#ffec99').click();
      await expect.poll(async () => (await el(page, rect.id)).strokeColor).toBe('#1971c2');
      await expect.poll(async () => (await el(page, rect.id)).backgroundColor).toBe('#ffec99');
      await expect
        .poll(async () => {
          const srv = (await serverElements(page, board.id)).find((e) => e.id === rect.id);
          return `${srv?.strokeColor} ${srv?.backgroundColor}`;
        })
        .toBe('#1971c2 #ffec99');
      await snap(page, testInfo, 'colored');
    });
  });

  test('undo and redo', async ({ page }) => {
    const board = await freshBoard(page, 'Undo redo');
    const rect = await drawShape(page, 'r', await canvasPoint(page, 0.3, 0.3), await canvasPoint(page, 0.45, 0.5));
    await expect.poll(async () => (await serverElements(page, board.id)).length).toBe(1);

    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await sceneOf(page)).length).toBe(0);
    await expect.poll(async () => (await serverElements(page, board.id)).length).toBe(0);

    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await sceneOf(page)).map((e) => e.id)).toEqual([rect.id]);
    await expect.poll(async () => (await serverElements(page, board.id)).length).toBe(1);

    // Move, then undo/redo with the zoom pill's history buttons.
    await page.keyboard.press('Escape');
    const grab = await topEdgeOf(page, rect);
    await drag(page, grab, { x: grab.x + 120, y: grab.y }, 10);
    await expect.poll(async () => Math.round((await el(page, rect.id)).x - rect.x)).toBe(120);
    await page.getByTestId('button-history-undo').click();
    await expect.poll(async () => Math.round((await el(page, rect.id)).x)).toBe(Math.round(rect.x));
    await page.getByTestId('button-history-redo').click();
    await expect.poll(async () => Math.round((await el(page, rect.id)).x - rect.x)).toBe(120);
    await expect.poll(async () => Math.round(((await serverElements(page, board.id))[0]?.x ?? 0) - rect.x)).toBe(120);
  });

  test('copy and paste, within a board and across boards', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const board = await freshBoard(page, 'Copy paste');
    const rect = await drawShape(page, 'r', await canvasPoint(page, 0.2, 0.3), await canvasPoint(page, 0.32, 0.45));
    await page.keyboard.press('Control+c');
    // Excalidraw writes the clipboard asynchronously; a paste sent before that finishes has nothing to paste.
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText().catch(() => ''))).toContain('excalidraw/clipboard');
    const target = await canvasPoint(page, 0.6, 0.6);
    await page.mouse.move(target.x, target.y);
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await sceneOf(page)).filter((e) => e.type === 'rectangle').length).toBe(2);
    const pasted = (await sceneOf(page)).find((e) => e.id !== rect.id)!;
    expect(pasted.width).toBeCloseTo(rect.width, 0);
    expect(pasted.x).toBeGreaterThan(rect.x + 100);
    await expect.poll(async () => (await serverElements(page, board.id)).length).toBe(2);
    await snap(page, testInfo, 'pasted');

    const other = await createBoard(page.request, 'Paste target');
    await openBoard(page, `/b/${other.id}`);
    await focusCanvas(page);
    const p = await canvasPoint(page, 0.4, 0.4);
    await page.mouse.move(p.x, p.y);
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await sceneOf(page)).map((e) => e.type)).toEqual(['rectangle']);
    await expect.poll(async () => (await serverElements(page, other.id)).length).toBe(1);
  });

  test('keyboard shortcuts', async ({ page }, testInfo) => {
    await freshBoard(page, 'Shortcuts');
    const tools: [string, string][] = [
      ['r', 'rectangle'],
      ['o', 'ellipse'],
      ['d', 'diamond'],
      ['a', 'arrow'],
      ['l', 'line'],
      ['p', 'freedraw'],
      ['t', 'text'],
      ['f', 'frame'],
      ['e', 'eraser'],
      ['h', 'hand'],
      ['2', 'rectangle'],
      ['4', 'ellipse'],
      ['v', 'selection'],
    ];
    for (const [key, tool] of tools) {
      await page.keyboard.press(key);
      expect((await appStateOf(page)).activeTool, `key "${key}"`).toBe(tool);
    }

    await page.keyboard.press('Control+Equal');
    await expect.poll(async () => (await appStateOf(page)).zoom).toBeGreaterThan(1);
    await page.keyboard.press('Control+Minus');
    await page.keyboard.press('Control+Minus');
    await expect.poll(async () => (await appStateOf(page)).zoom).toBeLessThan(1);
    await page.keyboard.press('Control+0');
    await expect.poll(async () => (await appStateOf(page)).zoom).toBe(1);

    // "?" opens the Monet Blackboard shortcuts dialog (it links to the full canvas help).
    await page.keyboard.press('Shift+?');
    await expect(page.getByTestId('dialog-shortcuts')).toBeVisible();
    await snap(page, testInfo, 'shortcuts-help');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-shortcuts')).toHaveCount(0);
  });
});
