// Chat history with the board AI, shared by everyone on the board (dark theme). People's messages are
// right-aligned bubbles; the AI writes in a serif face with no bubble, with a gray status line for what it
// changed on the board.
import { useEffect, useRef, useState } from 'react';
import { format, isToday } from 'date-fns';
import { AlertCircle, ArrowUpRight, ChevronRight, Crosshair, FileText, Paperclip, Presentation, Radio } from 'lucide-react';
import type { ChatMessage } from '@monet/board-protocol';
import { cn } from '@/lib/utils';
import { Markdown, safeHref, useInternalNavigate, withLinkToken } from './markdown';
import { WorkingDots } from './composer-parts';

function timeLabel(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return isToday(d) ? format(d, 'h:mm a') : format(d, 'MMM d, h:mm a');
}

function attachmentNames(meta: Record<string, unknown>): string[] {
  const raw = meta.attachments;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) =>
      typeof a === 'string' ? a : a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string' ? (a as { name: string }).name : null,
    )
    .filter((x): x is string => !!x);
}

interface DocumentMeta {
  url: string;
  title: string;
  isDeck: boolean;
}

/** Doc/deck results: assistant messages with meta { kind: 'document', documentId, documentKind, url, title }. */
function documentMeta(meta: Record<string, unknown> | undefined): DocumentMeta | null {
  if (!meta || meta.kind !== 'document' || typeof meta.url !== 'string') return null;
  const url = safeHref(meta.url);
  if (!url) return null;
  const kind = typeof meta.documentKind === 'string' ? meta.documentKind.toLowerCase() : '';
  const isDeck = kind.includes('deck') || kind.includes('slide') || /\/decks\//.test(url);
  const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : isDeck ? 'Untitled deck' : 'Untitled document';
  return { url, title, isDeck };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The card already links to the document: a message that is only the link shows just the card; otherwise
 * the link becomes its bold label so the sentence still reads naturally.
 */
function withoutDocLink(content: string, url: string) {
  const re = new RegExp(`\\[([^\\]]*)\\]\\(${escapeRe(url)}\\)`, 'g');
  if (/^[\s.:,;!\-–—]*$/.test(content.replace(re, ''))) return '';
  return content.replace(re, (_m, label: string) => (label.trim() ? `**${label.trim()}**` : '')).trim();
}

function DocumentCard({ doc, linkToken }: { doc: DocumentMeta; linkToken?: string | null }) {
  const nav = useInternalNavigate();
  const href = withLinkToken(doc.url, linkToken);
  const internal = href.startsWith('/');
  const Icon = doc.isDeck ? Presentation : FileText;
  return (
    <a
      href={href}
      onClick={(e) => nav(e, href)}
      {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
      className="mt-2 flex items-center gap-3 rounded-xl border border-[var(--monet-border)] bg-[var(--monet-surface)] p-2.5 font-sans transition hover:border-[#4d8ff7]/60 hover:bg-[var(--monet-hover)]"
      data-testid="card-ai-document"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--monet-active-bg)] text-[var(--monet-active-fg)]">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--monet-text-strong)]" data-testid="text-document-title">
          {doc.title}
        </span>
        <span className="block text-xs text-[var(--monet-text-muted)]">{doc.isDeck ? 'Slide deck' : 'Document'} · Open</span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--monet-text-muted)]" />
    </a>
  );
}

