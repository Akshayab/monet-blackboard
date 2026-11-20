// Tool definitions the board AI can call. The model chooses structure and content; the server computes
// positions (no coordinates in inputs), so the board stays tidy.
import type { AiTool } from "./types";
import { COLOR_NAMES } from "./style";

type Schema = Record<string, unknown>;

const color: Schema = {
  type: "string",
  description: `Color name: ${COLOR_NAMES.join(", ")}.`,
};
const ref: Schema = {
  type: "string",
  description: 'Optional short name you choose for the new element (e.g. "risk1") so later tool calls can refer to it.',
};
const placement: Record<string, Schema> = {
  section: {
    type: "string",
    description: "Handle/ref of an existing section to put the new content inside (the section grows to fit).",
  },
  near: { type: "string", description: "Handle/ref of an element or section to place the new content next to." },
  side: {
    type: "string",
    enum: ["right", "below", "left", "above", "over"],
    description: 'Which side of `near` (default right). "over" draws in the same spot as `near` (use when replacing it, then delete it).',
  },
};
const SHAPES = ["rect", "rounded", "ellipse", "diamond", "pill", "hexagon", "parallelogram", "database", "queue", "document", "cloud", "person"];
const HEADS = ["arrow", "circle", "dot", "triangle", "bar", "diamond", "none"];
const style: Schema = {
  type: "string",
  enum: ["filled", "outline", "hollow"],
  description: "filled (default): solid color; outline: colored border; hollow: dashed border.",
};
const link: Schema = { type: "string", description: "Optional https:// link; the item becomes clickable." };
const item: Schema = {
  type: "object",
  properties: {
    text: { type: "string", description: "Short text (ideally under 15 words)." },
    color,
    ref,
    kind: {
      type: "string",
      enum: ["sticky", "text", "card", ...SHAPES],
      description: "Defaults to sticky. Shapes: see add_shapes. parallelogram = a slanted step for travel/transition steps.",
    },
    style,
    link,
    title: { type: "string", description: "Only for kind=card: a heading line." },
  },
  required: ["text"],
};
const layout: Schema = {
  type: "string",
  enum: ["grid", "row", "column", "flow"],
  description: "grid (default) for clusters, row/column for lists, flow for ordered steps (adds arrows in order).",
};
const idList = (description: string): Schema => ({ type: "array", items: { type: "string" }, description });

function tool(name: string, description: string, properties: Record<string, Schema>, required: string[] = []): AiTool {
  return { name, description, input_schema: { type: "object", properties, required } };
}

