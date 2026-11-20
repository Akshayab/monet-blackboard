// Scripted scenarios for the board AI's test mode (AI_MOCK=1, see mock.ts; never in production). Prompts that
// start with "[dev-script:<name>]" run these canned tool calls instead of calling the AI, so the tools, layout
// engine, live streaming, and limits can be exercised (and screenshotted) without AI access.
import { sleepUnlessStopped, throwIfStopped } from "./runs";
import { isMockAi } from "./mock";
import type { ModelCaller, ModelReply, ModelRequest, ToolUse } from "./types";

export const DEV_SCRIPT_RE = /^\s*\[dev-script:([a-z0-9-]+)\]/i;
/**
 * "[dev-tools] <json>" runs exact tool calls (deterministic tests): the JSON is either one turn,
 * [{ "tool": "add_stickies", "input": {...} }, ...], or several turns, [[...], [...]]. A reply is added if missing.
 * Handles from the board summary (e1, s2, k1...) and refs from earlier turns work as usual.
 */
export const DEV_TOOLS_RE = /^\s*\[dev-tools\]\s*([\s\S]+)$/i;

export function devScriptsEnabled(): boolean {
  return isMockAi();
}

type Line = Record<string, unknown>;

interface ScriptState {
  turn: number;
  lines: Line[];
  results: unknown[];
}

type Step = (s: ScriptState) => { tool: string; input: Record<string, unknown> }[];

function boardLines(req: ModelRequest): Line[] {
  const first = req.messages[0];
  if (!first || typeof first.content === "string") return [];
  const text = first.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const out: Line[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as Line);
    } catch {
      /* not a board line */
    }
  }
  return out;
}

const reply = (message: string) => [{ tool: "reply", input: { message } }];
const ofKind = (s: ScriptState, kind: string) => s.lines.filter((l) => l.kind === kind);

