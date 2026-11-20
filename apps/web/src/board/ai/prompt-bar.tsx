// The bottom "Describe a change" bar: the main way to ask the board AI. Mic dictation, attachments and quick
// actions under "+", Enter sends, and the "Asking about N items" chip when part of the board is selected.
// A small "··· Working" status sits above it while the AI is running.
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@monet/board-protocol';
import { AlertCircle, ArrowUp, ChevronRight, Lightbulb, Loader2, Mic, Paperclip, PauseCircle, Plus, Sparkles, Square, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BoardContext } from '../slots';
import { ATTACH_ACCEPT } from './attachments';
import { useAiSession } from './ai-session';
import { ComposerChips, LiveDot, WorkingDots } from './composer-parts';
import { QUICK_ACTIONS, runQuickAction } from './quick-actions';
import { aiUi, useAiUi } from './store';
import { useComposer } from './use-composer';
import { acceptSuggestions, dismissSuggestions } from './suggestions';
import { useSuggestionUnits } from './suggestion-review';
import { useSelection } from './use-scene';

/** The "Describe a change" bar for the bottom dock. */
export function AiPromptBar({ ctx, className }: { ctx: BoardContext; className?: string }) {
  return <PromptBarView ctx={ctx} className={className} />;
}

export function PromptBarView({ ctx, className }: { ctx: BoardContext; className?: string }) {
  const { ai, live } = useAiSession();
  const { focusRequest } = useAiUi();
  const selection = useSelection(ctx.excalidrawAPI);
  const units = useSuggestionUnits(ctx.excalidrawAPI);
  const viewer = !ctx.canEdit && ctx.role !== null;
  const paused = ai?.paused ?? null;
  const c = useComposer({
    focusIds: selection.focusIds,
    focusCount: selection.count,
    disabled: !ctx.canEdit || !ai,
    blockedReason: paused?.message ?? null,
    sending: ai?.sending ?? false,
    micBusy: live?.active ?? false,
    focusRequest,
    maxHeight: 140,
    onSend: (input) => (ai ? ai.send(input) : Promise.resolve(false)),
  });

  const status = ai?.status.kind ?? 'idle';
  const working = status === 'thinking' || status === 'drawing';
  const notice = ai?.notice?.message ?? c.dictation.error ?? c.attachError ?? null;

  if (viewer) {
    return (
      <div className={cn('pointer-events-auto flex w-full max-w-[560px] flex-col items-center gap-2', className)} data-testid="ai-prompt-bar">
        <ReplyToast />
        {working && <WorkingLine />}
        <div
          className="rounded-full border border-[var(--monet-border)] bg-[var(--monet-surface)] px-4 py-2 text-[13px] text-[var(--monet-text-faint)]"
          data-testid="notice-ai-viewer"
        >
          View only · you can read the AI chat but not ask it to change this board
        </div>
      </div>
    );
  }

  return (
    <div className={cn('pointer-events-auto flex w-full max-w-[560px] flex-col gap-2', className)} data-testid="ai-prompt-bar" {...c.dropProps}>
      <ReplyToast />
      {working && <WorkingLine />}
      {units.length > 0 && ctx.excalidrawAPI && (
        <div
          className="mx-auto flex items-center gap-1 rounded-full border border-[var(--monet-border)] bg-[var(--monet-surface)] py-1 pl-3 pr-1 text-xs text-[var(--monet-text)] shadow-[0_4px_16px_rgba(0,0,0,0.35)]"
          data-testid="ai-suggestion-bar"
        >
          <Lightbulb className="h-3.5 w-3.5 text-[var(--monet-suggest)]" />
          <span className="mr-1">
            {units.length} suggestion{units.length === 1 ? '' : 's'} to review
          </span>
          <button
            className="rounded-full px-2 py-0.5 font-medium text-[var(--monet-success)] hover:bg-[var(--monet-hover)]"
            onClick={() => acceptSuggestions(ctx.excalidrawAPI!, units)}
            data-testid="button-bar-accept-suggestions"
          >
            Accept all
          </button>
          <button
            className="rounded-full px-2 py-0.5 text-[var(--monet-text-faint)] hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)]"
            onClick={() => dismissSuggestions(ctx.excalidrawAPI!, units)}
            data-testid="button-bar-dismiss-suggestions"
          >
            Dismiss all
          </button>
          <button
            className="flex items-center rounded-full px-2 py-0.5 text-[var(--monet-text-faint)] hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)]"
            onClick={() => aiUi.setChatOpen(true)}
            data-testid="button-bar-review-suggestions"
          >
            Review <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}
      {paused && (
        <div
          className="mx-auto flex items-center gap-1.5 rounded-full border border-[var(--monet-border-2)] bg-[var(--monet-surface)] px-3 py-1 text-xs text-[var(--monet-text)]"
          data-testid="notice-ai-paused-bar"
        >
          <PauseCircle className="h-3.5 w-3.5 text-[var(--monet-text-faint)]" /> {paused.message}
        </div>
      )}
      {notice && !paused && (
        <div
          className="mx-auto flex max-w-full items-start gap-1.5 rounded-xl border border-[var(--monet-danger-border)] bg-[var(--monet-danger-bg-2)] px-3 py-1.5 text-xs text-[var(--monet-danger-text)]"
          data-testid="notice-ai-error"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button
            onClick={() => {
              ai?.setNotice(null);
              c.dictation.clearError();
            }}
            className="rounded p-0.5 hover:bg-white/10"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {c.dictation.listening && (
        <div className="mx-auto flex items-center gap-1.5 text-xs text-[var(--monet-live)]" data-testid="status-dictating">
          <LiveDot /> Listening… press Esc or the mic to stop, Return to send
        </div>
      )}
      <ComposerChips c={c} focusCount={selection.count} className="justify-center" />
      <div
        className={cn(
          'flex min-h-[44px] w-full items-end gap-1 rounded-xl border border-[var(--monet-border-2)] bg-[var(--monet-surface-2)] py-[5px] pl-[5px] pr-[5px] shadow-[0_6px_24px_rgba(0,0,0,0.35)] transition focus-within:border-[var(--monet-border-3)]',
          c.dragOver && 'border-[#4d8ff7]',
        )}
      >
        <input
          ref={c.fileRef}
          type="file"
          multiple
          accept={ATTACH_ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void c.addFiles(e.target.files);
            e.target.value = '';
          }}
          data-testid="input-ai-file"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--monet-text-soft)] hover:bg-[var(--monet-hover-2)] hover:text-[var(--monet-text-strong)]"
              aria-label="Attach files or run a quick action"
              data-testid="button-ai-plus"
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-60 border-[var(--monet-border-2)] bg-[var(--monet-surface)] text-[var(--monet-text-strong)]"
          >
            <DropdownMenuItem
              onSelect={() => c.fileRef.current?.click()}
              className="gap-2 focus:bg-[var(--monet-hover)] focus:text-[var(--monet-text-strong)]"
              data-testid="button-ai-attach"
            >
              <Paperclip className="h-4 w-4 text-[var(--monet-text-faint)]" /> Attach CSV, text, PDF, or images
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[var(--monet-hover)]" />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-[var(--monet-text-muted)]">
              {selection.count > 0 ? `For the ${selection.count} selected item${selection.count === 1 ? '' : 's'}` : 'For the whole board'}
            </DropdownMenuLabel>
            {QUICK_ACTIONS.map((a) => (
              <DropdownMenuItem
                key={a.id}
                disabled={!!paused || c.reading > 0}
                onSelect={() => ai && runQuickAction(a, { boardId: ctx.boardId, focusElementIds: selection.count ? selection.focusIds : [], send: ai.send })}
                className="gap-2 focus:bg-[var(--monet-hover)] focus:text-[var(--monet-text-strong)]"
                data-testid={`button-quick-${a.id}`}
              >
                <a.icon className="h-4 w-4 text-[var(--monet-active-fg)]" /> {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <textarea
          ref={c.textareaRef}
          value={c.value}
          onChange={(e) => c.onChange(e.target.value)}
          onKeyDown={c.onKeyDown}
          onPaste={c.onPaste}
          disabled={!ctx.canEdit}
          rows={1}
          placeholder={paused ? 'Monet AI is paused. You can keep writing.' : c.useFocus ? 'Describe a change to the selection' : 'Describe a change'}
          className="block max-h-[140px] min-h-[32px] flex-1 resize-none self-center bg-transparent px-1.5 py-[5px] text-[15px] leading-[22px] text-[var(--monet-text-strong)] outline-none placeholder:text-[var(--monet-text-muted)]"
          data-testid="input-ai-prompt"
          aria-label="Describe a change for the board AI"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <button
                type="button"
                disabled={c.micDisabled}
                onClick={c.toggleMic}
                className={cn(
                  'grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--monet-text-soft)] hover:bg-[var(--monet-hover-2)] hover:text-[var(--monet-text-strong)] disabled:opacity-40',
                  c.dictation.listening && 'bg-[var(--monet-danger-bg)] text-[var(--monet-live)] hover:bg-[var(--monet-danger-border)]',
                )}
                aria-label={c.micLabel}
                aria-pressed={c.dictation.listening}
                data-testid="button-ai-mic"
              >
                {c.dictation.listening ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-[18px] w-[18px]" />}
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{c.micLabel}</TooltipContent>
        </Tooltip>
        {working && ai ? (
          <button
            type="button"
            onClick={() => void ai.stop()}
            disabled={ai.stopping}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--monet-text-strong)] text-[var(--monet-surface)] transition hover:opacity-90 disabled:opacity-60"
            aria-label="Stop Monet AI"
            title="Stop"
            data-testid="button-ai-stop"
          >
            {ai.stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3 w-3 fill-current" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void c.submit()}
            disabled={!c.canSend}
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded-full transition',
              c.hasContent && !paused ? 'bg-primary text-primary-foreground hover:brightness-95' : 'bg-[var(--monet-border-3)] text-[var(--monet-text-muted)]',
            )}
            aria-label={paused ? `Send (unavailable: ${paused.message})` : 'Send'}
            title={paused?.message}
            data-testid="button-ai-send"
          >
            {ai?.sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} />}
          </button>
        )}
      </div>
    </div>
  );
}

function WorkingLine() {
  return (
    <div className="mx-auto flex items-center gap-1.5 text-[12px] text-[var(--monet-text-faint)]" data-testid="status-ai-working">
      <WorkingDots className="text-[#c96442]" />
      Working
    </div>
  );
}

/** Plain-text preview of a Markdown reply. */
function preview(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The chat is hidden by default, so when the AI answers while it's closed, show the reply's first lines
 * above the bar with a way into the chat. Hides itself after a while or when the chat opens.
 */
function ReplyToast() {
  const { ai } = useAiSession();
  const { chatOpen } = useAiUi();
  const [shown, setShown] = useState<ChatMessage | null>(null);
  const seen = useRef<string | null | undefined>(undefined);
  const lastAssistant = ai?.messages.filter((m) => m.role === 'assistant').at(-1) ?? null;
  const loaded = !!ai?.loaded;
  useEffect(() => {
    if (!loaded) return;
    if (seen.current === undefined) {
      seen.current = lastAssistant?.id ?? null;
      return;
    }
    if (lastAssistant && lastAssistant.id !== seen.current) {
      seen.current = lastAssistant.id;
      if (!aiUi.get().chatOpen && lastAssistant.meta?.stopped !== true) setShown(lastAssistant);
    }
  }, [loaded, lastAssistant]);
  useEffect(() => {
    if (chatOpen) setShown(null);
  }, [chatOpen]);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 15_000);
    return () => clearTimeout(t);
  }, [shown]);
  if (!shown) return null;
  const isError = shown.meta?.error === true;
  const text = preview(shown.content);
  return (
    <div
      className="w-full rounded-2xl border border-[var(--monet-border)] bg-[var(--monet-surface)]/95 px-3.5 py-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.45)] backdrop-blur"
      data-testid="ai-reply-toast"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--monet-text-muted)]">
        <Sparkles className="h-3 w-3 text-[#c96442]" /> Monet AI
        <span className="flex-1" />
        <button
          onClick={() => setShown(null)}
          className="rounded p-0.5 hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)]"
          aria-label="Dismiss reply"
          data-testid="button-dismiss-reply-toast"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <p
        className={cn(
          'mt-1 line-clamp-3 text-[14px] leading-snug',
          isError ? 'font-sans text-[var(--monet-danger)]' : 'font-serif text-[var(--monet-text-strong)]',
        )}
        data-testid="text-reply-toast"
      >
        {text}
      </p>
      <button
        onClick={() => aiUi.setChatOpen(true)}
        className="mt-1.5 inline-flex items-center gap-0.5 text-[12px] font-medium text-[var(--monet-active-fg)] hover:text-[var(--monet-active-hover-fg)]"
        data-testid="button-reply-toast-open-chat"
      >
        Open chat <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
