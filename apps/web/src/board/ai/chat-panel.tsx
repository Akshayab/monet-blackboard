// The AI chat as a left split panel (hidden by default; "Show chat" toggles it). Shared with everyone on the
// board: messages, the AI's status lines, doc/deck cards, suggestion review, live mode, usage, and a Reply box.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowUp, Info, Loader2, Mic, PauseCircle, Plus, Radio, Square, X } from 'lucide-react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UsageMeter } from '@/components/usage-meter';
import { LogoMark } from '@/components/logo';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import type { BoardContext } from '../slots';
import { ATTACH_ACCEPT } from './attachments';
import { useAiSession } from './ai-session';
import { ComposerChips, LiveDot } from './composer-parts';
import { MessageList, StatusLine } from './message-list';
import { QUICK_ACTIONS, runQuickAction } from './quick-actions';
import { aiUi, useAiUi } from './store';
import { SuggestionList, useSuggestionUnits } from './suggestion-review';
import type { AiPause, AiUsage, BoardAi } from './use-board-ai';
import { useComposer } from './use-composer';
import type { LiveSession } from './use-live-session';
import { useSelection } from './use-scene';

/** The chat panel: render as the first child of the board's row (left of the canvas). */
export function AiChatPanel({ ctx }: { ctx: BoardContext }) {
  return <ChatPanelView ctx={ctx} fill />;
}

