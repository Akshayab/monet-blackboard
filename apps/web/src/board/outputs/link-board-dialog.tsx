// "Link a board…": pick another board you can open and drop a link card to it on this board.
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, type BoardSummary } from '@/lib/api';
import type { BoardContext } from '../slots';
import { addLinkCard } from './link-cards';
import { errorMessage } from './api';

export function LinkBoardDialog({ ctx, open, onOpenChange }: { ctx: BoardContext; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    setQ('');
    setError(null);
    setBoards(null);
    api<{ boards: BoardSummary[] }>('/boards')
      .then((d) => setBoards(d.boards.filter((b) => b.id !== ctx.boardId)))
      .catch((err) => setError(errorMessage(err)));
  }, [open, ctx.boardId]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (boards ?? []).filter((b) => !needle || b.title.toLowerCase().includes(needle));
  }, [boards, q]);

  function pick(b: BoardSummary) {
    if (!ctx.excalidrawAPI) return;
    addLinkCard(ctx.excalidrawAPI, { target: 'board', targetId: b.id, url: `/b/${b.id}`, title: b.title }, { select: true });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-link-board">
        <DialogHeader>
          <DialogTitle>Link a board</DialogTitle>
          <DialogDescription>Adds a card to this board that opens the other one. People still need access to open it.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your boards" className="pl-8" data-testid="input-link-board-search" />
        </div>
        <div className="max-h-[45vh] space-y-0.5 overflow-y-auto">
          {boards === null && !error && (
            <div className="grid place-items-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          {boards && shown.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No other boards yet.</p>}
          {shown.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => pick(b)}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60"
              data-testid={`button-link-board-${b.id}`}
            >
              <span className="truncate font-medium">{b.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{b.role === 'owner' ? 'Yours' : (b.ownerName ?? 'Shared')}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
