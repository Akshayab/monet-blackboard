// App theme: dark (default) or light. Stored per browser. The <html> element gets the
// "monet-light" class in light mode; index.css and the board shell switch their CSS variables on it.
import { useSyncExternalStore } from 'react';
import { swapThemeColors, THEME_SWAP_PAIRS, DARK_PALETTE, type BoardTheme } from '@monet/board-protocol';

const KEY = 'monet.theme';
const listeners = new Set<() => void>();

function read(): BoardTheme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let current: BoardTheme = typeof window === 'undefined' ? 'dark' : read();

function apply(theme: BoardTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('monet-light', theme === 'light');
  root.style.colorScheme = theme;
}
apply(current);

export function getTheme(): BoardTheme {
  return current;
}

export function setTheme(theme: BoardTheme) {
  if (theme === current) return;
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
  apply(theme);
  listeners.forEach((l) => l());
}

export function toggleTheme() {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

export function subscribeTheme(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useTheme(): BoardTheme {
  return useSyncExternalStore(subscribeTheme, getTheme, () => 'dark' as BoardTheme);
}

type Colored = { type?: unknown; strokeColor?: unknown; backgroundColor?: unknown };
const swap = <T>(els: readonly T[], to: BoardTheme) => swapThemeColors(els as unknown as Colored[], to) as unknown as T[];

/** Stored (dark-palette) elements → the colors this client shows. */
export function toDisplay<T>(els: readonly T[]): T[] {
  return current === 'light' ? swap(els, 'light') : (els as T[]);
}

/** What this client shows → stored (dark-palette) colors, before sending to the server. */
export function toStored<T>(els: readonly T[]): T[] {
  return current === 'light' ? swap(els, 'dark') : (els as T[]);
}

/** Canvas background and default ink for a theme. */
export const BOARD_THEME = {
  dark: { background: '#171717', stroke: '#e5e5e5', grid: '#262626', blend: 'lighten' as const },
  light: { background: '#ffffff', stroke: '#1e1e1e', grid: '#ececec', blend: 'darken' as const },
};

const SVG_PREFIX = 'data:image/svg+xml;base64,';
const SVG_SWAP = new Map<string, string>([[DARK_PALETTE.CANVAS_BG.toLowerCase(), BOARD_THEME.light.background]]);
for (const [a, b] of THEME_SWAP_PAIRS) {
  SVG_SWAP.set(a, b);
  SVG_SWAP.set(b, a);
}
const lightThumbs = new Map<string, string>();

/**
 * Library thumbnails are saved in the stored (dark) colors. SVG thumbnails get the same color swap as the board
 * in light mode; raster thumbnails (boards with images) stay as saved.
 */
export function thumbnailForTheme(dataUrl: string, theme: BoardTheme): string {
  if (theme === 'dark' || !dataUrl.startsWith(SVG_PREFIX)) return dataUrl;
  const cached = lightThumbs.get(dataUrl);
  if (cached) return cached;
  try {
    const bytes = Uint8Array.from(atob(dataUrl.slice(SVG_PREFIX.length)), (c) => c.charCodeAt(0));
    const svg = new TextDecoder().decode(bytes).replace(/#[0-9a-fA-F]{6}\b/g, (hex) => SVG_SWAP.get(hex.toLowerCase()) ?? hex);
    const out = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    if (lightThumbs.size > 200) lightThumbs.clear();
    lightThumbs.set(dataUrl, out);
    return out;
  } catch {
    return dataUrl;
  }
}
