// Simple illustrations the board AI can draw (add_illustration): everyday objects built from a few primitives on a
// 100x100 grid, in "marker" style (hand-drawn strokes, roughness 2, hatched fills) or "clean" style (roughness 0,
// solid fills). By design it never draws people or faces; callers offer a person icon block instead.
import { DARK_PALETTE, makeLine, makeShape, newId, type SceneElement } from "@monet/board-protocol";
import type { BuildCtx } from "./builders";
import { outlineFor } from "./shapes";

type P = [number, number];
type Fill = keyof typeof DARK_PALETTE.FILLS | null;
type Prim =
  { k: "poly"; pts: P[]; close?: boolean; fill?: Fill; ink?: boolean } | { k: "oval"; x: number; y: number; w: number; h: number; fill?: Fill; ink?: boolean };

const poly = (fill: Fill, ...pts: P[]): Prim => ({ k: "poly", pts, close: true, fill });
const line = (...pts: P[]): Prim => ({ k: "poly", pts });
const ink = (...pts: P[]): Prim => ({ k: "poly", pts, ink: true });
const oval = (x: number, y: number, w: number, h: number, fill: Fill = null, inkStroke = false): Prim => ({ k: "oval", x, y, w, h, fill, ink: inkStroke });

function ring(cx: number, cy: number, n: number, radius: (i: number) => number, start = -90): P[] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((start + (360 * i) / n) * Math.PI) / 180;
    const r = radius(i);
    return [Math.round((cx + r * Math.cos(a)) * 10) / 10, Math.round((cy + r * Math.sin(a)) * 10) / 10] as P;
  });
}

