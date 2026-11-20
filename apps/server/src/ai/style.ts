// Colors and type sizes the board AI uses on the dark canvas (DARK_PALETTE). Names are what the model sees and
// passes back.
import { DARK_PALETTE, FONT, SMALL_ROUNDNESS } from "@monet/board-protocol";

const F = DARK_PALETTE.FILLS;

/** Saturated fills for stickies, shapes, cards, and chart series. */
export const FILLS: Record<string, string> = { ...F };

/** On the dark canvas the accent colors are the fills themselves (plus light/dark neutrals). */
/** "black" is the canvas ink: light text on the dark board, which light mode shows as near-black. */
export const STRONG: Record<string, string> = { ...F, gray: DARK_PALETTE.ARROW, black: DARK_PALETTE.TEXT_ON_DARK };

/** Names people or the model may use for colors we don't have. */
const ALIASES: Record<string, string> = {
  red: "pink",
  magenta: "pink",
  violet: "purple",
  teal: "green",
  cyan: "blue",
  amber: "orange",
  gold: "yellow",
  grey: "white",
  gray: "white",
};

export const COLOR_NAMES = Object.keys(F);

/** Default sticky colors cycled per section so each group reads as one color. */
export const SECTION_CYCLE = ["yellow", "blue", "green", "pink", "orange", "purple"];

export const SERIES_COLORS = [F.blue, F.pink, F.yellow, F.green, F.purple, F.orange];

export const TEXT_ON_DARK = DARK_PALETTE.TEXT_ON_DARK;
export const TEXT_SUBTLE = DARK_PALETTE.TEXT_SUBTLE;
export const TEXT_MUTED = DARK_PALETTE.TEXT_MUTED;
export const TEXT_ON_FILL = DARK_PALETTE.TEXT_ON_FILL;
export const TABLE_HEADER = DARK_PALETTE.TABLE_HEADER;
export const TABLE_TEXT = DARK_PALETTE.TABLE_TEXT;
export const LINE = DARK_PALETTE.LINE;
export const ARROW = DARK_PALETTE.ARROW;
export const RUST = DARK_PALETTE.RUST;
export const RUST_TEXT = DARK_PALETTE.RUST_TEXT;
/** Suggestions keep the review purple (the client's accept/dismiss UI looks for it). */
export const SUGGESTION = DARK_PALETTE.SUGGESTION;
export const SUGGESTION_FILL = DARK_PALETTE.SUGGESTION_FILL;
/** Suggestion text on the canvas (arrow labels) and on the suggestion fill. */
export const SUGGESTION_TEXT = DARK_PALETTE.SUGGESTION_TEXT;
export const SUGGESTION_TEXT_ON_FILL = DARK_PALETTE.SUGGESTION_TEXT_ON_FILL;
export const ROUND = SMALL_ROUNDNESS;
/** All AI text uses the clean sans font, never the hand-drawn one. */
export const SANS = FONT.normal;
/** Kept for older call sites. */
export const INK = TEXT_ON_FILL;
export const MUTED = TEXT_MUTED;
export const GRID_LINE = LINE;

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

function normalize(c: string | undefined | null): string {
  const n = (c ?? "").trim().toLowerCase();
  return ALIASES[n] ?? n;
}

export function fillColor(c: string | undefined | null, fallback: string = F.yellow): string {
  const n = normalize(c);
  if (!n) return fallback;
  if (HEX.test(n)) return n;
  return FILLS[n] ?? fallback;
}

/** Accent color for text/lines on the dark canvas. */
export function strongColor(c: string | undefined | null, fallback: string = TEXT_ON_DARK): string {
  const raw = (c ?? "").trim().toLowerCase();
  if (raw === "gray" || raw === "grey") return STRONG.gray!;
  if (raw === "black") return STRONG.black!;
  const n = normalize(c);
  if (!n) return fallback;
  if (HEX.test(n)) return n;
  return STRONG[n] ?? fallback;
}

/** Text color that reads on a fill. */
export function textOn(fill: string): string {
  return fill.toLowerCase() === "transparent" ? TEXT_ON_DARK : TEXT_ON_FILL;
}

/** Hex -> palette name for the model's board summary (falls back to the hex value). */
export function colorName(hex: unknown): string | undefined {
  if (typeof hex !== "string" || !hex || hex === "transparent") return undefined;
  const h = hex.toLowerCase();
  for (const [name, v] of Object.entries(F)) if (v.toLowerCase() === h) return name;
  return h;
}

/** Free text sizes: small / normal / large / xl / huge (title, heading, subtitle, body, note are older aliases). */
export const TEXT_SIZES = { small: 14, normal: 18, large: 24, xl: 32, huge: 44, title: 34, heading: 28, subtitle: 18, body: 18, note: 14 } as const;
/** One step up, for text the user wants bold (Excalidraw text has no bold). */
export const BOLDER: Record<string, TextSize> = {
  small: "normal",
  note: "normal",
  normal: "large",
  body: "large",
  subtitle: "large",
  large: "xl",
  heading: "xl",
  xl: "huge",
  title: "huge",
  huge: "huge",
};
export type TextSize = keyof typeof TEXT_SIZES;

export const TEXT_COLORS: Record<TextSize, string> = {
  small: TEXT_SUBTLE,
  normal: TEXT_ON_DARK,
  large: TEXT_ON_DARK,
  xl: TEXT_ON_DARK,
  huge: TEXT_ON_DARK,
  title: TEXT_ON_DARK,
  heading: TEXT_ON_DARK,
  subtitle: TEXT_SUBTLE,
  body: TEXT_ON_DARK,
  note: TEXT_MUTED,
};
