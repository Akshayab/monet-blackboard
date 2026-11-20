// Lets other parts of the board (comments with "Send to AI") hand a request to the board AI without importing
// its hook. The AI controller listens and sends it like a prompt typed in the bar.
export const AI_SEND_EVENT = 'monet:ai-send';

export interface AiSendEventDetail {
  boardId: string;
  prompt: string;
  focusElementIds?: string[];
}

export function dispatchAiSend(detail: AiSendEventDetail) {
  window.dispatchEvent(new CustomEvent<AiSendEventDetail>(AI_SEND_EVENT, { detail }));
}

/** True when a comment mentions the AI (@AI, @Monet, @Monet AI). */
export function mentionsAi(text: string) {
  return /(^|\s)@(ai|monet)\b/i.test(text);
}

/** The request without the leading mention, e.g. "@AI lay out a timeline" → "lay out a timeline". */
export function stripAiMention(text: string) {
  return text.replace(/(^|\s)@(monet ai|monet|ai)\b[:,]?\s*/gi, '$1').trim();
}
