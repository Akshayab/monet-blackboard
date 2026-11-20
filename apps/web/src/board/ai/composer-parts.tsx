// Small pieces shared by the prompt bar and the Reply box (dark theme).
import { Crosshair, FileText, Image as ImageIcon, Loader2, Table2, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PendingAttachment } from './attachments';
import type { Composer } from './use-composer';

export function AttachmentChip({ a, onRemove, prefix = '' }: { a: PendingAttachment; onRemove: () => void; prefix?: string }) {
  const Icon = a.kind === 'csv' ? Table2 : a.kind === 'image' ? ImageIcon : FileText;
  const chip = (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--monet-border-2)] bg-[var(--monet-surface-2)] py-1 pl-1.5 pr-1 text-xs text-[var(--monet-text)]"
      data-testid={`${prefix}chip-attachment-${a.name}`}
    >
      {a.kind === 'image' && a.dataURL ? (
        <img src={a.dataURL} alt="" className="h-5 w-5 rounded object-cover" />
      ) : (
        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--monet-text-muted)]" />
      )}
      <span className="max-w-[9rem] truncate font-medium">{a.name}</span>
      <span className="shrink-0 text-[var(--monet-text-muted)]">{a.summary}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-0.5 text-[var(--monet-text-muted)] hover:bg-[var(--monet-border-2)] hover:text-[var(--monet-text-strong)]"
        aria-label={`Remove ${a.name}`}
        data-testid={`${prefix}button-remove-attachment-${a.name}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
  if (!a.previewRows?.length) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm p-2">
        <table className="text-[11px]">
          <tbody>
            {a.previewRows.map((row, i) => (
              <tr key={i} className={i === 0 ? 'font-semibold' : ''}>
                {row.map((c, j) => (
                  <td key={j} className="pr-2 align-top">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TooltipContent>
    </Tooltip>
  );
}

/** Focus chip + attachment chips + "Reading file…", shown above an input. */
/** `prefix` keeps test ids unique when both inputs are mounted (the Reply box uses "reply-"). */
export function ComposerChips({ c, focusCount, className, prefix = '' }: { c: Composer; focusCount: number; className?: string; prefix?: string }) {
  if (!c.useFocus && !c.attachments.length && !c.reading) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {c.useFocus && (
        <span
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--monet-active-border)] bg-[var(--monet-active-bg)] py-1 pl-2 pr-1 text-xs font-medium text-[var(--monet-active-fg)]"
          data-testid={`${prefix}chip-focus`}
        >
          <Crosshair className="h-3 w-3" />
          Asking about {focusCount} item{focusCount === 1 ? '' : 's'}
          <button
            type="button"
            onClick={c.clearFocus}
            className="rounded p-0.5 hover:bg-[var(--monet-active-hover-bg)]"
            aria-label="Ask about the whole board instead"
            data-testid={`${prefix}button-clear-focus`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      {c.attachments.map((a) => (
        <AttachmentChip key={a.id} a={a} prefix={prefix} onRemove={() => c.removeAttachment(a.id)} />
      ))}
      {c.reading > 0 && (
        <span className="inline-flex items-center gap-1 text-xs text-[var(--monet-text-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading file…
        </span>
      )}
    </div>
  );
}

/** Pulsing red dot used for dictation and live mode. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative flex h-2 w-2', className)}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
    </span>
  );
}

/** Three animated dots ("··· Working"). */
export function WorkingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-[3px]', className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-1 animate-pulse rounded-full bg-current" style={{ animationDelay: `${i * 180}ms` }} />
      ))}
    </span>
  );
}
