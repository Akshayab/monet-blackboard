import { describe, expect, it } from "vitest";
import { buildTimeline } from "../../src/ai/builders";

const ctx = () => {
  let n = 0;
  return { nextRef: (p = "e") => `${p}${++n}`, mark: (x: Record<string, unknown> = {}) => ({ ai: true, ...x }) };
};
const axisLabels = (els: { type: string; text?: unknown; x: unknown; y: unknown }[]) => {
  const texts = els.filter((e) => e.type === "text");
  const top = Math.min(...texts.map((e) => Number(e.y)));
  return texts
    .filter((e) => Number(e.y) === top)
    .sort((a, b) => Number(a.x) - Number(b.x))
    .map((e) => ({ text: String(e.text), x: Number(e.x) }));
};

describe("timeline axis", () => {
  const now = Date.UTC(2026, 10, 19);
  it("labels the month the first bar starts in, at the left end of the axis", () => {
    const b = buildTimeline(
      ctx(),
      {
        title: "Launch",
        milestones: [
          { label: "Research", date: "Jan 11 2027", end_date: "Jan 29 2027" },
          { label: "Design", date: "Feb 8 2027", end_date: "Mar 5 2027" },
          { label: "Build", date: "Mar 8 2027", end_date: "Apr 30 2027" },
          { label: "Launch", date: "May 15 2027" },
        ],
      },
      now,
    );
    const labels = axisLabels(b.elements as never);
    expect(labels.map((l) => l.text)).toEqual(["Jan 2027", "Feb", "Mar", "Apr", "May"]);
    const research = (b.elements as { type: string; text?: unknown; x: unknown }[]).find((e) => e.type === "text" && e.text === "Research")!;
    expect(labels[0]!.x).toBeLessThan(Number(research.x));
  });
  it("still names the year on the first month tick when there's no room for a start label", () => {
    const b = buildTimeline(
      ctx(),
      {
        title: "Q1",
        milestones: [
          { label: "Kickoff", date: "Jan 1 2027" },
          { label: "Beta", date: "Mar 1 2027" },
          { label: "GA", date: "Jun 1 2027" },
        ],
      },
      now,
    );
    const labels = axisLabels(b.elements as never).map((l) => l.text);
    expect(labels.some((t) => /2027/.test(t))).toBe(true);
    expect(labels.filter((t) => /^Jan/.test(t))).toHaveLength(1);
  });
});
