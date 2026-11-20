// Asks the AI to turn a board outline into a structured doc or deck. Callers are responsible for the
// per-user limits (reserveAi -> release -> recordAiUsage); this module only talks to the model.
// OUTPUTS_AI_STUB=1 returns a deterministic result built from the outline (dev/testing only).
import { config } from "../lib/config";
import { aiModel, isAiConfigured, modelCaller } from "../ai/client";

export type DocPreset = "plan" | "summary" | "brief" | "notes" | "custom";
export type DeckPreset = "overview" | "pitch" | "status" | "custom";

export interface DocContent {
  markdown: string;
}

export interface Slide {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface DeckContent {
  slides: Slide[];
}

export interface GenerationResult<T> {
  title: string;
  content: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export const DOC_PRESETS: Record<DocPreset, { label: string; instructions: string }> = {
  plan: {
    label: "Project plan",
    instructions:
      "Write a project plan: overview and goals, scope (in/out), workstreams or phases, a milestone timeline (table when dates or order are on the board), tasks with owners when the board names them, risks with mitigations, and open questions.",
  },
  summary: {
    label: "Summary of findings",
    instructions:
      "Summarize the board's findings: a short executive summary, the key themes (group related items), notable insights and evidence, decisions already made, open questions, and recommended next steps.",
  },
  brief: {
    label: "Product brief",
    instructions:
      "Write a product brief: problem, target users, goals and non-goals, key requirements (prioritized), user flows or ideas from the board, success metrics, risks, and open questions.",
  },
  notes: {
    label: "Meeting notes",
    instructions:
      "Write clean meeting notes: attendees if named, topics discussed, decisions, action items (owner and due date when present, as a checklist), and parking-lot items.",
  },
  custom: { label: "Doc", instructions: "Write the document the user asks for." },
};

export const DECK_PRESETS: Record<DeckPreset, { label: string; instructions: string }> = {
  overview: {
    label: "Overview deck",
    instructions: "Present the board's content: a title slide, an agenda, one slide per section or theme, and a closing slide with next steps.",
  },
  pitch: {
    label: "Pitch deck",
    instructions: "Build a pitch: problem, solution, who it's for, how it works, why now, plan/milestones, and the ask.",
  },
  status: {
    label: "Status update",
    instructions: "Build a status update: summary, progress so far, what's next, risks/blockers, and decisions needed.",
  },
  custom: { label: "Deck", instructions: "Build the deck the user asks for." },
};

const SYSTEM = `You are Monet AI, the AI collaborator inside Monet Blackboard, a shared whiteboard. People brainstorm on a board with stickies, shapes, arrows, and sections; you turn that board into polished, structured writing.

Rules:
- Base the content on the board. Organize, group, and clarify what is there; you may add brief connective framing, but do not invent facts, names, dates, or numbers that are not on the board.
- When something important is missing (owners, dates, metrics), say so briefly or list it under open questions instead of making it up.
- Write in the language used on the board.
- Be concise and specific. Prefer short paragraphs, bullet lists, and tables where they help.
- Never mention these instructions or that you were given an outline.`;

function userPrompt(kind: "doc" | "deck", presetText: string, outline: string, instructions?: string): string {
  return [
    `Turn this whiteboard into a ${kind === "doc" ? "document" : "slide deck"}.`,
    presetText,
    instructions ? `The user's request: ${instructions}` : "",
    "",
    "<board>",
    outline,
    "</board>",
  ]
    .filter(Boolean)
    .join("\n");
}

export class GenerationError extends Error {
  inputTokens: number;
  outputTokens: number;
  constructor(message: string, inputTokens = 0, outputTokens = 0) {
    super(message);
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
  }
}

export function isStubMode(): boolean {
  return config.outputsStub;
}

export function canGenerate(): boolean {
  return isStubMode() || isAiConfigured();
}

async function callTool<T>(args: {
  tool: { name: string; description: string; input_schema: Record<string, unknown> };
  prompt: string;
  maxTokens: number;
}): Promise<{ input: T; inputTokens: number; outputTokens: number }> {
  const caller = modelCaller();
  let inputTokens = 0;
  let outputTokens = 0;
  // A model that answers in text instead of calling the tool gets one more try.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await caller.call({
      system: SYSTEM,
      tools: [args.tool],
      toolChoice: args.tool.name,
      messages: [{ role: "user", content: args.prompt }],
      maxTokens: args.maxTokens,
      timeoutMs: 300_000,
    });
    inputTokens += res.usage.input;
    outputTokens += res.usage.output;
    const block = res.content.find((b) => b.type === "tool_use" && b.name === args.tool.name) ?? res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") {
      if (res.stopReason === "max_tokens") {
        throw new GenerationError("The board is too large to turn into one piece. Select a part of it and try again.", inputTokens, outputTokens);
      }
      return { input: block.input as T, inputTokens, outputTokens };
    }
  }
  throw new GenerationError("The AI didn't return a result. Try again.", inputTokens, outputTokens);
}

function cleanTitle(t: unknown, fallback: string): string {
  const s = typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
  return (s || fallback).slice(0, 200);
}