const DRAWINGS: Record<string, () => Prim[]> = {
  mountain: () => [
    poly("blue", [8, 86], [42, 28], [76, 86]),
    poly("purple", [48, 86], [70, 48], [94, 86]),
    poly("white", [34, 42], [42, 28], [50, 42], [45, 39], [42, 44], [38, 39]),
    oval(72, 8, 16, 16, "yellow"),
    line([4, 86], [96, 86]),
  ],
  house: () => [
    poly("orange", [24, 50], [76, 50], [76, 90], [24, 90]),
    poly("pink", [16, 52], [50, 20], [84, 52]),
    poly("white", [44, 66], [56, 66], [56, 90], [44, 90]),
    poly("blue", [60, 58], [70, 58], [70, 68], [60, 68]),
    poly("blue", [30, 58], [40, 58], [40, 68], [30, 68]),
  ],
  laptop: () => [poly("blue", [22, 24], [78, 24], [78, 64], [22, 64]), poly("white", [10, 64], [90, 64], [96, 76], [4, 76]), ink([44, 70], [56, 70])],
  plane: () => [
    poly("white", [48, 8], [52, 8], [56, 22], [56, 78], [50, 92], [44, 78], [44, 22]),
    poly("blue", [44, 38], [8, 58], [8, 64], [44, 54]),
    poly("blue", [56, 38], [92, 58], [92, 64], [56, 54]),
    poly("blue", [44, 76], [32, 86], [32, 90], [50, 86], [68, 90], [68, 86], [56, 76]),
  ],
  chart: () => [
    line([10, 8], [10, 90], [94, 90]),
    poly("blue", [20, 60], [32, 60], [32, 90], [20, 90]),
    poly("green", [42, 44], [54, 44], [54, 90], [42, 90]),
    poly("yellow", [64, 26], [76, 26], [76, 90], [64, 90]),
    line([16, 54], [38, 38], [60, 28], [86, 10]),
  ],
  tree: () => [poly("orange", [45, 58], [55, 58], [55, 92], [45, 92]), oval(18, 8, 64, 58, "green")],
  sun: () => [oval(30, 30, 40, 40, "yellow"), ...ring(50, 50, 8, () => 0).map((_, i) => line(ring(50, 50, 8, () => 27)[i]!, ring(50, 50, 8, () => 42)[i]!))],
  cloud: () => [{ k: "poly", pts: outlineFor("cloud", 92, 56).fills[0]!.map(([x, y]) => [x + 4, y + 22] as P), close: true, fill: "white" }],
  car: () => [
    poly("pink", [6, 62], [18, 46], [34, 36], [66, 36], [80, 48], [94, 52], [94, 72], [6, 72]),
    poly("blue", [36, 41], [62, 41], [72, 49], [28, 49]),
    oval(16, 62, 18, 18, "white"),
    oval(66, 62, 18, 18, "white"),
  ],
  phone: () => [poly("white", [30, 6], [70, 6], [70, 94], [30, 94]), poly("blue", [34, 14], [66, 14], [66, 80], [34, 80]), oval(46, 84, 8, 7, null, true)],
  rocket: () => [
    poly("white", [50, 4], [62, 24], [62, 70], [38, 70], [38, 24]),
    poly("pink", [38, 52], [24, 74], [38, 70]),
    poly("pink", [62, 52], [76, 74], [62, 70]),
    oval(44, 28, 12, 12, "blue"),
    poly("orange", [42, 70], [50, 94], [58, 70]),
  ],
  lightbulb: () => [oval(26, 6, 48, 50, "yellow"), poly("white", [38, 54], [62, 54], [60, 72], [40, 72]), line([40, 80], [60, 80]), line([43, 87], [57, 87])],
  book: () => [
    poly("blue", [6, 24], [50, 32], [50, 86], [6, 78]),
    poly("purple", [50, 32], [94, 24], [94, 78], [50, 86]),
    ink([14, 40], [42, 45]),
    ink([14, 52], [42, 57]),
    ink([58, 45], [86, 40]),
    ink([58, 57], [86, 52]),
  ],
  coffee: () => [
    poly("orange", [22, 36], [68, 36], [63, 86], [27, 86]),
    oval(60, 46, 22, 26),
    line([34, 28], [37, 18], [34, 8]),
    line([46, 28], [49, 18], [46, 8]),
    line([58, 28], [61, 18], [58, 8]),
  ],
  globe: () => [oval(10, 10, 80, 80, "blue"), oval(32, 10, 36, 80, null, true), ink([10, 50], [90, 50]), ink([17, 30], [83, 30]), ink([17, 70], [83, 70])],
  gear: () => [
    { k: "poly", pts: ring(50, 50, 32, (i) => (Math.floor(i / 2) % 2 === 0 ? 45 : 34)), close: true, fill: "purple" },
    oval(37, 37, 26, 26, null, true),
  ],
  star: () => [{ k: "poly", pts: ring(50, 54, 10, (i) => (i % 2 === 0 ? 46 : 19)), close: true, fill: "yellow" }],
  heart: () => {
    const pts: P[] = [];
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([Math.round((50 + x * 2.6) * 10) / 10, Math.round((46 - y * 2.6) * 10) / 10]);
    }
    return [{ k: "poly", pts, close: true, fill: "pink" }];
  },
  flag: () => [line([20, 94], [20, 6]), poly("green", [20, 8], [80, 16], [66, 30], [80, 44], [20, 42])],
  clock: () => [oval(10, 10, 80, 80, "blue"), line([50, 50], [50, 22]), line([50, 50], [70, 60])],
  envelope: () => [poly("yellow", [8, 24], [92, 24], [92, 78], [8, 78]), ink([8, 24], [50, 56], [92, 24])],
  calendar: () => [
    poly("white", [12, 18], [88, 18], [88, 88], [12, 88]),
    poly("pink", [12, 18], [88, 18], [88, 36], [12, 36]),
    ...[0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => oval(20 + c * 17, 44 + r * 14, 8, 8, null, true))),
  ],
  target: () => [oval(8, 8, 84, 84, "pink"), oval(22, 22, 56, 56, "white"), oval(36, 36, 28, 28, "pink")],
  trophy: () => [
    oval(10, 14, 22, 24),
    oval(68, 14, 22, 24),
    poly("yellow", [26, 10], [74, 10], [70, 44], [58, 56], [42, 56], [30, 44]),
    poly("yellow", [46, 56], [54, 56], [54, 74], [46, 74]),
    poly("orange", [32, 74], [68, 74], [68, 88], [32, 88]),
  ],
  lock: () => [oval(30, 8, 40, 50), poly("yellow", [22, 42], [78, 42], [78, 90], [22, 90]), oval(45, 56, 10, 10, null, true), ink([50, 66], [50, 76])],
  pin: () => [{ k: "poly", pts: [...ring(50, 38, 20, () => 28, 150).slice(0, 14), [50, 94]], close: true, fill: "pink" }, oval(39, 27, 22, 22, "white")],
  coin: () => [oval(14, 14, 72, 72, "yellow"), oval(25, 25, 50, 50, null, true)],
  server: () =>
    [0, 1, 2].flatMap((i) => [poly("blue", [16, 10 + i * 28], [84, 10 + i * 28], [84, 32 + i * 28], [16, 32 + i * 28]), oval(70, 18 + i * 28, 6, 6, "green")]),
  database: () => {
    const o = outlineFor("database", 70, 88);
    return [
      { k: "poly", pts: o.fills[0]!.map(([x, y]) => [x + 15, y + 6] as P), close: true, fill: "blue" },
      { k: "poly", pts: o.details[0]!.map(([x, y]) => [x + 15, y + 6] as P), ink: true },
    ];
  },
  boat: () => [line([50, 8], [50, 62]), poly("white", [50, 10], [50, 58], [20, 58]), poly("orange", [8, 62], [92, 62], [78, 84], [22, 84])],
  train: () => [
    poly("blue", [12, 26], [88, 26], [88, 74], [12, 74]),
    poly("white", [20, 34], [42, 34], [42, 52], [20, 52]),
    poly("white", [58, 34], [80, 34], [80, 52], [58, 52]),
    oval(20, 70, 16, 16, "white"),
    oval(64, 70, 16, 16, "white"),
    line([4, 88], [96, 88]),
  ],
  building: () => [
    poly("purple", [20, 14], [60, 14], [60, 92], [20, 92]),
    poly("blue", [60, 40], [86, 40], [86, 92], [60, 92]),
    ...[0, 1, 2, 3].flatMap((r) =>
      [0, 1].map((c) => poly("yellow", [28 + c * 16, 22 + r * 16], [36 + c * 16, 22 + r * 16], [36 + c * 16, 30 + r * 16], [28 + c * 16, 30 + r * 16])),
    ),
  ],
  plant: () => [
    poly("orange", [32, 66], [68, 66], [62, 94], [38, 94]),
    poly("green", [50, 66], [30, 34], [22, 18], [44, 32]),
    poly("green", [50, 66], [72, 30], [82, 16], [58, 34]),
    line([50, 66], [50, 26]),
  ],
};