export const BOARD_TOOLS: AiTool[] = [
  tool(
    "add_sections",
    "Create one or more named sections (frames) filled with items, laid out side by side, optionally with arrows between items. Best tool for turning a brain dump or request into a structured board in one call.",
    {
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            ref,
            note: { type: "string", description: "Optional one-line subtitle shown under the section's heading." },
            color: { ...color, description: "Default sticky color for this section (each section gets its own by default)." },
            layout,
            columns: { type: "integer", minimum: 1, maximum: 8 },
            item_kind: { type: "string", enum: ["sticky", "text", "card", ...SHAPES] },
            items: { type: "array", items: item },
          },
          required: ["name"],
        },
      },
      arrangement: {
        type: "string",
        enum: ["auto", "row", "column", "grid"],
        description: "How sections sit relative to each other (auto: a row of up to 4, else a grid).",
      },
      connections: {
        type: "array",
        description: "Arrows between items (use refs you gave items, or existing handles).",
        items: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" }, dashed: { type: "boolean" } },
          required: ["from", "to"],
        },
      },
      near: placement.near!,
      side: placement.side!,
    },
    ["sections"],
  ),
  tool(
    "add_stickies",
    "Add sticky notes, laid out as a tidy grid (or row/column/flow) in free space, or inside an existing section.",
    { stickies: { type: "array", items: item }, layout, columns: { type: "integer", minimum: 1, maximum: 8 }, ...placement },
    ["stickies"],
  ),
  tool(
    "add_shapes",
    "Add labeled shapes for diagrams, flowcharts, and day-by-day plans: rounded rectangles for steps/days/places, parallelograms for travel or transition steps (flights, trains, transfers, hand-offs), diamonds for decisions, ellipses for start/end. Use layout=flow (or connect_in_order) for a left-to-right sequence with arrows; use connect for branches.",
    {
      shapes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Label. For a two-line card put a short title, then a newline, then one detail line." },
            shape: { type: "string", enum: SHAPES, description: "Default rounded." },
            color,
            style,
            link,
            ref,
          },
          required: ["text"],
        },
      },
      layout,
      columns: { type: "integer", minimum: 1, maximum: 8 },
      connect_in_order: { type: "boolean" },
      ...placement,
    },
    ["shapes"],
  ),
  tool(
    "add_text",
    "Add free text on the dark canvas: a large title/heading (optionally with a lighter subtitle line under it), a body paragraph, or a small grey note/caption.",
    {
      text: { type: "string" },
      size: {
        type: "string",
        enum: ["small", "normal", "large", "xl", "huge", "title", "heading", "subtitle", "body", "note"],
        description: "small, normal (default), large, xl, huge. (title/heading/subtitle/body/note also work.)",
      },
      link,
      subtitle: { type: "string", description: "Only for title/heading: one lighter line shown under it (e.g. dates, budget, or scope)." },
      color,
      ref,
      ...placement,
    },
    ["text"],
  ),
  tool(
    "add_card",
    "Add a larger card with a heading and body text (supports '- ' bullet lines). Good for summaries, decisions, action-item lists, and annotations.",
    { title: { type: "string" }, body: { type: "string" }, color, wide: { type: "boolean" }, ref, ...placement },
    ["body"],
  ),
  tool(
    "connect",
    "Draw arrows between existing elements (handles or refs). Arrows stay attached when people move things.",
    {
      connections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            label: { type: "string" },
            dashed: { type: "boolean" },
            color,
            start_head: { type: "string", enum: HEADS, description: "Default none." },
            end_head: { type: "string", enum: HEADS, description: "Default arrow." },
            routing: { type: "string", enum: ["straight", "elbow", "curved"], description: "Default straight; elbow = right angles." },
          },
          required: ["from", "to"],
        },
      },
    },
    ["connections"],
  ),
  tool(
    "add_timeline",
    "Draw a timeline section: a date axis with ticks, swimlanes (explicit lanes, or one lane per owner), and a card per milestone showing owner and date. Milestones with end_date become bars spanning the range. Use real dates (YYYY-MM-DD) whenever possible.",
    {
      title: { type: "string" },
      ref,
      lanes: { type: "array", items: { type: "object", properties: { name: { type: "string" }, color }, required: ["name"] } },
      milestones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD preferred; also 'Mar 3', 'Q2 2027', 'Week 3'." },
            end_date: { type: "string" },
            owner: { type: "string" },
            lane: { type: "string" },
            color,
            ref,
          },
          required: ["label"],
        },
      },
      near: placement.near!,
      side: placement.side!,
    },
    ["title", "milestones"],
  ),
  tool(
    "add_chart",
    "Draw an editable bar or line chart (axes, gridlines, labels, legend) from data. Use real numbers from the user or attachments.",
    {
      title: { type: "string" },
      kind: { type: "string", enum: ["bar", "line"] },
      labels: { type: "array", items: { type: "string" }, description: "Category / x-axis labels." },
      series: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } }, color },
          required: ["name", "values"],
        },
      },
      unit: { type: "string", description: "Suffix for values, e.g. '%', 'k', ' hrs'." },
      y_label: { type: "string" },
      caption: { type: "string", description: "Short takeaway or source line under the chart." },
      ref,
      ...placement,
    },
    ["title", "labels", "series"],
  ),
  tool(
    "add_table",
    "Draw a table (header row + rows of light text, thin separators, no fills). Use it whenever there are numbers or side-by-side facts: budgets and cost estimates, comparisons, option trade-offs, schedules, pros/cons by option. Keep cells short; put totals in the last row.",
    {
      title: { type: "string", description: "Optional short title above the table." },
      columns: { type: "array", items: { type: "string" }, description: 'Header labels, e.g. ["Category", "Estimate"].' },
      rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Rows of cell text, one string per column." },
      ref,
      ...placement,
    },
    ["columns", "rows"],
  ),
  tool(
    "add_stat_cards",
    "Add a row of stat cards (big number + label + optional delta) for visual explainers and dashboards.",
    {
      title: { type: "string" },
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            value: { type: "string", description: "e.g. '42%', '$1.2M', '3.4x'" },
            label: { type: "string" },
            delta: { type: "string", description: "e.g. '+12% vs last quarter'" },
            trend: { type: "string", enum: ["up", "down", "flat"] },
            color,
            ref,
          },
          required: ["value", "label"],
        },
      },
      ...placement,
    },
    ["cards"],
  ),
  tool(
    "add_suggestions",
    "Add suggestion stickies (dashed purple, marked as suggestions for people to review). Use `between` to put a missing step between two elements (connected with dashed arrows), or `near` to attach a suggestion to one element.",
    {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            between: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2, description: "[from handle, to handle]" },
            near: { type: "string" },
            reason: { type: "string", description: "Short why, shown to people reviewing the suggestion." },
            ref,
          },
          required: ["text"],
        },
      },
    },
    ["suggestions"],
  ),
  tool(
    "update_elements",
    "Edit existing elements in place: text (a section's text is its name; a card's text is 'title\\nbody'), color, shape type, size, or a table's contents (pass the full new `table`). Prefer this over recreating content when asked to revise, rename, recolor, or fix things.",
    {
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            color,
            shape: { type: "string", enum: ["rectangle", "ellipse", "diamond"] },
            table: {
              type: "object",
              description: "Only for tables: the new title/columns/rows (omitted parts stay as they are).",
              properties: {
                title: { type: "string" },
                columns: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array", items: { type: "string" } } },
              },
            },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["id"],
        },
      },
    },
    ["updates"],
  ),
  tool(
    "move_elements",
    "Move existing elements: into a section (into_section), next to another element (near + side), or by an offset (dx, dy). Arrows stay attached.",
    {
      ids: idList("Handles to move."),
      into_section: { type: "string" },
      near: placement.near!,
      side: placement.side!,
      dx: { type: "number" },
      dy: { type: "number" },
    },
    ["ids"],
  ),
  tool(
    "delete_elements",
    "Delete elements (a section is deleted with its contents unless keep_section_contents). Only delete what the user asked to remove or replace.",
    { ids: idList("Handles to delete."), keep_section_contents: { type: "boolean" } },
    ["ids"],
  ),
  tool(
    "regroup",
    "Reorganize EXISTING items into themed sections (new ones, or an existing section via `section`), laid out as tidy grids. Items keep their text; old sections left empty are removed. Use for 'regroup by theme', clustering retro notes, and sorting a messy board.",
    {
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            ids: idList("Handles of items in this group."),
            color: { ...color, description: "Recolor this group's stickies (recommended: a different color per group)." },
            note: { type: "string" },
            section: { type: "string", description: "Existing section handle to move these into instead of creating a new section." },
          },
          required: ["name", "ids"],
        },
      },
      arrangement: { type: "string", enum: ["auto", "row", "column", "grid"] },
      remove_empty_sections: { type: "boolean", description: "Default true." },
      near: placement.near!,
      side: placement.side!,
    },
    ["groups"],
  ),
  tool(
    "arrange",
    "Lay existing items out as a grid/row/column/flow: the items in a section or a list of handles (kept in the order given, or most-voted first with order=votes).",
    {
      ids: idList("Handles, in the order to lay them out."),
      section: { type: "string" },
      layout,
      columns: { type: "integer", minimum: 1, maximum: 8 },
      order: { type: "string", enum: ["given", "votes"], description: "votes = most votes first." },
    },
  ),
  tool(
    "cleanup_layout",
    "Clean up a messy layout without recreating anything: fixes overlapping items first, then ragged rows/columns, then uneven gaps. Scope: the given handles, a section's contents, or (with neither) the whole board. Use for 'clean up', 'tidy', 'fix the overlaps', 'align these'.",
    { ids: idList("Optional handles to tidy (e.g. the selection)."), section: { type: "string", description: "Optional section handle to tidy inside." } },
  ),
  tool(
    "add_illustration",
    "Draw a simple illustration of an object (e.g. mountain, house, laptop, plane, chart, tree, sun, cloud, car, phone, rocket, lightbulb, book, coffee, globe, gear, star, heart, flag, clock, envelope, calendar, target, trophy, lock, pin, coin, server, database, boat, train, building, plant). Never people or faces: for those, use a person shape block instead.",
    {
      subject: { type: "string", description: "What to draw (one object)." },
      style: { type: "string", enum: ["marker", "clean"], description: "marker (default): hand-drawn strokes; clean: smooth shapes." },
      size: { type: "string", enum: ["small", "medium", "large"] },
      ref,
      ...placement,
    },
    ["subject"],
  ),
  tool(
    "add_live_embed",
    "Add a live, interactive embed people can use on the board: a poll (question + options), a timer (minutes), a calculator, or a clickable prototype / custom widget (your own self-contained HTML+CSS+JS, at most 16,000 characters, no network access, no external files).",
    {
      kind: { type: "string", enum: ["poll", "timer", "calculator", "prototype", "custom"] },
      title: { type: "string" },
      question: { type: "string", description: "poll only." },
      options: { type: "array", items: { type: "string" }, description: "poll only: 2-8 options." },
      minutes: { type: "number", description: "timer only (default 5)." },
      html: {
        type: "string",
        description:
          "prototype/custom only: one complete self-contained HTML document (inline <style>/<script>; images only as data: URLs). It runs sandboxed and shared: window.monet.getState(), monet.setState(patch) (deep-merges into state everyone sees; null deletes a key), and monet.onState(function (state, info) {...}) (called now and on every change; info.me = { id, name, color } or null, info.readOnly, info.theme 'dark'|'light'). Keep state small (under 32,000 JSON chars). For colors use the CSS variables --bg, --panel, --fg, --muted, --line, --accent (with --on-accent for text on it), --btn so it follows light/dark mode.",
      },
      width: { type: "number" },
      height: { type: "number" },
      ref,
      ...placement,
    },
    ["kind"],
  ),
  tool(
    "reply",
    "Finish: send your short reply to the people on the board (what you did, and anything they should check or decide). Call this exactly once, last.",
    { message: { type: "string" } },
    ["message"],
  ),
];
