// Turning boards into other things: AI-written docs and decks (stored in board_documents), file
// exports for other whiteboard tools (draw.io, Lucid, Excalidraw), and "Send to" Miro / Lucid.
import { boardDocumentsTable, db, usersTable } from "@monet/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/authMiddleware";
import { atLeast, getBoardAccess, type BoardAccess } from "../lib/access";
import { AiLimitError, getAiUsage, getGlobalAiPause, recordAiUsage, reserveAi } from "../lib/ai-limits";
import { getBoardElements } from "../realtime/rooms";
import { postChatMessage } from "./ai";
import { logger } from "../lib/logger";
import { config } from "../lib/config";
import { pgSafe } from "../lib/pg-safe";
import { byUserOrIp, limiters, rateLimit } from "../middlewares/rate-limit";
import { Scene, fileStem, loadBoardFiles } from "../outputs/scene";
import { boardOutline } from "../outputs/outline";
import {
  DECK_PRESETS,
  DOC_PRESETS,
  GenerationError,
  canGenerate,
  generateDeck,
  generateDoc,
  isStubMode,
  normalizeSlides,
  type DeckPreset,
  type DocPreset,
  type Slide,
} from "../outputs/generate";
import { markdownToDocx } from "../outputs/docx";
import { deckToPptx } from "../outputs/pptx";
import { sceneToDrawio } from "../outputs/drawio";
import { ExternalApiError, createLucidDocument, sceneToLucid } from "../outputs/lucid";
import { sceneToExcalidraw } from "../outputs/excalidraw-file";
import { sendToMiro } from "../outputs/miro";

const router: IRouter = Router();
const STALE_MS = 10 * 60 * 1000;

function linkTokenOf(req: Request): string | null {
  const v = req.query.link ?? req.headers["x-board-link"];
  return typeof v === "string" && v ? v : null;
}

async function access(req: Request, res: Response, needed: "viewer" | "editor", message?: string): Promise<BoardAccess | null> {
  const a = await getBoardAccess(String(req.params.id), req.user!.id, linkTokenOf(req));
  if (!a) {
    res.status(404).json({ error: "Board not found, or you don't have access." });
    return null;
  }
  if (!atLeast(a.role, needed)) {
    res.status(403).json({ error: message ?? "You need edit access for this." });
    return null;
  }
  return a;
}

type DocStatus = "generating" | "ready" | "error";

interface StoredContent {
  status?: DocStatus;
  markdown?: string;
  slides?: Slide[];
  error?: string;
  preset?: string;
  scope?: "board" | "selection";
  instructions?: string;
}

function statusOf(row: typeof boardDocumentsTable.$inferSelect): { status: DocStatus; error?: string } {
  const c = (row.content ?? {}) as StoredContent;
  const status: DocStatus = c.status ?? "ready";
  if (status === "generating" && Date.now() - row.createdAt.getTime() > STALE_MS) {
    return { status: "error", error: "Writing this was interrupted. Try again." };
  }
  return { status, ...(c.error ? { error: c.error } : {}) };
}

function viewerPath(boardId: string, kind: "doc" | "deck", id: string) {
  return `/b/${boardId}/${kind === "doc" ? "docs" : "decks"}/${id}`;
}

async function serialize(rows: (typeof boardDocumentsTable.$inferSelect)[], withContent: boolean) {
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const users = ids.length ? await db.select().from(usersTable).where(inArray(usersTable.id, ids)) : [];
  const names = new Map(users.map((u) => [u.id, u.displayName || "Someone"]));
  return rows.map((r) => {
    const c = (r.content ?? {}) as StoredContent;
    const st = statusOf(r);
    return {
      id: r.id,
      boardId: r.boardId,
      kind: r.kind,
      title: r.title,
      status: st.status,
      error: st.error ?? null,
      preset: c.preset ?? null,
      scope: c.scope ?? "board",
      createdBy: r.createdBy,
      createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      url: viewerPath(r.boardId, r.kind, r.id),
      ...(withContent ? { content: r.kind === "doc" ? { markdown: c.markdown ?? "" } : { slides: normalizeSlides(c.slides ?? []) } } : {}),
    };
  });
}

router.get("/outputs/config", requireAuth, async (req: Request, res: Response) => {
  const [usage, pause] = await Promise.all([getAiUsage(req.user!.id), getGlobalAiPause(req.user!.id)]);
  res.json({
    ai: canGenerate(),
    stub: isStubMode(),
    // The AI is off for everyone (kill switch "ai_disabled" or the global daily budget "global_budget").
    paused: !!pause,
    pauseCode: pause ? (pause.reason === "disabled" ? "ai_disabled" : "global_budget") : null,
    pauseMessage: pause?.message ?? null,
    usage,
    docPresets: Object.entries(DOC_PRESETS).map(([id, p]) => ({ id, label: p.label })),
    deckPresets: Object.entries(DECK_PRESETS).map(([id, p]) => ({ id, label: p.label })),
  });
});