function UsageLine({ usage, paused }: { usage: AiUsage | null; paused: AiPause | null }) {
  if (paused) {
    return (
      <div className="text-[11px] text-[var(--monet-text-muted)]" data-testid="text-ai-usage">
        Monet AI is paused
      </div>
    );
  }
  if (!usage) return null;
  const left = Math.max(0, usage.requestLimit - usage.requestsUsed);
  const tokenShare = usage.tokenLimit ? usage.tokensUsed / usage.tokenLimit : 0;
  const out = left === 0 || tokenShare >= 1;
  const busy = !!usage.concurrentLimit && (usage.running ?? 0) >= usage.concurrentLimit;
  const resets = usage.resetsAt ? new Date(usage.resetsAt) : null;
  return (
    <div className={cn('text-[11px]', out ? 'text-[var(--monet-danger)]' : 'text-[var(--monet-text-muted)]')} data-testid="text-ai-usage">
      {out ? "You've reached today's AI limit" : `${left} of ${usage.requestLimit} AI requests left today`}
      {tokenShare >= 0.8 && !out ? ' · nearly out of AI capacity' : ''}
      {resets && (out || left <= 5) ? ` · resets ${resets.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
      {busy && !out ? ' · wait for a running request to finish' : ''}
    </div>
  );
}

function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function LiveBanner({ live }: { live: LiveSession }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live.active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live.active]);
  if (!live.active && !live.sendingChunk) return null;
  const tail = live.transcript.length > 180 ? `…${live.transcript.slice(-180)}` : live.transcript;
  return (
    <div className="mx-4 mb-2 rounded-xl border border-[var(--monet-danger-border)] bg-[var(--monet-danger-bg-2)] px-3 py-2" data-testid="banner-live">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--monet-live)]">
        {live.active ? <LiveDot /> : <span className="h-2 w-2 rounded-full bg-red-500" />}
        <span className="flex-1">
          {live.active ? `Live · ${live.startedAt ? elapsed(now - live.startedAt) : '0:00'}` : 'Sending the last part…'}
          {live.chunksSent > 0 && (
            <span className="font-normal text-[var(--monet-live)]">
              {' '}
              · {live.chunksSent} update{live.chunksSent === 1 ? '' : 's'} sent
            </span>
          )}
        </span>
        {live.active && (
          <button
            onClick={live.stop}
            className="rounded-md bg-[var(--monet-danger-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--monet-danger-strong)] hover:bg-[var(--monet-danger-border)]"
            data-testid="button-live-stop"
          >
            Stop
          </button>
        )}
      </div>
      <p className="mt-1 line-clamp-3 text-xs text-[var(--monet-danger-muted)]" data-testid="text-live-transcript">
        {tail || 'Listening… the board updates about every 25 seconds while people talk.'}
      </p>
    </div>
  );
}

function ReplyBox({ ctx, ai, live }: { ctx: BoardContext; ai: BoardAi; live: LiveSession | null }) {
  const selection = useSelection(ctx.excalidrawAPI);
  const c = useComposer({
    focusIds: selection.focusIds,
    focusCount: selection.count,
    disabled: !ctx.canEdit,
    blockedReason: ai.paused?.message ?? null,
    sending: ai.sending,
    micBusy: live?.active ?? false,
    maxHeight: 180,
    onSend: (input) => ai.send(input),
  });
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--monet-border-2)] bg-[var(--monet-surface-2)] transition focus-within:border-[var(--monet-border-3)]',
        c.dragOver && 'border-[#4d8ff7]',
      )}
      {...c.dropProps}
      data-testid="ai-reply-box"
    >
      <ComposerChips c={c} focusCount={selection.count} className="px-2.5 pt-2.5" prefix="reply-" />
      <textarea
        ref={c.textareaRef}
        value={c.value}
        onChange={(e) => c.onChange(e.target.value)}
        onKeyDown={c.onKeyDown}
        onPaste={c.onPaste}
        rows={2}
        placeholder={ai.paused ? 'Monet AI is paused. You can keep writing.' : 'Reply'}
        className="block max-h-[180px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[14px] text-[var(--monet-text-strong)] outline-none placeholder:text-[var(--monet-text-muted)]"
        data-testid="input-ai-chat"
        aria-label="Reply to the board AI"
      />
      {c.dictation.listening && (
        <div className="flex items-center gap-1.5 px-3 pb-1 text-xs text-[var(--monet-live)]" data-testid="status-reply-dictating">
          <LiveDot /> Listening… Esc or the mic stops
        </div>
      )}
      {(c.dictation.error || c.attachError) && <div className="px-3 pb-1 text-xs text-[var(--monet-danger)]">{c.dictation.error ?? c.attachError}</div>}
      <div className="flex items-center gap-1 px-1.5 pb-1.5">
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
          data-testid="input-ai-chat-file"
        />
        <button
          type="button"
          onClick={() => c.fileRef.current?.click()}
          className="grid h-8 w-8 place-items-center rounded-full text-[var(--monet-text-faint)] hover:bg-[var(--monet-surface-3)] hover:text-[var(--monet-text-strong)]"
          aria-label="Attach files"
          data-testid="button-ai-chat-attach"
        >
          <Plus className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          disabled={c.micDisabled}
          onClick={c.toggleMic}
          className={cn(
            'grid h-8 w-8 place-items-center rounded-full text-[var(--monet-text-faint)] hover:bg-[var(--monet-surface-3)] hover:text-[var(--monet-text-strong)] disabled:opacity-40',
            c.dictation.listening && 'bg-[var(--monet-danger-bg)] text-[var(--monet-live)]',
          )}
          aria-label={c.micLabel}
          aria-pressed={c.dictation.listening}
          data-testid="button-ai-chat-mic"
        >
          {c.dictation.listening ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
        </button>
        {(ai.status.kind === 'thinking' || ai.status.kind === 'drawing') && ctx.canEdit ? (
          <button
            type="button"
            onClick={() => void ai.stop()}
            disabled={ai.stopping}
            className="grid h-8 w-8 place-items-center rounded-full bg-[var(--monet-text-strong)] text-[var(--monet-surface)] transition hover:opacity-90 disabled:opacity-60"
            aria-label="Stop Monet AI"
            title="Stop"
            data-testid="button-ai-chat-stop"
          >
            {ai.stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3 w-3 fill-current" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void c.submit()}
            disabled={!c.canSend}
            className={cn(
              'grid h-8 w-8 place-items-center rounded-full transition',
              c.hasContent && !ai.paused
                ? 'bg-primary text-primary-foreground hover:brightness-95'
                : 'bg-[var(--monet-border-3)] text-[var(--monet-text-muted)]',
            )}
            aria-label="Send reply"
            data-testid="button-ai-chat-send"
          >
            {ai.sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.25} />}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * `fill`: the board shell sizes the wrapper (40% / min 360 / max 640, outline while open), so fill it.
 * Without `fill` (legacy fallback) the panel sizes itself as an order-first left split.
 */
export function ChatPanelView({ ctx, fill = false }: { ctx: BoardContext; fill?: boolean }) {
  const isMobile = useIsMobile();
  const { chatOpen } = useAiUi();
  const { ai, live } = useAiSession();
  const selection = useSelection(ctx.excalidrawAPI);
  const units = useSuggestionUnits(ctx.excalidrawAPI);
  const viewer = !ctx.canEdit && ctx.role !== null;
  const meId = ctx.collab.me?.userId ?? ctx.user?.id ?? null;
  const title = ctx.collab.title || ctx.board?.title || 'Untitled board';
  const othersHere = ctx.collab.collaborators.some((c) => !c.isAI && c.userId !== meId);
  const access =
    ctx.role && ctx.role !== 'owner'
      ? ctx.role === 'viewer'
        ? 'View only'
        : ctx.role === 'commenter'
          ? 'Can comment'
          : 'Shared with you'
      : ctx.board?.linkAccess === 'edit'
        ? 'Anyone with the link can edit'
        : ctx.board?.linkAccess === 'view'
          ? 'Anyone with the link can view'
          : othersHere
            ? 'Shared'
            : 'Only you';

  // Close the chat when leaving the board.
  useEffect(() => () => aiUi.reset(), []);

  const showElements = useCallback(
    (ids: string[]) => {
      const api = ctx.excalidrawAPI;
      if (!api) return;
      const set = new Set(ids);
      const els = api.getSceneElements().filter((e) => set.has(e.id));
      if (!els.length) return;
      api.updateScene({
        appState: { selectedElementIds: Object.fromEntries(els.map((e) => [e.id, true])) as never },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.scrollToContent(els, { animate: true, fitToViewport: els.length > 1, viewportZoomFactor: 0.7 });
    },
    [ctx.excalidrawAPI],
  );

  const status = ai?.status;
  const running = status && (status.kind === 'thinking' || status.kind === 'drawing');
  const statusText = !status
    ? ''
    : status.kind === 'drawing'
      ? status.message || 'Working on the board…'
      : status.kind === 'thinking'
        ? status.message || 'Pondering…'
        : '';
  const whoName = (() => {
    if (!running || !status || !('userId' in status)) return null;
    const uid = status.userId;
    if (!uid || uid === meId) return null;
    return ctx.collab.collaborators.find((c) => c.userId === uid)?.name ?? null;
  })();
  const workingRow = running ? (
    <StatusLine busy testId="row-ai-working">
      {statusText}
      {whoName ? ` (for ${whoName})` : ''}
    </StatusLine>
  ) : null;

  const empty = !!ai?.loaded && ai.messages.length === 0;
  const runQuick = (id: (typeof QUICK_ACTIONS)[number]) => {
    if (!ai || ai.paused) return;
    runQuickAction(id, { boardId: ctx.boardId, focusElementIds: selection.count ? selection.focusIds : [], send: ai.send });
  };

  const panel = (
    <aside
      className={cn(
        'flex flex-col bg-[var(--monet-panel)] text-[var(--monet-text-strong)]',
        isMobile
          ? 'fixed inset-0 z-[60]'
          : fill
            ? 'h-full w-full min-w-0'
            : 'order-first h-full w-[380px] max-w-[45vw] shrink-0 border-r border-[var(--monet-surface-2)]',
        !chatOpen && 'hidden',
      )}
      aria-hidden={!chatOpen}
      data-testid="panel-ai-chat"
    >
      {/* Board card + controls */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-[var(--monet-border)] bg-[var(--monet-surface)] px-3 py-2.5"
          data-testid="card-ai-board"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--monet-surface-2)]">
            <LogoMark className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-[var(--monet-text-strong)]">{title}</span>
            <span className="block truncate text-xs text-[var(--monet-text-muted)]" data-testid="text-ai-board-access">
              Whiteboard · {access}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-1.5">
          {ctx.canEdit && live && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <button
                    onClick={() => {
                      live.clearError();
                      live.toggle();
                    }}
                    disabled={!live.supported || (!!ai?.paused && !live.active)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition disabled:opacity-40',
                      live.active
                        ? 'bg-[var(--monet-danger-bg)] text-[var(--monet-live)]'
                        : 'text-[var(--monet-text-soft)] hover:bg-[var(--monet-surface-2)] hover:text-[var(--monet-text-strong)]',
                    )}
                    aria-pressed={live.active}
                    data-testid="button-live-toggle"
                  >
                    <Radio className="h-3.5 w-3.5" /> Live
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-60">
                {ai?.paused && !live.active
                  ? ai.paused.message
                  : live.supported
                    ? live.active
                      ? 'Stop the live session'
                      : 'Live session: the AI listens while you talk and builds the board as you go'
                    : "Live sessions need speech recognition, which this browser doesn't support"}
              </TooltipContent>
            </Tooltip>
          )}
          <UsageMeter compact className="h-8 border-[var(--monet-border-2)] px-2 text-[var(--monet-text-soft)] hover:bg-[var(--monet-surface-2)]" />
          <button
            onClick={() => aiUi.setChatOpen(false)}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--monet-text-faint)] hover:bg-[var(--monet-surface-2)] hover:text-[var(--monet-text-strong)]"
            aria-label="Hide chat"
            data-testid="button-ai-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {live && <LiveBanner live={live} />}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4" data-testid="ai-chat-scroll">
        {ai?.configured === false && (
          <div
            className="flex items-start gap-2 rounded-xl border border-[var(--monet-warn-border)] bg-[var(--monet-warn-bg)] px-3 py-2 text-xs text-[var(--monet-warn-text)]"
            data-testid="notice-ai-not-configured"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The board AI isn't set up on this server yet. You can still chat here; the AI will reply once it's enabled.
          </div>
        )}
        {ai?.paused && ai.configured !== false && (
          <div
            className="flex items-start gap-2 rounded-xl border border-[var(--monet-border)] bg-[var(--monet-surface)] px-3 py-2 text-xs text-[var(--monet-text)]"
            data-testid="notice-ai-paused"
          >
            <PauseCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--monet-text-faint)]" />
            <span>
              <span className="font-medium">AI paused.</span> {ai.paused.message} The chat and board still work; the AI picks up again once it's back.
            </span>
          </div>
        )}
        {ai && (ai.notice || ai.runError || live?.error) && (
          <div
            className="flex items-start gap-2 rounded-xl border border-[var(--monet-danger-border)] bg-[var(--monet-danger-bg-2)] px-3 py-2 text-xs text-[var(--monet-danger-text)]"
            data-testid="notice-ai-chat-error"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{ai.notice?.message ?? live?.error ?? ai.runError}</span>
            {(ai.notice || live?.error) && (
              <button
                onClick={() => {
                  ai.setNotice(null);
                  live?.clearError();
                }}
                className="rounded p-0.5 hover:bg-white/10"
                aria-label="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
        <SuggestionList api={ctx.excalidrawAPI} units={units} canEdit={ctx.canEdit} />
        {!ai || !ai.loaded ? (
          <div className="grid place-items-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--monet-text-muted)]" />
          </div>
        ) : empty ? (
          <div className="pt-2" data-testid="ai-empty">
            <p className="font-serif text-[17px] text-[var(--monet-text-strong)]">Think out loud with Monet AI</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--monet-text-faint)]">
              Describe a change in the bar under the board, paste a messy brain dump, attach a CSV or PDF, or dictate. Select part of the board to ask about
              just that area.
            </p>
            {ctx.canEdit && (
              <div className="mt-4 grid grid-cols-2 gap-1.5" data-testid="ai-quick-actions">
                {QUICK_ACTIONS.map((a) => (
                  <button
                    key={a.id}
                    disabled={!!ai.paused || ai.sending}
                    onClick={() => runQuick(a)}
                    className="flex items-center gap-2 rounded-xl border border-[var(--monet-border)] bg-[var(--monet-surface)] px-3 py-2 text-left text-xs font-medium text-[var(--monet-text)] transition hover:border-[var(--monet-border-3)] hover:bg-[var(--monet-hover)] disabled:opacity-40"
                    data-testid={`button-chat-quick-${a.id}`}
                  >
                    <a.icon className="h-3.5 w-3.5 shrink-0 text-[var(--monet-active-fg)]" /> {a.label}
                  </button>
                ))}
              </div>
            )}
            {workingRow && <div className="mt-4">{workingRow}</div>}
          </div>
        ) : (
          <MessageList messages={ai.messages} meId={meId} footer={workingRow} linkToken={ctx.linkToken} onShowElements={showElements} />
        )}
      </div>

      <div className="space-y-1.5 border-t border-[var(--monet-surface-2)] px-4 pt-3 pb-3">
        {viewer ? (
          <div className="rounded-xl bg-[var(--monet-surface)] px-3 py-2.5 text-xs text-[var(--monet-text-faint)]" data-testid="notice-ai-viewer-chat">
            You have view access, so you can read the chat but not ask the AI to change the board.
          </div>
        ) : ai ? (
          <>
            <ReplyBox ctx={ctx} ai={ai} live={live} />
            <div className="flex items-center justify-between gap-2">
              <UsageLine usage={ai.usage} paused={ai.paused} />
              <span className="shrink-0 text-[11px] text-[var(--monet-text-muted)]" data-testid="text-ai-disclaimer">
                AI can make mistakes.
              </span>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
  // On phones the chat is a full-screen sheet above every floating canvas control (they live in <body>).
  return isMobile && typeof document !== 'undefined' ? createPortal(panel, document.body) : panel;
}
