// Board templates for the library's "Start new" row. Each one builds a real, editable board from the
// board-protocol element factories; the AI can then build on it like any other board.
import { PALETTE, makeArrow, makeLine, makeShape, makeSticky, type SceneElement } from "@monet/board-protocol";
import { finalize, heading, hint, section } from "./helpers";
import { thumbnailDataUrl } from "./thumbnail";

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  description: string;
  /** Title given to boards created from this template. */
  boardTitle: string;
}

export const TEMPLATE_IDS = ["retrospective", "launch-plan", "decision-matrix", "process-map", "brainstorm", "weekly-planning"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

const LIGHT_LINE = "#ced4da";
const WHITE = "#ffffff";

// ---------- Retrospective ----------
function retrospective(): SceneElement[] {
  const cols = [
    {
      name: "Went well",
      prompt: "What helped us this sprint?",
      color: PALETTE.stickyGreen,
      notes: ["Beta shipped on time", "Pairing on the API saved days", "Customer calls every week"],
    },
    {
      name: "To improve",
      prompt: "What slowed us down?",
      color: PALETTE.stickyPink,
      notes: ["Too many meetings on Thursdays", "Flaky tests slowed reviews", "Specs changed late"],
    },
    {
      name: "Action items",
      prompt: "Who does what, by when?",
      color: PALETTE.stickyBlue,
      notes: ["Fix flaky tests (Sam, Friday)", "Try a no-meeting Thursday (Priya)", "Lock specs before sprint start (Alex)"],
    },
  ];
  const out: SceneElement[] = [
    heading("Team retrospective", 0, -150),
    hint("Everyone adds stickies to each column. Then ask the AI to group them by theme and draft action items for each person.", 0, -92),
  ];
  cols.forEach((col, i) => {
    const x = i * 680;
    out.push(
      ...section(col.name, { x, y: 0, width: 620, height: 680 }, () => {
        const items: SceneElement[] = [hint(col.prompt, x + 30, 30)];
        col.notes.forEach((text, j) => {
          items.push(...makeSticky({ text, color: col.color, x: x + 30 + (j % 3) * 190, y: 80 + Math.floor(j / 3) * 200 }));
        });
        return items;
      }),
    );
  });
  return out;
}

// ---------- Product launch plan (timeline lanes) ----------
function launchPlan(): SceneElement[] {
  const weekW = 200;
  const left = 240;
  const weeks = 8;
  const laneH = 200;
  const laneGap = 20;
  const top = 100;
  const lanes = [
    {
      name: "Product",
      color: PALETTE.stickyBlue,
      tasks: [
        { text: "Beta feedback round", week: 0, span: 2 },
        { text: "Fix top beta issues", week: 2, span: 2 },
        { text: "Release candidate", week: 4, span: 2 },
      ],
    },
    {
      name: "Marketing",
      color: PALETTE.stickyPink,
      tasks: [
        { text: "Positioning + messaging", week: 1, span: 2 },
        { text: "Launch blog + press kit", week: 4, span: 2 },
        { text: "Launch-day social", week: 6, span: 1 },
      ],
    },
    {
      name: "Sales",
      color: PALETTE.stickyGreen,
      tasks: [
        { text: "Pricing sign-off", week: 2, span: 2 },
        { text: "Sales enablement", week: 4, span: 2 },
      ],
    },
    {
      name: "Support",
      color: PALETTE.stickyOrange,
      tasks: [
        { text: "Help center docs", week: 3, span: 2 },
        { text: "Launch-day rota", week: 6, span: 2 },
      ],
    },
  ];
  const lanesBottom = top + lanes.length * (laneH + laneGap) - laneGap;
  const launchX = left + 7 * weekW;
  const width = left + weeks * weekW + 40;
  const height = lanesBottom + 140;

  const out: SceneElement[] = [
    heading("Product launch plan", 0, -150),
    hint("Drag cards along the timeline. Ask the AI to add owners and dates, or to find what's missing.", 0, -92),
  ];
  out.push(
    ...section("Launch timeline", { x: 0, y: 0, width, height }, () => {
      const items: SceneElement[] = [];
      for (let w = 0; w < weeks; w++) {
        items.push(hint(`Week ${w + 1}`, left + w * weekW + 60, 36, 18));
      }
      items.push(
        makeLine({
          x: left,
          y: 80,
          points: [
            [0, 0],
            [weeks * weekW, 0],
          ],
          strokeColor: LIGHT_LINE,
          roughness: 0,
        }),
      );
      lanes.forEach((lane, i) => {
        const y = top + i * (laneH + laneGap);
        items.push(
          ...makeShape({ x: 20, y, width: 200, height: laneH, label: lane.name, backgroundColor: lane.color, roughness: 0, fontSize: 22 }),
          ...makeShape({ x: left, y, width: weeks * weekW, height: laneH, backgroundColor: PALETTE.sectionFill, strokeColor: LIGHT_LINE, roughness: 0 }),
        );
      });
      // Launch-day marker sits under the cards.
      items.push(
        makeLine({
          x: launchX,
          y: 80,
          points: [
            [0, 0],
            [0, lanesBottom - 80 + 30],
          ],
          strokeColor: PALETTE.suggestion,
          strokeStyle: "dashed",
          strokeWidth: 2,
          roughness: 0,
        }),
        ...makeShape({
          shape: "diamond",
          x: launchX - 90,
          y: lanesBottom + 30,
          width: 180,
          height: 96,
          label: "Launch day",
          backgroundColor: PALETTE.stickyPurple,
          roughness: 0,
          fontSize: 18,
        }),
      );
      lanes.forEach((lane, i) => {
        const y = top + i * (laneH + laneGap);
        lane.tasks.forEach((t, j) => {
          items.push(
            ...makeShape({
              x: left + t.week * weekW + 10,
              y: y + (j % 2 === 0 ? 30 : 100),
              width: t.span * weekW - 20,
              height: 70,
              label: t.text,
              backgroundColor: lane.color,
              roughness: 0,
              fontSize: 18,
            }),
          );
        });
      });
      return items;
    }),
  );
  return out;
}

// ---------- Decision matrix (options x criteria) ----------
function decisionMatrix(): SceneElement[] {
  const criteria = ["Cost", "Time to ship", "Risk", "Strategic fit"];
  const options = [
    { name: "A: Build in-house", scores: [2, 2, 3, 5] },
    { name: "B: Buy a vendor tool", scores: [3, 5, 4, 3] },
    { name: "C: Partner", scores: [4, 3, 2, 3] },
  ];
  const x0 = 30;
  const y0 = 70;
  const firstW = 280;
  const colW = 200;
  const totalW = 180;
  const headH = 90;
  const rowH = 110;
  const tableW = firstW + criteria.length * colW + totalW;
  const tableBottom = y0 + headH + options.length * rowH;
  const width = x0 * 2 + tableW;
  const height = tableBottom + 190;

  const out: SceneElement[] = [
    heading("Decision matrix", 0, -150),
    hint("Score each option from 1 (poor) to 5 (great). Ask the AI for pros and cons, or for criteria you missed.", 0, -92),
  ];
  out.push(
    ...section("Options × criteria", { x: 0, y: 0, width, height }, () => {
      const items: SceneElement[] = [hint("Higher is better for every criterion", x0, 28, 16)];
      const cell = (x: number, y: number, w: number, h: number, label: string, bg: string, fontSize = 20) =>
        makeShape({ x, y, width: w, height: h, label, backgroundColor: bg, roughness: 0, rounded: false, fontSize });
      items.push(...cell(x0, y0, firstW, headH, "Option", PALETTE.sectionFill));
      criteria.forEach((c, i) => items.push(...cell(x0 + firstW + i * colW, y0, colW, headH, c, PALETTE.stickyBlue)));
      items.push(...cell(x0 + firstW + criteria.length * colW, y0, totalW, headH, "Total", PALETTE.stickyGreen));
      options.forEach((o, r) => {
        const y = y0 + headH + r * rowH;
        items.push(...cell(x0, y, firstW, rowH, o.name, PALETTE.stickyYellow, 18));
        o.scores.forEach((s, i) => items.push(...cell(x0 + firstW + i * colW, y, colW, rowH, String(s), WHITE, 28)));
        const total = o.scores.reduce((a, b) => a + b, 0);
        items.push(...cell(x0 + firstW + criteria.length * colW, y, totalW, rowH, String(total), PALETTE.stickyGreen, 28));
      });
      items.push(
        ...makeShape({
          x: x0,
          y: tableBottom + 40,
          width: tableW,
          height: 110,
          label: "Decision: …    Why: …    Owner: …",
          backgroundColor: PALETTE.stickyPurple,
          roughness: 0,
          fontSize: 20,
          textAlign: "left",
        }),
      );
      return items;
    }),
  );
  return out;
}

// ---------- Process map (flow with connectors) ----------
function processMap(): SceneElement[] {
  const out: SceneElement[] = [
    heading("Process map", 0, -150),
    hint("Rename steps, add branches, and drag connectors. Ask the AI what's missing between two steps.", 0, -92),
  ];
  out.push(
    ...section("Request flow", { x: 0, y: 0, width: 1720, height: 640 }, () => {
      const node = (opts: Parameters<typeof makeShape>[0]) => makeShape({ roughness: 0, fontSize: 20, width: 200, height: 100, ...opts });
      const [start, startLabel] = node({ shape: "ellipse", x: 40, y: 150, label: "Request comes in", backgroundColor: PALETTE.stickyGreen });
      const [triage, triageLabel] = node({ x: 320, y: 150, label: "Triage and size it", backgroundColor: PALETTE.stickyBlue });
      const [decide, decideLabel] = node({ shape: "diamond", x: 600, y: 125, height: 150, label: "Approved?", backgroundColor: PALETTE.stickyYellow });
      const [work, workLabel] = node({ x: 880, y: 150, label: "Do the work", backgroundColor: PALETTE.stickyBlue });
      const [review, reviewLabel] = node({ x: 1160, y: 150, label: "Review and QA", backgroundColor: PALETTE.stickyBlue });
      const [done, doneLabel] = node({ shape: "ellipse", x: 1440, y: 150, label: "Shipped", backgroundColor: PALETTE.stickyGreen });
      const [reject, rejectLabel] = node({ x: 600, y: 430, label: "Send back with notes", backgroundColor: PALETTE.stickyPink });
      const shapes = [
        start!,
        startLabel!,
        triage!,
        triageLabel!,
        decide!,
        decideLabel!,
        work!,
        workLabel!,
        review!,
        reviewLabel!,
        done!,
        doneLabel!,
        reject!,
        rejectLabel!,
      ];
      const arrows = [
        ...makeArrow({ x: 0, y: 0, from: start, to: triage }),
        ...makeArrow({ x: 0, y: 0, from: triage, to: decide }),
        ...makeArrow({ x: 0, y: 0, from: decide, to: work, label: "Yes" }),
        ...makeArrow({ x: 0, y: 0, from: work, to: review }),
        ...makeArrow({ x: 0, y: 0, from: review, to: done }),
        ...makeArrow({ x: 0, y: 0, from: decide, to: reject, label: "No" }),
        ...makeArrow({ x: 0, y: 0, from: reject, to: start, strokeStyle: "dashed" }),
      ];
      const note = makeSticky({ text: "Where do requests get stuck? Ask the AI.", color: PALETTE.stickyYellow, x: 1180, y: 400, size: 180 });
      return [...shapes, ...arrows, ...note];
    }),
  );
  return out;
}

// ---------- Brainstorm (central topic + clusters) ----------
function brainstorm(): SceneElement[] {
  const out: SceneElement[] = [
    heading("Brainstorm", -700, -860),
    hint("Add ideas as stickies next to the closest cluster. Ask the AI to regroup them by theme or suggest more.", -700, -800),
  ];
  const [topic, topicLabel] = makeShape({
    shape: "ellipse",
    x: -180,
    y: -90,
    width: 360,
    height: 180,
    label: "Grow weekly active users",
    backgroundColor: PALETTE.stickyPurple,
    roughness: 0,
    fontSize: 26,
  });
  out.push(topic!, topicLabel!);
  const clusters = [
    { name: "Ideas", x: -640, y: -420, color: PALETTE.stickyYellow, notes: ["Referral rewards", "Self-serve onboarding"], above: true },
    { name: "Questions", x: 420, y: -420, color: PALETTE.stickyBlue, notes: ["Who should we focus on first?", "What does success look like?"], above: true },
    { name: "Risks", x: -640, y: 340, color: PALETTE.stickyPink, notes: ["Not enough eng time", "No clear owner"], above: false },
    { name: "Next steps", x: 420, y: 340, color: PALETTE.stickyGreen, notes: ["Talk to 5 customers", "Pick a pilot team"], above: false },
  ];
  for (const c of clusters) {
    const [chip, chipLabel] = makeShape({
      x: c.x,
      y: c.y,
      width: 220,
      height: 80,
      label: c.name,
      backgroundColor: WHITE,
      strokeWidth: 2,
      roughness: 0,
      fontSize: 24,
    });
    out.push(chip!, chipLabel!);
    const cx = c.x + 110;
    c.notes.forEach((text, i) => {
      out.push(...makeSticky({ text, color: c.color, size: 170, x: cx - 180 + i * 190, y: c.above ? c.y - 210 : c.y + 120 }));
    });
    out.push(...makeArrow({ x: 0, y: 0, from: topic, to: chip }));
  }
  return out;
}

// ---------- Weekly planning ----------
function weeklyPlanning(): SceneElement[] {
  const days = [
    { name: "Monday", note: "Team standup + plan the week" },
    { name: "Tuesday", note: "Design review, 2pm" },
    { name: "Wednesday", note: null },
    { name: "Thursday", note: "Customer demo" },
    { name: "Friday", note: "Write the weekly update" },
  ];
  const dayW = 300;
  const gap = 20;
  const colH = 680;
  const dayX0 = 480;
  const fullW = dayX0 + days.length * (dayW + gap) - gap;
  const out: SceneElement[] = [
    heading("Weekly planning", 0, -150),
    hint("Drop tasks into days. Ask the AI to balance the week or turn your priorities into a timeline.", 0, -92),
  ];
  out.push(
    ...section("Top 3 this week", { x: 0, y: 0, width: 440, height: colH }, () => [
      hint("If only three things get done…", 30, 30),
      ...makeSticky({ text: "1. Ship the onboarding fix", color: PALETTE.stickyYellow, x: 30, y: 80, width: 380, height: 150 }),
      ...makeSticky({ text: "2. Prep Thursday's demo", color: PALETTE.stickyYellow, x: 30, y: 250, width: 380, height: 150 }),
      ...makeSticky({ text: "3. Two hiring interviews", color: PALETTE.stickyYellow, x: 30, y: 420, width: 380, height: 150 }),
    ]),
  );
  days.forEach((d, i) => {
    const x = dayX0 + i * (dayW + gap);
    out.push(
      ...section(d.name, { x, y: 0, width: dayW, height: colH }, () =>
        d.note
          ? makeSticky({ text: d.note, color: PALETTE.stickyBlue, x: x + 30, y: 40, width: dayW - 60, height: 140 })
          : [hint("Open. Protect it for deep work?", x + 30, 40, 16)],
      ),
    );
  });
  out.push(
    ...section("Parking lot", { x: 0, y: colH + 60, width: fullW, height: 260 }, () => [
      hint("Ideas and tasks that can wait", 30, colH + 90),
      ...makeSticky({ text: "Refresh the team wiki", color: PALETTE.stickyOrange, x: 30, y: colH + 130, width: 260, height: 150 }),
    ]),
  );
  return out;
}

const BUILDERS: Record<TemplateId, { info: Omit<TemplateInfo, "id">; build: () => SceneElement[] }> = {
  retrospective: {
    info: { name: "Retrospective", description: "Went well, to improve, and action items.", boardTitle: "Team retrospective" },
    build: retrospective,
  },
  "launch-plan": {
    info: { name: "Product launch plan", description: "Timeline lanes for each team, up to launch day.", boardTitle: "Product launch plan" },
    build: launchPlan,
  },
  "decision-matrix": {
    info: { name: "Decision matrix", description: "Score options against the criteria that matter.", boardTitle: "Decision matrix" },
    build: decisionMatrix,
  },
  "process-map": {
    info: { name: "Process map", description: "Steps, decisions, and connectors from start to done.", boardTitle: "Process map" },
    build: processMap,
  },
  brainstorm: {
    info: { name: "Brainstorm", description: "A central topic with clusters of ideas around it.", boardTitle: "Brainstorm" },
    build: brainstorm,
  },
  "weekly-planning": {
    info: { name: "Weekly planning", description: "Top priorities, a column per day, and a parking lot.", boardTitle: "Weekly planning" },
    build: weeklyPlanning,
  },
};

export function listTemplates(): TemplateInfo[] {
  return TEMPLATE_IDS.map((id) => ({ id, ...BUILDERS[id].info }));
}

export function isTemplateId(v: unknown): v is TemplateId {
  return typeof v === "string" && (TEMPLATE_IDS as readonly string[]).includes(v);
}

/** Fresh elements for a new board from the template (new ids every call). */
export function buildTemplate(id: TemplateId): { title: string; elements: SceneElement[]; thumbnail: string } {
  const t = BUILDERS[id];
  const elements = finalize(t.build(), id);
  return { title: t.info.boardTitle, elements, thumbnail: thumbnailDataUrl(elements) };
}
