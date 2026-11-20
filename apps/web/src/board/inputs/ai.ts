// Client for POST /api/boards/:id/ai (see AiRequestBody in api-server/src/routes/ai.ts). The server
// applies per-user AI limits; this only shapes the request and turns errors into readable messages.
import { api, ApiError } from '@/lib/api';

export interface AiAttachment {
  name: string;
  mimeType: string;
  text?: string;
  dataURL?: string;
}

export interface AiRequest {
  prompt: string;
  focusElementIds?: string[];
  /** Scene rectangle where new content should go. x/y is the top-left anchor (e.g. the drop point). */
  viewport?: { x: number; y: number; width: number; height: number };
  attachments?: AiAttachment[];
  /** PNG data URL of the focused region (sketch clean-up). */
  snapshot?: string;
}

export async function requestAi(boardId: string, linkToken: string | null, body: AiRequest): Promise<{ runId: string }> {
  try {
    return await api<{ runId: string }>(`/boards/${boardId}/ai`, { method: 'POST', json: body, linkToken });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 413) throw new Error('That file is too big to send to the AI.');
      throw new Error(err.message);
    }
    throw new Error('Could not reach the AI. Check your connection and try again.');
  }
}