/** "Added 6 items, updated 2" plus one detail line per kind of change, from the AI's run stats. */
function changeSummary(meta: Record<string, unknown> | undefined): { summary: string; details: string[] } | null {
  if (!meta) return null;
  const n = (k: string) => (typeof meta[k] === 'number' ? (meta[k] as number) : 0);
  const items = (x: number) => `${x} item${x === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const details: string[] = [];
  if (n('created')) {
    parts.push(`Added ${items(n('created'))}`);
    details.push(`Added ${items(n('created'))} to the board`);
  }
  if (n('updated')) {
    parts.push(`${parts.length ? 'updated' : 'Updated'} ${n('updated')}`);
    details.push(`Changed ${items(n('updated'))} already on the board`);
  }
  if (n('deleted')) {
    parts.push(`${parts.length ? 'removed' : 'Removed'} ${n('deleted')}`);
    details.push(`Removed ${items(n('deleted'))}`);
  }
  return parts.length ? { summary: parts.join(', '), details } : null;
}

/** Grey step line for what the AI did; expands to the details and a "Show on board" action. */
function StepLine({ summary, details, onShow }: { summary: string; details: string[]; onShow?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="font-sans">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1.5 text-[13px] text-[var(--monet-text-muted)] hover:text-[var(--monet-text)]"
        aria-expanded={open}
        data-testid="status-ai-changes"
      >
        <span>{summary}</span>
        <ChevronRight className={cn('h-3.5 w-3.5 opacity-70 transition', open && 'rotate-90')} />
      </button>
      {open && (
        <div
          className="ml-1 mt-1 space-y-0.5 border-l border-[var(--monet-border)] pl-3 text-[12px] text-[var(--monet-text-muted)]"
          data-testid="steps-ai-changes"
        >
          {details.map((d) => (
            <div key={d}>{d}</div>
          ))}
          {onShow && (
            <button type="button" onClick={onShow} className="text-[var(--monet-active-fg)] hover:underline" data-testid="button-ai-show-changes">
              Show on board
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function StatusLine({ children, onClick, testId, busy }: { children: React.ReactNode; onClick?: () => void; testId?: string; busy?: boolean }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn('group flex items-center gap-1.5 font-sans text-[13px] text-[var(--monet-text-muted)]', onClick && 'hover:text-[var(--monet-text)]')}
      data-testid={testId}
    >
      {busy && <WorkingDots className="text-[#c96442]" />}
      <span>{children}</span>
      <ChevronRight className="h-3.5 w-3.5 opacity-70 transition group-hover:translate-x-0.5" />
    </Comp>
  );
}

export function MessageList({
  messages,
  meId,
  footer,
  linkToken,
  onShowElements,
}: {
  messages: ChatMessage[];
  meId: string | null;
  footer?: React.ReactNode;
  linkToken?: string | null;
  /** Select and scroll to elements the AI made. */
  onShowElements?: (ids: string[]) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1]?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [last, footer]);

  return (
    <div className="flex flex-col gap-4" data-testid="ai-messages">
      {messages.map((m) => {
        const isAI = m.role === 'assistant';
        const mine = !isAI && !!meId && m.userId === meId;
        const isError = isAI && m.meta?.error === true;
        const focusCount = typeof m.meta?.focusCount === 'number' ? m.meta.focusCount : 0;
        const live = m.meta?.mode === 'live';
        const files = attachmentNames(m.meta ?? {});
        const doc = isAI && !isError ? documentMeta(m.meta) : null;
        const text = doc ? withoutDocLink(m.content, doc.url) : m.content;
        const changes = isAI && !isError ? changeSummary(m.meta) : null;
        const ids = Array.isArray(m.meta?.elementIds) ? (m.meta.elementIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        const time = timeLabel(m.createdAt);

        if (!isAI) {
          return (
            <div key={m.id} className="flex flex-col items-end gap-1" data-testid="ai-message-user" title={time}>
              {!mine && (
                <span className="pr-1 text-[11px] font-medium text-[var(--monet-text-muted)]" data-testid="text-message-author">
                  {m.userName || 'Someone'}
                </span>
              )}
              {mine && (
                <span className="sr-only" data-testid="text-message-author">
                  You
                </span>
              )}
              {(focusCount > 0 || live || files.length > 0) && (
                <div className="flex flex-wrap justify-end gap-1">
                  {live && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[var(--monet-danger-bg)] px-1.5 py-0.5 text-[11px] text-[var(--monet-live)]">
                      <Radio className="h-3 w-3" /> Live transcript
                    </span>
                  )}
                  {focusCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[var(--monet-active-bg)] px-1.5 py-0.5 text-[11px] text-[var(--monet-active-fg)]">
                      <Crosshair className="h-3 w-3" /> About {focusCount} item{focusCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {files.map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--monet-surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--monet-text-faint)]"
                    >
                      <Paperclip className="h-3 w-3" /> {f}
                    </span>
                  ))}
                </div>
              )}
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--monet-hover)] px-3.5 py-2 text-[14px] leading-relaxed text-[var(--monet-text-strong)]',
                  live && 'italic text-[var(--monet-text-soft)]',
                )}
                data-testid="text-message-content"
              >
                {m.content}
              </div>
            </div>
          );
        }

        const stopped = m.meta?.stopped === true || m.meta?.state === 'stopped' || m.meta?.status === 'stopped';
        if (stopped) {
          const by = typeof m.meta?.stoppedBy === 'string' ? m.meta.stoppedBy : null;
          return (
            <div key={m.id} className="flex flex-col gap-1.5" title={time}>
              <div className="font-sans text-[13px] italic text-[var(--monet-text-muted)]" data-testid="text-ai-stopped">
                {!by || by === meId ? "You stopped Monet AI's response" : "Monet AI's response was stopped"}
              </div>
              {/* What the AI placed before the stop stays on the board. */}
              {changes && (
                <StepLine summary={changes.summary} details={changes.details} onShow={ids.length && onShowElements ? () => onShowElements(ids) : undefined} />
              )}
            </div>
          );
        }

        return (
          <div key={m.id} className="flex flex-col gap-1.5" data-testid="ai-message-assistant" title={time}>
            <span className="sr-only" data-testid="text-message-author">
              Monet AI
            </span>
            {changes && (
              <StepLine summary={changes.summary} details={changes.details} onShow={ids.length && onShowElements ? () => onShowElements(ids) : undefined} />
            )}
            {isError ? (
              <div className="flex items-start gap-1.5 font-sans text-[14px] text-[var(--monet-danger)]" data-testid="text-message-content">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{m.content}</span>
              </div>
            ) : (
              text && (
                <div data-testid="text-message-content">
                  <Markdown text={text} linkToken={linkToken} className="font-serif text-[15px] text-[var(--monet-text-strong)]" />
                </div>
              )
            )}
            {doc && <DocumentCard doc={doc} linkToken={linkToken} />}
          </div>
        );
      })}
      {footer}
      <div ref={endRef} />
    </div>
  );
}
