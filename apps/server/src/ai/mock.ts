// Test mode for the board AI: AI_MOCK=1 (never in production) swaps the model for deterministic scripts so the
// real tools, layout, live streaming, presence, chat, and limits can be tested without AI access.
//   - "[dev-script:<name>]" prompts run a canned scenario (dev-scripts.ts)
//   - "[dev-tools] <json>" prompts run exact tool calls (dev-scripts.ts)
//   - any other prompt runs a small keyword-driven script (below)
// GET /api/ai/usage reports configured: true while it's on.
import { config } from "../lib/config";
import type { ModelCaller, ModelReply, ModelRequest, ToolUse } from "./types";

export function isMockAi(): boolean {
  return config.mockAi;
}

type Line = Record<string, unknown>;

function firstText(req: ModelRequest): string {
  const first = req.messages[0];
  if (!first || typeof first.content === "string") return typeof first?.content === "string" ? first.content : "";
  return first.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

function boardLines(text: string): Line[] {
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

function focusHandles(text: string): Set<string> {
  const m = text.match(/The user selected an area of the board: ([^(\n.]+)/);
  return new Set(
    (m?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function requestText(text: string): string {
  const i = text.lastIndexOf("\n## Request\n");
  const j = text.lastIndexOf("\n## Live meeting transcript (latest chunk)\n");
  const at = Math.max(i, j);
  return at >= 0 ? text.slice(text.indexOf("\n", at + 2) + 1).trim() : text;
}

const use = (turn: number, calls: { tool: string; input: Record<string, unknown> }[]): ToolUse[] =>
  calls.map((c, i) => ({ type: "tool_use", id: `toolu_mock_${turn}_${i}`, name: c.tool, input: c.input }));

/** Keyword-driven stand-in for the model (one tool round, then a reply). */
export function mockCaller(): ModelCaller {
  return {
    model: "mock",
    kind: "dev-script",
    async call(req): Promise<ModelReply> {
      const turn = req.messages.filter((m) => m.role === "assistant").length;
      const usage = { input: 500, output: 120 };
      if (turn > 0)
        return { content: use(turn, [{ tool: "reply", input: { message: "Done. I laid that out on the board." } }]), stopReason: "tool_use", usage };
      const text = firstText(req);
      const prompt = requestText(text);
      const p = prompt.toLowerCase();
      const lines = boardLines(text);
      const focus = focusHandles(text);
      const stickies = lines.filter((l) => l.kind === "sticky" || l.kind === "rectangle");
      const pool = focus.size ? stickies.filter((s) => focus.has(String(s.id))) : stickies;
      const ids = pool.map((s) => String(s.id));
      let calls: { tool: string; input: Record<string, unknown> }[];
      if (/regroup|theme/.test(p) && ids.length >= 2) {
        const half = Math.ceil(ids.length / 2);
        calls = [
          {
            tool: "regroup",
            input: {
              groups: [
                { name: "Theme A", ids: ids.slice(0, half), color: "pink" },
                { name: "Theme B", ids: ids.slice(half), color: "blue" },
              ],
            },
          },
        ];
      } else if (/missing|gap/.test(p) && ids.length >= 2) {
        calls = [
          {
            tool: "add_suggestions",
            input: { suggestions: [{ text: "Review step", reason: "Nothing checks the work between these steps.", between: [ids[0], ids[1]] }] },
          },
        ];
      } else if (/says\s+(.+?)\s+so it says\s+(.+?)(?:\.|$)/i.test(prompt)) {
        // "Change the sticky note that says X so it says Y": edit that exact item in place.
        const [, from, to] = prompt.match(/says\s+(.+?)\s+so it says\s+(.+?)(?:\.|$)/i)!;
        const hit = lines.find(
          (l) =>
            String(l.text ?? "")
              .trim()
              .toLowerCase() === from!.trim().toLowerCase(),
        );
        calls = hit ? [{ tool: "update_elements", input: { updates: [{ id: String(hit.id), text: to!.trim() }] } }] : [];
      } else if (/rename|change|revise|edit/.test(p) && ids.length >= 1) {
        calls = [{ tool: "update_elements", input: { updates: [{ id: ids[0], text: "Revised by AI", color: "green" }] } }];
      } else if (/itinerary|day[- ]by[- ]day/.test(p)) {
        calls = [
          { tool: "add_text", input: { text: "Trip plan", size: "heading", subtitle: "3 days", ref: "head" } },
          {
            tool: "add_shapes",
            input: {
              layout: "flow",
              connect_in_order: true,
              near: "head",
              side: "below",
              shapes: [
                { text: "Day 1\nArrive", color: "pink" },
                { text: "Train", shape: "parallelogram", color: "yellow" },
                { text: "Day 2\nExplore", color: "green" },
              ],
            },
          },
          {
            tool: "add_table",
            input: {
              title: "Budget",
              columns: ["Category", "Estimate"],
              rows: [
                ["Hotel", "$300"],
                ["Total", "$300"],
              ],
            },
          },
        ];
      } else if (/\btable\b|budget|compar/.test(p)) {
        calls = [
          {
            tool: "add_table",
            input: {
              title: "Comparison",
              columns: ["Option", "Cost"],
              rows: [
                ["A", "$10"],
                ["B", "$20"],
              ],
            },
          },
        ];
      } else if (/timeline/.test(p)) {
        calls = [
          {
            tool: "add_timeline",
            input: {
              title: "Launch timeline",
              milestones: [
                { label: "Beta", date: "2027-03-02", owner: "Ana" },
                { label: "Pricing", date: "2027-03-09", owner: "Ben" },
                { label: "Launch", date: "2027-03-23", owner: "Ana" },
              ],
            },
          },
        ];
      } else if (/chart|stats?\b/.test(p)) {
        calls = [
          {
            tool: "add_stat_cards",
            input: {
              cards: [
                { value: "42%", label: "Growth" },
                { value: "1.2k", label: "Users" },
              ],
            },
          },
          {
            tool: "add_chart",
            input: { title: "Signups", kind: "bar", labels: ["Jan", "Feb", "Mar"], series: [{ name: "Signups", values: [120, 180, 260] }] },
          },
        ];
      } else {
        const parts = prompt
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 8);
        const ideas = parts.length >= 2 ? parts : ["Goal", "Plan", "Risks", "Next steps"];
        const half = Math.ceil(ideas.length / 2);
        calls = [
          {
            tool: "add_sections",
            input: {
              sections: [
                { name: "Ideas", items: ideas.slice(0, half).map((t, i) => ({ ref: `a${i}`, text: t })) },
                { name: "Follow-ups", items: ideas.slice(half).map((t, i) => ({ ref: `b${i}`, text: t })) },
              ],
              connections: [{ from: "a0", to: "b0", label: "leads to" }],
            },
          },
        ];
      }
      return { content: use(turn, calls), stopReason: "tool_use", usage };
    },
  };
}
