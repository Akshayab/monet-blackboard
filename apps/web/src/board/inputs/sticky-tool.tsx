// Sticky notes. Excalidraw has no sticky tool, so this adds one as an Excalidraw "custom" tool:
// a button next to the main toolbar (shortcut N, which Excalidraw doesn't use), click/tap the canvas to drop
// a sticky in the current color and start typing right away. Stickies are the same element JSON the AI
// makes (makeSticky: filled square, roughness 0, centered bound label, customData.kind = "sticky").
// Extras: a six-color picker (also recolors selected stickies) and a "+" handle on a selected sticky that
// adds the next one beside it. Ctrl/Cmd+D duplicates stickies natively.
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { CaptureUpdateAction, newElementWith, useDevice } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Plus } from 'lucide-react';
import { makeSticky, STICKY_COLORS } from '@monet/board-protocol';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isInOverlay, isWritable, Overlay } from './overlay';
import { insertElements, sceneToClient } from './scene';
import type { SceneState } from './use-scene-state';
import { STICKY_SHORTCUT } from '@/components/shortcuts/registry';

export const STICKY_TOOL = 'sticky';
const STICKY_SIZE = 180;
const GAP = 24;
const COLOR_KEY = 'monet.stickyColor';
const COLOR_NAMES = ['Yellow', 'Blue', 'Green', 'Pink', 'Orange', 'Purple'];

// The board shell's bottom tool pill has its own sticky button. While it's mounted, this file skips its floating
// button and anchors the color palette above the pill's button instead.
let pillMounts = 0;
const pillListeners = new Set<() => void>();
const notifyPill = () => pillListeners.forEach((l) => l());
export function useRegisterStickyPill() {
  useEffect(() => {
    pillMounts++;
    notifyPill();
    return () => {
      pillMounts--;
      notifyPill();
    };
  }, []);
}
function usePillMounted() {
  return useSyncExternalStore(
    (l) => {
      pillListeners.add(l);
      return () => pillListeners.delete(l);
    },
    () => pillMounts > 0,
  );
}

function isStickyTool(api: ExcalidrawImperativeAPI) {
  const tool = api.getAppState().activeTool;
  return tool.type === 'custom' && tool.customType === STICKY_TOOL;
}

export function isSticky(el: ExcalidrawElement) {
  return el.type !== 'text' && (el.customData as { kind?: string } | undefined)?.kind === 'sticky';
}

/** Puts the text cursor in a sticky's label (Excalidraw starts editing a selected container on Enter). */
function startEditing(api: ExcalidrawImperativeAPI, stickyId: string, attempt = 0) {
  requestAnimationFrame(() => {
    const app = api.getAppState();
    if (app.editingTextElement) return;
    if (!app.selectedElementIds[stickyId]) {
      if (attempt < 5) startEditing(api, stickyId, attempt + 1);
      return;
    }
    const container = document.querySelector<HTMLElement>('.excalidraw-container');
    container?.focus({ preventScroll: true });
    container?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  });
}

/** Adds a sticky centered on (cx, cy), selects it and starts editing its text. Returns its id. */
export function createSticky(api: ExcalidrawImperativeAPI, cx: number, cy: number, color: string) {
  // makeSticky with a blank label creates the bound text up front, so the label gets the sticky's font size.
  const elements = makeSticky({ x: cx - STICKY_SIZE / 2, y: cy - STICKY_SIZE / 2, text: ' ', color, size: STICKY_SIZE });
  const label = elements[1];
  if (label) {
    label.text = '';
    label.originalText = '';
  }
  if (api.getAppState().activeTool.type !== 'selection') api.setActiveTool({ type: 'selection' });
  insertElements(api, elements, { select: true, restore: false });
  startEditing(api, elements[0]!.id);
  return elements[0]!.id;
}

function readColor() {
  try {
    const c = localStorage.getItem(COLOR_KEY);
    if (c && (STICKY_COLORS as readonly string[]).includes(c)) return c;
  } catch {
    /* storage unavailable */
  }
  return STICKY_COLORS[0]!;
}

