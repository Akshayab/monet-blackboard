// Applies the board AI's changes: new elements get z-indices on top of the board, then rooms.applyServerChanges
// merges them and broadcasts them with their binding context (frames, label containers, arrow endpoints).
import { assignIndices, maxIndex, type SceneElement } from "@monet/board-protocol";
import { applyServerChanges, getRoom } from "../realtime/rooms";
import { runOwner } from "./runs";

export async function applyAiChanges(boardId: string, elements: SceneElement[], runId?: string): Promise<SceneElement[]> {
  if (!elements.length) return [];
  const room = await getRoom(boardId);
  const fresh = elements.filter((e) => !room.elements.has(e.id) && !e.index);
  if (fresh.length) assignIndices(fresh, maxIndex(room.elements.values()));
  // Tagged with the run and its requester so that person's client can undo the whole run in one step.
  const userId = runId ? runOwner(boardId, runId) : null;
  return applyServerChanges(boardId, elements, "ai", runId && userId ? { runId, userId } : undefined);
}
