import { describe, expect, it } from "vitest";
import { makeArrow, makeFrame, makeShape, makeSticky, makeText, type SceneElement } from "@monet/board-protocol";
import { safeLink, sanitizeElement } from "../../src/realtime/guard";
import { Scene } from "../../src/outputs/scene";
import { sceneToDrawio } from "../../src/outputs/drawio";
import { sceneToExcalidraw } from "../../src/outputs/excalidraw-file";
import { boardOutline } from "../../src/outputs/outline";
import { markdownToDocx } from "../../src/outputs/docx";
import { deckToPptx } from "../../src/outputs/pptx";

const rect = (extra: Record<string, unknown> = {}) => ({
  id: "r1",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  index: "a0",
  ...extra,
});

describe("sanitizeElement", () => {
  it("keeps a normal element", () => {
    expect(sanitizeElement(rect())?.id).toBe("r1");
  });
  it("drops elements without the fields the server and other clients rely on", () => {
    expect(sanitizeElement(null)).toBeNull();
    expect(sanitizeElement([rect()])).toBeNull();
    expect(sanitizeElement(rect({ id: "" }))).toBeNull();
    expect(sanitizeElement(rect({ id: "x".repeat(129) }))).toBeNull();
    expect(sanitizeElement(rect({ version: "1" }))).toBeNull();
    expect(sanitizeElement(rect({ version: -1 }))).toBeNull();
    expect(sanitizeElement(rect({ versionNonce: Number.NaN }))).toBeNull();
    expect(sanitizeElement(rect({ isDeleted: "no" }))).toBeNull();
    expect(sanitizeElement(rect({ index: 5 }))).toBeNull();
  });
  it("drops element types that could render HTML outside the embed runner", () => {
    for (const type of ["iframe", "magicframe", "script", "html"]) expect(sanitizeElement(rect({ type }))).toBeNull();
    for (const type of ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "image", "frame", "embeddable"]) {
      expect(sanitizeElement(rect({ type }))?.type).toBe(type);
    }
  });
  it("removes script-capable links but keeps web links", () => {
    expect(sanitizeElement(rect({ link: " JaVaScRiPt:alert(1)" }))?.link).toBeNull();
    expect(sanitizeElement(rect({ link: "java\tscript:alert(1)" }))?.link).toBeNull();
    expect(sanitizeElement(rect({ link: "data:text/html,<b>x</b>" }))?.link).toBeNull();
    expect(sanitizeElement(rect({ link: "https://example.com/a" }))?.link).toBe("https://example.com/a");
    expect(safeLink(42)).toBeNull();
  });
  it("drops oversized elements and cleans strings so they can be stored", () => {
    expect(sanitizeElement(rect({ type: "text", text: "x".repeat(1_100_000) }))).toBeNull();
    const cleaned = sanitizeElement(rect({ type: "text", text: "a\u0000b" }));
    expect(cleaned?.text).not.toContain("\u0000");
  });
});

function sampleScene(): Scene {
  const frame = makeFrame({ x: 0, y: 0, width: 900, height: 500, name: "Plan" });
  const sticky = makeSticky({ x: 40, y: 80, text: "Ship the beta" }).map((e) => ({ ...e, frameId: frame.id }));
  const box = makeShape({ x: 400, y: 80, width: 200, height: 100, label: "Review & sign-off" }).map((e) => ({ ...e, frameId: frame.id }));
  const arrow = makeArrow({ from: sticky[0]!, to: box[0]! });
  const title = makeText({ x: 0, y: -60, text: "Launch <plan>", fontSize: 32 });
  return new Scene([frame, ...sticky, ...box, ...arrow, title] as SceneElement[]);
}

describe("exporters", () => {
  it("draw.io: every item is exported and text is escaped", () => {
    const { xml, counts } = sceneToDrawio(sampleScene(), "Launch & plan", new Map());
    expect(xml).toMatch(/^<\?xml [^>]*\?>\s*<mxfile /);
    expect(xml).toContain("Ship the beta");
    // Labels are HTML (line breaks as <br>) inside an XML attribute, so they're escaped twice.
    expect(xml).toMatch(/Review &amp;amp;(&lt;br&gt;| )sign-off/);
    expect(xml).toContain("Launch &amp;lt;plan&amp;gt;");
    expect(xml).not.toContain("<plan>");
    expect(counts).toMatchObject({ sections: 1, stickies: 1, shapes: 1, text: 1, arrows: 1 });
  });
  it("Excalidraw file: every live element, only the image files it uses", () => {
    const scene = sampleScene();
    const files = new Map([["unused", { id: "unused", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 }]]);
    const out = sceneToExcalidraw(scene, files);
    expect(out.type).toBe("excalidraw");
    expect(out.source).toBe("monet-blackboard");
    expect(out.elements).toHaveLength(scene.elements.length);
    expect(out.files).toEqual({});
  });
  it("outline: sections, items and connections the AI reads", () => {
    const { text, counts } = boardOutline("Launch", sampleScene());
    expect(text).toContain('Board title: "Launch"');
    expect(text).toContain("Plan");
    expect(text).toContain("Ship the beta");
    expect(counts.sections).toBe(1);
    expect(counts.connections).toBe(1);
  });
  it("Word and PowerPoint: valid zip packages", async () => {
    const docx = await markdownToDocx("# Plan\n\n- one\n- **two**\n\n| a | b |\n|---|---|\n| 1 | 2 |", "Plan");
    const pptx = await deckToPptx("Plan", [
      { title: "Why", bullets: ["Because"], notes: "Say it" },
      { title: "How", bullets: ["Step 1", "Step 2"] },
    ]);
    for (const buf of [docx, pptx]) expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(pptx.length).toBeGreaterThan(10_000);
  });
});
