import { useMemo, type ReactNode } from 'react';
import { Link } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { Copy, ExternalLink, Eye, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { BoardSummary } from '@/lib/api';
import { thumbnailForTheme, useTheme } from '@/lib/theme';

export interface BoardActions {
  onRename: (b: BoardSummary) => void;
  onDuplicate: (b: BoardSummary) => void;
  onDelete: (b: BoardSummary) => void;
}

function edited(b: BoardSummary) {
  try {
    return `Edited ${formatDistanceToNow(new Date(b.updatedAt), { addSuffix: true })}`;
  } catch {
    return '';
  }
}

function RoleBadge({ b }: { b: BoardSummary }) {
  if (b.role === 'owner') return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {b.role === 'viewer' ? <Eye className="h-3 w-3" aria-hidden="true" /> : <Users className="h-3 w-3" aria-hidden="true" />}
      {b.role === 'viewer' ? 'View only' : b.role === 'commenter' ? 'Can comment' : 'Can edit'}
    </span>
  );
}

function Thumb({ b, className }: { b: BoardSummary; className?: string }) {
  const theme = useTheme();
  const src = useMemo(() => (b.thumbnail ? thumbnailForTheme(b.thumbnail, theme) : null), [b.thumbnail, theme]);
  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden bg-[var(--monet-canvas)] bg-[radial-gradient(circle,_hsl(var(--border))_1px,_transparent_1px)] [background-size:16px_16px]',
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full object-contain p-2" />
      ) : (
        <span className="text-xs text-muted-foreground">Empty board</span>
      )}
    </div>
  );
}

/** The "⋯" menu on a board card or row. Always visible on touch screens, on hover/focus elsewhere. */
function BoardMenu({ b, actions, className }: { b: BoardSummary; actions: BoardActions; className?: string }) {
  // Positioning lives on a wrapper: the shared button styles (hover-elevate) force position: relative.
  return (
    <div className={cn('shrink-0', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="secondary"
            aria-label={`More options for ${b.title}`}
            className={cn(
              'h-8 w-8 shadow-sm focus-visible:ring-2 data-[state=open]:opacity-100',
              '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100',
            )}
            data-testid={`button-board-menu-${b.id}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem asChild>
            <a href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/b/${b.id}`} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" /> Open in new tab
            </a>
          </DropdownMenuItem>
          {(b.role === 'owner' || b.role === 'editor') && (
            <DropdownMenuItem onSelect={() => actions.onRename(b)} data-testid={`button-board-rename-${b.id}`}>
              <Pencil className="mr-2 h-4 w-4" /> Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => actions.onDuplicate(b)} data-testid={`button-board-duplicate-${b.id}`}>
            <Copy className="mr-2 h-4 w-4" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => actions.onDelete(b)}
            className="text-destructive-text focus:text-destructive-text"
            data-testid={`button-board-delete-${b.id}`}
          >
            <Trash2 className="mr-2 h-4 w-4" /> {b.role === 'owner' ? 'Delete' : 'Leave board'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function BoardGridView({ boards, actions }: { boards: BoardSummary[]; actions: BoardActions }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-4" aria-label="Boards">
      {boards.map((b) => (
        <li
          key={b.id}
          className="group relative overflow-hidden rounded-xl border bg-card transition hover:shadow-md focus-within:ring-2 focus-within:ring-ring"
          data-testid={`card-board-${b.id}`}
        >
          <Link href={`/b/${b.id}`} className="block focus-visible:outline-none" aria-label={`Open ${b.title}`}>
            <Thumb b={b} className="aspect-[4/3]" />
            <div className="border-t p-3">
              <div className="truncate font-medium" data-testid={`text-board-title-${b.id}`}>
                {b.title}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {b.role !== 'owner' && b.ownerName ? `${b.ownerName} · ` : ''}
                  {edited(b)}
                </span>
              </div>
              {b.role !== 'owner' && (
                <div className="mt-2">
                  <RoleBadge b={b} />
                </div>
              )}
            </div>
          </Link>
          <BoardMenu b={b} actions={actions} className="absolute right-2 top-2" />
        </li>
      ))}
    </ul>
  );
}

export function BoardListView({ boards, actions }: { boards: BoardSummary[]; actions: BoardActions }) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Boards">
      {boards.map((b) => (
        <li
          key={b.id}
          className="group relative flex items-center gap-3 px-3 py-2 hover:bg-muted/40 focus-within:bg-muted/40"
          data-testid={`card-board-${b.id}`}
        >
          <Link
            href={`/b/${b.id}`}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open ${b.title}`}
          >
            <Thumb b={b} className="h-12 w-16 shrink-0 rounded-md border [&_span]:hidden" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium" data-testid={`text-board-title-${b.id}`}>
                {b.title}
              </div>
              <div className="truncate text-xs text-muted-foreground sm:hidden">
                {b.role !== 'owner' && b.ownerName ? `${b.ownerName} · ` : ''}
                {edited(b)}
              </div>
            </div>
            <span className="hidden w-40 shrink-0 truncate text-sm text-muted-foreground sm:block">
              {b.role === 'owner' ? 'You' : (b.ownerName ?? 'Someone')}
            </span>
            <span className="hidden w-44 shrink-0 truncate text-sm text-muted-foreground md:block">{edited(b)}</span>
            <span className="hidden w-24 shrink-0 sm:block">
              <RoleBadge b={b} />
            </span>
          </Link>
          <BoardMenu b={b} actions={actions} />
        </li>
      ))}
    </ul>
  );
}

export function BoardSkeletons({ view }: { view: 'grid' | 'list' }) {
  if (view === 'list') {
    return (
      <div className="divide-y rounded-xl border bg-card" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <div className="h-12 w-16 animate-pulse rounded-md bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="overflow-hidden rounded-xl border bg-card">
          <div className="aspect-[4/3] animate-pulse bg-muted" />
          <div className="space-y-2 p-3">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action, testId }: { title: string; body: string; action?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center" data-testid={testId}>
      <svg viewBox="0 0 96 64" className="h-16 w-24" aria-hidden="true">
        <rect x="6" y="10" width="34" height="34" rx="4" fill="#fff3bf" stroke="#18181b" strokeWidth="1.5" transform="rotate(-6 23 27)" />
        <rect x="50" y="18" width="34" height="34" rx="4" fill="#d0ebff" stroke="#18181b" strokeWidth="1.5" transform="rotate(4 67 35)" />
        <path d="M40 30c4-6 8-6 10-2" fill="none" stroke="#18181b" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
