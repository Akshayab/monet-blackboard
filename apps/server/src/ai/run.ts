// Board AI entry point (called by routes/ai.ts): enforce per-user limits, post the user's message, and start
// the agent in the background. Returns { runId } right away; progress arrives over the board's WebSocket.
import crypto from "crypto";
import type { z } from "zod";
import type { AuthUser } from "../lib/auth";
import { AiLimitError, reserveAi } from "../lib/ai-limits";
import { logger } from "../lib/logger";
import type { AiRequestBody } from "../routes/ai";
import { postChatMessage } from "../routes/ai";
import { getRoom } from "../realtime/rooms";
import { runAgent } from "./agent";
import { aiModel, isAiConfigured, modelCaller } from "./client";
import { config } from "../lib/config";
import { DEV_SCRIPT_RE, DEV_TOOLS_RE, devScriptCaller, devScriptsEnabled, devToolsCaller } from "./dev-scripts";
import { mockCaller } from "./mock";
import type { ModelCaller } from "./types";

export interface StartAiRunArgs {
  boardId: string;
  user: AuthUser;
  userName: string;
  request: z.infer<typeof AiRequestBody>;
  linkToken?: string | null;
}

export type StartAiRunResult = { runId: string } | { error: string; status: number; extra?: Record<string, unknown> };

function pickCaller(request: StartAiRunArgs["request"]): ModelCaller | null {
  if (devScriptsEnabled()) {
    const script = request.prompt.match(DEV_SCRIPT_RE);
    const scripted = script ? devScriptCaller(script[1]!) : null;
    if (scripted) return scripted;
    const tools = request.prompt.match(DEV_TOOLS_RE);
    const replay = tools ? devToolsCaller(tools[1]!) : null;
    if (replay) return replay;
    return mockCaller();
  }
  if (!isAiConfigured()) return null;
  return modelCaller(request.mode === "live" ? config.ai.liveModel || aiModel() : aiModel());
}

export async function startAiRun(args: StartAiRunArgs): Promise<StartAiRunResult> {
  const { boardId, user, request } = args;

  // Limits first (kill switch / global budget -> 503, user/board/IP limits -> 429), then configuration.
  let reservation: Awaited<ReturnType<typeof reserveAi>>;
  try {
    reservation = await reserveAi(user.id, { boardId });
  } catch (err) {
    if (err instanceof AiLimitError) {
      return {
        error: err.message,
        status: err.status,
        extra: { code: err.code, usage: err.usage, ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}) },
      };
    }
    throw err;
  }
  const caller = pickCaller(request);
  if (!caller) {
    reservation.release();
    return { error: "The board AI isn't configured on this server yet.", status: 503, extra: { code: "not_configured" } };
  }

  const runId = crypto.randomBytes(8).toString("hex");
  try {
    await postChatMessage(boardId, "user", request.prompt, user.id, {
      runId,
      mode: request.mode ?? "chat",
      focusCount: await countFocusItems(boardId, request.focusElementIds),
      attachments: (request.attachments ?? []).map((a) => ({ name: a.name })),
      snapshot: !!request.snapshot,
    });
  } catch (err) {
    reservation.release();
    throw err;
  }

  void runAgent({ ...args, runId, caller, release: reservation.release }).catch((err) => {
    reservation.release();
    logger.error({ err, boardId, runId }, "board AI run crashed");
  });
  return { runId };
}

/** Counts the selected items the way people see them: a sticky and its label are one item. */
async function countFocusItems(boardId: string, ids: string[] | undefined): Promise<number> {
  if (!ids?.length) return 0;
  try {
    const room = await getRoom(boardId);
    const items = new Set<string>();
    for (const id of ids) {
      const el = room.elements.get(id);
      const containerId = el && el.type === "text" ? (el as { containerId?: string | null }).containerId : null;
      items.add(containerId && room.elements.has(containerId) ? containerId : id);
    }
    return items.size;
  } catch {
    return ids.length;
  }
}
