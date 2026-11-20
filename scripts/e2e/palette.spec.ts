// Palette contrast (no browser): every sticky fill with its text color, the canvas text colors, the AI's ink colors,
// and the presence colors meet WCAG 2.2 AA in both themes. Light mode is checked through the same swap the client
// uses (swapThemeColors), so a new color that isn't swapped, or swaps to something unreadable, fails here.
import { test, expect } from '@playwright/test';
import {
  DARK_PALETTE,
  INK_SWAP_PAIRS,
  PALETTE,
  PRESENCE_COLORS,
  STICKY_COLORS,
  THEME_SWAP_PAIRS,
  contrastRatio,
  makeSticky,
  makeText,
  swapThemeColors,
  type SceneElement,
} from '@monet/board-protocol';

const AA = 4.5;
const GRAPHICS = 3;
const WHITE = '#ffffff';

/** Canvas backgrounds text sits on: the canvas, section/lane fills, and dark card fills (stored colors). */
const DARK_GROUNDS = [DARK_PALETTE.CANVAS_BG, '#1f1f1f', '#262626'];
/** The same grounds as light mode shows them. */
const LIGHT_GROUNDS = [WHITE, '#f8f9fa', '#f1f3f5'];

const toLight = (els: SceneElement[]) => swapThemeColors(els, 'light');
const toDark = (els: SceneElement[]) => swapThemeColors(els, 'dark');
const fmt = (n: number) => n.toFixed(2);

function failures(rows: { what: string; fg: string; bg: string; min: number }[]): string[] {
  return rows
    .filter((r) => contrastRatio(r.fg, r.bg) < r.min)
    .map((r) => `${r.what}: ${r.fg} on ${r.bg} = ${fmt(contrastRatio(r.fg, r.bg))}:1 (needs ${r.min})`);
}

