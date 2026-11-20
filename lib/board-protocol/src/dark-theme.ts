// Maps content made with the original light palette onto the dark board: saturated fills with
// dark text, light free text and captions, dark lane/card backgrounds, thin grey lines and arrows, and the clean
// sans font. Used by the templates and by the one-time upgrade of boards created before the dark redesign
// (the realtime server runs it once per board and records appState.monetTheme = "dark").
import { FONT, PALETTE } from "./elements";
import type { SceneElement } from "./messages";
import { DARK_PALETTE } from "./palette";

const FILL_MAP: Record<string, string> = {
  [PALETTE.stickyYellow]: DARK_PALETTE.FILLS.yellow,
  [PALETTE.stickyGreen]: DARK_PALETTE.FILLS.green,
  [PALETTE.stickyBlue]: DARK_PALETTE.FILLS.blue,
  [PALETTE.stickyPink]: DARK_PALETTE.FILLS.pink,
  [PALETTE.stickyOrange]: DARK_PALETTE.FILLS.orange,
  [PALETTE.stickyPurple]: DARK_PALETTE.FILLS.purple,
  [PALETTE.sectionFill]: "#1f1f1f",
  "#ffffff": "#262626",
  // Excalidraw's light background swatches.
  "#ffec99": DARK_PALETTE.FILLS.yellow,
  "#b2f2bb": DARK_PALETTE.FILLS.green,
  "#a5d8ff": DARK_PALETTE.FILLS.blue,
  "#ffc9c9": DARK_PALETTE.FILLS.pink,
};
const SATURATED = new Set<string>(Object.values(DARK_PALETTE.FILLS).filter((c) => c !== "#ffffff"));
const LIGHT_LINES = new Set(["#ced4da", "#dee2e6", "#adb5bd", "#e9ecef"]);
const INKS = new Set([PALETTE.ink, "#000000", "#1e1e1e", "#343a40", "#212529"]);
/** Text that reads fine on the dark canvas already (light text, the dark palette, accent colors). */
const isDarkInk = (c: string) => INKS.has(c);

export const DARK_THEME_VERSION = "dark";

/**
 * Rewrites element colors in place for the dark board. Returns the ids of elements that changed, so callers can
 * bump versions. Idempotent: running it on dark-palette content changes nothing.
 */
export function darkenElements(elements: SceneElement[]): Set<string> {
  const changed = new Set<string>();
  const set = (e: SceneElement, key: string, value: unknown) => {
    if ((e as Record<string, unknown>)[key] === value) return;
    (e as Record<string, unknown>)[key] = value;
    changed.add(e.id as string);
  };
  const byId = new Map(elements.map((e) => [e.id as string, e]));
  for (const e of elements) {
    if (e.isDeleted) continue;
    const bg = String(e.backgroundColor ?? "transparent").toLowerCase();
    if (FILL_MAP[bg]) set(e, "backgroundColor", FILL_MAP[bg]);
    if (e.fontFamily === FONT.handDrawn) set(e, "fontFamily", FONT.normal);
  }
  for (const e of elements) {
    if (e.isDeleted) continue;
    const stroke = String(e.strokeColor ?? "").toLowerCase();
    const bg = String(e.backgroundColor ?? "transparent").toLowerCase();
    if (e.type === "text") {
      const container = e.containerId ? byId.get(e.containerId as string) : undefined;
      const containerBg = String(container?.backgroundColor ?? "transparent").toLowerCase();
      if (container && SATURATED.has(containerBg)) {
        if (isDarkInk(stroke)) set(e, "strokeColor", DARK_PALETTE.TEXT_ON_FILL);
      } else if (stroke === PALETTE.muted) set(e, "strokeColor", DARK_PALETTE.TEXT_SUBTLE);
      else if (isDarkInk(stroke)) set(e, "strokeColor", DARK_PALETTE.TEXT_ON_DARK);
    } else if (e.type === "arrow") {
      if (isDarkInk(stroke) || LIGHT_LINES.has(stroke)) set(e, "strokeColor", DARK_PALETTE.ARROW);
    } else if (e.type === "line" || e.type === "freedraw") {
      if (LIGHT_LINES.has(stroke)) set(e, "strokeColor", DARK_PALETTE.LINE);
      else if (isDarkInk(stroke)) set(e, "strokeColor", DARK_PALETTE.DEFAULT_STROKE);
    } else if (e.type !== "frame" && e.type !== "image" && e.type !== "embeddable" && e.type !== "iframe") {
      if (SATURATED.has(bg) && (isDarkInk(stroke) || LIGHT_LINES.has(stroke))) set(e, "strokeColor", bg);
      else if (LIGHT_LINES.has(stroke)) set(e, "strokeColor", DARK_PALETTE.LINE);
      else if (isDarkInk(stroke)) set(e, "strokeColor", bg === "transparent" ? DARK_PALETTE.DEFAULT_STROKE : "#5c5c5c");
    }
  }
  return changed;
}