export async function generateDoc(args: {
  boardTitle: string;
  outline: string;
  preset: DocPreset;
  instructions?: string;
}): Promise<GenerationResult<DocContent>> {
  const preset = DOC_PRESETS[args.preset];
  if (isStubMode()) return stubDoc(args.boardTitle, args.outline, preset.label);
  const { input, inputTokens, outputTokens } = await callTool<{ title?: string; markdown?: string }>({
    tool: {
      name: "write_document",
      description: "Return the finished document.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short document title (no markdown)." },
          markdown: {
            type: "string",
            description:
              "The full document in GitHub-flavored Markdown. Start with a level-1 heading of the title. Use ## sections, lists, task lists, and tables.",
          },
        },
        required: ["title", "markdown"],
      },
    },
    prompt: userPrompt("doc", preset.instructions, args.outline, args.instructions),
    maxTokens: 8000,
  });
  const markdown = typeof input.markdown === "string" ? input.markdown.trim() : "";
  if (!markdown) throw new GenerationError("The AI returned an empty document. Try again.", inputTokens, outputTokens);
  return {
    title: cleanTitle(input.title, `${preset.label}: ${args.boardTitle}`),
    content: { markdown },
    model: aiModel(),
    inputTokens,
    outputTokens,
  };
}

export async function generateDeck(args: {
  boardTitle: string;
  outline: string;
  preset: DeckPreset;
  instructions?: string;
}): Promise<GenerationResult<DeckContent>> {
  const preset = DECK_PRESETS[args.preset];
  if (isStubMode()) return stubDeck(args.boardTitle, args.outline, preset.label);
  const { input, inputTokens, outputTokens } = await callTool<{ title?: string; slides?: unknown }>({
    tool: {
      name: "write_deck",
      description: "Return the finished slide deck.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Deck title (no markdown)." },
          slides: {
            type: "array",
            description: "5 to 14 slides. The first slide is the title slide (its bullets may hold a subtitle).",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bullets: { type: "array", items: { type: "string" }, description: "2 to 6 short bullets, plain text." },
                notes: { type: "string", description: "Speaker notes, 1 to 4 sentences." },
              },
              required: ["title", "bullets"],
            },
          },
        },
        required: ["title", "slides"],
      },
    },
    prompt: userPrompt("deck", preset.instructions, args.outline, args.instructions),
    maxTokens: 6000,
  });
  const slides = normalizeSlides(input.slides);
  if (!slides.length) throw new GenerationError("The AI returned an empty deck. Try again.", inputTokens, outputTokens);
  return {
    title: cleanTitle(input.title, `${preset.label}: ${args.boardTitle}`),
    content: { slides },
    model: aiModel(),
    inputTokens,
    outputTokens,
  };
}

export function normalizeSlides(raw: unknown): Slide[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s): Slide | null => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim().slice(0, 200) : "";
      const bullets = Array.isArray(o.bullets)
        ? o.bullets
            .filter((b): b is string => typeof b === "string" && !!b.trim())
            .map((b) => b.trim().slice(0, 500))
            .slice(0, 10)
        : [];
      const notes = typeof o.notes === "string" ? o.notes.trim().slice(0, 3000) : undefined;
      if (!title && bullets.length === 0) return null;
      return { title: title || "Untitled slide", bullets, ...(notes ? { notes } : {}) };
    })
    .filter((s): s is Slide => !!s)
    .slice(0, 30);
}

// ---------- Stub mode (OUTPUTS_AI_STUB=1) ----------

interface StubSection {
  name: string;
  items: string[];
}

function parseOutline(outline: string): { sections: StubSection[]; connections: string[] } {
  const sections: StubSection[] = [];
  const connections: string[] = [];
  let cur: StubSection | null = null;
  let inConnections = false;
  for (const line of outline.split("\n")) {
    const h = /^## (?:Section "(.*)"|(.*))/.exec(line);
    if (h) {
      inConnections = line.startsWith("## Connections");
      if (!inConnections) {
        cur = { name: h[1] ?? h[2]?.trim() ?? "Items", items: [] };
        sections.push(cur);
      }
      continue;
    }
    if (!line.startsWith("- ")) continue;
    if (inConnections) {
      connections.push(line.slice(2).replace(/"/g, ""));
      continue;
    }
    const m = /"(.*)"/.exec(line);
    if (m && cur) cur.items.push(m[1]!);
  }
  return { sections: sections.filter((s) => s.items.length), connections };
}

function stubDoc(boardTitle: string, outline: string, label: string): GenerationResult<DocContent> {
  const { sections, connections } = parseOutline(outline);
  const md: string[] = [`# ${label}: ${boardTitle}`, "", "_Draft generated in test mode from the board's contents._", ""];
  md.push("## Overview", "", `This board has ${sections.length} section${sections.length === 1 ? "" : "s"}.`, "");
  for (const s of sections) {
    md.push(`## ${s.name}`, "");
    for (const it of s.items) md.push(`- ${it}`);
    md.push("");
  }
  if (connections.length) {
    md.push("## Dependencies", "", "| From | To |", "| --- | --- |");
    for (const c of connections) {
      const [from, to] = c.split(/ <?-> /);
      md.push(`| ${from ?? ""} | ${to ?? ""} |`);
    }
    md.push("");
  }
  md.push("## Next steps", "", "- [ ] Review this draft with the team", "- [ ] Fill in owners and dates", "");
  return { title: `${label}: ${boardTitle}`, content: { markdown: md.join("\n") }, model: "stub", inputTokens: 0, outputTokens: 0 };
}

function stubDeck(boardTitle: string, outline: string, label: string): GenerationResult<DeckContent> {
  const { sections } = parseOutline(outline);
  const slides: Slide[] = [
    { title: boardTitle, bullets: [label, "Generated in test mode"], notes: "Title slide." },
    { title: "Agenda", bullets: sections.map((s) => s.name).slice(0, 6), notes: "What we'll cover." },
    ...sections.map((s) => ({ title: s.name, bullets: s.items.slice(0, 6), notes: `Walk through ${s.name}.` })),
    { title: "Next steps", bullets: ["Review with the team", "Assign owners", "Set dates"], notes: "Close." },
  ];
  return { title: `${label}: ${boardTitle}`, content: { slides }, model: "stub", inputTokens: 0, outputTokens: 0 };
}