// ---------- Docs & decks ----------

router.get("/boards/:id/documents", requireAuth, async (req: Request, res: Response) => {
  const a = await access(req, res, "viewer");
  if (!a) return;
  const rows = await db
    .select()
    .from(boardDocumentsTable)
    .where(eq(boardDocumentsTable.boardId, a.board.id))
    .orderBy(desc(boardDocumentsTable.createdAt))
    .limit(200);
  res.json({ documents: await serialize(rows, false) });
});

const CreateDocBody = z.object({
  kind: z.enum(["doc", "deck"]),
  preset: z.string().max(40).optional(),
  instructions: z.string().trim().max(2000).optional(),
  elementIds: z.array(z.string().max(100)).max(10_000).optional(),
});

const aiRequestLimit = rateLimit(limiters.aiRequests, byUserOrIp, "You're sending AI requests too quickly. Try again in a minute.");

router.post("/boards/:id/documents", requireAuth, aiRequestLimit, async (req: Request, res: Response) => {
  const a = await access(req, res, "editor", "You need edit access to ask the AI to write from this board.");
  if (!a) return;
  if (req.user!.kind === "guest" && !config.guestAi) {
    res.status(403).json({ error: "The owner has turned the AI off for guests on this server.", code: "guest_ai_off" });
    return;
  }
  const parsed = CreateDocBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
    return;
  }
  const { kind, instructions } = parsed.data;
  const preset = (
    kind === "doc"
      ? parsed.data.preset && parsed.data.preset in DOC_PRESETS
        ? parsed.data.preset
        : instructions
          ? "custom"
          : "plan"
      : parsed.data.preset && parsed.data.preset in DECK_PRESETS
        ? parsed.data.preset
        : instructions
          ? "custom"
          : "overview"
  ) as DocPreset | DeckPreset;
  if (preset === "custom" && !instructions) {
    res.status(400).json({ error: "Describe what you want the AI to write." });
    return;
  }
  if (!canGenerate()) {
    res.status(503).json({ error: "The board AI isn't configured on this server yet." });
    return;
  }

  const full = new Scene(await getBoardElements(a.board.id));
  const selection = parsed.data.elementIds?.length ? parsed.data.elementIds : null;
  const scene = full.subset(selection);
  const outline = boardOutline(a.board.title, scene, { selection: !!selection });
  if (outline.counts.items === 0 && outline.counts.sections === 0) {
    res.status(400).json({ error: selection ? "The selection has nothing to write about yet." : "The board is empty. Add some ideas first." });
    return;
  }

  const userId = req.user!.id;
  let reservation: Awaited<ReturnType<typeof reserveAi>>;
  try {
    reservation = await reserveAi(userId, { boardId: a.board.id });
  } catch (err) {
    if (err instanceof AiLimitError) {
      res.status(err.status).json({ error: err.message, code: err.code, usage: err.usage, retryAfterSec: err.retryAfterSec });
      return;
    }
    throw err;
  }

  const label = kind === "doc" ? DOC_PRESETS[preset as DocPreset].label : DECK_PRESETS[preset as DeckPreset].label;
  let row: typeof boardDocumentsTable.$inferSelect;
  try {
    [row] = (await db
      .insert(boardDocumentsTable)
      .values({
        boardId: a.board.id,
        kind,
        title: `${label} (writing…)`,
        content: { status: "generating", preset, scope: selection ? "selection" : "board", ...(instructions ? { instructions } : {}) },
        createdBy: userId,
      })
      .returning()) as [typeof boardDocumentsTable.$inferSelect];
  } catch (err) {
    reservation.release();
    throw err;
  }

  const noun = preset === "custom" ? kind : label.toLowerCase();
  const what = `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
  await postChatMessage(
    a.board.id,
    "user",
    `Turn ${selection ? "the selection" : "this board"} into ${what}${instructions ? `: ${instructions}` : ""}`,
    userId,
    { kind: "output-request", documentId: row.id, documentKind: kind, preset },
  ).catch((err) => logger.warn({ err }, "failed to post output request message"));

  const [doc] = await serialize([row], false);
  res.status(202).json({ document: doc });

  // Generate in the background; the client polls the document (and everyone on the board gets a chat message).
  void (async () => {
    let tokens = { input: 0, output: 0 };
    let model = "";
    try {
      const result =
        kind === "doc"
          ? await generateDoc({ boardTitle: a.board.title, outline: outline.text, preset: preset as DocPreset, instructions })
          : await generateDeck({ boardTitle: a.board.title, outline: outline.text, preset: preset as DeckPreset, instructions });
      tokens = { input: result.inputTokens, output: result.outputTokens };
      model = result.model;
      await db
        .update(boardDocumentsTable)
        .set(
          // Model text cut at a length limit can end in half an emoji, which jsonb refuses (see lib/pg-safe.ts).
          pgSafe({
            title: result.title,
            content: { status: "ready", preset, scope: selection ? "selection" : "board", ...(instructions ? { instructions } : {}), ...result.content },
          }),
        )
        .where(eq(boardDocumentsTable.id, row.id));
      const url = viewerPath(a.board.id, kind, row.id);
      await postChatMessage(
        a.board.id,
        "assistant",
        // The AI panel turns meta.url into a card and the matching link into a bold label.
        `I turned ${selection ? "the selection" : "the board"} into ${kind === "doc" ? "a doc" : "a deck"}: [${result.title.replace(/[[\]]/g, "")}](${url})`,
        null,
        { kind: "document", documentId: row.id, documentKind: kind, title: result.title, url },
      );
      await recordAiUsage({ userId, boardId: a.board.id, kind: `output-${kind}`, model, inputTokens: tokens.input, outputTokens: tokens.output, ok: true });
    } catch (err) {
      const message =
        err instanceof GenerationError
          ? err.message
          : err instanceof Error && /not configured/i.test(err.message)
            ? "The board AI isn't configured on this server yet."
            : "The AI couldn't finish this one. Try again in a moment.";
      if (err instanceof GenerationError) tokens = { input: err.inputTokens, output: err.outputTokens };
      logger.error({ err, boardId: a.board.id, documentId: row.id }, "output generation failed");
      await db
        .update(boardDocumentsTable)
        .set({ title: `${label} (failed)`, content: { status: "error", preset, error: message } })
        .where(eq(boardDocumentsTable.id, row.id))
        .catch(() => undefined);
      await postChatMessage(a.board.id, "assistant", `I couldn't write the ${kind}: ${message}`, null, {
        kind: "document",
        documentId: row.id,
        documentKind: kind,
        error: true,
      }).catch(() => undefined);
      await recordAiUsage({
        userId,
        boardId: a.board.id,
        kind: `output-${kind}`,
        model: model || undefined,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        ok: false,
      }).catch(() => undefined);
    } finally {
      reservation.release();
    }
  })();
});

