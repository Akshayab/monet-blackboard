// UI store shared by the AI pieces that live in different parts of the board page: the prompt bar (bottom
// dock), the chat panel (left split), and the canvas overlays. Other features (the "Show chat" and "Ask AI"
// toolbar buttons) drive it through `aiUi`.
import { useSyncExternalStore } from 'react';

export interface AiUiState {
  /** Whether the chat panel is open. Hidden by default. */
  chatOpen: boolean;
  /** Alias of chatOpen (the board shell reads `open`). */
  open: boolean;
  /** Bumped to ask the prompt bar to focus its input (toolbar "Ask AI", floating "Ask AI" on a selection). */
  focusRequest: number;
}

let state: AiUiState = { chatOpen: false, open: false, focusRequest: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<AiUiState>) {
  state = { ...state, ...patch };
  state.open = state.chatOpen;
  if ('chatOpen' in patch) reflectChatOpen(state.chatOpen);
  listeners.forEach((l) => l());
}

/** Lets board chrome CSS react to the chat panel (e.g. the blue outline around the board while it's open). */
function reflectChatOpen(open: boolean) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (open) {
    root.dataset.aiChatOpen = 'true';
    root.classList.add('monet-ai-chat-open');
  } else {
    delete root.dataset.aiChatOpen;
    root.classList.remove('monet-ai-chat-open');
  }
}

export const aiUi = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setChatOpen(open: boolean) {
    if (state.chatOpen !== open) set({ chatOpen: open });
  },
  toggleChat() {
    set({ chatOpen: !state.chatOpen });
  },
  // Aliases used by the board shell ("Show chat").
  setOpen(open: boolean) {
    aiUi.setChatOpen(open);
  },
  open() {
    aiUi.setChatOpen(true);
  },
  close() {
    aiUi.setChatOpen(false);
  },
  toggle() {
    aiUi.toggleChat();
  },
  isOpen() {
    return state.chatOpen;
  },
  /** Focuses the prompt bar ("Describe a change"). */
  focusPrompt() {
    set({ focusRequest: state.focusRequest + 1 });
  },
  /** Alias of focusPrompt (the tool pill's "Ask AI"): focuses the prompt bar without opening the chat. */
  focusComposer() {
    aiUi.focusPrompt();
  },
  /** Closes the chat when leaving a board. */
  reset() {
    set({ chatOpen: false });
  },
};

export function useAiUi(): AiUiState {
  return useSyncExternalStore(aiUi.subscribe, aiUi.get, aiUi.get);
}

export const setChatOpen = aiUi.setChatOpen;
export const toggleChat = aiUi.toggleChat;
export const focusPrompt = aiUi.focusPrompt;