test.describe('palette contrast', () => {
  test('every sticky fill and its text reach 4.5:1 in both themes', () => {
    // Older boards still carry the light-palette sticky colors until they're opened and recolored.
    const lightStickies = [PALETTE.stickyYellow, PALETTE.stickyBlue, PALETTE.stickyGreen, PALETTE.stickyPink, PALETTE.stickyOrange, PALETTE.stickyPurple];
    const fills = [...new Set([...STICKY_COLORS, ...lightStickies, ...Object.values(DARK_PALETTE.FILLS)])];
    const rows: { what: string; fg: string; bg: string; min: number }[] = [];
    for (const fill of fills) {
      const dark = makeSticky({ x: 0, y: 0, text: 'Sticky', color: fill });
      for (const [theme, els] of [
        ['dark', dark],
        ['light', toLight(dark)],
      ] as const) {
        const box = els.find((e) => e.type !== 'text')!;
        const label = els.find((e) => e.type === 'text')!;
        rows.push({ what: `${theme} sticky ${fill}`, fg: String(label.strokeColor), bg: String(box.backgroundColor), min: AA });
      }
    }
    // An AI suggestion sticky: purple fill with its own label color.
    const suggestion = makeSticky({
      x: 0,
      y: 0,
      text: 'Idea',
      color: DARK_PALETTE.SUGGESTION_FILL,
      strokeColor: DARK_PALETTE.SUGGESTION,
      labelColor: DARK_PALETTE.SUGGESTION_TEXT_ON_FILL,
    });
    for (const [theme, els] of [
      ['dark', suggestion],
      ['light', toLight(suggestion)],
    ] as const) {
      rows.push({
        what: `${theme} suggestion sticky`,
        fg: String(els.find((e) => e.type === 'text')!.strokeColor),
        bg: String(els[0]!.backgroundColor),
        min: AA,
      });
    }
    const bad = failures(rows);
    expect(bad, bad.join('\n')).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(fills.length * 2);
  });

  test('canvas text colors reach 4.5:1 on the canvas, section and card fills in both themes', () => {
    const inks: [string, string][] = [
      ['heading/body', DARK_PALETTE.TEXT_ON_DARK],
      ['subtitle', DARK_PALETTE.TEXT_SUBTLE],
      ['caption/note', DARK_PALETTE.TEXT_MUTED],
      ['table text', DARK_PALETTE.TABLE_TEXT],
      ['hand-drawn stroke', DARK_PALETTE.DEFAULT_STROKE],
      ['"Today" label', DARK_PALETTE.RUST_TEXT],
      ['suggestion label', DARK_PALETTE.SUGGESTION_TEXT],
      // The AI's colored text and arrows use the saturated fills as ink.
      ...Object.entries(DARK_PALETTE.FILLS)
        .filter(([n]) => n !== 'white')
        .map(([n, c]) => [`${n} ink`, c] as [string, string]),
    ];
    const rows: { what: string; fg: string; bg: string; min: number }[] = [];
    for (const [what, color] of inks) {
      const el = makeText({ x: 0, y: 0, text: what, strokeColor: color });
      const light = String(toLight([el])[0]!.strokeColor);
      // Saturated inks on a dark card are 4.5:1 for most hues; pink only reaches it on the canvas and sections.
      const darkGrounds = what.endsWith(' ink') ? DARK_GROUNDS.slice(0, 2) : DARK_GROUNDS;
      for (const bg of darkGrounds) rows.push({ what: `dark ${what}`, fg: color, bg, min: AA });
      for (const bg of LIGHT_GROUNDS) rows.push({ what: `light ${what} (${light})`, fg: light, bg, min: AA });
    }
    const bad = failures(rows);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  test('arrows and connectors reach 3:1 against the canvas in both themes', () => {
    const arrow = { ...makeText({ x: 0, y: 0, text: '' }), type: 'arrow', strokeColor: DARK_PALETTE.ARROW } as SceneElement;
    const light = String(toLight([arrow])[0]!.strokeColor);
    const bad = failures([
      ...DARK_GROUNDS.map((bg) => ({ what: 'dark arrow', fg: DARK_PALETTE.ARROW, bg, min: GRAPHICS })),
      ...LIGHT_GROUNDS.map((bg) => ({ what: 'light arrow', fg: light, bg, min: GRAPHICS })),
    ]);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  test('presence colors carry white initials, names and cursor chat at 4.5:1', () => {
    const bad = failures(PRESENCE_COLORS.map((c) => ({ what: 'presence', fg: WHITE, bg: c, min: AA })));
    expect(bad, bad.join('\n')).toEqual([]);
  });

  test('light mode swaps round-trip exactly, and no swap color is listed twice', () => {
    const all = [...THEME_SWAP_PAIRS.flat(), ...INK_SWAP_PAIRS.flat()].map((c) => c.toLowerCase());
    expect(new Set(all).size, 'a color appears in more than one swap pair').toBe(all.length);
    const samples: SceneElement[] = [
      makeText({ x: 0, y: 0, text: 'Heading', strokeColor: DARK_PALETTE.TEXT_ON_DARK }),
      makeText({ x: 0, y: 0, text: 'Note', strokeColor: DARK_PALETTE.TEXT_MUTED }),
      makeText({ x: 0, y: 0, text: 'Pink', strokeColor: DARK_PALETTE.FILLS.pink }),
      { ...makeText({ x: 0, y: 0, text: '' }), type: 'arrow', strokeColor: DARK_PALETTE.FILLS.blue } as SceneElement,
      ...makeSticky({ x: 0, y: 0, text: 'Sticky', color: DARK_PALETTE.FILLS.yellow }),
    ];
    const back = toDark(toLight(samples));
    expect(back.map((e) => [e.strokeColor, e.backgroundColor])).toEqual(samples.map((e) => [e.strokeColor, e.backgroundColor]));
    // A filled sticky keeps its fill-colored outline in light mode (only strokes drawn on the canvas darken).
    const sticky = toLight(makeSticky({ x: 0, y: 0, text: 'S', color: DARK_PALETTE.FILLS.blue }));
    expect(sticky[0]!.strokeColor).toBe(DARK_PALETTE.FILLS.blue);
  });
});