async function loadDoc(req: Request, res: Response, needed: "viewer" | "editor") {
  const a = await access(req, res, needed);
  if (!a) return null;
  const [row] = await db
    .select()
    .from(boardDocumentsTable)
    .where(and(eq(boardDocumentsTable.id, String(req.params.docId)), eq(boardDocumentsTable.boardId, a.board.id)));
  if (!row) {
    res.status(404).json({ error: "That doc or deck doesn't exist anymore." });
    return null;
  }
  return { a, row };
}

router.get("/boards/:id/documents/:docId", requireAuth, async (req: Request, res: Response) => {
  const found = await loadDoc(req, res, "viewer");
  if (!found) return;
  const [doc] = await serialize([found.row], true);
  res.json({ document: doc, board: { id: found.a.board.id, title: found.a.board.title, role: found.a.role } });
});

router.delete("/boards/:id/documents/:docId", requireAuth, async (req: Request, res: Response) => {
  const found = await loadDoc(req, res, "editor");
  if (!found) return;
  await db.delete(boardDocumentsTable).where(eq(boardDocumentsTable.id, found.row.id));
  res.json({ ok: true });
});

function deckMarkdown(title: string, slides: Slide[]): string {
  const out = [`# ${title}`, ""];
  slides.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`, "");
    for (const b of s.bullets) out.push(`- ${b}`);
    if (s.notes) out.push("", `> Notes: ${s.notes}`);
    out.push("");
  });
  return out.join("\n");
}

function sendFile(res: Response, buf: Buffer | string, filename: string, type: string) {
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
}

router.get("/boards/:id/documents/:docId/download", requireAuth, async (req: Request, res: Response) => {
  const found = await loadDoc(req, res, "viewer");
  if (!found) return;
  const { row } = found;
  const c = (row.content ?? {}) as StoredContent;
  if (statusOf(row).status !== "ready") {
    res.status(409).json({ error: "This isn't ready yet." });
    return;
  }
  const format = String(req.query.format ?? "md");
  const stem = fileStem(row.title);
  try {
    if (row.kind === "doc") {
      const md = c.markdown ?? "";
      if (format === "md") return sendFile(res, md, `${stem}.md`, "text/markdown; charset=utf-8");
      if (format === "docx")
        return sendFile(res, await markdownToDocx(md, row.title), `${stem}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else {
      const slides = normalizeSlides(c.slides ?? []);
      if (format === "md") return sendFile(res, deckMarkdown(row.title, slides), `${stem}.md`, "text/markdown; charset=utf-8");
      if (format === "pptx")
        return sendFile(res, await deckToPptx(row.title, slides), `${stem}.pptx`, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    }
  } catch (err) {
    logger.error({ err, documentId: row.id, format }, "document download failed");
    res.status(500).json({ error: "Couldn't build that file." });
    return;
  }
  res.status(400).json({ error: "Unknown format." });
});

