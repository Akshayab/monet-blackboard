// Monet Blackboard keyboard shortcuts shown in the "?" help overlay on the board page.
//
// Features that add their own shortcuts register them here so the overlay stays accurate:
//   useRegisterShortcuts('AI', [{ keys: ['Mod', 'Enter'], label: 'Send to the AI' }]);
// 'Mod' renders as ⌘ on Apple devices and Ctrl elsewhere.
import { useEffect, useSyncExternalStore } from 'react';

// Defined here, not in the board tools, so the library page can use this file without loading Excalidraw.
export const STICKY_SHORTCUT = 'N';
export const VOTE_SHORTCUT = 'U';

export interface Shortcut {
  /** Keys pressed together, e.g. ['Mod', 'Shift', 'Z']. Use a single entry like 'Click an avatar' for pointer gestures. */
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  group: string;
  items: Shortcut[];
}

/** Shortcuts that belong to Monet Blackboard itself (not Excalidraw). */
const CORE: ShortcutGroup[] = [
  {
    group: 'Monet Blackboard',
    items: [
      { keys: ['?'], label: 'Show these shortcuts' },
      { keys: [STICKY_SHORTCUT], label: 'Sticky note tool' },
      { keys: [VOTE_SHORTCUT], label: 'Vote on the selection with your face sticker (again to take it back)' },
      { keys: ['Click an avatar'], label: "Follow a teammate's view (click again to stop)" },
      { keys: ['Click the title'], label: 'Rename the board (Enter saves, Esc cancels)' },
    ],
  },
];

/** Excalidraw built-ins that matter most on a whiteboard. The full list is in the canvas help dialog. */
export const CANVAS_ESSENTIALS: ShortcutGroup[] = [
  {
    group: 'Tools',
    items: [
      { keys: ['V'], label: 'Select' },
      { keys: ['H'], label: 'Hand (pan)' },
      { keys: ['R'], label: 'Rectangle / card' },
      { keys: ['O'], label: 'Ellipse' },
      { keys: ['D'], label: 'Diamond' },
      { keys: ['A'], label: 'Arrow (connector)' },
      { keys: ['T'], label: 'Text' },
      { keys: ['P'], label: 'Draw (sketch)' },
      { keys: ['F'], label: 'Section (frame)' },
      { keys: ['E'], label: 'Eraser' },
      { keys: ['K'], label: 'Laser pointer' },
    ],
  },
  {
    group: 'View',
    items: [
      { keys: ['Space', 'Drag'], label: 'Pan the board' },
      { keys: ['Mod', 'Scroll'], label: 'Zoom in and out' },
      { keys: ['Shift', '1'], label: 'Zoom to fit everything' },
      { keys: ['Shift', '2'], label: 'Zoom to selection' },
    ],
  },
  {
    group: 'Edit',
    items: [
      { keys: ['Mod', 'Z'], label: 'Undo' },
      { keys: ['Mod', 'Shift', 'Z'], label: 'Redo' },
      { keys: ['Mod', 'D'], label: 'Duplicate' },
      { keys: ['Alt', 'Drag'], label: 'Duplicate while dragging' },
      { keys: ['Mod', 'G'], label: 'Group selection' },
      { keys: ['Enter'], label: 'Edit text of the selected shape' },
      { keys: ['Delete'], label: 'Delete selection' },
    ],
  },
];

let registered: ShortcutGroup[] = [];
let snapshot: ShortcutGroup[] = CORE;
const listeners = new Set<() => void>();

function rebuild() {
  const byGroup = new Map<string, Shortcut[]>();
  for (const g of [...CORE, ...registered]) byGroup.set(g.group, [...(byGroup.get(g.group) ?? []), ...g.items]);
  snapshot = [...byGroup].map(([group, items]) => ({ group, items }));
  listeners.forEach((l) => l());
}

/** Adds shortcuts to the overlay. Returns a function that removes them again. */
export function registerShortcuts(group: string, items: Shortcut[]): () => void {
  const entry: ShortcutGroup = { group, items };
  registered = [...registered, entry];
  rebuild();
  return () => {
    registered = registered.filter((g) => g !== entry);
    rebuild();
  };
}

/** Registers shortcuts while the calling component is mounted. Pass a stable (memoized or module-level) array. */
export function useRegisterShortcuts(group: string, items: Shortcut[]) {
  useEffect(() => registerShortcuts(group, items), [group, items]);
}

export function useAppShortcuts(): ShortcutGroup[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}

export const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

export function keyLabel(k: string): string {
  if (k === 'Mod') return isApple ? '⌘' : 'Ctrl';
  if (k === 'Alt') return isApple ? '⌥' : 'Alt';
  if (k === 'Shift') return isApple ? '⇧' : 'Shift';
  return k;
}

/** True when the key event comes from a place where typing should not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