const ALIASES: Record<string, string> = {
  mountains: "mountain",
  hill: "mountain",
  peak: "mountain",
  home: "house",
  cabin: "house",
  computer: "laptop",
  notebook: "laptop",
  airplane: "plane",
  aeroplane: "plane",
  flight: "plane",
  jet: "plane",
  graph: "chart",
  "bar chart": "chart",
  growth: "chart",
  analytics: "chart",
  forest: "tree",
  sunshine: "sun",
  weather: "cloud",
  automobile: "car",
  vehicle: "car",
  mobile: "phone",
  smartphone: "phone",
  launch: "rocket",
  idea: "lightbulb",
  bulb: "lightbulb",
  light: "lightbulb",
  reading: "book",
  docs: "book",
  cup: "coffee",
  mug: "coffee",
  tea: "coffee",
  world: "globe",
  earth: "globe",
  international: "globe",
  settings: "gear",
  cog: "gear",
  favorite: "star",
  rating: "star",
  love: "heart",
  like: "heart",
  milestone: "flag",
  goal: "flag",
  time: "clock",
  deadline: "clock",
  mail: "envelope",
  email: "envelope",
  letter: "envelope",
  schedule: "calendar",
  date: "calendar",
  bullseye: "target",
  aim: "target",
  award: "trophy",
  prize: "trophy",
  win: "trophy",
  winner: "trophy",
  security: "lock",
  padlock: "lock",
  privacy: "lock",
  location: "pin",
  map: "pin",
  place: "pin",
  money: "coin",
  cost: "coin",
  price: "coin",
  budget: "coin",
  servers: "server",
  infrastructure: "server",
  cloud_server: "server",
  data: "database",
  storage: "database",
  ship: "boat",
  sailboat: "boat",
  railway: "train",
  office: "building",
  city: "building",
  company: "building",
  flower: "plant",
  leaf: "plant",
  garden: "plant",
};