// ---------- Exports for other tools ----------

const ExportBody = z.object({
  elementIds: z.array(z.string().max(100)).max(10_000).optional(),
  background: z.string().max(40).optional(),
});

async function sceneFor(boardId: string, ids: string[] | undefined) {
  const scene = new Scene(await getBoardElements(boardId)).subset(ids?.length ? ids : null);
  const files = await loadBoardFiles(boardId, scene.fileIds());
  return { scene, files };
}

router.post("/boards/:id/export/:format", requireAuth, async (req: Request, res: Response) => {
  const a = await access(req, res, "viewer");
  if (!a) return;
  const parsed = ExportBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid export request." });
    return;
  }
  const { scene, files } = await sceneFor(a.board.id, parsed.data.elementIds);
  if (scene.elements.length === 0) {
    res.status(400).json({ error: "Nothing to export." });
    return;
  }
  const stem = fileStem(a.board.title);
  const format = String(req.params.format);
  if (format === "drawio") {
    const r = sceneToDrawio(scene, a.board.title, files);
    res.setHeader("X-Export-Counts", JSON.stringify(r.counts));
    return sendFile(res, r.xml, `${stem}.drawio`, "application/vnd.jgraph.mxfile; charset=utf-8");
  }
  if (format === "lucid") {
    const r = await sceneToLucid(scene, a.board.title, files);
    res.setHeader("X-Export-Counts", JSON.stringify(r.counts));
    return sendFile(res, r.zip, `${stem}.lucid`, "application/zip");
  }
  if (format === "excalidraw") {
    const doc = sceneToExcalidraw(scene, files, { viewBackgroundColor: parsed.data.background });
    return sendFile(res, JSON.stringify(doc), `${stem}.excalidraw`, "application/json; charset=utf-8");
  }
  res.status(400).json({ error: "Unknown export format." });
});

const MiroBody = z.object({
  accessToken: z.string().trim().min(10).max(2000),
  elementIds: z.array(z.string().max(100)).max(10_000).optional(),
});

router.post("/boards/:id/send/miro", requireAuth, async (req: Request, res: Response) => {
  const a = await access(req, res, "viewer");
  if (!a) return;
  const parsed = MiroBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Paste a Miro access token to continue." });
    return;
  }
  const { scene, files } = await sceneFor(a.board.id, parsed.data.elementIds);
  if (scene.elements.length === 0) {
    res.status(400).json({ error: "Nothing to send." });
    return;
  }
  try {
    const result = await sendToMiro({ token: parsed.data.accessToken, scene, title: a.board.title, files });
    res.json(result);
  } catch (err) {
    if (err instanceof ExternalApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err: err instanceof Error ? err.message : String(err), boardId: a.board.id }, "send to miro failed");
    res.status(502).json({ error: "Couldn't reach Miro. Try again in a moment." });
  }
});

const LucidBody = z.object({
  accessToken: z.string().trim().min(10).max(4000),
  product: z.enum(["lucidspark", "lucidchart"]).optional(),
  elementIds: z.array(z.string().max(100)).max(10_000).optional(),
});

router.post("/boards/:id/send/lucid", requireAuth, async (req: Request, res: Response) => {
  const a = await access(req, res, "viewer");
  if (!a) return;
  const parsed = LucidBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Paste a Lucid API key or access token to continue." });
    return;
  }
  const { scene, files } = await sceneFor(a.board.id, parsed.data.elementIds);
  if (scene.elements.length === 0) {
    res.status(400).json({ error: "Nothing to send." });
    return;
  }
  try {
    const lucid = await sceneToLucid(scene, a.board.title, files);
    const doc = await createLucidDocument({
      token: parsed.data.accessToken,
      zip: lucid.zip,
      title: a.board.title,
      product: parsed.data.product ?? "lucidspark",
    });
    res.json({ ...doc, counts: lucid.counts, skipped: lucid.skipped });
  } catch (err) {
    if (err instanceof ExternalApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err: err instanceof Error ? err.message : String(err), boardId: a.board.id }, "send to lucid failed");
    res.status(502).json({ error: "Couldn't reach Lucid. Try again in a moment." });
  }
});

export default router;
