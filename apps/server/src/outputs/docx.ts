// Markdown (as written by the AI) -> .docx, using marked's lexer and the docx library.
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import { marked, type Token, type Tokens } from "marked";

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function run(text: string, style: RunStyle): TextRun {
  return new TextRun({
    text: decodeEntities(text),
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    ...(style.code ? { font: "Consolas", shading: { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F5" } } : {}),
  });
}

function inline(tokens: Token[] | undefined, style: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push(run((t as Tokens.Codespan).text, { ...style, code: true }));
        break;
      case "br":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      case "link": {
        const l = t as Tokens.Link;
        const label = inlineText(l.tokens) || l.href;
        if (/^https?:\/\//i.test(l.href)) {
          out.push(new ExternalHyperlink({ link: l.href, children: [new TextRun({ text: decodeEntities(label), style: "Hyperlink" })] }));
        } else {
          out.push(run(label, style));
        }
        break;
      }
      case "image": {
        const im = t as Tokens.Image;
        out.push(run(`[${im.text || "image"}]`, { ...style, italics: true }));
        break;
      }
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length) out.push(...inline(tt.tokens, style));
        else out.push(run(tt.text, style));
        break;
      }
      case "escape":
        out.push(run((t as Tokens.Escape).text, style));
        break;
      case "html":
        out.push(run((t as Tokens.HTML).text.replace(/<[^>]+>/g, ""), style));
        break;
      case "checkbox":
        break;
      default: {
        const raw = (t as { text?: string; raw?: string }).text ?? (t as { raw?: string }).raw ?? "";
        if (raw) out.push(run(raw, style));
      }
    }
  }
  return out;
}

function inlineText(tokens: Token[] | undefined): string {
  return (tokens ?? [])
    .map((t) => {
      const any = t as { tokens?: Token[]; text?: string };
      if (any.tokens?.length) return inlineText(any.tokens);
      return any.text ?? "";
    })
    .join("");
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

class Builder {
  blocks: (Paragraph | Table)[] = [];
  orderedInstance = 0;

  block(tokens: Token[], ctx: { quote?: boolean } = {}) {
    for (const t of tokens) {
      switch (t.type) {
        case "heading": {
          const h = t as Tokens.Heading;
          this.blocks.push(new Paragraph({ heading: HEADINGS[Math.min(5, h.depth - 1)], children: inline(h.tokens) }));
          break;
        }
        case "paragraph": {
          const p = t as Tokens.Paragraph;
          this.blocks.push(
            new Paragraph({
              children: inline(p.tokens, ctx.quote ? { italics: true } : {}),
              spacing: { after: 120 },
              ...(ctx.quote ? { indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "CED4DA", space: 8 } } } : {}),
            }),
          );
          break;
        }
        case "text": {
          const tt = t as Tokens.Text;
          this.blocks.push(new Paragraph({ children: tt.tokens ? inline(tt.tokens) : [run(tt.text, {})] }));
          break;
        }
        case "list":
          this.list(t as Tokens.List, 0);
          break;
        case "table":
          this.table(t as Tokens.Table);
          break;
        case "code": {
          const c = t as Tokens.Code;
          for (const line of c.text.split("\n")) {
            this.blocks.push(
              new Paragraph({
                children: [run(line || " ", { code: true })],
                shading: { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F5" },
                spacing: { after: 0 },
              }),
            );
          }
          this.blocks.push(new Paragraph({ children: [] }));
          break;
        }
        case "blockquote":
          this.block((t as Tokens.Blockquote).tokens, { quote: true });
          break;
        case "hr":
          this.blocks.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CED4DA", space: 1 } } }));
          break;
        case "html": {
          const text = (t as Tokens.HTML).text.replace(/<[^>]+>/g, "").trim();
          if (text) this.blocks.push(new Paragraph({ children: [run(text, {})] }));
          break;
        }
        default:
          break;
      }
    }
  }

  list(list: Tokens.List, level: number) {
    const instance = list.ordered ? ++this.orderedInstance : 0;
    for (const item of list.items) {
      const prefix = item.task ? (item.checked ? "☑ " : "☐ ") : "";
      let first = true;
      for (const child of item.tokens) {
        if (child.type === "list") {
          this.list(child as Tokens.List, Math.min(level + 1, 4));
          continue;
        }
        if (child.type === "checkbox") continue;
        const tokens = (child as { tokens?: Token[] }).tokens;
        const children = tokens ? inline(tokens) : [run((child as { text?: string }).text ?? "", {})];
        if (first && prefix) children.unshift(new TextRun({ text: prefix }));
        const listProps = list.ordered
          ? { numbering: { reference: "ordered", level, instance } }
          : item.task
            ? { indent: { left: 360 * (level + 1) } }
            : { bullet: { level } };
        this.blocks.push(new Paragraph({ children, ...(first ? listProps : { indent: { left: 360 * (level + 1) } }) }));
        first = false;
      }
    }
  }

  table(t: Tokens.Table) {
    const cell = (c: Tokens.TableCell, header: boolean) =>
      new TableCell({
        children: [new Paragraph({ children: inline(c.tokens, header ? { bold: true } : {}) })],
        ...(header ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F5" } } : {}),
      });
    const rows = [
      new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }),
      ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
    ];
    this.blocks.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    this.blocks.push(new Paragraph({ children: [] }));
  }
}

export async function markdownToDocx(markdown: string, title: string): Promise<Buffer> {
  const tokens = marked.lexer(markdown, { gfm: true });
  const b = new Builder();
  b.block(tokens);
  const doc = new Document({
    creator: "Monet Blackboard",
    title,
    description: "Generated with Monet Blackboard",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
    },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: level % 2 === 0 ? LevelFormat.DECIMAL : LevelFormat.LOWER_LETTER,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: b.blocks.length ? b.blocks : [new Paragraph({ children: [] })] }],
  });
  return Packer.toBuffer(doc);
}