const PEOPLE =
  /\b(people|person|persons|human|humans|man|men|woman|women|boy|boys|girl|girls|child|children|kid|kids|baby|babies|face|faces|portrait|selfie|crowd|team|family|character|someone|somebody|myself|yourself|self[- ]portrait|figure|stick ?figure|avatar|head|body|couple|customer|user|users|employee|worker|doctor|teacher|student)\b/i;

export const ILLUSTRATION_SUBJECTS = Object.keys(DRAWINGS);

export const PEOPLE_REFUSAL =
  'I don\'t draw people or faces. I can add a person icon block instead (add_shapes with shape "person"), or draw a related object.';

/** Resolves a requested subject to a drawing name; "people" for people/faces; null when nothing matches. */
export function resolveSubject(subject: string): string | "people" | null {
  const s = subject.toLowerCase().trim();
  if (PEOPLE.test(s)) return "people";
  if (DRAWINGS[s]) return s;
  if (ALIASES[s]) return ALIASES[s]!;
  for (const word of s.split(/[^a-z_]+/).filter(Boolean)) {
    const w = word.replace(/s$/, "");
    if (DRAWINGS[word]) return word;
    if (DRAWINGS[w]) return w;
    if (ALIASES[word]) return ALIASES[word]!;
    if (ALIASES[w]) return ALIASES[w]!;
  }
  return null;
}

const SIZES = { small: 140, medium: 220, large: 340 } as const;

/**
 * Draws an illustration at (x, y). Returns the grouped elements (primary first) or null for an unknown subject.
 * Marker style: light hand-drawn strokes with hatched color fills; clean: solid fills, no roughness.
 */
export function buildIllustration(
  ctx: BuildCtx,
  name: string,
  x: number,
  y: number,
  opts: { style?: "marker" | "clean"; size?: keyof typeof SIZES; ref?: string; frameId?: string | null } = {},
): SceneElement[] | null {
  const draw = DRAWINGS[name];
  if (!draw) return null;
  const marker = opts.style !== "clean";
  const s = SIZES[opts.size ?? "medium"] / 100;
  const groupId = newId();
  const light = DARK_PALETTE.DEFAULT_STROKE;
  const dark = DARK_PALETTE.TEXT_ON_FILL;
  const els: SceneElement[] = [];
  draw().forEach((p, i) => {
    const fill = p.fill ? DARK_PALETTE.FILLS[p.fill] : "transparent";
    const stroke = p.ink ? dark : marker || !p.fill ? light : fill;
    const custom = ctx.mark({ aiKind: "illustration", illustration: name, ...(i === 0 && opts.ref ? { ref: opts.ref } : {}) });
    const common = {
      strokeColor: stroke,
      backgroundColor: fill,
      fillStyle: (marker ? "hachure" : "solid") as "hachure" | "solid",
      strokeWidth: marker ? 2 : p.ink ? 1 : 2,
      roughness: marker ? 2 : 0,
      groupIds: [groupId],
      frameId: opts.frameId ?? null,
      customData: custom,
    };
    if (p.k === "oval") {
      const [el] = makeShape({ ...common, shape: "ellipse", x: x + p.x * s, y: y + p.y * s, width: p.w * s, height: p.h * s, rounded: false });
      els.push(el!);
      return;
    }
    const pts = (p.close ? [...p.pts, p.pts[0]!] : p.pts).map(([px, py]) => [Math.round(px * s * 10) / 10, Math.round(py * s * 10) / 10] as P);
    const el = makeLine({ ...common, x, y, points: pts });
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    el.width = Math.max(...xs) - Math.min(...xs);
    el.height = Math.max(...ys) - Math.min(...ys);
    els.push(el);
  });
  return els;
}