const SCRIPTS: Record<string, Step[]> = {
  "brain-dump": [
    () => [
      {
        tool: "add_sections",
        input: {
          sections: [
            {
              name: "Goals",
              ref: "goals",
              items: [{ text: "Launch the mobile app by spring", ref: "g1" }, { text: "1,000 paying customers in Q1" }, { text: "Keep churn under 3%" }],
            },
            {
              name: "Workstreams",
              ref: "work",
              layout: "flow",
              items: [
                { text: "Finish onboarding redesign", ref: "w1" },
                { text: "Beta with 50 customers", ref: "w2" },
                { text: "Pricing page + billing", ref: "w3" },
                { text: "Launch campaign", ref: "w4" },
              ],
            },
            {
              name: "Risks",
              ref: "risks",
              items: [
                { text: "App store review delays", ref: "r1" },
                { text: "Only one iOS engineer" },
                { text: "Billing migration is untested" },
                { text: "Competitor launching in March" },
              ],
            },
          ],
          connections: [
            { from: "g1", to: "w1", label: "drives" },
            { from: "r1", to: "w4", dashed: true },
          ],
        },
      },
    ],
    () => [
      {
        tool: "add_timeline",
        input: {
          title: "Launch timeline",
          milestones: [
            { label: "Onboarding redesign done", date: "2026-11-27", owner: "Maya" },
            { label: "Beta starts", date: "2026-12-07", end_date: "2026-12-28", owner: "Leo" },
            { label: "Pricing live", date: "2027-01-08", owner: "Sam" },
            { label: "App store submission", date: "2027-01-15", owner: "Leo" },
            { label: "Launch campaign", date: "2027-02-02", owner: "Maya" },
          ],
        },
      },
    ],
    () =>
      reply(
        "I grouped your brain dump into Goals, Workstreams, and Risks, connected the dependencies, and added a launch timeline with owners. The dates are assumptions — adjust them on the board.",
      ),
  ],
  timeline: [
    (s) => {
      const items = s.lines.filter((l) => l.kind === "sticky").slice(0, 6);
      const owners = ["Maya", "Leo", "Sam"];
      return [
        {
          tool: "add_timeline",
          input: {
            title: "Plan timeline",
            milestones: items.map((it, i) => ({
              label: String(it.text ?? `Step ${i + 1}`).slice(0, 60),
              date: new Date(Date.UTC(2026, 10, 16 + i * 9)).toISOString().slice(0, 10),
              owner: owners[i % owners.length],
            })),
          },
        },
      ];
    },
    () => reply("I turned the plan into a timeline with owners and dates (dates are assumptions)."),
  ],
  flow: [
    () => [
      {
        tool: "add_shapes",
        input: {
          layout: "flow",
          shapes: [
            { text: "User signs up", shape: "ellipse", ref: "f1" },
            { text: "Verify email", ref: "f2" },
            { text: "Has a team invite?", shape: "diamond", ref: "f3" },
            { text: "Join team workspace", ref: "f4" },
            { text: "Hand off to onboarding", shape: "parallelogram", color: "yellow", ref: "f6" },
          ],
        },
      },
      { tool: "add_shapes", input: { shapes: [{ text: "Create personal workspace", ref: "f5", color: "green" }], near: "f3", side: "below" } },
    ],
    () => [{ tool: "connect", input: { connections: [{ from: "f3", to: "f5", label: "no" }] } }],
    () => reply("Here's the sign-up flow with the invite decision branching into two paths."),
  ],
  itinerary: [
    () => [
      { tool: "add_text", input: { text: "Kyoto weekend", size: "heading", subtitle: "3 days · 2 people · ~$1,900", ref: "head" } },
      {
        tool: "add_shapes",
        input: {
          layout: "flow",
          connect_in_order: true,
          columns: 5,
          near: "head",
          side: "below",
          shapes: [
            { text: "Fly into Osaka\nKIX, evening", shape: "parallelogram", color: "yellow", ref: "d0" },
            { text: "Day 1 · Higashiyama\nKiyomizu-dera, Gion walk", color: "pink", ref: "d1" },
            { text: "Day 2 · Arashiyama\nBamboo grove, river boat", color: "green", ref: "d2" },
            { text: "Train to Nara\n45 min, JR line", shape: "parallelogram", color: "yellow", ref: "t1" },
            { text: "Day 3 · Nara\nDeer park, Todai-ji", color: "blue", ref: "d3" },
          ],
        },
      },
    ],
    () => [
      {
        tool: "add_table",
        input: {
          title: "Budget",
          columns: ["Category", "Estimate"],
          rows: [
            ["Flights", "$1,100"],
            ["Ryokan (2 nights)", "$520"],
            ["Food", "$180"],
            ["Trains & transit", "$60"],
            ["Total", "$1,860"],
          ],
          ref: "budget",
          near: "d1",
          side: "below",
        },
      },
    ],
    () => reply("I laid out the weekend day by day with travel steps between the days, and added a budget table. Prices are estimates."),
  ],
  // Many small batches with pauses between turns (used to test stopping a run part-way).
  long: [
    ...Array.from({ length: 8 }, (_, k) => () => [
      { tool: "add_stickies", input: { layout: "row", stickies: Array.from({ length: 6 }, (_, i) => ({ text: `Batch ${k + 1} idea ${i + 1}` })) } },
    ]),
    () => reply("Added eight batches of ideas."),
  ],
  table: [
    () => [
      {
        tool: "add_table",
        input: {
          title: "Hosting options",
          columns: ["Option", "Monthly cost", "Setup"],
          rows: [
            ["Managed", "$40", "Minutes"],
            ["Self-hosted", "$12", "A day"],
          ],
          ref: "opts",
        },
      },
    ],
    () => [
      {
        tool: "update_elements",
        input: {
          updates: [
            {
              id: "opts",
              table: {
                rows: [
                  ["Managed", "$40", "Minutes"],
                  ["Self-hosted", "$12", "A day"],
                  ["Serverless", "$25", "An hour"],
                ],
              },
            },
          ],
        },
      },
    ],
    () => reply("I compared the hosting options in a table and added a serverless row."),
  ],
  explainer: [
    () => [
      { tool: "add_text", input: { text: "Q3 product health", size: "title", ref: "title" } },
      {
        tool: "add_stat_cards",
        input: {
          near: "title",
          side: "below",
          cards: [
            { value: "12.4k", label: "Weekly active teams", delta: "+18% vs Q2", trend: "up" },
            { value: "3.1%", label: "Monthly churn", delta: "-0.6 pts", trend: "up", color: "green" },
            { value: "$84k", label: "New MRR", delta: "+9%", color: "purple" },
            { value: "41 min", label: "Median time to first board", delta: "+5 min", trend: "down", color: "red" },
          ],
        },
      },
    ],
    () => [
      {
        tool: "add_chart",
        input: {
          title: "Weekly active teams (k)",
          kind: "bar",
          labels: ["Jul", "Aug", "Sep"],
          series: [
            { name: "2025", values: [7.2, 7.9, 8.4] },
            { name: "2026", values: [10.1, 11.3, 12.4] },
          ],
          caption: "Growth accelerated after the templates launch in August.",
        },
      },
      {
        tool: "add_chart",
        input: {
          title: "Churn by month",
          kind: "line",
          labels: ["Apr", "May", "Jun", "Jul", "Aug", "Sep"],
          series: [{ name: "Churn", values: [4.1, 3.9, 3.7, 3.4, 3.2, 3.1] }],
          unit: "%",
        },
      },
    ],
    () => reply("I built a Q3 explainer with four stat cards and two charts. Everything is editable."),
  ],
  gaps: [
    (s) => {
      const arrow = ofKind(s, "arrow").find((a) => a.from && a.to && a.from !== "?" && a.to !== "?");
      const items = s.lines.filter((l) => l.kind === "sticky" || l.kind === "rectangle");
      const between = arrow ? [arrow.from, arrow.to] : [items[0]?.id, items[1]?.id];
      return [
        {
          tool: "add_suggestions",
          input: {
            suggestions: [
              { text: "Security review before beta", between, reason: "Nothing checks the release before real users see it." },
              { text: "Collect beta feedback survey", between },
            ],
          },
        },
      ];
    },
    () => reply("I added two suggested missing steps (dashed purple). Keep the ones you agree with."),
  ],
  regroup: [
    (s) => {
      const items = s.lines.filter((l) => l.kind === "sticky");
      const themes = [
        { name: "Customer pain points", color: "pink", match: /slow|confus|bug|hard|crash|price|expensive/i },
        { name: "Feature ideas", color: "blue", match: /add|idea|template|integrat|export|dark|ai/i },
        { name: "Process", color: "green", match: /.*/ },
      ];
      const groups = themes.map((t) => ({ name: t.name, color: t.color, ids: [] as string[] }));
      for (const it of items) {
        const i = themes.findIndex((t) => t.match.test(String(it.text ?? "")));
        groups[i]!.ids.push(String(it.id));
      }
      return [{ tool: "regroup", input: { groups: groups.filter((g) => g.ids.length) } }];
    },
    () => reply("I regrouped the notes into themes."),
  ],
  retro: [
    (s) => {
      const items = s.lines.filter((l) => l.kind === "sticky");
      const good = items.filter((_, i) => i % 3 === 0).map((l) => String(l.id));
      const bad = items.filter((_, i) => i % 3 === 1).map((l) => String(l.id));
      const ideas = items.filter((_, i) => i % 3 === 2).map((l) => String(l.id));
      return [
        {
          tool: "regroup",
          input: {
            groups: [
              { name: "Went well", ids: good, color: "green" },
              { name: "To improve", ids: bad, color: "pink" },
              { name: "Ideas", ids: ideas, color: "blue" },
            ],
          },
        },
      ];
    },
    () => [
      {
        tool: "add_sections",
        input: {
          sections: [
            {
              name: "Action items",
              color: "orange",
              items: [{ text: "Ana: write the release checklist" }, { text: "Ben: add flaky-test alerts" }, { text: "Owner: TBD — book customer calls" }],
            },
          ],
        },
      },
    ],
    () => reply("I grouped the retro notes by theme and drafted action items with owners."),
  ],
  revise: [
    (s) => {
      const section = ofKind(s, "section")[0];
      const kids = s.lines.filter((l) => section && l.in === section.id && l.kind === "sticky");
      return [
        {
          tool: "update_elements",
          input: {
            updates: [
              ...(section ? [{ id: section.id, text: `${String(section.name)} (revised)` }] : []),
              ...kids.slice(0, 2).map((k) => ({ id: k.id, text: `${String(k.text)} — revised with a longer description that wraps`, color: "orange" })),
            ],
          },
        },
        ...(section
          ? [{ tool: "add_stickies", input: { section: section.id, stickies: [{ text: "New idea added in place" }, { text: "Another follow-up" }] } }]
          : []),
      ];
    },
    () => reply("I revised that section in place."),
  ],
  live: [
    (s) => {
      const section = ofKind(s, "section").find((l) => l.name === "Action items");
      const stickies = [{ text: "Leo: send beta invites Friday" }, { text: "Maya: draft launch email" }];
      if (section) return [{ tool: "add_stickies", input: { section: section.id, stickies } }];
      return [
        {
          tool: "add_sections",
          input: {
            sections: [
              { name: "Action items", items: stickies },
              { name: "Decisions", items: [{ text: "Beta limited to 50 teams" }] },
            ],
          },
        },
      ];
    },
    () => reply("Noted."),
  ],
  summary: [
    () => [
      {
        tool: "add_card",
        input: {
          title: "Summary",
          body: "- Launch target: spring\n- Biggest risk: app store review\n- Next step: start the beta with 50 customers",
          color: "yellow",
        },
      },
    ],
    () => reply("The board plans a spring launch; the biggest risk is app store review. I added a summary card."),
  ],
  "move-delete": [
    (s) => {
      const items = s.lines.filter((l) => l.kind === "sticky");
      const section = ofKind(s, "section")[0];
      return [
        ...(items[0] && section ? [{ tool: "move_elements", input: { ids: [items[0].id], into_section: section.id } }] : []),
        ...(items[1] ? [{ tool: "delete_elements", input: { ids: [items[1].id] } }] : []),
        ...(section ? [{ tool: "arrange", input: { section: section.id, layout: "grid", columns: 2 } }] : []),
      ];
    },
    () => reply("Moved, deleted, and tidied."),
  ],
};

