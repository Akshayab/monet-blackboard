// One-click prompts for common board transformations.
import { AlignLeft, CalendarRange, FileText, ListChecks, Presentation, SearchCheck, Shapes, type LucideIcon } from 'lucide-react';

export interface QuickAction {
  id: 'regroup' | 'timeline' | 'gaps' | 'summarize' | 'actions' | 'doc' | 'deck';
  label: string;
  icon: LucideIcon;
  prompt: (focused: boolean) => string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'regroup',
    label: 'Regroup by theme',
    icon: Shapes,
    prompt: (f) =>
      `Regroup ${f ? 'the selected items' : 'everything on the board'} by theme. Put related ideas into labeled sections, keep every existing note, and connect ideas that depend on each other.`,
  },
  {
    id: 'timeline',
    label: 'Turn into timeline',
    icon: CalendarRange,
    prompt: (f) =>
      `Turn ${f ? 'the selected items' : 'this board'} into a timeline: put the steps in order, group them into phases, and add owners and dates where you can.`,
  },
  {
    id: 'gaps',
    label: 'Find gaps',
    icon: SearchCheck,
    prompt: (f) =>
      `Find the gaps: what's missing between the steps ${f ? 'in the selected area' : 'on this board'}? Add your ideas to the board as suggestions for us to review.`,
  },
  {
    id: 'summarize',
    label: 'Summarize',
    icon: AlignLeft,
    prompt: (f) => `Summarize the key findings of ${f ? 'the selected items' : 'this board'} in a short note on the board.`,
  },
  {
    id: 'actions',
    label: 'Draft action items',
    icon: ListChecks,
    prompt: (f) => `Draft action items from ${f ? 'the selected items' : 'this board'}, grouped by owner, with a clear next step for each person.`,
  },
  { id: 'doc', label: 'Turn into doc', icon: FileText, prompt: (f) => `Turn ${f ? 'the selected items' : 'this board'} into a project plan document.` },
  { id: 'deck', label: 'Turn into deck', icon: Presentation, prompt: (f) => `Turn ${f ? 'the selected items' : 'this board'} into a short slide deck.` },
];

/**
 * Other features can take over a quick action (e.g. the doc/deck output feature) by listening for this
 * cancelable window event and calling preventDefault(); otherwise the action's prompt goes to the AI.
 */
export const QUICK_ACTION_EVENT = 'monet:quick-action';

export interface QuickActionEventDetail {
  id: QuickAction['id'];
  boardId: string;
  focusElementIds: string[];
}

export function dispatchQuickAction(detail: QuickActionEventDetail): boolean {
  const ev = new CustomEvent<QuickActionEventDetail>(QUICK_ACTION_EVENT, { detail, cancelable: true });
  return window.dispatchEvent(ev);
}

/** Runs a quick action: another feature may take it over (doc/deck); otherwise its prompt goes to the AI. */
export function runQuickAction(
  a: QuickAction,
  opts: { boardId: string; focusElementIds: string[]; send: (input: { prompt: string; focusElementIds?: string[] }) => Promise<boolean> },
) {
  const focused = opts.focusElementIds.length > 0;
  if (!dispatchQuickAction({ id: a.id, boardId: opts.boardId, focusElementIds: opts.focusElementIds })) return;
  void opts.send({ prompt: a.prompt(focused), focusElementIds: opts.focusElementIds });
}
