// Docs & decks generated from this board.
import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ExternalLink, FileText, Library, Link2, Loader2, Presentation, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import type { BoardContext } from '../slots';
import { appPath, deleteDocument, errorMessage, listDocuments, withLink, type BoardDocument, type DocKind } from './api';
import { addLinkCard } from './link-cards';

export function useBoardDocuments(ctx: BoardContext, active: boolean) {
  const [docs, setDocs] = useState<BoardDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const d = await listDocuments(ctx.boardId, ctx.linkToken);
      setDocs(d.documents);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ctx.boardId, ctx.linkToken]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // Refresh when the AI posts a document message to the board chat.
  useEffect(() => {
    return ctx.collab.onChat((m) => {
      if ((m.meta as { kind?: string }).kind === 'document') void refresh();
    });
  }, [ctx.collab, refresh]);

  // Keep polling while something is being written.
  useEffect(() => {
    if (!active || !docs?.some((d) => d.status === 'generating')) return;
    const t = window.setTimeout(() => void refresh(), 2000);
    return () => window.clearTimeout(t);
  }, [active, docs, refresh]);

  return { docs, error, refresh, setDocs };
}

export function DocumentsDialog({
  ctx,
  open,
  onOpenChange,
  onNew,
}: {
  ctx: BoardContext;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onNew: (kind: DocKind) => void;
}) {
  const { toast } = useToast();
  const { docs, error, refresh, setDocs } = useBoardDocuments(ctx, open);

  async function remove(doc: BoardDocument) {
    if (!window.confirm(`Delete "${doc.title}"? This can't be undone.`)) return;
    setDocs((d) => d?.filter((x) => x.id !== doc.id) ?? null);
    try {
      await deleteDocument(ctx.boardId, doc.id, ctx.linkToken);
    } catch (err) {
      toast({ title: "Couldn't delete", description: errorMessage(err), variant: 'destructive' });
      void refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-documents">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="h-5 w-5" /> Docs &amp; decks
          </DialogTitle>
          <DialogDescription>Everything the AI has written from this board. Anyone with access to the board can open them.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {docs === null && !error && (
            <div className="grid place-items-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          {docs?.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground" data-testid="text-documents-empty">
              Nothing yet. Turn the board into a doc or a deck to get started.
            </div>
          )}
          {docs?.map((d) => (
            <div key={d.id} className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60" data-testid={`row-document-${d.id}`}>
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted">
                {d.kind === 'doc' ? <FileText className="h-4 w-4" /> : <Presentation className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                {d.status === 'ready' ? (
                  <a
                    href={appPath(withLink(d.url, ctx.linkToken))}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-sm font-medium hover:underline"
                    data-testid={`link-document-${d.id}`}
                  >
                    {d.title}
                  </a>
                ) : (
                  <span className="block truncate text-sm font-medium">{d.title}</span>
                )}
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {d.status === 'generating' && (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Writing…
                    </>
                  )}
                  {d.status === 'error' && (
                    <span className="flex items-center gap-1 text-destructive-text">
                      <TriangleAlert className="h-3 w-3" /> {d.error ?? 'Failed'}
                    </span>
                  )}
                  {d.status === 'ready' && (
                    <span>
                      {d.kind === 'doc' ? 'Doc' : 'Deck'}
                      {d.scope === 'selection' ? ' · from a selection' : ''}
                      {d.createdByName ? ` · ${d.createdByName}` : ''} · {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
              {d.status === 'ready' && ctx.canEdit && ctx.excalidrawAPI && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  title="Add a link card to the board"
                  onClick={() => {
                    addLinkCard(ctx.excalidrawAPI!, { target: d.kind, targetId: d.id, url: d.url, title: d.title }, { select: true, scrollIntoView: true });
                    onOpenChange(false);
                  }}
                  data-testid={`button-link-document-${d.id}`}
                >
                  <Link2 className="h-4 w-4" />
                </Button>
              )}
              {d.status === 'ready' && (
                <Button asChild size="icon" variant="ghost" className="h-8 w-8" title="Open">
                  <a href={appPath(withLink(d.url, ctx.linkToken))} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
              {ctx.canEdit && d.status !== 'generating' && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100"
                  title="Delete"
                  onClick={() => void remove(d)}
                  data-testid={`button-delete-document-${d.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
        {ctx.canEdit && (
          <div className="flex gap-2 border-t pt-3">
            <Button variant="outline" size="sm" onClick={() => onNew('doc')}>
              <FileText className="mr-2 h-4 w-4" /> New doc
            </Button>
            <Button variant="outline" size="sm" onClick={() => onNew('deck')}>
              <Presentation className="mr-2 h-4 w-4" /> New deck
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
