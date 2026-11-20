// Shared colors for the dark Monet Blackboard canvas. Every part of the app (board shell, AI output, templates,
// sticky tool) uses these exact values so content looks the same no matter who made it.
//
// The board renders Excalidraw in its light theme on a dark background, so these values are what people see.
// (Excalidraw's own dark theme would invert every stored color.)
export const DARK_PALETTE = {
  CANVAS_BG: "#171717",
  GRID: "#262626",
  /** Headings and free text on the canvas. */
  TEXT_ON_DARK: "#f5f5f5",
  /** Subtitles under headings. */
  TEXT_SUBTLE: "#a3a3a3",
  /** Captions, notes, and secondary text (5.3:1 on dark card fills; light mode shows #666666). */
  TEXT_MUTED: "#999999",
  /** Text inside saturated fills and white cards. */
  TEXT_ON_FILL: "#1a1a1a",
  /** Table header text and table body text. */
  TABLE_HEADER: "#f5f5f5",
  TABLE_TEXT: "#d4d4d4",
  /** Thin separators (tables, chart gridlines, timeline lanes). */
  LINE: "#333333",
  /** Thin connector arrows. */
  ARROW: "#9ca3af",
  /** Default stroke for new hand-drawn items on the dark canvas. */
  DEFAULT_STROKE: "#e5e5e5",
  ACCENT: "#4d8ff7",
  /** The AI working outline, its label pill, and the send button. */
  RUST: "#c96442",
  RUST_BORDER: "#c96442",
  RUST_TINT: "rgba(201,100,66,0.06)",
  /** Rust as text (the timeline's "Today" label): 6.8:1 on the canvas; light mode shows #a34729. */
  RUST_TEXT: "#e3876a",
  /** AI suggestions: dashed outline/arrow color, sticky fill, and readable text on the canvas and on the fill. */
  SUGGESTION: "#7048e8",
  SUGGESTION_FILL: "#e5dbff",
  SUGGESTION_TEXT: "#b197fc",
  SUGGESTION_TEXT_ON_FILL: "#5530b8",
  FILLS: {
    pink: "#e8579f",
    yellow: "#f5d90a",
    purple: "#9b87f5",
    blue: "#5b9cf0",
    green: "#5fd35f",
    orange: "#f59e42",
    white: "#ffffff",
  },
} as const;

export type DarkFillName = keyof typeof DARK_PALETTE.FILLS;

/** Corner radius for AI shapes and stickies (Excalidraw adaptive roundness with a fixed small radius). */
export const SMALL_ROUNDNESS = { type: 3, value: 8 } as const;

/**
 * Light mode. Boards are stored in the dark palette (the canonical form); a client in light mode swaps this small
 * set of theme-dependent colors (free text, captions, lines, dark card fills) when elements arrive and swaps them
 * back before sending. Each pair swaps both ways, so the mapping is its own inverse and round trips are exact.
 * Saturated fills and the dark text on them are the same in both themes.
 */
export const THEME_SWAP_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["#f5f5f5", "#1e1e1e"], // headings and free text
  ["#e5e5e5", "#343a40"], // default stroke for hand drawing
  ["#d4d4d4", "#2b2b2b"], // table text
  ["#a3a3a3", "#6b6b6b"], // subtitles
  ["#9ca3af", "#6b7280"], // arrows
  ["#333333", "#dee2e6"], // separators and lines
  ["#262626", "#f1f3f5"], // dark card fills
  ["#1f1f1f", "#f8f9fa"], // lane and section fills
  ["#5c5c5c", "#adb5bd"], // neutral outlines
  ["#999999", "#666666"], // captions and notes (TEXT_MUTED)
  ["#8a8a8a", "#6e6e6e"], // captions on boards made before TEXT_MUTED changed
  ["#e3876a", "#a34729"], // rust text ("Today")
  ["#b197fc", "#6741d9"], // suggestion text
];