/** Screen rectangle of Excalidraw's main toolbar row (desktop) or bottom toolbar (mobile). */
function useToolbarRect(api: ExcalidrawImperativeAPI) {
  const [rect, setRect] = useState<{ toolbar: DOMRect; topRight: DOMRect | null } | null>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const toolbar = document.querySelector('.App-toolbar-container') ?? document.querySelector('.App-toolbar');
      if (!toolbar) return;
      const topRight = document.querySelector('.layer-ui__wrapper__top-right');
      const next = { toolbar: toolbar.getBoundingClientRect(), topRight: topRight?.getBoundingClientRect() ?? null };
      setRect((prev) =>
        prev &&
        prev.toolbar.left === next.toolbar.left &&
        prev.toolbar.right === next.toolbar.right &&
        prev.toolbar.top === next.toolbar.top &&
        prev.topRight?.left === next.topRight?.left
          ? prev
          : next,
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    const el = document.querySelector('.excalidraw-container');
    if (el) ro.observe(el);
    const tb = document.querySelector('.App-toolbar-container');
    if (tb) ro.observe(tb);
    window.addEventListener('resize', schedule);
    const off = api.onChange(schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [api]);
  return rect;
}

function StickyIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path d="M4 4h16v11l-5 5H4z" fill={color} stroke="#1e1e1e" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M15 20v-5h5" fill="none" stroke="#1e1e1e" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function StickyTool({ api, scene }: { api: ExcalidrawImperativeAPI; scene: SceneState }) {
  const [color, setColorState] = useState(readColor);
  const device = useDevice();
  const rect = useToolbarRect(api);
  const pill = usePillMounted();
  const tool = scene.app.activeTool;
  const active = tool.type === 'custom' && tool.customType === STICKY_TOOL;
  const selectedStickies = scene.selected.filter(isSticky);
  const onlyStickies = selectedStickies.length > 0 && scene.selected.every((e) => isSticky(e) || e.type === 'text');

  const toggle = useCallback(() => {
    if (isStickyTool(api)) api.setActiveTool({ type: 'selection' });
    else {
      api.setActiveTool({ type: 'custom', customType: STICKY_TOOL });
      api.setCursor('crosshair');
    }
  }, [api]);

  const setColor = (c: string) => {
    setColorState(c);
    try {
      localStorage.setItem(COLOR_KEY, c);
    } catch {
      /* storage unavailable */
    }
    // Recolor any selected stickies too.
    const ids = new Set(selectedStickies.map((e) => e.id));
    if (!ids.size) return;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) => (ids.has(e.id) && e.backgroundColor !== c ? newElementWith(e, { backgroundColor: c }) : e)),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  // Place a sticky where the canvas was clicked or tapped while the tool is active.
  const colorRef = useLatest(color);
  useEffect(
    () =>
      api.onPointerUp((activeTool, pointerDownState) => {
        if (activeTool.type !== 'custom' || activeTool.customType !== STICKY_TOOL) return;
        const { x, y } = pointerDownState.origin;
        setTimeout(() => createSticky(api, x, y, colorRef.current), 0);
      }),
    [api, colorRef],
  );

  // Shortcut: N toggles the tool (Escape leaves it via Excalidraw, which resets custom tools).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== STICKY_SHORTCUT.toLowerCase() || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isWritable(e.target) || isInOverlay(e.target) || api.getAppState().editingTextElement) return;
      const t = e.target;
      if (t instanceof Element && t !== document.body && !t.closest('.excalidraw-container')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [api, toggle]);

  if (!rect && !pill) return null;

  // "+" handle on a single selected sticky: add the next sticky to its right.
  const one = selectedStickies.length === 1 && onlyStickies && !scene.busy ? selectedStickies[0]! : null;
  const handle = one ? sceneToClient(one.x + one.width, one.y + one.height / 2, scene.app) : null;
  const addNext = () => {
    if (!one) return;
    let x = one.x + one.width + GAP + STICKY_SIZE / 2;
    const y = one.y + one.height / 2;
    const others = api.getSceneElements().filter(isSticky);
    // Skip over stickies already in that row.
    for (
      let i = 0;
      i < 20 && others.some((s) => Math.abs(s.x + s.width / 2 - x) < STICKY_SIZE * 0.6 && Math.abs(s.y + s.height / 2 - y) < STICKY_SIZE * 0.6);
      i++
    ) {
      x += STICKY_SIZE + GAP;
    }
    createSticky(api, x, y, one.backgroundColor);
  };
  const showPalette = active || onlyStickies;
  const paletteW = STICKY_COLORS.length * 30 + 12;

  const palette = (left: number, top: number, dark: boolean) => (
    <div
      className={cn(
        'fixed z-40 flex gap-1.5 rounded-lg p-1.5',
        dark
          ? 'border border-[var(--monet-border-2)] bg-[var(--monet-surface)] shadow-[0_8px_30px_rgba(0,0,0,0.45)]'
          : 'bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_8px_rgba(0,0,0,0.12)]',
      )}
      style={{ left, top }}
      role="radiogroup"
      aria-label="Sticky color"
      data-testid="palette-sticky-colors"
    >
      {STICKY_COLORS.map((c, i) => {
        const current = onlyStickies ? selectedStickies.every((s) => s.backgroundColor === c) : c === color;
        return (
          <button
            key={c}
            role="radio"
            aria-checked={current}
            aria-label={COLOR_NAMES[i]}
            title={COLOR_NAMES[i]}
            onClick={() => setColor(c)}
            className={cn(
              'h-6 w-6 rounded-md border',
              dark ? 'border-white/10' : 'border-black/15',
              current &&
                (dark ? 'ring-2 ring-[var(--monet-active-fg)] ring-offset-1 ring-offset-[var(--monet-surface)]' : 'ring-2 ring-indigo-500 ring-offset-1'),
            )}
            style={{ background: c }}
            data-testid={`sticky-color-${i}`}
          />
        );
      })}
    </div>
  );
  const addNextButton = handle && (
    <button
      className="fixed z-20 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full border border-[var(--monet-border-2)] bg-[var(--monet-surface)] text-[var(--monet-text)] shadow-md hover:bg-[var(--monet-hover)]"
      style={{ left: handle.x + 12, top: handle.y }}
      onClick={addNext}
      aria-label="Add a sticky next to this one"
      title="Add a sticky next to this one"
      data-testid="button-sticky-add-next"
    >
      <Plus className="h-4 w-4" />
    </button>
  );

  if (pill) {
    const btn = document.querySelector('[data-monet-tool-pill] [data-testid="tool-sticky"]')?.getBoundingClientRect();
    const left = btn ? Math.max(8, Math.min(btn.left + btn.width / 2 - paletteW / 2, window.innerWidth - paletteW - 8)) : 8;
    // Above the whole bottom dock (prompt bar + tool pill), so it never covers the prompt bar.
    const dock = document.querySelector('.monet-bottom-dock')?.getBoundingClientRect();
    const top = dock ? dock.top - 50 : btn ? btn.top - 50 : window.innerHeight - 120;
    return (
      <Overlay>
        {showPalette && palette(left, top, true)}
        {addNextButton}
      </Overlay>
    );
  }
  if (!rect) return null;

  // Next to the toolbar when there's room, otherwise just below it. Above the bottom toolbar on mobile.
  const size = 44;
  let left: number;
  let top: number;
  if (device.editor.isMobile) {
    left = rect.toolbar.right - size;
    top = rect.toolbar.top - size - 8;
  } else if (!rect.topRight || rect.toolbar.right + 8 + size <= rect.topRight.left - 8) {
    left = rect.toolbar.right + 8;
    top = rect.toolbar.top + (rect.toolbar.height - size) / 2;
  } else {
    left = rect.toolbar.right - size;
    top = rect.toolbar.bottom + 8;
  }
  const paletteLeft = Math.max(8, Math.min(left + size - paletteW, window.innerWidth - paletteW - 8));
  const paletteTop = device.editor.isMobile ? top - 46 : top + size + 6;

  return (
    <Overlay>
      <div
        className="fixed z-20 rounded-lg bg-white p-1 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_8px_rgba(0,0,0,0.12)]"
        style={{ left, top, width: size, height: size }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={cn('grid h-9 w-9 place-items-center rounded-md', active ? 'bg-[#e0dfff]' : 'hover:bg-neutral-100')}
              onClick={toggle}
              aria-pressed={active}
              aria-label={`Sticky note (${STICKY_SHORTCUT})`}
              data-testid="tool-sticky"
            >
              <StickyIcon color={color} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Sticky note <span className="ml-1 opacity-60">{STICKY_SHORTCUT}</span>
          </TooltipContent>
        </Tooltip>
      </div>
      {showPalette && (
        <div
          className="fixed z-20 flex gap-1.5 rounded-lg bg-white p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_8px_rgba(0,0,0,0.12)]"
          style={{ left: paletteLeft, top: paletteTop }}
          role="radiogroup"
          aria-label="Sticky color"
          data-testid="palette-sticky-colors"
        >
          {STICKY_COLORS.map((c, i) => {
            const current = onlyStickies ? selectedStickies.every((s) => s.backgroundColor === c) : c === color;
            return (
              <button
                key={c}
                role="radio"
                aria-checked={current}
                aria-label={COLOR_NAMES[i]}
                title={COLOR_NAMES[i]}
                onClick={() => setColor(c)}
                className={cn('h-6 w-6 rounded-md border border-black/15', current && 'ring-2 ring-indigo-500 ring-offset-1')}
                style={{ background: c }}
                data-testid={`sticky-color-${i}`}
              />
            );
          })}
        </div>
      )}
      {handle && (
        <button
          className="fixed z-20 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full border bg-white text-neutral-600 shadow-md hover:bg-neutral-50"
          style={{ left: handle.x + 12, top: handle.y }}
          onClick={addNext}
          aria-label="Add a sticky next to this one"
          title="Add a sticky next to this one"
          data-testid="button-sticky-add-next"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </Overlay>
  );
}

function useLatest<T>(value: T) {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}