export function devScriptCaller(name: string): ModelCaller | null {
  const steps = SCRIPTS[name.toLowerCase()];
  if (!steps) return null;
  return {
    model: `dev-script:${name}`,
    kind: "dev-script",
    async call(req): Promise<ModelReply> {
      throwIfStopped(req.signal);
      if (name.toLowerCase() === "long") await sleepUnlessStopped(600, req.signal);
      const turn = req.messages.filter((m) => m.role === "assistant").length;
      const step = steps[Math.min(turn, steps.length - 1)]!;
      const calls = step({ turn, lines: boardLines(req), results: [] });
      const content: ToolUse[] = calls.map((c, i) => ({ type: "tool_use", id: `toolu_dev_${turn}_${i}`, name: c.tool, input: c.input }));
      return { content, stopReason: "tool_use", usage: { input: 0, output: 0 } };
    },
  };
}

type ToolCall = { tool: string; input: Record<string, unknown> };

/** The JSON array at the start of `text` (anything after it, e.g. the user's words, is ignored). */
function leadingJson(text: string): string {
  const start = text.indexOf("[");
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** A caller that replays tool calls given in the prompt (dev only). Returns null when the JSON is invalid. */
export function devToolsCaller(json: string): ModelCaller | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(leadingJson(json));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const turns: ToolCall[][] = (parsed.length && Array.isArray(parsed[0]) ? parsed : [parsed]) as ToolCall[][];
  if (!turns.flat().some((c) => c?.tool === "reply")) turns.push([{ tool: "reply", input: { message: "Done." } }]);
  return {
    model: "dev-tools",
    kind: "dev-script",
    async call(req): Promise<ModelReply> {
      const turn = req.messages.filter((m) => m.role === "assistant").length;
      const calls = turns[Math.min(turn, turns.length - 1)] ?? [];
      const content: ToolUse[] = calls.map((c, i) => ({ type: "tool_use", id: `toolu_devtools_${turn}_${i}`, name: String(c.tool), input: c.input ?? {} }));
      return { content, stopReason: "tool_use", usage: { input: 0, output: 0 } };
    },
  };
}