/**
 * Saturated fills used as the color of text, arrows, lines, and pen strokes. They read on the dark canvas but not
 * on white, so light mode shows a darker shade of the same hue (5:1 or better on white, section and card fills).
 * Only applied to strokes drawn on the canvas (text, arrows, lines, pen strokes, unfilled outlines): fills and the
 * outline of a filled shape stay the same in both themes.
 */
export const INK_SWAP_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["#e8579f", "#b82b69"], // pink
  ["#f5d90a", "#806500"], // yellow
  ["#9b87f5", "#6548d3"], // purple
  ["#5b9cf0", "#2160c4"], // blue
  ["#5fd35f", "#287528"], // green
  ["#f59e42", "#ad5309"], // orange
];
const INK_TYPES = new Set(["text", "arrow", "line", "freedraw"]);
const OUTLINE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
/** Elements whose stroke is drawn straight on the canvas: text, connectors, pen strokes, and unfilled outlines. */
function strokeOnCanvas(e: { type?: unknown; backgroundColor?: unknown }): boolean {
  if (typeof e.type !== "string") return false;
  if (INK_TYPES.has(e.type)) return true;
  return OUTLINE_TYPES.has(e.type) && String(e.backgroundColor ?? "transparent").toLowerCase() === "transparent";
}

/** Presence colors (cursors, avatars, cursor chat, votes, comment pins): white text reaches 4.5:1 on each. */
export const PRESENCE_COLORS = ["#d42b2b", "#2f7d32", "#1971c2", "#b45309", "#9c36b5", "#1f7a8c", "#c2410c", "#4c7a0b", "#c2255c"] as const;
const SWAP = new Map<string, string>();
for (const [a, b] of THEME_SWAP_PAIRS) {
  SWAP.set(a, b);
  SWAP.set(b, a);
}
const INK_TO_LIGHT = new Map(INK_SWAP_PAIRS.map(([dark, light]) => [dark, light] as const));
const INK_TO_DARK = new Map(INK_SWAP_PAIRS.map(([dark, light]) => [light, dark] as const));
export type BoardTheme = "dark" | "light";

/**
 * Ink colors. Toward light mode a saturated fill drawn on the canvas becomes its darker shade; toward the stored
 * (dark) form a darker shade always goes back to the fill, whatever the background is now, so a shape whose fill was
 * removed or added while shown in light mode still stores the dark-palette color.
 */
function inkSwap(e: { type?: unknown; backgroundColor?: unknown }, stroke: string, to: BoardTheme): string | undefined {
  if (typeof e.type !== "string" || !(INK_TYPES.has(e.type) || OUTLINE_TYPES.has(e.type))) return undefined;
  return to === "dark" ? INK_TO_DARK.get(stroke) : strokeOnCanvas(e) ? INK_TO_LIGHT.get(stroke) : undefined;
}

/** Swaps a theme-dependent color (no-op for everything else). Its own inverse. */
export function swapThemeColor(color: string | undefined | null): string | undefined | null {
  if (!color) return color;
  return SWAP.get(color.toLowerCase()) ?? color;
}

/**
 * Returns elements with theme-dependent colors swapped (new objects only where something changed). `to: "light"`
 * goes from the stored (dark) colors to light-mode display colors, `to: "dark"` goes back; versions are left
 * untouched. The paired colors swap both ways; ink colors (INK_SWAP_PAIRS) need the direction.
 */
export function swapThemeColors<T extends { type?: unknown; strokeColor?: unknown; backgroundColor?: unknown }>(elements: readonly T[], to: BoardTheme): T[] {
  return elements.map((e) => {
    const stroke = e.strokeColor as string | undefined;
    const ink = stroke ? inkSwap(e, stroke.toLowerCase(), to) : undefined;
    const s = ink ?? swapThemeColor(stroke);
    const b = swapThemeColor(e.backgroundColor as string | undefined);
    return s === e.strokeColor && b === e.backgroundColor ? e : { ...e, strokeColor: s, backgroundColor: b };
  });
}
