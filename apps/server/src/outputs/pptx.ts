// Deck JSON -> .pptx with pptxgenjs. A clean, neutral Monet Blackboard look (no third-party branding).
import PptxGenJS from "pptxgenjs";
import type { Slide } from "./generate";

const INK = "1E1E1E";
const MUTED = "5F6670";
const ACCENT = "4C6EF5";

export async function deckToPptx(title: string, slides: Slide[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = title;
  pptx.company = "Monet Blackboard";
  pptx.author = "Monet Blackboard";

  slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    if (i === 0) {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACCENT } });
      slide.addText(s.title, { x: 0.9, y: 2.3, w: 11.5, h: 1.5, fontSize: 40, bold: true, color: INK, fontFace: "Calibri" });
      if (s.bullets.length) {
        slide.addText(s.bullets.join("\n"), { x: 0.9, y: 3.9, w: 11.5, h: 1.4, fontSize: 20, color: MUTED, fontFace: "Calibri" });
      }
    } else {
      slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.35, w: 1.0, h: 0.06, fill: { color: ACCENT } });
      slide.addText(s.title, { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontSize: 30, bold: true, color: INK, fontFace: "Calibri" });
      if (s.bullets.length) {
        slide.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, breakLine: true } })),
          { x: 0.6, y: 1.7, w: 12.1, h: 5.2, fontSize: s.bullets.length > 5 ? 18 : 22, color: INK, fontFace: "Calibri", valign: "top", paraSpaceAfter: 10 },
        );
      }
      slide.addText(`${i + 1}`, { x: 12.2, y: 6.9, w: 0.8, h: 0.4, fontSize: 11, color: MUTED, align: "right" });
    }
    if (s.notes) slide.addNotes(s.notes);
  });

  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}
