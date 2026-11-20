// Board top bar (sidebar icon + "Whiteboard ⌄" title on the left; avatars, Share, "Show chat" and
// close on the right). Clicking the title renames the board; the chevron opens the board menu.
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ChevronDown, Eye, LayoutGrid, Loader2, PanelLeft, Pencil, Sparkles, WifiOff, X } from 'lucide-react';
import { ShellMenu, ShellMenuItem, ShellMenuSeparator } from './shell-menu';
import { api } from '@/lib/api';
import { toast } from '@/hooks/use-toast';
import type { BoardContext } from '@/board/slots';
import { BoardSlots } from '@/board/slots';
import { useAiUi, aiUi } from '@/board/ai/store';
import { ThemeToggle } from '@/components/theme-toggle';

const ghost =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-[var(--monet-text)] transition hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8ff7]';

export function BoardTopBar({
  ctx,
  title,
  onTitleSaved,
  isMobile,
}: {
  ctx: BoardContext;
  title: string;
  onTitleSaved: (t: string) => void;
  isMobile: boolean;
}) {
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState<string | null>(null);
  const { chatOpen } = useAiUi();
  const { collab, canEdit, role, boardId, linkToken } = ctx;

  async function commit() {
    const next = draft?.trim();
    setDraft(null);
    if (!next || next === title) return;
    try {
      await api(`/boards/${boardId}`, { method: 'PATCH', json: { title: next }, linkToken });
      onTitleSaved(next);
    } catch (err) {
      toast({ title: "Couldn't rename the board", description: err instanceof Error ? err.message : 'Try again.', variant: 'destructive' });
    }
  }

  return (
    <header
      className="monet-topbar relative z-40 flex h-11 shrink-0 items-center gap-1 border-b border-[var(--monet-border)] bg-[var(--monet-surface)] px-2 text-[var(--monet-text)]"
      data-testid="board-topbar"
    >
      {/* Phones skip these two: the chat and close buttons on the right do the same, and the title and its menu need
          the room (without it the menu button slid under the buttons on the right and couldn't be tapped). */}
      {!isMobile && (
        <>
          <button
            type="button"
            className={ghost + ' w-8 justify-center px-0'}
            onClick={() => aiUi.toggleChat()}
            aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
            title={chatOpen ? 'Hide chat' : 'Show chat'}
            data-testid="button-sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <Link href="/" className={ghost + ' w-8 justify-center px-0'} title="All boards" aria-label="All boards" data-testid="link-home">
            <LayoutGrid className="h-4 w-4" />
          </Link>
        </>
      )}
      {/* min-w-7 keeps room for the menu button, so a long title or a narrow screen can't push it under its neighbours. */}
      <div className="flex min-w-7 items-center">
        {draft !== null ? (
          <input
            autoFocus
            maxLength={200}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') setDraft(null);
            }}
            className="h-8 w-64 max-w-[50vw] rounded-lg border border-[var(--monet-border-3)] bg-[var(--monet-surface-2)] px-2 text-[13px] text-[var(--monet-text-strong)] outline-none focus:border-[#4d8ff7]"
            aria-label="Board title"
            data-testid="input-board-title"
          />
        ) : (
          <button
            type="button"
            className="min-w-0 truncate rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--monet-text-strong)] hover:bg-[var(--monet-hover)]"
            onClick={() => canEdit && setDraft(title)}
            title={canEdit ? 'Rename board' : title}
            data-testid="text-board-title"
          >
            {title}
          </button>
        )}
        <ShellMenu
          align="start"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              className={ghost + ' w-7 shrink-0 justify-center px-0'}
              aria-label="Board menu"
              aria-haspopup="menu"
              data-testid="button-board-title-menu"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
        >
          {(close) => (
            <>
              {canEdit && (
                <ShellMenuItem
                  onSelect={() => {
                    close();
                    setTimeout(() => setDraft(title), 0);
                  }}
                  testId="menu-rename-board"
                >
                  <Pencil /> Rename
                </ShellMenuItem>
              )}
              <ShellMenuItem
                onSelect={() => {
                  aiUi.toggleChat();
                  close();
                }}
                testId="menu-toggle-chat"
              >
                <Sparkles /> {chatOpen ? 'Hide chat' : 'Show chat'}
              </ShellMenuItem>
              <ShellMenuSeparator />
              <ShellMenuItem onSelect={() => navigate('/')} testId="menu-all-boards">
                <LayoutGrid /> All boards
              </ShellMenuItem>
            </>
          )}
        </ShellMenu>
      </div>
      {!canEdit && role && (
        <span
          className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--monet-hover)] px-2 py-0.5 text-[11px] text-[var(--monet-text-soft)]"
          data-testid="badge-view-only"
        >
          <Eye className="h-3 w-3" /> {role === 'commenter' ? 'Can comment' : 'View only'}
        </span>
      )}
      {collab.connection === 'connecting' && <Loader2 className="ml-1 h-4 w-4 shrink-0 animate-spin text-[var(--monet-text-muted)]" />}
      {collab.connection === 'reconnecting' && (
        <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--monet-warn)]" data-testid="status-reconnecting">
          <WifiOff className="h-3 w-3" /> Reconnecting…
        </span>
      )}
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-1">
        <BoardSlots.TopRight ctx={ctx} isMobile={isMobile} />
        <ThemeToggle />
        <button
          type="button"
          className={ghost}
          onClick={() => aiUi.toggleChat()}
          aria-pressed={chatOpen}
          aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
          data-testid="button-ai-open"
        >
          <Sparkles className="h-4 w-4" />
          {!isMobile && (chatOpen ? 'Hide chat' : 'Show chat')}
        </button>
        <button
          type="button"
          className={ghost + ' w-8 justify-center px-0'}
          onClick={() => navigate('/')}
          aria-label="Close board"
          title="Close"
          data-testid="button-close-board"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
